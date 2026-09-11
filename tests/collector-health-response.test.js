import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUpstreamJson } from '../api/_data-upstream.js';
import customerOrdersHandler from '../api/customer-orders.js';
import groupOpsHandler from '../api/group-ops.js';
import { readAdminCredential } from '../api/_admin-auth.js';

const health = { ok: true, service: 'UPTWOYOU collector' };
const groupId = 'customer-health-response-test';
const actorId = 'visitor-health-response-test';
const capabilityToken = 'synthetic-health-proof-'.repeat(3);
const order = {
  id: 'order-1700000000001', groupId, dealId: groupId, visitorId: actorId,
  participantActorId: actorId, customerPhone: '01011112222', type: 'group',
  status: 'new', paymentStatus: 'pending', quantity: 1, selectedCount: 1,
  total: 1000, unitPrice: 1000, version: 1, paymentVersion: 1,
  reservationMutationId: 'synthetic-health-reservation', reservationAction: 'create',
  reservationQuantity: 1, publishMutationId: 'synthetic-health-order-publication',
};

async function invoke(handler, body) {
  const response = {
    statusCode: 200, body: null,
    setHeader() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({ method: 'POST', headers: { origin: 'http://localhost:5173' }, body }, response);
  return response;
}

async function withHealthCollector(proxy, run) {
  const keys = ['O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN',
    'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  process.env.O2O_DATA_API_ORIGIN = proxy ? 'https://health-proxy.example.test' : '';
  process.env.O2O_DATA_API_TOKEN = proxy ? 'synthetic-data-token' : '';
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://health-collector.example.test/exec';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'synthetic-collector-token';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ...health }) };
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('collector GET health is not a valid POST operation result and is never automatically reposted', async () => {
  await withHealthCollector(false, async (calls) => {
    for (const method of ['POST', 'post']) {
      await assert.rejects(fetchUpstreamJson('https://health-collector.example.test/exec', { method }),
        (error) => error.code === 'upstream_invalid_response' && error.status === 502);
    }
    assert.equal(calls.length, 2);
    const result = await fetchUpstreamJson('https://health-collector.example.test/exec');
    assert.deepEqual(result.result, health, 'an intentional GET health read remains available');
    assert.equal(calls.length, 3);
  });
});

const customerRequests = [
  { action: 'list', phone: order.customerPhone, visitorId: actorId, customerCapabilityToken: capabilityToken },
  { action: 'list_owner', ownerClaims: [{ dealId: 'owner-health-response-test', capabilityToken }] },
  { action: 'list_group', groupId, dealId: groupId, actorId, capabilityToken },
  { action: 'publish', order, visitorId: actorId, customerCapabilityToken: capabilityToken,
    participantCapabilityToken: capabilityToken },
  { action: 'manage', orderId: order.id, dealId: groupId, managerType: 'group_manager',
    kind: 'payment_status', direction: 'next', expectedVersion: 1,
    clientMutationId: 'synthetic-health-manage', actorId, capabilityToken },
];
const groupRequests = [
  { action: 'snapshot', groupId, actorId, capabilityToken },
  { action: 'transition_payment', groupId, actorId, participantActorId: actorId, capabilityToken,
    fromStatus: 'pending', toStatus: 'requested', direction: 'next', expectedVersion: 1,
    clientMutationId: 'synthetic-health-payment' },
];

for (const proxy of [false, true]) {
  for (const body of customerRequests) {
    test(`customer ${body.action} rejects health instead of an empty list or claimed saved order (proxy=${proxy})`, async () => {
      await withHealthCollector(proxy, async (calls) => {
        const response = await invoke(customerOrdersHandler, body);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(response.body, { ok: false, error: 'upstream_invalid_response' });
        assert.equal(calls.length, 1, 'invalid publication must not trigger a legacy snapshot event');
        assert.match(calls[0].url, proxy ? /health-proxy/ : /health-collector/);
      });
    });
  }
  for (const body of groupRequests) {
    test(`group ${body.action} rejects health instead of acknowledging a snapshot or payment (proxy=${proxy})`, async () => {
      await withHealthCollector(proxy, async (calls) => {
        const response = await invoke(groupOpsHandler, body);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(response.body, { ok: false, error: 'upstream_invalid_response' });
        assert.equal(calls.length, 1);
      });
    });
  }
}

test('a collector health response cannot be used as an empty administrator credential store', async () => {
  await withHealthCollector(false, async () => {
    await assert.rejects(readAdminCredential(),
      (error) => error.code === 'admin_credential_store_unavailable' && error.status === 503);
  });
});
