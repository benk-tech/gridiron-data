// Pinnacle guest feed: trimming, matching, the refs.pinnacle block, the 15 minute pull cadence, failing open.
// Offline: the 2026-10-12 19:02Z Pinnacle capture against the 18:53Z ESPN boards (research round 3, fair-sources).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIX, RESEARCH_NOW, researchInputs } from './helpers.mjs';
import { trimPinnacle, buildPinnacle, fetchPinnacleInputs, pinnacleRef, PINNACLE_HEADERS, PIN_ALIAS, PINNACLE_MIN_INTERVAL_MS, ALT_RANGE } from '../lib/pinnacle.mjs';
import { buildSnapshot } from '../lib/build.mjs';
import { collectInputs } from '../lib/sources.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { packSnapshot } from '../lib/ingest.mjs';

const gz = (...p) => JSON.parse(gunzipSync(readFileSync(join(FIX, ...p))).toString('utf8'));
const RAW = gz('pinnacle', 'pinnacle-20261012.json.gz');
const BOARDS = gz('pinnacle', 'espn-boards-20261012.json.gz');
const NOW = BOARDS.now; // 2026-10-12T18:53:26Z
const AT = '2026-10-12T19:02:44Z';
const clone = (x) => JSON.parse(JSON.stringify(x));
const httpIso = (s) => new Date(s).toISOString().replace(/\.\d{3}Z$/, 'Z');

function pinInputs({ errors = [], drop = [] } = {}) {
  const leagues = {};
  for (const lg of ['nfl', 'cfb']) {
    leagues[lg] = drop.includes(lg) ? null : { fetchedAt: AT, lastModified: httpIso(RAW[lg].straight.lastModified), ...trimPinnacle(lg, RAW[lg].matchups.body, RAW[lg].straight.body) };
  }
  return { attemptAt: AT, cached: false, requests: 4, errors, leagues };
}
const espnInputs = () => ({ fetchedAt: NOW, errors: [], scoreboards: clone(BOARDS.scoreboards) });
const build = (extra = {}) => buildSnapshot({ espn: espnInputs(), ...extra }, { now: NOW });
const label = (g) => `${g.away.abbr}@${g.home.abbr}`;

// A fetch that serves the capture (with its Last-Modified headers) and records every request.
function fakePinnacle({ status = {}, hang = false } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, headers: init.headers });
    const m = /\/leagues\/(889|880)\/(matchups|markets\/straight)$/.exec(new URL(url).pathname);
    if (!m) return new Response('?', { status: 404 });
    const lg = m[1] === '889' ? 'nfl' : 'cfb';
    const part = m[2] === 'matchups' ? 'matchups' : 'straight';
    const st = status[`${lg}/${part}`];
    if (typeof st === 'function') return st();
    if (st) return new Response('{"error":"x"}', { status: st });
    if (hang) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(init.signal.reason), { once: true }));
    return new Response(JSON.stringify(RAW[lg][part].body), { status: 200, headers: { 'last-modified': RAW[lg][part].lastModified } });
  };
  f.calls = calls;
  return f;
}

test('trimPinnacle keeps top-level games and their open main, alternate and period lines only', () => {
  const nfl = trimPinnacle('nfl', RAW.nfl.matchups.body, RAW.nfl.straight.body);
  const cfb = trimPinnacle('cfb', RAW.cfb.matchups.body, RAW.cfb.straight.body);
  assert.equal(nfl.matchups.length, 12, '12 NFL games (props, futures and specials dropped)');
  assert.equal(cfb.matchups.length, 59);
  assert.ok(RAW.nfl.matchups.body.some((m) => m.type === 'special'), 'the fixture carries specials to drop');
  const ids = new Set(nfl.matchups.map((m) => m.id));
  assert.ok(nfl.markets.every((x) => ids.has(x.matchupId) && ['moneyline', 'spread', 'total'].includes(x.type) && [0, 1, 3].includes(x.period)));
  assert.ok(nfl.markets.every((x) => x.prices.length === 2 && x.prices.every((p) => ['home', 'away', 'over', 'under'].includes(p.d))));
  assert.ok(cfb.markets.every((x) => x.period === 0), 'CFB: full game only');
  assert.equal(nfl.matchups.find((m) => m.home === 'Los Angeles Rams' && m.away === 'Arizona Cardinals').closed, true);
  assert.equal(nfl.markets.filter((x) => x.type === 'moneyline' && x.period === 0).length, 11);
  // same input in any order -> same copy
  const shuffled = trimPinnacle('nfl', [...RAW.nfl.matchups.body].reverse(), [...RAW.nfl.straight.body].reverse());
  assert.deepEqual(shuffled, nfl);
  assert.deepEqual(trimPinnacle('nfl', null, { not: 'an array' }), { matchups: [], markets: [] });
});

test('buildSnapshot: refs.pinnacle on the research week (NFL 11 priced + 1 off the board, CFB 57 + 2), every DK game covered', () => {
  const s = build({ pinnacle: pinInputs() });
  assert.deepEqual(validateSnapshot(s), []);
  const by = (lg) => s.games.filter((g) => g.league === lg && g.state === 'pre');
  const nfl = by('nfl'), cfb = by('cfb');
  assert.equal(nfl.length, 15);
  assert.equal(cfb.length, 65);
  const refs = (list) => list.filter((g) => g.refs?.pinnacle);
  assert.equal(refs(nfl).length, 12);
  assert.equal(refs(cfb).length, 59);
  assert.deepEqual(refs(nfl).filter((g) => g.refs.pinnacle.offBoard).map(label), ['ARI@LAR']);
  assert.deepEqual(refs(cfb).filter((g) => g.refs.pinnacle.offBoard).map(label).sort(), ['ALA@TENN', 'WIS@UCLA']);
  // not on Pinnacle's board at all: the three NFL games it had not posted, and the six games without a DK line
  assert.deepEqual(nfl.filter((g) => !g.refs).map(label).sort(), ['BAL@CLE', 'BUF@LV', 'CHI@ATL']);
  assert.ok(cfb.filter((g) => !g.refs).every((g) => g.odds === null), 'every CFB game with a DK line has a Pinnacle ref');
  assert.deepEqual(s.unmatched.pinnacle, []);
  assert.deepEqual(s.sources.pinnacle, { ok: true, fetchedAt: AT, cached: false, requests: 4, matched: 71, matchedByLeague: { nfl: 12, cfb: 59 }, errors: [] });
  // no wrong game and no flipped side: Pinnacle's main lines sit next to DraftKings' on every priced game
  for (const g of s.games) {
    const p = g.refs?.pinnacle?.odds;
    if (!p || !g.odds) continue;
    if (p.spread && g.odds.spread) assert.ok(Math.abs(p.spread.home - g.odds.spread.home) <= 2, `${label(g)} spread DK ${g.odds.spread.home} vs ${p.spread.home}`);
    if (p.total && g.odds.total) assert.ok(Math.abs(p.total.line - g.odds.total.line) <= 3, `${label(g)} total`);
    if (p.ml && Math.abs(g.odds.ml?.home ?? 0) >= 150) assert.equal(p.ml.home < 0, g.odds.ml.home < 0, `${label(g)} favorite`);
  }
  // games Pinnacle names differently: found through PIN_ALIAS
  for (const abbr of ['MIA', 'MISS', 'UL', 'SHSU', 'HAW', 'M-OH', 'MTSU']) {
    assert.ok(cfb.some((g) => (g.home.abbr === abbr || g.away.abbr === abbr) && g.refs?.pinnacle), `${abbr} matched`);
  }
  assert.equal(Object.keys(PIN_ALIAS).length, 7);
});

test('refs.pinnacle shape: BUF @ LAR main lines, trimmed alternates, NFL first half and first quarter', () => {
  const s = build({ pinnacle: pinInputs() });
  const g = s.games.find((x) => label(x) === 'BUF@LAR');
  const r = g.refs.pinnacle;
  assert.deepEqual(Object.keys(r), ['fetchedAt', 'lastModified', 'offBoard', 'odds', 'alts', 'periods']);
  assert.equal(r.fetchedAt, AT);
  assert.equal(r.lastModified, '2026-10-12T18:56:24Z');
  assert.equal(r.offBoard, false);
  assert.deepEqual(r.odds, {
    ml: { home: -174, away: 156 },
    spread: { home: -3.5, homeOdds: 103, awayOdds: -114 },
    total: { line: 54.5, overOdds: -109, underOdds: -103 },
  });
  assert.ok(r.alts.length > 10);
  for (const a of r.alts) {
    assert.deepEqual(Object.keys(a), ['type', 'points', 'a', 'b']);
    const main = a.type === 'spread' ? r.odds.spread.home : r.odds.total.line;
    assert.ok(Math.abs(a.points - main) <= ALT_RANGE && a.points !== main, `${a.type} ${a.points}`);
  }
  const sorted = [...r.alts].sort((x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : 0) || x.points - y.points);
  assert.deepEqual(r.alts, sorted);
  // spread alternates: a = home (LAR) price, b = away; laying more points costs more
  const sp = r.alts.filter((a) => a.type === 'spread');
  assert.deepEqual(sp.find((a) => a.points === -10.5), { type: 'spread', points: -10.5, a: 282, b: -349 });
  assert.ok(sp.find((a) => a.points === -6).a > sp.find((a) => a.points === -4).a);
  // total alternates: a = over price; a higher total pays more on the over
  const tt = r.alts.filter((a) => a.type === 'total');
  assert.ok(tt.find((a) => a.points === 57).a > tt.find((a) => a.points === 52).a);
  assert.deepEqual(Object.keys(r.periods), ['h1', 'q1']);
  for (const p of ['h1', 'q1']) {
    assert.ok(r.periods[p].ml && r.periods[p].spread && r.periods[p].total, p);
    assert.ok(Array.isArray(r.periods[p].alts));
  }
  assert.ok(r.periods.h1.total.line < r.odds.total.line && r.periods.q1.total.line < r.periods.h1.total.line);
  // CFB never carries periods; an off-the-board game carries no prices
  assert.ok(s.games.filter((x) => x.league === 'cfb' && x.refs).every((x) => !('periods' in x.refs.pinnacle)));
  const off = s.games.find((x) => label(x) === 'ARI@LAR').refs.pinnacle;
  assert.deepEqual({ ...off, fetchedAt: null, lastModified: null }, { fetchedAt: null, lastModified: null, offBoard: true, odds: { ml: null, spread: null, total: null }, alts: [] });
});

test('a neutral-site flip (ESPN lists the teams the other way) remaps every price onto ESPN home/away', () => {
  const base = build({ pinnacle: pinInputs() }).games.find((x) => label(x) === 'BUF@LAR').refs.pinnacle;
  const espn = espnInputs();
  const ev = espn.scoreboards.nfl.flatMap((b) => b.events).find((e) => e.shortName === 'BUF @ LAR');
  for (const c of ev.competitions[0].competitors) c.homeAway = c.homeAway === 'home' ? 'away' : 'home';
  const s = buildSnapshot({ espn, pinnacle: pinInputs() }, { now: NOW });
  const g = s.games.find((x) => x.espnId === ev.id);
  assert.equal(g.home.abbr, 'BUF');
  const r = g.refs.pinnacle;
  assert.deepEqual(r.odds.ml, { home: base.odds.ml.away, away: base.odds.ml.home });
  assert.deepEqual(r.odds.spread, { home: -base.odds.spread.home, homeOdds: base.odds.spread.awayOdds, awayOdds: base.odds.spread.homeOdds });
  assert.deepEqual(r.odds.total, base.odds.total);
  const flipAlt = (a) => (a.type === 'spread' ? { type: 'spread', points: -a.points, a: a.b, b: a.a } : a);
  const want = base.alts.map(flipAlt).sort((x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : 0) || x.points - y.points);
  assert.deepEqual(r.alts, want);
  assert.deepEqual(r.periods.h1.ml, { home: base.periods.h1.ml.away, away: base.periods.h1.ml.home });
  assert.deepEqual(validateSnapshot(s), []);
});

test('fails open: a failed league, a failed pull or a builder throw leaves the rest of the snapshot exactly as without Pinnacle', () => {
  const without = build();
  const strip = (s) => {
    const c = clone(s);
    delete c.sources.pinnacle;
    delete c.unmatched.pinnacle;
    for (const g of c.games) delete g.refs;
    return c;
  };
  assert.equal(without.sources.pinnacle.ok, false);
  assert.deepEqual(without.sources.pinnacle.errors, ['not fetched']);
  assert.ok(without.games.every((g) => !('refs' in g)));
  assert.ok(!('pinnacle' in without.unmatched));

  const full = build({ pinnacle: pinInputs() });
  assert.deepEqual(strip(full), strip(without), 'Pinnacle adds refs and its own source entry only');

  const half = build({ pinnacle: pinInputs({ errors: ['cfb: guest.api.arcadia.pinnacle.com/0.1/leagues/880/matchups: HTTP 403'], drop: ['cfb'] }) });
  assert.equal(half.sources.pinnacle.ok, false);
  assert.deepEqual(half.sources.pinnacle.matchedByLeague, { nfl: 12 });
  assert.ok(half.games.filter((g) => g.league === 'cfb').every((g) => !g.refs));
  assert.equal(half.games.filter((g) => g.refs).length, 12);
  assert.deepEqual(strip(half), strip(without));

  const down = build({ pinnacle: { attemptAt: AT, cached: false, requests: 2, errors: ['nfl: x: HTTP 403', 'cfb: x: HTTP 403'], leagues: { nfl: null, cfb: null } } });
  assert.ok(down.games.every((g) => !g.refs));
  assert.equal(down.sources.pinnacle.ok, false);
  assert.equal(down.sources.pinnacle.matched, 0);
  assert.deepEqual(strip(down), strip(without));
  assert.deepEqual(validateSnapshot(down), []);

  const boom = { attemptAt: AT, cached: false, requests: 4, errors: [], leagues: { get nfl() { throw new Error('boom pinnacle'); }, cfb: null } };
  const crashed = build({ pinnacle: boom });
  assert.equal(crashed.sources.pinnacle.ok, false);
  assert.ok(crashed.sources.pinnacle.errors.includes('build failed: boom pinnacle'), crashed.sources.pinnacle.errors.join(' | '));
  assert.ok(crashed.games.every((g) => !g.refs));
  assert.deepEqual(strip(crashed), strip(without));
  assert.deepEqual(validateSnapshot(crashed), []);
});

test('deterministic: same inputs give byte-identical snapshots; size impact stays small', () => {
  const a = JSON.stringify(build({ pinnacle: pinInputs() }));
  const b = JSON.stringify(build({ pinnacle: pinInputs() }));
  assert.equal(a, b);
  const shuffled = pinInputs();
  for (const lg of ['nfl', 'cfb']) { shuffled.leagues[lg].markets.reverse(); shuffled.leagues[lg].matchups.reverse(); }
  assert.equal(JSON.stringify(build({ pinnacle: shuffled })), a, 'input order does not matter');
  const withP = packSnapshot(JSON.parse(a)), without = packSnapshot(build());
  assert.ok(withP.gzBytes - without.gzBytes < 40 * 1024, `gzip grows by ${withP.gzBytes - without.gzBytes} bytes`);
});

test('unmatched.pinnacle lists Pinnacle games in the window that matched no ESPN game; a name change is flagged', () => {
  const P = pinInputs();
  const cfb = P.leagues.cfb;
  // an FCS-style game ESPN does not list, and a game far outside the window
  cfb.matchups.push({ id: 1, startTime: '2026-10-17T18:00:00Z', home: 'Nowhere State', away: 'Elsewhere Tech', closed: false });
  cfb.matchups.push({ id: 2, startTime: '2026-12-25T18:00:00Z', home: 'Nowhere State', away: 'Elsewhere Tech', closed: false });
  const s = build({ pinnacle: P });
  assert.deepEqual(s.unmatched.pinnacle, ['cfb: Elsewhere Tech @ Nowhere State 2026-10-17']);
  // every NFL name garbled: nothing pairs, and the source says so instead of quietly matching 0
  const G = pinInputs();
  for (const m of G.leagues.nfl.matchups) { m.home = `${m.home} XX`; m.away = `QQ ${m.away}`; }
  const s2 = build({ pinnacle: G });
  assert.equal(s2.sources.pinnacle.ok, false);
  assert.match(s2.sources.pinnacle.errors.join(' '), /nfl: none of \d+ Pinnacle games matched any of 15 pregame games/);
  assert.ok(s2.games.filter((g) => g.league === 'nfl').every((g) => !g.refs));
});

test('pinnacleRef: missing or inconsistent lines are null, never guessed', () => {
  const mu = { id: 9, startTime: '2026-10-17T18:00:00Z', home: 'H', away: 'A', closed: false };
  const row = (type, alt, prices, period = 0) => ({ matchupId: 9, period, type, alt, prices: prices.map(([d, points, price]) => ({ d, points, price })) });
  const r = pinnacleRef(mu, [
    row('moneyline', false, [['away', null, 120], ['home', null, -140]]),
    row('spread', false, [['away', 2.5, -110], ['home', -3.5, -110]]),          // sides disagree: dropped
    row('total', false, [['over', 44.5, -105], ['under', 44.5, -115]]),
    row('total', true, [['over', 60.5, 300], ['under', 60.5, -400]]),          // 16 points off: trimmed
    row('total', true, [['over', 41.5, -160], ['under', 41.5, 135]]),
  ], { league: 'cfb' });
  assert.deepEqual(r.odds, { ml: { home: -140, away: 120 }, spread: null, total: { line: 44.5, overOdds: -105, underOdds: -115 } });
  assert.deepEqual(r.alts, [{ type: 'total', points: 41.5, a: -160, b: 135 }]);
  assert.equal(r.offBoard, false);
  assert.ok(!('periods' in r));
  const off = pinnacleRef({ ...mu, closed: true }, [row('moneyline', false, [['away', null, 120], ['home', null, -140]])], { league: 'nfl' });
  assert.equal(off.offBoard, true);
  assert.deepEqual(off.odds, { ml: null, spread: null, total: null });
  assert.equal(pinnacleRef(mu, [], { league: 'nfl' }).offBoard, true, 'listed without any price: off the board');
});

test('fetchPinnacleInputs: 4 requests with only the tested headers; at most one pull per 15 minutes; a failed pull is stamped too', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-pin-'));
  try {
    const t0 = Date.parse(NOW);
    const f1 = fakePinnacle();
    const a = await fetchPinnacleInputs({ fetchImpl: f1, now: t0, stateDir, retryDelayMs: 0 });
    assert.equal(a.requests, 4);
    assert.equal(a.cached, false);
    assert.deepEqual(a.errors, []);
    assert.deepEqual(f1.calls.map((c) => c.url), [
      'https://guest.api.arcadia.pinnacle.com/0.1/leagues/889/matchups',
      'https://guest.api.arcadia.pinnacle.com/0.1/leagues/889/markets/straight',
      'https://guest.api.arcadia.pinnacle.com/0.1/leagues/880/matchups',
      'https://guest.api.arcadia.pinnacle.com/0.1/leagues/880/markets/straight',
    ]);
    for (const c of f1.calls) assert.deepEqual(c.headers, { ...PINNACLE_HEADERS });
    assert.equal(a.leagues.nfl.lastModified, '2026-10-12T18:56:24Z', 'Last-Modified of the prices, as ISO');
    assert.equal(a.leagues.cfb.lastModified, '2026-10-12T19:00:45Z');
    assert.equal(a.leagues.nfl.fetchedAt, '2026-10-12T18:53:26Z');
    assert.ok(existsSync(join(stateDir, 'pinnacle.json')));

    const f2 = fakePinnacle();
    const b = await fetchPinnacleInputs({ fetchImpl: f2, now: t0 + 14 * 60e3, stateDir });
    assert.equal(f2.calls.length, 0);
    assert.equal(b.cached, true);
    assert.equal(b.requests, 0);
    assert.deepEqual(b.leagues, a.leagues, 'the same copy');
    const sA = buildSnapshot({ espn: espnInputs(), pinnacle: a }, { now: NOW }), sB = buildSnapshot({ espn: espnInputs(), pinnacle: b }, { now: NOW });
    assert.deepEqual(sB.games, sA.games, 'the reused copy gives the same refs');
    assert.equal(sB.sources.pinnacle.cached, true);

    const f3 = fakePinnacle({ status: { 'cfb/matchups': 403 } });
    const c = await fetchPinnacleInputs({ fetchImpl: f3, now: t0 + PINNACLE_MIN_INTERVAL_MS, stateDir, retryDelayMs: 0 });
    assert.equal(c.requests, 3, 'NFL pair, then the CFB matchups refused (a 403 is not retried)');
    assert.equal(c.leagues.cfb, null);
    assert.ok(c.leagues.nfl);
    assert.deepEqual(c.errors, ['cfb: guest.api.arcadia.pinnacle.com/0.1/leagues/880/matchups: HTTP 403']);
    // the failed attempt counts: no new pull for 15 minutes, and the reused copy keeps the error
    const f4 = fakePinnacle();
    const d = await fetchPinnacleInputs({ fetchImpl: f4, now: t0 + PINNACLE_MIN_INTERVAL_MS + 5 * 60e3, stateDir });
    assert.equal(f4.calls.length, 0);
    assert.deepEqual(d.errors, c.errors);
    assert.equal(d.leagues.cfb, null);
    // a clock that went backwards (a --now rebuild) pulls again rather than trusting a future stamp
    const f5 = fakePinnacle();
    await fetchPinnacleInputs({ fetchImpl: f5, now: t0 - 60e3, stateDir, retryDelayMs: 0 });
    assert.equal(f5.calls.length, 4);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('fetchPinnacleInputs: a 5xx or a network error is retried once; junk answers and no state dir', async () => {
  let n = 0;
  const flaky = fakePinnacle({ status: { 'nfl/matchups': () => (n++ === 0 ? new Response('busy', { status: 503 }) : new Response(JSON.stringify(RAW.nfl.matchups.body), { status: 200 })) } });
  const a = await fetchPinnacleInputs({ fetchImpl: flaky, now: Date.parse(NOW), retryDelayMs: 0 });
  assert.deepEqual(a.errors, []);
  assert.equal(a.requests, 5);
  assert.equal(a.leagues.nfl.lastModified, '2026-10-12T18:56:24Z');
  // without a state dir every call pulls
  const f = fakePinnacle();
  await fetchPinnacleInputs({ fetchImpl: f, now: Date.parse(NOW), retryDelayMs: 0 });
  await fetchPinnacleInputs({ fetchImpl: f, now: Date.parse(NOW) + 60e3, retryDelayMs: 0 });
  assert.equal(f.calls.length, 8);
  // an HTML block page or an object instead of the list: that league is dropped with the reason
  const junk = fakePinnacle({ status: { 'nfl/straight': () => new Response('<html>blocked</html>', { status: 200 }), 'cfb/matchups': () => new Response('{"a":1}', { status: 200 }) } });
  const j = await fetchPinnacleInputs({ fetchImpl: junk, now: Date.parse(NOW), retryDelayMs: 0 });
  assert.equal(j.requests, 3, 'a 200 with a body that is not the list is not retried');
  assert.equal(j.leagues.nfl, null);
  assert.equal(j.leagues.cfb, null);
  assert.match(j.errors[0], /^nfl: .*markets\/straight: invalid JSON/);
  assert.match(j.errors[1], /^cfb: .*matchups: expected a JSON array/);
  const down = await fetchPinnacleInputs({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, now: Date.parse(NOW), retryDelayMs: 0 });
  assert.equal(down.requests, 4, 'one try and one retry per league');
  assert.deepEqual(down.leagues, { nfl: null, cfb: null });
});

test('collectInputs: Pinnacle runs only when parts.pinnacle is true, on its own budget; a stalled host costs only Pinnacle', async () => {
  const now = Date.parse(RESEARCH_NOW);
  const base = researchInputs();
  const espnAndKalshi = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'guest.api.arcadia.pinnacle.com') return pin(url, init);
    if (u.hostname.includes('kalshi.com')) {
      const s = u.searchParams.get('series_ticker');
      if (u.pathname.endsWith('/markets')) return new Response(JSON.stringify({ cursor: '', markets: base.kalshi.markets[s] || [] }), { status: 200 });
      if (u.pathname.includes('/series/')) return new Response(JSON.stringify({ series: { fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 } }), { status: 200 });
      return new Response(JSON.stringify({ cursor: '', multivariate_contracts: [] }), { status: 200 });
    }
    if (u.pathname.endsWith('/scoreboard')) return new Response(JSON.stringify(u.searchParams.get('week') ? { events: [] } : (u.pathname.includes('/nfl/') ? base.espn.scoreboards.nfl[0] : base.espn.scoreboards.cfb[0])), { status: 200 });
    return new Response('?', { status: 404 });
  };
  const off = { props: false, teamTotals: false, injuries: false, nflverse: false, cfb: false };
  let pin = fakePinnacle();
  const without = await collectInputs({ now, fetchImpl: espnAndKalshi, pauseMs: 0, parts: off });
  assert.equal(without.pinnacle, undefined);
  assert.equal(pin.calls.length, 0);
  const withP = await collectInputs({ now, fetchImpl: espnAndKalshi, pauseMs: 0, parts: { ...off, pinnacle: true } });
  assert.equal(pin.calls.length, 4);
  assert.equal(withP.stats.bySource.pinnacle.requests, 4);
  assert.equal(withP.stats.totalRequests, 6 + 4 + 6 + 1 + 4);
  const s = buildSnapshot(withP, { now });
  assert.equal(s.sources.pinnacle.ok, true);
  assert.ok(s.sources.pinnacle.matched > 50, `matched ${s.sources.pinnacle.matched}`);
  assert.deepEqual(validateSnapshot(s), []);

  pin = fakePinnacle({ hang: true });
  const t = Date.now();
  const stalled = await collectInputs({ now, fetchImpl: espnAndKalshi, pauseMs: 0, parts: { ...off, pinnacle: true }, budgets: { pinnacle: 250 } });
  assert.ok(Date.now() - t < 5000);
  assert.deepEqual(stalled.stats.budgetsSpent, ['pinnacle']);
  assert.deepEqual(stalled.pinnacle.leagues, { nfl: null, cfb: null });
  assert.match(stalled.pinnacle.errors[0], /pinnacle time budget \(250 ms\) spent/);
  assert.equal(stalled.pinnacle.requests, 1, 'the stalled request is cut, nothing more is sent, no retry');
  const s2 = buildSnapshot(stalled, { now });
  assert.equal(s2.sources.kalshi.ok, true);
  assert.equal(s2.sources.pinnacle.ok, false);
  assert.equal(s2.games.length, 76);
});

test('schema: refs.pinnacle problems are reported', () => {
  const s = build({ pinnacle: pinInputs() });
  const g = s.games.find((x) => x.league === 'cfb' && x.refs && !x.refs.pinnacle.offBoard);
  g.refs.pinnacle.periods = { h1: { ml: null, spread: null, total: null, alts: [] } };
  g.refs.pinnacle.alts.push({ type: 'moneyline', points: 1, a: 100, b: -120 });
  g.refs.pinnacle.odds.ml = { home: -50, away: 120 };
  const off = s.games.find((x) => x.refs?.pinnacle.offBoard);
  off.refs.pinnacle.odds.total = { line: 41.5, overOdds: -110, underOdds: -110 };
  const probs = validateSnapshot(s).join(' | ');
  assert.match(probs, /periods is NFL only/);
  assert.match(probs, /alts\[\d+\] \{ type, points, a, b \}/);
  assert.match(probs, /odds\.ml \{ home, away \}/);
  assert.match(probs, /off the board but has prices/);
});
