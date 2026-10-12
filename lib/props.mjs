// NFL player props: Kalshi prop ladders (15 series) joined to ESPN players and to the DraftKings main O/U line
// that ESPN's core API carries (propBets, provider 100). Data collection only: no pricing and no picks here.
//
// What the research found (live, 2026-10-11/12; see SPEC 10):
// - 15 Kalshi NFL prop series have open markets; Kalshi has no CFB player props, and ESPN has no DK CFB props.
// - ESPN DK prop items carry lines only (no prices). Over and under appear as duplicate items with no side label:
//   dedupe on athleteId|typeId and keep the newest. "Milestones" items are DK alt ladders, not main lines: dropped.
// - ESPN lastUpdated runs about 3 h fast, so it is never used as a time here (dk.updated stays null; the collector's
//   own timestamps in lib/moves.mjs are the movement clock).
// - DK lines freeze at kickoff while Kalshi keeps trading, and status=open still lists finished games at 0.99/0.01.
//   So only ESPN state 'pre' games and Kalshi status 'active' markets are used.
// - Join: Kalshi ticker team code + jersey + name key against the nflverse roster_weekly ID bridge
//   (glue.buildIdBridge), ESPN team rosters only as a fallback (126/126 BUF@LAR ladders in research).

import { createHttp, mapLimit, errorText, HttpError } from './http.mjs';
import { createKalshiClient, fetchSeriesMarkets, parseEventTicker, trimMarket, isOpenMarket, num } from './kalshi.mjs';
import { nameKey, toKalshi, kalshiGameCode } from './glue.mjs';

export const ESPN_CORE_NFL = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';

// Kalshi series -> SPEC 10.1 stat name and the ESPN propBets type id of the DK main line (null = DK posts no line).
// kind: 'ladder' = "N+" rungs, 'over' = single "over x.5" rung per player, 'winner' = one market per player.
export const PROP_SERIES = {
  KXNFLPASSYDS: { stat: 'passYds', espnType: '8', kind: 'ladder' },
  KXNFLPASSCOMP: { stat: 'passComp', espnType: '9', kind: 'ladder' },
  KXNFLPASSTDS: { stat: 'passTd', espnType: '10', kind: 'ladder' },
  KXNFLRSHATT: { stat: 'rushAtt', espnType: '11', kind: 'ladder' },
  KXNFLRSHYDS: { stat: 'rushYds', espnType: '12', kind: 'ladder' },
  KXNFLRECYDS: { stat: 'recYds', espnType: '13', kind: 'ladder' },
  KXNFLREC: { stat: 'rec', espnType: '14', kind: 'ladder' },
  KXNFLPASSINT: { stat: 'passInt', espnType: '15', kind: 'ladder' },
  KXNFLPASSATT: { stat: 'passAtt', espnType: '16', kind: 'ladder' },
  KXNFLRRYDS: { stat: 'rushRecYds', espnType: '20', kind: 'ladder' },
  KXNFLLONGREC: { stat: 'longRec', espnType: '19', kind: 'over' },
  KXNFLLONGRSH: { stat: 'longRush', espnType: '21', kind: 'over' },
  KXNFLTD: { stat: 'anyTd', espnType: null, kind: 'ladder' }, // DK type 31 exists but has no line
  KXNFLFIRSTTD: { stat: 'firstTd', espnType: null, kind: 'winner' }, // DK type 29, no line
  KXNFLFFPTS: { stat: 'ffpts', espnType: null, kind: 'over' }, // Sleeper full PPR; no DK counterpart
};
export const PROP_SERIES_LIST = Object.keys(PROP_SERIES);
// Stats whose value is not a whole number (fantasy points): threshold = strike instead of floor(strike) + 1.
const FRACTIONAL_STATS = new Set(['ffpts']);

const DAY = 86400e3;
// ESPN propBets are fetched only for pregame NFL games kicking off within this window (DK and Kalshi post full
// prop ladders about a day ahead), which keeps a full Sunday near 50 requests.
export const PROP_HORIZON_MS = 48 * 3600e3;
export const PROPBETS_MAX_PAGES = 2; // limit is capped at 1000; a pregame game has 1,500 to 1,700 items
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Unique errors, at most max (a changed ticker format must not flood the snapshot). */
export function capErrors(list, max = 50) {
  const u = [...new Set(list.filter(Boolean).map((x) => String(x).slice(0, 300)))];
  return u.length <= max ? u : [...u.slice(0, max), `...and ${u.length - max} more`];
}

/**
 * Can the DK main line be read as a 50/50 median (no DK prices exist)? props_lib fiftyFiftyClass with SPEC stat names.
 * Evidence (121 lines, 2026-10-11): Kalshi P(over DK line) was 0.47 to 0.53 for yardage lines >= 14.5 and pass att/comp;
 * low-count lines (receptions <= 2.5, pass TDs, INTs, TDs) were far from 0.5.
 * Returns 'safe' | 'caution' | 'unsafe' (SPEC 10.1); no line is 'unsafe'.
 */
export function fiftyFiftyClass(stat, line) {
  if (line == null || !Number.isFinite(Number(line))) return 'unsafe';
  const L = Number(line);
  switch (stat) {
    case 'passYds': return 'safe';
    case 'rushYds': case 'recYds': return L >= 14.5 ? 'safe' : 'unsafe'; // < 14.5 is also below Kalshi's lowest rung
    case 'rushRecYds': return L >= 29.5 ? 'safe' : 'caution';
    case 'passAtt': case 'passComp': return L >= 14.5 ? 'safe' : 'caution';
    case 'rushAtt': return L >= 9.5 ? 'safe' : 'caution';
    case 'rec': return L >= 3.5 ? 'caution' : 'unsafe';
    case 'longRec': case 'longRush': return 'caution';
    default: return 'unsafe'; // passTd, passInt, anyTd, firstTd, ffpts
  }
}

// ---------------------------------------------------------------- ESPN propBets (pure helpers)

const isMilestone = (it) => /Milestones/i.test(String(it?.type?.name || ''));
export const athleteIdOf = (it) => /athletes\/(\d+)/.exec(String(it?.athlete?.$ref || ''))?.[1] ?? null;
export const teamIdOf = (it) => /teams\/(\d+)/.exec(String(it?.team?.$ref || ''))?.[1] ?? null;

/** Keep only what the builders read; milestones (DK alt ladders) return null. $refs are shortened to 'athletes/<id>'. */
export function slimPropItem(it) {
  if (!it || isMilestone(it)) return null;
  const out = { type: { id: String(it.type?.id ?? ''), name: String(it.type?.name ?? '') } };
  const aid = athleteIdOf(it);
  const tid = teamIdOf(it);
  if (aid) out.athlete = { $ref: `athletes/${aid}` };
  if (tid) out.team = { $ref: `teams/${tid}` };
  const cur = num(it.current?.target?.value);
  const open = num(it.open?.target?.value);
  out.current = cur == null ? {} : { target: { value: cur } };
  out.open = open == null ? {} : { target: { value: open } };
  if (it.lastUpdated) out.lastUpdated = String(it.lastUpdated);
  return out;
}

/**
 * DK main O/U lines for one game: Map('athleteId|typeId' -> { aid, type, line, open, lu }).
 * Each prop appears once or twice (over and under) with the same values; keep the item with a line and the newest
 * lastUpdated (lastUpdated is only compared within one response, never used as a time).
 */
export function normalizeEspnProps(items = []) {
  const lines = new Map();
  const stats = { items: 0, milestones: 0, teamItems: 0, conflicts: 0 };
  for (const it of items || []) {
    stats.items++;
    if (isMilestone(it)) { stats.milestones++; continue; }
    const aid = athleteIdOf(it);
    if (!aid) { stats.teamItems++; continue; }
    const type = String(it.type?.id ?? '');
    const line = num(it.current?.target?.value);
    const open = num(it.open?.target?.value);
    const lu = String(it.lastUpdated || '');
    const k = `${aid}|${type}`;
    const prev = lines.get(k);
    if (prev && prev.line != null && line != null && prev.line !== line) stats.conflicts++;
    const better = !prev || (line != null && prev.line == null) || ((line != null) === (prev.line != null) && lu > prev.lu);
    if (better) lines.set(k, { aid, type, line, open, lu });
  }
  return { lines, stats };
}

// ---------------------------------------------------------------- Kalshi ticker parsing (pure)

/**
 * Parse one Kalshi player-prop market. codes = the game's Kalshi team codes [away, home].
 * Suffix grammar: TEAM + KEY + JERSEY [ "-" THRESHOLD ], KEY = first initial + last name letters (Jr/Sr/II/III dropped,
 * punctuation dropped). Team-level markets: TEAM+TEAM+"DST" (defense) and TEAM+"NO-TD" (first TD "No Touchdown").
 * Display names come from yes_sub_title (before the colon), never from the ticker.
 */
export function parseKalshiPlayer(m, codes = []) {
  const ticker = String(m?.ticker || '');
  const et = String(m?.event_ticker || '');
  const suffix = ticker.startsWith(`${et}-`) ? ticker.slice(et.length + 1) : '';
  const sub = String(m?.yes_sub_title ?? '');
  const out = { team: null, key: null, jersey: null, name: null, isDST: false, isNoTD: false,
    kalshiPlayerId: m?.custom_strike?.football_player ?? null, nameCheck: null };
  if (/NO-TD$/.test(suffix) || /^No Touchdown/i.test(sub)) { out.isNoTD = true; out.name = 'No Touchdown'; return out; }
  const dash = suffix.lastIndexOf('-');
  const body = dash > 0 ? suffix.slice(0, dash) : suffix;
  out.name = sub.includes(':') ? sub.slice(0, sub.lastIndexOf(':')).trim() : sub.trim();
  const wantKey = out.name ? nameKey(out.name) : null;
  let team = null;
  for (const c of [...codes].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (!body.startsWith(c)) continue;
    const rest = body.slice(c.length);
    if (wantKey && rest.startsWith(wantKey)) { team = c; break; }
    if (rest === `${c}DST`) { team = c; break; }
    if (!team) team = c;
  }
  out.team = team;
  if (!team) return out;
  const rest = body.slice(team.length);
  if (rest === `${team}DST` || /D\/ST/.test(sub)) { out.isDST = true; out.key = 'DST'; return out; }
  const km = /^([A-Z]+?)(\d+)?$/.exec(rest);
  out.key = km ? km[1] : rest;
  out.jersey = km && km[2] ? km[2] : null;
  out.nameCheck = wantKey ? wantKey === out.key : null;
  return out;
}

/** Contract strike: floor_strike, else the ticker token ('80' -> 79.5, '9P1' -> 9.1). FIRSTTD has none. */
function strikeOf(m) {
  const fs = num(m.floor_strike);
  if (fs != null) return fs;
  const tok = /-(\d+(?:P\d+)?)$/.exec(String(m.ticker || ''))?.[1];
  if (!tok) return null;
  return tok.includes('P') ? Number(tok.replace('P', '.')) : Number(tok) - 0.5;
}

/** SPEC rung: YES = stat >= threshold. Count stats: strike 79.5 -> 80. Fantasy points: threshold = strike. */
function thresholdOf(stat, kind, strike) {
  if (kind === 'winner') return 1; // first TD scorer: a 0/1 stat
  if (strike == null) return null;
  return FRACTIONAL_STATS.has(stat) ? strike : Math.floor(strike) + 1;
}

function trimRung(m, stat, kind) {
  const t = trimMarket(m, { type: 'prop' });
  const strike = kind === 'winner' ? null : strikeOf(m);
  return {
    ticker: t.ticker,
    threshold: thresholdOf(stat, kind, strike),
    strike,
    yesAsk: t.yesAsk, yesBid: t.yesBid, noAsk: t.noAsk, noBid: t.noBid,
    yesAskSize: t.yesAskSize, yesBidSize: t.yesBidSize,
    volume: t.volume, volume24h: t.volume24h,
  };
}

// ---------------------------------------------------------------- game keys (pure)

const DAYMS = 86400e3;
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / DAYMS;

/**
 * Index games by Kalshi teams part ('BALATL') for event lookups within +/- 1 day (SPEC: never exact suffix only).
 * Uses the matched KXNFLGAME event when the builder found one, else glue.kalshiGameCode from ESPN data.
 * Returns lookup(eventTicker) -> { game, away, home } | null, where away/home are Kalshi team codes.
 */
export function kalshiGameIndex(games = []) {
  const byTeams = new Map();
  for (const g of games) {
    if (!g?.home || !g?.away) continue;
    const away = g.away.kalshiCode || toKalshi(g.away.abbr);
    const home = g.home.kalshiCode || toKalshi(g.home.abbr);
    const keys = [];
    const p = g.kalshi?.gameEvent ? parseEventTicker(g.kalshi.gameEvent) : null;
    if (p) keys.push(p);
    if (g.league === 'nfl' && g.kickoff && g.away.abbr && g.home.abbr) {
      const q = parseEventTicker(`X-${kalshiGameCode(g.kickoff, g.away.abbr, g.home.abbr)}`);
      if (q && !keys.some((k) => k.eventKey === q.eventKey)) keys.push(q);
    }
    for (const k of keys) {
      if (!byTeams.has(k.teamsPart)) byTeams.set(k.teamsPart, []);
      byTeams.get(k.teamsPart).push({ game: g, away, home, dateKey: k.dateKey });
    }
  }
  return (eventTicker) => {
    const p = parseEventTicker(eventTicker);
    if (!p) return null;
    let best = null, bestDd = 2;
    for (const c of byTeams.get(p.teamsPart) || []) {
      const dd = dayDiff(c.dateKey, p.dateKey);
      if (dd <= 1 && dd < bestDd) { best = c; bestDd = dd; }
    }
    return best;
  };
}

// ---------------------------------------------------------------- player resolution (pure)

function lastKeyOf(fullName) { return nameKey(fullName).slice(1); }

function makePlayerIndex(players) {
  const byTeamJersey = new Map(), byTeamKey = new Map(), byTeamLast = new Map();
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); if (!map.get(k).some((x) => x.id === v.id)) map.get(k).push(v); };
  for (const p of players) {
    if (!p?.id || !p.kteam || !p.name) continue;
    if (p.jersey) push(byTeamJersey, `${p.kteam}|${p.jersey}`, p);
    push(byTeamKey, `${p.kteam}|${nameKey(p.name)}`, p);
    push(byTeamLast, `${p.kteam}|${lastKeyOf(p.name)}`, p);
  }
  return { byTeamJersey, byTeamKey, byTeamLast, size: players.length };
}

/** players from glue.buildIdBridge(...).byEspn (nflverse team codes) */
function bridgePlayers(bridge) {
  const out = [];
  const src = bridge?.byEspn;
  const values = src instanceof Map ? [...src.values()] : src && typeof src === 'object' ? Object.values(src) : [];
  for (const p of values) {
    if (!p?.espn || !p.team) continue;
    out.push({ id: String(p.espn), name: p.name, jersey: p.jersey ? String(p.jersey) : null, pos: p.pos || null, kteam: toKalshi(p.team) });
  }
  return out;
}

/** rosters = { [teamAbbr any source]: [{ id, name, jersey, pos }] } (ESPN team rosters, fallback only) */
function rosterPlayers(rosters) {
  const out = [];
  for (const [abbr, list] of Object.entries(rosters || {})) {
    for (const p of Array.isArray(list) ? list : []) {
      if (!p?.id) continue;
      out.push({ id: String(p.id), name: p.name || p.fullName || '', jersey: p.jersey ? String(p.jersey) : null, pos: p.pos || null, kteam: toKalshi(abbr) });
    }
  }
  return out;
}

// Team + jersey confirmed by name, then unique team + name key, then unique team + last name. Never jersey alone:
// jerseys repeat inside a team (SF #89) and change hands; the ATL Robinsons share a name key (BROBINSON).
function resolveIn(idx, pk) {
  const one = (arr) => (arr && arr.length === 1 ? arr[0] : null);
  if (pk.jersey && pk.key) {
    const c = (idx.byTeamJersey.get(`${pk.team}|${pk.jersey}`) || [])
      .filter((p) => nameKey(p.name) === pk.key || lastKeyOf(p.name) === pk.key.slice(1));
    if (c.length === 1) return [c[0], 'team+jersey+name'];
  }
  if (pk.key) { const k = one(idx.byTeamKey.get(`${pk.team}|${pk.key}`)); if (k) return [k, 'team+nameKey']; }
  if (pk.name) { const k2 = one(idx.byTeamKey.get(`${pk.team}|${nameKey(pk.name)}`)); if (k2) return [k2, 'team+subtitleName']; }
  if (pk.key && pk.key.length > 1) { const l = one(idx.byTeamLast.get(`${pk.team}|${pk.key.slice(1)}`)); if (l) return [l, 'team+lastName']; }
  return [null, null];
}

// ---------------------------------------------------------------- build (pure)

const SIDE_RANK = { away: 0, home: 1 };
const STAT_ORDER = Object.fromEntries(PROP_SERIES_LIST.map((s, i) => [PROP_SERIES[s].stat, i]));

/**
 * buildProps(raw, { games, bridge, rosters, now }) -> { props: [PropLadder], unmatched: [string], ok, errors, stats }
 * raw = fetchPropInputs() result: { kalshi: { [series]: [rawMarket] }, espnProps: { [espnEventId]: [items] }, errors }.
 * games = snapshot games (only league 'nfl' with state 'pre' are used). bridge = glue.buildIdBridge(roster_weekly).
 * rosters (optional fallback) = { [teamAbbr]: [{ id, name, jersey, pos }] }. Pure: no clock reads, no network.
 */
export function buildProps(raw, { games = [], bridge = null, rosters = null, now = null } = {}) { // eslint-disable-line no-unused-vars
  const errors = [...(raw?.errors || [])];
  const stats = { markets: 0, notActive: 0, noGame: 0, teamLevel: 0, unparsed: 0, ladders: 0, matched: 0,
    byMethod: {}, withDkLine: 0, games: 0, espnGames: 0, dkConflicts: 0 };
  const kalshi = raw?.kalshi || {};
  const pre = games.filter((g) => g?.league === 'nfl' && g.state === 'pre');
  const lookup = kalshiGameIndex(pre);

  // DK lines per ESPN event id
  const dkByEvent = new Map();
  for (const [eid, items] of Object.entries(raw?.espnProps || {})) {
    const { lines, stats: s } = normalizeEspnProps(items);
    dkByEvent.set(String(eid), lines);
    stats.dkConflicts += s.conflicts;
  }

  // group markets into ladders: series | event | player
  const ladders = new Map();
  for (const series of PROP_SERIES_LIST) {
    const cfg = PROP_SERIES[series];
    for (const m of Array.isArray(kalshi[series]) ? kalshi[series] : []) {
      stats.markets++;
      if (!m?.ticker || !m.event_ticker) { stats.unparsed++; continue; }
      if (!isOpenMarket(m)) { stats.notActive++; continue; }
      const hit = lookup(m.event_ticker);
      if (!hit) { stats.noGame++; continue; }
      const pk = parseKalshiPlayer(m, [hit.away, hit.home]);
      if (pk.isDST || pk.isNoTD) { stats.teamLevel++; continue; }
      if (!pk.team || !pk.key) { stats.unparsed++; errors.push(`${m.ticker}: cannot parse player`); continue; }
      const id = `${series}|${m.event_ticker}|${pk.kalshiPlayerId || `${pk.team}${pk.key}${pk.jersey || ''}`}`;
      if (!ladders.has(id)) ladders.set(id, { series, cfg, pk, hit, event: m.event_ticker, markets: [] });
      ladders.get(id).markets.push(m);
    }
  }

  const bridgeIdx = makePlayerIndex(bridgePlayers(bridge));
  const rosterIdx = makePlayerIndex(rosterPlayers(rosters));
  if (!bridgeIdx.size && !rosterIdx.size) errors.push('props: no ID bridge and no rosters; players cannot be joined to ESPN ids');

  const props = [];
  const unmatched = [];
  const gamesWithProps = new Set();
  for (const L of ladders.values()) {
    stats.ladders++;
    const { pk, hit, cfg } = L;
    const g = hit.game;
    let [p, method] = resolveIn(bridgeIdx, pk);
    if (p) method = `bridge:${method}`;
    else {
      [p, method] = resolveIn(rosterIdx, pk);
      method = p ? `roster:${method}` : 'unmatched';
    }
    stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
    if (p) stats.matched++;
    else unmatched.push(`${L.series} ${parseEventTicker(L.event)?.eventKey || L.event} ${pk.team} ${pk.name || pk.key} #${pk.jersey ?? '?'}`);

    const side = pk.team === hit.home ? 'home' : 'away';
    const dkLine = p && cfg.espnType ? dkByEvent.get(String(g.espnId))?.get(`${p.id}|${cfg.espnType}`) : null;
    const dk = dkLine && dkLine.line != null ? { line: dkLine.line, open: dkLine.open ?? null, updated: null } : null;
    if (dk) stats.withDkLine++;
    const rungs = L.markets.map((m) => trimRung(m, cfg.stat, cfg.kind))
      .sort((a, b) => (a.threshold ?? 0) - (b.threshold ?? 0) || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
    gamesWithProps.add(g.id);
    props.push({
      gameId: g.id,
      league: 'nfl',
      stat: cfg.stat,
      series: L.series,
      player: {
        espnId: p ? p.id : null,
        name: pk.name || p?.name || null,
        team: g[side]?.abbr ?? pk.team,
        side,
        pos: p?.pos ?? null,
        jersey: pk.jersey ?? p?.jersey ?? null,
      },
      dk,
      fifty: fiftyFiftyClass(cfg.stat, dk?.line),
      rungs,
      kalshiEvent: L.event,
    });
  }
  stats.games = gamesWithProps.size;
  stats.espnGames = dkByEvent.size;

  const kick = new Map(pre.map((g) => [g.id, Date.parse(g.kickoff) || 0]));
  props.sort((a, b) => (kick.get(a.gameId) - kick.get(b.gameId)) || (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0)
    || (SIDE_RANK[a.player.side] - SIDE_RANK[b.player.side])
    || String(a.player.name).localeCompare(String(b.player.name))
    || (STAT_ORDER[a.stat] - STAT_ORDER[b.stat])
    || (a.kalshiEvent < b.kalshiEvent ? -1 : a.kalshiEvent > b.kalshiEvent ? 1 : 0));
  unmatched.sort();

  const kalshiOk = PROP_SERIES_LIST.some((s) => Array.isArray(kalshi[s]));
  if (!kalshiOk) errors.push('props: no Kalshi prop data');
  return { props, unmatched, ok: kalshiOk && !(raw?.errors || []).length, errors: capErrors(errors), stats };
}

// ---------------------------------------------------------------- fetching

/** True when Kalshi lists at least one open DK-comparable ladder for this game (else ESPN propBets are skipped). */
function gamesWithKalshiLadders(kalshi, games) {
  const lookup = kalshiGameIndex(games);
  const ids = new Set();
  for (const [series, cfg] of Object.entries(PROP_SERIES)) {
    if (!cfg.espnType) continue;
    for (const m of Array.isArray(kalshi[series]) ? kalshi[series] : []) {
      if (!m?.event_ticker || !isOpenMarket(m)) continue;
      const hit = lookup(m.event_ticker);
      if (hit) ids.add(hit.game.id);
    }
  }
  return ids;
}

/**
 * fetchPropInputs({ games, fetchImpl, now }) -> { fetchedAt, kalshi, espnProps, errors, requests, stats }
 * Kalshi: the 15 prop series, status=open, paginated (about 15 to 18 requests on a full Sunday).
 * ESPN: DK propBets (up to 2 pages of 1000) for each NFL game with state 'pre' kicking off within 48 h that Kalshi
 * has DK-comparable ladders for (about 2 requests per game; 404 = DK props not posted, which is not an error).
 * Items are slimmed (slimPropItem) and milestones dropped at fetch time. Never throws for upstream failures.
 */
export async function fetchPropInputs({
  games = [], fetchImpl = globalThis.fetch, now = Date.now(), cacheDir = null, // eslint-disable-line no-unused-vars
  pauseMs = 150, horizonMs = PROP_HORIZON_MS, maxEspnGames = 16, series = PROP_SERIES_LIST, espnTimeoutMs = 10000, log = () => {},
} = {}) {
  const t0 = Date.now();
  const fetchedAt = new Date(t0).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const kHttp = createHttp({ fetchImpl, retries: 0 }); // the second Kalshi host is the retry
  // propBets: 404 (not posted) is the usual answer and a miss only costs one game's DK lines for one run, so a short
  // timeout and no retry: a stalled ESPN core host costs at most about 8 games x 10 s per lane, not 8 x 51 s.
  const eHttp = createHttp({ fetchImpl, retries: 0, timeoutMs: espnTimeoutMs });
  const client = createKalshiClient({ http: kHttp });
  const errors = [];
  const kalshi = {};
  // Prop markets close about 48 h after kickoff: this keeps games up to about 4 days out and skips later weeks.
  const maxCloseTs = Math.floor((now + 6 * DAY) / 1000);

  await mapLimit(series, 2, async (s) => {
    try { kalshi[s] = await fetchSeriesMarkets(client, s, { maxCloseTs }); } catch (e) { errors.push(`kalshi ${s}: ${errorText(e)}`); }
    await sleep(pauseMs);
  });
  const kalshiMs = Date.now() - t0;
  const kalshiDown = !series.some((s) => Array.isArray(kalshi[s]));

  const withLadders = gamesWithKalshiLadders(kalshi, games);
  const targets = games
    .filter((g) => g?.league === 'nfl' && g.state === 'pre' && /^\d+$/.test(String(g.espnId || '')))
    .filter((g) => { const k = Date.parse(g.kickoff); return Number.isFinite(k) && k >= now - 3600e3 && k <= now + horizonMs; })
    .filter((g) => kalshiDown || withLadders.has(g.id))
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || String(a.espnId).localeCompare(String(b.espnId)));
  if (targets.length > maxEspnGames) errors.push(`espn propBets: ${targets.length} games in range, fetched the first ${maxEspnGames}`);

  const espnProps = {};
  let notPosted = 0;
  const t1 = Date.now();
  await mapLimit(targets.slice(0, maxEspnGames), 2, async (g) => {
    const id = String(g.espnId);
    const base = `${ESPN_CORE_NFL}/events/${id}/competitions/${id}/odds/100/propBets?limit=1000`;
    const items = [];
    let pageCount = 1;
    try {
      for (let page = 1; page <= Math.min(pageCount, PROPBETS_MAX_PAGES); page++) {
        let j;
        try {
          j = await eHttp.getJson(`${base}&page=${page}`);
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) { if (page === 1) notPosted++; break; }
          throw e;
        }
        pageCount = Math.max(1, Number(j?.pageCount) || 1);
        for (const it of Array.isArray(j?.items) ? j.items : []) { const s = slimPropItem(it); if (s) items.push(s); }
        await sleep(pauseMs);
      }
      if (pageCount > PROPBETS_MAX_PAGES) errors.push(`espn propBets ${id}: ${pageCount} pages, read ${PROPBETS_MAX_PAGES}`);
      if (items.length) espnProps[id] = items;
    } catch (e) {
      errors.push(`espn propBets ${id}: ${errorText(e)}`);
      if (items.length) espnProps[id] = items;
    }
  });
  const espnMs = Date.now() - t1;
  log(`props: kalshi ${kHttp.stats.requests} req ${kalshiMs} ms, espn propBets ${eHttp.stats.requests} req for ${Math.min(targets.length, maxEspnGames)} games (${notPosted} not posted) ${espnMs} ms`);
  return {
    fetchedAt,
    kalshi,
    espnProps,
    errors,
    requests: kHttp.stats.requests + eHttp.stats.requests,
    stats: { kalshiRequests: kHttp.stats.requests, espnRequests: eHttp.stats.requests, espnGames: Math.min(targets.length, maxEspnGames),
      espnNotPosted: notPosted, kalshiMs, espnMs, kalshiHost: client.hostUsed() },
  };
}
