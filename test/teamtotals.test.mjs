import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rd } from './helpers.mjs';
import {
  TEAM_TOTAL_SERIES, buildTeamTotals, fetchTeamTotalInputs, impliedTeamTotals, ladderMainLine, dkTeamTotalsFromItems,
} from '../lib/teamtotals.mjs';

const P = 'props';
const clone = (x) => JSON.parse(JSON.stringify(x));
const GAMES = rd(P, 'games.json').games;
const LIVE = rd(P, 'live-teamtotals-20261012.json'); // live run 2026-10-12 ~01:25Z, BUF@LAR pregame
const gameOf = (games, espnId) => games.find((g) => g.espnId === espnId);

// BUF@LAR with the DK game line seen on the live scoreboard (LAR -3.5, 54.5)
function liveGames() {
  const games = clone(GAMES);
  const g = gameOf(games, '401872994');
  g.odds.spread.home = LIVE.dkGameLine.spread;
  g.odds.total.line = LIVE.dkGameLine.overUnder;
  return games;
}

test('KXNFLTEAMTOTAL (live BUF@LAR): every market links to the game with team and strike resolved', () => {
  assert.equal(LIVE.kalshi.KXNFLTEAMTOTAL.length, 27);
  const r = buildTeamTotals({ kalshi: { KXNFLTEAMTOTAL: LIVE.kalshi.KXNFLTEAMTOTAL }, errors: [] }, { games: liveGames() });
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.linked, 27);
  const list = r.marketsByGame['nfl-401872994'];
  assert.equal(list.length, 27);
  for (const m of list) {
    assert.equal(m.type, 'teamTotal');
    assert.equal(m.series, 'KXNFLTEAMTOTAL');
    assert.ok(m.team === 'home' || m.team === 'away');
    assert.equal(Math.ceil(m.strike), Number(/(\d+)$/.exec(m.ticker)[1]));
    assert.ok(new RegExp(m.team === 'home' ? '^LA Rams' : '^BUF Bills').test(m.title), `${m.ticker} ${m.title}`);
    for (const k of ['yesAsk', 'yesBid', 'noAsk', 'noBid', 'yesAskSize', 'yesBidSize', 'volume']) assert.equal(typeof m[k], 'number', k);
  }
  const lar = list.find((m) => m.ticker === 'KXNFLTEAMTOTAL-26OCT12BUFLAR-LAR29');
  assert.deepEqual([lar.team, lar.strike], ['home', 28.5]);
  assert.deepEqual(list.map((m) => m.team), [...Array(list.filter((m) => m.team === 'away').length).fill('away'), ...Array(list.filter((m) => m.team === 'home').length).fill('home')], 'away first, then home, by strike');
});

test('DK team totals (live BUF@LAR, ESPN type 98 with team refs): ladder midpoint matches the game-line implied total', () => {
  const games = liveGames();
  const g = gameOf(games, '401872994');
  assert.deepEqual(impliedTeamTotals(g.odds), { home: 29, away: 25.5 });
  const r = buildTeamTotals({ kalshi: {} }, { games, espnProps: { 401872994: LIVE.espnTeamTotalItems } });
  assert.deepEqual(r.dkTeamTotals, { 'nfl-401872994': { home: { line: 29.5, open: 28.5 }, away: { line: 25.5, open: 24.5 } } });
  assert.deepEqual(r.errors, []);
});

test('DK team totals (research BAL@ATL 23:59Z): ATL 23.5 (open 21.5), BAL 20.5 (open 24.5)', () => {
  const items = rd(P, 'espn-propbets-401872993.json').items;
  const g = gameOf(GAMES, '401872993');
  assert.deepEqual(impliedTeamTotals(g.odds), { home: 23.25, away: 20.25 });
  const r = buildTeamTotals({ kalshi: {} }, { games: GAMES, espnProps: { 401872993: items } });
  assert.deepEqual(r.dkTeamTotals['nfl-401872993'], { home: { line: 23.5, open: 21.5 }, away: { line: 20.5, open: 24.5 } });
  // without a DK game line the odd-count ladder midpoint is still used
  const noOdds = clone(g); noOdds.odds = null;
  assert.deepEqual(dkTeamTotalsFromItems(items, noOdds), { home: { line: 23.5, open: 21.5 }, away: { line: 20.5, open: 24.5 } });
});

test('ladderMainLine: rejects thin, ambiguous or implausible ladders instead of guessing', () => {
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i + 0.5);
  assert.deepEqual(ladderMainLine(range(13, 33), 23.25), { line: 23.5, why: null });
  assert.equal(ladderMainLine(range(13, 32), null).line, null, 'even count, no game line');
  assert.equal(ladderMainLine(range(13, 32), 23.1).line, 23.5);
  assert.equal(ladderMainLine(range(13, 32), 22.9).line, 22.5);
  const far = ladderMainLine(range(13, 33), 27);
  assert.equal(far.line, null);
  assert.match(far.why, /from game-line implied 27/);
  assert.equal(ladderMainLine([20.5, 21.5, 22.5], 21).line, null);
  const errors = [];
  const g = { id: 'nfl-x', home: { espnId: '1' }, away: { espnId: '33' }, odds: { total: { line: 43.5 }, spread: { home: -12 } } };
  const items = range(13, 33).map((v) => ({ team: { $ref: 'teams/1' }, type: { id: '98', name: 'Team Total Points' }, current: { target: { value: v } }, open: { target: { value: 21.5 } } }));
  assert.deepEqual(dkTeamTotalsFromItems(items, g, errors), { home: { line: null, open: 21.5 }, away: null });
  assert.equal(errors.length, 1);
});

test('KXNCAAFTEAMTOTAL (live sample NEB@ORE): joins a matched CFB game by teams part within one day', () => {
  const cfb = LIVE.kalshi.KXNCAAFTEAMTOTAL;
  assert.equal(cfb.length, 25);
  const game = { id: 'cfb-401999001', league: 'cfb', espnId: '401999001', kickoff: '2026-10-17T23:30:00Z', state: 'pre',
    home: { abbr: 'ORE', espnId: '2483', kalshiCode: 'ORE' }, away: { abbr: 'NEB', espnId: '158', kalshiCode: 'NEB' },
    kalshi: { gameEvent: 'KXNCAAFGAME-26OCT18NEBORE' } }; // GAME event dated one day later than the team-total event
  const r = buildTeamTotals({ kalshi: { KXNCAAFTEAMTOTAL: cfb } }, { games: [game] });
  assert.equal(r.marketsByGame['cfb-401999001'].length, 25);
  assert.ok(r.marketsByGame['cfb-401999001'].some((m) => m.team === 'home' && /^Oregon/.test(m.title)));
  assert.ok(r.marketsByGame['cfb-401999001'].some((m) => m.team === 'away'));
  // an unmatched CFB game (no Kalshi GAME event) gets nothing: CFB codes are only known from the matcher
  const r2 = buildTeamTotals({ kalshi: { KXNCAAFTEAMTOTAL: cfb } }, { games: [{ ...game, kalshi: { gameEvent: null } }] });
  assert.deepEqual(r2.marketsByGame, {});
  assert.deepEqual(r2.stats.orphanEvents, ['KXNCAAFTEAMTOTAL-26OCT17NEBORE']);
  assert.deepEqual(r2.dkTeamTotals, {}, 'no DK team totals for CFB');
});

test('team totals: bad suffix dropped with an error, strike mismatch kept with a warning, paused markets dropped', () => {
  const base = rd(P, 'kalshi-teamtotal-buflar-sample.json').markets;
  const ms = clone(base);
  ms.push({ ...clone(base[0]), ticker: 'KXNFLTEAMTOTAL-26OCT12BUFLAR-NYJ20', yes_sub_title: 'NY Jets over 19.5 points' });
  ms.push({ ...clone(base[0]), ticker: 'KXNFLTEAMTOTAL-26OCT12BUFLAR-BUF21', floor_strike: 22.5, yes_sub_title: 'Buffalo over 22.5 points' });
  ms.push({ ...clone(base[0]), ticker: 'KXNFLTEAMTOTAL-26OCT12BUFLAR-BUF24', floor_strike: 23.5, status: 'paused' });
  const r = buildTeamTotals({ kalshi: { KXNFLTEAMTOTAL: ms } }, { games: GAMES });
  assert.equal(r.stats.linked, 13);
  assert.equal(r.stats.badSuffix, 1);
  assert.equal(r.stats.notActive, 1);
  assert.ok(r.errors.some((e) => /NYJ20: suffix does not name BUF or LAR/.test(e)));
  assert.ok(r.errors.some((e) => /BUF21: floor_strike 22.5 does not match suffix 21/.test(e)));
  const buf = r.marketsByGame['nfl-401872994'].find((m) => m.ticker.endsWith('BUF21'));
  assert.deepEqual([buf.team, buf.strike], ['away', 22.5]);
  assert.equal(r.ok, true);
  assert.equal(buildTeamTotals(null, { games: GAMES }).ok, false);
});

test('buildTeamTotals is deterministic and order independent', () => {
  const raw = { kalshi: { KXNFLTEAMTOTAL: LIVE.kalshi.KXNFLTEAMTOTAL } };
  const a = buildTeamTotals(raw, { games: liveGames(), espnProps: { 401872994: LIVE.espnTeamTotalItems } });
  const rev = { kalshi: { KXNFLTEAMTOTAL: clone(LIVE.kalshi.KXNFLTEAMTOTAL).reverse() } };
  const b = buildTeamTotals(rev, { games: liveGames().reverse(), espnProps: { 401872994: clone(LIVE.espnTeamTotalItems).reverse() } });
  assert.deepEqual(b.marketsByGame, a.marketsByGame);
  assert.deepEqual(b.dkTeamTotals, a.dkTeamTotals);
});

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

test('fetchTeamTotalInputs: both series paginated; a league without games is skipped; errors recorded', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.search);
    const s = u.searchParams.get('series_ticker');
    if (s === 'KXNCAAFTEAMTOTAL' && !u.searchParams.get('cursor')) return json({ cursor: 'p2', markets: [{ ticker: 'A' }] });
    return json({ cursor: '', markets: [{ ticker: `${s}-1` }] });
  };
  const r = await fetchTeamTotalInputs({ fetchImpl, now: Date.parse('2026-10-12T01:00:00Z'), pauseMs: 0 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.requests, 3);
  assert.equal(r.kalshi.KXNCAAFTEAMTOTAL.length, 2);
  assert.equal(r.kalshi.KXNFLTEAMTOTAL.length, 1);
  assert.ok(calls.every((c) => c.includes('status=open') && c.includes('max_close_ts=')));
  const nflOnly = await fetchTeamTotalInputs({ games: GAMES, fetchImpl, now: Date.now(), pauseMs: 0 });
  assert.deepEqual(Object.keys(nflOnly.kalshi), [TEAM_TOTAL_SERIES.nfl]);
  const down = await fetchTeamTotalInputs({ fetchImpl: async () => new Response('x', { status: 503 }), pauseMs: 0 });
  assert.equal(down.errors.length, 2);
  assert.deepEqual(down.kalshi, {});
});
