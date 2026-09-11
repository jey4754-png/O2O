import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import pinHandler from '../api/admin-pin.js';
import adminHandler from '../api/admin-ops.js';
import groupHandler from '../api/group-ops.js';
import orderHandler from '../api/customer-orders.js';
import { readAdminCredential, verifyAdminPin } from '../api/_admin-auth.js';
import { imageResponse } from './helpers/product-image-store.js';

const bootstrapPin = '2468';
const newPin = '73019284';
const change = { action: 'change', adminPin: bootstrapPin, newPin, confirmPin: newPin,
  actorId: 'qa_admin', clientMutationId: 'pin-test-change-0001' };
const origin = 'https://o2o-ten.vercel.app';
async function invoke(handler, body, headers = { origin }, method = 'POST') {
  const response = imageResponse();
  await handler({ body, headers, method }, response);
  return response;
}
function fixture(t) {
  const keys = ['O2O_ADMIN_PIN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN',
    'O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN', 'O2O_RELEASE_PHASE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, { O2O_ADMIN_PIN: bootstrapPin, GOOGLE_SHEETS_COLLECTOR_URL: 'https://collector.example.test',
    GOOGLE_SHEETS_COLLECTOR_TOKEN: 'REPLACE_WITH_RANDOM_TOKEN', O2O_DATA_API_ORIGIN: '', O2O_DATA_API_TOKEN: '', O2O_RELEASE_PHASE: '9' });
  const properties = new Map();
  const calls = [];
  const context = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.has(key) ? properties.get(key) : null,
      setProperty: (key, value) => properties.set(key, value),
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  };
  runInNewContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), context);
  context.json_ = (value) => JSON.parse(JSON.stringify(value));
  context.handleAdminOperation_ = () => ({ ok: true, deals: [] });
  context.handleGroupOperation_ = () => ({ ok: true, snapshot: { participants: [], group: {} } });
  context.getCustomerOrdersByGroup_ = () => ({ ok: true, orders: [] });
  context.manageCustomerOrder_ = () => ({ ok: true, order: {
    id: 'order-1788888888888', customerPhone: '01012345678', selectedCount: 1,
    dealId: 'customer-pin-test', groupId: 'customer-pin-test',
  } });
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const result = context.doPost({ postData: { contents: options.body } });
    return { status: 200, ok: true, json: async () => result };
  };
  globalThis.fetch = fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { context, properties, calls, fetch };
}

test('admin rate-limit errors have a Korean recovery message in both administrator UIs', () => {
  for (const path of ['../src/AdminConsole.jsx', '../src/GroupRoom.jsx']) {
    const uiSource = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(uiSource,
      /admin_rate_limited:\s*'관리자 PIN 입력 시도가 너무 많습니다\. 잠시 후 다시 시도해 주세요\.'/);
  }
});

test('PIN rotation persists only salted hash, replaces bootstrap PIN across all admin APIs, and can rotate again', async (t) => {
  const store = fixture(t);
  assert.equal(await readAdminCredential(), null);
  assert.equal(await verifyAdminPin(bootstrapPin), null);
  const first = await invoke(pinHandler, change);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.version, 1);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  const record = await readAdminCredential();
  assert.equal(record.algorithm, 'scrypt-v1');
  assert.equal(record.hash.length, 128);
  assert.equal(record.salt.length, 32);
  assert.equal(JSON.stringify([...store.properties.values(), store.calls, first.body]).includes(newPin), false);
  await assert.rejects(verifyAdminPin(bootstrapPin), { code: 'invalid_admin_pin', status: 403 });
  assert.equal((await verifyAdminPin(newPin)).version, 1);
  for (const [handler, body] of [
    [adminHandler, { action: 'list', actorId: 'qa_admin' }],
    [groupHandler, { action: 'snapshot', groupId: 'customer-pin-test', actorId: 'qa_admin' }],
    [orderHandler, { action: 'list_group', groupId: 'customer-pin-test', dealId: 'customer-pin-test', actorId: 'qa_admin' }],
    [orderHandler, { action: 'manage', managerType: 'group_manager', orderId: 'order-1788888888888',
      dealId: 'customer-pin-test', actorId: 'qa_admin', kind: 'payment_status', direction: 'next',
      expectedVersion: 1, clientMutationId: 'order-pin-test-0001' }],
  ]) {
    const count = store.calls.filter((call) => call.action !== 'admin_credentials').length;
    assert.equal((await invoke(handler, { ...body, adminPin: bootstrapPin })).statusCode, 403);
    assert.equal(store.calls.filter((call) => call.action !== 'admin_credentials').length, count);
    assert.equal((await invoke(handler, { ...body, adminPin: newPin })).statusCode, 200);
    assert.equal(store.calls.at(-1).payload.adminCredentialVersion, 1);
  }
  const secondPin = '0182837465';
  const second = await invoke(pinHandler, { ...change, adminPin: newPin, newPin: secondPin, confirmPin: secondPin,
    clientMutationId: 'pin-test-change-0002' });
  assert.equal(second.body.version, 2);
  await assert.rejects(verifyAdminPin(newPin), { code: 'invalid_admin_pin' });
  assert.equal((await verifyAdminPin(secondPin)).version, 2);
  assert.notEqual((await readAdminCredential()).salt, record.salt);
});

test('PIN endpoint rejects wrong PIN, forged assertion, invalid format/confirmation/origin, and malformed bodies without writes', async (t) => {
  const store = fixture(t);
  for (const [body, expected, headers, method] of [
    [{ ...change, adminPin: 'wrong', adminAssertion: true }, 'invalid_admin_pin'],
    [{ ...change, adminPin: undefined }, 'invalid_admin_pin'],
    [{ ...change, adminPin: 'a'.repeat(129) }, 'invalid_admin_pin'],
    [{ ...change, newPin: '1234', confirmPin: '1234' }, 'invalid_new_pin'],
    [{ ...change, newPin: 12345678, confirmPin: 12345678 }, 'invalid_new_pin'],
    [{ ...change, confirmPin: '87654321' }, 'pin_mismatch'],
    [{ ...change, adminPin: newPin }, 'pin_unchanged'],
    [{ ...change, actorId: 'bad actor' }, 'invalid_actor_id'],
    [{ ...change, clientMutationId: 'short' }, 'invalid_client_mutation_id'],
    [change, 'forbidden_origin', {}],
    [change, 'forbidden_origin', { origin: 'https://attacker.invalid' }],
    [change, 'method_not_allowed', { origin }, 'GET'],
    ['{', 'invalid_request'], [[], 'invalid_request'],
    ['x'.repeat(4097), 'payload_too_large'],
  ]) {
    assert.equal((await invoke(pinHandler, body, headers, method)).body.error, expected);
  }
  assert.equal(store.properties.has('O2O_ADMIN_CREDENTIAL_V1'), false);
  assert.equal(JSON.stringify([...store.properties.values()]).includes('wrong'), false);
  assert.equal(store.calls.some((call) => call.payload?.operation === 'write'), false);
});

test('unknown/old collector responses, corrupt credentials and outages never fall back to env PIN', async (t) => {
  fixture(t);
  for (const result of [{ ok: true }, { ok: true, allowed: true }, { ok: true, credential: undefined }, { ok: true, credential: {} },
    { ok: true, credential: [] }, { ok: true, allowed: true, reserved: true, credential: undefined },
    { ok: true, allowed: true, reserved: true, credential: {} }, { ok: false, error: 'sensitive provider message' }]) {
    globalThis.fetch = async () => ({ status: 200, json: async () => result });
    await assert.rejects(verifyAdminPin(bootstrapPin), { code: 'admin_credential_store_unavailable', status: 503 });
  }
  globalThis.fetch = async () => { throw new Error('sensitive provider message'); };
  const response = await invoke(pinHandler, change);
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.stringify(response.body).includes('sensitive'), false);
});

test('a six-request PIN burst rejects excess work without separate credential round trips', async (t) => {
  const store = fixture(t);
  const request = { headers: { 'x-vercel-forwarded-for': '203.0.113.88' } };
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => verifyAdminPin('wrong-pin', request)));
  assert.equal(store.calls.filter((call) => call.payload?.operation === 'read').length, 0,
    'a successful rate_begin response carries the credential snapshot without another cold request');
  assert.equal(store.calls.filter((call) => call.payload?.operation === 'rate_begin').length, 6);
  assert.deepEqual(results.map((result) => result.reason?.status).sort(), [403, 403, 403, 403, 429, 429]);
});

test('current collector verifies an admin operation in three calls while old responses retain the read fallback', async (t) => {
  const store = fixture(t);
  const current = await invoke(adminHandler, { action: 'list', actorId: 'qa_admin', adminPin: bootstrapPin },
    { origin, 'x-forwarded-for': '203.0.113.41' });
  assert.equal(current.statusCode, 200);
  assert.deepEqual(store.calls.map((call) => call.action === 'admin_credentials'
    ? call.payload.operation : call.action), ['rate_begin', 'rate_success', 'admin_operation']);

  store.calls.length = 0;
  const currentFetch = store.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'admin_credentials' && body.payload.operation === 'rate_begin') {
      const response = await currentFetch(url, options);
      const result = await response.json();
      const { credential: _omittedForLegacyCompatibility, ...legacyResult } = result;
      return { ...response, json: async () => legacyResult };
    }
    return currentFetch(url, options);
  };
  const compatible = await invoke(adminHandler, { action: 'list', actorId: 'qa_admin', adminPin: bootstrapPin },
    { origin, 'x-forwarded-for': '203.0.113.42' });
  assert.equal(compatible.statusCode, 200);
  assert.deepEqual(store.calls.map((call) => call.action === 'admin_credentials'
    ? call.payload.operation : call.action), ['rate_begin', 'read', 'rate_success', 'admin_operation']);
});

for (const busyPhase of ['rate_begin', 'rate_success']) {
  test(`one explicit pre-lock ${busyPhase} busy response retries the identical body without duplicating limiter changes`, async (t) => {
    const store = fixture(t);
    let phase = '';
    let rejected = false;
    store.context.LockService.getScriptLock = () => ({
      tryLock() {
        if (phase === busyPhase && !rejected) { rejected = true; return false; }
        return true;
      },
      releaseLock() {},
    });
    const bodies = [];
    globalThis.fetch = async (url, options) => {
      phase = JSON.parse(options.body).payload.operation;
      bodies.push(options.body);
      const before = JSON.stringify([...store.properties]);
      const response = await store.fetch(url, options);
      if ((await response.json()).error === 'collector_busy') {
        assert.equal(JSON.stringify([...store.properties]), before, 'busy must precede every counter write');
      }
      return response;
    };
    const result = await invoke(adminHandler, { action: 'list', actorId: 'qa_admin', adminPin: bootstrapPin });
    assert.equal(result.statusCode, 200);
    const repeated = bodies.filter((body) => JSON.parse(body).payload.operation === busyPhase);
    assert.equal(repeated.length, 2);
    assert.equal(repeated[0], repeated[1]);
    assert.equal(store.calls.filter((call) => call.action === 'admin_operation').length, 1);
    const state = JSON.parse(store.properties.get('O2O_ADMIN_AUTH_RATE_LIMIT_V1'));
    assert.equal(state.global, null);
    assert.deepEqual(state.clients, {}, 'successful completion must release exactly one reserved attempt');
  });

  test(`persistent ${busyPhase} busy stops after two requests without entering an admin operation`, async (t) => {
    const store = fixture(t);
    let phase = '';
    store.context.LockService.getScriptLock = () => ({ tryLock: () => phase !== busyPhase, releaseLock() {} });
    globalThis.fetch = async (url, options) => {
      phase = JSON.parse(options.body).payload.operation;
      return store.fetch(url, options);
    };
    const result = await invoke(adminHandler, { action: 'list', actorId: 'qa_admin', adminPin: bootstrapPin });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.error, 'admin_credential_store_unavailable');
    assert.equal(store.calls.filter((call) => call.payload.operation === busyPhase).length, 2);
    assert.equal(store.calls.some((call) => call.action === 'admin_operation'), false);
    if (busyPhase === 'rate_begin') assert.equal(store.properties.size, 0);
    else assert.equal(JSON.parse(store.properties.get('O2O_ADMIN_AUTH_RATE_LIMIT_V1')).global.inFlight, 1);
  });
}

test('retrying pre-lock begin contention never retries a wrong PIN or skips its failure counter', async (t) => {
  const store = fixture(t);
  let locks = 0;
  store.context.LockService.getScriptLock = () => ({ tryLock: () => ++locks > 1, releaseLock() {} });
  await assert.rejects(verifyAdminPin('wrong-pin'), { code: 'invalid_admin_pin', status: 403 });
  assert.deepEqual(store.calls.map((call) => call.payload.operation), ['rate_begin', 'rate_begin', 'rate_failure']);
  const state = JSON.parse(store.properties.get('O2O_ADMIN_AUTH_RATE_LIMIT_V1'));
  assert.equal(state.global.failures, 1);
  assert.equal(state.global.inFlight, 0);
});

for (const failure of ['timeout_after_commit', 'health_after_commit', 'network_failure', 'store_failure',
  'ambiguous_busy', 'http_busy', 'malformed', 'rate_limit', 'invalid_pin']) {
  test(`credential ${failure} is never automatically replayed`, async (t) => {
    const store = fixture(t);
    let requests = 0;
    globalThis.fetch = async (url, options) => {
      requests += 1;
      if (failure.endsWith('_after_commit')) await store.fetch(url, options);
      if (failure === 'timeout_after_commit') throw Object.assign(new Error('unknown outcome'), { name: 'TimeoutError' });
      if (failure === 'network_failure') throw new Error('unknown outcome');
      if (failure === 'malformed') return { status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } };
      const result = failure === 'health_after_commit' ? { ok: true, service: 'UPTWOYOU collector' }
        : failure === 'store_failure' ? { ok: false, error: 'admin_credential_store_unavailable' }
        : failure === 'ambiguous_busy' ? { ok: false, error: 'collector_busy', reserved: true }
        : failure === 'http_busy' ? { ok: false, error: 'collector_busy' }
        : failure === 'rate_limit' ? { ok: true, allowed: false, retryAfter: 90 }
        : { ok: false, error: 'invalid_admin_pin' };
      return { status: failure === 'http_busy' ? 503 : 200, json: async () => result };
    };
    await assert.rejects(verifyAdminPin(bootstrapPin), {
      code: failure === 'rate_limit' ? 'admin_rate_limited' : 'admin_credential_store_unavailable',
    });
    assert.equal(requests, 1);
    if (failure.endsWith('_after_commit')) {
      assert.equal(JSON.parse(store.properties.get('O2O_ADMIN_AUTH_RATE_LIMIT_V1')).global.inFlight, 1);
    }
  });
}

test('explicit busy on a PIN failure record is not retried and its reserved slot still limits future work', async (t) => {
  const store = fixture(t);
  let phase = '';
  store.context.LockService.getScriptLock = () => ({ tryLock: () => phase !== 'rate_failure', releaseLock() {} });
  globalThis.fetch = async (url, options) => {
    phase = JSON.parse(options.body).payload.operation;
    return store.fetch(url, options);
  };
  await assert.rejects(verifyAdminPin('wrong-pin'), { code: 'admin_credential_store_unavailable' });
  assert.deepEqual(store.calls.map((call) => call.payload.operation), ['rate_begin', 'rate_failure']);
  assert.equal(JSON.parse(store.properties.get('O2O_ADMIN_AUTH_RATE_LIMIT_V1')).global.inFlight, 1);
});

test('admin failure logs distinguish authentication, validation, and operation without request or provider secrets', async (t) => {
  const store = fixture(t);
  const logs = [];
  t.mock.method(console, 'warn', (label, details) => {
    assert.equal(label, '[admin-ops] request_failure');
    logs.push(JSON.parse(details));
  });
  const fields = { action: 'cancel_order', actorId: 'qa_private_actor', dealId: 'customer-private-deal',
    orderId: 'order-1788888888888', reason: 'private cancellation reason', expectedVersion: 1,
    clientMutationId: 'private-request-identifier', adminPin: bootstrapPin };
  await invoke(adminHandler, { ...fields, adminPin: 'private-wrong-pin' });
  await invoke(adminHandler, { ...fields, reason: '' });
  store.context.handleAdminOperation_ = () => ({ ok: false, error: 'order_not_found' });
  await invoke(adminHandler, fields);
  const privateProviderText = 'abcdef'.repeat(12);
  store.context.handleAdminOperation_ = () => ({ ok: false, error: privateProviderText });
  await invoke(adminHandler, fields);
  await invoke(adminHandler, { ...fields, action: privateProviderText });
  assert.deepEqual(logs, [
    { action: 'cancel_order', error: 'invalid_admin_pin', status: 403, phase: 'authentication' },
    { action: 'cancel_order', error: 'reason_required', status: 400, phase: 'validation' },
    { action: 'cancel_order', error: 'order_not_found', status: 409, phase: 'operation' },
    { action: 'cancel_order', error: 'admin_operation_failed', status: 409, phase: 'operation' },
    { action: 'unknown', error: 'invalid_action', status: 400, phase: 'validation' },
  ]);
  for (const secret of [bootstrapPin, 'private-wrong-pin', fields.actorId, fields.dealId,
    fields.orderId, fields.reason, fields.clientMutationId, privateProviderText]) {
    assert.equal(JSON.stringify(logs).includes(secret), false);
  }
});

test('a limiter read or result-recording outage denies both correct and incorrect PINs without disclosure', async (t) => {
  fixture(t);
  for (const candidate of [bootstrapPin, 'wrong-pin']) {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.equal(JSON.stringify(body).includes(candidate), false);
      if (body.payload.operation === 'rate_begin') {
        return { status: 200, json: async () => ({ ok: true, allowed: true, reserved: true }) };
      }
      if (body.payload.operation === 'read') {
        return { status: 200, json: async () => ({ ok: true, credential: null }) };
      }
      return { status: 200, json: async () => ({ ok: false, error: 'sensitive-provider-detail' }) };
    };
    await assert.rejects(verifyAdminPin(candidate, { headers: { 'x-forwarded-for': '203.0.113.20' } }),
      { code: 'admin_credential_store_unavailable', status: 503 });
    assert.deepEqual(calls.map((call) => call.payload.operation), [
      'rate_begin', 'read', candidate === bootstrapPin ? 'rate_success' : 'rate_failure',
    ]);
  }
});

test('shared limiter prevents PIN endpoint hopping, returns Retry-After, and never persists attempted PINs', async (t) => {
  const store = fixture(t);
  const sameClient = (spoofed) => ({ origin, 'x-forwarded-for': `${spoofed}, 203.0.113.9` });
  const attempts = [
    [adminHandler, { action: 'list', actorId: 'qa_admin', adminPin: 'wrong-admin' }],
    [groupHandler, { action: 'snapshot', groupId: 'customer-pin-test', actorId: 'qa_admin', adminPin: 'wrong-group' }],
    [orderHandler, { action: 'list_group', groupId: 'customer-pin-test', dealId: 'customer-pin-test',
      actorId: 'qa_admin', adminPin: 'wrong-orders' }],
    [pinHandler, { ...change, adminPin: 'wrong-change' }],
    [adminHandler, { action: 'list', actorId: 'qa_admin', adminPin: 'wrong-final' }],
  ];
  for (let index = 0; index < attempts.length; index += 1) {
    const [handler, body] = attempts[index];
    const response = await invoke(handler, body, sameClient(`198.51.100.${index + 1}`));
    if (index < 4) {
      assert.equal(response.statusCode, 403);
      assert.equal(response.body.error, 'invalid_admin_pin');
      assert.equal(response.headers['Retry-After'], undefined);
    } else {
      assert.equal(response.statusCode, 429);
      assert.equal(response.body.error, 'admin_rate_limited');
      assert.match(response.headers['Retry-After'], /^\d+$/);
      assert.ok(Number(response.headers['Retry-After']) > 0);
    }
  }
  for (const [handler, body] of [
    [groupHandler, { action: 'snapshot', groupId: 'customer-pin-test', actorId: 'qa_admin', adminPin: bootstrapPin }],
    [orderHandler, { action: 'list_group', groupId: 'customer-pin-test', dealId: 'customer-pin-test',
      actorId: 'qa_admin', adminPin: bootstrapPin }],
    [pinHandler, change],
  ]) {
    const stillBlocked = await invoke(handler, body, sameClient('192.0.2.77'));
    assert.equal(stillBlocked.statusCode, 429, 'correct PIN cannot bypass an active client lock through another endpoint');
    assert.equal(stillBlocked.body.error, 'admin_rate_limited');
    assert.match(stillBlocked.headers['Retry-After'], /^\d+$/);
  }

  const otherClient = await invoke(adminHandler, {
    action: 'list', actorId: 'qa_admin', adminPin: bootstrapPin,
  }, { origin, 'x-forwarded-for': '203.0.113.10' });
  assert.equal(otherClient.statusCode, 200);
  assert.equal(otherClient.body.ok, true);
  const persisted = JSON.stringify([...store.properties.values()]);
  for (const attemptedPin of ['wrong-admin', 'wrong-group', 'wrong-orders', 'wrong-change', 'wrong-final', bootstrapPin]) {
    assert.equal(persisted.includes(attemptedPin), false);
  }
});

test('commit followed by lost response is recovered only by identical receipt/actor/new PIN', async (t) => {
  const store = fixture(t);
  let lost = false;
  globalThis.fetch = async (url, options) => {
    const result = await store.fetch(url, options);
    if (!lost && JSON.parse(options.body).payload.operation === 'write') {
      lost = true; throw new Error('response lost after commit');
    }
    return result;
  };
  assert.equal((await invoke(pinHandler, change)).statusCode, 503);
  const retry = await invoke(pinHandler, change);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.version, 1);
  assert.equal(store.calls.filter((call) => call.payload?.operation === 'write').length, 1);
  assert.equal((await invoke(pinHandler, { ...change, actorId: 'other_admin' })).statusCode, 409);
  assert.equal((await invoke(pinHandler, { ...change, newPin: '99998888', confirmPin: '99998888' })).statusCode, 409);
});

test('concurrent distinct PIN changes use CAS; concurrent identical changes return one commit and duplicate', async (t) => {
  const store = fixture(t);
  const runConcurrent = async (bodies) => {
    let readCount = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url, options) => {
      const result = await store.fetch(url, options);
      if (JSON.parse(options.body).payload.operation === 'read' && readCount < 2) {
        readCount += 1;
        if (readCount === 2) release();
        await barrier;
      }
      return result;
    };
    return Promise.all(bodies.map((body) => invoke(pinHandler, body)));
  };
  const responses = await runConcurrent([change, { ...change, newPin: '81920374', confirmPin: '81920374', clientMutationId: 'pin-test-change-0002' }]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal((await readAdminCredential()).version, 1);
  store.properties.clear();
  const identical = await runConcurrent([change, change]);
  assert.deepEqual(identical.map((response) => response.statusCode), [200, 200]);
  assert.equal(identical.filter((response) => response.body.duplicate).length, 1);
  assert.equal((await readAdminCredential()).version, 1);
});
