// nflverse.mjs: NFL defense ratings (run, pass, front, secondary) and player contexts from nflverse CSV releases.
// Node 22+, no deps. Logic from research2 defense-ratings/scripts/defense.mjs (team EPA, YPC/YPA, sack rate,
// points and PPR allowed) plus glue.buildFrontSecondary (stuff rate, explosive rates, pressure, per corner coverage)
// and player-baselines/code/player_context.mjs (averages, shares, teammate-out splits).
//
// fetchNflverseInputs(): HEAD each release asset (follows GitHub's 302) and downloads only when the ETag changed;
//   the gzip bytes are cached in cacheDir. 4 assets: pbp, stats_player_week, roster_weekly, pfr advstats def.
//   An asset that is missing (HTTP 404: from the March 1 season rollover until nflverse publishes the new season's
//   files in September) is not asked for again for 6 hours, other failures for 30 minutes (MISS_BACKOFF).
// buildNflverse(raw, { games, propPlayers, injuriesByGame, depth }): pure.
//
// Team codes: nflverse uses LA / WAS / JAX. Output is keyed by ESPN abbreviation (LAR / WSH / JAX) through
// glue.toEspn, so defense.nfl[game.home.abbr] works directly.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseCsv, gunzipText, isGzip, colIndex, num } from './csv.mjs';
import { nv, toEspn, nameKey, buildIdBridge, buildFrontSecondary } from './glue.mjs';

export const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';
export const NFLVERSE_ASSETS = {
  pbp: (s) => `${NFLVERSE}/pbp/play_by_play_${s}.csv.gz`,
  statsPlayerWeek: (s) => `${NFLVERSE}/stats_player/stats_player_week_${s}.csv.gz`,
  rosterWeekly: (s) => `${NFLVERSE}/weekly_rosters/roster_weekly_${s}.csv.gz`,
  pfrDef: (s) => `${NFLVERSE}/pfr_advstats/advstats_week_def_${s}.csv.gz`,
};
const ASSET_KEYS = Object.keys(NFLVERSE_ASSETS);
const UA = { 'user-agent': 'gridiron-data collector' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));
/** How long a failed asset is left alone when nothing is cached for it: 404 = not published (yet), else a transient error. */
export const MISS_BACKOFF = Object.freeze({ notFoundMs: 6 * 3600e3, otherMs: 30 * 60e3 });
const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** NFL season year for a date: Jan and Feb belong to the previous season. */
export function nflSeason(now = Date.now()) {
  const d = new Date(toMs(now));
  return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// ---------------------------------------------------------------- small byte fetchers (also used by cfb.mjs)

/** HEAD with redirect follow. -> { ok, status, etag, lastModified, bytes, url } (never throws). */
export async function headInfo(fetchImpl, url, { timeoutMs = 20000 } = {}) {
  try {
    const r = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: r.ok, status: r.status, etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified'), bytes: Number(r.headers.get('content-length')) || null, url: r.url || url };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e), url };
  }
}

const fetchFail = (url, e, suffix = '') => Object.assign(
  new Error(`${new URL(url).pathname}: ${e?.budget ? e.message : e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'network error')}${suffix}`),
  { status: 0, budget: !!e?.budget },
);

/** GET with redirect follow -> { buf, etag, lastModified } or throws an Error with .status (0 = no answer) and .budget. */
export async function fetchBytes(fetchImpl, url, { timeoutMs = 90000 } = {}) {
  let r;
  try {
    r = await fetchImpl(url, { redirect: 'follow', headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw fetchFail(url, e);
  }
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).pathname}: HTTP ${r.status}`), { status: r.status });
  let buf;
  try { buf = Buffer.from(await r.arrayBuffer()); } catch (e) { throw fetchFail(url, e, ' (reading the body)'); }
  return { buf, etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified') };
}

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function exists(path) { try { return (await stat(path)).size > 0; } catch { return false; } }

// ---------------------------------------------------------------- fetch

/**
 * fetchNflverseInputs({ fetchImpl, now, cacheDir, season, minCheckMs }) ->
 *   { season, fetchedAt, pbp, statsPlayerWeek, rosterWeekly, pfrDef (CSV texts or null),
 *     etags, lastModified, cached: { key: true when the cached copy was used }, errors, warnings, requests }
 * Per asset: 1 HEAD; 1 GET only when the ETag differs from the cached copy (or nothing is cached).
 * minCheckMs: skip even the HEAD when the cached copy was checked less than this long ago (default 30 min), so a
 * 5 minute cron does not HEAD GitHub 4 times every run. Pass 0 to always HEAD.
 * Misses: an asset with no cached copy that fails is recorded ({ url, at, status, retryAfter } in checkPath under
 * 'misses', else in meta.json) and skipped (no HEAD, no GET; still an error) until retryAfter. A HEAD that answers
 * 404 is final for that check (no GET). A spent time budget is not a miss.
 */
export async function fetchNflverseInputs({
  fetchImpl = globalThis.fetch, now = Date.now(), cacheDir = null, season = null, minCheckMs = 30 * 60e3, pauseMs = 150, log = () => {},
  checkPath = null,
} = {}) {
  const nowMs = toMs(now);
  const yr = season ?? nflSeason(nowMs);
  const dir = cacheDir ? join(cacheDir, 'nflverse') : null;
  const metaPath = dir ? join(dir, 'meta.json') : null;
  const meta = (metaPath && (await readJson(metaPath))) || {};
  // checkPath (optional, outside cacheDir): HEAD check stamps live there, so meta.json (and the cached folder) only
  // changes when an asset's data changes. Without it the stamps stay in meta.json as before.
  const checks = (checkPath && (await readJson(checkPath))) || {};
  const checkedAt = (key, m) => (checkPath ? checks[key] : m?.checkedAt) ?? null;
  let checksDirty = false;
  const stamp = (key) => { if (checkPath) { checks[key] = isoS(nowMs); checksDirty = true; } };
  const out = { season: yr, fetchedAt: isoS(nowMs), etags: {}, lastModified: {}, cached: {}, errors: [], warnings: [], requests: 0 };
  let dirty = false;
  // failed checks of assets with nothing cached (negative cache), next to the check stamps
  const missOf = (key, url) => { const r = (checkPath ? checks.misses : meta.misses)?.[key]; return r && r.url === url ? r : null; };
  const setMiss = (key, rec) => {
    if (checkPath) { (checks.misses ||= {})[key] = rec; checksDirty = true; } else { (meta.misses ||= {})[key] = rec; dirty = true; }
  };
  const clearMiss = (key) => {
    const store = checkPath ? checks.misses : meta.misses;
    if (!store?.[key]) return;
    delete store[key];
    if (checkPath) checksDirty = true; else dirty = true;
  };

  for (const key of ASSET_KEYS) {
    const url = NFLVERSE_ASSETS[key](yr);
    const file = dir ? join(dir, `${key}_${yr}.csv.gz`) : null;
    const m = meta[key]?.url === url ? meta[key] : null;
    const have = !!(file && m && (await exists(file)));
    const useCache = async (why) => {
      out[key] = gunzipText(await readFile(file));
      out.etags[key] = m.etag ?? null;
      out.lastModified[key] = m.lastModified ?? null;
      out.cached[key] = true;
      log(`nflverse ${key}: cached (${why})`);
    };
    const miss = have ? null : missOf(key, url);
    if (miss && nowMs < Date.parse(miss.retryAfter)) {
      out[key] = null;
      out.errors.push(`${key}: ${miss.status ? `HTTP ${miss.status}` : 'failed'} at ${miss.at}; next try after ${miss.retryAfter}`);
      log(`nflverse ${key}: skipped (failed at ${miss.at}, next try after ${miss.retryAfter})`);
      continue;
    }
    try {
      const ck = checkedAt(key, m);
      if (have && minCheckMs > 0 && ck && nowMs - Date.parse(ck) < minCheckMs) { await useCache('checked recently'); continue; }
      const h = await headInfo(fetchImpl, url);
      out.requests++;
      if (have && h.ok && h.etag && h.etag === m.etag) {
        await useCache('etag unchanged');
        if (checkPath) stamp(key);
        else { meta[key] = { ...m, checkedAt: isoS(nowMs) }; dirty = true; }
      } else if (have && !h.ok) {
        await useCache(`HEAD ${h.status || h.error}`);
        out.warnings.push(`${key}: HEAD failed (${h.status || h.error}); using the copy cached ${m.fetchedAt}`);
      } else {
        // nothing cached and the asset is not there (season files appear in September): no GET to learn it twice
        if (!have && h.status === 404) throw Object.assign(new Error(`${new URL(url).pathname}: HTTP 404`), { status: 404 });
        out.requests++; // counted before the await, so a GET that fails is counted too
        const g = await fetchBytes(fetchImpl, url);
        if (!isGzip(g.buf)) throw new Error(`${key}: not gzip (${g.buf.length} bytes)`);
        out[key] = gunzipText(g.buf);
        out.etags[key] = g.etag || h.etag || null;
        out.lastModified[key] = g.lastModified || h.lastModified || null;
        out.cached[key] = false;
        if (file) {
          try {
            await mkdir(dir, { recursive: true });
            await writeFile(file, g.buf);
            meta[key] = { url, etag: out.etags[key], lastModified: out.lastModified[key], bytes: g.buf.length, fetchedAt: isoS(nowMs), ...(checkPath ? {} : { checkedAt: isoS(nowMs) }) };
            dirty = true;
            stamp(key);
          } catch { /* cache is best effort */ }
        }
        clearMiss(key);
        log(`nflverse ${key}: downloaded ${g.buf.length} bytes`);
      }
    } catch (e) {
      if (have && out[key] == null) { try { await useCache('download failed'); out.warnings.push(`${key}: ${e.message}; using cached copy`); continue; } catch { /* fall through */ } }
      out[key] = out[key] ?? null;
      out.errors.push(`${key}: ${String(e?.message || e).slice(0, 200)}`);
      if (!have && !e?.budget) {
        const status = Number(e?.status) || 0;
        setMiss(key, { url, at: isoS(nowMs), status, retryAfter: isoS(nowMs + (status === 404 ? MISS_BACKOFF.notFoundMs : MISS_BACKOFF.otherMs)) });
      }
    }
    if (pauseMs) await sleep(pauseMs);
  }
  if (dirty && metaPath) { try { await mkdir(dir, { recursive: true }); await writeFile(metaPath, JSON.stringify(meta)); } catch { /* best effort */ } }
  if (checksDirty) { try { await mkdir(dirname(checkPath), { recursive: true }); await writeFile(checkPath, JSON.stringify(checks)); } catch { /* best effort */ } }
  return out;
}

/**
 * ESPN id bridge from raw.rosterWeekly alone (glue.buildIdBridge), for the props join before buildNflverse runs.
 * -> { byEspn, byGsis, byPfr } Maps, or null when the roster is missing or unreadable.
 */
export function rosterBridge(raw) {
  if (raw?.rosterWeekly == null) return null;
  const t = parseCsv(raw.rosterWeekly, { columns: ROSTER_COLS });
  if (['gsis_id', 'espn_id', 'team', 'week'].some((c) => t.missing.includes(c)) || !t.rows.length) return null;
  return buildIdBridge(t);
}

/** One short id for the 4 assets' ETags (rebuild only when it changes). */
export function nflverseEtag(raw) {
  const e = raw?.etags || {};
  const s = ASSET_KEYS.map((k) => `${k}=${e[k] ?? ''}`).join('|');
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- id bridge caching

/** Maps -> plain JSON (one array of player records). */
export function bridgeToJSON(bridge) {
  const players = [...(bridge?.byGsis?.values() || [])].sort((a, b) => (a.gsis < b.gsis ? -1 : a.gsis > b.gsis ? 1 : 0));
  return { v: 1, players };
}
/** Plain JSON -> { byEspn, byGsis, byPfr } Maps (same as glue.buildIdBridge output). */
export function bridgeFromJSON(json) {
  const byEspn = new Map(), byGsis = new Map(), byPfr = new Map();
  for (const p of json?.players || []) {
    byGsis.set(p.gsis, p);
    if (p.espn) byEspn.set(String(p.espn), p);
    if (p.pfr) byPfr.set(p.pfr, p);
  }
  return { byEspn, byGsis, byPfr };
}

// ---------------------------------------------------------------- parsing

const PBP_COLS = ['game_id', 'season_type', 'week', 'posteam', 'defteam', 'play_type', 'yards_gained', 'qb_dropback', 'qb_scramble',
  'rush_attempt', 'pass_attempt', 'sack', 'two_point_attempt', 'epa', 'passing_yards', 'home_team', 'away_team', 'home_score', 'away_score'];
const STAT_COLS = ['player_id', 'player_display_name', 'position', 'position_group', 'season', 'week', 'season_type', 'game_id', 'team', 'opponent_team',
  'completions', 'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions', 'sack_fumbles_lost', 'passing_2pt_conversions',
  'carries', 'rushing_yards', 'rushing_tds', 'rushing_fumbles_lost', 'rushing_2pt_conversions',
  'receptions', 'targets', 'receiving_yards', 'receiving_tds', 'receiving_fumbles_lost', 'receiving_2pt_conversions',
  'special_teams_tds', 'fantasy_points_ppr'];
const ROSTER_COLS = ['gsis_id', 'espn_id', 'pfr_id', 'team', 'jersey_number', 'full_name', 'position', 'week', 'status', 'depth_chart_position'];
const PFR_COLS = ['game_id', 'game_type', 'team', 'pfr_player_id', 'pfr_player_name', 'def_targets', 'def_yards_allowed', 'def_completions_allowed', 'def_pressures', 'def_receiving_td_allowed'];
// columns a piece cannot work without (the others read as 0 when absent)
const PBP_REQUIRED = ['game_id', 'season_type', 'week', 'defteam', 'posteam', 'play_type', 'yards_gained', 'qb_dropback', 'rush_attempt', 'epa', 'home_team', 'away_team'];
const STAT_REQUIRED = ['player_id', 'season_type', 'game_id', 'team', 'opponent_team', 'position_group'];

const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const n0 = (s) => { const x = num(s); return Number.isFinite(x) ? x : 0; };

/** rank: 1 = toughest (lowest value) unless higherIsBetter. Non-finite values get no rank. Ties keep key order. */
function rankBy(obj, get, higherIsBetter = false) {
  const keys = Object.keys(obj).filter((k) => Number.isFinite(get(obj[k]))).sort();
  keys.sort((a, b) => (higherIsBetter ? get(obj[b]) - get(obj[a]) : get(obj[a]) - get(obj[b])));
  const out = {}; keys.forEach((k, i) => { out[k] = i + 1; }); return out;
}

// ---------------------------------------------------------------- defense

function teamDefense(pbp, stats) {
  const c = colIndex(pbp.head, PBP_COLS, { required: false });
  const blank = () => ({ rushN: 0, rushYds: 0, rushEpaN: 0, rushEpa: 0, dbN: 0, dbEpa: 0, sacks: 0, att: 0, passYds: 0 });
  const D = {}, games = {}, ptsA = {};
  let maxWeek = 0;
  for (const r of pbp.rows) {
    if (r[c.season_type] !== 'REG') continue;
    const gid = r[c.game_id];
    const home = r[c.home_team], away = r[c.away_team];
    if (home) (games[home] ||= new Set()).add(gid);
    if (away) (games[away] ||= new Set()).add(gid);
    const wk = +r[c.week]; if (wk > maxWeek) maxWeek = wk;
    const hs = num(r[c.home_score]), as = num(r[c.away_score]);
    if (Number.isFinite(hs) && Number.isFinite(as)) { (ptsA[home] ||= {})[gid] = as; (ptsA[away] ||= {})[gid] = hs; }
    const def = r[c.defteam], off = r[c.posteam], pt = r[c.play_type];
    if (!def || !off || r[c.two_point_attempt] === '1') continue;
    if (pt !== 'run' && pt !== 'pass') continue; // drops no_play, kneels, spikes, special teams
    const d = (D[def] ||= blank());
    const epa = num(r[c.epa]);
    if (pt === 'run' && r[c.rush_attempt] === '1' && r[c.qb_scramble] !== '1') { // designed runs only
      d.rushN++; d.rushYds += num(r[c.yards_gained]) || 0;
      if (Number.isFinite(epa)) { d.rushEpaN++; d.rushEpa += epa; }
    }
    if (r[c.qb_dropback] === '1') { // dropbacks, scrambles included
      const sk = r[c.sack] === '1';
      if (Number.isFinite(epa)) { d.dbN++; d.dbEpa += epa; }
      if (sk) d.sacks++;
      if (pt === 'pass' && r[c.pass_attempt] === '1' && !sk) { d.att++; d.passYds += num(r[c.passing_yards]) || 0; }
    }
  }
  // PPR allowed per game to each position group (nflverse fantasy_points_ppr), by the defense faced
  const F = {}, fpGames = {};
  if (stats) {
    const s = colIndex(stats.head, STAT_COLS, { required: false });
    for (const r of stats.rows) {
      if (r[s.season_type] !== 'REG') continue;
      const def = r[s.opponent_team];
      if (!def) continue;
      (fpGames[def] ||= new Set()).add(r[s.game_id]);
      const pos = r[s.position_group];
      if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;
      ((F[def] ||= {})[pos] = (F[def]?.[pos] || 0) + n0(r[s.fantasy_points_ppr]));
    }
  }
  const out = {};
  for (const team of Object.keys(D).sort()) {
    const x = D[team];
    const g = games[team]?.size || 0;
    const pts = Object.values(ptsA[team] || {});
    const fg = fpGames[team]?.size || 0;
    out[team] = {
      games: g,
      plays: { rush: x.rushN, dropbacks: x.dbN },
      rushYpc: r2(x.rushYds / x.rushN), rushEpa: r3(x.rushEpa / x.rushEpaN),
      passYpa: r2(x.passYds / x.att), passEpa: r3(x.dbEpa / x.dbN),
      sackRate: r3(x.sacks / x.dbN),
      pointsPg: r1(mean(pts)),
      fpAllowed: stats && fg ? Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map((p) => [p, r1((F[team]?.[p] || 0) / fg)])) : null,
      _overallEpa: (x.rushEpa + x.dbEpa) / (x.rushEpaN + x.dbN),
    };
  }
  const R = {
    rush: rankBy(out, (t) => t.rushEpa), pass: rankBy(out, (t) => t.passEpa), overall: rankBy(out, (t) => t._overallEpa),
    vsQB: rankBy(out, (t) => t.fpAllowed?.QB), vsRB: rankBy(out, (t) => t.fpAllowed?.RB), vsWR: rankBy(out, (t) => t.fpAllowed?.WR), vsTE: rankBy(out, (t) => t.fpAllowed?.TE),
    rushYpc: rankBy(out, (t) => t.rushYpc), passYpa: rankBy(out, (t) => t.passYpa), points: rankBy(out, (t) => t.pointsPg), sack: rankBy(out, (t) => t.sackRate, true),
  };
  for (const [k, t] of Object.entries(out)) {
    t.ranks = Object.fromEntries(Object.entries(R).map(([rk, m]) => [rk, m[k] ?? null]));
    delete t._overallEpa;
  }
  return { teams: out, throughWeek: maxWeek };
}

// ---------------------------------------------------------------- injuries lookups (injuriesByGame from buildInjuries)

const OUTISH = /^(out|doubtful)/i;
const SURE = new Set(['confirmed', 'likely']);
function sideLists(injuriesByGame, gameId) {
  const v = injuriesByGame?.[gameId];
  if (!v) return null;
  return v.injuries && (v.injuries.home || v.injuries.away) ? v.injuries : v;
}
/** First upcoming NFL game per nflverse team code -> { game, side }. */
function nextGameByTeam(games) {
  const m = new Map();
  const list = (games || []).filter((g) => g?.league === 'nfl').sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || String(a.id).localeCompare(String(b.id)));
  for (const g of list) for (const side of ['home', 'away']) { const t = nv(g[side]?.abbr); if (t && !m.has(t)) m.set(t, { game: g, side }); }
  return m;
}
const isOutFor = (inj) => !!inj && OUTISH.test(inj.status || '') && SURE.has(inj.grade);

// ---------------------------------------------------------------- corners

function depthByNv(depth) {
  const m = new Map();
  for (const d of Object.values(depth || {})) {
    if (!d || d.error) continue;
    const abbr = d.abbr || d.team?.abbreviation;
    if (abbr) m.set(nv(abbr), d);
  }
  return m;
}
const cbTag = (cv) => (!cv || cv.tgt < 12 ? null : cv.ydsPerTgt >= 9 ? 'weak' : cv.ydsPerTgt <= 5.5 ? 'lockdown' : null);
function corner(p, slot, fs) {
  const cv = p?.id ? fs?.coverage?.[p.id] : null;
  return { name: p?.name ?? null, espnId: p?.id ?? null, slot, targets: cv?.tgt ?? 0, ydsPerTarget: cv?.ydsPerTgt ?? null, tag: cbTag(cv) };
}

function cornersFor(team, fs, dc, injList, bridge, cbPfr) {
  const out = [];
  if (dc?.defense) {
    const injById = new Map((injList || []).map((x) => [String(x.espnId), x]));
    for (const slot of ['lcb', 'rcb', 'nb']) {
      const list = dc.defense[slot] || [];
      if (!list[0]) continue;
      const c = corner(list[0], slot.toUpperCase(), fs);
      if (isOutFor(injById.get(String(list[0].id)))) {
        c.out = true;
        out.push(c);
        if (list[1]) out.push({ ...corner(list[1], slot.toUpperCase(), fs), fillIn: true });
      } else out.push(c);
    }
    return out;
  }
  // no depth chart: the 3 most targeted corners on this defense (slot unknown)
  const isCb = (v) => (cbPfr?.size ? cbPfr.has(v.pfr) : bridge?.byPfr?.get(v.pfr)?.pos === 'CB');
  const cbs = Object.values(fs?.coverage || {}).filter(isCb).sort((a, b) => b.tgt - a.tgt || String(a.name).localeCompare(String(b.name))).slice(0, 3);
  for (const v of cbs) out.push({ name: v.name, espnId: v.espn, slot: null, targets: v.tgt, ydsPerTarget: v.ydsPerTgt, tag: cbTag(v) });
  return out;
}

// ---------------------------------------------------------------- players

// stat key (PropLadder.stat) -> value from one weekly row. Unsupported here: longRec, longRush, firstTd.
const STAT_FN = {
  passYds: (r) => r.passing_yards, passAtt: (r) => r.attempts, passComp: (r) => r.completions, passTd: (r) => r.passing_tds, passInt: (r) => r.passing_interceptions,
  rushYds: (r) => r.rushing_yards, rushAtt: (r) => r.carries, recYds: (r) => r.receiving_yards, rec: (r) => r.receptions,
  rushRecYds: (r) => r.rushing_yards + r.receiving_yards,
  anyTd: (r) => r.rushing_tds + r.receiving_tds + r.special_teams_tds,
  // Kalshi KXNFLFFPTS settles on Sleeper default full PPR (INT -1), not nflverse fantasy_points_ppr (INT -2)
  ffpts: (r) => 0.04 * r.passing_yards + 4 * r.passing_tds - r.passing_interceptions + 0.1 * (r.rushing_yards + r.receiving_yards)
    + 6 * (r.rushing_tds + r.receiving_tds + r.special_teams_tds) + r.receptions
    + 2 * (r.passing_2pt_conversions + r.rushing_2pt_conversions + r.receiving_2pt_conversions)
    - 2 * (r.rushing_fumbles_lost + r.receiving_fumbles_lost + r.sack_fumbles_lost),
};
export const SUPPORTED_STATS = Object.keys(STAT_FN);
export { STAT_FN };
const DEFAULT_STATS = { QB: ['passYds', 'rushYds'], RB: ['rushYds', 'recYds', 'rec'], FB: ['rushYds', 'recYds', 'rec'], WR: ['recYds', 'rec'], TE: ['recYds', 'rec'] };
const NUMERIC = STAT_COLS.slice(10);
const SKILL_ROLES = new Set(['QB1', 'RB1', 'WR1', 'WR2', 'WR3', 'TE1']);
const LOG_MAX = 8;

function indexStats(stats, season) {
  const s = colIndex(stats.head, STAT_COLS, { required: false });
  const byPlayer = new Map(), teamGame = new Map();
  for (const r of stats.rows) {
    if (r[s.season_type] !== 'REG') continue;
    if (season && r[s.season] && +r[s.season] !== +season) continue;
    const x = { id: r[s.player_id], name: r[s.player_display_name], pos: r[s.position], group: r[s.position_group], week: +r[s.week], game: r[s.game_id], team: r[s.team], opp: r[s.opponent_team] };
    for (const k of NUMERIC) x[k] = s[k] >= 0 ? n0(r[s[k]]) : 0;
    if (!byPlayer.has(x.id)) byPlayer.set(x.id, []);
    byPlayer.get(x.id).push(x);
    const k = `${x.game}|${x.team}`;
    let t = teamGame.get(k);
    if (!t) teamGame.set(k, (t = { carries: 0, targets: 0, attempts: 0, players: new Map() }));
    t.carries += x.carries; t.targets += x.targets; t.attempts += x.attempts; t.players.set(x.id, x);
  }
  for (const a of byPlayer.values()) a.sort((p, q) => p.week - q.week || p.game.localeCompare(q.game));
  return { byPlayer, teamGame };
}

function shareOf(idx, g, key) {
  const t = idx.teamGame.get(`${g.game}|${g.team}`);
  return t && t[key] ? g[key] / t[key] : NaN;
}
function statBlock(recs, stat) {
  const vals = recs.map(STAT_FN[stat]);
  return { avg: r1(mean(vals)), last3: r1(mean(vals.slice(-3))), median: r1(median(vals)), log: vals.slice(-LOG_MAX).map(r1) };
}
// teammate presence in one team-game: in | partial | out (no snap counts here, so a stat row is the signal)
function presence(idx, rec, mateGsis) {
  const t = idx.teamGame.get(`${rec.game}|${rec.team}`);
  const m = t?.players.get(mateGsis);
  if (!m || m.carries + m.targets + m.attempts === 0) return 'out';
  if (m.group === 'QB' || m.pos === 'QB') return t.attempts && m.attempts / t.attempts >= 0.6 ? 'in' : 'partial';
  return 'in';
}

function playerContext(idx, gsis, stats, { bridge, mates = [] }) {
  const recs = idx.byPlayer.get(gsis) || [];
  if (!recs.length) return null;
  const b = bridge?.byGsis?.get(gsis);
  const last = recs[recs.length - 1];
  const pos = b?.pos || last.pos || null;
  const want = (stats?.length ? stats : DEFAULT_STATS[pos] || DEFAULT_STATS[last.group] || ['recYds']).filter((k) => STAT_FN[k]);
  const share = (key, list) => r3(mean(list.map((g) => shareOf(idx, g, key)).filter(Number.isFinite)));
  const ctx = {
    name: b?.name || last.name, team: toEspn(b?.team || last.team), pos, games: recs.length,
    stats: Object.fromEntries([...new Set(want)].map((k) => [k, statBlock(recs, k)])),
    share: { carries: share('carries', recs), targets: share('targets', recs), carriesLast3: share('carries', recs.slice(-3)), targetsLast3: share('targets', recs.slice(-3)) },
  };
  const splits = [];
  for (const mate of mates) {
    if (!mate.gsis || mate.gsis === gsis) continue;
    const mateRecs = idx.byPlayer.get(mate.gsis) || [];
    const mateTeams = new Set(mateRecs.map((r) => r.team));
    const w = { in: [], out: [] };
    for (const g of recs) {
      if (!mateTeams.has(g.team)) continue; // the teammate was not on this team this season
      const p = presence(idx, g, mate.gsis);
      if (p !== 'partial') w[p].push(g);
    }
    if (!w.out.length) continue;
    const avg = (list) => Object.fromEntries(Object.keys(ctx.stats).map((k) => [k, r1(mean(list.map(STAT_FN[k])))]));
    splits.push({ without: mate.name, withoutId: mate.espnId, games: w.out.length, avg: avg(w.out),
      share: { carries: share('carries', w.out), targets: share('targets', w.out) }, withGames: w.in.length, withAvg: avg(w.in) });
  }
  if (splits.length) ctx.splits = splits;
  return ctx;
}

/** Snapshot PropLadders -> buildNflverse propPlayers: one entry per ESPN athlete with the stats that have ladders. */
export function propPlayersFromProps(props = []) {
  const m = new Map();
  for (const p of props || []) {
    const id = p?.player?.espnId;
    if (id == null || !p.stat) continue;
    const k = String(id);
    const e = m.get(k) || { espnId: k, name: p.player.name ?? null, team: p.player.team ?? null, stats: [] };
    if (!e.stats.includes(p.stat)) e.stats.push(p.stat);
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.espnId.localeCompare(b.espnId));
}

// ---------------------------------------------------------------- build

/**
 * buildNflverse(raw, { games, propPlayers, injuriesByGame, depth }) ->
 *   { defense: { nfl: { [ESPN abbr]: DefenseRating + front/secondary/meta } }, players: { [espnId]: PlayerContext },
 *     bridge, meta: { season, throughWeek, etag, asOf }, ok, errors, warnings }
 * raw          fetchNflverseInputs() output (CSV texts, or gzip Buffers)
 * games        snapshot games (teams in upcoming NFL games get their QB, RB1, WR1 to WR3 and TE1 contexts)
 * propPlayers  [{ espnId, team, stats: ['rushYds', ...], name? }] players with Kalshi ladders
 * injuriesByGame buildInjuries().byGame (or { [gameId]: { home: [Injury], away: [Injury] } }): drives teammate
 *              splits (only teammates Out or Doubtful, graded confirmed or likely for that game) and the
 *              corner fill-ins
 * depth        optional fetchInjuryInputs().depth: corner slots (LCB, RCB, NB) and team starters. Without it,
 *              corners have slot null and starters come from this season's volume leaders.
 */
export function buildNflverse(raw = {}, { games = [], propPlayers = [], injuriesByGame = {}, depth = null } = {}) {
  const errors = [], warnings = [];
  const season = raw?.season ?? null;
  const parse = (key, columns, required) => {
    if (raw?.[key] == null) { errors.push(`${key}: missing`); return null; }
    try {
      const t = parseCsv(raw[key], { columns });
      const miss = (required || []).filter((c) => t.missing.includes(c));
      if (miss.length) { errors.push(`${key}: missing columns ${miss.join(', ')}`); return null; }
      if (!t.rows.length) { errors.push(`${key}: no rows`); return null; }
      return t;
    } catch (e) { errors.push(`${key}: ${String(e?.message || e).slice(0, 200)}`); return null; }
  };
  const pbp = parse('pbp', PBP_COLS, PBP_REQUIRED);
  const stats = parse('statsPlayerWeek', STAT_COLS, STAT_REQUIRED);
  const roster = parse('rosterWeekly', ROSTER_COLS, ['gsis_id', 'espn_id', 'team', 'week']);
  const pfr = parse('pfrDef', PFR_COLS, ['game_id', 'team', 'pfr_player_id', 'def_targets', 'def_yards_allowed', 'def_pressures']);

  let bridge = { byEspn: new Map(), byGsis: new Map(), byPfr: new Map() };
  const cbPfr = new Set(); // pfr ids whose latest roster row lists them at CB (roster 'position' is only DB)
  if (roster) {
    try { bridge = buildIdBridge(roster); } catch (e) { errors.push(`bridge: ${e.message}`); }
    const rc = colIndex(roster.head, ROSTER_COLS, { required: false });
    if (rc.depth_chart_position >= 0 && rc.pfr_id >= 0) {
      const latest = new Map();
      for (const r of roster.rows) { const g = r[rc.gsis_id]; if (g && (!latest.has(g) || +r[rc.week] > +latest.get(g)[rc.week])) latest.set(g, r); }
      for (const r of latest.values()) if (r[rc.pfr_id] && /^(CB|NB|DB)$/.test(r[rc.depth_chart_position])) cbPfr.add(r[rc.pfr_id]);
    }
  }

  const injuries = injuriesByGame || {};
  const nextGame = nextGameByTeam(games);
  const injFor = (team) => { const ng = nextGame.get(team); return ng ? sideLists(injuries, ng.game.id)?.[ng.side] || [] : []; };
  const dcByNv = depthByNv(depth);

  // ---- defense
  const nfl = {};
  let throughWeek = null;
  if (pbp) {
    try {
      const td = teamDefense(pbp, stats);
      throughWeek = td.throughWeek;
      let fs = {};
      if (pfr) { try { fs = buildFrontSecondary({ pbp, pfrDef: pfr, bridge }); } catch (e) { errors.push(`front/secondary: ${e.message}`); } }
      else {
        try { fs = buildFrontSecondary({ pbp, pfrDef: { head: PFR_COLS, rows: [] }, bridge }); } catch (e) { errors.push(`front/secondary: ${e.message}`); }
      }
      // explosive and pressure ranks: computed here so a null pressure rate gets no rank
      const fr = {
        stuff: rankBy(fs, (t) => t.stuffRate, true), explosiveRun: rankBy(fs, (t) => t.xRunRate),
        explosivePass: rankBy(fs, (t) => t.xPassRate), pressure: rankBy(fs, (t) => t.pressureRate, true),
      };
      for (const [team, t] of Object.entries(td.teams)) {
        const f = fs[team] || null;
        nfl[toEspn(team)] = {
          ...t,
          front: { epaRush: t.rushEpa, stuffRate: f?.stuffRate ?? null, explosiveRunRate: f?.xRunRate ?? null, pressureRate: f?.pressureRate ?? null,
            ranks: { epaRush: t.ranks.rush, stuff: fr.stuff[team] ?? null, explosive: fr.explosiveRun[team] ?? null, pressure: fr.pressure[team] ?? null } },
          secondary: { epaDropback: t.passEpa, explosivePassRate: f?.xPassRate ?? null,
            ranks: { epaDropback: t.ranks.pass, explosive: fr.explosivePass[team] ?? null },
            corners: cornersFor(team, f, dcByNv.get(team), injFor(team), bridge, cbPfr) },
          meta: { throughWeek, gamesCounted: t.games, pfrDropbacks: f?.pfrDropbacks ?? 0 },
        };
      }
    } catch (e) { errors.push(`defense: ${String(e?.message || e).slice(0, 200)}`); }
  }

  // ---- players
  const players = {};
  if (stats) {
    try {
      const idx = indexStats(stats, season);
      const want = new Map(); // gsis -> { espnId, stats:Set, team }
      const add = (gsis, espnId, list, team) => {
        if (!gsis || !espnId) return;
        const w = want.get(gsis) || { espnId: String(espnId), stats: new Set(), team };
        for (const k of list || []) if (STAT_FN[k]) w.stats.add(k);
        want.set(gsis, w);
      };
      // a) players with Kalshi ladders
      const byNameTeam = new Map();
      for (const [gsis, recs] of idx.byPlayer) { const r = recs[recs.length - 1]; byNameTeam.set(`${nameKey(r.name)}|${nv(r.team)}`, gsis); }
      let unresolved = 0;
      for (const p of propPlayers || []) {
        const espnId = p?.espnId != null ? String(p.espnId) : null;
        let gsis = espnId ? bridge.byEspn.get(espnId)?.gsis : null;
        if (!gsis && p?.name && p?.team) gsis = byNameTeam.get(`${nameKey(p.name)}|${nv(p.team)}`) || null;
        if (!gsis || !espnId) { unresolved++; continue; }
        add(gsis, espnId, p.stats, nv(p.team));
      }
      if (unresolved) warnings.push(`players: ${unresolved} prop player(s) not found in roster_weekly or this season's stats`);
      // b) starters of teams in upcoming NFL games, plus angle beneficiaries graded confirmed or likely
      for (const [team, { game, side }] of nextGame) {
        const dc = dcByNv.get(team);
        const ids = [];
        if (dc?.offense) for (const k of ['qb', 'rb', 'wr1', 'wr2', 'wr3', 'te']) { const p = (dc.offense[k] || [])[0]; if (p?.id) ids.push(String(p.id)); }
        else {
          const leaders = (group, key, n) => [...idx.byPlayer.entries()]
            .filter(([g, recs]) => recs[recs.length - 1].team === team && (recs[recs.length - 1].group === group) && (!bridge.byGsis.size || nv(bridge.byGsis.get(g)?.team || team) === team))
            .map(([g, recs]) => [g, recs.reduce((s, r) => s + r[key], 0)]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([g]) => g);
          for (const g of [...leaders('QB', 'attempts', 1), ...leaders('RB', 'carries', 1), ...leaders('WR', 'targets', 3), ...leaders('TE', 'targets', 1)]) {
            const e = bridge.byGsis.get(g)?.espn; if (e) ids.push(String(e));
          }
        }
        const v = injuries?.[game.id];
        for (const a of v?.angles || []) {
          if (!SURE.has(a.grade)) continue;
          for (const bnf of a.beneficiaries || []) if (bnf.id && (bnf.team ?? side) === side) ids.push(String(bnf.id));
        }
        for (const e of ids) { const b = bridge.byEspn.get(e); if (b) add(b.gsis, e, null, team); }
      }
      // c) contexts
      const keys = [...want.keys()].sort();
      for (const gsis of keys) {
        const w = want.get(gsis);
        const team = nv(bridge.byGsis.get(gsis)?.team || w.team || '');
        const ng = nextGame.get(team);
        const mates = [];
        if (ng) {
          for (const inj of sideLists(injuries, ng.game.id)?.[ng.side] || []) {
            if (!SKILL_ROLES.has(inj.role) || !isOutFor(inj) || String(inj.espnId) === w.espnId) continue;
            const b = bridge.byEspn.get(String(inj.espnId));
            if (b) mates.push({ gsis: b.gsis, espnId: String(inj.espnId), name: inj.name || b.name });
          }
        }
        const ctx = playerContext(idx, gsis, [...w.stats], { bridge, mates });
        if (ctx) players[w.espnId] = ctx;
      }
    } catch (e) { errors.push(`players: ${String(e?.message || e).slice(0, 200)}`); }
  }

  const lm = raw?.lastModified?.pbp ? Date.parse(raw.lastModified.pbp) : NaN;
  return {
    defense: { nfl },
    players,
    bridge,
    meta: { season, throughWeek, etag: nflverseEtag(raw), asOf: Number.isFinite(lm) ? isoS(lm) : null },
    ok: errors.length === 0 && Object.keys(nfl).length > 0,
    errors,
    warnings,
  };
}
