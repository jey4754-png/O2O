import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelGroupParticipation,
  claimGroupHost,
  createGroupRoom,
  groupOperationRetryCount,
  isGroupBackedDeal,
  joinGroupRoom,
  normalizeSnapshot,
  resolveUnreadCount,
  updateGroupTarget,
} from './groupApi.js';

test('only transient group API failures receive a bounded retry budget', () => {
  assert.equal(groupOperationRetryCount({ status: 503, code: 'collector_busy' }), 2);
  assert.equal(groupOperationRetryCount({ status: 504, code: 'upstream_timeout' }), 1);
  assert.equal(groupOperationRetryCount({ status: 409, code: 'state_conflict' }), 0);
  assert.equal(groupOperationRetryCount({ status: 403, code: 'forbidden' }), 0);
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump() { return JSON.stringify(Object.fromEntries(values)); },
  };
}

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

test('group join automatically retries collector contention with the identical mutation and quantity', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = memoryStorage();
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (payloads.length === 1) {
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
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].clientMutationId, payloads[1].clientMutationId);
    assert.equal(payloads[0].selectedQuantity, payloads[1].selectedQuantity);
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
    version: 3,
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

test('local participation cancellation releases quantity once and returns a cancelled order', async () => {
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
    paymentVersion: 1,
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
    const result = await cancelGroupParticipation(input);
    const member = result.snapshot.participants.find((item) => item.actorId === actorId);
    assert.equal(result.localOnly, true);
    assert.equal(result.snapshot.group.currentCount, 1);
    assert.equal(result.snapshot.group.orderedQuantity, 1);
    assert.equal(result.snapshot.group.version, 5);
    assert.equal(member.selectedQuantity, 0);
    assert.equal(member.counted, false);
    assert.equal(member.version, 4);
    assert.equal(result.order.status, 'cancelled');
    assert.equal(result.order.version, 2);
    assert.equal(result.order.statusHistory.at(-1).action, 'cancel_participation');
    assert.equal(result.snapshot.history.at(-1).orderId, order.id);

    const replay = await cancelGroupParticipation(input);
    assert.equal(replay.snapshot.group.version, 5);
    assert.equal(replay.snapshot.group.currentCount, 1);
    assert.equal(replay.snapshot.history.length, 1);
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
