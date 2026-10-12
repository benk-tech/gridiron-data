// lib/csv.mjs: quote-aware parsing, column projection, chunked streaming, gzip. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync, createGunzip } from 'node:zlib';
import { FIX } from './helpers.mjs';
import { parseCsv, CsvStream, forEachCsvRow, parseCsvStream, gunzipText, isGzip, toObjects, colIndex, num } from '../lib/csv.mjs';

const A = join(FIX, 'angles');

const TRICKY = [
  '﻿id,name,url,note',
  '1,Aaron Rodgers,"https://static.www.nfl.com/image/upload/f_auto,q_auto/league/x",plain',
  '2,"Ja\'Marr ""Chase""","a,b,c","line one',
  'line two"',
  '',
  '3,Short row',
  '4,Trailing,,',
  '5,"Crlf",x,y\r',
  '6,"end quote",z,"last"',
].join('\n');

test('quotes, doubled quotes, embedded commas and newlines, CRLF, blank lines, BOM', () => {
  const t = parseCsv(TRICKY);
  assert.deepEqual(t.head, ['id', 'name', 'url', 'note']);
  assert.equal(t.skipped, 1, 'the 2-field row is skipped, not shifted');
  assert.deepEqual(t.rows[0], ['1', 'Aaron Rodgers', 'https://static.www.nfl.com/image/upload/f_auto,q_auto/league/x', 'plain']);
  assert.deepEqual(t.rows[1], ['2', 'Ja\'Marr "Chase"', 'a,b,c', 'line one\nline two']);
  assert.deepEqual(t.rows[2], ['4', 'Trailing', '', '']);
  assert.deepEqual(t.rows[3], ['5', 'Crlf', 'x', 'y']);
  assert.deepEqual(t.rows[4], ['6', 'end quote', 'z', 'last']);
  assert.equal(t.rows.length, 5);
});

test('column projection keeps only the requested columns, in order; absent names are listed and read as empty', () => {
  const t = parseCsv(TRICKY, { columns: ['note', 'id', 'nope'] });
  assert.deepEqual(t.head, ['note', 'id', 'nope']);
  assert.deepEqual(t.missing, ['nope']);
  assert.deepEqual(t.rows[1], ['line one\nline two', '2', '']);
  assert.equal(t.rows.length, 5);
  const f = parseCsv(TRICKY, { columns: ['id'], filter: (r) => +r[0] > 3 });
  assert.deepEqual(f.rows, [['4'], ['5'], ['6']]);
});

test('CsvStream: any chunking gives the same rows (splits inside quotes, between CR and LF, after a closing quote)', () => {
  const ref = parseCsv(TRICKY, { columns: ['id', 'url', 'note'] }).rows;
  for (const size of [1, 2, 3, 5, 7, 11, 64]) {
    const rows = [];
    const s = new CsvStream({ columns: ['id', 'url', 'note'], onRow: (r) => rows.push(r) });
    for (let i = 0; i < TRICKY.length; i += size) s.push(TRICKY.slice(i, i + size));
    const meta = s.end();
    assert.deepEqual(rows, ref, `chunk size ${size}`);
    assert.equal(meta.skipped, 1);
  }
  const meta = forEachCsvRow(TRICKY, () => {}, { chunkSize: 4 });
  assert.equal(meta.count, 5);
});

test('gzip in, text out; parseCsvStream decodes multi-byte characters split across chunks', async () => {
  const text = 'name,city\n"Müller, Thomas",Zürich\nRenée,"São Paulo"\n';
  const gz = gzipSync(text);
  assert.equal(isGzip(gz), true);
  assert.equal(isGzip(Buffer.from(text)), false);
  assert.equal(gunzipText(gz), text);
  assert.equal(gunzipText(Buffer.from(text)), text);
  assert.equal(gunzipText(text), text);
  assert.deepEqual(parseCsv(gz).rows, [['Müller, Thomas', 'Zürich'], ['Renée', 'São Paulo']]);
  const bytes = Buffer.from(text, 'utf8');
  const chunks = []; for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, i + 3)); // cuts through ü, é, ã
  const t = await parseCsvStream(Readable.from(chunks), { columns: ['city'] });
  assert.deepEqual(t.rows, [['Zürich'], ['São Paulo']]);
  const t2 = await parseCsvStream(Readable.from([gz]).pipe(createGunzip()));
  assert.deepEqual(t2.rows, [['Müller, Thomas', 'Zürich'], ['Renée', 'São Paulo']]);
});

test('helpers: toObjects, colIndex, num', () => {
  const t = parseCsv('a,b\n1,NA\n');
  assert.deepEqual(toObjects(t), [{ a: '1', b: 'NA' }]);
  assert.deepEqual(colIndex(t.head, ['b', 'a']), { b: 1, a: 0 });
  assert.throws(() => colIndex(t.head, ['zz']), /missing column zz/);
  assert.deepEqual(colIndex(t.head, ['zz'], { required: false }), { zz: -1 });
  assert.ok(Number.isNaN(num('NA')) && Number.isNaN(num('')) && num('1.5') === 1.5);
});

test('real nflverse roster_weekly (quoted headshot_url with commas): every row aligned', () => {
  const buf = readFileSync(join(A, 'nflverse', 'roster_weekly_2026_trim.csv.gz'));
  const t = parseCsv(buf);
  assert.equal(t.skipped, 0);
  assert.ok(t.rows.length > 2500, `rows ${t.rows.length}`);
  const c = colIndex(t.head, ['gsis_id', 'espn_id', 'headshot_url', 'week', 'game_type']);
  const withComma = t.rows.filter((r) => r[c.headshot_url].includes(',')).length;
  assert.ok(withComma > 100, 'some headshot URLs contain commas');
  for (const r of t.rows) {
    assert.match(r[c.gsis_id], /^00-\d{7}$/);
    assert.match(r[c.espn_id], /^\d*$/);
    assert.match(r[c.week], /^\d+$/);
  }
  // a naive split would shift every later column on the rows with a comma in the URL
  const naive = gunzipText(buf).split('\n')[1 + t.rows.findIndex((r) => r[c.headshot_url].includes(','))].split(',');
  assert.notEqual(naive.length, t.head.length);
});
