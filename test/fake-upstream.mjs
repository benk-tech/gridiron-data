// Preload for the CLI test (node --import): serves the saved research capture in place of Kalshi and ESPN,
// and passes every other request (the local fake site) to the real fetch.
// FAKE_UPSTREAM: 'ok' (default) | 'kalshi-down' | 'espn-down' | 'all-down'
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'research-20261011');
const rd = (f) => readFileSync(join(DIR, f), 'utf8');
const mode = process.env.FAKE_UPSTREAM || 'ok';
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname.endsWith('kalshi.com')) {
    if (mode === 'kalshi-down' || mode === 'all-down') return json('{"error":"down"}', 503);
    if (url.pathname.endsWith('/markets')) {
      const s = url.searchParams.get('series_ticker');
      if (s) return json(rd(`kalshi_${s}.json`));
      const want = new Set((url.searchParams.get('tickers') || '').split(','));
      return json(JSON.stringify({ cursor: '', markets: [...want].map((t) => ({ ticker: t, status: 'finalized', result: 'no', settlement_ts: '2026-10-12T00:00:00Z', settlement_value_dollars: '0.0000' })) }));
    }
    const m = /\/series\/([A-Z]+)$/.exec(url.pathname);
    if (m) return json(JSON.stringify({ series: JSON.parse(rd('series.json'))[m[1]] }));
    if (url.pathname.endsWith('/multivariate_event_collections')) return json(JSON.stringify({ cursor: '', multivariate_contracts: JSON.parse(rd('collections.json')) }));
    return json('{}', 404);
  }
  if (url.hostname === 'site.api.espn.com') {
    if (mode === 'espn-down' || mode === 'all-down') return json('{}', 500);
    if (url.pathname.endsWith('/summary')) return json('{"injuries":[]}');
    if (url.searchParams.get('week')) return json('{"events":[]}');
    return json(rd(url.pathname.includes('/nfl/') ? 'espn_nfl_w6.json' : 'espn_cfb_w7.json'));
  }
  return realFetch(input, init);
};
