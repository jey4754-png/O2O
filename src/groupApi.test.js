import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGroupRoom,
  normalizeSnapshot,
  resolveUnreadCount,
  updateGroupTarget,
} from './groupApi.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
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
