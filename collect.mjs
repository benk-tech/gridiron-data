#!/usr/bin/env node
// Gridiron data collector (public data only: Kalshi markets, ESPN scoreboards, injuries and DK prop lines,
// nflverse and sportsdataverse stats).
//
//   node collect.mjs --out snapshot.json      fetch, build, write the snapshot JSON
//   node collect.mjs --post                   fetch, build, gzip + sign + POST to $INGEST_URL/api/ingest
//   node collect.mjs --settle                 pending/settle handshake only (or together with --post)
//
// Options:
//   --cache-dir DIR    daily data (fees, nflverse, depth charts, CFB), default .cache; '' = no cache
//   --state-dir DIR    run-to-run state: history.json (line moves, last 48 h), closes/ (staged closes), nflverse
//                      check stamps. Without it every run is a first run (no moves, no closes).
//   --closes-dir DIR   where finished ET days of closes are copied (default: closes/ next to this file); only with --state-dir
//   --skip LIST        comma list of optional parts to skip: props,teamTotals,injuries,nflverse,cfb
//   --skip-injuries    same as --skip injuries
//   --kalshi-gap-ms N  minimum gap between Kalshi requests (default 250; Kalshi answers 429 to bursts on /markets)
//   --save-inputs FILE.json.gz   raw fetched inputs (rebuild offline with scripts/build-fixture.mjs)
//   --quiet
// Env (only for --post / --settle): INGEST_URL, INGEST_KEY. Neither is ever printed.
//
// Exit code: 1 when the Kalshi core series AND the ESPN scoreboards both failed (nothing usable; no POST is sent),
// or when a POST to the site fails, or on bad usage/config. Partial source failures exit 0: they are recorded in
// snapshot.sources.X.errors and the snapshot is still posted.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInputs, PART_KEYS } from './lib/sources.mjs';
import { buildRun, summarize } from './lib/build.mjs';
import { validateSnapshot } from './lib/schema.mjs';
import { packSnapshot, postSnapshot, settleHandshake } from './lib/ingest.mjs';
import { CORE_SERIES_LIST, createKalshiClient } from './lib/kalshi.mjs';
import { createHttp, errorText } from './lib/http.mjs';
import { readHistoryFile, writeHistoryFile } from './lib/moves.mjs';
import { writeClosesFile, syncClosesDir } from './lib/closes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function version() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try { return `${JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8')).version}-local`; } catch { return 'local'; }
}

const USAGE = 'usage: node collect.mjs [--out file.json] [--post] [--settle] [--cache-dir DIR] [--state-dir DIR] [--closes-dir DIR] [--skip props,teamTotals,injuries,nflverse,cfb] [--skip-injuries] [--kalshi-gap-ms N] [--save-inputs FILE.json.gz] [--quiet]';

async function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        out: { type: 'string' },
        post: { type: 'boolean', default: false },
        settle: { type: 'boolean', default: false },
        'cache-dir': { type: 'string', default: '.cache' },
        'state-dir': { type: 'string' },
        'closes-dir': { type: 'string' },
        skip: { type: 'string', default: '' },
        'kalshi-gap-ms': { type: 'string' },
        'skip-injuries': { type: 'boolean', default: false },
        'save-inputs': { type: 'string' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help || (!args.out && !args.post && !args.settle)) {
    console.error(USAGE);
    return args.help ? 0 : 2;
  }
  const skip = new Set(String(args.skip || '').split(',').map((x) => x.trim()).filter(Boolean));
  if (args['skip-injuries']) skip.add('injuries');
  const unknown = [...skip].filter((x) => !PART_KEYS.includes(x));
  if (unknown.length) {
    console.error(`unknown --skip part(s): ${unknown.join(', ')} (known: ${PART_KEYS.join(', ')})\n${USAGE}`);
    return 2;
  }
  const log = args.quiet ? () => {} : (...a) => console.log(...a);
  const ingest = { url: process.env.INGEST_URL || '', key: process.env.INGEST_KEY || '' };
  if ((args.post || args.settle) && (!ingest.url || !ingest.key)) {
    console.error('INGEST_URL and INGEST_KEY must be set for --post / --settle');
    return 2;
  }
  const stateDir = args['state-dir'] ? resolve(args['state-dir']) : null;
  const closesDir = args['closes-dir'] ? resolve(args['closes-dir']) : resolve(HERE, 'closes');

  let exit = 0;
  const t0 = Date.now();

  if (args.out || args.post) {
    const inputs = await collectInputs({
      now: t0,
      cacheDir: args['cache-dir'] ? resolve(args['cache-dir']) : null,
      stateDir,
      parts: Object.fromEntries(PART_KEYS.map((k) => [k, !skip.has(k)])),
      ...(args['kalshi-gap-ms'] != null ? { kalshiGapMs: Math.max(0, Number(args['kalshi-gap-ms']) || 0) } : {}),
      log,
    });
    const fetchMs = Date.now() - t0;
    const historyPath = stateDir ? join(stateDir, 'history.json') : null;
    inputs.history = historyPath ? await readHistoryFile(historyPath) : null;

    const b0 = Date.now();
    const run = buildRun(inputs, { now: t0, version: version(), runMs: fetchMs });
    const buildMs = Date.now() - b0;
    const { snapshot } = run;
    if (args['save-inputs']) {
      const f = resolve(args['save-inputs']);
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, gzipSync(Buffer.from(JSON.stringify({ now: new Date(t0).toISOString(), inputs }), 'utf8')));
      log(`saved inputs to ${args['save-inputs']}`);
    }
    const pack = packSnapshot(snapshot);
    const sum = summarize(snapshot);

    log(`snapshot ${snapshot.generatedAt}  ${(pack.rawBytes / 1024).toFixed(0)} KB raw, ${(pack.gzBytes / 1024).toFixed(0)} KB gzip; fetch ${fetchMs} ms, build ${buildMs} ms`);
    log(`requests: ${inputs.stats.totalRequests} total (kalshi ${inputs.stats.kalshiRequests}, espn ${inputs.stats.espnRequests})`);
    for (const [name, s] of Object.entries(inputs.stats.bySource || {})) log(`  ${name.padEnd(10)} ${String(s.requests).padStart(3)} req ${String(s.ms).padStart(6)} ms`);
    for (const [lg, b] of Object.entries(sum.byLeague)) log(`${lg}: ${b.games} games (${b.pre || 0} pre, ${b.in || 0} in), ${b.withKalshi} on Kalshi, ${b.withOdds} with DK odds, ${b.markets} markets`);
    const mt = sum.marketsByType;
    log(`markets: ${sum.markets} (game ${mt.game}, spread ${mt.spread}, total ${mt.total}, team total ${mt.teamTotal}); ladders on ${sum.withLadders} games, team totals on ${sum.withTeamTotals}, DK team totals on ${sum.dkTeamTotals}; combo eligible ${sum.comboEligible}; unmatched kalshi ${sum.unmatchedKalshi}, espn ${sum.unmatchedEspn}`);
    log(`props: ${sum.props} ladders (${sum.propRungs} rungs), ${sum.propsMatched} joined to ESPN players, ${sum.propsWithDk} with a DK line (${sum.propsSafe} safe)`);
    log(`injuries: ${sum.injuries} listed; angles ${sum.angles} ${JSON.stringify(sum.anglesByKind)}; defense nfl ${sum.defenseNfl}, cfb ${sum.defenseCfb}; players ${sum.players}; cfb QB changes ${sum.cfbQbChanges}`);
    log(`moves: ${sum.gameMoves} game, ${sum.propMoves} prop (history since ${snapshot.sources.moves.since ?? 'none'}); closes this run ${run.closes.length}`);
    for (const [k, s] of Object.entries(snapshot.sources)) {
      log(`source ${k}: ${s.ok ? 'ok' : 'NOT OK'}${s.errors.length ? `  ${s.errors.slice(0, 5).join(' | ')}${s.errors.length > 5 ? ` (+${s.errors.length - 5})` : ''}` : ''}`);
    }
    const problems = validateSnapshot(snapshot);
    if (problems.length) console.warn(`schema warnings (${problems.length}): ${problems.slice(0, 10).join(' | ')}`);

    const kalshiCoreOk = CORE_SERIES_LIST.some((s) => Array.isArray(inputs.kalshi?.markets?.[s]));
    const espnOk = Object.values(inputs.espn?.scoreboards || {}).some((b) => b.length > 0);
    const bothDown = !kalshiCoreOk && !espnOk;

    // Run-to-run state. Skipped when nothing usable came back: the same closes are found again next run.
    if (stateDir && !bothDown) {
      try {
        const w = await writeClosesFile(join(stateDir, 'closes'), run.closes, { now: t0 });
        if (w.added) log(`closes: staged ${w.added} game(s) in ${w.files.length} day file(s)`);
        await writeHistoryFile(historyPath, run.history);
        const sy = await syncClosesDir(join(stateDir, 'closes'), closesDir, { now: t0 });
        if (sy.changed.length) log(`closes: ${sy.changed.length} finished day file(s) copied to the archive`);
      } catch (e) {
        console.warn(`state not saved: ${errorText(e)}`);
      }
    }

    if (args.out) {
      const out = resolve(args.out);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, pack.json);
      log(`wrote ${args.out}`);
    }

    if (bothDown) {
      console.error('Kalshi core and ESPN odds both failed; snapshot not posted');
      exit = 1;
    } else if (args.post) {
      try {
        const r = await postSnapshot(snapshot, { url: ingest.url, key: ingest.key });
        if (r.ok) log(`posted: HTTP ${r.status}, ${r.gzBytes} bytes`);
        else { console.error(`post failed: HTTP ${r.status}${r.json?.error ? ` (${String(r.json.error).slice(0, 120)})` : ''}`); exit = 1; }
      } catch (e) {
        console.error(`post failed: ${errorText(e)}`);
        exit = 1;
      }
    }
  }

  if (args.settle) {
    try {
      const kalshi = createKalshiClient({ http: createHttp({ retries: 0 }) });
      await settleHandshake({ url: ingest.url, key: ingest.key, kalshi, log });
    } catch (e) {
      // A failed settle is retried on the next run; it does not fail the job.
      console.warn(`settle skipped: ${errorText(e)}`);
    }
  }
  return exit;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => { console.error(`collector crashed: ${errorText(e)}`); process.exitCode = 1; },
);
