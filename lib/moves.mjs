// Line-move history: the collector's own record of DraftKings game lines, team totals and prop lines, kept for 48 h
// in state/history.json (the Actions cache carries it from run to run). Every timestamp is the collector's `now`,
// never ESPN's lastUpdated (which runs about 3 h fast). Pure functions plus two small file helpers.
//
// Run order for the integrator (closes must read the history BEFORE it is updated):
//   const prev = await readHistoryFile(join(stateDir, 'history.json'));
//   const closes = closesFromTransition(prev, snapshot.games, snapshot.props, { now });        // lib/closes.mjs
//   await writeClosesFile(join(stateDir, 'closes'), closes, { now });
//   const { history, moves } = updateHistory(prev, historyInput(snapshot.games, snapshot.props), { now });
//   applyMoves(snapshot.games, snapshot.props, moves);
//   await writeHistoryFile(join(stateDir, 'history.json'), history);
//
// history = { v: 1, at, games: { [gameId]: GameHist }, props: { [propKey]: PropHist } }
//   GameHist = { league, kickoff, home, away, state, seen, pre: { at, odds, dkTeamTotals } | null, lines: { [market]: [[at, value]] } }
//   PropHist = { gameId, stat, player: { espnId, name, team, side }, seen, dk, line: [[at, value]] }
// lines keep change points only (a point is added when the value changes), plus the newest point older than 48 h as
// the baseline. Moves are the changes inside the last 48 h.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const HISTORY_VERSION = 1;
export const KEEP_MS = 48 * 3600e3;
export const MAX_POINTS = 200;            // per line; a line flapping every run for 48 h would be 576 points
export const ML_MIN_STEP = 0.005;         // record a moneyline move only when the home win probability moves >= 0.5 pp
export const GAME_MARKETS = ['ml', 'spread', 'total', 'teamTotalHome', 'teamTotalAway'];

const isoOf = (t) => {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`moves: bad time ${t}`);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
};
const nnum = (x) => (x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);

/** American odds -> implied probability (with vig). */
export function americanToProb(a) {
  const x = nnum(a);
  if (x == null || x === 0 || (x > -100 && x < 100)) return null;
  return x < 0 ? -x / (-x + 100) : 100 / (x + 100);
}

/**
 * The tracked value of each game market. ml = DK home win probability with the vig removed proportionally
 * (home / (home + away)), 3 decimals; spread = DK home line; total = DK total; teamTotalHome/Away = DK team total line.
 */
export function gameLineValues(odds, dkTeamTotals) {
  const out = { ml: null, spread: null, total: null, teamTotalHome: null, teamTotalAway: null };
  const ph = americanToProb(odds?.ml?.home), pa = americanToProb(odds?.ml?.away);
  if (ph != null && pa != null) out.ml = Math.round((ph / (ph + pa)) * 1000) / 1000;
  out.spread = nnum(odds?.spread?.home);
  out.total = nnum(odds?.total?.line);
  out.teamTotalHome = nnum(dkTeamTotals?.home?.line);
  out.teamTotalAway = nnum(dkTeamTotals?.away?.line);
  return out;
}

/** SPEC 10.1 prop key: gameId|stat|player.espnId (null when the player has no ESPN id). */
export function propKey(p) {
  const id = p?.player?.espnId;
  if (!p?.gameId || !p?.stat || id === null || id === undefined || id === '') return null;
  return `${p.gameId}|${p.stat}|${id}`;
}

/**
 * Build updateHistory's `current` from snapshot games and props. dkTeamTotals: optional { [gameId]: {...} } when the
 * games do not carry g.dkTeamTotals yet. Props without an ESPN id are skipped (no stable key).
 */
export function historyInput(games = [], props = [], { dkTeamTotals = null } = {}) {
  return {
    games: (games || []).filter((g) => g?.id).map((g) => ({
      id: g.id, league: g.league ?? null, kickoff: g.kickoff ?? null, state: g.state ?? null,
      home: g.home?.abbr ?? null, away: g.away?.abbr ?? null,
      odds: g.odds ?? null, dkTeamTotals: g.dkTeamTotals ?? dkTeamTotals?.[g.id] ?? null,
    })),
    props: (props || []).map((p) => ({ key: propKey(p), gameId: p?.gameId, stat: p?.stat,
      player: p?.player ? { espnId: p.player.espnId ?? null, name: p.player.name ?? null, team: p.player.team ?? null, side: p.player.side ?? null } : null,
      dk: p?.dk ?? null })).filter((p) => p.key),
  };
}

function cleanSeries(s) {
  return Array.isArray(s) ? s.filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Date.parse(p[0])) && nnum(p[1]) != null) : [];
}

// Copy a previous history, dropping anything malformed. A wrong version or shape starts fresh.
function loadPrev(prev) {
  const h = { v: HISTORY_VERSION, at: null, games: {}, props: {} };
  if (!prev || typeof prev !== 'object' || prev.v !== HISTORY_VERSION) return h;
  h.at = typeof prev.at === 'string' ? prev.at : null;
  for (const [id, e] of Object.entries(prev.games || {})) {
    if (!e || typeof e !== 'object') continue;
    const lines = {};
    for (const m of GAME_MARKETS) { const s = cleanSeries(e.lines?.[m]); if (s.length) lines[m] = s; }
    h.games[id] = { league: e.league ?? null, kickoff: e.kickoff ?? null, home: e.home ?? null, away: e.away ?? null,
      state: e.state ?? null, seen: e.seen ?? null, pre: e.pre && typeof e.pre === 'object' ? e.pre : null, lines };
  }
  for (const [k, e] of Object.entries(prev.props || {})) {
    if (!e || typeof e !== 'object') continue;
    h.props[k] = { gameId: e.gameId ?? null, stat: e.stat ?? null, player: e.player ?? null, seen: e.seen ?? null, dk: e.dk ?? null, line: cleanSeries(e.line) };
  }
  return h;
}

function pushPoint(series, at, v, minStep = 0) {
  if (v == null) return series;
  const last = series.length ? series[series.length - 1][1] : null;
  if (last != null && (minStep ? Math.abs(v - last) < minStep : v === last)) return series;
  series.push([at, v]);
  return series;
}

// Keep the newest point older than the cutoff (the baseline a later move starts from) and everything after it.
function prune(series, cutoffMs) {
  let firstKeep = 0;
  for (let i = 0; i < series.length; i++) if (Date.parse(series[i][0]) < cutoffMs) firstKeep = i;
  const out = series.slice(firstKeep);
  return out.length > MAX_POINTS ? out.slice(out.length - MAX_POINTS) : out;
}

function movesOf(series, cutoffMs) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    if (Date.parse(series[i][0]) >= cutoffMs) out.push({ from: series[i - 1][1], to: series[i][1], at: series[i][0] });
  }
  return out;
}

/**
 * updateHistory(prevHistory | null, current, { now }) -> { history, moves }
 * current = { games: [{ id, odds, dkTeamTotals, state?, kickoff?, league?, home?, away? }], props: [{ key, dk, gameId?, stat?, player? }] }
 *   (historyInput() builds it). A game with no state is treated as pregame.
 * Lines are recorded only while a game is 'pre' (DK lines freeze at kickoff; in-game numbers are not pregame moves).
 * moves = { games: { [gameId]: [{ market, from, to, at }] }, props: { [propKey]: [{ from, to, at }] } }, last 48 h, oldest first.
 * The previous history object is not modified.
 */
export function updateHistory(prevHistory, current, { now } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const at = isoOf(nowMs);
  const cutoff = nowMs - KEEP_MS;
  const h = loadPrev(prevHistory);
  h.at = at;
  const stateOf = new Map();

  for (const cg of current?.games || []) {
    if (!cg?.id) continue;
    const e = (h.games[cg.id] ||= { league: null, kickoff: null, home: null, away: null, state: null, seen: null, pre: null, lines: {} });
    for (const k of ['league', 'kickoff', 'home', 'away']) if (cg[k] != null) e[k] = cg[k];
    const state = cg.state ?? 'pre';
    e.state = state;
    e.seen = at;
    stateOf.set(cg.id, state);
    if (state !== 'pre') continue;
    // Last pregame values for the closes archive: keep the previous value when DK pulls a line right before kickoff.
    e.pre = { at, odds: cg.odds ?? e.pre?.odds ?? null, dkTeamTotals: cg.dkTeamTotals ?? e.pre?.dkTeamTotals ?? null };
    const vals = gameLineValues(cg.odds, cg.dkTeamTotals);
    for (const m of GAME_MARKETS) {
      if (vals[m] == null) continue;
      e.lines[m] = pushPoint(e.lines[m] || [], at, vals[m], m === 'ml' ? ML_MIN_STEP : 0);
    }
  }

  // Games that were pregame, are gone from this run and whose kickoff has passed have started: mark them so the
  // closes archive does not fire again on the next run.
  for (const e of Object.values(h.games)) {
    if (e.seen !== at && e.state === 'pre' && Number.isFinite(Date.parse(e.kickoff)) && Date.parse(e.kickoff) <= nowMs) e.state = 'started';
  }

  for (const cp of current?.props || []) {
    const key = cp?.key;
    if (!key) continue;
    const gameId = cp.gameId ?? key.split('|')[0];
    const gs = stateOf.get(gameId) ?? h.games[gameId]?.state ?? 'pre';
    if (gs !== 'pre') continue;
    const e = (h.props[key] ||= { gameId, stat: cp.stat ?? key.split('|')[1] ?? null, player: null, seen: null, dk: null, line: [] });
    e.gameId = gameId;
    if (cp.stat) e.stat = cp.stat;
    if (cp.player) e.player = cp.player;
    else if (!e.player) e.player = { espnId: key.split('|')[2] ?? null };
    e.seen = at;
    const line = nnum(cp.dk?.line);
    if (line != null) {
      e.dk = cp.dk;
      e.line = pushPoint(e.line, at, line);
    }
  }

  // prune to 48 h and derive moves
  const moves = { games: {}, props: {} };
  for (const [id, e] of Object.entries(h.games)) {
    if (!e.seen || Date.parse(e.seen) < cutoff) { delete h.games[id]; continue; }
    const gm = [];
    for (const m of GAME_MARKETS) {
      if (!e.lines[m]) continue;
      e.lines[m] = prune(e.lines[m], cutoff);
      for (const mv of movesOf(e.lines[m], cutoff)) gm.push({ market: m, ...mv });
    }
    gm.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : GAME_MARKETS.indexOf(a.market) - GAME_MARKETS.indexOf(b.market)));
    if (gm.length) moves.games[id] = gm;
  }
  for (const [k, e] of Object.entries(h.props)) {
    if (!e.seen || Date.parse(e.seen) < cutoff) { delete h.props[k]; continue; }
    e.line = prune(e.line, cutoff);
    const pm = movesOf(e.line, cutoff);
    if (pm.length) moves.props[k] = pm;
  }
  return { history: h, moves };
}

/** Attach moves to snapshot games (g.moves) and props (p.moves). Every game and prop gets an array. Mutates. */
export function applyMoves(games = [], props = [], moves = { games: {}, props: {} }) {
  for (const g of games || []) if (g?.id) g.moves = moves?.games?.[g.id] ? moves.games[g.id].map((m) => ({ ...m })) : [];
  for (const p of props || []) {
    const k = propKey(p);
    p.moves = k && moves?.props?.[k] ? moves.props[k].map((m) => ({ ...m })) : [];
  }
}

/** Read state/history.json. Missing, empty or corrupt file -> null (start fresh). */
export async function readHistoryFile(path) {
  try {
    const j = JSON.parse(await readFile(path, 'utf8'));
    return j && typeof j === 'object' && j.v === HISTORY_VERSION ? j : null;
  } catch { return null; }
}

/** Write state/history.json atomically (temp file + rename). */
export async function writeHistoryFile(path, history) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(history));
  await rename(tmp, path);
}
