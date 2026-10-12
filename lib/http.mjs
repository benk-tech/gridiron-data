// Small fetch helpers for the collector: timeout, optional retry, request counting.
// Node 22+ built-ins only. Requests carry fresh headers (accept only): never forward
// anything else, because Kalshi answers 403 to any foreign Origin header.

export class HttpError extends Error {
  constructor(message, { status = 0, path = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry only on network errors, timeouts, 429 and 5xx. 4xx answers are final.
export const isRetryable = (e) => !(e instanceof HttpError) || e.status === 429 || e.status >= 500 || e.status === 0;

/**
 * createHttp({ fetchImpl, timeoutMs, retries, retryDelayMs }) -> { getJson(url), stats }
 * stats.requests counts every HTTP request actually sent (including retries).
 */
export function createHttp({ fetchImpl = globalThis.fetch, timeoutMs = 25000, retries = 0, retryDelayMs = 800 } = {}) {
  const stats = { requests: 0, bytes: 0 };

  async function once(url) {
    stats.requests++;
    const u = new URL(url);
    const label = u.hostname + u.pathname;
    let res;
    try {
      res = await fetchImpl(u.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new HttpError(`${label}: ${e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'network error')}`, { status: 0, path: label });
    }
    const text = await res.text();
    stats.bytes += text.length;
    if (!res.ok) throw new HttpError(`${label}: HTTP ${res.status}`, { status: res.status, path: label });
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(`${label}: invalid JSON (${text.length} bytes)`, { status: res.status, path: label });
    }
  }

  async function getJson(url, { retries: r = retries } = {}) {
    let last;
    for (let attempt = 0; attempt <= r; attempt++) {
      try {
        return await once(url);
      } catch (e) {
        last = e;
        if (!isRetryable(e) || attempt === r) break;
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
    throw last;
  }

  return { getJson, stats };
}

/**
 * pacedFetch(fetchImpl, { match, minGapMs, retry429, backoffMs }) -> fetch-compatible function with .stats
 * Requests to hosts matching `match` start at least minGapMs apart, shared by every client that uses this
 * wrapper (Kalshi answered HTTP 429 on both hosts to about 17 /markets calls in 2 s on 2026-10-12). A 429 holds
 * all matching requests for Retry-After seconds (capped at 10 s) or backoffMs x attempt, then retries the same
 * request, up to retry429 times. Other hosts pass straight through. stats = { paced, retried429 }.
 */
export function pacedFetch(fetchImpl = globalThis.fetch, { match = /(^|\.)kalshi\.com$/, minGapMs = 250, retry429 = 2, backoffMs = 1500 } = {}) {
  const stats = { paced: 0, retried429: 0 };
  let nextAt = 0;
  const slot = async () => {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + minGapMs;
    if (wait) await sleep(wait);
  };
  const f = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    let host = '';
    try { host = new URL(url).hostname; } catch { /* let fetch report it */ }
    if (!match.test(host)) return fetchImpl(input, init);
    for (let attempt = 0; ; attempt++) {
      await slot();
      stats.paced++;
      const r = await fetchImpl(input, init);
      if (r.status !== 429 || attempt >= retry429) return r;
      try { await r.arrayBuffer(); } catch { /* drain */ }
      const ra = Number(r.headers?.get?.('retry-after'));
      const delay = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : backoffMs * (attempt + 1);
      nextAt = Math.max(nextAt, Date.now() + delay);
      stats.retried429++;
    }
  };
  f.stats = stats;
  return f;
}

// Run fn over items with at most `limit` in flight. Results keep input order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export function errorText(e) {
  return String(e?.message || e || 'unknown error').slice(0, 300);
}
