// Exchange reference venues: Polymarket US, Gemini Predictions and SX Bet quote the same game lines as Kalshi. Only
// Kalshi is ever bet; these are VOTES (reference prices) for the engine's cross market truth, never targets here.
//
// Snapshot output (buildVenue, pure; ESPN home/away orientation even when a venue lists the teams the other way):
//   games[i].refs.venues = { polyus?: VenueQuotes, gemini?: VenueQuotes, sx?: VenueQuotes }   (pregame games only)
//   VenueQuotes = { fetchedAt, quotes: { [key]: { bid, ask, bidSize, askSize, sizeUnit } } }
//   keys: 'ml:home', 'sp:home:3.5', 'sp:away:3.5', 'tot:47.5' (lib/venues/common.mjs); trimmed to 'ml:home' plus the
//   spread and total keys that game's Kalshi markets list, since only Kalshi contracts are judged.
//   sources.<venue> = { ok, fetchedAt, cached, requests, matched, matchedByLeague, errors }   (optional, like Pinnacle)
// A venue that failed, was skipped, or matched nothing leaves no refs; nothing else in the snapshot depends on it.

import { matchGames, etDate, norm } from '../match.mjs';
import { half, reorient, sortQuotes, VENUE_MATCH_MIN } from './common.mjs';
import { fetchPolyUSInputs, POLY_ALIAS, POLYUS_LEAGUES } from './polyus.mjs';
import { fetchGeminiInputs, GEMINI_ALIAS } from './gemini.mjs';
import { fetchSxInputs, SX_ALIAS, SX_LEAGUES } from './sxbet.mjs';

/**
 * Every venue's role and cadence. Snapshot order of refs.venues follows VENUE_KEYS. markets: the contract kinds the
 * venue always lists for a league with games ('ml' winner, 'sp' spread, 'tot' total), for the format check.
 */
export const VENUES = Object.freeze({
  polyus: Object.freeze({ label: 'Polymarket US', role: 'vote', cadence: 'every run', leagues: POLYUS_LEAGUES, markets: Object.freeze(['ml', 'sp', 'tot']), alias: POLY_ALIAS, fetch: fetchPolyUSInputs }),
  gemini: Object.freeze({ label: 'Gemini Predictions', role: 'vote', cadence: '15 min', leagues: Object.freeze(['nfl', 'cfb']), markets: Object.freeze(['ml', 'sp', 'tot']), alias: GEMINI_ALIAS, fetch: fetchGeminiInputs }),
  sx: Object.freeze({ label: 'SX Bet', role: 'vote', offshore: true, cadence: '15 min', leagues: SX_LEAGUES, markets: Object.freeze(['ml']), alias: SX_ALIAS, fetch: fetchSxInputs }),
});
/** A format check fires only from this many listed events (or parsed games) up. */
export const DRIFT_MIN = 5;
const KIND_NAME = Object.freeze({ ml: 'winner', sp: 'spread', tot: 'total' });

/**
 * Format checks on one venue's parsed input -> error strings (none when it looks normal). A renamed market type,
 * status value or field makes a parser drop games or quotes silently, so:
 *   - R.seen[league] (events the fetcher saw listed) of DRIFT_MIN or more while the parser kept no game: an error;
 *   - DRIFT_MIN or more games kept, but no quote of a kind the venue always lists (VENUES[v].markets): an error.
 * An error sets sources.<venue>.ok to false (lib/build.mjs); whatever could still be read is kept.
 */
export function venueFormatErrors(venue, R) {
  const errors = [];
  const leagues = R && typeof R.leagues === 'object' && R.leagues ? R.leagues : {};
  const seen = R && typeof R.seen === 'object' && R.seen ? R.seen : {};
  for (const league of Object.keys(seen).sort()) {
    const n = Number(seen[league]);
    const kept = leagues[league];
    if (Number.isFinite(n) && n >= DRIFT_MIN && Array.isArray(kept) && !kept.length) errors.push(`${league}: ${n} ${venue} listings seen but none could be read (format change?)`);
  }
  for (const league of Object.keys(leagues).sort()) {
    const L = leagues[league];
    if (!Array.isArray(L) || L.length < DRIFT_MIN) continue;
    for (const kind of VENUES[venue]?.markets || []) {
      const n = L.reduce((a, g) => a + Object.keys(g?.quotes || {}).filter((k) => k.split(':')[0] === kind).length, 0);
      if (!n) errors.push(`${league}: ${L.length} ${venue} games but no ${KIND_NAME[kind]} quotes (format change?)`);
    }
  }
  return errors;
}
export const VENUE_KEYS = Object.freeze(Object.keys(VENUES));
const DAY = 86400e3;

/** The canonical keys of a game's Kalshi markets (the contracts a vote can be used on). */
export function kalshiKeys(game) {
  const keys = new Set(['ml:home']);
  for (const m of game?.kalshi?.markets || []) {
    const s = Number(m?.strike);
    if (m?.type === 'spread' && (m.team === 'home' || m.team === 'away') && half(s) && s > 0) keys.add(`sp:${m.team}:${s}`);
    else if (m?.type === 'total' && half(s)) keys.add(`tot:${s}`);
  }
  return keys;
}

/**
 * buildVenue(venue, R, { games, eventsByLeague, now, trim }) -> { refs: Map<gameId, VenueQuotes>, matched, unmatched, errors }
 *   R: inputs.venues[venue] ({ fetchedAt, leagues: { nfl: [VenueGame] | null, ... } }); games: snapshot games (refs only
 *   on 'pre' games); eventsByLeague: { nfl: [raw ESPN event] } (every event on the boards, post included).
 * Matching: lib/match.mjs (ET date +/- 1 day, both teams, the venue's alias table and alternate names), score >= 0.9.
 * matched: { league: games given refs }. unmatched: venue games dated inside the window that matched no ESPN game.
 * errors: venueFormatErrors (listed but unreadable games, a missing market kind) plus a league where nothing matched.
 * trim (default true): keep 'ml:home' and the keys the game's Kalshi markets list.
 */
export function buildVenue(venue, R, { games = [], eventsByLeague = {}, now, trim = true } = {}) {
  const refs = new Map();
  const unmatched = [];
  const matched = {};
  const errors = venueFormatErrors(venue, R);
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const dateLo = etDate(nowMs - DAY);
  const dateHi = etDate(nowMs + 10 * DAY);
  const alias = VENUES[venue]?.alias || {};
  const fix = (n) => alias[norm(n)] || n;
  for (const league of Object.keys(R?.leagues || {}).sort()) {
    const L = R.leagues[league];
    if (!Array.isArray(L)) continue;
    matched[league] = 0;
    const list = L.map((g) => ({
      eventTicker: `${venue}:${g.id}`, dateKey: g.dateKey, g,
      away: { name: fix(g.away?.name), code: '', alt: (g.away?.alt || []).map(fix) },
      home: { name: fix(g.home?.name), code: '', alt: (g.home?.alt || []).map(fix) },
    }));
    const r = matchGames(list, eventsByLeague[league] || [], league);
    const byEspn = new Map();
    for (const [id, v] of r.matches) if (v.score >= VENUE_MATCH_MIN) byEspn.set(String(v.espnEvent.id), { id, flipped: v.flipped });
    const taken = new Set([...byEspn.values()].map((v) => v.id));
    const byTicker = new Map(list.map((k) => [k.eventTicker, k.g]));
    let inWindow = 0;
    for (const k of list) {
      if (!(k.dateKey >= dateLo && k.dateKey <= dateHi)) continue;
      inWindow++;
      if (!taken.has(k.eventTicker)) unmatched.push(`${league}: ${k.g.away?.name} @ ${k.g.home?.name} ${k.dateKey}`);
    }
    let pre = 0;
    for (const g of games) {
      if (g.league !== league || g.state !== 'pre') continue;
      pre++;
      const hit = byEspn.get(String(g.espnId));
      if (!hit) continue;
      const vg = byTicker.get(hit.id);
      const quotes = sortQuotes(hit.flipped ? reorient(vg.quotes) : vg.quotes, trim ? kalshiKeys(g) : null);
      if (!Object.keys(quotes).length) continue;
      refs.set(g.id, { fetchedAt: R.fetchedAt ?? null, quotes });
      matched[league]++;
    }
    // The venue lists games for these dates and ESPN lists games, but none paired: a name or format change.
    if (!matched[league] && inWindow >= 5 && pre >= 5) errors.push(`${league}: none of ${inWindow} ${venue} games matched any of ${pre} pregame games (team name format change?)`);
  }
  unmatched.sort();
  return { refs, matched, unmatched, errors };
}

/** Fetch one venue (each venue's own module and cadence). Never throws for upstream failures. */
export function fetchVenueInputs(venue, opts) {
  return VENUES[venue].fetch(opts);
}
