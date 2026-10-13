// SX Bet (offshore on-chain exchange) public API: an offshore reference price (vote) only, never a betting
// target. Keyless.
//
//   GET https://api.sx.bet/markets/active?leagueId=243&onlyMainLine=true&betGroup=game-lines&pageSize=100
//   GET https://api.sx.bet/orderbook-v3/snapshot?marketHash=<hash>&showTakerPerspective=true   (one per game)
//
// NFL full game moneyline only (market type 226, 'including overtime'), games inside the snapshot window: 1 list GET
// plus about 15 book GETs, at most 2 at a time, at most every 15 minutes (state/sx.json, like Pinnacle). The snapshot
// route is documented as unauthenticated and not rate limited, "which is not a licence to poll hard". The college
// league (246) is wired but off: about 60 more GETs per pull. Fails open.
//
// Ported from research round 4 (other-venues-scripts/lib/exchanges.mjs sx(), homeBook()); NFL moneyline mids sat a
// median 0.31pp from Kalshi on 15 games. Book reading (docs.sx.bet, get-orderbook-snapshot):
//   percentageOdds = probability x 1e20. With showTakerPerspective=true each side lists the prices a TAKER pays for
//   that outcome (best = lowest) and each `size` is the taker stake (USDC, 6 decimals) that fully consumes the level.
//   outcomeOne = teamOne. teamOne was the home team on all 15 NFL games checked; the matcher's flip covers the rest.
//   YES of 'ml:home' (teamOne): ask = best outcomeOne taker price; bid = 1 - best outcomeTwo taker price.
//   Sizes in contracts: a stake S at price p buys S / p contracts that pay $1, so askSize = stake at the best
//   outcomeOne price / that price, and bidSize (NO of home = YES of the away team) = stake at the best outcomeTwo
//   price / that price.

import { etDate } from '../match.mjs';
import { Q, isoS, getJson, inWindow, sortQuotes, pullOrReuse, VENUE_ALIAS } from './common.mjs';
import { mapLimit } from '../http.mjs';
import { join } from 'node:path';

export const SX_BASE = 'https://api.sx.bet';
export const SX_LEAGUE_ID = Object.freeze({ nfl: 243, cfb: 246 });
export const SX_LEAGUES = Object.freeze(['nfl']);
export const SX_MONEYLINE = 226;
export const SX_MIN_INTERVAL_MS = 15 * 60e3;
export const SX_BOOK_CONCURRENCY = 2;
export const SX_ALIAS = Object.freeze({ ...VENUE_ALIAS });
const STATE_FILE = 'sx.json';
const STATE_VERSION = 1;
const P = (s) => { try { return Number(BigInt(String(s)) / 10n ** 14n) / 1e6; } catch { return NaN; } };   // 1e20 fixed point -> probability
const USD = (s) => { const n = Number(s); return Number.isFinite(n) ? n / 1e6 : NaN; };                    // USDC base units -> dollars
const sane = (p) => Number.isFinite(p) && p > 0.01 && p < 0.99;

/** Best taker level of one side: { p, stake } at the lowest price (stakes at that price summed), or null. */
function bestLevel(levels) {
  let best = null;
  for (const x of Array.isArray(levels) ? levels : []) {
    const p = P(x?.percentageOdds), s = USD(x?.size);
    if (!sane(p) || !(s >= 0)) continue;
    if (!best || p < best.p - 1e-12) best = { p, stake: s };
    else if (Math.abs(p - best.p) <= 1e-12) best.stake += s;
  }
  return best;
}

/** One taker-perspective snapshot -> YES of teamOne { bid, ask, bidSize, askSize, sizeUnit }, or null. */
export function sxBook(data) {
  const one = bestLevel(data?.outcomeOne), two = bestLevel(data?.outcomeTwo);
  if (!one || !two) return null;
  return Q(1 - two.p, one.p, { askSize: one.stake / one.p, bidSize: two.stake / two.p });
}

/**
 * markets (GET /markets/active list) + books ({ [marketHash]: snapshot data }) -> { nfl: [VenueGame], cfb: [...] }
 * VenueGame = { id: marketHash, dateKey, kickoff, away: { name: teamTwoName }, home: { name: teamOneName }, quotes }.
 * Only active moneyline markets of the wanted leagues with a two sided book; ordered by kickoff then hash.
 */
export function parseSx(markets, books, { leagues = SX_LEAGUES } = {}) {
  const out = Object.fromEntries(leagues.map((l) => [l, []]));
  const byId = Object.fromEntries(Object.entries(SX_LEAGUE_ID).map(([l, id]) => [id, l]));
  for (const m of Array.isArray(markets) ? markets : []) {
    const league = byId[m?.leagueId];
    if (!league || !out[league] || m.type !== SX_MONEYLINE || m.status !== 'ACTIVE') continue;
    if (!m.teamOneName || !m.teamTwoName || !Number.isFinite(Number(m.gameTime))) continue;
    const q = sxBook(books?.[m.marketHash]);
    if (!q) continue;
    const kickoff = isoS(Number(m.gameTime) * 1000);
    out[league].push({ id: String(m.marketHash), dateKey: etDate(kickoff), kickoff, away: { name: m.teamTwoName }, home: { name: m.teamOneName }, quotes: sortQuotes({ 'ml:home': q }) });
  }
  for (const l of Object.keys(out)) out[l].sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * fetchSxInputs({ fetchImpl, now, stateDir, log }) -> inputs.venues.sx:
 *   { attemptAt, fetchedAt, cached, requests, errors, leagues: { nfl: [VenueGame] | null } }
 * At most one pull per SX_MIN_INTERVAL_MS (state/sx.json). A failed book GET drops only that game (its error is
 * recorded). Never throws for upstream failures.
 */
export async function fetchSxInputs({
  fetchImpl = globalThis.fetch, now = Date.now(), stateDir = null, log = () => {}, timeoutMs = 20000, retryDelayMs = 800,
  minIntervalMs = SX_MIN_INTERVAL_MS, leagues = SX_LEAGUES, concurrency = SX_BOOK_CONCURRENCY,
} = {}) {
  return pullOrReuse({ path: stateDir ? join(stateDir, STATE_FILE) : null, now, minIntervalMs, version: STATE_VERSION, name: 'sx', log }, async () => {
    const stats = { requests: 0, bytes: 0 };
    const errors = [];
    const result = {};
    for (const league of leagues) {
      const markets = [];
      let listed = false;
      let key = null;
      for (let page = 0; page < 4; page++) {
        let j;
        try {
          j = await getJson(fetchImpl, `${SX_BASE}/markets/active?leagueId=${SX_LEAGUE_ID[league]}&onlyMainLine=true&betGroup=game-lines&pageSize=100${key ? `&paginationKey=${encodeURIComponent(key)}` : ''}`, { timeoutMs, retryDelayMs, stats });
        } catch (e) {
          errors.push(`${league} markets: ${String(e?.message || e).slice(0, 200)}`);
          break;
        }
        const got = j?.data?.markets;
        if (!Array.isArray(got)) { errors.push(`${league} markets: expected data.markets (format change?)`); break; }
        listed = true;
        markets.push(...got);
        key = j.data.nextKey;
        if (!key || got.length < 100) break;
      }
      if (!listed) { result[league] = null; continue; }
      const mls = markets.filter((m) => m?.type === SX_MONEYLINE && m.status === 'ACTIVE' && Number.isFinite(Number(m.gameTime)) && inWindow(isoS(Number(m.gameTime) * 1000), now))
        .sort((a, b) => (String(a.marketHash) < String(b.marketHash) ? -1 : 1));
      const books = {};
      await mapLimit(mls, concurrency, async (m) => {
        try {
          const j = await getJson(fetchImpl, `${SX_BASE}/orderbook-v3/snapshot?marketHash=${encodeURIComponent(m.marketHash)}&showTakerPerspective=true`, { timeoutMs, retryDelayMs, stats });
          if (j?.data) books[m.marketHash] = j.data;
        } catch (e) {
          errors.push(`${league} book ${String(m.marketHash).slice(0, 10)}: ${String(e?.message || e).slice(0, 160)}`);
        }
      });
      result[league] = parseSx(mls, books, { leagues: [league] })[league];
    }
    errors.sort();
    log(`sx: ${stats.requests} requests${errors.length ? `; ${errors.slice(0, 3).join(' | ')}` : ''}`);
    return { requests: stats.requests, errors, leagues: result };
  });
}
