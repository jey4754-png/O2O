import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fakeSheet } from './helpers/product-image-store.js';

const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
test('profile ingestion reads only matching rows and never rewrites existing data in a 20,000-row sheet', () => {
  const context = {};
  runInNewContext(source, context);
  const events = fakeSheet();
  events.rows.push(Array(15).fill('header'));
  for (let i = 0; i < 20000; i++) {
    const row = Array(15).fill('');
    row[4] = `visitor-${i}`;
    row[13] = '01000000000';
    events.rows.push(row);
  }
  events.rows[100][4] = 'matching-visitor';
  events.rows[100][2] = 'existing name';
  events.rows[100][13] = '';
  events.rows[200][4] = 'matching-visitor';
  const before = JSON.stringify(events.rows);
  let readCells = 0;
  const writes = [];
  const original = events.getRange.bind(events);
  events.getRange = (row, col, height = 1, width = 1) => {
    const range = original(row, col, height, width);
    return {
      ...range,
      getValues() { readCells += height * width; return range.getValues(); },
      setValues(values) { writes.push({ row, col, height, width }); return range.setValues(values); },
    };
  };
  context.backfillVisitorProfile_(events, 'matching-visitor', {
    tester_name: 'new name', customer_phone: '01011112222', tester_type: '사용자',
  });
  assert.equal(readCells, 30);
  assert.ok(writes.length > 0);
  assert.ok(writes.every(({ row, height, width }) => [101, 201].includes(row) && height === 1 && width === 1));
  assert.equal(events.rows[100][2], 'existing name');
  assert.equal(events.rows[100][13], "'01011112222");
  assert.equal(events.rows[200][13], '01000000000');
  const prior = JSON.parse(before);
  events.rows.forEach((row, index) => {
    if (![100, 200].includes(index)) assert.deepEqual(row, prior[index]);
  });
  writes.length = 0;
  context.backfillVisitorProfile_(events, 'matching-visitor', {
    tester_name: 'new name', customer_phone: '01011112222', tester_type: '사용자',
  });
  assert.equal(writes.length, 0, 'repeated ingestion must not write unchanged cells');
});

test('concurrent first reads recover when another request creates each required sheet', () => {
  const context = {};
  runInNewContext(source, context);
  const sheets = new Map();
  context.SpreadsheetApp = { openById: () => ({
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet(name) {
      const sheet = fakeSheet();
      sheet.getLastColumn = () => sheet.rows[0]?.length || 0;
      sheets.set(name, sheet);
      throw new Error('already exists');
    },
  }) };
  const result = context.ensureSheets_();
  assert.equal(Object.keys(result).length, 10);
  assert.equal(sheets.size, 10);
  assert.equal(result.events.rows.length, 1);
  assert.equal(result.groupHistory.rows.length, 1);
});
