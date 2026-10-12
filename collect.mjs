#!/usr/bin/env node
// Gridiron data collector (public data only: Kalshi markets, ESPN scoreboards and summaries).
//
//   node collect.mjs --out snapshot.json      fetch, build, write the snapshot JSON
//   node collect.mjs --post                   fetch, build, gzip + sign + POST to $INGEST_URL/api/ingest
//   node collect.mjs --settle                 pending/settle handshake only (or together with --post)
//
// Options: --cache-dir DIR (daily cache, default .cache), --skip-injuries, --quiet
// Env (only for --post / --settle): INGEST_URL, INGEST_KEY. Neither is ever printed.
//
// Exit code: 1 when the Kalshi core series AND the ESPN scoreboards both failed (nothing usable; no POST is sent),
// or when a POST to the site fails, or on bad usage/config. Partial source failures exit 0: they are recorded in
// snapshot.sources.X.errors and the snapshot is still posted.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInputs } from './lib/sources.mjs';
import { buildSnapshot, summarize } from './lib/build.mjs';
import { validateSnapshot } from './lib/schema.mjs';
import { packSnapshot, postSnapshot, settleHandshake } from './lib/ingest.mjs';
import { CORE_SERIES_LIST, createKalshiClient } from './lib/kalshi.mjs';
import { createHttp, errorText } from './lib/http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function version() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try { return `${JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8')).version}-local`; } catch { return 'local'; }
}

const USAGE = 'usage: node collect.mjs [--out file.json] [--post] [--settle] [--cache-dir DIR] [--skip-injuries] [--quiet]';

async function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        out: { type: 'string' },
        post: { type: 'boolean', default: false },
        settle: { type: 'boolean', default: false },
        'cache-dir': { type: 'string', default: '.cache' },
        'skip-injuries': { type: 'boolean', default: false },
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
  const log = args.quiet ? () => {} : (...a) => console.log(...a);
  const ingest = { url: process.env.INGEST_URL || '', key: process.env.INGEST_KEY || '' };
  if ((args.post || args.settle) && (!ingest.url || !ingest.key)) {
    console.error('INGEST_URL and INGEST_KEY must be set for --post / --settle');
    return 2;
  }

  let exit = 0;
  const t0 = Date.now();

  if (args.out || args.post) {
    const inputs = await collectInputs({
      now: t0,
      cacheDir: args['cache-dir'] ? resolve(args['cache-dir']) : null,
      injuryLeagues: args['skip-injuries'] ? [] : ['nfl'],
      log,
    });
    const snapshot = buildSnapshot(inputs, { now: t0, version: version(), runMs: Date.now() - t0 });
    const pack = packSnapshot(snapshot);
    const sum = summarize(snapshot);

    log(`snapshot ${snapshot.generatedAt}  ${(pack.rawBytes / 1024).toFixed(0)} KB raw, ${(pack.gzBytes / 1024).toFixed(0)} KB gzip, ${snapshot.collector.runMs} ms`);
    log(`requests: kalshi ${inputs.stats.kalshiRequests}, espn ${inputs.stats.espnRequests}`);
    for (const [lg, b] of Object.entries(sum.byLeague)) log(`${lg}: ${b.games} games (${b.pre || 0} pre, ${b.in || 0} in), ${b.withKalshi} on Kalshi, ${b.withOdds} with DK odds, ${b.markets} markets`);
    log(`markets: ${sum.markets} (game ${sum.marketsByType.game}, spread ${sum.marketsByType.spread}, total ${sum.marketsByType.total}); ladders on ${sum.withLadders} games; combo eligible ${sum.comboEligible}; unmatched kalshi ${sum.unmatchedKalshi}, espn ${sum.unmatchedEspn}`);
    for (const [k, s] of Object.entries(snapshot.sources)) {
      log(`source ${k}: ${s.ok ? 'ok' : 'NOT OK'}${s.errors.length ? `  ${s.errors.slice(0, 5).join(' | ')}${s.errors.length > 5 ? ` (+${s.errors.length - 5})` : ''}` : ''}`);
    }
    const problems = validateSnapshot(snapshot);
    if (problems.length) console.warn(`schema warnings (${problems.length}): ${problems.slice(0, 10).join(' | ')}`);

    const kalshiCoreOk = CORE_SERIES_LIST.some((s) => Array.isArray(inputs.kalshi?.markets?.[s]));
    const espnOk = Object.values(inputs.espn?.scoreboards || {}).some((b) => b.length > 0);
    const bothDown = !kalshiCoreOk && !espnOk;

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
