import test from 'node:test';
import assert from 'node:assert/strict';
import { markGroupRead, getLastReadSeq } from '../src/groupApi.js';
import { runCentralMutation } from '../src/centralMutationQueue.js';
import { adminStore } from './helpers/admin-store.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('poll bursts coalesce read receipts, retain the newest sequence, and let foreground writes proceed', async () => {
  const oldFetch = globalThis.fetch;
  const oldStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)) };
  const groupId = 'customer-read-coalescing';
  const actorId = 'qa-read-coalescing';
  values.set('o2o_mvp_group_credentials_v1', JSON.stringify({ [`${groupId}::${actorId}`]: {
    groupId, actorId, role: 'member', active: true, capabilityToken: 'synthetic-read-key-'.repeat(4),
  } }));
  const started = deferred();
  const release = deferred();
  const sequence = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    sequence.push(body.lastReadSeq);
    if (sequence.length === 1) { started.resolve(); await release.promise; }
    return { ok: true, status: 200, json: async () => ({ ok: true, lastReadSeq: body.lastReadSeq }) };
  };
  try {
    const first = markGroupRead(groupId, 5, actorId);
    await started.promise;
    const repeats = Array.from({ length: 30 }, () => markGroupRead(groupId, 5, actorId));
    const higher = markGroupRead(groupId, 9, actorId);
    const foreground = runCentralMutation(async () => { sequence.push('message'); });
    assert.deepEqual(sequence, [5]);
    release.resolve();
    await Promise.all([first, higher, foreground, ...repeats]);
    assert.deepEqual(sequence, [5, 'message', 9]);
    assert.equal(getLastReadSeq(groupId), 9);
    await markGroupRead(groupId, 7, actorId);
    assert.deepEqual(sequence, [5, 'message', 9]);
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'forbidden' }) });
    await assert.rejects(markGroupRead(groupId, 12, actorId), /forbidden/);
    assert.equal(getLastReadSeq(groupId), 9, 'a rejected receipt must not acknowledge unseen messages');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await markGroupRead(groupId, 12, actorId);
    assert.equal(getLastReadSeq(groupId), 12);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = oldStorage;
  }
});

test('a durable read receipt returns without rebuilding the room or exposing content', () => {
  const { context, data, dealId } = adminStore();
  data.groups.rows[1][7] = 8;
  context.buildGroupSnapshot_ = () => assert.fail('read acknowledgement must not scan the full room');
  const payload = { groupId: dealId, actorId: 'member-test', capabilityHash: 'c'.repeat(64),
    lastReadSeq: 6, clientMutationId: 'qa-compact-read-receipt' };
  const result = context.handleGroupOperation_('mark_read', payload);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.lastReadSeq, 6);
  assert.equal(result.snapshot, undefined);
  assert.equal(context.getParticipantRecord_(data, dealId, 'member-test').lastReadSeq, 6);
  const replay = context.handleGroupOperation_('mark_read', payload);
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.lastReadSeq, 6);
  assert.equal(data.groupHistory.rows.filter((row) => row[10] === payload.clientMutationId).length, 1);
});

test('a cached room still reflects the fresh caller read receipt', () => {
  const { context, dealId } = adminStore();
  context.baseGroupSnapshot_ = () => ({ group: { lastMessageSeq: 10 },
    participants: [{ actorId: 'member-test', lastReadSeq: 1 }], messages: [], history: [] });
  const snapshot = context.buildGroupSnapshot_({}, dealId, { actorId: 'member-test', role: 'member',
    participant: { counted: true, lastReadSeq: 8 } });
  assert.equal(snapshot.viewer.lastReadSeq, 8);
  assert.equal(snapshot.unreadCount, 2);
});
