// End to end through collect.mjs with Kalshi/ESPN replaced by the saved capture (preload) and a local signing site.
// Every run is pinned to the capture time with --now, so the results never depend on the real date (the fixture games
// leave the 9 day window in real time; the scheduled workflow must never depend on that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { KEY, fakeSite } from './fake-site.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { RESEARCH_NOW } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = pathToFileURL(join(ROOT, 'test', 'fake-upstream.mjs')).href;

function run(args, env) {
  const extra = [
    ...(args.includes('--out') || args.includes('--post') ? ['--kalshi-gap-ms', '0'] : []),
    ...(args.includes('--now') ? [] : ['--now', RESEARCH_NOW]),
  ];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', PRELOAD, join(ROOT, 'collect.mjs'), ...args, ...extra], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('collect.mjs --post --settle --out: posts a valid signed snapshot, settles, never prints the URL or key', async () => {
  const site = await fakeSite();
  const tmp = mkdtempSync(join(tmpdir(), 'gd-cli-'));
  try {
    const outFile = join(tmp, 'snap.json');
    const stateDir = join(tmp, 'state');
    const r = await run(['--post', '--settle', '--out', outFile, '--cache-dir', join(tmp, 'cache'), '--state-dir', stateDir, '--closes-dir', join(tmp, 'closes')], { INGEST_URL: site.url, INGEST_KEY: KEY, FAKE_UPSTREAM: 'ok' });
    assert.equal(r.code, 0, r.out);
    // run-to-run state: line history saved, nflverse check stamps kept out of the cache folder
    const hist = JSON.parse(readFileSync(join(stateDir, 'history.json'), 'utf8'));
    assert.equal(hist.v, 1);
    assert.ok(Object.keys(hist.games).length >= 70, 'pregame lines recorded for the games');
    assert.match(r.out, /requests: \d+ total/);
    assert.match(r.out, /props +\d+ req/);
    assert.match(r.out, /moves: 0 game, 0 prop \(history since none\)/);
    // second run reads the history (no lines moved in the capture, so no moves)
    const outFile2 = join(tmp, 'snap2.json');
    const r2 = await run(['--out', outFile2, '--cache-dir', join(tmp, 'cache'), '--state-dir', stateDir, '--closes-dir', join(tmp, 'closes'), '--skip', 'nflverse,cfb,injuries', '--now', '2026-10-11T22:56:00Z'], { FAKE_UPSTREAM: 'ok' });
    assert.equal(r2.code, 0, r2.out);
    const snap2 = JSON.parse(readFileSync(outFile2, 'utf8'));
    assert.equal(hist.at, '2026-10-11T22:51:00Z', 'the first run is pinned to the capture time');
    assert.equal(snap2.generatedAt, '2026-10-11T22:56:00Z');
    assert.equal(snap2.sources.moves.since, hist.at);
    assert.deepEqual(validateSnapshot(snap2), []);
    assert.ok(!existsSync(join(tmp, 'closes')), 'nothing kicked off between the runs: no closes archived');
    assert.equal(site.state.snapshots.length, 1);
    const posted = JSON.parse(gunzipSync(site.state.snapshots[0]).toString('utf8'));
    assert.deepEqual(validateSnapshot(posted), []);
    assert.deepEqual(posted, JSON.parse(readFileSync(outFile, 'utf8')));
    assert.equal(posted.sources.kalshi.ok, true);
    assert.equal(posted.generatedAt, '2026-10-11T22:51:00Z');
    assert.equal(posted.games.length, 76, 'every fixture game is inside the window at the pinned time');
    assert.equal(site.state.settled.length, 1);
    assert.equal(site.state.settled[0].results.length, 2);
    assert.ok(!r.out.includes(KEY), 'key printed');
    assert.ok(!r.out.includes(site.url) && !r.out.includes('127.0.0.1'), 'url printed');
    assert.match(r.out, /posted: HTTP 200/);
  } finally {
    site.server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('exit code: one core source down still posts (exit 0); both down skips the POST (exit 1)', async () => {
  const site = await fakeSite();
  try {
    const env = { INGEST_URL: site.url, INGEST_KEY: KEY };
    const k = await run(['--post', '--skip-injuries', '--skip', 'props,teamTotals,nflverse,cfb', '--cache-dir', ''], { ...env, FAKE_UPSTREAM: 'kalshi-down' });
    assert.equal(k.code, 0, k.out);
    assert.equal(site.state.snapshots.length, 1);
    const snap = JSON.parse(gunzipSync(site.state.snapshots[0]).toString('utf8'));
    assert.equal(snap.sources.kalshi.ok, false);
    assert.match(k.out, /source kalshi: NOT OK/);

    const both = await run(['--post', '--skip', 'injuries,props,teamTotals,nflverse,cfb', '--cache-dir', ''], { ...env, FAKE_UPSTREAM: 'all-down' });
    assert.equal(both.code, 1, both.out);
    assert.equal(site.state.snapshots.length, 1, 'nothing new posted');
    assert.match(both.out, /both failed/);
  } finally {
    site.server.close();
  }
});

test('exit code: a rejected POST is a failure; missing env is a usage error', async () => {
  const site = await fakeSite();
  try {
    const bad = await run(['--post', '--skip', 'injuries,props,teamTotals,nflverse,cfb', '--cache-dir', ''], { INGEST_URL: site.url, INGEST_KEY: 'wrong-key', FAKE_UPSTREAM: 'ok' });
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /post failed: HTTP 401/);
    const noenv = await run(['--post'], { INGEST_URL: '', INGEST_KEY: '' });
    assert.equal(noenv.code, 2);
    const badSkip = await run(['--out', 'x.json', '--skip', 'weather'], {});
    assert.equal(badSkip.code, 2);
    assert.match(badSkip.out, /unknown --skip part/);
    for (const bad of ['tomorrow', '', '12345']) {
      const badNow = await run(['--out', 'x.json', '--now', bad], {});
      assert.equal(badNow.code, 2, `--now ${JSON.stringify(bad)}`);
      assert.match(badNow.out, /bad --now value/);
    }
  } finally {
    site.server.close();
  }
});

test('ESPN answering 200 with empty scoreboards right after a full run: not posted, state kept, exit 1; posted (flagged) once the hold lapses', async () => {
  const site = await fakeSite();
  const tmp = mkdtempSync(join(tmpdir(), 'gd-cli-'));
  try {
    const env = { INGEST_URL: site.url, INGEST_KEY: KEY };
    const stateDir = join(tmp, 'state');
    const common = ['--post', '--cache-dir', '', '--state-dir', stateDir, '--closes-dir', join(tmp, 'closes'), '--skip', 'props,teamTotals,nflverse,cfb,injuries'];
    const ok = await run([...common, '--now', '2026-10-11T22:51:00Z'], { ...env, FAKE_UPSTREAM: 'ok' });
    assert.equal(ok.code, 0, ok.out);
    assert.equal(site.state.snapshots.length, 1);
    const histPath = join(stateDir, 'history.json');
    const hist1 = readFileSync(histPath, 'utf8');

    const empty = await run([...common, '--now', '2026-10-11T22:56:00Z'], { ...env, FAKE_UPSTREAM: 'espn-empty' });
    assert.equal(empty.code, 1, empty.out);
    assert.match(empty.out, /snapshot not posted: no games in this run, but the previous run \(2026-10-11T22:51:00Z\) listed 76 upcoming games/);
    assert.match(empty.out, /source espnOdds: NOT OK .*lists no games/);
    assert.equal(site.state.snapshots.length, 1, 'the last good snapshot stays up');
    assert.equal(readFileSync(histPath, 'utf8'), hist1, 'state not saved, so the next run still compares with the good run');

    // more than 6 hours after the last good run the hold lapses: the empty snapshot is posted, with ESPN flagged down
    await new Promise((r) => setTimeout(r, 1100)); // the site rejects a POST timestamp (seconds) that is not newer
    const later = await run([...common, '--now', '2026-10-12T04:56:00Z'], { ...env, FAKE_UPSTREAM: 'espn-empty' });
    assert.equal(later.code, 0, later.out);
    assert.equal(site.state.snapshots.length, 2);
    const snap = JSON.parse(gunzipSync(site.state.snapshots[1]).toString('utf8'));
    assert.equal(snap.games.length, 0);
    assert.equal(snap.sources.espnOdds.ok, false);
    assert.match(snap.sources.espnOdds.errors.join(' | '), /current regular season week lists no games/);
  } finally {
    site.server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
