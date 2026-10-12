// Kalshi implied centers in the line history (lib/moves.mjs) and games[i].kalshiMoves in the snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  kalshiCenters, updateHistory, historyInput, applyMoves, KALSHI_MARKETS, KALSHI_MIN_STEP, KALSHI_SNAPSHOT_MAX, KEEP_MS, MAX_POINTS,
} from '../lib/moves.mjs';
import { buildRun } from '../lib/build.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { researchInputs, RESEARCH_NOW, balatlInputs, BALATL_NOW } from './helpers.mjs';

const T0 = Date.parse('2026-10-11T18:00:00Z');
const MIN = 60e3, HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ID = 'nfl-401872993';

// One market in the snapshot's Market shape: YES quotes around `mid`, one cent wide unless `width` says otherwise.
const mk = (type, team, strike, mid, { width = 0.02, status = 'active' } = {}) => ({
  ticker: `T-${type}-${team}-${strike}`, type, team, strike, status,
  yesAsk: +(mid + width / 2).toFixed(3), yesBid: +(mid - width / 2).toFixed(3),
});
// ATL (home) about 3 points better than BAL; total about 43.8; home wins about 61%.
function markets({ home = 0.61, sp = [0.70, 0.62, 0.47, 0.35], tot = [0.58, 0.46] } = {}) {
  return [
    mk('game', 'home', null, home), mk('game', 'away', null, 1 - home),
    mk('spread', 'away', 1.5, 1 - sp[0]), mk('spread', 'home', 1.5, sp[1]), mk('spread', 'home', 3.5, sp[2]), mk('spread', 'home', 5.5, sp[3]),
    mk('total', null, 42.5, tot[0]), mk('total', null, 44.5, tot[1]),
  ];
}
const game = ({ state = 'pre', ms = markets() } = {}) => ({ id: ID, league: 'nfl', kickoff: '2026-10-12T00:20:00Z', state,
  home: { abbr: 'ATL' }, away: { abbr: 'BAL' },
  odds: { provider: 'DraftKings', ml: { home: -150, away: 130 }, spread: { home: -3 }, total: { line: 43.5 } }, dkTeamTotals: null,
  kalshi: { gameEvent: 'KXNFLGAME-26OCT11BALATL', markets: ms } });
const run = (prev, g, t) => updateHistory(prev, historyInput([g], []), { now: t });

test('kalshiCenters: home win from the GAME mid, spread and total where the ladders cross 50%', () => {
  // spread points: (-1.5, 0.70) from the away rung, (1.5, 0.62), (3.5, 0.47), (5.5, 0.35): crosses at 1.5 + 0.12 / 0.15 * 2 = 3.1
  // total: (42.5, 0.58), (44.5, 0.46): crosses at 42.5 + 0.08 / 0.12 * 2 = 43.83
  assert.deepEqual(kalshiCenters(game()), { ml: 0.61, spread: -3.1, total: 43.8 });
  // the away GAME market stands in when the home quote is too wide; a paused or wide rung is skipped
  const ms = markets();
  ms[0] = mk('game', 'home', null, 0.61, { width: 0.2 });
  ms[1] = mk('game', 'away', null, 0.35);
  ms[4] = mk('spread', 'home', 3.5, 0.47, { status: 'closed' });
  ms.push(mk('spread', 'home', 6.5, 0.30), mk('teamTotal', 'home', 23.5, 0.5));
  // spread now (-1.5, 0.70), (1.5, 0.62), (5.5, 0.35), (6.5, 0.30): 1.5 + 0.12 / 0.27 * 4 = 3.28
  assert.deepEqual(kalshiCenters(game({ ms })), { ml: 0.65, spread: -3.3, total: 43.8 });
  // nothing usable: no Kalshi block, no ladders, a ladder that never crosses 50%
  assert.deepEqual(kalshiCenters({ id: 'x' }), { ml: null, spread: null, total: null });
  assert.deepEqual(kalshiCenters(game({ ms: [mk('total', null, 40.5, 0.8), mk('total', null, 42.5, 0.7)] })), { ml: null, spread: null, total: null });
  // a pick em center is 0, never -0 (the snapshot must not depend on the sign of zero)
  const pk = kalshiCenters(game({ ms: [mk('spread', 'home', 1.5, 0.4), mk('spread', 'away', 1.5, 0.4)] }));
  assert.ok(Object.is(pk.spread, 0), String(pk.spread));
});

test('kalshiCenters on real markets: BAL@ATL at 23:49Z sits next to the DK line (ATL -3, total 43.5)', () => {
  const r = buildRun(balatlInputs(), { now: BALATL_NOW });
  const g = r.snapshot.games.find((x) => x.id === ID);
  assert.deepEqual(kalshiCenters(g), { ml: 0.625, spread: -3.2, total: 44 });
  assert.deepEqual(r.history.games[ID].kalshi, { ml: [[BALATL_NOW, 0.625]], spread: [[BALATL_NOW, -3.2]], total: [[BALATL_NOW, 44]] });
  // BUF@LAR had no Kalshi markets in this capture: no Kalshi series at all
  assert.deepEqual(r.history.games['nfl-401872994'].kalshi, {});
});

test('history: centers recorded each run, jitter under the step ignored, real moves emitted with the collector time', () => {
  assert.deepEqual(KALSHI_MARKETS, ['ml', 'spread', 'total']);
  assert.deepEqual({ ...KALSHI_MIN_STEP }, { ml: 0.01, spread: 0.25, total: 0.25 });
  let r = run(null, game(), T0);
  assert.deepEqual(r.history.games[ID].kalshi, { ml: [[iso(T0), 0.61]], spread: [[iso(T0), -3.1]], total: [[iso(T0), 43.8]] });
  assert.deepEqual(r.moves.kalshi, {});
  // run 2: half a cent on the moneyline, 0.2 on the spread: noise, no points
  r = run(r.history, game({ ms: markets({ home: 0.605, sp: [0.70, 0.635, 0.485, 0.35] }) }), T0 + 5 * MIN);
  assert.equal(kalshiCenters(game({ ms: markets({ sp: [0.70, 0.635, 0.485, 0.35] }) })).spread, -3.3);
  assert.deepEqual(r.history.games[ID].kalshi.ml, [[iso(T0), 0.61]]);
  assert.deepEqual(r.history.games[ID].kalshi.spread, [[iso(T0), -3.1]]);
  assert.deepEqual(r.moves.kalshi, {});
  // run 3: the moneyline goes 0.61 to 0.62 (exactly one step) and the spread ladder to -3.8
  r = run(r.history, game({ ms: markets({ home: 0.62, sp: [0.72, 0.66, 0.52, 0.40] }) }), T0 + 10 * MIN);
  const at3 = iso(T0 + 10 * MIN);
  assert.deepEqual(r.moves.kalshi[ID], [
    { market: 'ml', from: 0.61, to: 0.62, at: at3 },
    { market: 'spread', from: -3.1, to: -3.8, at: at3 },
  ]);
  assert.deepEqual(r.moves.games, {}, 'DK did not move');
  // the steps are measured from the last recorded point: 0.56 to 0.57 is a full cent even though 0.57 - 0.56 < 0.01
  let h = run(null, game({ ms: markets({ home: 0.56 }) }), T0).history;
  h = run(h, game({ ms: markets({ home: 0.57 }) }), T0 + 5 * MIN).history;
  assert.deepEqual(h.games[ID].kalshi.ml.map((p) => p[1]), [0.56, 0.57]);
});

test('history: a market that cannot be priced this run adds nothing; in-game runs record nothing', () => {
  let h = run(null, game(), T0).history;
  // the spread ladder goes wide (no rung inside 10 cents): no point, the series keeps its last value
  const wide = markets().map((m) => (m.type === 'spread' ? { ...m, yesAsk: m.yesAsk + 0.1 } : m));
  let r = run(h, game({ ms: wide }), T0 + 5 * MIN);
  assert.deepEqual(r.history.games[ID].kalshi.spread, [[iso(T0), -3.1]]);
  // when it comes back moved, the move starts from the last recorded value
  r = run(r.history, game({ ms: markets({ sp: [0.70, 0.66, 0.55, 0.40] }) }), T0 + 10 * MIN);
  assert.deepEqual(r.moves.kalshi[ID], [{ market: 'spread', from: -3.1, to: -4.2, at: iso(T0 + 10 * MIN) }]);
  // after kickoff Kalshi keeps trading but nothing is recorded (in-game prices are not pregame moves)
  h = r.history;
  r = run(h, game({ state: 'in', ms: markets({ home: 0.9, sp: [0.95, 0.9, 0.85, 0.6] }) }), T0 + 7 * HOUR);
  assert.deepEqual(r.history.games[ID].kalshi, h.games[ID].kalshi);
  assert.deepEqual(r.moves.kalshi[ID], [{ market: 'spread', from: -3.1, to: -4.2, at: iso(T0 + 10 * MIN) }], 'pregame moves stay for display');
});

test('history: a v1 file written before the Kalshi centers loads as is and keeps its DK lines', () => {
  const old = { v: 1, at: iso(T0), props: {}, games: { [ID]: { league: 'nfl', kickoff: '2026-10-12T00:20:00Z', home: 'ATL', away: 'BAL', state: 'pre',
    seen: iso(T0), pre: null, lines: { spread: [[iso(T0), -2.5]], total: [[iso(T0), 43.5]] } } } };
  const r = run(old, game(), T0 + 5 * MIN);
  assert.deepEqual(r.moves.games[ID], [{ market: 'spread', from: -2.5, to: -3, at: iso(T0 + 5 * MIN) }], 'DK history survived');
  assert.deepEqual(r.history.games[ID].kalshi, { ml: [[iso(T0 + 5 * MIN), 0.61]], spread: [[iso(T0 + 5 * MIN), -3.1]], total: [[iso(T0 + 5 * MIN), 43.8]] });
  assert.deepEqual(r.moves.kalshi, {}, 'first Kalshi sighting is a baseline, not a move');
  // malformed Kalshi points are dropped, the rest kept
  const bad = structuredClone(r.history);
  bad.games[ID].kalshi = { ml: [['not a date', 0.5], [iso(T0 + 5 * MIN), 0.61]], spread: 'nope', junk: [[iso(T0), 1]] };
  const r2 = run(bad, game(), T0 + 10 * MIN);
  assert.deepEqual(r2.history.games[ID].kalshi.ml, [[iso(T0 + 5 * MIN), 0.61]]);
  assert.deepEqual(r2.history.games[ID].kalshi.spread, [[iso(T0 + 10 * MIN), -3.1]]);
  assert.equal(r2.history.games[ID].kalshi.junk, undefined);
});

test('48 h window and size caps: old Kalshi moves drop out, a flapping market keeps only its newest moves in the snapshot', () => {
  let h = run(null, game(), T0).history;
  h = run(h, game({ ms: markets({ home: 0.64 }) }), T0 + HOUR).history;
  let r = run(h, game({ ms: markets({ home: 0.64 }) }), T0 + 51 * HOUR);
  assert.deepEqual(r.moves.kalshi, {});
  assert.deepEqual(r.history.games[ID].kalshi.ml, [[iso(T0 + HOUR), 0.64]], 'baseline kept');
  // a ladder flapping between two centers every run: the history keeps up to MAX_POINTS, the snapshot the newest few
  h = run(null, game(), T0).history;
  const flaps = 30;
  for (let i = 1; i <= flaps; i++) h = run(h, game({ ms: markets({ home: i % 2 ? 0.65 : 0.61 }) }), T0 + i * 5 * MIN).history;
  r = run(h, game({ ms: markets({ home: 0.61 }) }), T0 + flaps * 5 * MIN);
  assert.equal(r.history.games[ID].kalshi.ml.length, flaps + 1);
  assert.ok(flaps + 1 <= MAX_POINTS);
  const ml = r.moves.kalshi[ID].filter((m) => m.market === 'ml');
  assert.equal(ml.length, KALSHI_SNAPSHOT_MAX);
  assert.equal(ml.at(-1).at, iso(T0 + flaps * 5 * MIN), 'the newest are kept');
  // a game not seen for 48 h goes, Kalshi points with it
  r = run(r.history, { ...game(), id: 'nfl-other' }, T0 + flaps * 5 * MIN + KEEP_MS + MIN);
  assert.deepEqual(Object.keys(r.history.games), ['nfl-other']);
});

test('applyMoves: every game gets kalshiMoves (empty when none), copies not shared references', () => {
  const games = [game(), { ...game(), id: 'nfl-2' }];
  const mv = { games: {}, props: {}, kalshi: { [ID]: [{ market: 'ml', from: 0.61, to: 0.62, at: iso(T0) }] } };
  applyMoves(games, [], mv);
  assert.deepEqual(games[0].kalshiMoves, mv.kalshi[ID]);
  assert.notEqual(games[0].kalshiMoves[0], mv.kalshi[ID][0]);
  assert.deepEqual(games[1].kalshiMoves, []);
  applyMoves(games, [], { games: {}, props: {} }); // the builder's fallback when the move step fails
  assert.deepEqual(games.map((g) => g.kalshiMoves), [[], []]);
});

test('schema: kalshiMoves must use ml, spread or total, and ml values are probabilities', () => {
  const r = buildRun(balatlInputs(), { now: BALATL_NOW });
  const s = r.snapshot;
  assert.deepEqual(validateSnapshot(s), []);
  assert.ok(s.games.every((g) => Array.isArray(g.kalshiMoves) && g.kalshiMoves.length === 0));
  const g = s.games[0];
  g.kalshiMoves = [{ market: 'spread', from: -3.1, to: -3.7, at: BALATL_NOW }, { market: 'ml', from: 0.61, to: 0.62, at: BALATL_NOW }];
  assert.deepEqual(validateSnapshot(s), []);
  g.kalshiMoves = [{ market: 'teamTotalHome', from: 23.5, to: 24.5, at: BALATL_NOW }, { market: 'ml', from: 61, to: 62, at: BALATL_NOW }, { market: 'total', from: 'x', to: 44, at: BALATL_NOW }];
  const p = validateSnapshot(s);
  assert.ok(p.includes('games[0].kalshiMoves[0].market teamTotalHome'), p.join(' | '));
  assert.ok(p.includes('games[0].kalshiMoves[1] ml must be a probability'), p.join(' | '));
  assert.ok(p.includes('games[0].kalshiMoves[2] { from, to, at }'), p.join(' | '));
});

test('buildRun across two runs: Kalshi moves on the snapshot, deterministic, counted in sources.moves', () => {
  const NOW = Date.parse(RESEARCH_NOW);
  const r1 = buildRun(researchInputs(), { now: NOW });
  assert.deepEqual(validateSnapshot(r1.snapshot), []);
  assert.ok(r1.snapshot.games.every((g) => Array.isArray(g.kalshiMoves) && g.kalshiMoves.length === 0));
  const withCenters = r1.snapshot.games.filter((g) => g.state === 'pre' && Object.values(kalshiCenters(g)).some((v) => v != null)).length;
  assert.ok(withCenters >= 50, `${withCenters}`);
  assert.equal(r1.snapshot.sources.moves.kalshiGames, withCenters);
  // run 2, five minutes later: SEA@DEN's moneyline moves 3 cents toward Denver on Kalshi; DK does not move
  const in2 = researchInputs();
  for (const m of in2.kalshi.markets.KXNFLGAME) {
    if (m.event_ticker !== 'KXNFLGAME-26OCT15SEADEN') continue;
    const d = m.ticker.endsWith('-DEN') ? 0.03 : -0.03;
    for (const k of ['yes_ask_dollars', 'yes_bid_dollars']) m[k] = (Number(m[k]) + d).toFixed(4);
    for (const k of ['no_ask_dollars', 'no_bid_dollars']) m[k] = (Number(m[k]) - d).toFixed(4);
  }
  in2.history = r1.history;
  const t2 = NOW + 5 * MIN;
  const r2 = buildRun(in2, { now: t2 });
  assert.deepEqual(validateSnapshot(r2.snapshot), []);
  const den = r2.snapshot.games.find((g) => g.kalshi.gameEvent === 'KXNFLGAME-26OCT15SEADEN');
  assert.deepEqual(den.kalshiMoves, [{ market: 'ml', from: 0.445, to: 0.475, at: iso(t2) }]);
  assert.deepEqual(den.moves, []);
  assert.equal(r2.snapshot.games.reduce((a, g) => a + g.kalshiMoves.length, 0), 1, 'nothing else moved');
  // the same inputs give the same snapshot and history
  const again = buildRun({ ...structuredClone(in2), history: r1.history }, { now: t2 });
  assert.deepEqual(again.snapshot, r2.snapshot);
  assert.deepEqual(again.history, r2.history);
});

// Same method as the site's engine. Runs only where the gridiron-picks checkout sits next to this one (not in CI).
const PICKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'gridiron-picks');
const ENGINE = join(PICKS, 'public', 'js', 'engine', 'angles.js');
test('kalshiCenters matches the engine (angles.js) on the site fixtures', { skip: !existsSync(ENGINE) && 'gridiron-picks not checked out next to gridiron-data' }, async () => {
  const { kalshiCenters: engine } = await import(pathToFileURL(ENGINE).href);
  const same = (a, b) => (a == null ? b == null : b != null && a === +b); // the engine may return -0 for a pick em
  let compared = 0;
  for (const f of ['snapshot-live.json', 'snapshot-live2.json', 'snapshot-pinn.json', 'snapshot-balatl.json']) {
    const path = join(PICKS, 'test', 'fixtures', f);
    if (!existsSync(path)) continue;
    for (const g of JSON.parse(readFileSync(path, 'utf8')).games) {
      const a = kalshiCenters(g), b = engine(g);
      assert.ok(same(a.ml, b.homeWin) && same(a.spread, b.spreadCenter) && same(a.total, b.totalCenter), `${f} ${g.id}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      compared++;
    }
  }
  assert.ok(compared >= 100, `${compared} games compared`);
});
