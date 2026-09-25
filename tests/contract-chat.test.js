import test from 'node:test';
import assert from 'node:assert/strict';
import { adminStore } from './helpers/admin-store.js';

function fixture() {
  const store = adminStore();
  const { context, data, dealId: groupId } = store;
  context.CacheService = { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) };
  data.groupParticipants.rows.push([groupId, 'host-test', '호스트', 'host', true, 'pending', 0, 'd'.repeat(64), 1, '', '', 1]);
  let mutation = 0;
  const call = (action, actorId, extra = {}) => context.handleGroupOperation_(action, {
    groupId, actorId, capabilityHash: (actorId === 'host-test' ? 'd' : 'c').repeat(64),
    ...(actorId === 'operator_admin' ? { adminAssertion: true } : {}),
    clientMutationId: `contract-chat-${++mutation}`, ...extra,
  });
  return { ...store, groupId, call };
}

test('A-03: locked chat blocks host and member, preserves history, and permits administrator messages and unlock', () => {
  const { call, context, data, groupId } = fixture();
  assert.equal(call('send_message', 'host-test', { body: 'before lock' }).ok, true);
  let version = context.getGroupRecord_(data, groupId).version;
  const lock = call('toggle_lock', 'operator_admin', { locked: true, expectedVersion: version });
  assert.equal(lock.ok, true, lock.error);
  for (const actor of ['host-test', 'member-test']) {
    const denied = call('send_message', actor, { body: 'blocked message' });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'chat_locked');
    const cannotUnlock = call('toggle_lock', actor, { locked: false, expectedVersion: version + 1 });
    assert.equal(cannotUnlock.ok, false);
    assert.equal(cannotUnlock.error, 'forbidden');
  }
  const admin = call('send_message', 'operator_admin', { body: '운영 안내' });
  assert.equal(admin.ok, true, admin.error);
  assert.deepEqual(Array.from(admin.snapshot.messages, (message) => message.body), ['before lock', '운영 안내']);
  assert.equal(admin.snapshot.group.currentCount, 2, 'administrator must not count toward capacity');
  version = context.getGroupRecord_(data, groupId).version;
  assert.equal(call('toggle_lock', 'operator_admin', { locked: false, expectedVersion: version }).ok, true);
  assert.equal(call('send_message', 'host-test', { body: 'after unlock' }).ok, true);
});

test('A-02: central chat retains all records while snapshots isolate groups and expose only latest 100', () => {
  const { call, data, context, groupId } = fixture();
  for (let i = 1; i <= 105; i++) {
    const result = call('send_message', 'host-test', { body: `message-${i}` });
    assert.equal(result.ok, true, result.error);
  }
  data.groupChat.rows.push(['other-group', 999, 'other-message', 'someone', 'other', 'member', 'must not leak', new Date().toISOString(), 'other-mutation']);
  const result = call('snapshot', 'member-test');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.snapshot.messages.length, 100);
  assert.equal(result.snapshot.messages[0].body, 'message-6');
  assert.equal(result.snapshot.messages.at(-1).body, 'message-105');
  assert.equal(data.groupChat.rows.length, 107);
  assert.ok(result.snapshot.messages.every((m) => m.nickname && m.createdAt && m.actorId === 'host-test'));
  assert.equal(context.getGroupRecord_(data, groupId).lastMessageSeq, 105);
});
