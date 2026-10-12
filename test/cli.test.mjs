// End to end through collect.mjs with Kalshi/ESPN replaced by the saved capture (preload) and a local signing site.
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = pathToFileURL(join(ROOT, 'test', 'fake-upstream.mjs')).href;

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', PRELOAD, join(ROOT, 'collect.mjs'), ...args, ...(args.includes('--out') || args.includes('--post') ? ['--kalshi-gap-ms', '0'] : [])], {
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
    const r2 = await run(['--out', outFile2, '--cache-dir', join(tmp, 'cache'), '--state-dir', stateDir, '--closes-dir', join(tmp, 'closes'), '--skip', 'nflverse,cfb,injuries'], { FAKE_UPSTREAM: 'ok' });
    assert.equal(r2.code, 0, r2.out);
    const snap2 = JSON.parse(readFileSync(outFile2, 'utf8'));
    assert.equal(snap2.sources.moves.since, hist.at);
    assert.deepEqual(validateSnapshot(snap2), []);
    assert.ok(!existsSync(join(tmp, 'closes')), 'nothing kicked off between the runs: no closes archived');
    assert.equal(site.state.snapshots.length, 1);
    const posted = JSON.parse(gunzipSync(site.state.snapshots[0]).toString('utf8'));
    assert.deepEqual(validateSnapshot(posted), []);
    assert.deepEqual(posted, JSON.parse(readFileSync(outFile, 'utf8')));
    assert.equal(posted.sources.kalshi.ok, true);
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
  } finally {
    site.server.close();
  }
});
