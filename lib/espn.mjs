// ESPN site API (free, no key): scoreboards with DraftKings lines, game summaries with injuries.
// Fetching helpers plus pure parsers. Never uses the research plain-normal ladder pricing (pricing is not done here).

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { errorText } from './http.mjs';

export const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/football';

export const LEAGUES = {
  nfl: { path: 'nfl', query: {} },
  cfb: { path: 'college-football', query: { groups: '80', limit: '300' } }, // groups=80 = FBS (includes FBS vs FCS)
};
/** ESPN college groups: 80 = FBS (every game with an FBS team), 81 = FCS (every game with an FCS team). */
export const CFB_GROUPS = Object.freeze({ fbs: '80', fcs: '81' });

/** groups (college only) replaces the default groups=80, for the FCS boards (groups=81). */
export function scoreboardUrl(league, { seasonType, week, groups } = {}) {
  const L = LEAGUES[league];
  if (!L) throw new Error(`unknown league ${league}`);
  const sp = new URLSearchParams();
  if (seasonType != null && week != null) {
    sp.set('seasontype', String(seasonType));
    sp.set('week', String(week));
  }
  for (const [k, v] of Object.entries(L.query)) sp.set(k, k === 'groups' && groups != null ? String(groups) : v);
  const qs = sp.toString();
  return `${ESPN_SITE}/${L.path}/scoreboard${qs ? `?${qs}` : ''}`;
}

// ---------------------------------------------------------------- divisions (Team.division, Game.cls)

/**
 * ESPN conference ids of the FBS conferences (scoreboard competitors[i].team.conferenceId): ACC 1, Big 12 4, Big Ten 5,
 * SEC 8, Pac-12 9, C-USA 12, MAC 15, Mountain West 17, FBS Independents 18, Sun Belt 37, American 151 (checked on
 * the 2026 week 7 to 9 boards, 2026-10-13). Any other conference id is FCS on these boards.
 */
export const FBS_CONFERENCES = Object.freeze(['1', '4', '5', '8', '9', '12', '15', '17', '18', '37', '151']);
const FBS_SET = new Set(FBS_CONFERENCES);

/** ESPN team -> 'fbs' | 'fcs' | null (null: the board gives no conference, as for some non Division I opponents). */
export function teamDivision(team) {
  const c = team?.conferenceId;
  if (c === undefined || c === null || c === '') return null;
  return FBS_SET.has(String(c)) ? 'fbs' : 'fcs';
}

/** Two divisions -> 'FF' (FBS vs FBS) | 'FC' (FBS vs FCS) | 'CC' (FCS vs FCS) | null when either is unknown. */
export function gameClass(a, b) {
  if (!a || !b) return null;
  if (a === 'fbs' && b === 'fbs') return 'FF';
  if (a === 'fcs' && b === 'fcs') return 'CC';
  return 'FC';
}

export function summaryUrl(league, eventId) {
  return `${ESPN_SITE}/${LEAGUES[league].path}/summary?event=${encodeURIComponent(eventId)}`;
}

// Next calendar entry after (seasonType, week). Crosses into the postseason correctly.
// calendar: [{ value: '<seasonType>', entries: [{ value: '<week>', startDate }] }]
export function nextWeek(calendar, seasonType, week) {
  if (!Array.isArray(calendar)) return Number.isFinite(week) ? { seasonType, week: week + 1 } : null;
  const flat = [];
  for (const sec of calendar) {
    if (!sec || typeof sec !== 'object' || !Array.isArray(sec.entries)) continue;
    for (const e of sec.entries) flat.push({ seasonType: Number(sec.value), week: Number(e.value), start: Date.parse(e.startDate) });
  }
  flat.sort((a, b) => a.start - b.start);
  const i = flat.findIndex((x) => x.seasonType === seasonType && x.week === week);
  return i >= 0 && i + 1 < flat.length ? { seasonType: flat[i + 1].seasonType, week: flat[i + 1].week } : null;
}

/**
 * Default scoreboard (current week) plus the next calendar week: 2 requests per league.
 * Date ranges (?dates=A-B) return HTTP 400 as of 2026-10-11, so week numbers are the only option.
 * Returns { boards: [json...], errors: [string] }. A failed next-week fetch keeps the default board.
 */
export async function fetchScoreboards(http, league) {
  const boards = [];
  const errors = [];
  let cur;
  try {
    cur = await http.getJson(scoreboardUrl(league));
    boards.push(cur);
  } catch (e) {
    errors.push(`${league} scoreboard: ${e.message}`);
    return { boards, errors };
  }
  const seasonType = Number(cur?.season?.type ?? cur?.leagues?.[0]?.season?.type?.type);
  const week = Number(cur?.week?.number);
  const next = nextWeek(cur?.leagues?.[0]?.calendar, seasonType, week);
  if (next) {
    try {
      boards.push(await http.getJson(scoreboardUrl(league, next)));
    } catch (e) {
      errors.push(`${league} scoreboard week ${next.week}: ${e.message}`);
    }
  }
  return { boards, errors };
}

// ---------------------------------------------------------------- FCS and lookahead boards (part B)
//
// Two opt-in parts read four more college boards (lib/sources.mjs, --skip fcs,lookahead):
//   fcs        groups=81 (FCS): the default week and the next week, and the week after when lookahead runs too
//   lookahead  groups=80 (FBS): the week after next (the core run already reads the default and next FBS weeks)
// The FCS boards list every game with an FCS team (FBS vs FCS games are on both groups; the core FBS copy is kept).
// They are trimmed to the fields the collector reads (trimBoard) and kept in state/espn-extra.json: a board is reused
// for EXTRA_BOARDS.reuseMs (15 minutes) unless it lists a game that is live or starts within liveLeadMs, so game day
// states and kickoffs stay as fresh as the core boards. A failed request falls back to the saved copy for up to
// staleMaxMs (with an error, so the source reads not ok). About 4 GETs per 15 minutes, plus 1 per run on game days.

export const EXTRA_BOARDS = Object.freeze({
  reuseMs: 15 * 60e3,          // a saved board younger than this is reused ...
  liveLeadMs: 20 * 60e3,       // ... unless one of its games is 'in', or 'pre' with a kickoff within the next 20 min
  liveBackMs: 6 * 3600e3,      //     (or a 'pre' kickoff up to 6 h ago: a game whose state has not flipped yet)
  staleMaxMs: 60 * 60e3,       // a failed request reuses a saved copy at most this old
});
const EXTRA_STATE_FILE = 'espn-extra.json';
const EXTRA_STATE_VERSION = 1;

const pickKeys = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const trimStatus = (s) => ({ type: pickKeys(s?.type || {}, ['name', 'state', 'completed']) });
function trimCompetitor(c) {
  return {
    ...pickKeys(c, ['id', 'homeAway', 'score', 'winner']),
    team: pickKeys(c?.team || {}, ['id', 'location', 'name', 'nickname', 'abbreviation', 'displayName', 'shortDisplayName', 'logo', 'conferenceId']),
    records: (Array.isArray(c?.records) ? c.records : []).map((r) => pickKeys(r, ['name', 'type', 'summary'])),
  };
}
function trimEvent(e) {
  const c = e?.competitions?.[0] || {};
  return {
    ...pickKeys(e, ['id', 'date', 'name', 'shortName', 'season', 'week', 'weather']),
    status: trimStatus(e?.status),
    competitions: [{
      ...pickKeys(c, ['id', 'date', 'neutralSite', 'conferenceCompetition', 'timeValid']),
      ...(c.venue ? { venue: pickKeys(c.venue, ['id', 'fullName', 'indoor']) } : {}),
      competitors: (Array.isArray(c.competitors) ? c.competitors : []).map(trimCompetitor),
      ...(Array.isArray(c.odds) ? { odds: c.odds } : {}),
      status: trimStatus(c.status),
    }],
  };
}
/**
 * A scoreboard trimmed to what the collector reads: the calendar and season (next week), and per event the ids,
 * dates, status, teams (with conferenceId), records, scores, odds, venue indoor flag and weather. About 1/40 the size.
 * A board without an events list is returned as is (the format check reports it).
 */
export function trimBoard(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.events)) return b;
  const L = b.leagues?.[0] || {};
  return {
    leagues: [pickKeys(L, ['season', 'calendar'])],
    ...pickKeys(b, ['season', 'week']),
    events: b.events.map(trimEvent),
  };
}

/** Does a board list a game that is live, or about to start? (then a saved copy is not reused) */
export function boardLiveSoon(board, now, { leadMs = EXTRA_BOARDS.liveLeadMs, backMs = EXTRA_BOARDS.liveBackMs } = {}) {
  for (const ev of Array.isArray(board?.events) ? board.events : []) {
    const st = ev?.status?.type?.state ?? ev?.competitions?.[0]?.status?.type?.state;
    if (st === 'in') return true;
    if (st !== 'pre') continue;
    const k = Date.parse(ev?.competitions?.[0]?.date || ev?.date);
    if (Number.isFinite(k) && k <= now + leadMs && k >= now - backMs) return true;
  }
  return false;
}

/** (seasonType, week) of a board and the next two calendar weeks after it, or nulls. */
function boardWeeks(board) {
  const seasonType = Number(board?.season?.type ?? board?.leagues?.[0]?.season?.type?.type);
  const week = Number(board?.week?.number);
  if (!Number.isFinite(seasonType) || !Number.isFinite(week)) return { cur: null, next: null, after: null };
  const cal = board?.leagues?.[0]?.calendar;
  const next = nextWeek(cal, seasonType, week);
  const after = next ? nextWeek(cal, next.seasonType, next.week) : null;
  return { cur: { seasonType, week }, next, after };
}

async function readExtraState(path) {
  if (!path) return null;
  try {
    const j = JSON.parse(await readFile(path, 'utf8'));
    return j?.v === EXTRA_STATE_VERSION && j.boards && typeof j.boards === 'object' ? j : null;
  } catch { return null; }
}
async function writeExtraState(path, boards) {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify({ v: EXTRA_STATE_VERSION, boards }));
    await rename(`${path}.tmp`, path);
  } catch { /* the reuse is an optimisation: a write failure only means a fresh pull next run */ }
}

/**
 * fetchExtraBoards({ fcsHttp, laHttp, fcs, lookahead, fbsBoard, now, stateDir, log })
 *   fcsHttp / laHttp: lib/http.mjs clients (each on its part's time budget); fcs / lookahead: which parts run
 *   fbsBoard: this run's groups=80 default board (its week and calendar give the week after next), or null
 * -> { fcs: Part | null, lookahead: Part | null }
 *   Part = { fetchedAt, requests, ms, reused, errors, boards: [trimmed board], at: [ISO per board] }
 *   fcs.boards = [default week, next week (, week after next when lookahead runs)]; lookahead.boards = [FBS week after next]
 *   fetchedAt is the oldest board time used (a reused copy keeps the time of its pull). Never throws for upstream failures.
 */
export async function fetchExtraBoards({ fcsHttp, laHttp, fcs = false, lookahead = false, fbsBoard = null, now = Date.now(), stateDir = null, log = () => {} } = {}) {
  const path = stateDir ? join(stateDir, EXTRA_STATE_FILE) : null;
  const prev = (await readExtraState(path))?.boards || {};
  const keep = {};
  const isoNow = iso(now);
  const part = () => ({ fetchedAt: null, requests: 0, ms: 0, reused: 0, errors: [], boards: [], at: [] });
  const out = { fcs: fcs ? part() : null, lookahead: lookahead ? part() : null };

  async function get(P, http, key, url) {
    const saved = prev[key];
    const age = saved?.url === url ? now - Date.parse(saved.at) : NaN;
    if (Number.isFinite(age) && age >= 0 && age < EXTRA_BOARDS.reuseMs && !boardLiveSoon(saved.board, now)) {
      P.reused++;
      keep[key] = saved;
      return saved;
    }
    const before = http.stats.requests;
    try {
      const board = trimBoard(await http.getJson(url));
      const got = { url, at: isoNow, board };
      if (Array.isArray(board?.events)) keep[key] = got; // a board in an unknown format is used once (the build reports it), never reused
      return got;
    } catch (e) {
      if (Number.isFinite(age) && age >= 0 && age <= EXTRA_BOARDS.staleMaxMs) {
        P.errors.push(`${key}: ${errorText(e)}; reused the copy from ${saved.at}`);
        P.reused++;
        keep[key] = saved;
        return saved;
      }
      P.errors.push(`${key}: ${errorText(e)}`);
      return null;
    } finally {
      P.requests += http.stats.requests - before;
    }
  }
  const add = (P, got) => { if (got) { P.boards.push(got.board); P.at.push(got.at); } };

  let fcsWeeks = null;
  if (out.fcs) {
    const P = out.fcs;
    const t0 = Date.now();
    const cur = await get(P, fcsHttp, 'fcs:cur', scoreboardUrl('cfb', { groups: CFB_GROUPS.fcs }));
    add(P, cur);
    fcsWeeks = cur ? boardWeeks(cur.board) : null;
    if (cur && !fcsWeeks.cur) P.errors.push('fcs:cur: the board has no season type or week (ESPN format change?)');
    if (fcsWeeks?.next) add(P, await get(P, fcsHttp, 'fcs:next', scoreboardUrl('cfb', { ...fcsWeeks.next, groups: CFB_GROUPS.fcs })));
    if (lookahead && fcsWeeks?.after) add(P, await get(P, fcsHttp, 'fcs:after', scoreboardUrl('cfb', { ...fcsWeeks.after, groups: CFB_GROUPS.fcs })));
    P.ms = Date.now() - t0;
  }
  if (out.lookahead) {
    const P = out.lookahead;
    const t0 = Date.now();
    // The FBS week after next, counted from this run's FBS default board (else from the FCS default board).
    const fw = fbsBoard ? boardWeeks(fbsBoard) : null;
    const w = fw?.after ? fw : fcsWeeks;
    if (w?.after) add(P, await get(P, laHttp, 'fbs:after', scoreboardUrl('cfb', w.after)));
    else P.errors.push('fbs:after: no current college week to count from (the default scoreboard failed or has no calendar)');
    P.ms = Date.now() - t0;
  }
  for (const P of [out.fcs, out.lookahead]) {
    if (!P) continue;
    P.fetchedAt = P.at.length ? P.at.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null;
  }
  await writeExtraState(path, keep);
  if (out.fcs) log(`fcs: ${out.fcs.boards.length} boards (${out.fcs.reused} reused), ${out.fcs.requests} requests${out.fcs.errors.length ? `; ${out.fcs.errors.join(' | ')}` : ''}`);
  if (out.lookahead) log(`lookahead: ${out.lookahead.boards.length} board (${out.lookahead.reused} reused), ${out.lookahead.requests} requests${out.lookahead.errors.length ? `; ${out.lookahead.errors.join(' | ')}` : ''}`);
  return out;
}

// ---------------------------------------------------------------- pure parsing

// '-135' -> -135, '+114' -> 114, 'EVEN' -> 100, 'OFF' / '' / null -> null
export function parseAmerican(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) && Math.abs(s) >= 100 ? s : null;
  const t = String(s).trim().toUpperCase();
  if (t === 'EVEN' || t === 'EV') return 100;
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Math.abs(n) < 100 ? null : n;
}

// '+2.5' -> 2.5, 'o41.5' -> 41.5, 'u41.5' -> 41.5, 'PK' -> 0, junk -> null
export function parseLine(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const t = String(s).trim().toLowerCase().replace(/^[ou]/, '');
  if (t === 'pk' || t === 'pick' || t === "pick'em" || t === 'even') return 0;
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Any ESPN date ('2026-10-12T00:20Z') -> '2026-10-12T00:20:00Z'. Unparseable -> null.
export function iso(t) {
  if (t == null || t === '') return null;
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

const neg = (x) => (x == null ? null : x === 0 ? 0 : -x);

/**
 * competitions[0] -> SPEC Odds or null. Uses the DraftKings provider (id '100'); never a 'Live Odds' provider.
 * ESPN 'close' fields are the CURRENT line (they move pregame); 'open' fields are the opening line.
 */
export function parseOdds(comp, fetchedAt) {
  const arr = Array.isArray(comp?.odds) ? comp.odds : [];
  const o = arr.find((x) => String(x?.provider?.id) === '100') || arr.find((x) => x && !/live/i.test(x?.provider?.name || '')) || null;
  if (!o) return null;
  const A = parseAmerican, Ln = parseLine;
  const ml = o.moneyline, ps = o.pointSpread, tt = o.total;

  const mlHome = A(ml?.home?.close?.odds), mlAway = A(ml?.away?.close?.odds);
  const mlOut = mlHome == null && mlAway == null ? null : {
    home: mlHome, away: mlAway, homeOpen: A(ml?.home?.open?.odds), awayOpen: A(ml?.away?.open?.odds),
  };

  const homeLine = Ln(ps?.home?.close?.line) ?? neg(Ln(ps?.away?.close?.line)) ?? (typeof o.spread === 'number' ? o.spread : null);
  const spreadOut = homeLine == null ? null : {
    home: homeLine,
    homeOdds: A(ps?.home?.close?.odds),
    awayOdds: A(ps?.away?.close?.odds),
    homeOpen: Ln(ps?.home?.open?.line) ?? neg(Ln(ps?.away?.open?.line)),
    homeOddsOpen: A(ps?.home?.open?.odds),
    awayOddsOpen: A(ps?.away?.open?.odds),
  };

  const line = Ln(tt?.over?.close?.line) ?? Ln(tt?.under?.close?.line) ?? (typeof o.overUnder === 'number' ? o.overUnder : null);
  const totalOut = line == null ? null : {
    line,
    overOdds: A(tt?.over?.close?.odds),
    underOdds: A(tt?.under?.close?.odds),
    lineOpen: Ln(tt?.over?.open?.line) ?? Ln(tt?.under?.open?.line),
    overOddsOpen: A(tt?.over?.open?.odds),
    underOddsOpen: A(tt?.under?.open?.odds),
  };

  if (!mlOut && !spreadOut && !totalOut) return null;
  return { provider: o.provider?.name || o.provider?.displayName || 'DraftKings', fetchedAt: fetchedAt ?? null, ml: mlOut, spread: spreadOut, total: totalOut };
}

/** competitor -> SPEC Team (kalshiCode filled by the builder). */
export function parseTeam(competitor) {
  const t = competitor?.team || {};
  const recs = Array.isArray(competitor?.records) ? competitor.records : [];
  const rec = recs.find((r) => r?.type === 'total') || recs.find((r) => r?.name === 'overall') || null;
  return {
    abbr: t.abbreviation ?? null,
    name: t.displayName ?? null,
    shortName: t.shortDisplayName ?? null,
    espnId: t.id != null ? String(t.id) : null,
    kalshiCode: null,
    logo: t.logo ?? null,
    record: rec?.summary ?? null,
  };
}

/** Scoreboard weather (cheap, no extra request). Wind is not in the scoreboard, so windMph stays null. */
export function parseWeather(ev, comp) {
  const w = ev?.weather;
  const indoor = comp?.venue?.indoor;
  if (!w && indoor == null) return null;
  const temp = w?.temperature;
  return {
    tempF: typeof temp === 'number' ? temp : temp != null && Number.isFinite(Number(temp)) ? Number(temp) : null,
    condition: w?.displayValue ?? null,
    windMph: null,
    indoor: indoor == null ? null : !!indoor,
  };
}

/**
 * Normalise scoreboard events for one league. Dedupes by event id (first board wins).
 * Each item: { id, league, season, seasonType, week, kickoff, kickoffMs, state, neutral,
 *              homeComp, awayComp, comp, raw }
 */
export function parseScoreboardEvents(boards, league) {
  const seen = new Set();
  const out = [];
  for (const b of boards || []) {
    for (const ev of b?.events || []) {
      const id = ev?.id != null ? String(ev.id) : null;
      if (!id || seen.has(id)) continue;
      const comp = ev?.competitions?.[0];
      const homeComp = comp?.competitors?.find((c) => c.homeAway === 'home');
      const awayComp = comp?.competitors?.find((c) => c.homeAway === 'away');
      const kickoff = iso(comp?.date || ev?.date);
      if (!comp || !homeComp || !awayComp || !kickoff) continue;
      seen.add(id);
      out.push({
        id,
        league,
        season: Number(ev.season?.year ?? b?.season?.year) || null,
        seasonType: Number(ev.season?.type ?? b?.season?.type) || null,
        week: Number(ev.week?.number ?? b?.week?.number) || null,
        kickoff,
        kickoffMs: Date.parse(kickoff),
        state: ev.status?.type?.state ?? comp.status?.type?.state ?? null,
        neutral: !!comp.neutralSite,
        homeComp,
        awayComp,
        comp,
        raw: ev,
      });
    }
  }
  return out;
}

const STATUS_MAP = [
  [/^injured reserve|^ir$/i, 'IR'],
  [/physically unable|^pup$/i, 'PUP'],
];
function normStatus(s) {
  const t = String(s || '').trim();
  for (const [re, v] of STATUS_MAP) if (re.test(t)) return v;
  return t || null;
}

function injuryDetail(d) {
  if (!d || typeof d !== 'object') return null;
  const parts = [d.type, d.detail].filter((x) => x && !/^not specified$/i.test(String(x)));
  return parts.length ? [...new Set(parts)].join(', ') : null;
}

/**
 * Game summary -> Map<espnTeamId, [Injury]>. starter and depthRank stay null until depth charts are wired in (phase B).
 * Note: ESPN 'Out' includes coach's-decision inactives (for example a backup QB), so `detail` is passed through.
 */
export function parseSummaryInjuries(summary) {
  const out = new Map();
  for (const t of Array.isArray(summary?.injuries) ? summary.injuries : []) {
    const teamId = t?.team?.id != null ? String(t.team.id) : null;
    if (!teamId) continue;
    const list = [];
    for (const x of Array.isArray(t.injuries) ? t.injuries : []) {
      const a = x?.athlete || {};
      list.push({
        espnId: a.id != null ? String(a.id) : null,
        name: a.displayName || a.fullName || null,
        pos: a.position?.abbreviation || null,
        status: normStatus(x.status || x.type?.description),
        detail: injuryDetail(x.details),
        starter: null,
        depthRank: null,
        updated: iso(x.date),
      });
    }
    out.set(teamId, list);
  }
  return out;
}
