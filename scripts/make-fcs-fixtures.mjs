#!/usr/bin/env node
// Builds the FCS and lookahead test fixtures (test/fixtures/fcs/*.json.gz) from a saved set of ESPN CFB scoreboards:
//   node scripts/make-fcs-fixtures.mjs <espn-boards.json>
// The input is one JSON object of raw scoreboards keyed 'fbs-<week>' (groups=80) and 'fcs-<week>' (groups=81), as
// captured on 2026-10-13 19:44Z for weeks 7 to 9 of the 2026 season. Each board goes through lib/espn.mjs trimBoard,
// the same trim the collector applies before it keeps an FCS or lookahead board, so the fixtures hold exactly what
// the build reads. Public data only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimBoard } from '../lib/espn.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'fcs');
const src = JSON.parse(readFileSync(process.argv[2], 'utf8'));
mkdirSync(OUT, { recursive: true });
for (const [key, name] of [['fbs-7', 'espn-cfb-fbs-w7'], ['fcs-7', 'espn-cfb-fcs-w7'], ['fcs-8', 'espn-cfb-fcs-w8'], ['fbs-8', 'espn-cfb-fbs-w8']]) {
  const b = trimBoard(src[key]);
  const gz = gzipSync(Buffer.from(JSON.stringify(b), 'utf8'), { level: 9 });
  writeFileSync(join(OUT, `${name}.json.gz`), gz);
  console.log(`${name}: ${b.events.length} events, ${(gz.length / 1024).toFixed(1)} KB gz`);
}
