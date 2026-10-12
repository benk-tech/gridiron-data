import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { signature, signedHeaders, sha256Hex, packSnapshot, postSnapshot, getPending, postSettle, settleHandshake, PATHS } from '../lib/ingest.mjs';
import { createKalshiClient } from '../lib/kalshi.mjs';
import { createHttp } from '../lib/http.mjs';

const KEY = 'test-key-not-a-secret_0123456789abcdefABCDEF-_';
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// What the Worker is expected to do (WebCrypto, key = UTF-8 bytes of the INGEST_KEY string).
async function workerSig(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))).toString('hex');
}

test('signature matches a WebCrypto (Worker-style) HMAC over method\\npath\\nts\\nhash', async () => {
  assert.equal(sha256Hex(Buffer.alloc(0)), EMPTY_SHA);
  const ts = '1791848940';
  const sig = signature(KEY, 'GET', '/api/collector/pending', ts, EMPTY_SHA);
  assert.equal(sig, await workerSig(KEY, `GET\n/api/collector/pending\n${ts}\n${EMPTY_SHA}`));
  assert.match(sig, /^[0-9a-f]{64}$/);
  const body = Buffer.from('hello');
  const h = signedHeaders({ key: KEY, method: 'post', path: '/api/ingest', body, nowMs: 1791848940123 });
  assert.equal(h['X-GP-Timestamp'], '1791848940');
  assert.equal(h['X-GP-Signature'], await workerSig(KEY, `POST\n/api/ingest\n1791848940\n${sha256Hex(body)}`));
  assert.throws(() => signature('', 'GET', '/', '1', EMPTY_SHA), /INGEST_KEY/);
});

test('packSnapshot gzips the exact JSON and hashes the gzip bytes', () => {
  const snap = { v: 1, generatedAt: '2026-10-11T23:49:00Z', games: [{ id: 'nfl-1' }] };
  const p = packSnapshot(snap);
  assert.equal(gunzipSync(p.gz).toString('utf8'), JSON.stringify(snap));
  assert.equal(p.sha, createHash('sha256').update(p.gz).digest('hex'));
  assert.equal(p.gzBytes, p.gz.length);
});

// A stand-in for the Worker's collector routes that verifies everything SPEC section 4 requires.
function fakeSite() {
  const state = { snapshots: [], settled: [], lastTs: 0, pending: ['KXNFLGAME-26OCT11SFSEA-SEA', 'KXNFLGAME-26OCT18CARPHI-CAR'], rejects: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const ts = req.headers['x-gp-timestamp'];
    const sig = req.headers['x-gp-signature'];
    const want = await workerSig(KEY, `${req.method}\n${url.pathname}\n${ts}\n${sha256Hex(body)}`);
    const send = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (sig !== want) { state.rejects.push('sig'); return send(401, { error: 'bad signature' }); }
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) { state.rejects.push('ts'); return send(401, { error: 'stale' }); }
    if (req.method === 'POST' && url.pathname === PATHS.ingest) {
      if (Number(ts) <= state.lastTs) { state.rejects.push('replay'); return send(409, { error: 'replay' }); }
      if (req.headers['content-type'] !== 'application/octet-stream' || req.headers['content-encoding']) return send(400, { error: 'headers' });
      state.lastTs = Number(ts);
      state.snapshots.push(body);
      return send(200, { ok: true, size: body.length });
    }
    if (req.method === 'GET' && url.pathname === PATHS.pending) return send(200, { tickers: state.pending });
    if (req.method === 'POST' && url.pathname === PATHS.settle) { state.settled.push(JSON.parse(body.toString('utf8'))); return send(200, { ok: true }); }
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

test('postSnapshot / pending / settle against a local signature-checking server', async () => {
  const site = await fakeSite();
  try {
    const snap = { v: 1, generatedAt: '2026-10-11T23:49:00Z', games: [] };
    const r = await postSnapshot(snap, { url: site.url, key: KEY });
    assert.equal(r.status, 200);
    assert.equal(r.json.size, r.gzBytes);
    assert.equal(JSON.parse(gunzipSync(site.state.snapshots[0]).toString('utf8')).generatedAt, '2026-10-11T23:49:00Z');
    // Same-second resend is a replay and is refused by the server.
    const again = await postSnapshot(snap, { url: site.url, key: KEY, nowMs: site.state.lastTs * 1000 });
    assert.equal(again.status, 409);
    // Wrong key is refused.
    const bad = await postSnapshot(snap, { url: site.url, key: 'wrong-key', nowMs: Date.now() + 2000 });
    assert.equal(bad.status, 401);

    assert.deepEqual(await getPending({ url: site.url, key: KEY }), site.state.pending);
    await postSettle([{ ticker: 'A', status: 'finalized', result: 'no', settledAt: '2026-10-12T03:00:00Z' }], { url: site.url, key: KEY });
    assert.equal(site.state.settled[0].results[0].result, 'no');

    // Full handshake with a mocked Kalshi: one market settled, one still open.
    const kfetch = async (u) => {
      const tickers = new URL(u).searchParams.get('tickers').split(',');
      assert.deepEqual(tickers, site.state.pending);
      return new Response(JSON.stringify({ cursor: '', markets: [
        { ticker: tickers[0], status: 'finalized', result: 'yes', settlement_ts: '2026-10-12T00:05:11Z' },
        { ticker: tickers[1], status: 'active', result: '' },
      ] }), { status: 200 });
    };
    const kalshi = createKalshiClient({ http: createHttp({ fetchImpl: kfetch }) });
    const out = await settleHandshake({ url: site.url, key: KEY, kalshi });
    assert.deepEqual(out, { pending: 2, found: 2, settled: 1 });
    assert.deepEqual(site.state.settled[1], { results: [{ ticker: 'KXNFLGAME-26OCT11SFSEA-SEA', status: 'finalized', result: 'yes', settledAt: '2026-10-12T00:05:11Z' }] });
  } finally {
    site.server.close();
  }
});

test('errors never leak the ingest URL', async () => {
  const secretUrl = 'https://very-secret-host.invalid';
  await assert.rejects(getPending({ url: secretUrl, key: KEY, fetchImpl: async () => { throw new Error(`getaddrinfo ENOTFOUND ${secretUrl}`); } }), (e) => {
    assert.ok(!e.message.includes('very-secret-host'), e.message);
    return true;
  });
  await assert.rejects(getPending({ url: 'http://example.com', key: KEY }), /https/);
});
