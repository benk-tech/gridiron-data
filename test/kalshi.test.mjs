import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rd } from './helpers.mjs';
import { createHttp } from '../lib/http.mjs';
import {
  KALSHI_HOSTS, parseEventTicker, splitTeams, marketSuffix, buildKalshiGames, trimMarket, num,
  createKalshiClient, fetchSeriesMarkets, fetchMarketsByTickers, fetchOpenCollections, pickCollection,
  collectionEventTickers, feeFromSeries, settleRow,
} from '../lib/kalshi.mjs';
import { checkMarket } from '../lib/schema.mjs';

const F = 'research-20261011';
const mk = (s) => rd(F, `kalshi_${s}.json`).markets;

test('parseEventTicker / splitTeams', () => {
  assert.deepEqual(parseEventTicker('KXNCAAFSPREAD-26OCT17NEBORE'), { series: 'KXNCAAFSPREAD', dateKey: '2026-10-17', teamsPart: 'NEBORE', eventKey: '26OCT17NEBORE' });
  assert.equal(parseEventTicker('KXNFLGAME-26XYZ17NEBORE'), null);
  assert.equal(parseEventTicker('nonsense'), null);
  assert.deepEqual(splitTeams('NDSUUNM', ['UNM', 'NDSU']), ['NDSU', 'UNM']);
  assert.equal(splitTeams('NDSUUNM', ['UNM', 'ND']), null);
});

for (const [league, pre, nSpread, nTotal] of [['nfl', 'KXNFL', 178, 122], ['cfb', 'KXNCAAF', 1517, 969]]) {
  test(`${league}: every spread market links to its game and resolves team + strike (${nSpread})`, () => {
    const spreads = mk(`${pre}SPREAD`), totals = mk(`${pre}TOTAL`), gamesRaw = mk(`${pre}GAME`);
    assert.equal(spreads.length, nSpread);
    assert.equal(totals.length, nTotal);
    const kb = buildKalshiGames(gamesRaw, spreads, totals);
    assert.deepEqual(kb.errors, []);
    assert.equal(kb.stats.spreadLinked, nSpread, 'spread markets linked');
    assert.equal(kb.stats.totalLinked, nTotal, 'total markets linked');
    assert.equal(kb.stats.spreadDropped, 0);
    assert.equal(kb.stats.uuidConfirmed, nSpread, 'every spread team confirmed by custom_strike UUID');
    assert.equal(kb.orphans.length, 0);

    const uuidToCode = new Map();
    for (const g of kb.games.values()) { uuidToCode.set(g.away.teamId, g.away.code); uuidToCode.set(g.home.teamId, g.home.code); }
    let seen = 0;
    for (const g of kb.games.values()) {
      for (const l of g.legs.filter((x) => x.type === 'spread')) {
        seen++;
        const m = l.m;
        const sfx = /^([A-Z]+)(\d+)$/.exec(marketSuffix(m));
        assert.ok(sfx, m.ticker);
        assert.equal(l.code, sfx[1], `${m.ticker} code from suffix`);
        assert.equal(uuidToCode.get(m.custom_strike.football_team), l.code, `${m.ticker} code from UUID`);
        assert.ok(l.code === g.away.code || l.code === g.home.code);
        assert.equal(l.strike, Number(m.floor_strike));
        assert.equal(Math.ceil(l.strike), Number(sfx[2]), `${m.ticker} ceil(strike) = suffix`);
        assert.equal(Math.abs(l.strike % 1), 0.5, 'all strikes are X.5');
        // The team named in the title is the resolved team (title starts with the GAME market name or the code).
        const want = l.code === g.away.code ? g.away : g.home;
        const titleTeam = m.yes_sub_title.replace(/ wins by over .*$/, '');
        const first = titleTeam.split(' ')[0];
        assert.ok(titleTeam === want.name || want.code.startsWith(first.toUpperCase()) || want.name.startsWith(first), `${m.ticker}: '${titleTeam}' vs ${want.code}/${want.name}`);
        // Spread events can carry a different date code (CFB), but never more than 1 day.
        const dd = Math.abs(Date.parse(parseEventTicker(m.event_ticker).dateKey) - Date.parse(g.dateKey)) / 864e5;
        assert.ok(dd <= 1);
        const t = trimMarket(m, { type: 'spread', team: l.code === g.home.code ? 'home' : 'away', strike: l.strike });
        const problems = [];
        checkMarket(t, m.ticker, (x) => problems.push(x), { spreadEvent: m.event_ticker });
        assert.deepEqual(problems, []);
      }
      for (const l of g.legs.filter((x) => x.type === 'total')) {
        assert.equal(Math.ceil(l.strike), Number(marketSuffix(l.m)));
        assert.equal(l.code, null);
      }
    }
    assert.equal(seen, nSpread);
  });
}

test('cfb: spread date code differs from GAME on some events and still links (+/- 1 day)', () => {
  const kb = buildKalshiGames(mk('KXNCAAFGAME'), mk('KXNCAAFSPREAD'), mk('KXNCAAFTOTAL'));
  const shifted = [...kb.games.values()].filter((g) => g.spreadEvent && g.spreadEvent.split('-')[1] !== g.eventKey);
  assert.ok(shifted.length >= 20, `shifted ${shifted.length}`);
  const kent = [...kb.games.values()].find((g) => g.teamsPart === 'KENTUSF');
  assert.equal(kent.eventTicker, 'KXNCAAFGAME-26OCT16KENTUSF');
  assert.equal(kent.spreadEvent, 'KXNCAAFSPREAD-26OCT17KENTUSF');
});

test('one-sided CFB ladders are fine (no mirror rung assumed)', () => {
  const kb = buildKalshiGames(mk('KXNCAAFGAME'), mk('KXNCAAFSPREAD'), []);
  const g = [...kb.games.values()].find((x) => x.teamsPart === 'CHARTEM');
  assert.ok(g, 'CHARTEM present');
  const codes = new Set(g.legs.filter((l) => l.type === 'spread').map((l) => l.code));
  assert.equal(codes.size, 1);
});

test('UUID / ticker disagreement drops the market and records an error', () => {
  const games = mk('KXNFLGAME').filter((m) => m.event_ticker === 'KXNFLGAME-26OCT18HOUJAC');
  const spreads = mk('KXNFLSPREAD').filter((m) => m.event_ticker === 'KXNFLSPREAD-26OCT18HOUJAC').slice(0, 2);
  const hou = games.find((m) => m.ticker.endsWith('-HOU')).custom_strike.football_team;
  const jac = games.find((m) => m.ticker.endsWith('-JAC')).custom_strike.football_team;
  const bad = spreads.map((m) => ({ ...m, custom_strike: { football_team: m.custom_strike.football_team === hou ? jac : hou } }));
  const kb = buildKalshiGames(games, bad, []);
  assert.equal(kb.stats.spreadLinked, 0);
  assert.equal(kb.stats.spreadDropped, 2);
  assert.match(kb.errors[0], /team UUID says/);
});

test('missing floor_strike falls back to the ticker suffix; mismatch is reported', () => {
  const games = mk('KXNFLGAME').filter((m) => m.event_ticker === 'KXNFLGAME-26OCT18HOUJAC');
  const s = mk('KXNFLSPREAD').find((m) => m.ticker === 'KXNFLSPREAD-26OCT18HOUJAC-JAC8');
  const kb = buildKalshiGames(games, [{ ...s, floor_strike: undefined }, { ...s, ticker: 'KXNFLSPREAD-26OCT18HOUJAC-JAC9' }], []);
  const legs = [...kb.games.values()][0].legs.filter((l) => l.type === 'spread');
  assert.equal(legs[0].strike, 7.5);
  assert.equal(legs[1].strike, 7.5);
  assert.match(kb.errors.join(' '), /does not match suffix 9/);
});

test('trimMarket converts strings to numbers and keeps the NO identities', () => {
  const m = mk('KXNFLGAME').find((x) => x.ticker === 'KXNFLGAME-26OCT19WASSF-WAS');
  const t = trimMarket(m, { type: 'game', team: 'away', strike: null });
  for (const k of ['yesAsk', 'yesBid', 'noAsk', 'noBid', 'yesAskSize', 'yesBidSize', 'volume', 'volume24h', 'openInterest', 'lastPrice']) assert.equal(typeof t[k], 'number', k);
  assert.ok(Math.abs(t.noAsk - (1 - t.yesBid)) < 1e-9);
  assert.ok(Math.abs(t.noBid - (1 - t.yesAsk)) < 1e-9);
  assert.equal(t.series, 'KXNFLGAME');
  assert.equal(t.title, 'Washington');
  assert.deepEqual(Object.keys(t), ['ticker', 'event', 'series', 'type', 'team', 'strike', 'title', 'yesAsk', 'yesBid', 'noAsk', 'noBid', 'yesAskSize', 'yesBidSize', 'lastPrice', 'prevYesAsk', 'volume', 'volume24h', 'openInterest', 'status']);
  assert.equal(num(''), null);
  assert.equal(num('0.6300'), 0.63);
  assert.equal(num('abc'), null);
  // no_ask missing -> derived from yes_bid
  const t2 = trimMarket({ ...m, no_ask_dollars: undefined, no_bid_dollars: undefined }, { type: 'game' });
  assert.equal(t2.noAsk, Math.round((1 - t2.yesBid) * 1e4) / 1e4);
});

test('non-active markets are dropped', () => {
  const games = mk('KXNFLGAME').filter((m) => m.event_ticker === 'KXNFLGAME-26OCT18HOUJAC');
  const spreads = mk('KXNFLSPREAD').filter((m) => m.event_ticker === 'KXNFLSPREAD-26OCT18HOUJAC');
  const kb = buildKalshiGames(games, spreads.map((m, i) => (i === 0 ? { ...m, status: 'closed' } : m)), []);
  assert.equal(kb.stats.spreadLinked, spreads.length - 1);
});

test('fees, collections, settle rows', () => {
  const series = rd(F, 'series.json');
  assert.deepEqual(feeFromSeries(series.KXNFLGAME), { feeType: 'quadratic_with_maker_fees', multiplier: 1 });
  const cols = rd(F, 'collections.json');
  const c = pickCollection(cols);
  assert.equal(c.collection_ticker, 'KXMVECROSSCATEGORY-R');
  assert.ok(collectionEventTickers(c).includes('KXNFLSPREAD-26OCT15SEADEN'));
  assert.equal(pickCollection([]), null);
  // Shape seen live on KXNFLGAME-26OCT11SFSEA-SF (2026-10-12).
  assert.deepEqual(settleRow({ ticker: 'A', status: 'finalized', result: 'yes', settlement_ts: '2026-10-12T03:31:07.123Z', settlement_value_dollars: '1.0000' }), { ticker: 'A', status: 'finalized', result: 'yes', settledAt: '2026-10-12T03:31:07Z', value: 1 });
  assert.equal(settleRow({ ticker: 'A', status: 'active', result: '' }), null);
  assert.equal(settleRow({ ticker: 'A', status: 'closed', result: '' }), null);
  // Tie or void: final with no yes/no result -> reported with result '' and the settlement value.
  assert.deepEqual(settleRow({ ticker: 'T', status: 'finalized', result: 'scalar', settlement_ts: '2026-10-12T03:31:07Z', settlement_value_dollars: '0.5000' }), { ticker: 'T', status: 'finalized', result: '', settledAt: '2026-10-12T03:31:07Z', value: 0.5 });
});

// ---- fetching with a mock fetch (offline)

function mockFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    for (const [re, h] of routes) if (re.test(url)) return h(url, calls.length);
    return new Response('not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

test('fetchSeriesMarkets follows the cursor until empty', async () => {
  const f = mockFetch([[/\/markets\?/, (u) => {
    const c = new URL(u).searchParams.get('cursor');
    if (!c) return json({ cursor: 'p2', markets: [{ ticker: 'A' }] });
    if (c === 'p2') return json({ cursor: 'p3', markets: [{ ticker: 'B' }] });
    return json({ cursor: '', markets: [{ ticker: 'C' }] });
  }]]);
  const client = createKalshiClient({ http: createHttp({ fetchImpl: f }) });
  const out = await fetchSeriesMarkets(client, 'KXNCAAFSPREAD', { maxCloseTs: 123 });
  assert.deepEqual(out.map((m) => m.ticker), ['A', 'B', 'C']);
  assert.equal(f.calls.length, 3);
  const u = new URL(f.calls[0]);
  assert.equal(u.origin + u.pathname, `${KALSHI_HOSTS[0]}/markets`);
  assert.equal(u.searchParams.get('status'), 'open');
  assert.equal(u.searchParams.get('limit'), '1000');
  assert.equal(u.searchParams.get('max_close_ts'), '123');
  assert.equal(client.stats.requests, 3);
});

test('Kalshi client falls back to the second host on 429/5xx/network errors', async () => {
  const f = mockFetch([
    [/api\.elections/, () => new Response('slow down', { status: 429 })],
    [/external-api/, () => json({ cursor: '', markets: [{ ticker: 'X' }] })],
  ]);
  const client = createKalshiClient({ http: createHttp({ fetchImpl: f }) });
  const out = await fetchSeriesMarkets(client, 'KXNFLGAME');
  assert.deepEqual(out.map((m) => m.ticker), ['X']);
  assert.equal(client.hostUsed(), KALSHI_HOSTS[1]);
  assert.equal(f.calls.length, 2);
  // Next request goes straight to the host that worked.
  await fetchSeriesMarkets(client, 'KXNFLTOTAL');
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[2], /external-api/);
});

test('Kalshi 400 on max_close_ts retries once without it', async () => {
  const f = mockFetch([[/\/markets\?/, (u) => (new URL(u).searchParams.has('max_close_ts') ? new Response('bad', { status: 400 }) : json({ cursor: '', markets: [{ ticker: 'Y' }] }))]]);
  const client = createKalshiClient({ http: createHttp({ fetchImpl: f }) });
  const out = await fetchSeriesMarkets(client, 'KXNFLGAME', { maxCloseTs: 99 });
  assert.deepEqual(out.map((m) => m.ticker), ['Y']);
  assert.equal(f.calls.length, 2);
});

test('both hosts down -> error with the status, no hang', async () => {
  const f = mockFetch([[/./, () => new Response('down', { status: 503 })]]);
  const client = createKalshiClient({ http: createHttp({ fetchImpl: f }) });
  await assert.rejects(fetchSeriesMarkets(client, 'KXNFLGAME'), /HTTP 503/);
  assert.equal(f.calls.length, 2);
});

test('fetchMarketsByTickers chunks by 100 with the comma form and drops junk tickers', async () => {
  const f = mockFetch([[/\/markets\?/, (u) => json({ cursor: '', markets: new URL(u).searchParams.get('tickers').split(',').map((t) => ({ ticker: t })) })]]);
  const client = createKalshiClient({ http: createHttp({ fetchImpl: f }) });
  const tickers = Array.from({ length: 205 }, (_, i) => `KXNFLGAME-26OCT11SFSEA-T${i}`);
  const out = await fetchMarketsByTickers(client, [...tickers, 'bad ticker&x=1', tickers[0]]);
  assert.equal(out.length, 205);
  assert.equal(f.calls.length, 3);
});

test('fetchOpenCollections paginates', async () => {
  const f = mockFetch([[/multivariate_event_collections/, (u) => (new URL(u).searchParams.get('cursor') ? json({ cursor: '', multivariate_contracts: [{ collection_ticker: 'B' }] }) : json({ cursor: 'n', multivariate_contracts: [{ collection_ticker: 'A' }] }))]]);
  const client = createKalshiClient({ http: createHttp({ fetchImpl: f }) });
  const out = await fetchOpenCollections(client);
  assert.deepEqual(out.map((c) => c.collection_ticker), ['A', 'B']);
  assert.match(f.calls[0], /status=open/);
});
