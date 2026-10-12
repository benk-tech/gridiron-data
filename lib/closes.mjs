// Closes archive: when a game's ESPN state flips from 'pre' to 'in' or 'post', its last pregame DraftKings lines
// (game odds, team totals, player props) are the close. DK prop lines freeze at kickoff and ESPN drops old props,
// so this archive is the only clean record for later closing-line and backtest work. Public data only.
//
// Flow (see lib/moves.mjs for the full run order):
//   closesFromTransition(prevHistory, games, props, { now })   -> entries, from the history BEFORE this run updates it
//   writeClosesFile(stagingDir, entries, { now })               -> state/closes/<ET date of kickoff>.json (Actions cache)
//   node lib/closes.mjs sync state/closes closes                 -> workflow step: copies finished ET days into the repo's
//                                                                  closes/ folder, so the repo gets about one commit a day
// File: { v: 1, date, games: [CloseEntry] }, one game per line, sorted by kickoff. Dedupe by gameId (first capture wins).

import { readFile, writeFile, mkdir, readdir, rename, unlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOSES_VERSION = 1;
const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
/** US Eastern calendar date 'YYYY-MM-DD' (the NFL/CFB slate day; SNF at 00:20Z belongs to Sunday). */
export const etDay = (t) => ET_DATE.format(new Date(typeof t === 'number' ? t : Date.parse(t)));
const isoOf = (t) => new Date(typeof t === 'number' ? t : Date.parse(t)).toISOString().replace(/\.\d{3}Z$/, 'Z');
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * closesFromTransition(prevHistory, games, props, { now }) -> [CloseEntry]
 * A game flips when the previous history had it 'pre' and now it is 'in' or 'post', or it is missing from `games`
 * with its kickoff in the past (the snapshot drops 'post' games, and runs can be skipped).
 * CloseEntry = { gameId, league, kickoff, home, away, lastPregameAt, odds, dkTeamTotals, props: [{ stat, player, dk }] }
 * Values come from the history's last pregame sighting; `props` (this run's props) are only a fallback.
 */
export function closesFromTransition(prevHistory, games = [], props = [], { now } = {}) {
  if (!prevHistory || typeof prevHistory !== 'object' || !prevHistory.games) return [];
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const cur = new Map((games || []).filter((g) => g?.id).map((g) => [g.id, g]));
  const out = [];
  for (const [id, e] of Object.entries(prevHistory.games)) {
    if (!e || e.state !== 'pre' || !e.pre) continue;
    const g = cur.get(id);
    const kick = Date.parse(e.kickoff ?? g?.kickoff);
    const flipped = g ? g.state === 'in' || g.state === 'post' : Number.isFinite(kick) && kick <= nowMs;
    if (!flipped) continue;
    let ps = Object.values(prevHistory.props || {})
      .filter((p) => p && p.gameId === id && p.dk && p.dk.line != null)
      .map((p) => ({ stat: p.stat, player: p.player, dk: p.dk }));
    if (!ps.length) {
      ps = (props || []).filter((p) => p?.gameId === id && p.dk && p.dk.line != null)
        .map((p) => ({ stat: p.stat, player: { espnId: p.player?.espnId ?? null, name: p.player?.name ?? null, team: p.player?.team ?? null, side: p.player?.side ?? null }, dk: p.dk }));
    }
    ps.sort((a, b) => String(a.player?.side).localeCompare(String(b.player?.side)) || String(a.player?.name).localeCompare(String(b.player?.name))
      || String(a.stat).localeCompare(String(b.stat)));
    out.push({
      gameId: id,
      league: e.league ?? g?.league ?? null,
      kickoff: e.kickoff ?? g?.kickoff ?? null,
      home: e.home ?? g?.home?.abbr ?? null,
      away: e.away ?? g?.away?.abbr ?? null,
      lastPregameAt: e.pre.at ?? null,
      odds: e.pre.odds ?? null,
      dkTeamTotals: e.pre.dkTeamTotals ?? null,
      props: ps,
    });
  }
  out.sort((a, b) => (Date.parse(a.kickoff) || 0) - (Date.parse(b.kickoff) || 0) || (a.gameId < b.gameId ? -1 : 1));
  return out;
}

/** One game per line so git diffs stay readable. */
export function formatClosesFile(doc) {
  const games = (doc.games || []).map((g) => JSON.stringify(g));
  return `{"v":${CLOSES_VERSION},"date":${JSON.stringify(doc.date)},"games":[\n${games.join(',\n')}\n]}\n`;
}

async function readDoc(path, date) {
  try {
    const j = JSON.parse(await readFile(path, 'utf8'));
    if (j && Array.isArray(j.games)) return { v: CLOSES_VERSION, date: j.date || date, games: j.games.filter((g) => g && g.gameId) };
  } catch { /* missing or corrupt: start the day fresh */ }
  return { v: CLOSES_VERSION, date, games: [] };
}

async function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

const byKickoff = (a, b) => (Date.parse(a.kickoff) || 0) - (Date.parse(b.kickoff) || 0) || (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0);

/**
 * writeClosesFile(dir, entries, { now }) -> { files: [path], added, skipped }
 * Appends entries to dir/<ET date of kickoff>.json (dedupe by gameId, first capture kept). Each new entry gets
 * capturedAt = now. A file is rewritten only when something was added.
 */
export async function writeClosesFile(dir, entries = [], { now = Date.now() } = {}) {
  const res = { files: [], added: 0, skipped: 0 };
  if (!entries.length) return res;
  const byDate = new Map();
  for (const e of entries) {
    if (!e?.gameId) { res.skipped++; continue; }
    const date = etDay(Number.isFinite(Date.parse(e.kickoff)) ? e.kickoff : now);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(e);
  }
  await mkdir(dir, { recursive: true });
  for (const [date, list] of [...byDate.entries()].sort()) {
    const path = join(dir, `${date}.json`);
    const doc = await readDoc(path, date);
    const have = new Set(doc.games.map((g) => g.gameId));
    let added = 0;
    for (const e of list) {
      if (have.has(e.gameId)) { res.skipped++; continue; }
      doc.games.push({ ...e, capturedAt: isoOf(now) });
      have.add(e.gameId);
      added++;
    }
    if (!added) continue;
    doc.games.sort(byKickoff);
    await writeAtomic(path, formatClosesFile(doc));
    res.files.push(path);
    res.added += added;
  }
  return res;
}

/**
 * syncClosesDir(stagingDir, repoDir, { now, keepDays }) -> { changed: [file], pruned: [file] }
 * Merges staged day files whose ET date is before today (the day is over) into repoDir (by gameId, existing repo
 * entries kept), and deletes staged files older than keepDays. Files are rewritten only when the merge adds games.
 */
export async function syncClosesDir(stagingDir, repoDir, { now = Date.now(), keepDays = 10 } = {}) {
  const out = { changed: [], pruned: [] };
  let names = [];
  try { names = (await readdir(stagingDir)).filter((n) => DATE_FILE.test(n)).sort(); } catch { return out; }
  const today = etDay(now);
  const oldest = etDay(now - keepDays * 86400e3);
  for (const n of names) {
    const date = DATE_FILE.exec(n)[1];
    const src = join(stagingDir, n);
    if (date < today) {
      const staged = await readDoc(src, date);
      const dst = join(repoDir, n);
      const doc = await readDoc(dst, date);
      const have = new Set(doc.games.map((g) => g.gameId));
      const add = staged.games.filter((g) => !have.has(g.gameId));
      if (add.length) {
        await mkdir(repoDir, { recursive: true });
        doc.games.push(...add);
        doc.games.sort(byKickoff);
        await writeAtomic(dst, formatClosesFile(doc));
        out.changed.push(dst);
      }
    }
    if (date < oldest) {
      try { await stat(src); await unlink(src); out.pruned.push(src); } catch { /* already gone */ }
    }
  }
  return out;
}

// CLI for the workflow: node lib/closes.mjs sync <stagingDir> <repoDir>
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd !== 'sync' || !a || !b) {
    console.error('usage: node lib/closes.mjs sync <stagingDir> <repoDir>');
    process.exitCode = 2;
  } else {
    syncClosesDir(a, b).then(
      (r) => console.log(`closes: ${r.changed.length} day file(s) updated, ${r.pruned.length} staged file(s) pruned`),
      (e) => { console.error(`closes sync failed: ${String(e?.message || e).slice(0, 200)}`); process.exitCode = 1; },
    );
  }
}
