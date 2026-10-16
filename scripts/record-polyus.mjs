// Preload for a live collector run that also keeps the raw Polymarket US answers, for fixtures
// (scripts/make-polyus-fixtures.mjs). It sends no request of its own: it wraps globalThis.fetch and copies every
// gateway.polymarket.us response body it sees to $POLYUS_RECORD_DIR as <n>.json.gz, with index.json listing
// { n, url, status, at } in request order.
//
//   POLYUS_RECORD_DIR=/tmp/rec node --import ./scripts/record-polyus.mjs collect.mjs --out snap.json --save-inputs in.json.gz ...

import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIR = process.env.POLYUS_RECORD_DIR;
if (DIR) {
  mkdirSync(DIR, { recursive: true });
  const orig = globalThis.fetch;
  const index = [];
  let n = 0;
  globalThis.fetch = async (input, init) => {
    const res = await orig(input, init);
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (new URL(url).hostname === 'gateway.polymarket.us') {
      const k = n++;
      const at = new Date().toISOString();
      try {
        const text = await res.clone().text();
        writeFileSync(join(DIR, `${k}.json.gz`), gzipSync(Buffer.from(text, 'utf8')));
        index.push({ n: k, url, status: res.status, at });
      } catch (e) {
        index.push({ n: k, url, status: res.status, at, error: String(e?.message || e) });
      }
      writeFileSync(join(DIR, 'index.json'), JSON.stringify(index, null, 1));
    }
    return res;
  };
}
