// Kalshi kickoff close for closing-line value (CLV), sent with the settle results (SPEC section 4 handshake).
//
// The site's GET /api/collector/pending may list { ticker, kickoff } objects (as well as plain ticker strings). For
// every listed ticker whose kickoff has passed, the collector looks up
//   GET /trade-api/v2/markets/trades?ticker=T&max_ts=<kickoff unix seconds>&limit=200
// (paced with the run's other Kalshi requests) and computes the close: the count-weighted VWAP of yes_price over those
// last 200 pregame trades, in dollars. POST /api/collector/settle then carries it as `closeYes` next to `result`.
//
// The site stops listing a ticker once it has a result, so a result is never posted before its close is known:
//   - closes are looked up (and kept in state/clv-closes.json) as soon as a ticker is listed, usually while the game
//     is still on, so the close is ready when Kalshi settles the market;
//   - at most CLOSE.lookupsPerRun lookups per run, settled tickers first; a settled ticker whose close is still
//     missing is held back (not posted) and comes back on a later run;
//   - a ticker with no pregame trades is posted with closeYes: null, and so is one whose lookups failed
//     CLOSE.maxAttempts times (any error: network, 4xx, 429, 5xx, on both hosts), or one held for CLOSE.holdMs since
//     the collector first saw it listed (since kickoff when there is no state dir), so a broken trades endpoint can
//     delay a settlement but never block it. Holding from first sight, not from kickoff, keeps a backlog after a
//     collector outage (up to 200 settled tickers, 40 lookups per run) waiting for its closes instead of dropping them.
// Plain ticker strings (no kickoff) settle exactly as before, without closeYes.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errorText } from './http.mjs';
import { num, TICKER_RE } from './kalshi.mjs';

export const CLOSE = Object.freeze({
  lookupsPerRun: 40,          // GET /markets/trades per run; the rest wait for later runs
  trades: 200,                // the close is the VWAP of the last this many pregame trades
  maxAttempts: 3,             // failed lookups (any error) before the result is posted without a close
  holdMs: 12 * 3600e3,        // a settled result waits for its close at most this long after it was first listed
  keepMs: 21 * 86400e3,       // store entries are dropped this long after kickoff
  pendingMax: 200,            // SPEC 4: the site lists at most 200 tickers
});
const STORE_FILE = 'clv-closes.json';
const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const round4 = (x) => Math.round(x * 1e4) / 1e4;

function kickoffIso(k) {
  if (k == null || k === '') return null;
  let ms;
  if (typeof k === 'number') ms = k < 1e12 ? k * 1000 : k; // unix seconds or ms
  else ms = Date.parse(String(k));
  return Number.isFinite(ms) ? isoS(ms) : null;
}

/** Pending list from the site (strings and/or { ticker, kickoff }) -> [{ ticker, kickoff: ISO | null }], deduped. */
export function normalizePending(list) {
  const out = [];
  const seen = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    const ticker = typeof x === 'string' ? x : typeof x?.ticker === 'string' ? x.ticker : null;
    if (!ticker || !TICKER_RE.test(ticker)) continue;
    const kickoff = typeof x === 'string' ? null : kickoffIso(x.kickoff);
    const i = seen.get(ticker);
    if (i != null) { if (!out[i].kickoff && kickoff) out[i].kickoff = kickoff; continue; }
    seen.set(ticker, out.length);
    out.push({ ticker, kickoff });
  }
  return out.slice(0, CLOSE.pendingMax);
}

/**
 * Trades (GET /markets/trades, newest first) -> { closeYes, trades, contracts } | null.
 * closeYes = sum(count x yes_price) / sum(count) over the newest `limit` trades at or before maxTs (unix seconds),
 * rounded to $0.0001. Block trades (negotiated off the book) are left out. null when no usable trade is left.
 * Reads yes_price_dollars / count_fp (strings, the current API) and falls back to yes_price (cents) / count.
 */
export function closeVwap(trades, { maxTs = null, limit = CLOSE.trades } = {}) {
  const rows = [];
  (Array.isArray(trades) ? trades : []).forEach((t, i) => {
    if (!t || t.is_block_trade === true) return;
    const cents = num(t.yes_price);
    const y = num(t.yes_price_dollars) ?? (cents == null ? null : cents / 100);
    const n = num(t.count_fp) ?? num(t.count);
    if (y == null || !(y > 0 && y < 1) || n == null || !(n > 0)) return;
    const ts = Date.parse(t.created_time);
    if (maxTs != null && Number.isFinite(ts) && ts > maxTs * 1000) return; // after kickoff
    rows.push({ y, n, ts: Number.isFinite(ts) ? ts : -Infinity, i });
  });
  rows.sort((a, b) => b.ts - a.ts || a.i - b.i); // newest first, API order on ties
  const use = rows.slice(0, limit);
  const contracts = use.reduce((a, r) => a + r.n, 0);
  if (!(contracts > 0)) return null;
  const closeYes = round4(use.reduce((a, r) => a + r.n * r.y, 0) / contracts);
  return { closeYes, trades: use.length, contracts: Math.round(contracts * 100) / 100 };
}

/** GET /markets/trades for one ticker: the newest `limit` trades at or before maxTs. */
export async function fetchTrades(kalshi, ticker, { maxTs, limit = CLOSE.trades }) {
  const j = await kalshi.get('/markets/trades', { ticker, max_ts: maxTs, limit });
  if (!Array.isArray(j?.trades)) throw new Error(`trades ${ticker}: no trades list`);
  return j.trades;
}

// ---------------------------------------------------------------- store (state/clv-closes.json)

/** { v: 1, closes: { [ticker]: { kickoff, done, closeYes, trades, at, attempts, note } } }; empty without stateDir. */
export async function readCloseStore(stateDir) {
  if (stateDir) {
    try {
      const j = JSON.parse(await readFile(join(stateDir, STORE_FILE), 'utf8'));
      if (j?.v === 1 && j.closes && typeof j.closes === 'object') return j;
    } catch { /* first run or unreadable: start empty */ }
  }
  return { v: 1, closes: {} };
}

export async function writeCloseStore(stateDir, store) {
  if (!stateDir) return;
  const path = join(stateDir, STORE_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(store));
  await rename(`${path}.tmp`, path);
}

/** Drop entries whose kickoff is more than CLOSE.keepMs old (tickers the site stopped listing). */
export function pruneCloseStore(store, now, { keepMs = CLOSE.keepMs } = {}) {
  for (const [t, e] of Object.entries(store.closes)) {
    const k = Date.parse(e?.kickoff);
    if (!Number.isFinite(k) || now - k > keepMs) delete store.closes[t];
  }
  return store;
}

/**
 * Look up the closes this run can afford and decide which settle rows go out now.
 *   items: normalizePending() output; rows: settleRow() results for those tickers; store: readCloseStore() (mutated)
 *   persistent: the store is saved between runs (a state dir); the hold then runs from the ticker's first sighting,
 *   else from its kickoff (a fresh store every run would otherwise hold forever)
 * -> { results, held, stats: { due, lookups, computed, failed, noTrades, sentWithClose, sentWithoutClose, held } }
 * results: rows to POST; rows of tickers with a past kickoff carry closeYes (number, or null when there is none).
 */
export async function attachCloses({ items, rows, kalshi, store, now, persistent = false, maxLookups = CLOSE.lookupsPerRun, log = () => {} }) {
  const rowBy = new Map(rows.map((r) => [r.ticker, r]));
  const due = new Map(items.filter((i) => i.kickoff && Date.parse(i.kickoff) <= now).map((i) => [i.ticker, i]));
  const stats = { due: due.size, lookups: 0, computed: 0, failed: 0, noTrades: 0, sentWithClose: 0, sentWithoutClose: 0, held: 0 };
  const entryOf = (i) => {
    let e = store.closes[i.ticker];
    if (!e || e.kickoff !== i.kickoff) e = store.closes[i.ticker] = { kickoff: i.kickoff, firstSeen: isoS(now), done: false, attempts: 0 }; // new, or the kickoff moved
    return e;
  };
  // Settled tickers first (their result is waiting), then by kickoff, then ticker: the same order on every run.
  const todo = [...due.values()]
    .filter((i) => !entryOf(i).done)
    .sort((a, b) => Number(rowBy.has(b.ticker)) - Number(rowBy.has(a.ticker)) || Date.parse(a.kickoff) - Date.parse(b.kickoff) || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  for (const i of todo) {
    if (stats.lookups >= maxLookups) break;
    const e = entryOf(i);
    const maxTs = Math.floor(Date.parse(i.kickoff) / 1000);
    stats.lookups++;
    try {
      const v = closeVwap(await fetchTrades(kalshi, i.ticker, { maxTs }), { maxTs });
      Object.assign(e, { done: true, closeYes: v ? v.closeYes : null, trades: v ? v.trades : 0, at: isoS(now) });
      if (v) stats.computed++; else { stats.noTrades++; e.note = 'no pregame trades'; }
    } catch (err) {
      if (err?.final || err?.budget) { stats.lookups--; break; } // the settle time budget is spent: the rest wait
      stats.failed++;
      e.attempts = (e.attempts || 0) + 1;
      e.note = errorText(err).slice(0, 160);
      if (e.attempts >= CLOSE.maxAttempts) Object.assign(e, { done: true, closeYes: null, trades: 0, at: isoS(now) });
      log(`close ${i.ticker}: ${e.note}${e.done ? ' (posting the result without a close)' : ''}`);
    }
  }
  const results = [];
  const held = [];
  for (const r of rows) {
    const i = due.get(r.ticker);
    if (!i) { results.push(r); continue; } // plain ticker (no kickoff): as before
    const e = store.closes[r.ticker];
    if (e?.done) {
      results.push({ ...r, closeYes: e.closeYes ?? null });
      if (e.closeYes != null) stats.sentWithClose++; else stats.sentWithoutClose++;
    } else if (now - Date.parse(persistent && e?.firstSeen ? e.firstSeen : i.kickoff) < CLOSE.holdMs) {
      held.push(r.ticker); // its close is not known yet: keep it pending at the site, a later run posts both
    } else {
      results.push({ ...r, closeYes: null });
      stats.sentWithoutClose++;
    }
  }
  stats.held = held.length;
  return { results, held, stats };
}
