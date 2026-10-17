import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDelimited, tableToCsv, tableToObjects, readTableFile } from '../lib/spreadsheet.ts';

/**
 * Uploaded spreadsheets used to be parsed with SheetJS 0.18.5 (unpatched
 * prototype-pollution / ReDoS advisories, no longer on npm). These pin what
 * the replacement must do for the subscriber import, the import wizard and
 * the monitoring host import.
 */

test('CSV: quoted commas, doubled quotes, CRLF and a BOM', () => {
  const rows = parseDelimited('﻿name,phone\r\n"Khan, Ali","03"\r\n"Sara ""B""",0300\r\n\r\n');
  assert.deepEqual(rows, [['name', 'phone'], ['Khan, Ali', '03'], ['Sara "B"', '0300']]);
});

test('TSV is recognised by its tabs', () => {
  assert.deepEqual(parseDelimited('host\tlabel\n10.0.0.1\tcore'), [['host', 'label'], ['10.0.0.1', 'core']]);
});

test('round trip back to CSV quotes only what needs it', () => {
  const rows = [['a', 'b,c', 'd"e'], ['1', '', 'x\ny']];
  assert.equal(tableToCsv(rows), 'a,"b,c","d""e"\n1,,"x\ny"');
  assert.deepEqual(parseDelimited(tableToCsv(rows)), rows);
});

test('header row becomes object keys; missing cells are empty', () => {
  assert.deepEqual(tableToObjects([['host', 'label'], ['10.0.0.1'], ['10.0.0.2', 'edge']]), [
    { host: '10.0.0.1', label: '' },
    { host: '10.0.0.2', label: 'edge' },
  ]);
});

test('a real .xlsx: first sheet only, dates as yyyy-mm-dd, numbers as text', async () => {
  const buf = readFileSync(new URL('./fixtures/subscribers.xlsx', import.meta.url));
  const file = new File([buf], 'subscribers.xlsx');
  const rows = await readTableFile(file);
  assert.deepEqual(rows[0], ['username', 'full name', 'phone', 'expiry']);
  assert.deepEqual(rows[1], ['ali01', 'Ali Khan', '03001234567', '2026-11-01']);
  assert.deepEqual(rows[2], ['sara, b', 'Sara "B"', '3001112222', '']);
  assert.equal(rows.length, 3);
  // …and it survives the CSV hand-off the import screens use.
  assert.deepEqual(parseDelimited(tableToCsv(rows)), rows);
});

test('old binary .xls is refused with instructions, not mis-read', async () => {
  await assert.rejects(readTableFile(new File([new Uint8Array([0xd0, 0xcf])], 'old.xls')), /save as \.xlsx or CSV/);
});
