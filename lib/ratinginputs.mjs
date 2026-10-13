// ratinginputs.mjs: line free data reductions for the site's power ratings (snapshot.ratingInputs). Node 22+, no deps.
//
// This module only reshapes public data. It holds no fitted weights, coefficients, priors, blend rules or cohort
// rules, and it never reads a betting line: every play by play, games.csv and sportsdataverse column it reads is on an
// allowlist below, and test/ratinginputs.test.mjs fails if a spread, total line, moneyline, odds, vegas_wp, betting or
// matchup line field ever reaches the snapshot.
//
// NFL (nflverse):
//   reducePbp(text)        play by play -> per team game sums by wp bucket and per QB game dropback and EPA sums.
//                          The same reduction as the site's reference reducer (kept plays, buckets, rounding, row
//                          order); a parity test checks it game for game.
//   parseNflGames(text)    games.csv -> one row per game of the season: schedule, scores, rest, roof, surface,
//                          weather, stadium and nflverse's starting QB ids. The line columns are never read.
//   nflStarters(...)       each team's projected starting QB for its next game: the ESPN depth chart QB1, or the next
//                          QB on the chart when QB1 is listed Out or Doubtful, mapped to the nflverse gsis id
//                          through the roster_weekly id bridge, with a source tag.
// CFB (sportsdataverse, ESPN scoreboards):
//   reduceCfbSchedule(...) every Division I vs Division I game of the season with scores, divisions and conferences.
//   reduceCfbTeamBox/Adv/Paper  the FBS involved box efficiency: yards per play, plays, success rate margin.
//   ESPN scoreboard finals fill scores (and missing games) the schedule file does not have yet.
//
// fetchRatingInputs() downloads (by ETag) and reduces; buildRatingInputs() is pure and makes snapshot.ratingInputs
// in the shape agreed with the site (the README has it).
//
// Wp buckets (a data shaping choice, public): bucket 0 is 0.10 <= wp <= 0.90 or wp missing, bucket 1 is
// 0.03 <= wp < 0.10 or 0.90 < wp <= 0.97, bucket 2 is anything more lopsided. wp is nflverse's win probability
// WITHOUT the line; vegas_wp (built from the closing spread) is never read.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { CsvStream, gunzipText, parseCsv, num } from './csv.mjs';
import { headInfo, fetchBytes, nflSeason } from './nflverse.mjs';
import { cfbSeason } from './cfb.mjs';
import { nv } from './glue.mjs';
import { severity } from './injuries.mjs';

export const RATING_INPUTS_VERSION = 1;
export const FRANCHISE = Object.freeze({ SD: 'LAC', OAK: 'LV', STL: 'LA' });
export const fr = (t) => FRANCHISE[t] || t;

/** nflverse wp -> bucket 0 (core), 1 (lopsided), 2 (very lopsided). Missing wp counts as core. */
export function wpBucket(wp) {
  if (!Number.isFinite(wp)) return 0;
  const x = Math.min(wp, 1 - wp);
  return x >= 0.10 ? 0 : x >= 0.03 ? 1 : 2;
}

// Columns read from play by play. vegas_wp, vegas_home_wp, spread_line and total_line are deliberately absent.
export const PBP_RATING_COLS = Object.freeze(['game_id', 'season', 'week', 'season_type', 'game_date', 'home_team', 'away_team', 'posteam', 'defteam',
  'play_type', 'epa', 'success', 'wp', 'pass', 'rush', 'qb_dropback', 'qb_kneel', 'qb_spike', 'qb_scramble',
  'passer_player_id', 'passer_player_name', 'id', 'name', 'fixed_drive', 'two_point_attempt', 'play_deleted', 'play',
  'home_score', 'away_score', 'qtr']);

/**
 * reducePbp(text | Buffer) -> { rows, kept, maxWeek, skipped, games }
 * Kept plays: play_type pass or run, not deleted, play == 1, not a two point try, not a kneel or spike, epa present,
 * and nflverse pass or rush set. pass = nflverse `pass` (dropbacks: passes, sacks, scrambles); rush = `rush`.
 * games[i] = { id, season, week, type, date, home, away, hs, as, teams: { [team]: TeamGame } }
 * TeamGame = { pass: [[plays, sumEPA, successes] x 3 buckets], rush: (same), plays, drives, qb: { [gsis]: [[dropbacks,
 *   sumEPA] x 3] }, qbOrder: [gsis in first seen order], names: { [gsis]: 'F.Last' } }
 * plays = kept plays in all buckets (pace); drives = distinct fixed_drive values with the team on offense (all rows).
 * EPA sums are rounded to 4 decimals. Team codes are franchise codes (SD, OAK, STL mapped to LAC, LV, LA).
 * Games are sorted by (game_date, game_id); teams keep the order of their first row in the file.
 */
export function reducePbp(input) {
  const games = new Map();
  let rows = 0, kept = 0, maxWeek = 0;
  let C = null;
  const tg = (g, team) => {
    let t = g.teams[team];
    if (!t) {
      t = { pass: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rush: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], plays: 0, drives: new Set(), qb: {}, qbOrder: [], names: {} };
      g.teams[team] = t;
    }
    return t;
  };
  const stream = new CsvStream({
    columns: PBP_RATING_COLS,
    onHeader: (h, meta) => {
      if (meta.missing.length) throw new Error(`pbp: missing columns ${meta.missing.join(', ')}`);
      C = Object.fromEntries(h.map((x, i) => [x, i]));
    },
    onRow: (r) => {
      rows++;
      const gid = r[C.game_id];
      let g = games.get(gid);
      if (!g) { g = { id: gid, teams: {} }; games.set(gid, g); }
      if (!g.meta) {
        g.meta = { season: +r[C.season], week: +r[C.week], type: r[C.season_type], date: r[C.game_date], home: fr(r[C.home_team]), away: fr(r[C.away_team]), hs: num(r[C.home_score]), as: num(r[C.away_score]) };
        if (g.meta.week > maxWeek) maxWeek = g.meta.week;
      }
      const pos = r[C.posteam];
      if (!pos) return;
      const t = tg(g, fr(pos));
      const fd = r[C.fixed_drive];
      if (fd !== '' && fd !== 'NA') t.drives.add(fd);
      const pt = r[C.play_type];
      if (pt !== 'pass' && pt !== 'run') return;
      if (r[C.play_deleted] === '1' || r[C.play] === '0' || r[C.two_point_attempt] === '1') return;
      if (r[C.qb_kneel] === '1' || r[C.qb_spike] === '1') return;
      const epa = num(r[C.epa]);
      if (!Number.isFinite(epa)) return;
      const isPass = r[C.pass] === '1', isRush = r[C.rush] === '1';
      if (!isPass && !isRush) return;
      kept++;
      const b = wpBucket(num(r[C.wp]));
      const succ = r[C.success] === '1' ? 1 : 0;
      const a = isPass ? t.pass[b] : t.rush[b];
      a[0]++; a[1] += epa; a[2] += succ;
      t.plays++;
      if (isPass) {
        const qid = r[C.id] && r[C.id] !== 'NA' ? r[C.id] : (r[C.passer_player_id] && r[C.passer_player_id] !== 'NA' ? r[C.passer_player_id] : null);
        if (qid) {
          let q = t.qb[qid];
          if (!q) { q = t.qb[qid] = [[0, 0], [0, 0], [0, 0]]; t.qbOrder.push(qid); t.names[qid] = r[C.name] || r[C.passer_player_name] || ''; }
          q[b][0]++; q[b][1] += epa;
        }
      }
    },
  });
  stream.push(gunzipText(input));
  const meta = stream.end();
  const out = [];
  const r4 = (a) => a.map((x) => [x[0], +x[1].toFixed(4), x[2]]);
  for (const g of games.values()) {
    if (!g.meta) continue;
    const teams = {};
    for (const [team, t] of Object.entries(g.teams)) {
      const qb = {};
      for (const [id, q] of Object.entries(t.qb)) qb[id] = q.map((x) => [x[0], +x[1].toFixed(4)]);
      teams[team] = { pass: r4(t.pass), rush: r4(t.rush), plays: t.plays, drives: t.drives.size, qb, qbOrder: t.qbOrder, names: t.names };
    }
    out.push({ id: g.id, ...g.meta, teams });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  return { rows, kept, maxWeek, skipped: meta.skipped, games: out };
}

/** reducePbp games -> the snapshot's flat rows: teamGames [{ id, team, pass, rush, plays, drives }] and qbGames
 * [{ id, team, qb, name, b }] (QBs in their first credited dropback order within each team-game). */
export function flattenAgg(aggGames = []) {
  const teamGames = [], qbGames = [];
  for (const g of aggGames) {
    for (const [team, t] of Object.entries(g.teams || {})) {
      teamGames.push({ id: g.id, team, pass: t.pass, rush: t.rush, plays: t.plays, drives: t.drives });
      for (const qb of t.qbOrder || []) qbGames.push({ id: g.id, team, qb, name: t.names?.[qb] ?? '', b: t.qb[qb] });
    }
  }
  return { teamGames, qbGames };
}

// ---------------------------------------------------------------- NFL schedule and results (games.csv)

// games.csv columns read. The line columns (spread_line, total_line, home_moneyline, away_moneyline and the spread and
// total odds) are not on this list, so the parser skips them and they never become strings in memory.
export const NFL_GAME_COLS = Object.freeze(['game_id', 'season', 'game_type', 'week', 'gameday', 'weekday', 'gametime',
  'away_team', 'away_score', 'home_team', 'home_score', 'location', 'away_rest', 'home_rest', 'div_game', 'roof', 'surface',
  'temp', 'wind', 'away_qb_id', 'home_qb_id', 'away_qb_name', 'home_qb_name', 'espn', 'stadium_id']);
const NFL_GAME_REQUIRED = ['game_id', 'season', 'game_type', 'week', 'gameday', 'away_team', 'home_team', 'away_score', 'home_score', 'location'];

const nOrNull = (s) => { const x = num(s); return Number.isFinite(x) ? x : null; };

/**
 * parseNflGames(text | Buffer, { season }) -> { games, missing }
 * games: one row per game of `season` (every season when null), in file order, the site's reference games.json row
 * without its four line fields:
 *   { id, season, type, week, date, time, weekday, home, away, hs, as, result, total, neutral, homeRest, awayRest, div,
 *     roof, surface, temp, wind, homeQb, awayQb, homeQbName, awayQbName, espn, stadium }
 * hs, as, result (hs - as) and total (hs + as, the points scored) are null until the game is played. roof is '' until
 * nflverse fills it (retractable roofs on game day). homeQb/awayQb are nflverse's starters (gsis): the actual starter
 * once played, its projection before that. Team codes are franchise codes.
 */
export function parseNflGames(input, { season = null } = {}) {
  const t = parseCsv(input, { columns: NFL_GAME_COLS });
  const missing = NFL_GAME_REQUIRED.filter((c) => t.missing.includes(c));
  if (missing.length) throw new Error(`games.csv: missing columns ${missing.join(', ')}`);
  const c = Object.fromEntries(t.head.map((h, i) => [h, i]));
  const games = [];
  for (const r of t.rows) {
    const s = +r[c.season];
    if (season != null && s !== +season) continue;
    const g = (k) => r[c[k]] ?? '';
    const hs = nOrNull(g('home_score')), as = nOrNull(g('away_score'));
    games.push({
      id: g('game_id'), season: s, type: g('game_type'), week: +g('week'),
      date: g('gameday'), time: g('gametime') || '', weekday: g('weekday'),
      home: fr(g('home_team')), away: fr(g('away_team')),
      hs, as, result: hs !== null && as !== null ? hs - as : null, total: hs !== null && as !== null ? hs + as : null,
      neutral: g('location') === 'Neutral',
      homeRest: nOrNull(g('home_rest')), awayRest: nOrNull(g('away_rest')),
      div: g('div_game') === '1', roof: g('roof') || '', surface: g('surface') || '',
      temp: nOrNull(g('temp')), wind: nOrNull(g('wind')),
      homeQb: g('home_qb_id') || null, awayQb: g('away_qb_id') || null,
      homeQbName: g('home_qb_name') || null, awayQbName: g('away_qb_name') || null,
      espn: g('espn') || null, stadium: g('stadium_id') || '',
    });
  }
  return { games, missing: t.missing };
}

// ---------------------------------------------------------------- NFL projected starters

const OUT_SEVERITY = 0.75; // injuries.mjs severity: Doubtful 0.75, Out and long-term lists 1

/**
 * nflStarters({ games, depth, injuryItems, bridge, at }) -> [Starter] sorted by team
 * Starter = { team, qb, name, espnId, source: 'depth' | 'depth_injury', status, replaced: null | { qb, name, status }, at }
 * games        parseNflGames rows: only teams with an unplayed game get a row (their next game)
 * depth        trimmed ESPN depth charts (lib/injuries.mjs trimDepth), any iterable or object of them
 * injuryItems  the league injuries feed items (trimLeague). When given it is the status source (the newest item per
 *              player; no item = no designation). Without it the depth chart's own injury note is used.
 * bridge       roster_weekly id bridge ({ byEspn: Map }): ESPN athlete id -> gsis; qb is null when it misses
 * at           the depth charts' fetch time
 * source 'depth' = depth chart QB1; 'depth_injury' = QB1 is Out or Doubtful, so the next QB on the chart who is not.
 * A team with no QB on its chart, or with every listed QB Out or Doubtful, gets no row.
 */
export function nflStarters({ games = [], depth = null, injuryItems = null, bridge = null, at = null } = {}) {
  const upcoming = new Set();
  for (const g of games) if (g.hs === null || g.as === null) { upcoming.add(g.home); upcoming.add(g.away); }
  const injById = new Map();
  for (const it of injuryItems || []) {
    if (!it?.id) continue;
    const prev = injById.get(String(it.id));
    if (!prev || Date.parse(it.date) > Date.parse(prev.date)) injById.set(String(it.id), it);
  }
  const statusOf = (p) => {
    const s = injuryItems ? injById.get(String(p.id))?.status : p.inj?.status;
    return s && !/^active$/i.test(String(s)) ? String(s) : null;
  };
  const isOut = (p) => severity(statusOf(p) || '') >= OUT_SEVERITY;
  const gsis = (p) => bridge?.byEspn?.get(String(p.id))?.gsis ?? null;
  const charts = depth instanceof Map ? [...depth.values()] : Array.isArray(depth) ? depth : Object.values(depth || {});
  const out = [];
  const seen = new Set();
  for (const dc of charts) {
    if (!dc || dc.error || !dc.abbr) continue;
    const team = fr(nv(dc.abbr));
    if (!upcoming.has(team) || seen.has(team)) continue;
    const qbs = (dc.offense?.qb || []).filter((p) => p?.id != null);
    if (!qbs.length) continue;
    const q1 = qbs[0];
    const row = (p, source, replaced) => ({ team, qb: gsis(p), name: p.name ?? null, espnId: String(p.id), source, status: statusOf(p), replaced, at: at ?? null });
    if (!isOut(q1)) out.push(row(q1, 'depth', null));
    else {
      const alt = qbs.slice(1).find((p) => !isOut(p));
      if (!alt) continue;
      out.push(row(alt, 'depth_injury', { qb: gsis(q1), name: q1.name ?? null, status: statusOf(q1) }));
    }
    seen.add(team);
  }
  return out.sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : 0));
}

// ---------------------------------------------------------------- CFB (sportsdataverse)

const bool = (s) => s === 'true' || s === 'TRUE' || s === true;
const D1 = new Set(['fbs', 'fcs']);

export const CFB_SCHEDULE_COLS = Object.freeze(['game_id', 'season', 'week', 'season_type', 'season_type_id', 'start_date', 'completed',
  'neutral_site', 'conference_game', 'home_id', 'home_team', 'home_abbreviation', 'home_division', 'home_conference', 'home_points',
  'away_id', 'away_team', 'away_abbreviation', 'away_division', 'away_conference', 'away_points']);
const CFB_SCHEDULE_REQUIRED = ['game_id', 'week', 'start_date', 'completed', 'neutral_site', 'home_id', 'home_division', 'home_points', 'away_id', 'away_division', 'away_points'];
export const CFB_TEAMBOX_COLS = Object.freeze(['game_id', 'team_id', 'totalYards', 'completionAttempts', 'rushingAttempts']);
export const CFB_ADV_COLS = Object.freeze(['game_id', 'team_id', 'EPA_per_play']);
export const CFB_PAPER_COLS = Object.freeze(['game_id', 'team_id', 'success_margin']);

/**
 * reduceCfbSchedule(text | Buffer, { season }) -> { games, nonD1 }
 * Every cfb_schedules row where both teams are Division I (FBS or FCS), played and upcoming, in the FILE's order:
 *   { id, season, week, st (2 regular, 3 post), date, neutral, confGame, h, a, hp, ap, done,
 *     hDiv, aDiv, hConf, aConf, hName, hAbbr, aName, aAbbr }
 * done = completed and both scores present; hp/ap are null until then. Division and conference are this season's.
 * nonD1 counts completed games of a D1 team against a non D1 opponent (left out).
 */
export function reduceCfbSchedule(input, { season = null } = {}) {
  const t = parseCsv(input, { columns: CFB_SCHEDULE_COLS });
  const miss = CFB_SCHEDULE_REQUIRED.filter((x) => t.missing.includes(x));
  if (miss.length) throw new Error(`cfb_schedules: missing columns ${miss.join(', ')}`);
  const c = Object.fromEntries(t.head.map((h, i) => [h, i]));
  const games = [];
  let nonD1 = 0;
  for (const r of t.rows) {
    const g = (k) => r[c[k]] ?? '';
    const hDiv = g('home_division'), aDiv = g('away_division');
    const done = bool(g('completed')) && Number.isFinite(num(g('home_points'))) && Number.isFinite(num(g('away_points')));
    if (!D1.has(hDiv) || !D1.has(aDiv)) {
      if (done && (D1.has(hDiv) || D1.has(aDiv))) nonD1++;
      continue;
    }
    games.push({
      id: String(g('game_id')), season: season ?? (+g('season') || null), week: +g('week'),
      st: +g('season_type_id') || (g('season_type') === 'postseason' ? 3 : 2),
      date: g('start_date'), neutral: bool(g('neutral_site')), confGame: bool(g('conference_game')),
      h: String(g('home_id')), a: String(g('away_id')),
      hp: done ? +g('home_points') : null, ap: done ? +g('away_points') : null, done,
      hDiv, aDiv, hConf: g('home_conference') || null, aConf: g('away_conference') || null,
      hName: g('home_team') || null, hAbbr: g('home_abbreviation') || null, aName: g('away_team') || null, aAbbr: g('away_abbreviation') || null,
    });
  }
  return { games, nonD1 };
}

/** team_box -> [[gameId, teamId, totalYards | null, plays | null]] (plays = rushing attempts + pass attempts). */
export function reduceCfbTeamBox(input) {
  const t = parseCsv(input, { columns: CFB_TEAMBOX_COLS });
  const miss = CFB_TEAMBOX_COLS.filter((x) => t.missing.includes(x));
  if (miss.length) throw new Error(`team_box: missing columns ${miss.join(', ')}`);
  return t.rows.map((r) => {
    const att = num(String(r[3] || '').split(/[/-]/)[1]);
    const plays = num(r[4]) + att;
    const yds = num(r[2]);
    return [String(r[0]), String(r[1]), Number.isFinite(yds) ? yds : null, Number.isFinite(plays) ? plays : null];
  });
}

/** adv_team_gamelog -> [[gameId, teamId]] for rows with a finite EPA per play (EPA itself is not kept). */
export function reduceCfbAdv(input) {
  const t = parseCsv(input, { columns: CFB_ADV_COLS });
  const miss = CFB_ADV_COLS.filter((x) => t.missing.includes(x));
  if (miss.length) throw new Error(`adv_team_gamelog: missing columns ${miss.join(', ')}`);
  return t.rows.filter((r) => Number.isFinite(num(r[2]))).map((r) => [String(r[0]), String(r[1])]);
}

/** cfb_paper_index_games -> [[gameId, teamId, successMargin]] for rows with a finite success rate margin. */
export function reduceCfbPaper(input) {
  const t = parseCsv(input, { columns: CFB_PAPER_COLS });
  const miss = CFB_PAPER_COLS.filter((x) => t.missing.includes(x));
  if (miss.length) throw new Error(`cfb_paper_index_games: missing columns ${miss.join(', ')}`);
  const out = [];
  for (const r of t.rows) { const v = num(r[2]); if (Number.isFinite(v)) out.push([String(r[0]), String(r[1]), v]); }
  return out;
}

/**
 * cfbEff(games, { teamBox, adv, paper }) -> [{ id, ypp: [home, away], plays: [home, away], sr }] sorted by game id
 * A row exists when a team_box row matched the game's home or away team, an adv_team_gamelog row matched with a finite
 * EPA per play, or the home team's paper_index row had a finite success margin (so a row can hold only nulls).
 * ypp = totalYards / plays and plays are set only when plays > 0; sr is the HOME team's success rate margin. Later
 * rows for the same game and team overwrite earlier ones. Full precision; missing values are null.
 */
export function cfbEff(games = [], { teamBox = null, adv = null, paper = null } = {}) {
  const byId = new Map(games.map((g) => [g.id, g]));
  const slot = (gid, tid) => { const g = byId.get(gid); return !g ? -1 : tid === g.h ? 0 : tid === g.a ? 1 : -1; };
  const eff = new Map();
  const E = (gid) => { let e = eff.get(gid); if (!e) eff.set(gid, (e = { id: gid, ypp: [null, null], plays: [null, null], sr: null })); return e; };
  for (const [gid, tid, yds, plays] of teamBox || []) {
    const k = slot(gid, tid);
    if (k < 0) continue;
    const e = E(gid);
    if (plays > 0) { e.plays[k] = plays; const y = yds === null ? NaN : yds / plays; e.ypp[k] = Number.isFinite(y) ? y : null; }
  }
  for (const [gid, tid] of adv || []) { if (slot(gid, tid) >= 0) E(gid); }
  for (const [gid, tid, v] of paper || []) { if (slot(gid, tid) === 0) E(gid).sr = v; }
  return [...eff.values()].sort((a, b) => (a.id.length - b.id.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * ESPN scoreboard finals -> fills for the schedule rows (pure; parsed events from lib/espn.mjs parseScoreboardEvents).
 * A final (status completed, both scores) of a schedule game that is not done yet sets its scores; a final between
 * two teams the schedule knows that is missing from the schedule is added. -> { games, filled: [id], added: [id] }
 */
export function fillCfbFinals(games, events = [], { season = null } = {}) {
  const out = games.map((g) => ({ ...g }));
  const byId = new Map(out.map((g) => [g.id, g]));
  const team = new Map();
  for (const g of out) {
    if (!team.has(g.h)) team.set(g.h, { div: g.hDiv, conf: g.hConf, name: g.hName, abbr: g.hAbbr });
    if (!team.has(g.a)) team.set(g.a, { div: g.aDiv, conf: g.aConf, name: g.aName, abbr: g.aAbbr });
  }
  const filled = [], added = [];
  for (const ev of events || []) {
    if (ev?.state !== 'post' || ev.raw?.status?.type?.completed !== true) continue;
    if (season != null && ev.season != null && ev.season !== season) continue;
    const hId = String(ev.homeComp?.team?.id ?? ''), aId = String(ev.awayComp?.team?.id ?? '');
    const hs = num(ev.homeComp?.score), as = num(ev.awayComp?.score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    const g = byId.get(String(ev.id));
    if (g) {
      if (g.done) continue;
      let hp, ap;
      if (g.h === hId && g.a === aId) { hp = hs; ap = as; } else if (g.h === aId && g.a === hId) { hp = as; ap = hs; } else continue;
      g.hp = hp; g.ap = ap; g.done = true;
      filled.push(g.id);
    } else {
      const H = team.get(hId), A = team.get(aId);
      if (!H || !A || !ev.kickoff) continue;
      const row = {
        id: String(ev.id), season: season ?? ev.season ?? null, week: Number(ev.week) || null, st: Number(ev.seasonType) || 2,
        date: ev.kickoff, neutral: !!ev.neutral, confGame: !!ev.comp?.conferenceCompetition,
        h: hId, a: aId, hp: hs, ap: as, done: true,
        hDiv: H.div, aDiv: A.div, hConf: H.conf ?? null, aConf: A.conf ?? null, hName: H.name ?? null, hAbbr: H.abbr ?? null, aName: A.name ?? null, aAbbr: A.abbr ?? null,
      };
      out.push(row); byId.set(row.id, row); added.push(row.id);
    }
  }
  return { games: out, filled: filled.sort(), added: added.sort() };
}

// ---------------------------------------------------------------- build (pure)

const latestIso = (...xs) => { const v = xs.filter((x) => typeof x === 'string' && Number.isFinite(Date.parse(x))); return v.length ? v.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null; };

/**
 * buildRatingInputs(raw, { cfbEvents, depth, injuryItems, bridge, depthFetchedAt }) -> { ratingInputs | null, source }
 * raw = fetchRatingInputs() output. Pure: the same inputs always give the same output (asOf values are the times the
 * reductions were built or fetched, carried in raw, never the run's clock).
 * ratingInputs = { v: 1, nfl?: { season, asOf, etag, throughWeek, games, teamGames, qbGames, starters },
 *                  cfb?: { season, asOf, files: { etags }, games, eff, effMissing } }
 * A league is left out when its core files are missing (NFL: games.csv rows and the pbp reduction; CFB: the
 * schedule), and the reason is in source.errors. source = sources.ratingInputs (ok only with both leagues and no error).
 */
export function buildRatingInputs(raw = {}, { cfbEvents = [], depth = null, injuryItems = null, bridge = null, depthFetchedAt = null } = {}) {
  const errors = [...(raw?.errors || [])];
  const warnings = [...(raw?.warnings || [])];
  const ri = { v: RATING_INPUTS_VERSION };
  const stats = {};

  // ---- NFL
  const N = raw?.nfl;
  if (N?.games?.rows && N?.pbp?.games) {
    const { teamGames, qbGames } = flattenAgg(N.pbp.games);
    let starters = [];
    try { starters = nflStarters({ games: N.games.rows, depth, injuryItems, bridge, at: depthFetchedAt }); } catch (e) { errors.push(`nfl starters: ${String(e?.message || e).slice(0, 160)}`); }
    if (!depth || !(depth instanceof Map ? depth.size : Object.keys(depth).length)) warnings.push('nfl starters: no depth charts (injuries part skipped or failed)');
    const missingQb = starters.filter((s) => s.qb === null).map((s) => `${s.team} ${s.name}`);
    if (missingQb.length) warnings.push(`nfl starters: no gsis id for ${missingQb.join(', ')} (not in roster_weekly yet)`);
    ri.nfl = {
      season: N.season,
      asOf: latestIso(N.pbp.builtAt, N.games.fetchedAt),
      etag: N.pbp.etag ?? null,
      throughWeek: N.pbp.maxWeek ?? null,
      games: N.games.rows,
      teamGames,
      qbGames,
      starters,
    };
    stats.nfl = { games: N.games.rows.length, played: N.games.rows.filter((g) => g.result !== null).length, teamGames: teamGames.length, qbGames: qbGames.length, starters: starters.length, throughWeek: ri.nfl.throughWeek };
  } else if (N) {
    errors.push(`nfl: left out (${[!N.games?.rows && 'no games.csv rows', !N.pbp?.games && 'no play by play reduction'].filter(Boolean).join(', ')})`);
  }

  // ---- CFB
  const F = raw?.cfb?.files || {};
  if (F.schedules?.data?.games) {
    const season = raw.cfb.season;
    const fill = fillCfbFinals(F.schedules.data.games, cfbEvents, { season });
    const eff = cfbEff(fill.games, { teamBox: F.teamBox?.data, adv: F.advGamelog?.data, paper: F.paperIndex?.data });
    const effIds = new Set(eff.map((e) => e.id));
    const missing = fill.games.filter((g) => g.done && (g.hDiv === 'fbs' || g.aDiv === 'fbs') && !effIds.has(g.id)).map((g) => g.id);
    ri.cfb = {
      season,
      asOf: latestIso(...CFB_FILE_KEYS.map((k) => F[k]?.fetchedAt)),
      files: { etags: Object.fromEntries(CFB_FILE_KEYS.map((k) => [k, F[k]?.etag ?? null])) },
      games: fill.games,
      eff,
      effMissing: missing.length,
    };
    for (const k of CFB_FILE_KEYS) if (k !== 'schedules' && !F[k]) warnings.push(`cfb: no ${k} file, efficiency is incomplete`);
    if (missing.length) warnings.push(`cfb: ${missing.length} final(s) with an FBS team and no box efficiency yet (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''})`);
    stats.cfb = { games: fill.games.length, finals: fill.games.filter((g) => g.done).length, eff: eff.length, effMissing: missing.length, espnFilled: fill.filled.length, espnAdded: fill.added.length, nonD1: F.schedules.data.nonD1 ?? null };
  } else if (raw?.cfb) {
    errors.push('cfb: left out (no schedule file)');
  }

  const has = !!(ri.nfl || ri.cfb);
  const source = {
    ok: errors.length === 0 && !!ri.nfl && !!ri.cfb,
    fetchedAt: raw?.fetchedAt ?? null,
    requests: raw?.requests ?? 0,
    ...stats,
    warnings: [...new Set(warnings)].slice(0, 10),
    errors: [...new Set(errors)].slice(0, 40),
  };
  return { ratingInputs: has ? ri : null, source };
}

// ---------------------------------------------------------------- fetch (ETag gated, reductions cached)

export const NFL_GAMES_URL = 'https://github.com/nflverse/nfldata/raw/master/data/games.csv';
const SDV = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download';
export const CFB_RATING_URLS = Object.freeze({
  schedules: (s) => `${SDV}/cfb_schedules/cfb_schedules_${s}.csv.gz`,
  teamBox: (s) => `${SDV}/espn_cfb_team_box/team_box_${s}.csv`,
  advGamelog: (s) => `${SDV}/espn_cfb_adv_team_gamelog/adv_team_gamelog_${s}.csv`,
  paperIndex: (s) => `${SDV}/cfb_paper_index_games/cfb_paper_index_games_${s}.csv`,
});
export const CFB_FILE_KEYS = Object.freeze(Object.keys(CFB_RATING_URLS));
const CFB_REDUCERS = { teamBox: reduceCfbTeamBox, advGamelog: reduceCfbAdv, paperIndex: reduceCfbPaper };
/** Bumped whenever a reducer's output changes, so cached reductions from an older collector are rebuilt. */
export const REDUCER_VERSION = 1;
/**
 * How often each file is checked with a HEAD (a GET follows only when its ETag changed): games.csv every 30 minutes
 * (scores and starters change on game days), the college files every 3 hours (sportsdataverse rebuilds them about
 * once a day). A file with nothing cached that failed is left alone for RATING_MISS_BACKOFF.
 */
export const RATING_CHECK_MS = Object.freeze({ nflGames: 30 * 60e3, cfb: 3 * 3600e3 });
export const RATING_MISS_BACKOFF = Object.freeze({ notFoundMs: 6 * 3600e3, otherMs: 30 * 60e3 });

const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String(e?.message || e || 'unknown error').slice(0, 200);

async function readJsonFile(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function writeJsonFile(path, data) { try { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(data)); return true; } catch { return false; } }

/**
 * One ETag gated file: HEAD (at most every minCheckMs), GET only when the ETag changed or nothing is cached. Only the
 * REDUCED data is cached, never the raw file: { v, url, etag, lastModified, fetchedAt, bytes, data }.
 * -> { data, etag, lastModified, fetchedAt, cached } or null (the error is in out.errors).
 */
async function etagFile(ctx, { key, url, file, minCheckMs, reduce }) {
  const { fetchImpl, nowMs, out } = ctx;
  const c = file ? await readJsonFile(file) : null;
  const m = c && c.url === url && c.v === REDUCER_VERSION && c.data != null ? c : null;
  const use = (why) => { ctx.log(`ratinginputs ${key}: cached (${why})`); return { data: m.data, etag: m.etag ?? null, lastModified: m.lastModified ?? null, fetchedAt: m.fetchedAt ?? null, cached: true }; };
  const miss = m ? null : ctx.missOf(key, url);
  if (miss && nowMs < Date.parse(miss.retryAfter)) {
    out.errors.push(`${key}: ${miss.status ? `HTTP ${miss.status}` : 'failed'} at ${miss.at}; next try after ${miss.retryAfter}`);
    return null;
  }
  try {
    const ck = ctx.checks[key];
    const age = ck ? nowMs - Date.parse(ck) : NaN;
    if (m && minCheckMs > 0 && age >= 0 && age < minCheckMs) return use('checked recently');
    const h = await headInfo(fetchImpl, url);
    ctx.count();
    if (m && h.ok && h.etag && h.etag === m.etag) { ctx.stamp(key); return use('etag unchanged'); }
    if (m && !h.ok) { out.warnings.push(`${key}: HEAD failed (${h.status || h.error}); using the copy fetched ${m.fetchedAt}`); return use(`HEAD ${h.status || h.error}`); }
    if (!m && h.status === 404) throw Object.assign(new Error(`${new URL(url).pathname}: HTTP 404`), { status: 404 });
    ctx.count(); // counted before the await, so a GET that fails is counted too
    const g = await fetchBytes(fetchImpl, url);
    const data = reduce(g.buf);
    // The HEAD's ETag is kept first: later checks compare HEAD with HEAD (raw.githubusercontent answers a weak ETag).
    const rec = { v: REDUCER_VERSION, url, etag: h.etag || g.etag || null, lastModified: g.lastModified || h.lastModified || null, fetchedAt: isoS(nowMs), bytes: g.buf.length, data };
    if (file) await writeJsonFile(file, rec);
    ctx.stamp(key);
    ctx.clearMiss(key);
    ctx.log(`ratinginputs ${key}: downloaded ${g.buf.length} bytes`);
    return { data, etag: rec.etag, lastModified: rec.lastModified, fetchedAt: rec.fetchedAt, cached: false };
  } catch (e) {
    if (m) { out.warnings.push(`${key}: ${errText(e)}; using the copy fetched ${m.fetchedAt}`); return use('download failed'); }
    out.errors.push(`${key}: ${errText(e)}`);
    if (!e?.budget) {
      const status = Number(e?.status) || 0;
      ctx.setMiss(key, { url, at: isoS(nowMs), status, retryAfter: isoS(nowMs + (status === 404 ? RATING_MISS_BACKOFF.notFoundMs : RATING_MISS_BACKOFF.otherMs)) });
    }
    return null;
  }
}

/**
 * fetchRatingInputs({ fetchImpl, now, cacheDir, checkPath, nflverse, nflSeasonYr, cfbSeasonYr, minCheckMs, pauseMs, log })
 *   -> { fetchedAt, requests, errors, warnings,
 *        nfl: { season, games: { rows, etag, lastModified, fetchedAt, cached } | null,
 *               pbp: { v, season, etag, lastModified, builtAt, rows, kept, maxWeek, skipped, games } | null },
 *        cfb: { season, files: { schedules | teamBox | advGamelog | paperIndex: { data, etag, lastModified, fetchedAt, cached } | null } } }
 * nflverse: fetchNflverseInputs() output, or a promise of it, or null. Its play by play (downloaded by ETag already)
 *   is reduced here and the reduction is cached under the pbp ETag, so a run whose pbp did not change reads the small
 *   cached reduction instead of parsing the file again. Without a pbp (nflverse skipped or failed) the cached
 *   reduction is used with a warning.
 * games.csv and the four sportsdataverse files are HEAD checked (RATING_CHECK_MS), downloaded only on a new ETag and
 *   reduced right away; only the line free reductions are cached (cacheDir/ratinginputs/). The HEAD stamps and the
 *   failed-file records go to checkPath (the state dir) when given, so the daily cache changes only when data does.
 * Never throws for upstream failures; each failure is in errors.
 */
export async function fetchRatingInputs({
  fetchImpl = globalThis.fetch, now = Date.now(), cacheDir = null, checkPath = null, nflverse = null,
  nflSeasonYr = null, cfbSeasonYr = null, minCheckMs = null, pauseMs = 100, log = () => {},
} = {}) {
  const nowMs = toMs(now);
  const dir = cacheDir ? join(cacheDir, 'ratinginputs') : null;
  const out = { fetchedAt: isoS(nowMs), requests: 0, errors: [], warnings: [] };
  const checksFile = checkPath || (dir ? join(dir, 'checks.json') : null);
  const checks = (checksFile && (await readJsonFile(checksFile))) || {};
  let dirty = false;
  const ctx = {
    fetchImpl, nowMs, out, checks, log,
    count: () => { out.requests++; },
    stamp: (key) => { checks[key] = isoS(nowMs); dirty = true; },
    missOf: (key, url) => { const r = checks.misses?.[key]; return r && r.url === url ? r : null; },
    setMiss: (key, rec) => { (checks.misses ||= {})[key] = rec; dirty = true; },
    clearMiss: (key) => { if (checks.misses?.[key]) { delete checks.misses[key]; dirty = true; } },
  };
  const checkMs = (k) => (minCheckMs ?? RATING_CHECK_MS[k]);
  const nflYr = nflSeasonYr ?? nflSeason(nowMs);
  const cfbYr = cfbSeasonYr ?? cfbSeason(nowMs);

  // ---- CFB: the four sportsdataverse files of the season, one after another
  const cfb = { season: cfbYr, files: {} };
  for (const key of CFB_FILE_KEYS) {
    const k = `cfb-${key}`;
    const reduce = key === 'schedules' ? (buf) => reduceCfbSchedule(buf, { season: cfbYr }) : CFB_REDUCERS[key];
    cfb.files[key] = await etagFile(ctx, { key: k, url: CFB_RATING_URLS[key](cfbYr), file: dir ? join(dir, `${k}-${cfbYr}.json`) : null, minCheckMs: checkMs('cfb'), reduce });
    if (pauseMs) await sleep(pauseMs);
  }

  // ---- NFL: games.csv (schedule, results, rest, roof, starters); the line columns are never read
  const nfl = { season: nflYr, games: null, pbp: null };
  const g = await etagFile(ctx, { key: 'nfl-games', url: NFL_GAMES_URL, file: dir ? join(dir, `nfl-games-${nflYr}.json`) : null, minCheckMs: checkMs('nflGames'), reduce: (buf) => parseNflGames(buf, { season: nflYr }).games });
  if (g) nfl.games = { rows: g.data, etag: g.etag, lastModified: g.lastModified, fetchedAt: g.fetchedAt, cached: g.cached };

  // ---- NFL: the play by play reduction, cached under the pbp ETag
  let raw = null;
  try { raw = await nflverse; } catch { raw = null; }
  const aggFile = dir ? join(dir, `nfl-pbp-${nflYr}.json`) : null;
  const cachedAgg = aggFile ? await readJsonFile(aggFile) : null;
  const aggOk = cachedAgg && cachedAgg.v === REDUCER_VERSION && cachedAgg.season === nflYr && Array.isArray(cachedAgg.games) ? cachedAgg : null;
  const pbpEtag = raw?.etags?.pbp ?? null;
  const pbpText = raw && Number(raw.season) === nflYr ? raw.pbp ?? null : null;
  const why = raw ? (raw.errors || []).find((e) => /^pbp/.test(e)) || 'nflverse pbp missing' : 'nflverse not fetched';
  if (pbpText != null && aggOk && pbpEtag && aggOk.etag === pbpEtag) {
    nfl.pbp = aggOk;
    log('ratinginputs nfl-pbp: cached reduction (pbp etag unchanged)');
  } else if (pbpText != null) {
    try {
      const r = reducePbp(pbpText);
      nfl.pbp = { v: REDUCER_VERSION, season: nflYr, etag: pbpEtag, lastModified: raw?.lastModified?.pbp ?? null, builtAt: isoS(nowMs), rows: r.rows, kept: r.kept, maxWeek: r.maxWeek, skipped: r.skipped, games: r.games };
      if (aggFile && pbpEtag) await writeJsonFile(aggFile, nfl.pbp);
      log(`ratinginputs nfl-pbp: reduced ${r.rows} rows, ${r.games.length} games`);
    } catch (e) {
      out.errors.push(`nfl-pbp: ${errText(e)}`);
      if (aggOk) { nfl.pbp = aggOk; out.warnings.push(`nfl-pbp: using the reduction of pbp ${aggOk.etag}`); }
    }
  } else if (aggOk) {
    nfl.pbp = aggOk;
    out.warnings.push(`nfl-pbp: no play by play this run (${errText(why)}); using the reduction of pbp ${aggOk.etag} built ${aggOk.builtAt}`);
  } else {
    out.errors.push(`nfl-pbp: no play by play (${errText(why)}) and no cached reduction`);
  }

  if (dirty && checksFile) await writeJsonFile(checksFile, checks);
  return { ...out, nfl, cfb };
}
