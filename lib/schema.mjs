// validateSnapshot(snapshot) -> [problem strings]. Empty array = matches the SPEC section 3 shape (+ the optional 10.1 fields).
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
// Phase B additions (optional): checked only when present.
const EXTRA_SOURCE_KEYS = ['fees', 'teamTotals', 'cfb', 'moves', 'pinnacle'];
const GRADES = ['confirmed', 'likely', 'questionable', 'carryover', 'longterm'];
const ANGLE_KINDS = ['qb-out', 'skill-out', 'ol-out', 'def-out', 'cfb-qb-change'];
const MOVE_MARKETS = ['ml', 'spread', 'total', 'teamTotalHome', 'teamTotalAway'];
const KALSHI_MOVE_MARKETS = ['ml', 'spread', 'total'];   // games[i].kalshiMoves: Kalshi implied centers (lib/moves.mjs)
const FIFTY = ['safe', 'caution', 'unsafe'];
const SIDES = ['home', 'away'];
const DASH_RE = /[\u2013\u2014]/; // Ben's rule: no long dashes in text that reaches the site

export function validateSnapshot(s, { maxProblems = 60 } = {}) {
  const p = [];
  const bad = (msg) => { if (p.length < maxProblems) p.push(msg); };
  if (!isObj(s)) return ['snapshot is not an object'];
  if (s.v !== 1) bad('v must be 1');
  if (!isIso(s.generatedAt)) bad('generatedAt must be ISO UTC');
  if (!isObj(s.collector) || !isStr(s.collector.version) || !numOrNull(s.collector.runMs)) bad('collector { version, runMs }');

  if (!isObj(s.sources)) bad('sources missing');
  else {
    for (const k of [...SOURCE_KEYS, ...EXTRA_SOURCE_KEYS]) {
      const src = s.sources[k];
      if (src === undefined && EXTRA_SOURCE_KEYS.includes(k)) continue;
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

  const gameIds = new Set(Array.isArray(s.games) ? s.games.map((g) => g?.id) : []);
  if (!Array.isArray(s.props)) bad('props must be an array');
  else {
    const seen = new Set();
    s.props.forEach((p, i) => {
      checkProp(p, `props[${i}]`, bad, gameIds);
      const k = isObj(p) ? `${p.kalshiEvent}|${p.series ?? p.stat}|${p.player?.espnId ?? p.player?.name}` : null;
      if (k && seen.has(k)) bad(`props[${i}] duplicate ladder ${k}`);
      seen.add(k);
    });
  }
  if (!isObj(s.defense) || !isObj(s.defense.nfl) || !isObj(s.defense.cfb)) bad('defense { nfl, cfb }');
  else {
    for (const [t, d] of Object.entries(s.defense.nfl)) if (!isObj(d) || !numOrNull(d.games ?? null) || !isObj(d.ranks)) bad(`defense.nfl.${t} { games, ranks }`);
    for (const [t, d] of Object.entries(s.defense.cfb)) if (!isObj(d) || !isObj(d.ranks)) bad(`defense.cfb.${t} { ranks }`);
  }
  if (!isObj(s.players)) bad('players must be an object');
  else for (const [id, pc] of Object.entries(s.players)) if (!isObj(pc) || !isStr(pc.name ?? '') || (pc.stats !== undefined && !isObj(pc.stats))) bad(`players.${id}`);
  if (s.cfbQbChanges !== undefined) {
    if (!Array.isArray(s.cfbQbChanges)) bad('cfbQbChanges must be an array');
    else s.cfbQbChanges.forEach((q, i) => { if (!isObj(q) || !gameIds.has(q.gameId) || !SIDES.includes(q.team) || !isStr(q.note)) bad(`cfbQbChanges[${i}]`); });
  }
  if (!Array.isArray(s.comboEligible) || !s.comboEligible.every(isStr)) bad('comboEligible must be string[]');
  if (!isObj(s.unmatched) || !Array.isArray(s.unmatched.kalshi) || !Array.isArray(s.unmatched.espn)) bad('unmatched { kalshi, espn }');
  else if (s.unmatched.pinnacle !== undefined && !(Array.isArray(s.unmatched.pinnacle) && s.unmatched.pinnacle.every(isStr))) bad('unmatched.pinnacle must be string[]');
  if (isObj(s.sources?.pinnacle) && !isNum(s.sources.pinnacle.matched)) bad('sources.pinnacle.matched must be a number');
  return p;
}

const isAmerican = (x) => isNum(x) && Math.abs(x) >= 100;
const americanOrNull = (x) => x === null || isAmerican(x);

// refs.pinnacle lines: { ml, spread, total } in the SPEC 3 Odds field names (no provider, no opening lines), each
// null when Pinnacle has no such line, plus alts [{ type, points, a, b }].
function checkLines(o, at, bad) {
  if (!isObj(o)) return bad(`${at} must be an object`);
  if (o.ml !== null && !(isObj(o.ml) && isAmerican(o.ml.home) && isAmerican(o.ml.away))) bad(`${at}.ml { home, away }`);
  if (o.spread !== null && !(isObj(o.spread) && isNum(o.spread.home) && americanOrNull(o.spread.homeOdds) && americanOrNull(o.spread.awayOdds))) bad(`${at}.spread { home, homeOdds, awayOdds }`);
  if (o.total !== null && !(isObj(o.total) && isNum(o.total.line) && americanOrNull(o.total.overOdds) && americanOrNull(o.total.underOdds))) bad(`${at}.total { line, overOdds, underOdds }`);
}
function checkAlts(list, at, bad) {
  if (!Array.isArray(list)) return bad(`${at} must be an array`);
  list.forEach((x, i) => {
    if (!isObj(x) || !['spread', 'total'].includes(x.type) || !isNum(x.points) || !isAmerican(x.a) || !isAmerican(x.b)) bad(`${at}[${i}] { type, points, a, b }`);
  });
}
function checkPinnacleRef(r, at, bad, league) {
  if (!isObj(r)) return bad(`${at} must be an object`);
  if (!(r.fetchedAt === null || isIso(r.fetchedAt))) bad(`${at}.fetchedAt must be ISO or null`);
  if (!(r.lastModified === null || isIso(r.lastModified))) bad(`${at}.lastModified must be ISO or null`);
  if (typeof r.offBoard !== 'boolean') bad(`${at}.offBoard must be boolean`);
  checkLines(r.odds, `${at}.odds`, bad);
  checkAlts(r.alts, `${at}.alts`, bad);
  if (r.offBoard && isObj(r.odds) && (r.odds.ml || r.odds.spread || r.odds.total)) bad(`${at} is off the board but has prices`);
  if (r.periods !== undefined) {
    if (league !== 'nfl') bad(`${at}.periods is NFL only`);
    if (!isObj(r.periods)) return bad(`${at}.periods must be an object`);
    for (const [k, v] of Object.entries(r.periods)) {
      if (!['h1', 'q1'].includes(k)) { bad(`${at}.periods.${k} (h1 or q1 only)`); continue; }
      checkLines(v, `${at}.periods.${k}`, bad);
      checkAlts(v?.alts, `${at}.periods.${k}.alts`, bad);
    }
  }
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
  if (!['game', 'spread', 'total', 'teamTotal'].includes(m.type)) bad(`${at}.type`);
  if (m.type === 'total' ? m.team !== null : !['home', 'away'].includes(m.team)) bad(`${at}.team ${m.team} invalid for ${m.type}`);
  if (m.type === 'game' ? m.strike !== null : !isHalf(m.strike)) bad(`${at}.strike ${m.strike} invalid for ${m.type}`);
  for (const k of ['yesAsk', 'yesBid', 'noAsk', 'noBid', 'lastPrice', 'prevYesAsk']) if (!priceOk(m[k])) bad(`${at}.${k} must be 0..1 or null`);
  for (const k of ['yesAskSize', 'yesBidSize', 'volume', 'volume24h', 'openInterest']) if (!(m[k] === null || (isNum(m[k]) && m[k] >= 0))) bad(`${at}.${k} must be >= 0 or null`);
  if (isStr(m.ticker) && isStr(m.event) && !m.ticker.startsWith(`${m.event}-`)) bad(`${at}.ticker not under its event`);
  const want = { game: events.gameEvent, spread: events.spreadEvent, total: events.totalEvent, teamTotal: events.teamTotalEvent }[m.type];
  if (want !== undefined && m.event !== want) bad(`${at}.event ${m.event} != ${m.type}Event ${want}`);
}

function checkInjury(x, at, bad) {
  if (!isObj(x)) return bad(`${at} missing`);
  for (const k of ['espnId', 'name', 'pos', 'status', 'detail', 'updated']) if (!(x[k] === null || isStr(x[k]))) bad(`${at}.${k}`);
  if (!(x.starter === null || typeof x.starter === 'boolean')) bad(`${at}.starter`);
  if (!numOrNull(x.depthRank)) bad(`${at}.depthRank`);
  if (x.grade !== undefined && !GRADES.includes(x.grade)) bad(`${at}.grade ${x.grade}`);
  if (x.role !== undefined && !(x.role === null || isStr(x.role))) bad(`${at}.role`);
  if (x.newsAt !== undefined && !(x.newsAt === null || isIso(x.newsAt))) bad(`${at}.newsAt`);
  if (DASH_RE.test(`${x.newsText ?? ''} ${x.detail ?? ''}`)) bad(`${at} has a long dash in its text`);
}

function checkAngle(a, at, bad) {
  if (!isObj(a)) return bad(`${at} missing`);
  if (!ANGLE_KINDS.includes(a.kind)) bad(`${at}.kind ${a.kind}`);
  if (!SIDES.includes(a.team)) bad(`${at}.team`);
  if (!GRADES.includes(a.grade)) bad(`${at}.grade ${a.grade}`);
  for (const k of ['beneficiaries', 'fades', 'signals']) if (!Array.isArray(a[k])) bad(`${at}.${k} must be an array`);
  if (DASH_RE.test(JSON.stringify([a.why, a.player, a.beneficiaries, a.fades, a.signals]))) bad(`${at} has a long dash in its text`);
}

// markets: the allowed market names, or null for prop moves (they carry no market field)
function checkMoves(list, at, bad, markets) {
  if (!Array.isArray(list)) return bad(`${at} must be an array`);
  list.forEach((m, i) => {
    if (!isObj(m) || !isNum(m.from) || !isNum(m.to) || !isIso(m.at)) bad(`${at}[${i}] { from, to, at }`);
    else if (markets && !markets.includes(m.market)) bad(`${at}[${i}].market ${m.market}`);
    else if (markets === KALSHI_MOVE_MARKETS && m.market === 'ml' && !(m.from >= 0 && m.from <= 1 && m.to >= 0 && m.to <= 1)) bad(`${at}[${i}] ml must be a probability`);
  });
}

function checkProp(p, at, bad, gameIds) {
  if (!isObj(p)) return bad(`${at} missing`);
  if (!gameIds.has(p.gameId)) bad(`${at}.gameId ${p.gameId} is not a game in this snapshot`);
  if (!isStr(p.stat) || !isStr(p.kalshiEvent)) bad(`${at} stat/kalshiEvent`);
  if (!isObj(p.player) || !SIDES.includes(p.player.side) || !(p.player.espnId === null || isStr(p.player.espnId))) bad(`${at}.player`);
  else if (p.player.injury !== undefined && p.player.injury !== null) checkInjury(p.player.injury, `${at}.player.injury`, bad);
  if (!(p.dk === null || (isObj(p.dk) && isNum(p.dk.line) && numOrNull(p.dk.open)))) bad(`${at}.dk`);
  if (p.fifty !== undefined && !FIFTY.includes(p.fifty)) bad(`${at}.fifty`);
  if (!Array.isArray(p.rungs) || !p.rungs.length) bad(`${at}.rungs must be a non-empty array`);
  else p.rungs.forEach((r, i) => {
    if (!isObj(r) || !isStr(r.ticker) || !r.ticker.startsWith(`${p.kalshiEvent}-`) || !isNum(r.threshold)) bad(`${at}.rungs[${i}] { ticker, threshold }`);
    else for (const k of ['yesAsk', 'yesBid', 'noAsk', 'noBid']) if (!priceOk(r[k])) bad(`${at}.rungs[${i}].${k}`);
  });
  if (p.moves !== undefined) checkMoves(p.moves, `${at}.moves`, bad, null);
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
    if (k.teamTotalEvent !== undefined && !(k.teamTotalEvent === null || isStr(k.teamTotalEvent))) bad(`${at}.kalshi.teamTotalEvent`);
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
  if (g.dkTeamTotals !== undefined && g.dkTeamTotals !== null) {
    if (!isObj(g.dkTeamTotals)) bad(`${at}.dkTeamTotals`);
    else for (const sd of SIDES) { const t = g.dkTeamTotals[sd]; if (!(t === null || t === undefined || (isObj(t) && numOrNull(t.line) && numOrNull(t.open)))) bad(`${at}.dkTeamTotals.${sd}`); }
  }
  if (g.angles !== undefined) {
    if (!Array.isArray(g.angles)) bad(`${at}.angles must be an array`);
    else g.angles.forEach((a, i) => checkAngle(a, `${at}.angles[${i}]`, bad));
  }
  if (g.moves !== undefined) checkMoves(g.moves, `${at}.moves`, bad, MOVE_MARKETS);
  if (g.kalshiMoves !== undefined) checkMoves(g.kalshiMoves, `${at}.kalshiMoves`, bad, KALSHI_MOVE_MARKETS);
  if (g.refs !== undefined) {
    if (!isObj(g.refs)) bad(`${at}.refs must be an object`);
    else {
      if (g.refs.pinnacle !== undefined) checkPinnacleRef(g.refs.pinnacle, `${at}.refs.pinnacle`, bad, g.league);
      if (g.state !== 'pre') bad(`${at}.refs on a game that is not pregame`);
    }
  }
  if (!(g.weather === null || (isObj(g.weather) && numOrNull(g.weather.tempF) && numOrNull(g.weather.windMph)))) bad(`${at}.weather`);
}
