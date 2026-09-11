import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import customerOrdersHandler from '../api/customer-orders.js';

const OWNER_HASH = 'a'.repeat(64);
const OWNED_ID = 'owner-history-owned';

function order(id, overrides = {}) {
  return {
    id: `order-${id}`,
    dealId: OWNED_ID,
    type: 'purchase',
    status: 'new',
    paymentStatus: 'pending',
    customerName: 'Synthetic customer',
    customerPhone: '01000000001',
    visitorId: 'synthetic-visitor',
    title: 'Synthetic product',
    selectedCount: 1,
    total: 2000,
    createdAt: '2026-08-27T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function snapshotRow(value, event = 'customer_order_snapshot') {
  const row = Array(16).fill('');
  row[6] = event;
  row[11] = JSON.stringify({ order_snapshot: JSON.stringify(value) });
  row[13] = value.customerPhone || '';
  return row;
}

function readOnlySheet(rows, searches = []) {
  return {
    getLastRow: () => rows.length,
    getRange(row, column, height = 1, width = 1) {
      return {
        getValues: () => rows.slice(row - 1, row - 1 + height)
          .map((value) => Array.from({ length: width }, (_, index) => value[column - 1 + index] ?? '')),
        createTextFinder(value) {
          searches.push(String(value));
          let entireCell = false;
          return {
            matchCase() { return this; },
            matchEntireCell(enabled = true) { entireCell = enabled; return this; },
            findAll: () => rows.slice(row - 1, row - 1 + height).flatMap((entry, index) => (
              (entireCell ? String(entry[column - 1] || '') === String(value)
                : String(entry[column - 1] || '').includes(String(value)))
                ? [{ getRow: () => row + index }]
                : []
            )),
          };
        },
        setValue() { throw new Error('unexpected_write'); },
        setValues() { throw new Error('unexpected_write'); },
      };
    },
    appendRow() { throw new Error('unexpected_write'); },
    deleteRow() { throw new Error('unexpected_write'); },
  };
}

function fixture({ current = [], historic = [], extraEvents = [], deals } = {}) {
  const context = {};
  runInNewContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), context);
  const searches = [];
  const eventRows = [Array(16).fill('header'), ...historic.map((value) => snapshotRow(value)), ...extraEvents];
  const records = deals || {
    [OWNED_ID]: { id: OWNED_ID, source: 'merchant', _ownerCapabilityHash: OWNER_HASH },
  };
  const publicDealRows = [Array(7).fill('header'), ...Object.values(records).map((deal) => {
    const row = Array(7).fill('');
    row[6] = JSON.stringify(deal);
    return row;
  })];
  const sheets = {
    publicDeals: readOnlySheet(publicDealRows, searches),
    customerOrders: readOnlySheet([['id', 'phone', 'updated', 'snapshot'], ...current.map((value) => [value.id, '', '', JSON.stringify(value)])]),
    events: readOnlySheet(eventRows, searches),
  };
  context.ensureSheets_ = () => sheets;
  context.json_ = (value) => JSON.parse(JSON.stringify(value));
  return {
    context,
    searches,
    read: (claims = [{ dealId: OWNED_ID, ownerCapabilityHash: OWNER_HASH }]) => context.getOwnerCustomerOrdersResponse_(claims),
  };
}

test('owner history includes event-only orders as well as current rows without writing or returning private proof', () => {
  const f = fixture({
    current: [order('1234567890101', { createdAt: '2026-09-09T00:00:00.000Z' })],
    historic: [order('1234567890100', { _customerCapabilityHash: 'c'.repeat(64), _reservationMutationId: 'private-mutation' })],
  });
  const result = f.read();
  assert.equal(result.ok, true);
  assert.deepEqual(result.orders.map((item) => item.id), ['order-1234567890101', 'order-1234567890100']);
  assert.equal(result.orders[1]._customerCapabilityHash, undefined);
  assert.equal(result.orders[1]._reservationMutationId, undefined);
  assert.deepEqual(f.searches, ['customer_order_snapshot']);
});

test('owner history selects canonical versions rather than rolling payment or cancellation back to older events', () => {
  const paid = order('1234567890102', { version: 3, paymentVersion: 4, paymentStatus: 'paid' });
  const cancelled = order('1234567890103', { version: 3, status: 'cancelled' });
  const f = fixture({
    current: [paid, cancelled, order('1234567890104')],
    historic: [
      { ...paid, version: 2, paymentVersion: 2, paymentStatus: 'pending', statusUpdatedAt: '2099-01-01T00:00:00.000Z' },
      { ...cancelled, version: 2, status: 'new', statusUpdatedAt: '2099-01-01T00:00:00.000Z' },
      order('1234567890104', { version: 2, status: 'confirmed' }),
    ],
  });
  const result = f.read();
  assert.equal(result.ok, true);
  assert.equal(result.orders.length, 3);
  assert.equal(result.orders.find((item) => item.id === paid.id).paymentStatus, 'paid');
  assert.equal(result.orders.find((item) => item.id === cancelled.id).status, 'cancelled');
  assert.equal(result.orders.find((item) => item.id === 'order-1234567890104').status, 'confirmed');
});

test('owner history queries only verified products and exact-matches event product IDs, including nested legacy IDs', () => {
  const otherId = `${OWNED_ID}-other`;
  const f = fixture({
    historic: [
      order('1234567890105', { dealId: undefined, deal: { id: OWNED_ID } }),
      order('1234567890106', { dealId: otherId, customerPhone: '01099999999' }),
    ],
    deals: {
      [OWNED_ID]: { id: OWNED_ID, source: 'merchant', _ownerCapabilityHash: OWNER_HASH },
      [otherId]: { id: otherId, source: 'merchant', _ownerCapabilityHash: 'b'.repeat(64) },
    },
  });
  const result = f.read([
    { dealId: OWNED_ID, ownerCapabilityHash: OWNER_HASH },
    { dealId: otherId, ownerCapabilityHash: OWNER_HASH },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.orders.map((item) => item.id), ['order-1234567890105']);
  assert.doesNotMatch(JSON.stringify(result), /01099999999/);
  assert.deepEqual(f.searches, ['customer_order_snapshot']);
});

test('owner history keeps Spreadsheet searches bounded when many verified products are claimed', () => {
  const claims = [];
  const deals = {};
  const historic = [];
  for (let index = 0; index < 50; index += 1) {
    const dealId = `owner-history-batch-${index}`;
    const capabilityHash = String(index % 10).repeat(64);
    claims.push({ dealId, ownerCapabilityHash: capabilityHash });
    deals[dealId] = { id: dealId, source: 'merchant', _ownerCapabilityHash: capabilityHash };
    historic.push(order(String(1234567890200 + index), { dealId }));
  }
  const f = fixture({ deals, historic });
  const result = f.read(claims);
  assert.equal(result.ok, true);
  assert.equal(result.orders.length, 50);
  assert.deepEqual(f.searches, ['customer_order_snapshot']);
});

test('owner history cannot expose stale snapshots when a newer canonical row belongs to an unverified product', () => {
  const old = order('1234567890107');
  const f = fixture({
    current: [{ ...old, dealId: 'owner-unverified-product', version: 2 }],
    historic: [old],
  });
  assert.deepEqual(f.read(), { ok: true, orders: [] });
});

test('owner history never uses phone or legacy hashless products as ownership proof', () => {
  const f = fixture({
    historic: [order('1234567890108')],
    deals: {
      [OWNED_ID]: { id: OWNED_ID, source: 'merchant', ownerPhone: '01000000001' },
      'owner-customer-source': { id: 'owner-customer-source', source: 'customer', _ownerCapabilityHash: OWNER_HASH },
    },
  });
  const result = f.read([
    { dealId: OWNED_ID, ownerCapabilityHash: OWNER_HASH },
    { dealId: 'owner-customer-source', ownerCapabilityHash: OWNER_HASH },
    { dealId: 'owner-no-record', ownerCapabilityHash: OWNER_HASH },
  ]);
  assert.deepEqual(result, { ok: true, orders: [] });
  assert.deepEqual(f.searches, []);
});

test('owner history preserves deleted-product order history and projects payment for historical rows', () => {
  const f = fixture({
    historic: [order('1234567890109')],
    deals: {
      [OWNED_ID]: { id: OWNED_ID, source: 'merchant', deletedAt: '2026-09-08T00:00:00.000Z', _ownerCapabilityHash: OWNER_HASH },
    },
  });
  const projected = [];
  f.context.projectStoredGroupOrderPayment_ = (_sheets, value) => {
    projected.push(value.id);
    return { ...value, paymentStatus: 'paid', paymentVersion: 2 };
  };
  const result = f.read();
  assert.equal(result.ok, true);
  assert.deepEqual(projected, ['order-1234567890109']);
  assert.equal(result.orders[0].paymentStatus, 'paid');
});

test('owner history ignores unrelated or corrupt event rows but reports event-store failures', () => {
  const invalid = snapshotRow(order('1234567890110'));
  invalid[11] = `${OWNED_ID} corrupt JSON`;
  const f = fixture({
    historic: [order('1234567890111')],
    extraEvents: [invalid, snapshotRow(order('1234567890112'), 'unrelated_event'),
      snapshotRow(order('1234567890114'), 'customer_order_snapshot_debug')],
  });
  assert.deepEqual(f.read().orders.map((item) => item.id), ['order-1234567890111']);
  f.context.historicCustomerOrdersForDeals_ = () => { throw new Error('synthetic_read_failure'); };
  assert.deepEqual(f.read(), { ok: false, error: 'owner_orders_failed' });
});

test('owner orders API returns event-only history through hashed-capability collector authorization', async () => {
  const token = 'synthetic-owner-capability-token-for-history-test';
  const hash = createHash('sha256').update(token).digest('hex');
  const f = fixture({
    historic: [order('1234567890113', { _customerCapabilityHash: 'd'.repeat(64) })],
    deals: { [OWNED_ID]: { id: OWNED_ID, source: 'merchant', _ownerCapabilityHash: hash } },
  });
  const keys = ['GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN', 'O2O_DATA_API_ORIGIN'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'synthetic-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const response = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  try {
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.action, 'customer_orders_owner');
      assert.equal(request.ownerClaims[0].ownerCapabilityHash, hash);
      assert.equal(request.ownerClaims[0].capabilityToken, undefined);
      assert.equal(options.body.includes(token), false);
      return { ok: true, status: 200, json: async () => f.read(request.ownerClaims) };
    };
    await customerOrdersHandler({
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
      body: { action: 'list_owner', capabilities: [{ dealId: OWNED_ID, capabilityToken: token }] },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.orders.map((item) => item.id), ['order-1234567890113']);
    assert.equal(response.body.orders[0]._customerCapabilityHash, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    previous.forEach((value, key) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
