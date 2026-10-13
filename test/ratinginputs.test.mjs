// lib/ratinginputs.mjs and snapshot.ratingInputs: the line free rating inputs for the site's power ratings. Offline.
//
// Fixtures (test/fixtures/ratinginputs), all from the 2026-10-13 nflverse and sportsdataverse files:
//   pbp_2026_sample.csv.gz       every play by play row of 4 games (NE@SEA, CLE@JAX, SF@LA neutral, WAS@DAL with
//                                4 Dallas passers), only the columns the reducer reads
//   agg_2026_sample.json         the site's reference reducer output (agg_2026.json) for those 4 games
//   games_sample.csv             8 games.csv rows (one 2025) with every line column replaced by a sentinel (777,
//                                -777, 77.5, 777.5) so no real line is stored here, and games_sample_expected.json,
//                                the site's reference parser rows for the 2026 games without their line fields
//   cfb_*_sample                 the 4 sportsdataverse files cut to 9 games, and cfb_sample_expected.json, the
//                                site's parity rows (from its reference loader) for them
// The full-season parity against the site's reference outputs runs when RATINGINPUTS_MODEL_DIR (a folder with
// cache/nflverse, nfl/data and cfb/cache/sdv) and optionally RATINGINPUTS_PARITY_DIR (the site's parity rows) are
// set; otherwise it is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIX, researchInputs, RESEARCH_NOW } from './helpers.mjs';
import {
  reducePbp, flattenAgg, parseNflGames, nflStarters, reduceCfbSchedule, reduceCfbTeamBox, reduceCfbAdv, reduceCfbPaper,
  cfbEff, fillCfbFinals, buildRatingInputs, fetchRatingInputs, wpBucket,
  PBP_RATING_COLS, NFL_GAME_COLS, CFB_SCHEDULE_COLS, CFB_TEAMBOX_COLS, CFB_ADV_COLS, CFB_PAPER_COLS, CFB_RATING_URLS, CFB_FILE_KEYS,
  NFL_GAMES_URL, RATING_CHECK_MS, RATING_MISS_BACKOFF,
} from '../lib/ratinginputs.mjs';
import { buildSnapshot } from '../lib/build.mjs';
import { validateSnapshot, lineFieldPaths, LINE_FIELD_RE } from '../lib/schema.mjs';
import { packSnapshot } from '../lib/ingest.mjs';
import { withDeadline, budgetSignal } from '../lib/http.mjs';
import { gunzipText } from '../lib/csv.mjs';

const R = join(FIX, 'ratinginputs');
const buf = (f) => readFileSync(join(R, f));
const json = (f) => JSON.parse(readFileSync(join(R, f), 'utf8'));
const PBP = buf('pbp_2026_sample.csv.gz');
const AGG = json('agg_2026_sample.json').games;
const GAMES_CSV = buf('games_sample.csv');
const GAMES_EXP = json('games_sample_expected.json').games;
const CFB_EXP = json('cfb_sample_expected.json');
const CFB = { schedules: buf('cfb_schedules_sample.csv.gz'), teamBox: buf('team_box_sample.csv'), advGamelog: buf('adv_team_gamelog_sample.csv'), paperIndex: buf('paper_index_sample.csv') };
const SENTINELS = new Set([777, -777, 77.5, 777.5]);

/** The engine's conversion back to agg rows (ratinginputs-shape.md toAgg). */
function toAgg(teamGames, qbGames) {
  const byId = new Map();
  for (const t of teamGames) {
    if (!byId.has(t.id)) byId.set(t.id, { id: t.id, teams: {} });
    byId.get(t.id).teams[t.team] = { pass: t.pass, rush: t.rush, plays: t.plays, drives: t.drives, qb: {}, qbOrder: [], names: {} };
  }
  for (const q of qbGames) {
    const t = byId.get(q.id)?.teams[q.team];
    if (t) { t.qb[q.qb] = q.b; t.qbOrder.push(q.qb); t.names[q.qb] = q.name; }
  }
  return [...byId.values()];
}
const walkValues = (o, fn) => { if (Array.isArray(o)) o.forEach((x) => walkValues(x, fn)); else if (o && typeof o === 'object') Object.values(o).forEach((x) => walkValues(x, fn)); else fn(o); };

/** fetchRatingInputs-shaped raw input from the fixtures (what the fetch step would have cached). */
function fixtureRaw({ at = '2026-10-13T19:55:11Z' } = {}) {
  const r = reducePbp(PBP);
  const file = (data, etag) => ({ data, etag, lastModified: null, fetchedAt: at, cached: true });
  return {
    fetchedAt: at, requests: 0, errors: [], warnings: [],
    nfl: { season: 2026, games: { rows: parseNflGames(GAMES_CSV, { season: 2026 }).games, etag: 'W/"g1"', lastModified: null, fetchedAt: at, cached: true },
      pbp: { v: 1, season: 2026, etag: '"p1"', lastModified: null, builtAt: at, rows: r.rows, kept: r.kept, maxWeek: r.maxWeek, skipped: r.skipped, games: r.games } },
    cfb: { season: 2026, files: {
      schedules: file(reduceCfbSchedule(CFB.schedules, { season: 2026 }), '"s1"'), teamBox: file(reduceCfbTeamBox(CFB.teamBox), '"t1"'),
      advGamelog: file(reduceCfbAdv(CFB.advGamelog), '"a1"'), paperIndex: file(reduceCfbPaper(CFB.paperIndex), '"x1"'),
    } },
  };
}

// ---------------------------------------------------------------- NFL reducer parity

test('reducePbp: the 4 sample games match the reference agg_2026.json rows exactly (byte for byte)', () => {
  const r = reducePbp(PBP);
  assert.equal(r.games.length, 4);
  assert.equal(JSON.stringify(r.games), JSON.stringify(AGG));
  assert.equal(r.maxWeek, 2);
  assert.equal(r.skipped, 0);
  // the 4 Washington passers keep their first dropback order, and the SF@LA neutral game uses the LA franchise code
  assert.equal(r.games.find((g) => g.id === '2026_02_WAS_DAL').teams.WAS.qbOrder.length, 4);
  assert.deepEqual(Object.keys(r.games.find((g) => g.id === '2026_01_SF_LA').teams).sort(), ['LA', 'SF']);
  // CLE@JAX is the sample's garbage time game: plays in buckets 1 and 2
  const cj = r.games.find((g) => g.id === '2026_01_CLE_JAX').teams;
  assert.ok(Object.values(cj).some((t) => t.pass[2][0] + t.rush[2][0] > 0) && Object.values(cj).some((t) => t.pass[1][0] + t.rush[1][0] > 0));
});

test('reducePbp: vegas_wp, spread_line and total_line are never read (adding them with any values changes nothing)', () => {
  const text = gunzipText(PBP);
  const lines = text.split('\n');
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647).toFixed(4); };
  const withLines = lines.map((l, i) => (!l ? l : i === 0 ? `vegas_wp,${l},spread_line,total_line,vegas_home_wp` : `${rnd()},${l},${rnd()},${rnd()},${rnd()}`)).join('\n');
  assert.equal(JSON.stringify(reducePbp(withLines).games), JSON.stringify(AGG));
  for (const c of PBP_RATING_COLS) assert.doesNotMatch(c, LINE_FIELD_RE, c);
});

test('wpBucket: core 0.10 to 0.90 (and missing), lopsided to 0.03 or 0.97, very lopsided past that', () => {
  // x = min(wp, 1 - wp) in floating point, as in the model: 1 - 0.9 is 0.0999..., so wp 0.9 itself is bucket 1
  assert.deepEqual([NaN, 0.5, 0.1, 0.89, 0.9, 0.0999, 0.03, 0.97, 0.0299, 0.98].map(wpBucket), [0, 0, 0, 0, 1, 1, 1, 1, 2, 2]);
});

test('flattenAgg: teamGames and qbGames convert back to the agg rows exactly (the engine toAgg)', () => {
  const { teamGames, qbGames } = flattenAgg(AGG);
  assert.equal(teamGames.length, 8);
  assert.equal(qbGames.length, AGG.reduce((n, g) => n + Object.values(g.teams).reduce((m, t) => m + t.qbOrder.length, 0), 0));
  assert.deepEqual(Object.keys(teamGames[0]), ['id', 'team', 'pass', 'rush', 'plays', 'drives']);
  assert.deepEqual(Object.keys(qbGames[0]), ['id', 'team', 'qb', 'name', 'b']);
  assert.equal(JSON.stringify(toAgg(teamGames, qbGames)), JSON.stringify(AGG.map((g) => ({ id: g.id, teams: g.teams }))));
});

// ---------------------------------------------------------------- NFL games.csv

test('parseNflGames: the reference games.json rows without their line fields; the sentinel line values never come out', () => {
  const { games } = parseNflGames(GAMES_CSV, { season: 2026 });
  assert.equal(JSON.stringify(games), JSON.stringify(GAMES_EXP));
  assert.equal(games.length, 7, 'the 2025 row is left out');
  for (const g of games) for (const k of Object.keys(g)) assert.doesNotMatch(k, LINE_FIELD_RE, k);
  walkValues(games, (v) => assert.ok(!SENTINELS.has(v), `sentinel ${v} leaked`));
  const atl = games.find((g) => g.id === '2026_06_CHI_ATL');
  assert.deepEqual([atl.hs, atl.as, atl.result, atl.total, atl.roof], [null, null, null, null, ''], 'upcoming retractable roof game: raw blank roof');
  assert.equal(games.find((g) => g.id === '2026_01_SF_LA').neutral, true);
  assert.equal(parseNflGames(GAMES_CSV).games.length, 8);
  for (const c of NFL_GAME_COLS) assert.doesNotMatch(c, LINE_FIELD_RE, c);
});

// ---------------------------------------------------------------- NFL starters

const ITEM = (id, status, date = '2026-10-13T12:00Z') => ({ id, status, date, name: null, pos: 'QB' });
const QB = (id, name, inj = null) => ({ id, name, pos: 'QB', inj: inj ? { status: inj } : null });
const DEPTH = {
  1: { teamId: '1', abbr: 'ATL', offense: { qb: [QB('11', 'Atl One', 'Questionable'), QB('12', 'Atl Two')] }, defense: {} },
  2: { teamId: '2', abbr: 'CHI', offense: { qb: [QB('21', 'Chi One'), QB('22', 'Chi Two')] }, defense: {} },
  3: { teamId: '3', abbr: 'LAR', offense: { qb: [QB('31', 'La One'), QB('32', 'La Two'), QB('33', 'La Three')] }, defense: {} },
  4: { teamId: '4', abbr: 'WSH', offense: { qb: [QB('41', 'Was One'), QB('42', 'Was Two')] }, defense: {} },
  5: { teamId: '5', abbr: 'NE', offense: { qb: [QB('51', 'Ne One')] }, defense: {} },
  6: { teamId: '6', abbr: 'KC', offense: { qb: [] }, defense: {} },
};
const BRIDGE = { byEspn: new Map([['11', { gsis: '00-A11' }], ['12', { gsis: '00-A12' }], ['21', { gsis: '00-C21' }], ['31', { gsis: '00-L31' }], ['32', { gsis: '00-L32' }], ['42', { gsis: '00-W42' }]]) };
const SCHED = [
  { id: 'x1', home: 'ATL', away: 'CHI', hs: null, as: null },
  { id: 'x2', home: 'LA', away: 'WAS', hs: null, as: null },
  { id: 'x3', home: 'NE', away: 'KC', hs: 20, as: 17 },
];

test('nflStarters: depth chart QB1, the next QB when QB1 is Out or Doubtful, gsis through the bridge, source tags', () => {
  const items = [ITEM('11', 'Questionable'), ITEM('31', 'Out'), ITEM('32', 'Doubtful'), ITEM('41', 'Out', '2026-10-10T12:00Z'), ITEM('41', 'Active', '2026-10-12T12:00Z'), ITEM('21', 'Doubtful')];
  const s = nflStarters({ games: SCHED, depth: DEPTH, injuryItems: items, bridge: BRIDGE, at: '2026-10-13T19:55:11Z' });
  assert.deepEqual(s.map((x) => x.team), ['ATL', 'CHI', 'LA', 'WAS'], 'teams with an unplayed game only (NE and KC played; KC has no QB anyway), sorted');
  const by = Object.fromEntries(s.map((x) => [x.team, x]));
  assert.deepEqual(by.ATL, { team: 'ATL', qb: '00-A11', name: 'Atl One', espnId: '11', source: 'depth', status: 'Questionable', replaced: null, at: '2026-10-13T19:55:11Z' });
  assert.deepEqual(by.CHI, { team: 'CHI', qb: null, name: 'Chi Two', espnId: '22', source: 'depth_injury', status: null, replaced: { qb: '00-C21', name: 'Chi One', status: 'Doubtful' }, at: '2026-10-13T19:55:11Z' }, 'Doubtful QB1 passed over; the bridge misses QB2');
  assert.equal(by.LA.espnId, '33', 'QB1 Out and QB2 Doubtful: the third QB');
  assert.deepEqual(by.LA.replaced, { qb: '00-L31', name: 'La One', status: 'Out' });
  assert.equal(by.WAS.source, 'depth', 'a newer Active item clears the older Out');
  assert.equal(by.WAS.status, null);
  // no league feed: the depth chart's own note is the status
  const d = nflStarters({ games: SCHED, depth: DEPTH, injuryItems: null, bridge: BRIDGE, at: null });
  assert.equal(d.find((x) => x.team === 'ATL').status, 'Questionable');
  assert.equal(d.find((x) => x.team === 'CHI').source, 'depth');
  // the feed has no row but the chart says Out: the chart's note counts (the injury lists' rule); a newer feed row
  // beats an older chart note; a chart note about a signing is not an injury
  const chartOut = { 1: { ...DEPTH[1], offense: { qb: [{ id: '11', name: 'Atl One', pos: 'QB', inj: { status: 'Out', date: '2026-10-12T10:00Z', comment: 'Ruled out with a rib injury.' } }, QB('12', 'Atl Two')] } } };
  const c1 = nflStarters({ games: SCHED, depth: chartOut, injuryItems: [ITEM('99', 'Out')], bridge: BRIDGE });
  assert.deepEqual([c1[0].source, c1[0].espnId, c1[0].replaced.status], ['depth_injury', '12', 'Out']);
  const c2 = nflStarters({ games: SCHED, depth: chartOut, injuryItems: [ITEM('11', 'Questionable', '2026-10-13T09:00Z')], bridge: BRIDGE });
  assert.deepEqual([c2[0].source, c2[0].status], ['depth', 'Questionable']);
  const signed = { 1: { ...DEPTH[1], offense: { qb: [{ id: '11', name: 'Atl One', pos: 'QB', inj: { status: 'Out', date: '2026-10-12T10:00Z', comment: 'Signed with Atlanta on Monday.' } }] } } };
  assert.equal(nflStarters({ games: SCHED, depth: signed, injuryItems: [], bridge: BRIDGE })[0].source, 'depth');
  // every QB on the chart out: no row
  assert.equal(nflStarters({ games: SCHED, depth: { 1: DEPTH[1] }, injuryItems: [ITEM('11', 'Out'), ITEM('12', 'Injured Reserve')], bridge: BRIDGE }).length, 0);
  // a Map of charts (what build.mjs passes) works the same
  assert.deepEqual(nflStarters({ games: SCHED, depth: new Map(Object.entries(DEPTH)), injuryItems: items, bridge: BRIDGE, at: '2026-10-13T19:55:11Z' }), s);
});

// ---------------------------------------------------------------- CFB

test('CFB reductions: games in file order and box efficiency match the reference loader rows exactly', () => {
  const sch = reduceCfbSchedule(CFB.schedules, { season: 2026 });
  assert.equal(sch.nonD1, 1, 'Hampton against a non Division I team is dropped and counted');
  assert.equal(JSON.stringify(sch.games), JSON.stringify(CFB_EXP.games));
  const eff = cfbEff(sch.games, { teamBox: reduceCfbTeamBox(CFB.teamBox), adv: reduceCfbAdv(CFB.advGamelog), paper: reduceCfbPaper(CFB.paperIndex) });
  assert.equal(JSON.stringify(eff), JSON.stringify(CFB_EXP.eff));
  for (const cols of [CFB_SCHEDULE_COLS, CFB_TEAMBOX_COLS, CFB_ADV_COLS, CFB_PAPER_COLS]) for (const c of cols) assert.doesNotMatch(c, LINE_FIELD_RE, c);
  for (const k of CFB_FILE_KEYS) assert.doesNotMatch(CFB_RATING_URLS[k](2026), /betting|matchup_line/);
});

test('cfbEff: a row exists whenever the model creates one, even with only nulls; ypp needs plays above 0', () => {
  const games = [{ id: '1', h: 'A', a: 'B' }, { id: '2', h: 'C', a: 'D' }, { id: '3', h: 'E', a: 'F' }, { id: '10', h: 'G', a: 'H' }];
  const eff = cfbEff(games, {
    teamBox: [['1', 'A', 400, 80], ['1', 'B', null, 50], ['2', 'C', 300, 0], ['9', 'A', 1, 1], ['1', 'Z', 1, 1]],
    adv: [['3', 'F']],
    paper: [['10', 'H', 0.2], ['10', 'G', -0.1]],
  });
  assert.deepEqual(eff, [
    { id: '1', ypp: [5, null], plays: [80, 50], sr: null },
    { id: '2', ypp: [null, null], plays: [null, null], sr: null },
    { id: '3', ypp: [null, null], plays: [null, null], sr: null },
    { id: '10', ypp: [null, null], plays: [null, null], sr: -0.1 },
  ]);
});

const espnEvent = (id, home, away, { hs = '24', as = '17', state = 'post', completed = true, date = '2026-10-17T16:00Z' } = {}) => ({
  id, date, season: { year: 2026, type: 2 }, week: { number: 7 }, status: { type: { state, completed } },
  competitions: [{ id, date, neutralSite: false, conferenceCompetition: true, competitors: [
    { homeAway: 'home', score: hs, team: { id: home, abbreviation: 'H', displayName: 'Home' } },
    { homeAway: 'away', score: as, team: { id: away, abbreviation: 'A', displayName: 'Away' } },
  ] }],
});

test('fillCfbFinals: ESPN finals fill scores the schedule lacks and add missing games between known teams', async () => {
  const { parseScoreboardEvents } = await import('../lib/espn.mjs');
  const games = reduceCfbSchedule(CFB.schedules, { season: 2026 }).games;
  const events = parseScoreboardEvents([{ events: [
    espnEvent('401866663', '2529', '2261'),                               // Sacred Heart vs Hampton, not final in the file
    espnEvent('401856719', '2', '61', { hs: '10', as: '31' }),           // listed the other way round: mapped by team id
    espnEvent('401999001', '2529', '2261', { hs: '3', as: '0' }),        // not in the file, both teams known
    espnEvent('401999002', '2529', '99999'),                              // unknown team: ignored
    espnEvent('401999003', '2529', '2261', { state: 'in', completed: false }),
    espnEvent('401856634', '333', '151', { hs: '0', as: '99' }),        // already final in the file: kept
  ] }], 'cfb');
  const r = fillCfbFinals(games, events, { season: 2026 });
  assert.deepEqual(r.filled, ['401856719', '401866663']);
  assert.deepEqual(r.added, ['401999001']);
  const by = Object.fromEntries(r.games.map((g) => [g.id, g]));
  assert.deepEqual([by['401866663'].hp, by['401866663'].ap, by['401866663'].done], [24, 17, true]);
  assert.deepEqual([by['401856719'].hp, by['401856719'].ap], [31, 10], 'Georgia (home in the file) scored 31');
  assert.deepEqual([by['401856634'].hp, by['401856634'].ap], [48, 10]);
  assert.equal(by['401999001'].hDiv, 'fcs');
  assert.equal(by['401999001'].hName, 'Sacred Heart');
  assert.equal(games.find((g) => g.id === '401866663').done, false, 'the input rows are not changed');
});

// ---------------------------------------------------------------- build and schema

test('buildSnapshot: ratingInputs in the agreed shape, schema clean, deterministic; absent input leaves every other byte unchanged', () => {
  const raw = fixtureRaw();
  const inputs = { ...researchInputs(), ratingInputs: raw };
  const s = buildSnapshot(inputs, { now: RESEARCH_NOW });
  assert.deepEqual(validateSnapshot(s), []);
  const ri = s.ratingInputs;
  assert.deepEqual(Object.keys(ri), ['v', 'nfl', 'cfb']);
  assert.deepEqual(Object.keys(ri.nfl), ['season', 'asOf', 'etag', 'throughWeek', 'games', 'teamGames', 'qbGames', 'starters']);
  assert.deepEqual(Object.keys(ri.cfb), ['season', 'asOf', 'files', 'games', 'eff', 'effMissing']);
  assert.deepEqual([ri.nfl.season, ri.nfl.asOf, ri.nfl.etag, ri.nfl.throughWeek], [2026, '2026-10-13T19:55:11Z', '"p1"', 2]);
  assert.deepEqual(ri.cfb.files, { etags: { schedules: '"s1"', teamBox: '"t1"', advGamelog: '"a1"', paperIndex: '"x1"' } });
  assert.equal(ri.cfb.effMissing, 0);
  assert.equal(JSON.stringify(toAgg(ri.nfl.teamGames, ri.nfl.qbGames)), JSON.stringify(AGG.map((g) => ({ id: g.id, teams: g.teams }))));
  assert.deepEqual(lineFieldPaths(ri), []);
  assert.equal(s.sources.ratingInputs.ok, true, s.sources.ratingInputs.errors.join(' | '));
  assert.equal(s.sources.ratingInputs.cfb.games, 8);
  // same inputs, same bytes
  assert.equal(JSON.stringify(buildSnapshot({ ...researchInputs(), ratingInputs: fixtureRaw() }, { now: RESEARCH_NOW })), JSON.stringify(s));
  // without the input: no field, no source entry, and everything else identical
  const plain = buildSnapshot(researchInputs(), { now: RESEARCH_NOW });
  assert.equal(plain.ratingInputs, undefined);
  assert.equal(plain.sources.ratingInputs, undefined);
  const strip = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.ratingInputs; delete c.sources.ratingInputs; return JSON.stringify(c); };
  assert.equal(strip(s), JSON.stringify(plain));
});

test('buildSnapshot: ESPN board finals reach ratingInputs.cfb; depth charts and injuries make the starters', () => {
  const base = researchInputs();
  const inputs = {
    ...base,
    espn: { ...base.espn, scoreboards: { ...base.espn.scoreboards, cfb: [...base.espn.scoreboards.cfb, { events: [espnEvent('401866663', '2529', '2261')] }] } },
    injuryFeed: { league: { fetchedAt: RESEARCH_NOW, timestamp: null, count: 1, items: [ITEM('11', 'Out')] }, depth: { 1: DEPTH[1] }, depthFetchedAt: '2026-10-11T18:00:00Z', schedule: [], leagueFetchedAt: RESEARCH_NOW, errors: [], requests: 1 },
    ratingInputs: fixtureRaw(),
  };
  // the sample games.csv has CHI@ATL unplayed, so ATL gets a starter row
  const s = buildSnapshot(inputs, { now: RESEARCH_NOW });
  assert.deepEqual(validateSnapshot(s).filter((p) => /ratingInputs/.test(p)), []);
  const g = s.ratingInputs.cfb.games.find((x) => x.id === '401866663');
  assert.deepEqual([g.hp, g.ap, g.done], [24, 17, true]);
  assert.equal(s.sources.ratingInputs.cfb.espnFilled, 1);
  assert.deepEqual(s.ratingInputs.nfl.starters, [{ team: 'ATL', qb: null, name: 'Atl Two', espnId: '12', source: 'depth_injury', status: null, replaced: { qb: null, name: 'Atl One', status: 'Out' }, at: '2026-10-11T18:00:00Z' }]);
  assert.ok(s.sources.ratingInputs.warnings.some((w) => /no gsis id for ATL Atl Two/.test(w)), 'no roster bridge in these inputs');
});

test('buildSnapshot: a missing league or a builder crash fails open (field left out, source says why)', () => {
  const noPbp = fixtureRaw();
  noPbp.nfl.pbp = null;
  noPbp.errors = ['nfl-pbp: no play by play (nflverse not fetched) and no cached reduction'];
  const a = buildSnapshot({ ...researchInputs(), ratingInputs: noPbp }, { now: RESEARCH_NOW });
  assert.equal(a.ratingInputs.nfl, undefined);
  assert.ok(a.ratingInputs.cfb);
  assert.equal(a.sources.ratingInputs.ok, false);
  assert.ok(a.sources.ratingInputs.errors.some((e) => /nfl: left out \(no play by play reduction\)/.test(e)));
  const broken = fixtureRaw();
  broken.cfb.files.schedules.data.games = 5; // not a list: the builder throws
  const b = buildSnapshot({ ...researchInputs(), ratingInputs: broken }, { now: RESEARCH_NOW });
  assert.equal(b.ratingInputs, undefined);
  assert.equal(b.sources.ratingInputs.ok, false);
  assert.match(b.sources.ratingInputs.errors.join(' | '), /build failed/);
  assert.deepEqual(validateSnapshot(b), []);
  const plain = buildSnapshot(researchInputs(), { now: RESEARCH_NOW });
  assert.equal(JSON.stringify(b.games), JSON.stringify(plain.games));
});

test('schema: any betting line field anywhere inside ratingInputs is a problem; total and result are not', () => {
  const s = buildSnapshot({ ...researchInputs(), ratingInputs: fixtureRaw() }, { now: RESEARCH_NOW });
  const inject = (fn) => { const c = JSON.parse(JSON.stringify(s)); fn(c.ratingInputs); return validateSnapshot(c).filter((p) => /betting line field/.test(p)); };
  assert.deepEqual(inject(() => {}), []);
  const cases = {
    'nfl.games[0].spread': (ri) => { ri.nfl.games[0].spread = 3; },
    'nfl.games[1].totalLine': (ri) => { ri.nfl.games[1].totalLine = 44.5; },
    'nfl.games[2].homeMl': (ri) => { ri.nfl.games[2].homeMl = -150; },
    'nfl.games[3].away_moneyline': (ri) => { ri.nfl.games[3].away_moneyline = 130; },
    'nfl.teamGames[0].vegas_wp': (ri) => { ri.nfl.teamGames[0].vegas_wp = 0.6; },
    'nfl.qbGames[0].spread_line': (ri) => { ri.nfl.qbGames[0].spread_line = 1; },
    'cfb.games[0].odds': (ri) => { ri.cfb.games[0].odds = { a: 1 }; },
    'cfb.eff[0].over_odds': (ri) => { ri.cfb.eff[0].over_odds = -110; },
    'cfb.files.etags.betting': (ri) => { ri.cfb.files.etags.betting = 'x'; },
    'cfb.matchup_line': (ri) => { ri.cfb.matchup_line = []; },
    'nfl.vegas_home_wp': (ri) => { ri.nfl.vegas_home_wp = 0.5; },
    'nfl.games[0].total_line': (ri) => { ri.nfl.games[0].total_line = 41; },
  };
  for (const [path, fn] of Object.entries(cases)) {
    const p = inject(fn);
    assert.equal(p.length, 1, path);
    assert.match(p[0], new RegExp(`^ratingInputs\\.${path.replace(/[.[\]]/g, '\\$&')}: `), path);
  }
  for (const ok of ['total', 'result', 'hs', 'as', 'plays', 'sr', 'ypp', 'homeQb', 'stadium', 'roof', 'confGame', 'effMissing']) assert.doesNotMatch(ok, LINE_FIELD_RE, ok);
  // shape checks
  const c = JSON.parse(JSON.stringify(s));
  c.ratingInputs.nfl.starters = [{ team: 'ATL', qb: null, name: 'X', espnId: '1', source: 'guess', status: null, replaced: null, at: null }];
  c.ratingInputs.cfb.games[0].hp = null;
  c.ratingInputs.cfb.eff.push({ id: 'nope', ypp: [1, 2], plays: [3, 4], sr: 0 });
  const probs = validateSnapshot(c);
  assert.ok(probs.some((p) => /ratingInputs\.nfl\.starters\[0\]/.test(p)));
  assert.ok(probs.some((p) => /ratingInputs\.cfb\.games\[0\] scores must be set exactly when done/.test(p)));
  assert.ok(probs.some((p) => /ratingInputs\.cfb\.eff\[\d+\]\.id nope is not in cfb\.games/.test(p)));
});

// ---------------------------------------------------------------- size budget

test('size budget: a full season of rating inputs stays under 160 KB gzipped, and the research snapshot with it under 1 MB', (t) => {
  // Synthetic worst case: 285 NFL games (regular season and playoffs) all played, 3 QBs per team-game, 32 starters;
  // 1,750 CFB games all final and 950 efficiency rows (today: 272 / 79 played, 1,539 / 748 final, 448 rows).
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const g0 = parseNflGames(GAMES_CSV, { season: 2026 }).games[0];
  const nflGames = Array.from({ length: 285 }, (_, i) => ({ ...g0, id: `2026_${String(i % 22).padStart(2, '0')}_T${i}`, week: 1 + (i % 22), hs: 10 + (i % 30), as: 7 + (i % 25), result: 3, total: 40, temp: 50 + (i % 40), wind: i % 20 }));
  const b3 = () => [0, 1, 2].map(() => [Math.floor(rnd() * 40), +(rnd() * 20 - 10).toFixed(4), Math.floor(rnd() * 20)]);
  const teamGames = nflGames.flatMap((g) => ['AAA', 'BBB'].map((team) => ({ id: g.id, team, pass: b3(), rush: b3(), plays: 60, drives: 11 })));
  const qbGames = teamGames.flatMap((t) => [0, 1, 2].map((k) => ({ id: t.id, team: t.team, qb: `00-00${Math.floor(rnd() * 99999)}`, name: `Q.Passer${k}`, b: [0, 1, 2].map(() => [Math.floor(rnd() * 40), +(rnd() * 20 - 10).toFixed(4)]) })));
  const starters = Array.from({ length: 32 }, (_, i) => ({ team: `T${i}`, qb: `00-00${i}`, name: 'Some Quarterback Jr.', espnId: String(4000000 + i), source: 'depth', status: null, replaced: null, at: '2026-12-01T00:00:00Z' }));
  const c0 = CFB_EXP.games[0];
  const cfbGames = Array.from({ length: 1750 }, (_, i) => ({ ...c0, id: String(401856000 + i), h: String(i % 266), a: String((i * 7) % 266), hp: i % 60, ap: i % 45 }));
  const eff = Array.from({ length: 950 }, (_, i) => ({ id: String(401856000 + i), ypp: [rnd() * 8, rnd() * 8], plays: [60 + (i % 30), 55 + (i % 30)], sr: rnd() - 0.5 }));
  const ri = { v: 1, nfl: { season: 2026, asOf: '2026-12-01T00:00:00Z', etag: '"x"', throughWeek: 22, games: nflGames, teamGames, qbGames, starters },
    cfb: { season: 2026, asOf: '2026-12-01T00:00:00Z', files: { etags: { schedules: 'a', teamBox: 'b', advGamelog: 'c', paperIndex: 'd' } }, games: cfbGames, eff, effMissing: 0 } };
  const gz = gzipSync(Buffer.from(JSON.stringify(ri))).length;
  assert.ok(gz < 160 * 1024, `ratingInputs ${Math.round(gz / 1024)} KB gzipped`);
  const snap = { ...buildSnapshot(researchInputs(), { now: RESEARCH_NOW }), ratingInputs: ri };
  const pack = packSnapshot(snap);
  assert.ok(pack.gzBytes < 1024 * 1024, `snapshot ${Math.round(pack.gzBytes / 1024)} KB gzipped`);
  t.diagnostic(`full season ratingInputs ${Math.round(JSON.stringify(ri).length / 1024)} KB raw, ${Math.round(gz / 1024)} KB gzipped; research snapshot with it ${Math.round(pack.gzBytes / 1024)} KB gzipped`);
});

// ---------------------------------------------------------------- fetch (ETag gated)

function fakeGitHub(files) {
  // files: { url: { etag, body: Buffer } | { status } }; HEAD and GET are counted per url
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${url}`);
    const x = files[url];
    if (!x) return new Response('', { status: 404 });
    if (x.status) return new Response('', { status: x.status });
    if (x.stall) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(init.signal.reason)));
    const headers = { etag: x.etag, 'last-modified': 'Tue, 13 Oct 2026 10:05:49 GMT' };
    return method === 'HEAD' ? new Response(null, { status: 200, headers }) : new Response(x.body, { status: 200, headers });
  };
  f.calls = calls;
  return f;
}
const ghFiles = () => ({
  [CFB_RATING_URLS.schedules(2026)]: { etag: '"s1"', body: CFB.schedules },
  [CFB_RATING_URLS.teamBox(2026)]: { etag: '"t1"', body: CFB.teamBox },
  [CFB_RATING_URLS.advGamelog(2026)]: { etag: '"a1"', body: CFB.advGamelog },
  [CFB_RATING_URLS.paperIndex(2026)]: { etag: '"x1"', body: CFB.paperIndex },
  [NFL_GAMES_URL]: { etag: 'W/"g1"', body: GAMES_CSV },
});
const NV = (pbp = PBP, etag = '"p1"') => ({ season: 2026, pbp, etags: { pbp: etag }, lastModified: { pbp: 'Tue, 13 Oct 2026 16:56:53 GMT' }, errors: [] });
const T0 = Date.parse('2026-10-13T20:00:00Z');
const snapDir = (dir) => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

test('fetchRatingInputs: cold download, warm cache, HEAD-only checks with stamps in the state dir, new ETag, reduction cached by pbp ETag', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-ri-'));
  try {
    const cacheDir = join(tmp, 'cache'), checkPath = join(tmp, 'state', 'ratinginputs-checks.json');
    const files = ghFiles();
    const opts = { cacheDir, checkPath, pauseMs: 0 };
    // cold: HEAD + GET for 5 files, pbp reduced
    const f1 = fakeGitHub(files);
    const cold = await fetchRatingInputs({ ...opts, fetchImpl: f1, now: T0, nflverse: Promise.resolve(NV()) });
    assert.deepEqual(cold.errors, []);
    assert.equal(cold.requests, 10);
    assert.equal(f1.calls.filter((c) => c.startsWith('HEAD')).length, 5);
    assert.equal(cold.nfl.games.rows.length, 7);
    assert.equal(JSON.stringify(cold.nfl.pbp.games), JSON.stringify(AGG));
    assert.equal(cold.nfl.pbp.builtAt, '2026-10-13T20:00:00Z');
    assert.deepEqual(CFB_FILE_KEYS.map((k) => cold.cfb.files[k].etag), ['"s1"', '"t1"', '"a1"', '"x1"']);
    const cache = snapDir(join(cacheDir, 'ratinginputs'));
    assert.deepEqual(Object.keys(cache).sort(), ['cfb-advGamelog-2026.json', 'cfb-paperIndex-2026.json', 'cfb-schedules-2026.json', 'cfb-teamBox-2026.json', 'nfl-games-2026.json', 'nfl-pbp-2026.json']);
    walkValues(JSON.parse(cache['nfl-games-2026.json']), (v) => assert.ok(!SENTINELS.has(v), `sentinel ${v} cached`));
    for (const text of Object.values(cache)) assert.doesNotMatch(text, /spread|moneyline|vegas|_odds|total_line|totalLine/i);
    // 10 minutes later: nothing sent; a pbp with the same ETag is not parsed again (this text would not parse)
    const f2 = fakeGitHub(files);
    const warm = await fetchRatingInputs({ ...opts, fetchImpl: f2, now: T0 + 10 * 60e3, nflverse: NV('not a play by play file', '"p1"') });
    assert.deepEqual(f2.calls, []);
    assert.deepEqual(warm.errors, []);
    assert.equal(JSON.stringify(warm.nfl.pbp.games), JSON.stringify(AGG));
    assert.ok(Object.values(warm.cfb.files).every((x) => x.cached) && warm.nfl.games.cached);
    // 4 hours later: one HEAD per file, same ETags, the cache folder is unchanged; stamps are in the state dir
    const f3 = fakeGitHub(files);
    const later = await fetchRatingInputs({ ...opts, fetchImpl: f3, now: T0 + 4 * 3600e3, nflverse: NV() });
    assert.equal(later.requests, 5);
    assert.ok(f3.calls.every((c) => c.startsWith('HEAD')));
    assert.deepEqual(snapDir(join(cacheDir, 'ratinginputs')), cache, 'daily cache unchanged by an ETag-only check');
    assert.equal(JSON.parse(readFileSync(checkPath, 'utf8'))['nfl-games'], '2026-10-14T00:00:00Z');
    // games.csv changes 31 minutes after that: only it is checked (the CFB files were checked under 3 hours ago)
    const files2 = { ...files, [NFL_GAMES_URL]: { etag: 'W/"g2"', body: GAMES_CSV } };
    const f4 = fakeGitHub(files2);
    const changed = await fetchRatingInputs({ ...opts, fetchImpl: f4, now: T0 + 4 * 3600e3 + 31 * 60e3, nflverse: NV() });
    assert.deepEqual(f4.calls, [`HEAD ${NFL_GAMES_URL}`, `GET ${NFL_GAMES_URL}`]);
    assert.equal(changed.nfl.games.etag, 'W/"g2"');
    assert.equal(changed.nfl.games.cached, false);
    // a new pbp ETag is reduced again; nflverse not fetched at all: the cached reduction, with a warning
    const re = await fetchRatingInputs({ ...opts, fetchImpl: fakeGitHub(files2), now: T0 + 5 * 3600e3, nflverse: NV(PBP, '"p2"') });
    assert.equal(re.nfl.pbp.etag, '"p2"');
    assert.equal(re.nfl.pbp.builtAt, '2026-10-14T01:00:00Z');
    const none = await fetchRatingInputs({ ...opts, fetchImpl: fakeGitHub(files2), now: T0 + 5 * 3600e3, nflverse: null });
    assert.deepEqual(none.errors, []);
    assert.equal(none.nfl.pbp.etag, '"p2"');
    assert.match(none.warnings.join(' | '), /no play by play this run \(nflverse not fetched\); using the reduction of pbp "p2"/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('fetchRatingInputs: a missing file waits 6 hours, a failed HEAD keeps the cached copy, nothing at all is an error', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-ri-'));
  try {
    const cacheDir = join(tmp, 'cache'), checkPath = join(tmp, 'state', 'checks.json');
    const files = ghFiles();
    delete files[CFB_RATING_URLS.paperIndex(2026)];
    const a = await fetchRatingInputs({ cacheDir, checkPath, pauseMs: 0, fetchImpl: fakeGitHub(files), now: T0, nflverse: null });
    assert.equal(a.cfb.files.paperIndex, null);
    assert.ok(a.errors.some((e) => /^cfb-paperIndex: .*HTTP 404$/.test(e)), a.errors.join(' | '));
    assert.ok(a.errors.some((e) => /^nfl-pbp: no play by play \(nflverse not fetched\) and no cached reduction$/.test(e)));
    const miss = JSON.parse(readFileSync(checkPath, 'utf8')).misses['cfb-paperIndex'];
    assert.equal(miss.retryAfter, new Date(T0 + RATING_MISS_BACKOFF.notFoundMs).toISOString().replace('.000', ''));
    // an hour later: no request for it, the error stays
    const f = fakeGitHub(ghFiles());
    const b = await fetchRatingInputs({ cacheDir, checkPath, pauseMs: 0, fetchImpl: f, now: T0 + 3600e3, nflverse: null });
    assert.ok(!f.calls.some((c) => c.includes('paper_index')));
    assert.ok(b.errors.some((e) => /^cfb-paperIndex: HTTP 404 at .*; next try after /.test(e)));
    // HEAD 500 with a cached copy: the copy, with a warning
    const bad = { ...ghFiles(), [CFB_RATING_URLS.schedules(2026)]: { status: 500 } };
    const c = await fetchRatingInputs({ cacheDir, checkPath, pauseMs: 0, fetchImpl: fakeGitHub(bad), now: T0 + 4 * 3600e3, nflverse: null, minCheckMs: 0 });
    assert.ok(c.cfb.files.schedules.cached);
    assert.match(c.warnings.join(' | '), /cfb-schedules: HEAD failed \(500\); using the copy fetched 2026-10-13T20:00:00Z/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('fetchRatingInputs: a stalled host costs only its own time budget and records no miss', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-ri-'));
  try {
    const checkPath = join(tmp, 'checks.json');
    const files = Object.fromEntries(Object.keys(ghFiles()).map((u) => [u, { stall: true }]));
    const budget = budgetSignal(150, 'ratinginputs');
    const r = await fetchRatingInputs({ cacheDir: join(tmp, 'cache'), checkPath, pauseMs: 0, fetchImpl: withDeadline(fakeGitHub(files), budget.signal), now: T0, nflverse: null });
    budget.clear();
    assert.ok(r.errors.filter((e) => /ratinginputs time budget \(150 ms\) spent/.test(e)).length >= 1, r.errors.join(' | '));
    assert.equal(existsSync(checkPath) ? Object.keys(JSON.parse(readFileSync(checkPath, 'utf8')).misses || {}).length : 0, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('check intervals: games.csv every 30 minutes, the college files every 3 hours', () => {
  assert.deepEqual(RATING_CHECK_MS, { nflGames: 30 * 60e3, cfb: 3 * 3600e3 });
});

// ---------------------------------------------------------------- full parity on the model's own files (local only)

const MODEL_DIR = process.env.RATINGINPUTS_MODEL_DIR || '';
const PARITY_DIR = process.env.RATINGINPUTS_PARITY_DIR || '';
test('parity on the full 2026 files: reducer = reference agg_2026.json, games = reference games.json, rows = the site parity rows', { skip: !MODEL_DIR && 'set RATINGINPUTS_MODEL_DIR (and RATINGINPUTS_PARITY_DIR) to run' }, (t) => {
  const pick = (...c) => c.map((p) => join(MODEL_DIR, p)).find(existsSync);
  const pbpFile = pick('cache/nflverse/play_by_play_2026.csv.gz', 'cache/collector/nflverse/pbp_2026.csv.gz');
  const t0 = performance.now();
  const r = reducePbp(readFileSync(pbpFile));
  const ms = performance.now() - t0;
  const agg = readFileSync(join(MODEL_DIR, 'nfl/data/agg_2026.json'), 'utf8');
  assert.equal(JSON.stringify({ season: 2026, rows: r.rows, kept: r.kept, maxWeek: r.maxWeek, skipped: r.skipped, games: r.games }), agg, 'agg_2026.json byte for byte');
  const games = parseNflGames(readFileSync(join(MODEL_DIR, 'cache/nflverse/games.csv')), { season: 2026 }).games;
  const mg = JSON.parse(readFileSync(join(MODEL_DIR, 'nfl/data/games.json'), 'utf8')).filter((g) => g.season === 2026)
    .map((g) => { const o = { ...g }; for (const k of ['spread', 'totalLine', 'homeMl', 'awayMl']) delete o[k]; return o; });
  assert.equal(JSON.stringify(games), JSON.stringify(mg), 'games.json 2026 rows without the line fields');
  t.diagnostic(`pbp ${r.rows} rows, ${r.games.length} games, reduced in ${Math.round(ms)} ms; games ${games.length}`);
  const C = join(MODEL_DIR, 'cfb/cache/sdv');
  const at = '2026-10-13T19:55:11Z';
  const file = (data) => ({ data, etag: null, fetchedAt: at });
  const raw = {
    fetchedAt: at, requests: 0, errors: [], warnings: [],
    nfl: { season: 2026, games: { rows: games, fetchedAt: at }, pbp: { etag: null, builtAt: at, maxWeek: r.maxWeek, games: r.games } },
    cfb: { season: 2026, files: {
      schedules: file(reduceCfbSchedule(readFileSync(join(C, 'schedules_2026.csv.gz')), { season: 2026 })), teamBox: file(reduceCfbTeamBox(readFileSync(join(C, 'teamBox_2026.csv')))),
      advGamelog: file(reduceCfbAdv(readFileSync(join(C, 'advGamelog_2026.csv')))), paperIndex: file(reduceCfbPaper(readFileSync(join(C, 'paperIndex_2026.csv')))),
    } },
  };
  const { ratingInputs: ri } = buildRatingInputs(raw, {});
  assert.deepEqual(lineFieldPaths(ri), []);
  const kb = (o) => `${Math.round(JSON.stringify(o).length / 1024)} KB raw, ${Math.round(gzipSync(Buffer.from(JSON.stringify(o))).length / 1024)} KB gzip`;
  t.diagnostic(`ratingInputs ${kb(ri)} (nfl ${kb(ri.nfl)}, cfb ${kb(ri.cfb)})`);
  if (!PARITY_DIR) return;
  const fn = JSON.parse(readFileSync(join(PARITY_DIR, 'nfl-ratinginputs-2026w6.json'), 'utf8'));
  const fc = JSON.parse(readFileSync(join(PARITY_DIR, 'cfb-ratinginputs-2026-10-13.json'), 'utf8'));
  for (const k of ['games', 'teamGames', 'qbGames']) assert.equal(JSON.stringify(ri.nfl[k]), JSON.stringify(fn[k]), `nfl.${k}`);
  assert.equal(ri.nfl.throughWeek, fn.throughWeek);
  for (const k of ['games', 'eff', 'effMissing']) assert.equal(JSON.stringify(ri.cfb[k]), JSON.stringify(fc[k]), `cfb.${k}`);
  t.diagnostic(`engine parity fixtures: nfl ${fn.games.length} games, ${fn.teamGames.length} team games, ${fn.qbGames.length} QB games; cfb ${fc.games.length} games, ${fc.eff.length} eff rows: equal`);
});

// ---------------------------------------------------------------- CLI (saved captures in place of the APIs)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = pathToFileURL(join(ROOT, 'test', 'fake-upstream.mjs')).href;
function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', PRELOAD, join(ROOT, 'collect.mjs'), '--kalshi-gap-ms', '0', ...args], { cwd: ROOT, env: { ...process.env, FAKE_UPSTREAM: 'ok' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('collect.mjs: rating inputs are on by default and fail open with GitHub unreachable; --skip ratinginputs leaves no trace', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-cli-ri-'));
  try {
    const dirs = (k) => ['--cache-dir', join(tmp, k, 'cache'), '--state-dir', join(tmp, k, 'state'), '--closes-dir', join(tmp, k, 'closes'), '--now', RESEARCH_NOW];
    const a = await run(['--out', join(tmp, 'a.json'), ...dirs('a'), '--skip', 'props,teamTotals,nflverse,cfb,injuries']);
    const b = await run(['--out', join(tmp, 'b.json'), ...dirs('b'), '--skip', 'props,teamTotals,nflverse,cfb,injuries,ratinginputs']);
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    const A = JSON.parse(readFileSync(join(tmp, 'a.json'), 'utf8'));
    const B = JSON.parse(readFileSync(join(tmp, 'b.json'), 'utf8'));
    assert.deepEqual(validateSnapshot(A), []);
    assert.equal(A.ratingInputs, undefined, 'nothing could be fetched, so no field');
    assert.equal(A.sources.ratingInputs.ok, false);
    assert.equal(A.sources.ratingInputs.requests, 5, 'one HEAD per file, each answered 404');
    assert.ok(A.sources.ratingInputs.errors.some((e) => /cfb-schedules: .*HTTP 404/.test(e)), A.sources.ratingInputs.errors.join(' | '));
    assert.ok(A.sources.ratingInputs.errors.some((e) => /nfl-pbp: no play by play \(nflverse not fetched\)/.test(e)));
    assert.match(a.out, /ratingInputs: none; 5 requests/);
    assert.match(a.out, /source ratingInputs: NOT OK/);
    const misses = JSON.parse(readFileSync(join(tmp, 'a', 'state', 'ratinginputs-checks.json'), 'utf8')).misses;
    assert.deepEqual(Object.keys(misses).sort(), ['cfb-advGamelog', 'cfb-paperIndex', 'cfb-schedules', 'cfb-teamBox', 'nfl-games']);
    assert.equal(B.sources.ratingInputs, undefined);
    assert.doesNotMatch(b.out, /ratingInputs/);
    // everything else is the same snapshot
    const norm = (s) => s.games.map((g) => ({ ...g, odds: g.odds && { ...g.odds, fetchedAt: null } }));
    assert.equal(JSON.stringify(norm(A)), JSON.stringify(norm(B)));
    assert.deepEqual(Object.keys(A.sources).filter((k) => k !== 'ratingInputs'), Object.keys(B.sources));
    for (const k of ['fees', 'props', 'defense', 'players', 'comboEligible', 'unmatched']) assert.deepEqual(A[k], B[k], k);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
