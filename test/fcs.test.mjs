// Part B: FCS vs FCS games and CFB lookahead (lib/espn.mjs boards and divisions, lib/match.mjs aliases, lib/build.mjs
// part B games, lib/moves.mjs first lines, lib/closes.mjs closeRef). Offline.
//
// Fixtures (test/fixtures/fcs, scripts/make-fcs-fixtures.mjs): ESPN college boards captured 2026-10-13 19:44Z and
// trimmed with lib/espn.mjs trimBoard: groups=80 week 7 and 8, groups=81 week 7 and 8. The Kalshi side is the
// 2026-10-11 research capture (test/fixtures/research-20261011), which already lists the week 7 FCS games and most
// week 8 college games.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { FIX, rd, researchInputs, RESEARCH_NOW } from './helpers.mjs';
import { buildRun, buildSnapshot, summarize, WINDOW, LOOKAHEAD, previousUpcoming } from '../lib/build.mjs';
import { buildKalshiGames } from '../lib/kalshi.mjs';
import { matchGames, NAME_ALIAS, CODE_ALIAS } from '../lib/match.mjs';
import {
  teamDivision, gameClass, FBS_CONFERENCES, trimBoard, boardLiveSoon, fetchExtraBoards, scoreboardUrl, EXTRA_BOARDS, CFB_GROUPS,
} from '../lib/espn.mjs';
import { updateHistory, historyInput } from '../lib/moves.mjs';
import { closesFromTransition, closeRefsFor, closeRefOf, tickerEvent, CLOSE_REF_MAX_BYTES, formatClosesFile } from '../lib/closes.mjs';
import { settlePieces, withCloseRefs, settleHandshake, SETTLE_BODY_BUDGET, packSnapshot } from '../lib/ingest.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { createHttp } from '../lib/http.mjs';
import { KEY, fakeSite } from './fake-site.mjs';

const gz = (f) => JSON.parse(gunzipSync(readFileSync(join(FIX, 'fcs', f))).toString('utf8'));
const FBS7 = gz('espn-cfb-fbs-w7.json.gz');
const FBS8 = gz('espn-cfb-fbs-w8.json.gz');
const FCS7 = gz('espn-cfb-fcs-w7.json.gz');
const FCS8 = gz('espn-cfb-fcs-w8.json.gz');
const T = RESEARCH_NOW; // 2026-10-11T22:51:00Z: week 7 is inside the 9 day window, week 8 is 9 to 16 days out
const clone = (x) => JSON.parse(JSON.stringify(x));
const K = (s) => rd('research-20261011', `kalshi_${s}.json`).markets;

/** Research inputs with the 2026-10-13 FBS boards as the core college boards (they carry conference ids), plus part B. */
function partBInputs({ fcs = true, lookahead = true, fcsBoards = [FCS7, FCS8], laBoards = [], coreCfb = [FBS7, FBS8] } = {}) {
  const inputs = researchInputs();
  inputs.espn.scoreboards.cfb = clone(coreCfb);
  if (fcs) inputs.fcs = { fetchedAt: T, requests: fcsBoards.length, ms: 1, reused: 0, errors: [], boards: clone(fcsBoards), at: fcsBoards.map(() => T) };
  if (lookahead) inputs.lookahead = { fetchedAt: laBoards.length ? T : null, requests: laBoards.length, ms: 1, reused: 0, errors: [], boards: clone(laBoards), at: laBoards.map(() => T) };
  return inputs;
}
const coreOnly = (inputs) => { const c = { ...inputs }; delete c.fcs; delete c.lookahead; return c; };

// ---------------------------------------------------------------- matcher

test('matcher: 54 of 54 FCS vs FCS week 7 Kalshi games pair with the groups=81 board (53 without the Albany aliases)', () => {
  const kb = buildKalshiGames(K('KXNCAAFGAME'), K('KXNCAAFSPREAD'), K('KXNCAAFTOTAL'));
  const kg = [...kb.games.values()];
  const research = rd('research-20261011', 'espn_cfb_w7.json').events;
  const pass1 = matchGames(kg, research, 'cfb');
  assert.equal(pass1.matches.size, 62, 'the 62 FBS board games of week 7 (14/14 NFL, 62/62 FBS is the SPEC 8 regression)');
  const week7 = (k) => k.dateKey >= '2026-10-13' && k.dateKey <= '2026-10-18';
  const left = pass1.unmatchedKalshi.filter(week7);
  assert.equal(left.length, 54, 'Kalshi lists 54 FCS vs FCS games in week 7');
  const pass2 = matchGames(left, FCS7.events, 'cfb');
  assert.equal(pass2.matches.size, 54);
  assert.deepEqual(pass2.unmatchedKalshi, []);
  assert.ok([...pass2.matches.values()].every((m) => m.score >= 0.95), 'every pair scores 0.95 or more');
  const alb = pass2.matches.get('KXNCAAFGAME-26OCT17ALBYSTON');
  assert.equal(alb.espnEvent.id, '401866666');
  assert.equal(alb.espnEvent.shortName, 'ALB @ STBK');
  // without the aliases Albany at Stony Brook is the one miss (Kalshi 'University at Albany', ALBY; ESPN 'UAlbany', ALB)
  const name = NAME_ALIAS['university at albany'], code = CODE_ALIAS.CFB.ALBY;
  delete NAME_ALIAS['university at albany'];
  delete CODE_ALIAS.CFB.ALBY;
  try {
    const bare = matchGames(left, FCS7.events, 'cfb');
    assert.equal(bare.matches.size, 53);
    assert.deepEqual(bare.unmatchedKalshi.map((k) => k.eventTicker), ['KXNCAAFGAME-26OCT17ALBYSTON']);
  } finally {
    NAME_ALIAS['university at albany'] = name;
    CODE_ALIAS.CFB.ALBY = code;
  }
  // either alias alone is enough
  delete CODE_ALIAS.CFB.ALBY;
  try { assert.equal(matchGames(left, FCS7.events, 'cfb').matches.size, 54, 'name alias alone'); } finally { CODE_ALIAS.CFB.ALBY = code; }
});

test('matcher: every college game in the research Kalshi capture pairs once the FCS and week 8 boards are read (222 of 222)', () => {
  const kb = buildKalshiGames(K('KXNCAAFGAME'), K('KXNCAAFSPREAD'), K('KXNCAAFTOTAL'));
  const kg = [...kb.games.values()];
  assert.equal(kg.length, 222);
  const pass1 = matchGames(kg, [...FBS7.events, ...FBS8.events], 'cfb');
  const pass2 = matchGames(pass1.unmatchedKalshi, [...FCS7.events, ...FCS8.events].filter((e) => ![...FBS7.events, ...FBS8.events].some((f) => f.id === e.id)), 'cfb');
  assert.equal(pass1.matches.size + pass2.matches.size, 222);
  assert.ok(pass2.matches.has('KXNCAAFGAME-26OCT24ALBYURI'), 'Albany at Rhode Island (week 8) through the same alias');
});

// ---------------------------------------------------------------- divisions

test('divisions: FBS conference ids make fbs, any other conference fcs, none null; the class follows', () => {
  assert.deepEqual(FBS_CONFERENCES, ['1', '4', '5', '8', '9', '12', '15', '17', '18', '37', '151']);
  assert.equal(teamDivision({ conferenceId: '8' }), 'fbs');
  assert.equal(teamDivision({ conferenceId: 151 }), 'fbs');
  assert.equal(teamDivision({ conferenceId: '22' }), 'fcs');
  assert.equal(teamDivision({ conferenceId: null }), null);
  assert.equal(teamDivision({}), null);
  assert.equal(teamDivision(null), null);
  assert.equal(gameClass('fbs', 'fbs'), 'FF');
  assert.equal(gameClass('fcs', 'fbs'), 'FC');
  assert.equal(gameClass('fbs', 'fcs'), 'FC');
  assert.equal(gameClass('fcs', 'fcs'), 'CC');
  assert.equal(gameClass('fcs', null), null);
  // the captured boards: week 7 FBS 59 FF + 3 FC; week 7 FCS 55 CC + the same 3 FC + 1 game against a team with no conference
  const classes = (b) => {
    const out = {};
    for (const e of b.events) {
      const c = e.competitions[0].competitors;
      const k = gameClass(teamDivision(c[0].team), teamDivision(c[1].team)) ?? 'null';
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  };
  assert.deepEqual(classes(FBS7), { FF: 59, FC: 3 });
  assert.deepEqual(classes(FCS7), { CC: 55, FC: 3, null: 1 });
});

// ---------------------------------------------------------------- snapshot

test('buildSnapshot with part B: 54 FCS vs FCS games this week, 106 lookahead games next week, classes on every college game', () => {
  const s = buildSnapshot(partBInputs(), { now: T });
  assert.deepEqual(validateSnapshot(s), []);
  const cfb = s.games.filter((g) => g.league === 'cfb');
  const by = (f) => cfb.filter(f).length;
  assert.equal(by((g) => !g.lookahead && g.cls === 'FF'), 59);
  assert.equal(by((g) => !g.lookahead && g.cls === 'FC'), 3);
  assert.equal(by((g) => !g.lookahead && g.cls === 'CC'), 54);
  assert.equal(by((g) => g.lookahead && g.cls === 'FF'), 51);
  assert.equal(by((g) => g.lookahead && g.cls === 'CC'), 55);
  assert.equal(by((g) => g.lookahead), 106);
  assert.ok(cfb.every((g) => typeof g.cls === 'string' && g.home.division && g.away.division));
  assert.ok(s.games.filter((g) => g.league === 'nfl').every((g) => !('cls' in g) && !('division' in g.home) && !('lookahead' in g)));
  // FCS vs FCS: Kalshi winner markets, no sportsbook line, nothing from the core builders
  for (const g of cfb.filter((x) => x.cls === 'CC')) {
    assert.equal(g.home.division, 'fcs');
    assert.equal(g.away.division, 'fcs');
    assert.ok(g.kalshi.gameEvent);
    assert.equal(g.kalshi.markets.length, 2);
    assert.equal(g.odds, null, 'the FCS boards carry no DraftKings line 3 to 11 days out');
    assert.equal(g.refs, undefined);
    assert.deepEqual(g.angles, []);
  }
  // lookahead: 9 to 16 days out, winner markets only
  const now = Date.parse(T);
  for (const g of cfb.filter((x) => x.lookahead)) {
    const d = Date.parse(g.kickoff) - now;
    assert.ok(d > WINDOW.aheadMs && d <= LOOKAHEAD.aheadMs, `${g.id} ${g.kickoff}`);
    assert.ok(g.kalshi.markets.every((m) => m.type === 'game'));
    assert.equal(g.kalshi.spreadEvent, null);
    assert.equal(g.kalshi.totalEvent, null);
    assert.equal(g.state, 'pre');
  }
  const alb = s.games.filter((g) => g.kalshi.gameEvent?.includes('ALBY')).map((g) => [g.kalshi.gameEvent, g.away.shortName, g.home.shortName, !!g.lookahead]);
  assert.deepEqual(alb, [['KXNCAAFGAME-26OCT17ALBYSTON', 'UAlbany', 'Stony Brook', false], ['KXNCAAFGAME-26OCT24ALBYURI', 'UAlbany', 'Rhode Island', true]]);
  // every college Kalshi game is paired now; NFL leftovers are the capture's own
  assert.deepEqual(s.unmatched.kalshi.filter((t) => t.startsWith('KXNCAAF')), []);
  // part B games never make combo legs
  const partB = new Set(cfb.filter((g) => g.cls === 'CC' || g.lookahead).map((g) => g.kalshi.gameEvent));
  assert.ok(s.comboEligible.every((e) => !partB.has(e)));
  assert.equal(s.sources.fcs.ok, true, s.sources.fcs.errors.join(' | '));
  assert.equal(s.sources.fcs.games, 54);
  assert.equal(s.sources.fcs.lookaheadGames, 55);
  assert.equal(s.sources.lookahead.ok, true, s.sources.lookahead.errors.join(' | '));
  assert.equal(s.sources.lookahead.games, 106);
  assert.equal(s.sources.lookahead.windowDays, 16);
  const sum = summarize(s);
  assert.deepEqual(sum.classes, { FF: 110, FC: 3, CC: 109 });
  assert.equal(sum.lookahead, 106);
});

test('part B only adds: every core game, source and list is byte for byte the same; unmatched loses exactly the paired games', () => {
  const on = buildSnapshot(partBInputs(), { now: T });
  const off = buildSnapshot(coreOnly(partBInputs()), { now: T });
  // the line history also tracks the part B games (their first DK line and closes)
  const nB = on.games.filter((g) => g.cls === 'CC' || g.lookahead).length;
  assert.equal(on.sources.moves.games - off.sources.moves.games, nB);
  assert.ok(on.sources.moves.kalshiGames - off.sources.moves.kalshiGames <= nB);
  assert.equal(off.sources.fcs, undefined);
  assert.ok(off.games.every((g) => !('cls' in g) && !('lookahead' in g) && !('division' in g.home) && !('division' in g.away)));
  const strip = (s) => {
    const c = clone(s);
    c.games = c.games.filter((g) => g.cls !== 'CC' && !g.lookahead);
    for (const g of c.games) { delete g.cls; delete g.home.division; delete g.away.division; }
    delete c.sources.fcs;
    delete c.sources.lookahead;
    c.sources.moves.games = c.sources.moves.kalshiGames = null;
    c.unmatched = null;
    return JSON.stringify(c);
  };
  assert.equal(strip(on), strip(off));
  const offU = new Set(off.unmatched.kalshi), onU = new Set(on.unmatched.kalshi);
  const gone = [...offU].filter((t) => !onU.has(t));
  const partB = new Set(on.games.filter((g) => g.cls === 'CC' || g.lookahead).map((g) => g.kalshi.gameEvent));
  assert.ok(gone.length >= 54);
  assert.deepEqual(gone.filter((t) => !partB.has(t)), [], 'only games now in the snapshot leave the unmatched list');
  assert.deepEqual([...onU].filter((t) => !offU.has(t)), []);
  assert.deepEqual(on.unmatched.espn, off.unmatched.espn);
});

test('fcs only: FCS vs FCS games inside the 9 day window, no lookahead; lookahead only: no FCS vs FCS games', () => {
  const f = buildSnapshot(partBInputs({ lookahead: false, fcsBoards: [FCS7, FCS8] }), { now: T });
  assert.deepEqual(validateSnapshot(f), []);
  assert.equal(f.games.filter((g) => g.cls === 'CC').length, 54);
  assert.equal(f.games.filter((g) => g.lookahead).length, 0);
  assert.equal(f.sources.lookahead, undefined);
  // without lookahead the unmatched list keeps its old date range (through the day after the 9 day window)
  assert.ok(f.unmatched.kalshi.every((t) => !t.startsWith('KXNCAAF') || tickerEvent(t).dateKey <= '2026-10-21'));
  const l = buildSnapshot(partBInputs({ fcs: false }), { now: T });
  assert.deepEqual(validateSnapshot(l), []);
  assert.equal(l.games.filter((g) => g.cls === 'CC').length, 0);
  assert.equal(l.games.filter((g) => g.lookahead).length, 51, 'the FBS week 8 games Kalshi lists');
  assert.equal(l.sources.fcs, undefined);
  // the week after next comes from the lookahead board when the core next week board does not list it
  const w = buildSnapshot(partBInputs({ fcs: false, coreCfb: [FBS7], laBoards: [FBS8] }), { now: T });
  assert.equal(w.games.filter((g) => g.lookahead).length, 51);
  assert.equal(w.sources.lookahead.boards, 1);
});

test('part B fails open: a malformed or empty FCS board, or a crash, costs only its own games and source', () => {
  const good = buildSnapshot(coreOnly(partBInputs()), { now: T });
  const core = (s) => JSON.stringify(s.games.filter((g) => g.cls !== 'CC' && !g.lookahead).map((g) => { const c = clone(g); delete c.cls; delete c.home.division; delete c.away.division; return c; }));
  // no events list
  const a = buildSnapshot(partBInputs({ fcsBoards: [{ leagues: [], season: { type: 2 } }] }), { now: T });
  assert.equal(a.sources.fcs.ok, false);
  assert.match(a.sources.fcs.errors.join(' | '), /fcs: the scoreboard has no events list/);
  assert.equal(core(a), core(good));
  // an empty FCS week is not an outage (the FCS season ends a week before the FBS one): no games, no error
  const b = buildSnapshot(partBInputs({ lookahead: false, fcsBoards: [{ ...clone(FCS7), events: [] }] }), { now: T });
  assert.equal(b.sources.fcs.ok, true, b.sources.fcs.errors.join(' | '));
  assert.equal(b.games.filter((g) => g.cls === 'CC').length, 0);
  assert.equal(core(b), core(good));
  // a shape nobody has seen (competitors not a list): the part B build throws, core games unchanged
  const weird = clone(FCS7);
  weird.events[0].competitions[0].competitors = 5;
  const c = buildSnapshot(partBInputs({ fcsBoards: [weird] }), { now: T });
  assert.equal(c.sources.fcs.ok, false);
  assert.match(c.sources.fcs.errors.join(' | '), /build failed/);
  assert.equal(c.sources.lookahead.ok, false);
  assert.equal(c.games.filter((g) => g.cls === 'CC' || g.lookahead).length, 0);
  assert.equal(core(c), core(good));
  assert.equal(c.sources.espnOdds.ok, good.sources.espnOdds.ok, 'never the core ESPN source');
  // the FCS board renames every team (a format change): games listed, Kalshi games left over, none paired
  const renamed = clone(FCS7);
  renamed.events.forEach((e, i) => e.competitions[0].competitors.forEach((c, j) => {
    c.team = { ...c.team, location: `Q${i}x${j}`, name: 'Q', abbreviation: `Q${i}X${j}`, displayName: `Q${i}x${j} Q`, shortDisplayName: `Q${i}x${j}` };
  }));
  const d = buildSnapshot(partBInputs({ lookahead: false, fcsBoards: [renamed] }), { now: T });
  assert.equal(d.games.filter((g) => g.cls === 'CC').length, 0);
  assert.equal(d.sources.fcs.ok, false);
  assert.match(d.sources.fcs.errors.join(' | '), /fcs: none of \d+ Kalshi games left after the FBS match paired with any of \d+ games only the FCS boards list/);
});

// ---------------------------------------------------------------- history, first line, plausibility

test('history: part B games carry class, lookahead and events; a run without part B after one with it raises no ESPN flag', () => {
  const r1 = buildRun(partBInputs(), { now: T });
  const h = r1.history;
  const cc = Object.entries(h.games).filter(([, e]) => e.cls === 'CC');
  assert.equal(cc.length, 109);
  assert.equal(Object.values(h.games).filter((e) => e.lookahead === true).length, 106);
  assert.ok(Object.values(h.games).every((e) => Array.isArray(e.events)));
  assert.ok(Object.values(h.games).filter((e) => e.league === 'nfl').every((e) => !('cls' in e) && !('lookahead' in e)));
  const g = Object.values(h.games).find((e) => e.events.includes('KXNCAAFGAME-26OCT17ALBYSTON'));
  assert.equal(g.cls, 'CC');
  // the cross run checks leave part B games out, so --skip fcs,lookahead after a full run flags nothing
  const prev = previousUpcoming(h, Date.parse(T) + 5 * 60e3);
  assert.equal(prev.byLeague.cfb.size, 62, 'the core college games only');
  const r2 = buildRun({ ...coreOnly(partBInputs()), history: h }, { now: Date.parse(T) + 5 * 60e3 });
  assert.equal(r2.snapshot.sources.espnOdds.ok, true, r2.snapshot.sources.espnOdds.errors.join(' | '));
  assert.equal(r2.hold, null);
  // the next part B run does not see the core games as new: the lookahead flag clears once a game is inside the window
  const later = Date.parse(T) + 2 * 86400e3; // week 8 Tuesday games are now inside 9 days
  const r3 = buildRun({ ...partBInputs(), history: h }, { now: later });
  const inWindow = r3.snapshot.games.filter((x) => x.cls === 'FF' && !x.lookahead && x.week === 8);
  assert.ok(inWindow.length > 0);
  for (const x of inWindow) assert.equal(r3.history.games[x.id].lookahead, undefined, x.id);
});

test('first line: the first DK line the collector saw is kept through moves and the lookahead to window step, and closes carry it', () => {
  const now0 = Date.parse('2026-10-08T12:00:00Z');
  const base = { id: 'cfb-1', league: 'cfb', kickoff: '2026-10-24T19:30:00Z', home: { abbr: 'H' }, away: { abbr: 'A' }, cls: 'FF', kalshi: { gameEvent: 'KXNCAAFGAME-26OCT24AH', markets: [] } };
  const o = (sp) => ({ provider: 'DraftKings', fetchedAt: null, ml: null, spread: { home: sp, homeOdds: -110, awayOdds: -110, homeOpen: sp, homeOddsOpen: -110, awayOddsOpen: -110 }, total: null });
  let h = updateHistory(null, historyInput([{ ...base, state: 'pre', odds: null, lookahead: true }], []), { now: now0 }).history;
  assert.equal(h.games['cfb-1'].first, null, 'no line yet');
  assert.equal(h.games['cfb-1'].lookahead, true);
  h = updateHistory(h, historyInput([{ ...base, state: 'pre', odds: o(-6.5), lookahead: true }], []), { now: now0 + 3600e3 }).history;
  assert.deepEqual(h.games['cfb-1'].first, { at: '2026-10-08T13:00:00Z', odds: o(-6.5) });
  h = updateHistory(h, historyInput([{ ...base, state: 'pre', odds: o(-8) }], []), { now: now0 + 9 * 86400e3 }).history; // inside the window now
  assert.equal(h.games['cfb-1'].lookahead, undefined);
  assert.equal(h.games['cfb-1'].first.odds.spread.home, -6.5, 'never overwritten');
  // an old history file (no first, no events) loads; the first line starts from the next sighting
  const old = clone(h);
  delete old.games['cfb-1'].first;
  delete old.games['cfb-1'].events;
  const h2 = updateHistory(old, historyInput([{ ...base, state: 'pre', odds: o(-8.5) }], []), { now: now0 + 9 * 86400e3 + 300e3 }).history;
  assert.equal(h2.games['cfb-1'].first.odds.spread.home, -8.5);
  const kick = Date.parse(base.kickoff);
  const closes = closesFromTransition(h, [{ ...base, state: 'in', odds: o(-9) }], [], { now: kick + 60e3 });
  assert.equal(closes.length, 1);
  assert.deepEqual(closes[0].firstLine, { at: '2026-10-08T13:00:00Z', odds: o(-6.5) });
  assert.equal(closes[0].odds.spread.home, -8);
  assert.deepEqual(closes[0].events, ['KXNCAAFGAME-26OCT24AH']);
  assert.equal(closes[0].cls, 'FF');
  // an FCS vs FCS game with no DK line is archived too: odds and firstLine null
  const cc = { ...base, id: 'cfb-2', cls: 'CC', kalshi: { gameEvent: 'KXNCAAFGAME-26OCT24CCDD', markets: [] }, odds: null };
  const hc = updateHistory(null, historyInput([{ ...cc, state: 'pre' }], []), { now: kick - 600e3 }).history;
  const cl = closesFromTransition(hc, [{ ...cc, state: 'in' }], [], { now: kick + 60e3 });
  assert.equal(cl.length, 1);
  assert.equal(cl[0].odds, null);
  assert.equal(cl[0].firstLine, null);
  assert.equal(cl[0].cls, 'CC');
});

// ---------------------------------------------------------------- closeRef

const ODDS = {
  provider: 'DraftKings', fetchedAt: '2026-10-17T15:58:00Z',
  ml: { home: -1100, away: 700, homeOpen: -1000, awayOpen: 650 },
  spread: { home: -17.5, homeOdds: -110, awayOdds: -110, homeOpen: -16.5, homeOddsOpen: -110, awayOddsOpen: -110 },
  total: { line: 51.5, overOdds: -115, underOdds: -105, lineOpen: 50.5, overOddsOpen: -110, underOddsOpen: -110 },
};
const entry = (over = {}) => ({
  gameId: 'cfb-401866500', league: 'cfb', kickoff: '2026-10-17T19:30:00Z', home: 'TA&M', away: 'CIT', lastPregameAt: '2026-10-17T19:28:00Z',
  odds: ODDS, firstLine: { at: '2026-10-11T19:03:00Z', odds: { ...ODDS, fetchedAt: '2026-10-11T19:03:00Z' } }, dkTeamTotals: null, props: [],
  events: ['KXNCAAFGAME-26OCT17CITTXAM', 'KXNCAAFSPREAD-26OCT16CITTXAM', 'KXNCAAFTOTAL-26OCT17CITTXAM'], cls: 'FC', capturedAt: '2026-10-17T19:31:00Z', ...over,
});

test('closeRef: the game by event ticker (ladder events a day off included, props by teams part), staged copy first, at most 2048 bytes', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-ref-'));
  try {
    const staged = join(tmp, 'state', 'closes'), archive = join(tmp, 'closes');
    mkdirSync(staged, { recursive: true });
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(staged, '2026-10-17.json'), formatClosesFile({ date: '2026-10-17', games: [entry()] }));
    writeFileSync(join(archive, '2026-10-17.json'), formatClosesFile({ date: '2026-10-17', games: [entry({ odds: { ...ODDS, provider: 'Archive' } })] }));
    writeFileSync(join(archive, '2026-10-11.json'), formatClosesFile({ date: '2026-10-11', games: [
      { ...entry(), gameId: 'nfl-401872993', league: 'nfl', kickoff: '2026-10-11T17:00:00Z', events: ['KXNFLGAME-26OCT11BALATL', 'KXNFLSPREAD-26OCT11BALATL'], cls: undefined },
      { ...entry(), gameId: 'cfb-9', odds: null, events: ['KXNCAAFGAME-26OCT11AABB'] },
    ] }));
    const refs = await closeRefsFor([
      'KXNCAAFGAME-26OCT17CITTXAM-CIT', // exact event
      'KXNCAAFSPREAD-26OCT16CITTXAM-TXAM17', // the spread event dated a day earlier
      'KXNFLRSHYDS-26OCT11BALATL-BALDHENRY22-80', // a prop: same teams part
      'KXNCAAFGAME-26OCT11AABB-AA', // no DK line: no ref
      'KXNCAAFGAME-26OCT20XXYY-XX', // not archived
      'not a ticker',
    ], { dirs: [staged, archive] });
    assert.deepEqual([...refs.keys()], ['KXNCAAFGAME-26OCT17CITTXAM-CIT', 'KXNCAAFSPREAD-26OCT16CITTXAM-TXAM17', 'KXNFLRSHYDS-26OCT11BALATL-BALDHENRY22-80']);
    const r = refs.get('KXNCAAFGAME-26OCT17CITTXAM-CIT');
    assert.deepEqual(Object.keys(r), ['v', 'gameId', 'at', 'odds', 'firstLine']);
    assert.equal(r.odds.provider, 'DraftKings', 'the staged copy is read first');
    assert.equal(r.at, '2026-10-17T19:28:00Z');
    assert.equal(r.firstLine.at, '2026-10-11T19:03:00Z');
    assert.equal(refs.get('KXNFLRSHYDS-26OCT11BALATL-BALDHENRY22-80').gameId, 'nfl-401872993');
    // size: a full Odds close plus a full first line is far under the site's 2048 byte cap; an oversize ref drops its first line
    const bytes = Buffer.byteLength(JSON.stringify(r), 'utf8');
    assert.ok(bytes < CLOSE_REF_MAX_BYTES, `${bytes} bytes`);
    assert.equal(CLOSE_REF_MAX_BYTES, 2048);
    const big = closeRefOf(entry({ firstLine: { at: 'x', odds: { ...ODDS, note: 'y'.repeat(1500) } } }));
    assert.equal(big.firstLine, null);
    assert.equal(closeRefOf(entry({ odds: { ...ODDS, note: 'y'.repeat(2100) } })), null);
    assert.equal(closeRefOf(entry({ odds: null })), null);
    assert.deepEqual(tickerEvent('KXNCAAFSPREAD-26OCT16CITTXAM-TXAM17'), { event: 'KXNCAAFSPREAD-26OCT16CITTXAM', series: 'KXNCAAFSPREAD', dateKey: '2026-10-16', teamsPart: 'CITTXAM' });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle: result rows carry closeRef; bodies are split under the older site limit (256 KB), so 200 refs always go through', async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ ticker: `KXNCAAFGAME-26OCT17T${i}-A`, status: 'finalized', result: 'yes', settledAt: '2026-10-17T23:00:00Z', closeYes: 0.5, closeRef: { v: 1, gameId: 'x', at: 'y', odds: { pad: 'z'.repeat(1900) }, firstLine: null } }));
  const pieces = settlePieces(rows);
  assert.ok(pieces.length >= 2);
  assert.deepEqual(pieces.flat(), rows);
  for (const p of pieces) assert.ok(Buffer.byteLength(JSON.stringify({ results: p }), 'utf8') <= SETTLE_BODY_BUDGET);
  assert.deepEqual(settlePieces([]), []);
  // end to end against the local site: the archived game gives the ref; the return reports it
  const tmp = mkdtempSync(join(tmpdir(), 'gd-settle-'));
  const site = await fakeSite();
  try {
    mkdirSync(join(tmp, 'closes'), { recursive: true });
    writeFileSync(join(tmp, 'closes', '2026-10-17.json'), formatClosesFile({ date: '2026-10-17', games: [entry()] }));
    site.state.pending = ['KXNCAAFGAME-26OCT17CITTXAM-CIT', 'KXNCAAFGAME-26OCT17ZZYY-ZZ'];
    const kalshi = { get: async (path, q) => ({ cursor: '', markets: String(q.tickers).split(',').map((t) => ({ ticker: t, status: 'finalized', result: 'yes', settlement_ts: '2026-10-17T23:00:00Z' })) }) };
    const out = await settleHandshake({ url: site.url, key: KEY, kalshi, now: Date.parse('2026-10-18T00:00:00Z'), closeDirs: [null, join(tmp, 'closes')] });
    assert.deepEqual(out, { pending: 2, found: 2, settled: 2, refs: 1 });
    const body = site.state.settled[0].results;
    assert.deepEqual(body.find((r) => r.ticker === 'KXNCAAFGAME-26OCT17CITTXAM-CIT').closeRef.odds, ODDS);
    assert.equal(body.find((r) => r.ticker === 'KXNCAAFGAME-26OCT17ZZYY-ZZ').closeRef, undefined);
    const plain = await withCloseRefs(body.map(({ closeRef, ...r }) => r), []);
    assert.equal(plain.refs, 0, 'no close folders: rows as they were');
  } finally {
    site.server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- fetching the boards

function fakeEspn({ fail = () => false } = {}) {
  const calls = [];
  const boards = { '81:': FCS7, '81:8': FCS8, '81:9': { ...clone(FCS8), week: { number: 9 }, events: [] }, '80:9': { ...clone(FBS8), week: { number: 9 }, events: [] } };
  const f = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const key = `${u.searchParams.get('groups')}:${u.searchParams.get('week') || ''}`;
    if (fail(url)) return new Response('{}', { status: 503 });
    return boards[key] ? new Response(JSON.stringify(boards[key]), { status: 200 }) : new Response('{}', { status: 404 });
  };
  return { f, calls };
}
const http = (f) => createHttp({ fetchImpl: f, retries: 0 });

test('fetchExtraBoards: FCS default, next and week after, FBS week after; reused for 15 minutes unless a game is about to start', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-extra-'));
  try {
    const { f, calls } = fakeEspn();
    const now = Date.parse('2026-10-13T19:44:00Z');
    const run = (at, opts = {}) => fetchExtraBoards({ fcsHttp: http(f), laHttp: http(f), fcs: true, lookahead: true, fbsBoard: FBS7, now: at, stateDir: tmp, ...opts });
    const a = await run(now);
    assert.deepEqual(calls, [
      scoreboardUrl('cfb', { groups: CFB_GROUPS.fcs }),
      scoreboardUrl('cfb', { seasonType: 2, week: 8, groups: CFB_GROUPS.fcs }),
      scoreboardUrl('cfb', { seasonType: 2, week: 9, groups: CFB_GROUPS.fcs }),
      scoreboardUrl('cfb', { seasonType: 2, week: 9 }),
    ]);
    assert.match(calls[0], /groups=81&limit=300$/);
    assert.match(calls[3], /seasontype=2&week=9&groups=80&limit=300$/);
    assert.deepEqual([a.fcs.requests, a.fcs.reused, a.fcs.boards.length, a.lookahead.requests, a.lookahead.boards.length], [3, 0, 3, 1, 1]);
    assert.deepEqual(a.fcs.errors, []);
    assert.deepEqual(a.fcs.boards[0], trimBoard(FCS7), 'kept trimmed');
    assert.equal(a.fcs.fetchedAt, '2026-10-13T19:44:00Z');
    // 5 minutes later: everything reused, no request
    calls.length = 0;
    const b = await run(now + 5 * 60e3);
    assert.deepEqual(calls, []);
    assert.deepEqual([b.fcs.reused, b.lookahead.reused, b.fcs.fetchedAt], [3, 1, '2026-10-13T19:44:00Z']);
    // 15 minutes after the pull: pulled again
    const c = await run(now + EXTRA_BOARDS.reuseMs);
    assert.equal(c.fcs.requests + c.lookahead.requests, 4);
    // Saturday: a week 7 game kicks off within 20 minutes, so the default FCS board is pulled on every run
    const first = Date.parse('2026-10-16T23:00:00Z'); // Columbia at Penn
    await run(first - 25 * 60e3);
    calls.length = 0;
    const d = await run(first - 15 * 60e3); // 10 minutes later: the other boards are reused
    assert.deepEqual(calls, [scoreboardUrl('cfb', { groups: CFB_GROUPS.fcs })], 'only the board with the game');
    assert.equal(d.fcs.reused, 2);
    assert.equal(boardLiveSoon(FCS7, first - 15 * 60e3), true);
    assert.equal(boardLiveSoon(FCS7, first - 25 * 60e3), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchExtraBoards: a failed pull reuses a copy up to an hour old (with an error); none saved: an error and no board', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-extra-'));
  try {
    const now = Date.parse('2026-10-13T19:44:00Z');
    const ok = fakeEspn();
    await fetchExtraBoards({ fcsHttp: http(ok.f), laHttp: http(ok.f), fcs: true, lookahead: false, fbsBoard: FBS7, now, stateDir: tmp });
    const down = fakeEspn({ fail: () => true });
    const a = await fetchExtraBoards({ fcsHttp: http(down.f), laHttp: http(down.f), fcs: true, lookahead: false, fbsBoard: FBS7, now: now + 30 * 60e3, stateDir: tmp });
    assert.equal(a.fcs.boards.length, 2);
    assert.equal(a.fcs.reused, 2);
    assert.match(a.fcs.errors[0], /fcs:cur: .*HTTP 503; reused the copy from 2026-10-13T19:44:00Z/);
    const b = await fetchExtraBoards({ fcsHttp: http(down.f), laHttp: http(down.f), fcs: true, lookahead: false, fbsBoard: FBS7, now: now + 2 * 3600e3, stateDir: tmp });
    assert.equal(b.fcs.boards.length, 0);
    assert.match(b.fcs.errors[0], /fcs:cur: .*HTTP 503$/);
    // lookahead with no FBS default board counts from the FCS board; with neither it says so
    const c = await fetchExtraBoards({ fcsHttp: http(ok.f), laHttp: http(ok.f), fcs: true, lookahead: true, fbsBoard: null, now, stateDir: null });
    assert.equal(c.lookahead.boards.length, 1);
    const d = await fetchExtraBoards({ fcsHttp: http(ok.f), laHttp: http(ok.f), fcs: false, lookahead: true, fbsBoard: null, now, stateDir: null });
    assert.match(d.lookahead.errors[0], /no current college week to count from/);
    assert.equal(d.fcs, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- size

test('size: the research snapshot with this week\'s FCS games and 16 days of lookahead stays far under 1 MB gzipped', (t) => {
  const off = packSnapshot(buildSnapshot(coreOnly(partBInputs()), { now: T }));
  const on = packSnapshot(buildSnapshot(partBInputs(), { now: T }));
  // a synthetic second lookahead week (the week 8 games again, a week later), the most a 16 day window can hold
  const shift = (b, days, id) => ({ ...clone(b), events: clone(b.events).map((e) => {
    const d = (x) => new Date(Date.parse(x) + days * 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
    e.id = `${id}${e.id}`; e.date = d(e.date); e.competitions[0].date = d(e.competitions[0].date); return e;
  }) });
  const inputs = partBInputs({ fcsBoards: [FCS7, FCS8, shift(FCS8, 7, '9')], laBoards: [shift(FBS8, 7, '8')] });
  const kal = inputs.kalshi.markets.KXNCAAFGAME;
  const later = kal.filter((m) => /-26OCT2[34]/.test(m.event_ticker)).map((m) => {
    const bump = (s) => s.replace(/26OCT(\d{2})/, (_, dd) => `26OCT${Number(dd) + 7}`);
    return { ...m, ticker: bump(m.ticker), event_ticker: bump(m.event_ticker) };
  });
  inputs.kalshi.markets.KXNCAAFGAME = [...kal, ...later];
  // Thursday of week 7: this week's games, next week's inside the 9 day window, the synthetic week as lookahead
  const bigSnap = buildSnapshot(inputs, { now: Date.parse(T) + 4 * 86400e3 });
  assert.deepEqual(validateSnapshot(bigSnap), []);
  const nLook = bigSnap.games.filter((g) => g.lookahead).length;
  assert.ok(nLook >= 80, `${nLook} lookahead games`);
  const big = packSnapshot(bigSnap);
  assert.ok(on.gzBytes - off.gzBytes < 60 * 1024, `part B adds ${Math.round((on.gzBytes - off.gzBytes) / 1024)} KB gzipped`);
  assert.ok(big.gzBytes < 1024 * 1024, `${Math.round(big.gzBytes / 1024)} KB gzipped`);
  t.diagnostic(`research snapshot ${Math.round(off.gzBytes / 1024)} KB gz without part B, ${Math.round(on.gzBytes / 1024)} KB gz with it (+${Math.round((on.gzBytes - off.gzBytes) / 1024)} KB, ${Math.round((on.rawBytes - off.rawBytes) / 1024)} KB raw); 4 days later with a synthetic third week (${nLook} lookahead games, ${bigSnap.games.length} games) ${Math.round(big.gzBytes / 1024)} KB gz`);
});

// ---------------------------------------------------------------- collectInputs

test('collectInputs: fcs and lookahead are opt-in; lookahead widens the close window of KXNCAAFGAME only (16 days of kickoffs)', async () => {
  const { collectInputs } = await import('../lib/sources.mjs');
  const calls = [];
  const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
  const f = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname.includes('kalshi.com')) {
      if (u.pathname.endsWith('/markets')) return ok({ cursor: '', markets: [] });
      if (u.pathname.endsWith('/multivariate_event_collections')) return ok({ cursor: '', multivariate_contracts: [] });
      return ok({ series: { ticker: 'X', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 } });
    }
    if (u.hostname === 'site.api.espn.com' && u.pathname.endsWith('/scoreboard')) {
      const key = `${u.searchParams.get('groups') || ''}:${u.searchParams.get('week') || ''}`;
      const b = { '80:': FBS7, '81:': FCS7, '81:8': FCS8, '80:8': FBS8 }[key] || (u.pathname.includes('/nfl/') ? rd('research-20261011', 'espn_nfl_w6.json') : { events: [] });
      return ok(b);
    }
    return new Response('?', { status: 404 });
  };
  const now = Date.parse('2026-10-13T19:44:00Z');
  const parts = { props: false, teamTotals: false, injuries: false, nflverse: false, cfb: false };
  const closeTs = (series) => Number(new URL(calls.find((u) => u.includes(`series_ticker=${series}&`) || u.endsWith(`series_ticker=${series}`))).searchParams.get('max_close_ts'));
  const off = await collectInputs({ now, fetchImpl: f, pauseMs: 0, parts });
  assert.equal(off.fcs, undefined);
  assert.equal(off.lookahead, undefined);
  assert.ok(!calls.some((u) => /groups=81/.test(u)), 'no FCS board unless asked');
  assert.equal(closeTs('KXNCAAFGAME'), Math.floor((now + 12 * 86400e3) / 1000));
  calls.length = 0;
  const on = await collectInputs({ now, fetchImpl: f, pauseMs: 0, parts: { ...parts, fcs: true, lookahead: true } });
  assert.equal(closeTs('KXNCAAFGAME'), Math.floor((now + 19 * 86400e3) / 1000), '16 days of kickoffs + 48 h to close + 1 day of slack');
  for (const s of ['KXNCAAFSPREAD', 'KXNCAAFTOTAL', 'KXNFLGAME']) assert.equal(closeTs(s), Math.floor((now + 12 * 86400e3) / 1000), s);
  assert.deepEqual([on.fcs.boards.length, on.lookahead.boards.length], [3, 1]);
  assert.deepEqual([on.stats.bySource.fcs.requests, on.stats.bySource.lookahead.requests], [3, 1]);
  assert.ok(calls.some((u) => /seasontype=2&week=9&groups=80/.test(u)), 'the FBS week after next');
  assert.ok(on.stats.espnRequests >= off.stats.espnRequests + 4);
});
