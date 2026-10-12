import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FIX, rd, CORE, RESEARCH_NOW } from './helpers.mjs';
import { collectInputs } from '../lib/sources.mjs';
import { pacedFetch } from '../lib/http.mjs';
import { buildSnapshot } from '../lib/build.mjs';
import { validateSnapshot } from '../lib/schema.mjs';

const F = 'research-20261011';
const A = join(FIX, 'angles');
const NV = {
  'play_by_play_2026.csv.gz': 'pbp_2026_trim.csv.gz',
  'stats_player_week_2026.csv.gz': 'stats_player_week_2026_trim.csv.gz',
  'roster_weekly_2026.csv.gz': 'roster_weekly_2026_trim.csv.gz',
  'advstats_week_def_2026.csv.gz': 'advstats_week_def_2026.csv.gz',
};
const OFF = { pauseMs: 0, parts: { props: false, teamTotals: false, injuries: false, nflverse: false, cfb: false } };

// Serves the research capture (Kalshi core, ESPN boards) and the Phase B fixtures as if they were the live APIs.
// Any URL it does not know is a test failure (calls.unknown), so nothing can reach the network.
function fakeApis({ failSeries = [], leagueDown = false } = {}) {
  const calls = [];
  calls.unknown = [];
  const series = rd(F, 'series.json');
  const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(method === 'HEAD' ? `HEAD ${url}` : url);
    const u = new URL(url);
    if (u.hostname.includes('kalshi.com')) {
      if (u.pathname.endsWith('/markets')) {
        const s = u.searchParams.get('series_ticker');
        if (failSeries.includes(s)) return new Response('down', { status: 503 });
        return ok({ cursor: '', markets: CORE.includes(s) ? rd(F, `kalshi_${s}.json`).markets : [] });
      }
      const m = /\/series\/([A-Z]+)$/.exec(u.pathname);
      if (m) return ok({ series: series[m[1]] || { ticker: m[1], fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 } });
      if (u.pathname.endsWith('/multivariate_event_collections')) return ok({ cursor: '', multivariate_contracts: rd(F, 'collections.json') });
    }
    if (u.hostname === 'site.api.espn.com') {
      if (u.pathname.endsWith('/summary')) return ok({ injuries: [] });
      if (u.pathname.endsWith('/nfl/injuries')) return leagueDown ? new Response('{}', { status: 500 }) : ok(JSON.parse(readFileSync(join(A, 'espn-injuries-raw-BAL-LAC.json'), 'utf8')));
      const dc = /\/nfl\/teams\/(\d+)\/depthcharts$/.exec(u.pathname);
      if (dc) return ok(dc[1] === '33' ? JSON.parse(readFileSync(join(A, 'espn-depth-raw-BAL.json'), 'utf8')) : { depthchart: [] });
      if (u.pathname.endsWith('/scoreboard')) {
        if (u.searchParams.get('week')) return ok({ events: [] });
        return ok(rd(F, u.pathname.includes('/nfl/') ? 'espn_nfl_w6.json' : 'espn_cfb_w7.json'));
      }
    }
    if (u.hostname === 'sports.core.api.espn.com' && /\/propBets$/.test(u.pathname)) return new Response('{}', { status: 404 });
    if (u.hostname === 'site.web.api.espn.com' && u.pathname.endsWith('/statistics/byteam')) return ok(JSON.parse(gunzipSync(readFileSync(join(A, 'cfb', 'cfb_byteam_trim.json.gz'))).toString('utf8')));
    if (u.hostname === 'github.com') {
      const name = u.pathname.split('/').pop();
      if (u.pathname.includes('/nflverse/') && NV[name]) {
        const headers = { etag: `"${name}-v1"`, 'last-modified': 'Sun, 11 Oct 2026 21:00:00 GMT' };
        if (method === 'HEAD') return new Response(null, { status: 200, headers });
        return new Response(readFileSync(join(A, 'nflverse', NV[name])), { status: 200, headers });
      }
      if (name === 'cfb_defense_vs_position_2026.csv') return new Response(gunzipSync(readFileSync(join(A, 'cfb', 'cfb_defense_vs_position_2026.csv.gz'))), { status: 200 });
    }
    calls.unknown.push(`${method} ${url}`);
    return new Response('?', { status: 404 });
  };
  f.calls = calls;
  return f;
}

const reqs = (inputs) => Object.fromEntries(Object.entries(inputs.stats.bySource).map(([k, v]) => [k, v.requests]));

test('collectInputs: core only, request budget, valid snapshot', async () => {
  const f = fakeApis();
  const now = Date.parse(RESEARCH_NOW);
  const inputs = await collectInputs({ now, fetchImpl: f, ...OFF });
  assert.deepEqual(f.calls.unknown, []);
  assert.deepEqual(Object.keys(inputs.kalshi.markets).sort(), [...CORE].sort());
  assert.equal(inputs.kalshi.requests, 6 + 6 + 1, '6 market series + 6 series fee lookups + 1 collections');
  assert.deepEqual(reqs(inputs), { kalshi: 6, espn: 4, fees: 6, combos: 1 });
  assert.deepEqual(inputs.kalshi.errors, []);
  assert.deepEqual(inputs.espn.errors, []);
  for (const k of ['props', 'teamTotals', 'injuryFeed', 'injuries', 'nflverse', 'cfb']) assert.equal(inputs[k], undefined, k);
  const marketsCall = f.calls.find((u) => u.includes('series_ticker=KXNFLGAME'));
  assert.match(marketsCall, /^https:\/\/api\.elections\.kalshi\.com\/trade-api\/v2\/markets\?/);
  assert.match(marketsCall, /max_close_ts=\d{10}/);
  const s = buildSnapshot(inputs, { now });
  assert.deepEqual(validateSnapshot(s), []);
  assert.equal(s.games.length, 76);
  assert.equal(s.sources.kalshi.requests, 13);
  assert.ok(s.collector.timings.kalshi.ms >= 0 && s.collector.requests === 17);
});

test('collectInputs: every source, cold then warm cache; budgets per source and no churn in the daily cache', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'gd-cache-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-state-'));
  try {
    const now = Date.parse(RESEARCH_NOW);
    const f1 = fakeApis();
    const cold = await collectInputs({ now, fetchImpl: f1, cacheDir, stateDir, pauseMs: 0 });
    assert.deepEqual(f1.calls.unknown, []);
    const r1 = reqs(cold);
    assert.deepEqual({ ...r1, cfb: undefined }, {
      kalshi: 6, espn: 4,
      teamTotals: 2,           // KXNFLTEAMTOTAL + KXNCAAFTEAMTOTAL
      props: 15,               // 15 prop series; no ladders, so no ESPN propBets
      fees: 6 + 15 + 2,        // fee lookups for every series in the run
      combos: 1,
      injuries: 1 + 32 + 2,    // league feed, 32 depth charts, current and previous NFL week
      nflverse: 4 + 4,         // HEAD and GET per asset
      cfb: undefined,
    });
    assert.ok(r1.cfb >= 5, `cfb ${r1.cfb}: sportsdataverse csv, byteam, 3 boards (+ summaries)`);
    assert.equal(cold.injuries, undefined, 'league feed worked: no summary fallback');
    assert.ok(cold.injuryFeed.league.items.length > 0);
    assert.deepEqual(cold.nflverse.errors, []);
    assert.deepEqual(cold.cfb.errors, []);

    const s = buildSnapshot(cold, { now });
    assert.deepEqual(validateSnapshot(s), []);
    assert.equal(Object.keys(s.defense.nfl).length, 32);
    assert.ok(Object.keys(s.defense.cfb).length >= 100);
    assert.equal(s.sources.nflverse.ok, true, s.sources.nflverse.errors.join(' | '));
    assert.equal(s.sources.injuries.ok, true, s.sources.injuries.errors.join(' | '));
    assert.equal(s.sources.fees.ok, true);
    assert.ok(s.fees.KXNFLRSHYDS && s.fees.KXNCAAFTEAMTOTAL);
    assert.equal(s.collector.requests, Object.values(r1).reduce((a, b) => a + b, 0));

    // 10 minutes later: fees, depth charts, nflverse (checked < 30 min ago), CFB all come from the caches.
    const files = (d) => readdirSync(d, { recursive: true }).map(String).sort();
    const cacheBefore = files(cacheDir).map((p) => [p, existsSync(join(cacheDir, p)) && !p.endsWith('nflverse') ? readFileSync(join(cacheDir, p)).length : 0]);
    const f2 = fakeApis();
    const warm = await collectInputs({ now: now + 10 * 60e3, fetchImpl: f2, cacheDir, stateDir, pauseMs: 0 });
    assert.deepEqual(reqs(warm), { kalshi: 6, espn: 4, teamTotals: 2, props: 15, fees: 0, combos: 1, injuries: 1, nflverse: 0, cfb: 0 });
    assert.equal(warm.injuryFeed.depthCached, true);
    assert.ok(warm.cfb.defense.cached && warm.cfb.qb.cached);

    // 40 minutes later: nflverse sends HEADs only (same ETags), and the stamps go to the state dir, not the cache.
    const meta = readFileSync(join(cacheDir, 'nflverse', 'meta.json'), 'utf8');
    const f3 = fakeApis();
    const later = await collectInputs({ now: now + 40 * 60e3, fetchImpl: f3, cacheDir, stateDir, pauseMs: 0 });
    assert.equal(reqs(later).nflverse, 4);
    assert.equal(f3.calls.filter((u) => u.startsWith('HEAD ')).length, 4);
    assert.equal(readFileSync(join(cacheDir, 'nflverse', 'meta.json'), 'utf8'), meta, 'meta.json unchanged on an ETag-only check');
    assert.ok(existsSync(join(stateDir, 'nflverse-checks.json')));
    assert.deepEqual(files(cacheDir).map((p) => [p, existsSync(join(cacheDir, p)) && !p.endsWith('nflverse') ? readFileSync(join(cacheDir, p)).length : 0]), cacheBefore, 'daily cache files unchanged');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('collectInputs: league injuries feed down -> game summaries are fetched as the fallback', async () => {
  const now = Date.parse(RESEARCH_NOW);
  const f = fakeApis({ leagueDown: true });
  const inputs = await collectInputs({ now, fetchImpl: f, pauseMs: 0, parts: { props: false, teamTotals: false, nflverse: false, cfb: false } });
  assert.equal(inputs.injuryFeed.league, null);
  assert.equal(Object.keys(inputs.injuries.summaries).length, 14, 'one summary per NFL game in the window');
  assert.equal(reqs(inputs).summaries, 14);
  const s = buildSnapshot(inputs, { now });
  assert.deepEqual(validateSnapshot(s), []);
  assert.equal(s.sources.injuries.ok, false);
  assert.match(s.sources.injuries.errors.join(' '), /league injuries/);
});

test('pacedFetch: Kalshi requests start minGapMs apart, a 429 is retried after Retry-After, other hosts pass through', async () => {
  const seen = [];
  let first429 = true;
  const raw = async (url) => {
    seen.push([url, Date.now()]);
    if (url.includes('kalshi') && url.includes('A') && first429) { first429 = false; return new Response('slow down', { status: 429, headers: { 'retry-after': '0.05' } }); }
    return new Response('{}', { status: 200 });
  };
  const f = pacedFetch(raw, { minGapMs: 60, backoffMs: 10 });
  const t0 = Date.now();
  const rs = await Promise.all([
    f('https://api.elections.kalshi.com/trade-api/v2/markets?s=A'),
    f('https://api.elections.kalshi.com/trade-api/v2/markets?s=B'),
    f('https://site.api.espn.com/x'),
    f('https://external-api.kalshi.com/trade-api/v2/markets?s=C'),
  ]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200]);
  assert.deepEqual(f.stats, { paced: 4, retried429: 1 });
  const k = seen.filter(([u]) => u.includes('kalshi')).map(([, t]) => t);
  for (let i = 1; i < k.length; i++) assert.ok(k[i] - k[i - 1] >= 40, `gap ${k[i] - k[i - 1]} ms (timer granularity allows about 15 ms of slack)`);
  assert.ok(k[k.length - 1] - k[0] >= 3 * 60 - 20, 'four Kalshi starts span at least three gaps');
  assert.ok(seen.find(([u]) => u.includes('espn'))[1] - t0 < 30, 'ESPN is not held behind Kalshi');
  // a persistent 429 is returned after retry429 extra attempts
  const always = pacedFetch(async () => new Response('', { status: 429 }), { minGapMs: 0, backoffMs: 0, retry429: 2, maxRetries429: 3 });
  assert.equal((await always('https://api.elections.kalshi.com/x')).status, 429);
  assert.equal(always.stats.paced, 3);
  // the run's retry budget (3) is nearly spent: one more retry, then every 429 comes back at once (fail fast)
  assert.equal((await always('https://api.elections.kalshi.com/y')).status, 429);
  assert.deepEqual(always.stats, { paced: 5, retried429: 3 });
  assert.equal((await always('https://api.elections.kalshi.com/z')).status, 429);
  assert.deepEqual(always.stats, { paced: 6, retried429: 3 });
});

test('collectInputs: Kalshi answering 429 everywhere fails fast and ESPN data still comes through', async () => {
  const f = fakeApis();
  const down = async (url, init) => (url.includes('kalshi.com') ? new Response('{"error":"too many requests"}', { status: 429 }) : f(url, init));
  const t = Date.now();
  // With the live gap (250 ms, 1.5 s x attempt backoff) the 4-retry cap bounds the extra wait to about 9 s per run;
  // here the gap is 0 so the test is instant and checks the cap itself.
  const inputs = await collectInputs({ now: Date.parse(RESEARCH_NOW), fetchImpl: down, pauseMs: 0, parts: { injuries: false, nflverse: false, cfb: false } });
  const ms = Date.now() - t;
  assert.equal(inputs.stats.kalshiRetried429, 4, 'the per-run retry budget');
  assert.ok(ms < 5e3, `took ${ms} ms`);
  assert.deepEqual(inputs.kalshi.markets, {});
  const s = buildSnapshot(inputs, { now: Date.parse(RESEARCH_NOW) });
  assert.equal(s.games.length, 76, 'ESPN games still listed');
  assert.equal(s.sources.kalshi.ok, false);
  assert.deepEqual(validateSnapshot(s), []);
});

test('collectInputs: a Kalshi 429 on a prop series is retried, counted, and the series kept', async () => {
  const f = fakeApis();
  let hits = 0;
  const flaky = async (url, init) => {
    if (url.includes('series_ticker=KXNFLTD&') && hits++ === 0) return new Response('{"error":"too many requests"}', { status: 429 });
    return f(url, init);
  };
  const inputs = await collectInputs({ now: Date.parse(RESEARCH_NOW), fetchImpl: flaky, pauseMs: 0, parts: { injuries: false, nflverse: false, cfb: false } });
  assert.deepEqual(inputs.props.errors, []);
  assert.ok(Array.isArray(inputs.props.kalshi.KXNFLTD));
  assert.equal(inputs.stats.bySource.kalshi429.requests, 1);
  assert.equal(inputs.stats.kalshiRetried429, 1);
});

test('collectInputs: one series down on both hosts is recorded, the rest is kept', async () => {
  const now = Date.parse(RESEARCH_NOW);
  const inputs = await collectInputs({ now, fetchImpl: fakeApis({ failSeries: ['KXNCAAFTOTAL'] }), ...OFF });
  assert.equal(inputs.kalshi.markets.KXNCAAFTOTAL, undefined);
  assert.match(inputs.kalshi.errors[0], /^KXNCAAFTOTAL: .*HTTP 503/);
  const s = buildSnapshot(inputs, { now });
  assert.equal(s.sources.kalshi.ok, false);
  assert.equal(s.games.length, 76);
  assert.deepEqual(validateSnapshot(s), []);
});
