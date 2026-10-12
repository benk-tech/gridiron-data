// Preload for the CLI test (node --import): serves the saved research capture in place of Kalshi and ESPN.
// Only the local fake site (127.0.0.1 / localhost) reaches the real fetch; every other host gets a canned answer
// or a 404, so the test suite never touches the network (GitHub, ESPN core, sportsdataverse included).
// FAKE_UPSTREAM: 'ok' (default) | 'kalshi-down' | 'espn-down' | 'all-down'
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'research-20261011');
const rd = (f) => readFileSync(join(DIR, f), 'utf8');
const mode = process.env.FAKE_UPSTREAM || 'ok';
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const SERIES = JSON.parse(rd('series.json'));

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.hostname.endsWith('kalshi.com')) {
    if (mode === 'kalshi-down' || mode === 'all-down') return json('{"error":"down"}', 503);
    if (url.pathname.endsWith('/markets')) {
      const s = url.searchParams.get('series_ticker');
      if (s) return existsSync(join(DIR, `kalshi_${s}.json`)) ? json(rd(`kalshi_${s}.json`)) : json('{"cursor":"","markets":[]}');
      const want = new Set((url.searchParams.get('tickers') || '').split(','));
      return json(JSON.stringify({ cursor: '', markets: [...want].map((t) => ({ ticker: t, status: 'finalized', result: 'no', settlement_ts: '2026-10-12T00:00:00Z', settlement_value_dollars: '0.0000' })) }));
    }
    const m = /\/series\/([A-Z]+)$/.exec(url.pathname);
    if (m) return json(JSON.stringify({ series: SERIES[m[1]] || { ticker: m[1], fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 } }));
    if (url.pathname.endsWith('/multivariate_event_collections')) return json(JSON.stringify({ cursor: '', multivariate_contracts: JSON.parse(rd('collections.json')) }));
    return json('{}', 404);
  }
  if (url.hostname === 'site.api.espn.com') {
    if (mode === 'espn-down' || mode === 'all-down') return json('{}', 500);
    if (url.pathname.endsWith('/summary')) return json('{"injuries":[]}');
    if (url.pathname.endsWith('/injuries')) return json('{"timestamp":"2026-10-11T22:00:00Z","injuries":[]}');
    if (url.pathname.endsWith('/depthcharts')) return json('{"depthchart":[]}');
    if (url.searchParams.get('week')) return json('{"events":[]}');
    return json(rd(url.pathname.includes('/nfl/') ? 'espn_nfl_w6.json' : 'espn_cfb_w7.json'));
  }
  // ESPN core (propBets: not posted), ESPN site.web (CFB byteam), GitHub (nflverse, sportsdataverse): unavailable.
  return json('{}', 404);
};
