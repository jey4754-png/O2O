import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

export function fakeSheet() {
  const rows = [];
  let columns = 26;
  return {
    rows,
    appendRow(value) { this.getRange(rows.length + 1, 1, 1, value.length).setValues([value]); },
    getLastRow: () => rows.length,
    getMaxColumns: () => columns,
    getMaxRows: () => 1000,
    insertColumnsAfter(_after, count) { columns += count; },
    setFrozenRows() {},
    getRange(row, col, height = 1, width = 1) {
      return {
        getValue: () => rows[row - 1]?.[col - 1] ?? '',
        getValues: () => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => rows[row + y - 1]?.[col + x - 1] ?? '')),
        setValues(values) {
          values.forEach((value, y) => {
            rows[row + y - 1] ||= [];
            value.forEach((cell, x) => {
              if (String(cell).length > 45000) throw new Error('spreadsheet_cell_limit');
              rows[row + y - 1][col + x - 1] = cell;
            });
          });
        },
        createTextFinder(value) {
          let entireCell = false;
          let caseSensitive = false;
          const matches = () => rows.flatMap((cells, index) => {
            if (index < row - 1 || index >= row - 1 + height) return [];
            let cell = String(cells[col - 1] ?? '');
            let needle = String(value);
            if (!caseSensitive) { cell = cell.toLowerCase(); needle = needle.toLowerCase(); }
            return (entireCell ? cell === needle : cell.includes(needle))
              ? [{ getRow: () => index + 1, getValue: () => cells[col - 1] ?? '' }] : [];
          });
          return {
            matchEntireCell(enabled = true) { entireCell = enabled; return this; },
            matchCase(enabled = true) { caseSensitive = enabled; return this; },
            findAll: matches,
            findNext: () => matches()[0] || null,
          };
        },
      };
    },
  };
}

export function productImageStore() {
  const context = {};
  runInNewContext(readFileSync(new URL('../../apps-script/Code.gs', import.meta.url), 'utf8'), context);
  const sheets = new Map();
  context.Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value)).digest()],
  };
  context.SpreadsheetApp = {
    openById: () => ({
      getSheetByName: (name) => sheets.get(name) || null,
      insertSheet(name) { const sheet = fakeSheet(); sheets.set(name, sheet); return sheet; },
    }),
  };
  const publicDeals = fakeSheet();
  publicDeals.rows.push(['time', 'id', 'source', 'region', 'district', 'neighborhood', 'deal']);
  context.ensureSheets_ = () => ({ publicDeals });
  context.acquireScriptLock_ = () => ({ releaseLock() {} });
  context.activeMerchantAllocationsByActor_ = () => ({ total: 0, byActor: {} });
  context.invalidatePublicDealsCache_ = () => {};
  context.json_ = (value) => value;
  return { context, sheets, publicDeals };
}

export function imageResponse() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end(value) { this.body = value; return this; },
  };
}

export function imageDeal(image) {
  return { id: 'owner-image-quality-regression', source: 'merchant', saleType: 'instant', title: 'image quality regression', originalPrice: 10000, discountRate: 0, image, expectedPublishVersion: 0, publishMutationId: 'publish-image-quality-001' };
}
