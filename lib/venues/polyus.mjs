// Polymarket US (QCX LLC, a CFTC exchange) public gateway: a reference price (vote) for the game lines. Keyless.
//
//   GET https://gateway.polymarket.us/v2/leagues/{nfl|cfb}/events?limit=100&offset=N   every game, winner market only
//   GET https://gateway.polymarket.us/v1/events/slug/{event slug}                       one game, every market
//
// Since 2026-10-15 the league list returns only each event's primary (winner) market; spreads, totals and props come
// only with the event detail (Polymarket US changelog of 2026-10-09, "primary markets on event lists"). The market
// objects themselves did not change: the detail carries the same football_team_full_game_spread and _total markets,
// with the same line, marketSides (long, team.ordering) and bestBidQuote / bestAskQuote fields as the old list.
// So every run reads the list (NFL 1 page, CFB 3 pages, about 2.5 MB of JSON now), then one detail per game that
// still needs its lines (the list says it has spreads or totals, it kicks off within POLYUS_DETAIL_AHEAD_MS and has
// not started), at most POLYUS_MAX_DETAILS per run (the leagues take turns, each by kickoff), POLYUS_DETAIL_CONCURRENCY
// at a time: about 80 detail GETs a run in mid October 2026 (NFL 14, CFB 68), an NFL detail about 3 MB of JSON and a
// college one about 1 MB (about 120 MB a run in all). A list that still carries the lines (the old format) is read
// as before and its games need no detail. Cloudflare DYNAMIC, not cached. Only the full game winner, spread and total
// quotes are kept. The payload has prices only, no sizes, so sizes are null. Fails open: a failed league has no
// quotes; a failed detail leaves that game with its winner quote; a 403 or 429 on a detail, or a spent time budget,
// stops the remaining details. Every error is recorded.
//
// Ported from research round 4 (polymarket/code/polymarket.mjs fetchPolyUS, parsePolyUS), whose orientation was
// checked against Kalshi on 428 near-line contracts (median gap 0.3pp, no flips), and checked again on the detail
// format against Kalshi on 2026-10-16 (test/fixtures/venues/polyus-20261016.json.gz).
// Orientation traps: football events list the AWAY team as the long side of the winner market (team.ordering says
// which); spread rungs are quoted for the long team (line < 0: it must win by more than |line|; line > 0: it gets the
// points, so YES of the long side is NO of 'the other team wins by more than line'). Never read m.title: on 'pos'
// rungs it describes the short side.

import { etDate } from '../match.mjs';
import { mapLimit } from '../http.mjs';
import { Q, flipQ, half, other, isoS, getJson, spKey, totKey, sortQuotes, VENUE_ALIAS } from './common.mjs';

export const POLYUS_BASE = 'https://gateway.polymarket.us';
export const POLYUS_LEAGUES = Object.freeze(['nfl', 'cfb']);
export const POLYUS_PAGE = 100;
export const POLYUS_MAX_PAGES = 5;
/** Event detail GETs per run at most, both leagues together (the CLI's --polyus-details overrides it; 0 = none). */
export const POLYUS_MAX_DETAILS = 100;
/** Event detail GETs in flight at once. */
export const POLYUS_DETAIL_CONCURRENCY = 2;
/** A detail is pulled only for a game kicking off within this long: the snapshot window (lib/build.mjs WINDOW.aheadMs),
 * which holds next week's NFL games too, with their Kalshi spreads and totals. */
export const POLYUS_DETAIL_AHEAD_MS = 9 * 86400e3;
// Polymarket name (normalized) -> ESPN name, where the production matcher cannot pair them ('la tech' and 'nm state'
// seen 2026-10-12; both are in the shared table).
export const POLY_ALIAS = Object.freeze({ ...VENUE_ALIAS });

const WINNER = 'football_team_full_game_winner';
const SPREAD = 'football_team_full_game_spread';
const TOTAL = 'football_team_full_game_total';
const OPEN = 'MARKET_STATUS_OPEN';

/**
 * Raw gateway events (a list page's `events`, or [detail.event]) -> venue games, in the source's own order:
 *   [{ id: event slug, dateKey (ET), kickoff, away: { name }, home: { name }, quotes: { key: Quote } }]
 * Closed or archived events, games without a two-team winner market, closed markets, one-sided or crossed books and
 * whole-point lines are dropped. A list event of the new format has only its winner market, so only 'ml:home'.
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
      // ignored: team totals, halves, quarters, props
    }
    const kickoff = e.startTime || ml.gameStartTime;
    if (!Number.isFinite(Date.parse(kickoff))) continue;
    games.push({ id: String(e.slug || e.id), dateKey: etDate(kickoff), kickoff: isoS(Date.parse(kickoff)), away: { name: awayName }, home: { name: homeName }, quotes: sortQuotes(quotes) });
  }
  return games;
}

/**
 * Kickoff (ms) of a list event whose full game lines must come from its detail, else null: open, listed without
 * any full game spread or total market (the format since 2026-10-15; the old list carried them), listed with
 * spreads or totals to read (marketCounts.numSpreadsAndTotalsMarkets > 0: about 300 on an NFL game, 0 on most FCS
 * games; the old list had no such count), kicking off after nowMs and within aheadMs.
 */
export function detailKickoff(e, nowMs, aheadMs = POLYUS_DETAIL_AHEAD_MS) {
  if (!e || e.closed || e.archived) return null;
  const ms = Array.isArray(e.markets) ? e.markets : [];
  if (ms.some((m) => m?.sportsMarketType === SPREAD || m?.sportsMarketType === TOTAL)) return null;
  if (!(Number(e.marketCounts?.numSpreadsAndTotalsMarkets) > 0)) return null;
  const t = Date.parse(e.startTime || ms.find((m) => m?.sportsMarketType === WINNER)?.gameStartTime);
  return Number.isFinite(t) && t > nowMs && t <= nowMs + aheadMs ? t : null;
}

/**
 * The detail GETs of a run: the leagues take turns (in `leagues` order), each league's games by kickoff then id,
 * until maxDetails. wanted: { league: [{ league, id, slug, eventId, kickoff }] }.
 */
export function planDetails(wanted, leagues = POLYUS_LEAGUES, maxDetails = POLYUS_MAX_DETAILS) {
  const queues = leagues.map((l) => [...(wanted[l] || [])].sort((a, b) => a.kickoff - b.kickoff || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  const plan = [];
  for (let i = 0; plan.length < maxDetails && queues.some((q) => i < q.length); i++) {
    for (const q of queues) if (i < q.length && plan.length < maxDetails) plan.push(q[i]);
  }
  return plan;
}

const detailUrl = (d) => (d.slug ? `${POLYUS_BASE}/v1/events/slug/${encodeURIComponent(d.slug)}` : `${POLYUS_BASE}/v1/events/${encodeURIComponent(d.eventId)}`);

/**
 * fetchPolyUSInputs({ fetchImpl, now, log, maxDetails }) -> inputs.venues.polyus:
 *   { attemptAt, fetchedAt, cached: false, requests, errors, leagues: { nfl: [VenueGame] | null, cfb: ... }, seen,
 *     details: { league: { wanted, pulled } } }
 * seen: { league: open events in the list } for the leagues that returned a page, so buildVenue can tell "the venue
 * lists games but none could be read" (a renamed market type or field) from "no games".
 * details: games whose lines had to come from a detail (wanted) and how many details were read (pulled), for the log.
 * List pages are fetched one at a time (100 events each, at most POLYUS_MAX_PAGES per league) and parsed as they
 * arrive; then the details (planDetails), POLYUS_DETAIL_CONCURRENCY at a time, each merged into its game in plan
 * order, so the result does not depend on which answer came first. A league whose first page failed is null; a later
 * page failing keeps the games already parsed (with the error). fetchedAt is the run's clock (like Pinnacle).
 * Never throws for upstream failures.
 */
export async function fetchPolyUSInputs({
  fetchImpl = globalThis.fetch, now = Date.now(), log = () => {}, timeoutMs = 30000, retryDelayMs = 800,
  leagues = POLYUS_LEAGUES, maxPages = POLYUS_MAX_PAGES, maxDetails = POLYUS_MAX_DETAILS,
  concurrency = POLYUS_DETAIL_CONCURRENCY, aheadMs = POLYUS_DETAIL_AHEAD_MS,
} = {}) {
  const stats = { requests: 0, bytes: 0 };
  const errors = [];
  const out = {};
  const seen = {};
  const wanted = {};
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const at = isoS(nowMs);
  for (const league of leagues) {
    let games = null;
    const want = [];
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
      const parsed = parsePolyUS(body.events);
      games = [...(games || []), ...parsed];
      const kept = new Set(parsed.map((g) => g.id));
      for (const e of body.events) {
        const id = e ? String(e.slug || e.id) : null;
        const kickoff = id && kept.has(id) ? detailKickoff(e, nowMs, aheadMs) : null;
        if (kickoff != null) want.push({ league, id, slug: e.slug || null, eventId: e.id ?? null, kickoff });
      }
      if (body.events.length < POLYUS_PAGE) break;
    }
    out[league] = games;
    if (games) wanted[league] = want;
  }

  // ---- event details: the full game spreads and totals of the games the list no longer carries them for
  const listRequests = stats.requests;
  const plan = planDetails(wanted, leagues, Math.max(0, Number(maxDetails) || 0));
  const got = new Array(plan.length).fill(null);
  const detailErrors = [];
  let stopped = null;
  await mapLimit(plan, Math.max(1, concurrency), async (d, i) => {
    if (stopped) return;
    let body;
    try {
      body = await getJson(fetchImpl, detailUrl(d), { timeoutMs, retryDelayMs, stats });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 200);
      // a block, a rate limit or a spent time budget: the next detail would fail the same way
      if (e?.final || e?.status === 403 || e?.status === 429) { if (!stopped) stopped = `${d.league} ${d.id}: ${msg}`; }
      else detailErrors.push(`${d.league} ${d.id}: ${msg}`);
      return;
    }
    const ev = body?.event;
    if (!ev || !Array.isArray(ev.markets)) { detailErrors.push(`${d.league} ${d.id}: expected an event with markets (format change?)`); return; }
    if (ev.closed || ev.archived) return;
    const [g] = parsePolyUS([ev]);
    if (!g) detailErrors.push(`${d.league} ${d.id}: event detail could not be read (format change?)`);
    else got[i] = g;
  });
  const pulled = {};
  for (let i = 0; i < plan.length; i++) {
    const d = plan[i], g = got[i], L = out[d.league];
    const k = g && Array.isArray(L) ? L.findIndex((x) => x.id === d.id) : -1;
    if (k < 0) continue;
    const base = L[k];
    if (g.away.name !== base.away.name || g.home.name !== base.home.name) { detailErrors.push(`${d.league} ${d.id}: detail lists other teams than the list`); continue; }
    L[k] = { ...base, quotes: sortQuotes({ ...base.quotes, ...g.quotes }) };
    pulled[d.league] = (pulled[d.league] || 0) + 1;
  }
  if (stopped) detailErrors.push(`details stopped after ${stopped}`);
  errors.push(...detailErrors.sort());
  const details = Object.fromEntries(Object.keys(wanted).map((l) => [l, { wanted: wanted[l].length, pulled: pulled[l] || 0 }]));
  const wantN = Object.values(wanted).reduce((a, w) => a + w.length, 0);
  const skipped = wantN - plan.length;
  log(`polyus: ${stats.requests} requests (${listRequests} list, ${stats.requests - listRequests} event details for ${wantN} games${skipped > 0 ? `, ${skipped} over the cap of ${maxDetails}` : ''}), ${(stats.bytes / 1e6).toFixed(1)} MB${errors.length ? `; ${errors.slice(0, 5).join(' | ')}${errors.length > 5 ? ` (+${errors.length - 5})` : ''}` : ''}`);
  return { attemptAt: at, fetchedAt: at, cached: false, requests: stats.requests, errors, leagues: out, seen, details };
}
