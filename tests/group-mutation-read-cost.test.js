import test from 'node:test';
import assert from 'node:assert/strict';
import { adminStore } from './helpers/admin-store.js';

function hostPaymentFixture(pastReads = 0) {
  const { context, data, dealId } = adminStore();
  const order = JSON.parse(data.customerOrders.rows[1][3]);
  Object.assign(order, { paymentStatus: 'pending', paymentConfirmedAt: '', quantity: 1,
    selectedCount: 1, reservationQuantity: 1, _reservationQuantity: 1,
    total: 3340, unitPrice: 3338, hostRemainderApplied: 2 });
  data.customerOrders.rows[1][3] = JSON.stringify(order);
  data.groupParticipants.rows[1][3] = 'host';
  data.groupParticipants.rows[1][5] = 'pending';
  data.groupParticipants.rows[1][11] = 1;
  data.groups.rows[1][6] = 'member-test';
  const reservation = JSON.parse(data.groupHistory.rows[1][13]);
  reservation.mutationContract = JSON.stringify({ selectedQuantity: 1 });
  data.groupHistory.rows[1][13] = JSON.stringify(reservation);
  for (let index = 0; index < pastReads; index += 1) {
    context.appendGroupHistory_(data, { groupId: dealId, action: 'mark_read',
      actorId: 'member-test', entityId: 'member-test', clientMutationId: `synthetic-mark-read-${index}`,
      result: { pending: false } });
  }
  const payload = { groupId: dealId, actorId: 'member-test', participantActorId: 'member-test',
    capabilityHash: 'c'.repeat(64), direction: 'next', fromStatus: 'pending', toStatus: 'requested',
    expectedVersion: 2, clientMutationId: 'synthetic-host-payment-001' };
  return { context, data, dealId, payload };
}

test('a message checks the published product once while retaining durable replay and fresh permissions', () => {
  const { context, data, dealId } = hostPaymentFixture();
  let locked = false;
  let productLookups = 0;
  context.acquireScriptLock_ = () => { locked = true; return { releaseLock() { locked = false; } }; };
  const getRange = data.publicDeals.getRange.bind(data.publicDeals);
  data.publicDeals.getRange = (...args) => {
    const range = getRange(...args);
    const finder = range.createTextFinder.bind(range);
    range.createTextFinder = (...query) => {
      const result = finder(...query);
      const find = result.findNext;
      result.findNext = () => { if (locked) productLookups++; return find(); };
      return result;
    };
    return range;
  };
  const payload = { groupId: dealId, actorId: 'member-test', capabilityHash: 'c'.repeat(64),
    body: 'Synthetic single product lookup', clientMutationId: 'single-product-message-001' };
  const sent = context.handleGroupOperation_('send_message', payload);
  assert.equal(sent.ok, true, sent.error);
  assert.equal(productLookups, 1);
  assert.equal(sent.snapshot.messages.length, 1);
  const replay = context.handleGroupOperation_('send_message', payload);
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.snapshot.messages.length, 1);
  data.groupParticipants.rows[1][7] = 'd'.repeat(64);
  const rejected = context.handleGroupOperation_('send_message', { ...payload,
    clientMutationId: 'single-product-revoked-001' });
  assert.equal(rejected.error, 'invalid_capability');
  assert.equal(data.groupChat.rows.length, 2);
});

test('host payment with 250 completed read receipts avoids one locked remote read per receipt', () => {
  const { context, data, payload } = hostPaymentFixture(250);
  let locked = false;
  let lockedReads = 0;
  context.acquireScriptLock_ = () => { locked = true; return { releaseLock() { locked = false; } }; };
  for (const sheet of Object.values(data)) {
    const original = sheet.getRange.bind(sheet);
    sheet.getRange = (...args) => {
      const range = original(...args);
      for (const method of ['getValue', 'getValues']) {
        const read = range[method].bind(range);
        range[method] = (...rest) => { if (locked) lockedReads += 1; return read(...rest); };
      }
      return range;
    };
  }
  const result = context.handleGroupOperation_('transition_payment', payload);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.order.paymentStatus, 'requested');
  assert.equal(result.order.total, 3340);
  assert.equal(result.order.hostRemainderApplied, 2);
  assert.equal(result.snapshot.participants[0].paymentStatus, 'requested');
  assert.ok(lockedReads <= 25, `expected bounded reads under the script lock, received ${lockedReads}`);
  const replay = context.handleGroupOperation_('transition_payment', payload);
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.order.version, result.order.version);
});

test('pending repair batches preserve group scope, row order, and fresh state on the next invocation', () => {
  const { context, data, dealId } = hostPaymentFixture();
  const append = (groupId, suffix) => context.appendGroupHistory_(data, {
    groupId, action: 'mark_read', actorId: 'member-test', entityId: 'member-test',
    clientMutationId: `synthetic-pending-${suffix}`,
    result: { pending: true, repair: { operations: [] }, completionResult: { marker: suffix } },
  });
  const first = append(dealId, 'first');
  const neighbor = append('customer-unrelated-group', 'neighbor');
  const last = append(dealId, 'last');
  const repaired = [];
  const original = context.repairPendingGroupMutation_;
  context.repairPendingGroupMutation_ = (sheets, mutation) => {
    repaired.push(mutation.rowNumber);
    return original(sheets, mutation);
  };
  context.repairPendingGroupMutations_(data, dealId);
  assert.deepEqual(repaired, [first, last]);
  assert.equal(JSON.parse(data.groupHistory.rows[neighbor - 1][13]).pending, true);
  context.repairPendingGroupMutations_(data, dealId);
  assert.deepEqual(repaired, [first, last], 'completed intents must not be replayed from stale cached data');
  const next = append(dealId, 'new');
  context.repairPendingGroupMutations_(data, dealId);
  assert.deepEqual(repaired, [first, last, next]);
});

test('an unreadable pending-intent batch stops payment before any participant or order change', () => {
  const { context, data, payload } = hostPaymentFixture(4);
  const beforeOrder = data.customerOrders.rows[1][3];
  const beforeParticipant = [...data.groupParticipants.rows[1]];
  const getRange = data.groupHistory.getRange.bind(data.groupHistory);
  data.groupHistory.getRange = (...args) => {
    if (args[1] === 14) return { getValues() { throw new Error('synthetic_history_read_unavailable'); } };
    return getRange(...args);
  };
  const result = context.handleGroupOperation_('transition_payment', payload);
  assert.equal(result.ok, false);
  assert.equal(data.customerOrders.rows[1][3], beforeOrder);
  assert.deepEqual(data.groupParticipants.rows[1], beforeParticipant);
});

test('payment reads its participant table once inside the lock and discards the memo before unlocking', () => {
  const { context, data, payload } = hostPaymentFixture();
  let locked = false;
  let participantReads = 0;
  context.acquireScriptLock_ = () => {
    locked = true;
    return { releaseLock() {
      assert.equal(data._lockedGroupReadMemo, undefined);
      locked = false;
    } };
  };
  const getRange = data.groupParticipants.getRange.bind(data.groupParticipants);
  data.groupParticipants.getRange = (...args) => {
    const range = getRange(...args);
    const read = range.getValues.bind(range);
    range.getValues = () => { if (locked) participantReads += 1; return read(); };
    return range;
  };
  const result = context.handleGroupOperation_('transition_payment', payload);
  assert.equal(result.ok, true, result.error);
  assert.equal(participantReads, 1);
  assert.equal(result.order.paymentStatus, 'requested');
  assert.equal(data._lockedGroupReadMemo, undefined);
});

test('an uncommitted local plan cannot change the memoized group or participant authority', () => {
  const { context, data, dealId, payload } = hostPaymentFixture();
  const execute = context.executeGroupMutation_;
  context.executeGroupMutation_ = (action, incoming, sheets) => {
    const group = context.getGroupRecord_(sheets, dealId);
    const version = group.version;
    group.version += 100;
    group.hostActorId = 'synthetic-uncommitted-host';
    assert.equal(context.getGroupRecord_(sheets, dealId).version, version);
    assert.equal(context.getGroupRecord_(sheets, dealId).hostActorId, 'member-test');
    const participant = context.getParticipantRecord_(sheets, dealId, 'member-test', true);
    participant.capabilityHash = 'd'.repeat(64);
    participant.paymentStatus = 'confirmed';
    const fresh = context.getParticipantRecord_(sheets, dealId, 'member-test', true);
    assert.equal(fresh.capabilityHash, 'c'.repeat(64));
    assert.equal(fresh.paymentStatus, 'pending');
    return execute(action, incoming, sheets);
  };
  const result = context.handleGroupOperation_('transition_payment', payload);
  assert.equal(result.ok, true, result.error);
  assert.equal(JSON.parse(data.customerOrders.rows[1][3]).paymentStatus, 'requested');
});

test('a changed capability is rejected on the next invocation after a successful mutation', () => {
  const { context, data, payload } = hostPaymentFixture();
  assert.equal(context.handleGroupOperation_('transition_payment', payload).ok, true);
  data.groupParticipants.rows[1][7] = 'd'.repeat(64);
  const beforeChat = JSON.stringify(data.groupChat.rows);
  const result = context.handleGroupOperation_('send_message', {
    ...payload, body: 'must never be saved', clientMutationId: 'synthetic-revoked-message',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_capability');
  assert.equal(JSON.stringify(data.groupChat.rows), beforeChat);
  assert.equal(data._lockedGroupReadMemo, undefined);
});

test('a failed write clears memoized authority and retry repairs the durable intent once', () => {
  const { context, data, payload } = hostPaymentFixture();
  const getRange = data.groupParticipants.getRange.bind(data.groupParticipants);
  let fail = true;
  data.groupParticipants.getRange = (...args) => {
    const range = getRange(...args);
    const write = range.setValues.bind(range);
    range.setValues = (values) => {
      if (fail && args[0] === 2 && args[1] === 1) {
        fail = false;
        throw new Error('synthetic_participant_write_failed');
      }
      return write(values);
    };
    return range;
  };
  assert.equal(context.handleGroupOperation_('transition_payment', payload).ok, false);
  assert.equal(data._lockedGroupReadMemo, undefined);
  const result = context.handleGroupOperation_('transition_payment', payload);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.duplicate, true);
  assert.equal(result.order.paymentStatus, 'requested');
  assert.equal(result.order.total, 3340);
  assert.equal(data.groupParticipants.rows[1][5], 'requested');
  assert.equal(data._lockedGroupReadMemo, undefined);
});
