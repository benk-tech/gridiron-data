// Trim saved captures into the offline fixtures for the Pinnacle source and the Kalshi kickoff close.
// usage: node scripts/make-pinnacle-fixtures.mjs <inputs.json.gz> <pinnDir> <fetchLog.json,...> <tradesDir>
//   inputs.json.gz  collect.mjs --save-inputs capture ({ now, inputs }); only its ESPN scoreboards are kept
//   pinnDir         raw Pinnacle guest responses: nfl_matchups.json, nfl_straight.json, cfb_matchups.json, cfb_straight.json
//   fetchLog.json   fetch logs ({ log: [{ url, lastModified }] }) giving each response's Last-Modified header
//   tradesDir       raw GET /markets/trades captures (trades_<TICKER>.json = { pick, a: { trades } })
// Output: test/fixtures/pinnacle/ and test/fixtures/clv/ (gzipped compact JSON).

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [inputsFile, pinnDir, logs, tradesDir] = process.argv.slice(2);
if (!inputsFile || !pinnDir || !logs || !tradesDir) {
  console.error('usage: node scripts/make-pinnacle-fixtures.mjs <inputs.json.gz> <pinnDir> <fetchLog.json,...> <tradesDir>');
  process.exit(2);
}
const rd = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
};

// ESPN boards: the fields the builder and the matcher read (same trim as make-test-fixtures.mjs).
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

// Pinnacle: keep every top-level game and a few specials (props, futures) so the filters are exercised; drop limits.
function trimPinnacleRaw(mu, px) {
  const keepMu = (m) => (m.type === 'matchup' && !m.parentId) || m.id % 7 === 0;
  const matchups = mu.filter(keepMu).map((m) => ({
    ...pick(m, ['id', 'type', 'parentId', 'isLive', 'startTime', 'status', 'units']),
    participants: (m.participants || []).map((p) => pick(p, ['alignment', 'name', 'id'])),
    periods: (m.periods || []).map((p) => pick(p, ['period', 'status'])),
  }));
  const ids = new Set(matchups.map((m) => m.id));
  const straight = px.filter((x) => ids.has(x.matchupId) || x.matchupId % 11 === 0).map((x) => pick(x, ['matchupId', 'period', 'type', 'isAlternate', 'status', 'key', 'side', 'prices']));
  return { matchups, straight };
}

function write(dir, name, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), gzipSync(Buffer.from(JSON.stringify(data), 'utf8'), { level: 9 }));
}

const saved = JSON.parse(gunzipSync(readFileSync(inputsFile)).toString('utf8'));
const P = join(ROOT, 'test/fixtures/pinnacle');
write(P, 'espn-boards-20261012.json.gz', {
  now: saved.now,
  scoreboards: Object.fromEntries(Object.entries(saved.inputs.espn.scoreboards).map(([lg, boards]) => [lg, boards.map(trimBoard)])),
});
const lm = new Map();
for (const f of logs.split(',')) for (const l of rd(f).log || []) if (l.lastModified) lm.set(l.url, l.lastModified);
const pin = { capturedAt: '2026-10-12T19:02:44Z' };
for (const [lg, id] of [['nfl', 889], ['cfb', 880]]) {
  const t = trimPinnacleRaw(rd(join(pinnDir, `${lg}_matchups.json`)), rd(join(pinnDir, `${lg}_straight.json`)));
  const base = `https://guest.api.arcadia.pinnacle.com/0.1/leagues/${id}`;
  pin[lg] = {
    matchups: { lastModified: lm.get(`${base}/matchups`) ?? null, body: t.matchups },
    straight: { lastModified: lm.get(`${base}/markets/straight`) ?? null, body: t.straight },
  };
}
write(P, 'pinnacle-20261012.json.gz', pin);

const C = join(ROOT, 'test/fixtures/clv');
for (const [ticker, n] of [['KXNFLSPREAD-26OCT11BALATL-ATL4', 200], ['KXNFLTOTAL-26OCT11SFSEA-53', 200]]) {
  const j = rd(join(tradesDir, `trades_${ticker}.json`));
  write(C, `trades-${ticker}.json.gz`, { kickoff: j.pick.kickoff, result: j.pick.result, cursor: '', trades: (j.a.trades || []).slice(0, n) });
}

for (const d of [P, C]) for (const f of readdirSync(d)) console.log(`${(statSync(join(d, f)).size / 1024).toFixed(0).padStart(6)} KB  ${d.slice(ROOT.length + 1)}/${f}`);
