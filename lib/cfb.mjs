// cfb.mjs: FBS defense ratings and the CFB QB-change detector (Node 22+, no deps).
// ESPN has no usable college injuries or depth charts (research2 injuries-depth), so the college "injury" signal is
// a box score check: the team's season passing leader barely threw in its last game while someone else did.
//
// fetchCfbInputs(): daily  = sportsdataverse cfb_defense_vs_position CSV (1) + ESPN byteam groups=80 (1); each piece is
//                            cached on its own, and a failed piece waits DEFENSE_BACKOFF before it is asked for again
//                   weekly = ESPN FBS scoreboards for the current, previous and next week (3) + one game summary
//                            per team's last finished game (about 60), cached by week (refreshed Sunday 12:00 UTC)
// buildCfb(raw, { games }): pure. -> { defense: { cfb: { [ESPN abbr]: rating } }, cfbQbChanges, ok, errors }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { parseCsv, colIndex, num } from './csv.mjs';
import { createHttp, mapLimit, errorText } from './http.mjs';
import { scoreboardUrl, summaryUrl, nextWeek, iso } from './espn.mjs';
import { prevWeek } from './injuries.mjs';
import { fetchBytes } from './nflverse.mjs';

const SDV = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download';
export const CFB_URLS = {
  dvp: (s) => `${SDV}/cfb_defense_vs_position/cfb_defense_vs_position_${s}.csv`,
  byTeam: (s) => `https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/statistics/byteam?region=us&lang=en&contentorigin=espn&season=${s}&seasontype=2&groups=80&limit=500`,
};
const DAY = 864e5;
/** A failed defense piece is retried after: 6 h for HTTP 404 (the new season's file is not published until about
 * late August), 1 h otherwise. A spent time budget is not a failure of the file and is retried next run. */
export const DEFENSE_BACKOFF = Object.freeze({ notFoundMs: 6 * 3600e3, otherMs: 3600e3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function writeJson(path, data) { try { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(data)); } catch { /* best effort */ } }

/** College season year: August to January belong to the August year. */
export function cfbSeason(now = Date.now()) {
  const d = new Date(toMs(now));
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/** Weekly cache key: the date of the latest Sunday 12:00 UTC at or before now (Saturday games are final by then). */
export function cfbWeekKey(now = Date.now()) {
  const nowMs = toMs(now);
  const d = new Date(nowMs);
  let k = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) - d.getUTCDay() * DAY;
  if (k > nowMs) k -= 7 * DAY;
  return new Date(k).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- trimming

/** ESPN byteam -> only the names table and each team's Opponent (splitId 900) categories. */
export function trimByTeam(j) {
  if (!j || !Array.isArray(j.teams)) return null;
  return {
    categories: (j.categories || []).map((c) => ({ name: c.name, names: c.names })),
    teams: j.teams.map((t) => ({
      team: { id: String(t.team?.id), abbreviation: t.team?.abbreviation || null, displayName: t.team?.displayName || null },
      categories: (t.categories || []).filter((c) => String(c.splitId) === '900').map((c) => ({ name: c.name, splitId: '900', values: c.values })),
    })),
  };
}

/** ESPN scoreboard -> [{ id, date, state, teams: [{ id, abbr, homeAway, leader: { id, name, line } | null }] }] */
export function trimBoard(board) {
  const out = [];
  for (const e of board?.events || []) {
    const c = e?.competitions?.[0];
    if (!c) continue;
    const teams = (c.competitors || []).map((x) => {
      const l = (x.leaders || []).find((y) => y.name === 'passingLeader')?.leaders?.[0];
      return { id: String(x.team?.id), abbr: x.team?.abbreviation || null, homeAway: x.homeAway,
        leader: l?.athlete?.id ? { id: String(l.athlete.id), name: l.athlete.displayName || null, line: l.displayValue || null } : null };
    });
    out.push({ id: String(e.id), date: iso(c.date || e.date), state: e.status?.type?.state ?? c.status?.type?.state ?? null, teams });
  }
  return out;
}

/** CFB game summary -> [{ teamId, eventId, passers: [{ id, name, att }] }] from boxscore passing (C/ATT column). */
export function summaryPassers(summary, eventId) {
  const out = [];
  for (const tp of summary?.boxscore?.players || []) {
    const p = (tp.statistics || []).find((x) => x.name === 'passing');
    const labels = p?.labels || [];
    let iAtt = labels.indexOf('C/ATT');
    if (iAtt < 0) iAtt = (p?.keys || []).indexOf('completions/passingAttempts');
    const passers = (p?.athletes || [])
      .filter((a) => a?.athlete?.id && !String(a.athlete.id).startsWith('-'))
      .map((a) => ({ id: String(a.athlete.id), name: a.athlete.displayName || null, att: Number(String(a.stats?.[iAtt] ?? '0/0').split('/')[1]) || 0 }));
    out.push({ teamId: String(tp.team?.id), eventId: String(eventId), passers });
  }
  return out;
}

// ---------------------------------------------------------------- fetch

/**
 * fetchCfbInputs({ fetchImpl, now, cacheDir, season, maxSummaries }) ->
 *   { season, defense: { fetchedAt, dvp (CSV text) | null, byTeam (trimmed) | null, cached },
 *     qb: { fetchedAt, weekKey, events, lastPassers: { [teamId]: { eventId, date, passers } }, cached } | null,
 *     errors, requests }
 */
export async function fetchCfbInputs({
  fetchImpl = globalThis.fetch, now = Date.now(), cacheDir = null, season = null, maxSummaries = 90,
  concurrency = 3, pauseMs = 200, retryDelayMs = 800, log = () => {},
} = {}) {
  const nowMs = toMs(now);
  const yr = season ?? cfbSeason(nowMs);
  const http = createHttp({ fetchImpl, retries: 1, retryDelayMs, timeoutMs: 30000 });
  const errors = [];
  let extra = 0; // requests not counted by http (CSV download)

  // ---- daily defense (the day rolls over at 14:00 UTC: sportsdataverse publishes about 13:00 UTC)
  const day = new Date(nowMs - 14 * 3600e3).toISOString().slice(0, 10);
  const dPath = cacheDir ? join(cacheDir, `cfb-defense-${day}.json`) : null;
  const cachedDef = dPath ? await readJson(dPath) : null;
  let defense;
  if (cachedDef?.dvp && cachedDef?.byTeam) { defense = { ...cachedDef, cached: true }; log(`cfb defense: cache ${day}`); }
  else {
    // Pieces already fetched today are kept; only the missing ones are asked for, and not before retryAfter.
    defense = { fetchedAt: cachedDef?.fetchedAt ?? iso(nowMs), dvp: cachedDef?.dvp ?? null, byTeam: cachedDef?.byTeam ?? null, cached: !!cachedDef };
    const missing = () => [!defense.dvp && 'dvp', !defense.byTeam && 'byteam'].filter(Boolean).join(' and ');
    if (cachedDef?.retryAfter && nowMs < Date.parse(cachedDef.retryAfter)) {
      errors.push(`cfb ${missing()}: ${cachedDef.lastError || 'failed'}; next try after ${cachedDef.retryAfter}`);
      log(`cfb defense: ${missing()} skipped until ${cachedDef.retryAfter}`);
    } else {
      const fails = [];
      if (!defense.dvp) {
        try { extra++; defense.dvp = (await fetchBytes(fetchImpl, CFB_URLS.dvp(yr))).buf.toString('utf8'); } catch (e) { errors.push(`cfb dvp: ${errorText(e)}`); fails.push(e); }
      }
      if (!defense.byTeam) {
        try {
          const t = trimByTeam(await http.getJson(CFB_URLS.byTeam(yr)));
          if (!t) throw new Error('unexpected JSON (no teams list)');
          defense.byTeam = t;
        } catch (e) { errors.push(`cfb byteam: ${errorText(e)}`); fails.push(e); }
      }
      if (dPath) {
        const realFails = fails.filter((e) => !e?.budget);
        const notFound = realFails.length > 0 && realFails.every((e) => Number(e?.status) === 404);
        const keep = { fetchedAt: defense.fetchedAt, dvp: defense.dvp, byTeam: defense.byTeam };
        if (realFails.length) {
          await writeJson(dPath, { ...keep, retryAfter: iso(nowMs + (notFound ? DEFENSE_BACKOFF.notFoundMs : DEFENSE_BACKOFF.otherMs)),
            lastError: realFails.map((e) => errorText(e)).join('; ').slice(0, 300) });
        } else if (defense.dvp || defense.byTeam) {
          await writeJson(dPath, keep); // complete, or only cut short by the time budget: keep what arrived
        }
      }
    }
  }

  // ---- weekly QB check
  const weekKey = cfbWeekKey(nowMs);
  const qPath = cacheDir ? join(cacheDir, `cfb-qb-${weekKey}.json`) : null;
  let qb = qPath ? await readJson(qPath) : null;
  const backoff = qb?.retryAfter && nowMs < Date.parse(qb.retryAfter);
  if (qb?.complete || (backoff && qb?.events)) { qb.cached = true; log(`cfb qb: cache ${weekKey}`); }
  else {
    qb = { fetchedAt: iso(nowMs), weekKey, events: [], lastPassers: {}, cached: false, complete: false };
    const qErrors = [];
    try {
      const cur = await http.getJson(scoreboardUrl('cfb'));
      const st = Number(cur?.season?.type ?? cur?.leagues?.[0]?.season?.type?.type);
      const wk = Number(cur?.week?.number);
      const cal = cur?.leagues?.[0]?.calendar;
      const boards = [cur];
      for (const w of [prevWeek(cal, st, wk), nextWeek(cal, st, wk)]) {
        if (!w) continue;
        try { boards.push(await http.getJson(scoreboardUrl('cfb', w))); } catch (e) { qErrors.push(`cfb scoreboard week ${w.week}: ${errorText(e)}`); }
      }
      const seen = new Set();
      qb.events = boards.flatMap(trimBoard).filter((e) => !seen.has(e.id) && seen.add(e.id)).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id));
      // each team with an upcoming game -> its latest finished game before that kickoff
      const upcoming = qb.events.filter((e) => e.state === 'pre');
      const finished = qb.events.filter((e) => e.state === 'post');
      const want = [];
      const seenTeam = new Set(), seenEv = new Set();
      for (const e of upcoming) {
        for (const t of e.teams) {
          if (seenTeam.has(t.id)) continue;
          seenTeam.add(t.id);
          let last = null;
          for (const f of finished) if (f.date < e.date && f.teams.some((x) => x.id === t.id) && (!last || f.date > last.date)) last = f;
          if (last && !seenEv.has(last.id)) { seenEv.add(last.id); want.push(last); }
        }
      }
      const pickEv = want.slice(0, maxSummaries);
      if (want.length > pickEv.length) qErrors.push(`cfb qb: ${want.length - pickEv.length} summaries skipped (maxSummaries ${maxSummaries})`);
      let failed = 0;
      await mapLimit(pickEv, concurrency, async (ev) => {
        try {
          for (const t of summaryPassers(await http.getJson(summaryUrl('cfb', ev.id)), ev.id)) qb.lastPassers[t.teamId] = { eventId: ev.id, date: ev.date, passers: t.passers };
        } catch (e) { failed++; qErrors.push(`cfb summary ${ev.id}: ${errorText(e)}`); }
        if (pauseMs) await sleep(pauseMs);
      });
      qb.complete = failed <= Math.max(2, pickEv.length * 0.1) && want.length === pickEv.length;
      if (!qb.complete) qb.retryAfter = iso(nowMs + 6 * 3600e3);
    } catch (e) {
      qErrors.push(`cfb scoreboard: ${errorText(e)}`);
      qb.retryAfter = iso(nowMs + 3600e3);
    }
    qb.errors = qErrors;
    errors.push(...qErrors);
    if (qPath) await writeJson(qPath, { ...qb, cached: undefined });
  }
  return { season: yr, defense, qb, errors, requests: http.stats.requests + extra };
}

// ---------------------------------------------------------------- build: defense

/** ESPN byteam -> { [teamId]: { abbr, games, ptsAllowedPg, passYpaAllowed, ... } } from the Opponent split. */
export function parseEspnByTeam(json) {
  const names = Object.fromEntries((json?.categories || []).map((c) => [c.name, c.names]));
  const out = {};
  for (const t of json?.teams || []) {
    const opp = {};
    for (const cat of (t.categories || []).filter((c) => String(c.splitId) === '900')) {
      (names[cat.name] || []).forEach((n, i) => { const key = `${cat.name}.${n}`; if (!(key in opp)) opp[key] = cat.values?.[i]; });
    }
    const id = String(t.team?.id);
    out[id] = { id, abbr: t.team?.abbreviation || null, name: t.team?.displayName || null, games: opp['general.gamesPlayed'] ?? null,
      ptsAllowedPg: r2(opp['passing.totalPointsPerGame']), passYpaAllowed: r2(opp['passing.yardsPerPassAttempt']), rushYpcEspn: r2(opp['rushing.yardsPerRushAttempt']) };
  }
  return out;
}
const r2 = (x) => (Number.isFinite(+x) && x !== null && x !== '' ? Math.round(+x * 100) / 100 : null);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
function rankBy(obj, get, higherIsBetter = false) {
  const keys = Object.keys(obj).filter((k) => Number.isFinite(get(obj[k]))).sort();
  keys.sort((a, b) => (higherIsBetter ? get(obj[b]) - get(obj[a]) : get(obj[a]) - get(obj[b])));
  const out = {}; keys.forEach((k, i) => { out[k] = i + 1; }); return out;
}

const DVP_COLS = ['team_id', 'pos_team', 'division', 'position_group', 'plays', 'games', 'epa_per_play_allowed', 'carries', 'rush_yards_per_carry_allowed'];

/** FBS ratings keyed by ESPN team id (sportsdataverse team_id is the ESPN id). Ranks are over all FBS teams. */
export function cfbDefenseById(dvpCsv, byTeamJson) {
  const t = parseCsv(dvpCsv, { columns: DVP_COLS });
  const miss = ['team_id', 'division', 'position_group', 'plays', 'epa_per_play_allowed'].filter((c) => t.missing.includes(c));
  if (miss.length) throw new Error(`cfb dvp: missing columns ${miss.join(', ')}`);
  const c = colIndex(t.head, DVP_COLS, { required: false });
  const espn = byTeamJson ? parseEspnByTeam(byTeamJson) : {};
  const T = {};
  for (const r of t.rows) {
    if (r[c.division] !== 'fbs') continue;
    const id = String(r[c.team_id]);
    const x = (T[id] ||= { id, name: r[c.pos_team], games: 0, pos: {} });
    x.games = Math.max(x.games, +r[c.games] || 0);
    x.pos[r[c.position_group]] = { plays: +r[c.plays] || 0, epa: num(r[c.epa_per_play_allowed]), ypc: num(r[c.rush_yards_per_carry_allowed]) };
  }
  const out = {};
  for (const [id, x] of Object.entries(T)) {
    const e = espn[id];
    let ep = 0, pl = 0;
    for (const v of Object.values(x.pos)) if (Number.isFinite(v.epa) && v.plays) { ep += v.epa * v.plays; pl += v.plays; }
    out[id] = {
      abbr: e?.abbr ?? null,
      games: x.games,
      ptsAllowedPg: e?.ptsAllowedPg ?? null,
      passYpaAllowed: e?.passYpaAllowed ?? null,                       // ESPN opponent passing yards per attempt
      rushYpcAllowed: Number.isFinite(x.pos.RB?.ypc) ? r2(x.pos.RB.ypc) : null, // RB carries only (ESPN counts sacks as rushes)
      epaAllowed: Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map((p) => [p, Number.isFinite(x.pos[p]?.epa) ? r3(x.pos[p].epa) : null])),
      _overall: pl ? ep / pl : NaN,
    };
  }
  // pass = EPA allowed on QB plays (dropbacks plus designed QB runs), rush = EPA allowed on RB plays,
  // overall = play-weighted EPA over the four position groups, points = points allowed per game. 1 = toughest.
  const R = { pass: rankBy(out, (v) => v.epaAllowed.QB), rush: rankBy(out, (v) => v.epaAllowed.RB), overall: rankBy(out, (v) => v._overall), points: rankBy(out, (v) => v.ptsAllowedPg) };
  for (const [id, v] of Object.entries(out)) { v.ranks = Object.fromEntries(Object.entries(R).map(([k, m]) => [k, m[id] ?? null])); delete v._overall; }
  return out;
}

// ---------------------------------------------------------------- build: QB changes

/** Detector from research2 injuries.mjs: season leader threw < 5 passes last game while another QB threw 10+. */
export function detectQbChange(leader, last) {
  if (!leader?.id || !last?.passers?.length) return null;
  const top = [...last.passers].sort((a, b) => b.att - a.att || a.id.localeCompare(b.id))[0];
  const leaderAtt = last.passers.find((p) => p.id === leader.id)?.att || 0;
  if (!top || top.att < 10 || top.id === leader.id || leaderAtt >= 5) return null;
  return { top, leaderAtt };
}

/**
 * buildCfb(raw, { games }) -> { defense: { cfb: { [ESPN abbr]: rating } }, cfbQbChanges: [...], ok, errors, warnings }
 * defense.cfb covers the teams in `games` (CFB) when games are given, else every FBS team with an abbreviation.
 * cfbQbChanges[i] = { gameId, team: 'home'|'away', expected, last, note, expectedId, lastId, lastAtt, expectedAttLast, lastEventId, lastGameAt }
 */
export function buildCfb(raw = {}, { games = [] } = {}) {
  const errors = [], warnings = [];
  const cfbGames = (games || []).filter((g) => g?.league === 'cfb');
  const defense = {};
  const d = raw?.defense;
  if (!d?.dvp) errors.push('cfb dvp: missing');
  else {
    try {
      const byId = cfbDefenseById(d.dvp, d.byTeam || null);
      if (!d.byTeam) errors.push('cfb byteam: missing (points allowed and YPA are null)');
      const add = (abbr, id) => { if (abbr && byId[id] && !defense[abbr]) { const { abbr: _a, ...v } = byId[id]; defense[abbr] = v; } };
      if (cfbGames.length) {
        let missing = 0;
        for (const g of cfbGames) for (const side of ['home', 'away']) {
          const t = g[side];
          if (t?.abbr && byId[String(t.espnId)]) add(t.abbr, String(t.espnId));
          else missing++;
        }
        if (missing) warnings.push(`cfb defense: ${missing} team slot(s) in games have no FBS rating (FCS opponents or no data yet)`);
      } else {
        for (const [id, v] of Object.entries(byId)) add(v.abbr, id);
      }
    } catch (e) { errors.push(String(e?.message || e).slice(0, 200)); }
  }

  const cfbQbChanges = [];
  const q = raw?.qb;
  if (!q?.events) { if (cfbGames.length) errors.push('cfb qb: no weekly data'); }
  else {
    const leaderOf = (teamId, eventId) => {
      const ev = q.events.find((e) => e.id === String(eventId));
      const own = ev?.teams.find((t) => t.id === teamId)?.leader;
      if (own) return own;
      for (const e of q.events) if (e.state === 'pre') { const l = e.teams.find((t) => t.id === teamId)?.leader; if (l) return l; }
      return null;
    };
    for (const g of [...cfbGames].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      if (g.state !== 'pre') continue;
      for (const side of ['home', 'away']) {
        const t = g[side];
        const tid = String(t?.espnId);
        const leader = leaderOf(tid, g.espnId);
        const last = q.lastPassers?.[tid];
        if (!leader || !last || (last.date && Date.parse(last.date) >= Date.parse(g.kickoff))) continue;
        const hit = detectQbChange(leader, last);
        if (!hit) continue;
        cfbQbChanges.push({
          gameId: g.id, team: side, expected: leader.name, last: hit.top.name,
          note: `${t.abbr} season passing leader ${leader.name} threw ${hit.leaderAtt} pass${hit.leaderAtt === 1 ? '' : 'es'} in the last game; ${hit.top.name} threw ${hit.top.att}. Check team news for the starter.`,
          expectedId: leader.id, lastId: hit.top.id, lastAtt: hit.top.att, expectedAttLast: hit.leaderAtt, lastEventId: last.eventId, lastGameAt: last.date ?? null,
        });
      }
    }
  }
  return { defense: { cfb: defense }, cfbQbChanges, ok: errors.length === 0, errors, warnings };
}

/** cfbQbChanges -> { [gameId]: [Angle] } with kind 'cfb-qb-change' (grade questionable: a box score hint, not a report). */
export function cfbQbAngles(changes, games = []) {
  const byId = new Map((games || []).map((g) => [g.id, g]));
  const out = {};
  for (const c of changes || []) {
    const abbr = byId.get(c.gameId)?.[c.team]?.abbr || '';
    (out[c.gameId] ||= []).push({
      kind: 'cfb-qb-change', team: c.team, player: c.expected, playerId: c.expectedId, role: 'QB1', grade: 'questionable', why: c.note,
      beneficiaries: [{ name: c.last, id: c.lastId, why: 'threw the most passes in the last game', team: c.team }],
      fades: [{ name: `${abbr} team total and spread`.trim(), id: null, why: 'possible starting QB change', team: c.team }],
      signals: [{ kind: 'box-score', text: `${c.last} ${c.lastAtt} attempts, ${c.expected} ${c.expectedAttLast}`, at: c.lastGameAt }],
    });
  }
  return out;
}
