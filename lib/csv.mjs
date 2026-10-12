// csv.mjs: quote-aware CSV parsing for the nflverse / sportsdataverse files (Node 22+, no deps).
//
// RFC 4180: fields may be quoted, quoted fields may hold commas, newlines and doubled quotes ("").
// nflverse needs this: roster_weekly and stats_player_week carry headshot_url values like
// "https://static.www.nfl.com/image/upload/f_auto,q_auto/..." (a comma inside quotes), and a naive split(',')
// shifts every later column on almost every row.
//
// Built for size: play_by_play is about 26 MB of text now and about 100 MB by January, with 372 columns.
// `columns` keeps only the named columns, so other fields are never sliced into strings.
// CsvStream accepts text in chunks (for example from a gunzip stream) and emits rows as they complete.

import { gunzipSync } from 'node:zlib';

const QUOTE = 34, COMMA = 44, LF = 10, CR = 13;

/** Buffer / Uint8Array (gzip or plain) or string -> UTF-8 text. */
export function gunzipText(input) {
  if (typeof input === 'string') return input;
  if (input == null) return '';
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf8');
  return buf.toString('utf8');
}

/** True when the bytes start with the gzip magic number. */
export const isGzip = (buf) => !!buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;

/**
 * Scan complete records from text[pos..]. Calls onRecord(fields) for each. fields holds every field when keep is
 * null; otherwise only the fields whose index has keep[i] >= 0, placed at out[keep[i]] (others are skipped).
 * Returns { pos, count } where pos is the index just after the last complete record. With final=false a record
 * that runs off the end of the text is left unconsumed so the caller can append more text and resume.
 */
function scanRecords(text, pos, final, keepFor, onRecord) {
  const n = text.length;
  while (pos < n) {
    // blank lines between records are skipped
    const c0 = text.charCodeAt(pos);
    if (c0 === LF) { pos++; continue; }
    if (c0 === CR) {
      if (pos + 1 >= n && !final) return { pos, incomplete: true };
      pos += (pos + 1 < n && text.charCodeAt(pos + 1) === LF) ? 2 : 1;
      continue;
    }
    const keep = keepFor();
    const fields = keep ? new Array(keep.width).fill('') : [];
    let col = 0, i = pos;
    for (;;) { // one field per pass
      const want = keep ? (col < keep.map.length ? keep.map[col] : -1) : col;
      let value = '';
      if (i < n && text.charCodeAt(i) === QUOTE) {
        let j = i + 1, start = j, parts = null;
        for (;;) {
          const q = text.indexOf('"', j);
          if (q < 0) { j = -1; break; }
          if (q + 1 < n && text.charCodeAt(q + 1) === QUOTE) { // doubled quote inside a quoted field
            if (want >= 0) (parts ||= []).push(text.slice(start, q + 1));
            j = q + 2; start = j; continue;
          }
          if (q + 1 >= n && !final) { j = -1; break; } // cannot tell yet whether this quote is doubled
          if (want >= 0) value = parts ? parts.join('') + text.slice(start, q) : text.slice(start, q);
          j = q + 1; break;
        }
        if (j < 0) {
          if (!final) return { pos, incomplete: true };
          if (want >= 0) value = (parts ? parts.join('') : '') + text.slice(start); // unterminated quote: take the rest
          i = n;
        } else i = j;
        while (i < n) { const c = text.charCodeAt(i); if (c === COMMA || c === LF || c === CR) break; i++; } // lenient
      } else {
        const s = i;
        while (i < n) { const c = text.charCodeAt(i); if (c === COMMA || c === LF || c === CR) break; i++; }
        if (want >= 0) value = text.slice(s, i);
      }
      if (want >= 0) { if (keep) fields[want] = value; else fields.push(value); }
      col++;
      if (i >= n) { if (!final) return { pos, incomplete: true }; break; }
      const c = text.charCodeAt(i);
      if (c === COMMA) { i++; continue; }
      if (c === CR) {
        if (i + 1 >= n && !final) return { pos, incomplete: true };
        i += (i + 1 < n && text.charCodeAt(i + 1) === LF) ? 2 : 1;
      } else i++; // LF
      break;
    }
    pos = i;
    onRecord(fields, col);
  }
  return { pos, incomplete: false };
}

/**
 * Chunked parser. new CsvStream({ columns, onHeader, onRow }) then push(text) any number of times and end().
 * onRow(row) gets an array aligned to `head` (the requested columns, or all columns). Rows whose field count
 * differs from the header are counted in `skipped` and not emitted (a truncated or corrupt line).
 */
export class CsvStream {
  constructor({ columns = null, onHeader = null, onRow = () => {} } = {}) {
    this.columns = columns;
    this.onHeader = onHeader;
    this.onRow = onRow;
    this.buf = '';
    this.head = null;          // output column names
    this.fullHead = null;      // every column name in the file
    this.missing = [];         // requested columns not in the file
    this.keep = null;
    this.count = 0;
    this.skipped = 0;
    this.headerWidth = 0;
  }

  _keepFor() {
    return this.keep; // null while reading the header (keep every field)
  }

  _record(fields, width) {
    if (!this.fullHead) {
      this.fullHead = fields.map((f, i) => (i === 0 ? f.replace(/^﻿/, '') : f));
      this.headerWidth = this.fullHead.length;
      if (this.columns) {
        const idx = new Map(this.fullHead.map((h, i) => [h, i]));
        this.head = [...this.columns];
        this.missing = this.columns.filter((c) => !idx.has(c));
        const map = new Array(this.fullHead.length).fill(-1);
        this.columns.forEach((c, outIdx) => { if (idx.has(c)) map[idx.get(c)] = outIdx; });
        this.keep = { map, width: this.columns.length };
      } else {
        this.head = this.fullHead;
        this.keep = { map: this.fullHead.map((_, i) => i), width: this.fullHead.length };
      }
      if (this.onHeader) this.onHeader(this.head, { missing: this.missing, fullHead: this.fullHead });
      return;
    }
    if (width !== this.headerWidth) { this.skipped++; return; }
    this.count++;
    this.onRow(fields);
  }

  push(chunk) {
    if (!chunk) return this;
    this.buf = this.buf ? this.buf + chunk : chunk;
    const r = scanRecords(this.buf, 0, false, () => this._keepFor(), (f, w) => this._record(f, w));
    this.buf = r.pos >= this.buf.length ? '' : this.buf.slice(r.pos);
    return this;
  }

  end() {
    if (this.buf) scanRecords(this.buf, 0, true, () => this._keepFor(), (f, w) => this._record(f, w));
    this.buf = '';
    return { head: this.head || [], missing: this.missing, count: this.count, skipped: this.skipped, fullHead: this.fullHead || [] };
  }
}

/**
 * parseCsv(text | Buffer, { columns, filter }) -> { head, rows, missing, skipped }
 * rows are arrays aligned to head. columns (optional) = names to keep, in that order; names absent from the file
 * are listed in `missing` and read as ''. filter(row) (optional) drops rows as they are parsed.
 */
export function parseCsv(input, { columns = null, filter = null } = {}) {
  const text = gunzipText(input);
  const rows = [];
  const s = new CsvStream({ columns, onRow: (r) => { if (!filter || filter(r)) rows.push(r); } });
  s.push(text);
  const meta = s.end();
  return { head: meta.head, rows, missing: meta.missing, skipped: meta.skipped };
}

/** forEachCsvRow(text | Buffer, fn, { columns }) streams rows to fn without keeping them. Returns the metadata. */
export function forEachCsvRow(input, fn, { columns = null, chunkSize = 0 } = {}) {
  const text = gunzipText(input);
  const s = new CsvStream({ columns, onRow: fn });
  if (chunkSize > 0) for (let i = 0; i < text.length; i += chunkSize) s.push(text.slice(i, i + chunkSize));
  else s.push(text);
  return s.end();
}

/**
 * parseCsvStream(asyncIterable of Buffer/string chunks, { columns, filter, gunzip }) -> Promise<{ head, rows, ... }>
 * For a file: parseCsvStream(createReadStream(p).pipe(createGunzip())). Multi-byte characters split across
 * chunks are decoded correctly.
 */
export async function parseCsvStream(iterable, { columns = null, filter = null } = {}) {
  const rows = [];
  const s = new CsvStream({ columns, onRow: (r) => { if (!filter || filter(r)) rows.push(r); } });
  const dec = new TextDecoder('utf-8');
  for await (const chunk of iterable) s.push(typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true }));
  const tail = dec.decode();
  if (tail) s.push(tail);
  const meta = s.end();
  return { head: meta.head, rows, missing: meta.missing, skipped: meta.skipped };
}

/** { head, rows } -> [{ col: value }] (small tables only). */
export function toObjects({ head, rows }) {
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** Column index map; throws naming the first missing required column. */
export function colIndex(head, names, { required = true } = {}) {
  const out = {};
  for (const n of names) {
    const i = head.indexOf(n);
    if (i < 0 && required) throw new Error(`missing column ${n}`);
    out[n] = i;
  }
  return out;
}

/** '' / 'NA' / null -> NaN, else Number. */
export const num = (s) => (s === '' || s === 'NA' || s == null ? NaN : +s);
