// Small fetch helpers for the collector: timeout, optional retry, request counting.
// Node 22+ built-ins only. Requests carry fresh headers (accept only): never forward
// anything else, because Kalshi answers 403 to any foreign Origin header.

export class HttpError extends Error {
  constructor(message, { status = 0, path = '', final = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
    this.final = final; // true: never retried (the run's time budget for this source is spent)
  }
}

/** The abort reason once a time budget is spent (see budgetSignal and withDeadline). */
export class BudgetError extends Error {
  constructor(message = 'time budget spent') {
    super(message);
    this.name = 'BudgetError';
    this.budget = true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry only on network errors, timeouts, 429 and 5xx. 4xx answers are final, and so is a spent time budget.
export const isRetryable = (e) => !e?.final && !e?.budget && (!(e instanceof HttpError) || e.status === 429 || e.status >= 500 || e.status === 0);

/** Short text for a failed fetch or body read: the budget message, 'timeout', or the network error. */
export const failText = (e) => (e?.budget ? (e.message || 'time budget spent') : e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'network error'));

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
      if (e?.refused) stats.requests--; // refused by a spent budget: not sent
      throw new HttpError(`${label}: ${failText(e)}`, { status: 0, path: label, final: !!e?.budget });
    }
    let text;
    try {
      text = await res.text(); // the body can stall too; the same signal cuts it off
    } catch (e) {
      throw new HttpError(`${label}: ${failText(e)} (reading the body)`, { status: 0, path: label, final: !!e?.budget });
    }
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
 * all matching requests for Retry-After seconds (capped at 5 s) or backoffMs x attempt, then retries the same
 * request, up to retry429 times. maxRetries429 caps the retries for the whole wrapper (one run): once spent, a
 * 429 is returned at once, so a Kalshi outage that answers 429 fails fast (as before pacing) instead of holding
 * the 4 minute job until it times out without posting. Other hosts pass straight through.
 * stats = { paced, retried429 }.
 */
export function pacedFetch(fetchImpl = globalThis.fetch, { match = /(^|\.)kalshi\.com$/, minGapMs = 250, retry429 = 2, backoffMs = 1500, maxRetries429 = 4 } = {}) {
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
      if (r.status !== 429 || attempt >= retry429 || stats.retried429 >= maxRetries429) return r;
      try { await r.arrayBuffer(); } catch { /* drain */ }
      const ra = Number(r.headers?.get?.('retry-after'));
      const delay = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : backoffMs * (attempt + 1);
      nextAt = Math.max(nextAt, Date.now() + delay);
      stats.retried429++;
    }
  };
  f.stats = stats;
  return f;
}

/**
 * budgetSignal(ms, label, onSpent) -> { signal, clear }: an AbortSignal that aborts with a BudgetError
 * ('<label> time budget (60 s) spent') ms from now. The timer never keeps the process alive. ms = Infinity: never.
 */
export function budgetSignal(ms, label = 'run', onSpent = null) {
  const c = new AbortController();
  let timer = null;
  if (Number.isFinite(ms) && ms >= 0) {
    const shown = ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms)} ms`;
    timer = setTimeout(() => {
      try { onSpent?.(label); } catch { /* logging only */ }
      c.abort(new BudgetError(`${label} time budget (${shown}) spent`));
    }, ms);
    timer.unref?.();
  }
  return { signal: c.signal, clear: () => { if (timer) clearTimeout(timer); } };
}

/**
 * withDeadline(fetchImpl, signal) -> fetch-compatible function. Each request also stops when `signal` aborts (a time
 * budget), combined with the request's own timeout signal; once it has aborted, new requests fail at once with its
 * reason and send nothing. createHttp treats that error as final (no retry). Keeps fetchImpl.stats (pacedFetch).
 * Wrap it OUTSIDE pacedFetch so a request refused by the budget never waits for a pacing slot.
 */
export function withDeadline(fetchImpl = globalThis.fetch, signal = null) {
  if (!signal) return fetchImpl;
  const f = (input, init = {}) => {
    if (signal.aborted) {
      const e = new BudgetError(signal.reason?.message);
      e.refused = true; // nothing was sent
      return Promise.reject(e);
    }
    return fetchImpl(input, { ...(init || {}), signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
  };
  if (fetchImpl.stats) f.stats = fetchImpl.stats;
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
