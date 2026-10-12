// Build a snapshot from a raw capture folder with the collector's real code (offline, read-only on the folder).
// usage: node scripts/build-fixture.mjs <rawDir | inputs.json.gz> <out.json> [--now ISO] [--leagues nfl,cfb]
//
// inputs.json.gz is what `collect.mjs --save-inputs` writes ({ now, inputs }); it is rebuilt as is.
//
// rawDir layout (as captured for gridiron-picks/test/fixtures/raw-*):
//   fetched_at.txt                  capture time (used as `now` unless --now is given)
//   kalshi_<SERIES>.json            GET /markets responses ({ cursor, markets }); core series are used, prop series are phase B
//   espn_scoreboard*.json           ESPN scoreboards (league taken from leagues[0].slug)
//   espn_summary*.json              ESPN game summaries (injuries; event id from header.id or the boards)
//   series_<SERIES>.json            optional GET /series/{t} responses (fees); defaults are flagged when absent
//   collections.json                optional GET /multivariate_event_collections response

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { buildSnapshot, summarize } from '../lib/build.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { packSnapshot } from '../lib/ingest.mjs';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { now: { type: 'string' }, leagues: { type: 'string' } } });
const [rawDir, outFile] = positionals;
if (!rawDir || !outFile) {
  console.error('usage: node scripts/build-fixture.mjs <rawDir> <out.json> [--now ISO] [--leagues nfl,cfb]');
  process.exit(2);
}
if (statSync(resolve(rawDir)).isFile()) {
  const saved = JSON.parse(gunzipSync(readFileSync(resolve(rawDir))).toString('utf8'));
  const snap = buildSnapshot(saved.inputs, { now: opt.now || saved.now, version: 'rebuild', runMs: 0, ...(opt.leagues ? { leagues: opt.leagues.split(',') } : {}) });
  const probs = validateSnapshot(snap);
  if (probs.length) { console.error(`schema problems: ${probs.join(' | ')}`); process.exit(1); }
  writeFileSync(resolve(outFile), JSON.stringify(snap));
  const pk = packSnapshot(snap);
  console.log(`wrote ${outFile}: ${pk.rawBytes} bytes, ${pk.gzBytes} gzip`);
  console.log(JSON.stringify(summarize(snap)));
  process.exit(0);
}
const dir = resolve(rawDir);
const rd = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const files = readdirSync(dir);
const now = opt.now || (existsSync(join(dir, 'fetched_at.txt')) ? readFileSync(join(dir, 'fetched_at.txt'), 'utf8').trim() : null);
if (!now || !Number.isFinite(Date.parse(now))) {
  console.error('no capture time: pass --now or add fetched_at.txt');
  process.exit(2);
}

const markets = {};
for (const f of files) {
  const m = /^kalshi_([A-Z0-9]+)\.json$/.exec(f);
  if (m) markets[m[1]] = rd(f).markets || [];
}
const scoreboards = { nfl: [], cfb: [] };
for (const f of files.filter((x) => /^espn_scoreboard.*\.json$/.test(x))) {
  const j = rd(f);
  const slug = j?.leagues?.[0]?.slug;
  const league = slug === 'nfl' ? 'nfl' : slug === 'college-football' ? 'cfb' : null;
  if (league) scoreboards[league].push(j);
}
const leagues = opt.leagues ? opt.leagues.split(',') : ['nfl', 'cfb'].filter((l) => scoreboards[l].length);

const boardIds = new Set(Object.values(scoreboards).flat().flatMap((b) => (b.events || []).map((e) => String(e.id))));
const summaries = {};
for (const f of files.filter((x) => /^espn_summary.*\.json$/.test(x))) {
  const j = rd(f);
  let id = j?.header?.id != null ? String(j.header.id) : null;
  if (!id) {
    // Fall back to the board event whose two teams match the summary's injury/boxscore teams.
    const teams = new Set((j.injuries || []).map((t) => String(t.team?.id)));
    for (const b of Object.values(scoreboards).flat()) for (const e of b.events || []) {
      const ids = (e.competitions?.[0]?.competitors || []).map((c) => String(c.team?.id));
      if (ids.length === 2 && ids.every((x) => teams.has(x))) id = String(e.id);
    }
  }
  if (id && boardIds.has(id)) summaries[id] = { injuries: j.injuries || [] };
}

const seriesData = {};
for (const f of files) {
  const m = /^series_([A-Z0-9]+)\.json$/.exec(f);
  if (m) seriesData[m[1]] = rd(f).series || rd(f);
}
const inputs = {
  kalshi: { fetchedAt: now, requests: 0, errors: [], markets },
  espn: { fetchedAt: now, errors: [], scoreboards },
  ...(Object.keys(summaries).length ? { injuries: { fetchedAt: now, errors: [], leagues: ['nfl'].filter((l) => leagues.includes(l)), summaries } } : {}),
  ...(Object.keys(seriesData).length ? { series: { fetchedAt: now, errors: [], data: seriesData } } : {}),
  ...(files.includes('collections.json') ? { combos: { fetchedAt: now, errors: [], collections: rd('collections.json').multivariate_contracts || rd('collections.json') } } : {}),
};

const snapshot = buildSnapshot(inputs, { now, version: 'fixture', runMs: 0, leagues });
const problems = validateSnapshot(snapshot);
if (problems.length) {
  console.error(`schema problems: ${problems.join(' | ')}`);
  process.exit(1);
}
const out = resolve(outFile);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(snapshot, null, 1) + '\n');
const p = packSnapshot(snapshot);
console.log(`wrote ${outFile}: ${p.rawBytes} bytes compact, ${p.gzBytes} gzip`);
console.log(JSON.stringify(summarize(snapshot)));
for (const [k, s] of Object.entries(snapshot.sources)) console.log(`  ${k}: ${s.ok ? 'ok' : 'not ok'} ${s.errors.join(' | ')}`);
