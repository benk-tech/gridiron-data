// Polymarket US since 2026-10-15: the league lists (GET /v2/leagues/{nfl,cfb}/events) carry only each event's
// winner market; the full game spreads and totals come only with the event detail (GET /v1/events/slug/{slug}), in
// the same market shape the old list used. Offline: a collector run of 2026-10-16 07:05Z with --polyus-details 16
// (scripts/make-polyus-fixtures.mjs): the 4 list pages, 16 event details (8 NFL, 8 college), and that run's ESPN
// boards and Kalshi books. The format before (the lines inside the list) is polyus-20261012.json.gz, read in
// test/venues.test.mjs.
// To be polite to the gateway the fetcher now pulls at most every 15 minutes (state/polyus.json), asks for details
// only for games kicking off within 48 hours, nearest first, and at most 40 per pull; the last tests cover that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { FIX } from './helpers.mjs';
import { parsePolyUS, fetchPolyUSInputs, planDetails, detailKickoff, POLYUS_BASE, POLYUS_MAX_DETAILS, POLYUS_DETAIL_AHEAD_MS, POLYUS_MIN_INTERVAL_MS } from '../lib/venues/polyus.mjs';
import { buildVenue, venueFormatErrors } from '../lib/venues/index.mjs';
import { Q, flipQ, reorient } from '../lib/venues/common.mjs';
import { buildSnapshot } from '../lib/build.mjs';
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
const DAY = 86400e3, HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// The run asked for 16 details (8 NFL, 8 college), up to 9 days out, when the planner still took the leagues in
// turns. So that the detail format tests below read exactly those 16 with today's planner, they use REACH (that 9 day
// reach) and the RECORDED lists: every game whose detail the fixture lacks is listed without spreads or totals
// (marketCounts 0), so it wants no detail. The cap, window and cadence tests at the end use the lists as served.
const REACH = 9 * DAY;
const RECORDED_SLUGS = new Set(NEW.details.map((d) => d.slug));
const recordedList = (lg) => NEW.list[lg].map((e) => (RECORDED_SLUGS.has(e.slug) ? e : { ...e, marketCounts: { ...e.marketCounts, numSpreadsAndTotalsMarkets: 0 } }));
// The 16 details in the order today's planner asks for them: nearest kickoff first, a tie by league (NFL first)
// then slug, so the college games of Friday and Saturday come before the NFL games of Sunday.
const PLANNED = [
  'cfb-clmb-penn-2026-10-16', 'cfb-mphs-tulane-2026-10-16', 'cfb-applst-coast-2026-10-16', 'cfb-wash-pur-2026-10-16',
  'cfb-ballst-bowlgr-2026-10-17', 'cfb-chsou-clmsn-2026-10-17', 'cfb-cin-wvir-2026-10-17', 'cfb-fl-tx-2026-10-17',
  'nfl-hou-jax-2026-10-18', 'nfl-bal-cle-2026-10-18', 'nfl-car-phi-2026-10-18', 'nfl-chi-atl-2026-10-18',
  'nfl-no-nyg-2026-10-18', 'nfl-nyj-ne-2026-10-18', 'nfl-pit-tb-2026-10-18', 'nfl-ten-ind-2026-10-18',
];
// The games of the lists as served that want a detail at a clock, nearest first: open, lines counted, kicking off
// after the clock and within 48 hours of it (worked out here from the raw lists, not with the fetcher's code).
const servedWanted = (clockMs) => ['nfl', 'cfb'].flatMap((lg) => NEW.list[lg]
  .filter((e) => !e.closed && !e.archived && e.marketCounts.numSpreadsAndTotalsMarkets > 0)
  .map((e) => ({ league: lg, slug: e.slug, t: Date.parse(e.startTime) }))
  .filter((x) => x.t > clockMs && x.t <= clockMs + 48 * HOUR))
  .sort((a, b) => a.t - b.t || (a.league === b.league ? 0 : a.league === 'nfl' ? -1 : 1) || (a.slug < b.slug ? -1 : 1));

// The gateway of that run: the list pages (RECORDED unless served: true), the 16 details by slug (any other detail
// 404), status overrides by slug.
function gateway({ details = NEW.details, status = {}, delay = null, calls = [], served = false } = {}) {
  const bySlug = new Map(details.map((d) => [d.slug, d]));
  const lists = { nfl: served ? NEW.list.nfl : recordedList('nfl'), cfb: served ? NEW.list.cfb : recordedList('cfb') };
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const lg = /^\/v2\/leagues\/(nfl|cfb)\/events$/.exec(u.pathname)?.[1];
    if (lg) {
      const off = Number(u.searchParams.get('offset'));
      return new Response(JSON.stringify({ events: lists[lg].slice(off, off + 100) }), { status: 200 });
    }
    const slug = /^\/v1\/events\/slug\/(.+)$/.exec(u.pathname)?.[1];
    if (delay) await new Promise((r) => setTimeout(r, delay(slug)));
    if (status[slug]) return new Response('{"code":7,"message":"x"}', { status: status[slug] });
    if (slug && bySlug.has(slug)) return new Response(JSON.stringify({ event: bySlug.get(slug) }), { status: 200 });
    return new Response('{"code":5,"message":"not found"}', { status: 404 });
  };
}
const via = (g = {}, opts = {}) => fetchPolyUSInputs({ fetchImpl: gateway(g), now: Date.parse(NOW), retryDelayMs: 0, aheadMs: REACH, ...opts });

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

test('fetchPolyUSInputs on the new format: 4 list GETs, then one detail per game with lines, nearest kickoff first', async () => {
  const calls = [];
  const r = await via({ calls });
  assert.equal(r.requests, 20);
  assert.deepEqual(calls.slice(0, 4), listUrls);
  assert.deepEqual(calls.slice(4), PLANNED.map((s) => `${POLYUS_BASE}/v1/events/slug/${s}`));
  assert.deepEqual([r.fetchedAt, r.cached, r.errors, r.seen], ['2026-10-16T07:05:26Z', false, [], { nfl: 28, cfb: 218 }]);
  assert.deepEqual(r.details, { nfl: { wanted: 8, pulled: 8, read: 8 }, cfb: { wanted: 8, pulled: 8, read: 8 } });
  assert.deepEqual([kinds(r.leagues.nfl), kinds(r.leagues.cfb)], [{ ml: 27, sp: 324, tot: 229 }, { ml: 172, sp: 287, tot: 181 }]);
  assert.deepEqual(venueFormatErrors('polyus', r), []);
  // a game with a detail: the detail's quotes (its winner too, read seconds after the list); the others: the list's winner
  const withLines = [...r.leagues.nfl, ...r.leagues.cfb].filter((g) => Object.keys(g.quotes).length > 1).map((g) => g.id).sort();
  assert.deepEqual(withLines, [...PLANNED].sort());
  const cp = r.leagues.nfl.find((g) => g.id === 'nfl-car-phi-2026-10-18');
  assert.deepEqual(cp.quotes, parsePolyUS([NEW.details.find((d) => d.slug === cp.id)])[0].quotes);
  assert.deepEqual(r.leagues.nfl.map((g) => g.id), parsePolyUS(NEW.list.nfl).map((g) => g.id), 'the list order is kept');

  // the games that want a detail: open, lines counted, kicking off after now and within the reach
  const now = Date.parse(NOW);
  assert.equal(detailKickoff(OLD.nfl[0], Date.parse(OLD.fetchedAt)), null, 'an old list event carries its lines: no detail');
  assert.equal(detailKickoff({ ...NEW.list.nfl[0], closed: true }, now, REACH), null);
  assert.equal(detailKickoff(NEW.list.nfl[0], Date.parse(NEW.list.nfl[0].startTime), REACH), null, 'started: no detail');
  assert.equal(detailKickoff(NEW.list.nfl.find((e) => !(e.marketCounts.numSpreadsAndTotalsMarkets > 0)), now, REACH), null, 'no lines counted: no detail');
  // the merge does not depend on which answer came first: answers arriving in reverse order (concurrency 4)
  const slow = await via({ delay: (s) => 40 - 2 * PLANNED.indexOf(s) }, { concurrency: 4 });
  assert.deepEqual(slow.leagues, r.leagues);
});

test('fetchPolyUSInputs: a failed detail keeps the winner; a 403 stops the rest; a cap of 0 reads winner quotes only', async () => {
  // a 404 (an event gone between the list and the detail): that game keeps its winner quote, the rest are read
  const a = await via({ status: { 'nfl-car-phi-2026-10-18': 404 } });
  assert.deepEqual(a.errors, ['nfl nfl-car-phi-2026-10-18: gateway.polymarket.us/v1/events/slug/nfl-car-phi-2026-10-18: HTTP 404']);
  assert.deepEqual(Object.keys(a.leagues.nfl.find((g) => g.id === 'nfl-car-phi-2026-10-18').quotes), ['ml:home']);
  assert.deepEqual(a.details.nfl, { wanted: 8, pulled: 7, read: 7 });
  // a 5xx is retried once
  let n = 0;
  const flaky = gateway();
  const b = await fetchPolyUSInputs({ fetchImpl: async (url) => (url.includes('nfl-hou-jax') && !n++ ? new Response('{}', { status: 502 }) : flaky(url)), now: Date.parse(NOW), retryDelayMs: 0, aheadMs: REACH });
  assert.deepEqual([b.requests, b.errors, b.details.nfl.pulled], [21, [], 8]);
  // a 403 (a block) on the first detail: no further detail GET; one error says so
  const calls = [];
  const c = await via({ calls, status: { 'cfb-clmb-penn-2026-10-16': 403 } }, { concurrency: 1 });
  assert.deepEqual([c.requests, calls.length], [5, 5]);
  assert.deepEqual(c.errors, ['details stopped after cfb cfb-clmb-penn-2026-10-16: gateway.polymarket.us/v1/events/slug/cfb-clmb-penn-2026-10-16: HTTP 403']);
  assert.deepEqual([kinds(c.leagues.nfl).sp, kinds(c.leagues.cfb).sp], [0, 0]);
  // a detail that is not an event, or whose winner market is gone: an error, the winner from the list stays
  const d = await via({ details: NEW.details.map((x) => (x.slug === 'nfl-bal-cle-2026-10-18' ? { ...x, markets: x.markets.filter((m) => m.sportsMarketType !== WINNER) } : x)) });
  assert.deepEqual(d.errors, ['nfl nfl-bal-cle-2026-10-18: event detail could not be read (format change?)']);
  assert.deepEqual(Object.keys(d.leagues.nfl.find((g) => g.id === 'nfl-bal-cle-2026-10-18').quotes), ['ml:home']);
  const e = await fetchPolyUSInputs({ fetchImpl: async (url) => (url.includes('/v1/') ? new Response('{"events":[]}', { status: 200 }) : gateway()(url)), now: Date.parse(NOW), retryDelayMs: 0, aheadMs: REACH, maxDetails: 2 });
  assert.deepEqual(e.errors, ['cfb cfb-clmb-penn-2026-10-16: expected an event with markets (format change?)', 'cfb cfb-mphs-tulane-2026-10-16: expected an event with markets (format change?)']);
  // --polyus-details 0: the list only (4 GETs), winner quotes only; no game's lines were read, so the spread and
  // total check has nothing to look at
  const z = await via({}, { maxDetails: 0 });
  assert.deepEqual([z.requests, z.errors, z.details], [4, [], { nfl: { wanted: 8, pulled: 0, read: 0 }, cfb: { wanted: 8, pulled: 0, read: 0 } }]);
  assert.deepEqual([kinds(z.leagues.nfl).sp, kinds(z.leagues.cfb).tot], [0, 0]);
  assert.deepEqual(venueFormatErrors('polyus', z), []);
  assert.deepEqual(venueFormatErrors('polyus', { ...z, details: undefined }).length, 4, 'without the read counts (an older saved pull): checked on every game, as before');
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

// ---------------------------------------------------------------- polite: the cap, the 48 hour window, the cadence

test('cap: at most 40 details per pull by default (--polyus-details overrides), nearest kickoff first across both leagues', async () => {
  const now = Date.parse(NOW);
  const logs = [];
  const calls = [];
  // the lists as served and the defaults: 56 college games want a detail (no NFL game kicks off within 48 hours of
  // Friday 07:05Z), the 40 nearest are asked for; the 32 the fixture lacks answer 404 and keep their winner quote
  const r = await fetchPolyUSInputs({ fetchImpl: gateway({ calls, served: true }), now, retryDelayMs: 0, log: (s) => logs.push(s) });
  const want = servedWanted(now);
  assert.deepEqual([POLYUS_MAX_DETAILS, want.length], [40, 56]);
  assert.equal(r.requests, 44);
  assert.equal(new Set(calls).size, 44, 'one GET each');
  assert.deepEqual(calls.slice(4), want.slice(0, 40).map((x) => `${POLYUS_BASE}/v1/events/slug/${x.slug}`), 'the 40 nearest, in kickoff order');
  assert.ok(want[39].t <= want[40].t, 'none left out kicks off before one asked for');
  assert.deepEqual(r.details, { nfl: { wanted: 0, pulled: 0, read: 0 }, cfb: { wanted: 56, pulled: 8, read: 8 } });
  assert.equal(r.errors.length, 32);
  assert.match(r.errors[0], /^cfb cfb-[a-z0-9-]+: gateway\.polymarket\.us\/v1\/events\/slug\/cfb-[a-z0-9-]+: HTTP 404$/);
  assert.deepEqual(r.errors, [...r.errors].sort(), 'sorted');
  assert.match(logs.join('\n'), /^polyus: 44 requests \(4 list, 40 event details for 56 games, 16 over the cap of 40\), [\d.]+ MB; /m);
  // the cap is the maxDetails option (the CLI's --polyus-details): 2 asks for the 2 nearest, 0 for none
  const two = [];
  const r2 = await fetchPolyUSInputs({ fetchImpl: gateway({ calls: two, served: true }), now, retryDelayMs: 0, maxDetails: 2 });
  assert.deepEqual([r2.requests, two.slice(4)], [6, want.slice(0, 2).map((x) => `${POLYUS_BASE}/v1/events/slug/${x.slug}`)]);
  const r0 = await fetchPolyUSInputs({ fetchImpl: gateway({ served: true }), now, retryDelayMs: 0, maxDetails: 0 });
  assert.deepEqual([r0.requests, r0.details], [4, { nfl: { wanted: 0, pulled: 0, read: 0 }, cfb: { wanted: 56, pulled: 0, read: 0 } }]);
  // planDetails: one queue, nearest kickoff first, a tie by league order then id, up to the cap; no league takes turns
  const w = (league, id, kickoff) => ({ league, id, kickoff });
  const wanted = { nfl: [w('nfl', 'b', 3), w('nfl', 'a', 3), w('nfl', 'c', 1)], cfb: [w('cfb', 'x', 2), w('cfb', 'y', 1), w('cfb', 'z', 5), w('cfb', 'q', 9)] };
  assert.deepEqual(planDetails(wanted, ['nfl', 'cfb'], 6).map((d) => d.id), ['c', 'y', 'x', 'a', 'b', 'z']);
  assert.deepEqual(planDetails(wanted, ['cfb', 'nfl'], 2).map((d) => d.id), ['y', 'c'], 'a tie goes by league order');
  assert.deepEqual(planDetails(wanted, ['nfl', 'cfb'], 0), []);
  assert.deepEqual(planDetails({ nfl: [w('nfl', 'm', 10), w('nfl', 'n', 11)], cfb: [w('cfb', 'u', 1), w('cfb', 'v', 2), w('cfb', 'x', 3)] }, ['nfl', 'cfb'], 3).map((d) => d.id), ['u', 'v', 'x'], 'nearer games of one league fill the cap');
  assert.deepEqual(planDetails({ cfb: wanted.cfb }, ['nfl', 'cfb']).map((d) => d.id), ['y', 'x', 'z', 'q'], 'a league without games');
  assert.equal(planDetails({ cfb: Array.from({ length: 50 }, (_, i) => w('cfb', `g${String(i).padStart(2, '0')}`, i)) }).length, 40, 'the default cap');
});

test('48 hour window: details only for games kicking off within 48 hours of the pull; later games keep the list winner quote', async () => {
  assert.equal(POLYUS_DETAIL_AHEAD_MS, 48 * HOUR);
  const now = Date.parse(NOW);
  // the edges, on one college game with lines: after the pull and at most 48 hours later
  const e = NEW.list.cfb.find((x) => x.marketCounts.numSpreadsAndTotalsMarkets > 0);
  const at = (ms) => ({ ...e, startTime: iso(ms) });
  assert.equal(detailKickoff(at(now + 48 * HOUR), now), now + 48 * HOUR, 'exactly 48 hours out: wanted');
  assert.equal(detailKickoff(at(now + 48 * HOUR + 1000), now), null, 'a second later: not');
  assert.equal(detailKickoff(at(now + 60e3), now), now + 60e3);
  assert.equal(detailKickoff(at(now), now), null, 'kicking off now: not');
  // the lists as served at Friday 07:05Z: the Sunday NFL games are 54 hours or more away, so only college games are
  // asked for, and the NFL games keep the winner quote from the list
  const r = await fetchPolyUSInputs({ fetchImpl: gateway({ served: true }), now, retryDelayMs: 0, maxDetails: 100 });
  assert.deepEqual(r.details, { nfl: { wanted: 0, pulled: 0, read: 0 }, cfb: { wanted: 56, pulled: 8, read: 8 } });
  assert.equal(r.requests, 4 + 56, 'with a cap of 100, every game within 48 hours and none further out');
  assert.ok(r.leagues.nfl.every((g) => Object.keys(g.quotes).every((k) => k === 'ml:home')), 'NFL: winner quotes only');
  const firstNfl = Math.min(...NEW.list.nfl.map((x) => Date.parse(x.startTime)).filter((t) => t > now));
  assert.equal((firstNfl - now) / HOUR > 48, true);
  const kicks = (lg) => NEW.list[lg].filter((x) => detailKickoff(x, now) != null).map((x) => Date.parse(x.startTime));
  assert.ok(kicks('cfb').every((t) => t > now && t <= now + 48 * HOUR));
  assert.equal(NEW.list.cfb.filter((x) => x.marketCounts.numSpreadsAndTotalsMarkets > 0 && Date.parse(x.startTime) > now + 48 * HOUR).length, 12, 'next week\'s 12 college games with lines wait');
  // Saturday 14:00Z, the same lists: the Sunday and Monday NFL games are now inside 48 hours, but the 40 nearest are
  // still Saturday's college games, so the NFL games wait until enough of those have kicked off
  const sat = Date.parse('2026-10-17T14:00:00Z');
  const wantSat = (lg) => NEW.list[lg].filter((x) => detailKickoff(x, sat) != null).map((x) => ({ league: lg, id: x.slug, kickoff: Date.parse(x.startTime) }));
  const plan = planDetails({ nfl: wantSat('nfl'), cfb: wantSat('cfb') });
  assert.deepEqual([wantSat('nfl').length, wantSat('cfb').length, plan.length, plan.filter((d) => d.league === 'nfl').length], [12, 52, 40, 0]);
  assert.deepEqual(plan.map((d) => d.id), servedWanted(sat).slice(0, 40).map((x) => x.slug));
});

test('cadence: at most one pull per 15 minutes from the state dir; runs in between reuse it with the pull\'s fetchedAt; a failed pull is reused too', async () => {
  assert.equal(POLYUS_MIN_INTERVAL_MS, 15 * 60e3);
  const tmp = mkdtempSync(join(tmpdir(), 'gd-pu-'));
  try {
    const calls = [];
    const logs = [];
    let blocked = false;
    const gw = gateway({ calls });
    const fetchImpl = async (url) => (blocked ? (calls.push(url), new Response('{"code":7,"message":"x"}', { status: 403 })) : gw(url));
    const t0 = Date.parse(NOW);
    const run = (min) => fetchPolyUSInputs({ fetchImpl, now: t0 + min * 60e3, stateDir: tmp, retryDelayMs: 0, aheadMs: REACH, log: (s) => logs.push(s) });
    const a = await run(0);
    assert.deepEqual([a.cached, a.requests, a.attemptAt, a.fetchedAt, calls.length, a.errors], [false, 20, NOW, NOW, 20, []]);
    assert.ok(existsSync(join(tmp, 'polyus.json')), 'state/polyus.json keeps the pull');
    // 5, 10 and 14 minutes later (and a second short of 15): no request, the same games and quotes, fetchedAt unchanged
    for (const min of [5, 10, 14, 15 - 1 / 60]) {
      const b = await run(min);
      assert.equal(calls.length, 20, `no request ${min} minutes after the pull`);
      assert.deepEqual([b.cached, b.requests, b.attemptAt, b.fetchedAt], [true, 0, NOW, NOW]);
      assert.deepEqual([b.leagues, b.seen, b.details, b.errors], [a.leagues, a.seen, a.details, a.errors]);
    }
    assert.ok(logs.includes('polyus: reusing the pull from 2026-10-16T07:05:26Z (next pull after 2026-10-16T07:20:26Z)'), logs.join('\n'));
    // the reused copy builds the same snapshot games as the pull (only sources.polyus.cached and requests differ)
    const espn = () => ({ fetchedAt: iso(t0 + 14 * 60e3), errors: [], scoreboards: clone(NEW.espn.scoreboards) });
    const sa = buildSnapshot({ espn: espn(), venues: { polyus: a } }, { now: iso(t0 + 14 * 60e3) });
    const sb = buildSnapshot({ espn: espn(), venues: { polyus: await run(14) } }, { now: iso(t0 + 14 * 60e3) });
    assert.deepEqual(sb.games, sa.games);
    assert.ok(sb.games.some((g) => g.refs?.venues?.polyus?.fetchedAt === NOW), 'refs carry the time of the pull');
    assert.deepEqual([sb.sources.polyus.cached, sb.sources.polyus.requests, sb.sources.polyus.fetchedAt], [true, 0, NOW]);
    // 15 minutes after the pull: pulled again, fetchedAt is this run's clock
    const c = await run(15);
    assert.deepEqual([c.cached, c.requests, c.fetchedAt, calls.length], [false, 20, '2026-10-16T07:20:26Z', 40]);
    // a blocked gateway at 30 minutes: one pull (2 list GETs, a 403 is not retried), then reused until 45
    blocked = true;
    const d = await run(30);
    assert.deepEqual([d.cached, d.requests, d.leagues, calls.length], [false, 2, { nfl: null, cfb: null }, 42]);
    assert.match(d.errors[0], /HTTP 403/);
    blocked = false;
    const e = await run(40);
    assert.deepEqual([e.cached, e.requests, e.leagues, e.fetchedAt, calls.length], [true, 0, { nfl: null, cfb: null }, '2026-10-16T07:35:26Z', 42]);
    const f = await run(45);
    assert.deepEqual([f.cached, f.requests, calls.length], [false, 20, 62]);
    assert.deepEqual(f.leagues, a.leagues);
    // without a state dir every call pulls (the old behaviour, for tests and one off runs)
    const n = calls.length;
    await fetchPolyUSInputs({ fetchImpl, now: t0, retryDelayMs: 0, aheadMs: REACH });
    await fetchPolyUSInputs({ fetchImpl, now: t0 + 60e3, retryDelayMs: 0, aheadMs: REACH });
    assert.equal(calls.length, n + 40);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('format check with the 48 hour window: a league with no game that soon is no format change; renamed lines and a missing count still are', async () => {
  const now = Date.parse(NOW);
  const served = (opts = {}, g = {}) => fetchPolyUSInputs({ fetchImpl: gateway({ served: true, ...g }), now: opts.now ?? now, retryDelayMs: 0, ...opts });
  // Friday 07:05Z: no NFL game within 48 hours, so the 28 NFL games carry winner quotes only; that is not an error
  // (the old check said "nfl: 28 polyus games but no spread quotes (format change?)" here)
  const r = await served();
  assert.deepEqual([kinds(r.leagues.nfl).sp, kinds(r.leagues.nfl).tot, kinds(r.leagues.cfb).sp > 0], [0, 0, true]);
  assert.deepEqual(venueFormatErrors('polyus', r), []);
  const s = buildSnapshot({ espn: { fetchedAt: NOW, errors: [], scoreboards: clone(NEW.espn.scoreboards) }, venues: { polyus: { ...r, errors: [] } } }, { now: NOW });
  assert.deepEqual([s.sources.polyus.ok, s.sources.polyus.errors], [true, []], 'the 404s of the details the fixture lacks left out');
  // Saturday 14:00Z: Sunday's NFL games are within 48 hours but Saturday's college games fill the cap; still no error
  const sat = await served({ now: Date.parse('2026-10-17T14:00:00Z') });
  assert.deepEqual([sat.details.nfl.wanted, sat.details.nfl.pulled], [12, 0]);
  assert.deepEqual(venueFormatErrors('polyus', sat), []);
  // the spread type renamed in the details: the league whose details were read reports it
  const renamed = NEW.details.map((d) => ({ ...d, markets: d.markets.map((m) => (m.sportsMarketType === SPREAD ? { ...m, sportsMarketType: 'football_team_full_game_handicap' } : m)) }));
  const x = await served({}, { details: renamed });
  assert.deepEqual(venueFormatErrors('polyus', x), ['cfb: 218 polyus games but no spread quotes (format change?)']);
  // the lines count gone from the list: no detail could ever be asked for, so the fetcher says so
  // (listsOnly: the list pages from these lists, every detail 404)
  const listsOnly = (lists) => async (url) => {
    const u = new URL(url), [, v, leagues, lg] = u.pathname.split('/'), off = Number(u.searchParams.get('offset'));
    return v === 'v2' && leagues === 'leagues' && lists[lg] ? new Response(JSON.stringify({ events: lists[lg].slice(off, off + 100) }), { status: 200 }) : new Response('{}', { status: 404 });
  };
  const noCount = { nfl: NEW.list.nfl.map(({ marketCounts, ...e }) => e), cfb: NEW.list.cfb.map(({ marketCounts, ...e }) => e) };
  const y = await fetchPolyUSInputs({ fetchImpl: listsOnly(noCount), now, retryDelayMs: 0 });
  assert.deepEqual([y.requests, y.details.nfl.wanted, y.details.cfb.wanted], [4, 0, 0]);
  assert.deepEqual(y.errors, [
    `nfl: ${y.leagues.nfl.length} polyus games but none has a spreads and totals count, so no detail is asked for (format change?)`,
    `cfb: ${y.leagues.cfb.length} polyus games but none has a spreads and totals count, so no detail is asked for (format change?)`,
  ]);
  // the old list format (lines inside the list) has no count and needs none
  const old = await fetchPolyUSInputs({ fetchImpl: listsOnly({ nfl: OLD.nfl, cfb: OLD.cfb }), now: Date.parse(OLD.fetchedAt), retryDelayMs: 0 });
  assert.deepEqual([old.requests, old.errors, old.details.nfl.wanted, old.details.nfl.read > 5], [4, [], 0, true]);
});
