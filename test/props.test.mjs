import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rd } from './helpers.mjs';
import { buildIdBridge } from '../lib/glue.mjs';
import {
  PROP_SERIES, PROP_SERIES_LIST, fiftyFiftyClass, parseKalshiPlayer, normalizeEspnProps, slimPropItem,
  buildProps, fetchPropInputs, kalshiGameIndex,
} from '../lib/props.mjs';

const P = 'props';
const clone = (x) => JSON.parse(JSON.stringify(x));
const GAMES = rd(P, 'games.json').games;
const BRIDGE = buildIdBridge(rd(P, 'roster-weekly-bridge.json'));
const ROSTERS = rd(P, 'espn-rosters.json').rosters;
const BUFLAR = { kalshi: rd(P, 'kalshi-buflar-0017z.json').markets, espnProps: { 401872994: rd(P, 'espn-propbets-401872994.json').items }, errors: [] };
const BALATL = { kalshi: rd(P, 'kalshi-balatl-2357z.json').markets, espnProps: { 401872993: rd(P, 'espn-propbets-401872993.json').items }, errors: [] };
const ofGame = (r, espnId) => r.props.filter((p) => p.gameId === `nfl-${espnId}`);
const find = (r, stat, re) => r.props.find((p) => p.stat === stat && re.test(p.player.name));

test('PROP_SERIES: 15 NFL series with SPEC 10.1 stat names', () => {
  assert.equal(PROP_SERIES_LIST.length, 15);
  const stats = new Set(Object.values(PROP_SERIES).map((c) => c.stat));
  for (const s of ['passYds', 'rushYds', 'recYds', 'rushRecYds', 'rec', 'passTd', 'passInt', 'passAtt', 'passComp', 'rushAtt', 'longRec', 'longRush', 'anyTd', 'firstTd', 'ffpts']) {
    assert.ok(stats.has(s), s);
  }
});

test('fiftyFiftyClass: safe only for yardage and attempt lines the research backs', () => {
  assert.equal(fiftyFiftyClass('passYds', 180.5), 'safe');
  assert.equal(fiftyFiftyClass('rushYds', 80.5), 'safe');
  assert.equal(fiftyFiftyClass('recYds', 9.5), 'unsafe');
  assert.equal(fiftyFiftyClass('rushRecYds', 24.5), 'caution');
  assert.equal(fiftyFiftyClass('rushAtt', 14.5), 'safe');
  assert.equal(fiftyFiftyClass('rec', 1.5), 'unsafe');
  assert.equal(fiftyFiftyClass('rec', 4.5), 'caution');
  assert.equal(fiftyFiftyClass('passTd', 1.5), 'unsafe');
  assert.equal(fiftyFiftyClass('longRec', 17.5), 'caution');
  assert.equal(fiftyFiftyClass('rushYds', null), 'unsafe');
  assert.equal(fiftyFiftyClass('anyTd', 0.5), 'unsafe');
});

test('parseKalshiPlayer: team code, name key, jersey; D/ST and No Touchdown are team level', () => {
  const m = (ticker, sub) => ({ ticker, event_ticker: ticker.split('-').slice(0, 2).join('-'), yes_sub_title: sub });
  assert.deepEqual(
    (({ team, key, jersey, name, nameCheck }) => ({ team, key, jersey, name, nameCheck }))(parseKalshiPlayer(m('KXNFLRECYDS-26OCT12BUFLAR-LARPNACUA12-40', 'Puka Nacua: 40+'), ['BUF', 'LAR'])),
    { team: 'LAR', key: 'PNACUA', jersey: '12', name: 'Puka Nacua', nameCheck: true });
  const jc = parseKalshiPlayer(m('KXNFLRSHYDS-26OCT18HOUJAC-JACTETIENNE1-60', 'Travis Etienne Jr.: 60+'), ['HOU', 'JAC']);
  assert.equal(jc.team, 'JAC');
  assert.equal(jc.key, 'TETIENNE');
  assert.equal(parseKalshiPlayer(m('KXNFLFIRSTTD-26OCT15SEADEN-SEASEADST', 'SEA Seahawks D/ST'), ['SEA', 'DEN']).isDST, true);
  assert.equal(parseKalshiPlayer({ ticker: 'KXNFLFIRSTTD-26OCT15SEADEN-SEANO-TD', event_ticker: 'KXNFLFIRSTTD-26OCT15SEADEN', yes_sub_title: 'No Touchdown' }, ['SEA', 'DEN']).isNoTD, true);
  const ft = parseKalshiPlayer(m('KXNFLFIRSTTD-26OCT11BALATL-ATLKPITTS8', 'Kyle Pitts'), ['BAL', 'ATL']);
  assert.deepEqual([ft.team, ft.key, ft.jersey], ['ATL', 'KPITTS', '8']);
});

test('normalizeEspnProps: drops milestones and team items, dedupes over/under duplicates', () => {
  const items = [
    { athlete: { $ref: 'athletes/1' }, type: { id: '12', name: 'Total Rushing Yards' }, current: { target: { value: 80.5 } }, open: { target: { value: 86.5 } }, lastUpdated: '2026-10-12T02:10Z' },
    { athlete: { $ref: 'http://x/athletes/1?lang=en' }, type: { id: '12', name: 'Total Rushing Yards' }, current: { target: { value: 81.5 } }, open: { target: { value: 86.5 } }, lastUpdated: '2026-10-12T02:16Z' },
    { athlete: { $ref: 'athletes/1' }, type: { id: '196', name: 'Rushing Yards Milestones' }, current: { target: { value: 90 } }, open: { target: { value: 90 } } },
    { team: { $ref: 'teams/33' }, type: { id: '98', name: 'Team Total Points' }, current: { target: { value: 20.5 } }, open: { target: { value: 24.5 } } },
  ];
  const { lines, stats } = normalizeEspnProps(items);
  assert.equal(lines.size, 1);
  assert.deepEqual(lines.get('1|12'), { aid: '1', type: '12', line: 81.5, open: 86.5, lu: '2026-10-12T02:16Z' });
  assert.equal(stats.milestones, 1);
  assert.equal(stats.teamItems, 1);
  assert.equal(stats.conflicts, 1);
  assert.equal(slimPropItem(items[2]), null);
  assert.deepEqual(slimPropItem(items[1]).athlete, { $ref: 'athletes/1' });
});

test('BUF@LAR (critic capture 2026-10-12 00:17Z): 126/126 ladders join, through the bridge and through rosters alike', () => {
  const both = buildProps(BUFLAR, { games: GAMES, bridge: BRIDGE, rosters: ROSTERS });
  const bridgeOnly = buildProps(BUFLAR, { games: GAMES, bridge: BRIDGE });
  const rostersOnly = buildProps(BUFLAR, { games: GAMES, rosters: ROSTERS });
  for (const r of [both, bridgeOnly, rostersOnly]) {
    const mine = ofGame(r, '401872994');
    assert.equal(mine.length, 126, 'ladders (D/ST and No Touchdown excluded)');
    assert.equal(mine.filter((p) => p.player.espnId).length, 126, 'matched');
    assert.equal(mine.filter((p) => p.dk).length, 62, 'with a DK line (critic: 62)');
    assert.deepEqual(r.unmatched, []);
  }
  assert.deepEqual(bridgeOnly.stats.byMethod, { 'bridge:team+jersey+name': 125, 'bridge:team+nameKey': 1 });
  const key = (p) => `${p.kalshiEvent}|${p.player.name}|${p.stat}`;
  const viaRoster = new Map(rostersOnly.props.map((p) => [key(p), p.player.espnId]));
  assert.equal(bridgeOnly.props.filter((p) => viaRoster.get(key(p)) === p.player.espnId).length, 126, 'both routes pick the same ESPN id');

  const st = find(both, 'passYds', /Stafford/);
  assert.equal(st.player.espnId, '12483');
  assert.deepEqual(st.player, { espnId: '12483', name: 'Matthew Stafford', team: 'LAR', side: 'home', pos: 'QB', jersey: '9' });
  assert.deepEqual(st.dk, { line: 278.5, open: 279.5, updated: null });
  assert.equal(st.fifty, 'safe');
  assert.equal(st.kalshiEvent, 'KXNFLPASSYDS-26OCT12BUFLAR');
  assert.deepEqual(st.rungs.map((r) => r.threshold), [200, 225, 250, 275, 300, 325, 350, 375, 400]);
  for (const r of st.rungs) assert.equal(r.threshold, r.strike + 0.5);
  const allen = find(both, 'passYds', /Josh Allen/);
  assert.equal(allen.player.side, 'away');
  assert.equal(allen.player.team, 'BUF');
  // Bachman: in the ESPN roster and (by name) in roster_weekly; joined either way
  assert.equal(find(both, 'anyTd', /Bachman/).player.espnId, '3919510');
});

test('BAL@ATL (research capture 2026-10-11 23:57Z): 111/111 ladders join, 59 DK lines; other games are gated out', () => {
  const r = buildProps(BALATL, { games: GAMES, bridge: BRIDGE, rosters: ROSTERS });
  const mine = ofGame(r, '401872993');
  assert.equal(mine.length, 111);
  assert.equal(mine.filter((p) => p.player.espnId).length, 111);
  assert.equal(mine.filter((p) => p.dk).length, 59, 'research join_rows_pre had 59 BAL@ATL DK lines');
  assert.equal(r.props.length, 111, 'finished SF@SEA and DEN@LAC ladders (still status open) and SEA@DEN D/ST rows are not props');
  assert.equal(r.stats.noGame, 24);
  assert.equal(r.stats.teamLevel, 12);
  const henry = find(r, 'rushYds', /Derrick Henry/);
  assert.deepEqual(henry.dk, { line: 80.5, open: 86.5, updated: null });
  assert.equal(henry.player.side, 'away');
  assert.equal(henry.fifty, 'safe');
  const bijan = find(r, 'rushYds', /Bijan/);
  assert.equal(bijan.player.team, 'ATL');
  assert.equal(bijan.player.side, 'home');
  const brian = find(r, 'rushAtt', /Brian Robinson/);
  assert.ok(bijan.player.espnId && brian.player.espnId);
  assert.notEqual(bijan.player.espnId, brian.player.espnId, 'BROBINSON name-key collision resolved by jersey');
  assert.deepEqual([bijan.player.jersey, brian.player.jersey], ['7', '15']);
  const ff = mine.find((p) => p.stat === 'ffpts');
  assert.equal(ff.dk, null);
  assert.equal(ff.fifty, 'unsafe');
  for (const rg of ff.rungs) assert.equal(rg.threshold, rg.strike, 'fantasy points: threshold = strike');
  const ft = mine.find((p) => p.stat === 'firstTd');
  assert.equal(ft.rungs.length, 1);
  assert.equal(ft.rungs[0].threshold, 1);
  const lr = mine.find((p) => p.stat === 'longRec');
  assert.equal(lr.rungs[0].threshold, Math.floor(lr.rungs[0].strike) + 1);
  for (const p of mine) {
    assert.ok(['safe', 'caution', 'unsafe'].includes(p.fifty));
    assert.ok(p.rungs.length >= 1);
    for (let i = 1; i < p.rungs.length; i++) assert.ok(p.rungs[i].threshold >= p.rungs[i - 1].threshold, 'rungs sorted');
  }
});

test('pregame gate: a game in progress gives no props; non-active markets are dropped', () => {
  const games = clone(GAMES);
  games.find((g) => g.espnId === '401872993').state = 'in';
  assert.equal(buildProps(BALATL, { games, bridge: BRIDGE }).props.length, 0);
  const raw = clone(BUFLAR);
  for (const m of raw.kalshi.KXNFLPASSYDS) if (/MSTAFFORD/.test(m.ticker) && m.floor_strike >= 349.5) m.status = 'initialized';
  const r = buildProps(raw, { games: GAMES, bridge: BRIDGE });
  assert.deepEqual(find(r, 'passYds', /Stafford/).rungs.map((x) => x.threshold), [200, 225, 250, 275, 300, 325]);
  assert.equal(r.stats.notActive, 3);
});

test('no matched KXNFLGAME event: games fall back to glue.kalshiGameCode (ET date, ESPN codes mapped to Kalshi)', () => {
  const games = clone(GAMES);
  const g = games.find((x) => x.espnId === '401872994');
  g.kalshi.gameEvent = null;
  delete g.home.kalshiCode;
  delete g.away.kalshiCode;
  const r = buildProps(BUFLAR, { games, bridge: BRIDGE });
  assert.equal(ofGame(r, '401872994').length, 126);
  const look = kalshiGameIndex([{ id: 'x', league: 'nfl', kickoff: '2026-10-18T13:30:00Z', home: { abbr: 'JAX' }, away: { abbr: 'HOU' }, kalshi: {} }]);
  assert.equal(look('KXNFLRSHYDS-26OCT18HOUJAC')?.game.id, 'x', 'JAX maps to Kalshi JAC');
  assert.equal(look('KXNFLRSHYDS-26OCT17HOUJAC')?.game.id, 'x', 'one day of date drift is tolerated');
  assert.equal(look('KXNFLRSHYDS-26OCT20HOUJAC'), null);
});

test('raw Kalshi markets: rung keeps prices, sizes and volume as numbers', () => {
  const games = clone(GAMES);
  const r = buildProps({ kalshi: { KXNFLRSHYDS: rd(P, 'kalshi-raw-henry.json').markets }, espnProps: {} }, { games, bridge: BRIDGE });
  assert.equal(r.props.length, 1);
  const rung = r.props[0].rungs.find((x) => x.threshold === 80);
  assert.equal(rung.ticker, 'KXNFLRSHYDS-26OCT11BALATL-BALDHENRY22-80');
  assert.equal(rung.strike, 79.5);
  for (const k of ['yesAsk', 'yesBid', 'noAsk', 'noBid', 'yesAskSize', 'yesBidSize', 'volume']) assert.equal(typeof rung[k], 'number', k);
  assert.ok(Math.abs(rung.noAsk - (1 - rung.yesBid)) < 1e-9);
  assert.equal(r.props[0].dk, null, 'no ESPN props for this game in the input');
});

test('unmatched players stay as ladders without an ESPN id and are listed', () => {
  const raw = clone(BUFLAR);
  raw.kalshi.KXNFLRSHYDS.push({ ticker: 'KXNFLRSHYDS-26OCT12BUFLAR-BUFZNOBODY99-25', event_ticker: 'KXNFLRSHYDS-26OCT12BUFLAR',
    yes_sub_title: 'Zed Nobody: 25+', floor_strike: 24.5, yes_bid_dollars: '0.4000', yes_ask_dollars: '0.4200', status: 'active' });
  const r = buildProps(raw, { games: GAMES, bridge: BRIDGE, rosters: ROSTERS });
  assert.deepEqual(r.unmatched, ['KXNFLRSHYDS 26OCT12BUFLAR BUF Zed Nobody #99']);
  const z = find(r, 'rushYds', /Zed Nobody/);
  assert.equal(z.player.espnId, null);
  assert.equal(z.dk, null);
  assert.equal(z.player.side, 'away');
});

test('buildProps is deterministic and independent of input order', () => {
  const a = buildProps(BUFLAR, { games: GAMES, bridge: BRIDGE, rosters: ROSTERS });
  const raw = clone(BUFLAR);
  for (const s of Object.keys(raw.kalshi)) raw.kalshi[s].reverse();
  raw.espnProps['401872994'].reverse();
  const b = buildProps(raw, { games: clone(GAMES).reverse(), bridge: BRIDGE, rosters: ROSTERS });
  assert.deepEqual(b.props, a.props);
  assert.deepEqual(buildProps(BUFLAR, { games: GAMES, bridge: BRIDGE, rosters: ROSTERS }), a);
});

test('missing inputs degrade, never throw', () => {
  const r = buildProps(null, { games: GAMES });
  assert.equal(r.ok, false);
  assert.deepEqual(r.props, []);
  const r2 = buildProps({ kalshi: BUFLAR.kalshi, errors: ['kalshi KXNFLREC: HTTP 503'] }, { games: GAMES, bridge: BRIDGE });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.includes('kalshi KXNFLREC: HTTP 503'));
  assert.equal(ofGame(r2, '401872994').filter((p) => p.dk).length, 0, 'no ESPN props: ladders without DK lines');
  assert.ok(buildProps(BUFLAR, { games: GAMES }).errors.some((e) => /no ID bridge/.test(e)));
});

// ---------------------------------------------------------------- fetching (mock fetch, offline)

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const NOW = Date.parse('2026-10-11T23:00:00Z');

function slateGames(n, { kickoff = '2026-10-12T17:00:00Z' } = {}) {
  const codes = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB'];
  return Array.from({ length: n }, (_, i) => ({ id: `nfl-40100${i}`, league: 'nfl', espnId: `40100${i}`, kickoff, state: 'pre',
    away: { abbr: codes[2 * i], kalshiCode: codes[2 * i] }, home: { abbr: codes[2 * i + 1], kalshiCode: codes[2 * i + 1] }, kalshi: {} }));
}

function mockUpstream({ games, failSeries = null, notPosted = new Set(), espn500 = new Set(), extraPage = 'KXNFLRECYDS' }) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.hostname + u.pathname + u.search);
    if (u.hostname.includes('kalshi')) {
      const s = u.searchParams.get('series_ticker');
      if (s === failSeries) return new Response('down', { status: 503 });
      const cursor = u.searchParams.get('cursor') || '';
      const markets = cursor ? [] : games.map((g) => ({ ticker: `${s}-26OCT12${g.away.kalshiCode}${g.home.kalshiCode}-${g.home.kalshiCode}APLAYER1-50`,
        event_ticker: `${s}-26OCT12${g.away.kalshiCode}${g.home.kalshiCode}`, yes_sub_title: 'A Player: 50+', floor_strike: 49.5, status: 'active',
        yes_bid_dollars: '0.5000', yes_ask_dollars: '0.5200' }));
      return json({ cursor: s === extraPage && !cursor ? 'page2' : '', markets });
    }
    const id = /events\/(\d+)\//.exec(u.pathname)?.[1];
    if (notPosted.has(id)) return new Response('{"error":"not found"}', { status: 404 });
    if (espn500.has(id)) return new Response('oops', { status: 500 });
    const page = Number(u.searchParams.get('page'));
    return json({ pageCount: 2, pageIndex: page, items: [
      { athlete: { $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/${page}00?lang=en` }, type: { id: '12', name: 'Total Rushing Yards (incl. overtime)' },
        current: { target: { value: 50.5, displayValue: '50.5' } }, open: { target: { value: 48.5 } }, lastUpdated: '2026-10-12T02:00Z', odds: {} },
      { athlete: { $ref: `athletes/${page}00` }, type: { id: '196', name: 'Rushing Yards Milestones' }, current: { target: { value: 60 } }, open: { target: { value: 50 } } },
      { team: { $ref: 'http://x/teams/2?lang=en' }, type: { id: '98', name: 'Team Total Points' }, current: { target: { value: 24.5 } }, open: { target: { value: 23.5 } } },
    ] });
  };
  return { fetchImpl, calls };
}

test('fetchPropInputs: 15 series paginated, propBets 2 pages per pregame game in range, 404 is "not posted"', async () => {
  const games = slateGames(3);
  games.push({ ...slateGames(1)[0], id: 'nfl-later', espnId: '409999', kickoff: '2026-10-19T17:00:00Z' }); // beyond 48 h
  games.push({ ...slateGames(1)[0], id: 'nfl-live', espnId: '408888', state: 'in' });
  games.push({ id: 'cfb-1', league: 'cfb', espnId: '401871067', kickoff: '2026-10-12T17:00:00Z', state: 'pre', home: { abbr: 'MTSU' }, away: { abbr: 'DEL' }, kalshi: {} });
  const up = mockUpstream({ games: games.slice(0, 3), notPosted: new Set(['401002']) });
  const r = await fetchPropInputs({ games, fetchImpl: up.fetchImpl, now: NOW, pauseMs: 0 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.kalshiRequests, 16, '15 series + 1 extra page');
  assert.equal(r.stats.espnRequests, 5, '2 + 2 + 1 (404)');
  assert.equal(r.requests, 21);
  assert.equal(r.stats.espnNotPosted, 1);
  assert.deepEqual(Object.keys(r.espnProps).sort(), ['401000', '401001']);
  assert.equal(r.espnProps['401000'].length, 4, 'milestones dropped at fetch time (2 pages x 2 kept items)');
  assert.deepEqual(r.espnProps['401000'][0].athlete, { $ref: 'athletes/100' });
  assert.deepEqual(r.espnProps['401000'][1].team, { $ref: 'teams/2' });
  assert.equal(PROP_SERIES_LIST.filter((s) => Array.isArray(r.kalshi[s])).length, 15);
  assert.ok(up.calls.every((c) => !c.includes('409999') && !c.includes('408888') && !c.includes('401871067')), 'later, live and CFB games are not fetched');
  assert.ok(up.calls.filter((c) => c.includes('kalshi')).every((c) => c.includes('status=open') && c.includes('max_close_ts=')));
  const built = buildProps(r, { games, rosters: { MIA: [] } });
  assert.equal(built.props.filter((p) => p.dk).length, 0, 'mock players are not on any roster');
});

test('fetchPropInputs: a full Sunday stays near 50 requests; errors are recorded, not thrown', async () => {
  const games = slateGames(14);
  const up = mockUpstream({ games });
  const r = await fetchPropInputs({ games, fetchImpl: up.fetchImpl, now: NOW, pauseMs: 0 });
  assert.equal(r.stats.espnGames, 14);
  assert.ok(r.requests <= 50, `requests ${r.requests}`);
  assert.equal(r.requests, 16 + 28);

  const up2 = mockUpstream({ games: games.slice(0, 2), failSeries: 'KXNFLREC', espn500: new Set(['401001']) });
  const r2 = await fetchPropInputs({ games: games.slice(0, 2), fetchImpl: up2.fetchImpl, now: NOW, pauseMs: 0 });
  assert.equal(r2.kalshi.KXNFLREC, undefined);
  assert.ok(r2.errors.some((e) => /kalshi KXNFLREC/.test(e)));
  assert.ok(r2.errors.some((e) => /espn propBets 401001/.test(e)));
  assert.deepEqual(Object.keys(r2.espnProps), ['401000']);
  const capped = await fetchPropInputs({ games, fetchImpl: mockUpstream({ games }).fetchImpl, now: NOW, pauseMs: 0, maxEspnGames: 4 });
  assert.equal(capped.stats.espnRequests, 8);
  assert.ok(capped.errors.some((e) => /14 games in range, fetched the first 4/.test(e)));
});

test('fetchPropInputs: games without DK-comparable Kalshi ladders are skipped (no ESPN request)', async () => {
  const games = slateGames(2);
  const up = mockUpstream({ games: [] });
  const r = await fetchPropInputs({ games, fetchImpl: up.fetchImpl, now: NOW, pauseMs: 0 });
  assert.equal(r.stats.espnRequests, 0);
  assert.deepEqual(r.espnProps, {});
});

test('fetchPropInputs: a stalled ESPN core host costs one short timeout per game (no retry)', async () => {
  const games = slateGames(4);
  const up = mockUpstream({ games });
  const fetchImpl = (url, init) => {
    if (!new URL(url).hostname.includes('espn')) return up.fetchImpl(url, init);
    return new Promise((_, rej) => {
      const guard = setTimeout(() => rej(new Error('never aborted')), 60000); // ref'd, like an open socket
      init.signal.addEventListener('abort', () => { clearTimeout(guard); rej(init.signal.reason); }, { once: true });
    });
  };
  const t = Date.now();
  const r = await fetchPropInputs({ games, fetchImpl, now: NOW, pauseMs: 0, espnTimeoutMs: 40 });
  const ms = Date.now() - t;
  assert.equal(r.stats.espnGames, 4);
  assert.equal(r.stats.espnRequests, 4, 'one attempt per game: a stalled propBets request is not retried');
  assert.equal(r.errors.filter((e) => /espn propBets \d+: .*timeout/.test(e)).length, 4, r.errors.join(' | '));
  assert.ok(ms < 3000, `took ${ms} ms`);
  assert.ok(Object.keys(r.kalshi).length > 0, 'Kalshi ladders kept');
});
