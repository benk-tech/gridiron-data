// Trim a live collector run into the offline fixture for the Polymarket US format of 2026-10-15 (lib/venues/polyus.mjs):
// the league lists now carry only each event's winner market, and the spreads and totals come with the event detail.
// The format before (the lines inside the list) is test/fixtures/venues/polyus-20261012.json.gz.
//
// usage: node scripts/make-polyus-fixtures.mjs <record dir> <inputs.json.gz> <snapshot.json> <out name>
//   <record dir>      the raw gateway answers of the run (scripts/record-polyus.mjs: index.json + <n>.json.gz)
//   <inputs.json.gz>  the same run's --save-inputs file (ESPN boards and the run's clock)
//   <snapshot.json>   the same run's --out snapshot (Kalshi books per game, for orientation checks)
// The 2026-10-16 fixture: POLYUS_RECORD_DIR=... node --import ./scripts/record-polyus.mjs collect.mjs --out snap.json
//   --cache-dir cache --state-dir state --polyus-details 16 --save-inputs inputs.json.gz (07:05Z, 20 gateway GETs:
//   4 list pages, 8 NFL and 8 college details). Pass --closes-dir too (a scratch folder), or the run copies finished
//   days of closes into closes/ of this checkout.
// Output: test/fixtures/venues/<out name> (gzipped compact JSON):
//   { now, fetchedAt, list: { nfl: [event], cfb: [event] }, details: [event], espn: { scoreboards }, kalshi: { games } }
//   list events and details keep only the fields the parser reads plus a few that identify them; a detail keeps every
//   full game winner, spread and total market and one market of a few other kinds (halves, team totals, a player
//   prop), so the parser's filters are still exercised. Kalshi books: pregame games on the saved boards (the FCS and
//   lookahead boards are left out), winner, spread and total markets.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'fixtures', 'venues');
const [recDir, inputsFile, snapFile, outName] = process.argv.slice(2);
if (!recDir || !inputsFile || !snapFile || !outName) {
  console.error('usage: node scripts/make-polyus-fixtures.mjs <record dir> <inputs.json.gz> <snapshot.json> <out name>');
  process.exit(2);
}
const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
};
const gzJson = (f) => JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));

// ---- Polymarket US: the recorded list pages and event details
const FULL = new Set(['football_team_full_game_winner', 'football_team_full_game_spread', 'football_team_full_game_total']);
const OTHER_KINDS = ['football_team_first_half_spread', 'football_game_first_half_total', 'football_team_points_full_game_total', 'football_player_passing_yards'];
const trimMarket = (m) => ({
  ...pick(m, ['slug', 'title', 'sportsMarketType', 'sportsMarketTypeV2', 'marketType', 'line', 'status', 'active', 'closed', 'archived', 'gameStartTime', 'bestBidQuote', 'bestAskQuote']),
  marketSides: (m.marketSides || []).map((s) => ({ ...pick(s, ['long', 'description']), ...(s.team ? { team: pick(s.team, ['name', 'abbreviation', 'ordering']) } : {}) })),
});
const bySlug = (a, b) => (String(a.slug) < String(b.slug) ? -1 : String(a.slug) > String(b.slug) ? 1 : 0);
const trimEvent = (e, keepMarket) => ({
  ...pick(e, ['id', 'slug', 'title', 'startTime', 'active', 'closed', 'archived', 'marketCounts']),
  markets: [...(e.markets || [])].sort(bySlug).filter(keepMarket).map(trimMarket),
});
const index = JSON.parse(readFileSync(join(recDir, 'index.json'), 'utf8')).sort((a, b) => a.n - b.n);
const list = {};
const details = [];
for (const r of index) {
  if (r.status !== 200) continue;
  const u = new URL(r.url);
  const body = gzJson(join(recDir, `${r.n}.json.gz`));
  const lg = /^\/v2\/leagues\/(nfl|cfb)\/events$/.exec(u.pathname)?.[1];
  if (lg) {
    (list[lg] ||= []).push(...body.events.map((e) => trimEvent(e, () => true)));
  } else if (u.pathname.startsWith('/v1/events/')) {
    const seen = new Set();
    details.push(trimEvent(body.event, (m) => {
      if (FULL.has(m.sportsMarketType)) return true;
      if (!OTHER_KINDS.includes(m.sportsMarketType) || seen.has(m.sportsMarketType)) return false;
      seen.add(m.sportsMarketType);
      return true;
    }));
  }
}
details.sort(bySlug);

// ---- ESPN boards of the run (same trim as scripts/make-venue-fixtures.mjs)
const side = (s, withLine) => s && { close: s.close && pick(s.close, withLine ? ['line', 'odds'] : ['odds']), open: s.open && pick(s.open, withLine ? ['line', 'odds'] : ['odds']) };
const trimOdds = (o) => ({
  provider: pick(o.provider, ['id', 'name']), details: o.details, spread: o.spread, overUnder: o.overUnder,
  moneyline: o.moneyline && { home: side(o.moneyline.home, false), away: side(o.moneyline.away, false) },
  pointSpread: o.pointSpread && { home: side(o.pointSpread.home, true), away: side(o.pointSpread.away, true) },
  total: o.total && { over: side(o.total.over, true), under: side(o.total.under, true) },
});
const trimEspn = (e) => {
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
const trimBoard = (j) => ({ season: j.season, week: j.week ? { number: j.week.number } : undefined, events: (j.events || []).map(trimEspn) });
const cap = gzJson(inputsFile);

// ---- Kalshi books of the same run, per ESPN game on those boards: { espnId: { league, kickoff, markets } }
const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
const onBoards = new Set(Object.values(cap.inputs.espn.scoreboards).flat().flatMap((b) => (b.events || []).map((e) => String(e.id))));
const kalshi = {};
for (const g of snap.games) {
  if (g.state !== 'pre' || !g.kalshi?.markets?.length || !onBoards.has(String(g.espnId))) continue;
  kalshi[g.espnId] = {
    league: g.league, kickoff: g.kickoff,
    markets: g.kalshi.markets.filter((m) => ['game', 'spread', 'total'].includes(m.type)).map((m) => pick(m, ['type', 'team', 'strike', 'yesBid', 'yesAsk', 'status'])),
  };
}

mkdirSync(OUT, { recursive: true });
const f = join(OUT, outName);
writeFileSync(f, gzipSync(Buffer.from(JSON.stringify({
  now: cap.now.replace(/\.\d{3}Z$/, 'Z'),
  fetchedAt: cap.inputs.venues.polyus.fetchedAt,
  list, details,
  espn: { scoreboards: Object.fromEntries(Object.entries(cap.inputs.espn.scoreboards).map(([lg, boards]) => [lg, boards.map(trimBoard)])) },
  kalshi: { generatedAt: snap.generatedAt, games: kalshi },
}), 'utf8'), { level: 9 }));
console.log(`${outName}: ${(statSync(f).size / 1024).toFixed(1)} KB; list nfl ${list.nfl?.length ?? 0}, cfb ${list.cfb?.length ?? 0}; ${details.length} details; ${Object.keys(kalshi).length} Kalshi games`);
