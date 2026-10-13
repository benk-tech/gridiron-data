// Polymarket US (QCX LLC, a CFTC exchange) public gateway: a reference price (vote) for the game lines. Keyless.
//
//   GET https://gateway.polymarket.us/v2/leagues/{nfl|cfb}/events?limit=100&offset=N
//
// Every game with every market and its live best bid and ask (Cloudflare DYNAMIC, not cached). Heavy: NFL is 1 page
// (about 0.46 MB brotli, 18.6 MB of JSON), CFB 3 pages (about 1.2 MB brotli, 46.6 MB of JSON), so about 4 GETs per
// run (seen 2026-10-12 from a US residential IP; GitHub runner IPs untested). Pulled every run. Each page is parsed
// as it arrives and only the full game winner, spread and total quotes are kept. The events payload has prices only,
// no sizes, so sizes are null. Fails open: a failed league has no quotes and its error is recorded.
//
// Ported from research round 4 (polymarket/code/polymarket.mjs fetchPolyUS, parsePolyUS), whose orientation was
// checked against Kalshi on 428 near-line contracts (median gap 0.3pp, no flips).
// Orientation traps: football events list the AWAY team as the long side of the winner market (team.ordering says
// which); spread rungs are quoted for the long team (line < 0: it must win by more than |line|; line > 0: it gets the
// points, so YES of the long side is NO of 'the other team wins by more than line'). Never read m.title: on 'pos'
// rungs it describes the short side.

import { etDate } from '../match.mjs';
import { Q, flipQ, half, other, isoS, getJson, spKey, totKey, sortQuotes, VENUE_ALIAS } from './common.mjs';

export const POLYUS_BASE = 'https://gateway.polymarket.us';
export const POLYUS_LEAGUES = Object.freeze(['nfl', 'cfb']);
export const POLYUS_PAGE = 100;
export const POLYUS_MAX_PAGES = 5;
// Polymarket name (normalized) -> ESPN name, where the production matcher cannot pair them ('la tech' and 'nm state'
// seen 2026-10-12; both are in the shared table).
export const POLY_ALIAS = Object.freeze({ ...VENUE_ALIAS });

const WINNER = 'football_team_full_game_winner';
const SPREAD = 'football_team_full_game_spread';
const TOTAL = 'football_team_full_game_total';
const OPEN = 'MARKET_STATUS_OPEN';

/**
 * Raw gateway events -> venue games, in the source's own order:
 *   [{ id: event slug, dateKey (ET), kickoff, away: { name }, home: { name }, quotes: { key: Quote } }]
 * Closed or archived events, games without a two-team winner market, closed markets, one-sided or crossed books and
 * whole-point lines are dropped.
 */
export function parsePolyUS(events) {
  const games = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.closed || e.archived) continue;
    const ms = Array.isArray(e.markets) ? e.markets : [];
    const ml = ms.find((m) => m?.sportsMarketType === WINNER);
    const sides = Array.isArray(ml?.marketSides) ? ml.marketSides : [];
    const L = sides.find((s) => s?.long === true), S = sides.find((s) => s?.long === false);
    if (!L?.team?.name || !S?.team?.name || L.team.name === S.team.name) continue;
    // Football leagues order 'away': the long side is the away team. team.ordering confirms it when present; the
    // matcher's flipped flag covers any game listed the other way round.
    const longIsHome = L.team.ordering === 'home' && S.team.ordering === 'away';
    const awayName = longIsHome ? S.team.name : L.team.name;
    const homeName = longIsHome ? L.team.name : S.team.name;
    const sideOf = (name) => (name === awayName ? 'away' : name === homeName ? 'home' : null);
    const quotes = {};
    const put = (k, q) => { if (q && !quotes[k]) quotes[k] = q; };
    const sorted = [...ms].filter(Boolean).sort((a, b) => (String(a.slug) < String(b.slug) ? -1 : String(a.slug) > String(b.slug) ? 1 : 0));
    for (const m of sorted) {
      if (m.status && m.status !== OPEN) continue;
      if (m.closed === true || m.archived === true) continue;
      const q = Q(m.bestBidQuote?.value, m.bestAskQuote?.value); // the LONG side's book
      if (!q) continue;
      const t = m.sportsMarketType;
      const line = Number(m.line);
      if (t === WINNER) put('ml:home', longIsHome ? q : flipQ(q));
      else if (t === SPREAD && half(line)) {
        const side = sideOf(m.marketSides?.find((s) => s?.long === true)?.team?.name);
        if (!side) continue;
        if (line < 0) put(spKey(side, line), q);            // long team -s: wins by more than s
        else put(spKey(other(side), line), flipQ(q));        // long team +s covers = the other team does NOT win by more than s
      } else if (t === TOTAL && half(line)) {
        const longDesc = String(m.marketSides?.find((s) => s?.long === true)?.description || 'Over').toLowerCase();
        put(totKey(line), longDesc.startsWith('under') ? flipQ(q) : q); // long = Over on every market seen
      }
      // ignored: team totals, halves, quarters
    }
    const kickoff = e.startTime || ml.gameStartTime;
    if (!Number.isFinite(Date.parse(kickoff))) continue;
    games.push({ id: String(e.slug || e.id), dateKey: etDate(kickoff), kickoff: isoS(Date.parse(kickoff)), away: { name: awayName }, home: { name: homeName }, quotes: sortQuotes(quotes) });
  }
  return games;
}

/**
 * fetchPolyUSInputs({ fetchImpl, now, log }) -> inputs.venues.polyus:
 *   { attemptAt, fetchedAt, cached: false, requests, errors, leagues: { nfl: [VenueGame] | null, cfb: ... }, seen }
 * seen: { league: open events in the payload } for the leagues that returned a page, so buildVenue can tell "the
 * venue lists games but none could be read" (a renamed market type or field) from "no games".
 * Pages are fetched one at a time (100 events each, at most POLYUS_MAX_PAGES per league) and parsed as they arrive.
 * A league whose first page failed is null; a later page failing keeps the games already parsed (with the error).
 * fetchedAt is the run's clock (like Pinnacle). Never throws for upstream failures.
 */
export async function fetchPolyUSInputs({
  fetchImpl = globalThis.fetch, now = Date.now(), log = () => {}, timeoutMs = 30000, retryDelayMs = 800,
  leagues = POLYUS_LEAGUES, maxPages = POLYUS_MAX_PAGES,
} = {}) {
  const stats = { requests: 0, bytes: 0 };
  const errors = [];
  const out = {};
  const seen = {};
  const at = isoS(now);
  for (const league of leagues) {
    let games = null;
    for (let page = 0; page < maxPages; page++) {
      const url = `${POLYUS_BASE}/v2/leagues/${league}/events?limit=${POLYUS_PAGE}&offset=${page * POLYUS_PAGE}`;
      let body;
      try {
        body = await getJson(fetchImpl, url, { timeoutMs, retryDelayMs, stats });
      } catch (e) {
        errors.push(`${league}: ${String(e?.message || e).slice(0, 200)}`);
        break;
      }
      if (!Array.isArray(body?.events)) { errors.push(`${league}: expected an events list (format change?)`); break; }
      seen[league] = (seen[league] || 0) + body.events.filter((e) => e && !e.closed && !e.archived).length;
      games = [...(games || []), ...parsePolyUS(body.events)];
      if (body.events.length < POLYUS_PAGE) break;
    }
    out[league] = games;
  }
  log(`polyus: ${stats.requests} requests, ${(stats.bytes / 1e6).toFixed(1)} MB${errors.length ? `; ${errors.join(' | ')}` : ''}`);
  return { attemptAt: at, fetchedAt: at, cached: false, requests: stats.requests, errors, leagues: out, seen };
}
