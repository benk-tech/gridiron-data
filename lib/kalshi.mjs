// Kalshi public market data: fetching (paginated, host fallback) and pure parsing/trimming.
// Verified against the live API on 2026-10-11 (see SPEC section 3). No auth is used anywhere.

import { HttpError, errorText } from './http.mjs';

// SPEC: primary host first, fallback second. Both answer the same public endpoints.
export const KALSHI_HOSTS = [
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://external-api.kalshi.com/trade-api/v2',
];

export const CORE_SERIES = {
  nfl: { game: 'KXNFLGAME', spread: 'KXNFLSPREAD', total: 'KXNFLTOTAL' },
  cfb: { game: 'KXNCAAFGAME', spread: 'KXNCAAFSPREAD', total: 'KXNCAAFTOTAL' },
};
export const CORE_SERIES_LIST = Object.values(CORE_SERIES).flatMap((s) => [s.game, s.spread, s.total]);

// Used only when /series/{t} was not fetched; matches the live value seen 2026-10-11 on all six core series.
export const DEFAULT_FEE = { feeType: 'quadratic_with_maker_fees', multiplier: 1 };

// ---------------------------------------------------------------- fetching

function queryString(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * createKalshiClient({ http, hosts }) -> { get(path, params), stats, hostUsed() }
 * Tries the preferred host, then the other one, on network errors, timeouts, 403, 429 and 5xx.
 * A 400 or 404 is final (the request itself is wrong, another host will not fix it).
 */
export function createKalshiClient({ http, hosts = KALSHI_HOSTS }) {
  let preferred = 0;
  async function get(path, params) {
    const qs = queryString(params);
    let last;
    for (let i = 0; i < hosts.length; i++) {
      const h = (preferred + i) % hosts.length;
      try {
        const j = await http.getJson(hosts[h] + path + qs);
        preferred = h;
        return j;
      } catch (e) {
        last = e;
        if (e instanceof HttpError && (e.status === 400 || e.status === 404)) throw e;
      }
    }
    throw last;
  }
  return { get, stats: http.stats, hostUsed: () => hosts[preferred] };
}

// All markets for one query, following `cursor` until it is '' or missing (SPEC: paginate until empty).
export async function fetchAllMarkets(client, params, { maxPages = 12 } = {}) {
  let cursor = '';
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const j = await client.get('/markets', { ...params, limit: 1000, cursor });
    if (Array.isArray(j?.markets)) out.push(...j.markets);
    cursor = j?.cursor || '';
    if (!cursor) return out;
  }
  throw new Error(`markets ${params.series_ticker || ''}: more than ${maxPages} pages`);
}

// Open markets of one series. maxCloseTs (unix seconds) trims far-future games; close_time = kickoff + 48h.
// If the API ever rejects max_close_ts with a 400, retry once without it (it is only a payload optimisation).
export async function fetchSeriesMarkets(client, series, { maxCloseTs } = {}) {
  const base = { series_ticker: series, status: 'open' };
  if (!maxCloseTs) return fetchAllMarkets(client, base);
  try {
    return await fetchAllMarkets(client, { ...base, max_close_ts: maxCloseTs });
  } catch (e) {
    if (e instanceof HttpError && e.status === 400) return fetchAllMarkets(client, base);
    throw e;
  }
}

// GET /series/{t} -> series object ({ fee_type, fee_multiplier, ... }).
export async function fetchSeriesInfo(client, series) {
  const j = await client.get(`/series/${encodeURIComponent(series)}`);
  if (!j?.series) throw new Error(`series ${series}: no series object`);
  return j.series;
}

// GET /multivariate_event_collections?status=open (paginated, at most a few pages).
export async function fetchOpenCollections(client, { maxPages = 5 } = {}) {
  let cursor = '';
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const j = await client.get('/multivariate_event_collections', { status: 'open', limit: 200, cursor });
    if (Array.isArray(j?.multivariate_contracts)) out.push(...j.multivariate_contracts);
    cursor = j?.cursor || '';
    if (!cursor) break;
  }
  return out;
}

const TICKER_RE = /^[A-Z0-9][A-Z0-9._-]{2,120}$/;

// GET /markets?tickers=A,B,C in chunks of 100 (comma form verified on /markets; it does NOT work on /markets/orderbooks).
// No status filter, so settled markets come back too.
export async function fetchMarketsByTickers(client, tickers, { chunk = 100 } = {}) {
  const clean = [...new Set(tickers.filter((t) => typeof t === 'string' && TICKER_RE.test(t)))];
  const out = [];
  for (let i = 0; i < clean.length; i += chunk) {
    const part = clean.slice(i, i + chunk);
    const j = await client.get('/markets', { tickers: part.join(','), limit: 1000 });
    if (Array.isArray(j?.markets)) out.push(...j.markets);
  }
  return out;
}

// ---------------------------------------------------------------- parsing (pure)

const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// 'KXNCAAFSPREAD-26OCT17NEBORE' -> { series, dateKey: '2026-10-17', teamsPart: 'NEBORE', eventKey: '26OCT17NEBORE' }
// The date is the US/Eastern calendar date of Kalshi's scheduled kickoff; teams are AWAY + HOME.
export function parseEventTicker(et) {
  const m = /^([A-Z0-9]+)-(\d{2})([A-Z]{3})(\d{2})([A-Z0-9]+)$/.exec(String(et || ''));
  if (!m || !MON[m[3]]) return null;
  return {
    series: m[1],
    dateKey: `20${m[2]}-${String(MON[m[3]]).padStart(2, '0')}-${m[4]}`,
    teamsPart: m[5],
    eventKey: `${m[2]}${m[3]}${m[4]}${m[5]}`,
  };
}

// Market suffix: GAME 'ORE' (team code) | SPREAD 'ORE8' (code + ceil(strike)) | TOTAL '74' (ceil(strike)).
export function marketSuffix(m) {
  return String(m.ticker).slice(String(m.event_ticker).length + 1);
}

// Split 'NDSUUNM' using the GAME market codes ['UNM','NDSU'] -> ['NDSU','UNM'] = [away, home].
export function splitTeams(teamsPart, codes) {
  for (const a of codes) for (const b of codes) if (a !== b && a + b === teamsPart) return [a, b];
  return null;
}

// Kalshi sends prices and sizes as decimal strings. '' / null / junk -> null.
export function num(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

const round4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);

/** Trim a raw Kalshi market to the SPEC Market shape. type/team/strike are resolved by the caller. */
export function trimMarket(m, { type, team = null, strike = null }) {
  const yesBid = num(m.yes_bid_dollars);
  const yesAsk = num(m.yes_ask_dollars);
  return {
    ticker: m.ticker,
    event: m.event_ticker,
    series: String(m.event_ticker).split('-')[0],
    type,
    team,
    strike,
    title: m.yes_sub_title || m.title || '',
    yesAsk,
    yesBid,
    noAsk: num(m.no_ask_dollars) ?? (yesBid == null ? null : round4(1 - yesBid)),
    noBid: num(m.no_bid_dollars) ?? (yesAsk == null ? null : round4(1 - yesAsk)),
    yesAskSize: num(m.yes_ask_size_fp),
    yesBidSize: num(m.yes_bid_size_fp), // NO is bought by hitting YES bids, so this is also the NO ask size
    lastPrice: num(m.last_price_dollars),
    prevYesAsk: num(m.previous_yes_ask_dollars),
    volume: num(m.volume_fp),
    volume24h: num(m.volume_24h_fp),
    openInterest: num(m.open_interest_fp),
    status: m.status ?? null,
  };
}

// Open markets only. The /markets?status=open query returns status 'active'; anything else (paused, closed) is dropped.
export const isOpenMarket = (m) => !m.status || m.status === 'active';

function groupBy(arr, f) {
  const m = new Map();
  for (const x of arr) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

const DAY = 86400e3;
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;

/**
 * Group GAME / SPREAD / TOTAL markets into Kalshi games and resolve every market's team and strike.
 * Returns { games: Map<gameEventTicker, KGame>, orphans: [eventTicker], errors: [string], stats }.
 * KGame = { eventTicker, eventKey, series, dateKey, teamsPart, away:{code,name,teamId}, home:{...},
 *           spreadEvent, totalEvent, legs: [{ m, type, code, strike }] }   (code = Kalshi team code or null for totals)
 * Spread/total events join the GAME event by teams part within +/- 1 day (CFB date codes differ on about half the games).
 * Spread team: custom_strike.football_team UUID against the two GAME markets, confirmed by the ticker suffix code;
 * if the two disagree the market is dropped and an error recorded (never guess).
 */
export function buildKalshiGames(gameMarkets = [], spreadMarkets = [], totalMarkets = []) {
  const errors = [];
  const stats = { gameEvents: 0, spreadLinked: 0, totalLinked: 0, spreadDropped: 0, totalDropped: 0, uuidConfirmed: 0, codeOnly: 0 };
  const games = new Map();

  for (const [et, all] of groupBy(gameMarkets.filter(isOpenMarket), (m) => m.event_ticker)) {
    const p = parseEventTicker(et);
    if (!p) { errors.push(`${et}: unparsed GAME event ticker`); continue; }
    if (all.length !== 2) { errors.push(`${et}: expected 2 GAME markets, got ${all.length}`); continue; }
    const codes = all.map(marketSuffix);
    const order = splitTeams(p.teamsPart, codes);
    if (!order) { errors.push(`${et}: cannot split ${p.teamsPart} with ${codes.join('/')}`); continue; }
    const side = (code) => {
      const m = all.find((x) => marketSuffix(x) === code);
      return { code, name: m.yes_sub_title || '', teamId: m.custom_strike?.football_team ?? null, market: m };
    };
    const g = { eventTicker: et, eventKey: p.eventKey, series: p.series, dateKey: p.dateKey, teamsPart: p.teamsPart,
      away: side(order[0]), home: side(order[1]), spreadEvent: null, totalEvent: null, legs: [] };
    g.legs.push({ m: g.away.market, type: 'game', code: g.away.code, strike: null });
    g.legs.push({ m: g.home.market, type: 'game', code: g.home.code, strike: null });
    games.set(et, g);
    stats.gameEvents++;
  }

  const byTeams = groupBy([...games.values()], (g) => g.teamsPart);
  const findGame = (et) => {
    const p = parseEventTicker(et);
    if (!p) return null;
    let best = null, bestDd = 2;
    for (const g of byTeams.get(p.teamsPart) || []) {
      const dd = dayDiff(g.dateKey, p.dateKey);
      if (dd <= 1 && dd < bestDd) { best = g; bestDd = dd; }
    }
    return best;
  };

  const orphans = new Set();
  const link = (m, type) => {
    const g = findGame(m.event_ticker);
    if (!g) { orphans.add(m.event_ticker); return null; }
    const key = type === 'spread' ? 'spreadEvent' : 'totalEvent';
    if (g[key] && g[key] !== m.event_ticker) {
      errors.push(`${m.event_ticker}: second ${type} event for ${g.eventTicker} (kept ${g[key]})`);
      return null;
    }
    g[key] = m.event_ticker;
    return g;
  };

  for (const m of spreadMarkets.filter(isOpenMarket)) {
    const g = link(m, 'spread');
    if (!g) continue;
    const sfx = /^([A-Z]+)(\d+)$/.exec(marketSuffix(m));
    const tickerCode = sfx?.[1] ?? null;
    const tickerNum = sfx ? Number(sfx[2]) : null;
    const codeOk = tickerCode === g.away.code || tickerCode === g.home.code;
    const uuid = m.custom_strike?.football_team ?? null;
    const uuidCode = uuid && uuid === g.away.teamId ? g.away.code : uuid && uuid === g.home.teamId ? g.home.code : null;
    if (uuidCode && tickerCode && uuidCode !== tickerCode) {
      errors.push(`${m.ticker}: team UUID says ${uuidCode}, ticker says ${tickerCode}; dropped`);
      stats.spreadDropped++;
      continue;
    }
    const code = uuidCode || (codeOk ? tickerCode : null);
    if (!code) {
      errors.push(`${m.ticker}: cannot resolve spread team; dropped`);
      stats.spreadDropped++;
      continue;
    }
    if (uuidCode) stats.uuidConfirmed++; else stats.codeOnly++;
    const strike = resolveStrike(m, tickerNum, errors);
    if (strike == null) { stats.spreadDropped++; continue; }
    g.legs.push({ m, type: 'spread', code, strike });
    stats.spreadLinked++;
  }

  for (const m of totalMarkets.filter(isOpenMarket)) {
    const g = link(m, 'total');
    if (!g) continue;
    const sfx = /^(\d+)$/.exec(marketSuffix(m));
    const strike = resolveStrike(m, sfx ? Number(sfx[1]) : null, errors);
    if (strike == null) { stats.totalDropped++; continue; }
    g.legs.push({ m, type: 'total', code: null, strike });
    stats.totalLinked++;
  }

  return { games, orphans: [...orphans].sort(), errors, stats };
}

// floor_strike is the contract term (YES = over strike). The ticker suffix number must equal ceil(strike).
function resolveStrike(m, tickerNum, errors) {
  let strike = num(m.floor_strike);
  if (strike == null && tickerNum != null) strike = tickerNum - 0.5;
  if (strike == null) {
    errors.push(`${m.ticker}: no strike; dropped`);
    return null;
  }
  if (tickerNum != null && Math.ceil(strike) !== tickerNum) {
    errors.push(`${m.ticker}: floor_strike ${strike} does not match suffix ${tickerNum} (kept floor_strike)`);
  }
  return strike;
}

// /series/{t} objects -> SPEC fees map { SERIES: { feeType, multiplier } }.
export function feeFromSeries(s) {
  if (!s || typeof s !== 'object') return null;
  return { feeType: String(s.fee_type || DEFAULT_FEE.feeType), multiplier: num(s.fee_multiplier) ?? 1 };
}

// Pick the open combo collection: prefer KXMVECROSSCATEGORY-* that is not a shard, then any cross-category, then the first.
export function pickCollection(collections = []) {
  const list = collections.filter((c) => c && typeof c.collection_ticker === 'string');
  return (
    list.find((c) => /^KXMVECROSSCATEGORY-/.test(c.collection_ticker) && !/SHARD/.test(c.collection_ticker)) ||
    list.find((c) => /^KXMVECROSSCATEGORY/.test(c.collection_ticker)) ||
    list[0] ||
    null
  );
}

export function collectionEventTickers(c) {
  if (!c) return [];
  if (Array.isArray(c.associated_events)) return c.associated_events.map((e) => e?.ticker).filter(Boolean);
  if (Array.isArray(c.associated_event_tickers)) return c.associated_event_tickers.filter(Boolean);
  return [];
}

// Settled-result row for POST /api/collector/settle. Only markets with a yes/no result are reported.
export function settleRow(m) {
  const result = m?.result === 'yes' || m?.result === 'no' ? m.result : '';
  if (!result) return null;
  const when = m.settlement_ts || m.expiration_time || m.close_time || null;
  const t = when ? Date.parse(when) : NaN;
  return {
    ticker: m.ticker,
    status: m.status ?? '',
    result,
    settledAt: Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
  };
}

export { errorText };
