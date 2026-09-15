import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import customerOrdersHandler, { normalizedOrders } from '../api/customer-orders.js';
import { mergeAuthoritativeCustomerOrderRefresh } from '../src/orderMerge.js';
import {
  customerOrderSyncFingerprint,
  customerOrderWriteContent,
  requestCustomerHistory,
} from '../src/customerHistory.js';
import { customerHistoryStore, historyOrder } from './helpers/customer-history-store.js';
import { imageResponse } from './helpers/product-image-store.js';

const token = 'synthetic-customer-history-capability-0001';
const hash = createHash('sha256').update(token).digest('hex');
const proof = { phone: '01011112222', visitorId: 'customer-history-visitor', customerCapabilityToken: token };

test('payment projection hints are omitted from publish content without mutating the read snapshot', () => {
  const order = { id: 'order-1234567890300', paymentSyncStatus: 'repair_required', paymentStatus: 'pending', version: 2 };
  assert.deepEqual(customerOrderWriteContent(order), { id: order.id, paymentStatus: 'pending', version: 2 });
  assert.equal(order.paymentSyncStatus, 'repair_required');
  assert.deepEqual(customerOrderWriteContent({ ...order, paymentSyncStatus: 'verified_history' }), customerOrderWriteContent(order));
});

test('a compact central read does not requeue an already accepted rich local order snapshot', () => {
  const central = historyOrder('1234567890399', {
    groupId: 'customer-history-fingerprint',
    dealId: 'customer-history-fingerprint',
    participantActorId: 'customer-history-visitor',
    reservationMutationId: 'history-fingerprint-reservation',
    deal: {
      id: 'customer-history-fingerprint',
      title: '중앙 주문 상품',
      store: '중앙 매장',
      region: '서울',
      district: '강남구',
      neighborhood: '역삼동',
    },
  });
  const locallyMerged = {
    ...central,
    syncedAt: '2026-09-10T02:37:27.000Z',
    clientMutationId: central.reservationMutationId,
    paymentSyncStatus: 'verified_history',
    deal: {
      ...central.deal,
      source: 'customer',
      saleType: 'community',
      image: 'data:image/webp;base64,local-preview',
      originalPrice: 10000,
    },
  };

  assert.equal(
    customerOrderSyncFingerprint(locallyMerged),
    customerOrderSyncFingerprint(central),
  );
  assert.notEqual(
    customerOrderSyncFingerprint({ ...locallyMerged, selectedCount: 2, quantity: 2 }),
    customerOrderSyncFingerprint(central),
  );
});

test('a real normalized central order and its local merge have the same sync fingerprint', () => {
  const local = { type: 'purchase', ...historyOrder('1234567890398'),
    localDisplayState: 'expanded', updatedAt: '2026-09-10T00:00:00.000Z' };
  const central = normalizedOrders([local])[0];
  const [merged] = mergeAuthoritativeCustomerOrderRefresh([local], [central]);
  assert.notDeepEqual(Object.keys(merged), Object.keys(central), 'reproduces actual merge key order');
  assert.equal(customerOrderSyncFingerprint(merged), customerOrderSyncFingerprint(central));
});

test('fingerprints ignore object key order and undefined metadata while preserving meaningful changes', () => {
  const original = { id: 'order-1234567890397', type: 'purchase', quantity: 1,
    paymentStatus: 'pending', statusHistory: [{ action: 'created', version: 1 }],
    deal: { id: 'owner-fingerprint', title: '합성 상품' } };
  const reordered = { deal: { title: '합성 상품', id: 'owner-fingerprint' },
    statusHistory: [{ version: 1, action: 'created', optional: undefined }],
    paymentStatus: 'pending', quantity: 1, type: 'purchase', id: original.id,
    syncedAt: '2026-09-10', localOnly: undefined };
  assert.equal(customerOrderSyncFingerprint(original), customerOrderSyncFingerprint(reordered));
  for (const changed of [{ quantity: 2 }, { paymentStatus: 'requested' },
    { statusHistory: [{ action: 'requested', version: 2 }] },
    { deal: { ...original.deal, title: '변경 상품' } }]) {
    assert.notEqual(customerOrderSyncFingerprint(original), customerOrderSyncFingerprint({ ...original, ...changed }));
  }
});

test('fingerprints treat formatted and normalized customer phone numbers as the same order', () => {
  const order = {
    id: 'order-1234567890396',
    customerPhone: '010-1234-5678',
    paymentStatus: 'pending',
    deal: { id: 'phone-normalization', title: '전화번호 정규화 검수' },
  };
  assert.equal(
    customerOrderSyncFingerprint(order),
    customerOrderSyncFingerprint({ ...order, customerPhone: '01012345678' }),
  );
});

test('customer browser read → real API → GAS returns only phone/key-authorized current and event history', async () => {
  const current = historyOrder('1234567890301', { _customerCapabilityHash: hash });
  const historic = historyOrder('1234567890302', { _customerCapabilityHash: hash });
  const store = customerHistoryStore({ current: [current,
    historyOrder('1234567890303'),
    historyOrder('1234567890304', { _customerCapabilityHash: 'b'.repeat(64) }),
    historyOrder('1234567890305', { customerPhone: '01033334444', _customerCapabilityHash: hash }),
  ], historic: [historic] });
  const keys = ['O2O_DATA_API_ORIGIN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, { O2O_DATA_API_ORIGIN: '', GOOGLE_SHEETS_COLLECTOR_URL: 'https://collector.example.test',
    GOOGLE_SHEETS_COLLECTOR_TOKEN: 'synthetic-token' });
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.action, 'customer_orders');
      assert.equal(body.customerCapabilityHash, hash);
      assert.equal(body.customerCapabilityToken, undefined);
      assert.equal(options.body.includes(token), false);
      const result = store.context.getCustomerOrdersResponse_(body.phone, body.visitorId, body.customerCapabilityHash);
      return { ok: true, status: 200, json: async () => result };
    };
    const orders = await requestCustomerHistory(proof, { fetchImpl: async (_url, options) => {
      const response = imageResponse();
      await customerOrdersHandler({ method: 'POST', headers: { origin: 'http://localhost:5173' },
        body: JSON.parse(options.body) }, response);
      return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.body };
    } });
    assert.deepEqual(orders.map((order) => order.id).sort(), [current.id, historic.id].sort());
    assert.equal(JSON.stringify(orders).includes(hash), false);
    assert.equal(store.currentRows.length, 5, 'read does not migrate or recreate missing ownership');
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test('customer history HTTP, malformed JSON, and malformed result failures never become empty successes', async () => {
  for (const response of [
    { ok: false, status: 503, json: async () => ({ ok: false, error: 'collector_unavailable' }) },
    { ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } },
    { ok: true, status: 200, json: async () => ({ ok: true }) },
  ]) {
    await assert.rejects(requestCustomerHistory(proof, { fetchImpl: async () => response }),
      (error) => Boolean(error.code));
  }
});

test('customer history accepts a genuine authorized empty response without claiming legacy recovery', async () => {
  assert.deepEqual(await requestCustomerHistory(proof, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, orders: [] }) }),
  }), []);
});

test('customer history reads have a bounded timeout and respect a cancelled profile request', async () => {
  const hangingFetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(requestCustomerHistory(proof, { fetchImpl: hangingFetch, timeoutMs: 5 }), /customer_history_timeout/);
  const controller = new AbortController();
  const pending = requestCustomerHistory(proof, { fetchImpl: hangingFetch, signal: controller.signal });
  controller.abort(new Error('profile_changed'));
  await assert.rejects(pending, /profile_changed/);
});

test('history timeout after successful response headers preserves the timeout cause', async () => {
  await assert.rejects(requestCustomerHistory(proof, {
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }),
  }), (error) => error.code === 'customer_history_timeout');
});

test('a cancelled profile read cannot return a late successful response body', async () => {
  const controller = new AbortController();
  await assert.rejects(requestCustomerHistory(proof, {
    signal: controller.signal,
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => {
        controller.abort(new Error('profile_changed'));
        return { ok: true, orders: [historyOrder('1234567890396')] };
      },
    }),
  }), /profile_changed/);
});
