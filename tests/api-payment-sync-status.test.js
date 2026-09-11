import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { normalizedOrders } from '../api/customer-orders.js';

function order(overrides = {}) {
  return {
    id: 'order-1700000000001', type: 'group', dealId: 'customer-sync-status',
    groupId: 'customer-sync-status', visitorId: 'visitor-sync-status',
    participantActorId: 'visitor-sync-status', customerPhone: '01000000000',
    selectedCount: 1, quantity: 1, unitPrice: 1000, total: 1000,
    version: 1, paymentVersion: 1, paymentStatus: 'pending',
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function invoke(body) {
  const response = responseRecorder();
  await handler({ method: 'POST', headers: { origin: 'http://localhost:5173' }, body }, response);
  return response;
}

async function withUpstream(proxied, run) {
  const keys = ['O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN',
    'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'synthetic-collector-token';
  process.env.O2O_DATA_API_TOKEN = 'synthetic-proxy-token';
  if (proxied) process.env.O2O_DATA_API_ORIGIN = 'https://proxy.example.test';
  else delete process.env.O2O_DATA_API_ORIGIN;
  try { await run(); } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('read normalization retains only exact server payment-sync enum values and no private proof', () => {
  for (const value of ['repair_required', 'verified_history', 'confirmed', 'verified_history ', '',
    ['verified_history'], { status: 'verified_history' }, true, null, undefined]) {
    const [normalized] = normalizedOrders([order({
      paymentSyncStatus: value, _customerCapabilityHash: 'a'.repeat(64),
      _reservationMutationId: 'private-reservation-test',
    })]);
    assert.equal(Object.hasOwn(normalized, 'paymentSyncStatus'),
      ['repair_required', 'verified_history'].includes(value));
    if (Object.hasOwn(normalized, 'paymentSyncStatus')) assert.equal(normalized.paymentSyncStatus, value);
    assert.equal(normalized._customerCapabilityHash, undefined);
    assert.equal(normalized._reservationMutationId, undefined);
  }
  const [latest] = normalizedOrders([
    order({ version: 2, paymentVersion: 2 }),
    order({ paymentSyncStatus: 'repair_required' }),
  ]);
  assert.equal(latest.version, 2);
  assert.equal(Object.hasOwn(latest, 'paymentSyncStatus'), false);
});

for (const proxied of [false, true]) {
  test(`all authenticated order-list routes preserve upstream payment-sync diagnostics (proxy=${proxied})`, async () => {
    await withUpstream(proxied, async () => {
      const requests = [];
      globalThis.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, status: 200, async json() {
          return { ok: true, orders: [
            order({ paymentSyncStatus: 'repair_required' }),
            order({ id: 'order-1700000000002', paymentSyncStatus: 'verified_history' }),
            order({ id: 'order-1700000000003', paymentSyncStatus: 'untrusted-value' }),
          ] };
        } };
      };
      for (const body of [
        { action: 'list', phone: '01000000000', visitorId: 'visitor-sync-status',
          customerCapabilityToken: 'c'.repeat(64) },
        { action: 'list_owner', ownerClaims: [{ dealId: 'owner-sync-status', capabilityToken: 'o'.repeat(64) }] },
        { action: 'list_group', groupId: 'customer-sync-status', actorId: 'visitor-sync-status',
          capabilityToken: 'p'.repeat(64) },
      ]) {
        const response = await invoke(body);
        assert.equal(response.statusCode, 200, response.body.error);
        assert.deepEqual(response.body.orders.map((item) => item.paymentSyncStatus),
          ['repair_required', 'verified_history', undefined]);
        assert.equal(response.headers['Cache-Control'], 'private, no-store');
      }
      assert.equal(requests.length, 3);
      assert.equal(requests.every((request) => String(request.url).startsWith(proxied
        ? 'https://proxy.example.test' : 'https://collector.example.test')), true);
    });
  });

  test(`publication never forwards or returns caller-supplied payment-sync diagnostics (proxy=${proxied})`, async () => {
    await withUpstream(proxied, async () => {
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return { ok: true, status: 200, async json() {
          return { ok: true, legacyEventStored: true,
            order: { ...body.order, paymentSyncStatus: 'verified_history' } };
        } };
      };
      for (const paymentSyncStatus of ['verified_history', 'repair_required']) {
        const response = await invoke({ action: 'publish', visitorId: 'visitor-sync-status',
          customerCapabilityToken: 'c'.repeat(64), participantCapabilityToken: 'p'.repeat(64),
          paymentSyncStatus, order: order({ paymentSyncStatus }) });
        assert.equal(response.statusCode, 202, response.body.error);
        assert.equal(Object.hasOwn(response.body.order, 'paymentSyncStatus'), false);
      }
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(Object.hasOwn(request, 'paymentSyncStatus'), false);
        assert.equal(Object.hasOwn(request.order, 'paymentSyncStatus'), false);
      }
    });
  });
}
