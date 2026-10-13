// Trim saved research captures into the offline fixtures for the exchange reference venues (lib/venues).
// usage: node scripts/make-venue-fixtures.mjs <research4 dir> <gemini list json>
//   research4/polymarket/live/inputs.json.gz     collect.mjs --save-inputs capture at 2026-10-12T23:34Z: ESPN boards kept
//   research4/polymarket/live/snapshot.json      the snapshot of that capture: Kalshi books per game, for orientation checks
//   research4/polymarket/live/us_events_slim.json Polymarket US NFL + CFB events at 23:36:52Z (research slim copy; rebuilt
//                                                into the raw gateway shape with only the fields the parser reads)
//   research4/polymarket/live/us_nfl_events.json  one raw NFL event (BUF @ LAR, 23:31Z) kept whole but trimmed
//   research4/other-venues/sx-nfl-gamelines.json  SX /markets/active (NFL game lines) at about 23:33Z
//   research4/other-venues/sx-nfl-ml-snapshots.json  SX taker perspective books of the 15 NFL moneylines in the window
//   <gemini list json>  GET /v1/prediction-markets/events?status=active&category=sports&sport=american_football
//                       &sports_market_type=moneyline|spread|total&sports_market_scope=full_contest&limit=200 (2026-10-13T00:30:36Z)
// Output: test/fixtures/venues/*.json.gz (gzipped compact JSON).

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'fixtures', 'venues');
const [R, geminiFile] = process.argv.slice(2);
if (!R || !geminiFile) {
  console.error('usage: node scripts/make-venue-fixtures.mjs <research4 dir> <gemini list json>');
  process.exit(2);
}
const rd = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'));
const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
};
mkdirSync(OUT, { recursive: true });
const save = (name, data) => {
  const f = join(OUT, name);
  writeFileSync(f, gzipSync(Buffer.from(JSON.stringify(data), 'utf8'), { level: 9 }));
  console.log(`${name}: ${(statSync(f).size / 1024).toFixed(1)} KB`);
};

// ---- ESPN boards (same trim as scripts/make-pinnacle-fixtures.mjs)
const side = (s, withLine) => s && { close: s.close && pick(s.close, withLine ? ['line', 'odds'] : ['odds']), open: s.open && pick(s.open, withLine ? ['line', 'odds'] : ['odds']) };
const trimOdds = (o) => ({
  provider: pick(o.provider, ['id', 'name']), details: o.details, spread: o.spread, overUnder: o.overUnder,
  moneyline: o.moneyline && { home: side(o.moneyline.home, false), away: side(o.moneyline.away, false) },
  pointSpread: o.pointSpread && { home: side(o.pointSpread.home, true), away: side(o.pointSpread.away, true) },
  total: o.total && { over: side(o.total.over, true), under: side(o.total.under, true) },
});
const trimEvent = (e) => {
  const c = e.competitions[0];
  return {
    id: e.id, date: e.date, shortName: e.shortName, season: e.season, week: e.week ? { number: e.week.number } : undefined,
    status: { type: pick(e.status?.type, ['state', 'completed']) },
    competitions: [{
      id: c.id, date: c.date, neutralSite: c.neutralSite, venue: c.venue ? { indoor: c.venue.indoor } : undefined,
      competitors: c.competitors.map((x) => ({
        homeAway: x.homeAway,
        team: pick(x.team, ['id', 'location', 'name', 'abbreviation', 'displayName', 'shortDisplayName']),
        records: (x.records || []).filter((r) => r.type === 'total' || r.name === 'overall').map((r) => pick(r, ['name', 'type', 'summary'])),
      })),
      odds: Array.isArray(c.odds) ? c.odds.filter((o) => String(o?.provider?.id) === '100').map(trimOdds) : undefined,
    }],
  };
};
const trimBoard = (j) => ({ season: j.season, week: j.week ? { number: j.week.number } : undefined, events: (j.events || []).map(trimEvent) });
const cap = JSON.parse(gunzipSync(readFileSync(join(R, 'polymarket', 'live', 'inputs.json.gz'))).toString('utf8'));
save('espn-boards-20261012.json.gz', {
  now: cap.now,
  scoreboards: Object.fromEntries(Object.entries(cap.inputs.espn.scoreboards).map(([lg, boards]) => [lg, boards.map(trimBoard)])),
});

// ---- Kalshi books of that capture, per ESPN game (folded later by the test): { espnId: { league, kickoff, markets } }
const snap = rd(R, 'polymarket', 'live', 'snapshot.json');
const kalshi = {};
for (const g of snap.games) {
  if (g.state !== 'pre' || !g.kalshi?.markets?.length) continue;
  kalshi[g.espnId] = {
    league: g.league, kickoff: g.kickoff,
    markets: g.kalshi.markets.filter((m) => ['game', 'spread', 'total'].includes(m.type)).map((m) => pick(m, ['type', 'team', 'strike', 'yesBid', 'yesAsk', 'status'])),
  };
}
save('kalshi-books-20261012.json.gz', { generatedAt: snap.generatedAt, games: kalshi });

// ---- Polymarket US: the slim copy rebuilt into the raw gateway shape (only the fields lib/venues/polyus.mjs reads)
const slim = rd(R, 'polymarket', 'live', 'us_events_slim.json');
const q = (v) => (v == null ? null : { value: String(v), currency: 'USD' });
const rebuild = (e) => ({
  slug: e.slug, title: e.title, startTime: e.startTime, closed: false, archived: false,
  markets: e.markets.filter((m) => m.type.startsWith('football_team_full_game_')).map((m) => ({
    slug: m.slug, sportsMarketType: m.type, ...(m.line != null ? { line: m.line } : {}), status: m.status, gameStartTime: m.gst,
    bestBidQuote: q(m.bid), bestAskQuote: q(m.ask),
    marketSides: m.sides.map((s) => ({ long: s.long, description: s.desc, ...(s.team ? { team: { name: s.team.name, ordering: s.team.ordering } } : {}) })),
  })),
});
// One raw NFL event, every market type kept (the parser must ignore halves, quarters and team totals).
const raw = rd(R, 'polymarket', 'live', 'us_nfl_events.json').events.find((e) => e.slug === 'nfl-buf-lar-2026-10-12');
const rawTrim = {
  ...pick(raw, ['id', 'slug', 'title', 'startTime', 'closed', 'archived', 'active']),
  markets: raw.markets.map((m) => ({
    ...pick(m, ['slug', 'sportsMarketType', 'line', 'status', 'closed', 'archived', 'gameStartTime', 'bestBidQuote', 'bestAskQuote', 'feeCoefficient']),
    marketSides: (m.marketSides || []).map((s) => ({ ...pick(s, ['long', 'description']), ...(s.team ? { team: pick(s.team, ['name', 'abbreviation', 'ordering']) } : {}) })),
  })),
};
save('polyus-20261012.json.gz', {
  fetchedAt: slim.fetchedAt.replace(/\.\d{3}Z$/, 'Z'),
  nfl: slim.events.nfl.map(rebuild), cfb: slim.events.cfb.map(rebuild),
  rawBufLar: { fetchedAt: '2026-10-12T23:31:19Z', event: rawTrim },
});

// ---- Gemini: the moneyline events with their nested full game spread and total events (descriptions and images
// dropped); one nested first half and team total event per game kept so the parser's filters are exercised.
const gem = rd(geminiFile);
const trimContract = (c) => pick(c, ['id', 'label', 'prices', 'status', 'ticker', 'instrumentSymbol', 'marketState', 'abbreviatedName', 'sportsSide', 'strike', 'sortOrder']);
const trimGemEvent = (e) => ({
  ...pick(e, ['id', 'title', 'type', 'ticker', 'status', 'startTime', 'isLive', 'participants', 'sportsMarket', 'volume']),
  contracts: (e.contracts || []).map(trimContract),
});
const keepNested = (n) => /-(S|T|1HM|TT)$/.test(n.ticker);
save('gemini-20261013.json.gz', {
  fetchedAt: '2026-10-13T00:30:36Z',
  pagination: gem.pagination,
  data: gem.data.filter((e) => /-M$/.test(e.ticker)).map((e) => ({ ...trimGemEvent(e), events: (e.events || []).filter(keepNested).map(trimGemEvent) })),
});

// ---- SX Bet: the NFL game lines list and the moneyline books (taker perspective)
const sxList = rd(R, 'other-venues', 'sx-nfl-gamelines.json');
const sxSnaps = rd(R, 'other-venues', 'sx-nfl-ml-snapshots.json');
save('sx-20261012.json.gz', {
  fetchedAt: '2026-10-12T23:33:00Z',
  markets: { status: sxList.status, data: { nextKey: null, markets: sxList.data.markets.map((m) => pick(m, ['status', 'marketHash', 'outcomeOneName', 'outcomeTwoName', 'teamOneName', 'teamTwoName', 'type', 'gameTime', 'line', 'sportXeventId', 'leagueId', 'leagueLabel', 'mainLine'])) } },
  books: Object.fromEntries(Object.values(sxSnaps).map((s) => [s.book.marketHash, s.book])),
});
