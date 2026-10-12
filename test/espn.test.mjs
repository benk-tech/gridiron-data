import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rd } from './helpers.mjs';
import { createHttp } from '../lib/http.mjs';
import {
  parseAmerican, parseLine, iso, nextWeek, parseOdds, parseTeam, parseWeather, parseScoreboardEvents,
  parseSummaryInjuries, fetchScoreboards, scoreboardUrl, summaryUrl,
} from '../lib/espn.mjs';

test('parseAmerican / parseLine', () => {
  assert.equal(parseAmerican('-135'), -135);
  assert.equal(parseAmerican('+114'), 114);
  assert.equal(parseAmerican('EVEN'), 100);
  assert.equal(parseAmerican('OFF'), null);
  assert.equal(parseAmerican(''), null);
  assert.equal(parseAmerican('50'), null);
  assert.equal(parseAmerican(-110), -110);
  assert.equal(parseLine('+2.5'), 2.5);
  assert.equal(parseLine('-3'), -3);
  assert.equal(parseLine('o41.5'), 41.5);
  assert.equal(parseLine('u41.5'), 41.5);
  assert.equal(parseLine('PK'), 0);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('abc'), null);
  assert.equal(iso('2026-10-12T00:20Z'), '2026-10-12T00:20:00Z');
  assert.equal(iso('garbage'), null);
});

test('BAL @ ATL odds parse to the SPEC Odds shape (current and open)', () => {
  const ev = rd('balatl-20261011', 'espn_scoreboard.json').events.find((e) => e.id === '401872993');
  const o = parseOdds(ev.competitions[0], '2026-10-11T23:49:00Z');
  assert.deepEqual(o, {
    provider: 'DraftKings',
    fetchedAt: '2026-10-11T23:49:00Z',
    ml: { home: -175, away: 145, homeOpen: 180, awayOpen: -218 },
    spread: { home: -3, homeOdds: -120, awayOdds: 100, homeOpen: 4.5, homeOddsOpen: -110, awayOddsOpen: -110 },
    total: o.total,
  });
  assert.equal(o.total.line, 43.5);
  for (const k of ['overOdds', 'underOdds', 'lineOpen', 'overOddsOpen', 'underOddsOpen']) assert.equal(typeof o.total[k], 'number', k);
});

test("'OFF' juice becomes null on that side only; no odds object -> null", () => {
  const cfb = rd('research-20261011', 'espn_cfb_w7.json');
  const ukou = cfb.events.find((e) => e.id === '401856722');
  const o = parseOdds(ukou.competitions[0], null);
  assert.equal(o.spread.home, -6.5);
  assert.equal(o.spread.homeOdds, null);
  assert.equal(o.spread.awayOdds, -112);
  assert.equal(o.ml.home, -250);
  const none = cfb.events.find((e) => e.shortName === 'CHSO @ CLEM');
  assert.equal(parseOdds(none.competitions[0], null), null);
  // Live-odds provider is never used for pregame values.
  assert.equal(parseOdds({ odds: [{ provider: { id: '200', name: 'DraftKings - Live Odds' }, moneyline: { home: { close: { odds: '-110' } } } }] }), null);
});

test('teams, weather, events', () => {
  const sb = rd('balatl-20261011', 'espn_scoreboard.json');
  const events = parseScoreboardEvents([sb, sb], 'nfl');
  assert.equal(events.length, sb.events.length, 'deduped across boards');
  const e = events.find((x) => x.id === '401872993');
  assert.equal(e.kickoff, '2026-10-12T00:20:00Z');
  assert.equal(e.state, 'pre');
  assert.equal(e.week, 5);
  assert.equal(e.season, 2026);
  assert.equal(e.seasonType, 2);
  assert.deepEqual(parseTeam(e.homeComp), { abbr: 'ATL', name: 'Atlanta Falcons', shortName: 'Falcons', espnId: '1', kalshiCode: null, logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/atl.png', record: '2-2' });
  assert.deepEqual(parseWeather(e.raw, e.comp), { tempF: 65, condition: 'Mostly clear', windMph: null, indoor: true });
  assert.equal(parseWeather({}, {}), null);
});

test('summary injuries -> Injury shape keyed by ESPN team id', () => {
  const m = parseSummaryInjuries(rd('balatl-20261011', 'espn_summary.json'));
  assert.deepEqual([...m.keys()].sort(), ['1', '33']);
  const lamar = m.get('33').find((x) => x.name === 'Lamar Jackson');
  assert.deepEqual(lamar, { espnId: lamar.espnId, name: 'Lamar Jackson', pos: 'QB', status: 'Out', detail: 'Ankle, Sprain', starter: null, depthRank: null, updated: lamar.updated });
  assert.match(lamar.updated, /^2026-10-1\dT\d\d:\d\d:00Z$/);
  const rush = m.get('1').find((x) => x.name === 'Cooper Rush');
  assert.equal(rush.detail, "Coach's Decision");
  assert.equal(parseSummaryInjuries({}).size, 0);
  const ir = parseSummaryInjuries({ injuries: [{ team: { id: '9' }, injuries: [{ status: 'Injured Reserve', athlete: { id: 1, displayName: 'X' } }] }] });
  assert.equal(ir.get('9')[0].status, 'IR');
});

test('nextWeek follows the calendar (NFL 5 -> 6, CFB regular season end -> postseason)', () => {
  const nfl = rd('research-20261011', 'espn_nfl_w6.json').leagues[0].calendar;
  assert.deepEqual(nextWeek(nfl, 2, 5), { seasonType: 2, week: 6 });
  assert.deepEqual(nextWeek(nfl, 2, 18), { seasonType: 3, week: 1 });
  const cfb = rd('research-20261011', 'espn_cfb_w7.json').leagues[0].calendar;
  assert.deepEqual(nextWeek(cfb, 2, 7), { seasonType: 2, week: 8 });
  assert.equal(nextWeek(cfb, 2, 15)?.seasonType, 3);
  assert.deepEqual(nextWeek(undefined, 2, 5), { seasonType: 2, week: 6 });
});

test('fetchScoreboards: default board then next week from the calendar (2 requests per league)', async () => {
  const sb = rd('balatl-20261011', 'espn_scoreboard.json');
  const calls = [];
  const f = async (u) => {
    calls.push(u);
    return new Response(JSON.stringify(new URL(u).searchParams.get('week') ? { events: [] } : sb), { status: 200 });
  };
  const r = await fetchScoreboards(createHttp({ fetchImpl: f }), 'cfb');
  assert.equal(r.boards.length, 2);
  assert.deepEqual(r.errors, []);
  assert.equal(calls[0], scoreboardUrl('cfb'));
  assert.match(calls[0], /groups=80/);
  assert.match(calls[0], /limit=300/);
  assert.match(calls[1], /seasontype=2&week=6&groups=80&limit=300/);
  assert.equal(summaryUrl('nfl', '401872993'), 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872993');
});

test('fetchScoreboards: a failed default board is an error, not a throw', async () => {
  const f = async () => new Response('nope', { status: 500 });
  const r = await fetchScoreboards(createHttp({ fetchImpl: f, retries: 1, retryDelayMs: 1 }), 'nfl');
  assert.equal(r.boards.length, 0);
  assert.match(r.errors[0], /HTTP 500/);
});
