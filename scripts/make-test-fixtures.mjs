// Trim saved raw API captures into small offline test fixtures (keeps only the fields the collector reads).
// usage: node scripts/make-test-fixtures.mjs <researchKalshiDir> <researchDir> <balatlRawDir>
//   researchKalshiDir: folder with raw_KXNFLGAME.json ... and espn_nfl_w6.json / espn_cfb_w7.json (the matcher run of 2026-10-11)
//   researchDir:       folder with series_*.json and mvecombo_collections_trim.json
//   balatlRawDir:      raw capture of BAL@ATL at 2026-10-11T23:49Z (kalshi_*.json, espn_scoreboard.json, espn_summary.json)
// Output: test/fixtures/research-20261011/ and test/fixtures/balatl-20261011/ (compact JSON).

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [kalshiDir, researchDir, balatlDir] = process.argv.slice(2);
if (!kalshiDir || !researchDir || !balatlDir) {
  console.error('usage: node scripts/make-test-fixtures.mjs <researchKalshiDir> <researchDir> <balatlRawDir>');
  process.exit(2);
}
const rd = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
};

const MARKET_KEYS = ['ticker', 'event_ticker', 'status', 'yes_sub_title', 'floor_strike', 'strike_type', 'custom_strike', 'close_time',
  'yes_ask_dollars', 'yes_bid_dollars', 'no_ask_dollars', 'no_bid_dollars', 'yes_ask_size_fp', 'yes_bid_size_fp',
  'last_price_dollars', 'previous_yes_ask_dollars', 'volume_fp', 'volume_24h_fp', 'open_interest_fp'];
const trimMarkets = (j) => ({ cursor: '', markets: (j.markets || []).map((m) => pick(m, MARKET_KEYS)) });

function trimOddsSide(s, withLine) {
  if (!s) return undefined;
  const one = (x) => (x ? pick(x, withLine ? ['line', 'odds'] : ['odds']) : undefined);
  return { close: one(s.close), open: one(s.open) };
}
function trimOdds(o) {
  return {
    provider: pick(o.provider, ['id', 'name']),
    details: o.details, spread: o.spread, overUnder: o.overUnder,
    moneyline: o.moneyline && { home: trimOddsSide(o.moneyline.home, false), away: trimOddsSide(o.moneyline.away, false) },
    pointSpread: o.pointSpread && { home: trimOddsSide(o.pointSpread.home, true), away: trimOddsSide(o.pointSpread.away, true) },
    total: o.total && { over: trimOddsSide(o.total.over, true), under: trimOddsSide(o.total.under, true) },
  };
}
function trimEvent(e) {
  const c = e.competitions[0];
  return {
    id: e.id, date: e.date, name: e.name, shortName: e.shortName,
    season: e.season, week: e.week ? { number: e.week.number } : undefined,
    status: { type: pick(e.status?.type, ['state', 'completed']) },
    weather: e.weather ? pick(e.weather, ['displayValue', 'temperature']) : undefined,
    competitions: [{
      id: c.id, date: c.date, neutralSite: c.neutralSite,
      venue: c.venue ? { indoor: c.venue.indoor } : undefined,
      competitors: c.competitors.map((x) => ({
        homeAway: x.homeAway,
        team: pick(x.team, ['id', 'location', 'name', 'abbreviation', 'displayName', 'shortDisplayName', 'logo']),
        records: (x.records || []).filter((r) => r.type === 'total' || r.name === 'overall').map((r) => pick(r, ['name', 'type', 'summary'])),
      })),
      odds: Array.isArray(c.odds) ? c.odds.map(trimOdds) : undefined,
    }],
  };
}
const trimBoard = (j) => ({
  leagues: (j.leagues || []).map((l) => pick(l, ['slug', 'season', 'calendar'])),
  season: j.season,
  week: j.week ? { number: j.week.number } : undefined,
  events: (j.events || []).map(trimEvent),
});
function trimSummary(j) {
  return {
    injuries: (j.injuries || []).map((t) => ({
      team: pick(t.team, ['id', 'abbreviation', 'displayName']),
      injuries: (t.injuries || []).map((x) => ({
        status: x.status, date: x.date,
        athlete: { ...pick(x.athlete, ['id', 'displayName', 'fullName', 'jersey']), position: pick(x.athlete?.position, ['abbreviation']) },
        type: pick(x.type, ['description', 'abbreviation']),
        details: pick(x.details, ['type', 'location', 'detail', 'side', 'returnDate']),
      })),
    })),
  };
}

function write(dir, name, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
}

const R = join(ROOT, 'test/fixtures/research-20261011');
for (const s of ['KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL', 'KXNCAAFGAME', 'KXNCAAFSPREAD', 'KXNCAAFTOTAL']) {
  write(R, `kalshi_${s}.json`, trimMarkets(rd(join(kalshiDir, `raw_${s}.json`))));
}
write(R, 'espn_nfl_w6.json', trimBoard(rd(join(kalshiDir, 'espn_nfl_w6.json'))));
write(R, 'espn_cfb_w7.json', trimBoard(rd(join(kalshiDir, 'espn_cfb_w7.json'))));
const series = {};
for (const s of ['KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL', 'KXNCAAFGAME', 'KXNCAAFSPREAD', 'KXNCAAFTOTAL']) {
  series[s] = pick(rd(join(researchDir, `series_${s}.json`)).series, ['ticker', 'fee_type', 'fee_multiplier']);
}
write(R, 'series.json', series);
const col = rd(join(researchDir, 'mvecombo_collections_trim.json'));
write(R, 'collections.json', (col.open_collections || []).map((c) => ({
  ...pick(c, ['collection_ticker', 'series_ticker', 'size_min', 'size_max']),
  associated_events: (c.associated_events || []).map((e) => pick(e, ['ticker', 'is_yes_only', 'size_max'])),
})));

const B = join(ROOT, 'test/fixtures/balatl-20261011');
for (const s of ['KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL']) write(B, `kalshi_${s}.json`, trimMarkets(rd(join(balatlDir, `kalshi_${s}.json`))));
write(B, 'espn_scoreboard.json', trimBoard(rd(join(balatlDir, 'espn_scoreboard.json'))));
write(B, 'espn_summary.json', trimSummary(rd(join(balatlDir, 'espn_summary.json'))));
write(B, 'fetched_at.txt', readFileSync(join(balatlDir, 'fetched_at.txt'), 'utf8').trim() + '\n');

let total = 0;
for (const d of [R, B]) for (const f of readdirSync(d)) { const n = statSync(join(d, f)).size; total += n; console.log(`${(n / 1024).toFixed(0).padStart(6)} KB  ${d.slice(ROOT.length + 1)}/${f}`); }
console.log(`${(total / 1024).toFixed(0).padStart(6)} KB  total`);
