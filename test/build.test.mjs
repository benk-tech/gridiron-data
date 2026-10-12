import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchInputs, balatlInputs, RESEARCH_NOW, BALATL_NOW } from './helpers.mjs';
import { buildSnapshot, buildRun, summarize, WINDOW, PLAUSIBILITY } from '../lib/build.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { teamScore } from '../lib/match.mjs';
import { packSnapshot } from '../lib/ingest.mjs';

test('research capture -> valid snapshot v1 with 14 NFL + 62 FBS games, all matched', () => {
  const s = buildSnapshot(researchInputs(), { now: RESEARCH_NOW, version: 'test', runMs: 1234 });
  assert.deepEqual(validateSnapshot(s), []);
  assert.equal(s.v, 1);
  assert.equal(s.generatedAt, '2026-10-11T22:51:00Z');
  assert.deepEqual(s.collector, { version: 'test', runMs: 1234 });
  const sum = summarize(s);
  assert.equal(sum.byLeague.nfl.games, 14);
  assert.equal(sum.byLeague.cfb.games, 62);
  assert.equal(sum.byLeague.nfl.withKalshi, 14);
  assert.equal(sum.byLeague.cfb.withKalshi, 62);
  assert.equal(sum.byLeague.nfl.withOdds, 13, 'WSH @ SF had no DK line');
  assert.equal(sum.byLeague.cfb.withOdds, 58);
  assert.deepEqual(s.unmatched.espn, []);
  // Unmatched Kalshi: FCS games plus Kalshi games of weeks this capture had no ESPN board for. Never an FBS week-7 game.
  assert.ok(s.unmatched.kalshi.length >= 54);
  for (const k of ['sources', 'fees', 'games', 'props', 'defense', 'players', 'comboEligible', 'unmatched']) assert.ok(k in s, k);
  assert.ok(s.sources.kalshi.ok && s.sources.espnOdds.ok && s.sources.combos.ok && s.sources.fees.ok);
  assert.equal(s.sources.combos.collection, 'KXMVECROSSCATEGORY-R');
  assert.deepEqual(s.fees.KXNFLSPREAD, { feeType: 'quadratic_with_maker_fees', multiplier: 1 });
  // Phase B parts not in these inputs: empty, flagged 'not fetched' (test/integration.test.mjs covers them filled).
  assert.deepEqual(s.props, []);
  assert.deepEqual(s.defense, { nfl: {}, cfb: {} });
  assert.deepEqual(s.players, {});
  assert.deepEqual(s.cfbQbChanges, []);
  for (const k of ['props', 'nflverse', 'injuries', 'teamTotals', 'cfb']) { assert.equal(s.sources[k].ok, false, k); assert.deepEqual(s.sources[k].errors, ['not fetched'], k); }
  assert.equal(s.sources.moves.ok, true);
  assert.equal(s.sources.moves.since, null);
  for (const g of s.games) {
    assert.deepEqual(g.angles, []);
    assert.deepEqual(g.moves, []);
    assert.equal(g.dkTeamTotals, null);
    assert.equal(g.kalshi.teamTotalEvent, null);
  }
  // CFB team labels: the school (ESPN location), NFL keeps the nickname.
  const cfbGame = s.games.find((g) => g.league === 'cfb' && g.away.abbr === 'MSST');
  assert.equal(cfbGame?.away.shortName, 'Mississippi State');
  assert.equal(s.games.find((g) => g.league === 'cfb' && g.away.abbr === 'WKU')?.away.shortName, 'Western Kentucky');
  for (const g of s.games.filter((x) => x.league === 'nfl')) assert.equal(g.home.shortName, g.home.name.split(' ').pop(), g.home.name);
});

test('every spread market in the snapshot is on the right team (checked against ESPN names)', () => {
  const s = buildSnapshot(researchInputs(), { now: RESEARCH_NOW });
  let spreads = 0;
  for (const g of s.games) {
    for (const m of g.kalshi.markets) {
      if (m.type === 'total') { assert.equal(m.team, null); continue; }
      const team = g[m.team];
      const code = m.ticker.slice(m.event.length + 1).replace(/\d+$/, '');
      assert.equal(code, team.kalshiCode, `${m.ticker} code vs ${m.team}`);
      if (m.type === 'spread') {
        spreads++;
        const name = m.title.replace(/ wins by over .*$/, '');
        const espnTeam = { abbreviation: team.abbr, displayName: team.name, shortDisplayName: team.shortName, location: team.name };
        const other = g[m.team === 'home' ? 'away' : 'home'];
        const otherTeam = { abbreviation: other.abbr, displayName: other.name, shortDisplayName: other.shortName, location: other.name };
        const lg = g.league;
        assert.ok(teamScore({ code, name }, espnTeam, lg) >= teamScore({ code, name }, otherTeam, lg), `${m.ticker}: '${name}' closer to ${other.name} than ${team.name}`);
        assert.equal(m.event, g.kalshi.spreadEvent);
      }
    }
  }
  assert.ok(spreads > 1500, `spreads ${spreads}`);
});

test('combo eligibility is limited to events in the snapshot', () => {
  const s = buildSnapshot(researchInputs(), { now: RESEARCH_NOW });
  const events = new Set(s.games.flatMap((g) => [g.kalshi.gameEvent, g.kalshi.spreadEvent, g.kalshi.totalEvent]).filter(Boolean));
  assert.ok(s.comboEligible.length > 100);
  for (const e of s.comboEligible) assert.ok(events.has(e), e);
  assert.ok(s.comboEligible.includes('KXNFLSPREAD-26OCT15SEADEN'));
  assert.ok(!s.comboEligible.some((e) => e.startsWith('KXNFLSPREAD-26OCT18LACKC')), 'week 6 NFL ladders were mostly not eligible');
});

test('window: drops post games, keeps pre/in within -6 h .. +9 d', () => {
  const later = Date.parse(RESEARCH_NOW) + 5 * 86400e3; // Oct 16 22:51Z: early week-7 CFB and Thursday NFL games fall out
  const s = buildSnapshot(researchInputs(), { now: later });
  for (const g of s.games) {
    const k = Date.parse(g.kickoff);
    assert.ok(k >= later - WINDOW.behindMs && k <= later + WINDOW.aheadMs, g.id);
  }
  assert.ok(s.games.length < 76);
  // A game marked 'post' is never kept even when its kickoff is in the window.
  const inp = researchInputs();
  const ev = inp.espn.scoreboards.nfl[0].events[0];
  ev.status = { type: { state: 'post' } };
  const s2 = buildSnapshot(inp, { now: RESEARCH_NOW });
  assert.ok(!s2.games.some((g) => g.espnId === ev.id));
  assert.ok(!s2.unmatched.espn.includes(ev.id));
});

test('BAL @ ATL capture (2026-10-11T23:49Z)', () => {
  const s = buildSnapshot(balatlInputs(), { now: BALATL_NOW, version: 'fixture', leagues: ['nfl'] });
  assert.deepEqual(validateSnapshot(s), []);
  const g = s.games.find((x) => x.id === 'nfl-401872993');
  assert.ok(g);
  assert.equal(g.kickoff, '2026-10-12T00:20:00Z');
  assert.equal(g.state, 'pre');
  assert.equal(g.home.abbr, 'ATL');
  assert.equal(g.home.kalshiCode, 'ATL');
  assert.equal(g.away.kalshiCode, 'BAL');
  assert.equal(g.kalshi.gameEvent, 'KXNFLGAME-26OCT11BALATL');
  assert.equal(g.kalshi.spreadEvent, 'KXNFLSPREAD-26OCT11BALATL');
  assert.equal(g.kalshi.totalEvent, 'KXNFLTOTAL-26OCT11BALATL');
  assert.equal(g.kalshi.markets.filter((m) => m.type === 'game').length, 2);
  assert.equal(g.kalshi.markets.filter((m) => m.type === 'spread').length, 25);
  assert.equal(g.kalshi.markets.filter((m) => m.type === 'total').length, 19);
  const atl = g.kalshi.markets.find((m) => m.ticker === 'KXNFLGAME-26OCT11BALATL-ATL');
  assert.equal(atl.team, 'home');
  assert.equal(atl.yesAsk, 0.63);
  assert.equal(atl.yesBid, 0.62);
  const bal6 = g.kalshi.markets.find((m) => m.ticker === 'KXNFLSPREAD-26OCT11BALATL-BAL6');
  assert.equal(bal6.team, 'away');
  assert.equal(bal6.strike, 5.5);
  for (const m of g.kalshi.markets.filter((x) => x.type === 'spread')) {
    assert.equal(m.team, m.ticker.includes('-ATL') ? 'home' : 'away', m.ticker);
  }
  assert.deepEqual(g.odds.ml, { home: -175, away: 145, homeOpen: 180, awayOpen: -218 });
  assert.equal(g.odds.spread.home, -3);
  assert.equal(g.injuries.away.find((x) => x.name === 'Lamar Jackson').status, 'Out');
  assert.equal(g.injuries.home.length, 5);
  // BUF @ LAR (MNF) is in the window but the capture has no Kalshi events for it.
  const mnf = s.games.find((x) => x.id === 'nfl-401872994');
  assert.ok(mnf);
  assert.equal(mnf.kalshi.gameEvent, null);
  assert.deepEqual(mnf.kalshi.markets, []);
  assert.deepEqual(s.unmatched.espn, ['401872994']);
  assert.equal(s.games.length, 2, 'post games dropped');
  // Offline fixture: fees are defaults and flagged; the MNF summary was not captured.
  assert.deepEqual(s.fees.KXNFLGAME, { feeType: 'quadratic_with_maker_fees', multiplier: 1, assumed: true });
  assert.equal(s.sources.fees.ok, false);
  assert.equal(s.sources.espnOdds.ok, true, 'NFL-only snapshot does not expect a CFB board');
  assert.equal(s.sources.kalshi.ok, true);
  assert.ok(!('KXNCAAFGAME' in s.fees));
  assert.match(s.sources.injuries.errors.join(' '), /401872994/);
  assert.equal(s.sources.combos.ok, false);
  assert.deepEqual(s.comboEligible, []);
});

test('empty and partial inputs never throw and degrade to ok=false', () => {
  const s = buildSnapshot({}, { now: RESEARCH_NOW });
  assert.deepEqual(validateSnapshot(s), []);
  assert.deepEqual(s.games, []);
  for (const k of ['kalshi', 'espnOdds', 'injuries', 'props', 'nflverse', 'combos', 'fees']) assert.equal(s.sources[k].ok, false, k);
  // Kalshi down, ESPN up: games still listed with null Kalshi data.
  const inp = researchInputs();
  inp.kalshi = { fetchedAt: RESEARCH_NOW, requests: 2, errors: ['KXNFLGAME: HTTP 503'], markets: {} };
  const s2 = buildSnapshot(inp, { now: RESEARCH_NOW });
  assert.deepEqual(validateSnapshot(s2), []);
  assert.equal(s2.games.length, 76);
  assert.ok(s2.games.every((g) => g.kalshi.gameEvent === null));
  assert.equal(s2.sources.kalshi.ok, false);
  assert.match(s2.sources.kalshi.errors.join(' '), /HTTP 503/);
  // One CFB series missing: NFL is untouched, CFB games keep their GAME markets.
  const inp3 = researchInputs();
  delete inp3.kalshi.markets.KXNCAAFTOTAL;
  const s3 = buildSnapshot(inp3, { now: RESEARCH_NOW });
  assert.equal(s3.sources.kalshi.ok, false);
  assert.ok(s3.games.filter((g) => g.league === 'cfb').every((g) => g.kalshi.totalEvent === null));
  assert.ok(s3.games.some((g) => g.league === 'nfl' && g.kalshi.totalEvent));
});

test('deterministic and within the size target', () => {
  const a = JSON.stringify(buildSnapshot(researchInputs(), { now: RESEARCH_NOW }));
  const b = JSON.stringify(buildSnapshot(researchInputs(), { now: RESEARCH_NOW }));
  assert.equal(a, b);
  const p = packSnapshot(JSON.parse(a));
  assert.ok(p.gzBytes < 1.5 * 1024 * 1024, `gzip ${p.gzBytes}`);
});

test('neutral-site flip maps Kalshi teams onto ESPN home/away', () => {
  const inp = researchInputs();
  // Swap ESPN home/away for HOU vs JAX (the London game) and expect the market sides to follow ESPN.
  const ev = inp.espn.scoreboards.nfl[0].events.find((e) => /HOU/.test(e.shortName) && /JAX/.test(e.shortName));
  for (const c of ev.competitions[0].competitors) c.homeAway = c.homeAway === 'home' ? 'away' : 'home';
  const s = buildSnapshot(inp, { now: RESEARCH_NOW });
  const g = s.games.find((x) => x.espnId === ev.id);
  assert.equal(g.home.abbr, 'HOU');
  assert.equal(g.home.kalshiCode, 'HOU');
  assert.equal(g.away.kalshiCode, 'JAC');
  const houWin = g.kalshi.markets.find((m) => m.type === 'game' && m.ticker.endsWith('-HOU'));
  assert.equal(houWin.team, 'home');
  for (const m of g.kalshi.markets.filter((x) => x.type === 'spread')) assert.equal(m.team, /-HOU\d+$/.test(m.ticker) ? 'home' : 'away');
  assert.deepEqual(validateSnapshot(s), []);
});

test('a builder that throws costs only its own source (build failed, ok=false); the games and prices are still built', () => {
  const boom = (what) => { throw new Error(`boom ${what}`); };
  const inp = researchInputs();
  inp.props = { fetchedAt: RESEARCH_NOW, requests: 1, errors: [], espnProps: {}, kalshi: { get KXNFLRSHYDS() { return boom('props'); } } };
  inp.nflverse = { season: 2026, fetchedAt: RESEARCH_NOW, errors: [], get pbp() { return boom('nflverse'); } };
  inp.cfb = { season: 2026, errors: [], requests: 0, defense: { fetchedAt: RESEARCH_NOW, get dvp() { return boom('cfb'); } }, qb: null };
  inp.history = { v: 1, at: '2026-10-11T22:46:00Z', get games() { return boom('history'); }, props: {} };
  inp.teamTotals = { fetchedAt: RESEARCH_NOW, requests: 2, errors: [], kalshi: { get KXNFLTEAMTOTAL() { return boom('teamTotals'); } } };
  inp.injuryFeed = { leagueFetchedAt: RESEARCH_NOW, errors: [], requests: 1, depth: {}, schedule: [], league: { count: 1, get items() { return boom('injuries'); } } };
  const base = buildSnapshot(researchInputs(), { now: RESEARCH_NOW });
  let s;
  assert.doesNotThrow(() => { s = buildSnapshot(inp, { now: RESEARCH_NOW }); });
  assert.deepEqual(validateSnapshot(s), []);
  for (const [k, what] of [['props', 'props'], ['nflverse', 'nflverse'], ['cfb', 'cfb'], ['moves', 'history'], ['teamTotals', 'teamTotals'], ['injuries', 'injuries']]) {
    assert.equal(s.sources[k].ok, false, k);
    assert.ok(s.sources[k].errors.some((e) => e === `build failed: boom ${what}`), `${k}: ${s.sources[k].errors.join(' | ')}`);
  }
  assert.deepEqual(s.props, []);
  assert.ok(s.games.every((g) => Array.isArray(g.moves) && g.moves.length === 0));
  assert.equal(s.sources.kalshi.ok, true);
  assert.equal(s.sources.espnOdds.ok, true);
  assert.equal(s.games.length, 76);
  assert.deepEqual(s.games.map((g) => g.kalshi.markets), base.games.map((g) => g.kalshi.markets), 'core markets untouched');
});

// ---------------------------------------------------------------- plausibility: a fetch that worked but carries nothing usable

const allBoards = (inp) => [...inp.espn.scoreboards.nfl, ...inp.espn.scoreboards.cfb];

test('plausibility: ESPN boards that parse to nothing, or list no games in season, are flagged (espnOdds ok=false)', () => {
  const renamed = researchInputs();
  for (const b of allBoards(renamed)) for (const e of b.events) { e.contests = e.competitions; delete e.competitions; }
  const a = buildSnapshot(renamed, { now: RESEARCH_NOW });
  assert.equal(a.sources.espnOdds.ok, false);
  assert.ok(a.sources.espnOdds.errors.includes('nfl: 14 scoreboard events but none could be read (ESPN format change?)'), a.sources.espnOdds.errors.join(' | '));
  assert.ok(a.sources.espnOdds.errors.includes('cfb: 62 scoreboard events but none could be read (ESPN format change?)'));
  assert.equal(a.sources.kalshi.ok, true, 'Kalshi itself is fine');

  const empty = researchInputs();
  for (const b of allBoards(empty)) b.events = [];
  const b = buildSnapshot(empty, { now: RESEARCH_NOW });
  assert.equal(b.games.length, 0);
  assert.equal(b.sources.espnOdds.ok, false);
  assert.deepEqual(b.sources.espnOdds.errors, ['nfl: the current regular season week lists no games (ESPN outage?)', 'cfb: the current regular season week lists no games (ESPN outage?)']);

  const noList = researchInputs();
  delete noList.espn.scoreboards.nfl[0].events;
  assert.ok(buildSnapshot(noList, { now: RESEARCH_NOW }).sources.espnOdds.errors.includes('nfl: the scoreboard has no events list (ESPN format change?)'));

  // a couple of unreadable events among many: not flagged (one odd event is not a format change)
  const few = researchInputs();
  for (const e of few.espn.scoreboards.cfb[0].events.slice(0, 2)) delete e.competitions;
  const c = buildSnapshot(few, { now: RESEARCH_NOW });
  assert.equal(c.sources.espnOdds.ok, true, c.sources.espnOdds.errors.join(' | '));
  assert.equal(c.games.length, 74);

  // off-season (season type 4) with no events: nothing to flag
  const off = researchInputs();
  for (const b2 of allBoards(off)) { b2.events = []; b2.season = { type: 4, year: 2027 }; b2.leagues[0].season.type = { type: 4 }; }
  assert.equal(buildSnapshot(off, { now: RESEARCH_NOW }).sources.espnOdds.ok, true);
});

test('plausibility: Kalshi markets with no price at all, or no Kalshi game matching any ESPN game, are flagged (kalshi ok=false)', () => {
  const cents = researchInputs();
  for (const arr of Object.values(cents.kalshi.markets)) {
    for (const m of arr) for (const k of Object.keys(m)) if (k.endsWith('_dollars')) { m[k.replace('_dollars', '')] = Math.round(Number(m[k]) * 100); delete m[k]; }
  }
  const a = buildSnapshot(cents, { now: RESEARCH_NOW });
  assert.equal(a.sources.kalshi.ok, false);
  assert.ok(a.sources.kalshi.errors.includes('2725 markets on matched games but none has a price (Kalshi format change?)'), a.sources.kalshi.errors.join(' | '));
  assert.equal(a.sources.espnOdds.ok, true);

  // Kalshi game dates two days off on every NFL event: nothing matches although both sides list the week
  const shifted = researchInputs();
  const bump = (t) => String(t).replace(/-26OCT(\d\d)/, (_, d) => `-26OCT${String(Number(d) + 2).padStart(2, '0')}`);
  for (const s of ['KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL']) for (const m of shifted.kalshi.markets[s]) { m.ticker = bump(m.ticker); m.event_ticker = bump(m.event_ticker); }
  const b = buildSnapshot(shifted, { now: RESEARCH_NOW });
  assert.equal(b.sources.kalshi.ok, false);
  assert.ok(b.sources.kalshi.errors.some((e) => /^nfl: none of \d+ Kalshi games matched any of 14 ESPN games/.test(e)), b.sources.kalshi.errors.join(' | '));
  assert.ok(!b.sources.kalshi.errors.some((e) => /^cfb: none/.test(e)), 'CFB still matches');

  const base = buildSnapshot(researchInputs(), { now: RESEARCH_NOW });
  assert.equal(base.sources.kalshi.ok, true);
  assert.equal(base.sources.espnOdds.ok, true);
});

test('plausibility: the league injuries feed listing nobody while NFL games are in the window is flagged', () => {
  const inp = researchInputs();
  inp.injuryFeed = { league: { fetchedAt: RESEARCH_NOW, timestamp: RESEARCH_NOW, count: 0, items: [] }, depth: {}, schedule: [], leagueFetchedAt: RESEARCH_NOW, errors: [], requests: 1 };
  const s = buildSnapshot(inp, { now: RESEARCH_NOW });
  assert.equal(s.sources.injuries.ok, false);
  assert.ok(s.sources.injuries.errors.includes('league injuries feed lists no players while 14 NFL games are in the window (ESPN format change?)'), s.sources.injuries.errors.join(' | '));
  // no NFL games in the window (CFB only): an empty feed is not suspicious
  const cfbOnly = researchInputs();
  cfbOnly.injuryFeed = inp.injuryFeed;
  cfbOnly.espn.scoreboards.nfl = [];
  assert.ok(!buildSnapshot(cfbOnly, { now: RESEARCH_NOW }).sources.injuries.errors.some((e) => /lists no players/.test(e)));
});

test('cross-run: games the previous run listed as upcoming that vanish are flagged; an empty run after a full one is held', () => {
  const t0 = Date.parse(RESEARCH_NOW);
  const first = buildRun(researchInputs(), { now: t0 });
  assert.equal(first.hold, null);
  const prev = JSON.parse(JSON.stringify(first.history));
  const later = (min) => t0 + min * 60e3;

  // same boards 5 minutes later: nothing flagged
  const same = buildRun({ ...researchInputs(), history: prev }, { now: later(5) });
  assert.equal(same.snapshot.sources.espnOdds.ok, true, same.snapshot.sources.espnOdds.errors.join(' | '));
  assert.equal(same.hold, null);

  // the CFB board lost its events (and has no season type to go on): CFB flagged from the history alone, NFL fine, not held
  const cfbGone = researchInputs();
  cfbGone.espn.scoreboards.cfb = [{ events: [] }];
  const r1 = buildRun({ ...cfbGone, history: prev }, { now: later(5) });
  assert.equal(r1.snapshot.games.length, 14);
  assert.equal(r1.snapshot.sources.espnOdds.ok, false);
  assert.deepEqual(r1.snapshot.sources.espnOdds.errors, [`cfb: 62 of the 62 upcoming games listed in the previous run (${prev.at}) are missing from the scoreboards`]);
  assert.equal(r1.hold, null, 'NFL games are still there');

  // a few games gone (below vanishMin): not flagged
  const few = researchInputs();
  few.espn.scoreboards.nfl[0].events = few.espn.scoreboards.nfl[0].events.slice(PLAUSIBILITY.vanishMin - 1);
  assert.equal(buildRun({ ...few, history: prev }, { now: later(5) }).snapshot.sources.espnOdds.ok, true);

  // everything gone: held (the caller does not post it), and flagged
  const none = researchInputs();
  for (const b of allBoards(none)) b.events = [];
  const r2 = buildRun({ ...none, history: prev }, { now: later(5) });
  assert.equal(r2.snapshot.games.length, 0);
  assert.deepEqual(r2.hold, { reason: `no games in this run, but the previous run (${prev.at}) listed 76 upcoming games`, prevAt: prev.at, prevUpcoming: 76 });
  // Kalshi and ESPN both empty after a full run: held as well
  assert.ok(buildRun({ ...none, kalshi: { ...none.kalshi, markets: {} }, history: prev }, { now: later(5) }).hold);
  // the previous run is too old to compare with: not held (posted, flagged by the in-season check)
  const old = buildRun({ ...none, history: prev }, { now: t0 + PLAUSIBILITY.prevMaxAgeMs + 60e3 });
  assert.equal(old.hold, null);
  assert.equal(old.snapshot.sources.espnOdds.ok, false);
  // no history (first run): not held
  assert.equal(buildRun(none, { now: later(5) }).hold, null);
});
