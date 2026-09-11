import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import groupHandler from '../api/group-ops.js';
import { fetchUpstreamJson } from '../api/_data-upstream.js';
import { paymentPipelineStore } from './helpers/payment-pipeline.js';
import { imageResponse } from './helpers/product-image-store.js';

const token = 'REPLACE_WITH_RANDOM_TOKEN';
const groupId = 'customer-transport-contract';
const actorId = 'visitor-transport-contract';
const capabilityToken = 'synthetic-transport-capability-'.repeat(2);
const capabilityHash = createHash('sha256').update(capabilityToken).digest('hex');
const payment = {
  action: 'transition_payment', groupId, actorId, participantActorId: actorId,
  capabilityToken, fromStatus: 'pending', toStatus: 'requested', direction: 'next',
  expectedVersion: 1, clientMutationId: 'transport-payment-one-intent',
};
const snapshot = { action: 'snapshot', groupId, actorId, capabilityToken };

// Keep Node fetch, HTTP redirects, body consumption and AbortSignal real. Only
// Google service primitives are replaced by the shared private Sheet fixture.
// No test creates a transition result or substitutes a successful API response.
async function transportFixture(t) {
  const store = paymentPipelineStore();
  const runGas = (body) => JSON.parse(store.context.doPost({
    postData: { contents: JSON.stringify({ token, ...body }) },
  }).contents);
  const seed = (body) => {
    const result = runGas(body);
    assert.equal(result.ok, true, result.error);
    return result;
  };
  seed({ action: 'group_create', payload: {
    groupId, dealId: groupId, actorId, nickname: '합성 호스트', title: '전송 검수 상품',
    hostMode: 'self', targetCount: 5, totalQuantity: 5, selectedQuantity: 1,
    capabilityHash, clientMutationId: 'transport-create-reservation',
  } });
  seed({ action: 'publish_deal', ownerCapabilityHash: capabilityHash, deal: {
    id: groupId, groupId, source: 'customer', title: '전송 검수 상품',
    originalPrice: 10000, target: 5, targetCount: 5, totalQuantity: 5,
    creatorActorId: actorId, creatorQuantity: 1, hostMode: 'self',
    expectedPublishVersion: 0, publishMutationId: 'transport-publish-deal',
  } });
  seed({ action: 'publish_order', visitorId: actorId,
    customerCapabilityHash: capabilityHash, participantCapabilityHash: capabilityHash, order: {
      id: 'order-1700000000001', type: 'group', dealId: groupId, groupId,
      visitorId: actorId, participantActorId: actorId, customerPhone: '01011112222',
      customerName: '합성 호스트', status: 'new', paymentStatus: 'pending',
      quantity: 1, selectedCount: 1, reservationMutationId: 'transport-create-reservation',
      reservationAction: 'create', reservationQuantity: 1,
      publishMutationId: 'transport-publish-order', unitPrice: 2000, total: 2000,
      version: 1, paymentVersion: 1,
    } });

  const received = [];
  const gasCalls = [];
  const errors = [];
  const results = new Map();
  let notifyBodyStarted;
  const bodyStarted = new Promise((resolve) => { notifyBodyStarted = resolve; });
  let mode = 'normal';
  let redirectStatus = 302;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const contents = Buffer.concat(chunks).toString();
      received.push({ method: request.method, path: request.url, contents });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET') {
        const result = results.get(request.url);
        response.end(result ?? store.context.doGet().contents);
        return;
      }
      if (mode === 'headers-timeout') return;
      if (mode === 'body-timeout') {
        response.writeHead(200);
        response.write('{"ok":');
        notifyBodyStarted();
        return;
      }
      if (mode === 'preserve-method' && request.url !== '/execute') {
        response.writeHead(307, { Location: '/execute' }).end();
        return;
      }
      if (mode !== 'health-before') {
        const payload = JSON.parse(contents);
        gasCalls.push(payload);
        const result = runGas(payload);
        const resultPath = `/result/${gasCalls.length}`;
        results.set(resultPath, JSON.stringify(result));
        if (mode === 'preserve-method') {
          response.end(JSON.stringify(result));
          return;
        }
        if (mode !== 'health-after') {
          response.writeHead(redirectStatus, { Location: resultPath }).end();
          return;
        }
      }
      // Models the observed POST -> doGet health response, both before and
      // after GAS committed. The HTTP status alone cannot distinguish them.
      response.writeHead(redirectStatus, { Location: '/exec' }).end();
    } catch (error) {
      errors.push(error.stack || String(error));
      response.writeHead(500).end(JSON.stringify({ ok: false, error: 'fixture_error' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/exec`;
  const env = {
    O2O_DATA_API_ORIGIN: '', O2O_DATA_API_TOKEN: '', O2O_RELEASE_PHASE: '9',
    GOOGLE_SHEETS_COLLECTOR_URL: url, GOOGLE_SHEETS_COLLECTOR_TOKEN: token,
    O2O_UPSTREAM_TIMEOUT_MS: '15000',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    assert.deepEqual(errors, []);
  });
  return {
    ...store, received, gasCalls, url, bodyStarted,
    setMode(value, status = 302) { mode = value; redirectStatus = status; },
    async invoke(body) {
      const response = imageResponse();
      await groupHandler({ method: 'POST', headers: { origin: 'http://localhost:5173' }, body }, response);
      return response;
    },
  };
}

for (const status of [302, 303]) {
  test(`real HTTP ${status} result redirect preserves the completed GAS payment response`, async (t) => {
    const store = await transportFixture(t);
    store.setMode('normal', status);
    const result = await store.invoke(payment);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.order.paymentStatus, 'requested');
    assert.equal(store.payments().length, 1);
    assert.equal(store.gasCalls.length, 1);
    assert.deepEqual(store.received.map(({ method }) => method), ['POST', 'GET']);
    assert.equal(store.received[1].contents, '');
    assert.equal(store.orders()[0].paymentVersion, 2);
  });
}

for (const phase of ['before', 'after']) {
  test(`repeated HTTP 200 health ${phase} commit remains uncertain without automatic POST replay`, async (t) => {
    const store = await transportFixture(t);
    store.setMode(`health-${phase}`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await store.invoke(payment);
      assert.equal(result.statusCode, 502);
      assert.deepEqual(result.body, { ok: false, error: 'upstream_invalid_response' });
      assert.equal(store.received.filter(({ method }) => method === 'POST').length, attempt);
      assert.equal(store.gasCalls.length, phase === 'after' ? attempt : 0);
      assert.equal(store.payments().length, phase === 'after' ? 1 : 0);
      assert.equal(store.orders()[0].paymentStatus, phase === 'after' ? 'requested' : 'pending');
    }
    store.setMode('normal');
    const recovered = await store.invoke(payment);
    assert.equal(recovered.statusCode, 200);
    assert.equal(Boolean(recovered.body.duplicate), phase === 'after');
    assert.equal(recovered.body.order.paymentStatus, 'requested');
    assert.equal(store.payments().length, 1);
    assert.equal(store.orders()[0].paymentVersion, 2);
    const mutations = store.gasCalls.filter(({ action }) => action === 'group_transition_payment');
    assert.ok(mutations.every(({ payload }) => payload.clientMutationId === payment.clientMutationId));
  });
}

test('HTTP 307 preserves the exact POST body and GAS still executes the payment only once', async (t) => {
  const store = await transportFixture(t);
  store.setMode('preserve-method');
  const result = await store.invoke(payment);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(store.received.map(({ method }) => method), ['POST', 'POST']);
  assert.equal(store.received[0].contents, store.received[1].contents);
  assert.equal(store.gasCalls.length, 1);
  assert.equal(store.payments().length, 1);
});

test('snapshot health response cannot become an empty successful group snapshot', async (t) => {
  const store = await transportFixture(t);
  store.setMode('health-after');
  const before = JSON.stringify([...store.sheets].map(([name, sheet]) => [name, sheet.rows]));
  const result = await store.invoke(snapshot);
  assert.equal(result.statusCode, 502);
  assert.deepEqual(result.body, { ok: false, error: 'upstream_invalid_response' });
  assert.equal(store.received.filter(({ method }) => method === 'POST').length, 1);
  assert.equal(JSON.stringify([...store.sheets].map(([name, sheet]) => [name, sheet.rows])), before);
});

for (const phase of ['headers', 'body']) {
  test(`a real snapshot ${phase} timeout is HTTP 504 with existing payment data untouched`, async (t) => {
    const store = await transportFixture(t);
    store.setMode(`${phase}-timeout`);
    process.env.O2O_UPSTREAM_TIMEOUT_MS = '1000';
    const before = JSON.stringify([...store.sheets].map(([name, sheet]) => [name, sheet.rows]));
    const result = await store.invoke(snapshot);
    assert.equal(result.statusCode, 504);
    assert.deepEqual(result.body, { ok: false, error: 'upstream_timeout' });
    assert.equal(store.received.filter(({ method }) => method === 'POST').length, 1);
    assert.equal(JSON.stringify([...store.sheets].map(([name, sheet]) => [name, sheet.rows])), before);
  });
}

test('caller cancellation remains cancellation rather than an upstream timeout or an automatic retry', async (t) => {
  const store = await transportFixture(t);
  store.setMode('body-timeout');
  const controller = new AbortController();
  const reason = new DOMException('Caller left the group screen', 'AbortError');
  const request = fetchUpstreamJson(store.url, {
    method: 'POST', body: JSON.stringify({ token, action: 'group_snapshot', payload: {} }),
    signal: controller.signal,
  });
  await store.bodyStarted;
  controller.abort(reason);
  await assert.rejects(request, (error) => error.name === 'AbortError' && error.code !== 'upstream_timeout');
  assert.equal(store.received.filter(({ method }) => method === 'POST').length, 1);
  assert.equal(store.gasCalls.length, 0);
});
