// lib/injuries.mjs: per-game grading, angles, trimming, fetch + 6 h depth cache. Offline (saved captures + mock fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FIX, balatlInputs, BALATL_NOW } from './helpers.mjs';
import { buildSnapshot } from '../lib/build.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import {
  severity, isLongTerm, athleteIdFrom, normStatus, tidy, trimLeague, trimDepth, trimSchedule, prevWeek,
  gradeStatus, buildInjuries, flattenAngles, fetchInjuryInputs, NFL_TEAM_IDS,
} from '../lib/injuries.mjs';

const A = join(FIX, 'angles');
const gzJson = (f) => JSON.parse(gunzipSync(readFileSync(join(A, f))).toString('utf8'));
const json = (f) => JSON.parse(readFileSync(join(A, f), 'utf8'));
const H = 3600e3, DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const RES = gzJson('injuries-research-20261011.json.gz'); // Sunday 2026-10-11 23:59Z, ATL/BAL/CHI/TB league rows
const LIVE = gzJson('injuries-live-20261012.json.gz');    // Monday 2026-10-12 01:25Z, full live fetch
const byName = (games, label) => games.find((g) => `${g.away.abbr}@${g.home.abbr}` === label);
const anglesOf = (out, game) => out.byGame[game.id].angles;

test('status helpers', () => {
  assert.equal(severity('Active'), 0);
  assert.equal(severity('Out'), 1);
  assert.equal(severity('Injured Reserve'), 1);
  assert.equal(severity('Doubtful'), 0.75);
  assert.equal(severity('Questionable'), 0.35);
  assert.equal(severity('Weird Label'), 0.2);
  assert.ok(isLongTerm('Injured Reserve') && isLongTerm('Physically Unable to Perform') && !isLongTerm('Out'));
  assert.equal(normStatus('Injured Reserve'), 'IR');
  assert.equal(normStatus('Physically Unable to Perform'), 'PUP');
  assert.equal(normStatus('Out'), 'Out');
  assert.equal(athleteIdFrom({ links: [{ href: 'https://www.espn.com/nfl/player/_/id/3916387/lamar-jackson' }] }), '3916387');
  assert.equal(athleteIdFrom({ headshot: { href: 'https://a.espncdn.com/i/headshots/nfl/players/full/4035671.png' } }), '4035671');
  assert.equal(athleteIdFrom({ id: 7 }), '7');
  assert.equal(athleteIdFrom({}), null);
  assert.equal(tidy('Shoulder - AC Joint'), 'Shoulder, AC Joint');
  assert.equal(tidy('Knee — MCL'), 'Knee, MCL');
  assert.equal(tidy('He said–no'), 'He said, no');
  assert.equal(tidy('run-heavier'), 'run-heavier', 'compound-word hyphens stay');
});

test('trimLeague: raw ESPN league feed (no athlete.id) -> rows with ids; text kept for non-Active and QB rows only', () => {
  const raw = json('espn-injuries-raw-BAL-LAC.json');
  const t = trimLeague(raw, '2026-10-12T01:25:00Z');
  assert.equal(t.count, 50, '25 rows per team');
  assert.equal(t.items.filter((x) => x.id).length, 50, 'ids from links and from headshot URLs');
  assert.deepEqual([...new Set(t.items.map((x) => x.teamId))].sort(), ['24', '33']);
  const lamar = t.items.find((x) => x.name === 'Lamar Jackson');
  assert.equal(lamar.id, '3916387');
  assert.equal(lamar.fantasy, 'INACTIVE');
  for (const x of t.items) if (x.status === 'Active' && x.pos !== 'QB') assert.equal(x.comment, '');
  assert.equal(trimLeague(t), t, 'already trimmed input passes through');
});

test('trimDepth: groups chosen by content (offense is the last group), OL slots kept', () => {
  const raw = json('espn-depth-raw-BAL.json');
  assert.ok(!raw.depthchart[0].positions.qb, 'offense is not first in the raw chart');
  const d = trimDepth(raw);
  assert.equal(d.teamId, '33');
  assert.equal(d.abbr, 'BAL');
  for (const k of ['qb', 'rb', 'wr1', 'wr2', 'wr3', 'te', 'lt', 'lg', 'c', 'rg', 'rt']) assert.ok(d.offense[k]?.length, `offense ${k}`);
  for (const k of ['lcb', 'rcb', 'ss', 'fs', 'nb']) assert.ok(d.defense[k]?.length, `defense ${k}`);
  assert.equal(d.offense.qb[0].name, 'Lamar Jackson');
  assert.equal(d.offense.qb[0].pos, 'QB');
  assert.equal(d.offense.lt[0].pos, 'LT', 'slot position as ESPN labels it');
  const shuffled = trimDepth({ ...raw, depthchart: [...raw.depthchart].reverse() });
  assert.deepEqual(shuffled, d);
  assert.equal(trimDepth(d), d, 'already trimmed input passes through');
});

test('trimSchedule and prevWeek', () => {
  const s = trimSchedule({ events: [{ id: '1', date: '2026-10-12T00:20Z', status: { type: { state: 'pre' } }, competitions: [{ date: '2026-10-12T00:20Z', competitors: [{ homeAway: 'home', team: { id: '1', abbreviation: 'ATL' } }, { homeAway: 'away', team: { id: '33', abbreviation: 'BAL' } }] }] }] });
  assert.deepEqual(s, [{ id: '1', kickoff: '2026-10-12T00:20:00Z', state: 'pre', home: { id: '1', abbr: 'ATL' }, away: { id: '33', abbr: 'BAL' } }]);
  const cal = [{ value: '1', entries: [{ value: '3', startDate: '2026-08-20T00:00Z' }] }, { value: '2', entries: [{ value: '1', startDate: '2026-09-09T00:00Z' }, { value: '2', startDate: '2026-09-16T00:00Z' }] }];
  assert.deepEqual(prevWeek(cal, 2, 2), { seasonType: 2, week: 1 });
  assert.deepEqual(prevWeek(cal, 2, 1), { seasonType: 1, week: 3 }, 'crosses back into the preseason');
  assert.equal(prevWeek(cal, 1, 3), null);
  assert.deepEqual(prevWeek(undefined, 2, 5), { seasonType: 2, week: 4 });
});

test('gradeStatus: one status graded for THIS game (fantasyStatus + the previous kickoff, never the date alone)', () => {
  const kick = Date.parse('2026-10-18T17:00:00Z'), prev = Date.parse('2026-10-11T17:00:00Z');
  const g = (st) => gradeStatus(st, { kickMs: kick, prevKickMs: prev });
  assert.equal(g({ status: 'Active', date: iso(kick - DAY) }), null);
  assert.equal(g({ status: 'Out', fantasy: 'INACTIVE', date: iso(kick - 80 * 60e3) }).grade, 'confirmed');
  assert.equal(g({ status: 'Out', fantasy: 'INACTIVE', date: iso(prev - 80 * 60e3) }).grade, 'carryover', 'last week inactive');
  assert.equal(g({ status: 'Out', fantasy: 'INACTIVE', date: iso(prev + 4 * H) }).grade, 'carryover', 're-dated by a post-game quote');
  assert.equal(g({ status: 'Out', fantasy: 'OUT', date: iso(prev - 2 * DAY) }).grade, 'carryover');
  const hurt = g({ status: 'Out', fantasy: 'OUT', date: iso(prev + 2 * H) });
  assert.equal(hurt.grade, 'questionable');
  assert.equal(hurt.newInjury, true);
  assert.equal(g({ status: 'Out', fantasy: 'OUT', date: iso(prev + 20 * H), comment: "He won't return to Sunday's game" }).grade, 'questionable');
  assert.equal(g({ status: 'Out', fantasy: 'OUT', date: iso(kick - 2 * DAY) }).grade, 'confirmed', 'Friday ruling for Sunday');
  assert.equal(g({ status: 'Out', fantasy: 'OUT', date: iso(prev + 40 * H) }).grade, 'likely', 'early-week Out without "ruled out" text');
  assert.equal(g({ status: 'Out', fantasy: 'OUT', date: iso(prev + 40 * H), comment: 'He was ruled out for Sunday' }).grade, 'confirmed');
  assert.equal(g({ status: 'Doubtful', fantasy: 'DOUBTFUL', date: iso(kick - 2 * DAY) }).grade, 'likely');
  assert.equal(g({ status: 'Questionable', fantasy: 'QUESTIONABLE', date: iso(kick - 2 * DAY) }).grade, 'questionable');
  assert.equal(g({ status: 'Injured Reserve', fantasy: 'IR', date: iso(prev - 20 * DAY) }).grade, 'longterm');
  assert.equal(g({ status: 'Injured Reserve', fantasy: 'IR-R', date: iso(prev), returnDate: '2026-10-15' }).grade, 'questionable', 'eligible to return before this game');
  // an in-progress game keeps its gameday inactives confirmed even when ESPN re-dates the row after kickoff
  assert.equal(gradeStatus({ status: 'Out', fantasy: 'INACTIVE', date: iso(kick + H) }, { kickMs: kick, prevKickMs: prev, state: 'in' }).grade, 'confirmed');
});

test('research capture (Sun 23:59Z): Lamar confirmed for BAL@ATL, carryover for BAL@CLE; Caleb carryover; Baker likely', () => {
  const out = buildInjuries(RES, { games: RES.games, now: RES.now, recentGames: RES.schedule });
  assert.equal(out.ok, true, out.errors.join('; '));
  const balatl = byName(RES.games, 'BAL@ATL');
  const qb = anglesOf(out, balatl).find((a) => a.kind === 'qb-out');
  assert.equal(qb.team, 'away');
  assert.equal(qb.player, 'Lamar Jackson');
  assert.equal(qb.role, 'QB1');
  assert.equal(qb.grade, 'confirmed');
  assert.deepEqual(qb.beneficiaries.map((b) => b.name), ['Tyler Huntley', 'Derrick Henry', 'Mark Andrews']);
  assert.deepEqual(qb.fades.map((f) => f.name), ['Zay Flowers', 'BAL team total and spread']);
  assert.ok(qb.signals.some((s) => s.kind === 'espn-news' && /Huntley will start/.test(s.text)), 'Huntley "will start" note');
  const lamar = out.byGame[balatl.id].injuries.away.find((x) => x.name === 'Lamar Jackson');
  assert.deepEqual({ ...lamar, newsText: undefined, detail: undefined }, {
    espnId: '3916387', name: 'Lamar Jackson', pos: 'QB', status: 'Out', detail: undefined, starter: true, depthRank: 1,
    updated: '2026-10-11T23:05:00Z', role: 'QB1', grade: 'confirmed', fantasyStatus: 'INACTIVE', newsAt: '2026-10-11T23:05:00Z', newsText: undefined,
  });
  const g = (label, kind, role) => anglesOf(out, byName(RES.games, label)).find((a) => a.kind === kind && a.role === role);
  assert.equal(g('BAL@CLE', 'qb-out', 'QB1').grade, 'carryover');
  assert.equal(g('BAL@CLE', 'qb-out', 'QB1').signals.length, 0, 'last week\'s "Huntley will start" note is not a signal for next week');
  assert.equal(g('CHI@ATL', 'qb-out', 'QB1').player, 'Caleb Williams');
  assert.equal(g('CHI@ATL', 'qb-out', 'QB1').grade, 'carryover');
  assert.equal(g('CHI@ATL', 'qb-out', 'QB1').beneficiaries[0].name, 'Tyson Bagent');
  const baker = g('PIT@TB', 'qb-out', 'QB1');
  assert.equal(baker.player, 'Baker Mayfield');
  assert.equal(baker.grade, 'likely');
  assert.equal(baker.beneficiaries[0].name, 'Jalon Daniels');
  assert.ok(baker.signals.some((s) => s.kind === 'espn-news'));
  // stale depth-chart trade note (Marvin Harrison Jr. listed Out on his new team) is dropped
  const houjax = byName(RES.games, 'HOU@JAX');
  assert.ok(!out.byGame[houjax.id].injuries.away.some((x) => x.name === 'Marvin Harrison Jr.'));
  // games without injury data for a team still get entries; CFB games are ignored
  assert.equal(Object.keys(out.byGame).length, RES.games.length);
});

test('Kalshi passer names: backup listed and starter not -> kalshi signal; it upgrades a carryover QB angle to likely', () => {
  const balatl = byName(RES.games, 'BAL@ATL'), balcle = byName(RES.games, 'BAL@CLE');
  const out = buildInjuries(RES, { games: RES.games, recentGames: RES.schedule, kalshiPassers: { '26OCT11BALATL': ['Tyler Huntley', 'Michael Penix Jr.'] },
    props: [{ gameId: balcle.id, stat: 'passYds', player: { name: 'Tyler Huntley' } }] });
  const a = anglesOf(out, balatl).find((x) => x.kind === 'qb-out');
  assert.ok(a.signals.some((s) => s.kind === 'kalshi' && s.text === 'Kalshi KXNFLPASSYDS-26OCT11BALATL lists Tyler Huntley, not Lamar Jackson'));
  const b = anglesOf(out, balcle).find((x) => x.kind === 'qb-out');
  assert.equal(b.grade, 'likely');
  assert.ok(b.signals.some((s) => s.kind === 'kalshi'));
  const contra = buildInjuries(RES, { games: RES.games, recentGames: RES.schedule, kalshiPassers: { [balcle.id]: ['Lamar Jackson'] } });
  const c = anglesOf(contra, balcle).find((x) => x.kind === 'qb-out');
  assert.equal(c.grade, 'carryover');
  assert.ok(c.signals.some((s) => s.kind === 'kalshi-contra'));
});

test('synthetic gameday: ATL secondary and front starters inactive -> def-out angles for BAL WRs and RB; Friday Doubtful RB -> likely; Q cleared by Active', () => {
  const g = byName(RES.games, 'BAL@ATL');
  const kick = Date.parse(g.kickoff);
  const atl = RES.depth[g.home.espnId], bal = RES.depth[g.away.espnId];
  const front = Object.keys(atl.defense).find((k) => /dt|nt/.test(k));
  const mk = (p, teamId, status, fantasy, at, extra = {}) => ({ id: p.id, name: p.name, teamId, status, fantasy, date: iso(at), comment: '', longComment: '', ...extra });
  const items = [
    mk(atl.defense.lcb[0], '1', 'Out', 'INACTIVE', kick - 80 * 60e3),
    mk(atl.defense.lde[0], '1', 'Out', 'INACTIVE', kick - 80 * 60e3),
    mk(atl.defense[front][0], '1', 'Out', 'INACTIVE', kick - 80 * 60e3),
    mk(atl.offense.rb[0], '1', 'Doubtful', 'DOUBTFUL', kick - 2 * DAY),
    mk(bal.offense.te[0], '33', 'Questionable', 'QUESTIONABLE', kick - 2 * DAY),
    mk(bal.offense.te[0], '33', 'Active', null, kick - 85 * 60e3),
  ];
  const depth = { [g.home.espnId]: atl, [g.away.espnId]: bal };
  const out = buildInjuries({ league: { items }, depth }, { games: [g], now: iso(kick - H), recentGames: RES.schedule });
  const angles = out.byGame[g.id].angles;
  const sec = angles.find((a) => a.kind === 'def-out' && a.role === 'secondary');
  assert.equal(sec.team, 'home');
  assert.equal(sec.grade, 'confirmed');
  assert.deepEqual(sec.beneficiaries.map((b) => [b.name, b.team]), [[bal.offense.wr1[0].name, 'away'], [bal.offense.wr2[0].name, 'away']]);
  const fr = angles.find((a) => a.kind === 'def-out' && a.role === 'front');
  assert.ok(fr.players.length >= 2);
  for (const p of [atl.defense.lde[0], atl.defense[front][0]]) assert.ok(fr.players.some((x) => x.id === p.id), p.name);
  assert.deepEqual(fr.beneficiaries.map((b) => b.name), [bal.offense.rb[0].name]);
  const rb = angles.find((a) => a.kind === 'skill-out' && a.role === 'RB1');
  assert.equal(rb.team, 'home');
  assert.equal(rb.grade, 'likely');
  assert.equal(rb.status, 'Doubtful');
  assert.ok(!angles.some((a) => a.role === 'TE1'));
  assert.ok(!out.byGame[g.id].injuries.away.some((x) => x.role === 'TE1'), 'gameday Active clears the Friday Questionable');
});

test('ol-out needs 2 OL starters; its grade is the second most certain one', () => {
  const g = byName(RES.games, 'BAL@ATL');
  const kick = Date.parse(g.kickoff);
  const raw = trimDepth(json('espn-depth-raw-BAL.json'));
  const bal = { ...raw, offense: Object.fromEntries(Object.entries(raw.offense).map(([k, l]) => [k, l.map((p) => ({ ...p, inj: null }))])) }; // only the synthetic statuses below
  const atl = RES.depth[g.home.espnId];
  const mk = (p, status, fantasy, at) => ({ id: p.id, name: p.name, teamId: '33', status, fantasy, date: iso(at), comment: '', longComment: '' });
  const depth = { [g.home.espnId]: atl, [g.away.espnId]: { ...bal, defense: {} } };
  const one = buildInjuries({ league: { items: [mk(bal.offense.lt[0], 'Out', 'INACTIVE', kick - H)] }, depth }, { games: [g], recentGames: RES.schedule });
  assert.ok(!one.byGame[g.id].angles.some((a) => a.kind === 'ol-out'));
  assert.equal(one.byGame[g.id].injuries.away.find((x) => x.role === 'OL').pos, 'LT');
  const two = buildInjuries({ league: { items: [mk(bal.offense.lt[0], 'Out', 'INACTIVE', kick - H), mk(bal.offense.rg[0], 'Doubtful', 'DOUBTFUL', kick - 2 * DAY)] }, depth }, { games: [g], recentGames: RES.schedule });
  const ol = two.byGame[g.id].angles.find((a) => a.kind === 'ol-out');
  assert.equal(ol.team, 'away');
  assert.equal(ol.grade, 'likely');
  assert.deepEqual(ol.players.map((p) => p.slot), ['LT', 'RG']);
  assert.deepEqual(ol.fades.map((f) => f.why), ['pass protection weakened', 'run blocking weakened']);
});

test('live capture (Mon 01:25Z): 16 NFL games, schema-valid injuries, deterministic, no dashes, OL and QB angles', () => {
  const run = () => buildInjuries(LIVE, { games: LIVE.games, now: LIVE.now, recentGames: LIVE.schedule });
  const out = run();
  assert.equal(out.ok, true, out.errors.join('; '));
  assert.deepEqual(out.notes, [], 'previous kickoff known for every team (current + previous week captured)');
  assert.equal(Object.keys(out.byGame).length, 16);
  assert.equal(JSON.stringify(run()), JSON.stringify(out), 'same inputs, same output');
  const text = JSON.stringify(out);
  assert.ok(!/[–—]| - /.test(text), 'no em/en dashes or spaced hyphens');
  assert.ok(!/newsAgeHours|likelyPricedIn/.test(text), 'no clock-dependent fields');
  for (const v of Object.values(out.byGame)) for (const side of ['home', 'away']) for (const x of v.injuries[side]) {
    for (const k of ['espnId', 'name', 'pos', 'status', 'detail', 'updated', 'newsAt', 'newsText', 'fantasyStatus']) assert.ok(x[k] === null || typeof x[k] === 'string', `${x.name}.${k}`);
    assert.equal(x.starter, true);
    assert.equal(x.depthRank, 1);
    assert.ok(['QB1', 'RB1', 'WR1', 'WR2', 'WR3', 'TE1', 'OL', 'DL', 'LB', 'CB', 'S'].includes(x.role));
    assert.ok(['confirmed', 'likely', 'questionable', 'carryover', 'longterm'].includes(x.grade));
  }
  const all = flattenAngles(out.byGame);
  for (const a of all) {
    assert.ok(['qb-out', 'skill-out', 'ol-out', 'def-out'].includes(a.kind));
    assert.ok(['home', 'away'].includes(a.team));
    for (const k of ['beneficiaries', 'fades', 'signals']) assert.ok(Array.isArray(a[k]));
  }
  const g = (label) => byName(LIVE.games, label);
  // BAL@ATL kicked off at 00:20Z: no angles for a game in progress, but its inactives stay confirmed
  assert.equal(g('BAL@ATL').state, 'in');
  assert.deepEqual(out.byGame[g('BAL@ATL').id].angles, []);
  assert.equal(out.byGame[g('BAL@ATL').id].injuries.away.find((x) => x.name === 'Lamar Jackson').grade, 'confirmed');
  assert.equal(anglesOf(out, g('BAL@CLE')).find((a) => a.kind === 'qb-out').grade, 'carryover');
  assert.equal(anglesOf(out, g('PIT@TB')).find((a) => a.kind === 'qb-out').grade, 'likely');
  const ol = anglesOf(out, g('LAC@KC')).find((a) => a.kind === 'ol-out');
  assert.ok(ol, 'LAC missing 2 OL starters');
  assert.equal(ol.team, 'away');
  assert.deepEqual(ol.players.map((p) => p.name).sort(), ['Joe Alt', 'Kayode Awosika']);
});

test('the built injuries drop into a snapshot that passes validateSnapshot', () => {
  const snap = buildSnapshot(balatlInputs(), { now: BALATL_NOW, leagues: ['nfl'] });
  const out = buildInjuries(LIVE, { games: LIVE.games, now: LIVE.now, recentGames: LIVE.schedule });
  let n = 0;
  for (const game of snap.games) {
    const v = out.byGame[game.id];
    if (!v) continue;
    game.injuries = v.injuries;
    game.angles = v.angles;
    n += v.injuries.home.length + v.injuries.away.length;
  }
  assert.ok(n > 0);
  assert.deepEqual(validateSnapshot(snap), []);
});

test('no schedule data: falls back to one week before and says so', () => {
  const g = byName(RES.games, 'BAL@CLE');
  const out = buildInjuries({ league: RES.league, depth: RES.depth }, { games: [g] });
  assert.match(out.notes[0], /previous kickoff unknown for 2 team/);
  const bad = buildInjuries({}, { games: [g] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes('no league injuries feed'));
  assert.ok(bad.errors.some((e) => /no depth chart for BAL/.test(e)));
});

// ---------------------------------------------------------------- fetch (mock)

function mockEspn({ leagueStatus = 200, depthFail = () => false } = {}) {
  const league = json('espn-injuries-raw-BAL-LAC.json');
  const depth = json('espn-depth-raw-BAL.json');
  const cal = [{ value: '2', entries: [4, 5, 6].map((w) => ({ value: String(w), startDate: `2026-10-0${w - 3}T07:00Z` })) }];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/nfl/injuries')) return leagueStatus === 200 ? ok(league) : new Response('down', { status: leagueStatus });
    const m = /\/teams\/(\d+)\/depthcharts$/.exec(u.pathname);
    if (m) return depthFail(m[1]) ? new Response('err', { status: 500 }) : ok({ ...depth, team: { id: m[1], abbreviation: `T${m[1]}` } });
    if (u.pathname.endsWith('/nfl/scoreboard')) {
      const wk = Number(u.searchParams.get('week') || 5);
      return ok({ week: { number: wk }, season: { type: 2 }, leagues: [{ calendar: cal }], events: [{ id: `e${wk}`, date: `2026-10-0${wk - 3}T17:00Z`, competitions: [{ competitors: [{ homeAway: 'home', team: { id: '1', abbreviation: 'ATL' } }, { homeAway: 'away', team: { id: '33', abbreviation: 'BAL' } }] }] }] });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('fetchInjuryInputs: league every run; 32 depth charts + 2 scoreboards cached for 6 hours', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gp-inj-'));
  const t0 = Date.parse('2026-10-12T01:00:00Z');
  const m = mockEspn();
  const a = await fetchInjuryInputs({ fetchImpl: m.fetchImpl, now: t0, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  assert.equal(a.requests, 35, '1 league + 32 depth + current and previous week scoreboards');
  assert.equal(a.depthCached, false);
  assert.equal(Object.keys(a.depth).length, 32);
  assert.deepEqual(Object.keys(a.depth).sort(), [...NFL_TEAM_IDS].sort(), 'feed lists only 2 teams, so the fixed 32 team ids are used');
  assert.equal(a.league.count, 50);
  assert.deepEqual(a.schedule.map((g) => g.id), ['e4', 'e5']);
  assert.ok(m.calls.some((u) => /week=4/.test(u)), 'previous week from the calendar');
  assert.deepEqual(a.errors, []);
  const cached = JSON.parse(await readFile(join(cacheDir, 'injuries-depth.json'), 'utf8'));
  assert.equal(cached.fetchedAt, '2026-10-12T01:00:00Z');

  const b = await fetchInjuryInputs({ fetchImpl: m.fetchImpl, now: t0 + H, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  assert.equal(b.requests, 1);
  assert.equal(b.depthCached, true);
  assert.equal(b.depthFetchedAt, '2026-10-12T01:00:00Z');
  assert.deepEqual(b.schedule, a.schedule);

  const c = await fetchInjuryInputs({ fetchImpl: m.fetchImpl, now: t0 + 7 * H, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  assert.equal(c.requests, 35, 'refreshed after 6 hours');

  // league feed down: depth still served, error recorded, builder degrades
  const d = await fetchInjuryInputs({ fetchImpl: mockEspn({ leagueStatus: 503 }).fetchImpl, now: t0 + 8 * H, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  assert.equal(d.league, null);
  assert.ok(d.errors.some((e) => /league injuries/.test(e)));
  assert.equal(d.requests, 2, 'one retry on 5xx');
  assert.equal(d.depthCached, true);
});

test('fetchInjuryInputs: a mostly failed depth refresh keeps old charts and waits 30 minutes before retrying', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gp-inj-'));
  const t0 = Date.parse('2026-10-12T01:00:00Z');
  await fetchInjuryInputs({ fetchImpl: mockEspn().fetchImpl, now: t0, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  const bad = mockEspn({ depthFail: () => true });
  const a = await fetchInjuryInputs({ fetchImpl: bad.fetchImpl, now: t0 + 7 * H, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  assert.equal(Object.keys(a.depth).length, 32, 'older charts kept');
  assert.ok(a.errors.filter((e) => /^depth/.test(e)).length === 32);
  const b = await fetchInjuryInputs({ fetchImpl: bad.fetchImpl, now: t0 + 7 * H + 10 * 60e3, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  assert.equal(b.requests, 1, 'inside the 30 minute back-off only the league feed is fetched');
  assert.equal(b.depthCached, true);
});
