// Local stand-in for the site's collector routes (SPEC section 4), used by the ingest and CLI tests.
import { createServer } from 'node:http';
import { sha256Hex, PATHS } from '../lib/ingest.mjs';

export const KEY = 'test-key-not-a-secret_0123456789abcdefABCDEF-_';

// What the Worker is expected to do (WebCrypto, key = UTF-8 bytes of the INGEST_KEY string).
export async function workerSig(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))).toString('hex');
}

// A stand-in for the Worker's collector routes that verifies everything SPEC section 4 requires.
export function fakeSite({ key = KEY } = {}) {
  const state = { snapshots: [], settled: [], lastTs: 0, pending: ['KXNFLGAME-26OCT11SFSEA-SEA', 'KXNFLGAME-26OCT18CARPHI-CAR'], rejects: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const ts = req.headers['x-gp-timestamp'];
    const sig = req.headers['x-gp-signature'];
    const want = await workerSig(key, `${req.method}\n${url.pathname}\n${ts}\n${sha256Hex(body)}`);
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
