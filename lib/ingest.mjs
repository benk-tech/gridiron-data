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
export async function signedFetch({ baseUrl, key, method = 'GET', path, body = null, contentType, fetchImpl = globalThis.fetch, nowMs = Date.now(), timeoutMs = 30000 }) {
  const url = siteUrl(baseUrl, path);
  const bytes = toBytes(body);
  const headers = {
    ...signedHeaders({ key, method, path: url.pathname, body: bytes, nowMs }),
    accept: 'application/json',
    // Cheap insurance in case the Worker applies its state-changing Origin check to collector routes too.
    origin: url.origin,
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
    throw new Error(`${method} ${url.pathname}: ${e?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json };
}

/** POST /api/ingest with the gzipped snapshot (Content-Type application/octet-stream, no Content-Encoding). */
export async function postSnapshot(snapshot, { url, key, fetchImpl, nowMs } = {}) {
  const pack = packSnapshot(snapshot);
  const r = await signedFetch({ baseUrl: url, key, method: 'POST', path: PATHS.ingest, body: pack.gz, contentType: 'application/octet-stream', fetchImpl, nowMs });
  return { ...r, rawBytes: pack.rawBytes, gzBytes: pack.gzBytes, sha: pack.sha };
}

export async function getPending({ url, key, fetchImpl, nowMs } = {}) {
  const r = await signedFetch({ baseUrl: url, key, method: 'GET', path: PATHS.pending, fetchImpl, nowMs });
  if (!r.ok) throw new Error(`pending: HTTP ${r.status}`);
  const tickers = Array.isArray(r.json?.tickers) ? r.json.tickers.filter((t) => typeof t === 'string') : [];
  return tickers.slice(0, 200);
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
 */
export async function settleHandshake({ url, key, kalshi, fetchImpl, log = () => {} }) {
  const tickers = await getPending({ url, key, fetchImpl });
  if (!tickers.length) return { pending: 0, found: 0, settled: 0 };
  const markets = await fetchMarketsByTickers(kalshi, tickers);
  const results = markets.map(settleRow).filter(Boolean);
  if (results.length) await postSettle(results, { url, key, fetchImpl });
  log(`settle: ${tickers.length} pending, ${markets.length} found on Kalshi, ${results.length} settled`);
  return { pending: tickers.length, found: markets.length, settled: results.length };
}
