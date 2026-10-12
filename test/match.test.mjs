import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rd } from './helpers.mjs';
import { buildKalshiGames } from '../lib/kalshi.mjs';
import { matchGames, norm, etDate, teamScore } from '../lib/match.mjs';

const F = 'research-20261011';
const mk = (s) => rd(F, `kalshi_${s}.json`).markets;

// Same windows as the research run (code/test_matcher.mjs): NFL week 6 and CFB week 7 Kalshi date codes.
const RUNS = [
  { league: 'nfl', pre: 'KXNFL', espn: 'espn_nfl_w6.json', from: '2026-10-14', to: '2026-10-21', kalshi: 14, espnGames: 14, matched: 14, unmatchedKalshi: 0 },
  { league: 'cfb', pre: 'KXNCAAF', espn: 'espn_cfb_w7.json', from: '2026-10-12', to: '2026-10-19', kalshi: 116, espnGames: 62, matched: 62, unmatchedKalshi: 54 },
];

for (const r of RUNS) {
  test(`${r.league}: matcher reproduces ${r.matched}/${r.espnGames} from the research run`, () => {
    const kb = buildKalshiGames(mk(`${r.pre}GAME`), mk(`${r.pre}SPREAD`), mk(`${r.pre}TOTAL`));
    const week = [...kb.games.values()].filter((g) => g.dateKey >= r.from && g.dateKey < r.to);
    const events = rd(F, r.espn).events;
    assert.equal(week.length, r.kalshi, 'Kalshi games in the week window');
    assert.equal(events.length, r.espnGames, 'ESPN events');
    const m = matchGames(week, events, r.league);
    assert.equal(m.matches.size, r.matched);
    assert.equal(m.unmatchedEspn.length, 0);
    assert.equal(m.unmatchedKalshi.length, r.unmatchedKalshi);
    // Away+home order agreed with ESPN on every research game (no flips), and both sides really are the same teams.
    for (const [et, hit] of m.matches) {
      assert.equal(hit.flipped, false, `${et} flipped`);
      const kg = kb.games.get(et);
      const c = hit.espnEvent.competitions[0];
      const home = c.competitors.find((x) => x.homeAway === 'home').team;
      const away = c.competitors.find((x) => x.homeAway === 'away').team;
      assert.ok(teamScore(kg.home, home, r.league) >= 0.9, `${et} home ${kg.home.name} vs ${home.displayName}`);
      assert.ok(teamScore(kg.away, away, r.league) >= 0.9, `${et} away ${kg.away.name} vs ${away.displayName}`);
    }
  });
}

test('nfl: truncated Kalshi names match through the code fallback', () => {
  const kb = buildKalshiGames(mk('KXNFLGAME'), [], []);
  const m = matchGames([...kb.games.values()], rd(F, 'espn_nfl_w6.json').events, 'nfl');
  const lackc = m.matches.get('KXNFLGAME-26OCT18LACKC');
  assert.equal(lackc.espnEvent.shortName, 'LAC @ KC');
  assert.equal(lackc.score, 0.97);
  assert.equal(m.matches.get('KXNFLGAME-26OCT18NONYG').espnEvent.shortName, 'NO @ NYG');
});

test('cfb: placeholder Kalshi kickoffs still match (no kickoff-time window, ET date +/- 1 day)', () => {
  const kb = buildKalshiGames(mk('KXNCAAFGAME'), [], []);
  // Kalshi dates ARK@VAN on Oct 16; ESPN has it Oct 17 23:00Z (Oct 17 ET).
  const m = matchGames([...kb.games.values()], rd(F, 'espn_cfb_w7.json').events, 'cfb');
  const hit = m.matches.get('KXNCAAFGAME-26OCT16ARKVAN');
  assert.ok(hit, 'ARKVAN matched');
  assert.match(hit.espnEvent.date, /^2026-10-17/);
});

test('norm handles St., accents, punctuation', () => {
  assert.equal(norm('San Jose St.'), 'san jose state');
  assert.equal(norm('San José State'), 'san jose state');
  assert.equal(norm('Texas A&M'), 'texas a and m');
  assert.equal(norm('Miami (FL)'), 'miami fl');
});

test('etDate uses US/Eastern across the DST change', () => {
  assert.equal(etDate('2026-10-16T00:15:00Z'), '2026-10-15'); // Thursday night game, EDT
  assert.equal(etDate('2026-11-06T01:15:00Z'), '2026-11-05'); // after Nov 1, EST
  assert.equal(etDate('2026-11-06T05:30:00Z'), '2026-11-06');
});

test('matcher never pairs games more than one ET day apart', () => {
  const kg = [{ eventTicker: 'KXNFLGAME-26OCT01SEADEN', dateKey: '2026-10-01', away: { code: 'SEA', name: 'Seattle' }, home: { code: 'DEN', name: 'Denver' } }];
  const ev = rd(F, 'espn_nfl_w6.json').events.filter((e) => e.shortName === 'SEA @ DEN');
  assert.equal(ev.length, 1);
  assert.equal(matchGames(kg, ev, 'nfl').matches.size, 0);
});
