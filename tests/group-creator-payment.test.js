import test from 'node:test';
import assert from 'node:assert/strict';
import { adminStore } from './helpers/admin-store.js';

// Exercise the actual Apps Script create/publication/payment/read pipeline.
// This uses only in-memory synthetic records, never the configured collector.
function creatorStore() {
  const { context, data } = adminStore();
  for (const sheet of Object.values(data)) sheet.rows.splice(1);
  context.CacheService = {
    getScriptCache: () => ({ get: () => null, put() {}, remove() {} }),
  };
  const groupId = 'customer-creator-payment-test';
  const actorId = 'visitor-creator-payment-test';
  const participantCapabilityHash = 'c'.repeat(64);
  const customerCapabilityHash = 'b'.repeat(64);
  const reservationMutationId = 'create-creator-payment-test';
  const customerPhone = '01011112222';
  const created = context.handleGroupOperation_('create', {
    groupId, dealId: groupId, actorId, title: '합성 입금 테스트', nickname: '합성 사용자',
    hostMode: 'self', targetCount: 5, totalQuantity: 5, selectedQuantity: 1,
    capabilityHash: participantCapabilityHash, clientMutationId: reservationMutationId,
  });
  assert.equal(created.ok, true, created.error);
  const publishedDeal = context.publishPublicDeal_({
    id: groupId, groupId, source: 'customer', title: '합성 입금 테스트',
    originalPrice: 10000, target: 5, targetCount: 5, totalQuantity: 5,
    creatorActorId: actorId, creatorQuantity: 1, hostMode: 'self',
    expectedPublishVersion: 0, publishMutationId: 'publish-creator-deal-test',
  }, 'a'.repeat(64));
  assert.equal(publishedDeal.ok, true, publishedDeal.error);
  const order = {
    id: 'order-1700000000001', type: 'group', dealId: groupId, groupId,
    visitorId: actorId, participantActorId: actorId, customerPhone,
    customerName: '합성 사용자', status: 'new', paymentStatus: 'pending',
    quantity: 1, selectedCount: 1, reservationMutationId,
    reservationAction: 'create', reservationQuantity: 1,
    publishMutationId: 'publish-creator-order-test',
    unitPrice: 2000, total: 2000, version: 1, paymentVersion: 1,
  };
  const publishOrder = (value = order, proof = participantCapabilityHash) => (
    context.publishCustomerOrder_(value, actorId, customerCapabilityHash, proof)
  );
  const readOrders = () => context.getCustomerOrdersResponse_(
    customerPhone, actorId, customerCapabilityHash,
  );
  const paymentPayload = (fromStatus, toStatus, expectedVersion, clientMutationId) => ({
    groupId, actorId, participantActorId: actorId,
    capabilityHash: participantCapabilityHash,
    direction: ['pending', 'requested', 'confirmed'].indexOf(toStatus)
      > ['pending', 'requested', 'confirmed'].indexOf(fromStatus) ? 'next' : 'previous',
    fromStatus, toStatus, expectedVersion, clientMutationId,
  });
  const transition = (payload) => context.handleGroupOperation_('transition_payment', payload);
  return { context, data, groupId, actorId, order, publishOrder, readOrders, paymentPayload, transition };
}

test('centrally saved customer creator order follows payment request and every reversal in My Orders', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  let version = 1;
  for (const [from, to] of [
    ['pending', 'requested'], ['requested', 'confirmed'],
    ['confirmed', 'requested'], ['requested', 'pending'],
  ]) {
    const payload = store.paymentPayload(from, to, version, `creator-payment-step-${version}`);
    const result = store.transition(payload);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.order.type, 'group');
    assert.equal(result.order.paymentStatus, to);
    assert.equal(result.order.version, version + 1);
    assert.equal(result.snapshot.participants[0].paymentStatus, to);
    const orders = store.readOrders();
    assert.equal(orders.ok, true, orders.error);
    assert.equal(orders.orders.length, 1);
    assert.equal(orders.orders[0].paymentStatus, to);
    assert.equal(orders.orders[0].version, version + 1);
    assert.equal(orders.orders[0]._customerCapabilityHash, undefined);
    assert.equal(orders.orders[0]._reservationMutationId, undefined);
    const retry = store.transition(payload);
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.order.version, version + 1);
    assert.equal(store.data.customerOrders.rows.length, 2);
    version += 1;
  }
});

test('payment before creator order publication fails before mutation and the same request can succeed after publication', () => {
  const store = creatorStore();
  const payload = store.paymentPayload('pending', 'requested', 1, 'creator-payment-before-publish');
  const result = store.transition(payload);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'order_payment_link_required');
  assert.equal(result.order, undefined);
  assert.equal(store.context.getParticipantRecord_(store.data, store.groupId, store.actorId).paymentStatus, 'pending');
  assert.equal(store.context.findMutation_(store.data, payload.clientMutationId, 'transition_payment'), null);
  assert.equal(store.readOrders().orders.length, 0);
  assert.equal(store.data.customerOrders.rows.length, 1);
  assert.equal(store.publishOrder().ok, true);
  const retried = store.transition(payload);
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.order.paymentStatus, 'requested');
});

function reserveAdditionalCreatorQuantity(store, mutationId = 'creator-additional-reservation') {
  const participant = store.context.getParticipantRecord_(store.data, store.groupId, store.actorId);
  const reserved = store.context.handleGroupOperation_('reserve_quantity', {
    groupId: store.groupId, actorId: store.actorId, capabilityHash: 'c'.repeat(64),
    quantity: 1, expectedVersion: participant.version, clientMutationId: mutationId,
  });
  assert.equal(reserved.ok, true, reserved.error);
  return { ...store.order, id: 'order-1700000000002', reservationMutationId: mutationId,
    reservationAction: 'reserve_quantity', publishMutationId: 'creator-additional-order' };
}

test('payment rejects an unpublished additional reservation atomically and succeeds with the same intent after saving it', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const additionalOrder = reserveAdditionalCreatorQuantity(store);
  const payload = store.paymentPayload('pending', 'requested', 2, 'creator-incomplete-quantity-payment');
  const before = JSON.stringify(store.data);
  const result = store.transition(payload);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'order_sync_pending');
  assert.equal(JSON.stringify(store.data), before, 'failed preflight must not write an order, participant, or receipt');
  assert.equal(store.context.findMutation_(store.data, payload.clientMutationId, 'transition_payment'), null);

  assert.equal(store.publishOrder(additionalOrder).ok, true);
  const retried = store.transition(payload);
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.snapshot.participants[0].paymentStatus, 'requested');
  const orders = store.readOrders().orders;
  assert.equal(orders.length, 2);
  assert.ok(orders.every((order) => order.paymentStatus === 'requested'));
  assert.equal(orders.reduce((quantity, order) => quantity + order.quantity, 0), 2);
});

for (const extraOrderState of ['cancelled', 'unbound']) {
  test(`a ${extraOrderState} order cannot fill the payment quantity gap`, () => {
    const store = creatorStore();
    assert.equal(store.publishOrder().ok, true);
    const additionalOrder = reserveAdditionalCreatorQuantity(store);
    if (extraOrderState === 'cancelled') additionalOrder.status = 'cancelled';
    store.data.customerOrders.rows.push(['', additionalOrder.id, additionalOrder.customerPhone,
      JSON.stringify(additionalOrder)]);
    const before = JSON.stringify(store.data);
    const result = store.transition(store.paymentPayload('pending', 'requested', 2,
      `creator-${extraOrderState}-quantity-payment`));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'order_sync_pending');
    assert.equal(JSON.stringify(store.data), before);
  });
}

test('completed payment receipt replay does not apply its old transition to a later incomplete checkout', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const payload = store.paymentPayload('pending', 'requested', 1, 'creator-receipt-before-more-quantity');
  assert.equal(store.transition(payload).ok, true);
  assert.equal(store.transition(store.paymentPayload('requested', 'pending', 2,
    'creator-rewind-before-more-quantity')).ok, true);
  reserveAdditionalCreatorQuantity(store);
  const before = JSON.stringify(store.data);
  const replay = store.transition(payload);
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.snapshot.participants[0].paymentStatus, 'pending');
  assert.equal(JSON.stringify(store.data), before);
});

function changeStoredOrder(store, change) {
  const order = JSON.parse(store.data.customerOrders.rows[1][3]);
  change(order);
  store.data.customerOrders.rows[1][3] = JSON.stringify(order);
  return order;
}

function losePrivateBinding(store) {
  return changeStoredOrder(store, (order) => {
    delete order._reservationMutationId;
    delete order._reservationAction;
    delete order._reservationQuantity;
  });
}

function manageCreatorPayment(store, order, direction, clientMutationId) {
  return store.context.manageCustomerOrder_({
    orderId: order.id,
    dealId: store.groupId,
    managerType: 'group_manager',
    kind: 'payment_status',
    direction,
    expectedVersion: order.version,
    clientMutationId,
    actorId: store.actorId,
    capabilityHash: 'c'.repeat(64),
  });
}

test('manager payment also rejects incomplete reserved quantity without writing any part of the transaction', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  reserveAdditionalCreatorQuantity(store);
  // A pre-fix request could advance the saved order while the additional
  // reservation was missing. Confirmation must not compound that old state.
  const requestedOrder = changeStoredOrder(store, (order) => { order.paymentStatus = 'requested'; });
  const participant = store.context.getParticipantRecord_(store.data, store.groupId, store.actorId);
  participant.paymentStatus = 'requested';
  store.context.updateParticipantRow_(store.data, participant);
  const before = JSON.stringify(store.data);
  const rejected = manageCreatorPayment(store, requestedOrder, 'next', 'manager-incomplete-quantity');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'order_sync_pending');
  assert.equal(JSON.stringify(store.data), before);
});

test('manager confirms multiple saved orders only when their total covers the reserved quantity', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const additionalOrder = reserveAdditionalCreatorQuantity(store);
  assert.equal(store.publishOrder(additionalOrder).ok, true);
  assert.equal(store.transition(store.paymentPayload('pending', 'requested', 2,
    'creator-multiple-orders-request')).ok, true);
  const orders = store.readOrders().orders;
  const first = manageCreatorPayment(store, orders[0], 'next', 'manager-first-quantity');
  assert.equal(first.ok, true, first.error);
  assert.equal(first.order.paymentStatus, 'confirmed');
  assert.equal(store.context.getParticipantRecord_(store.data, store.groupId, store.actorId).paymentStatus, 'requested');
  const second = manageCreatorPayment(store, orders[1], 'next', 'manager-second-quantity');
  assert.equal(second.ok, true, second.error);
  assert.equal(store.context.getParticipantRecord_(store.data, store.groupId, store.actorId).paymentStatus, 'confirmed');
  assert.ok(store.readOrders().orders.every((order) => order.paymentStatus === 'confirmed'));
});

test('manager receipt replay remains read-only when a later checkout has not finished publication', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const requested = store.transition(store.paymentPayload('pending', 'requested', 1,
    'creator-request-before-managed-receipt'));
  assert.equal(requested.ok, true, requested.error);
  const confirmed = manageCreatorPayment(store, requested.order, 'next', 'manager-receipt-before-more-quantity');
  assert.equal(confirmed.ok, true, confirmed.error);
  const rewound = manageCreatorPayment(store, confirmed.order, 'previous', 'manager-rewind-before-more-quantity');
  assert.equal(rewound.ok, true, rewound.error);
  const participant = store.context.getParticipantRecord_(store.data, store.groupId, store.actorId);
  assert.equal(store.transition(store.paymentPayload('requested', 'pending', participant.version,
    'creator-rewind-after-managed-receipt')).ok, true);
  reserveAdditionalCreatorQuantity(store);
  const before = JSON.stringify(store.data);
  const replay = manageCreatorPayment(store, requested.order, 'next', 'manager-receipt-before-more-quantity');
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.order.paymentStatus, 'pending');
  assert.equal(JSON.stringify(store.data), before);
});

test('overrepresented proven order quantity also prevents a new payment transition', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const additionalOrder = reserveAdditionalCreatorQuantity(store);
  assert.equal(store.publishOrder(additionalOrder).ok, true);
  const participant = store.context.getParticipantRecord_(store.data, store.groupId, store.actorId);
  // Simulate inconsistent historic data without treating it as authorization
  // to silently rewrite either an order or the participant reservation.
  participant.selectedQuantity = 1;
  store.context.updateParticipantRow_(store.data, participant);
  const before = JSON.stringify(store.data);
  const rejected = store.transition(store.paymentPayload('pending', 'requested', 2,
    'creator-overrepresented-quantity'));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'order_sync_pending');
  assert.equal(JSON.stringify(store.data), before);
});

test('legacy private binding loss is repaired only from the same owned snapshot and real completed reservation', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const original = losePrivateBinding(store);
  const payload = store.paymentPayload('pending', 'requested', 1, 'creator-legacy-binding-repair');
  const result = store.transition(payload);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.order.paymentStatus, 'requested');
  assert.equal(result.order.version, 2);
  const repaired = JSON.parse(store.data.customerOrders.rows[1][3]);
  for (const field of ['total', 'unitPrice', 'quantity', 'selectedCount', 'customerPhone', '_customerCapabilityHash']) {
    assert.equal(repaired[field], original[field], field);
  }
  assert.equal(repaired._reservationMutationId, original.reservationMutationId);
  assert.equal(repaired._reservationAction, 'create');
  assert.equal(repaired._reservationQuantity, 1);
  assert.equal(result.order._reservationMutationId, undefined);
  assert.equal(result.order._customerCapabilityHash, undefined);
  assert.equal(store.transition(payload).order.version, 2);
  let participantVersion = 2;
  for (const [from, to] of [['requested', 'confirmed'], ['confirmed', 'requested'], ['requested', 'pending']]) {
    const next = store.transition(store.paymentPayload(from, to, participantVersion, `repaired-reversal-${participantVersion}`));
    assert.equal(next.ok, true, next.error);
    assert.equal(next.order.paymentStatus, to);
    assert.equal(store.readOrders().orders[0].paymentStatus, to);
    participantVersion += 1;
  }
});

test('verified historic payment projection fixes an already requested legacy view without writing or changing money', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const order = losePrivateBinding(store);
  const participant = store.context.getParticipantRecord_(store.data, store.groupId, store.actorId);
  participant.paymentStatus = 'requested';
  participant.version = 2;
  participant.updatedAt = '2026-09-09T00:00:00.000Z';
  store.context.updateParticipantRow_(store.data, participant);
  const before = JSON.stringify(store.data.customerOrders.rows);
  const projection = store.context.projectStoredGroupOrderPayment_(store.data, order);
  assert.equal(projection.paymentStatus, 'requested');
  assert.equal(projection.paymentSyncStatus, 'verified_history');
  assert.equal(projection.total, order.total);
  assert.equal(projection.version, order.version);
  assert.equal(JSON.stringify(store.data.customerOrders.rows), before);
  const cancelled = store.transition(store.paymentPayload('requested', 'pending', 2, 'legacy-request-cancel-repair'));
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(cancelled.order.paymentStatus, 'pending');
  assert.equal(cancelled.order.version, 2);
  assert.equal(JSON.parse(store.data.customerOrders.rows[1][3])._reservationAction, 'create');
});

test('manager confirmation repairs a verified legacy binding and updates the group participant atomically', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const requested = store.transition(
    store.paymentPayload('pending', 'requested', 1, 'manager-legacy-request'),
  );
  assert.equal(requested.ok, true, requested.error);
  losePrivateBinding(store);

  const confirmed = manageCreatorPayment(
    store,
    requested.order,
    'next',
    'manager-legacy-confirm',
  );
  assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.order.paymentStatus, 'confirmed');
  assert.equal(
    store.context.getParticipantRecord_(store.data, store.groupId, store.actorId).paymentStatus,
    'confirmed',
  );
  const stored = JSON.parse(store.data.customerOrders.rows[1][3]);
  assert.equal(stored._reservationMutationId, store.order.reservationMutationId);
  assert.equal(stored._reservationAction, 'create');
  assert.equal(stored.paymentSyncStatus, undefined);
  assert.equal(store.readOrders().orders[0].paymentStatus, 'confirmed');
});

test('manager payment change fails closed when a legacy group order has no verifiable participant binding', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const requested = store.transition(
    store.paymentPayload('pending', 'requested', 1, 'manager-unbound-request'),
  );
  assert.equal(requested.ok, true, requested.error);
  losePrivateBinding(store);
  store.data.events.rows.splice(1);
  const before = JSON.stringify(store.data);

  const rejected = manageCreatorPayment(
    store,
    requested.order,
    'next',
    'manager-unbound-confirm',
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'order_payment_link_required');
  assert.equal(JSON.stringify(store.data), before);
});

for (const defect of ['missing_history', 'repair_history', 'recovery_history', 'pending_history', 'missing_snapshot',
  'generic_event_snapshot', 'ownership_conflict', 'forged_private', 'forged_public', 'forged_quantity',
  'competing_reservation', 'rolled_back', 'cancelled_reservation']) {
  test(`legacy ${defect} does not permit adopting an order or false-success payment`, () => {
    const store = creatorStore();
    assert.equal(store.publishOrder().ok, true);
    losePrivateBinding(store);
    const historyRow = store.data.groupHistory.rows[1];
    if (defect === 'missing_history') store.data.groupHistory.rows.splice(1);
    if (defect === 'repair_history') historyRow[6] = 'repair_customer_group';
    if (defect === 'recovery_history') historyRow[6] = 'recover_legacy_customer_group';
    if (defect === 'pending_history') {
      const result = JSON.parse(historyRow[13]);
      // A completed recovery intent is not fabricated here: a history record
      // with no durable completion marker is insufficient repair evidence.
      delete result.pending;
      historyRow[13] = JSON.stringify(result);
    }
    if (defect === 'missing_snapshot') store.data.events.rows.splice(1);
    if (defect === 'generic_event_snapshot') store.data.events.rows[1][6] = 'button_clicked';
    if (defect === 'ownership_conflict') changeStoredOrder(store, (order) => { order._customerCapabilityHash = 'e'.repeat(64); });
    if (defect === 'forged_private') changeStoredOrder(store, (order) => { order._reservationMutationId = 'unrelated-reservation'; });
    if (defect === 'forged_public') changeStoredOrder(store, (order) => { order.reservationMutationId = 'unrelated-reservation'; });
    if (defect === 'forged_quantity') changeStoredOrder(store, (order) => { order.quantity = 2; order.selectedCount = 2; });
    if (defect === 'competing_reservation') {
      const duplicate = { ...JSON.parse(store.data.customerOrders.rows[1][3]), id: 'order-1700000000002' };
      store.data.customerOrders.rows.push(['', duplicate.id, duplicate.customerPhone, JSON.stringify(duplicate)]);
    }
    if (['rolled_back', 'cancelled_reservation'].includes(defect)) {
      store.context.appendGroupHistory_(store.data, {
        groupId: store.groupId, actorId: store.actorId, entityId: store.actorId,
        action: defect === 'rolled_back' ? 'rollback_reservation' : 'cancel_participation',
        clientMutationId: `legacy-${defect}-history`,
        result: { reservationMutationId: store.order.reservationMutationId },
      });
    }
    const before = JSON.stringify(store.data);
    const payload = store.paymentPayload('pending', 'requested', 1, `legacy-denied-${defect}`);
    const result = store.transition(payload);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'order_payment_link_required');
    assert.equal(JSON.stringify(store.data), before);
    const stored = JSON.parse(store.data.customerOrders.rows[1][3]);
    const projection = store.context.projectStoredGroupOrderPayment_(store.data, stored);
    assert.equal(projection.paymentStatus, 'pending');
    assert.equal(projection.paymentSyncStatus, 'repair_required');
  });
}

for (const mode of ['chat_only', 'free', 'zero_quantity_host']) {
  test(`${mode} group payment remains available without a purchase order`, () => {
    const store = creatorStore();
    if (mode === 'chat_only') store.data.publicDeals.rows.splice(1);
    if (mode === 'free') {
      const deal = JSON.parse(store.data.publicDeals.rows[1][6]);
      deal.originalPrice = 0;
      store.data.publicDeals.rows[1][6] = JSON.stringify(deal);
    }
    if (mode === 'zero_quantity_host') {
      const participant = store.context.getParticipantRecord_(store.data, store.groupId, store.actorId);
      participant.selectedQuantity = 0;
      store.context.updateParticipantRow_(store.data, participant);
    }
    const result = store.transition(store.paymentPayload('pending', 'requested', 1, `payment-no-order-${mode}`));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.order, undefined);
    assert.equal(result.snapshot.participants[0].paymentStatus, 'requested');
  });
}

for (const lostBinding of [false, true]) {
test(`creator payment retry repairs an interrupted order write without double transition (legacy=${lostBinding})`, () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  if (lostBinding) losePrivateBinding(store);
  const originalGetRange = store.data.customerOrders.getRange.bind(store.data.customerOrders);
  let failNextWrite = true;
  store.data.customerOrders.getRange = (...args) => {
    const range = originalGetRange(...args);
    return {
      ...range,
      setValues(values) {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('synthetic_order_write_interruption');
        }
        return range.setValues(values);
      },
    };
  };
  const payload = store.paymentPayload('pending', 'requested', 1, 'creator-payment-recover-write');
  assert.equal(store.transition(payload).ok, false);
  assert.equal(store.context.getParticipantRecord_(store.data, store.groupId, store.actorId).paymentStatus, 'pending');
  const repaired = store.transition(payload);
  assert.equal(repaired.ok, true, repaired.error);
  assert.equal(repaired.duplicate, true);
  assert.equal(repaired.order.paymentStatus, 'requested');
  assert.equal(repaired.order.version, 2);
  assert.equal(store.readOrders().orders[0].paymentStatus, 'requested');
  assert.equal(store.transition(payload).order.version, 2);
});
}

test('legacy repair survives interruption after the order write and before participant write', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  losePrivateBinding(store);
  const originalGetRange = store.data.groupParticipants.getRange.bind(store.data.groupParticipants);
  let failNextWrite = true;
  store.data.groupParticipants.getRange = (...args) => {
    const range = originalGetRange(...args);
    return { ...range, setValues(values) {
      if (failNextWrite) { failNextWrite = false; throw new Error('synthetic_participant_write_interruption'); }
      return range.setValues(values);
    } };
  };
  const payload = store.paymentPayload('pending', 'requested', 1, 'legacy-participant-write-retry');
  assert.equal(store.transition(payload).ok, false);
  assert.equal(JSON.parse(store.data.customerOrders.rows[1][3]).paymentStatus, 'requested');
  assert.equal(store.context.getParticipantRecord_(store.data, store.groupId, store.actorId).paymentStatus, 'pending');
  const repaired = store.transition(payload);
  assert.equal(repaired.ok, true, repaired.error);
  assert.equal(repaired.duplicate, true);
  assert.equal(repaired.order.version, 2);
  assert.equal(repaired.snapshot.participants[0].paymentStatus, 'requested');
  assert.equal(store.transition(payload).order.version, 2);
});

test('pending legacy repair cannot advance the participant if its evidence disappears before retry', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  losePrivateBinding(store);
  const originalGetRange = store.data.customerOrders.getRange.bind(store.data.customerOrders);
  let failNextWrite = true;
  store.data.customerOrders.getRange = (...args) => {
    const range = originalGetRange(...args);
    return { ...range, setValues(values) {
      if (failNextWrite) { failNextWrite = false; throw new Error('synthetic_order_write_interruption'); }
      return range.setValues(values);
    } };
  };
  const payload = store.paymentPayload('pending', 'requested', 1, 'legacy-lost-evidence-retry');
  assert.equal(store.transition(payload).ok, false);
  const preservedEvents = store.data.events.rows.splice(1);
  const retried = store.transition(payload);
  assert.equal(retried.ok, false);
  assert.equal(retried.error, 'order_payment_link_required');
  assert.equal(store.context.getParticipantRecord_(store.data, store.groupId, store.actorId).paymentStatus, 'pending');
  assert.equal(JSON.parse(store.data.customerOrders.rows[1][3]).paymentStatus, 'pending');
  store.data.events.rows.push(...preservedEvents);
  assert.equal(store.transition(payload).order.paymentStatus, 'requested');
});

test('a contradictory linked order state is rejected before a participant rewind', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  changeStoredOrder(store, (order) => { order.paymentStatus = 'confirmed'; });
  const participant = store.context.getParticipantRecord_(store.data, store.groupId, store.actorId);
  participant.paymentStatus = 'requested';
  participant.version = 2;
  store.context.updateParticipantRow_(store.data, participant);
  const before = JSON.stringify(store.data);
  const result = store.transition(store.paymentPayload('requested', 'pending', 2, 'contradictory-linked-rewind'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'order_payment_state_conflict');
  assert.equal(JSON.stringify(store.data), before);
});

test('old false-success receipt cannot bypass the missing-order guard on retry', () => {
  const store = creatorStore();
  const payload = store.paymentPayload('pending', 'requested', 1, 'legacy-false-success-receipt');
  const participant = store.context.getParticipantRecord_(store.data, store.groupId, store.actorId);
  participant.paymentStatus = 'requested';
  participant.version = 2;
  store.context.updateParticipantRow_(store.data, participant);
  store.context.appendGroupHistory_(store.data, {
    groupId: store.groupId, actorId: store.actorId, entityId: store.actorId,
    action: 'transition_payment', fromStatus: 'pending', toStatus: 'requested',
    clientMutationId: payload.clientMutationId,
    result: { pending: false, syncedOrderCount: 0,
      mutationContract: store.context.groupMutationContract_('transition_payment', payload) },
  });
  const before = JSON.stringify(store.data);
  const response = store.transition(payload);
  assert.equal(response.ok, false);
  assert.equal(response.error, 'order_payment_link_required');
  assert.equal(JSON.stringify(store.data), before);
  // The old late-order guard still rejects creating a new order while the
  // existing participant is already requested; this needs explicit repair.
  assert.equal(store.publishOrder().error, 'quantity_reservation_closed');
});

test('verified legacy confirmed participant supports one-step reversal without changing prices', () => {
  const store = creatorStore();
  assert.equal(store.publishOrder().ok, true);
  const order = losePrivateBinding(store);
  const participant = store.context.getParticipantRecord_(store.data, store.groupId, store.actorId);
  participant.paymentStatus = 'confirmed';
  participant.version = 3;
  participant.updatedAt = '2026-09-09T00:00:00.000Z';
  store.context.updateParticipantRow_(store.data, participant);
  const result = store.transition(store.paymentPayload('confirmed', 'requested', 3, 'legacy-confirmed-reverse'));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.order.paymentStatus, 'requested');
  assert.equal(result.order.paymentConfirmedAt, '');
  assert.equal(result.order.total, order.total);
  assert.equal(result.order.unitPrice, order.unitPrice);
  assert.equal(result.order.version, 2);
});

test('creator reservation binding still rejects a wrong participant capability and never adopts lookalike orders', () => {
  const store = creatorStore();
  const denied = store.publishOrder(store.order, 'e'.repeat(64));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'invalid_participant_capability');
  assert.equal(store.data.customerOrders.rows.length, 1);
  assert.equal(store.publishOrder().ok, true);
  const lookalike = { ...store.order, id: 'order-1700000000002' };
  store.data.customerOrders.rows.push(['', lookalike.id, lookalike.customerPhone, JSON.stringify(lookalike)]);
  const payload = store.paymentPayload('pending', 'requested', 1, 'creator-payment-secure-binding');
  assert.equal(store.transition(payload).ok, true);
  assert.equal(JSON.parse(store.data.customerOrders.rows[2][3]).paymentStatus, 'pending');
  const forged = store.transition({ ...payload, capabilityHash: 'f'.repeat(64) });
  assert.equal(forged.ok, false);
  assert.equal(forged.error, 'invalid_capability');
});
