// validateSnapshot(snapshot) -> [problem strings]. Empty array = matches the SPEC section 3 shape.
// Used by the tests and by collect.mjs as a self-check before posting.

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isIso = (x) => typeof x === 'string' && ISO_RE.test(x) && Number.isFinite(Date.parse(x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isStr = (x) => typeof x === 'string';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const numOrNull = (x) => x === null || isNum(x);
const priceOk = (x) => x === null || (isNum(x) && x >= 0 && x <= 1);
const isHalf = (x) => isNum(x) && Math.abs(Math.abs(x % 1) - 0.5) < 1e-9;

const SOURCE_KEYS = ['kalshi', 'espnOdds', 'injuries', 'props', 'nflverse', 'combos'];

export function validateSnapshot(s, { maxProblems = 60 } = {}) {
  const p = [];
  const bad = (msg) => { if (p.length < maxProblems) p.push(msg); };
  if (!isObj(s)) return ['snapshot is not an object'];
  if (s.v !== 1) bad('v must be 1');
  if (!isIso(s.generatedAt)) bad('generatedAt must be ISO UTC');
  if (!isObj(s.collector) || !isStr(s.collector.version) || !numOrNull(s.collector.runMs)) bad('collector { version, runMs }');

  if (!isObj(s.sources)) bad('sources missing');
  else {
    for (const k of SOURCE_KEYS) {
      const src = s.sources[k];
      if (!isObj(src)) { bad(`sources.${k} missing`); continue; }
      if (typeof src.ok !== 'boolean') bad(`sources.${k}.ok must be boolean`);
      if (!Array.isArray(src.errors) || !src.errors.every(isStr)) bad(`sources.${k}.errors must be string[]`);
      if ('fetchedAt' in src && src.fetchedAt !== null && !isIso(src.fetchedAt)) bad(`sources.${k}.fetchedAt must be ISO or null`);
    }
    if (isObj(s.sources.kalshi) && !isNum(s.sources.kalshi.requests)) bad('sources.kalshi.requests must be a number');
    if (isObj(s.sources.combos) && !(s.sources.combos.collection === null || isStr(s.sources.combos.collection))) bad('sources.combos.collection');
  }

  if (!isObj(s.fees)) bad('fees missing');
  else for (const [k, f] of Object.entries(s.fees)) if (!isObj(f) || !isStr(f.feeType) || !isNum(f.multiplier)) bad(`fees.${k} { feeType, multiplier }`);

  if (!Array.isArray(s.games)) bad('games must be an array');
  else s.games.forEach((g, i) => checkGame(g, `games[${i}]`, bad));

  if (!Array.isArray(s.props)) bad('props must be an array');
  if (!isObj(s.defense) || !isObj(s.defense.nfl) || !isObj(s.defense.cfb)) bad('defense { nfl, cfb }');
  if (!isObj(s.players)) bad('players must be an object');
  if (!Array.isArray(s.comboEligible) || !s.comboEligible.every(isStr)) bad('comboEligible must be string[]');
  if (!isObj(s.unmatched) || !Array.isArray(s.unmatched.kalshi) || !Array.isArray(s.unmatched.espn)) bad('unmatched { kalshi, espn }');
  return p;
}

function checkTeam(t, at, bad) {
  if (!isObj(t)) return bad(`${at} missing`);
  for (const k of ['abbr', 'name', 'shortName', 'espnId']) if (!isStr(t[k])) bad(`${at}.${k} must be a string`);
  for (const k of ['kalshiCode', 'logo', 'record']) if (!(t[k] === null || isStr(t[k]))) bad(`${at}.${k} must be string or null`);
}

function checkOdds(o, at, bad) {
  if (o === null) return;
  if (!isObj(o)) return bad(`${at} must be object or null`);
  if (!isStr(o.provider) || !(o.fetchedAt === null || isIso(o.fetchedAt))) bad(`${at} provider/fetchedAt`);
  if (o.ml !== null) {
    if (!isObj(o.ml)) bad(`${at}.ml`);
    else for (const k of ['home', 'away', 'homeOpen', 'awayOpen']) if (!numOrNull(o.ml[k])) bad(`${at}.ml.${k}`);
  }
  if (o.spread !== null) {
    if (!isObj(o.spread) || !isNum(o.spread.home)) bad(`${at}.spread.home`);
    else for (const k of ['homeOdds', 'awayOdds', 'homeOpen', 'homeOddsOpen', 'awayOddsOpen']) if (!numOrNull(o.spread[k])) bad(`${at}.spread.${k}`);
  }
  if (o.total !== null) {
    if (!isObj(o.total) || !isNum(o.total.line)) bad(`${at}.total.line`);
    else for (const k of ['overOdds', 'underOdds', 'lineOpen', 'overOddsOpen', 'underOddsOpen']) if (!numOrNull(o.total[k])) bad(`${at}.total.${k}`);
  }
}

export function checkMarket(m, at, bad, events = {}) {
  if (!isObj(m)) return bad(`${at} missing`);
  for (const k of ['ticker', 'event', 'series', 'title', 'status']) if (!isStr(m[k])) bad(`${at}.${k} must be a string`);
  if (!['game', 'spread', 'total'].includes(m.type)) bad(`${at}.type`);
  if (m.type === 'total' ? m.team !== null : !['home', 'away'].includes(m.team)) bad(`${at}.team ${m.team} invalid for ${m.type}`);
  if (m.type === 'game' ? m.strike !== null : !isHalf(m.strike)) bad(`${at}.strike ${m.strike} invalid for ${m.type}`);
  for (const k of ['yesAsk', 'yesBid', 'noAsk', 'noBid', 'lastPrice', 'prevYesAsk']) if (!priceOk(m[k])) bad(`${at}.${k} must be 0..1 or null`);
  for (const k of ['yesAskSize', 'yesBidSize', 'volume', 'volume24h', 'openInterest']) if (!(m[k] === null || (isNum(m[k]) && m[k] >= 0))) bad(`${at}.${k} must be >= 0 or null`);
  if (isStr(m.ticker) && isStr(m.event) && !m.ticker.startsWith(`${m.event}-`)) bad(`${at}.ticker not under its event`);
  const want = { game: events.gameEvent, spread: events.spreadEvent, total: events.totalEvent }[m.type];
  if (want !== undefined && m.event !== want) bad(`${at}.event ${m.event} != ${m.type}Event ${want}`);
}

function checkInjury(x, at, bad) {
  if (!isObj(x)) return bad(`${at} missing`);
  for (const k of ['espnId', 'name', 'pos', 'status', 'detail', 'updated']) if (!(x[k] === null || isStr(x[k]))) bad(`${at}.${k}`);
  if (!(x.starter === null || typeof x.starter === 'boolean')) bad(`${at}.starter`);
  if (!numOrNull(x.depthRank)) bad(`${at}.depthRank`);
}

function checkGame(g, at, bad) {
  if (!isObj(g)) return bad(`${at} missing`);
  if (!['nfl', 'cfb'].includes(g.league)) bad(`${at}.league`);
  if (!isStr(g.espnId) || g.id !== `${g.league}-${g.espnId}`) bad(`${at}.id must be league-espnId`);
  for (const k of ['season', 'seasonType', 'week']) if (!numOrNull(g[k])) bad(`${at}.${k}`);
  if (!isIso(g.kickoff)) bad(`${at}.kickoff must be ISO UTC`);
  if (!['pre', 'in'].includes(g.state)) bad(`${at}.state ${g.state} (only pre/in are kept)`);
  if (typeof g.neutral !== 'boolean') bad(`${at}.neutral`);
  checkTeam(g.home, `${at}.home`, bad);
  checkTeam(g.away, `${at}.away`, bad);
  checkOdds(g.odds, `${at}.odds`, bad);
  const k = g.kalshi;
  if (!isObj(k) || !Array.isArray(k.markets)) bad(`${at}.kalshi`);
  else {
    for (const e of ['gameEvent', 'spreadEvent', 'totalEvent']) if (!(k[e] === null || isStr(k[e]))) bad(`${at}.kalshi.${e}`);
    if (!k.gameEvent && k.markets.length) bad(`${at}.kalshi has markets but no gameEvent`);
    if (k.gameEvent && (g.home.kalshiCode === null || g.away.kalshiCode === null)) bad(`${at} matched but kalshiCode missing`);
    const seen = new Set();
    k.markets.forEach((m, i) => {
      checkMarket(m, `${at}.kalshi.markets[${i}]`, bad, k);
      if (seen.has(m.ticker)) bad(`${at} duplicate market ${m.ticker}`);
      seen.add(m.ticker);
    });
  }
  if (!isObj(g.injuries) || !Array.isArray(g.injuries.home) || !Array.isArray(g.injuries.away)) bad(`${at}.injuries`);
  else ['home', 'away'].forEach((s) => g.injuries[s].forEach((x, i) => checkInjury(x, `${at}.injuries.${s}[${i}]`, bad)));
  if (!(g.weather === null || (isObj(g.weather) && numOrNull(g.weather.tempF) && numOrNull(g.weather.windMph)))) bad(`${at}.weather`);
}
