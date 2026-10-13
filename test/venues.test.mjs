// Exchange reference venues (lib/venues): parsing, orientation, matching, the refs.venues block, the 15 minute pull
// cadence, and failing open. Offline: research round 4 captures of 2026-10-12 (Polymarket US 23:36Z, SX Bet 23:33Z,
// Kalshi + ESPN 23:34Z) and a Gemini pull of 2026-10-13 00:30Z (scripts/make-venue-fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIX, RESEARCH_NOW, researchInputs } from './helpers.mjs';
import { parsePolyUS, fetchPolyUSInputs, POLYUS_BASE } from '../lib/venues/polyus.mjs';
import { parseGemini, fetchGeminiInputs, strikeOf, GEMINI_QUERY } from '../lib/venues/gemini.mjs';
import { parseSx, sxBook, fetchSxInputs } from '../lib/venues/sxbet.mjs';
import { buildVenue, kalshiKeys, VENUE_KEYS } from '../lib/venues/index.mjs';
import { Q, flipQ, foldPair, reorient, sortQuotes, keyOrder, VENUE_HEADERS } from '../lib/venues/common.mjs';
import { teamScore } from '../lib/match.mjs';
import { buildSnapshot, buildRun, summarize } from '../lib/build.mjs';
import { trimPinnacle } from '../lib/pinnacle.mjs';
import { validateSnapshot } from '../lib/schema.mjs';

const gz = (...p) => JSON.parse(gunzipSync(readFileSync(join(FIX, ...p))).toString('utf8'));
const PU = gz('venues', 'polyus-20261012.json.gz');
const GM = gz('venues', 'gemini-20261013.json.gz');
const SX = gz('venues', 'sx-20261012.json.gz');
const BOARDS = gz('venues', 'espn-boards-20261012.json.gz');
const KAL = gz('venues', 'kalshi-books-20261012.json.gz');
const NOW = BOARDS.now; // 2026-10-12T23:34:15Z
const clone = (x) => JSON.parse(JSON.stringify(x));
const KEY_RE = /^(ml:home|sp:(home|away):\d+\.5|tot:\d+\.5)$/;

const venueInputs = (fetchedAt = null) => ({
  polyus: { attemptAt: fetchedAt ?? PU.fetchedAt, fetchedAt: fetchedAt ?? PU.fetchedAt, cached: false, requests: 4, errors: [], leagues: { nfl: parsePolyUS(PU.nfl), cfb: parsePolyUS(PU.cfb) } },
  gemini: { attemptAt: fetchedAt ?? GM.fetchedAt, fetchedAt: fetchedAt ?? GM.fetchedAt, cached: false, requests: 1, errors: [], leagues: parseGemini(GM.data) },
  sx: { attemptAt: fetchedAt ?? SX.fetchedAt, fetchedAt: fetchedAt ?? SX.fetchedAt, cached: false, requests: 16, errors: [], leagues: parseSx(SX.markets.data.markets, SX.books) },
});
const boardsSnapshot = () => buildSnapshot({ espn: { fetchedAt: NOW, errors: [], scoreboards: clone(BOARDS.scoreboards) } }, { now: NOW });
const eventsByLeague = () => Object.fromEntries(Object.entries(BOARDS.scoreboards).map(([l, bs]) => [l, bs.flatMap((b) => b.events || [])]));

// Kalshi books of the same capture in canonical keys (the two winner markets folded), for orientation checks.
function kalshiQuotes(markets) {
  const out = {};
  for (const m of markets) {
    if (m.status && m.status !== 'active') continue;
    let k = null, q = Q(m.yesBid, m.yesAsk);
    if (!q) continue;
    if (m.type === 'game') { k = 'ml:home'; if (m.team === 'away') q = flipQ(q); }
    else if (m.type === 'spread' && Math.abs(m.strike % 1) === 0.5) k = `sp:${m.team}:${m.strike}`;
    else if (m.type === 'total' && Math.abs(m.strike % 1) === 0.5) k = `tot:${m.strike}`;
    if (k && (!out[k] || q.ask - q.bid < out[k].ask - out[k].bid)) out[k] = q;
  }
  return out;
}

// ---------------------------------------------------------------- quote helpers and the matcher's alternate names

test('Q, flipQ, foldPair, reorient, key order: two sided only, sizes follow the side, ESPN orientation swaps', () => {
  assert.equal(Q(0.5, 0.49), null, 'crossed');
  assert.equal(Q(null, 0.5), null, 'one sided');
  assert.equal(Q(0, 0.5), null);
  assert.equal(Q(0.5, 1), null);
  assert.deepEqual(Q('0.4', { value: '0.41' }), { bid: 0.4, ask: 0.41, bidSize: null, askSize: null, sizeUnit: null });
  assert.deepEqual(Q(0.4, 0.41, { bidSize: 10.4, askSize: null }), { bid: 0.4, ask: 0.41, bidSize: 10, askSize: null, sizeUnit: 'contracts' });
  assert.deepEqual(flipQ(Q(0.4, 0.41, { bidSize: 5, askSize: 7 })), { bid: 0.59, ask: 0.6, bidSize: 7, askSize: 5, sizeUnit: 'contracts' });
  // one-sided contracts still fold: home has only a bid, away only a bid -> home 0.56 / (1 - 0.40)
  assert.deepEqual(foldPair({ bid: '0.56' }, { bid: '0.40' }), Q(0.56, 0.6));
  assert.deepEqual(foldPair({ bid: 0.55, ask: 0.58 }, { bid: 0.43, ask: 0.44 }), Q(0.56, 0.57), 'best of each side');
  assert.equal(foldPair({ bid: 0.56 }, { ask: 0.45 }), null, 'no ask anywhere');
  const q = { 'tot:44.5': Q(0.5, 0.52), 'sp:home:3.5': Q(0.4, 0.42), 'ml:home': Q(0.6, 0.61), 'sp:away:1.5': Q(0.3, 0.31) };
  assert.deepEqual(reorient(q), { 'tot:44.5': q['tot:44.5'], 'sp:away:3.5': q['sp:home:3.5'], 'ml:home': flipQ(q['ml:home']), 'sp:home:1.5': q['sp:away:1.5'] });
  assert.deepEqual(Object.keys(sortQuotes({ ...q, 'sp:away:10.5': Q(0.1, 0.11), 'tot:9.5': Q(0.9, 0.91), 'sp:home:3': Q(0.5, 0.51) })),
    ['ml:home', 'sp:away:1.5', 'sp:away:10.5', 'sp:home:3.5', 'tot:9.5', 'tot:44.5'], 'canonical order, whole lines dropped');
  assert.ok(keyOrder('sp:away:2.5', 'sp:away:10.5') < 0);
  assert.deepEqual(Object.keys(sortQuotes(q, new Set(['tot:44.5']))), ['ml:home', 'tot:44.5'], 'trim keeps ml:home');
});

test('teamScore: a side with alternate names scores its best name; sides without alt score exactly as before', () => {
  const t = { location: 'Middle Tennessee', displayName: 'Middle Tennessee Blue Raiders', shortDisplayName: 'Middle Tennessee', abbreviation: 'MTSU', name: 'Blue Raiders' };
  assert.ok(teamScore({ code: '', name: 'Middle Tennessee State Blue Raiders' }, t, 'cfb') < 0.9);
  assert.equal(teamScore({ code: '', name: 'Middle Tennessee State Blue Raiders', alt: ['Middle Tennessee'] }, t, 'cfb'), 1);
  assert.equal(teamScore({ code: 'MTU', name: 'x' }, t, 'cfb'), 0.97, 'Kalshi code alias unchanged');
  assert.equal(teamScore({ code: 'MTU', name: 'x', alt: ['y'] }, t, 'cfb'), 0.97, 'the code still counts with alt names');
});

// ---------------------------------------------------------------- Polymarket US

test('parsePolyUS: raw BUF @ LAR event, away team long, only the 71 full game markets read', () => {
  const [g] = parsePolyUS([PU.rawBufLar.event]);
  assert.deepEqual([g.away.name, g.home.name, g.kickoff, g.dateKey], ['Buffalo Bills', 'Los Angeles Rams', '2026-10-13T00:15:00Z', '2026-10-12']);
  // winner: long = Bills 0.385 / 0.3875, so P(Rams win) = 0.6125 / 0.615
  assert.deepEqual(g.quotes['ml:home'], Q(0.6125, 0.615));
  // pos rung: Bills +33.5 at 0.99 / 0.995 -> P(Rams win by more than 33.5) = 0.005 / 0.01 (the title names the short side)
  assert.deepEqual(g.quotes['sp:home:33.5'], Q(0.005, 0.01));
  assert.deepEqual(g.quotes['tot:26.5'], Q(0.98, 0.99), 'long = Over');
  assert.equal(Object.keys(g.quotes).length, 71, '1 winner + every full game spread and total rung; halves, quarters and team totals ignored');
  assert.ok(Object.keys(g.quotes).every((k) => KEY_RE.test(k)));
});

test('parsePolyUS: rebuilt 23:36Z capture, negative and positive rungs on CAR @ PHI', () => {
  const nfl = parsePolyUS(PU.nfl), cfb = parsePolyUS(PU.cfb);
  assert.equal(nfl.length, 29);
  assert.equal(cfb.length, 218);
  const g = nfl.find((x) => x.id === 'nfl-car-phi-2026-10-18');
  assert.deepEqual([g.away.name, g.home.name], ['Carolina Panthers', 'Philadelphia Eagles']);
  assert.deepEqual(g.quotes['ml:home'], Q(0.515, 0.5175), 'Panthers long 0.4825 / 0.485');
  assert.deepEqual(g.quotes['sp:away:3.5'], Q(0.355, 0.36), 'Panthers -3.5 (neg rung) is YES of the long side');
  assert.deepEqual(g.quotes['sp:home:3.5'], Q(0.375, 0.385), 'Panthers +3.5 at 0.615 / 0.625 is NO of Eagles by more than 3.5');
  assert.deepEqual(g.quotes['tot:41.5'], Q(0.52, 0.525));
});

test('parsePolyUS: home team long, closed and crossed markets, whole lines, Under long, games without a winner', () => {
  const side = (long, name, ordering, description) => ({ long, description, team: { name, ordering } });
  const m = (type, bid, ask, extra = {}) => ({ slug: `${type}-${extra.line ?? ''}-${bid}`, sportsMarketType: type, status: 'MARKET_STATUS_OPEN', bestBidQuote: { value: String(bid) }, bestAskQuote: { value: String(ask) }, ...extra });
  const ev = {
    slug: 'nfl-a-b', startTime: '2026-10-18T17:00:00Z',
    markets: [
      m('football_team_full_game_winner', 0.6, 0.61, { marketSides: [side(true, 'Home Team', 'home'), side(false, 'Away Team', 'away')] }),
      m('football_team_full_game_spread', 0.4, 0.41, { line: -3.5, marketSides: [side(true, 'Home Team'), side(false, 'Away Team')] }),
      m('football_team_full_game_spread', 0.7, 0.71, { line: 2.5, marketSides: [side(true, 'Home Team'), side(false, 'Away Team')] }),
      m('football_team_full_game_spread', 0.5, 0.51, { line: 3, marketSides: [side(true, 'Home Team'), side(false, 'Away Team')] }),
      m('football_team_full_game_spread', 0.5, 0.49, { line: 6.5, marketSides: [side(true, 'Home Team'), side(false, 'Away Team')] }),
      m('football_team_full_game_spread', 0.2, 0.21, { line: -7.5, status: 'MARKET_STATUS_CLOSED', marketSides: [side(true, 'Home Team'), side(false, 'Away Team')] }),
      m('football_team_full_game_total', 0.45, 0.46, { line: 44.5, marketSides: [{ long: true, description: 'Under' }, { long: false, description: 'Over' }] }),
    ],
  };
  const [g] = parsePolyUS([ev, { ...ev, slug: 'closed', closed: true }, { slug: 'no-winner', startTime: ev.startTime, markets: ev.markets.slice(1) }]);
  assert.deepEqual([g.away.name, g.home.name], ['Away Team', 'Home Team']);
  assert.deepEqual(g.quotes, {
    'ml:home': Q(0.6, 0.61),                // long is home: YES of the long side as is
    'sp:away:2.5': Q(0.29, 0.3),            // Home +2.5 covers = Away does not win by more than 2.5
    'sp:home:3.5': Q(0.4, 0.41),            // Home -3.5
    'tot:44.5': Q(0.54, 0.55),              // long = Under
  });
});

test('fetchPolyUSInputs: one page at a time, 4 GETs for both leagues, plain headers; a blocked league fails open', async () => {
  const calls = [];
  const fake = (status = {}) => async (url, init = {}) => {
    calls.push({ url, headers: init.headers });
    const u = new URL(url);
    const lg = /\/v2\/leagues\/(nfl|cfb)\/events$/.exec(u.pathname)?.[1];
    if (status[lg]) return new Response('{"error":"x"}', { status: status[lg] });
    const off = Number(u.searchParams.get('offset'));
    return new Response(JSON.stringify({ events: PU[lg].slice(off, off + 100) }), { status: 200 });
  };
  const r = await fetchPolyUSInputs({ fetchImpl: fake(), now: Date.parse(NOW), retryDelayMs: 0 });
  assert.equal(r.requests, 4);
  assert.deepEqual(calls.map((c) => c.url), [
    `${POLYUS_BASE}/v2/leagues/nfl/events?limit=100&offset=0`,
    `${POLYUS_BASE}/v2/leagues/cfb/events?limit=100&offset=0`,
    `${POLYUS_BASE}/v2/leagues/cfb/events?limit=100&offset=100`,
    `${POLYUS_BASE}/v2/leagues/cfb/events?limit=100&offset=200`,
  ]);
  assert.deepEqual(calls[0].headers, { ...VENUE_HEADERS });
  assert.deepEqual([r.leagues.nfl.length, r.leagues.cfb.length], [29, 218]);
  assert.deepEqual([r.fetchedAt, r.cached, r.errors], ['2026-10-12T23:34:15Z', false, []]);
  calls.length = 0;
  const b = await fetchPolyUSInputs({ fetchImpl: fake({ cfb: 403 }), now: Date.parse(NOW), retryDelayMs: 0 });
  assert.equal(b.leagues.cfb, null);
  assert.equal(b.leagues.nfl.length, 29);
  assert.deepEqual(b.errors, ['cfb: gateway.polymarket.us/v2/leagues/cfb/events: HTTP 403']);
  assert.equal(b.requests, 2, 'a 403 is not retried');
  calls.length = 0;
  const c = await fetchPolyUSInputs({ fetchImpl: fake({ nfl: 503, cfb: 503 }), now: Date.parse(NOW), retryDelayMs: 0 });
  assert.equal(c.requests, 4, 'a 5xx is retried once per league');
  assert.deepEqual(c.leagues, { nfl: null, cfb: null });
});

// ---------------------------------------------------------------- Gemini

test('parseGemini: moneyline events with nested spread and total ladders, sides from contract tickers', () => {
  const p = parseGemini(GM.data);
  assert.deepEqual([p.nfl.length, p.cfb.length], [15, 61]);
  const g = p.nfl.find((x) => x.id === 'NFL-2610160015-SEA-DEN');
  assert.deepEqual(g.away, { name: 'Seattle Seahawks', alt: ['Seattle'] });
  assert.deepEqual(g.home, { name: 'Denver Broncos', alt: ['Denver'] });
  // winner: Denver 0.40 / 0.41, Seattle 0.59 / 0.60, folded: home YES bid max(0.40, 1 - 0.60), ask min(0.41, 1 - 0.59)
  assert.deepEqual(g.quotes['ml:home'], Q(0.4, 0.41));
  assert.deepEqual(g.quotes['sp:home:3.5'], Q(0.29, 0.3), 'DEN3: Denver wins by more than 3.5');
  assert.deepEqual(g.quotes['sp:away:3.5'], Q(0.43, 0.44), 'SEA3');
  // every key maps back to the contract it came from
  const ev = GM.data.find((e) => e.ticker === 'NFL-2610160015-SEA-DEN-M');
  const T = ev.events.find((e) => e.ticker.endsWith('-T'));
  assert.ok(T.contracts.length >= 10 && T.contracts.every((c) => c.strike === undefined), 'production shape: no strike on nested ladders');
  for (const c of T.contracts) {
    const q = Q(c.prices.bestBid, c.prices.bestAsk);
    const line = /^More than (\d+\.5) points scored$/.exec(c.label)[1];
    if (q) assert.deepEqual(g.quotes[`tot:${line}`], q, c.label);
  }
  assert.ok(Object.keys(g.quotes).every((k) => KEY_RE.test(k)), 'first half and team total events ignored');
  // a game whose two winner contracts are each one sided still has no two sided book (FAU @ Army): no quote
  assert.equal(p.cfb.find((x) => x.id === 'NCAAF-2610171600-FAU-ARM').quotes['ml:home'], undefined);
});

test('parseGemini: the moneyline-only list sends nested ladders without a strike; the line is read from the label', () => {
  // The collector's own request, untouched (3 events, 2026-10-13 00:54Z): no nested spread or total contract has a strike.
  const S = GM.mlOnlySample.data;
  const ladders = S.flatMap((e) => e.events.filter((n) => /-(S|T)$/.test(n.ticker))).flatMap((n) => n.contracts);
  assert.ok(ladders.length > 100 && ladders.every((c) => c.strike === undefined), 'no strike on the nested ladders');
  const p = parseGemini(S);
  const n = Object.fromEntries([...p.nfl, ...p.cfb].map((g) => [g.id, Object.keys(g.quotes).length]));
  assert.deepEqual(n, { 'NFL-2610130015-BUF-LAR': 43, 'NCAAF-2610132300-DEL-MTN': 34, 'NCAAF-2610140000-FIU-JAX': 29 });
  const del = p.cfb.find((g) => g.id === 'NCAAF-2610132300-DEL-MTN');
  const c = S[1].events.find((e) => e.ticker.endsWith('-S')).contracts.find((x) => x.ticker === 'DEL1');
  assert.equal(c.label, 'Delaware wins by more than 1.5 points');
  assert.deepEqual(del.quotes['sp:away:1.5'], Q(c.prices.bestBid, c.prices.bestAsk));
  // strikeOf: the structured strike when sent, else the label; nothing for other wording
  assert.deepEqual(strikeOf({ strike: { type: 'spread', value: '2.5' }, label: 'X wins by more than 9.5 points' }, 'S'), { type: 'spread', value: 2.5 });
  assert.deepEqual(strikeOf({ label: 'Los Angeles R wins by more than 13.5 points' }, 'S'), { type: 'spread', value: 13.5 });
  assert.deepEqual(strikeOf({ label: 'More than 47.5 points scored' }, 'T'), { type: 'over', value: 47.5 });
  assert.deepEqual(strikeOf({ label: 'Fewer than 47.5 points scored' }, 'T'), { type: 'under', value: 47.5 });
  assert.equal(strikeOf({ label: 'Over 47.5' }, 'T'), null);
  assert.equal(strikeOf({ label: 'More than 47.5 points scored' }, 'S'), null, 'a total label is not a spread');
});

test('parseGemini: label fallback, under strikes, closed contracts, top-level and nested copies of an event', () => {
  const c = (ticker, label, bid, ask, extra = {}) => ({ ticker, label, prices: { bestBid: bid, bestAsk: ask }, status: 'active', marketState: 'open', ...extra });
  const M = {
    ticker: 'NCAAF-2610171600-AAA-BBB-M', status: 'active', startTime: '2026-10-17T16:00:00.000Z',
    participants: [{ name: 'Bravo Bees', abbreviation: 'BBB', side: 'home' }, { name: 'Alpha Ants', abbreviation: 'AAA', side: 'away' }],
    contracts: [c('BBB', 'Bravo', '0.55', '0.57', { sportsSide: 'home' }), c('AAA', 'Alpha', '0.44', '0.46', { sportsSide: 'away' })],
    events: [{
      ticker: 'NCAAF-2610171600-AAA-BBB-S', status: 'active',
      contracts: [
        c('X3', 'Bravo wins by more than 3.5 points', '0.4', '0.42', { strike: { type: 'spread', value: '3.5' } }),
        c('AAA6', 'Alpha wins by more than 6.5 points', '0.1', '0.12', { strike: { type: 'spread', value: '6.5' } }),
        c('AAA7', 'Alpha wins by more than 7.5 points', '0.08', '0.09', { strike: { type: 'spread', value: '7.5' }, marketState: 'closed' }),
      ],
    }],
  };
  const T = { ticker: 'NCAAF-2610171600-AAA-BBB-T', status: 'active', contracts: [c('U50', 'Fewer than 50.5', '0.6', '0.62', { strike: { type: 'under', value: '50.5' } })] };
  const p = parseGemini([M, T, { ...T }]);
  assert.equal(p.cfb.length, 1);
  assert.deepEqual(p.cfb[0].quotes, {
    'ml:home': Q(0.55, 0.56),
    'sp:away:6.5': Q(0.1, 0.12),
    'sp:home:3.5': Q(0.4, 0.42),   // ticker prefix unknown: the label names Bravo
    'tot:50.5': Q(0.38, 0.4),      // under strike flipped to YES of over
  });
});

test('fetchGeminiInputs: one filtered GET, reused for 15 minutes from the state dir, a failed pull is reused too', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-gem-'));
  try {
    const calls = [];
    let status = 200;
    const fake = async (url, init = {}) => {
      calls.push({ url, headers: init.headers });
      if (status !== 200) return new Response('{"error":"x"}', { status });
      const u = new URL(url), off = Number(u.searchParams.get('offset')), lim = Number(u.searchParams.get('limit'));
      return new Response(JSON.stringify({ data: GM.data.slice(off, off + lim), pagination: { limit: lim, offset: off, total: GM.data.length } }), { status: 200 });
    };
    const t0 = Date.parse(NOW);
    const a = await fetchGeminiInputs({ fetchImpl: fake, now: t0, stateDir: tmp, retryDelayMs: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.gemini.com/v1/prediction-markets/events?${GEMINI_QUERY}&limit=100&offset=0`);
    assert.match(calls[0].url, /sport=american_football&sports_market_type=moneyline&sports_market_scope=full_contest/);
    assert.deepEqual([a.cached, a.requests, a.fetchedAt, a.leagues.nfl.length, a.leagues.cfb.length], [false, 1, '2026-10-12T23:34:15Z', 15, 61]);
    assert.ok(existsSync(join(tmp, 'gemini.json')));
    const b = await fetchGeminiInputs({ fetchImpl: fake, now: t0 + 5 * 60e3, stateDir: tmp });
    assert.equal(calls.length, 1, 'no request inside 15 minutes');
    assert.deepEqual([b.cached, b.requests, b.fetchedAt], [true, 0, a.fetchedAt]);
    assert.deepEqual(b.leagues, a.leagues);
    status = 403;
    const c = await fetchGeminiInputs({ fetchImpl: fake, now: t0 + 15 * 60e3, stateDir: tmp, retryDelayMs: 0 });
    assert.equal(calls.length, 2, 'pulled again after 15 minutes; a 403 is not retried');
    assert.deepEqual(c.leagues, { nfl: null, cfb: null });
    assert.match(c.errors[0], /HTTP 403/);
    const d = await fetchGeminiInputs({ fetchImpl: fake, now: t0 + 20 * 60e3, stateDir: tmp });
    assert.equal(calls.length, 2, 'the failed pull is reused too');
    assert.deepEqual([d.cached, d.leagues.nfl], [true, null]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- SX Bet

test('sxBook: taker perspective book -> YES of team one with sizes in contracts', () => {
  const hj = SX.books['0xa067dbe958d8601ad686350aebc502a9043c416f6e6df8f1ce92fb1c45fd20e7']; // HOU @ JAX
  // Jaguars cost 0.58625 (stake $33.48 -> 57 contracts); Texans cost 0.4275 (stake $14.20 -> 33 contracts) -> Jaguars bid 0.5725
  assert.deepEqual(sxBook(hj), { bid: 0.5725, ask: 0.5863, bidSize: 33, askSize: 57, sizeUnit: 'contracts' });
  const lv = (p, usd) => ({ percentageOdds: `${BigInt(Math.round(p * 1e6)) * 10n ** 14n}`, size: String(usd * 1e6) });
  assert.deepEqual(sxBook({ outcomeOne: [lv(0.6, 30), lv(0.6, 30), lv(0.62, 100)], outcomeTwo: [lv(0.45, 9)] }), Q(0.55, 0.6, { askSize: 100, bidSize: 20 }), 'stakes at the best price summed');
  assert.equal(sxBook({ outcomeOne: [lv(0.6, 30)], outcomeTwo: [] }), null, 'one sided');
  assert.equal(sxBook({ outcomeOne: [lv(0.6, 30)], outcomeTwo: [lv(0.995, 5)] }), null, 'a 99.5c level is not a price');
});

test('parseSx and fetchSxInputs: NFL moneylines in the window only, books 2 at a time, reused for 15 minutes', async () => {
  const p = parseSx(SX.markets.data.markets, SX.books);
  assert.equal(p.nfl.length, 15, 'the 15 moneylines with a book; spread and total markets ignored');
  assert.deepEqual([p.nfl[0].away.name, p.nfl[0].home.name], ['Buffalo Bills', 'Los Angeles Rams']);
  const tmp = mkdtempSync(join(tmpdir(), 'gd-sx-'));
  try {
    const calls = [];
    let inFlight = 0, maxInFlight = 0;
    const fake = async (url) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname === '/markets/active') return new Response(JSON.stringify(SX.markets), { status: 200 });
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      const h = u.searchParams.get('marketHash');
      if (h.startsWith('0x92')) return new Response('{}', { status: 404 }); // one book down: only that game is lost
      assert.equal(u.searchParams.get('showTakerPerspective'), 'true');
      return new Response(JSON.stringify({ status: 'success', data: SX.books[h] }), { status: 200 });
    };
    const t0 = Date.parse('2026-10-12T23:33:00Z');
    const r = await fetchSxInputs({ fetchImpl: fake, now: t0, stateDir: tmp, retryDelayMs: 0 });
    assert.equal(calls.length, 16, '1 list + 15 books (the other 6 moneylines kick off more than 9 days out)');
    assert.match(calls[0], /\/markets\/active\?leagueId=243&onlyMainLine=true&betGroup=game-lines&pageSize=100$/);
    assert.ok(maxInFlight <= 2, `at most 2 books at a time (saw ${maxInFlight})`);
    assert.equal(r.leagues.nfl.length, 14);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^nfl book 0x92288450: api\.sx\.bet\/orderbook-v3\/snapshot: HTTP 404$/);
    assert.deepEqual(Object.keys(r.leagues), ['nfl'], 'college is off');
    const again = await fetchSxInputs({ fetchImpl: fake, now: t0 + 10 * 60e3, stateDir: tmp });
    assert.deepEqual([again.cached, again.requests, calls.length], [true, 0, 16]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- matching and orientation against the same capture

test('buildVenue: match counts per venue and league against the 23:34Z ESPN boards; unmatched are FCS or later weeks', () => {
  const snap = boardsSnapshot();
  const pre = snap.games.filter((g) => g.state === 'pre');
  assert.deepEqual([pre.filter((g) => g.league === 'nfl').length, pre.filter((g) => g.league === 'cfb').length], [15, 65]);
  const V = venueInputs();
  const r = Object.fromEntries(VENUE_KEYS.map((v) => [v, buildVenue(v, V[v], { games: snap.games, eventsByLeague: eventsByLeague(), now: NOW, trim: false })]));
  assert.deepEqual(r.polyus.matched, { cfb: 64, nfl: 15 }, 'The Citadel @ Texas A&M has no two sided quote');
  assert.deepEqual(r.gemini.matched, { cfb: 38, nfl: 15 }, 'Gemini lists 61 college games; 23 have no two sided book');
  assert.deepEqual(r.sx.matched, { nfl: 15 });
  for (const v of VENUE_KEYS) assert.deepEqual(r[v].errors, [], v);
  assert.deepEqual(r.gemini.unmatched, [], 'Hawaii (ESPN: Hawai\'i) paired through the shared name table');
  assert.deepEqual(r.sx.unmatched, []);
  assert.equal(r.polyus.unmatched.length, 57);
  assert.ok(r.polyus.unmatched.includes('nfl: New England Patriots @ Chicago Bears 2026-10-22'), 'next week: not on these boards');
  assert.ok(r.polyus.unmatched.includes('cfb: Brown @ Princeton 2026-10-17'), 'FCS');
  assert.ok(!r.polyus.unmatched.some((u) => /NM State/.test(u)), 'NM State paired through the shared name table');
});

test('orientation regression: every tight venue/Kalshi pair on the same key is within 5 cents (no flipped sides)', () => {
  const snap = boardsSnapshot();
  const V = venueInputs();
  const need = { polyus: 900, gemini: 250, sx: 10 };
  for (const v of VENUE_KEYS) {
    const r = buildVenue(v, V[v], { games: snap.games, eventsByLeague: eventsByLeague(), now: NOW, trim: false });
    const gaps = [], big = [];
    for (const g of snap.games) {
      const ref = r.refs.get(g.id), k = KAL.games[g.espnId];
      if (!ref || !k || Date.parse(g.kickoff) < Date.parse(V[v].fetchedAt)) continue; // live by the venue's pull
      const kq = kalshiQuotes(k.markets);
      for (const [key, q] of Object.entries(ref.quotes)) {
        const x = kq[key];
        if (!x || x.ask - x.bid > 0.03 || q.ask - q.bid > 0.03) continue;
        const d = Math.abs((x.bid + x.ask) / 2 - (q.bid + q.ask) / 2);
        gaps.push(d);
        if (d >= 0.05) big.push(`${g.away.abbr}@${g.home.abbr} ${key} kalshi ${x.bid}/${x.ask} ${v} ${q.bid}/${q.ask}`);
      }
    }
    assert.deepEqual(big, [], `${v}: orientation bug?`);
    assert.ok(gaps.length >= need[v], `${v}: ${gaps.length} tight pairs`);
    gaps.sort((a, b) => a - b);
    assert.ok(gaps[Math.floor(gaps.length / 2)] <= 0.01, `${v}: median gap ${gaps[Math.floor(gaps.length / 2)]}`);
  }
});

test('buildVenue: a venue listing home and away the other way round is remapped to ESPN orientation', () => {
  const snap = boardsSnapshot();
  const V = venueInputs();
  const swap = (g) => ({ ...g, away: g.home, home: g.away, quotes: reorient(g.quotes) });
  for (const v of VENUE_KEYS) {
    const straight = buildVenue(v, V[v], { games: snap.games, eventsByLeague: eventsByLeague(), now: NOW, trim: false });
    const swapped = buildVenue(v, { ...V[v], leagues: Object.fromEntries(Object.entries(V[v].leagues).map(([l, gs]) => [l, gs.map(swap)])) }, { games: snap.games, eventsByLeague: eventsByLeague(), now: NOW, trim: false });
    assert.deepEqual([...swapped.refs.entries()], [...straight.refs.entries()], v);
  }
});

// ---------------------------------------------------------------- the snapshot block

// Kalshi + ESPN of the 2026-10-11 capture (the CLI fixture) with the venue captures stamped as pulled at that time,
// plus the Pinnacle capture, so venue refs sit next to refs.pinnacle and are trimmed to the Kalshi keys.
function fullInputs({ venues = venueInputs(RESEARCH_NOW.replace(/\.\d{3}Z$/, 'Z')) } = {}) {
  const RAW = gz('pinnacle', 'pinnacle-20261012.json.gz');
  const leagues = {};
  for (const lg of ['nfl', 'cfb']) leagues[lg] = { fetchedAt: RESEARCH_NOW, lastModified: null, ...trimPinnacle(lg, RAW[lg].matchups.body, RAW[lg].straight.body) };
  return { ...researchInputs(), pinnacle: { attemptAt: RESEARCH_NOW, cached: false, requests: 4, errors: [], leagues }, ...(venues ? { venues } : {}) };
}

test('buildSnapshot: refs.venues on pregame games next to refs.pinnacle, trimmed to Kalshi keys, sources per venue', () => {
  const s = buildSnapshot(fullInputs(), { now: RESEARCH_NOW });
  assert.deepEqual(validateSnapshot(s), []);
  assert.deepEqual(s.sources.polyus, { ok: true, fetchedAt: '2026-10-11T22:51:00Z', cached: false, requests: 4, matched: 75, matchedByLeague: { cfb: 61, nfl: 14 }, errors: [] });
  assert.deepEqual(s.sources.gemini.matchedByLeague, { cfb: 38, nfl: 14 });
  assert.deepEqual(s.sources.sx.matchedByLeague, { nfl: 14 });
  assert.ok(VENUE_KEYS.every((v) => s.sources[v].ok));
  let both = 0, quotes = 0;
  for (const g of s.games) {
    const vs = g.refs?.venues;
    if (!vs) continue;
    assert.equal(g.state, 'pre');
    assert.deepEqual(Object.keys(vs), VENUE_KEYS.filter((v) => vs[v]), 'venue order fixed');
    if (g.refs.pinnacle) { both++; assert.deepEqual(Object.keys(g.refs), ['pinnacle', 'venues']); }
    const keep = kalshiKeys(g);
    for (const [v, x] of Object.entries(vs)) {
      assert.equal(x.fetchedAt, '2026-10-11T22:51:00Z');
      const ks = Object.keys(x.quotes);
      assert.ok(ks.length >= 1);
      assert.ok(ks.every((k) => keep.has(k)), `${g.id} ${v}: only Kalshi keys`);
      assert.deepEqual(ks, [...ks].sort(keyOrder));
      quotes += ks.length;
    }
  }
  assert.ok(both >= 60, `${both} games carry both blocks`);
  const sum = summarize(s);
  assert.deepEqual(sum.venues.sx.nfl, { pre: 14, refs: 14, quotes: 14 });
  assert.equal(Object.values(sum.venues).flatMap((x) => Object.values(x)).reduce((a, b) => a + b.quotes, 0), quotes);
});

test('buildSnapshot: deterministic, venue game order does not matter, no venues = no venue fields at all', () => {
  const a = JSON.stringify(buildSnapshot(fullInputs(), { now: RESEARCH_NOW }));
  assert.equal(JSON.stringify(buildSnapshot(fullInputs(), { now: RESEARCH_NOW })), a);
  const V = venueInputs(RESEARCH_NOW.replace(/\.\d{3}Z$/, 'Z'));
  for (const v of VENUE_KEYS) for (const l of Object.keys(V[v].leagues)) V[v].leagues[l].reverse();
  assert.equal(JSON.stringify(buildSnapshot(fullInputs({ venues: V }), { now: RESEARCH_NOW })), a, 'same snapshot from reversed lists');
  const none = buildSnapshot(fullInputs({ venues: null }), { now: RESEARCH_NOW });
  const empty = buildSnapshot(fullInputs({ venues: {} }), { now: RESEARCH_NOW });
  assert.deepEqual(empty, none);
  assert.ok(VENUE_KEYS.every((v) => !(v in none.sources)), 'no sources entry for a venue that was not fetched');
  assert.ok(none.games.every((g) => !g.refs?.venues));
  // with venues, the snapshot is the one without them plus refs.venues and the three sources entries
  const withV = JSON.parse(a);
  for (const g of withV.games) if (g.refs?.venues) { delete g.refs.venues; if (!Object.keys(g.refs).length) delete g.refs; }
  for (const v of VENUE_KEYS) delete withV.sources[v];
  delete withV.collector; delete none.collector;
  assert.deepEqual(withV, JSON.parse(JSON.stringify(none)));
});

test('buildSnapshot: a failed, partial or crashing venue fails open on its own', () => {
  const ok = buildSnapshot(fullInputs(), { now: RESEARCH_NOW });
  const V = venueInputs(RESEARCH_NOW.replace(/\.\d{3}Z$/, 'Z'));
  V.gemini = { ...V.gemini, leagues: { nfl: null, cfb: null }, errors: ['api.gemini.com/v1/prediction-markets/events: HTTP 403'] };
  V.polyus = { ...V.polyus, leagues: { ...V.polyus.leagues, cfb: null }, errors: ['cfb: gateway.polymarket.us/v2/leagues/cfb/events: timeout'] };
  V.sx = { ...V.sx, leagues: { nfl: [null] } }; // a shape nobody has seen: the builder throws
  const s = buildSnapshot(fullInputs({ venues: V }), { now: RESEARCH_NOW });
  assert.deepEqual(validateSnapshot(s), []);
  assert.deepEqual(s.sources.gemini, { ok: false, fetchedAt: '2026-10-11T22:51:00Z', cached: false, requests: 1, matched: 0, matchedByLeague: {}, errors: ['api.gemini.com/v1/prediction-markets/events: HTTP 403'] });
  assert.equal(s.sources.polyus.ok, false);
  assert.deepEqual(s.sources.polyus.matchedByLeague, { nfl: 14 }, 'the NFL quotes are kept');
  assert.equal(s.sources.sx.ok, false);
  assert.match(s.sources.sx.errors.join(' '), /^build failed: /);
  assert.ok(s.games.every((g) => !g.refs?.venues?.gemini && !g.refs?.venues?.sx));
  assert.ok(s.games.filter((g) => g.league === 'cfb').every((g) => !g.refs?.venues));
  // everything else is as in the full build
  const strip = (x) => x.games.map((g) => { const c = clone(g); if (c.refs) { delete c.refs.venues; if (!Object.keys(c.refs).length) delete c.refs; } return c; });
  assert.deepEqual(strip(s), strip(ok));
  for (const k of ['kalshi', 'espnOdds', 'pinnacle', 'combos', 'fees', 'moves']) assert.deepEqual(s.sources[k], ok.sources[k], k);
  // the run diagnostics carry the unmatched lists for the logs, not the snapshot
  const run = buildRun(fullInputs(), { now: RESEARCH_NOW });
  assert.ok(run.venues.polyus.unmatched.length > 0);
  assert.equal(run.snapshot.unmatched.polyus, undefined);
});

test('buildVenue: nothing matched while both sides list games is a format error; kalshiKeys reads half point rungs', () => {
  const snap = boardsSnapshot();
  const V = venueInputs();
  const renamed = { ...V.sx, leagues: { nfl: V.sx.leagues.nfl.map((g) => ({ ...g, away: { name: `Team ${g.away.name.length}` }, home: { name: `Club ${g.home.name.length}` } })) } };
  const r = buildVenue('sx', renamed, { games: snap.games, eventsByLeague: eventsByLeague(), now: NOW });
  assert.deepEqual(r.matched, { nfl: 0 });
  assert.deepEqual(r.errors, ['nfl: none of 15 sx games matched any of 15 pregame games (team name format change?)']);
  const g = { kalshi: { markets: [
    { type: 'game', team: 'home', strike: null }, { type: 'spread', team: 'away', strike: 3.5 }, { type: 'spread', team: 'home', strike: 7 },
    { type: 'total', team: null, strike: 44.5 }, { type: 'teamTotal', team: 'home', strike: 20.5 },
  ] } };
  assert.deepEqual([...kalshiKeys(g)], ['ml:home', 'sp:away:3.5', 'tot:44.5']);
});
