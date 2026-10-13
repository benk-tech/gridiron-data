// End to end through collect.mjs (saved captures in place of the APIs): the exchange reference venues are pulled on
// their own cadence (Polymarket US every run, Gemini and SX Bet every 15 minutes from the state dir), logged with
// their timings and request counts, and fail open: blocked or skipped venues leave the rest of the snapshot as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSnapshot } from '../lib/schema.mjs';
import { foldKalshiBook } from '../lib/moves.mjs';
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
// DK odds carry the real fetch time, which differs between runs; Kalshi's previous run book (prevQuotes, prevAt) is
// run to run state, present from the second run on
const games = (s, { keepVenues = false } = {}) => s.games.map((g) => {
  const c = JSON.parse(JSON.stringify({ ...g, odds: g.odds && { ...g.odds, fetchedAt: null } }));
  if (!keepVenues && c.refs) { delete c.refs.venues; if (!Object.keys(c.refs).length) delete c.refs; }
  delete c.kalshi.prevQuotes; delete c.kalshi.prevAt;
  return c;
});

test('collect.mjs: venues pulled on their cadence, logged, reused from state; blocked or skipped venues fail open', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-cli-ven-'));
  try {
    const common = ['--cache-dir', join(tmp, 'cache'), '--state-dir', join(tmp, 'state'), '--closes-dir', join(tmp, 'closes'), '--skip', 'props,teamTotals,nflverse,cfb,injuries,pinnacle'];
    const snap = (n) => JSON.parse(readFileSync(join(tmp, `s${n}.json`), 'utf8'));

    const r1 = await run(['--out', join(tmp, 's1.json'), ...common, '--now', at(0)], { FAKE_VENUES: 'ok' });
    assert.equal(r1.code, 0, r1.out);
    assert.match(r1.out, /polyus: nfl 14\/14 pregame games \(\d+ quotes\), cfb 61\/62 pregame games \(\d+ quotes\); pulled, 4 requests in \d+ ms; unmatched \d+ \(cfb: /);
    assert.match(r1.out, /gemini: nfl 14\/14 pregame games \(\d+ quotes\), cfb 38\/62 pregame games \(\d+ quotes\); pulled, 1 requests in \d+ ms/);
    assert.match(r1.out, /sx: nfl 14\/14 pregame games \(14 quotes\); pulled, 16 requests in \d+ ms; unmatched 1 \(nfl: Buffalo Bills @ Los Angeles Rams 2026-10-12\)/);
    assert.match(r1.out, /^ {2}polyus +4 req +\d+ ms$/m, 'per-venue timing line');
    assert.match(r1.out, /^ {2}sx +16 req +\d+ ms$/m);
    for (const v of ['polyus', 'gemini', 'sx']) assert.match(r1.out, new RegExp(`source ${v}: ok`));
    const s1 = snap(1);
    assert.deepEqual(validateSnapshot(s1), []);
    assert.deepEqual([s1.sources.polyus.matched, s1.sources.gemini.matched, s1.sources.sx.matched], [75, 52, 14]);
    assert.deepEqual([s1.collector.timings.polyus.requests, s1.collector.timings.gemini.requests, s1.collector.timings.sx.requests], [4, 1, 16]);
    assert.ok(existsSync(join(tmp, 'state', 'gemini.json')) && existsSync(join(tmp, 'state', 'sx.json')));
    assert.ok(!existsSync(join(tmp, 'state', 'polyus.json')), 'Polymarket US keeps no copy: pulled every run');

    // 5 minutes later: Polymarket US pulled again, Gemini and SX reused (fetchedAt stays the time of their pull)
    const r2 = await run(['--out', join(tmp, 's2.json'), ...common, '--now', at(5)], { FAKE_VENUES: 'ok' });
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.out, /polyus: .*; pulled, 4 requests/);
    assert.match(r2.out, /gemini: .*; reused the pull from 2026-10-11T22:51:00Z/);
    assert.match(r2.out, /sx: .*; reused the pull from 2026-10-11T22:51:00Z/);
    const s2 = snap(2);
    assert.deepEqual([s2.sources.gemini.cached, s2.sources.sx.cached, s2.sources.polyus.cached], [true, true, false]);
    assert.deepEqual([s2.collector.timings.gemini.requests, s2.collector.timings.sx.requests], [0, 0]);
    assert.equal(s2.sources.polyus.fetchedAt, at(5));
    assert.equal(s2.sources.gemini.fetchedAt, at(0));
    const g2 = s2.games.find((g) => g.refs?.venues?.sx);
    assert.equal(g2.refs.venues.sx.fetchedAt, at(0));
    assert.equal(g2.refs.venues.polyus.fetchedAt, at(5));
    // Kalshi's book from the previous run: none on the first run (no history), on every game with venue quotes from
    // the second run on, stamped with that run's time
    assert.ok(s1.games.every((g) => g.kalshi.prevQuotes === undefined && g.kalshi.prevAt === undefined), 'first run: no previous book');
    assert.equal(s1.sources.moves.prevBooks, 0);
    const withPrev = s2.games.filter((g) => g.kalshi.prevQuotes);
    // (a game whose Kalshi book is one sided on every key, like a 99 to 1 favorite, has nothing to carry)
    const missing = s2.games.filter((g) => g.refs?.venues && Object.keys(foldKalshiBook(g)).length && !(g.kalshi.prevQuotes && g.kalshi.prevAt === at(0)));
    assert.deepEqual(missing.map((g) => g.id), []);
    assert.ok(withPrev.length >= 70, `${withPrev.length}`);
    assert.equal(s2.sources.moves.prevBooks, withPrev.length);
    assert.match(r2.out, new RegExp(`previous run Kalshi books on ${withPrev.length} games`));
    assert.deepEqual(validateSnapshot(s2), []);

    // 15 minutes after the first pull, every venue host blocks the runner (HTTP 403): no venue refs, the rest as before
    const r3 = await run(['--out', join(tmp, 's3.json'), ...common, '--now', at(15)], { FAKE_VENUES: 'block' });
    assert.equal(r3.code, 0, r3.out);
    for (const v of ['polyus', 'gemini', 'sx']) assert.match(r3.out, new RegExp(`source ${v}: NOT OK .*HTTP 403`));
    const s3 = snap(3);
    assert.deepEqual(validateSnapshot(s3), []);
    assert.ok(s3.games.every((g) => !g.refs?.venues));
    assert.deepEqual([s3.sources.polyus.requests, s3.sources.gemini.requests, s3.sources.sx.requests], [2, 1, 1], 'a 403 is not retried');
    assert.deepEqual(games(s3), games(s1), 'everything else is as before');

    // --skip: no venue requests, no venue sources entries, and the games are the same as with the venues blocked
    const r4 = await run(['--out', join(tmp, 's4.json'), ...common.slice(0, -1), 'props,teamTotals,nflverse,cfb,injuries,pinnacle,polyus,gemini,sx', '--now', at(20)], { FAKE_VENUES: 'ok' });
    assert.equal(r4.code, 0, r4.out);
    const s4 = snap(4);
    assert.ok(['polyus', 'gemini', 'sx'].every((v) => !(v in s4.sources) && !(v in s4.collector.timings)));
    assert.doesNotMatch(r4.out, /source (polyus|gemini|sx)/);
    assert.deepEqual(games(s4, { keepVenues: true }), games(s3, { keepVenues: true }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('collect.mjs: unknown --skip names are refused; the venue names are known', async () => {
  const r = await run(['--out', 'x.json', '--skip', 'polyus,novig'], {});
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown --skip part\(s\): novig \(known: props, teamTotals, injuries, nflverse, cfb, pinnacle, polyus, gemini, sx\)/);
});
