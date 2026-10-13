// Gemini Predictions (Gemini Titan, a CFTC exchange) public REST: a reference price (vote) for the game lines. Keyless.
//
//   GET https://api.gemini.com/v1/prediction-markets/events?status=active&category=sports&sport=american_football
//       &sports_market_type=moneyline&sports_market_scope=full_contest&limit=100&offset=N
//
// One page lists every active NFL and college football game winner event (76 on 2026-10-13); each carries its full
// game spread ('-S') and total ('-T') events nested in `events`, with the same prices as their own listing, so one GET
// covers all three lines (about 7 MB, uncompressed). The `sport`, `sports_market_type` and `sports_market_scope`
// filters are the documented sports taxonomy (developer.gemini.com); without them the sports list is 650+ events of
// every sport. Pulled at most every 15 minutes (state/gemini.json, like Pinnacle). The REST snapshot has best bid and
// ask only, no sizes, so sizes are null. Fails open.
//
// Event tickers: NFL-2610130015-BUF-LAR-M (winner), -S (spread ladder), -T (total ladder); NCAAF-... for college.
// Winner: two contracts, one per team (sportsSide home/away); folded like Kalshi's two winner markets.
// Spread contracts: 'Los Angeles R wins by more than 3.5 points', strike { type: 'spread', value: '3.5' }, contract
// ticker = team abbreviation + floor(strike) ('LAR3'); no sportsSide, so the team comes from the ticker prefix (or
// the label) against the event's participants. Total contracts: 'More than 47.5 points scored', strike { type: 'over' }.

import { etDate } from '../match.mjs';
import { Q, flipQ, foldPair, half, isoS, getJson, spKey, totKey, sortQuotes, pullOrReuse, VENUE_ALIAS } from './common.mjs';
import { join } from 'node:path';

export const GEMINI_BASE = 'https://api.gemini.com/v1/prediction-markets';
export const GEMINI_QUERY = 'status=active&category=sports&sport=american_football&sports_market_type=moneyline&sports_market_scope=full_contest';
export const GEMINI_PAGE = 100;
export const GEMINI_MAX_PAGES = 3;
export const GEMINI_MIN_INTERVAL_MS = 15 * 60e3;
export const GEMINI_LEAGUE = Object.freeze({ NFL: 'nfl', NCAAF: 'cfb' });
// Gemini name (normalized) -> ESPN name, where the production matcher cannot pair them. Gemini gives a full name
// ('Middle Tennessee State Blue Raiders') and a short label ('Middle Tennessee'); the matcher tries both. 'Hawaii'
// (ESPN: Hawai'i) is in the shared table.
export const GEMINI_ALIAS = Object.freeze({ ...VENUE_ALIAS });
const STATE_FILE = 'gemini.json';
const STATE_VERSION = 1;

const live = (c) => c && (c.status == null || c.status === 'active') && (c.marketState == null || c.marketState === 'open');
const price = (c) => Q(c?.prices?.bestBid, c?.prices?.bestAsk);
const sides = (c) => ({ bid: c?.prices?.bestBid, ask: c?.prices?.bestAsk });   // one-sided allowed (for the fold)
const base = (ticker) => String(ticker || '').split('-').slice(0, 4).join('-');
const suffix = (ticker) => String(ticker || '').split('-').slice(4).join('-');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The ESPN side ('home' | 'away') a spread contract is about, from its ticker prefix or its label. */
function spreadSide(c, teams) {
  const prefix = String(c?.ticker || '').replace(/\d+$/, '').toUpperCase();
  for (const t of teams) if (t.abbr && prefix === t.abbr) return t.side;
  const label = norm(c?.label);
  const hits = teams.filter((t) => t.labels.some((l) => l && label.startsWith(`${l} wins by`)));
  return hits.length === 1 ? hits[0].side : null;
}

/**
 * List events (top level and nested) -> { nfl: [VenueGame], cfb: [VenueGame] }, games in ticker order.
 * VenueGame = { id: event base ticker, dateKey, kickoff, away: { name, alt }, home: { name, alt }, quotes }.
 */
export function parseGemini(events) {
  const all = new Map();
  const add = (e) => { if (e?.ticker && !all.has(e.ticker)) all.set(e.ticker, e); };
  for (const e of Array.isArray(events) ? events : []) { add(e); for (const n of Array.isArray(e?.events) ? e.events : []) add(n); }
  const byGame = new Map();
  for (const e of all.values()) {
    if (e.status && e.status !== 'active') continue;
    const b = base(e.ticker);
    if (!byGame.has(b)) byGame.set(b, {});
    byGame.get(b)[suffix(e.ticker)] = e;
  }
  const out = { nfl: [], cfb: [] };
  for (const b of [...byGame.keys()].sort()) {
    const parts = byGame.get(b);
    const M = parts.M;
    const league = GEMINI_LEAGUE[b.split('-')[0]];
    if (!M || !league) continue;
    const ps = Array.isArray(M.participants) ? M.participants : [];
    const hp = ps.find((p) => p?.side === 'home'), ap = ps.find((p) => p?.side === 'away');
    const cs = (Array.isArray(M.contracts) ? M.contracts : []).filter(live);
    const hc = cs.find((c) => c.sportsSide === 'home'), ac = cs.find((c) => c.sportsSide === 'away');
    if (!hp?.name || !ap?.name || !hc || !ac) continue;
    const kickoff = M.startTime;
    if (!Number.isFinite(Date.parse(kickoff))) continue;
    const teams = [
      { side: 'home', abbr: String(hp.abbreviation || hc.abbreviatedName || '').toUpperCase(), labels: [norm(hc.label), norm(hp.name)] },
      { side: 'away', abbr: String(ap.abbreviation || ac.abbreviatedName || '').toUpperCase(), labels: [norm(ac.label), norm(ap.name)] },
    ];
    const quotes = {};
    const put = (k, q) => { if (q && !quotes[k]) quotes[k] = q; };
    put('ml:home', foldPair(sides(hc), sides(ac)));
    const S = parts.S;
    for (const c of (Array.isArray(S?.contracts) ? S.contracts : []).filter(live)) {
      const s = Number(c?.strike?.value);
      if (c?.strike?.type !== 'spread' || !half(s) || s <= 0) continue;
      const side = spreadSide(c, teams);
      if (side) put(spKey(side, s), price(c));
    }
    const T = parts.T;
    for (const c of (Array.isArray(T?.contracts) ? T.contracts : []).filter(live)) {
      const s = Number(c?.strike?.value);
      if (!half(s)) continue;
      if (c?.strike?.type === 'over') put(totKey(s), price(c));
      else if (c?.strike?.type === 'under') put(totKey(s), flipQ(price(c)));
    }
    out[league].push({
      id: b, dateKey: etDate(kickoff), kickoff: isoS(Date.parse(kickoff)),
      away: { name: ap.name, alt: [ac.label].filter((x) => x && x !== ap.name) },
      home: { name: hp.name, alt: [hc.label].filter((x) => x && x !== hp.name) },
      quotes: sortQuotes(quotes),
    });
  }
  return out;
}

/**
 * fetchGeminiInputs({ fetchImpl, now, stateDir, log }) -> inputs.venues.gemini:
 *   { attemptAt, fetchedAt, cached, requests, errors, leagues: { nfl: [VenueGame] | null, cfb: ... } }
 * At most one pull per GEMINI_MIN_INTERVAL_MS (state/gemini.json; runs in between reuse it with cached: true).
 * Never throws for upstream failures.
 */
export async function fetchGeminiInputs({
  fetchImpl = globalThis.fetch, now = Date.now(), stateDir = null, log = () => {}, timeoutMs = 30000, retryDelayMs = 800,
  minIntervalMs = GEMINI_MIN_INTERVAL_MS, maxPages = GEMINI_MAX_PAGES,
} = {}) {
  return pullOrReuse({ path: stateDir ? join(stateDir, STATE_FILE) : null, now, minIntervalMs, version: STATE_VERSION, name: 'gemini', log }, async () => {
    const stats = { requests: 0, bytes: 0 };
    const errors = [];
    const events = [];
    let ok = false;
    for (let page = 0; page < maxPages; page++) {
      let body;
      try {
        body = await getJson(fetchImpl, `${GEMINI_BASE}/events?${GEMINI_QUERY}&limit=${GEMINI_PAGE}&offset=${page * GEMINI_PAGE}`, { timeoutMs, retryDelayMs, stats });
      } catch (e) {
        errors.push(String(e?.message || e).slice(0, 200));
        break;
      }
      if (!Array.isArray(body?.data)) { errors.push('expected a data list (format change?)'); break; }
      ok = true;
      events.push(...body.data);
      const total = Number(body.pagination?.total);
      if (body.data.length < GEMINI_PAGE || (Number.isFinite(total) && (page + 1) * GEMINI_PAGE >= total)) break;
    }
    const parsed = ok ? parseGemini(events) : null;
    log(`gemini: ${stats.requests} requests, ${(stats.bytes / 1e6).toFixed(1)} MB${errors.length ? `; ${errors.join(' | ')}` : ''}`);
    return { requests: stats.requests, errors, leagues: { nfl: parsed ? parsed.nfl : null, cfb: parsed ? parsed.cfb : null } };
  });
}
