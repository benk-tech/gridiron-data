// lib/cfb.mjs: FBS defense ratings (sportsdataverse + ESPN byteam) and the QB-change detector. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FIX } from './helpers.mjs';
import {
  buildCfb, cfbDefenseById, fetchCfbInputs, trimBoard, trimByTeam, summaryPassers, detectQbChange, cfbQbAngles, cfbWeekKey, cfbSeason, parseEspnByTeam, CFB_URLS,
} from '../lib/cfb.mjs';

const A = join(FIX, 'angles', 'cfb');
const buf = (f) => readFileSync(join(A, f));
const gzJson = (f) => JSON.parse(gunzipSync(buf(f)).toString('utf8'));
const json = (f) => JSON.parse(buf(f).toString('utf8'));
const DVP = gunzipSync(buf('cfb_defense_vs_position_2026.csv.gz')).toString('utf8'); // sportsdataverse 2026-10-11 13:01Z
const BYTEAM = gzJson('cfb_byteam_trim.json.gz');                                     // ESPN byteam groups=80, trimmed
const LIVE = gzJson('cfb-qb-live-20261012.json.gz');                                   // this session's weekly capture (6 summaries)

test('FBS ratings match the research (138 teams; RB EPA, QB-play EPA, points allowed)', () => {
  const byId = cfbDefenseById(DVP, BYTEAM);
  const all = Object.values(byId);
  assert.equal(all.length, 138);
  assert.equal(all.filter((v) => !v.abbr).length, 0, 'every SDV team_id is an ESPN id in byteam');
  const order = (f, desc = false) => all.filter((v) => f(v) != null).sort((a, b) => (desc ? f(b) - f(a) : f(a) - f(b))).map((v) => v.abbr);
  assert.deepEqual(order((v) => v.epaAllowed.RB).slice(0, 5), ['COLO', 'IU', 'KU', 'PITT', 'OU']);
  assert.deepEqual(order((v) => v.epaAllowed.RB, true).slice(0, 3), ['ARMY', 'USA', 'USM']);
  assert.deepEqual(order((v) => v.epaAllowed.QB).slice(0, 3), ['LSU', 'UCLA', 'OU']);
  assert.deepEqual(order((v) => v.epaAllowed.QB, true).slice(0, 3), ['ULM', 'STAN', 'PUR']);
  assert.deepEqual(order((v) => v.ptsAllowedPg).slice(0, 2), ['MIA', 'NDSU']);
  const colo = all.find((v) => v.abbr === 'COLO');
  assert.equal(colo.epaAllowed.RB, -0.29);
  assert.equal(colo.ranks.rush, 1);
  assert.equal(all.find((v) => v.abbr === 'ULM').ranks.pass, 138);
  assert.equal(all.find((v) => v.abbr === 'MIA').ptsAllowedPg, 9.8);
  for (const k of ['pass', 'rush', 'overall']) assert.deepEqual(all.map((v) => v.ranks[k]).sort((a, b) => a - b), Array.from({ length: 138 }, (_, i) => i + 1));
});

test('buildCfb: defense keyed by the games\' ESPN abbreviations in the SPEC 10.1 shape', () => {
  const out = buildCfb({ defense: { dvp: DVP, byTeam: BYTEAM }, qb: LIVE.qb }, { games: LIVE.games });
  assert.equal(out.ok, true, out.errors.join('; '));
  const teams = new Set(LIVE.games.flatMap((g) => [g.home.abbr, g.away.abbr]));
  assert.ok(Object.keys(out.defense.cfb).every((t) => teams.has(t)));
  assert.ok(Object.keys(out.defense.cfb).length >= 115, `${Object.keys(out.defense.cfb).length} teams`);
  assert.equal(out.warnings.length, 1, 'FCS opponents have no FBS rating');
  const uga = out.defense.cfb.UGA;
  assert.deepEqual(Object.keys(uga).sort(), ['epaAllowed', 'games', 'passYpaAllowed', 'ptsAllowedPg', 'ranks', 'rushYpcAllowed']);
  assert.deepEqual(uga, { games: 6, ptsAllowedPg: 14, passYpaAllowed: 5.75, rushYpcAllowed: 2.99, epaAllowed: { QB: 0.022, RB: -0.188, WR: 0.207, TE: 0.469 }, ranks: { pass: 61, rush: 9, overall: 50, points: 11 } });
  const all = buildCfb({ defense: { dvp: DVP, byTeam: BYTEAM } });
  assert.equal(Object.keys(all.defense.cfb).length, 138, 'no games: every FBS team');
  assert.ok(JSON.stringify(out.defense.cfb).length < 40000);
});

test('QB-change detector on the live weekly capture: DEL and WKU season leaders threw 0 passes in their last game', () => {
  const out = buildCfb({ defense: { dvp: DVP, byTeam: BYTEAM }, qb: LIVE.qb }, { games: LIVE.games });
  const ids = new Set(LIVE.games.map((g) => g.id));
  const byTeam = Object.fromEntries(out.cfbQbChanges.map((c) => [LIVE.games.find((g) => g.id === c.gameId)[c.team].abbr, c]));
  assert.deepEqual(Object.keys(byTeam).sort(), ['DEL', 'WKU']);
  assert.deepEqual({ expected: byTeam.DEL.expected, last: byTeam.DEL.last, lastAtt: byTeam.DEL.lastAtt, expectedAttLast: byTeam.DEL.expectedAttLast },
    { expected: 'Nick Minicucci', last: 'EJ Archield Jr.', lastAtt: 19, expectedAttLast: 0 });
  assert.equal(byTeam.WKU.last, 'Brock Glenn');
  for (const c of out.cfbQbChanges) {
    assert.ok(ids.has(c.gameId) && /^cfb-\d+$/.test(c.gameId));
    assert.ok(['home', 'away'].includes(c.team));
    assert.ok(!/[–—]| - /.test(c.note), 'no dashes');
  }
  const angles = cfbQbAngles(out.cfbQbChanges, LIVE.games);
  const a = angles[byTeam.DEL.gameId][0];
  assert.equal(a.kind, 'cfb-qb-change');
  assert.equal(a.grade, 'questionable');
  assert.equal(a.role, 'QB1');
  assert.deepEqual(a.beneficiaries.map((b) => b.name), ['EJ Archield Jr.']);
  assert.equal(a.fades[0].name, 'DEL team total and spread');
});

test('deterministic: same inputs (games in any order) give byte-identical output', () => {
  const a = buildCfb({ defense: { dvp: DVP, byTeam: BYTEAM }, qb: LIVE.qb }, { games: LIVE.games });
  const b = buildCfb({ defense: { dvp: DVP, byTeam: BYTEAM }, qb: LIVE.qb }, { games: [...LIVE.games].reverse() });
  assert.equal(JSON.stringify(a.cfbQbChanges), JSON.stringify(b.cfbQbChanges));
  const keys = (o) => Object.keys(o).sort();
  assert.deepEqual(keys(a.defense.cfb), keys(b.defense.cfb));
  for (const k of keys(a.defense.cfb)) assert.deepEqual(a.defense.cfb[k], b.defense.cfb[k]);
});

test('detectQbChange thresholds (leader under 5 attempts, other QB 10 or more)', () => {
  const L = { id: '1', name: 'Leader' };
  const last = (a, b) => ({ passers: [{ id: '1', name: 'Leader', att: a }, { id: '2', name: 'Other', att: b }] });
  assert.ok(detectQbChange(L, last(4, 25)));
  assert.equal(detectQbChange(L, last(5, 25)), null);
  assert.equal(detectQbChange(L, last(0, 9)), null);
  assert.equal(detectQbChange(L, last(30, 2)), null);
  assert.ok(detectQbChange(L, { passers: [{ id: '2', name: 'Other', att: 22 }] }), 'leader absent from the box score');
  assert.equal(detectQbChange(null, last(0, 30)), null);
});

test('summaryPassers reads C/ATT from a raw CFB box score; trimBoard keeps season passing leaders', () => {
  const rows = summaryPassers(json('espn-cfb-summary-raw-401871050.json'), '401871050');
  assert.equal(rows.length, 2);
  const del = rows.find((r) => r.teamId === '48');
  assert.deepEqual(del.passers.find((p) => p.name === 'EJ Archield Jr.'), { id: '5296312', name: 'EJ Archield Jr.', att: 19 });
  assert.ok(rows.every((r) => r.passers.every((p) => !p.id.startsWith('-'))), 'team pseudo rows dropped');
  const ev = trimBoard(json('espn-cfb-board-w7-sample.json'));
  assert.equal(ev.length, 4);
  assert.ok(ev.every((e) => e.state === 'pre' && e.teams.length === 2));
  assert.ok(ev.some((e) => e.teams.some((t) => t.leader?.name && /\d+\/\d+/.test(t.leader.line))), 'season line like 88/156, 913 YDS');
});

test('cfbWeekKey, cfbSeason, byteam trimming', () => {
  assert.equal(cfbWeekKey('2026-10-12T00:30:00Z'), '2026-10-11');
  assert.equal(cfbWeekKey('2026-10-11T11:59:00Z'), '2026-10-04', 'Saturday night games may still be running');
  assert.equal(cfbWeekKey('2026-10-11T12:00:00Z'), '2026-10-11');
  assert.equal(cfbWeekKey('2026-10-17T23:00:00Z'), '2026-10-11');
  assert.equal(cfbSeason('2026-10-11T00:00:00Z'), 2026);
  assert.equal(cfbSeason('2027-01-10T00:00:00Z'), 2026);
  assert.equal(trimByTeam(BYTEAM).teams.length, 138, 'idempotent');
  const p = parseEspnByTeam(BYTEAM);
  assert.equal(p['61'].abbr, 'UGA');
});

test('missing inputs: errors, never throws', () => {
  const out = buildCfb({}, { games: LIVE.games });
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors, ['cfb dvp: missing', 'cfb qb: no weekly data']);
  assert.deepEqual(out.defense.cfb, {});
  const noBy = buildCfb({ defense: { dvp: DVP } }, { games: LIVE.games });
  assert.ok(noBy.errors.some((e) => /byteam: missing/.test(e)));
  assert.equal(noBy.defense.cfb.UGA.ptsAllowedPg, null);
  assert.equal(noBy.defense.cfb.UGA.epaAllowed.RB, -0.188);
});

// ---------------------------------------------------------------- fetch (mock)

function mockCfb() {
  const calls = [];
  const cal = [{ value: '2', entries: [5, 6, 7].map((w) => ({ value: String(w), startDate: `2026-10-${String(w - 4).padStart(2, '0')}T07:00Z` })) }];
  const comp = (state, date, home, away, leader) => ({ id: `${home}${away}${date.slice(8, 10)}`, date, status: { type: { state } }, competitions: [{ date, status: { type: { state } }, competitors: [
    { homeAway: 'home', team: { id: home, abbreviation: `T${home}` }, leaders: leader && leader[home] ? [{ name: 'passingLeader', leaders: [{ displayValue: '50/90, 600 YDS', athlete: { id: leader[home], displayName: `Leader ${home}` } }] }] : [] },
    { homeAway: 'away', team: { id: away, abbreviation: `T${away}` }, leaders: [] }] }] });
  const boards = {
    6: [comp('post', '2026-10-10T19:00Z', '10', '20'), comp('post', '2026-10-10T23:00Z', '30', '40')],
    5: [comp('post', '2026-10-03T19:00Z', '50', '60')],
    7: [comp('pre', '2026-10-17T19:00Z', '10', '30', { 10: '1001' }), comp('pre', '2026-10-17T23:00Z', '50', '70', { 50: '5001' })],
  };
  const summary = (home, away) => ({ boxscore: { players: [
    { team: { id: home }, statistics: [{ name: 'passing', labels: ['C/ATT', 'YDS'], athletes: [{ athlete: { id: `${home}02`, displayName: 'Backup' }, stats: ['15/25', '180'] }, { athlete: { id: '-1', displayName: 'TEAM' }, stats: ['0/0', '0'] }] }] },
    { team: { id: away }, statistics: [{ name: 'passing', labels: ['C/ATT', 'YDS'], athletes: [{ athlete: { id: `${away}01`, displayName: 'Starter' }, stats: ['20/30', '250'] }] }] }] } });
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const ok = (b) => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status: 200 });
    if (url === CFB_URLS.dvp(2026)) return ok(DVP);
    if (url === CFB_URLS.byTeam(2026)) return ok(BYTEAM);
    if (u.pathname.endsWith('/college-football/scoreboard')) {
      const wk = Number(u.searchParams.get('week') || 6);
      return ok({ week: { number: wk }, season: { type: 2 }, leagues: [{ calendar: cal }], events: boards[wk] || [] });
    }
    if (u.pathname.endsWith('/college-football/summary')) {
      const ev = Object.values(boards).flat().find((e) => e.id === u.searchParams.get('event'));
      const [h, a] = ev.competitions[0].competitors.map((c) => c.team.id);
      return ok(summary(h, a));
    }
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('fetchCfbInputs: daily defense (2 requests), weekly QB check (3 boards + 1 summary per needed game), both cached', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gp-cfb-'));
  const t0 = Date.parse('2026-10-12T01:30:00Z');
  const m = mockCfb();
  const a = await fetchCfbInputs({ fetchImpl: m.fetchImpl, now: t0, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  // teams 10, 30 (last game in week 6) and 50 (week 5) have upcoming games; 70 has no finished game in range
  assert.equal(a.requests, 2 + 3 + 3);
  assert.deepEqual(a.errors, []);
  assert.equal(a.qb.complete, true);
  assert.equal(a.qb.weekKey, '2026-10-11');
  assert.deepEqual(Object.keys(a.qb.lastPassers).sort(), ['10', '20', '30', '40', '50', '60']);
  assert.ok(a.defense.dvp.startsWith('season,team_id'));
  const built = buildCfb(a, { games: [
    { id: 'cfb-1030', league: 'cfb', espnId: '103017', kickoff: '2026-10-17T19:00:00Z', state: 'pre', home: { abbr: 'T10', espnId: '10' }, away: { abbr: 'T30', espnId: '30' } },
  ] });
  assert.deepEqual(built.cfbQbChanges.map((c) => [c.team, c.expected, c.last]), [['home', 'Leader 10', 'Backup']]);

  const b = await fetchCfbInputs({ fetchImpl: m.fetchImpl, now: t0 + 3600e3, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  assert.equal(b.requests, 0, 'same day, same week: all from cache');
  assert.equal(b.defense.cached, true);
  assert.equal(b.qb.cached, true);
  const c = await fetchCfbInputs({ fetchImpl: m.fetchImpl, now: t0 + 86400e3, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  assert.equal(c.requests, 2, 'next day: defense refreshed, weekly QB data still cached');
});

test('fetchCfbInputs: maxSummaries caps the weekly requests and marks the week for a retry', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gp-cfb-'));
  const t0 = Date.parse('2026-10-12T01:30:00Z');
  const m = mockCfb();
  const a = await fetchCfbInputs({ fetchImpl: m.fetchImpl, now: t0, cacheDir, pauseMs: 0, retryDelayMs: 0, maxSummaries: 1 });
  assert.equal(a.requests, 2 + 3 + 1);
  assert.equal(a.qb.complete, false);
  assert.match(a.errors.join(' '), /2 summaries skipped/);
  const b = await fetchCfbInputs({ fetchImpl: m.fetchImpl, now: t0 + 60e3, cacheDir, pauseMs: 0, retryDelayMs: 0, maxSummaries: 1 });
  assert.equal(b.requests, 0, 'incomplete week waits 6 hours before retrying');
  const c = await fetchCfbInputs({ fetchImpl: m.fetchImpl, now: t0 + 7 * 3600e3, cacheDir, pauseMs: 0, retryDelayMs: 0 });
  assert.equal(c.requests, 3 + 3, 'retry after the back-off (defense still cached for the day)');
  assert.equal(c.qb.complete, true);
});

test('fetchCfbInputs: a missing defense file (404) waits 6 hours; the piece that worked is kept and not fetched again', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gp-cfb-'));
  const t0 = Date.parse('2026-10-12T01:30:00Z');
  const m = mockCfb();
  let dvpUp = false;
  const fetchImpl = async (url, init) => (url === CFB_URLS.dvp(2026) && !dvpUp ? new Response('Not Found', { status: 404 }) : m.fetchImpl(url, init));
  const run = (h) => fetchCfbInputs({ fetchImpl, now: t0 + h * 3600e3, cacheDir, pauseMs: 0, retryDelayMs: 0 });

  const a = await run(0);
  assert.equal(a.requests, 2 + 3 + 3);
  assert.ok(a.errors.some((e) => /^cfb dvp: .*cfb_defense_vs_position_2026\.csv: HTTP 404$/.test(e)), a.errors.join(' | '));
  assert.ok(a.defense.byTeam && !a.defense.dvp);

  for (const h of [5 / 60, 1, 5.9]) {
    const b = await run(h);
    assert.equal(b.requests, 0, `+${h} h: no request (dvp backs off, byteam kept, weekly QB data cached)`);
    assert.ok(b.defense.byTeam, 'byteam from the cache');
    assert.ok(b.errors.some((e) => /^cfb dvp: .*HTTP 404; next try after 2026-10-12T07:30:00Z$/.test(e)), b.errors.join(' | '));
  }

  dvpUp = true;
  const c = await run(6.1);
  assert.equal(c.requests, 1, 'only the missing piece is fetched');
  assert.deepEqual(c.errors, []);
  assert.ok(c.defense.dvp.startsWith('season,team_id') && c.defense.byTeam);
  const d = await run(7);
  assert.equal(d.requests, 0);
  assert.equal(d.defense.cached, true);
});
