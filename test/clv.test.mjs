// Kalshi kickoff close (closeYes) in the settle handshake: VWAP math, the pending list forms, the per-run lookup
// budget, holding a result back until its close is known, and never blocking a settlement for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIX } from './helpers.mjs';
import { closeVwap, normalizePending, CLOSE } from '../lib/clv.mjs';
import { settleHandshake, getPending, getPendingItems } from '../lib/ingest.mjs';
import { createKalshiClient } from '../lib/kalshi.mjs';
import { createHttp, pacedFetch, withDeadline, BudgetError } from '../lib/http.mjs';
import { KEY, fakeSite } from './fake-site.mjs';

const gz = (...p) => JSON.parse(gunzipSync(readFileSync(join(FIX, ...p))).toString('utf8'));
const ATL4 = 'KXNFLSPREAD-26OCT11BALATL-ATL4';
const SFSEA = 'KXNFLTOTAL-26OCT11SFSEA-53';
const T_ATL4 = gz('clv', `trades-${ATL4}.json.gz`);   // kickoff 2026-10-12T00:20Z, the 200 trades before it
const T_SFSEA = gz('clv', `trades-${SFSEA}.json.gz`); // kickoff 2026-10-11T20:25Z, only 90 trades before it
const KO_ATL4 = '2026-10-12T00:20:00Z';
const KO_SFSEA = '2026-10-11T20:25:00Z';
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

// Independent reference: sum(count x price) / sum(count) over the given trades.
const ref = (trades) => {
  let n = 0, v = 0;
  for (const t of trades) { n += Number(t.count_fp); v += Number(t.count_fp) * Number(t.yes_price_dollars); }
  return v / n;
};

test('closeVwap: count-weighted VWAP of the last 200 pregame trades, in dollars', () => {
  const c = closeVwap(T_ATL4.trades, { maxTs: sec(KO_ATL4) });
  assert.equal(c.trades, 200);
  assert.equal(c.closeYes, 0.4745);
  assert.equal(c.closeYes, Math.round(ref(T_ATL4.trades) * 1e4) / 1e4);
  assert.ok(Math.abs(c.contracts - T_ATL4.trades.reduce((a, t) => a + Number(t.count_fp), 0)) < 0.01);
  // fewer than 200 trades before kickoff: all of them
  const s = closeVwap(T_SFSEA.trades, { maxTs: sec(KO_SFSEA) });
  assert.equal(s.trades, 90);
  assert.equal(s.closeYes, Math.round(ref(T_SFSEA.trades) * 1e4) / 1e4);
  // only the newest `limit` trades count
  const last50 = closeVwap(T_ATL4.trades, { maxTs: sec(KO_ATL4), limit: 50 });
  assert.equal(last50.closeYes, Math.round(ref(T_ATL4.trades.slice(0, 50)) * 1e4) / 1e4);
  // trades after max_ts (the API should not send them) and block trades are left out, whatever their order
  const late = { ...T_ATL4.trades[0], created_time: '2026-10-12T00:25:00Z', yes_price_dollars: '0.9900', count_fp: '100000.00' };
  const block = { ...T_ATL4.trades[1], is_block_trade: true, yes_price_dollars: '0.0100', count_fp: '100000.00' };
  const mixed = [block, ...T_ATL4.trades.slice().reverse(), late];
  assert.equal(closeVwap(mixed, { maxTs: sec(KO_ATL4) }).closeYes, 0.4745);
  // the older field names (cents, integer counts)
  assert.deepEqual(closeVwap([{ yes_price: 40, count: 3, created_time: '2026-10-12T00:00:00Z' }, { yes_price: 50, count: 1, created_time: '2026-10-12T00:01:00Z' }]), { closeYes: 0.425, trades: 2, contracts: 4 });
  // nothing usable
  assert.equal(closeVwap([]), null);
  assert.equal(closeVwap(null), null);
  assert.equal(closeVwap([{ yes_price_dollars: '1.0000', count_fp: '5' }, { yes_price_dollars: '0.5', count_fp: '0' }]), null);
});

test('normalizePending: plain tickers and { ticker, kickoff } objects, deduped, junk dropped, at most 200', () => {
  assert.deepEqual(normalizePending([
    'KXNFLGAME-26OCT11SFSEA-SEA',
    { ticker: ATL4, kickoff: '2026-10-12T00:20Z' },
    { ticker: SFSEA, kickoff: sec(KO_SFSEA) },
    { ticker: 'KXNFLGAME-26OCT18CARPHI-CAR', kickoff: Date.parse('2026-10-18T17:00:00Z') },
    { ticker: 'KXNFLGAME-26OCT11SFSEA-SEA', kickoff: '2026-10-11T20:25:00Z' },   // same ticker again: fills the kickoff
    { ticker: 'bad ticker', kickoff: KO_ATL4 }, { kickoff: KO_ATL4 }, 42, null,
    { ticker: 'KXNFLGAME-26OCT19DALGB-GB', kickoff: 'soon' },
  ]), [
    { ticker: 'KXNFLGAME-26OCT11SFSEA-SEA', kickoff: '2026-10-11T20:25:00Z' },
    { ticker: ATL4, kickoff: KO_ATL4 },
    { ticker: SFSEA, kickoff: KO_SFSEA },
    { ticker: 'KXNFLGAME-26OCT18CARPHI-CAR', kickoff: '2026-10-18T17:00:00Z' },
    { ticker: 'KXNFLGAME-26OCT19DALGB-GB', kickoff: null },
  ]);
  assert.equal(normalizePending(Array.from({ length: 250 }, (_, i) => `KXNFLGAME-26OCT11X${i}-A`)).length, CLOSE.pendingMax);
  assert.deepEqual(normalizePending({ tickers: 'nope' }), []);
});

// A Kalshi stand-in: /markets?tickers=... answers with `settled` (ticker -> result or null for still open),
// /markets/trades serves the fixtures (or `tradesStatus[ticker]`), and every request is recorded.
function fakeKalshi({ settled = {}, tradesStatus = {}, tradesFor = {} } = {}) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname.endsWith('/markets/trades')) {
      const t = u.searchParams.get('ticker');
      const st = tradesStatus[t];
      if (st === 'budget') throw Object.assign(new BudgetError('settle time budget (30 s) spent'), {});
      if (st) return new Response('{"error":"x"}', { status: st });
      const trades = tradesFor[t] || (t === ATL4 ? T_ATL4.trades : t === SFSEA ? T_SFSEA.trades : []);
      return new Response(JSON.stringify({ cursor: '', trades }), { status: 200 });
    }
    if (u.pathname.endsWith('/markets')) {
      const want = (u.searchParams.get('tickers') || '').split(',');
      const markets = want.filter((t) => t in settled).map((t) => (settled[t]
        ? { ticker: t, status: 'finalized', result: settled[t], settlement_ts: '2026-10-12T03:40:00Z', settlement_value_dollars: settled[t] === 'yes' ? '1.0000' : '0.0000' }
        : { ticker: t, status: 'active', result: '' }));
      return new Response(JSON.stringify({ cursor: '', markets }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  f.calls = calls;
  f.trades = () => calls.filter((u) => u.pathname.endsWith('/markets/trades'));
  return f;
}
const clientOf = (f) => createKalshiClient({ http: createHttp({ fetchImpl: f, retries: 0 }) });

test('getPending / getPendingItems accept both forms from the site', async () => {
  const site = await fakeSite();
  try {
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }, 'KXNFLGAME-26OCT11SFSEA-SEA'];
    // The Worker's shape: { tickers: [strings], items: [{ ticker, kickoff }] }; the kickoff comes from items.
    assert.deepEqual(await getPendingItems({ url: site.url, key: KEY }), [{ ticker: ATL4, kickoff: KO_ATL4 }, { ticker: 'KXNFLGAME-26OCT11SFSEA-SEA', kickoff: null }]);
    assert.deepEqual(await getPending({ url: site.url, key: KEY }), [ATL4, 'KXNFLGAME-26OCT11SFSEA-SEA']);
    // An older site (tickers only, plain strings): the same tickers, no kickoffs, so no close lookups.
    site.state.pendingShape = 'legacy';
    site.state.pending = [ATL4, 'KXNFLGAME-26OCT11SFSEA-SEA'];
    assert.deepEqual(await getPendingItems({ url: site.url, key: KEY }), [{ ticker: ATL4, kickoff: null }, { ticker: 'KXNFLGAME-26OCT11SFSEA-SEA', kickoff: null }]);
    // tickers-only holding objects is still read (the form this collector was first written against)
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }];
    assert.deepEqual(await getPendingItems({ url: site.url, key: KEY }), [{ ticker: ATL4, kickoff: KO_ATL4 }]);
  } finally {
    site.server.close();
  }
});

test('settleHandshake: closeYes rides with the result; the trades request is max_ts = kickoff, limit 200; plain tickers unchanged', async () => {
  const site = await fakeSite();
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-clv-'));
  try {
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }, { ticker: SFSEA, kickoff: KO_SFSEA }, 'KXNFLGAME-26OCT11SFSEA-SEA'];
    const k = fakeKalshi({ settled: { [ATL4]: 'no', [SFSEA]: 'yes', 'KXNFLGAME-26OCT11SFSEA-SEA': 'yes' } });
    const out = await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(k), now: Date.parse('2026-10-12T04:00:00Z'), stateDir });
    assert.equal(out.settled, 3);
    assert.deepEqual(out.closes, { due: 2, lookups: 2, computed: 2, failed: 0, noTrades: 0, sentWithClose: 2, sentWithoutClose: 0, held: 0 });
    const posted = site.state.settled[0].results;
    const by = Object.fromEntries(posted.map((r) => [r.ticker, r]));
    assert.equal(by[ATL4].closeYes, 0.4745);
    assert.equal(by[ATL4].result, 'no');
    assert.equal(by[SFSEA].closeYes, Math.round(ref(T_SFSEA.trades) * 1e4) / 1e4);
    assert.ok(!('closeYes' in by['KXNFLGAME-26OCT11SFSEA-SEA']), 'a plain ticker settles exactly as before');
    const tr = k.trades();
    assert.equal(tr.length, 2);
    const q = tr.find((u) => u.searchParams.get('ticker') === ATL4).searchParams;
    assert.equal(q.get('max_ts'), String(sec(KO_ATL4)));
    assert.equal(q.get('limit'), '200');
    // settled at the site: nothing kept for them
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'clv-closes.json'), 'utf8')), { v: 1, closes: {} });
  } finally {
    site.server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('settleHandshake: the close is looked up while the game is on and kept; the result is posted with it later, without a second lookup', async () => {
  const site = await fakeSite();
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-clv-'));
  try {
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }];
    const now = Date.parse('2026-10-12T02:30:00Z');
    const k1 = fakeKalshi({ settled: { [ATL4]: null } }); // still open
    const a = await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(k1), now, stateDir });
    assert.equal(a.settled, 0);
    assert.equal(k1.trades().length, 1);
    assert.equal(site.state.settled.length, 0, 'nothing to post yet');
    const kept = JSON.parse(readFileSync(join(stateDir, 'clv-closes.json'), 'utf8')).closes[ATL4];
    assert.equal(kept.closeYes, 0.4745);
    assert.equal(kept.done, true);

    const k2 = fakeKalshi({ settled: { [ATL4]: 'no' } });
    const b = await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(k2), now: now + 3600e3, stateDir });
    assert.equal(k2.trades().length, 0, 'the kept close is reused');
    assert.equal(b.settled, 1);
    assert.equal(site.state.settled[0].results[0].closeYes, 0.4745);
  } finally {
    site.server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('settleHandshake: at most maxCloses lookups per run; a settled result whose close is missing is held back and posted on a later run', async () => {
  const site = await fakeSite();
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-clv-'));
  try {
    // three settled tickers due, budget 1 per run (the live budget is CLOSE.lookupsPerRun = 40)
    const extra = 'KXNFLGAME-26OCT11SFSEA-SF';
    site.state.pending = [{ ticker: extra, kickoff: KO_SFSEA }, { ticker: ATL4, kickoff: KO_ATL4 }, { ticker: SFSEA, kickoff: KO_SFSEA }];
    const settled = { [ATL4]: 'no', [SFSEA]: 'yes', [extra]: 'no' };
    const now = Date.parse('2026-10-12T04:00:00Z');
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const k = fakeKalshi({ settled });
      runs.push({ out: await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(k), now: now + i * 300e3, stateDir, maxCloses: 1 }), trades: k.trades().map((u) => u.searchParams.get('ticker')) });
      // the site stops listing what it settled
      const done = new Set((site.state.settled.at(-1)?.results || []).map((r) => r.ticker));
      site.state.pending = site.state.pending.filter((p) => !done.has(p.ticker));
    }
    // oldest kickoff first, then ticker: the SF moneyline (no trades in the fixture), the SF @ SEA total, then ATL4
    assert.deepEqual(runs.map((r) => r.trades), [[extra], [SFSEA], [ATL4]]);
    assert.deepEqual(runs.map((r) => [r.out.settled, r.out.closes.held]), [[1, 2], [1, 1], [1, 0]]);
    const posted = site.state.settled.flatMap((s) => s.results);
    assert.deepEqual(posted.map((r) => [r.ticker, r.closeYes]), [[extra, null], [SFSEA, Math.round(ref(T_SFSEA.trades) * 1e4) / 1e4], [ATL4, 0.4745]]);
    assert.equal(runs[0].out.closes.noTrades, 1, 'no pregame trades: posted with closeYes null');
    assert.deepEqual(site.state.pending, []);
  } finally {
    site.server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('settleHandshake: a failing trades lookup (any error, 404 included) delays a settlement at most CLOSE.maxAttempts runs', async () => {
  const site = await fakeSite();
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-clv-'));
  try {
    const t404 = 'KXNFLGAME-26OCT11SFSEA-SF';
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }, { ticker: t404, kickoff: KO_SFSEA }];
    const k = () => fakeKalshi({ settled: { [ATL4]: 'no', [t404]: 'no' }, tradesStatus: { [ATL4]: 503, [t404]: 404 } });
    const now = Date.parse('2026-10-12T03:00:00Z');
    const a = await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(k()), now, stateDir });
    assert.equal(site.state.settled.length, 0, 'both held for a retry');
    assert.deepEqual([a.closes.held, a.closes.failed], [2, 2]);
    const b = await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(k()), now: now + 300e3, stateDir });
    assert.equal(b.closes.held, 2, 'second failure: still held');
    const c = await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(k()), now: now + 600e3, stateDir });
    assert.equal(c.closes.held, 0, `third failure (CLOSE.maxAttempts = ${CLOSE.maxAttempts}): posted without a close`);
    assert.deepEqual(site.state.settled[0].results.map((r) => [r.ticker, r.result, r.closeYes]).sort(), [[t404, 'no', null], [ATL4, 'no', null]].sort());
  } finally {
    site.server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('settleHandshake: a backlog after a collector outage (kickoffs days old, more than one run of lookups) still gets every close', async () => {
  const site = await fakeSite();
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-clv-'));
  try {
    const third = 'KXNFLSPREAD-26OCT11BALATL-ATL7';
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }, { ticker: SFSEA, kickoff: KO_SFSEA }, { ticker: third, kickoff: KO_ATL4 }];
    const settled = { [ATL4]: 'no', [SFSEA]: 'yes', [third]: 'no' };
    const now = Date.parse(KO_ATL4) + 3 * 86400e3; // three days after kickoff, far past CLOSE.holdMs
    const held = [];
    for (let i = 0; i < 3; i++) {
      const out = await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(fakeKalshi({ settled, tradesFor: { [third]: T_ATL4.trades } })), now: now + i * 300e3, stateDir, maxCloses: 1 });
      held.push(out.closes.held);
      const done = new Set((site.state.settled.at(-1)?.results || []).map((r) => r.ticker));
      site.state.pending = site.state.pending.filter((p) => !done.has(p.ticker));
    }
    assert.deepEqual(held, [2, 1, 0]);
    const posted = site.state.settled.flatMap((x) => x.results);
    assert.equal(posted.length, 3);
    assert.ok(posted.every((r) => typeof r.closeYes === 'number'), JSON.stringify(posted));
  } finally {
    site.server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('settleHandshake: without saved state the hold still ends CLOSE.holdMs after kickoff; a spent time budget stops the lookups', async () => {
  const site = await fakeSite();
  try {
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }];
    const failing = () => fakeKalshi({ settled: { [ATL4]: 'no' }, tradesStatus: { [ATL4]: 503 } });
    const early = await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(failing()), now: Date.parse(KO_ATL4) + CLOSE.holdMs - 60e3 });
    assert.equal(early.closes.held, 1);
    assert.equal(site.state.settled.length, 0);
    const late = await settleHandshake({ url: site.url, key: KEY, kalshi: clientOf(failing()), now: Date.parse(KO_ATL4) + CLOSE.holdMs + 60e3 });
    assert.equal(late.closes.held, 0);
    assert.deepEqual(site.state.settled[0].results.map((r) => [r.ticker, r.closeYes]), [[ATL4, null]]);

    // the settle budget runs out before the lookups: nothing is counted as a failure, the result waits for a later run
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }, { ticker: SFSEA, kickoff: KO_SFSEA }];
    const spent = fakeKalshi({ settled: { [ATL4]: 'no', [SFSEA]: 'yes' }, tradesStatus: { [SFSEA]: 'budget', [ATL4]: 'budget' } });
    const ctl = new AbortController();
    const fetchImpl = withDeadline(spent, ctl.signal);
    const kalshi = createKalshiClient({ http: createHttp({ fetchImpl, retries: 0 }) });
    const r = await settleHandshake({ url: site.url, key: KEY, kalshi, now: Date.parse('2026-10-12T04:00:00Z') });
    assert.equal(r.closes.lookups, 0);
    assert.equal(r.closes.failed, 0);
    assert.equal(r.closes.held, 2);
    assert.equal(spent.trades().length, 1, 'the first refusal stops the loop');
  } finally {
    site.server.close();
  }
});

test('settleHandshake: trades lookups go through the shared Kalshi pacer', async () => {
  const site = await fakeSite();
  try {
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }, { ticker: SFSEA, kickoff: KO_SFSEA }];
    const k = fakeKalshi({ settled: { [ATL4]: 'no', [SFSEA]: 'yes' } });
    const pacer = pacedFetch(k, { minGapMs: 40, backoffMs: 0 });
    const t0 = Date.now();
    const out = await settleHandshake({ url: site.url, key: KEY, kalshi: createKalshiClient({ http: createHttp({ fetchImpl: pacer, retries: 0 }) }), now: Date.parse('2026-10-12T04:00:00Z') });
    assert.equal(out.closes.computed, 2);
    assert.equal(pacer.stats.paced, 3, '/markets plus two trades lookups, all paced');
    assert.equal(k.calls.length, 3);
    assert.ok(Date.now() - t0 >= 2 * 40 - 15, 'three paced starts are at least two gaps apart');
  } finally {
    site.server.close();
  }
});

test('settleHandshake: a failed POST keeps the looked-up closes for the next run', async () => {
  const site = await fakeSite();
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-clv-'));
  try {
    site.state.pending = [{ ticker: ATL4, kickoff: KO_ATL4 }];
    const k = fakeKalshi({ settled: { [ATL4]: 'no' } });
    await assert.rejects(settleHandshake({ url: site.url, key: 'wrong-key', kalshi: clientOf(k), now: Date.parse('2026-10-12T04:00:00Z'), stateDir }), /pending: HTTP 401/);
    assert.ok(!existsSync(join(stateDir, 'clv-closes.json')), 'pending refused: nothing looked up');
    // the settle POST itself fails (the fake site answers 404 to a settle at another path): closes are kept
    const realPath = site.url;
    const failingFetch = async (u, init) => (String(u).endsWith('/api/collector/settle') ? new Response('{"error":"down"}', { status: 503 }) : fetch(u, init));
    await assert.rejects(settleHandshake({ url: realPath, key: KEY, kalshi: clientOf(k), fetchImpl: failingFetch, now: Date.parse('2026-10-12T04:00:00Z'), stateDir }), /settle: HTTP 503/);
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'clv-closes.json'), 'utf8')).closes[ATL4].closeYes, 0.4745);
  } finally {
    site.server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
