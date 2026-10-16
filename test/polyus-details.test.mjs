// Polymarket US since 2026-10-15: the league lists (GET /v2/leagues/{nfl,cfb}/events) carry only each event's
// winner market; the full game spreads and totals come only with the event detail (GET /v1/events/slug/{slug}), in
// the same market shape the old list used. Offline: a collector run of 2026-10-16 07:05Z with --polyus-details 16
// (scripts/make-polyus-fixtures.mjs): the 4 list pages, 16 event details (8 NFL, 8 college), and that run's ESPN
// boards and Kalshi books. The format before (the lines inside the list) is polyus-20261012.json.gz, read in
// test/venues.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { FIX } from './helpers.mjs';
import { parsePolyUS, fetchPolyUSInputs, planDetails, detailKickoff, POLYUS_BASE, POLYUS_MAX_DETAILS, POLYUS_DETAIL_AHEAD_MS } from '../lib/venues/polyus.mjs';
import { buildVenue, venueFormatErrors } from '../lib/venues/index.mjs';
import { Q, flipQ, reorient } from '../lib/venues/common.mjs';
import { buildSnapshot, WINDOW } from '../lib/build.mjs';
import { validateSnapshot } from '../lib/schema.mjs';

const gz = (...p) => JSON.parse(gunzipSync(readFileSync(join(FIX, ...p))).toString('utf8'));
const NEW = gz('venues', 'polyus-20261016.json.gz');
const OLD = gz('venues', 'polyus-20261012.json.gz');
const NOW = NEW.now; // 2026-10-16T07:05:26Z
const clone = (x) => JSON.parse(JSON.stringify(x));
const WINNER = 'football_team_full_game_winner', SPREAD = 'football_team_full_game_spread', TOTAL = 'football_team_full_game_total';
const KEY_RE = /^(ml:home|sp:(home|away):\d+\.5|tot:\d+\.5)$/;
const kinds = (L) => {
  const c = { ml: 0, sp: 0, tot: 0 };
  for (const g of L || []) for (const k of Object.keys(g.quotes)) c[k.split(':')[0]]++;
  return c;
};
const listUrls = [
  `${POLYUS_BASE}/v2/leagues/nfl/events?limit=100&offset=0`,
  `${POLYUS_BASE}/v2/leagues/cfb/events?limit=100&offset=0`,
  `${POLYUS_BASE}/v2/leagues/cfb/events?limit=100&offset=100`,
  `${POLYUS_BASE}/v2/leagues/cfb/events?limit=100&offset=200`,
];
// The 16 details of the run, in the order they were asked for: the leagues take turns, each by kickoff then slug.
const PLANNED = [
  'nfl-hou-jax-2026-10-18', 'cfb-clmb-penn-2026-10-16', 'nfl-bal-cle-2026-10-18', 'cfb-mphs-tulane-2026-10-16',
  'nfl-car-phi-2026-10-18', 'cfb-applst-coast-2026-10-16', 'nfl-chi-atl-2026-10-18', 'cfb-wash-pur-2026-10-16',
  'nfl-no-nyg-2026-10-18', 'cfb-ballst-bowlgr-2026-10-17', 'nfl-nyj-ne-2026-10-18', 'cfb-chsou-clmsn-2026-10-17',
  'nfl-pit-tb-2026-10-18', 'cfb-cin-wvir-2026-10-17', 'nfl-ten-ind-2026-10-18', 'cfb-fl-tx-2026-10-17',
];

// The gateway of that run: the list pages, the 16 details by slug (any other detail 404), status overrides by slug.
function gateway({ details = NEW.details, status = {}, delay = null, calls = [] } = {}) {
  const bySlug = new Map(details.map((d) => [d.slug, d]));
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const lg = /^\/v2\/leagues\/(nfl|cfb)\/events$/.exec(u.pathname)?.[1];
    if (lg) {
      const off = Number(u.searchParams.get('offset'));
      return new Response(JSON.stringify({ events: NEW.list[lg].slice(off, off + 100) }), { status: 200 });
    }
    const slug = /^\/v1\/events\/slug\/(.+)$/.exec(u.pathname)?.[1];
    if (delay) await new Promise((r) => setTimeout(r, delay(slug)));
    if (status[slug]) return new Response('{"code":7,"message":"x"}', { status: status[slug] });
    if (slug && bySlug.has(slug)) return new Response(JSON.stringify({ event: bySlug.get(slug) }), { status: 200 });
    return new Response('{"code":5,"message":"not found"}', { status: 404 });
  };
}
const via = (g = {}, opts = {}) => fetchPolyUSInputs({ fetchImpl: gateway(g), now: Date.parse(NOW), retryDelayMs: 0, maxDetails: 16, ...opts });

// Kalshi books of the run in canonical keys (the two winner markets folded), as in test/venues.test.mjs.
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
const boardsSnapshot = () => buildSnapshot({ espn: { fetchedAt: NOW, errors: [], scoreboards: clone(NEW.espn.scoreboards) } }, { now: NOW });
const eventsByLeague = () => Object.fromEntries(Object.entries(NEW.espn.scoreboards).map(([l, bs]) => [l, bs.flatMap((b) => b.events || [])]));

// ---------------------------------------------------------------- what changed

test('what changed: the 2026-10-16 lists carry only the winner market, and the format check names the missing kinds as the scheduled run logged them', () => {
  for (const lg of ['nfl', 'cfb']) {
    for (const e of NEW.list[lg]) assert.deepEqual(e.markets.map((m) => m.sportsMarketType), [WINNER], e.slug);
  }
  const withLines = (L) => L.filter((e) => e.markets.some((m) => m.sportsMarketType === SPREAD) && e.markets.some((m) => m.sportsMarketType === TOTAL)).length;
  assert.deepEqual([withLines(OLD.nfl), withLines(OLD.cfb), withLines(NEW.list.nfl), withLines(NEW.list.cfb)], [15, 59, 0, 0], 'the old list carried the lines of every game that had them');
  // the lines still exist: the list counts them per event (27 NFL games, 68 college games; 0 on most FCS games)
  const counted = (lg) => NEW.list[lg].filter((e) => e.marketCounts.numSpreadsAndTotalsMarkets > 0).length;
  assert.deepEqual([counted('nfl'), counted('cfb')], [27, 68]);
  // read the old way (the list only): winner quotes, and the four errors of the 2026-10-16 runs
  const R = { leagues: { nfl: parsePolyUS(NEW.list.nfl), cfb: parsePolyUS(NEW.list.cfb) }, seen: { nfl: 28, cfb: 218 } };
  assert.deepEqual([kinds(R.leagues.nfl), kinds(R.leagues.cfb)], [{ ml: 27, sp: 0, tot: 0 }, { ml: 172, sp: 0, tot: 0 }]);
  assert.deepEqual(venueFormatErrors('polyus', R), [
    'cfb: 218 polyus games but no spread quotes (format change?)',
    'cfb: 218 polyus games but no total quotes (format change?)',
    'nfl: 28 polyus games but no spread quotes (format change?)',
    'nfl: 28 polyus games but no total quotes (format change?)',
  ]);
});

test('what did not change: the detail carries the full game lines in the old market shape; CAR @ PHI read by hand', () => {
  const d = NEW.details.find((x) => x.slug === 'nfl-car-phi-2026-10-18');
  const oldSpread = OLD.rawBufLar.event.markets.find((m) => m.sportsMarketType === SPREAD);
  const oldTotal = OLD.rawBufLar.event.markets.find((m) => m.sportsMarketType === TOTAL);
  // same type labels, the same fields the parser reads, the same side and outcome naming
  for (const d2 of NEW.details) {
    const full = d2.markets.filter((m) => [WINNER, SPREAD, TOTAL].includes(m.sportsMarketType));
    assert.deepEqual([...new Set(full.map((m) => m.sportsMarketType))].sort(), [WINNER, SPREAD, TOTAL].sort(), d2.slug);
    for (const m of full) {
      for (const k of ['slug', 'sportsMarketType', 'status', 'marketSides']) assert.ok(k in m, `${m.slug} ${k}`);
      for (const k of ['bestBidQuote', 'bestAskQuote']) if (k in m) assert.match(m[k].value, /^0\.\d+$/, `${m.slug} ${k}: a decimal string, as before (left out when that side of the book is empty)`);
      if (m.sportsMarketType === WINNER) continue;
      assert.equal(typeof m.line, 'number', m.slug);
      assert.ok(Math.abs(Math.abs(m.line % 1) - 0.5) < 1e-9, `${m.slug}: half point lines, a number as before`);
      const L = m.marketSides.find((s) => s.long);
      if (m.sportsMarketType === SPREAD) {
        assert.equal(L.team.ordering, 'away', `${m.slug}: the long side of every spread rung is the away team`);
        assert.equal(L.description, `${m.line > 0 ? '+' : '-'}${Math.abs(m.line).toFixed(2)}`, m.slug);
        assert.match(m.slug, m.line < 0 ? /-neg-\d+pt5$/ : /-pos-\d+pt5$/);
      } else {
        assert.equal(L.description, 'Over', m.slug);
      }
    }
  }
  assert.deepEqual(Object.keys(d.markets.find((m) => m.sportsMarketType === SPREAD).marketSides[0].team).sort(), Object.keys(oldSpread.marketSides[0].team).sort());
  assert.equal(oldSpread.marketSides.find((s) => s.long).description, '+33.50', 'old: the same "+33.50" outcome naming');
  assert.equal(oldTotal.marketSides.find((s) => s.long).description, 'Over');

  const [g] = parsePolyUS([d]);
  assert.deepEqual([g.away.name, g.home.name, g.kickoff], ['Carolina Panthers', 'Philadelphia Eagles', '2026-10-18T17:00:00Z']);
  assert.equal(Object.keys(g.quotes).length, 71, '1 winner + 41 spread + 29 total rungs; the half, team total and player prop markets kept in the fixture are ignored');
  assert.ok(Object.keys(g.quotes).every((k) => KEY_RE.test(k)));
  assert.deepEqual(g.quotes['ml:home'], Q(0.365, 0.3675), 'Panthers long 0.6325 / 0.635');
  assert.deepEqual(g.quotes['sp:away:3.5'], Q(0.495, 0.5), 'neg rung: CAR -3.5 is YES of the long side');
  const pos = d.markets.find((m) => m.slug === 'asc-nfl-car-phi-2026-10-18-pos-3pt5');
  assert.equal(pos.title, 'Philadelphia Eagles wins by over 3.5 points', 'the title of a pos rung names the short side');
  assert.deepEqual([pos.bestBidQuote.value, pos.bestAskQuote.value], ['0.7300', '0.7350']);
  assert.deepEqual(g.quotes['sp:home:3.5'], Q(0.265, 0.27), 'pos rung: CAR +3.5 covering is NO of PHI by more than 3.5');
  assert.deepEqual(g.quotes['sp:away:7.5'], Q(0.34, 0.35));
  assert.deepEqual(g.quotes['sp:home:7.5'], Q(0.155, 0.165));
  assert.deepEqual(g.quotes['tot:44.5'], Q(0.31, 0.32), 'long = Over');
});

// ---------------------------------------------------------------- the fetcher

test('fetchPolyUSInputs on the new format: 4 list GETs, then one detail per game with lines, the leagues taking turns by kickoff', async () => {
  const calls = [];
  const r = await via({ calls });
  assert.equal(r.requests, 20);
  assert.deepEqual(calls.slice(0, 4), listUrls);
  assert.deepEqual(calls.slice(4), PLANNED.map((s) => `${POLYUS_BASE}/v1/events/slug/${s}`));
  assert.deepEqual([r.fetchedAt, r.errors, r.seen], ['2026-10-16T07:05:26Z', [], { nfl: 28, cfb: 218 }]);
  assert.deepEqual(r.details, { nfl: { wanted: 14, pulled: 8 }, cfb: { wanted: 68, pulled: 8 } });
  assert.deepEqual([kinds(r.leagues.nfl), kinds(r.leagues.cfb)], [{ ml: 27, sp: 324, tot: 229 }, { ml: 172, sp: 287, tot: 181 }]);
  assert.deepEqual(venueFormatErrors('polyus', r), []);
  // a game with a detail: the detail's quotes (its winner too, read seconds after the list); the others: the list's winner
  const withLines = [...r.leagues.nfl, ...r.leagues.cfb].filter((g) => Object.keys(g.quotes).length > 1).map((g) => g.id).sort();
  assert.deepEqual(withLines, [...PLANNED].sort());
  const cp = r.leagues.nfl.find((g) => g.id === 'nfl-car-phi-2026-10-18');
  assert.deepEqual(cp.quotes, parsePolyUS([NEW.details.find((d) => d.slug === cp.id)])[0].quotes);
  assert.deepEqual(r.leagues.nfl.map((g) => g.id), parsePolyUS(NEW.list.nfl).map((g) => g.id), 'the list order is kept');

  // the games that want a detail: open, lines counted, kicking off after now and inside the snapshot window (9 days)
  const now = Date.parse(NOW);
  const wanted = NEW.list.nfl.filter((e) => detailKickoff(e, now) != null);
  assert.equal(wanted.length, 14);
  assert.ok(wanted.every((e) => Date.parse(e.startTime) > now && Date.parse(e.startTime) <= now + POLYUS_DETAIL_AHEAD_MS));
  assert.ok(NEW.list.nfl.filter((e) => !wanted.includes(e)).every((e) => !(e.marketCounts.numSpreadsAndTotalsMarkets > 0) || Date.parse(e.startTime) > now + POLYUS_DETAIL_AHEAD_MS), 'the rest: no lines, or next week');
  assert.equal(POLYUS_DETAIL_AHEAD_MS, WINDOW.aheadMs, 'the snapshot window');
  assert.equal(detailKickoff(OLD.nfl[0], Date.parse(OLD.fetchedAt)), null, 'an old list event carries its lines: no detail');
  assert.equal(detailKickoff({ ...NEW.list.nfl[0], closed: true }, now), null);
  assert.equal(detailKickoff(NEW.list.nfl[0], Date.parse(NEW.list.nfl[0].startTime)), null, 'started: no detail');
});

test('fetchPolyUSInputs: the default cap reads every wanted game; the merge does not depend on which answer came first', async () => {
  // default cap (100): 82 details; the 66 not in the fixture answer 404 and those games keep their winner quote
  const calls = [];
  const all = await via({ calls }, { maxDetails: undefined });
  assert.equal(POLYUS_MAX_DETAILS, 100);
  assert.equal(all.requests, 86);
  assert.equal(new Set(calls).size, 86, 'one GET each');
  assert.equal(all.errors.length, 66);
  assert.match(all.errors[0], /^cfb cfb-[a-z0-9-]+: gateway\.polymarket\.us\/v1\/events\/slug\/cfb-[a-z0-9-]+: HTTP 404$/);
  assert.deepEqual(all.errors, [...all.errors].sort(), 'sorted');
  assert.deepEqual(all.leagues, (await via()).leagues);
  // answers arriving in reverse order (concurrency 4): the same games and quotes
  const slow = await via({ delay: (s) => 40 - 2 * PLANNED.indexOf(s) }, { concurrency: 4 });
  assert.deepEqual(slow.leagues, (await via()).leagues);
  // planDetails: the leagues take turns, each by kickoff then id, up to the cap
  const w = (league, id, kickoff) => ({ league, id, kickoff });
  const wanted = { nfl: [w('nfl', 'b', 3), w('nfl', 'a', 3), w('nfl', 'c', 1)], cfb: [w('cfb', 'x', 2), w('cfb', 'y', 1), w('cfb', 'z', 5), w('cfb', 'q', 9)] };
  assert.deepEqual(planDetails(wanted, ['nfl', 'cfb'], 6).map((d) => d.id), ['c', 'y', 'a', 'x', 'b', 'z']);
  assert.deepEqual(planDetails(wanted, ['nfl', 'cfb'], 0), []);
  assert.deepEqual(planDetails({ cfb: wanted.cfb }, ['nfl', 'cfb']).map((d) => d.id), ['y', 'x', 'z', 'q'], 'a league without games');
});

test('fetchPolyUSInputs: a failed detail keeps the winner; a 403 stops the rest; no details at all is reported by the format check', async () => {
  // a 404 (an event gone between the list and the detail): that game keeps its winner quote, the rest are read
  const a = await via({ status: { 'nfl-car-phi-2026-10-18': 404 } });
  assert.deepEqual(a.errors, ['nfl nfl-car-phi-2026-10-18: gateway.polymarket.us/v1/events/slug/nfl-car-phi-2026-10-18: HTTP 404']);
  assert.deepEqual(Object.keys(a.leagues.nfl.find((g) => g.id === 'nfl-car-phi-2026-10-18').quotes), ['ml:home']);
  assert.deepEqual(a.details.nfl, { wanted: 14, pulled: 7 });
  // a 5xx is retried once
  let n = 0;
  const flaky = gateway();
  const b = await fetchPolyUSInputs({ fetchImpl: async (url) => (url.includes('nfl-hou-jax') && !n++ ? new Response('{}', { status: 502 }) : flaky(url)), now: Date.parse(NOW), retryDelayMs: 0, maxDetails: 16 });
  assert.deepEqual([b.requests, b.errors, b.details.nfl.pulled], [21, [], 8]);
  // a 403 (a block): no further detail GET; one error says so
  const calls = [];
  const c = await via({ calls, status: { 'nfl-hou-jax-2026-10-18': 403 } }, { concurrency: 1 });
  assert.deepEqual([c.requests, calls.length], [5, 5]);
  assert.deepEqual(c.errors, ['details stopped after nfl nfl-hou-jax-2026-10-18: gateway.polymarket.us/v1/events/slug/nfl-hou-jax-2026-10-18: HTTP 403']);
  assert.deepEqual([kinds(c.leagues.nfl).sp, kinds(c.leagues.cfb).sp], [0, 0]);
  // a detail that is not an event, or whose winner market is gone: an error, the winner from the list stays
  const d = await via({ details: NEW.details.map((x) => (x.slug === 'nfl-bal-cle-2026-10-18' ? { ...x, markets: x.markets.filter((m) => m.sportsMarketType !== WINNER) } : x)) });
  assert.deepEqual(d.errors, ['nfl nfl-bal-cle-2026-10-18: event detail could not be read (format change?)']);
  assert.deepEqual(Object.keys(d.leagues.nfl.find((g) => g.id === 'nfl-bal-cle-2026-10-18').quotes), ['ml:home']);
  const e = await fetchPolyUSInputs({ fetchImpl: async (url) => (url.includes('/v1/') ? new Response('{"events":[]}', { status: 200 }) : gateway()(url)), now: Date.parse(NOW), retryDelayMs: 0, maxDetails: 2 });
  assert.deepEqual(e.errors, ['cfb cfb-clmb-penn-2026-10-16: expected an event with markets (format change?)', 'nfl nfl-hou-jax-2026-10-18: expected an event with markets (format change?)']);
  // --polyus-details 0: the list only (4 GETs); the spread and total check reports the lines missing
  const z = await via({}, { maxDetails: 0 });
  assert.deepEqual([z.requests, z.errors, z.details], [4, [], { nfl: { wanted: 14, pulled: 0 }, cfb: { wanted: 68, pulled: 0 } }]);
  assert.equal(venueFormatErrors('polyus', z).length, 4);
});

test('format check on the detail format: lines that vanish from the details too set sources.polyus.ok false; the rest still votes', async () => {
  const renamed = NEW.details.map((d) => ({ ...d, markets: d.markets.map((m) => (m.sportsMarketType === SPREAD ? { ...m, sportsMarketType: 'football_team_full_game_handicap' } : m)) }));
  const r = await via({ details: renamed });
  assert.deepEqual(r.errors, []);
  assert.deepEqual([kinds(r.leagues.nfl).sp, kinds(r.leagues.nfl).tot > 0], [0, true]);
  assert.deepEqual(venueFormatErrors('polyus', r), ['cfb: 218 polyus games but no spread quotes (format change?)', 'nfl: 28 polyus games but no spread quotes (format change?)']);
  const s = buildSnapshot({ espn: { fetchedAt: NOW, errors: [], scoreboards: clone(NEW.espn.scoreboards) }, venues: { polyus: r } }, { now: NOW });
  assert.deepEqual(validateSnapshot(s), []);
  assert.equal(s.sources.polyus.ok, false);
  assert.deepEqual(s.sources.polyus.errors, ['cfb: 218 polyus games but no spread quotes (format change?)', 'nfl: 28 polyus games but no spread quotes (format change?)']);
  assert.ok(s.sources.polyus.matched > 0 && s.games.some((g) => g.refs?.venues?.polyus?.quotes?.['ml:home']));
  // the same run with the details as served: ok (no Kalshi markets in this build, so every block is trimmed to its
  // winner quote, and the one college game without a two sided winner book gets none)
  const ok = buildSnapshot({ espn: { fetchedAt: NOW, errors: [], scoreboards: clone(NEW.espn.scoreboards) }, venues: { polyus: await via() } }, { now: NOW });
  assert.deepEqual([ok.sources.polyus.ok, ok.sources.polyus.errors, ok.sources.polyus.matchedByLeague], [true, [], { cfb: 98, nfl: 14 }]);
});

// ---------------------------------------------------------------- orientation and sign against Kalshi, same run

test('orientation regression (detail format): every tight Polymarket US / Kalshi pair of the 2026-10-16 run is within 3 cents', async () => {
  const snap = boardsSnapshot();
  const r = buildVenue('polyus', await via(), { games: snap.games, eventsByLeague: eventsByLeague(), now: NOW, trim: false });
  assert.deepEqual([r.matched, r.errors], [{ cfb: 99, nfl: 14 }, []]);
  const check = (orient) => {
    const out = {};
    for (const g of snap.games) {
      const ref = r.refs.get(g.id), k = NEW.kalshi.games[g.espnId];
      if (!ref || !k) continue;
      const S = (out[g.league] ||= { lineGames: 0, pairs: { ml: 0, sp: 0, tot: 0 }, gaps: [], big: [] });
      const quotes = orient(ref.quotes);
      if (Object.keys(quotes).some((x) => !x.startsWith('ml'))) S.lineGames++;
      const kq = kalshiQuotes(k.markets);
      for (const [key, q] of Object.entries(quotes)) {
        const x = kq[key];
        if (!x || x.ask - x.bid > 0.03 || q.ask - q.bid > 0.03) continue; // tight books only
        const d = Math.abs((x.bid + x.ask) / 2 - (q.bid + q.ask) / 2);
        S.pairs[key.split(':')[0]]++;
        S.gaps.push(d);
        if (d >= 0.03 - 1e-9) S.big.push(`${g.away.abbr}@${g.home.abbr} ${key} kalshi ${x.bid}/${x.ask} polyus ${q.bid}/${q.ask}`);
      }
    }
    for (const S of Object.values(out)) S.gaps.sort((a, b) => a - b);
    return out;
  };
  const got = check((q) => q);
  // 8 NFL and 7 college games with lines (Columbia @ Penn is FCS vs FCS, not on these boards)
  assert.deepEqual([got.nfl.lineGames, got.cfb.lineGames], [8, 7]);
  assert.deepEqual([got.nfl.pairs, got.cfb.pairs], [{ ml: 14, sp: 200, tot: 98 }, { ml: 57, sp: 152, tot: 64 }]);
  for (const lg of ['nfl', 'cfb']) {
    assert.deepEqual(got[lg].big, [], `${lg}: a pair 3 cents or more apart (orientation or sign bug?)`);
    assert.ok(got[lg].gaps[got[lg].gaps.length >> 1] <= 0.005, `${lg}: median gap ${got[lg].gaps[got[lg].gaps.length >> 1]}`);
  }
  // the check has teeth: home and away swapped, or every spread sign flipped, puts many pairs 3 cents or more apart
  const swapped = check(reorient);
  const signFlip = (quotes) => Object.fromEntries(Object.entries(quotes).map(([k, v]) => (k.startsWith('sp:') ? [k, flipQ(v)] : [k, v])));
  const flipped = check(signFlip);
  for (const lg of ['nfl', 'cfb']) {
    assert.ok(swapped[lg].big.length >= 50, `${lg} swapped: ${swapped[lg].big.length}`);
    assert.ok(flipped[lg].big.length >= 50, `${lg} sign flipped: ${flipped[lg].big.length}`);
  }
});
