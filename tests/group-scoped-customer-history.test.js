import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import customerOrdersHandler from '../api/customer-orders.js';
import groupHandler from '../api/group-ops.js';
import { requestCustomerHistory } from '../src/customerHistory.js';
import { customerHistoryStore, historyOrder } from './helpers/customer-history-store.js';
import { imageResponse } from './helpers/product-image-store.js';
import { adminStore } from './helpers/admin-store.js';

const groupId = 'customer-scoped-payment-history';
const otherGroupId = 'customer-unrelated-history';
const phone = '01011112222';
const actorId = 'customer-history-visitor';
const token = 'synthetic-scoped-customer-capability-0001';
const hash = createHash('sha256').update(token).digest('hex');
const fixtureOrder = (suffix, overrides = {}) => historyOrder(String(1700000000000 + suffix), {
  groupId, dealId: groupId, _customerCapabilityHash: hash, ...overrides,
});
const read = (store, requestedGroupId = groupId, requestedHash = hash) => (
  store.context.getCustomerOrdersResponse_(phone, actorId, requestedHash, requestedGroupId)
);

for (const newerInCurrent of [true, false]) {
  test(`a group-scoped read cannot revive a same-id order superseded in another group (current=${newerInCurrent})`, () => {
    const stale = fixtureOrder(101, { version: 1, paymentVersion: 1 });
    const newest = { ...stale, groupId: otherGroupId, dealId: otherGroupId, version: 2, paymentVersion: 2 };
    const store = customerHistoryStore({ current: [newerInCurrent ? newest : stale],
      historic: [newerInCurrent ? stale : newest] });
    const unscoped = read(store, '');
    assert.equal(unscoped.ok, true, unscoped.error);
    assert.equal(unscoped.orders[0].groupId, otherGroupId);
    const scoped = read(store);
    assert.equal(scoped.ok, true, scoped.error);
    assert.deepEqual(scoped.orders, []);
  });

  test(`scope cannot hide a conflicting same-id capability from another group (current=${newerInCurrent})`, () => {
    const mine = fixtureOrder(102);
    const conflicting = { ...mine, groupId: otherGroupId, dealId: otherGroupId,
      _customerCapabilityHash: 'e'.repeat(64), version: 2, paymentVersion: 2 };
    const store = customerHistoryStore({ current: [newerInCurrent ? conflicting : mine],
      historic: [newerInCurrent ? mine : conflicting] });
    assert.deepEqual(read(store, '').orders, []);
    const scoped = read(store);
    assert.equal(scoped.ok, true, scoped.error);
    assert.deepEqual(scoped.orders, []);
  });
}

test('group scope limits expensive projections only after phone, capability, and version verification', () => {
  const mine = fixtureOrder(103);
  const otherGroup = fixtureOrder(104, { groupId: otherGroupId, dealId: otherGroupId });
  const otherPhone = fixtureOrder(105, { customerPhone: '01099990000' });
  const otherKey = fixtureOrder(106, { _customerCapabilityHash: 'e'.repeat(64) });
  const hashless = fixtureOrder(107, { _customerCapabilityHash: '' });
  const store = customerHistoryStore({ current: [mine, otherGroup, otherPhone, otherKey, hashless] });
  const projections = [];
  const original = store.context.projectStoredGroupOrderPayment_;
  store.context.projectStoredGroupOrderPayment_ = (sheets, order, context) => {
    projections.push(order.id);
    return original(sheets, order, context);
  };
  const result = read(store);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.orders.map((item) => item.id), [mine.id]);
  assert.deepEqual(projections, [mine.id]);
  assert.equal(JSON.stringify(result).includes(hash), false);
  assert.deepEqual(read(store, groupId, 'd'.repeat(64)).orders, []);
});

test('adaptive event windows preserve distant cross-group versions, conflicting keys, and exact phone filters', () => {
  const moved = fixtureOrder(120);
  const conflicted = fixtureOrder(121);
  const valid = fixtureOrder(122);
  const historic = Array.from({ length: 2048 }, (_, index) => fixtureOrder(1000 + index, {
    customerPhone: '01099992222',
  }));
  historic[0] = moved;
  historic[100] = conflicted;
  historic[1800] = { ...conflicted, groupId: otherGroupId, dealId: otherGroupId,
    _customerCapabilityHash: 'e'.repeat(64), version: 2 };
  historic[2047] = { ...moved, groupId: otherGroupId, dealId: otherGroupId, version: 3 };
  const store = customerHistoryStore({ current: [moved, conflicted, valid], historic });
  const before = JSON.stringify([store.currentRows, store.eventRows]);
  const scoped = read(store);
  assert.equal(scoped.ok, true, scoped.error);
  assert.deepEqual(scoped.orders.map((order) => order.id), [valid.id]);
  const unscoped = read(store, '');
  assert.equal(unscoped.ok, true, unscoped.error);
  assert.deepEqual(unscoped.orders.map((order) => order.id).sort(), [moved.id, valid.id].sort());
  assert.equal(unscoped.orders.find((order) => order.id === moved.id).groupId, otherGroupId);
  assert.equal(JSON.stringify([store.currentRows, store.eventRows]), before);
  assert.equal(JSON.stringify([scoped, unscoped]).includes(hash), false);
});

test('customer history filters phone matches without a second full event-name scan', () => {
  const mine = fixtureOrder(123);
  const store = customerHistoryStore({ current: [mine], historic: [mine] });
  const originalGetRange = store.data.events.getRange.bind(store.data.events);
  let globalEventNameFinders = 0;
  store.data.events.getRange = (row, column, height, width) => {
    const range = originalGetRange(row, column, height, width);
    const originalCreateTextFinder = range.createTextFinder.bind(range);
    range.createTextFinder = (value) => {
      if (column === 7 && row === 2 && height === store.eventRows.length - 1) {
        globalEventNameFinders += 1;
      }
      return originalCreateTextFinder(value);
    };
    return range;
  };
  const result = read(store, '');
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.orders.map((order) => order.id), [mine.id]);
  assert.equal(globalEventNameFinders, 0);
});

for (const proxied of [false, true]) {
  test(`browser → customer API → scoped collector read preserves capability proof (proxy=${proxied})`, async () => {
    const store = customerHistoryStore({ current: [fixtureOrder(108), fixtureOrder(109, {
      groupId: otherGroupId, dealId: otherGroupId,
    })] });
    const envKeys = ['O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const previousFetch = globalThis.fetch;
    process.env.O2O_DATA_API_ORIGIN = proxied ? 'https://scoped-history-proxy.example.test' : '';
    process.env.O2O_DATA_API_TOKEN = 'synthetic-proxy-token';
    process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://scoped-history-collector.example.test';
    process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'synthetic-collector-token';
    const forwarded = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      forwarded.push(body);
      assert.equal(body.action, proxied ? 'list' : 'customer_orders');
      assert.equal(body.groupId, groupId);
      assert.equal(body.customerCapabilityHash, hash);
      assert.equal(body.visitorId, actorId);
      assert.equal(body.customerCapabilityToken, undefined);
      assert.equal(options.body.includes(token), false);
      assert.ok(String(url).includes(proxied ? 'scoped-history-proxy' : 'scoped-history-collector'));
      const result = store.context.getCustomerOrdersResponse_(body.phone, body.visitorId,
        body.customerCapabilityHash, body.groupId);
      return { ok: true, status: 200, json: async () => result };
    };
    try {
      const orders = await requestCustomerHistory({ phone, visitorId: actorId,
        customerCapabilityToken: token, groupId }, {
        fetchImpl: async (_url, options) => {
          const response = imageResponse();
          await customerOrdersHandler({ method: 'POST', headers: { origin: 'http://localhost:5173' },
            body: JSON.parse(options.body) }, response);
          return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.body };
        },
      });
      assert.deepEqual(orders.map((item) => item.groupId), [groupId]);
      assert.equal(forwarded.length, 1);
      for (const invalid of [
        { groupId: 'invalid group id' },
        { groupId, customerCapabilityToken: '' },
      ]) {
        const response = imageResponse();
        await customerOrdersHandler({ method: 'POST', headers: { origin: 'http://localhost:5173' },
          body: { action: 'list', phone, visitorId: actorId, customerCapabilityToken: token, ...invalid } }, response);
        assert.ok(response.statusCode >= 400);
      }
      assert.equal(forwarded.length, 1, 'scope never bypasses input or capability validation');
    } finally {
      globalThis.fetch = previousFetch;
      for (const key of envKeys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    }
  });
}

test('a claimed local sync acknowledgement cannot replace the server order binding during payment', async () => {
  const { context, data, dealId } = adminStore();
  data.customerOrders.rows.splice(1);
  const deal = JSON.parse(data.publicDeals.rows[1][6]);
  Object.assign(deal, { saleType: 'group', originalPrice: 10000 });
  data.publicDeals.rows[1][6] = JSON.stringify(deal);
  data.groupParticipants.rows[1][5] = 'pending';
  const groupToken = 'synthetic-group-payment-capability-0001';
  data.groupParticipants.rows[1][7] = createHash('sha256').update(groupToken).digest('hex');
  const envKeys = ['O2O_DATA_API_ORIGIN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  process.env.O2O_DATA_API_ORIGIN = '';
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://payment-binding-collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'synthetic-collector-token';
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.action, 'group_transition_payment');
    assert.equal(body.payload.syncedOrderFingerprints, undefined);
    assert.equal(body.payload.order, undefined);
    const result = context.handleGroupOperation_('transition_payment', body.payload);
    return { ok: true, status: 200, json: async () => result };
  };
  try {
    const response = imageResponse();
    await groupHandler({ method: 'POST', headers: { origin: 'http://localhost:5173' }, body: {
      action: 'transition_payment', groupId: dealId, actorId: 'member-test',
      participantActorId: 'member-test', capabilityToken: groupToken,
      direction: 'next', fromStatus: 'pending', toStatus: 'requested', expectedVersion: 2,
      clientMutationId: 'synthetic-forged-local-ack',
      syncedOrderFingerprints: { 'order-1700000000001': 'claimed-local-ack' },
      order: { id: 'order-1700000000001', groupId: dealId, syncedAt: '2026-09-10T09:04:00Z' },
    } }, response);
    assert.equal(calls, 1);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, 'order_payment_link_required');
    assert.equal(context.getParticipantRecord_(data, dealId, 'member-test').paymentStatus, 'pending');
    assert.equal(data.customerOrders.rows.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
