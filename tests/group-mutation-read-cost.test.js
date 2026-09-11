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
