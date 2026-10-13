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
// Exchange reference venues (lib/venues): optional sources and games[i].refs.venues.<venue>.
const VENUE_SOURCE_KEYS = ['polyus', 'gemini', 'sx'];
const VENUE_KEY_RE = /^(ml:home|sp:(home|away):\d+\.5|tot:\d+\.5)$/;
// Phase B additions (optional): checked only when present.
const EXTRA_SOURCE_KEYS = ['fees', 'teamTotals', 'cfb', 'moves', 'pinnacle', ...VENUE_SOURCE_KEYS, 'ratingInputs', 'fcs', 'lookahead'];
// Part B (FCS and lookahead): Team.division, Game.cls, Game.lookahead (CFB only, all optional).
const DIVISIONS = ['fbs', 'fcs'];
const CLASSES = ['FF', 'FC', 'CC'];
const LOOKAHEAD_MS = [9 * 86400e3, 16 * 86400e3]; // a lookahead game kicks off this far after generatedAt
/**
 * snapshot.ratingInputs is line free by construction: no field anywhere inside it may be named like a betting line
 * (spread, spread_line, totalLine, total_line, homeMl, awayMl, moneyline, the odds columns, vegas_wp, vegas_home_wp,
 * or anything from espn_cfb_betting or cfb_matchup_line). `total` (points scored) and `result` are allowed.
 */
export const LINE_FIELD_RE = /spread|moneyline|vegas|betting|matchup_?line|odds|total_?line|^(home|away)?_?ml$|^line$/i;
const STARTER_SOURCES = ['depth', 'depth_injury'];
const GRADES = ['confirmed', 'likely', 'questionable', 'carryover', 'longterm'];
const ANGLE_KINDS = ['qb-out', 'skill-out', 'ol-out', 'def-out', 'cfb-qb-change'];
const MOVE_MARKETS = ['ml', 'spread', 'total', 'teamTotalHome', 'teamTotalAway'];
const KALSHI_MOVE_MARKETS = ['ml', 'spread', 'total'];   // games[i].kalshiMoves: Kalshi implied centers (lib/moves.mjs)
const FIFTY = ['safe', 'caution', 'unsafe'];
const SIDES = ['home', 'away'];
const DASH_RE = /[\u2013\u2014]/; // house style: no long dashes in text that reaches the site

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
  else s.games.forEach((g, i) => checkGame(g, `games[${i}]`, bad, Date.parse(s.generatedAt)));

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
  else if (Array.isArray(s.games)) {
    // part B games never supply a combo leg
    const partB = new Set();
    for (const g of s.games) if (isObj(g) && (g.cls === 'CC' || g.lookahead === true)) for (const e of [g.kalshi?.gameEvent, g.kalshi?.spreadEvent, g.kalshi?.totalEvent, g.kalshi?.teamTotalEvent]) if (e) partB.add(e);
    for (const e of s.comboEligible) if (partB.has(e)) bad(`comboEligible lists ${e}, an FCS vs FCS or lookahead game`);
  }
  if (isObj(s.sources)) {
    for (const k of ['fcs', 'lookahead']) {
      const src = s.sources[k];
      if (src !== undefined && (!isObj(src) || !isNum(src.requests) || !isNum(src.games) || !isNum(src.boards))) bad(`sources.${k} { requests, boards, games }`);
    }
  }
  if (!isObj(s.unmatched) || !Array.isArray(s.unmatched.kalshi) || !Array.isArray(s.unmatched.espn)) bad('unmatched { kalshi, espn }');
  else if (s.unmatched.pinnacle !== undefined && !(Array.isArray(s.unmatched.pinnacle) && s.unmatched.pinnacle.every(isStr))) bad('unmatched.pinnacle must be string[]');
  if (isObj(s.sources?.pinnacle) && !isNum(s.sources.pinnacle.matched)) bad('sources.pinnacle.matched must be a number');
  for (const v of VENUE_SOURCE_KEYS) {
    const src = s.sources?.[v];
    if (src === undefined) continue;
    if (!isObj(src) || !isNum(src.matched) || !isNum(src.requests) || typeof src.cached !== 'boolean' || !isObj(src.matchedByLeague)) bad(`sources.${v} { matched, requests, cached, matchedByLeague }`);
  }
  if (s.ratingInputs !== undefined) checkRatingInputs(s.ratingInputs, bad);
  return p;
}

/** Paths of every key under `obj` whose name looks like a betting line field (LINE_FIELD_RE). */
export function lineFieldPaths(obj, path = 'ratingInputs', out = []) {
  if (Array.isArray(obj)) obj.forEach((x, i) => { if (x && typeof x === 'object') lineFieldPaths(x, `${path}[${i}]`, out); });
  else if (isObj(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (LINE_FIELD_RE.test(k)) out.push(`${path}.${k}`);
      if (v && typeof v === 'object') lineFieldPaths(v, `${path}.${k}`, out);
    }
  }
  return out;
}

const strOrNull = (x) => x === null || isStr(x);
const isoOrNull = (x) => x === null || isIso(x);
const triple = (a, w) => Array.isArray(a) && a.length === 3 && a.every((x) => Array.isArray(x) && x.length === w && x.every(isNum));
const pairOrNull = (a) => Array.isArray(a) && a.length === 2 && a.every(numOrNull);

// snapshot.ratingInputs (lib/ratinginputs.mjs; the shape agreed with the site engine). Every part optional.
function checkRatingInputs(ri, bad) {
  if (!isObj(ri)) return bad('ratingInputs must be an object');
  if (ri.v !== 1) bad('ratingInputs.v must be 1');
  for (const path of lineFieldPaths(ri).slice(0, 5)) bad(`${path}: a betting line field inside ratingInputs`);
  const n = ri.nfl;
  if (n !== undefined) {
    const at = 'ratingInputs.nfl';
    if (!isObj(n)) bad(`${at} must be an object`);
    else {
      if (!isNum(n.season) || !isoOrNull(n.asOf) || !strOrNull(n.etag) || !numOrNull(n.throughWeek)) bad(`${at} { season, asOf, etag, throughWeek }`);
      for (const k of ['games', 'teamGames', 'qbGames', 'starters']) if (!Array.isArray(n[k])) bad(`${at}.${k} must be an array`);
      const ids = new Set();
      (Array.isArray(n.games) ? n.games : []).forEach((g, i) => {
        if (!isObj(g) || !isStr(g.id) || !isStr(g.home) || !isStr(g.away) || !isStr(g.date) || !isNum(g.week) || !numOrNull(g.hs) || !numOrNull(g.as) || !numOrNull(g.result) || !numOrNull(g.total) || typeof g.neutral !== 'boolean') bad(`${at}.games[${i}]`);
        else ids.add(g.id);
      });
      (Array.isArray(n.teamGames) ? n.teamGames : []).forEach((t, i) => {
        if (!isObj(t) || !isStr(t.id) || !isStr(t.team) || !triple(t.pass, 3) || !triple(t.rush, 3) || !isNum(t.plays) || !isNum(t.drives)) bad(`${at}.teamGames[${i}] { id, team, pass, rush, plays, drives }`);
        else if (!ids.has(t.id)) bad(`${at}.teamGames[${i}].id ${t.id} is not in nfl.games`);
      });
      (Array.isArray(n.qbGames) ? n.qbGames : []).forEach((q, i) => {
        if (!isObj(q) || !isStr(q.id) || !isStr(q.team) || !isStr(q.qb) || !isStr(q.name) || !triple(q.b, 2)) bad(`${at}.qbGames[${i}] { id, team, qb, name, b }`);
      });
      (Array.isArray(n.starters) ? n.starters : []).forEach((x, i) => {
        if (!isObj(x) || !isStr(x.team) || !strOrNull(x.qb) || !strOrNull(x.name) || !isStr(x.espnId) || !STARTER_SOURCES.includes(x.source) || !strOrNull(x.status) || !isoOrNull(x.at)) bad(`${at}.starters[${i}]`);
        else if (x.source === 'depth_injury' ? !(isObj(x.replaced) && strOrNull(x.replaced.qb) && strOrNull(x.replaced.name)) : x.replaced !== null) bad(`${at}.starters[${i}].replaced`);
      });
    }
  }
  const c = ri.cfb;
  if (c !== undefined) {
    const at = 'ratingInputs.cfb';
    if (!isObj(c)) bad(`${at} must be an object`);
    else {
      if (!isNum(c.season) || !isoOrNull(c.asOf) || !isObj(c.files) || !isObj(c.files.etags) || !isNum(c.effMissing)) bad(`${at} { season, asOf, files: { etags }, effMissing }`);
      if (!Array.isArray(c.games)) bad(`${at}.games must be an array`);
      if (!Array.isArray(c.eff)) bad(`${at}.eff must be an array`);
      const ids = new Set();
      (Array.isArray(c.games) ? c.games : []).forEach((g, i) => {
        const div = (d) => d === 'fbs' || d === 'fcs';
        if (!isObj(g) || !isStr(g.id) || !isStr(g.h) || !isStr(g.a) || !isStr(g.date) || typeof g.done !== 'boolean' || typeof g.neutral !== 'boolean' || !div(g.hDiv) || !div(g.aDiv)) bad(`${at}.games[${i}]`);
        else if (g.done ? !(isNum(g.hp) && isNum(g.ap)) : !(g.hp === null && g.ap === null)) bad(`${at}.games[${i}] scores must be set exactly when done`);
        else if (ids.has(g.id)) bad(`${at}.games[${i}] duplicate id ${g.id}`);
        else ids.add(g.id);
      });
      (Array.isArray(c.eff) ? c.eff : []).forEach((e, i) => {
        if (!isObj(e) || !isStr(e.id) || !pairOrNull(e.ypp) || !pairOrNull(e.plays) || !numOrNull(e.sr)) bad(`${at}.eff[${i}] { id, ypp, plays, sr }`);
        else if (!ids.has(e.id)) bad(`${at}.eff[${i}].id ${e.id} is not in cfb.games`);
      });
    }
  }
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
// refs.venues: { [venue]: { fetchedAt, quotes: { [key]: { bid, ask, bidSize, askSize, sizeUnit } } } }
function checkVenueRefs(r, at, bad) {
  if (!isObj(r)) return bad(`${at} must be an object`);
  for (const [v, x] of Object.entries(r)) {
    const a = `${at}.${v}`;
    if (!VENUE_SOURCE_KEYS.includes(v)) { bad(`${a}: unknown venue`); continue; }
    if (!isObj(x) || !(x.fetchedAt === null || isIso(x.fetchedAt)) || !isObj(x.quotes)) { bad(`${a} { fetchedAt, quotes }`); continue; }
    if (!Object.keys(x.quotes).length) bad(`${a}.quotes is empty`);
    for (const [k, q] of Object.entries(x.quotes)) {
      if (!VENUE_KEY_RE.test(k)) { bad(`${a}.quotes: bad key ${k}`); continue; }
      const sizeOk = (n) => n === null || (isNum(n) && n >= 0);
      if (!isObj(q) || !isNum(q.bid) || !isNum(q.ask) || !(q.bid > 0 && q.ask < 1 && q.bid <= q.ask)) bad(`${a}.quotes.${k} needs 0 < bid <= ask < 1`);
      else if (!sizeOk(q.bidSize) || !sizeOk(q.askSize) || !(q.sizeUnit === null || q.sizeUnit === 'contracts')) bad(`${a}.quotes.${k} sizes`);
      else if ((q.sizeUnit === null) !== (q.bidSize === null && q.askSize === null)) bad(`${a}.quotes.${k}: sizeUnit must be set exactly when a size is known`);
    }
  }
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
  if (t.division !== undefined && !(t.division === null || DIVISIONS.includes(t.division))) bad(`${at}.division ${t.division} (fbs, fcs or null)`);
}

// Part B fields: Team.division and Game.cls together on college games only, cls agreeing with the divisions; a lookahead
// game is a college game 9 to 16 days out with only its winner markets and nothing the core builders add.
function checkPartB(g, at, bad, genMs) {
  const hasCls = g.cls !== undefined;
  const hasDiv = g.home?.division !== undefined || g.away?.division !== undefined;
  if (g.league !== 'cfb') {
    if (hasCls || hasDiv || g.lookahead !== undefined) bad(`${at}: cls, division and lookahead are college fields`);
    return;
  }
  if (hasCls !== hasDiv || (hasDiv && (g.home?.division === undefined || g.away?.division === undefined))) bad(`${at}: cls and both team divisions come together`);
  if (hasCls) {
    if (!(g.cls === null || CLASSES.includes(g.cls))) bad(`${at}.cls ${g.cls} (FF, FC, CC or null)`);
    const h = g.home?.division, a = g.away?.division;
    const want = !h || !a ? null : h === 'fbs' && a === 'fbs' ? 'FF' : h === 'fcs' && a === 'fcs' ? 'CC' : 'FC';
    if (g.cls !== want) bad(`${at}.cls ${g.cls} does not match the divisions ${h} and ${a}`);
  }
  if (g.lookahead !== undefined) {
    if (g.lookahead !== true) bad(`${at}.lookahead must be true when present`);
    if (!hasCls) bad(`${at}: a lookahead game carries cls`);
    if (g.state !== 'pre') bad(`${at}: a lookahead game is pregame`);
    const d = Date.parse(g.kickoff) - genMs;
    if (Number.isFinite(d) && !(d > LOOKAHEAD_MS[0] && d <= LOOKAHEAD_MS[1])) bad(`${at}: a lookahead game kicks off 9 to 16 days after generatedAt`);
    const k = g.kalshi;
    if (isObj(k)) {
      if (!k.gameEvent) bad(`${at}: a lookahead game is matched to a Kalshi game event`);
      if (k.spreadEvent !== null || k.totalEvent !== null || (k.teamTotalEvent ?? null) !== null) bad(`${at}: a lookahead game has no ladder events`);
      if (Array.isArray(k.markets) && k.markets.some((m) => m?.type !== 'game')) bad(`${at}: a lookahead game carries winner markets only`);
    }
    if (g.refs !== undefined) bad(`${at}: a lookahead game has no Pinnacle or venue refs`);
    if (g.dkTeamTotals !== undefined && g.dkTeamTotals !== null) bad(`${at}: a lookahead game has no DK team totals`);
    if (Array.isArray(g.angles) && g.angles.length) bad(`${at}: a lookahead game has no angles`);
    if (isObj(g.injuries) && ((g.injuries.home || []).length || (g.injuries.away || []).length)) bad(`${at}: a lookahead game has no injuries`);
  }
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

function checkGame(g, at, bad, genMs = NaN) {
  if (!isObj(g)) return bad(`${at} missing`);
  checkPartB(g, at, bad, genMs);
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
    // Kalshi's folded book on the previous run (lib/moves.mjs prevBooks): optional, both fields together, pregame only
    if (k.prevQuotes !== undefined || k.prevAt !== undefined) {
      const okP = (x) => isNum(x) && x > 0 && x < 1;
      if (!isIso(k.prevAt)) bad(`${at}.kalshi.prevAt must be ISO UTC`);
      if (!isObj(k.prevQuotes) || !Object.keys(k.prevQuotes).length) bad(`${at}.kalshi.prevQuotes must be a non-empty object`);
      else for (const [key, q] of Object.entries(k.prevQuotes)) if (!VENUE_KEY_RE.test(key) || !isObj(q) || !okP(q.bid) || !okP(q.ask)) bad(`${at}.kalshi.prevQuotes.${key}`);
      if (g.state !== 'pre') bad(`${at}.kalshi.prevQuotes on a game that is not pregame`);
    }
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
      if (g.refs.venues !== undefined) checkVenueRefs(g.refs.venues, `${at}.refs.venues`, bad);
      if (g.state !== 'pre') bad(`${at}.refs on a game that is not pregame`);
    }
  }
  if (!(g.weather === null || (isObj(g.weather) && numOrNull(g.weather.tempF) && numOrNull(g.weather.windMph)))) bad(`${at}.weather`);
}
