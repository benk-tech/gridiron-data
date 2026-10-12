// Preload for the CLI test (node --import): serves the saved research capture in place of Kalshi and ESPN.
// Only the local fake site (127.0.0.1 / localhost) reaches the real fetch; every other host gets a canned answer
// or a 404, so the test suite never touches the network (GitHub, ESPN core, sportsdataverse included).
// FAKE_UPSTREAM: 'ok' (default) | 'kalshi-down' | 'espn-down' | 'all-down'
//   | 'espn-empty' (ESPN answers 200 with an empty events list on every scoreboard, as during an ESPN incident)
// FAKE_PINNACLE: unset (default: the Pinnacle host answers 404 like any unknown host) | 'ok' (the 2026-10-12 capture,
//   with its Last-Modified headers) | 'block' (HTTP 403, as a block of the runner's IP would look)
// Kalshi /markets/trades serves the saved trades of the tickers in test/fixtures/clv (an empty list for any other).
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'research-20261011');
const rd = (f) => readFileSync(join(DIR, f), 'utf8');
const INJURIES = readFileSync(join(DIR, '..', 'angles', 'espn-injuries-raw-BAL-LAC.json'), 'utf8');
const mode = process.env.FAKE_UPSTREAM || 'ok';
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const SERIES = JSON.parse(rd('series.json'));
const gz = (...p) => JSON.parse(gunzipSync(readFileSync(join(DIR, '..', ...p))).toString('utf8'));
const pinMode = process.env.FAKE_PINNACLE || '';
const PIN = pinMode === 'ok' ? gz('pinnacle', 'pinnacle-20261012.json.gz') : null;
const PIN_LEAGUE = { 889: 'nfl', 880: 'cfb' };

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.hostname === 'guest.api.arcadia.pinnacle.com' && pinMode) {
    if (pinMode === 'block') return json('{"error":"forbidden"}', 403);
    const m = /\/leagues\/(\d+)\/(matchups|markets\/straight)$/.exec(url.pathname);
    const part = m && PIN[PIN_LEAGUE[m[1]]]?.[m[2] === 'matchups' ? 'matchups' : 'straight'];
    if (part) return new Response(JSON.stringify(part.body), { status: 200, headers: { 'content-type': 'application/json', 'last-modified': part.lastModified } });
    return json('[]', 404);
  }
  if (url.hostname.endsWith('kalshi.com')) {
    if (mode === 'kalshi-down' || mode === 'all-down') return json('{"error":"down"}', 503);
    if (url.pathname.endsWith('/markets/trades')) {
      const t = url.searchParams.get('ticker') || '';
      const f = join(DIR, '..', 'clv', `trades-${t}.json.gz`);
      return json(JSON.stringify({ cursor: '', trades: existsSync(f) ? gz('clv', `trades-${t}.json.gz`).trades : [] }));
    }
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
    if (url.pathname.endsWith('/injuries')) return json(INJURIES);
    if (url.pathname.endsWith('/depthcharts')) return json('{"depthchart":[]}');
    if (url.searchParams.get('week')) return json('{"events":[]}');
    if (mode === 'espn-empty' && url.pathname.endsWith('/scoreboard')) {
      const b = JSON.parse(rd(url.pathname.includes('/nfl/') ? 'espn_nfl_w6.json' : 'espn_cfb_w7.json'));
      return json(JSON.stringify({ ...b, events: [] }));
    }
    return json(rd(url.pathname.includes('/nfl/') ? 'espn_nfl_w6.json' : 'espn_cfb_w7.json'));
  }
  // ESPN core (propBets: not posted), ESPN site.web (CFB byteam), GitHub (nflverse, sportsdataverse): unavailable.
  return json('{}', 404);
};
