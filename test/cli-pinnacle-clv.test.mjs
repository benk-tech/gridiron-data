// End to end through collect.mjs (saved captures in place of the APIs, a local signing site): the Pinnacle pull and
// its 15 minute reuse, a blocked Pinnacle failing open, and the settle handshake posting Kalshi kickoff closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEY, fakeSite } from './fake-site.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { RESEARCH_NOW } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = pathToFileURL(join(ROOT, 'test', 'fake-upstream.mjs')).href;

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', PRELOAD, join(ROOT, 'collect.mjs'), '--kalshi-gap-ms', '0', ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
const at = (min) => new Date(Date.parse(RESEARCH_NOW) + min * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

test('collect.mjs: Pinnacle pulled, reused for 15 minutes, and a blocked pull fails open', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-cli-pin-'));
  try {
    const common = ['--cache-dir', join(tmp, 'cache'), '--state-dir', join(tmp, 'state'), '--closes-dir', join(tmp, 'closes'), '--skip', 'props,teamTotals,nflverse,cfb,injuries'];
    const snap = (n) => JSON.parse(readFileSync(join(tmp, `s${n}.json`), 'utf8'));
    const r1 = await run(['--out', join(tmp, 's1.json'), ...common, '--now', at(0)], { FAKE_PINNACLE: 'ok' });
    assert.equal(r1.code, 0, r1.out);
    assert.match(r1.out, /pinnacle: nfl 11\/14 pregame games \(1 off the board\), cfb 59\/62 pregame games \(2 off the board\); pulled, 4 requests; unmatched 1/);
    assert.match(r1.out, /source pinnacle: ok/);
    const s1 = snap(1);
    assert.deepEqual(validateSnapshot(s1), []);
    assert.equal(s1.sources.pinnacle.matched, 70);
    assert.deepEqual(s1.unmatched.pinnacle, ['nfl: Buffalo Bills @ Los Angeles Rams 2026-10-12'], 'this ESPN capture has no BUF @ LAR');
    assert.equal(s1.collector.timings.pinnacle.requests, 4);

    const r2 = await run(['--out', join(tmp, 's2.json'), ...common, '--now', at(5)], { FAKE_PINNACLE: 'ok' });
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.out, /reused the pull from 2026-10-11T22:51:00Z/);
    const s2 = snap(2);
    assert.equal(s2.sources.pinnacle.cached, true);
    assert.equal(s2.collector.timings.pinnacle.requests, 0);
    assert.deepEqual(s2.games.map((g) => g.refs ?? null), s1.games.map((g) => g.refs ?? null), 'the same refs from the saved copy');

    // 15 minutes after the pull: pulled again, and this time the runner's IP is blocked (HTTP 403, not retried)
    const r3 = await run(['--out', join(tmp, 's3.json'), ...common, '--now', at(15)], { FAKE_PINNACLE: 'block' });
    assert.equal(r3.code, 0, r3.out);
    assert.match(r3.out, /pulled, 2 requests/);
    assert.match(r3.out, /source pinnacle: NOT OK .*HTTP 403/);
    const s3 = snap(3);
    assert.ok(s3.games.every((g) => !('refs' in g)));
    // (DK odds carry the real fetch time, which differs between runs)
    // Kalshi's previous run book (kalshi.prevQuotes, prevAt) is run to run state: present from the second run on
    const strip = (s) => s.games.map((g) => {
      const c = { ...g, odds: g.odds && { ...g.odds, fetchedAt: null }, kalshi: { ...g.kalshi } };
      delete c.refs; delete c.kalshi.prevQuotes; delete c.kalshi.prevAt;
      return c;
    });
    assert.deepEqual(strip(s3), strip(s1), 'everything else is as before');
    assert.deepEqual(validateSnapshot(s3), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('collect.mjs --settle: kickoff closes ride with the settle results; plain tickers settle as before', async () => {
  const site = await fakeSite();
  const tmp = mkdtempSync(join(tmpdir(), 'gd-cli-clv-'));
  try {
    site.state.pending = [
      { ticker: 'KXNFLSPREAD-26OCT11BALATL-ATL4', kickoff: '2026-10-12T00:20:00Z' },
      { ticker: 'KXNFLGAME-26OCT18CARPHI-CAR', kickoff: '2026-10-18T17:00:00Z' },   // not kicked off yet: no lookup
      'KXNFLGAME-26OCT11SFSEA-SEA',
    ];
    const r = await run(['--settle', '--state-dir', join(tmp, 'state'), '--now', '2026-10-12T04:00:00Z'], { INGEST_URL: site.url, INGEST_KEY: KEY });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /settle: 3 pending, 3 found on Kalshi, 3 settled \(1 with a close, 0 without\), 0 held for their close; closes: 1 due, 1 looked up \(1 computed/);
    const by = Object.fromEntries(site.state.settled[0].results.map((x) => [x.ticker, x]));
    assert.equal(by['KXNFLSPREAD-26OCT11BALATL-ATL4'].closeYes, 0.4745);
    assert.ok(!('closeYes' in by['KXNFLGAME-26OCT18CARPHI-CAR']));
    assert.ok(!('closeYes' in by['KXNFLGAME-26OCT11SFSEA-SEA']));
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'state', 'clv-closes.json'), 'utf8')), { v: 1, closes: {} });
    assert.ok(!r.out.includes(KEY) && !r.out.includes('127.0.0.1'));
  } finally {
    site.server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
