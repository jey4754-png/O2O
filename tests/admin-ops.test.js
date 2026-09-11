import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/admin-ops.js';
import { productImageStore, imageResponse, imageDeal, fakeSheet } from './helpers/product-image-store.js';
import { adminStore } from './helpers/admin-store.js';

test('real GAS group cancellation repairs an interrupted multi-row commit and keeps a rejoin receipt', () => {
  const { context, data, dealId, orderId } = adminStore();
  const request = { ...base, adminAssertion: true, action: 'cancel_order', dealId, orderId, expectedVersion: 2 };
  const original = context.applyGroupRepairOperation_;
  let injected = false;
  context.applyGroupRepairOperation_ = (sheets, operation) => {
    if (operation.type === 'order_update' && !injected) { injected = true; throw new Error('injected_disconnect'); }
    return original(sheets, operation);
  };
  assert.equal(context.handleAdminOperation_(request).error, 'injected_disconnect');
  assert.equal(context.getParticipantRecord_(data, dealId, 'member-test').selectedQuantity, 0);
  const retried = context.handleAdminOperation_(request);
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.duplicate, true);
  assert.equal(retried.order.status, 'cancelled');
  assert.equal(context.getGroupRecord_(data, dealId).version, 2);
  assert.equal(context.getParticipantRecord_(data, dealId, 'member-test').version, 3);
  const receipt = context.customerOrderReservationHistory_(data, dealId, 'member-test').at(-1);
  assert.equal(receipt.action, 'admin_cancel_order');
  assert.equal(receipt.result.cancelledQuantity, 2);
  assert.equal(receipt.result.selectedQuantity, 0);
  assert.equal(context.hasActiveBoundGroupOrder_(data, dealId, 'member-test'), false);
  assert.equal(JSON.parse(data.groupHistory.rows.at(-1)[13]).pending, false);
});

test('admin list and order reads sanitize private proofs and use canonical payment state', () => {
  const { context, dealId } = adminStore();
  const list = context.handleAdminOperation_({ ...base, action: 'list', adminAssertion: true });
  assert.equal(list.ok, true, list.error);
  assert.equal(list.deals[0]._ownerCapabilityHash, undefined);
  const orders = context.handleAdminOperation_({ ...base, action: 'orders', dealId, adminAssertion: true });
  assert.equal(orders.ok, true, orders.error);
  assert.equal(orders.orders[0].paymentStatus, 'confirmed');
  assert.equal(orders.orders[0]._customerCapabilityHash, undefined);
});

test('last host order cancellation releases the role without changing recorded money or charging another member', () => {
  const { context, data, dealId, orderId } = adminStore();
  data.groupParticipants.rows[1][3] = 'host';
  data.groups.rows[1][6] = 'member-test';
  data.groups.rows[1][12] = 'member-test';
  const before = JSON.parse(data.customerOrders.rows[1][3]);
  before.total = 1003; before.hostRemainderApplied = 3;
  data.customerOrders.rows[1][3] = JSON.stringify(before);
  const result = context.handleAdminOperation_({ ...base, adminAssertion: true, action: 'cancel_order', dealId, orderId, expectedVersion: 2 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.order.total, 1003);
  assert.equal(result.order.adminReleasedHost, true);
  assert.equal(result.order.refundReviewRequired, true);
  assert.equal(context.getGroupRecord_(data, dealId).hostActorId, '');
  assert.equal(context.getParticipantRecord_(data, dealId, 'member-test').role, 'creator');
});

const base = { action: 'delete', dealId: 'owner-image-quality-regression', actorId: 'operator_admin', expectedVersion: 1, clientMutationId: 'admin-delete-test-001', reason: '잘못 등록된 테스트 상품' };
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
function fixture() {
  const store = productImageStore();
  store.context.repairPendingMerchantDealPublish_ = () => {};
  store.context.findExactRow_ = (_sheet, col, value) => store.publicDeals.rows.findIndex((row) => row[col - 1] === value) + 1;
  store.context.publishPublicDeal_(imageDeal(jpeg), 'a'.repeat(64));
  return store;
}
test('admin delete requires assertion, CAS and reason; tombstone preserves ownership and image with exact retry', () => {
  const { context, publicDeals } = fixture();
  assert.equal(context.handleAdminOperation_(base).error, 'forbidden');
  const request = { ...base, adminAssertion: true };
  assert.equal(context.handleAdminOperation_({ ...request, reason: '' }).error, 'reason_required');
  assert.equal(context.handleAdminOperation_({ ...request, expectedVersion: 0 }).error, 'state_conflict');
  const result = context.handleAdminOperation_(request);
  assert.equal(result.ok, true);
  assert.equal(result.deal.visibility, 'deleted');
  assert.equal(result.deal.publishVersion, 2);
  assert.equal(result.deal._adminMutationHistory, undefined);
  const stored = JSON.parse(publicDeals.rows[1][6]);
  assert.equal(stored._ownerCapabilityHash, 'a'.repeat(64));
  assert.equal(stored.image, jpeg);
  assert.equal(stored._adminMutationHistory[0].reason, base.reason);
  assert.equal(context.handleAdminOperation_(request).duplicate, true);
  assert.equal(context.handleAdminOperation_({ ...request, reason: 'changed' }).error, 'client_mutation_conflict');
});
test('admin image preserves full-quality stored JPEG and cannot overwrite a deleted product', () => {
  const { context } = fixture();
  const request = { ...base, adminAssertion: true, action: 'image', image: jpeg, clientMutationId: 'admin-image-test-001' };
  const result = context.handleAdminOperation_(request);
  assert.equal(result.ok, true);
  assert.equal(result.deal.image, jpeg);
  assert.equal(result.deal.publishVersion, 2);
  assert.equal(context.handleAdminOperation_(request).duplicate, true);
  assert.equal(context.handleAdminOperation_({ ...base, adminAssertion: true, expectedVersion: 2 }).ok, true);
  assert.equal(context.handleAdminOperation_({ ...request, expectedVersion: 3, clientMutationId: 'admin-image-test-002' }).error, 'deal_deleted');
});
test('admin cancellation keeps payment history, does not imply refund, and is idempotent', () => {
  const { context } = fixture();
  const orders = fakeSheet();
  const order = { id: 'order-1700000000001', dealId: base.dealId, type: 'purchase', status: 'new', paymentStatus: 'confirmed',
    paymentConfirmedAt: '2026-09-08T00:00:00Z', quantity: 2, version: 2, paymentVersion: 2,
    _customerCapabilityHash: 'b'.repeat(64), statusHistory: [] };
  orders.rows.push(['time', 'id', 'phone', 'data'], ['', order.id, '', JSON.stringify(order)]);
  context.ensureSheets_ = () => ({ customerOrders: orders });
  context.getCustomerOrderRecord_ = (_sheets, id) => {
    assert.equal(id, order.id);
    return { rowNumber: 2, order: JSON.parse(orders.rows[1][3]) };
  };
  const request = { ...base, adminAssertion: true, action: 'cancel_order', orderId: order.id, expectedVersion: 2 };
  assert.equal(context.handleAdminOperation_({ ...request, dealId: 'owner-wrong' }).error, 'forbidden');
  const result = context.handleAdminOperation_(request);
  assert.equal(result.ok, true);
  assert.equal(result.order.status, 'cancelled');
  assert.equal(result.order.refundReviewRequired, true);
  assert.equal(result.order.paymentStatusBeforeCancellation, 'confirmed');
  assert.equal(result.order.paymentConfirmedAt, order.paymentConfirmedAt);
  assert.equal(result.order.version, 3);
  assert.equal(result.order._lastAdminCancelContract, undefined);
  assert.equal(context.handleAdminOperation_(request).duplicate, true);
  assert.equal(JSON.parse(orders.rows[1][3])._customerCapabilityHash, 'b'.repeat(64));
});
test('admin API may read credentials but rejects forged assertion, wrong PIN/origin/action/image before any admin operation', async () => {
  const envKeys = ['O2O_ADMIN_PIN', 'O2O_DATA_API_ORIGIN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.O2O_ADMIN_PIN = 'test-private-pin';
  process.env.O2O_DATA_API_ORIGIN = '';
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.invalid/admin-test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'private-test-token';
  const originalFetch = globalThis.fetch;
  const collectorRequests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, process.env.GOOGLE_SHEETS_COLLECTOR_URL);
    const body = JSON.parse(options.body);
    collectorRequests.push(body);
    assert.equal(body.action, 'admin_credentials', 'invalid input must not perform any admin operation');
    assert.equal(body.token, 'private-test-token');
    assert.equal(body.adminPin, undefined);
    assert.equal(JSON.stringify(body).includes('test-private-pin'), false);
    if (body.payload.operation === 'read') {
      assert.deepEqual(body.payload, { operation: 'read' });
      return { status: 200, json: async () => ({ ok: true, credential: null }) };
    }
    assert.match(body.payload.clientKey, /^[a-f0-9]{32}$/);
    assert.ok(['rate_begin', 'rate_failure', 'rate_success'].includes(body.payload.operation));
    return { status: 200, json: async () => ({ ok: true, allowed: true,
      ...(body.payload.operation === 'rate_begin' ? { reserved: true } : {}) }) };
  };
  try {
    for (const [body, origin, expected, expectedReads] of [
      [{ ...base, adminAssertion: true }, 'http://localhost:5173', 'invalid_admin_pin', 0],
      [{ ...base, adminPin: 'wrong' }, 'http://localhost:5173', 'invalid_admin_pin', 1],
      [{ ...base, adminPin: 'test-private-pin' }, 'https://attacker.invalid', 'forbidden_origin', 0],
      [{ ...base, adminPin: 'test-private-pin' }, '', 'forbidden_origin', 0],
      [{ ...base, adminPin: 'test-private-pin', action: 'hard_delete' }, 'http://localhost:5173', 'invalid_action', 1],
      [{ ...base, adminPin: 'test-private-pin', action: 'image', image: 'data:image/jpeg;base64,YmFk' }, 'http://localhost:5173', 'invalid_image', 1],
    ]) {
      const beforeReads = collectorRequests.filter((request) => request.payload.operation === 'read').length;
      const response = imageResponse();
      await handler({ method: 'POST', body, headers: { origin } }, response);
      assert.equal(response.body.error, expected);
      assert.equal(collectorRequests.filter((request) => request.payload.operation === 'read').length - beforeReads, expectedReads);
      assert.equal(collectorRequests.filter((request) => request.action === 'admin_operation').length, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test('admin API preserves Retry-After when a remote data API rejects the second shared PIN check', async () => {
  const envKeys = ['O2O_ADMIN_PIN', 'O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN',
    'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    O2O_ADMIN_PIN: 'test-private-pin',
    O2O_DATA_API_ORIGIN: 'https://data.example.test',
    O2O_DATA_API_TOKEN: 'private-data-api-token',
    GOOGLE_SHEETS_COLLECTOR_URL: 'https://collector.example.test',
    GOOGLE_SHEETS_COLLECTOR_TOKEN: 'private-test-token',
  });
  globalThis.fetch = async (url, options) => {
    if (url === process.env.GOOGLE_SHEETS_COLLECTOR_URL) {
      const operation = JSON.parse(options.body).payload.operation;
      const result = operation === 'read' ? { ok: true, credential: null }
        : { ok: true, allowed: true, ...(operation === 'rate_begin' ? { reserved: true } : {}) };
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => result };
    }
    assert.equal(url, 'https://data.example.test/api/admin-ops');
    return {
      status: 429,
      ok: false,
      headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '777' : null },
      json: async () => ({ ok: false, error: 'admin_rate_limited' }),
    };
  };
  try {
    const response = imageResponse();
    await handler({ method: 'POST', headers: { origin: 'https://o2o-ten.vercel.app' },
      body: { action: 'list', actorId: 'operator_admin', adminPin: 'test-private-pin' } }, response);
    assert.equal(response.statusCode, 429);
    assert.equal(response.body.error, 'admin_rate_limited');
    assert.equal(response.headers['Retry-After'], '777');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
