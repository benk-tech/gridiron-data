// Kalshi's folded book from the previous run (lib/moves.mjs foldKalshiBook, prevBooks): kept in state/history.json and
// put on the snapshot as games[i].kalshi.prevQuotes and prevAt. The site's cross market check calls a Kalshi price a
// bet only when it held for one run, so a first run, a lost cache, a game new to the board or a stale history must
// carry NO previous book (otherwise every Kalshi move would be a bet on first sight).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { foldKalshiBook, prevBooks, applyPrevBooks, updateHistory, historyInput, PREV_BOOK_MAX_AGE_MS } from '../lib/moves.mjs';
import { buildRun } from '../lib/build.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { researchInputs, RESEARCH_NOW } from './helpers.mjs';

const MIN = 60e3;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const T0 = Date.parse('2026-10-11T18:00:00Z');
const ID = 'nfl-401872993';
const mk = (type, team, strike, yesBid, yesAsk, extra = {}) => ({
  ticker: `T-${type}-${team}-${strike}`, type, team, strike, status: 'active', yesBid, yesAsk,
  noAsk: +(1 - yesBid).toFixed(4), noBid: +(1 - yesAsk).toFixed(4), yesAskSize: 100, yesBidSize: 100, ...extra,
});
const game = ({ state = 'pre', ms } = {}) => ({ id: ID, league: 'nfl', kickoff: '2026-10-12T00:20:00Z', state,
  home: { abbr: 'ATL' }, away: { abbr: 'BAL' }, odds: null, dkTeamTotals: null,
  kalshi: { gameEvent: 'KXNFLGAME-26OCT11BALATL', markets: ms || [mk('game', 'home', null, 0.60, 0.62), mk('game', 'away', null, 0.37, 0.39), mk('spread', 'home', 3.5, 0.46, 0.48), mk('total', null, 44.5, 0.49, 0.51)] } });

test('foldKalshiBook: the two winner markets fold into ml:home, ladders keep their own market, both sides required', () => {
  // home 60/62, away 37/39: YES of ml:home = min(home YES 0.62, away NO 0.63) = 0.62; NO = min(home NO 0.40, away YES 0.39)
  assert.deepEqual(foldKalshiBook(game()), { 'ml:home': { bid: 0.61, ask: 0.62 }, 'sp:home:3.5': { bid: 0.46, ask: 0.48 }, 'tot:44.5': { bid: 0.49, ask: 0.51 } });
  // the away market sets both sides: NO on Baltimore at 1 - 0.40 = 0.60, YES on Baltimore at 0.41
  const away = foldKalshiBook(game({ ms: [mk('game', 'home', null, 0.55, 0.65), mk('game', 'away', null, 0.40, 0.41)] }));
  assert.deepEqual(away, { 'ml:home': { bid: 0.59, ask: 0.60 } });
  // NO ask from 1 - yesBid when noAsk is missing; a zero size is no offer; closed markets, whole and team total strikes skipped
  const ms = [
    mk('spread', 'away', 1.5, 0.30, 0.33, { noAsk: null }),
    mk('spread', 'home', 6.5, 0.20, 0.22, { yesAskSize: 0 }),
    mk('spread', 'home', 3, 0.5, 0.52),
    mk('total', null, 47.5, 0.4, 0.42, { status: 'closed' }),
    mk('teamTotal', 'home', 23.5, 0.5, 0.52),
  ];
  assert.deepEqual(foldKalshiBook(game({ ms })), { 'sp:away:1.5': { bid: 0.30, ask: 0.33 } });
  assert.deepEqual(foldKalshiBook({ id: 'x' }), {});
});

test('history: the book and its time are kept per pregame game; a run without one keeps the old book and time', () => {
  let h = updateHistory(null, historyInput([game()], []), { now: T0 }).history;
  assert.deepEqual(h.games[ID].book, { 'ml:home': [0.61, 0.62], 'sp:home:3.5': [0.46, 0.48], 'tot:44.5': [0.49, 0.51] });
  assert.equal(h.games[ID].bookAt, iso(T0));
  // run 2: every quote one sided -> nothing to record, so the book stays with its older time
  h = updateHistory(h, historyInput([game({ ms: [mk('game', 'home', null, 0.6, 0.62, { yesBid: null, noAsk: null })] })], []), { now: T0 + 5 * MIN }).history;
  assert.equal(h.games[ID].bookAt, iso(T0));
  // in game: nothing recorded
  h = updateHistory(h, historyInput([game({ state: 'in', ms: [mk('game', 'home', null, 0.7, 0.72)] })], []), { now: T0 + 10 * MIN }).history;
  assert.equal(h.games[ID].bookAt, iso(T0));
  // a v1 file written before the book existed loads as is; a malformed book is dropped
  const old = { v: 1, at: iso(T0), games: { [ID]: { league: 'nfl', kickoff: '2026-10-12T00:20:00Z', state: 'pre', seen: iso(T0), lines: {}, kalshi: {} } }, props: {} };
  const h2 = updateHistory(old, historyInput([], []), { now: T0 + MIN }).history;
  assert.deepEqual([h2.games[ID].book, h2.games[ID].bookAt], [null, null]);
  old.games[ID].book = { 'ml:home': ['x', 2] }; old.games[ID].bookAt = iso(T0);
  assert.equal(updateHistory(old, historyInput([], []), { now: T0 + MIN }).history.games[ID].book, null);
});

test('prevBooks: only the previous run, at most 60 minutes old, only games and keys that run recorded', () => {
  const h1 = updateHistory(null, historyInput([game()], []), { now: T0 }).history;
  const at = (min) => T0 + min * MIN;
  // the next run, 5 minutes later, with Kalshi 2 cents higher on the moneyline
  const g2 = game({ ms: [mk('game', 'home', null, 0.62, 0.64), mk('game', 'away', null, 0.35, 0.37), mk('spread', 'home', 3.5, 0.46, 0.48), mk('spread', 'home', 6.5, 0.3, 0.32)] });
  const pb = prevBooks(h1, [g2], { now: at(5) });
  assert.deepEqual([...pb.keys()], [ID]);
  // keys both runs quote; the total is gone from this run and the 6.5 rung is new
  assert.deepEqual(pb.get(ID), { prevQuotes: { 'ml:home': { bid: 0.61, ask: 0.62 }, 'sp:home:3.5': { bid: 0.46, ask: 0.48 } }, prevAt: iso(T0) });
  applyPrevBooks([g2], pb);
  assert.deepEqual(g2.kalshi.prevQuotes['ml:home'], { bid: 0.61, ask: 0.62 });
  assert.equal(g2.kalshi.prevAt, iso(T0));
  // no history (first run, lost cache), a history from another version, or one with no time: nothing
  for (const p of [null, undefined, { ...h1, v: 2 }, { ...h1, at: null }, 'junk']) assert.equal(prevBooks(p, [game()], { now: at(5) }).size, 0);
  // older than an hour, or not before this run: not the previous run
  assert.equal(PREV_BOOK_MAX_AGE_MS, 60 * MIN);
  assert.equal(prevBooks(h1, [game()], { now: at(60) }).size, 1);
  assert.equal(prevBooks(h1, [game()], { now: at(61) }).size, 0);
  assert.equal(prevBooks(h1, [game()], { now: at(0) }).size, 0);
  assert.equal(prevBooks(h1, [game()], { now: at(-5) }).size, 0);
  // a game the previous run did not record (new to the board, or its book is from an older run): nothing
  assert.equal(prevBooks(h1, [{ ...game(), id: 'nfl-other' }], { now: at(5) }).size, 0);
  const h2 = updateHistory(h1, historyInput([], []), { now: at(5) }).history;   // run 2 did not see the game
  assert.equal(h2.games[ID].bookAt, iso(T0));
  assert.equal(prevBooks(h2, [game()], { now: at(10) }).size, 0, 'the book is from two runs ago');
  // not pregame now: nothing
  assert.equal(prevBooks(h1, [game({ state: 'in' })], { now: at(5) }).size, 0);
  // malformed entries are skipped, never thrown
  const bad = structuredClone(h1); bad.games[ID].book = { 'ml:home': [0, 1.2], 'sp:home:3.5': 'x' };
  assert.equal(prevBooks(bad, [game()], { now: at(5) }).size, 0);
});

test('buildRun: no previous book on a first run; the next run carries the first run book on its pregame games', () => {
  const NOW = Date.parse(RESEARCH_NOW);
  const SEADEN = '26OCT15SEADEN';
  // run 1 without SEA@DEN's Kalshi markets (the game is new to the board on run 2)
  const in1 = researchInputs();
  for (const s of ['KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL']) in1.kalshi.markets[s] = in1.kalshi.markets[s].filter((m) => !m.event_ticker.includes(SEADEN));
  const r1 = buildRun(in1, { now: NOW });
  assert.equal(r1.snapshot.sources.moves.since, null);
  assert.ok(r1.snapshot.games.every((g) => g.kalshi.prevQuotes === undefined && g.kalshi.prevAt === undefined), 'no history: no previous book');
  assert.equal(r1.snapshot.sources.moves.prevBooks, 0);
  assert.deepEqual(validateSnapshot(r1.snapshot), []);
  // run 2, five minutes later
  const in2 = researchInputs();
  in2.history = r1.history;
  const t2 = NOW + 5 * MIN;
  const r2 = buildRun(in2, { now: t2 });
  assert.deepEqual(validateSnapshot(r2.snapshot), []);
  const pre1 = new Map(r1.snapshot.games.filter((g) => g.state === 'pre').map((g) => [g.id, foldKalshiBook(g)]));
  let n = 0;
  for (const g of r2.snapshot.games) {
    const before = pre1.get(g.id) || {};
    const keys = Object.keys(foldKalshiBook(g)).filter((k) => before[k]);
    if (g.state !== 'pre' || !keys.length) { assert.equal(g.kalshi.prevQuotes, undefined, g.id); continue; }
    n++;
    assert.equal(g.kalshi.prevAt, iso(NOW));
    assert.deepEqual(g.kalshi.prevQuotes, Object.fromEntries(keys.map((k) => [k, before[k]])), g.id);
  }
  assert.ok(n >= 50, `${n} games with a previous book`);
  assert.equal(r2.snapshot.sources.moves.prevBooks, n);
  const den = r2.snapshot.games.find((g) => g.kalshi.gameEvent === `KXNFLGAME-${SEADEN}`);
  assert.ok(den && Object.keys(foldKalshiBook(den)).length && den.kalshi.prevQuotes === undefined, 'new to the board: no previous book');
  // the same run with the history lost (cache miss), or with a history over an hour old: no previous book anywhere
  assert.ok(buildRun({ ...researchInputs(), history: null }, { now: t2 }).snapshot.games.every((g) => !g.kalshi.prevQuotes));
  const late = buildRun({ ...researchInputs(), history: r1.history }, { now: NOW + 61 * MIN }).snapshot;
  assert.ok(late.games.every((g) => !g.kalshi.prevQuotes && !g.kalshi.prevAt));
  assert.equal(late.sources.moves.prevBooks, 0);
  // deterministic
  assert.deepEqual(buildRun({ ...researchInputs(), history: r1.history }, { now: t2 }).snapshot, r2.snapshot);
});

test('schema: kalshi.prevQuotes and prevAt come together, keyed by contract, prices inside (0, 1)', () => {
  const s = buildRun(researchInputs(), { now: Date.parse(RESEARCH_NOW) }).snapshot;
  const g = s.games.find((x) => x.state === 'pre' && x.kalshi.markets.length);
  g.kalshi.prevQuotes = { 'ml:home': { bid: 0.4, ask: 0.42 } }; g.kalshi.prevAt = RESEARCH_NOW;
  assert.deepEqual(validateSnapshot(s), []);
  g.kalshi.prevQuotes = { 'ml:away': { bid: 0.4, ask: 0.42 }, 'tot:44.5': { bid: 0, ask: 0.5 } }; delete g.kalshi.prevAt;
  const p = validateSnapshot(s);
  const at = `games[${s.games.indexOf(g)}].kalshi`;
  for (const m of [`${at}.prevAt must be ISO UTC`, `${at}.prevQuotes.ml:away`, `${at}.prevQuotes.tot:44.5`]) assert.ok(p.includes(m), p.join(' | '));
});

// The engine folds Kalshi's book the same way (gridiron-picks consensus.js kalshiBook), so a previous book the
// collector stored compares like with like. Runs only where the gridiron-picks checkout sits next to this one.
const PICKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'gridiron-picks');
const ENGINE = join(PICKS, 'public', 'js', 'engine', 'consensus.js');
test('foldKalshiBook matches the engine (consensus.js kalshiBook) on the site fixtures', { skip: !existsSync(ENGINE) && 'gridiron-picks not checked out next to gridiron-data' }, async () => {
  const { kalshiBook } = await import(pathToFileURL(ENGINE).href);
  const load = (f) => (f.endsWith('.gz') ? JSON.parse(gunzipSync(readFileSync(f))) : JSON.parse(readFileSync(f, 'utf8')));
  let keys = 0;
  const files = ['test/fixtures/snapshot-live.json', 'test/fixtures/snapshot-live2.json', 'test/fixtures/snapshot-pinn.json', 'test/fixtures/snapshot-venues.json', 'test/engine/fixtures/snapshot-venues.json.gz'];
  for (const f of files.map((x) => join(PICKS, x)).filter(existsSync)) {
    for (const g of load(f).games) {
      const mine = foldKalshiBook(g);
      const eng = Object.fromEntries(Object.entries(kalshiBook(g)).filter(([, b]) => b.bid != null && b.ask != null).map(([k, b]) => [k, { bid: b.bid, ask: b.ask }]));
      assert.deepEqual(mine, eng, `${f} ${g.id}`);
      keys += Object.keys(mine).length;
    }
  }
  assert.ok(keys >= 1000, `${keys} keys compared`);
});
