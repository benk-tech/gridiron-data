// Collector -> site protocol (SPEC section 4): gzip + sha256 + HMAC-SHA256 signature, POST, pending/settle handshake.
//
// Signature for every collector request:
//   ts   = unix seconds (string)
//   hash = hex(sha256(bodyBytes))      body = the exact bytes sent; empty for GET
//   sig  = hex(hmacSha256(INGEST_KEY, `${method}\n${path}\n${ts}\n${hash}`))
//   headers: X-GP-Timestamp: ts, X-GP-Signature: sig
// HMAC key bytes = the UTF-8 bytes of the INGEST_KEY string exactly as stored (the base64url text is NOT decoded).
// In a Worker that is: crypto.subtle.importKey('raw', new TextEncoder().encode(env.INGEST_KEY), { name: 'HMAC', hash: 'SHA-256' }, ...).
// path = URL pathname only (no query string), e.g. '/api/ingest'.
//
// Never log the ingest URL or key: this repo and its Actions logs are public.

import { gzipSync } from 'node:zlib';
import { createHash, createHmac } from 'node:crypto';
import { fetchMarketsByTickers, settleRow } from './kalshi.mjs';
import { CLOSE, normalizePending, attachCloses, readCloseStore, writeCloseStore, pruneCloseStore } from './clv.mjs';

export const PATHS = {
  ingest: '/api/ingest',
  pending: '/api/collector/pending',
  settle: '/api/collector/settle',
};

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function signature(key, method, path, ts, bodyHash) {
  if (!key) throw new Error('INGEST_KEY is empty');
  return createHmac('sha256', Buffer.from(String(key), 'utf8')).update(`${method}\n${path}\n${ts}\n${bodyHash}`, 'utf8').digest('hex');
}

/** Headers for one signed request. body: Buffer | Uint8Array | string | null. */
export function signedHeaders({ key, method, path, body = null, nowMs = Date.now() }) {
  const bytes = toBytes(body);
  const ts = String(Math.floor(nowMs / 1000));
  return {
    'X-GP-Timestamp': ts,
    'X-GP-Signature': signature(key, method.toUpperCase(), path, ts, sha256Hex(bytes)),
  };
}

function toBytes(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(String(body), 'utf8');
}

/** Snapshot -> { json, gz, rawBytes, gzBytes, sha } (sha = hex sha256 of the gzip bytes, the exact POST body). */
export function packSnapshot(snapshot) {
  const json = JSON.stringify(snapshot);
  const raw = Buffer.from(json, 'utf8');
  const gz = gzipSync(raw, { level: 9 });
  return { json, gz, rawBytes: raw.length, gzBytes: gz.length, sha: sha256Hex(gz) };
}

function siteUrl(base, path) {
  let u;
  try { u = new URL(path, base); } catch { throw new Error('INGEST_URL is not a valid URL'); }
  if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) throw new Error('INGEST_URL must be https (or localhost)');
  return u;
}

/**
 * One signed request to the site. Returns { ok, status, json }. Errors never include the URL.
 */
export async function signedFetch({ baseUrl, key, method = 'GET', path, body = null, contentType, extraHeaders = null, fetchImpl = globalThis.fetch, nowMs = Date.now(), timeoutMs = 30000 }) {
  const url = siteUrl(baseUrl, path);
  const bytes = toBytes(body);
  const headers = {
    ...signedHeaders({ key, method, path: url.pathname, body: bytes, nowMs }),
    accept: 'application/json',
    // Cheap insurance in case the Worker applies its state-changing Origin check to collector routes too.
    origin: url.origin,
    ...(extraHeaders || {}),
  };
  if (method !== 'GET' && method !== 'HEAD') headers['content-type'] = contentType || 'application/octet-stream';
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : bytes,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // never e.message: it can carry the URL
    throw new Error(`${method} ${url.pathname}: ${e?.budget ? 'time budget spent' : e?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json };
}

/**
 * POST /api/ingest with the gzipped snapshot (Content-Type application/octet-stream, no Content-Encoding).
 * X-GP-Generated tells the Worker the build time (it never parses the body); it is not signed, so the Worker only
 * accepts it within 15 min before to 1 min after the signed timestamp and otherwise records the post time.
 */
export async function postSnapshot(snapshot, { url, key, fetchImpl, nowMs } = {}) {
  const pack = packSnapshot(snapshot);
  const extraHeaders = typeof snapshot?.generatedAt === 'string' ? { 'X-GP-Generated': snapshot.generatedAt } : null;
  const r = await signedFetch({ baseUrl: url, key, method: 'POST', path: PATHS.ingest, body: pack.gz, contentType: 'application/octet-stream', extraHeaders, fetchImpl, nowMs });
  return { ...r, rawBytes: pack.rawBytes, gzBytes: pack.gzBytes, sha: pack.sha };
}

/**
 * GET /api/collector/pending -> [{ ticker, kickoff: ISO | null }] (at most 200).
 * The site answers { tickers: [ticker], items: [{ ticker, kickoff }] } (migration 0003: the same tickers in the same
 * order, `tickers` kept for older collectors). `items` is read when it is a list, since only it carries the kickoff
 * the close lookup needs; an older site that sends `tickers` alone still settles, without closes. Either list may
 * hold plain ticker strings or { ticker, kickoff } objects (lib/clv.mjs normalizePending).
 */
export async function getPendingItems({ url, key, fetchImpl, nowMs } = {}) {
  const r = await signedFetch({ baseUrl: url, key, method: 'GET', path: PATHS.pending, fetchImpl, nowMs });
  if (!r.ok) throw new Error(`pending: HTTP ${r.status}`);
  const list = Array.isArray(r.json?.items) ? r.json.items : Array.isArray(r.json?.tickers) ? r.json.tickers : [];
  return normalizePending(list);
}

/** GET /api/collector/pending -> [ticker] (at most 200). */
export async function getPending(opts = {}) {
  return (await getPendingItems(opts)).map((i) => i.ticker);
}

export async function postSettle(results, { url, key, fetchImpl, nowMs } = {}) {
  const body = Buffer.from(JSON.stringify({ results }), 'utf8');
  const r = await signedFetch({ baseUrl: url, key, method: 'POST', path: PATHS.settle, body, contentType: 'application/json', fetchImpl, nowMs });
  if (!r.ok) throw new Error(`settle: HTTP ${r.status}`);
  return r.json;
}

/**
 * Pending/settle handshake: GET pending tickers, look them up on Kalshi (/markets?tickers=A,B,C, chunks of 100),
 * POST the ones that have a yes/no result. Unsettled markets are left for a later run.
 * When the site lists { ticker, kickoff } (not just strings), tickers whose kickoff has passed also get their Kalshi
 * kickoff close (lib/clv.mjs): at most maxCloses trade lookups per run, posted as closeYes with the result; a result
 * whose close is still missing is held back for a later run. stateDir keeps the closes between runs
 * (state/clv-closes.json). now: the run's clock (ms) for "kickoff has passed".
 * Returns { pending, found, settled } plus closes: { due, lookups, ... } when any listed kickoff has passed.
 */
export async function settleHandshake({ url, key, kalshi, fetchImpl, log = () => {}, now = Date.now(), stateDir = null, maxCloses = CLOSE.lookupsPerRun }) {
  const items = await getPendingItems({ url, key, fetchImpl });
  if (!items.length) return { pending: 0, found: 0, settled: 0 };
  const tickers = items.map((i) => i.ticker);
  const markets = await fetchMarketsByTickers(kalshi, tickers);
  const rows = markets.map(settleRow).filter(Boolean);
  const wantClose = items.some((i) => i.kickoff && Date.parse(i.kickoff) <= now);
  if (!wantClose) {
    if (rows.length) await postSettle(rows, { url, key, fetchImpl });
    log(`settle: ${tickers.length} pending, ${markets.length} found on Kalshi, ${rows.length} settled`);
    return { pending: tickers.length, found: markets.length, settled: rows.length };
  }
  const store = await readCloseStore(stateDir);
  let c;
  try {
    c = await attachCloses({ items, rows, kalshi, store, now, persistent: !!stateDir, maxLookups: maxCloses, log });
    if (c.results.length) {
      await postSettle(c.results, { url, key, fetchImpl });
      for (const r of c.results) delete store.closes[r.ticker]; // settled at the site: never listed again
    }
  } finally {
    // closes already looked up are kept even when the POST failed, so the next run does not fetch them again
    try { await writeCloseStore(stateDir, pruneCloseStore(store, now)); } catch (e) { log(`closes not saved: ${String(e?.message || e).slice(0, 120)}`); }
  }
  const s = c.stats;
  log(`settle: ${tickers.length} pending, ${markets.length} found on Kalshi, ${c.results.length} settled (${s.sentWithClose} with a close, ${s.sentWithoutClose} without), ${s.held} held for their close; closes: ${s.due} due, ${s.lookups} looked up (${s.computed} computed, ${s.noTrades} no trades, ${s.failed} failed)`);
  return { pending: tickers.length, found: markets.length, settled: c.results.length, closes: s };
}
