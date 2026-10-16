// End to end through collect.mjs (saved captures in place of the APIs): the exchange reference venues are pulled on
// their cadence (each at most every 15 minutes, reused from the state dir in between), logged with their timings and
// request counts, and fail open: blocked or skipped venues leave the rest of the snapshot as it was.
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
    for (const v of ['polyus', 'gemini', 'sx']) assert.ok(existsSync(join(tmp, 'state', `${v}.json`)), `state/${v}.json keeps the pull`);

    // 5 minutes later: every venue reused, Polymarket US too (no requests; fetchedAt stays the time of the pull)
    const r2 = await run(['--out', join(tmp, 's2.json'), ...common, '--now', at(5)], { FAKE_VENUES: 'ok' });
    assert.equal(r2.code, 0, r2.out);
    for (const v of ['polyus', 'gemini', 'sx']) assert.match(r2.out, new RegExp(`${v}: .*; reused the pull from 2026-10-11T22:51:00Z`));
    assert.doesNotMatch(r2.out, /polyus: .*; pulled/);
    const s2 = snap(2);
    assert.deepEqual([s2.sources.gemini.cached, s2.sources.sx.cached, s2.sources.polyus.cached], [true, true, true]);
    assert.deepEqual([s2.collector.timings.gemini.requests, s2.collector.timings.sx.requests, s2.collector.timings.polyus.requests], [0, 0, 0]);
    assert.equal(s2.sources.polyus.fetchedAt, at(0));
    assert.equal(s2.sources.gemini.fetchedAt, at(0));
    assert.deepEqual([s2.sources.polyus.ok, s2.sources.polyus.matched], [true, 75], 'the reused pull still votes');
    const g2 = s2.games.find((g) => g.refs?.venues?.sx);
    assert.equal(g2.refs.venues.sx.fetchedAt, at(0));
    assert.equal(g2.refs.venues.polyus.fetchedAt, at(0));
    const polyRefs = (s) => s.games.map((g) => g.refs?.venues?.polyus ?? null);
    assert.deepEqual(polyRefs(s2), polyRefs(s1), 'the same Polymarket US blocks as the pull');
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
  assert.match(r.out, /unknown --skip part\(s\): novig \(known: props, teamTotals, injuries, nflverse, cfb, pinnacle, polyus, gemini, sx, ratinginputs, fcs, lookahead\)/);
});

test('collect.mjs: --polyus-details caps the Polymarket US event details (the format since 2026-10-15); a bad value is refused', async () => {
  for (const bad of ['x', '-1', '1.5', '']) {
    const r = await run(['--out', 'x.json', `--polyus-details=${bad}`], {});
    assert.equal(r.code, 2, `--polyus-details ${JSON.stringify(bad)}`);
    assert.match(r.out, /bad --polyus-details value/);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'gd-cli-pud-'));
  try {
    const common = ['--cache-dir', join(tmp, 'cache'), '--closes-dir', join(tmp, 'closes'), '--skip', 'props,teamTotals,nflverse,cfb,injuries,pinnacle,gemini,sx,ratinginputs,fcs,lookahead', '--now', '2026-10-16T07:05:26Z'];
    // the 2026-10-16 lists and 16 details: 56 college games kick off within 48 hours (no NFL game does), 2 details
    // asked for, 54 left for the cap; the NFL games keep their winner quotes and that is no format error
    const a = await run(['--out', join(tmp, 'a.json'), ...common, '--polyus-details', '2'], { FAKE_VENUES: 'polyus=new' });
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /^polyus: 6 requests \(4 list, 2 event details for 56 games, 54 over the cap of 2\), [\d.]+ MB$/m);
    assert.match(a.out, /^source polyus: ok$/m);
    assert.match(a.out, /^ {2}polyus +6 req +\d+ ms$/m);
    assert.equal(JSON.parse(readFileSync(join(tmp, 'a.json'), 'utf8')).sources.polyus.requests, 6);
    // the default cap of 40, nearest first (32 of those details are not in the fixture and answer 404, so the source
    // is not ok)
    const b = await run(['--out', join(tmp, 'b.json'), ...common], { FAKE_VENUES: 'polyus=new' });
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /^polyus: 44 requests \(4 list, 40 event details for 56 games, 16 over the cap of 40\)/m);
    assert.match(b.out, /source polyus: NOT OK {2}cfb cfb-[a-z0-9-]+: gateway\.polymarket\.us\/v1\/events\/slug\/cfb-[a-z0-9-]+: HTTP 404/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
