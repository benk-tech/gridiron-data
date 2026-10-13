#!/usr/bin/env node
// Gridiron data collector (public data only: Kalshi markets, ESPN scoreboards, injuries and DK prop lines,
// nflverse and sportsdataverse stats, Pinnacle guest prices, and reference quotes from Polymarket US, Gemini
// Predictions and SX Bet).
//
//   node collect.mjs --out snapshot.json      fetch, build, write the snapshot JSON
//   node collect.mjs --post                   fetch, build, gzip + sign + POST to $INGEST_URL/api/ingest
//   node collect.mjs --settle                 pending/settle handshake only (or together with --post), with Kalshi
//                                             kickoff closes (closeYes) when the site lists { ticker, kickoff }
//
// Options:
//   --cache-dir DIR    daily data (fees, nflverse, depth charts, CFB), default .cache; '' = no cache
//   --state-dir DIR    run-to-run state: history.json (line moves, last 48 h), closes/ (staged closes), nflverse
//                      check stamps, pinnacle.json, gemini.json and sx.json (last pulls, each reused for 15 min),
//                      clv-closes.json (Kalshi kickoff closes waiting for their settlement). Without it every run is a
//                      first run.
//   --closes-dir DIR   where finished ET days of closes are copied (default: closes/ next to this file); only with --state-dir
//   --skip LIST        comma list of optional parts to skip: props,teamTotals,injuries,nflverse,cfb,pinnacle,polyus,
//                      gemini,sx
//   --skip-injuries    same as --skip injuries
//   --kalshi-gap-ms N  minimum gap between Kalshi requests (default 250; Kalshi answers 429 to bursts on /markets)
//   --save-inputs FILE.json.gz   raw fetched inputs (rebuild offline with scripts/build-fixture.mjs)
//   --now ISO          run as if the clock read ISO (game window, generatedAt, history and closes times). For tests and
//                      fixture rebuilds; request signatures and time budgets always use the real clock.
//   --quiet
// Env (only for --post / --settle): INGEST_URL, INGEST_KEY. Neither is ever printed.
//
// Exit code: 1 when nothing usable came back and no POST is sent: the Kalshi core series AND the ESPN scoreboards
// both failed, or the run found no games at all while the previous run (state/history.json, at most 6 h old) listed
// 10 or more upcoming games (an ESPN outage that answers 200 with empty lists). In both cases the last good snapshot
// stays up and the run-to-run state is not saved. Also 1 when a POST to the site fails, or on bad usage/config.
// Partial source failures exit 0: they are recorded in snapshot.sources.X.errors (ok=false) and the snapshot is
// still posted.

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
import { createHttp, errorText, withDeadline, budgetSignal, pacedFetch } from './lib/http.mjs';
import { readHistoryFile, writeHistoryFile } from './lib/moves.mjs';
import { writeClosesFile, syncClosesDir } from './lib/closes.mjs';
import { VENUE_KEYS } from './lib/venues/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The settle handshake (after the POST) gets its own budget so it can never hold the job past its timeout either.
const SETTLE_BUDGET_MS = 30e3;

function version() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try { return `${JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8')).version}-local`; } catch { return 'local'; }
}

const USAGE = 'usage: node collect.mjs [--out file.json] [--post] [--settle] [--cache-dir DIR] [--state-dir DIR] [--closes-dir DIR] [--skip props,teamTotals,injuries,nflverse,cfb,pinnacle,polyus,gemini,sx] [--skip-injuries] [--kalshi-gap-ms N] [--save-inputs FILE.json.gz] [--now ISO] [--quiet]';

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
        now: { type: 'string' },
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
  const startMs = Date.now(); // real clock: timings and time budgets
  let t0 = startMs; // the run's 'now': game window, generatedAt, history and closes
  if (args.now != null) {
    t0 = /^\d{4}-\d{2}-\d{2}T/.test(args.now) ? Date.parse(args.now) : NaN;
    if (!Number.isFinite(t0)) {
      console.error(`bad --now value (want an ISO time such as 2026-10-11T22:51:00Z)\n${USAGE}`);
      return 2;
    }
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
  // One Kalshi pacer for the whole run: the collection and the settle handshake (markets, kickoff close trades) share
  // its request spacing and its per-run cap on 429 retries. Other hosts pass straight through it.
  const gap = args['kalshi-gap-ms'] != null ? Math.max(0, Number(args['kalshi-gap-ms']) || 0) : 250;
  const pacer = pacedFetch(globalThis.fetch, { minGapMs: gap, backoffMs: gap ? 1500 : 0 });

  if (args.out || args.post) {
    const inputs = await collectInputs({
      now: t0,
      cacheDir: args['cache-dir'] ? resolve(args['cache-dir']) : null,
      stateDir,
      parts: Object.fromEntries(PART_KEYS.map((k) => [k, !skip.has(k)])),
      pacer,
      log,
    });
    const fetchMs = Date.now() - startMs;
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
    if (inputs.stats.budgetsSpent?.length) console.warn(`time budget spent: ${inputs.stats.budgetsSpent.join(', ')} (requests still open were stopped; building with what arrived)`);
    for (const [lg, b] of Object.entries(sum.byLeague)) log(`${lg}: ${b.games} games (${b.pre || 0} pre, ${b.in || 0} in), ${b.withKalshi} on Kalshi, ${b.withOdds} with DK odds, ${b.markets} markets`);
    const mt = sum.marketsByType;
    log(`markets: ${sum.markets} (game ${mt.game}, spread ${mt.spread}, total ${mt.total}, team total ${mt.teamTotal}); ladders on ${sum.withLadders} games, team totals on ${sum.withTeamTotals}, DK team totals on ${sum.dkTeamTotals}; combo eligible ${sum.comboEligible}; unmatched kalshi ${sum.unmatchedKalshi}, espn ${sum.unmatchedEspn}`);
    log(`props: ${sum.props} ladders (${sum.propRungs} rungs), ${sum.propsMatched} joined to ESPN players, ${sum.propsWithDk} with a DK line (${sum.propsSafe} safe)`);
    log(`injuries: ${sum.injuries} listed; angles ${sum.angles} ${JSON.stringify(sum.anglesByKind)}; defense nfl ${sum.defenseNfl}, cfb ${sum.defenseCfb}; players ${sum.players}; cfb QB changes ${sum.cfbQbChanges}`);
    log(`moves: ${sum.gameMoves} game, ${sum.propMoves} prop (history since ${snapshot.sources.moves.since ?? 'none'}); kalshi centers: ${sum.kalshiMoves} moves, ${snapshot.sources.moves.kalshiGames} games on record; previous run Kalshi books on ${snapshot.sources.moves.prevBooks ?? 0} games; closes this run ${run.closes.length}`);
    log(`pinnacle: ${Object.entries(sum.pinnacle).sort(([a], [b]) => (a < b ? 1 : -1)).map(([lg, b]) => `${lg} ${b.refs}/${b.pre} pregame games (${b.offBoard} off the board)`).join(', ')}; ${inputs.pinnacle ? (inputs.pinnacle.cached ? `reused the pull from ${inputs.pinnacle.attemptAt}` : `pulled, ${inputs.pinnacle.requests} requests`) : 'not fetched'}; unmatched ${snapshot.unmatched.pinnacle?.length ?? 0}`);
    // Exchange reference venues: games with quotes per league, the pull (or the reused copy), timings and requests.
    for (const v of VENUE_KEYS) {
      const src = snapshot.sources[v];
      const R = inputs.venues?.[v];
      if (!src || !R) continue;
      const by = Object.entries(sum.venues[v] || {}).sort(([a], [b]) => (a < b ? 1 : -1)).map(([lg, b]) => `${lg} ${b.refs}/${b.pre} pregame games (${b.quotes} quotes)`).join(', ');
      const t = inputs.stats.bySource?.[v];
      const um = run.venues?.[v]?.unmatched || [];
      log(`${v}: ${by || 'no games'}; ${R.cached ? `reused the pull from ${R.attemptAt}` : `pulled, ${R.requests} requests`}${t ? ` in ${t.ms} ms` : ''}; unmatched ${um.length}${um.length ? ` (${um.slice(0, 3).join('; ')}${um.length > 3 ? '; ...' : ''})` : ''}`);
    }
    for (const [k, s] of Object.entries(snapshot.sources)) {
      log(`source ${k}: ${s.ok ? 'ok' : 'NOT OK'}${s.errors.length ? `  ${s.errors.slice(0, 5).join(' | ')}${s.errors.length > 5 ? ` (+${s.errors.length - 5})` : ''}` : ''}`);
    }
    const problems = validateSnapshot(snapshot);
    if (problems.length) console.warn(`schema warnings (${problems.length}): ${problems.slice(0, 10).join(' | ')}`);

    const kalshiCoreOk = CORE_SERIES_LIST.some((s) => Array.isArray(inputs.kalshi?.markets?.[s]));
    const espnOk = Object.values(inputs.espn?.scoreboards || {}).some((b) => b.length > 0);
    const bothDown = !kalshiCoreOk && !espnOk;
    const held = bothDown ? null : run.hold; // an empty run right after a full one: keep the last good snapshot up

    // Run-to-run state. Skipped when nothing usable came back: the same closes are found again next run, and the
    // next run still compares with the last good history.
    if (stateDir && !bothDown && !held) {
      try {
        const w = await writeClosesFile(join(stateDir, 'closes'), run.closes, { now: t0 });
        if (w.added) log(`closes: staged ${w.added} game(s) in ${w.files.length} day file(s)`);
        if (run.history) await writeHistoryFile(historyPath, run.history); // null: the move builder failed, keep the old file
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
    } else if (held) {
      console.error(`snapshot not posted: ${held.reason}. The last good snapshot stays up; state not saved.`);
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
    const budget = budgetSignal(SETTLE_BUDGET_MS, 'settle');
    try {
      const fetchImpl = withDeadline(globalThis.fetch, budget.signal);
      const kalshi = createKalshiClient({ http: createHttp({ fetchImpl: withDeadline(pacer, budget.signal), retries: 0 }) });
      await settleHandshake({ url: ingest.url, key: ingest.key, kalshi, fetchImpl, log, now: t0, stateDir });
    } catch (e) {
      // A failed settle is retried on the next run; it does not fail the job.
      console.warn(`settle skipped: ${errorText(e)}`);
    } finally {
      budget.clear();
    }
  }
  return exit;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => { console.error(`collector crashed: ${errorText(e)}`); process.exitCode = 1; },
);
