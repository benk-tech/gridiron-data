// End to end through collect.mjs (saved captures in place of the APIs, a local signing site): the FCS and lookahead
// boards (part B), their 15 minute reuse, the --skip switches, and closeRef riding with the settle results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEY, fakeSite } from './fake-site.mjs';
import { validateSnapshot } from '../lib/schema.mjs';
import { RESEARCH_NOW } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = pathToFileURL(join(ROOT, 'test', 'fake-upstream.mjs')).href;

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', PRELOAD, join(ROOT, 'collect.mjs'), '--kalshi-gap-ms', '0', ...args], {
      cwd: ROOT, env: { ...process.env, FAKE_UPSTREAM: 'ok', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
const at = (min) => new Date(Date.parse(RESEARCH_NOW) + min * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const LIGHT = 'props,teamTotals,nflverse,cfb,injuries,ratinginputs';

test('collect.mjs: FCS vs FCS and lookahead games join the snapshot, the boards are reused for 15 minutes, --skip fcs,lookahead removes every trace', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-cli-fcs-'));
  try {
    const common = ['--cache-dir', join(tmp, 'cache'), '--state-dir', join(tmp, 'state'), '--closes-dir', join(tmp, 'closes'), '--skip', LIGHT];
    const snap = (n) => JSON.parse(readFileSync(join(tmp, `s${n}.json`), 'utf8'));
    const r1 = await run(['--out', join(tmp, 's1.json'), ...common, '--now', at(0)], { FAKE_FCS: 'ok' });
    assert.equal(r1.code, 0, r1.out);
    const s1 = snap(1);
    assert.deepEqual(validateSnapshot(s1), []);
    // 76 core games (the research capture), 54 FCS vs FCS games of week 7, 106 lookahead games of week 8
    assert.equal(s1.games.length, 236);
    assert.equal(s1.games.filter((g) => g.cls === 'CC' && !g.lookahead).length, 54);
    assert.equal(s1.games.filter((g) => g.lookahead).length, 106);
    assert.equal(s1.sources.fcs.ok, true, s1.sources.fcs.errors.join(' | '));
    assert.equal(s1.sources.lookahead.ok, true, s1.sources.lookahead.errors.join(' | '));
    assert.deepEqual([s1.collector.timings.fcs.requests, s1.collector.timings.lookahead.requests], [3, 1]);
    assert.match(r1.out, /part B: cfb classes .*CC 109.*; FCS vs FCS 54 in the window, 55 lookahead; lookahead games 106; fcs 3 board\(s\), 0 reused, 3 requests; lookahead 1 board\(s\), 0 reused, 1 requests/);
    assert.match(r1.out, /source fcs: ok/);
    assert.ok(s1.unmatched.kalshi.every((t) => !t.startsWith('KXNCAAF')), 'every college Kalshi game paired');
    assert.ok(readdirSync(join(tmp, 'state')).includes('espn-extra.json'));

    // 5 minutes later: no board is pulled again, the same games come back
    const r2 = await run(['--out', join(tmp, 's2.json'), ...common, '--now', at(5)], { FAKE_FCS: 'ok' });
    assert.equal(r2.code, 0, r2.out);
    const s2 = snap(2);
    assert.deepEqual([s2.collector.timings.fcs.requests, s2.collector.timings.lookahead.requests], [0, 0]);
    assert.deepEqual([s2.sources.fcs.reused, s2.sources.lookahead.reused], [3, 1]);
    assert.deepEqual(s2.games.map((g) => g.id), s1.games.map((g) => g.id));
    assert.equal(s2.sources.espnOdds.ok, s1.sources.espnOdds.ok);

    // --skip fcs,lookahead right after: the old snapshot, and no ESPN alarm about 160 vanished games. (At +6 minutes
    // the two week 8 games at 23:00Z on 2026-10-20 are still 9 days and 2 minutes away, so the core list is the same.)
    const r3 = await run(['--out', join(tmp, 's3.json'), ...common.slice(0, -1), `${LIGHT},fcs,lookahead`, '--now', at(6)], { FAKE_FCS: 'ok' });
    assert.equal(r3.code, 0, r3.out);
    const s3 = snap(3);
    assert.deepEqual(validateSnapshot(s3), []);
    assert.equal(s3.games.length, 76);
    assert.deepEqual(s3.games.map((g) => g.id), s1.games.filter((g) => g.cls !== 'CC' && !g.lookahead).map((g) => g.id));
    assert.ok(s3.games.every((g) => !('cls' in g) && !('lookahead' in g) && !('division' in g.home) && !('division' in g.away)));
    assert.ok(!('fcs' in s3.sources) && !('lookahead' in s3.sources) && !('fcs' in s3.collector.timings));
    assert.doesNotMatch(r3.out, /part B:/);
    assert.equal(s3.sources.espnOdds.ok, s1.sources.espnOdds.ok, s3.sources.espnOdds.errors.join(' | '));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('collect.mjs --settle: a tracked ticker whose game closed carries closeRef (the DK close and the first DK line seen)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gd-cli-ref-'));
  const site = await fakeSite();
  try {
    const dirs = ['--cache-dir', join(tmp, 'cache'), '--state-dir', join(tmp, 'state'), '--closes-dir', join(tmp, 'closes')];
    const r1 = await run(['--out', join(tmp, 's1.json'), ...dirs, '--skip', LIGHT, '--now', at(0)]);
    assert.equal(r1.code, 0, r1.out);
    const s1 = JSON.parse(readFileSync(join(tmp, 's1.json'), 'utf8'));
    const g = s1.games.find((x) => x.home.abbr === 'MTSU' && x.away.abbr === 'DEL'); // Tuesday 2026-10-13 23:00Z
    assert.ok(g?.odds && g.kalshi.gameEvent, 'DEL at MTSU has a DK line and a Kalshi game');
    // after kickoff the game has left the window: its close is staged, and the finished day copied to the archive
    const r2 = await run(['--out', join(tmp, 's2.json'), ...dirs, '--skip', LIGHT, '--now', '2026-10-14T06:00:00Z']);
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.out, /closes: staged \d+ game\(s\)/);
    const day = JSON.parse(readFileSync(join(tmp, 'closes', '2026-10-13.json'), 'utf8'));
    const close = day.games.find((x) => x.gameId === g.id);
    assert.deepEqual(close.events, [g.kalshi.gameEvent, g.kalshi.spreadEvent, g.kalshi.totalEvent].filter(Boolean));
    assert.equal(close.firstLine.at, '2026-10-11T22:51:00Z');
    // the site lists the winner contract after kickoff; Kalshi says it settled
    const ticker = g.kalshi.markets.find((m) => m.type === 'game' && m.team === 'home').ticker;
    site.state.pending = [{ ticker, kickoff: g.kickoff }, { ticker: 'KXNFLGAME-26OCT18CARPHI-CAR', kickoff: '2026-10-18T17:00:00Z' }];
    const r3 = await run(['--settle', ...dirs, '--now', '2026-10-14T06:05:00Z'], { INGEST_URL: site.url, INGEST_KEY: KEY });
    assert.equal(r3.code, 0, r3.out);
    assert.match(r3.out, /1 with a DK close ref/);
    const rows = site.state.settled.flatMap((b) => b.results);
    const row = rows.find((x) => x.ticker === ticker);
    assert.deepEqual(Object.keys(row.closeRef), ['v', 'gameId', 'at', 'odds', 'firstLine']);
    assert.equal(row.closeRef.gameId, g.id);
    assert.deepEqual(row.closeRef.odds, close.odds);
    assert.deepEqual(row.closeRef.firstLine, close.firstLine);
    assert.ok(Buffer.byteLength(JSON.stringify(row.closeRef)) <= 2048);
    assert.equal(rows.find((x) => x.ticker === 'KXNFLGAME-26OCT18CARPHI-CAR').closeRef, undefined, 'no archived close for that game');
  } finally {
    site.server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
