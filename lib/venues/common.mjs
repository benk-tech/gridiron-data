// Shared pieces of the exchange reference venues (lib/venues/polyus.mjs, gemini.mjs, sxbet.mjs): the quote shape and
// its canonical contract keys, orientation helpers, a small JSON GET with one retry, and the 15 minute state cache.
//
// Canonical contract keys, always in ESPN home/away orientation, half point strikes only:
//   'ml:home'       P(home team wins)
//   'sp:home:3.5'   P(home team wins by more than 3.5)       'sp:away:3.5' for the away team
//   'tot:47.5'      P(total points over 47.5)
// Quote (YES side of the key) = { bid, ask, bidSize, askSize, sizeUnit }
//   bid, ask   dollars, 0 < bid <= ask < 1 (two sided and uncrossed only; anything else is no quote)
//   sizes      contracts at that best price when the venue gives a size we can convert, else null; sizeUnit is
//              'contracts' when either size is known, else null. NO of the key is bought at 1 - bid, against bidSize.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { failText } from '../http.mjs';

export const VENUE_HEADERS = Object.freeze({ accept: 'application/json', 'user-agent': 'gridiron-data/1 (private)' });
/** A venue game is attached only on a match score of at least this (same floor as Pinnacle; Kalshi accepts 0.75). */
export const VENUE_MATCH_MIN = 0.9;
export const SIZE_UNIT = 'contracts';
/**
 * Venue team name (normalized) -> ESPN name, where the production matcher cannot pair them (Pinnacle's table plus the
 * names the venues use, seen 2026-10-12). Each venue adds its own entries on top. The matcher's NAME_ALIAS still applies.
 */
export const VENUE_ALIAS = Object.freeze({
  'la tech': 'louisiana tech',
  'nm state': 'new mexico state',
  hawaii: 'hawai i',
  'miami florida': 'miami',
  mississippi: 'ole miss',
  'ul lafayette': 'louisiana',
  'sam houston state': 'sam houston',
  'miami ohio': 'miami oh',
  'middle tennessee state': 'middle tennessee',
});
const DAY = 86400e3;

export const r4 = (x) => Math.round(x * 1e4) / 1e4;
export const half = (x) => Number.isFinite(x) && Math.abs(Math.abs(x % 1) - 0.5) < 1e-9;
export const other = (s) => (s === 'home' ? 'away' : 'home');
export const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const num = (x) => (x == null || x === '' ? NaN : Number(typeof x === 'object' ? x.value : x));
const size = (x) => (Number.isFinite(x) && x >= 0 ? Math.round(x) : null);

/** Quote for YES of a key, or null unless two sided and uncrossed. Sizes are contracts (rounded) or null. */
export function Q(bid, ask, { bidSize = null, askSize = null } = {}) {
  const b = num(bid), a = num(ask);
  if (!(b > 0 && a < 1 && a >= b)) return null;
  const bs = size(bidSize), as = size(askSize);
  return { bid: r4(b), ask: r4(a), bidSize: bs, askSize: as, sizeUnit: bs != null || as != null ? SIZE_UNIT : null };
}

/** The same book seen from the other outcome: YES of the complement key. */
export const flipQ = (q) => (q ? { bid: r4(1 - q.ask), ask: r4(1 - q.bid), bidSize: q.askSize, askSize: q.bidSize, sizeUnit: q.sizeUnit } : null);

/**
 * Fold two complementary books into YES of the first (Kalshi-style winner markets): YES of A, plus YES of B which is
 * NO of A. bid = max(A bid, 1 - B ask), ask = min(A ask, 1 - B bid); the size follows the side that set the price.
 * a, b: { bid, ask, bidSize, askSize } where any part may be missing (a one-sided contract still counts for its side).
 */
export function foldPair(a, b) {
  const ok = (x) => Number.isFinite(x) && x > 0 && x < 1;
  const bids = [], asks = [];
  const ab = num(a?.bid), aa = num(a?.ask), bb = num(b?.bid), ba = num(b?.ask);
  if (ok(ab)) bids.push({ p: ab, s: a.bidSize ?? null });
  if (ok(ba)) bids.push({ p: 1 - ba, s: b.askSize ?? null });
  if (ok(aa)) asks.push({ p: aa, s: a.askSize ?? null });
  if (ok(bb)) asks.push({ p: 1 - bb, s: b.bidSize ?? null });
  if (!bids.length || !asks.length) return null;
  const bid = bids.reduce((x, y) => (y.p > x.p ? y : x));
  const ask = asks.reduce((x, y) => (y.p < x.p ? y : x));
  return Q(bid.p, ask.p, { bidSize: bid.s, askSize: ask.s });
}

/** Quotes of a venue game listed with home and away swapped (neutral sites), in the ESPN orientation. */
export function reorient(quotes) {
  const out = {};
  for (const [k, v] of Object.entries(quotes || {})) {
    if (k === 'ml:home') out[k] = flipQ(v);
    else if (k.startsWith('sp:')) { const [, side, s] = k.split(':'); out[`sp:${other(side)}:${s}`] = v; }
    else out[k] = v;
  }
  return out;
}

const KEY_RE = /^(ml:home|sp:(home|away):\d+\.5|tot:\d+\.5)$/;
export const isKey = (k) => KEY_RE.test(k);
export const spKey = (side, s) => `sp:${side}:${Math.abs(s)}`;
export const totKey = (s) => `tot:${s}`;
const rank = (k) => {
  const [t, a, b] = k.split(':');
  if (t === 'ml') return [0, 0, 0];
  if (t === 'sp') return [1, a === 'away' ? 0 : 1, Number(b)];
  return [2, 0, Number(a)];
};
/** Canonical key order: moneyline, away spreads, home spreads (by strike), totals (by strike). */
export function keyOrder(a, b) {
  const x = rank(a), y = rank(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
/** A new quotes object with only valid keys, in canonical order (keep: optional Set of keys; ml:home is always kept). */
export function sortQuotes(quotes, keep = null) {
  const out = {};
  for (const k of Object.keys(quotes || {}).filter(isKey).sort(keyOrder)) {
    if (keep && k !== 'ml:home' && !keep.has(k)) continue;
    if (quotes[k]) out[k] = quotes[k];
  }
  return out;
}

/** Kickoff inside the snapshot window (6 h back, 9 days ahead): only those games are worth a request per game. */
export const inWindow = (iso, nowMs) => { const t = Date.parse(iso); return Number.isFinite(t) && t > nowMs - 6 * 3600e3 && t < nowMs + 9 * DAY; };

// ---------------------------------------------------------------- HTTP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One GET with the venue headers -> parsed JSON. Throws Error('<host/path>: <reason>') with .status and .final. */
async function getOnce(fetchImpl, url, { timeoutMs, stats }) {
  const u = new URL(url);
  const label = u.hostname + u.pathname;
  stats.requests++;
  let res;
  try {
    res = await fetchImpl(u.toString(), { headers: { ...VENUE_HEADERS }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.refused) stats.requests--; // refused by a spent time budget: nothing was sent
    throw Object.assign(new Error(`${label}: ${failText(e)}`), { final: !!e?.budget });
  }
  let text;
  try { text = await res.text(); } catch (e) { throw Object.assign(new Error(`${label}: ${failText(e)} (reading the body)`), { final: !!e?.budget }); }
  stats.bytes = (stats.bytes || 0) + text.length;
  if (!res.ok) throw Object.assign(new Error(`${label}: HTTP ${res.status}`), { status: res.status });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error(`${label}: invalid JSON (${text.length} bytes)`), { status: res.status }); }
}

/** GET JSON with one retry on a network error, a timeout or a 5xx. A 4xx (a block), bad JSON and a spent budget are final. */
export async function getJson(fetchImpl, url, opts) {
  try {
    return await getOnce(fetchImpl, url, opts);
  } catch (e) {
    if (e.final || (e.status && e.status < 500)) throw e;
    if (opts.retryDelayMs) await sleep(opts.retryDelayMs);
    return getOnce(fetchImpl, url, opts);
  }
}

// ---------------------------------------------------------------- 15 minute state cache (same pattern as lib/pinnacle.mjs)

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function writeJsonAtomic(path, data) {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path);
  } catch { /* state is best effort: the next run pulls again */ }
}

/**
 * At most one pull per minIntervalMs, measured with the run's `now` against the last attempt (failed or not, so a
 * blocked venue costs one pull per interval). In between, the saved copy is returned with cached: true and requests: 0
 * (its fetchedAt stays the time of the pull). Without a path every run pulls.
 * pull() -> { errors, leagues, ... } (no attemptAt/cached/requests; those are added here).
 */
export async function pullOrReuse({ path, now, minIntervalMs, version, name, log }, pull) {
  const prev = path ? await readJson(path) : null;
  const prevAt = Date.parse(prev?.attemptAt);
  if (prev?.v === version && prev.inputs && Number.isFinite(prevAt) && now >= prevAt && now - prevAt < minIntervalMs) {
    log(`${name}: reusing the pull from ${prev.attemptAt} (next pull after ${isoS(prevAt + minIntervalMs)})`);
    return { ...prev.inputs, cached: true, requests: 0 };
  }
  const at = isoS(now);
  const r = await pull(at);
  const inputs = { attemptAt: at, fetchedAt: at, ...r };
  if (path) await writeJsonAtomic(path, { v: version, attemptAt: at, inputs: { ...inputs, requests: undefined } });
  return { ...inputs, cached: false };
}
