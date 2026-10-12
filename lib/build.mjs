// buildSnapshot / buildRun: PURE functions from already-fetched raw responses to snapshot v1 (SPEC sections 3 and 10.1).
// No network, no clock reads (pass `now`), no randomness: same inputs give the same output, so tests run offline.
//
// inputs = {
//   kalshi:     { fetchedAt, requests, errors: [fetch errors], markets: { KXNFLGAME: [rawMarket], ... } },  // one array per core series
//   series:     { fetchedAt, errors, data: { KXNFLGAME: rawSeriesObject, ... } },                         // GET /series/{t} -> .series
//   combos:     { fetchedAt, errors, collections: [rawCollection] },                                     // GET /multivariate_event_collections?status=open
//   espn:       { fetchedAt, requests, errors, scoreboards: { nfl: [json, json], cfb: [json, json] } },  // default week + next week
//   injuries:   { fetchedAt, requests, errors, leagues: ['nfl'], summaries: { [espnEventId]: summaryJson } },  // fallback only
//   // Phase B (each optional; absent => that source is ok=false 'not fetched' and its fields stay empty):
//   injuryFeed: lib/injuries.mjs fetchInjuryInputs()   (league feed + depth charts + schedule)
//   props:      lib/props.mjs fetchPropInputs()          (Kalshi prop ladders + ESPN DK propBets)
//   teamTotals: lib/teamtotals.mjs fetchTeamTotalInputs()
//   nflverse:   lib/nflverse.mjs fetchNflverseInputs()   (CSV texts)
//   cfb:        lib/cfb.mjs fetchCfbInputs()
//   pinnacle:   lib/pinnacle.mjs fetchPinnacleInputs()  (Pinnacle guest feed, trimmed; refs.pinnacle on matched games)
//   history:    state/history.json from the previous run (lib/moves.mjs), or null on a first run
//   stats:      collectInputs() stats ({ bySource: { name: { requests, ms } } }), for collector.timings
// }
// Any missing key degrades that source to ok=false; buildSnapshot never throws on missing or partial inputs.
//
// Assembly order (the modules depend on each other): ID bridge (nflverse roster) -> props -> injuries (graded per
// game, prop players included) -> nflverse defense + player contexts -> team totals -> CFB -> moves and closes.

import {
  CORE_SERIES, DEFAULT_FEE, buildKalshiGames, trimMarket, feeFromSeries,
  pickCollection, collectionEventTickers, parseEventTicker,
} from './kalshi.mjs';
import { parseScoreboardEvents, parseOdds, parseTeam, parseWeather, parseSummaryInjuries, iso } from './espn.mjs';
import { matchGames, etDate } from './match.mjs';
import { buildProps, PROP_SERIES_LIST } from './props.mjs';
import { buildTeamTotals, TEAM_TOTAL_SERIES } from './teamtotals.mjs';
import { buildInjuries, trimDepth, depthSpot } from './injuries.mjs';
import { buildNflverse, rosterBridge, propPlayersFromProps } from './nflverse.mjs';
import { buildCfb, cfbQbAngles } from './cfb.mjs';
import { updateHistory, historyInput, applyMoves } from './moves.mjs';
import { closesFromTransition } from './closes.mjs';
import { buildPinnacle } from './pinnacle.mjs';

export const SNAPSHOT_VERSION = 1;
export const LEAGUE_KEYS = ['nfl', 'cfb'];
// SPEC: include 'pre' or 'in' games whose kickoff is within the next 9 days or the last 6 hours. Drop 'post'.
export const WINDOW = { aheadMs: 9 * 86400e3, behindMs: 6 * 3600e3 };
const MAX_ERRORS = 40;

// ---------------------------------------------------------------- plausibility (empty or unquoted data is flagged)
// A fetch can succeed and still carry nothing usable (ESPN serving events: [] during an incident, a renamed field).
// These gates turn that into ok=false with an error, so the site shows the source as down instead of an empty slate.

/** Cross-run checks look at the previous run only when it is this recent; HOLD: when a run must not be posted. */
export const PLAUSIBILITY = Object.freeze({
  prevMaxAgeMs: 6 * 3600e3,   // compare with the previous run only when it is at most this old
  vanishMin: 5,               // a league is flagged when at least this many of the previous run's upcoming games vanish
  vanishShare: 0.5,           //   and they are at least this share of them
  holdMinGames: 10,           // 0 games now, while the previous run had at least this many upcoming: do not post
  quoteMin: 10,               // at least this many markets (or rungs) and none with any price: flagged
});

/**
 * ESPN games the previous run saw as pregame that kick off after `now` (so they must still be listed), by league.
 * prev = history.json of the previous run (lib/moves.mjs). -> { at, byLeague: { nfl: Set(gameId) }, total } | null
 */
export function previousUpcoming(prev, now, { maxAgeMs = PLAUSIBILITY.prevMaxAgeMs } = {}) {
  try {
    const at = Date.parse(prev?.at);
    if (!Number.isFinite(at) || !(now - at >= 0 && now - at <= maxAgeMs)) return null;
    const byLeague = {};
    let total = 0;
    for (const [id, e] of Object.entries(prev?.games || {})) {
      if (!e || e.seen !== prev.at || e.state !== 'pre' || !(Date.parse(e.kickoff) > now)) continue;
      (byLeague[e.league || String(id).split('-')[0]] ||= new Set()).add(id);
      total++;
    }
    return { at: prev.at, byLeague, total };
  } catch {
    return null; // an unreadable history only turns the cross-run checks off
  }
}

/** One league's ESPN boards: format and outage checks -> error strings (none when they look normal). */
function espnBoardProblems(league, boards, events) {
  if (!boards.length) return []; // the fetch failed: already an error
  const cur = boards[0]; // the default (current week) board
  if (!Array.isArray(cur?.events)) return [`${league}: the scoreboard has no events list (ESPN format change?)`];
  const ids = new Set();
  let noId = 0;
  for (const b of boards) for (const ev of Array.isArray(b?.events) ? b.events : []) { if (ev?.id != null) ids.add(String(ev.id)); else noId++; }
  const raw = ids.size + noId;
  const unreadable = raw - events.length;
  if (raw > 0 && events.length === 0) return [`${league}: ${raw} scoreboard events but none could be read (ESPN format change?)`];
  if (unreadable >= 3 && unreadable * 4 >= raw) return [`${league}: ${unreadable} of ${raw} scoreboard events could not be read (ESPN format change?)`];
  const seasonType = Number(cur?.season?.type ?? cur?.leagues?.[0]?.season?.type?.type);
  if (cur.events.length === 0 && (seasonType === 2 || seasonType === 3)) {
    return [`${league}: the current ${seasonType === 3 ? 'postseason' : 'regular season'} week lists no games (ESPN outage?)`];
  }
  return [];
}

const hasQuote = (m) => [m?.yesAsk, m?.yesBid, m?.noAsk, m?.noBid, m?.lastPrice].some((x) => x != null);

function toMs(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`buildSnapshot: bad now ${t}`);
  return ms;
}

function capErrors(list, max = MAX_ERRORS) {
  const uniq = [...new Set(list.filter(Boolean).map((x) => String(x).slice(0, 300)))];
  return uniq.length <= max ? uniq : [...uniq.slice(0, max), `...and ${uniq.length - max} more`];
}

const TYPE_RANK = { game: 0, spread: 1, total: 2, teamTotal: 3 };
const TEAM_RANK = { away: 0, home: 1 };
function marketOrder(a, b) {
  return ((TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9))
    || ((TEAM_RANK[a.team] ?? 2) - (TEAM_RANK[b.team] ?? 2))
    || ((a.strike ?? 0) - (b.strike ?? 0))
    || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0);
}

function makeGame(ev, hit, { oddsFetchedAt, injuries }) {
  const home = parseTeam(ev.homeComp);
  const away = parseTeam(ev.awayComp);
  if (ev.league === 'cfb') {
    // The engine labels read shortName: for colleges that is the school ("Ohio State wins"), ESPN team.location.
    home.shortName = ev.homeComp?.team?.location || home.shortName;
    away.shortName = ev.awayComp?.team?.location || away.shortName;
  }
  const kalshi = { gameEvent: null, spreadEvent: null, totalEvent: null, teamTotalEvent: null, markets: [] };
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
    dkTeamTotals: null,
    kalshi,
    injuries: {
      home: (injuries && injuries.get(home.espnId)) || [],
      away: (injuries && injuries.get(away.espnId)) || [],
    },
    angles: [],
    moves: [],
    weather: parseWeather(ev.raw, ev.comp),
  };
}

const notFetched = (extra = {}) => ({ ok: false, fetchedAt: null, ...extra, errors: ['not fetched'] });

/** Depth charts keyed by ESPN team id, trimmed (raw ESPN or already trimmed input). */
function depthCharts(feed, errors) {
  const out = new Map();
  for (const [id, d] of Object.entries(feed?.depth || {})) {
    if (!d || d.error) continue;
    try { out.set(String(id), trimDepth(d, id)); } catch (e) { errors.push(`depth ${id}: ${String(e?.message || e).slice(0, 120)}`); }
  }
  return out;
}

/** Depth chart athletes as a fallback roster for the props join: { [ESPN abbr]: [{ id, name, jersey: null, pos }] }. */
function depthRosters(depth, games) {
  const abbrOf = new Map();
  for (const g of games) for (const s of ['home', 'away']) if (g[s]?.espnId && g[s]?.abbr) abbrOf.set(String(g[s].espnId), g[s].abbr);
  const out = {};
  for (const [id, dc] of depth) {
    const abbr = abbrOf.get(id) || dc.abbr;
    if (!abbr) continue;
    const seen = new Set();
    const list = [];
    for (const group of [dc.offense, dc.defense]) {
      for (const slot of Object.keys(group || {}).sort()) {
        for (const p of group[slot] || []) {
          if (!p?.id || seen.has(String(p.id))) continue;
          seen.add(String(p.id));
          list.push({ id: String(p.id), name: p.name || '', jersey: null, pos: p.pos || null });
        }
      }
    }
    out[abbr] = list;
  }
  return out;
}

// ---------------------------------------------------------------- main

/**
 * buildRun(inputs, { now, version, runMs, leagues }) -> { snapshot, history, closes, hold }
 *   snapshot  snapshot v1 (SPEC 3 + 10.1)
 *   history   the updated line-move history to save as state/history.json (lib/moves.mjs)
 *   closes    last pregame DK lines of games that kicked off since the previous run (lib/closes.mjs entries)
 *   hold      null, or { reason, prevAt, prevUpcoming } when this run has no games at all while the previous run
 *             (inputs.history, at most PLAUSIBILITY.prevMaxAgeMs old) listed holdMinGames or more upcoming games: the
 *             caller should not post it over the last good snapshot, and should not save the run-to-run state
 * now: ms or ISO; it sets generatedAt, the game window and the move timestamps. leagues: default ['nfl', 'cfb'].
 */
export function buildRun(inputs = {}, opts = {}) {
  const now = toMs(opts.now ?? Date.now());
  const K = inputs.kalshi || null;
  const E = inputs.espn || null;
  const S = inputs.series || null;
  const C = inputs.combos || null;
  const I = inputs.injuries || null;
  const IF = inputs.injuryFeed || null;
  const PR = inputs.props || null;
  const TT = inputs.teamTotals || null;
  const NV = inputs.nflverse || null;
  const CF = inputs.cfb || null;
  const PN = inputs.pinnacle || null;

  const errs = {
    kalshi: [...(K?.errors || [])],
    espnOdds: [...(E?.errors || [])],
    injuries: [...(IF?.errors || [])],
    combos: [...(C?.errors || [])],
    fees: [...(S?.errors || [])],
    props: [],
    teamTotals: [],
    nflverse: [...(NV?.errors || [])],
    cfb: [...(CF?.errors || [])],
    pinnacle: [...(PN?.errors || [])],
  };

  // Plausibility flags (see espnBoardProblems, previousUpcoming): the source is ok=false and the message is in its errors.
  const bad = { kalshi: false, espnOdds: false, props: false, teamTotals: false };
  const flag = (key, msg) => { bad[key] = true; errs[key].push(msg); };

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

  // Summary injuries (5 per team): the fallback when the league injuries feed failed (or was not fetched).
  // Their errors count only when they are the injury source (no feed, or the feed's league request failed).
  const summariesUsed = !!I && !IF?.league;
  const summaryErrs = [...(I?.errors || [])];
  const injuryMaps = new Map();
  for (const [id, summary] of Object.entries(I?.summaries || {})) {
    try { injuryMaps.set(String(id), parseSummaryInjuries(summary)); } catch (e) { summaryErrs.push(`summary ${id}: ${e.message}`); }
  }
  const injuryLeagues = new Set(I?.leagues || []);

  const lo = now - WINDOW.behindMs;
  const hi = now + WINDOW.aheadMs;
  const dateLo = etDate(now - 86400e3);
  const dateHi = etDate(hi + 86400e3);

  const games = [];
  const unmatched = { kalshi: [], espn: [] };
  const allEvents = {};

  for (const league of leagues) {
    const ser = CORE_SERIES[league];
    const kb = buildKalshiGames(kMarkets[ser.game] || [], kMarkets[ser.spread] || [], kMarkets[ser.total] || []);
    errs.kalshi.push(...kb.errors);
    const boards = Array.isArray(E?.scoreboards?.[league]) ? E.scoreboards[league] : [];
    const events = parseScoreboardEvents(boards, league);
    allEvents[league] = events;
    for (const msg of espnBoardProblems(league, boards, events)) flag('espnOdds', msg);

    // Match against ALL ESPN events (post included), then window. Otherwise games that finished today
    // would show up as unmatched Kalshi games instead of being dropped.
    const m = matchGames([...kb.games.values()], events.map((e) => e.raw), league);
    const byEspn = new Map();
    for (const [et, r] of m.matches) byEspn.set(String(r.espnEvent.id), { kg: kb.games.get(et), flipped: r.flipped, score: r.score });

    let inWindow = 0, matchedInWindow = 0, kalshiInWindow = 0;
    for (const ev of events) {
      if (ev.state !== 'pre' && ev.state !== 'in') continue;
      if (!(ev.kickoffMs >= lo && ev.kickoffMs <= hi)) continue;
      const hit = byEspn.get(ev.id) || null;
      inWindow++;
      if (hit) matchedInWindow++;
      if (!hit) unmatched.espn.push(ev.id);
      if (injuryLeagues.has(league) && !injuryMaps.has(ev.id)) summaryErrs.push(`no summary for ${league} ${ev.id}`);
      games.push(makeGame(ev, hit, { oddsFetchedAt: E?.fetchedAt ?? null, injuries: injuryMaps.get(ev.id) }));
    }
    // Diagnostics: Kalshi games or orphan ladders dated inside the window that matched no ESPN FBS/NFL game (mostly FCS).
    for (const kg of m.unmatchedKalshi) if (kg.dateKey >= dateLo && kg.dateKey <= dateHi) { unmatched.kalshi.push(kg.eventTicker); kalshiInWindow++; }
    // Kalshi lists games for these dates and ESPN lists games, but not one pair matched: a ticker or name format change.
    if (!matchedInWindow && inWindow >= 5 && kalshiInWindow >= 5) {
      flag('kalshi', `${league}: none of ${kalshiInWindow} Kalshi games matched any of ${inWindow} ESPN games (ticker or team name format change?)`);
    }
    for (const et of kb.orphans) {
      const p = parseEventTicker(et);
      if (p && p.dateKey >= dateLo && p.dateKey <= dateHi) unmatched.kalshi.push(et);
    }
  }

  games.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.league.localeCompare(b.league) || a.espnId.localeCompare(b.espnId));

  // Games the previous run saw as upcoming that are gone now (ESPN answering 200 with an empty or partial list).
  const prevUp = previousUpcoming(inputs.history ?? null, now);
  const listed = new Set(games.map((g) => g.id));
  for (const league of leagues) {
    const ids = [...(prevUp?.byLeague?.[league] || [])];
    const gone = ids.filter((id) => !listed.has(id)).length;
    if (gone >= PLAUSIBILITY.vanishMin && gone >= ids.length * PLAUSIBILITY.vanishShare) {
      flag('espnOdds', `${league}: ${gone} of the ${ids.length} upcoming games listed in the previous run (${prevUp.at}) are missing from the scoreboards`);
    }
  }
  // Markets with no price at all (a renamed price field reads as null everywhere).
  const coreMarkets = games.flatMap((g) => g.kalshi.markets);
  if (coreMarkets.length >= PLAUSIBILITY.quoteMin && !coreMarkets.some(hasQuote)) {
    flag('kalshi', `${coreMarkets.length} markets on matched games but none has a price (Kalshi format change?)`);
  }
  // Nothing to show while the previous run had a full slate: the caller should not post this over the last good one.
  const prevUpcomingInLeagues = leagues.reduce((a, l) => a + (prevUp?.byLeague?.[l]?.size || 0), 0);
  const hold = !games.length && prevUpcomingInLeagues >= PLAUSIBILITY.holdMinGames
    ? { reason: `no games in this run, but the previous run (${prevUp.at}) listed ${prevUpcomingInLeagues} upcoming games`, prevAt: prevUp.at, prevUpcoming: prevUpcomingInLeagues }
    : null;
  unmatched.kalshi.sort();
  unmatched.espn.sort();
  if (summariesUsed) errs.injuries.push(...summaryErrs);
  const gameById = new Map(games.map((g) => [g.id, g]));
  const nflGames = games.filter((g) => g.league === 'nfl');

  // ---- 1. ID bridge (nflverse roster_weekly) and depth charts (props fallback roster, depth roles)
  let bridge = null;
  if (NV) {
    try { bridge = rosterBridge(NV); } catch (e) { errs.nflverse.push(`bridge: ${String(e?.message || e).slice(0, 160)}`); }
  }
  const depth = depthCharts(IF, errs.injuries);

  // Each optional builder runs guarded: a throw (an upstream shape nobody has seen yet) costs only that source, which
  // is reported ok=false with 'build failed: ...'; the core games and markets are still posted.
  const crashed = new Set();
  const guard = (key, fn) => {
    try { return fn(); } catch (e) {
      crashed.add(key);
      errs[key].push(`build failed: ${String(e?.message || e).slice(0, 200)}`);
      return null;
    }
  };

  // ---- 2. props
  let props = [];
  let propsRes = null;
  if (PR && leagues.includes('nfl')) {
    propsRes = guard('props', () => buildProps(PR, { games: nflGames, bridge, rosters: depth.size ? depthRosters(depth, nflGames) : null, now }));
    if (propsRes) {
      props = propsRes.props;
      errs.props.push(...propsRes.errors);
      const rungs = props.flatMap((p) => p.rungs || []);
      if (rungs.length >= PLAUSIBILITY.quoteMin && !rungs.some(hasQuote)) flag('props', `${rungs.length} prop rungs but none has a price (Kalshi format change?)`);
    }
  }

  // ---- 3. injuries graded for each game (league feed + depth charts), prop players included
  let injRes = null;
  const leagueFeedOk = !!IF?.league;
  if (IF && leagues.includes('nfl')) guard('injuries', () => {
    const want = {};
    for (const p of props) {
      if (p.player?.espnId == null || !p.player.side) continue;
      ((want[p.gameId] ||= { home: [], away: [] })[p.player.side]).push(String(p.player.espnId));
    }
    const nflPre = nflGames.filter((g) => g.state === 'pre').length;
    if (leagueFeedOk && !(IF.league.count > 0) && nflPre > 0) {
      errs.injuries.push(`league injuries feed lists no players while ${nflPre} NFL games are in the window (ESPN format change?)`);
    }
    injRes = buildInjuries(IF, { games: nflGames, now, recentGames: allEvents.nfl || [], props, players: want });
    errs.injuries.push(...injRes.errors);
    for (const g of nflGames) {
      const bg = injRes.byGame[g.id];
      if (!bg) continue;
      // The league feed replaces the 5-per-team summary lists; summaries stay only when the feed failed.
      if (leagueFeedOk || !injuryMaps.has(g.espnId)) g.injuries = bg.injuries;
      g.angles = bg.angles;
    }
    for (const p of props) {
      const bg = injRes.byGame[p.gameId];
      const id = p.player?.espnId != null ? String(p.player.espnId) : null;
      if (!id) continue;
      if (leagueFeedOk && bg?.players && id in bg.players) p.player.injury = bg.players[id];
      const g = gameById.get(p.gameId);
      const dc = depth.get(String(g?.[p.player.side]?.espnId ?? ''));
      if (dc) p.player.depthRole = depthSpot(dc, id)?.role ?? null;
    }
  });

  // ---- 4. nflverse: NFL defense ratings and player contexts
  let nvRes = null;
  if (NV && leagues.includes('nfl')) {
    nvRes = guard('nflverse', () => buildNflverse(NV, { games: nflGames, propPlayers: propPlayersFromProps(props), injuriesByGame: injRes?.byGame || {}, depth: IF?.depth || null }));
    if (nvRes) errs.nflverse.push(...nvRes.errors);
  }

  // ---- 5. team totals: Kalshi teamTotal markets on matched games, DK team total lines from propBets
  let ttRes = null;
  let ttDropped = 0;
  if (TT || PR?.espnProps) guard('teamTotals', () => {
    const r = buildTeamTotals(TT || { kalshi: {}, errors: [] }, { games, espnProps: PR?.espnProps || {} });
    errs.teamTotals.push(...r.errors);
    // all or nothing: the games are changed only after the builder returned
    ttRes = r;
    for (const g of games) {
      g.dkTeamTotals = ttRes.dkTeamTotals[g.id] ?? null;
      const list = ttRes.marketsByGame[g.id];
      if (!list?.length) continue;
      if (!g.kalshi.gameEvent) { ttDropped += list.length; continue; } // no matched Kalshi game: keep the game's markets consistent
      g.kalshi.markets = [...g.kalshi.markets, ...list].sort(marketOrder);
      g.kalshi.teamTotalEvent = list[0].event;
    }
    if (ttDropped) errs.teamTotals.push(`${ttDropped} team total market(s) dropped: their game has no matched Kalshi game event`);
    const tt = games.flatMap((g) => g.kalshi.markets.filter((x) => x.type === 'teamTotal'));
    if (tt.length >= PLAUSIBILITY.quoteMin && !tt.some(hasQuote)) flag('teamTotals', `${tt.length} team total markets but none has a price (Kalshi format change?)`);
  });

  // ---- 6. CFB: defense ratings and the QB-change detector
  let cfbRes = null;
  let cfbQbChanges = [];
  if (CF && leagues.includes('cfb')) guard('cfb', () => {
    const r = buildCfb(CF, { games });
    const qa = cfbQbAngles(r.cfbQbChanges, games);
    cfbRes = r;
    errs.cfb.push(...r.errors);
    cfbQbChanges = r.cfbQbChanges;
    for (const g of games) if (qa[g.id]) g.angles = [...g.angles, ...qa[g.id]];
  });

  // ---- 7. Pinnacle guest prices (second source): refs.pinnacle on matched pregame games. Fails open: on any problem
  // the games carry no refs and sources.pinnacle says why; nothing else in the snapshot depends on it.
  let pnRes = null;
  if (PN) guard('pinnacle', () => {
    const r = buildPinnacle(PN, { games, eventsByLeague: Object.fromEntries(leagues.map((l) => [l, (allEvents[l] || []).map((e) => e.raw)])), now });
    pnRes = r;
    errs.pinnacle.push(...r.errors);
    for (const g of games) { const ref = r.refs.get(g.id); if (ref) g.refs = { pinnacle: ref }; }
    unmatched.pinnacle = r.unmatched;
  });

  // ---- 8. line moves (collector history) and closes (games that kicked off since the previous run)
  // On a throw: no moves and no closes this run, and history is null so the caller keeps the saved file as it is.
  const prev = inputs.history ?? null;
  errs.moves = [];
  const mv = guard('moves', () => {
    const c = closesFromTransition(prev, games, props, { now });
    const u = updateHistory(prev, historyInput(games, props), { now });
    applyMoves(games, props, u.moves);
    return { closes: c, history: u.history };
  });
  if (!mv) applyMoves(games, props, { games: {}, props: {} });
  const closes = mv?.closes ?? [];
  const history = mv?.history ?? null;

  // Fees: every core series, the prop and team-total series when those were fetched, and any other series given.
  const fees = {};
  const seriesData = S?.data || {};
  const feeMissing = [];
  const feeSeries = [
    ...coreSeries,
    ...(PR && leagues.includes('nfl') ? PROP_SERIES_LIST : []),
    ...(TT ? leagues.map((l) => TEAM_TOTAL_SERIES[l]) : []),
    ...Object.keys(seriesData),
  ];
  for (const s of [...new Set(feeSeries)].sort()) {
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
  for (const g of games) for (const e of [g.kalshi.gameEvent, g.kalshi.spreadEvent, g.kalshi.totalEvent, g.kalshi.teamTotalEvent]) if (e) snapshotEvents.add(e);
  for (const p of props) if (p?.kalshiEvent) snapshotEvents.add(p.kalshiEvent);
  const comboEligible = [...new Set(collectionEventTickers(collection).filter((t) => snapshotEvents.has(t)))].sort();

  const ps = propsRes?.stats;
  const sources = {
    kalshi: {
      ok: !!K && !(K.errors || []).length && !missingSeries.length && !bad.kalshi,
      fetchedAt: K?.fetchedAt ?? null,
      requests: K?.requests ?? 0,
      errors: capErrors(errs.kalshi),
    },
    espnOdds: {
      ok: !!E && !(E.errors || []).length && !espnLeaguesMissing.length && !bad.espnOdds,
      fetchedAt: E?.fetchedAt ?? null,
      ...(E?.requests != null ? { requests: E.requests } : {}),
      errors: capErrors(errs.espnOdds),
    },
    injuries: IF
      ? {
        ok: leagueFeedOk && errs.injuries.length === 0,
        fetchedAt: IF.leagueFetchedAt ?? null,
        depthFetchedAt: IF.depthFetchedAt ?? null,
        requests: (IF.requests || 0) + (I?.requests || 0),
        leagues: ['nfl'],
        notes: [
          'NFL: ESPN league injuries feed plus team depth charts; lists hold depth chart starters graded for each game',
          ...(leagueFeedOk ? [] : [I ? 'league feed failed: injury lists fall back to game summaries (at most 5 per team)' : 'league feed failed: statuses come from the depth charts only']),
          ...(injRes?.notes || []),
          'CFB: no injury source; see cfbQbChanges',
        ],
        errors: capErrors(errs.injuries),
      }
      : I
        ? {
          ok: errs.injuries.length === 0,
          fetchedAt: I.fetchedAt ?? null,
          ...(I.requests != null ? { requests: I.requests } : {}),
          leagues: [...injuryLeagues].sort(),
          notes: ['ESPN game summaries list at most 5 injuries per team (newest first), so a list can be incomplete'],
          errors: capErrors(errs.injuries),
        }
        : notFetched(),
    props: propsRes
      ? {
        ok: propsRes.ok && !bad.props,
        fetchedAt: PR.fetchedAt ?? null,
        requests: PR.requests ?? 0,
        ladders: ps.ladders, matched: ps.matched, withDkLine: ps.withDkLine, games: ps.games, espnGames: ps.espnGames,
        unmatched: propsRes.unmatched.slice(0, 30),
        errors: capErrors(errs.props),
      }
      : notFetched(),
    nflverse: nvRes
      ? {
        ok: nvRes.ok && !(NV.errors || []).length,
        fetchedAt: NV.fetchedAt ?? null,
        asOf: nvRes.meta.asOf,
        season: nvRes.meta.season,
        throughWeek: nvRes.meta.throughWeek,
        etag: nvRes.meta.etag,
        requests: NV.requests ?? 0,
        teams: Object.keys(nvRes.defense.nfl).length,
        players: Object.keys(nvRes.players).length,
        warnings: capErrors([...(NV.warnings || []), ...(nvRes.warnings || [])], 10),
        errors: capErrors(errs.nflverse),
      }
      : notFetched({ asOf: null, season: null, throughWeek: null }),
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
    teamTotals: TT && ttRes
      ? {
        ok: ttRes.ok && !ttDropped && !bad.teamTotals,
        fetchedAt: TT.fetchedAt ?? null,
        requests: TT.requests ?? 0,
        markets: ttRes.stats.linked - ttDropped,
        dkGames: ttRes.stats.dkGames,
        notes: ttRes.notes,
        errors: capErrors(errs.teamTotals),
      }
      : notFetched(),
    cfb: cfbRes
      ? {
        ok: cfbRes.ok && !(CF.errors || []).length,
        fetchedAt: CF.defense?.fetchedAt ?? null,
        qbFetchedAt: CF.qb?.fetchedAt ?? null,
        qbWeek: CF.qb?.weekKey ?? null,
        qbComplete: !!CF.qb?.complete,
        requests: CF.requests ?? 0,
        teams: Object.keys(cfbRes.defense.cfb).length,
        warnings: capErrors(cfbRes.warnings || [], 10),
        errors: capErrors(errs.cfb),
      }
      : notFetched(),
    moves: {
      ok: !!history,
      since: prev?.at ?? null,           // the previous run's time; null = no history yet, so no moves
      games: history ? Object.keys(history.games).length : 0,
      props: history ? Object.keys(history.props).length : 0,
      errors: capErrors(errs.moves),
    },
    // Second price source (lib/pinnacle.mjs). ok=false also when one league failed or nothing matched.
    pinnacle: pnRes
      ? {
        ok: !errs.pinnacle.length && leagues.every((l) => !!PN.leagues?.[l]),
        fetchedAt: PN.attemptAt ?? null,
        cached: !!PN.cached,
        requests: PN.requests ?? 0,
        matched: Object.values(pnRes.matched).reduce((a, n) => a + n, 0),
        matchedByLeague: pnRes.matched,
        errors: capErrors(errs.pinnacle),
      }
      : notFetched({ cached: false, requests: PN?.requests ?? 0, matched: 0, matchedByLeague: {} }),
  };
  for (const key of crashed) sources[key] = { ...sources[key], ok: false, errors: capErrors(errs[key]) };

  const bySource = inputs.stats?.bySource || null;
  const snapshot = {
    v: SNAPSHOT_VERSION,
    generatedAt: iso(now),
    collector: {
      version: String(opts.version ?? '0.0.0'),
      runMs: Number.isFinite(opts.runMs) ? Math.round(opts.runMs) : null,
      ...(bySource ? {
        requests: Object.values(bySource).reduce((a, s) => a + (s.requests || 0), 0),
        timings: Object.fromEntries(Object.keys(bySource).sort().map((k) => [k, { ms: bySource[k].ms, requests: bySource[k].requests }])),
      } : {}),
    },
    sources,
    fees,
    games,
    props,
    defense: { nfl: nvRes?.defense?.nfl || {}, cfb: cfbRes?.defense?.cfb || {} },
    players: nvRes?.players || {},
    cfbQbChanges,
    comboEligible,
    unmatched,
  };
  return { snapshot, history, closes, hold };
}

/** buildSnapshot(inputs, opts) -> snapshot v1 (buildRun without the history and closes outputs). */
export function buildSnapshot(inputs = {}, opts = {}) {
  return buildRun(inputs, opts).snapshot;
}

/** Counts for logs and reports. */
export function summarize(snapshot) {
  const out = {
    games: snapshot.games.length, byLeague: {}, markets: 0, marketsByType: { game: 0, spread: 0, total: 0, teamTotal: 0 },
    withOdds: 0, withKalshi: 0, withLadders: 0, withTeamTotals: 0, dkTeamTotals: 0,
    injuries: 0, angles: 0, anglesByKind: {}, gameMoves: 0, propMoves: 0, pinnacle: {},
  };
  for (const g of snapshot.games) {
    const b = (out.byLeague[g.league] ||= { games: 0, withKalshi: 0, withOdds: 0, markets: 0, pre: 0, in: 0 });
    b.games++;
    b[g.state] = (b[g.state] || 0) + 1;
    if (g.kalshi.gameEvent) { b.withKalshi++; out.withKalshi++; }
    if (g.odds) { b.withOdds++; out.withOdds++; }
    if (g.kalshi.spreadEvent || g.kalshi.totalEvent) out.withLadders++;
    if (g.kalshi.teamTotalEvent) out.withTeamTotals++;
    if (g.dkTeamTotals) out.dkTeamTotals++;
    b.markets += g.kalshi.markets.length;
    out.markets += g.kalshi.markets.length;
    for (const m of g.kalshi.markets) out.marketsByType[m.type] = (out.marketsByType[m.type] || 0) + 1;
    out.injuries += (g.injuries?.home?.length || 0) + (g.injuries?.away?.length || 0);
    for (const a of g.angles || []) { out.angles++; out.anglesByKind[a.kind] = (out.anglesByKind[a.kind] || 0) + 1; }
    out.gameMoves += (g.moves || []).length;
    const pn = (out.pinnacle[g.league] ||= { pre: 0, refs: 0, offBoard: 0 });
    if (g.state === 'pre') pn.pre++;
    if (g.refs?.pinnacle) { pn.refs++; if (g.refs.pinnacle.offBoard) pn.offBoard++; }
  }
  const props = snapshot.props || [];
  out.props = props.length;
  out.propsMatched = props.filter((p) => p.player?.espnId != null).length;
  out.propsWithDk = props.filter((p) => p.dk).length;
  out.propsSafe = props.filter((p) => p.fifty === 'safe').length;
  out.propRungs = props.reduce((a, p) => a + (p.rungs?.length || 0), 0);
  out.propMoves = props.reduce((a, p) => a + (p.moves?.length || 0), 0);
  out.defenseNfl = Object.keys(snapshot.defense?.nfl || {}).length;
  out.defenseCfb = Object.keys(snapshot.defense?.cfb || {}).length;
  out.players = Object.keys(snapshot.players || {}).length;
  out.cfbQbChanges = (snapshot.cfbQbChanges || []).length;
  out.unmatchedKalshi = snapshot.unmatched.kalshi.length;
  out.unmatchedEspn = snapshot.unmatched.espn.length;
  out.comboEligible = snapshot.comboEligible.length;
  return out;
}
