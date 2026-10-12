import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateHistory, historyInput } from '../lib/moves.mjs';
import { closesFromTransition, writeClosesFile, syncClosesDir, etDay, formatClosesFile } from '../lib/closes.mjs';

const MIN = 60e3, HOUR = 3600e3;
const KICK = Date.parse('2026-10-12T00:20:00Z'); // SNF, Sunday 8:20 PM ET
const odds = (spread) => ({ provider: 'DraftKings', ml: { home: -175, away: 145 }, spread: { home: spread }, total: { line: 43.5 } });
const game = (state, spread = -3, extra = {}) => ({ id: 'nfl-401872993', league: 'nfl', kickoff: '2026-10-12T00:20:00Z', state,
  home: { abbr: 'ATL' }, away: { abbr: 'BAL' }, odds: odds(spread), dkTeamTotals: { home: { line: 23.5, open: 21.5 }, away: { line: 20.5, open: 24.5 } }, ...extra });
const other = (state) => ({ id: 'cfb-401871067', league: 'cfb', kickoff: '2026-10-13T23:30:00Z', state, home: { abbr: 'MTSU' }, away: { abbr: 'DEL' }, odds: odds(-7), dkTeamTotals: null });
const prop = (stat, line, name = 'Derrick Henry', espnId = '3043078') => ({ gameId: 'nfl-401872993', stat, dk: { line, open: line + 1, updated: null },
  player: { espnId, name, team: 'BAL', side: 'away', pos: 'RB' }, rungs: [] });

function pregameHistory() {
  let h = updateHistory(null, historyInput([game('pre'), other('pre')], [prop('rushYds', 86.5), prop('rec', 1.5)]), { now: KICK - 2 * HOUR }).history;
  h = updateHistory(h, historyInput([game('pre', -3.5), other('pre')], [prop('rushYds', 81.5), prop('rec', 1.5)]), { now: KICK - 5 * MIN }).history;
  return h;
}

test("closesFromTransition: 'pre' to 'in' emits the last pregame lines once", () => {
  const prev = pregameHistory();
  const now = KICK + 3 * MIN;
  const games = [game('in', 7), other('pre')];
  const closes = closesFromTransition(prev, games, [], { now });
  assert.equal(closes.length, 1);
  const c = closes[0];
  assert.deepEqual(Object.keys(c), ['gameId', 'league', 'kickoff', 'home', 'away', 'lastPregameAt', 'odds', 'dkTeamTotals', 'props']);
  assert.equal(c.gameId, 'nfl-401872993');
  assert.equal(c.lastPregameAt, '2026-10-12T00:15:00Z');
  assert.equal(c.odds.spread.home, -3.5, 'last pregame line, not the in-game 7');
  assert.deepEqual(c.dkTeamTotals.home, { line: 23.5, open: 21.5 });
  assert.deepEqual(c.props.map((p) => [p.stat, p.player.name, p.dk.line]), [['rec', 'Derrick Henry', 1.5], ['rushYds', 'Derrick Henry', 81.5]]);
  // after this run updates the history, the next run does not emit it again
  const next = updateHistory(prev, historyInput(games, []), { now }).history;
  assert.deepEqual(closesFromTransition(next, [game('in', 10), other('pre')], [], { now: now + 5 * MIN }), []);
});

test('closesFromTransition: a game that vanished after kickoff counts (snapshot drops post games, runs get skipped)', () => {
  const prev = pregameHistory();
  const closes = closesFromTransition(prev, [other('pre')], [], { now: KICK + 4 * HOUR });
  assert.deepEqual(closes.map((c) => c.gameId), ['nfl-401872993']);
  // missing before its kickoff (an ESPN outage) is not a close
  assert.deepEqual(closesFromTransition(prev, [], [], { now: KICK - MIN }), []);
  // still pregame: nothing
  assert.deepEqual(closesFromTransition(prev, [game('pre'), other('pre')], [], { now: KICK - MIN }), []);
  // no previous history: nothing
  assert.deepEqual(closesFromTransition(null, [game('in')], [], { now: KICK }), []);
  // post straight from pre (collector was down through the game)
  assert.equal(closesFromTransition(prev, [game('post')], [], { now: KICK + 4 * HOUR }).length, 1);
});

test('writeClosesFile: ET slate date, dedupe by gameId, one game per line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gd-closes-'));
  try {
    const prev = pregameHistory();
    const closes = closesFromTransition(prev, [game('in')], [], { now: KICK + 3 * MIN });
    assert.equal(etDay(KICK), '2026-10-11', 'SNF at 00:20Z is Sunday in ET');
    const r = await writeClosesFile(dir, closes, { now: KICK + 3 * MIN });
    assert.equal(r.added, 1);
    assert.deepEqual(await readdir(dir), ['2026-10-11.json']);
    const text = await readFile(join(dir, '2026-10-11.json'), 'utf8');
    const doc = JSON.parse(text);
    assert.equal(doc.v, 1);
    assert.equal(doc.date, '2026-10-11');
    assert.equal(doc.games.length, 1);
    assert.equal(doc.games[0].capturedAt, '2026-10-12T00:23:00Z');
    assert.equal(text.split('\n').length, 4, 'header, one game line, footer, trailing newline');
    // same game again: skipped, file untouched
    const again = await writeClosesFile(dir, closes, { now: KICK + 8 * MIN });
    assert.deepEqual([again.added, again.skipped, again.files.length], [0, 1, 0]);
    assert.equal(await readFile(join(dir, '2026-10-11.json'), 'utf8'), text);
    // a second game the same ET day is appended in kickoff order
    const early = { ...closes[0], gameId: 'nfl-401872992', kickoff: '2026-10-11T17:00:00Z', props: [] };
    await writeClosesFile(dir, [early], { now: KICK + 9 * MIN });
    const doc2 = JSON.parse(await readFile(join(dir, '2026-10-11.json'), 'utf8'));
    assert.deepEqual(doc2.games.map((g) => g.gameId), ['nfl-401872992', 'nfl-401872993']);
    assert.deepEqual(await writeClosesFile(dir, [], { now: KICK }), { files: [], added: 0, skipped: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('syncClosesDir: only finished ET days reach the repo folder, merged by gameId; old staged files pruned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gd-sync-'));
  const staging = join(root, 'state', 'closes'), repo = join(root, 'closes');
  try {
    await mkdir(staging, { recursive: true });
    await mkdir(repo, { recursive: true });
    const entry = (id, kickoff) => ({ gameId: id, kickoff, league: 'nfl', odds: null, dkTeamTotals: null, props: [] });
    await writeFile(join(staging, '2026-10-11.json'), formatClosesFile({ date: '2026-10-11', games: [entry('a', '2026-10-11T17:00:00Z'), entry('b', '2026-10-11T20:25:00Z')] }));
    await writeFile(join(staging, '2026-10-12.json'), formatClosesFile({ date: '2026-10-12', games: [entry('c', '2026-10-13T00:15:00Z')] }));
    await writeFile(join(staging, '2026-09-20.json'), formatClosesFile({ date: '2026-09-20', games: [entry('old', '2026-09-20T17:00:00Z')] }));
    await writeFile(join(staging, 'notes.txt'), 'ignored');
    await writeFile(join(repo, '2026-10-11.json'), formatClosesFile({ date: '2026-10-11', games: [{ ...entry('a', '2026-10-11T17:00:00Z'), kept: true }] }));
    const now = Date.parse('2026-10-12T16:00:00Z'); // Monday noon ET: Sunday is over, Monday is not
    const r = await syncClosesDir(staging, repo, { now });
    assert.deepEqual(r.changed.map((p) => p.split(/[\\/]/).pop()).sort(), ['2026-09-20.json', '2026-10-11.json']);
    const sun = JSON.parse(await readFile(join(repo, '2026-10-11.json'), 'utf8'));
    assert.deepEqual(sun.games.map((g) => g.gameId), ['a', 'b']);
    assert.equal(sun.games[0].kept, true, 'existing repo entries win');
    assert.ok(!(await readdir(repo)).includes('2026-10-12.json'), 'Monday is still open');
    assert.deepEqual(r.pruned.map((p) => p.split(/[\\/]/).pop()), ['2026-09-20.json']);
    const again = await syncClosesDir(staging, repo, { now });
    assert.deepEqual(again.changed, [], 'nothing new: no rewrite, so no commit');
    assert.deepEqual(await syncClosesDir(join(root, 'missing'), repo, { now }), { changed: [], pruned: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closes CLI (used by the workflow) runs and reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gd-cli-'));
  try {
    const cli = fileURLToPath(new URL('../lib/closes.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [cli, 'sync', join(root, 'state', 'closes'), join(root, 'closes')], { encoding: 'utf8' });
    assert.match(out, /closes: 0 day file\(s\) updated, 0 staged file\(s\) pruned/);
    assert.throws(() => execFileSync(process.execPath, [cli], { stdio: 'pipe' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
