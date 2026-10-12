// Pinnacle guest feed: a second, independent price source for the game lines (unofficial, keyless, public JSON).
//
//   GET https://guest.api.arcadia.pinnacle.com/0.1/leagues/{889 NFL | 880 NCAAF}/matchups
//   GET https://guest.api.arcadia.pinnacle.com/0.1/leagues/{889 NFL | 880 NCAAF}/markets/straight
//
// 4 requests per pull, 0.1 to 0.6 MB each (verified keyless from a US residential IP on 2026-10-12; GitHub Actions
// IPs untested). The CDN answers `Cache-Control: public, max-age=905`, so a pull at most every 15 minutes
// (state/pinnacle.json keeps the last attempt and a trimmed copy; runs in between reuse it). The feed is undocumented
// and can change or block without notice: every failure FAILS OPEN (no refs for that league, the rest of the snapshot
// is unchanged, sources.pinnacle.ok = false with the reason).
//
// Snapshot output (buildPinnacle, pure; ESPN home/away orientation even when Pinnacle lists the teams the other way):
//   games[i].refs.pinnacle = {
//     fetchedAt,                 // ISO, when the collector pulled the league
//     lastModified,              // ISO, the CDN Last-Modified of the prices (markets/straight), or null
//     offBoard,                  // true: Pinnacle lists the game but has no open full-game price (taken off the board)
//     odds: {                    // full game, main lines, American odds (SPEC 3 Odds field names); each null if absent
//       ml:     { home, away },
//       spread: { home, homeOdds, awayOdds },      // home = the home team's line (negative = home favored)
//       total:  { line, overOdds, underOdds },
//     },
//     alts: [{ type: 'spread'|'total', points, a, b }],   // alternate lines only, within 10 points of the main line
//                                                         // spread: points = home line, a = home odds, b = away odds
//                                                         // total:  points = total,     a = over odds, b = under odds
//     periods: { h1, q1 },       // NFL only, each key only when Pinnacle prices it: { ml, spread, total, alts } as above
//   }                            // (h1 = Pinnacle period 1, first half; q1 = period 3, first quarter)
// refs is absent on games Pinnacle does not list, on games that are not pregame, and whenever the feed failed.
// Team totals are not carried.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { matchGames, etDate, norm } from './match.mjs';
import { failText } from './http.mjs';

export const PINNACLE_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
export const PINNACLE_LEAGUES = Object.freeze({ nfl: 889, cfb: 880 });
/** The CDN caches for 905 s: pull at most this often; runs in between reuse the copy in state/pinnacle.json. */
export const PINNACLE_MIN_INTERVAL_MS = 15 * 60e3;
// The headers the research fetch used (keyless). Nothing else is sent.
export const PINNACLE_HEADERS = Object.freeze({ accept: 'application/json', 'user-agent': 'gridiron-data/1 (private)' });
// Pinnacle name (normalized) -> ESPN name, where the production matcher cannot pair them (seen live 2026-10-12: the
// research's 5, plus Miami Ohio and Middle Tennessee State, which missed the 0.9 floor on the same capture).
// The matcher's own NAME_ALIAS (appalachian state -> app state, ...) still applies after these.
export const PIN_ALIAS = Object.freeze({
  'miami florida': 'miami',
  mississippi: 'ole miss',
  'ul lafayette': 'louisiana',
  'sam houston state': 'sam houston',
  hawaii: 'hawai i',
  'miami ohio': 'miami oh',
  'middle tennessee state': 'middle tennessee',
});
/** A Pinnacle game is attached only on a match score of at least this (the Kalshi matcher accepts 0.75). */
export const PIN_MATCH_MIN = 0.9;
/** Alternate lines farther than this from the main line are dropped. */
export const ALT_RANGE = 10;
const PERIODS = Object.freeze({ nfl: [0, 1, 3], cfb: [0] });
const PERIOD_KEY = Object.freeze({ 1: 'h1', 3: 'q1' });
const TYPES = new Set(['moneyline', 'spread', 'total']);
const DESIGNATIONS = new Set(['home', 'away', 'over', 'under']);
const STATE_FILE = 'pinnacle.json';
const STATE_VERSION = 1;
const DAY = 86400e3;

const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const httpDateIso = (s) => { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? isoS(t) : null; };
const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const american = (x) => { const n = finite(x); return n != null && Math.abs(n) >= 100 ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- trimming (pure)

/**
 * Raw /matchups and /markets/straight of one league -> the trimmed copy the builder reads (and state keeps).
 *   { matchups: [{ id, startTime, home, away, closed }], markets: [{ matchupId, period, type, alt, prices: [{ d, points, price }] }] }
 * Matchups: top-level games only (type 'matchup', no parent, a home and an away participant, not live); props,
 * futures and specials are dropped. closed = Pinnacle marks the full game period closed. Markets: moneyline, spread and
 * total rows of those games, open, for the league's periods (NFL 0, 1, 3; CFB 0), with home/away/over/under prices.
 * Sorted, so the same responses always give the same copy.
 */
export function trimPinnacle(league, matchupsRaw, marketsRaw) {
  const periods = PERIODS[league] || [0];
  const matchups = [];
  for (const m of Array.isArray(matchupsRaw) ? matchupsRaw : []) {
    if (m?.type !== 'matchup' || m.parentId != null || m.isLive === true) continue;
    const parts = Array.isArray(m.participants) ? m.participants : [];
    if (parts.length !== 2) continue;
    const home = parts.find((p) => p?.alignment === 'home');
    const away = parts.find((p) => p?.alignment === 'away');
    const start = Date.parse(m.startTime);
    if (!home?.name || !away?.name || !Number.isFinite(start) || !Number.isFinite(Number(m.id))) continue;
    const p0 = (Array.isArray(m.periods) ? m.periods : []).find((p) => p?.period === 0);
    matchups.push({ id: Number(m.id), startTime: isoS(start), home: String(home.name), away: String(away.name), closed: p0?.status === 'closed' });
  }
  matchups.sort((a, b) => a.id - b.id);
  const ids = new Set(matchups.map((m) => m.id));
  const markets = [];
  for (const x of Array.isArray(marketsRaw) ? marketsRaw : []) {
    if (!ids.has(Number(x?.matchupId)) || !TYPES.has(x.type) || !periods.includes(x.period)) continue;
    if (x.status != null && x.status !== 'open') continue;
    const prices = [];
    for (const p of Array.isArray(x.prices) ? x.prices : []) {
      if (!DESIGNATIONS.has(p?.designation) || american(p.price) == null) continue;
      prices.push({ d: p.designation, points: finite(p.points), price: p.price });
    }
    if (prices.length !== 2) continue;
    prices.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    markets.push({ matchupId: Number(x.matchupId), period: x.period, type: x.type, alt: x.isAlternate === true, prices });
  }
  const key = (m) => `${m.type}|${m.alt ? 1 : 0}`;
  const pts = (m) => m.prices.find((p) => p.d === 'home' || p.d === 'over')?.points ?? 0;
  markets.sort((a, b) => a.matchupId - b.matchupId || a.period - b.period || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) || pts(a) - pts(b));
  return { matchups, markets };
}

// ---------------------------------------------------------------- fetching

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function writeJsonAtomic(path, data) {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path);
  } catch { /* state is best effort: the next run fetches again */ }
}

/** One GET with the Pinnacle headers -> { body, lastModified }. Throws Error('<path>: <reason>') (no retry here). */
async function getJsonMeta(fetchImpl, url, { timeoutMs, stats }) {
  const u = new URL(url);
  const label = u.hostname + u.pathname;
  stats.requests++;
  let res;
  try {
    res = await fetchImpl(u.toString(), { headers: { ...PINNACLE_HEADERS }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.refused) stats.requests--; // refused by a spent time budget: nothing was sent
    const err = new Error(`${label}: ${failText(e)}`);
    err.final = !!e?.budget;
    throw err;
  }
  let text;
  try { text = await res.text(); } catch (e) { const err = new Error(`${label}: ${failText(e)} (reading the body)`); err.final = !!e?.budget; throw err; }
  if (!res.ok) { const err = new Error(`${label}: HTTP ${res.status}`); err.status = res.status; throw err; }
  // a 200 that is not the list (a block page, a format change) is final: retrying at once would get the same answer
  const junk = (msg) => Object.assign(new Error(`${label}: ${msg}`), { status: res.status });
  let body;
  try { body = JSON.parse(text); } catch { throw junk(`invalid JSON (${text.length} bytes)`); }
  if (!Array.isArray(body)) throw junk('expected a JSON array (format change?)');
  return { body, lastModified: httpDateIso(res.headers?.get?.('last-modified')) };
}

// One retry on a network error, a timeout or a 5xx; a 4xx (a block) and a spent budget are final.
async function getWithRetry(fetchImpl, url, opts) {
  try {
    return await getJsonMeta(fetchImpl, url, opts);
  } catch (e) {
    if (e.final || (e.status && e.status < 500)) throw e;
    if (opts.retryDelayMs) await sleep(opts.retryDelayMs);
    return getJsonMeta(fetchImpl, url, opts);
  }
}

/**
 * fetchPinnacleInputs({ fetchImpl, now, stateDir, log }) -> inputs.pinnacle:
 *   { attemptAt, cached, requests, errors, leagues: { nfl: League | null, cfb: League | null } }
 *   League = { fetchedAt, lastModified, matchups, markets }   (trimPinnacle output; null when the league failed)
 * At most one pull per PINNACLE_MIN_INTERVAL_MS (measured with the run's `now` against the last attempt, failed or
 * not, so a blocked feed costs 4 requests per 15 minutes): in between, the copy from state/pinnacle.json is returned
 * with cached: true and requests: 0, including the errors of that attempt. Without stateDir every run pulls.
 * Never throws for upstream failures.
 */
export async function fetchPinnacleInputs({
  fetchImpl = globalThis.fetch, now = Date.now(), stateDir = null, log = () => {},
  timeoutMs = 20000, retryDelayMs = 800, minIntervalMs = PINNACLE_MIN_INTERVAL_MS,
} = {}) {
  const path = stateDir ? join(stateDir, STATE_FILE) : null;
  const prev = path ? await readJson(path) : null;
  const prevAt = Date.parse(prev?.attemptAt);
  if (prev?.v === STATE_VERSION && prev.inputs && Number.isFinite(prevAt) && now >= prevAt && now - prevAt < minIntervalMs) {
    log(`pinnacle: reusing the pull from ${prev.attemptAt} (next pull after ${isoS(prevAt + minIntervalMs)})`);
    return { ...prev.inputs, cached: true, requests: 0 };
  }
  const stats = { requests: 0 };
  const errors = [];
  const leagues = {};
  const at = isoS(now);
  for (const [league, id] of Object.entries(PINNACLE_LEAGUES)) {
    const base = `${PINNACLE_BASE}/leagues/${id}`;
    try {
      const mu = await getWithRetry(fetchImpl, `${base}/matchups`, { timeoutMs, retryDelayMs, stats });
      const px = await getWithRetry(fetchImpl, `${base}/markets/straight`, { timeoutMs, retryDelayMs, stats });
      leagues[league] = { fetchedAt: at, lastModified: px.lastModified, ...trimPinnacle(league, mu.body, px.body) };
    } catch (e) {
      leagues[league] = null;
      errors.push(`${league}: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  const out = { attemptAt: at, cached: false, requests: stats.requests, errors, leagues };
  if (path) await writeJsonAtomic(path, { v: STATE_VERSION, attemptAt: at, inputs: { attemptAt: at, errors, leagues } });
  log(`pinnacle: ${stats.requests} requests${errors.length ? `; ${errors.join(' | ')}` : ''}`);
  return out;
}

// ---------------------------------------------------------------- snapshot block (pure)

const other = (s) => (s === 'home' ? 'away' : 'home');

/** Main lines and alternates of one period of one matchup, in ESPN home/away orientation. */
function periodLines(rows, flipped) {
  const pd = (espnSide) => (flipped ? other(espnSide) : espnSide); // Pinnacle designation of an ESPN side
  const price = (m, d) => m?.prices.find((p) => p.d === d) || null;
  const spreadOf = (m) => {
    const h = price(m, pd('home')), a = price(m, pd('away'));
    if (!h || !a || h.points == null || a.points == null || Math.abs(h.points + a.points) > 1e-9) return null;
    return { home: h.points, homeOdds: h.price, awayOdds: a.price };
  };
  const totalOf = (m) => {
    const o = price(m, 'over'), u = price(m, 'under');
    if (!o || !u || o.points == null || o.points !== u.points) return null;
    return { line: o.points, overOdds: o.price, underOdds: u.price };
  };
  const mainOf = (type) => rows.find((m) => m.type === type && !m.alt) || null;
  const mlRow = mainOf('moneyline');
  const h = price(mlRow, pd('home')), a = price(mlRow, pd('away'));
  const ml = h && a ? { home: h.price, away: a.price } : null;
  const spread = spreadOf(mainOf('spread'));
  const total = totalOf(mainOf('total'));
  const alts = [];
  const seen = new Set();
  for (const m of rows) {
    if (!m.alt) continue;
    let alt = null;
    if (m.type === 'spread' && spread) {
      const s = spreadOf(m);
      if (s && Math.abs(s.home - spread.home) <= ALT_RANGE) alt = { type: 'spread', points: s.home, a: s.homeOdds, b: s.awayOdds };
    } else if (m.type === 'total' && total) {
      const t = totalOf(m);
      if (t && Math.abs(t.line - total.line) <= ALT_RANGE) alt = { type: 'total', points: t.line, a: t.overOdds, b: t.underOdds };
    }
    if (!alt || alt.points === (alt.type === 'spread' ? spread.home : total.line)) continue;
    const k = `${alt.type}|${alt.points}`;
    if (seen.has(k)) continue;
    seen.add(k);
    alts.push(alt);
  }
  alts.sort((x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : 0) || x.points - y.points);
  return { ml, spread, total, alts };
}

/** refs.pinnacle for one matched game. */
export function pinnacleRef(matchup, rows, { league, flipped = false, fetchedAt = null, lastModified = null } = {}) {
  const byPeriod = (p) => rows.filter((m) => m.period === p);
  const full = periodLines(byPeriod(0), flipped);
  const offBoard = !!matchup.closed || (!full.ml && !full.spread && !full.total);
  const ref = {
    fetchedAt: fetchedAt ?? null,
    lastModified: lastModified ?? null,
    offBoard,
    odds: offBoard ? { ml: null, spread: null, total: null } : { ml: full.ml, spread: full.spread, total: full.total },
    alts: offBoard ? [] : full.alts,
  };
  if (league === 'nfl' && !offBoard) {
    const periods = {};
    for (const p of [1, 3]) {
      const x = periodLines(byPeriod(p), flipped);
      if (x.ml || x.spread || x.total) periods[PERIOD_KEY[p]] = x;
    }
    if (Object.keys(periods).length) ref.periods = periods;
  }
  return ref;
}

/**
 * buildPinnacle(P, { games, eventsByLeague, now }) -> { refs: Map<gameId, ref>, unmatched: [string], matched, errors }
 *   P: inputs.pinnacle; games: snapshot games (refs only on 'pre' games); eventsByLeague: { nfl: [raw ESPN event] }
 *   (every event on the boards, post included, so a finished game is not reported as a miss).
 * Matching: lib/match.mjs (ET date +/- 1 day, both teams, PIN_ALIAS on Pinnacle names first), score >= PIN_MATCH_MIN.
 * unmatched: Pinnacle games dated inside the snapshot window that matched no ESPN game ('cfb: Away @ Home 2026-10-17').
 * matched: { nfl, cfb } count of snapshot games given refs.pinnacle (off-board games included).
 */
export function buildPinnacle(P, { games = [], eventsByLeague = {}, now } = {}) {
  const refs = new Map();
  const unmatched = [];
  const matched = {};
  const errors = [];
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const dateLo = etDate(nowMs - DAY);
  const dateHi = etDate(nowMs + 10 * DAY);
  const alias = (n) => PIN_ALIAS[norm(n)] || n;
  for (const league of Object.keys(PINNACLE_LEAGUES)) {
    const L = P?.leagues?.[league];
    if (!L) continue;
    matched[league] = 0;
    const list = (Array.isArray(L.matchups) ? L.matchups : []).map((m) => ({
      eventTicker: String(m.id), dateKey: etDate(m.startTime), m,
      away: { name: alias(m.away), code: '' }, home: { name: alias(m.home), code: '' },
    }));
    const r = matchGames(list, eventsByLeague[league] || [], league);
    const byEspn = new Map();
    for (const [id, v] of r.matches) if (v.score >= PIN_MATCH_MIN) byEspn.set(String(v.espnEvent.id), { id, flipped: v.flipped });
    const taken = new Set([...byEspn.values()].map((v) => v.id));
    let inWindow = 0;
    for (const k of list) {
      if (k.dateKey < dateLo || k.dateKey > dateHi) continue;
      inWindow++;
      if (!taken.has(k.eventTicker)) unmatched.push(`${league}: ${k.m.away} @ ${k.m.home} ${k.dateKey}`);
    }
    const rowsBy = new Map();
    for (const x of Array.isArray(L.markets) ? L.markets : []) {
      const k = String(x.matchupId);
      if (!rowsBy.has(k)) rowsBy.set(k, []);
      rowsBy.get(k).push(x);
    }
    const mById = new Map(list.map((k) => [k.eventTicker, k.m]));
    let pre = 0;
    for (const g of games) {
      if (g.league !== league || g.state !== 'pre') continue;
      pre++;
      const hit = byEspn.get(String(g.espnId));
      if (!hit) continue;
      refs.set(g.id, pinnacleRef(mById.get(hit.id), rowsBy.get(hit.id) || [], { league, flipped: hit.flipped, fetchedAt: L.fetchedAt, lastModified: L.lastModified }));
      matched[league]++;
    }
    // Pinnacle lists games for these dates and ESPN lists games, but none paired: a name or format change.
    if (!matched[league] && inWindow >= 5 && pre >= 5) errors.push(`${league}: none of ${inWindow} Pinnacle games matched any of ${pre} pregame games (team name format change?)`);
  }
  unmatched.sort();
  return { refs, unmatched, matched, errors };
}
