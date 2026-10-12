// buildSnapshot: PURE function from already-fetched raw responses to snapshot v1 (SPEC section 3).
// No network, no clock reads (pass `now`), no randomness: same inputs give the same output, so tests run offline.
//
// inputs = {
//   kalshi:   { fetchedAt, requests, errors: [fetch errors], markets: { KXNFLGAME: [rawMarket], ... } },  // one array per series fetched
//   series:   { fetchedAt, errors, data: { KXNFLGAME: rawSeriesObject, ... } },                         // GET /series/{t} -> .series
//   combos:   { fetchedAt, errors, collections: [rawCollection] },                                     // GET /multivariate_event_collections?status=open
//   espn:     { fetchedAt, requests, errors, scoreboards: { nfl: [json, json], cfb: [json, json] } },  // default week + next week
//   injuries: { fetchedAt, requests, errors, leagues: ['nfl'], summaries: { [espnEventId]: summaryJson } },
//   // Phase B (optional, additive): props, nflverse. Absent => sources.X.ok = false, 'not implemented yet'.
//   props:    { ... },   nflverse: { ... },
// }
// Any missing key degrades that source to ok=false; buildSnapshot never throws on missing or partial inputs.

import {
  CORE_SERIES, DEFAULT_FEE, buildKalshiGames, trimMarket, feeFromSeries,
  pickCollection, collectionEventTickers, parseEventTicker,
} from './kalshi.mjs';
import { parseScoreboardEvents, parseOdds, parseTeam, parseWeather, parseSummaryInjuries, iso } from './espn.mjs';
import { matchGames, etDate } from './match.mjs';

export const SNAPSHOT_VERSION = 1;
export const LEAGUE_KEYS = ['nfl', 'cfb'];
// SPEC: include 'pre' or 'in' games whose kickoff is within the next 9 days or the last 6 hours. Drop 'post'.
export const WINDOW = { aheadMs: 9 * 86400e3, behindMs: 6 * 3600e3 };
const MAX_ERRORS = 40;

function toMs(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`buildSnapshot: bad now ${t}`);
  return ms;
}

function capErrors(list) {
  const uniq = [...new Set(list.filter(Boolean).map((x) => String(x).slice(0, 300)))];
  return uniq.length <= MAX_ERRORS ? uniq : [...uniq.slice(0, MAX_ERRORS), `...and ${uniq.length - MAX_ERRORS} more`];
}

const TYPE_RANK = { game: 0, spread: 1, total: 2 };
const TEAM_RANK = { away: 0, home: 1 };
function marketOrder(a, b) {
  return (TYPE_RANK[a.type] - TYPE_RANK[b.type])
    || ((TEAM_RANK[a.team] ?? 2) - (TEAM_RANK[b.team] ?? 2))
    || ((a.strike ?? 0) - (b.strike ?? 0))
    || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0);
}

function makeGame(ev, hit, { oddsFetchedAt, injuries }) {
  const home = parseTeam(ev.homeComp);
  const away = parseTeam(ev.awayComp);
  const kalshi = { gameEvent: null, spreadEvent: null, totalEvent: null, markets: [] };
  if (hit) {
    const { kg, flipped } = hit;
    // Kalshi orders teams away+home; at neutral sites ESPN can list them the other way round (flipped).
    const homeK = flipped ? kg.away : kg.home;
    const awayK = flipped ? kg.home : kg.away;
    home.kalshiCode = homeK.code;
    away.kalshiCode = awayK.code;
    const sideOf = (code) => (code === homeK.code ? 'home' : code === awayK.code ? 'away' : null);
    kalshi.gameEvent = kg.eventTicker;
    kalshi.spreadEvent = kg.spreadEvent;
    kalshi.totalEvent = kg.totalEvent;
    kalshi.markets = kg.legs
      .map((l) => trimMarket(l.m, { type: l.type, team: l.type === 'total' ? null : sideOf(l.code), strike: l.strike }))
      .sort(marketOrder);
  }
  return {
    id: `${ev.league}-${ev.id}`,
    league: ev.league,
    espnId: ev.id,
    season: ev.season,
    seasonType: ev.seasonType,
    week: ev.week,
    kickoff: ev.kickoff,
    state: ev.state,
    neutral: ev.neutral,
    home,
    away,
    odds: parseOdds(ev.comp, oddsFetchedAt),
    kalshi,
    injuries: {
      home: (injuries && injuries.get(home.espnId)) || [],
      away: (injuries && injuries.get(away.espnId)) || [],
    },
    weather: parseWeather(ev.raw, ev.comp),
  };
}

// ---------------------------------------------------------------- phase B extension points
// Replace these bodies (or import real builders) in phase B; keep the signatures. ctx gives read access to the
// built games so props can attach to game ids, and defense/players can key on team abbreviations
// (matchup angles such as "RB vs a top run defense" or "WR vs a bottom-5 pass defense" read snapshot.defense
// and snapshot.players; the engine computes the tags).

const notYet = (extra = {}) => ({ ok: false, fetchedAt: null, ...extra, errors: ['not implemented yet'] });

export function buildPropsSection(input, ctx) { // eslint-disable-line no-unused-vars
  return { props: [], source: notYet() };
}

export function buildNflverseSection(input, ctx) { // eslint-disable-line no-unused-vars
  return {
    defense: { nfl: {}, cfb: {} },
    players: {},
    source: { ok: false, asOf: null, season: null, throughWeek: null, errors: ['not implemented yet'] },
  };
}

// ---------------------------------------------------------------- main

/**
 * buildSnapshot(inputs, { now, version, runMs, leagues }) -> snapshot v1
 * now: ms or ISO; it sets generatedAt and the game window. leagues: default ['nfl', 'cfb'].
 */
export function buildSnapshot(inputs = {}, opts = {}) {
  const now = toMs(opts.now ?? Date.now());
  const K = inputs.kalshi || null;
  const E = inputs.espn || null;
  const S = inputs.series || null;
  const C = inputs.combos || null;
  const I = inputs.injuries || null;

  const errs = {
    kalshi: [...(K?.errors || [])],
    espnOdds: [...(E?.errors || [])],
    injuries: [...(I?.errors || [])],
    combos: [...(C?.errors || [])],
    fees: [...(S?.errors || [])],
  };

  // opts.leagues limits the snapshot to some leagues (offline fixtures that captured only NFL). Default: both.
  const leagues = LEAGUE_KEYS.filter((l) => !opts.leagues || opts.leagues.includes(l));
  const kMarkets = K?.markets || {};
  const coreSeries = leagues.flatMap((l) => Object.values(CORE_SERIES[l]));
  const missingSeries = coreSeries.filter((s) => !Array.isArray(kMarkets[s]));
  if (!K) errs.kalshi.push('no Kalshi data');
  else if (missingSeries.length) errs.kalshi.push(`missing series: ${missingSeries.join(', ')}`);
  const espnLeaguesMissing = leagues.filter((l) => !(E?.scoreboards?.[l] || []).length);
  if (!E) errs.espnOdds.push('no ESPN data');
  else if (espnLeaguesMissing.length) errs.espnOdds.push(`no scoreboard for: ${espnLeaguesMissing.join(', ')}`);

  // Injuries (game summaries). Leagues not listed in inputs.injuries.leagues are not fetched (CFB is phase B).
  const injuryMaps = new Map();
  for (const [id, summary] of Object.entries(I?.summaries || {})) {
    try { injuryMaps.set(String(id), parseSummaryInjuries(summary)); } catch (e) { errs.injuries.push(`summary ${id}: ${e.message}`); }
  }
  const injuryLeagues = new Set(I?.leagues || []);

  const lo = now - WINDOW.behindMs;
  const hi = now + WINDOW.aheadMs;
  const dateLo = etDate(now - 86400e3);
  const dateHi = etDate(hi + 86400e3);

  const games = [];
  const unmatched = { kalshi: [], espn: [] };

  for (const league of leagues) {
    const ser = CORE_SERIES[league];
    const kb = buildKalshiGames(kMarkets[ser.game] || [], kMarkets[ser.spread] || [], kMarkets[ser.total] || []);
    errs.kalshi.push(...kb.errors);
    const events = parseScoreboardEvents(E?.scoreboards?.[league] || [], league);

    // Match against ALL ESPN events (post included), then window. Otherwise games that finished today
    // would show up as unmatched Kalshi games instead of being dropped.
    const m = matchGames([...kb.games.values()], events.map((e) => e.raw), league);
    const byEspn = new Map();
    for (const [et, r] of m.matches) byEspn.set(String(r.espnEvent.id), { kg: kb.games.get(et), flipped: r.flipped, score: r.score });

    for (const ev of events) {
      if (ev.state !== 'pre' && ev.state !== 'in') continue;
      if (!(ev.kickoffMs >= lo && ev.kickoffMs <= hi)) continue;
      const hit = byEspn.get(ev.id) || null;
      if (!hit) unmatched.espn.push(ev.id);
      if (injuryLeagues.has(league) && !injuryMaps.has(ev.id)) errs.injuries.push(`no summary for ${league} ${ev.id}`);
      games.push(makeGame(ev, hit, { oddsFetchedAt: E?.fetchedAt ?? null, injuries: injuryMaps.get(ev.id) }));
    }
    // Diagnostics: Kalshi games or orphan ladders dated inside the window that matched no ESPN FBS/NFL game (mostly FCS).
    for (const kg of m.unmatchedKalshi) if (kg.dateKey >= dateLo && kg.dateKey <= dateHi) unmatched.kalshi.push(kg.eventTicker);
    for (const et of kb.orphans) {
      const p = parseEventTicker(et);
      if (p && p.dateKey >= dateLo && p.dateKey <= dateHi) unmatched.kalshi.push(et);
    }
  }

  games.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.league.localeCompare(b.league) || a.espnId.localeCompare(b.espnId));
  unmatched.kalshi.sort();
  unmatched.espn.sort();

  const ctx = { now, games, gameById: new Map(games.map((g) => [g.id, g])) };
  const propsPart = buildPropsSection(inputs.props, ctx);
  const nflversePart = buildNflverseSection(inputs.nflverse, ctx);

  // Fees: every core series plus any other series we were given (props series in phase B).
  const fees = {};
  const seriesData = S?.data || {};
  const feeMissing = [];
  for (const s of [...new Set([...coreSeries, ...Object.keys(seriesData)])].sort()) {
    const f = feeFromSeries(seriesData[s]);
    if (f) fees[s] = f;
    else { fees[s] = { ...DEFAULT_FEE, assumed: true }; feeMissing.push(s); }
  }
  if (feeMissing.length) errs.fees.push(`no series info for ${feeMissing.join(', ')}; assumed ${DEFAULT_FEE.feeType} x${DEFAULT_FEE.multiplier}`);

  // Combo eligibility: event tickers of this snapshot that the open collection accepts.
  const collection = pickCollection(C?.collections || []);
  if (C && !collection) errs.combos.push('no open combo collection');
  if (!C) errs.combos.push('not fetched');
  const snapshotEvents = new Set();
  for (const g of games) for (const e of [g.kalshi.gameEvent, g.kalshi.spreadEvent, g.kalshi.totalEvent]) if (e) snapshotEvents.add(e);
  for (const p of propsPart.props) if (p?.kalshiEvent) snapshotEvents.add(p.kalshiEvent);
  const comboEligible = [...new Set(collectionEventTickers(collection).filter((t) => snapshotEvents.has(t)))].sort();

  const sources = {
    kalshi: {
      ok: !!K && !(K.errors || []).length && !missingSeries.length,
      fetchedAt: K?.fetchedAt ?? null,
      requests: K?.requests ?? 0,
      errors: capErrors(errs.kalshi),
    },
    espnOdds: {
      ok: !!E && !(E.errors || []).length && !espnLeaguesMissing.length,
      fetchedAt: E?.fetchedAt ?? null,
      ...(E?.requests != null ? { requests: E.requests } : {}),
      errors: capErrors(errs.espnOdds),
    },
    injuries: I
      ? {
        ok: errs.injuries.length === 0,
        fetchedAt: I.fetchedAt ?? null,
        ...(I.requests != null ? { requests: I.requests } : {}),
        leagues: [...injuryLeagues].sort(),
        notes: ['starter and depthRank are null until depth charts are added (phase B)', ...(injuryLeagues.has('cfb') ? [] : ['CFB injuries pending phase B'])],
        errors: capErrors(errs.injuries),
      }
      : { ok: false, fetchedAt: null, errors: ['pending phase B'] },
    props: { ...propsPart.source, errors: capErrors(propsPart.source.errors || []) },
    nflverse: { ...nflversePart.source, errors: capErrors(nflversePart.source.errors || []) },
    combos: {
      ok: !!C && !(C.errors || []).length && !!collection,
      fetchedAt: C?.fetchedAt ?? null,
      collection: collection?.collection_ticker ?? null,
      errors: capErrors(errs.combos),
    },
    // Not in the SPEC list (additive): lets the engine see that fees are defaults rather than fetched values.
    fees: {
      ok: !!S && !(S.errors || []).length && !feeMissing.length,
      fetchedAt: S?.fetchedAt ?? null,
      errors: capErrors(errs.fees),
    },
  };

  return {
    v: SNAPSHOT_VERSION,
    generatedAt: iso(now),
    collector: { version: String(opts.version ?? '0.0.0'), runMs: Number.isFinite(opts.runMs) ? Math.round(opts.runMs) : null },
    sources,
    fees,
    games,
    props: propsPart.props,
    defense: nflversePart.defense,
    players: nflversePart.players,
    comboEligible,
    unmatched,
  };
}

/** Counts for logs and reports. */
export function summarize(snapshot) {
  const out = { games: snapshot.games.length, byLeague: {}, markets: 0, marketsByType: { game: 0, spread: 0, total: 0 }, withOdds: 0, withKalshi: 0, withLadders: 0 };
  for (const g of snapshot.games) {
    const b = (out.byLeague[g.league] ||= { games: 0, withKalshi: 0, withOdds: 0, markets: 0, pre: 0, in: 0 });
    b.games++;
    b[g.state] = (b[g.state] || 0) + 1;
    if (g.kalshi.gameEvent) { b.withKalshi++; out.withKalshi++; }
    if (g.odds) { b.withOdds++; out.withOdds++; }
    if (g.kalshi.spreadEvent || g.kalshi.totalEvent) out.withLadders++;
    b.markets += g.kalshi.markets.length;
    out.markets += g.kalshi.markets.length;
    for (const m of g.kalshi.markets) out.marketsByType[m.type]++;
  }
  out.unmatchedKalshi = snapshot.unmatched.kalshi.length;
  out.unmatchedEspn = snapshot.unmatched.espn.length;
  out.comboEligible = snapshot.comboEligible.length;
  return out;
}
