// Team totals: Kalshi KXNFLTEAMTOTAL / KXNCAAFTEAMTOTAL ladders attached to games as Market type 'teamTotal',
// plus the DraftKings NFL team total line read from ESPN propBets (type 98 'Team Total Points'). Data only.
//
// DK team totals on ESPN are an ALT LADDER, not a main line: each team has about 21 rungs (main line +/- 10,
// listed twice for over/under), every rung carries open.target = the opening main line, and no rung is flagged
// as the current main line. The current line is read as the ladder midpoint and checked against the DK game line
// ((total -/+ home spread) / 2). On 2026-10-11/12 that matched 4 of 4 teams within 0.5 (BAL@ATL 20.5/23.5 vs
// 20.25/23.25 implied, BUF@LAR 25.5/29.5 vs 25.5/29). A midpoint more than 2 points from the implied value is
// rejected (line null) rather than guessed.

import { createHttp, mapLimit, errorText } from './http.mjs';
import { createKalshiClient, fetchSeriesMarkets, parseEventTicker, trimMarket, isOpenMarket, num } from './kalshi.mjs';
import { kalshiGameIndex, teamIdOf, capErrors } from './props.mjs';

export const TEAM_TOTAL_SERIES = { nfl: 'KXNFLTEAMTOTAL', cfb: 'KXNCAAFTEAMTOTAL' };
export const DK_TEAM_TOTAL_TYPE = '98';
export const TT_MAX_IMPLIED_DIFF = 2;
const TT_MIN_RUNGS = 5;
const DAY = 86400e3;
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * fetchTeamTotalInputs({ games, fetchImpl, now }) -> { fetchedAt, kalshi: { KXNFLTEAMTOTAL: [...], KXNCAAFTEAMTOTAL: [...] },
 * errors, requests, stats }. Open markets, paginated, close time capped like the core series. A league with no games
 * in `games` is skipped (pass no games to fetch both). Never throws for upstream failures.
 */
export async function fetchTeamTotalInputs({
  games = null, fetchImpl = globalThis.fetch, now = Date.now(), cacheDir = null, // eslint-disable-line no-unused-vars
  pauseMs = 150, log = () => {},
} = {}) {
  const t0 = Date.now();
  const fetchedAt = new Date(t0).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const http = createHttp({ fetchImpl, retries: 0 });
  const client = createKalshiClient({ http });
  const errors = [];
  const kalshi = {};
  const leagues = Object.keys(TEAM_TOTAL_SERIES).filter((l) => !Array.isArray(games) || !games.length || games.some((g) => g?.league === l));
  const maxCloseTs = Math.floor((now + 12 * DAY) / 1000);
  await mapLimit(leagues, 2, async (l) => {
    const s = TEAM_TOTAL_SERIES[l];
    try { kalshi[s] = await fetchSeriesMarkets(client, s, { maxCloseTs }); } catch (e) { errors.push(`kalshi ${s}: ${errorText(e)}`); }
    await sleep(pauseMs);
  });
  const ms = Date.now() - t0;
  log(`team totals: kalshi ${http.stats.requests} req ${ms} ms (${leagues.join(', ') || 'no leagues'})`);
  return { fetchedAt, kalshi, errors, requests: http.stats.requests, stats: { ms, leagues, kalshiHost: client.hostUsed() } };
}

// ---------------------------------------------------------------- pure

/** DK implied team totals from the game line: home = (total - homeSpread) / 2, away = (total + homeSpread) / 2. */
export function impliedTeamTotals(odds) {
  const T = num(odds?.total?.line);
  const S = num(odds?.spread?.home);
  if (T == null || S == null) return null;
  return { home: (T - S) / 2, away: (T + S) / 2 };
}

/**
 * Main line of a DK alt team-total ladder: the midpoint of its distinct rungs (main +/- 10 in every capture),
 * accepted only when it sits within TT_MAX_IMPLIED_DIFF of the game-line implied value (when that exists).
 * Returns { line, why } with line null when the ladder cannot be read safely.
 */
export function ladderMainLine(rungValues, implied = null) {
  const r = [...new Set(rungValues.filter((x) => Number.isFinite(x)))].sort((a, b) => a - b);
  if (r.length < TT_MIN_RUNGS) return { line: null, why: `${r.length} rungs` };
  let mid = (r[0] + r[r.length - 1]) / 2;
  if (Math.abs(mid - Math.round(mid)) < 1e-9) {        // even rung count: midpoint is a whole number
    if (implied == null) return { line: null, why: `ambiguous midpoint ${mid}` };
    mid += implied >= mid ? 0.5 : -0.5;
  }
  if (implied != null && Math.abs(mid - implied) > TT_MAX_IMPLIED_DIFF) {
    return { line: null, why: `ladder midpoint ${mid} is ${Math.abs(mid - implied).toFixed(2)} from game-line implied ${implied}` };
  }
  return { line: mid, why: null };
}

/** The most common value (ties: the smaller one), for the shared open.target of a ladder. */
function mode(values) {
  const c = new Map();
  for (const v of values) if (Number.isFinite(v)) c.set(v, (c.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of [...c.entries()].sort((a, b) => a[0] - b[0])) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/** DK team totals for one NFL game from its ESPN propBets items. -> { home: {line, open} | null, away: ... } | null */
export function dkTeamTotalsFromItems(items, game, errors = []) {
  const byTeam = new Map();
  for (const it of items || []) {
    const isTT = String(it?.type?.id ?? '') === DK_TEAM_TOTAL_TYPE || /^Team Total Points$/i.test(String(it?.type?.name || ''));
    if (!isTT) continue;
    const tid = teamIdOf(it);
    if (!tid) continue;
    if (!byTeam.has(tid)) byTeam.set(tid, { rungs: [], opens: [] });
    const cur = num(it.current?.target?.value);
    const open = num(it.open?.target?.value);
    if (cur != null) byTeam.get(tid).rungs.push(cur);
    if (open != null) byTeam.get(tid).opens.push(open);
  }
  if (!byTeam.size) return null;
  const implied = impliedTeamTotals(game?.odds);
  const out = { home: null, away: null };
  for (const side of ['home', 'away']) {
    const tid = String(game?.[side]?.espnId ?? '');
    const t = byTeam.get(tid);
    if (!t) continue;
    const { line, why } = ladderMainLine(t.rungs, implied ? implied[side] : null);
    if (why) errors.push(`dk team total ${game.id} ${side}: ${why}; line not used`);
    const open = mode(t.opens);
    if (line == null && open == null) continue;
    out[side] = { line, open };
  }
  for (const tid of byTeam.keys()) {
    if (tid !== String(game?.home?.espnId) && tid !== String(game?.away?.espnId)) errors.push(`dk team total ${game?.id}: team ${tid} is not in this game`);
  }
  return out.home || out.away ? out : null;
}

const SIDE_RANK = { away: 0, home: 1 };

/**
 * buildTeamTotals(raw, { games, espnProps }) -> { marketsByGame: { [gameId]: [Market] }, dkTeamTotals: { [gameId]: {...} },
 * ok, errors, notes, stats }
 * raw = fetchTeamTotalInputs() result. games = snapshot games. espnProps = fetchPropInputs().espnProps.
 * Events join games by Kalshi teams part within +/- 1 day (CFB date codes drift); the ticker suffix is the team code
 * plus ceil(strike) (e.g. LAR32 = LAR over 31.5); strike = floor_strike, checked against the suffix.
 */
export function buildTeamTotals(raw, { games = [], espnProps = {} } = {}) {
  const errors = [...(raw?.errors || [])];
  const stats = { markets: 0, linked: 0, notActive: 0, noGame: 0, badSuffix: 0, games: 0, dkGames: 0 };
  const marketsByGame = {};
  const orphanEvents = new Set();

  for (const [league, series] of Object.entries(TEAM_TOTAL_SERIES)) {
    const lookup = kalshiGameIndex(games.filter((g) => g?.league === league && (league === 'nfl' || g.kalshi?.gameEvent)));
    for (const m of Array.isArray(raw?.kalshi?.[series]) ? raw.kalshi[series] : []) {
      stats.markets++;
      if (!m?.ticker || !m.event_ticker) { stats.badSuffix++; continue; }
      if (!isOpenMarket(m)) { stats.notActive++; continue; }
      const hit = lookup(m.event_ticker);
      if (!hit) { stats.noGame++; orphanEvents.add(m.event_ticker); continue; }
      const suffix = String(m.ticker).startsWith(`${m.event_ticker}-`) ? String(m.ticker).slice(m.event_ticker.length + 1) : '';
      let code = null, n = null;
      for (const c of [hit.away, hit.home].filter(Boolean).sort((a, b) => b.length - a.length)) {
        const rest = suffix.startsWith(c) ? suffix.slice(c.length) : null;
        if (rest != null && /^\d+$/.test(rest)) { code = c; n = Number(rest); break; }
      }
      if (!code) { stats.badSuffix++; errors.push(`${m.ticker}: suffix does not name ${hit.away} or ${hit.home}; dropped`); continue; }
      let strike = num(m.floor_strike);
      if (strike == null) strike = n - 0.5;
      else if (Math.ceil(strike) !== n) errors.push(`${m.ticker}: floor_strike ${strike} does not match suffix ${n} (kept floor_strike)`);
      const team = code === hit.home ? 'home' : 'away';
      (marketsByGame[hit.game.id] ||= []).push(trimMarket(m, { type: 'teamTotal', team, strike }));
      stats.linked++;
    }
  }
  for (const list of Object.values(marketsByGame)) {
    list.sort((a, b) => (SIDE_RANK[a.team] - SIDE_RANK[b.team]) || (a.strike - b.strike) || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  }
  stats.games = Object.keys(marketsByGame).length;

  const dkTeamTotals = {};
  for (const g of games) {
    if (g?.league !== 'nfl') continue;
    const items = espnProps?.[String(g.espnId)];
    if (!items) continue;
    const tt = dkTeamTotalsFromItems(items, g, errors);
    if (tt) { dkTeamTotals[g.id] = tt; stats.dkGames++; }
  }

  const ok = Object.values(TEAM_TOTAL_SERIES).some((s) => Array.isArray(raw?.kalshi?.[s])) && !(raw?.errors || []).length;
  return {
    marketsByGame,
    dkTeamTotals,
    ok,
    errors: capErrors(errors),
    notes: ['DK team total line = midpoint of the DraftKings alt team-total ladder on ESPN, kept only within 2 points of (total -/+ spread) / 2 from the DK game line'],
    stats: { ...stats, orphanEvents: [...orphanEvents].sort() },
  };
}

/** Event key of a team-total event ('KXNFLTEAMTOTAL-26OCT12BUFLAR' -> '26OCT12BUFLAR'), for diagnostics. */
export const teamTotalEventKey = (et) => parseEventTicker(et)?.eventKey ?? null;
