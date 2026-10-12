// injuries.mjs: NFL injuries graded per game, plus injury angles (Node 22+, no deps).
// Ported from research2/injuries/injuries.mjs (detectAngles), with these changes:
//   - grades use the SPEC 10.1 vocabulary: confirmed | likely | questionable | carryover | longterm
//     (research 'monitor' maps to 'questionable'; the research long-term flag maps to 'longterm')
//   - deterministic: no Date.now() inside the builder, no newsAgeHours / likelyPricedIn fields
//   - offensive line starters are kept (the research trim dropped lt/lg/c/rg/rt), so 'ol-out' can fire
//   - the previous kickoff per team comes from a small ESPN schedule capture (current and previous week),
//     plus opts.recentGames and the snapshot games, instead of a one-week guess
//
// fetchInjuryInputs(): ESPN league injuries feed (1 request every run) + 32 team depth charts and 2 scoreboards
//   (cached in cacheDir for 6 hours). Returns trimmed copies, not the 8.7 MB raw feed.
// buildInjuries(raw, { games }): pure. byGame[gameId] = { injuries: { home, away }, angles }.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHttp, mapLimit, errorText } from './http.mjs';
import { scoreboardUrl, iso } from './espn.mjs';
import { kalshiGameCode, nameKey } from './glue.mjs';

export const SITE_NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
export const DEPTH_TTL_MS = 6 * 3600e3;
const H = 3600e3, DAY = 864e5;

// ESPN NFL team ids (fallback only; the live list comes from the league injuries feed).
export const NFL_TEAM_IDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16',
  '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '33', '34'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function writeJson(path, data) {
  try { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(data)); } catch { /* cache is best effort */ }
}

// ---------------------------------------------------------------- status helpers

const LONG_TERM = /^(injured reserve|ir\b|physically unable|pup|suspen|reserve|non[- ]football|nfi|commissioner|did not report|exempt)/i;

/** Status label -> how unavailable (0 active .. 1 out). */
export function severity(status = '') {
  const s = String(status || '').toLowerCase();
  if (!s || s === 'active') return 0;
  if (s.startsWith('out') || LONG_TERM.test(s)) return 1;
  if (s.startsWith('doubtful')) return 0.75;
  if (s.startsWith('questionable') || s.startsWith('game time')) return 0.35;
  if (s.startsWith('day-to-day') || s.startsWith('probable')) return 0.1;
  return 0.2; // unknown non-active label: keep it visible
}
export const isLongTerm = (status = '') => LONG_TERM.test(String(status || ''));

/** The league feed has no athlete.id: parse it from the profile link or the headshot URL. */
export function athleteIdFrom(a = {}) {
  if (a.id != null && a.id !== '') return String(a.id);
  for (const l of a.links || []) { const m = /\/id\/(\d+)/.exec(l?.href || ''); if (m) return m[1]; }
  const m = /\/full\/(\d+)\.png/.exec(a.headshot?.href || '');
  return m ? m[1] : null;
}

/** Same normalisation as espn.mjs parseSummaryInjuries, so both injury sources read alike. */
export function normStatus(s) {
  const t = String(s || '').trim();
  if (/^injured reserve|^ir$/i.test(t)) return 'IR';
  if (/physically unable|^pup$/i.test(t)) return 'PUP';
  return t || null;
}

const clean = (x) => (x && !/^not specified$/i.test(String(x)) ? String(x) : null);
/** ESPN text for display: em/en dashes and spaced hyphens used as dashes become commas (Ben's writing rule). */
export const tidy = (x) => String(x ?? '').replace(/\s*[\u2013\u2014]\s*/g, ', ').replace(/\s+-\s+/g, ', ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- trimming (fetch side; also accepted by the builder)

const STARTER_NEWS = /\b(will|set to|expected to|slated to|in line to|poised to|going to|is to) (make (the|his)( first)? )?start\b|\bnamed (the )?starter|\bdraws? the start|\bwill get the (start|nod)/i;

/**
 * Raw ESPN league injuries JSON -> { fetchedAt, timestamp, count, items }. Every row is kept (Active rows clear an
 * older Questionable), but text is kept only for non-Active rows and QB rows (QB 'will start' notes are signals).
 */
export function trimLeague(j, fetchedAt = null) {
  if (j && Array.isArray(j.items)) return j; // already trimmed
  const items = [];
  for (const t of j?.injuries || []) {
    for (const r of t?.injuries || []) {
      const a = r?.athlete || {};
      const pos = a.position?.abbreviation || null;
      const active = String(r.status || '').toLowerCase() === 'active';
      const keepText = !active || pos === 'QB';
      const comment = String(r.shortComment || '');
      const long = String(r.longComment || '');
      items.push({
        id: athleteIdFrom(a), name: a.displayName || null, pos,
        teamId: String(a.team?.id ?? t.id ?? ''), team: a.team?.abbreviation || null,
        status: r.status || null, fantasy: r.details?.fantasyStatus?.abbreviation || null,
        injury: clean(r.details?.type), injuryDetail: clean(r.details?.detail), returnDate: r.details?.returnDate || null,
        date: r.date || null,
        comment: keepText ? comment.slice(0, 240) : '', longComment: keepText ? long.slice(0, 320) : '',
        starterNews: active && pos === 'QB' && STARTER_NEWS.test(`${comment} ${long}`),
      });
    }
  }
  return { fetchedAt, timestamp: j?.timestamp ?? null, count: items.length, items };
}

const OFF_SLOTS = ['qb', 'rb', 'fb', 'wr1', 'wr2', 'wr3', 'te', 'lt', 'lg', 'c', 'rg', 'rt'];
const OFF_KEEP = /^(qb|rb|fb|wr\d?|te\d?|lt|lg|c|rg|rt)$/;
const DEF_SECONDARY = /^(lcb|rcb|cb\d?|nb|ss|fs|s\d?)$/;
const DEF_SAFETY = /^(ss|fs|s\d?)$/;
const DEF_FRONT = /^(lde|rde|de|nt|ldt|rdt|dt|lilb|rilb|mlb|ilb|wlb|slb|olb|lolb|rolb|edge|wde|sde)$/;
const DEF_LB = /lb$/;
const SLOT_POS = { qb: 'QB', rb: 'RB', fb: 'FB', wr1: 'WR', wr2: 'WR', wr3: 'WR', te: 'TE', lt: 'OT', rt: 'OT', lg: 'G', rg: 'G', c: 'C' };
const slotPos = (k) => SLOT_POS[k] || (DEF_SECONDARY.test(k) ? (DEF_SAFETY.test(k) ? 'S' : 'CB') : DEF_LB.test(k) ? 'LB' : /nt/.test(k) ? 'NT' : /dt/.test(k) ? 'DT' : 'DE');

function trimAthlete(a, pos) {
  const inj = (a?.injuries || [])[0];
  return {
    id: String(a.id), name: a.displayName || a.name || null, pos,
    inj: inj ? { status: inj.status || null, date: inj.date || null, comment: String(inj.shortComment || '').slice(0, 160), fantasy: inj.details?.fantasyStatus?.abbreviation || null } : null,
  };
}

/**
 * Raw ESPN team depth chart -> { teamId, abbr, offense: { qb: [athlete...] ... }, defense: { lcb: [...] ... } }.
 * Groups are picked by content (a qb key; a secondary key), never by formation name or position in the list.
 * Already-trimmed input (the research depth_cache shape) passes through.
 */
export function trimDepth(j, teamId = null) {
  if (j && j.offense && j.defense && !Array.isArray(j.depthchart)) return j;
  const groups = Array.isArray(j?.depthchart) ? j.depthchart : [];
  const off = groups.find((g) => g?.positions?.qb) || null;
  const def = groups.find((g) => Object.keys(g?.positions || {}).some((k) => DEF_SECONDARY.test(k))) || null;
  const offense = {}, defense = {};
  for (const [k, p] of Object.entries(off?.positions || {})) {
    if (OFF_KEEP.test(k)) offense[k] = (p?.athletes || []).slice(0, 4).map((a) => trimAthlete(a, p?.position?.abbreviation || slotPos(k)));
  }
  for (const [k, p] of Object.entries(def?.positions || {})) {
    if (DEF_SECONDARY.test(k) || DEF_FRONT.test(k)) defense[k] = (p?.athletes || []).slice(0, 3).map((a) => trimAthlete(a, p?.position?.abbreviation || slotPos(k)));
  }
  return { teamId: String(j?.team?.id ?? teamId ?? ''), abbr: j?.team?.abbreviation || null, offense, defense };
}

/** Raw ESPN scoreboard -> [{ id, kickoff, state, home: { id, abbr }, away: { id, abbr } }] (schedule only). */
export function trimSchedule(board) {
  const out = [];
  for (const e of board?.events || []) {
    const c = e?.competitions?.[0];
    const h = c?.competitors?.find((x) => x.homeAway === 'home'), a = c?.competitors?.find((x) => x.homeAway === 'away');
    const kickoff = iso(c?.date || e?.date);
    if (!h || !a || !kickoff) continue;
    out.push({ id: String(e.id), kickoff, state: e.status?.type?.state ?? c.status?.type?.state ?? null,
      home: { id: String(h.team?.id), abbr: h.team?.abbreviation || null }, away: { id: String(a.team?.id), abbr: a.team?.abbreviation || null } });
  }
  return out;
}

/** Calendar entry before (seasonType, week): the mirror of espn.mjs nextWeek. */
export function prevWeek(calendar, seasonType, week) {
  if (!Array.isArray(calendar)) return Number.isFinite(week) && week > 1 ? { seasonType, week: week - 1 } : null;
  const flat = [];
  for (const sec of calendar) for (const e of sec?.entries || []) flat.push({ seasonType: Number(sec.value), week: Number(e.value), start: Date.parse(e.startDate) });
  flat.sort((a, b) => a.start - b.start);
  const i = flat.findIndex((x) => x.seasonType === seasonType && x.week === week);
  return i > 0 ? { seasonType: flat[i - 1].seasonType, week: flat[i - 1].week } : null;
}

// ---------------------------------------------------------------- fetch

/**
 * fetchInjuryInputs({ fetchImpl, now, cacheDir }) ->
 *   { league, depth: { [espnTeamId]: trimmedDepth }, depthFetchedAt, schedule, leagueFetchedAt, depthCached, errors, requests }
 * League feed: 1 request every run. Depth charts (32) + schedule boards (2): only when the cache is older than
 * depthTtlMs (6 h). A failed refresh keeps the previous depth data and waits 30 minutes before retrying.
 */
export async function fetchInjuryInputs({
  fetchImpl = globalThis.fetch, now = Date.now(), cacheDir = null, depthTtlMs = DEPTH_TTL_MS,
  concurrency = 4, pauseMs = 150, retryDelayMs = 800, teamIds = null, log = () => {},
} = {}) {
  const nowMs = toMs(now);
  const http = createHttp({ fetchImpl, retries: 1, retryDelayMs });
  const errors = [];

  let league = null;
  const leagueFetchedAt = iso(nowMs);
  try {
    const j = await http.getJson(`${SITE_NFL}/injuries`);
    // A 200 without the injuries list (renamed key, error body) is a failed feed, not an empty one, so the game
    // summaries fallback runs and the source is reported down.
    if (!Array.isArray(j?.injuries)) throw new Error(`unexpected JSON (no injuries list; keys: ${Object.keys(j || {}).slice(0, 6).join(', ') || 'none'})`);
    league = trimLeague(j, leagueFetchedAt);
  } catch (e) { errors.push(`league injuries: ${errorText(e)}`); }

  const fromFeed = league ? [...new Set(league.items.map((x) => x.teamId).filter(Boolean))].sort((a, b) => a - b) : [];
  const ids = (teamIds || (fromFeed.length >= 30 ? fromFeed : NFL_TEAM_IDS)).map(String);

  const cachePath = cacheDir ? join(cacheDir, 'injuries-depth.json') : null;
  const cached = cachePath ? await readJson(cachePath) : null;
  const cachedAge = cached?.fetchedAt ? nowMs - Date.parse(cached.fetchedAt) : Infinity;
  const fresh = cached?.depth && cachedAge >= 0 && cachedAge < depthTtlMs && ids.every((id) => cached.depth[id]);
  const backoff = cached?.retryAfter && nowMs < Date.parse(cached.retryAfter);

  if (fresh || (backoff && cached?.depth)) {
    log(`injuries: depth charts from cache (${cached.fetchedAt})`);
    if (!fresh) errors.push(`depth: last refresh failed; using older charts until ${cached.retryAfter}`);
    return { league, depth: cached.depth, depthFetchedAt: cached.fetchedAt ?? null, schedule: cached.schedule || [], leagueFetchedAt: league ? leagueFetchedAt : null, depthCached: true, errors, requests: http.stats.requests };
  }

  const depth = {};
  let failed = 0;
  await mapLimit(ids, concurrency, async (id) => {
    try {
      depth[id] = trimDepth(await http.getJson(`${SITE_NFL}/teams/${id}/depthcharts`), id);
    } catch (e) {
      failed++;
      errors.push(`depth ${id}: ${errorText(e)}`);
      if (cached?.depth?.[id]) depth[id] = cached.depth[id]; // keep the older chart rather than nothing
    }
    if (pauseMs) await sleep(pauseMs);
  });

  // Schedule: current and previous week, for each team's previous kickoff.
  let schedule = [];
  try {
    const cur = await http.getJson(scoreboardUrl('nfl'));
    schedule.push(...trimSchedule(cur));
    const prev = prevWeek(cur?.leagues?.[0]?.calendar, Number(cur?.season?.type ?? cur?.leagues?.[0]?.season?.type?.type), Number(cur?.week?.number));
    if (prev) schedule.push(...trimSchedule(await http.getJson(scoreboardUrl('nfl', prev))));
  } catch (e) {
    errors.push(`schedule: ${errorText(e)}`);
    if (cached?.schedule?.length) schedule = cached.schedule;
  }
  const seen = new Set();
  schedule = schedule.filter((g) => !seen.has(g.id) && seen.add(g.id)).sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));

  const depthFetchedAt = iso(nowMs);
  if (cachePath) {
    if (failed > ids.length / 2) await writeJson(cachePath, { ...(cached || {}), depth: { ...(cached?.depth || {}), ...depth }, retryAfter: iso(nowMs + 30 * 60e3) });
    else await writeJson(cachePath, { fetchedAt: depthFetchedAt, depth, schedule });
  }
  return { league, depth, depthFetchedAt, schedule, leagueFetchedAt: league ? leagueFetchedAt : null, depthCached: false, errors, requests: http.stats.requests };
}

// ---------------------------------------------------------------- grading

export const GRADE_ORDER = ['confirmed', 'likely', 'questionable', 'carryover', 'longterm'];
const gradeRank = (g) => { const i = GRADE_ORDER.indexOf(g); return i < 0 ? 9 : i; };
const INGAME = /remainder of|won'?t return|will not return|rest of (the|sunday|monday|thursday|saturday)|questionable to return|exited|left (the|sunday|monday|thursday)/i;

/**
 * Does this status apply to THIS game? ESPN bumps `date` on every news blurb without changing the status, so the
 * date alone is not the designation time; fantasyStatus (INACTIVE vs OUT vs QUESTIONABLE vs IR) says which kind
 * of designation it is, and the team's previous kickoff says whether it predates this week.
 * st = { status, fantasy, date, comment, returnDate }. Returns { sev, grade, why, newInjury } or null (not hurt).
 */
export function gradeStatus(st, { kickMs, prevKickMs, state = 'pre' }) {
  const sev = severity(st?.status);
  if (!sev) return null;
  const d = Date.parse(st.date);
  const fant = String(st.fantasy || '').toUpperCase();
  const longTerm = isLongTerm(st.status) || /^(IR|PUP|NFI|SUSP|RESERVE)/.test(fant);
  if (longTerm) {
    const backBy = st.returnDate ? Date.parse(`${st.returnDate}T23:59:59Z`) : NaN;
    if (Number.isFinite(backBy) && backBy < kickMs) return { sev, grade: 'questionable', why: `on a reserve list (${fant || st.status}) with a return date before this game`, newInjury: false };
    return { sev, grade: 'longterm', why: `on a reserve list (${fant || st.status})`, newInjury: false };
  }
  if (!Number.isFinite(d)) return { sev, grade: 'questionable', why: 'no news date', newInjury: false };
  if (fant === 'INACTIVE') {
    const hi = state === 'in' ? kickMs + 5 * H : kickMs;
    if (d >= kickMs - 5 * H && d <= hi) return { sev, grade: 'confirmed', why: 'gameday inactive for this game', newInjury: false };
    return { sev, grade: 'carryover', why: 'inactive for the previous game; no designation for this game yet', newInjury: false };
  }
  if (d < prevKickMs) return { sev, grade: 'carryover', why: 'designation predates the previous game', newInjury: false };
  if (d < prevKickMs + 4.5 * H || (d < prevKickMs + 30 * H && INGAME.test(st.comment || ''))) {
    return { sev, grade: 'questionable', why: 'hurt in the previous game; status for this game not set', newInjury: true };
  }
  let grade;
  if (sev >= 1) grade = (kickMs - d) <= 4 * DAY || /ruled out|will miss|won'?t play|out for/i.test(st.comment || '') ? 'confirmed' : 'likely';
  else grade = sev >= 0.75 ? 'likely' : 'questionable';
  return { sev, grade, why: 'designation for this game', newInjury: false };
}

/** League row vs depth-embedded row: the newer one wins; depth-only trade/signing notes are dropped. */
function mergedStatus(p, injById) {
  const L = injById.get(p.id), D = p.inj;
  if (L && (!D || !D.date || Date.parse(L.date) >= Date.parse(D.date))) return { ...L, via: 'league' };
  if (D && /\b(trade[ds]?|acquired|signed|released|waived|claimed)\b/i.test(D.comment || '')) return null;
  if (D) return { status: D.status, fantasy: D.fantasy || null, date: D.date, comment: D.comment || '', longComment: '', injury: null, injuryDetail: null, returnDate: null, via: 'depth' };
  return null;
}

// ---------------------------------------------------------------- schedule index (previous kickoff per team)

function teamIdsOf(g) {
  const c = g?.competitions?.[0]?.competitors;
  const h = g?.home?.espnId ?? g?.home?.id ?? g?.homeComp?.team?.id ?? c?.find((x) => x.homeAway === 'home')?.team?.id;
  const a = g?.away?.espnId ?? g?.away?.id ?? g?.awayComp?.team?.id ?? c?.find((x) => x.homeAway === 'away')?.team?.id;
  return [h, a].filter((x) => x != null).map(String);
}
const kickoffOf = (g) => toMs(g?.kickoff ?? g?.competitions?.[0]?.date ?? g?.date);

function scheduleIndex(lists) {
  const m = new Map();
  for (const list of lists) for (const g of list || []) {
    const k = kickoffOf(g);
    if (!Number.isFinite(k)) continue;
    for (const id of teamIdsOf(g)) { if (!m.has(id)) m.set(id, new Set()); m.get(id).add(k); }
  }
  const out = new Map();
  for (const [id, s] of m) out.set(id, [...s].sort((a, b) => a - b));
  return out;
}

// ---------------------------------------------------------------- the builder

const OFF_ROLE = { qb: 'QB1', rb: 'RB1', wr1: 'WR1', wr2: 'WR2', wr3: 'WR3', te: 'TE1', lt: 'OL', lg: 'OL', c: 'OL', rg: 'OL', rt: 'OL' };
const ROLE_ORDER = ['QB1', 'RB1', 'WR1', 'WR2', 'WR3', 'TE1', 'OL', 'DL', 'LB', 'CB', 'S'];
const DEF_ORDER = ['lde', 'ldt', 'de', 'nt', 'dt', 'rdt', 'rde', 'wlb', 'lolb', 'lilb', 'mlb', 'ilb', 'rilb', 'slb', 'rolb', 'olb', 'edge', 'wde', 'sde', 'lcb', 'rcb', 'cb', 'nb', 'ss', 'fs', 's'];
const defRole = (k) => (DEF_SECONDARY.test(k) ? (DEF_SAFETY.test(k) ? 'S' : 'CB') : DEF_LB.test(k) ? 'LB' : 'DL');
const defSort = (a, b) => (DEF_ORDER.indexOf(a) + 1 || 99) - (DEF_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b);

const lastName = (n = '') => n.replace(/\b(Jr|Sr|II|III|IV|V)\b\.?/g, '').trim().split(/\s+/).pop() || '';
const mentionsStart = (text = '', name = '') => {
  const ln = lastName(name).replace(/[^A-Za-z'-]/g, '');
  return !!ln && new RegExp(`${ln}[^.]{0,90}\\bstart|\\bstart[^.]{0,90}${ln}`, 'i').test(text);
};

function injuryOut(p, s, role, depthRank) {
  return {
    espnId: p.id, name: p.name ?? s.name ?? null, pos: (s.via === 'league' && s.pos) || p.pos || null,
    status: normStatus(s.status), detail: [s.injury, s.injuryDetail].filter(Boolean).map(tidy).filter((x, i, a) => x && a.indexOf(x) === i).join(', ') || null,
    starter: depthRank === 1, depthRank, updated: iso(s.date),
    role, grade: s.grade, fantasyStatus: s.fantasy || null, newsAt: iso(s.date),
    newsText: tidy(s.comment).slice(0, 200) || null,
  };
}

const SECOND = { qb: 'QB2', rb: 'RB2', te: 'TE2' };
/**
 * Where a player sits on a trimmed depth chart: { p, slot, role, rank } or null. role is the SPEC depth role of
 * the first man in an offensive slot (QB1, RB1, WR1 to WR3, TE1), QB2/RB2/TE2 for the second, OL/DL/LB/CB/S for
 * starters on the lines and in the secondary, else null. rank = 1-based place in the slot.
 */
export function depthSpot(dc, id) {
  if (!dc || id == null) return null;
  const pid = String(id);
  for (const slot of OFF_SLOTS) {
    const list = dc.offense?.[slot] || [];
    const i = list.findIndex((p) => String(p?.id) === pid);
    if (i >= 0) return { p: list[i], slot, role: i === 0 ? (OFF_ROLE[slot] ?? null) : (i === 1 ? SECOND[slot] ?? null : null), rank: i + 1 };
  }
  for (const slot of Object.keys(dc.defense || {}).sort(defSort)) {
    const list = dc.defense[slot] || [];
    const i = list.findIndex((p) => String(p?.id) === pid);
    if (i >= 0) return { p: list[i], slot, role: i === 0 ? defRole(slot) : null, rank: i + 1 };
  }
  return null;
}

function passersFor(game, kalshiPassers, props) {
  const names = new Set();
  const code = (() => { try { return kalshiGameCode(game.kickoff, game.away.abbr, game.home.abbr); } catch { return null; } })();
  for (const k of [game.id, game.espnId, code]) for (const n of (kalshiPassers && k != null && kalshiPassers[k]) || []) names.add(n);
  for (const p of props || []) if (p?.gameId === game.id && p?.stat === 'passYds' && p?.player?.name) names.add(p.player.name);
  return { names: [...names], code };
}

/**
 * buildInjuries(raw, { games, now, recentGames, kalshiPassers, props }) -> { byGame, ok, errors, notes }
 *   raw          fetchInjuryInputs() output (raw ESPN league/depth JSON is also accepted and trimmed here)
 *   games        snapshot games; only NFL games get entries
 *   recentGames  optional: any game objects with team espn ids and a kickoff (for example every parsed ESPN
 *                scoreboard event, finished games included); improves each team's previous kickoff
 *   kalshiPassers optional { [gameId | Kalshi game code]: ['Tyler Huntley', ...] } from KXNFLPASSYDS
 *   props        optional snapshot PropLadders (passYds ladders name the expected passer)
 *   players      optional { [gameId]: { home: [espnId], away: [espnId] } }: also grade these players (any depth,
 *                for example prop players who are not starters) -> byGame[gameId].players[espnId] = Injury | null
 *                (null = no injury designation). A side without a depth chart is left out (unknown).
 * byGame[gameId] = { injuries: { home: [Injury], away: [Injury] }, angles: [Angle], players? }
 * Injuries list depth-chart starters only (QB, RB1, WR1 to WR3, TE1, OL, defensive starters) who are not Active.
 */
export function buildInjuries(raw = {}, { games = [], now = null, recentGames = [], kalshiPassers = null, props = null, players = null } = {}) {
  const errors = [], notes = [];
  const league = raw?.league ? trimLeague(raw.league) : null;
  if (!league) errors.push('no league injuries feed');
  const depth = {};
  for (const [id, d] of Object.entries(raw?.depth || {})) {
    if (!d || d.error) continue;
    try { depth[String(id)] = trimDepth(d, id); } catch (e) { errors.push(`depth ${id}: ${errorText(e)}`); }
  }
  const items = league?.items || [];
  const injById = new Map();
  for (const it of items) if (it.id && (!injById.has(it.id) || Date.parse(it.date) > Date.parse(injById.get(it.id).date))) injById.set(it.id, it);

  const sched = scheduleIndex([raw?.schedule || [], recentGames, games]);
  const fallbackTeams = new Set();
  const prevKickOf = (teamId, kickMs) => {
    const ks = sched.get(String(teamId)) || [];
    let best = null;
    for (const k of ks) if (k < kickMs - H) best = k;
    if (best == null) { fallbackTeams.add(String(teamId)); return kickMs - 7 * DAY; }
    return best;
  };

  const nowMs = now == null ? null : toMs(now);
  const byGame = {};
  for (const game of games) {
    if (game?.league !== 'nfl') continue;
    const kickMs = toMs(game.kickoff);
    if (!Number.isFinite(kickMs)) continue;
    const ctx = {};
    for (const side of ['home', 'away']) {
      const team = game[side] || {};
      const dc = depth[String(team.espnId)];
      if (!dc) { errors.push(`no depth chart for ${team.abbr || team.espnId} (${game.id})`); ctx[side] = null; continue; }
      const prevKickMs = prevKickOf(team.espnId, kickMs);
      const cache = new Map();
      const status = (p) => {
        if (!p?.id) return null;
        if (cache.has(p.id)) return cache.get(p.id);
        const st = mergedStatus(p, injById);
        const gr = st ? gradeStatus(st, { kickMs, prevKickMs, state: game.state }) : null;
        const v = gr ? { ...st, ...gr } : null;
        cache.set(p.id, v);
        return v;
      };
      // effectively unavailable for this game (used to skip injured players when naming beneficiaries)
      const outIds = new Set();
      for (const list of Object.values(dc.offense || {})) for (const p of list) { const s = status(p); if (s && s.sev >= 0.75 && ['confirmed', 'likely', 'longterm'].includes(s.grade)) outIds.add(p.id); }
      for (const list of Object.values(dc.defense || {})) for (const p of list) { const s = status(p); if (s && s.sev >= 0.75 && ['confirmed', 'likely', 'longterm'].includes(s.grade)) outIds.add(p.id); }
      // starters who are not Active
      const injuries = [], seen = new Set(), starters = [];
      const slots = [...OFF_SLOTS.filter((k) => OFF_ROLE[k] && dc.offense?.[k]?.length).map((k) => [k, OFF_ROLE[k], dc.offense[k]]),
        ...Object.keys(dc.defense || {}).sort(defSort).map((k) => [k, defRole(k), dc.defense[k]])];
      for (const [slot, role, list] of slots) {
        const p = list[0];
        if (!p?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        const s = status(p);
        starters.push({ slot, role, p, s });
        if (s) injuries.push(injuryOut(p, s, role, 1));
      }
      injuries.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || String(a.name).localeCompare(String(b.name)));
      ctx[side] = { team, dc, prevKickMs, status, outIds, injuries, starters };
    }

    const angles = [];
    const pick = (c, slot) => (c?.dc?.offense?.[slot] || []).filter((p) => !c.outIds.has(p.id));
    const entry = (p, why, side) => ({ name: p.name, id: p.id, why, team: side });
    if (game.state === 'pre' && (nowMs == null || kickMs > nowMs - 6 * H)) {
      for (const side of ['away', 'home']) {
        const c = ctx[side];
        if (!c) continue;
        const oppSide = side === 'home' ? 'away' : 'home';
        const o = ctx[oppSide];
        const abbr = c.team.abbr;

        // QB1 / RB1 / WR1-3 / TE1 out or doubtful
        for (const { slot, role, p: starter, s } of c.starters) {
          if (!['QB1', 'RB1', 'WR1', 'WR2', 'WR3', 'TE1'].includes(role) || !s || s.sev < 0.75) continue;
          const list = c.dc.offense[slot] || [];
          const next = list.slice(1).filter((p) => !c.outIds.has(p.id));
          const a = { kind: slot === 'qb' ? 'qb-out' : 'skill-out', team: side, player: starter.name, playerId: starter.id, role, grade: s.grade,
            status: normStatus(s.status), why: s.why, newsAt: iso(s.date), beneficiaries: [], fades: [], signals: [] };
          if (slot === 'qb') {
            const bq = next[0];
            if (bq) a.beneficiaries.push(entry(bq, 'backup QB starts: his passing props, team pass volume shifts to him', side));
            const rb1 = pick(c, 'rb')[0]; if (rb1) a.beneficiaries.push(entry(rb1, 'run heavier script: carries up', side));
            const te1 = pick(c, 'te')[0]; if (te1) a.beneficiaries.push(entry(te1, 'short and checkdown targets up', side));
            const wr1 = pick(c, 'wr1')[0]; if (wr1) a.fades.push(entry(wr1, 'deep target volume and efficiency down', side));
            a.fades.push({ name: `${abbr} team total and spread`, id: null, why: 'starting QB downgrade', team: side });
            for (const it of items) {
              if (it.teamId === String(c.team.espnId) && it.pos === 'QB' && it.starterNews && it.id !== starter.id && Date.parse(it.date) > c.prevKickMs) {
                a.signals.push({ kind: 'espn-news', text: `${it.name}: ${tidy(it.comment).slice(0, 200)}`, at: iso(it.date) });
              }
            }
            const own = `${s.comment || ''} ${s.longComment || ''}`;
            if (bq && Date.parse(s.date) > c.prevKickMs + 4.5 * H && mentionsStart(own, bq.name)) a.signals.push({ kind: 'espn-news', text: `${starter.name} blurb: ${tidy(own).slice(0, 200)}`, at: iso(s.date) });
            const { names, code } = passersFor(game, kalshiPassers, props);
            if (names.length) {
              const set = new Set(names.map(nameKey));
              const onK = (n) => set.has(nameKey(n));
              if (bq && onK(bq.name) && !onK(starter.name)) a.signals.push({ kind: 'kalshi', text: `Kalshi KXNFLPASSYDS-${code} lists ${bq.name}, not ${starter.name}`, at: null });
              else if (onK(starter.name)) a.signals.push({ kind: 'kalshi-contra', text: `Kalshi KXNFLPASSYDS-${code} still lists ${starter.name}`, at: null });
            }
            if (a.signals.some((x) => x.kind === 'kalshi' || x.kind === 'espn-news') && (a.grade === 'carryover' || a.grade === 'questionable')) {
              a.grade = 'likely';
              a.why = `${a.why}; news or Kalshi names the backup as the starter`;
            }
          } else if (slot === 'rb') {
            if (next[0]) a.beneficiaries.push(entry(next[0], 'RB2 inherits early down carries', side));
            if (next[1]) a.beneficiaries.push(entry(next[1], 'committee share and passing down work', side));
          } else if (slot.startsWith('wr')) {
            const seenB = new Set([starter.id]);
            for (const k of ['wr1', 'wr2', 'wr3']) if (k !== slot) { const p = pick(c, k)[0]; if (p && !seenB.has(p.id)) { seenB.add(p.id); a.beneficiaries.push(entry(p, 'remaining starting WR: target share up', side)); } }
            const te1 = pick(c, 'te')[0]; if (te1 && !seenB.has(te1.id)) { seenB.add(te1.id); a.beneficiaries.push(entry(te1, 'TE1 absorbs targets', side)); }
            const rep = next.find((p) => !seenB.has(p.id)); if (rep) a.beneficiaries.push(entry(rep, `next man up at ${role}: snaps up`, side));
          } else if (slot === 'te') {
            if (next[0]) a.beneficiaries.push(entry(next[0], 'TE2 inherits routes', side));
            const wr3 = pick(c, 'wr3')[0]; if (wr3) a.beneficiaries.push(entry(wr3, 'slot WR picks up middle targets', side));
          }
          angles.push(a);
        }

        // group angles: 2+ OL starters out, defensive starters out (long-term absences are already in the stats)
        const group = (pred) => c.starters.filter(({ role, s }) => pred(role) && s && s.sev >= 0.75 && s.grade !== 'longterm')
          .sort((x, y) => gradeRank(x.s.grade) - gradeRank(y.s.grade) || String(x.p.name).localeCompare(String(y.p.name)));
        const groupAngle = (kind, role, members, need, why) => ({
          kind, team: side, player: members.map((m) => `${m.p.name} (${m.slot.toUpperCase()}, ${normStatus(m.s.status)})`).join('; '), playerId: null, role,
          grade: members[need - 1].s.grade, status: null, why, newsAt: null,
          players: members.map((m) => ({ name: m.p.name, id: m.p.id, slot: m.slot.toUpperCase(), status: normStatus(m.s.status), grade: m.s.grade })),
          beneficiaries: [], fades: [], signals: [],
        });
        const ol = group((r) => r === 'OL');
        if (ol.length >= 2) {
          const a = groupAngle('ol-out', 'OL', ol, 2, `${ol.length} offensive line starters out or doubtful`);
          const qb = pick(c, 'qb')[0]; if (qb) a.fades.push(entry(qb, 'pass protection weakened', side));
          const rb = pick(c, 'rb')[0]; if (rb) a.fades.push(entry(rb, 'run blocking weakened', side));
          angles.push(a);
        }
        const sec = group((r) => r === 'CB' || r === 'S');
        if (sec.length >= 1) {
          const a = groupAngle('def-out', 'secondary', sec, 1, `${abbr} secondary missing ${sec.length} starter${sec.length > 1 ? 's' : ''}`);
          if (o) for (const k of ['wr1', 'wr2']) { const p = pick(o, k)[0]; if (p) a.beneficiaries.push(entry(p, 'faces a depleted secondary: receiving yards and receptions up', oppSide)); }
          angles.push(a);
        }
        const front = group((r) => r === 'DL' || r === 'LB');
        if (front.length >= 2) {
          const a = groupAngle('def-out', 'front', front, 2, `${abbr} front seven missing ${front.length} starters`);
          if (o) { const p = pick(o, 'rb')[0]; if (p) a.beneficiaries.push(entry(p, 'faces a front missing 2 or more starters: rushing yards up', oppSide)); }
          angles.push(a);
        }
      }
    }
    const KIND = ['qb-out', 'skill-out', 'ol-out', 'def-out'];
    angles.sort((a, b) => KIND.indexOf(a.kind) - KIND.indexOf(b.kind) || (a.team === b.team ? 0 : a.team === 'away' ? -1 : 1) || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || String(a.role).localeCompare(String(b.role)));
    let graded = null;
    const want = players?.[game.id];
    if (want) {
      graded = {};
      for (const side of ['home', 'away']) {
        const c = ctx[side];
        if (!c) continue;
        for (const id of [...new Set((want[side] || []).map(String))].sort()) {
          const spot = depthSpot(c.dc, id);
          const p = spot?.p || { id, name: null, pos: null, inj: null };
          const s = c.status(p);
          graded[id] = s ? injuryOut(p, s, spot?.role ?? null, spot?.rank ?? null) : null;
        }
      }
    }
    byGame[game.id] = { injuries: { home: ctx.home?.injuries || [], away: ctx.away?.injuries || [] }, angles, ...(graded ? { players: graded } : {}) };
  }
  if (fallbackTeams.size) notes.push(`previous kickoff unknown for ${fallbackTeams.size} team(s); assumed one week before`);
  return { byGame, ok: errors.length === 0, errors: [...new Set(errors)], notes };
}

/** All angles of a byGame map as one flat list (for logs and reports). */
export function flattenAngles(byGame) {
  const out = [];
  for (const [gameId, v] of Object.entries(byGame || {})) for (const a of v.angles || []) out.push({ gameId, ...a });
  return out;
}
