// lib/nflverse.mjs: defense ratings + front/secondary, player contexts, id bridge, ETag-gated fetch. Offline.
// Fixtures are the research2 nflverse files (pbp + stats 2026-10-11 21:04Z build, roster 14:00Z, PFR def 11:02Z)
// trimmed to the used columns; the expected numbers are the research and critic outputs on the same files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FIX } from './helpers.mjs';
import { parseCsv, colIndex } from '../lib/csv.mjs';
import { withDeadline, BudgetError } from '../lib/http.mjs';
import {
  buildNflverse, fetchNflverseInputs, nflverseEtag, bridgeToJSON, bridgeFromJSON, nflSeason, NFLVERSE_ASSETS, STAT_FN, SUPPORTED_STATS, propPlayersFromProps,
} from '../lib/nflverse.mjs';

const A = join(FIX, 'angles');
const buf = (...p) => readFileSync(join(A, ...p));
const RES = JSON.parse(gunzipSync(buf('injuries-research-20261011.json.gz')).toString('utf8'));
const RAW = {
  season: 2026,
  pbp: buf('nflverse', 'pbp_2026_trim.csv.gz'),
  statsPlayerWeek: buf('nflverse', 'stats_player_week_2026_trim.csv.gz'),
  rosterWeekly: buf('nflverse', 'roster_weekly_2026_trim.csv.gz'),
  pfrDef: buf('nflverse', 'advstats_week_def_2026.csv.gz'),
  etags: { pbp: '"p1"', statsPlayerWeek: '"s1"', rosterWeekly: '"r1"', pfrDef: '"d1"' },
  lastModified: { pbp: 'Sun, 11 Oct 2026 21:04:08 GMT' },
};
const game = (label) => RES.games.find((g) => `${g.away.abbr}@${g.home.abbr}` === label);
const HENRY = '3043078';
const base = buildNflverse(RAW, { games: RES.games, depth: RES.depth, propPlayers: [{ espnId: HENRY, team: 'BAL', stats: ['rushYds', 'rushAtt', 'ffpts', 'longRush'] }] });
const D = base.defense.nfl;
const order = (f, desc = false) => Object.entries(D).filter(([, v]) => f(v) != null).sort((a, b) => (desc ? f(b[1]) - f(a[1]) : f(a[1]) - f(b[1]))).map(([t]) => t);

test('defense: 32 teams keyed by ESPN abbreviation (LAR, WSH, JAX), meta from the pbp', () => {
  assert.equal(base.ok, true, base.errors.join('; '));
  assert.equal(Object.keys(D).length, 32);
  for (const t of ['LAR', 'WSH', 'JAX', 'ATL', 'BAL', 'BUF']) assert.ok(D[t], t);
  for (const t of ['LA', 'WAS', 'JAC']) assert.equal(D[t], undefined, `${t} must be converted`);
  assert.deepEqual(base.meta, { season: 2026, throughWeek: 5, etag: nflverseEtag(RAW), asOf: '2026-10-11T21:04:08Z' });
  for (const t of ['ATL', 'BAL', 'BUF', 'LAR', 'SEA', 'SF']) assert.equal(D[t].games, 4, `${t}: week 5 game not in the 21:04Z build`);
  assert.equal(D.DAL.games, 5);
  for (const k of ['rush', 'pass', 'overall', 'vsQB', 'vsRB', 'vsWR', 'vsTE']) {
    assert.deepEqual(Object.values(D).map((v) => v.ranks[k]).sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i + 1), `ranks.${k} is 1..32`);
  }
});

test('defense numbers match the research (run D and pass D by EPA, designed runs only)', () => {
  assert.deepEqual(order((v) => v.rushEpa).slice(0, 5), ['ATL', 'ARI', 'SEA', 'JAX', 'MIN']);
  assert.deepEqual(order((v) => v.rushEpa, true).slice(0, 5), ['DEN', 'IND', 'NO', 'NE', 'DET']);
  assert.deepEqual(order((v) => v.passEpa).slice(0, 5), ['MIN', 'LAR', 'SEA', 'GB', 'CLE']);
  assert.deepEqual(order((v) => v.passEpa, true).slice(0, 5), ['DAL', 'ARI', 'MIA', 'DET', 'TEN']);
  const atl = D.ATL;
  assert.equal(atl.rushEpa, -0.25);
  assert.equal(atl.rushYpc, 2.94);
  assert.equal(atl.ranks.rush, 1);
  assert.equal(D.MIN.passEpa, -0.206);
  assert.equal(D.MIN.sackRate, 0.095);
  assert.equal(D.DAL.passEpa, 0.398);
  assert.deepEqual(atl.fpAllowed, { QB: 17.7, RB: 16.9, WR: 38.4, TE: 15.9 });
  assert.equal(atl.ranks.vsWR, 28, 'ATL stops the run but WRs feast');
  assert.deepEqual(Object.keys(atl).sort(), ['fpAllowed', 'front', 'games', 'meta', 'passEpa', 'passYpa', 'plays', 'pointsPg', 'ranks', 'rushEpa', 'rushYpc', 'sackRate', 'secondary']);
});

test('front and secondary (critic glue): stuff, explosive, pressure ranks and named corners', () => {
  assert.deepEqual(order((v) => v.front.stuffRate, true).slice(0, 5), ['CIN', 'BUF', 'KC', 'SEA', 'GB']);
  assert.equal(D.CIN.front.stuffRate, 0.267);
  // pressure denominator counts only dropbacks from games the PFR file covers (weeks 1 to 4 + TB@DAL)
  assert.deepEqual(order((v) => v.front.pressureRate, true).slice(0, 5), ['MIN', 'LV', 'CHI', 'BUF', 'SEA']);
  assert.equal(D.MIN.front.pressureRate, 0.418);
  // Henry vs ATL: tough front (EPA/rush #1, stuff 21.5% #6, 10+ yd runs 3.1% #2)
  assert.deepEqual(D.ATL.front, { epaRush: -0.25, stuffRate: 0.215, explosiveRunRate: 0.031, pressureRate: 0.273, ranks: { epaRush: 1, stuff: 6, explosive: 2, pressure: 10 } });
  assert.deepEqual(D.BUF.secondary.ranks, { epaDropback: 27, explosive: 28 });
  assert.deepEqual(D.LAR.secondary.ranks, { epaDropback: 2, explosive: 1 });
  const cb = (t) => Object.fromEntries(D[t].secondary.corners.map((c) => [c.slot, [c.name, c.ydsPerTarget, c.targets, c.tag]]));
  assert.deepEqual(cb('ATL').RCB, ['Mike Hughes', 9.68, 25, 'weak']);
  assert.deepEqual(cb('BAL').LCB, ['Nate Wiggins', 4.27, 22, 'lockdown']);
  assert.deepEqual(cb('BAL').RCB, ['Marlon Humphrey', 9.35, 23, 'weak']);
  assert.deepEqual(cb('LAR').RCB, ['Trent McDuffie', 2, 21, 'lockdown']);
  assert.deepEqual(cb('LAR').LCB, ['Jaylen Watson', 10.08, 13, 'weak']);
  for (const v of Object.values(D)) for (const c of v.secondary.corners) assert.ok(['LCB', 'RCB', 'NB'].includes(c.slot) && typeof c.espnId === 'string');
});

test('players: prop players and the QB/RB1/WR1-3/TE1 of teams in upcoming games, compact', () => {
  const p = base.players[HENRY];
  assert.deepEqual(Object.keys(p.stats), ['rushYds', 'rushAtt', 'ffpts'], 'longRush has no weekly source and is skipped');
  assert.deepEqual({ name: p.name, team: p.team, pos: p.pos, games: p.games }, { name: 'Derrick Henry', team: 'BAL', pos: 'RB', games: 4 });
  assert.deepEqual(p.stats.rushYds, { avg: 93.5, last3: 76.7, median: 81, log: [144, 68, 89, 73] });
  assert.equal(p.share.carries, 0.707);
  assert.equal(p.splits, undefined, 'no teammate out in this input');
  const bijan = Object.values(base.players).find((x) => x.name === 'Bijan Robinson');
  assert.ok(bijan && bijan.stats.rushYds && bijan.stats.recYds && bijan.stats.rec, 'RB1 default stats');
  const qbs = Object.values(base.players).filter((x) => x.pos === 'QB');
  assert.ok(qbs.length >= 25, `${qbs.length} QBs`);
  for (const q of qbs) assert.deepEqual(Object.keys(q.stats), ['passYds', 'rushYds']);
  for (const x of Object.values(base.players)) for (const s of Object.values(x.stats)) assert.ok(s.log.length <= 8);
  const teams = new Set(Object.values(base.players).map((x) => x.team));
  assert.ok(teams.has('LAR') && teams.has('WSH') && !teams.has('LA'));
  assert.ok(JSON.stringify(base.players).length < 120000, 'compact');
});

test('ffpts uses Kalshi FFPTS scoring (Sleeper full PPR, INT -1), not nflverse fantasy_points_ppr (INT -2)', () => {
  const t = parseCsv(buf('nflverse', 'stats_player_week_2026_trim.csv.gz'));
  const c = colIndex(t.head, t.head);
  let qbChecked = 0, rbChecked = 0;
  for (const r of t.rows) {
    const o = {};
    for (const k of t.head) o[k] = Number.isFinite(+r[c[k]]) && r[c[k]] !== '' ? +r[c[k]] : 0;
    const ppr = o.fantasy_points_ppr;
    const mine = STAT_FN.ffpts(o);
    if (r[c.position] === 'QB' && o.attempts > 10) { assert.ok(Math.abs(mine - (ppr + o.passing_interceptions)) < 0.011, `${r[c.player_display_name]} wk${r[c.week]}`); qbChecked++; }
    if (r[c.position] === 'RB' && o.carries > 5) { assert.ok(Math.abs(mine - ppr) < 0.011, `${r[c.player_display_name]} wk${r[c.week]}`); rbChecked++; }
  }
  assert.ok(qbChecked > 100 && rbChecked > 100);
  assert.ok(SUPPORTED_STATS.includes('rushRecYds') && SUPPORTED_STATS.includes('anyTd') && !SUPPORTED_STATS.includes('longRec'));
});

test('splits: only for a teammate Out or Doubtful (confirmed or likely) for this game', () => {
  const carphi = game('CAR@PHI');
  const phi = RES.depth[carphi.home.espnId];
  const saquon = phi.offense.rb[0], backup = phi.offense.rb[1];
  assert.equal(saquon.name, 'Saquon Barkley');
  const inj = (grade) => ({ [carphi.id]: { injuries: { home: [{ espnId: saquon.id, name: saquon.name, role: 'RB1', status: 'Out', grade }], away: [] }, angles: [] } });
  const props = [{ espnId: backup.id, team: 'PHI', stats: ['rushYds'] }];
  const out = buildNflverse(RAW, { games: RES.games, depth: RES.depth, propPlayers: props, injuriesByGame: inj('confirmed') });
  const s = out.players[backup.id].splits;
  assert.equal(s.length, 1);
  assert.equal(s[0].without, 'Saquon Barkley');
  assert.equal(s[0].withoutId, saquon.id);
  assert.ok(s[0].games >= 1 && s[0].withGames >= 1, JSON.stringify(s[0]));
  assert.ok(Number.isFinite(s[0].avg.rushYds) && Number.isFinite(s[0].withAvg.rushYds));
  assert.equal(out.players[saquon.id].splits, undefined, 'never split a player against himself');
  const carry = buildNflverse(RAW, { games: RES.games, depth: RES.depth, propPlayers: props, injuriesByGame: inj('carryover') });
  assert.equal(carry.players[backup.id].splits, undefined, 'carryover is not "out for this game"');
});

test('corners: a starting CB ruled out for the next game is flagged and his backup listed as the fill-in', () => {
  const balatl = game('BAL@ATL');
  const atl = RES.depth[balatl.home.espnId];
  const hughes = atl.defense.rcb[0];
  const out = buildNflverse(RAW, { games: RES.games, depth: RES.depth, injuriesByGame: { [balatl.id]: { home: [{ espnId: hughes.id, name: hughes.name, role: 'CB', status: 'Out', grade: 'confirmed' }], away: [] } } });
  const rcb = out.defense.nfl.ATL.secondary.corners.filter((c) => c.slot === 'RCB');
  assert.deepEqual(rcb.map((c) => [c.name, !!c.out, !!c.fillIn]), [['Mike Hughes', true, false], [atl.defense.rcb[1].name, false, true]]);
});

test('without depth charts: corners by targets (slot null) and starters from volume leaders', () => {
  const out = buildNflverse(RAW, { games: RES.games });
  assert.equal(out.ok, true);
  const c = out.defense.nfl.ATL.secondary.corners;
  assert.ok(c.length >= 2 && c.every((x) => x.slot === null));
  assert.ok(c[0].targets >= c[1].targets);
  const names = Object.values(out.players).map((p) => p.name);
  for (const n of ['Derrick Henry', 'Bijan Robinson', 'Drake London']) assert.ok(names.includes(n), n);
});

test('propPlayersFromProps: PropLadders -> one entry per athlete with its ladder stats', () => {
  const props = [
    { gameId: 'nfl-1', stat: 'rushYds', player: { espnId: HENRY, name: 'Derrick Henry', team: 'BAL' } },
    { gameId: 'nfl-1', stat: 'rushAtt', player: { espnId: HENRY, name: 'Derrick Henry', team: 'BAL' } },
    { gameId: 'nfl-1', stat: 'rushYds', player: { espnId: HENRY, name: 'Derrick Henry', team: 'BAL' } },
    { gameId: 'nfl-1', stat: 'recYds', player: { espnId: null, name: 'Unknown', team: 'BAL' } },
  ];
  const pp = propPlayersFromProps(props);
  assert.deepEqual(pp, [{ espnId: HENRY, name: 'Derrick Henry', team: 'BAL', stats: ['rushYds', 'rushAtt'] }]);
  const out = buildNflverse(RAW, { games: [], propPlayers: pp });
  assert.deepEqual(Object.keys(out.players), [HENRY]);
  assert.deepEqual(Object.keys(out.players[HENRY].stats), ['rushYds', 'rushAtt']);
});

test('id bridge: buildIdBridge Maps survive bridgeToJSON / bridgeFromJSON', () => {
  const j = JSON.parse(JSON.stringify(bridgeToJSON(base.bridge)));
  const back = bridgeFromJSON(j);
  assert.equal(back.byGsis.size, base.bridge.byGsis.size);
  assert.equal(back.byEspn.size, base.bridge.byEspn.size);
  assert.equal(back.byPfr.size, base.bridge.byPfr.size);
  assert.deepEqual(back.byEspn.get(HENRY), base.bridge.byEspn.get(HENRY));
  assert.equal(back.byEspn.get(HENRY).jersey, '22');
  assert.equal(back.byPfr.get('HenrDe00').gsis, '00-0032764');
});

test('bad or missing inputs never throw', () => {
  const none = buildNflverse({});
  assert.equal(none.ok, false);
  assert.deepEqual(none.errors, ['pbp: missing', 'statsPlayerWeek: missing', 'rosterWeekly: missing', 'pfrDef: missing']);
  assert.deepEqual(none.defense, { nfl: {} });
  const broken = buildNflverse({ ...RAW, pbp: 'a,b\n1,2\n' }, { games: RES.games });
  assert.ok(broken.errors.some((e) => /pbp: missing columns/.test(e)));
  assert.deepEqual(broken.defense.nfl, {});
  assert.ok(Object.keys(broken.players).length > 0, 'players still built');
  const unknown = buildNflverse(RAW, { games: [], propPlayers: [{ espnId: '999999999', team: 'BAL', stats: ['rushYds'] }] });
  assert.equal(unknown.ok, true, 'an unknown prop player is a warning');
  assert.equal(unknown.warnings.length, 1);
});

test('deterministic: same inputs give byte-identical defense and players', () => {
  const opts = { games: RES.games, depth: RES.depth, propPlayers: [{ espnId: HENRY, team: 'BAL', stats: ['rushYds'] }] };
  const a = buildNflverse(RAW, opts), b = buildNflverse({ ...RAW }, { ...opts, games: [...RES.games].reverse() });
  assert.equal(JSON.stringify({ d: a.defense, p: a.players, m: a.meta }), JSON.stringify({ d: b.defense, p: b.players, m: b.meta }));
});

test('nflSeason and nflverseEtag', () => {
  assert.equal(nflSeason('2026-10-11T00:00:00Z'), 2026);
  assert.equal(nflSeason('2027-01-20T00:00:00Z'), 2026);
  assert.equal(nflSeason('2027-03-05T00:00:00Z'), 2027);
  assert.equal(nflverseEtag(RAW), nflverseEtag({ etags: { ...RAW.etags } }));
  assert.notEqual(nflverseEtag(RAW), nflverseEtag({ etags: { ...RAW.etags, pbp: '"p2"' } }));
  assert.match(nflverseEtag(RAW), /^[0-9a-f]{16}$/);
});

// ---------------------------------------------------------------- fetch (mock GitHub release downloads)

function mockReleases() {
  const files = { pbp: RAW.pbp, statsPlayerWeek: RAW.statsPlayerWeek, rosterWeekly: RAW.rosterWeekly, pfrDef: RAW.pfrDef };
  const state = { etag: { pbp: '"p1"', statsPlayerWeek: '"s1"', rosterWeekly: '"r1"', pfrDef: '"d1"' }, headStatus: 200, notGzip: null };
  const byUrl = Object.fromEntries(Object.keys(files).map((k) => [NFLVERSE_ASSETS[k](2026), k]));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = byUrl[url];
    calls.push(`${init.method || 'GET'} ${key}`);
    if (!key) return new Response('nope', { status: 404 });
    assert.equal(init.redirect, 'follow');
    const headers = { etag: state.etag[key], 'last-modified': 'Mon, 12 Oct 2026 01:14:18 GMT' };
    if (init.method === 'HEAD') return new Response(null, { status: state.headStatus, headers });
    return new Response(state.notGzip === key ? Buffer.from('<html>oops</html>') : files[key], { status: 200, headers });
  };
  return { fetchImpl, calls, state };
}

test('fetchNflverseInputs: HEAD each asset, GET only on a new ETag, gzip cached on disk', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gp-nv-'));
  const t0 = Date.parse('2026-10-12T01:30:00Z');
  const m = mockReleases();
  const a = await fetchNflverseInputs({ fetchImpl: m.fetchImpl, now: t0, cacheDir, pauseMs: 0 });
  assert.equal(a.requests, 8);
  assert.deepEqual(a.errors, []);
  assert.equal(a.season, 2026);
  assert.deepEqual(a.cached, { pbp: false, statsPlayerWeek: false, rosterWeekly: false, pfrDef: false });
  assert.ok(a.pbp.startsWith('game_id,season_type'));
  assert.equal(a.etags.pbp, '"p1"');

  const b = await fetchNflverseInputs({ fetchImpl: m.fetchImpl, now: t0 + 60e3, cacheDir, pauseMs: 0, minCheckMs: 0 });
  assert.equal(b.requests, 4, 'HEAD only');
  assert.deepEqual(Object.values(b.cached), [true, true, true, true]);
  assert.equal(b.pbp, a.pbp);
  assert.equal(nflverseEtag(b), nflverseEtag(a));

  m.state.etag.pbp = '"p2"';
  const c = await fetchNflverseInputs({ fetchImpl: m.fetchImpl, now: t0 + 2 * 60e3, cacheDir, pauseMs: 0, minCheckMs: 0 });
  assert.equal(c.requests, 5, 'pbp changed: 4 HEAD + 1 GET');
  assert.equal(c.cached.pbp, false);
  assert.notEqual(nflverseEtag(c), nflverseEtag(a));

  const d = await fetchNflverseInputs({ fetchImpl: m.fetchImpl, now: t0 + 10 * 60e3, cacheDir, pauseMs: 0 });
  assert.equal(d.requests, 0, 'checked less than 30 minutes ago: no HEAD at all');
  assert.equal(d.etags.pbp, '"p2"');

  m.state.headStatus = 503;
  const e = await fetchNflverseInputs({ fetchImpl: m.fetchImpl, now: t0 + 60 * 60e3, cacheDir, pauseMs: 0 });
  assert.equal(e.requests, 4);
  assert.deepEqual(e.errors, []);
  assert.equal(e.warnings.length, 4);
  assert.ok(e.pbp && e.cached.pbp);
});

test('fetchNflverseInputs: a non-gzip download is an error for that asset only (no cache dir)', async () => {
  const m = mockReleases();
  m.state.notGzip = 'pfrDef';
  const a = await fetchNflverseInputs({ fetchImpl: m.fetchImpl, now: Date.parse('2026-10-12T01:30:00Z'), pauseMs: 0 });
  assert.equal(a.pfrDef, null);
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0], /pfrDef: not gzip/);
  assert.ok(a.pbp && a.statsPlayerWeek && a.rosterWeekly);
  const built = buildNflverse(a, { games: RES.games });
  assert.ok(built.errors.includes('pfrDef: missing'));
  assert.equal(Object.keys(built.defense.nfl).length, 32, 'defense still built without PFR (no pressure)');
  assert.equal(built.defense.nfl.ATL.front.pressureRate, null);
  assert.equal(built.defense.nfl.ATL.front.ranks.pressure, null);
});

// Negative cache: a missing asset with nothing cached (the season rollover on March 1 until the new season's files
// appear) is asked for once per back-off, not on every 5 minute run.
function releasesWithMissing({ missing = new Set(), missStatus = 404 } = {}) {
  const m = mockReleases();
  const calls = [];
  const byUrl = Object.fromEntries(Object.keys(NFLVERSE_ASSETS).map((k) => [NFLVERSE_ASSETS[k](2026), k]));
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${byUrl[url]}`);
    if (missing.has(byUrl[url])) return new Response('Not Found', { status: missStatus });
    return m.fetchImpl(url, init);
  };
  return { fetchImpl, calls, missing };
}

test('fetchNflverseInputs: a missing asset (404, nothing cached) is checked once per 6 hours with a HEAD only', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gp-nv-'));
  const checkPath = join(await mkdtemp(join(tmpdir(), 'gp-nvs-')), 'nflverse-checks.json');
  const t0 = Date.parse('2026-10-12T01:30:00Z');
  const up = releasesWithMissing({ missing: new Set(['pbp', 'statsPlayerWeek', 'rosterWeekly', 'pfrDef']) });
  const run = (min) => fetchNflverseInputs({ fetchImpl: up.fetchImpl, now: t0 + min * 60e3, cacheDir, checkPath, pauseMs: 0 });

  const a = await run(0);
  assert.deepEqual(up.calls, ['HEAD pbp', 'HEAD statsPlayerWeek', 'HEAD rosterWeekly', 'HEAD pfrDef'], 'a HEAD 404 is final: no GET');
  assert.equal(a.requests, 4);
  assert.equal(a.errors.length, 4);
  assert.match(a.errors[0], /^pbp: .*play_by_play_2026\.csv\.gz: HTTP 404$/);
  const misses = JSON.parse(readFileSync(checkPath, 'utf8')).misses;
  assert.deepEqual(misses.pbp, { url: NFLVERSE_ASSETS.pbp(2026), at: '2026-10-12T01:30:00Z', status: 404, retryAfter: '2026-10-12T07:30:00Z' });

  for (const min of [5, 10, 355]) {
    up.calls.length = 0;
    const r = await run(min);
    assert.deepEqual(up.calls, [], `+${min} min: no request`);
    assert.equal(r.requests, 0);
    assert.deepEqual(r.errors.map((e) => e.split(':')[0]), ['pbp', 'statsPlayerWeek', 'rosterWeekly', 'pfrDef'], 'still reported as errors (ok=false)');
    assert.match(r.errors[0], /^pbp: HTTP 404 at 2026-10-12T01:30:00Z; next try after 2026-10-12T07:30:00Z$/);
  }

  // after the back-off: pbp has been published, the other three are still missing
  up.missing.delete('pbp');
  up.calls.length = 0;
  const b = await run(361);
  assert.deepEqual(up.calls, ['HEAD pbp', 'GET pbp', 'HEAD statsPlayerWeek', 'HEAD rosterWeekly', 'HEAD pfrDef']);
  assert.ok(b.pbp && b.cached.pbp === false);
  assert.equal(b.errors.length, 3);
  const misses2 = JSON.parse(readFileSync(checkPath, 'utf8')).misses;
  assert.deepEqual(Object.keys(misses2).sort(), ['pfrDef', 'rosterWeekly', 'statsPlayerWeek'], 'the published asset is no longer a miss');
  assert.equal(misses2.rosterWeekly.retryAfter, '2026-10-12T13:31:00Z');
});

test('fetchNflverseInputs: other failures back off 30 minutes; a spent time budget is not a miss; a cached copy is never a miss', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gp-nv-'));
  const checkPath = join(await mkdtemp(join(tmpdir(), 'gp-nvs-')), 'nflverse-checks.json');
  const t0 = Date.parse('2026-10-12T01:30:00Z');
  const up = releasesWithMissing({ missing: new Set(['pfrDef']), missStatus: 503 });
  const run = (min, fetchImpl = up.fetchImpl) => fetchNflverseInputs({ fetchImpl, now: t0 + min * 60e3, cacheDir, checkPath, pauseMs: 0 });
  const a = await run(0);
  assert.equal(a.requests, 3 * 2 + 2, 'pfrDef: HEAD 503, then the GET is tried (503)');
  assert.deepEqual(a.errors, [`pfrDef: ${new URL(NFLVERSE_ASSETS.pfrDef(2026)).pathname}: HTTP 503`]);
  up.calls.length = 0;
  await run(10);
  assert.deepEqual(up.calls, [], 'cached assets were checked < 30 min ago; pfrDef waits out its 30 minute back-off');
  up.missing.clear();
  up.calls.length = 0;
  const c = await run(31);
  assert.deepEqual(up.calls.filter((x) => x.endsWith('pfrDef')), ['HEAD pfrDef', 'GET pfrDef']);
  assert.ok(c.pfrDef);

  // the time budget ran out before the request: an error this run, but no back-off
  const cache2 = await mkdtemp(join(tmpdir(), 'gp-nv-'));
  const check2 = join(await mkdtemp(join(tmpdir(), 'gp-nvs-')), 'nflverse-checks.json');
  const spent = withDeadline(up.fetchImpl, AbortSignal.abort(new BudgetError('nflverse time budget (75 s) spent')));
  const d = await fetchNflverseInputs({ fetchImpl: spent, now: t0, cacheDir: cache2, checkPath: check2, pauseMs: 0 });
  assert.equal(d.errors.length, 4);
  assert.ok(d.errors.every((e) => /nflverse time budget \(75 s\) spent/.test(e)), d.errors.join(' | '));
  const after = await fetchNflverseInputs({ fetchImpl: up.fetchImpl, now: t0 + 60e3, cacheDir: cache2, checkPath: check2, pauseMs: 0 });
  assert.equal(after.requests, 8, 'retried at once on the next run');
  assert.deepEqual(after.errors, []);
});
