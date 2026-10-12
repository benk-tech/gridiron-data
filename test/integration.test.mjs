// Phase B assembly through buildRun (offline): the BAL@ATL capture (2026-10-11 23:49Z) plus the props, team-total,
// injuries, nflverse and CFB fixtures that the module tests use. Checks that the pieces join up in one snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FIX, rd, balatlInputs, BALATL_NOW, researchInputs, RESEARCH_NOW } from './helpers.mjs';
import { buildRun, buildSnapshot, summarize } from '../lib/build.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { packSnapshot } from '../lib/ingest.mjs';

const A = join(FIX, 'angles');
const buf = (...p) => readFileSync(join(A, ...p));
const gz = (...p) => JSON.parse(gunzipSync(buf(...p)).toString('utf8'));
const NOW = Date.parse(BALATL_NOW);
const MIN = 60e3;
const BALATL = 'nfl-401872993';
const BUFLAR = 'nfl-401872994';
const HENRY = '3043078';
const DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']'); // en and em dash (Ben's rule)

const INJ = gz('injuries-research-20261011.json.gz');
const PB = rd('props', 'kalshi-balatl-2357z.json').markets;
const PL = rd('props', 'kalshi-buflar-0017z.json').markets;
const ESPN_PROPS = { 401872993: rd('props', 'espn-propbets-401872993.json').items, 401872994: rd('props', 'espn-propbets-401872994.json').items };
const TT_LIVE = rd('props', 'live-teamtotals-20261012.json');

function phaseBInputs() {
  const inputs = balatlInputs();
  // The capture has no Kalshi GAME event for BUF@LAR: add one (cloned from BAL@ATL) so team totals have a game to join.
  const base = inputs.kalshi.markets.KXNFLGAME;
  const mk = (code, name, uuid) => ({ ...base[0], ticker: `KXNFLGAME-26OCT12BUFLAR-${code}`, event_ticker: 'KXNFLGAME-26OCT12BUFLAR', yes_sub_title: name, custom_strike: { football_team: uuid }, close_time: '2026-10-15T00:15:00Z' });
  inputs.kalshi.markets.KXNFLGAME = [...base, mk('BUF', 'Buffalo', 'uuid-buf'), mk('LAR', 'Los Angeles R', 'uuid-lar')];
  const kalshi = {};
  for (const s of new Set([...Object.keys(PB), ...Object.keys(PL)])) kalshi[s] = [...(PB[s] || []), ...(PL[s] || [])];
  inputs.props = { fetchedAt: BALATL_NOW, kalshi: structuredClone(kalshi), espnProps: structuredClone(ESPN_PROPS), errors: [], requests: 0 };
  inputs.teamTotals = { fetchedAt: BALATL_NOW, kalshi: { KXNFLTEAMTOTAL: structuredClone(TT_LIVE.kalshi.KXNFLTEAMTOTAL), KXNCAAFTEAMTOTAL: [] }, errors: [], requests: 0 };
  inputs.injuryFeed = { league: structuredClone(INJ.league), depth: structuredClone(INJ.depth), schedule: structuredClone(INJ.schedule),
    leagueFetchedAt: BALATL_NOW, depthFetchedAt: BALATL_NOW, depthCached: false, errors: [], requests: 0 };
  inputs.nflverse = {
    season: 2026, fetchedAt: BALATL_NOW, etags: { pbp: '"p1"', statsPlayerWeek: '"s1"', rosterWeekly: '"r1"', pfrDef: '"f1"' }, lastModified: {}, cached: {}, errors: [], warnings: [], requests: 0,
    pbp: buf('nflverse', 'pbp_2026_trim.csv.gz'), statsPlayerWeek: buf('nflverse', 'stats_player_week_2026_trim.csv.gz'),
    rosterWeekly: buf('nflverse', 'roster_weekly_2026_trim.csv.gz'), pfrDef: buf('nflverse', 'advstats_week_def_2026.csv.gz'),
  };
  return inputs;
}

// DK spread on the ESPN board (current line), for simulating a move between runs.
function setSpread(inputs, eventId, homeLine) {
  const ev = inputs.espn.scoreboards.nfl[0].events.find((e) => e.id === eventId);
  const o = ev.competitions[0].odds.find((x) => String(x?.provider?.id) === '100') || ev.competitions[0].odds[0];
  o.pointSpread.home.close.line = `${homeLine > 0 ? '+' : ''}${homeLine}`;
  o.pointSpread.away.close.line = `${-homeLine > 0 ? '+' : ''}${-homeLine}`;
}
function setPropLine(inputs, eventId, athleteId, typeId, value) {
  let n = 0;
  for (const it of inputs.props.espnProps[eventId]) {
    if (String(it?.athlete?.$ref || '').includes(`athletes/${athleteId}`) && String(it.type?.id) === typeId) { it.current = { target: { value } }; n++; }
  }
  assert.ok(n > 0, `no DK item for ${athleteId} type ${typeId}`);
}

const first = buildRun(phaseBInputs(), { now: NOW, version: 'test', runMs: 1 });
const S = first.snapshot;
const game = (s, id) => s.games.find((g) => g.id === id);

test('phase B snapshot validates and stays small', () => {
  assert.deepEqual(validateSnapshot(S), []);
  const pk = packSnapshot(S);
  assert.ok(pk.gzBytes < 400e3, `gzip ${pk.gzBytes}`);
  assert.ok(!DASH.test(pk.json), 'no long dashes anywhere in the snapshot');
  for (const k of ['props', 'teamTotals', 'nflverse', 'moves']) assert.equal(S.sources[k].ok, true, `${k}: ${S.sources[k].errors.join(' | ')}`);
  assert.equal(S.sources.injuries.ok, true, S.sources.injuries.errors.join(' | '));
  assert.equal(S.sources.cfb.ok, false, 'not fetched');
  assert.deepEqual(S.sources.cfb.errors, ['not fetched']);
  assert.equal(S.sources.moves.since, null, 'first run: no history');
});

test('props: both games, every ladder joined to an ESPN player, DK lines and fifty classes', () => {
  const sum = summarize(S);
  assert.ok(S.props.length > 150, `${S.props.length} ladders`);
  assert.equal(sum.propsMatched, S.props.length, 'every ladder joined (bridge, then depth-chart fallback)');
  assert.ok(new Set(S.props.map((p) => p.gameId)).size === 2);
  assert.ok(sum.propsWithDk >= 100, `${sum.propsWithDk} with DK`);
  const henry = S.props.find((p) => p.stat === 'rushYds' && p.player.espnId === HENRY);
  assert.ok(henry, 'Derrick Henry rushing yards ladder');
  assert.equal(henry.player.side, 'away');
  assert.equal(henry.player.depthRole, 'RB1');
  assert.equal(henry.player.injury, null, 'Henry has no injury designation');
  assert.equal(henry.fifty, 'safe');
  assert.ok(henry.dk && henry.dk.line > 50);
  assert.deepEqual(henry.moves, []);
  for (const p of S.props) assert.ok('depthRole' in p.player && 'injury' in p.player, `${p.player.name}: injury and depthRole attached`);
  assert.ok(S.fees.KXNFLRSHYDS && S.fees.KXNFLTEAMTOTAL, 'fees listed for prop and team total series');
  assert.equal(S.fees.KXNFLRSHYDS.assumed, true, 'no series info in this fixture: flagged as assumed');
});

test('injuries: league feed + depth charts replace the 5-per-team summaries; QB angle with Kalshi confirmation', () => {
  const g = game(S, BALATL);
  const lamar = g.injuries.away.find((x) => x.name === 'Lamar Jackson');
  assert.ok(lamar, 'Lamar listed');
  assert.equal(lamar.role, 'QB1');
  assert.equal(lamar.starter, true);
  assert.ok(['confirmed', 'likely'].includes(lamar.grade), lamar.grade);
  for (const x of [...g.injuries.home, ...g.injuries.away]) assert.ok(x.role && x.grade, `${x.name} graded`);
  const qb = g.angles.find((a) => a.kind === 'qb-out' && a.team === 'away');
  assert.ok(qb, 'qb-out angle for BAL');
  assert.ok(qb.beneficiaries.some((b) => /Huntley/.test(b.name)), 'backup QB named');
  assert.ok(qb.signals.some((x) => x.kind === 'kalshi' && /Huntley/.test(x.text)), 'Kalshi passing ladder names the backup');
  assert.equal(S.sources.injuries.notes[0].startsWith('NFL: ESPN league injuries feed'), true);
});

test('league injuries feed down: game summaries are the fallback list', () => {
  const inputs = phaseBInputs();
  inputs.injuryFeed.league = null;
  inputs.injuryFeed.errors = ['league injuries: HTTP 500'];
  const s = buildSnapshot(inputs, { now: NOW });
  assert.deepEqual(validateSnapshot(s), []);
  const g = game(s, BALATL);
  assert.equal(g.injuries.home.length, 5, 'summary list (5 per team)');
  assert.ok(g.injuries.away.some((x) => x.name === 'Lamar Jackson' && x.role === undefined));
  assert.equal(s.sources.injuries.ok, false);
  assert.ok(s.sources.injuries.notes.some((n) => /fall back to game summaries/.test(n)));
  assert.ok(s.props.every((p) => !('injury' in p.player)), 'no player.injury claims without the league feed');
});

test('defense and player contexts from nflverse, keyed by ESPN abbreviation', () => {
  assert.equal(Object.keys(S.defense.nfl).length, 32);
  for (const t of ['ATL', 'BAL', 'BUF', 'LAR']) {
    const d = S.defense.nfl[t];
    assert.ok(d && d.ranks && d.front && d.secondary, t);
    assert.ok(Array.isArray(d.secondary.corners));
  }
  assert.ok(!S.defense.nfl.LA, 'nflverse LA is filed under LAR');
  assert.ok(S.players[HENRY], 'Henry has a player context');
  assert.ok(S.players[HENRY].stats.rushYds.avg > 0);
  assert.ok(S.sources.nflverse.throughWeek >= 5);
  assert.ok(Object.keys(S.players).length >= 40);
});

test('team totals: Kalshi markets on BUF@LAR, DK team totals from propBets', () => {
  const g = game(S, BUFLAR);
  const tt = g.kalshi.markets.filter((m) => m.type === 'teamTotal');
  assert.ok(tt.length >= 10, `${tt.length} team total markets`);
  assert.equal(g.kalshi.teamTotalEvent, 'KXNFLTEAMTOTAL-26OCT12BUFLAR');
  assert.ok(tt.every((m) => (m.team === 'home') === m.ticker.includes('-LAR')));
  const types = g.kalshi.markets.map((m) => m.type);
  assert.deepEqual(types, [...types].sort((a, b) => ['game', 'spread', 'total', 'teamTotal'].indexOf(a) - ['game', 'spread', 'total', 'teamTotal'].indexOf(b)), 'teamTotal markets sort last');
  const withDk = S.games.filter((x) => x.dkTeamTotals);
  assert.ok(withDk.length >= 1);
  for (const x of withDk) for (const side of ['home', 'away']) if (x.dkTeamTotals[side]) assert.ok(Number.isFinite(x.dkTeamTotals[side].open));
  assert.equal(game(S, BALATL).kalshi.teamTotalEvent, null, 'no team total markets for BAL@ATL in this capture');
});

test('determinism: same inputs give the same snapshot and history', () => {
  const again = buildRun(phaseBInputs(), { now: NOW, version: 'test', runMs: 1 });
  assert.deepEqual(again.snapshot, S);
  assert.deepEqual(again.history, first.history);
  const txt = JSON.stringify(S);
  assert.ok(!/minutesAgo|ageSec|ageHours|newsAgeHours/.test(txt), 'no now-relative ages inside the snapshot');
});

test('moves across runs, then closes when the game kicks off', () => {
  // run 2, five minutes later: DK moved the BAL@ATL spread and Henry's rushing line
  const in2 = phaseBInputs();
  setSpread(in2, '401872993', -4.5);
  const henry1 = S.props.find((p) => p.stat === 'rushYds' && p.player.espnId === HENRY);
  setPropLine(in2, '401872993', HENRY, '12', henry1.dk.line - 5);
  in2.history = first.history;
  const t2 = NOW + 5 * MIN;
  const r2 = buildRun(in2, { now: t2 });
  assert.deepEqual(validateSnapshot(r2.snapshot), []);
  const g2 = game(r2.snapshot, BALATL);
  const at2 = new Date(t2).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.deepEqual(g2.moves.filter((m) => m.market === 'spread'), [{ market: 'spread', from: -3, to: -4.5, at: at2 }]);
  const h2 = r2.snapshot.props.find((p) => p.stat === 'rushYds' && p.player.espnId === HENRY);
  assert.deepEqual(h2.moves, [{ from: henry1.dk.line, to: henry1.dk.line - 5, at: at2 }]);
  assert.equal(r2.snapshot.sources.moves.since, first.history.at);
  assert.deepEqual(r2.closes, []);

  // run 3, after kickoff: BAL@ATL is 'in' -> its last pregame lines are the close
  const in3 = phaseBInputs();
  setSpread(in3, '401872993', -4.5);
  setPropLine(in3, '401872993', HENRY, '12', henry1.dk.line - 5);
  const ev = in3.espn.scoreboards.nfl[0].events.find((e) => e.id === '401872993');
  ev.status = { type: { state: 'in' } };
  ev.competitions[0].status = { type: { state: 'in' } };
  in3.history = r2.history;
  const r3 = buildRun(in3, { now: Date.parse('2026-10-12T00:40:00Z') });
  assert.deepEqual(validateSnapshot(r3.snapshot), []);
  const close = r3.closes.find((c) => c.gameId === BALATL);
  assert.ok(close, 'close captured at the pre to in flip');
  assert.equal(close.odds.spread.home, -4.5);
  assert.equal(close.lastPregameAt, at2);
  assert.ok(close.props.some((p) => p.player.espnId === HENRY && p.stat === 'rushYds' && p.dk.line === henry1.dk.line - 5));
  assert.ok(!r3.closes.some((c) => c.gameId === BUFLAR), 'BUF@LAR is still pregame');
  // the started game keeps its pregame moves for display; no new points are recorded while it is live
  assert.ok(game(r3.snapshot, BALATL).moves.some((m) => m.market === 'spread'));
  assert.equal(r3.snapshot.props.filter((p) => p.gameId === BALATL).length, 0, 'props are pregame only');
  // run 4: the flip is not reported twice
  const in4 = structuredClone(in3);
  in4.history = r3.history;
  assert.deepEqual(buildRun(in4, { now: Date.parse('2026-10-12T00:45:00Z') }).closes, []);
});

test('CFB: school names in shortName, defense.cfb for slate teams, QB-change angles', () => {
  const inputs = researchInputs();
  const qb = gz('cfb', 'cfb-qb-live-20261012.json.gz');
  inputs.cfb = {
    season: 2026, errors: [], requests: 0,
    defense: { fetchedAt: RESEARCH_NOW, dvp: gunzipSync(buf('cfb', 'cfb_defense_vs_position_2026.csv.gz')).toString('utf8'), byTeam: gz('cfb', 'cfb_byteam_trim.json.gz'), cached: false },
    qb: qb.qb,
  };
  const s = buildSnapshot(inputs, { now: RESEARCH_NOW });
  assert.deepEqual(validateSnapshot(s), []);
  const cfb = s.games.filter((g) => g.league === 'cfb');
  const wku = cfb.find((g) => g.home.abbr === 'WKU' || g.away.abbr === 'WKU');
  const side = wku.home.abbr === 'WKU' ? 'home' : 'away';
  assert.equal(wku[side].shortName, 'Western Kentucky', 'school name, not "Western KY" or "Hilltoppers"');
  for (const g of s.games.filter((x) => x.league === 'nfl')) assert.notEqual(g.home.shortName, g.home.name, 'NFL keeps the nickname');
  assert.ok(Object.keys(s.defense.cfb).length >= 100, `${Object.keys(s.defense.cfb).length} CFB teams`);
  assert.equal(s.sources.cfb.ok, true, s.sources.cfb.errors.join(' | '));
  for (const q of s.cfbQbChanges) {
    const g = s.games.find((x) => x.id === q.gameId);
    assert.ok(g.angles.some((a) => a.kind === 'cfb-qb-change' && a.team === q.team), q.note);
  }
  assert.ok(s.cfbQbChanges.length >= 1, 'the live capture flagged at least one QB change on this slate');
});

test('plausibility: prop rungs and team total markets with no price at all are flagged (props, teamTotals ok=false)', () => {
  const inp = phaseBInputs();
  const strip = (arr) => { for (const m of arr || []) for (const k of Object.keys(m)) if (k.endsWith('_dollars')) delete m[k]; };
  for (const arr of Object.values(inp.props.kalshi)) strip(arr);
  for (const arr of Object.values(inp.teamTotals.kalshi)) strip(arr);
  const s = buildSnapshot(inp, { now: NOW });
  const rungs = s.props.flatMap((p) => p.rungs).length;
  const tt = s.games.flatMap((g) => g.kalshi.markets.filter((m) => m.type === 'teamTotal')).length;
  assert.ok(rungs >= 10, `rungs ${rungs}`);
  assert.equal(s.sources.props.ok, false);
  assert.ok(s.sources.props.errors.includes(`${rungs} prop rungs but none has a price (Kalshi format change?)`), s.sources.props.errors.join(' | '));
  assert.ok(tt >= 10, `team total markets ${tt}`);
  assert.equal(s.sources.teamTotals.ok, false);
  assert.ok(s.sources.teamTotals.errors.includes(`${tt} team total markets but none has a price (Kalshi format change?)`), s.sources.teamTotals.errors.join(' | '));
  assert.equal(s.sources.kalshi.ok, true, 'core markets still priced');
});
