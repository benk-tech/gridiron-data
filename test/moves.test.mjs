import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateHistory, historyInput, applyMoves, propKey, gameLineValues, americanToProb, readHistoryFile, writeHistoryFile,
  KEEP_MS, HISTORY_VERSION,
} from '../lib/moves.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const clone = (x) => JSON.parse(JSON.stringify(x));
const T0 = Date.parse('2026-10-11T18:00:00Z');
const MIN = 60e3, HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function odds({ spread = -3, total = 43.5, home = -150, away = 130 } = {}) {
  return { provider: 'DraftKings', ml: { home, away, homeOpen: -110, awayOpen: -110 },
    spread: { home: spread, homeOdds: -110, awayOdds: -110, homeOpen: -2.5 }, total: { line: total, overOdds: -110, underOdds: -110, lineOpen: 44.5 } };
}
const game = (o = {}) => ({ id: 'nfl-401872993', league: 'nfl', kickoff: '2026-10-12T00:20:00Z', state: 'pre',
  home: { abbr: 'ATL' }, away: { abbr: 'BAL' }, odds: odds(o), dkTeamTotals: { home: { line: 23.5, open: 21.5 }, away: { line: 20.5, open: 24.5 } }, ...o.g });
const prop = (line, o = {}) => ({ gameId: 'nfl-401872993', stat: 'rushYds', player: { espnId: '3043078', name: 'Derrick Henry', team: 'BAL', side: 'away', pos: 'RB' },
  dk: { line, open: 86.5, updated: null }, rungs: [], ...o });

test('helpers: americanToProb, gameLineValues, propKey', () => {
  assert.ok(Math.abs(americanToProb(-175) - 175 / 275) < 1e-12);
  assert.ok(Math.abs(americanToProb(145) - 100 / 245) < 1e-12);
  assert.equal(americanToProb(50), null);
  const v = gameLineValues(odds({ home: -175, away: 145 }), { home: { line: 23.5 }, away: { line: null } });
  assert.equal(v.ml, 0.609);
  assert.deepEqual([v.spread, v.total, v.teamTotalHome, v.teamTotalAway], [-3, 43.5, 23.5, null]);
  assert.equal(propKey(prop(80.5)), 'nfl-401872993|rushYds|3043078');
  assert.equal(propKey({ ...prop(80.5), player: { espnId: null } }), null);
});

test('first run: history seeded, no moves; timestamps are the collector clock', () => {
  const { history, moves } = updateHistory(null, historyInput([game()], [prop(86.5)]), { now: T0 });
  assert.deepEqual(moves, { games: {}, props: {} });
  assert.equal(history.v, HISTORY_VERSION);
  assert.equal(history.at, '2026-10-11T18:00:00Z');
  const g = history.games['nfl-401872993'];
  assert.deepEqual(g.lines.spread, [['2026-10-11T18:00:00Z', -3]]);
  assert.deepEqual(g.lines.teamTotalHome, [['2026-10-11T18:00:00Z', 23.5]]);
  assert.equal(g.state, 'pre');
  assert.equal(g.pre.at, '2026-10-11T18:00:00Z');
  assert.equal(history.props['nfl-401872993|rushYds|3043078'].line.length, 1);
});

test('moves: spread, total, team total and prop changes between runs; small ML wiggles ignored', () => {
  let h = updateHistory(null, historyInput([game()], [prop(86.5)]), { now: T0 }).history;
  const prev = clone(h);
  // run 2: ML -150 -> -152 (0.2 pp, ignored), spread -3 -> -3.5, prop 86.5 -> 80.5
  let r = updateHistory(h, historyInput([game({ spread: -3.5, home: -152, away: 130 })], [prop(80.5)]), { now: T0 + 5 * MIN });
  assert.deepEqual(h, prev, 'previous history is not modified');
  assert.deepEqual(r.moves.games['nfl-401872993'], [{ market: 'spread', from: -3, to: -3.5, at: '2026-10-11T18:05:00Z' }]);
  assert.deepEqual(r.moves.props['nfl-401872993|rushYds|3043078'], [{ from: 86.5, to: 80.5, at: '2026-10-11T18:05:00Z' }]);
  h = r.history;
  // run 3: ML -150 -> -175 (well over 0.5 pp), total 43.5 -> 44.5, team total home 23.5 -> 24
  const g3 = game({ spread: -3.5, total: 44.5, home: -175, away: 145 });
  g3.dkTeamTotals.home.line = 24;
  r = updateHistory(h, historyInput([g3], [prop(80.5)]), { now: T0 + 10 * MIN });
  const at3 = '2026-10-11T18:10:00Z';
  assert.deepEqual(r.moves.games['nfl-401872993'], [
    { market: 'spread', from: -3, to: -3.5, at: '2026-10-11T18:05:00Z' },
    { market: 'ml', from: 0.58, to: 0.609, at: at3 },
    { market: 'total', from: 43.5, to: 44.5, at: at3 },
    { market: 'teamTotalHome', from: 23.5, to: 24, at: at3 },
  ]);
  assert.equal(r.history.games['nfl-401872993'].lines.spread.length, 2, 'unchanged runs add no points');
});

test('48 h window: old moves drop out, the newest old point stays as the baseline, unseen games are pruned', () => {
  let h = updateHistory(null, historyInput([game()], [prop(86.5)]), { now: T0 }).history;
  h = updateHistory(h, historyInput([game({ spread: -3.5 })], [prop(80.5)]), { now: T0 + HOUR }).history;
  // 50 h later: still the same values; the move at T0+1h is now outside the window
  let r = updateHistory(h, historyInput([game({ spread: -3.5 })], [prop(80.5)]), { now: T0 + 51 * HOUR });
  assert.deepEqual(r.moves, { games: {}, props: {} });
  assert.deepEqual(r.history.games['nfl-401872993'].lines.spread, [[iso(T0 + HOUR), -3.5]], 'baseline kept');
  // a later change moves from the baseline value
  r = updateHistory(r.history, historyInput([game({ spread: -4 })], [prop(80.5)]), { now: T0 + 52 * HOUR });
  assert.deepEqual(r.moves.games['nfl-401872993'], [{ market: 'spread', from: -3.5, to: -4, at: iso(T0 + 52 * HOUR) }]);
  // a game (and its props) not seen for more than 48 h is removed
  r = updateHistory(r.history, { games: [], props: [] }, { now: T0 + 52 * HOUR + KEEP_MS + MIN });
  assert.deepEqual(r.history.games, {});
  assert.deepEqual(r.history.props, {});
});

test('in-game: lines stop recording at kickoff, last pregame values kept for the closes archive', () => {
  let h = updateHistory(null, historyInput([game()], [prop(80.5)]), { now: T0 }).history;
  const live = game({ spread: 7.5, g: { state: 'in' } });
  live.dkTeamTotals = null;
  const r = updateHistory(h, historyInput([live], [prop(120.5)]), { now: T0 + 7 * HOUR });
  const g = r.history.games['nfl-401872993'];
  assert.equal(g.state, 'in');
  assert.deepEqual(g.lines.spread, [[iso(T0), -3]]);
  assert.equal(g.pre.odds.spread.home, -3);
  assert.equal(r.history.props['nfl-401872993|rushYds|3043078'].dk.line, 80.5);
  assert.deepEqual(r.moves, { games: {}, props: {} });
  // a pregame game that vanished from the snapshot after kickoff is marked started (closes fire once)
  h = updateHistory(null, historyInput([game()], []), { now: T0 }).history;
  const gone = updateHistory(h, { games: [], props: [] }, { now: Date.parse('2026-10-12T00:30:00Z') }).history;
  assert.equal(gone.games['nfl-401872993'].state, 'started');
  // ...but not before its kickoff (an ESPN outage must not end a game)
  const early = updateHistory(h, { games: [], props: [] }, { now: T0 + HOUR }).history;
  assert.equal(early.games['nfl-401872993'].state, 'pre');
});

test('DK pulls a line right before kickoff: the last value stays as the pregame close', () => {
  let h = updateHistory(null, historyInput([game()], [prop(80.5)]), { now: T0 }).history;
  const g = game({ g: { odds: null, dkTeamTotals: null } });
  h = updateHistory(h, historyInput([g], [prop(80.5, { dk: null })]), { now: T0 + 5 * MIN }).history;
  assert.equal(h.games['nfl-401872993'].pre.odds.spread.home, -3);
  assert.equal(h.games['nfl-401872993'].pre.dkTeamTotals.home.line, 23.5);
  assert.equal(h.games['nfl-401872993'].pre.at, iso(T0 + 5 * MIN));
  assert.equal(h.props['nfl-401872993|rushYds|3043078'].dk.line, 80.5);
});

test('applyMoves attaches arrays to every game and prop; historyInput skips props with no ESPN id', () => {
  const games = [game(), { ...game(), id: 'nfl-2' }];
  const props = [prop(80.5), { ...prop(10.5), player: { espnId: null, name: 'X' } }];
  assert.equal(historyInput(games, props).props.length, 1);
  applyMoves(games, props, { games: { 'nfl-401872993': [{ market: 'spread', from: -3, to: -3.5, at: 'a' }] }, props: { 'nfl-401872993|rushYds|3043078': [{ from: 86.5, to: 80.5, at: 'a' }] } });
  assert.equal(games[0].moves.length, 1);
  assert.deepEqual(games[1].moves, []);
  assert.equal(props[0].moves.length, 1);
  assert.deepEqual(props[1].moves, []);
});

test('bad or foreign history files start fresh; history round-trips through the file helpers', async () => {
  for (const bad of [{ v: 99, games: {} }, 'nope', { v: 1, games: { x: null, y: { lines: { spread: [['not a date', 1], [iso(T0), 'x']] } } } }]) {
    const r = updateHistory(bad, historyInput([game()], []), { now: T0 });
    assert.deepEqual(r.moves, { games: {}, props: {} });
    assert.ok(r.history.games['nfl-401872993']);
  }
  const dir = await mkdtemp(join(tmpdir(), 'gd-hist-'));
  try {
    const path = join(dir, 'state', 'history.json');
    assert.equal(await readHistoryFile(path), null);
    const { history } = updateHistory(null, historyInput([game()], [prop(80.5)]), { now: T0 });
    await writeHistoryFile(path, history);
    assert.deepEqual(await readHistoryFile(path), history);
    await writeFile(path, '{ truncated');
    assert.equal(await readHistoryFile(path), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('updateHistory is deterministic for the same inputs and now', () => {
  const run = () => {
    let h = updateHistory(null, historyInput([game()], [prop(86.5)]), { now: T0 }).history;
    return updateHistory(h, historyInput([game({ spread: -4 })], [prop(80.5)]), { now: T0 + 5 * MIN });
  };
  assert.deepEqual(run(), run());
  assert.throws(() => updateHistory(null, { games: [] }, { now: 'not a time' }));
});
