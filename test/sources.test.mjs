import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rd, CORE, RESEARCH_NOW } from './helpers.mjs';
import { collectInputs } from '../lib/sources.mjs';
import { buildSnapshot } from '../lib/build.mjs';
import { validateSnapshot } from '../lib/schema.mjs';

const F = 'research-20261011';

// Serves the research capture as if it were the live APIs.
function fakeApis({ failSeries = [] } = {}) {
  const calls = [];
  const series = rd(F, 'series.json');
  const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
  const f = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname.includes('kalshi.com')) {
      if (u.pathname.endsWith('/markets')) {
        const s = u.searchParams.get('series_ticker');
        if (failSeries.includes(s)) return new Response('down', { status: 503 });
        return ok({ cursor: '', markets: rd(F, `kalshi_${s}.json`).markets });
      }
      const m = /\/series\/([A-Z]+)$/.exec(u.pathname);
      if (m) return ok({ series: series[m[1]] });
      if (u.pathname.endsWith('/multivariate_event_collections')) return ok({ cursor: '', multivariate_contracts: rd(F, 'collections.json') });
    }
    if (u.hostname === 'site.api.espn.com') {
      if (u.pathname.endsWith('/summary')) return ok({ injuries: [] });
      const nfl = u.pathname.includes('/nfl/');
      if (u.searchParams.get('week')) return ok({ events: [] });
      return ok(rd(F, nfl ? 'espn_nfl_w6.json' : 'espn_cfb_w7.json'));
    }
    return new Response('?', { status: 404 });
  };
  f.calls = calls;
  return f;
}

test('collectInputs: one full run, request budget, valid snapshot', async () => {
  const f = fakeApis();
  const now = Date.parse(RESEARCH_NOW);
  const inputs = await collectInputs({ now, fetchImpl: f });
  assert.deepEqual(Object.keys(inputs.kalshi.markets).sort(), [...CORE].sort());
  assert.equal(inputs.kalshi.requests, 6 + 6 + 1, '6 market series + 6 series fee lookups + 1 collections');
  assert.equal(inputs.stats.espnRequests, 4 + 14, '2 scoreboards per league + 14 NFL summaries');
  assert.deepEqual(inputs.kalshi.errors, []);
  assert.deepEqual(inputs.espn.errors, []);
  assert.equal(Object.keys(inputs.injuries.summaries).length, 14);
  const marketsCall = f.calls.find((u) => u.includes('series_ticker=KXNFLGAME'));
  assert.match(marketsCall, /^https:\/\/api\.elections\.kalshi\.com\/trade-api\/v2\/markets\?/);
  assert.match(marketsCall, /max_close_ts=\d{10}/);
  const s = buildSnapshot(inputs, { now });
  assert.deepEqual(validateSnapshot(s), []);
  assert.equal(s.games.length, 76);
  assert.equal(s.sources.injuries.ok, true);
  assert.deepEqual(s.sources.injuries.leagues, ['nfl']);
  assert.equal(s.sources.kalshi.requests, 13);
});

test('collectInputs: daily fee cache skips /series on the second run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-cache-'));
  try {
    const now = Date.parse(RESEARCH_NOW);
    await collectInputs({ now, fetchImpl: fakeApis(), cacheDir: dir, injuryLeagues: [] });
    assert.deepEqual(readdirSync(dir), ['kalshi-series-2026-10-11.json']);
    const f2 = fakeApis();
    const inputs = await collectInputs({ now, fetchImpl: f2, cacheDir: dir, injuryLeagues: [] });
    assert.equal(f2.calls.filter((u) => u.includes('/series/')).length, 0);
    assert.equal(inputs.kalshi.requests, 7);
    assert.equal(inputs.series.data.KXNFLGAME.fee_type, 'quadratic_with_maker_fees');
    assert.equal(inputs.injuries, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectInputs: one series down on both hosts is recorded, the rest is kept', async () => {
  const now = Date.parse(RESEARCH_NOW);
  const inputs = await collectInputs({ now, fetchImpl: fakeApis({ failSeries: ['KXNCAAFTOTAL'] }), injuryLeagues: [] });
  assert.equal(inputs.kalshi.markets.KXNCAAFTOTAL, undefined);
  assert.match(inputs.kalshi.errors[0], /^KXNCAAFTOTAL: .*HTTP 503/);
  const s = buildSnapshot(inputs, { now });
  assert.equal(s.sources.kalshi.ok, false);
  assert.equal(s.games.length, 76);
  assert.deepEqual(validateSnapshot(s), []);
});
