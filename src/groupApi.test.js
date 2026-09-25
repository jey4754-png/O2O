import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  cancelGroupParticipation,
  claimGroupHost,
  createGroupRoom,
  fetchGroupSnapshot,
  fetchUnreadCounts,
  getGroupCredential,
  getPendingGroupTransition,
  groupOperationRetryCount,
  hasLegacyCustomerGroupRecoveryState,
  isGroupBackedDeal,
  joinGroupRoom,
  normalizeSnapshot,
  recoverLegacyCustomerGroupRoom,
  reserveGroupQuantity,
  resolveUnreadCount,
  rollbackGroupReservation,
  transitionGroupStatus,
  transitionParticipantPayment,
  updateGroupTarget,
} from './groupApi.js';

test('only transient group API failures receive a bounded retry budget', () => {
  assert.equal(groupOperationRetryCount({ status: 408 }), 2);
  assert.equal(groupOperationRetryCount({ status: 425 }), 2);
  assert.equal(groupOperationRetryCount({ status: 429 }), 3);
  assert.equal(groupOperationRetryCount({ status: 500 }), 2);
  assert.equal(groupOperationRetryCount({ status: 503, code: 'collector_busy' }), 3);
  assert.equal(groupOperationRetryCount({ status: 504, code: 'upstream_timeout' }), 2);
  assert.equal(groupOperationRetryCount({ name: 'TypeError' }), 2);
  assert.equal(groupOperationRetryCount({ status: 409, code: 'state_conflict' }), 0);
  assert.equal(groupOperationRetryCount({ status: 409, code: 'collector_busy' }), 0);
  assert.equal(groupOperationRetryCount({ status: 403, code: 'forbidden' }), 0);
  assert.equal(groupOperationRetryCount({ name: 'AbortError' }), 0);
});

test('a response-loss retry replays the frozen group transition instead of advancing twice', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const groupId = 'customer-transition-response-loss';
  const actorId = 'visitor-transition-response-loss';
  const capabilityToken = `group-${'t'.repeat(64)}`;
  const storage = memoryStorage();
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role: 'host',
      active: true,
      capabilityToken,
    },
  }));
  globalThis.localStorage = storage;
  const transitionPayloads = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.action === 'snapshot') {
      const committed = transitionPayloads.length >= 3;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            snapshot: {
              group: {
                groupId,
                status: committed ? 'recruited' : 'recruiting',
                targetCount: 1,
                totalQuantity: 1,
                version: committed ? 2 : 1,
              },
              participants: [{
                actorId,
                role: 'host',
                counted: true,
                selectedQuantity: 1,
                paymentStatus: 'confirmed',
                version: 1,
              }],
            },
          };
        },
      };
    }
    transitionPayloads.push(payload);
    if (transitionPayloads.length <= 3) throw new TypeError('response_lost_after_commit');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          duplicate: true,
          snapshot: {
            group: {
              groupId,
              status: 'recruited',
              targetCount: 1,
              totalQuantity: 1,
              version: 2,
            },
            participants: [{
              actorId,
              role: 'host',
              counted: true,
              selectedQuantity: 1,
              paymentStatus: 'confirmed',
              version: 1,
            }],
          },
        };
      },
    };
  };

  try {
    await assert.rejects(
      transitionGroupStatus(groupId, 'next', actorId),
      (error) => error?.transitionRetryPending === true
        && error?.mutationIntent?.fromStatus === 'recruiting'
        && error?.mutationIntent?.toStatus === 'recruited',
    );
    const pending = getPendingGroupTransition(groupId, actorId);
    assert.equal(pending.fromStatus, 'recruiting');
    assert.equal(pending.toStatus, 'recruited');
    assert.equal(pending.expectedVersion, 1);

    // The refreshed snapshot is already "recruited". A new next transition
    // would target "purchased", but the retained intent must replay the first
    // mutation and receive the server's idempotent duplicate result instead.
    const replay = await transitionGroupStatus(groupId, 'next', actorId);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.snapshot.group.status, 'recruited');
    assert.equal(getPendingGroupTransition(groupId, actorId), null);

    const requestBodies = transitionPayloads.map((payload) => JSON.stringify(payload));
    assert.equal(new Set(requestBodies).size, 1);
    assert.equal(transitionPayloads.at(-1).fromStatus, 'recruiting');
    assert.equal(transitionPayloads.at(-1).toStatus, 'recruited');
    assert.equal(transitionPayloads.at(-1).expectedVersion, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('a retained payment transition replays pending to requested after the snapshot already advanced', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const groupId = 'customer-payment-response-loss';
  const actorId = 'visitor-payment-response-loss';
  const capabilityToken = `group-${'p'.repeat(64)}`;
  const intent = {
    action: 'transition_payment',
    groupId,
    actorId,
    participantActorId: actorId,
    direction: 'next',
    fromStatus: 'pending',
    toStatus: 'requested',
    expectedVersion: 1,
    clientMutationId: 'transition-payment-response-loss',
  };
  const storage = memoryStorage();
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role: 'member',
      active: true,
      capabilityToken,
    },
  }));
  storage.setItem('o2o_mvp_group_transition_mutations_v1', JSON.stringify({
    [`transition_payment::${groupId}::${actorId}::${actorId}`]: intent,
  }));
  globalThis.localStorage = storage;
  let transitionPayload = null;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const snapshot = {
      group: {
        groupId,
        status: 'recruiting',
        targetCount: 1,
        totalQuantity: 1,
        version: 1,
      },
      participants: [{
        actorId,
        role: 'member',
        counted: true,
        selectedQuantity: 1,
        paymentStatus: 'requested',
        version: 2,
      }],
    };
    if (payload.action === 'transition_payment') transitionPayload = payload;
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, duplicate: payload.action === 'transition_payment', snapshot };
      },
    };
  };

  try {
    const replay = await transitionParticipantPayment(groupId, actorId, 'next', actorId, null,
      { expectedFromStatus: 'pending' });
    assert.equal(replay.duplicate, true);
    assert.equal(transitionPayload.clientMutationId, intent.clientMutationId);
    assert.equal(transitionPayload.fromStatus, 'pending');
    assert.equal(transitionPayload.toStatus, 'requested');
    assert.equal(transitionPayload.expectedVersion, 1);
    assert.equal(getPendingGroupTransition(groupId, actorId), null);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

for (const [expectedFromStatus, currentStatus, direction] of [
  ['pending', 'requested', 'next'],
  ['requested', 'confirmed', 'next'],
  ['confirmed', 'requested', 'previous'],
]) {
  test(`a ${expectedFromStatus} payment click cannot become a different ${currentStatus} transition`, async () => {
    const previousStorage = globalThis.localStorage;
    const previousFetch = globalThis.fetch;
    const groupId = `customer-payment-stale-${expectedFromStatus}`;
    const actorId = 'visitor-payment-stale';
    const storage = memoryStorage();
    storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
      [`${groupId}::${actorId}`]: {
        groupId, actorId, role: 'host', active: true, capabilityToken: `group-${'s'.repeat(64)}`,
      },
    }));
    globalThis.localStorage = storage;
    const requests = [];
    const snapshot = {
      group: { groupId, status: 'recruiting', targetCount: 1, totalQuantity: 1, version: 2 },
      participants: [{ actorId, role: 'host', counted: true, selectedQuantity: 1,
        paymentStatus: currentStatus, version: 2 }],
    };
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      return { ok: true, status: 200, json: async () => ({ ok: true, snapshot }) };
    };
    try {
      await assert.rejects(
        transitionParticipantPayment(groupId, actorId, direction, actorId, null, { expectedFromStatus }),
        (error) => error.code === 'state_conflict' && error.status === 409
          && error.snapshot.participants[0].paymentStatus === currentStatus,
      );
      assert.deepEqual(requests.map(({ action }) => action), ['snapshot']);
      assert.equal(getPendingGroupTransition(groupId, actorId), null);

      const currentDirection = currentStatus === 'confirmed' ? 'previous' : 'next';
      await transitionParticipantPayment(groupId, actorId, currentDirection, actorId, null,
        { expectedFromStatus: currentStatus });
      const mutations = requests.filter(({ action }) => action === 'transition_payment');
      assert.equal(mutations.length, 1, 'a fresh user confirmation remains actionable');
      assert.equal(mutations[0].fromStatus, currentStatus);
      assert.equal(mutations[0].toStatus, currentStatus === 'confirmed' ? 'requested' : 'confirmed');
    } finally {
      globalThis.fetch = previousFetch;
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });
}

for (const retainIntent of [false, true]) {
  test(`leaving during the fresh payment read sends no mutation and ${retainIntent ? 'retains the previous intent' : 'creates no intent'}`, async () => {
    const previousStorage = globalThis.localStorage;
    const previousFetch = globalThis.fetch;
    const groupId = `customer-payment-context-${retainIntent}`;
    const actorId = 'visitor-payment-context';
    const storage = memoryStorage();
    storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
      [`${groupId}::${actorId}`]: {
        groupId, actorId, role: 'host', active: true, capabilityToken: `group-${'c'.repeat(64)}`,
      },
    }));
    const intent = {
      action: 'transition_payment', groupId, actorId, participantActorId: actorId,
      direction: 'next', fromStatus: 'pending', toStatus: 'requested', expectedVersion: 1,
      clientMutationId: 'payment-context-existing-intent',
    };
    if (retainIntent) storage.setItem('o2o_mvp_group_transition_mutations_v1', JSON.stringify({
      [`transition_payment::${groupId}::${actorId}::${actorId}`]: intent,
    }));
    globalThis.localStorage = storage;
    const requests = [];
    let releaseRead;
    const readResponse = new Promise((resolve) => { releaseRead = resolve; });
    let notifyRead;
    const reading = new Promise((resolve) => { notifyRead = resolve; });
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      notifyRead();
      await readResponse;
      return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: {
        group: { groupId, status: 'recruiting', targetCount: 1, totalQuantity: 1, version: 2 },
        participants: [{ actorId, role: 'host', counted: true, selectedQuantity: 1,
          paymentStatus: retainIntent ? 'requested' : 'pending', version: retainIntent ? 2 : 1 }],
      } }) };
    };
    let current = true;
    const assertCurrentContext = () => {
      if (!current) throw new Error('operation_context_changed');
    };
    try {
      const result = transitionParticipantPayment(groupId, actorId, 'next', actorId, null,
        { expectedFromStatus: 'pending', assertCurrentContext });
      await reading;
      current = false;
      releaseRead();
      await assert.rejects(result, /operation_context_changed/);
      assert.deepEqual(requests.map(({ action }) => action), ['snapshot']);
      assert.deepEqual(getPendingGroupTransition(groupId, actorId), retainIntent ? intent : null);
      await assert.rejects(transitionParticipantPayment(groupId, actorId, 'next', actorId, null,
        { expectedFromStatus: 'pending', assertCurrentContext }), /operation_context_changed/);
      assert.equal(requests.length, 1, 'an already stale screen cannot start another read');
    } finally {
      releaseRead();
      globalThis.fetch = previousFetch;
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump() { return JSON.stringify(Object.fromEntries(values)); },
  };
}

function writeBlockedStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem() { throw new Error('storage_write_blocked'); },
    removeItem(key) { values.delete(key); },
  };
}

function legacyRecoveryStorage({
  groupId = 'customer-legacy-recovery',
  actorId = 'visitor-legacy-recovery',
  role = 'host',
  snapshotOverrides = {},
} = {}) {
  const storage = memoryStorage();
  const capabilityToken = `group-${'r'.repeat(64)}`;
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role,
      active: false,
      capabilityToken,
    },
  }));
  storage.setItem('o2o_mvp_group_fallback_v1', JSON.stringify({
    [groupId]: {
      localOnly: true,
      group: {
        id: groupId,
        groupId,
        dealId: groupId,
        creatorActorId: actorId,
        hostMode: role === 'creator' ? 'recruiting' : 'self',
        hostActorId: role === 'host' ? actorId : '',
        status: 'recruiting',
        targetCount: 2,
        totalQuantity: 2,
        ...snapshotOverrides.group,
      },
      participants: snapshotOverrides.participants || [{
        actorId,
        role,
        counted: true,
        selectedQuantity: 1,
        paymentStatus: 'pending',
        version: 1,
      }],
      messages: [],
      history: [],
      lastSeq: 0,
    },
  }));
  return { storage, capabilityToken, groupId, actorId };
}

test('legacy customer-group recovery retries one frozen receipt and restores the saved credential', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const fixture = legacyRecoveryStorage();
  const deal = {
    id: fixture.groupId,
    groupId: fixture.groupId,
    source: 'customer',
    title: '과거 공동구매',
  };
  const legacyEventId = 'f81d4fae-7dec-4a45-8a6f-67c6f0f5e123';
  const requestBodies = [];
  globalThis.localStorage = fixture.storage;
  globalThis.fetch = async (_url, options) => {
    requestBodies.push(options.body);
    if (requestBodies.length === 1) {
      return {
        ok: false,
        status: 503,
        async json() { return { ok: false, error: 'collector_busy' }; },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          capabilityToken: fixture.capabilityToken,
          snapshot: {
            group: {
              groupId: fixture.groupId,
              dealId: fixture.groupId,
              creatorActorId: fixture.actorId,
              hostActorId: fixture.actorId,
              hostMode: 'self',
              status: 'recruiting',
              targetCount: 2,
              totalQuantity: 2,
              version: 1,
            },
            participants: [{
              actorId: fixture.actorId,
              role: 'host',
              counted: true,
              selectedQuantity: 1,
              paymentStatus: 'pending',
              version: 1,
            }],
          },
        };
      },
    };
  };

  try {
    assert.equal(hasLegacyCustomerGroupRecoveryState(deal, fixture.actorId), true);
    const result = await recoverLegacyCustomerGroupRoom({
      deal,
      actorId: fixture.actorId,
      nickname: '원 생성자',
      legacyEventId,
    });
    assert.equal(result.snapshot.group.groupId, fixture.groupId);
    assert.equal(requestBodies.length, 2);
    assert.equal(new Set(requestBodies).size, 1);
    const payload = JSON.parse(requestBodies[0]);
    assert.deepEqual(payload, {
      action: 'recover_legacy_customer_group',
      groupId: fixture.groupId,
      dealId: fixture.groupId,
      actorId: fixture.actorId,
      nickname: '원 생성자',
      capabilityToken: fixture.capabilityToken,
      legacyEventId,
    });
    assert.equal(payload.ownerCapabilityToken, undefined);
    assert.equal(payload.clientMutationId, undefined);
    assert.equal(getGroupCredential(fixture.groupId, fixture.actorId).active, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('legacy customer-group recovery rejects missing or non-v4 receipts before any request', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const fixture = legacyRecoveryStorage();
  const deal = {
    id: fixture.groupId,
    groupId: fixture.groupId,
    source: 'customer',
    title: '과거 공동구매',
  };
  let fetchCalls = 0;
  globalThis.localStorage = fixture.storage;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected_request');
  };

  try {
    for (const legacyEventId of [
      '',
      'f81d4fae-7dec-3a45-8a6f-67c6f0f5e123',
      'F81D4FAE-7DEC-4A45-8A6F-67C6F0F5E123',
      'event-1700000000000',
    ]) {
      await assert.rejects(
        () => recoverLegacyCustomerGroupRoom({
          deal,
          actorId: fixture.actorId,
          nickname: '원 생성자',
          legacyEventId,
        }),
        (error) => error?.code === 'legacy_recovery_not_authorized',
      );
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('legacy customer-group recovery rejects forged or mismatched local group state before any request', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const fixture = legacyRecoveryStorage({
    snapshotOverrides: {
      group: { creatorActorId: 'visitor-attacker' },
    },
  });
  const deal = {
    id: fixture.groupId,
    groupId: fixture.groupId,
    source: 'customer',
    title: '과거 공동구매',
  };
  let fetchCalls = 0;
  globalThis.localStorage = fixture.storage;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected_request');
  };

  try {
    assert.equal(hasLegacyCustomerGroupRecoveryState(deal, fixture.actorId), false);
    await assert.rejects(
      () => recoverLegacyCustomerGroupRoom({
        deal,
        actorId: fixture.actorId,
        nickname: '공격자',
        legacyEventId: 'f81d4fae-7dec-4a45-8a6f-67c6f0f5e123',
      }),
      (error) => error?.code === 'legacy_recovery_not_authorized',
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('a remote 404 with a usable local snapshot is marked as a missing central group', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  const storage = memoryStorage();
  const groupId = 'legacy-local-only-group';
  const actorId = 'visitor-legacy-local-only';
  const capabilityToken = `group-${'l'.repeat(64)}`;
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role: 'host',
      active: true,
      capabilityToken,
    },
  }));
  storage.setItem('o2o_mvp_group_fallback_v1', JSON.stringify({
    [groupId]: {
      group: {
        groupId,
        status: 'recruiting',
        targetCount: 2,
        currentCount: 1,
        totalQuantity: 2,
        orderedQuantity: 1,
        version: 1,
      },
      participants: [{
        actorId,
        role: 'host',
        counted: true,
        selectedQuantity: 1,
        version: 1,
      }],
      messages: [],
      history: [],
    },
  }));
  globalThis.localStorage = storage;
  process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = 'true';
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    async json() { return { ok: false, error: 'group_not_found' }; },
  });

  try {
    const snapshot = await fetchGroupSnapshot(groupId, { actorId });
    assert.equal(snapshot.localOnly, true);
    assert.equal(snapshot.centralGroupMissing, true);
    assert.equal(snapshot.group.groupId, groupId);
    assert.equal(getGroupCredential(groupId, actorId).active, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('a transient remote failure uses local fallback without claiming the central group is missing', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  const storage = memoryStorage();
  const groupId = 'temporarily-local-group';
  const actorId = 'visitor-temporarily-local';
  const capabilityToken = `group-${'t'.repeat(64)}`;
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role: 'host',
      active: true,
      capabilityToken,
    },
  }));
  storage.setItem('o2o_mvp_group_fallback_v1', JSON.stringify({
    [groupId]: {
      group: {
        groupId,
        status: 'recruiting',
        targetCount: 2,
        currentCount: 1,
        totalQuantity: 2,
        orderedQuantity: 1,
        version: 1,
      },
      participants: [{
        actorId,
        role: 'host',
        counted: true,
        selectedQuantity: 1,
        version: 1,
      }],
      messages: [],
      history: [],
    },
  }));
  globalThis.localStorage = storage;
  process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = 'true';
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async json() { return { ok: false, error: 'collector_busy' }; },
  });
  const controller = new AbortController();
  controller.abort();

  try {
    const snapshot = await fetchGroupSnapshot(groupId, { actorId, signal: controller.signal });
    assert.equal(snapshot.localOnly, true);
    assert.equal(snapshot.centralGroupMissing, undefined);
    assert.equal(snapshot.group.groupId, groupId);
    assert.equal(getGroupCredential(groupId, actorId).active, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('a permanently missing saved group is disabled after one unread poll', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  const storage = memoryStorage();
  const groupId = 'stale-missing-group';
  const actorId = 'visitor-stale-group';
  const capabilityToken = `group-${'s'.repeat(64)}`;
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role: 'member',
      active: true,
      capabilityToken,
    },
  }));
  globalThis.localStorage = storage;
  delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: false,
      status: 404,
      async json() { return { ok: false, error: 'group_not_found' }; },
    };
  };

  try {
    assert.deepEqual(await fetchUnreadCounts(), { [groupId]: 0 });
    assert.deepEqual(await fetchUnreadCounts(), {});
    assert.equal(fetchCalls, 1);
    const credential = getGroupCredential(groupId, actorId);
    assert.equal(credential.active, false);
    assert.equal(credential.capabilityToken, capabilityToken);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('transient unread polling failures never disable a saved group', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  const storage = memoryStorage();
  const groupId = 'temporarily-unavailable-group';
  const actorId = 'visitor-temporary-group';
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role: 'member',
      active: true,
      capabilityToken: `group-${'t'.repeat(64)}`,
    },
  }));
  globalThis.localStorage = storage;
  delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: false,
      status: 503,
      async json() { return { ok: false, error: 'collector_busy' }; },
    };
  };

  try {
    assert.deepEqual(await fetchUnreadCounts(), { [groupId]: 0 });
    assert.deepEqual(await fetchUnreadCounts(), { [groupId]: 0 });
    assert.equal(fetchCalls, 2);
    assert.equal(getGroupCredential(groupId, actorId).active, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('a stale missing-group response cannot disable a successful rejoin', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  const storage = memoryStorage();
  const groupId = 'rejoined-before-stale-404';
  const actorId = 'visitor-rejoined-before-stale-404';
  const capabilityToken = `group-${'r'.repeat(64)}`;
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role: 'member',
      active: true,
      capabilityToken,
    },
  }));
  globalThis.localStorage = storage;
  delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  let releaseStaleSnapshot;
  let signalSnapshotStarted;
  const snapshotStarted = new Promise((resolve) => { signalSnapshotStarted = resolve; });
  const staleSnapshotReleased = new Promise((resolve) => { releaseStaleSnapshot = resolve; });
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.action === 'snapshot') {
      signalSnapshotStarted();
      await staleSnapshotReleased;
      return {
        ok: false,
        status: 404,
        async json() { return { ok: false, error: 'group_not_found' }; },
      };
    }
    assert.equal(payload.action, 'join');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          capabilityToken,
          snapshot: {
            group: {
              groupId,
              status: 'recruiting',
              targetCount: 2,
              totalQuantity: 2,
              version: 2,
            },
            participants: [{
              actorId,
              role: 'member',
              counted: true,
              selectedQuantity: 1,
              version: 1,
            }],
          },
        };
      },
    };
  };

  try {
    const staleSnapshot = fetchGroupSnapshot(groupId, { actorId });
    await snapshotStarted;
    await joinGroupRoom({
      deal: { id: groupId, title: '재가입 경합 검증', target: 2, totalQuantity: 2 },
      actorId,
      nickname: '재가입자',
      selectedQuantity: 1,
      allowLocalFallback: false,
    });
    releaseStaleSnapshot();
    await assert.rejects(staleSnapshot, /group_not_found/);
    const credential = getGroupCredential(groupId, actorId);
    assert.equal(credential.active, true);
    assert.equal(credential.capabilityToken, capabilityToken);
    assert.equal(credential.credentialRevision, 1);
  } finally {
    releaseStaleSnapshot?.();
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('an older admin 404 cannot override a newer successful snapshot', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  const storage = memoryStorage();
  const groupId = 'admin-overlapping-snapshots';
  const actorId = 'visitor-admin-overlapping-snapshots';
  const capabilityToken = `group-${'a'.repeat(64)}`;
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role: 'admin',
      active: true,
      capabilityToken,
    },
  }));
  globalThis.localStorage = storage;
  delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  let requestCount = 0;
  let releaseOldRequest;
  let signalOldRequestStarted;
  const oldRequestStarted = new Promise((resolve) => { signalOldRequestStarted = resolve; });
  const oldRequestReleased = new Promise((resolve) => { releaseOldRequest = resolve; });
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      signalOldRequestStarted();
      await oldRequestReleased;
      return {
        ok: false,
        status: 404,
        async json() { return { ok: false, error: 'group_not_found' }; },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          snapshot: {
            group: { groupId, status: 'recruiting', targetCount: 2, version: 1 },
            participants: [],
            viewer: { actorId, role: 'admin', active: true },
          },
        };
      },
    };
  };

  try {
    const olderSnapshot = fetchGroupSnapshot(groupId, { actorId });
    await oldRequestStarted;
    await fetchGroupSnapshot(groupId, { actorId });
    releaseOldRequest();
    await assert.rejects(olderSnapshot, /group_not_found/);
    const credential = getGroupCredential(groupId, actorId);
    assert.equal(credential.active, true);
    assert.equal(credential.credentialRevision, 1);
  } finally {
    releaseOldRequest?.();
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('server unreadCount zero overrides lastSeq and local read sequence', () => {
  assert.equal(resolveUnreadCount({ unreadCount: 0, lastSeq: 25 }, 0), 0);
  assert.equal(resolveUnreadCount({ unreadCount: 0, lastSeq: 25 }, 24), 0);
});

test('positive server unreadCount is used without local recomputation', () => {
  assert.equal(resolveUnreadCount({ unreadCount: 7, lastSeq: 100 }, 99), 7);
  assert.equal(resolveUnreadCount({ unreadCount: 7, lastSeq: 2 }, 0), 7);
});

test('lastSeq minus local read sequence remains the fallback when server value is absent', () => {
  assert.equal(resolveUnreadCount({ lastSeq: 10 }, 4), 6);
});

test('group snapshots normalize recruiting hosts and quantity totals authoritatively', () => {
  const snapshot = normalizeSnapshot({
    group: {
      groupId: 'customer-normalized-group',
      status: 'recruiting',
      creatorActorId: 'creator-1',
      hostMode: 'recruiting',
      hostActorId: '',
      hostMatched: true,
      targetCount: 3,
      totalQuantity: 7,
    },
    participants: [
      { actorId: 'creator-1', role: 'creator', counted: true, selectedQuantity: 3 },
      { actorId: 'member-1', role: 'member', counted: true, selectedQuantity: 2 },
      { actorId: 'admin-1', role: 'admin', counted: false, selectedQuantity: 9 },
    ],
  }, 'customer-normalized-group');

  assert.equal(snapshot.group.creatorActorId, 'creator-1');
  assert.equal(snapshot.group.hostMode, 'recruiting');
  assert.equal(snapshot.group.hostMatched, false);
  assert.equal(snapshot.group.totalQuantity, 7);
  assert.equal(snapshot.group.orderedQuantity, 5);
});

test('legacy group snapshots default creator, host mode, and selected quantity safely', () => {
  const snapshot = normalizeSnapshot({
    group: {
      groupId: 'customer-legacy-group',
      hostActorId: 'legacy-host',
      targetCount: 3,
    },
    participants: [
      { actorId: 'legacy-host', role: 'host', counted: true },
      { actorId: 'legacy-admin', role: 'admin', counted: false },
    ],
  }, 'customer-legacy-group');

  assert.equal(snapshot.group.creatorActorId, 'legacy-host');
  assert.equal(snapshot.group.hostMode, 'self');
  assert.equal(snapshot.group.hostMatched, true);
  assert.equal(snapshot.group.totalQuantity, 3);
  assert.equal(snapshot.group.orderedQuantity, 1);
  assert.equal(snapshot.participants[0].selectedQuantity, 1);
  assert.equal(snapshot.participants[1].selectedQuantity, 0);
});

test('merchant group deals share the public deal id with their group room', () => {
  assert.equal(isGroupBackedDeal({ source: 'merchant', saleType: 'group' }), true);
  assert.equal(isGroupBackedDeal({ source: 'merchant', saleType: 'instant' }), false);
  assert.equal(isGroupBackedDeal({ source: 'customer', saleType: 'community' }), true);
});

test('customer group local fallback rejects zero-quantity member joins', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  globalThis.localStorage = memoryStorage();
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = 'true';
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    async json() { return { ok: false, error: 'group_not_found' }; },
  });

  const deal = {
    id: 'customer-zero-quantity-guard',
    source: 'customer',
    title: '0개 참여 차단 공구',
    target: 3,
    totalQuantity: 5,
    creatorQuantity: 1,
  };
  try {
    await createGroupRoom({ deal, actorId: 'visitor-zero-host', nickname: '생성자' });
    await assert.rejects(() => joinGroupRoom({
      deal,
      actorId: 'visitor-zero-member',
      nickname: '비참여자',
      selectedQuantity: 0,
    }), /invalid_quantity/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = previousCustomEvent;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('reservation rollback releases a failed join once and supports a clean retry', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  globalThis.localStorage = memoryStorage();
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = 'true';
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    async json() { return { ok: false, error: 'group_not_found' }; },
  });

  const deal = {
    id: 'customer-reservation-rollback-local',
    source: 'customer',
    title: '예약 보상 테스트',
    target: 4,
    totalQuantity: 6,
    creatorQuantity: 1,
  };
  const actorId = 'visitor-reservation-rollback-local';
  const joinMutationId = 'join-reservation-rollback-local';
  try {
    await createGroupRoom({ deal, actorId: 'visitor-reservation-host', nickname: '생성자' });
    const joined = await joinGroupRoom({
      deal,
      actorId,
      nickname: '참여자',
      selectedQuantity: 2,
      clientMutationId: joinMutationId,
    });
    assert.equal(joined.snapshot.group.orderedQuantity, 3);

    const rolledBack = await rollbackGroupReservation(
      deal.id,
      2,
      actorId,
      joinMutationId,
      'rollback-reservation-local-one',
      { allowLocalFallback: true },
    );
    const inactive = rolledBack.snapshot.participants.find((item) => item.actorId === actorId);
    assert.equal(rolledBack.snapshot.group.orderedQuantity, 1);
    assert.equal(inactive.selectedQuantity, 0);
    assert.equal(inactive.counted, false);

    const replay = await rollbackGroupReservation(
      deal.id,
      2,
      actorId,
      joinMutationId,
      'rollback-reservation-local-two',
      { allowLocalFallback: true },
    );
    assert.equal(replay.snapshot.group.orderedQuantity, 1);
    assert.equal(replay.snapshot.participants.find((item) => item.actorId === actorId).version, inactive.version);

    const reserved = await reserveGroupQuantity(
      deal.id,
      2,
      actorId,
      'reserve-after-rollback-local',
      { allowLocalFallback: true },
    );
    const reactivated = reserved.snapshot.participants.find((item) => item.actorId === actorId);
    assert.equal(reactivated.counted, true);
    assert.equal(reactivated.selectedQuantity, 2);
    assert.equal(reserved.snapshot.group.orderedQuantity, 3);

    const secondRollback = await rollbackGroupReservation(
      deal.id,
      2,
      actorId,
      'reserve-after-rollback-local',
      'rollback-reactivated-reserve-local',
      { allowLocalFallback: true },
    );
    const inactiveAgain = secondRollback.snapshot.participants.find((item) => item.actorId === actorId);
    assert.equal(inactiveAgain.counted, false);
    assert.equal(inactiveAgain.selectedQuantity, 0);
    assert.equal(secondRollback.snapshot.group.orderedQuantity, 1);

    await reserveGroupQuantity(
      deal.id,
      2,
      actorId,
      'reserve-multi-local-a',
      { allowLocalFallback: true },
    );
    await reserveGroupQuantity(
      deal.id,
      3,
      actorId,
      'reserve-multi-local-b',
      { allowLocalFallback: true },
    );
    const firstMultiRollback = await rollbackGroupReservation(
      deal.id,
      2,
      actorId,
      'reserve-multi-local-a',
      'rollback-multi-local-a',
      { allowLocalFallback: true },
    );
    assert.equal(
      firstMultiRollback.snapshot.participants.find((item) => item.actorId === actorId).counted,
      true,
    );
    const finalMultiRollback = await rollbackGroupReservation(
      deal.id,
      3,
      actorId,
      'reserve-multi-local-b',
      'rollback-multi-local-b',
      { allowLocalFallback: true },
    );
    const fullyReleased = finalMultiRollback.snapshot.participants.find((item) => item.actorId === actorId);
    assert.equal(fullyReleased.selectedQuantity, 0);
    assert.equal(fullyReleased.counted, false);
    assert.equal(finalMultiRollback.snapshot.group.orderedQuantity, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = previousCustomEvent;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('host claim without an existing paid participant credential does not create a zero-quantity member', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const storage = memoryStorage();
  let fetchCalls = 0;
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected_network_call');
  };

  try {
    await assert.rejects(() => claimGroupHost({
      deal: {
        id: 'merchant-host-without-order',
        source: 'merchant',
        saleType: 'group',
      },
      actorId: 'visitor-without-order',
    }), /host_order_required/);
    assert.equal(fetchCalls, 0);
    assert.equal(storage.dump().includes('visitor-without-order'), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('merchant group join can provision a matching local room fallback', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  globalThis.localStorage = memoryStorage();
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = 'true';
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    async json() { return { ok: false, error: 'group_not_found' }; },
  });

  const deal = {
    id: 'owner-merchant-room-fallback',
    source: 'merchant',
    saleType: 'group',
    title: '사과 공동구매',
    target: 50,
    totalQuantity: 50,
  };
  try {
    const result = await joinGroupRoom({
      deal,
      actorId: 'visitor-merchant-room',
      nickname: '참여자',
      selectedQuantity: 4,
      clientMutationId: 'checkout-merchant-room-fallback',
    });
    assert.equal(result.snapshot.group.groupId, deal.id);
    assert.equal(result.snapshot.group.targetCount, 20);
    assert.equal(result.snapshot.group.currentCount, 1);
    assert.equal(result.snapshot.group.orderedQuantity, 4);
    assert.equal(result.snapshot.group.hostMode, 'recruiting');
    assert.equal(result.snapshot.participants[0].role, 'member');
    const replay = await joinGroupRoom({
      deal,
      actorId: 'visitor-merchant-room',
      nickname: '참여자',
      selectedQuantity: 4,
      clientMutationId: 'checkout-merchant-room-fallback',
    });
    assert.equal(replay.snapshot.group.orderedQuantity, 4);
    assert.equal(replay.snapshot.participants.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = previousCustomEvent;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('주문·게시 트랜잭션은 중앙 실패를 로컬 성공으로 바꾸지 않는다', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = 'true';
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    async json() { return { ok: false, error: 'group_not_found' }; },
  });

  const merchantDeal = {
    id: 'merchant-central-only-transaction',
    source: 'merchant',
    saleType: 'group',
    title: '중앙 전용 공구',
    target: 5,
    totalQuantity: 10,
  };
  const customerDeal = {
    id: 'customer-central-only-publish',
    source: 'customer',
    title: '중앙 전용 게시',
    target: 3,
    totalQuantity: 6,
    creatorQuantity: 1,
  };
  try {
    await assert.rejects(() => joinGroupRoom({
      deal: merchantDeal,
      actorId: 'visitor-central-only',
      nickname: '참여자',
      selectedQuantity: 2,
      clientMutationId: 'checkout-central-only-transaction',
      allowLocalFallback: false,
    }), /group_not_found/);
    await assert.rejects(() => createGroupRoom({
      deal: customerDeal,
      actorId: 'visitor-central-only-host',
      nickname: '생성자',
      clientMutationId: 'create-customer-central-only-publish',
      allowLocalFallback: false,
    }), /group_not_found/);
    const stored = JSON.parse(storage.dump());
    assert.equal(stored.o2o_mvp_group_credentials_v1, undefined);
    assert.equal(stored.o2o_mvp_group_fallback_v1, undefined);
    assert.equal(storage.dump().includes('local-'), false);
    // The random pending capability is intentionally retained so a response-
    // loss retry cannot mint or steal a different membership credential.
    assert.match(stored.o2o_mvp_group_membership_mutations_v1, /capabilityToken/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('group creation retries reuse the same membership mutation id after a lost response', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = memoryStorage();
  const payloads = [];
  let attempt = 0;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    attempt += 1;
    if (attempt === 1) throw new Error('network_response_lost');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          capabilityToken: `capability-${'x'.repeat(64)}`,
          snapshot: {
            group: {
              groupId: payload.groupId,
              status: 'recruiting',
              targetCount: payload.targetCount,
              totalQuantity: payload.totalQuantity,
              hostMode: payload.hostMode,
              hostActorId: payload.actorId,
              version: 1,
            },
            participants: [{
              actorId: payload.actorId,
              role: 'host',
              counted: true,
              selectedQuantity: payload.selectedQuantity,
              version: 1,
            }],
          },
        };
      },
    };
  };

  const input = {
    deal: { id: 'customer-retry-test', title: '재시도 테스트', target: 3, totalQuantity: 7, creatorQuantity: 2 },
    actorId: 'visitor-retry-test',
    nickname: '테스트 호스트',
  };
  try {
    await assert.rejects(createGroupRoom(input), /network_response_lost/);
    const result = await createGroupRoom(input);
    assert.equal(result.snapshot.group.hostActorId, input.actorId);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].clientMutationId, payloads[1].clientMutationId);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('successful create and join keep credentials usable when localStorage writes are blocked', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = writeBlockedStorage();
  const payloads = [];
  const creatorToken = `create-capability-${'c'.repeat(64)}`;
  const memberToken = `join-capability-${'j'.repeat(64)}`;
  const deal = {
    id: 'customer-memory-credential-fallback',
    source: 'customer',
    title: '메모리 자격 증명 테스트',
    target: 3,
    totalQuantity: 5,
    creatorQuantity: 1,
  };
  const roleFor = (actorId) => (actorId === 'visitor-memory-creator' ? 'host' : 'member');
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    const role = roleFor(payload.actorId);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          ...(['create', 'join'].includes(payload.action)
            ? { capabilityToken: role === 'host' ? creatorToken : memberToken }
            : {}),
          snapshot: {
            group: {
              groupId: deal.id,
              status: 'recruiting',
              targetCount: deal.target,
              totalQuantity: deal.totalQuantity,
              hostMode: 'self',
              hostActorId: 'visitor-memory-creator',
              version: 2,
            },
            participants: [{
              actorId: payload.actorId,
              role,
              counted: true,
              selectedQuantity: 1,
              version: 1,
            }],
          },
        };
      },
    };
  };

  try {
    await createGroupRoom({
      deal,
      actorId: 'visitor-memory-creator',
      nickname: '생성자',
      clientMutationId: 'create-memory-credential-fallback',
      allowLocalFallback: false,
    });
    assert.equal(
      getGroupCredential(deal.id, 'visitor-memory-creator')?.capabilityToken,
      creatorToken,
    );
    await fetchGroupSnapshot(deal.id, {
      actorId: 'visitor-memory-creator',
      allowLocalFallback: false,
    });
    assert.equal(payloads.at(-1).capabilityToken, creatorToken);

    await joinGroupRoom({
      deal,
      actorId: 'visitor-memory-member',
      nickname: '참여자',
      selectedQuantity: 1,
      clientMutationId: 'join-memory-credential-fallback',
      allowLocalFallback: false,
    });
    assert.equal(
      getGroupCredential(deal.id, 'visitor-memory-member')?.capabilityToken,
      memberToken,
    );
    await fetchGroupSnapshot(deal.id, {
      actorId: 'visitor-memory-member',
      allowLocalFallback: false,
    });
    assert.equal(payloads.at(-1).capabilityToken, memberToken);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('a response-loss retry keeps the pending capability hash when localStorage writes fail', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = writeBlockedStorage();
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (payloads.length === 1) throw new Error('commit_response_lost');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          capabilityToken: payload.capabilityToken,
          snapshot: {
            group: {
              groupId: payload.groupId,
              status: 'recruiting',
              targetCount: 3,
              totalQuantity: 5,
              version: 2,
            },
            participants: [{
              actorId: payload.actorId,
              role: 'member',
              counted: true,
              selectedQuantity: payload.selectedQuantity,
              version: 1,
            }],
          },
        };
      },
    };
  };

  const input = {
    deal: { id: 'customer-memory-attempt-retry', source: 'customer' },
    actorId: 'visitor-memory-attempt-retry',
    nickname: '응답 유실 참여자',
    selectedQuantity: 2,
    clientMutationId: 'join-memory-attempt-retry',
    allowLocalFallback: false,
  };
  try {
    await assert.rejects(joinGroupRoom(input), /commit_response_lost/);
    await joinGroupRoom(input);

    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].clientMutationId, payloads[1].clientMutationId);
    assert.equal(payloads[0].capabilityToken, payloads[1].capabilityToken);
    assert.equal(
      createHash('sha256').update(payloads[0].capabilityToken).digest('hex'),
      createHash('sha256').update(payloads[1].capabilityToken).digest('hex'),
    );
    assert.equal(
      getGroupCredential(input.deal.id, input.actorId)?.capabilityToken,
      payloads[0].capabilityToken,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('join resumes the persisted mutation and capability after a page reload changes the UI mutation id', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = memoryStorage();
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (payloads.length === 1) throw new Error('commit_response_lost');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          capabilityToken: payload.capabilityToken,
          snapshot: {
            group: {
              groupId: payload.groupId,
              status: 'recruiting',
              targetCount: 5,
              totalQuantity: 5,
              version: 2,
            },
            participants: [{
              actorId: payload.actorId,
              role: 'member',
              counted: true,
              selectedQuantity: payload.selectedQuantity,
              version: 1,
            }],
          },
        };
      },
    };
  };

  const common = {
    deal: { id: 'owner-reload-response-loss', source: 'merchant', saleType: 'group' },
    actorId: 'visitor-reload-response-loss',
    nickname: '재접속 참여자',
    selectedQuantity: 1,
    allowLocalFallback: false,
  };
  try {
    await assert.rejects(() => joinGroupRoom({
      ...common,
      clientMutationId: 'join-before-page-reload-1234',
    }), /commit_response_lost/);
    await joinGroupRoom({
      ...common,
      clientMutationId: 'join-after-page-reload-5678',
    });

    assert.equal(payloads.length, 2);
    assert.equal(payloads[1].clientMutationId, payloads[0].clientMutationId);
    assert.equal(payloads[1].capabilityToken, payloads[0].capabilityToken);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('group creation accepts a workflow-stable mutation id across separate submit attempts', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = memoryStorage();
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          duplicate: payloads.length > 1,
          capabilityToken: `capability-${'s'.repeat(64)}`,
          snapshot: {
            group: {
              groupId: payload.groupId,
              status: 'recruiting',
              targetCount: payload.targetCount,
              totalQuantity: payload.totalQuantity,
              hostMode: payload.hostMode,
              hostActorId: payload.actorId,
              version: 1,
            },
            participants: [{
              actorId: payload.actorId,
              role: 'host',
              counted: true,
              selectedQuantity: payload.selectedQuantity,
              version: 1,
            }],
          },
        };
      },
    };
  };

  const input = {
    deal: { id: 'customer-workflow-retry', title: '게시 재시도', target: 3, totalQuantity: 6, creatorQuantity: 2 },
    actorId: 'visitor-workflow-retry',
    nickname: '재시도 호스트',
    clientMutationId: 'create-customer-workflow-retry',
  };
  try {
    await createGroupRoom(input);
    await createGroupRoom(input);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].clientMutationId, input.clientMutationId);
    assert.equal(payloads[1].clientMutationId, input.clientMutationId);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('group join retries network loss and collector contention with an identical request body', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = memoryStorage();
  const payloads = [];
  const requestBodies = [];
  globalThis.fetch = async (_url, options) => {
    requestBodies.push(options.body);
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (payloads.length === 1) {
      throw new TypeError('Failed to fetch');
    }
    if (payloads.length === 2) {
      return {
        ok: false,
        status: 503,
        async json() { return { ok: false, error: 'collector_busy' }; },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          capabilityToken: `capability-${'r'.repeat(64)}`,
          snapshot: {
            group: {
              groupId: payload.groupId,
              status: 'recruiting',
              targetCount: 5,
              totalQuantity: 10,
              orderedQuantity: payload.selectedQuantity,
              version: 2,
            },
            participants: [{
              actorId: payload.actorId,
              role: 'member',
              counted: true,
              selectedQuantity: payload.selectedQuantity,
              version: 1,
            }],
          },
        };
      },
    };
  };

  try {
    const result = await joinGroupRoom({
      deal: { id: 'customer-collector-retry', source: 'customer' },
      actorId: 'visitor-collector-retry',
      nickname: '재시도 참여자',
      selectedQuantity: 3,
      clientMutationId: 'checkout-collector-retry-1234',
    });
    assert.equal(result.snapshot.group.orderedQuantity, 3);
    assert.equal(payloads.length, 3);
    assert.equal(requestBodies[0], requestBodies[1]);
    assert.equal(requestBodies[1], requestBodies[2]);
    assert.equal(payloads[0].clientMutationId, payloads[2].clientMutationId);
    assert.equal(payloads[0].selectedQuantity, payloads[2].selectedQuantity);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('target updates preserve the version captured when the edit form opened', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    'customer-target-version::visitor-target-version': {
      groupId: 'customer-target-version',
      actorId: 'visitor-target-version',
      role: 'host',
      capabilityToken: `capability-${'v'.repeat(64)}`,
    },
  }));
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          snapshot: {
            group: {
              groupId: payload.groupId,
              status: 'recruiting',
              targetCount: payload.action === 'update_target' ? payload.targetCount : 3,
              currentCount: 1,
              totalQuantity: 3,
              orderedQuantity: 1,
              version: payload.action === 'update_target' ? 5 : 9,
            },
            participants: [{
              actorId: payload.actorId,
              role: 'host',
              counted: true,
              selectedQuantity: 1,
              version: 1,
            }],
          },
        };
      },
    };
  };

  try {
    await updateGroupTarget('customer-target-version', 5, 'visitor-target-version', 4);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].action, 'snapshot');
    assert.equal(payloads[1].action, 'update_target');
    assert.equal(payloads[1].targetCount, 5);
    assert.equal(payloads[1].expectedVersion, 4);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('participation cancellation forwards scoped proofs and authoritative versions', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  const groupCapabilityToken = `group-capability-${'g'.repeat(48)}`;
  const customerCapabilityToken = `customer-capability-${'c'.repeat(48)}`;
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    'customer-cancel-remote::visitor-cancel-remote': {
      groupId: 'customer-cancel-remote',
      actorId: 'visitor-cancel-remote',
      role: 'member',
      capabilityToken: groupCapabilityToken,
    },
  }));
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    const cancelled = payload.action === 'cancel_participation';
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          ...(cancelled ? {
            order: {
              id: payload.orderId,
              status: 'cancelled',
              version: payload.expectedOrderVersion + 1,
            },
          } : {}),
          snapshot: {
            group: {
              groupId: payload.groupId,
              status: 'recruiting',
              targetCount: 4,
              currentCount: cancelled ? 1 : 2,
              totalQuantity: 8,
              orderedQuantity: cancelled ? 1 : 3,
              version: cancelled ? 8 : 7,
            },
            participants: [
              {
                actorId: 'visitor-host-remote',
                role: 'host',
                counted: true,
                paymentStatus: 'pending',
                selectedQuantity: 1,
                version: 1,
              },
              {
                actorId: payload.actorId,
                role: 'member',
                counted: !cancelled,
                paymentStatus: 'pending',
                selectedQuantity: cancelled ? 0 : 2,
                version: cancelled ? 5 : 4,
              },
            ],
          },
        };
      },
    };
  };

  const order = {
    id: 'order-170000000000001',
    type: 'purchase',
    groupId: 'customer-cancel-remote',
    dealId: 'customer-cancel-remote',
    visitorId: 'visitor-cancel-remote',
    status: 'new',
    paymentStatus: 'pending',
    selectedCount: 2,
    version: 1,
    paymentVersion: 3,
  };
  try {
    const result = await cancelGroupParticipation({
      groupId: order.groupId,
      order,
      actorId: order.visitorId,
      customerCapabilityToken,
      clientMutationId: 'cancel-participation-remote-test',
    });

    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].action, 'snapshot');
    assert.equal(payloads[1].action, 'cancel_participation');
    assert.equal(payloads[1].capabilityToken, groupCapabilityToken);
    assert.equal(payloads[1].customerCapabilityToken, customerCapabilityToken);
    assert.equal(payloads[1].orderId, order.id);
    assert.equal(payloads[1].expectedVersion, 4);
    assert.equal(payloads[1].expectedOrderVersion, 3);
    assert.equal(payloads[1].order, undefined);
    assert.equal(result.snapshot.group.currentCount, 1);
    assert.equal(result.snapshot.group.orderedQuantity, 1);
    assert.equal(result.order.status, 'cancelled');
    assert.equal(storage.dump().includes(customerCapabilityToken), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('participation cancellation fails closed offline and leaves browser state unchanged', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = 'true';
  globalThis.fetch = async () => { throw new Error('offline'); };
  const groupId = 'customer-cancel-local';
  const actorId = 'visitor-cancel-local';
  const customerCapabilityToken = `customer-capability-${'l'.repeat(48)}`;
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${groupId}::${actorId}`]: {
      groupId,
      actorId,
      role: 'member',
      capabilityToken: `group-capability-${'m'.repeat(48)}`,
    },
  }));
  storage.setItem('o2o_mvp_group_fallback_v1', JSON.stringify({
    [groupId]: {
      localOnly: true,
      group: {
        groupId,
        status: 'recruiting',
        targetCount: 4,
        currentCount: 2,
        totalQuantity: 8,
        orderedQuantity: 3,
        version: 4,
      },
      participants: [
        {
          actorId: 'visitor-host-local',
          role: 'host',
          counted: true,
          paymentStatus: 'pending',
          selectedQuantity: 1,
          version: 1,
        },
        {
          actorId,
          role: 'member',
          counted: true,
          paymentStatus: 'pending',
          selectedQuantity: 2,
          version: 3,
        },
      ],
      messages: [],
      history: [],
      lastSeq: 0,
    },
  }));
  const order = {
    id: 'order-170000000000002',
    type: 'purchase',
    groupId,
    dealId: groupId,
    visitorId: actorId,
    status: 'new',
    paymentStatus: 'pending',
    selectedCount: 2,
    version: 1,
    paymentVersion: 3,
    statusHistory: [],
  };
  const input = {
    groupId,
    order,
    actorId,
    customerCapabilityToken,
    clientMutationId: 'cancel-participation-local-test',
  };

  try {
    const before = storage.getItem('o2o_mvp_group_fallback_v1');
    await assert.rejects(
      () => cancelGroupParticipation(input),
      /offline/,
    );
    assert.equal(storage.getItem('o2o_mvp_group_fallback_v1'), before);
    assert.equal(storage.dump().includes(customerCapabilityToken), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = previousCustomEvent;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
});

test('unread polling skips the visible room, retains badges on failure and resumes after recovery', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const storage = memoryStorage();
  const actorId = 'visitor-poll-load';
  const credentials = Object.fromEntries(['open-room', 'other-room'].map((groupId) => [`${groupId}::${actorId}`, {
    groupId, actorId, role: 'member', active: true, capabilityToken: `group-${'u'.repeat(64)}`,
  }]));
  storage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify(credentials));
  globalThis.localStorage = storage;
  const calls = [];
  let unavailable = true;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.groupId);
    return { ok: !unavailable, status: unavailable ? 503 : 200,
      json: async () => unavailable ? { ok: false, error: 'collector_busy' } : {
        ok: true, snapshot: { group: { groupId: body.groupId }, lastSeq: 4, messages: [], participants: [], history: [] },
      },
    };
  };
  try {
    let errors = 0;
    const counts = await fetchUnreadCounts({ skipGroupId: 'open-room', previousCounts: { 'other-room': 3 }, onError: () => errors++ });
    assert.deepEqual(counts, { 'open-room': 0, 'other-room': 3 });
    assert.deepEqual(calls, ['other-room']);
    assert.equal(errors, 1);
    unavailable = false;
    await fetchUnreadCounts();
    assert.deepEqual(calls, ['other-room', 'open-room', 'other-room']);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
  }
});
