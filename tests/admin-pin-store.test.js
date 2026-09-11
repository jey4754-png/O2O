import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const key = 'O2O_ADMIN_CREDENTIAL_V1';
const rateKey = 'O2O_ADMIN_AUTH_RATE_LIMIT_V1';
const verifier = { algorithm: 'scrypt-v1', salt: 'a'.repeat(32), hash: 'b'.repeat(128) };
const initialWrite = { operation: 'write', adminAssertion: true, expectedVersion: 0,
  clientMutationId: 'pin-change-test-0001', actorId: 'operator_admin', credential: verifier };

function fixture() {
  const values = new Map();
  const counters = { acquired: 0, released: 0, writes: 0, propertyReads: 0 };
  let locked = false;
  const properties = {
    getProperty(name) {
      assert.ok([key, rateKey].includes(name));
      counters.propertyReads += 1;
      return values.has(name) ? values.get(name) : null;
    },
    setProperty(name, value) {
      assert.ok([key, rateKey].includes(name));
      assert.equal(locked, true, 'credential commits require a script lock');
      counters.writes += 1;
      values.set(name, value);
      return properties;
    },
  };
  const context = {
    PropertiesService: { getScriptProperties: () => properties },
    LockService: {
      getScriptLock: () => ({
        tryLock(timeout) {
          assert.equal(timeout, 3000);
          if (locked) return false;
          locked = true; counters.acquired += 1; return true;
        },
        releaseLock() { assert.equal(locked, true); locked = false; counters.released += 1; },
      }),
    },
  };
  runInNewContext(source, context);
  context.json_ = (value) => JSON.parse(JSON.stringify(value));
  context.ensureSheets_ = () => assert.fail('credential requests must not ingest events or write spreadsheets');
  const request = (payload, token = 'REPLACE_WITH_RANDOM_TOKEN') => context.doPost({
    postData: { contents: JSON.stringify({ token, action: 'admin_credentials', payload }) },
  });
  return { context, values, counters, properties, request, isLocked: () => locked };
}

test('GAS credential route is token-protected and invalid requests never become event ingestion', () => {
  const store = fixture();
  assert.equal(store.request({ operation: 'read' }, 'wrong').error, 'unauthorized');
  assert.equal(store.counters.propertyReads, 0);
  for (const payload of [undefined, null, [], '', 42, {}, { operation: 'rotate' },
    { operation: 'read', adminPin: 'do-not-store-this' }]) {
    assert.equal(store.request(payload).error, 'invalid_admin_credential_request');
  }
  assert.equal(store.request({ ...initialWrite, adminAssertion: false }).error, 'forbidden');
  assert.equal(store.request({ ...initialWrite, adminPin: 'do-not-store-this' }).error, 'invalid_admin_credential_request');
  assert.equal(store.counters.writes, 0);
  assert.deepEqual(store.request({ operation: 'read' }), { ok: true, credential: null });
  assert.equal(store.counters.acquired, 0, 'single atomic property reads do not need a write lock');
});

test('explicit credential busy is emitted before property access or any limiter change', () => {
  for (const operation of ['rate_begin', 'rate_success']) {
    const store = fixture();
    const clientKey = 'c'.repeat(32);
    if (operation === 'rate_success') assert.equal(store.request({ operation: 'rate_begin', clientKey }).ok, true);
    const valuesBefore = JSON.stringify([...store.values]);
    const countersBefore = { ...store.counters };
    store.context.LockService.getScriptLock = () => ({
      tryLock: () => false,
      releaseLock: () => assert.fail('unacquired lock must not be released'),
    });
    assert.deepEqual(store.request({ operation, clientKey }), { ok: false, error: 'collector_busy' });
    assert.equal(JSON.stringify([...store.values]), valuesBefore);
    assert.deepEqual(store.counters, countersBefore);
  }
});

test('GAS validates complete verifier, versions and identifiers without truncation or coercion', () => {
  const store = fixture();
  for (const credential of [null, [], { ...verifier, pin: 'do-not-store-this' },
    { ...verifier, algorithm: 'sha256' }, { ...verifier, salt: 'A'.repeat(32) },
    { ...verifier, hash: 'b'.repeat(127) }, { ...verifier, hash: 123 }, { salt: verifier.salt, hash: verifier.hash }]) {
    assert.equal(store.request({ ...initialWrite, credential }).error, 'invalid_admin_credential');
  }
  for (const expectedVersion of ['0', null, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(store.request({ ...initialWrite, expectedVersion }).error, 'invalid_expected_version');
  }
  for (const actorId of ['', null, 123, 'a'.repeat(129), 'actor with spaces', 'operator_admin ']) {
    assert.equal(store.request({ ...initialWrite, actorId }).error, 'invalid_actor_id');
  }
  for (const clientMutationId of ['', 'short', 'a'.repeat(129), 'mutation.with.dots', 12345678]) {
    assert.equal(store.request({ ...initialWrite, clientMutationId }).error, 'invalid_client_mutation_id');
  }
  assert.equal(store.counters.writes, 0);
  assert.equal(store.counters.acquired, 0);
});

test('GAS bootstraps and rotates one atomic verifier property while retaining safe audit metadata', () => {
  const store = fixture();
  const first = store.request(initialWrite);
  assert.equal(first.ok, true);
  assert.equal(first.version, 1);
  assert.equal(Number.isFinite(Date.parse(first.updatedAt)), true);
  assert.equal(first.credential, undefined, 'write response does not expose the verifier');
  const saved = store.request({ operation: 'read' }).credential;
  assert.deepEqual(saved, { ...verifier, version: 1, updatedAt: first.updatedAt,
    updatedBy: initialWrite.actorId, lastMutationId: initialWrite.clientMutationId });
  const next = { ...initialWrite, expectedVersion: 1, actorId: 'another_admin', clientMutationId: 'pin-change-test-0002',
    credential: { ...verifier, salt: 'c'.repeat(32), hash: 'd'.repeat(128) } };
  const rotated = store.request(next);
  assert.equal(rotated.ok, true);
  assert.equal(rotated.version, 2);
  assert.deepEqual(store.request({ operation: 'read' }).credential, { ...next.credential, version: 2,
    updatedAt: rotated.updatedAt, updatedBy: next.actorId, lastMutationId: next.clientMutationId });
  assert.equal(store.values.size, 1);
  assert.equal(store.counters.writes, 2);
  assert.equal(store.counters.acquired, store.counters.released);
  assert.equal(store.isLocked(), false);
});

test('GAS exact retries do not rotate again and conflicting reuse of the mutation ID fails', () => {
  const store = fixture();
  const first = store.request(initialWrite);
  assert.deepEqual(store.request(initialWrite), { ok: true, duplicate: true, version: 1, updatedAt: first.updatedAt });
  for (const change of [{ expectedVersion: 1 }, { actorId: 'other_admin' },
    { credential: { ...verifier, salt: 'c'.repeat(32) } }, { credential: { ...verifier, hash: 'd'.repeat(128) } }]) {
    assert.equal(store.request({ ...initialWrite, ...change }).error, 'client_mutation_conflict');
  }
  assert.equal(store.counters.writes, 1);
  assert.equal(store.counters.acquired, store.counters.released);
});

test('GAS serializes concurrent rotations and rejects stale compare-and-swap versions', () => {
  const store = fixture();
  const getProperty = store.properties.getProperty;
  let attempted = false;
  let concurrentResult;
  const concurrent = { ...initialWrite, clientMutationId: 'concurrent-change-0002' };
  store.properties.getProperty = (name) => {
    if (!attempted) { attempted = true; concurrentResult = store.request(concurrent); }
    return getProperty(name);
  };
  assert.equal(store.request(initialWrite).ok, true);
  assert.equal(concurrentResult.error, 'collector_busy');
  assert.equal(store.request(concurrent).error, 'state_conflict');
  assert.equal(store.counters.writes, 1);
  assert.equal(store.counters.acquired, store.counters.released);
});

test('GAS corrupt or unknown persisted credentials fail closed without replacing state', () => {
  const store = fixture();
  store.request(initialWrite);
  const good = store.request({ operation: 'read' }).credential;
  const invalidRecords = ['', 'not-json', 'null', '[]', '{}', ...[
    { ...good, pin: 'unexpected-secret' }, { ...good, algorithm: 'unknown' },
    { ...good, version: 0 }, { ...good, version: '1' }, { ...good, updatedAt: '2026-02-30T00:00:00.000Z' },
    { ...good, updatedAt: '2026-09-09' }, { ...good, updatedBy: '' }, { ...good, lastMutationId: 'short' },
    { ...good, salt: null },
  ].map(JSON.stringify)];
  for (const record of invalidRecords) {
    store.values.set(key, record);
    assert.equal(store.request({ operation: 'read' }).error, 'admin_credential_state_invalid');
    assert.equal(store.request(initialWrite).error, 'admin_credential_state_invalid');
    assert.equal(store.values.get(key), record, 'malformed state must not trigger bootstrap fallback');
  }
  assert.equal(store.counters.writes, 1);
  assert.equal(store.counters.acquired, store.counters.released);
});

test('GAS read/write service failures are opaque and release locks without false success', () => {
  const store = fixture();
  const getProperty = store.properties.getProperty;
  const setProperty = store.properties.setProperty;
  store.properties.getProperty = () => { throw new Error('sensitive provider details'); };
  assert.deepEqual(store.request({ operation: 'read' }), { ok: false, error: 'admin_credential_store_unavailable' });
  assert.equal(store.request(initialWrite).error, 'admin_credential_store_unavailable');
  store.properties.getProperty = getProperty;
  store.properties.setProperty = () => { throw new Error('sensitive provider details'); };
  assert.equal(store.request(initialWrite).error, 'admin_credential_store_unavailable');
  assert.equal(store.request({ operation: 'read' }).credential, null);
  store.properties.setProperty = () => store.properties;
  assert.equal(store.request(initialWrite).error, 'admin_credential_store_unavailable', 'verify persisted state before acknowledging success');
  store.properties.setProperty = setProperty;
  assert.equal(store.request(initialWrite).ok, true);
  assert.equal(store.counters.acquired, store.counters.released);
});

test('GAS recovers a commit whose response was lost via exact retry without double rotation', () => {
  const store = fixture();
  const setProperty = store.properties.setProperty;
  store.properties.setProperty = (name, value) => {
    setProperty(name, value);
    throw new Error('simulated provider disconnect after atomic commit');
  };
  assert.equal(store.request(initialWrite).error, 'admin_credential_store_unavailable');
  assert.equal(store.request({ operation: 'read' }).credential.lastMutationId, initialWrite.clientMutationId);
  store.properties.setProperty = setProperty;
  assert.equal(store.request(initialWrite).duplicate, true);
  assert.equal(store.counters.writes, 1);
  assert.equal(store.counters.acquired, store.counters.released);
});

test('GAS refuses exhausted credential versions instead of losing CAS precision', () => {
  const store = fixture();
  store.request(initialWrite);
  const existing = store.request({ operation: 'read' }).credential;
  store.values.set(key, JSON.stringify({ ...existing, version: Number.MAX_SAFE_INTEGER }));
  assert.equal(store.request({ ...initialWrite, expectedVersion: Number.MAX_SAFE_INTEGER,
    clientMutationId: 'pin-change-exhausted-0002' }).error, 'admin_credential_version_exhausted');
  assert.equal(store.counters.writes, 1);
  assert.equal(store.counters.acquired, store.counters.released);
});

test('GAS shared PIN limiter validates opaque keys and never accepts a PIN or endpoint bucket', () => {
  const store = fixture();
  const valid = { operation: 'rate_check', clientKey: 'a'.repeat(32) };
  const reads = store.counters.propertyReads;
  assert.equal(store.request(valid, 'wrong').error, 'unauthorized');
  assert.equal(store.counters.propertyReads, reads, 'token validation precedes limiter state access');
  for (const payload of [
    { operation: 'rate_check' },
    { ...valid, clientKey: 'A'.repeat(32) },
    { ...valid, clientKey: 'a'.repeat(31) },
    { ...valid, adminPin: 'must-never-reach-the-store' },
    { ...valid, endpoint: 'admin-ops' },
  ]) {
    assert.equal(store.request(payload).error, 'invalid_admin_credential_request');
  }
  assert.equal(store.values.has(rateKey), false);
});

test('GAS shared PIN limiter reserves five in-flight slots before verification and rejects a sixth burst', () => {
  const store = fixture();
  const clientKey = '9'.repeat(32);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(store.request({ operation: 'rate_begin', clientKey }),
      { ok: true, allowed: true, reserved: true, credential: null });
  }
  const sixth = store.request({ operation: 'rate_begin', clientKey });
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.retryAfter, 900);
  assert.equal(Object.hasOwn(sixth, 'credential'), false,
    'a denied reservation must not return the verifier snapshot');
  const state = JSON.parse(store.values.get(rateKey));
  assert.equal(state.clients[clientKey].inFlight, 5);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(store.request({ operation: 'rate_failure', clientKey }).allowed, true);
  }
  assert.equal(store.request({ operation: 'rate_failure', clientKey }).allowed, false);
  assert.equal(store.counters.acquired, store.counters.released);
});

test('GAS shared PIN limiter atomically reserves attempts, blocks the fifth failure for 15 minutes and resets on success', () => {
  const store = fixture();
  const clientKey = 'b'.repeat(32);
  const request = (operation, keyValue = clientKey) => store.request({ operation, clientKey: keyValue });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.deepEqual(request('rate_begin'), { ok: true, allowed: true, reserved: true, credential: null });
    assert.deepEqual(request('rate_failure'), { ok: true, allowed: true });
  }
  assert.deepEqual(request('rate_begin'), { ok: true, allowed: true, reserved: true, credential: null });
  assert.deepEqual(request('rate_success'), { ok: true, allowed: true });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(request('rate_begin').allowed, true);
    assert.equal(request('rate_failure').allowed, true);
  }
  assert.equal(request('rate_begin').allowed, true);
  const blocked = request('rate_failure');
  assert.equal(blocked.ok, true);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 900);
  assert.equal(request('rate_begin').allowed, false);
  assert.equal(request('rate_success').allowed, false, 'a blocked client cannot clear its own lock with a candidate PIN');
  assert.equal(request('rate_begin', 'c'.repeat(32)).allowed, true, 'another client is not blocked by one client threshold');
  const serialized = store.values.get(rateKey);
  assert.equal(serialized.includes('must-never-reach-the-store'), false);
  assert.equal(store.counters.acquired, store.counters.released);
});

test('GAS returns the current verifier only with a successful locked rate_begin reservation', () => {
  const store = fixture();
  const written = store.request(initialWrite);
  const saved = store.request({ operation: 'read' }).credential;
  assert.equal(written.ok, true);
  const clientKey = 'd'.repeat(32);
  const begin = store.request({ operation: 'rate_begin', clientKey });
  assert.deepEqual(begin, { ok: true, allowed: true, reserved: true, credential: saved });
  assert.equal(store.request({ operation: 'rate_success', clientKey }).allowed, true);
  const check = store.request({ operation: 'rate_check', clientKey });
  assert.equal(check.allowed, true);
  assert.equal(Object.hasOwn(check, 'credential'), false,
    'non-login limiter operations must not return the verifier');
  assert.equal(store.request({ operation: 'rate_failure', clientKey }).allowed, true);
  assert.equal(store.counters.acquired, store.counters.released);
});

test('GAS shared PIN limiter has a global cross-client ceiling and malformed state fails closed', () => {
  const store = fixture();
  let result;
  for (let index = 0; index < 40; index += 1) {
    const clientKey = index.toString(16).padStart(32, '0');
    assert.equal(store.request({ operation: 'rate_begin', clientKey }).allowed, true);
    result = store.request({ operation: 'rate_failure', clientKey });
  }
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfter, 900);
  assert.equal(store.request({ operation: 'rate_begin', clientKey: 'f'.repeat(32) }).allowed, false,
    'rotating client keys cannot bypass the global ceiling');
  const saved = store.values.get(rateKey);
  for (const corrupt of ['not-json', '{}', JSON.stringify({ version: 1, global: null, clients: { bad: {} } })]) {
    store.values.set(rateKey, corrupt);
    assert.equal(store.request({ operation: 'rate_check', clientKey: 'a'.repeat(32) }).error,
      'admin_auth_rate_limit_state_invalid');
    assert.equal(store.values.get(rateKey), corrupt, 'malformed limiter state is never reset or overwritten');
  }
  store.values.set(rateKey, saved);
  assert.equal(store.counters.acquired, store.counters.released);
});

function privilegedRequest(store, action, payload, token = 'REPLACE_WITH_RANDOM_TOKEN') {
  return store.context.doPost({ postData: { contents: JSON.stringify({ token, action, payload }) } });
}

function installPrivilegeSpies(store) {
  const calls = [];
  store.context.handleAdminOperation_ = (payload) => { calls.push(['admin_operation', payload]); return { ok: true }; };
  store.context.handleGroupOperation_ = (action, payload) => { calls.push([`group_${action}`, payload]); return { ok: true }; };
  store.context.manageCustomerOrder_ = (payload) => { calls.push(['manage_order', payload]); return { ok: true }; };
  store.context.getCustomerOrdersByGroup_ = (payload) => { calls.push(['customer_orders_group', payload]); return { ok: true }; };
  return calls;
}

test('GAS admin privilege gate permits only the current credential version across payload routes', () => {
  const store = fixture();
  store.request(initialWrite);
  const calls = installPrivilegeSpies(store);
  for (const action of ['admin_operation', 'group_snapshot', 'group_join', 'group_transition_payment',
    'group_send_message', 'manage_order', 'customer_orders_group']) {
    for (const adminCredentialVersion of [undefined, null, 0, 2, '1', 1.5]) {
      assert.equal(privilegedRequest(store, action, { adminAssertion: true, adminCredentialVersion }).error, 'stale_admin_credential');
    }
    assert.equal(privilegedRequest(store, action, { adminAssertion: true, adminCredentialVersion: 1 }).ok, true);
  }
  assert.equal(calls.length, 7, 'stale requests must not reach any business handler');
  const reads = store.counters.propertyReads;
  assert.equal(privilegedRequest(store, 'admin_operation', { adminAssertion: true, adminCredentialVersion: 1 }, 'wrong').error, 'unauthorized');
  assert.equal(store.counters.propertyReads, reads, 'the outer token check must precede credential access');
});

test('GAS credential rotation revokes old assertions while exempting only the CAS credential endpoint', () => {
  const store = fixture();
  store.request(initialWrite);
  const calls = installPrivilegeSpies(store);
  assert.equal(privilegedRequest(store, 'admin_operation', { adminAssertion: true, adminCredentialVersion: 1 }).ok, true);
  assert.equal(store.request({ ...initialWrite, expectedVersion: 1, clientMutationId: 'pin-change-next-0002',
    credential: { ...verifier, salt: 'c'.repeat(32), hash: 'd'.repeat(128) } }).ok, true,
  'credential write authenticates in the API and independently enforces CAS');
  assert.equal(privilegedRequest(store, 'admin_operation', { adminAssertion: true, adminCredentialVersion: 1 }).error, 'stale_admin_credential');
  assert.equal(privilegedRequest(store, 'group_transition_payment', { adminAssertion: true }).error, 'stale_admin_credential');
  assert.equal(privilegedRequest(store, 'admin_operation', { adminAssertion: true, adminCredentialVersion: 2 }).ok, true);
  assert.equal(calls.length, 2);
});

test('GAS bootstrap assertions remain compatible only before the first credential is stored', () => {
  const store = fixture();
  const calls = installPrivilegeSpies(store);
  for (const payload of [{ adminAssertion: true }, { adminAssertion: true, adminCredentialVersion: 0 }]) {
    assert.equal(privilegedRequest(store, 'admin_operation', payload).ok, true);
  }
  for (const adminCredentialVersion of [null, '0', 1, -1]) {
    assert.equal(privilegedRequest(store, 'admin_operation', { adminAssertion: true, adminCredentialVersion }).error, 'stale_admin_credential');
  }
  assert.equal(calls.length, 2);
  store.request(initialWrite);
  assert.equal(privilegedRequest(store, 'admin_operation', { adminAssertion: true }).error, 'stale_admin_credential');
  assert.equal(privilegedRequest(store, 'admin_operation', { adminAssertion: true, adminCredentialVersion: 0 }).error, 'stale_admin_credential');
});

test('GAS malformed credential state fails closed for admin assertions without affecting capability routes', () => {
  const store = fixture();
  const calls = installPrivilegeSpies(store);
  store.values.set(key, '{}');
  assert.equal(privilegedRequest(store, 'admin_operation', { adminAssertion: true, adminCredentialVersion: 1 }).error, 'admin_credential_state_invalid');
  assert.equal(privilegedRequest(store, 'group_snapshot', { adminAssertion: true }).error, 'admin_credential_state_invalid');
  assert.equal(calls.length, 0);
  const reads = store.counters.propertyReads;
  assert.equal(privilegedRequest(store, 'group_snapshot', { adminAssertion: false, capabilityHash: 'a'.repeat(64) }).ok, true);
  assert.equal(privilegedRequest(store, 'group_snapshot', { capabilityHash: 'a'.repeat(64) }).ok, true);
  assert.equal(store.counters.propertyReads, reads, 'ordinary participant/host capability authentication is unchanged');
  assert.equal(calls.length, 2);
});
