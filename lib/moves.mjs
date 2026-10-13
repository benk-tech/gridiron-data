// Line-move history: the collector's own record of DraftKings game lines, team totals and prop lines, plus Kalshi's
// implied centers (spread, total, home win) per game, kept for 48 h in state/history.json (the Actions cache carries
// it from run to run). Every timestamp is the collector's `now`, never ESPN's lastUpdated (which runs about 3 h fast).
// The Kalshi centers come from the markets already in the snapshot (no extra requests); next to the DK lines they
// show how many minutes Kalshi takes to follow a DK move (the lag angle). Pure functions plus two small file helpers.
//
// Run order for the integrator (closes must read the history BEFORE it is updated):
//   const prev = await readHistoryFile(join(stateDir, 'history.json'));
//   const closes = closesFromTransition(prev, snapshot.games, snapshot.props, { now });        // lib/closes.mjs
//   await writeClosesFile(join(stateDir, 'closes'), closes, { now });
//   const { history, moves } = updateHistory(prev, historyInput(snapshot.games, snapshot.props), { now });
//   applyMoves(snapshot.games, snapshot.props, moves);          // g.moves, p.moves and g.kalshiMoves
//   await writeHistoryFile(join(stateDir, 'history.json'), history);
//
// history = { v: 1, at, games: { [gameId]: GameHist }, props: { [propKey]: PropHist } }
//   GameHist = { league, kickoff, home, away, state, seen, pre: { at, odds, dkTeamTotals } | null,
//                lines: { [market]: [[at, value]] }, kalshi: { ['ml'|'spread'|'total']: [[at, value]] },
//                book: { [key]: [bid, ask] } | null, bookAt: ISO | null,
//                first: { at, odds } | null, events: [Kalshi event ticker], cls?: 'FF'|'FC'|'CC'|null, lookahead?: true }
// `first` is the first DraftKings line this collector saw for the game while it was pregame (the run's time and the
// Odds as the snapshot had them), never overwritten: the closes archive carries it as firstLine. With the lookahead
// part, CFB games enter the history up to 16 days out, so for them it is close to DK's first post. ESPN's own
// homeOpen / lineOpen fields stay the true opener. `events` (game, spread, total, team total event tickers, the newest
// run's) lets the settle step find a ticker's game. `cls` and `lookahead` mark part B games, which the cross run
// plausibility checks leave out (lib/build.mjs previousUpcoming).
//   PropHist = { gameId, stat, player: { espnId, name, team, side }, seen, dk, line: [[at, value]] }
// lines keep change points only (a point is added when the value changes), plus the newest point older than 48 h as
// the baseline. Moves are the changes inside the last 48 h. `kalshi` and `book` (and later `first`, `events`, `cls`,
// `lookahead`) were added inside v1: a history file without them loads as is (no Kalshi points, book or first line
// yet), and an older collector reading a newer file drops them.
// `book` is Kalshi's folded book per contract key on the last pregame run that had one (foldKalshiBook), `bookAt` that
// run's time; the next run puts it on the snapshot as games[i].kalshi.prevQuotes and prevAt (prevBooks).

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const HISTORY_VERSION = 1;
export const KEEP_MS = 48 * 3600e3;
export const MAX_POINTS = 200;            // per line; a line flapping every run for 48 h would be 576 points
export const ML_MIN_STEP = 0.005;         // record a moneyline move only when the home win probability moves >= 0.5 pp
export const GAME_MARKETS = ['ml', 'spread', 'total', 'teamTotalHome', 'teamTotalAway'];

// Kalshi implied centers. They are interpolated from mid prices, so they wiggle by a tenth of a point or half a cent
// from run to run without anyone trading; a point is recorded only when the center has moved at least this far from
// the last recorded point (0.25 on a 0.1 grid means 0.3 or more). Measured on the 2026-10-12 snapshots: over 30 to
// 40 minutes 3 to 4 of 65 ladders moved 0.3 or more and 4 to 6 of 75 moneylines moved 1 pp or more.
export const KALSHI_MARKETS = ['ml', 'spread', 'total'];
export const KALSHI_MIN_STEP = Object.freeze({ ml: 0.01, spread: 0.25, total: 0.25 });
export const KALSHI_MAX_SPREAD = 0.10;    // a market's mid counts only when its yes ask minus yes bid is at most this
export const KALSHI_SNAPSHOT_MAX = 20;    // newest Kalshi moves per market per game in the snapshot (a flapping ladder stays small)
const STEP_EPS = 1e-9;                    // 0.57 - 0.56 is 0.0099999... in floating point

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

// ---- Kalshi implied centers: the same method as the engine's angles.js kalshiCenters (gridiron-picks), so the
// newest recorded value lines up with what the site computes from the live markets. Team totals are left out.

// Mid of a market's YES quotes, or null when either side is missing, the quote is wider than KALSHI_MAX_SPREAD or the
// market is not active. Written exactly like the engine's check (including its floating point edge at 10 cents wide).
function kalshiMid(m) {
  const a = nnum(m?.yesAsk), b = nnum(m?.yesBid);
  if (!(a > 0 && a < 1) || !(b > 0 && b < 1) || a - b > KALSHI_MAX_SPREAD) return null;
  if (m.status && m.status !== 'active') return null;
  return (a + b) / 2;
}

// x where a series of points sorted by x first crosses level y, by straight-line interpolation. null when it never does.
function crossing(points, y = 0.5) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) return a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
  }
  return null;
}
const round = (x, d) => (x == null ? null : +x.toFixed(d) || 0); // `|| 0` turns -0 into 0

/**
 * Kalshi implied centers of a snapshot game, from the markets it already carries (no requests):
 *   ml     = home win probability, the mid of the home GAME market (else 1 minus the away mid), 3 decimals
 *   spread = home line where the spread ladder crosses 50% (negative = home favored, like odds.spread.home), 1 decimal
 *   total  = total points where the total ladder crosses 50%, 1 decimal
 * Each is null when the markets cannot give it (no ladder, quotes too wide, the ladder never crosses 50%).
 */
export function kalshiCenters(game) {
  const ms = Array.isArray(game?.kalshi?.markets) ? game.kalshi.markets : [];
  let ml = null;
  const gh = ms.find((m) => m?.type === 'game' && m.team === 'home'), ga = ms.find((m) => m?.type === 'game' && m.team === 'away');
  if (gh && kalshiMid(gh) != null) ml = kalshiMid(gh);
  else if (ga && kalshiMid(ga) != null) ml = 1 - kalshiMid(ga);
  // P(home margin > x): the home ladder gives it at x = strike, the away ladder at x = -strike as 1 minus its mid.
  const sp = [];
  for (const m of ms) {
    if (m?.type !== 'spread' || m.strike == null) continue;
    const v = kalshiMid(m);
    if (v == null) continue;
    if (m.team === 'home') sp.push({ x: +m.strike, y: v });
    else if (m.team === 'away') sp.push({ x: -m.strike, y: 1 - v });
  }
  sp.sort((a, b) => a.x - b.x);
  const homeMargin = crossing(sp, 0.5);
  const tp = ms.filter((m) => m?.type === 'total' && m.strike != null).map((m) => ({ x: +m.strike, y: kalshiMid(m) }))
    .filter((p) => p.y != null).sort((a, b) => a.x - b.x);
  return {
    ml: round(ml, 3),
    spread: homeMargin == null ? null : round(-homeMargin, 1),
    total: round(crossing(tp, 0.5), 1),
  };
}

// ---- Kalshi's folded book per contract key, written exactly like the engine's consensus.js kalshiBook (gridiron-picks),
// which folds the two winner markets into one key the same way. Keys are in ESPN home/away orientation with half point
// strikes only, the same keys as games[i].refs.venues: 'ml:home' (home wins), 'sp:home:3.5' / 'sp:away:3.5' (that team
// wins by more than 3.5), 'tot:44.5' (over 44.5). YES of 'ml:home' is YES on the home market or NO on the away market,
// whichever is cheaper, so ask = min(home YES ask, away NO ask) and bid = 1 - min(home NO ask, away YES ask). A side's
// ask is its yesAsk (YES) or its noAsk, else 1 - yesBid (NO); a size of 0 or less is no offer.
// The previous run's book on the snapshot (games[i].kalshi.prevQuotes, prevAt) is what lets the site require that a
// Kalshi price HELD for one run before calling it a bet (a fresh Kalshi move may be news). No extra requests.

/** A previous run's book older than this is not "the previous run" (a stale Actions cache, a long outage). */
export const PREV_BOOK_MAX_AGE_MS = 60 * 60e3;
const validP = (x) => x != null && x > 0 && x < 1;
const halfStrike = (x) => Number.isFinite(x) && Math.abs(Math.abs(x % 1) - 0.5) < 1e-9;
const r4 = (x) => +x.toFixed(4);
function bookKey(m) {
  const s = nnum(m.strike);
  if (m.type === 'game' && (m.team === 'home' || m.team === 'away')) return { key: 'ml:home', flip: m.team === 'away' };
  if (m.type === 'spread' && (m.team === 'home' || m.team === 'away') && halfStrike(s)) return { key: `sp:${m.team}:${s}`, flip: false };
  if (m.type === 'total' && halfStrike(s)) return { key: `tot:${s}`, flip: false };
  return null;
}
function sideAsk(m, side) {
  let ask, size;
  if (side === 'yes') { ask = nnum(m.yesAsk); size = nnum(m.yesAskSize); }
  else {
    const nA = nnum(m.noAsk), yB = nnum(m.yesBid);
    ask = validP(nA) ? nA : validP(yB) ? 1 - yB : null;
    size = nnum(m.yesBidSize);
  }
  if (!validP(ask) || (size != null && size <= 0)) return null;
  return r4(ask);
}
/**
 * Kalshi's folded book of a snapshot game: { [key]: { bid, ask } } for every key with both sides offered (active
 * markets only), in market order. Team totals and whole point strikes are left out.
 */
export function foldKalshiBook(game) {
  const best = {};
  for (const m of Array.isArray(game?.kalshi?.markets) ? game.kalshi.markets : []) {
    if (!m || (m.status != null && m.status !== 'active')) continue;
    const k = bookKey(m);
    if (!k) continue;
    const b = (best[k.key] ||= { yes: null, no: null });
    const y = sideAsk(m, k.flip ? 'no' : 'yes'), n = sideAsk(m, k.flip ? 'yes' : 'no');
    if (y != null && (b.yes == null || y < b.yes)) b.yes = y;
    if (n != null && (b.no == null || n < b.no)) b.no = n;
  }
  const out = {};
  for (const [key, b] of Object.entries(best)) if (b.yes != null && b.no != null) out[key] = { bid: r4(1 - b.no), ask: b.yes };
  return out;
}

/**
 * The previous run's Kalshi book for this run's games: Map(gameId -> { prevQuotes: { [key]: { bid, ask } }, prevAt }).
 * prev = state/history.json as read at the start of this run (null on a first run or a lost cache: then nothing).
 * A game gets one only when it is pregame now, the previous run (prev.at) is less than maxAgeMs old, that run recorded
 * the game's book (bookAt === prev.at, so a game new to the board or missing from the last run gets none), and only
 * for the keys both runs quote on both sides. Pure; never throws on a malformed file (that game is skipped).
 */
export function prevBooks(prev, games = [], { now, maxAgeMs = PREV_BOOK_MAX_AGE_MS } = {}) {
  const out = new Map();
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const at = typeof prev?.at === 'string' ? Date.parse(prev.at) : NaN;
  if (!prev || prev.v !== HISTORY_VERSION || !Number.isFinite(at) || !(nowMs - at > 0 && nowMs - at <= maxAgeMs)) return out;
  for (const g of games || []) {
    if (!g?.id || g.state !== 'pre') continue;
    const e = prev.games?.[g.id];
    if (!e || typeof e !== 'object' || e.bookAt !== prev.at || !e.book || typeof e.book !== 'object') continue;
    const prevQuotes = {};
    for (const key of Object.keys(foldKalshiBook(g))) {
      const p = e.book[key];
      if (Array.isArray(p) && p.length === 2 && validP(nnum(p[0])) && validP(nnum(p[1]))) prevQuotes[key] = { bid: nnum(p[0]), ask: nnum(p[1]) };
    }
    if (Object.keys(prevQuotes).length) out.set(g.id, { prevQuotes, prevAt: prev.at });
  }
  return out;
}

/** Put prevBooks() on the snapshot games: g.kalshi.prevQuotes and g.kalshi.prevAt, only on the games it lists. Mutates. */
export function applyPrevBooks(games = [], books = new Map()) {
  for (const g of games || []) {
    const b = books.get(g?.id);
    if (!b || !g.kalshi) continue;
    g.kalshi.prevQuotes = b.prevQuotes;
    g.kalshi.prevAt = b.prevAt;
  }
}

/** SPEC 10.1 prop key: gameId|stat|player.espnId (null when the player has no ESPN id). */
export function propKey(p) {
  const id = p?.player?.espnId;
  if (!p?.gameId || !p?.stat || id === null || id === undefined || id === '') return null;
  return `${p.gameId}|${p.stat}|${id}`;
}

/**
 * Build updateHistory's `current` from snapshot games and props. dkTeamTotals: optional { [gameId]: {...} } when the
 * games do not carry g.dkTeamTotals yet. Props without an ESPN id are skipped (no stable key). Each game also gets
 * its Kalshi implied centers (kalshiCenters) and its folded book (foldKalshiBook) from g.kalshi.markets.
 */
export function historyInput(games = [], props = [], { dkTeamTotals = null } = {}) {
  return {
    games: (games || []).filter((g) => g?.id).map((g) => ({
      id: g.id, league: g.league ?? null, kickoff: g.kickoff ?? null, state: g.state ?? null,
      home: g.home?.abbr ?? null, away: g.away?.abbr ?? null,
      odds: g.odds ?? null, dkTeamTotals: g.dkTeamTotals ?? dkTeamTotals?.[g.id] ?? null,
      kalshi: kalshiCenters(g),
      book: foldKalshiBook(g),
      events: [g.kalshi?.gameEvent, g.kalshi?.spreadEvent, g.kalshi?.totalEvent, g.kalshi?.teamTotalEvent].filter((e) => typeof e === 'string' && e),
      ...(g.cls !== undefined ? { cls: g.cls } : {}),
      ...(g.lookahead === true ? { lookahead: true } : {}),
    })),
    props: (props || []).map((p) => ({ key: propKey(p), gameId: p?.gameId, stat: p?.stat,
      player: p?.player ? { espnId: p.player.espnId ?? null, name: p.player.name ?? null, team: p.player.team ?? null, side: p.player.side ?? null } : null,
      dk: p?.dk ?? null })).filter((p) => p.key),
  };
}

function cleanSeries(s) {
  return Array.isArray(s) ? s.filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Date.parse(p[0])) && nnum(p[1]) != null) : [];
}

// A stored book { [key]: [bid, ask] } with only valid entries, or null.
function cleanBook(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const out = {};
  for (const [k, p] of Object.entries(b)) if (Array.isArray(p) && p.length === 2 && validP(nnum(p[0])) && validP(nnum(p[1]))) out[k] = [nnum(p[0]), nnum(p[1])];
  return Object.keys(out).length ? out : null;
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
    const kalshi = {}; // absent in files written before the Kalshi centers were added
    for (const m of KALSHI_MARKETS) { const s = cleanSeries(e.kalshi?.[m]); if (s.length) kalshi[m] = s; }
    const book = cleanBook(e.book); // absent in files written before the folded book was added
    h.games[id] = { league: e.league ?? null, kickoff: e.kickoff ?? null, home: e.home ?? null, away: e.away ?? null,
      state: e.state ?? null, seen: e.seen ?? null, pre: e.pre && typeof e.pre === 'object' ? e.pre : null, lines, kalshi,
      book, bookAt: book && typeof e.bookAt === 'string' ? e.bookAt : null,
      // absent in files written before part B: no first line on record, no events, no class
      first: e.first && typeof e.first === 'object' && typeof e.first.at === 'string' && e.first.odds && typeof e.first.odds === 'object' ? { at: e.first.at, odds: e.first.odds } : null,
      events: Array.isArray(e.events) ? e.events.filter((x) => typeof x === 'string' && x) : [] };
    if (e.cls === 'FF' || e.cls === 'FC' || e.cls === 'CC' || e.cls === null) h.games[id].cls = e.cls;
    if (e.lookahead === true) h.games[id].lookahead = true;
  }
  for (const [k, e] of Object.entries(prev.props || {})) {
    if (!e || typeof e !== 'object') continue;
    h.props[k] = { gameId: e.gameId ?? null, stat: e.stat ?? null, player: e.player ?? null, seen: e.seen ?? null, dk: e.dk ?? null, line: cleanSeries(e.line) };
  }
  return h;
}

function pushPoint(series, at, v, minStep = 0, eps = 0) {
  if (v == null) return series;
  const last = series.length ? series[series.length - 1][1] : null;
  if (last != null && (minStep ? Math.abs(v - last) < minStep - eps : v === last)) return series;
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

// Change points of a game's series inside the window, as moves sorted by time, then by market order.
function gameMoves(seriesByMarket, markets, cutoff, maxPerMarket = Infinity) {
  const out = [];
  for (const m of markets) {
    if (!seriesByMarket[m]) continue;
    seriesByMarket[m] = prune(seriesByMarket[m], cutoff);
    const list = movesOf(seriesByMarket[m], cutoff);
    for (const mv of list.length > maxPerMarket ? list.slice(list.length - maxPerMarket) : list) out.push({ market: m, ...mv });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : markets.indexOf(a.market) - markets.indexOf(b.market)));
}

/**
 * updateHistory(prevHistory | null, current, { now }) -> { history, moves }
 * current = { games: [{ id, odds, dkTeamTotals, kalshi?, state?, kickoff?, league?, home?, away? }], props: [{ key, dk, gameId?, stat?, player? }] }
 *   (historyInput() builds it; kalshi = kalshiCenters(game)). A game with no state is treated as pregame.
 * Lines and Kalshi centers are recorded only while a game is 'pre' (DK lines freeze at kickoff and Kalshi trades in
 * game; in-game numbers are not pregame moves).
 * moves = { games: { [gameId]: [{ market, from, to, at }] }, props: { [propKey]: [{ from, to, at }] },
 *           kalshi: { [gameId]: [{ market: 'ml'|'spread'|'total', from, to, at }] } }, last 48 h, oldest first;
 *   kalshi keeps only the newest KALSHI_SNAPSHOT_MAX per market (the history keeps them all, up to MAX_POINTS).
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
    const e = (h.games[cg.id] ||= { league: null, kickoff: null, home: null, away: null, state: null, seen: null, pre: null, lines: {}, kalshi: {}, book: null, bookAt: null, first: null, events: [] });
    for (const k of ['league', 'kickoff', 'home', 'away']) if (cg[k] != null) e[k] = cg[k];
    const state = cg.state ?? 'pre';
    e.state = state;
    e.seen = at;
    stateOf.set(cg.id, state);
    if (Array.isArray(cg.events) && cg.events.length) e.events = [...cg.events];
    if (cg.cls !== undefined) e.cls = cg.cls;
    if (cg.lookahead === true) e.lookahead = true;
    else delete e.lookahead; // inside the 9 day window now (or a run without the lookahead part)
    if (state !== 'pre') continue;
    // First DK line this collector saw (never overwritten; a game without odds yet keeps waiting for one).
    if (!e.first && cg.odds && typeof cg.odds === 'object') e.first = { at, odds: cg.odds };
    // Last pregame values for the closes archive: keep the previous value when DK pulls a line right before kickoff.
    e.pre = { at, odds: cg.odds ?? e.pre?.odds ?? null, dkTeamTotals: cg.dkTeamTotals ?? e.pre?.dkTeamTotals ?? null };
    const vals = gameLineValues(cg.odds, cg.dkTeamTotals);
    for (const m of GAME_MARKETS) {
      if (vals[m] == null) continue;
      e.lines[m] = pushPoint(e.lines[m] || [], at, vals[m], m === 'ml' ? ML_MIN_STEP : 0);
    }
    // Kalshi centers: a market that cannot give one this run (quotes too wide, ladder pulled) adds nothing, so the
    // next real change still moves from the last recorded value.
    for (const m of KALSHI_MARKETS) {
      const v = nnum(cg.kalshi?.[m]);
      if (v == null) continue;
      e.kalshi[m] = pushPoint(e.kalshi[m] || [], at, v, KALSHI_MIN_STEP[m], STEP_EPS);
    }
    // Kalshi's folded book this run. A run with no two sided key keeps the old one with its older bookAt, so the next
    // run does not treat it as the previous run's book.
    const book = cleanBook(Object.fromEntries(Object.entries(cg.book || {}).map(([k, q]) => [k, [q?.bid, q?.ask]])));
    if (book) { e.book = book; e.bookAt = at; }
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
  const moves = { games: {}, props: {}, kalshi: {} };
  for (const [id, e] of Object.entries(h.games)) {
    if (!e.seen || Date.parse(e.seen) < cutoff) { delete h.games[id]; continue; }
    const gm = gameMoves(e.lines, GAME_MARKETS, cutoff);
    if (gm.length) moves.games[id] = gm;
    const km = gameMoves(e.kalshi, KALSHI_MARKETS, cutoff, KALSHI_SNAPSHOT_MAX);
    if (km.length) moves.kalshi[id] = km;
  }
  for (const [k, e] of Object.entries(h.props)) {
    if (!e.seen || Date.parse(e.seen) < cutoff) { delete h.props[k]; continue; }
    e.line = prune(e.line, cutoff);
    const pm = movesOf(e.line, cutoff);
    if (pm.length) moves.props[k] = pm;
  }
  return { history: h, moves };
}

/**
 * Attach moves to snapshot games (g.moves: DK lines, g.kalshiMoves: Kalshi implied centers) and props (p.moves).
 * Every game and prop gets an array. Mutates.
 */
export function applyMoves(games = [], props = [], moves = { games: {}, props: {}, kalshi: {} }) {
  for (const g of games || []) {
    if (!g?.id) continue;
    g.moves = moves?.games?.[g.id] ? moves.games[g.id].map((m) => ({ ...m })) : [];
    g.kalshiMoves = moves?.kalshi?.[g.id] ? moves.kalshi[g.id].map((m) => ({ ...m })) : [];
  }
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
