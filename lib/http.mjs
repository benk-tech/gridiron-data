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
