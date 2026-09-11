import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { fetchUpstreamJson } from '../api/_data-upstream.js';
import collectHandler from '../api/collect.js';
import customerOrdersHandler, { normalizedOrders } from '../api/customer-orders.js';
import groupOpsHandler from '../api/group-ops.js';
import publicDealsHandler from '../api/public-deals.js';
import statsHandler from '../api/stats.js';

function appsScriptContext() {
  const context = {};
  runInNewContext(
    readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'),
    context,
  );
  context.Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(_algorithm, value) {
      return [...createHash('sha256').update(String(value), 'utf8').digest()]
        .map((byte) => (byte > 127 ? byte - 256 : byte));
    },
  };
  return context;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

async function invoke(handler, body) {
  const response = responseRecorder();
  await handler({
    method: 'POST',
    headers: { origin: 'http://localhost:5173' },
    body,
  }, response);
  return response;
}

async function invokeGet(handler) {
  const response = responseRecorder();
  await handler({ method: 'GET', headers: {} }, response);
  return response;
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function orderSnapshot(overrides = {}) {
  return {
    id: 'order-1234567890456',
    createdAt: '2026-09-01T00:00:00.000Z',
    statusUpdatedAt: '2026-09-01T00:01:00.000Z',
    status: 'new',
    paymentStatus: 'pending',
    visitorId: 'visitor-order-integrity',
    customerPhone: '01012345678',
    dealId: 'owner-order-integrity',
    selectedCount: 1,
    quantity: 1,
    version: 1,
    deal: { id: 'owner-order-integrity' },
    ...overrides,
  };
}

test('duplicate order snapshots select the highest CAS version before timestamps', () => {
  const current = orderSnapshot({
    version: 3,
    paymentVersion: 3,
    paymentStatus: 'confirmed',
    statusUpdatedAt: '2026-09-01T00:03:00.000Z',
  });
  const staleWithFutureTimestamp = orderSnapshot({
    version: 2,
    paymentVersion: 2,
    paymentStatus: 'requested',
    statusUpdatedAt: '2099-09-01T00:00:00.000Z',
  });

  const [normalized] = normalizedOrders([current, staleWithFutureTimestamp]);
  assert.equal(normalized.version, 3);
  assert.equal(normalized.paymentVersion, 3);
  assert.equal(normalized.paymentStatus, 'confirmed');
});

test('order normalization reconciles mismatched version aliases to the highest valid value', () => {
  const [normalized] = normalizedOrders([orderSnapshot({ version: 2, paymentVersion: 4 })]);
  assert.equal(normalized.version, 4);
  assert.equal(normalized.paymentVersion, 4);
});

test('initial instant-order pricing is derived from the public deal, not browser totals', () => {
  const context = appsScriptContext();
  const deal = {
    id: 'owner-canonical-instant-price',
    source: 'merchant',
    saleType: 'instant',
    visibility: 'public',
    title: '복숭아 2개',
    store: '시장 과일가게',
    region: '서울',
    district: '강남구',
    neighborhood: '역삼동',
    originalPrice: 13000,
    discountRate: 15,
  };
  const canonical = JSON.parse(JSON.stringify(
    context.canonicalInitialCustomerOrderPricing_({}, orderSnapshot({
      dealId: deal.id,
      deal: { id: deal.id, title: '조작된 상품명' },
      type: 'purchase',
      selectedCount: 2,
      quantity: 2,
      unitPrice: 1,
      total: 1,
      hostRemainderApplied: 999,
    }), 'visitor-order-integrity', deal),
  ));

  assert.equal(canonical.unitPrice, 11050);
  assert.equal(canonical.total, 22100);
  assert.equal(canonical.hostRemainderApplied, 0);
  assert.equal(canonical.title, deal.title);
  assert.equal(canonical.deal.store, deal.store);
});

test('initial order pricing rejects invalid quantities and deal/group binding bypasses', () => {
  const context = appsScriptContext();
  const instantDeal = {
    id: 'owner-canonical-instant-binding',
    source: 'merchant',
    saleType: 'instant',
    visibility: 'public',
    originalPrice: 10000,
    discountRate: 10,
  };
  [-1, 0, 1.5, 1000].forEach((selectedCount) => {
    assert.throws(
      () => context.canonicalInitialCustomerOrderPricing_({}, orderSnapshot({
        dealId: instantDeal.id,
        deal: { id: instantDeal.id },
        type: 'purchase',
        selectedCount,
        quantity: selectedCount,
      }), 'visitor-order-integrity', instantDeal),
      (error) => error?.code === 'invalid_order_quantity',
    );
  });
  assert.throws(
    () => context.canonicalInitialCustomerOrderPricing_({}, orderSnapshot({
      dealId: instantDeal.id,
      deal: { id: instantDeal.id },
      groupId: instantDeal.id,
      type: 'purchase',
    }), 'visitor-order-integrity', instantDeal),
    (error) => error?.code === 'invalid_order_deal_binding',
  );

  const customerGroup = {
    id: 'customer-canonical-group-binding',
    source: 'customer',
    visibility: 'public',
    originalPrice: 10000,
  };
  assert.throws(
    () => context.canonicalInitialCustomerOrderPricing_({}, orderSnapshot({
      dealId: customerGroup.id,
      deal: { id: customerGroup.id },
      groupId: '',
      type: 'purchase',
    }), 'visitor-order-integrity', customerGroup),
    (error) => error?.code === 'invalid_group_deal_binding',
  );
});

test('merchant group pricing rejects malformed discount configuration', () => {
  const context = appsScriptContext();
  const groupId = 'owner-invalid-group-price';
  context.getGroupRecord_ = () => ({
    groupId,
    dealId: groupId,
    hostActorId: '',
    totalQuantity: 5,
  });
  context.activePublicDealRecord_ = () => ({
    id: groupId,
    source: 'merchant',
    saleType: 'group',
    visibility: 'public',
    originalPrice: 10000,
    discountRate: 101,
    totalQuantity: 5,
  });
  assert.throws(
    () => context.canonicalGroupOrderPricing_({ publicDeals: {} }, orderSnapshot({
      dealId: groupId,
      groupId,
      deal: { id: groupId },
      type: 'purchase',
    }), 'visitor-order-integrity'),
    (error) => error?.code === 'invalid_deal_price',
  );
});

test('customer-order gateway rejects non-positive, fractional, oversized, and negative financial values', async () => {
  const invalidOrders = [
    orderSnapshot({ selectedCount: 0, quantity: 0, type: 'purchase' }),
    orderSnapshot({ selectedCount: -1, quantity: -1, type: 'purchase' }),
    orderSnapshot({ selectedCount: 1.5, quantity: 1.5, type: 'purchase' }),
    orderSnapshot({ selectedCount: 1000, quantity: 1000, type: 'purchase' }),
    orderSnapshot({ selectedCount: 1, quantity: 1, unitPrice: -1, type: 'purchase' }),
    orderSnapshot({ selectedCount: 1, quantity: 1, total: -1, type: 'purchase' }),
    orderSnapshot({ selectedCount: 1, quantity: 1, hostRemainderApplied: -1, type: 'purchase' }),
  ];

  for (const order of invalidOrders) {
    const response = await invoke(customerOrdersHandler, {
      action: 'publish',
      order,
      visitorId: order.visitorId,
      customerCapabilityToken: `customer-${'q'.repeat(64)}`,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { ok: false, error: 'invalid_order_request' });
  }
});

test('Apps Script snapshot merging also prioritizes the highest CAS version', () => {
  const context = appsScriptContext();
  const current = orderSnapshot({
    version: 4,
    paymentVersion: 4,
    paymentStatus: 'confirmed',
    statusUpdatedAt: '2026-09-01T00:04:00.000Z',
  });
  const staleWithFutureTimestamp = orderSnapshot({
    version: 3,
    paymentVersion: 3,
    paymentStatus: 'requested',
    statusUpdatedAt: '2099-09-01T00:00:00.000Z',
  });

  const [merged] = JSON.parse(JSON.stringify(
    context.mergeCustomerOrderSnapshots_([current, staleWithFutureTimestamp]),
  ));
  assert.equal(merged.version, 4);
  assert.equal(merged.paymentStatus, 'confirmed');
  assert.equal(context.secureOrderVersion_({ version: 2, paymentVersion: 5 }), 5);
});

test('Apps Script participation cancellation advances the highest legacy order version alias', () => {
  const context = appsScriptContext();
  const participant = {
    actorId: 'visitor-cancel-version',
    role: 'member',
    counted: true,
    paymentStatus: 'pending',
    selectedQuantity: 1,
    version: 2,
  };
  const group = {
    groupId: 'customer-cancel-version',
    dealId: 'customer-cancel-version',
    groupStatus: 'recruiting',
    totalQuantity: 2,
    version: 3,
  };
  const order = orderSnapshot({
    id: 'order-1234567890457',
    groupId: group.groupId,
    dealId: group.dealId,
    visitorId: participant.actorId,
    participantActorId: participant.actorId,
    version: 1,
    paymentVersion: 3,
    _reservationQuantity: 1,
  });
  let storedOrder = null;
  context.findMutation_ = () => null;
  context.authorizeGroupActor_ = () => ({
    actorId: participant.actorId,
    role: 'member',
    participant,
  });
  context.getGroupRecord_ = () => group;
  context.getCustomerOrderRecord_ = () => ({ order, rowNumber: 2 });
  context.authorizeCustomerOrderCancellation_ = () => order;
  context.updateParticipantRow_ = () => {};
  context.updateGroupRow_ = () => {};
  context.updateCustomerOrderRecord_ = (_sheets, record) => { storedOrder = record.order; };
  context.appendGroupHistory_ = () => {};
  context.invalidateGroupSnapshot_ = () => {};

  const result = context.executeGroupMutation_('cancel_participation', {
    groupId: group.groupId,
    actorId: participant.actorId,
    orderId: order.id,
    expectedVersion: 2,
    expectedOrderVersion: 3,
    customerCapabilityHash: 'a'.repeat(64),
    capabilityHash: 'b'.repeat(64),
    clientMutationId: 'mutation-cancel-version',
  }, {});

  assert.equal(result.order.version, 4);
  assert.equal(result.order.paymentVersion, 4);
  assert.equal(storedOrder.version, 4);
});

test('Apps Script quantity reservation reactivates a member after cancellation history', () => {
  const context = appsScriptContext();
  const groupId = 'customer-cancel-reselect-server';
  const actorId = 'visitor-cancel-reselect-server';
  const participant = {
    groupId,
    actorId,
    role: 'member',
    counted: false,
    paymentStatus: 'pending',
    selectedQuantity: 0,
    version: 4,
  };
  const group = {
    groupId,
    dealId: groupId,
    groupStatus: 'recruiting',
    targetCount: 4,
    totalQuantity: 8,
    version: 5,
  };
  const history = [{
    rowNumber: 2,
    groupId,
    actorId,
    action: 'cancel_participation',
    mutationId: 'cancel-before-reselect-server',
    result: {
      orderId: 'order-170000000000099',
      cancelledQuantity: 2,
      previousQuantity: 2,
      selectedQuantity: 0,
      orderVersion: 2,
    },
  }];
  let committed = null;
  context.findMutation_ = () => null;
  context.authorizeGroupActor_ = () => ({ actorId, role: 'member', participant });
  context.getGroupRecord_ = () => group;
  context.customerOrderReservationHistory_ = () => history;
  context.getParticipantsForGroup_ = () => [participant];
  context.activePublicDealRecord_ = () => ({ id: groupId, source: 'customer', visibility: 'public' });
  context.storedCustomerOrders_ = () => [];
  context.updateGroupRow_ = () => {};
  context.invalidateGroupSnapshot_ = () => {};
  context.commitGroupMutationIntent_ = (
    _sheets,
    historyData,
    mutationContract,
    completionResult,
    operations,
  ) => {
    committed = { historyData, mutationContract, completionResult, operations };
  };

  context.executeGroupMutation_('reserve_quantity', {
    groupId,
    actorId,
    quantity: 2,
    expectedVersion: 4,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'reserve-after-cancel-server',
  }, { publicDeals: {}, customerOrders: {} });

  assert.equal(participant.counted, true);
  assert.equal(participant.selectedQuantity, 2);
  assert.equal(participant.version, 5);
  assert.equal(committed.historyData.action, 'reserve_quantity');
  assert.equal(committed.completionResult.reactivated, true);
  assert.equal(committed.completionResult.reactivationReason, 'cancel_participation');
  assert.equal(committed.operations[0].target.counted, true);
  assert.equal(committed.operations[0].target.selectedQuantity, 2);
});

test('Apps Script quantity reservation keeps a cancelled member inactive while an order remains active', () => {
  const context = appsScriptContext();
  const groupId = 'customer-cancel-active-order-server';
  const actorId = 'visitor-cancel-active-order-server';
  const participant = {
    groupId,
    actorId,
    role: 'member',
    counted: false,
    paymentStatus: 'pending',
    selectedQuantity: 0,
    version: 4,
  };
  const group = {
    groupId,
    dealId: groupId,
    groupStatus: 'recruiting',
    targetCount: 4,
    totalQuantity: 8,
    version: 5,
  };
  const history = [{
    rowNumber: 2,
    groupId,
    actorId,
    action: 'cancel_participation',
    mutationId: 'cancel-with-active-order-server',
    result: {
      orderId: 'order-170000000000100',
      cancelledQuantity: 2,
      previousQuantity: 2,
      selectedQuantity: 0,
      orderVersion: 2,
    },
  }];
  let commitCalled = false;
  context.findMutation_ = () => null;
  context.authorizeGroupActor_ = () => ({ actorId, role: 'member', participant });
  context.getGroupRecord_ = () => group;
  context.customerOrderReservationHistory_ = () => history;
  context.getParticipantsForGroup_ = () => [participant];
  context.activePublicDealRecord_ = () => ({ id: groupId, source: 'customer', visibility: 'public' });
  context.storedCustomerOrders_ = () => [{
    id: 'order-170000000000101',
    type: 'purchase',
    status: 'new',
    paymentStatus: 'pending',
    groupId,
    participantActorId: actorId,
    _reservationAction: 'join',
    _reservationMutationId: 'reservation-still-bound-server',
    _reservationQuantity: 2,
  }];
  context.updateGroupRow_ = () => {};
  context.invalidateGroupSnapshot_ = () => {};
  context.commitGroupMutationIntent_ = () => { commitCalled = true; };

  assert.throws(
    () => context.executeGroupMutation_('reserve_quantity', {
      groupId,
      actorId,
      quantity: 1,
      expectedVersion: 4,
      capabilityHash: 'b'.repeat(64),
      clientMutationId: 'reserve-blocked-active-order-server',
    }, { publicDeals: {}, customerOrders: {} }),
    (error) => error?.code === 'forbidden',
  );
  assert.equal(commitCalled, false);
  assert.equal(participant.counted, false);
  assert.equal(participant.selectedQuantity, 0);
  assert.equal(participant.version, 4);
});

test('Apps Script group transition requires confirmed payments from participant and legacy order actors', () => {
  const context = appsScriptContext();
  const groupId = 'owner-transition-payment-union';
  const hostActorId = 'visitor-transition-payment-host';
  const legacyActorId = 'visitor-transition-payment-legacy';
  const adminActorId = 'visitor-transition-payment-admin';
  const participants = [{
    groupId,
    actorId: hostActorId,
    role: 'host',
    counted: true,
    paymentStatus: 'confirmed',
    selectedQuantity: 1,
    version: 2,
  }, {
    groupId,
    actorId: 'visitor-transition-payment-member',
    role: 'member',
    counted: true,
    paymentStatus: 'confirmed',
    selectedQuantity: 1,
    version: 2,
  }, {
    groupId,
    actorId: adminActorId,
    role: 'admin',
    counted: false,
    paymentStatus: 'pending',
    selectedQuantity: 0,
    version: 1,
  }];
  const group = {
    groupId,
    dealId: groupId,
    groupStatus: 'recruiting',
    hostActorId,
    targetCount: 4,
    totalQuantity: 8,
    version: 3,
  };
  const legacyOrder = {
    id: 'order-170000000000201',
    type: 'group',
    status: 'new',
    paymentStatus: 'pending',
    groupId,
    dealId: groupId,
    visitorId: legacyActorId,
  };
  const orders = [legacyOrder, {
    id: 'order-170000000000202',
    type: 'purchase',
    status: 'new',
    paymentStatus: 'confirmed',
    groupId,
    dealId: groupId,
    participantActorId: 'visitor-transition-payment-order-only',
  }, {
    id: 'order-170000000000203',
    type: 'purchase',
    status: 'new',
    paymentStatus: 'pending',
    groupId: 'owner-transition-other-group',
    dealId: 'owner-transition-other-group',
    participantActorId: 'visitor-transition-other-group',
  }, {
    id: 'order-170000000000204',
    type: 'group',
    status: 'new',
    paymentStatus: 'pending',
    groupId,
    dealId: 'owner-transition-other-deal',
    participantActorId: 'visitor-transition-other-deal',
  }, {
    id: 'order-170000000000205',
    type: 'purchase',
    status: 'new',
    paymentStatus: 'pending',
    groupId,
    dealId: groupId,
    participantActorId: adminActorId,
  }, {
    id: 'order-170000000000206',
    type: 'group',
    status: 'cancelled',
    paymentStatus: 'pending',
    groupId,
    dealId: groupId,
    participantActorId: 'visitor-transition-cancelled-order',
  }];
  let committed = null;
  context.findMutation_ = () => null;
  context.authorizeGroupActor_ = () => ({
    actorId: hostActorId,
    role: 'host',
    participant: participants[0],
  });
  context.getGroupRecord_ = () => group;
  context.getParticipantsForGroup_ = () => participants;
  context.storedCustomerOrders_ = () => orders;
  context.invalidateGroupSnapshot_ = () => {};
  context.commitGroupMutationIntent_ = (
    _sheets,
    historyData,
    mutationContract,
    completionResult,
    operations,
  ) => {
    committed = { historyData, mutationContract, completionResult, operations };
  };
  const sheets = { publicDeals: {}, customerOrders: {} };
  const paymentActors = context.groupPaymentActors_(sheets, groupId, participants);
  assert.equal(paymentActors.some((item) => item.actorId === legacyActorId), true);
  assert.equal(
    paymentActors.some((item) => item.actorId === 'visitor-transition-payment-order-only'),
    true,
  );
  assert.equal(paymentActors.some((item) => item.actorId === adminActorId), false);
  assert.equal(
    paymentActors.some((item) => item.actorId === 'visitor-transition-other-group'),
    false,
  );
  assert.equal(
    paymentActors.some((item) => item.actorId === 'visitor-transition-other-deal'),
    false,
  );

  assert.throws(
    () => context.executeGroupMutation_('transition_group', {
      groupId,
      actorId: hostActorId,
      direction: 'next',
      fromStatus: 'recruiting',
      toStatus: 'recruited',
      expectedVersion: 3,
      capabilityHash: 'c'.repeat(64),
      clientMutationId: 'transition-payment-union-blocked',
    }, sheets),
    (error) => error?.code === 'payments_not_confirmed',
  );
  assert.equal(group.groupStatus, 'recruiting');
  assert.equal(group.version, 3);
  assert.equal(committed, null);

  legacyOrder.paymentStatus = 'confirmed';
  context.executeGroupMutation_('transition_group', {
    groupId,
    actorId: hostActorId,
    direction: 'next',
    fromStatus: 'recruiting',
    toStatus: 'recruited',
    expectedVersion: 3,
    capabilityHash: 'c'.repeat(64),
    clientMutationId: 'transition-payment-union-confirmed',
  }, sheets);

  assert.equal(group.groupStatus, 'recruited');
  assert.equal(group.version, 4);
  assert.equal(committed.historyData.action, 'transition_group');
  assert.equal(committed.operations[0].target.groupStatus, 'recruited');
  const contract = JSON.parse(committed.mutationContract);
  assert.equal(contract.fromStatus, 'recruiting');
  assert.equal(contract.toStatus, 'recruited');

  assert.throws(
    () => context.executeGroupMutation_('transition_group', {
      groupId,
      actorId: hostActorId,
      direction: 'next',
      fromStatus: 'recruiting',
      toStatus: 'recruited',
      expectedVersion: 4,
      capabilityHash: 'c'.repeat(64),
      clientMutationId: 'transition-stale-from-status',
    }, sheets),
    (error) => error?.code === 'state_conflict',
  );
  assert.throws(
    () => context.executeGroupMutation_('transition_group', {
      groupId,
      actorId: hostActorId,
      direction: 'next',
      fromStatus: 'recruited',
      toStatus: 'delivered',
      expectedVersion: 4,
      capabilityHash: 'c'.repeat(64),
      clientMutationId: 'transition-skipped-to-status',
    }, sheets),
    (error) => error?.code === 'invalid_state_transition',
  );
});

test('Apps Script payment transitions bind the exact participant from and to states', () => {
  const context = appsScriptContext();
  const groupId = 'customer-payment-intent-contract';
  const actorId = 'visitor-payment-intent-contract';
  const group = {
    groupId,
    dealId: groupId,
    groupStatus: 'recruiting',
    version: 1,
  };
  const participant = {
    groupId,
    actorId,
    role: 'member',
    counted: true,
    paymentStatus: 'pending',
    selectedQuantity: 1,
    version: 1,
  };
  let committed = null;
  context.findMutation_ = () => null;
  context.authorizeGroupActor_ = () => ({ actorId, role: 'member', participant });
  context.getGroupRecord_ = () => group;
  context.getParticipantRecord_ = () => participant;
  context.planGroupPaymentOrders_ = () => ({ records: [], changedRecords: [] });
  context.commitGroupMutationIntent_ = (
    _sheets,
    historyData,
    mutationContract,
    completionResult,
    operations,
  ) => {
    committed = { historyData, mutationContract, completionResult, operations };
  };

  context.executeGroupMutation_('transition_payment', {
    groupId,
    actorId,
    participantActorId: actorId,
    direction: 'next',
    fromStatus: 'pending',
    toStatus: 'requested',
    expectedVersion: 1,
    capabilityHash: 'd'.repeat(64),
    clientMutationId: 'transition-payment-intent-contract',
  }, {});

  assert.equal(participant.paymentStatus, 'requested');
  assert.equal(participant.version, 2);
  assert.equal(committed.historyData.fromStatus, 'pending');
  assert.equal(committed.historyData.toStatus, 'requested');
  const contract = JSON.parse(committed.mutationContract);
  assert.equal(contract.fromStatus, 'pending');
  assert.equal(contract.toStatus, 'requested');

  assert.throws(
    () => context.executeGroupMutation_('transition_payment', {
      groupId,
      actorId,
      participantActorId: actorId,
      direction: 'next',
      fromStatus: 'pending',
      toStatus: 'requested',
      expectedVersion: 2,
      capabilityHash: 'd'.repeat(64),
      clientMutationId: 'transition-payment-stale-from',
    }, {}),
    (error) => error?.code === 'state_conflict',
  );
});

test('Apps Script payment transitions return the authoritative updated order', () => {
  const context = appsScriptContext();
  const groupId = 'customer-payment-order-response';
  const actorId = 'visitor-payment-order-response';
  const updatedOrder = {
    id: 'order-178877665544332211',
    groupId,
    dealId: groupId,
    visitorId: actorId,
    participantActorId: actorId,
    type: 'purchase',
    paymentStatus: 'requested',
    quantity: 1,
    selectedCount: 1,
    version: 2,
    paymentVersion: 2,
  };
  const group = { groupId, dealId: groupId, groupStatus: 'recruiting', version: 1 };
  const participant = {
    groupId,
    actorId,
    role: 'member',
    counted: true,
    paymentStatus: 'pending',
    selectedQuantity: 1,
    version: 1,
  };
  let completionResult = null;
  context.findMutation_ = () => null;
  context.authorizeGroupActor_ = () => ({ actorId, role: 'member', participant });
  context.getGroupRecord_ = () => group;
  context.getParticipantRecord_ = () => participant;
  context.planGroupPaymentOrders_ = () => ({
    records: [{ rowNumber: 2, beforeVersion: 1, order: updatedOrder }],
    changedRecords: [{ rowNumber: 2, beforeVersion: 1, order: updatedOrder }],
  });
  context.commitGroupMutationIntent_ = (_sheets, _history, _contract, result) => {
    completionResult = result;
  };

  const result = context.executeGroupMutation_('transition_payment', {
    groupId,
    actorId,
    participantActorId: actorId,
    direction: 'next',
    fromStatus: 'pending',
    toStatus: 'requested',
    expectedVersion: 1,
    capabilityHash: 'e'.repeat(64),
    clientMutationId: 'transition-payment-order-response',
  }, {});

  assert.equal(result.order, updatedOrder);
  assert.equal(completionResult.adjustedOrderId, updatedOrder.id);
  assert.equal(completionResult.syncedOrderCount, 1);

  // A committed request whose response was lost must return the same current
  // order on retry, without advancing the participant or writing twice.
  context.findMutation_ = () => ({ groupId, actorId, result: completionResult });
  context.plannedGroupPaymentOrderRecords_ = () => [{ order: updatedOrder }];
  context.getCustomerOrderRecord_ = (_sheets, id) => {
    assert.equal(id, updatedOrder.id);
    return { order: updatedOrder };
  };
  context.commitGroupMutationIntent_ = () => assert.fail('retry must not write');
  const replay = context.executeGroupMutation_('transition_payment', {
    groupId,
    actorId,
    participantActorId: actorId,
    direction: 'next',
    fromStatus: 'pending',
    toStatus: 'requested',
    expectedVersion: 1,
    capabilityHash: 'e'.repeat(64),
    clientMutationId: 'transition-payment-order-response',
  }, {});
  assert.equal(replay.duplicate, true);
  assert.equal(replay.order, updatedOrder);
  assert.equal(participant.version, 2);
});

test('Apps Script reservation rollback is exact, idempotent, and leaves a retryable participant', () => {
  const context = appsScriptContext();
  const groupId = 'customer-reservation-rollback-server';
  const actorId = 'visitor-reservation-rollback-server';
  const participant = {
    groupId,
    actorId,
    role: 'member',
    counted: true,
    paymentStatus: 'pending',
    selectedQuantity: 2,
    version: 1,
  };
  const group = {
    groupId,
    dealId: groupId,
    groupStatus: 'recruiting',
    hostMode: 'recruiting',
    hostActorId: '',
    totalQuantity: 6,
    version: 1,
  };
  const joinMutationId = 'join-reservation-rollback-server';
  const history = [{
    rowNumber: 2,
    groupId,
    actorId,
    action: 'join',
    mutationId: joinMutationId,
    fromStatus: '',
    toStatus: 'joined',
    result: {
      mutationContract: JSON.stringify({
        action: 'join',
        groupId,
        actorId,
        requestedRole: 'member',
        selectedQuantity: 2,
      }),
    },
  }];
  const sheets = {
    customerOrders: {
      getLastRow() { return 1; },
    },
    publicDeals: {},
  };

  context.findMutation_ = (_sheets, mutationId, action) => {
    const entry = history.find((item) => item.mutationId === mutationId);
    if (!entry) return null;
    if (entry.action !== action) {
      const error = new Error('client_mutation_conflict');
      error.code = 'client_mutation_conflict';
      throw error;
    }
    return { groupId, actorId, result: entry.result || {} };
  };
  context.authorizeGroupActor_ = () => ({ actorId, role: participant.role, participant });
  context.getGroupRecord_ = () => group;
  context.customerOrderReservationHistory_ = () => history;
  context.getParticipantsForGroup_ = () => [participant];
  context.activePublicDealRecord_ = () => ({ id: groupId, source: 'customer', visibility: 'public' });
  context.merchantGroupSeed_ = () => null;
  context.updateParticipantRow_ = () => {};
  context.updateGroupRow_ = () => {};
  context.invalidateGroupSnapshot_ = () => {};
  context.appendGroupHistory_ = (_sheets, data) => {
    history.push({
      rowNumber: history.length + 2,
      groupId: data.groupId,
      actorId: data.actorId,
      action: data.action,
      mutationId: data.clientMutationId,
      fromStatus: String(data.fromStatus || ''),
      toStatus: String(data.toStatus || ''),
      result: data.result || {},
    });
  };

  assert.throws(
    () => context.executeGroupMutation_('rollback_reservation', {
      groupId,
      actorId,
      reservationMutationId: joinMutationId,
      quantity: 1,
      capabilityHash: 'a'.repeat(64),
      clientMutationId: 'rollback-reservation-server-wrong-quantity',
    }, sheets),
    (error) => error?.code === 'reservation_quantity_mismatch',
  );

  context.boundCustomerOrderReservations_ = () => ({ [joinMutationId]: 'order-1234567890999' });
  assert.throws(
    () => context.executeGroupMutation_('rollback_reservation', {
      groupId,
      actorId,
      reservationMutationId: joinMutationId,
      quantity: 2,
      capabilityHash: 'a'.repeat(64),
      clientMutationId: 'rollback-reservation-server-bound',
    }, sheets),
    (error) => error?.code === 'reservation_already_bound',
  );
  context.boundCustomerOrderReservations_ = () => ({});

  // Compensation must remain available after the recruiting window closes and
  // after the public deal is soft-deleted. A durable order failure can be
  // discovered after either transition, and leaving the reservation behind
  // would permanently consume capacity.
  group.groupStatus = 'delivered';
  context.activePublicDealRecord_ = () => null;
  const first = context.executeGroupMutation_('rollback_reservation', {
    groupId,
    actorId,
    reservationMutationId: joinMutationId,
    quantity: 2,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'rollback-reservation-server-one',
  }, sheets);
  assert.equal(first.duplicate, false);
  assert.equal(participant.selectedQuantity, 0);
  assert.equal(participant.counted, false);
  assert.equal(group.version, 2);

  const sameMutationReplay = context.executeGroupMutation_('rollback_reservation', {
    groupId,
    actorId,
    reservationMutationId: joinMutationId,
    quantity: 2,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'rollback-reservation-server-one',
  }, sheets);
  assert.equal(sameMutationReplay.duplicate, true);
  assert.equal(participant.selectedQuantity, 0);
  assert.equal(group.version, 2);

  const alternateMutationReplay = context.executeGroupMutation_('rollback_reservation', {
    groupId,
    actorId,
    reservationMutationId: joinMutationId,
    quantity: 2,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'rollback-reservation-server-two',
  }, sheets);
  assert.equal(alternateMutationReplay.unchanged, true);
  assert.equal(participant.selectedQuantity, 0);
  assert.equal(group.version, 2);

  assert.throws(
    () => context.selectCustomerOrderReservation_(history, {}, {
      selectedCount: 2,
      reservationMutationId: joinMutationId,
    }, participant),
    (error) => error?.code === 'order_reservation_unverified',
  );

  group.groupStatus = 'recruiting';
  context.activePublicDealRecord_ = () => ({ id: groupId, source: 'customer', visibility: 'public' });
  const reserveMutationId = 'reserve-after-rollback-server';
  context.executeGroupMutation_('reserve_quantity', {
    groupId,
    actorId,
    quantity: 2,
    expectedVersion: participant.version,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: reserveMutationId,
  }, sheets);
  assert.equal(participant.counted, true);
  assert.equal(participant.selectedQuantity, 2);
  const reserveHistory = history.find((item) => item.mutationId === reserveMutationId);
  assert.equal(reserveHistory.result.reactivated, true);

  const creatorRollback = context.executeGroupMutation_('rollback_reservation', {
    groupId,
    actorId,
    reservationMutationId: reserveMutationId,
    quantity: 2,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'rollback-reserve-retry-server',
  }, sheets);
  assert.equal(participant.counted, false);
  assert.equal(participant.selectedQuantity, 0);

  const firstAdditionalReservation = 'reserve-multi-rollback-a';
  context.executeGroupMutation_('reserve_quantity', {
    groupId,
    actorId,
    quantity: 2,
    expectedVersion: participant.version,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: firstAdditionalReservation,
  }, sheets);
  const secondAdditionalReservation = 'reserve-multi-rollback-b';
  context.executeGroupMutation_('reserve_quantity', {
    groupId,
    actorId,
    quantity: 3,
    expectedVersion: participant.version,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: secondAdditionalReservation,
  }, sheets);
  assert.equal(participant.selectedQuantity, 5);

  context.executeGroupMutation_('rollback_reservation', {
    groupId,
    actorId,
    reservationMutationId: firstAdditionalReservation,
    quantity: 2,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'rollback-multi-reservation-a',
  }, sheets);
  assert.equal(participant.selectedQuantity, 3);
  assert.equal(participant.counted, true);
  context.executeGroupMutation_('rollback_reservation', {
    groupId,
    actorId,
    reservationMutationId: secondAdditionalReservation,
    quantity: 3,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'rollback-multi-reservation-b',
  }, sheets);
  assert.equal(participant.selectedQuantity, 0);
  assert.equal(participant.counted, false);

  const creatorReservationMutationId = 'create-reservation-rollback-server';
  participant.role = 'host';
  participant.counted = true;
  participant.selectedQuantity = 2;
  group.hostActorId = actorId;
  history.push({
    rowNumber: history.length + 2,
    groupId,
    actorId,
    action: 'create',
    mutationId: creatorReservationMutationId,
    fromStatus: '',
    toStatus: 'recruiting',
    result: {
      mutationContract: JSON.stringify({
        action: 'create',
        groupId,
        actorId,
        selectedQuantity: 2,
      }),
    },
  });
  context.executeGroupMutation_('rollback_reservation', {
    groupId,
    actorId,
    reservationMutationId: creatorReservationMutationId,
    quantity: 2,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'rollback-create-reservation-server',
  }, sheets);
  assert.equal(participant.selectedQuantity, 0);
  assert.equal(participant.counted, false);
  assert.equal(group.hostActorId, '');
  assert.equal(history.at(-1).result.reservationAction, 'create');
  const creatorRollbackVersion = group.version;

  const duplicateCreatorRollback = context.executeGroupMutation_('rollback_reservation', {
    groupId,
    actorId,
    reservationMutationId: creatorReservationMutationId,
    quantity: 2,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'rollback-create-reservation-server',
  }, sheets);
  assert.equal(creatorRollback.duplicate, false);
  assert.equal(duplicateCreatorRollback.duplicate, true);
  assert.equal(group.version, creatorRollbackVersion);

  const alternateCreatorRollback = context.executeGroupMutation_('rollback_reservation', {
    groupId,
    actorId,
    reservationMutationId: creatorReservationMutationId,
    quantity: 2,
    capabilityHash: 'a'.repeat(64),
    clientMutationId: 'rollback-create-reservation-server-retry',
  }, sheets);
  assert.equal(alternateCreatorRollback.unchanged, true);
  assert.equal(group.version, creatorRollbackVersion);
});

test('Apps Script customer groups reject zero-quantity member joins', () => {
  const context = appsScriptContext();
  const group = {
    groupId: 'customer-zero-quantity-server',
    dealId: 'customer-zero-quantity-server',
    groupStatus: 'recruiting',
    targetCount: 3,
    totalQuantity: 5,
    lastMessageSeq: 0,
    version: 1,
  };
  context.findMutation_ = () => null;
  context.activePublicDealRecord_ = () => ({
    id: group.groupId,
    source: 'customer',
    visibility: 'public',
  });
  context.findExactRow_ = () => ({ getRow: () => 2 });
  context.getGroupRecord_ = () => group;
  context.getParticipantRecord_ = () => null;
  context.getParticipantsForGroup_ = () => [];
  context.appendParticipant_ = () => { throw new Error('unexpected_participant_write'); };
  context.appendGroupHistory_ = () => {};
  context.invalidateGroupSnapshot_ = () => {};

  assert.throws(
    () => context.executeGroupMutation_('join', {
      groupId: group.groupId,
      actorId: 'visitor-zero-quantity-server',
      nickname: '비참여자',
      requestedRole: 'member',
      selectedQuantity: 0,
      capabilityHash: 'a'.repeat(64),
      clientMutationId: 'mutation-zero-quantity-server',
    }, { publicDeals: {} }),
    (error) => error?.code === 'invalid_quantity',
  );
});

test('inactive group capabilities cannot read chat/history or perform ordinary mutations', () => {
  const context = appsScriptContext();
  const groupId = 'customer-inactive-capability';
  const actorId = 'visitor-inactive-capability';
  const inactiveParticipant = {
    actorId,
    role: 'creator',
    counted: false,
    selectedQuantity: 0,
    paymentStatus: 'pending',
    lastReadSeq: 2,
    capabilityHash: 'a'.repeat(64),
    rowNumber: 7,
    version: 3,
  };
  context.baseGroupSnapshot_ = () => ({
    group: { groupId, lastMessageSeq: 4, version: 2 },
    participants: [{
      actorId,
      role: 'creator',
      counted: false,
      selectedQuantity: 0,
      paymentStatus: 'pending',
      lastReadSeq: 2,
      version: 3,
    }, { actorId: 'visitor-other', role: 'member', counted: true }],
    messages: [{ body: 'private message' }],
    history: [{ action: 'send_message' }],
    lastSeq: 4,
  });
  const actor = { actorId, role: 'creator', participant: inactiveParticipant };
  const snapshot = context.buildGroupSnapshot_({}, groupId, actor);
  assert.equal(snapshot.messages.length, 0);
  assert.equal(snapshot.history.length, 0);
  assert.equal(snapshot.participants.length, 1);
  assert.equal(snapshot.participants[0].actorId, actorId);
  assert.equal('capabilityHash' in snapshot.participants[0], false);
  assert.equal(snapshot.viewer.active, false);
  assert.equal(snapshot.unreadCount, 0);

  context.findMutation_ = () => null;
  context.authorizeGroupActor_ = () => actor;
  context.getGroupRecord_ = () => ({
    groupId,
    groupStatus: 'recruiting',
    lastMessageSeq: 4,
    version: 2,
  });
  assert.throws(
    () => context.executeGroupMutation_('send_message', {
      groupId,
      actorId,
      body: 'should not send',
      capabilityHash: 'a'.repeat(64),
      clientMutationId: 'inactive-message-mutation',
    }, {}),
    (error) => error?.code === 'forbidden',
  );
  assert.throws(
    () => context.executeGroupMutation_('update_target', {
      groupId,
      actorId,
      targetCount: 3,
      expectedVersion: 2,
      capabilityHash: 'a'.repeat(64),
      clientMutationId: 'inactive-target-mutation',
    }, {}),
    (error) => error?.code === 'forbidden',
  );
});

test('Apps Script merchant joins cannot mint a capability from a victim order actor with zero quantity', () => {
  const context = appsScriptContext();
  const actorId = 'victim-merchant-order-actor';
  const group = {
    groupId: 'owner-merchant-zero-quantity-server',
    dealId: 'owner-merchant-zero-quantity-server',
    groupStatus: 'recruiting',
    targetCount: 3,
    totalQuantity: 5,
    lastMessageSeq: 0,
    version: 1,
  };
  const merchantDeal = {
    id: group.groupId,
    source: 'merchant',
    saleType: 'group',
    visibility: 'public',
    title: '피해자 주문이 있는 사장님 공구',
    targetCount: group.targetCount,
    totalQuantity: group.totalQuantity,
  };
  let participantWritten = false;
  context.findMutation_ = () => null;
  context.activePublicDealRecord_ = () => merchantDeal;
  context.findExactRow_ = () => 2;
  context.getGroupRecord_ = () => group;
  context.getParticipantRecord_ = () => null;
  context.getParticipantsForGroup_ = () => [];
  // This models the vulnerable pre-fix lookup: the caller supplies the
  // victim's actor id and the server finds that victim's active legacy order.
  context.activeMerchantActorAllocation_ = () => 2;
  context.activeMerchantAllocationsByActor_ = () => ({
    total: 2,
    byActor: { [actorId]: 2 },
  });
  context.appendParticipant_ = () => { participantWritten = true; };
  context.appendGroupHistory_ = () => {};
  context.invalidateGroupSnapshot_ = () => {};

  assert.throws(
    () => context.executeGroupMutation_('join', {
      groupId: group.groupId,
      actorId,
      nickname: '공격자',
      requestedRole: 'member',
      selectedQuantity: 0,
      capabilityHash: 'a'.repeat(64),
      clientMutationId: 'mutation-merchant-zero-server',
    }, {}),
    (error) => error?.code === 'invalid_quantity',
  );
  assert.equal(participantWritten, false);

  assert.throws(
    () => context.executeGroupMutation_('join', {
      groupId: group.groupId,
      actorId,
      nickname: '공격자',
      requestedRole: 'member',
      selectedQuantity: 1,
      capabilityHash: 'b'.repeat(64),
      clientMutationId: 'mutation-merchant-positive-server',
    }, {}),
    (error) => error?.code === 'order_actor_claim_requires_proof',
  );
  assert.equal(participantWritten, false);
});

test('Apps Script idempotency keys are bound to the exact group mutation contract', () => {
  const context = appsScriptContext();
  const originalPayload = {
    action: 'update_target',
    groupId: 'customer-contract-test',
    actorId: 'visitor-contract-test',
    targetCount: 3,
    expectedVersion: 2,
    clientMutationId: 'mutation-contract-test',
    capabilityHash: 'a'.repeat(64),
  };
  const originalContract = context.groupMutationContract_('update_target', originalPayload);
  context.findMutation_ = () => ({
    groupId: originalPayload.groupId,
    actorId: originalPayload.actorId,
    result: { mutationContract: originalContract },
  });
  context.authorizeGroupActor_ = () => ({
    actorId: originalPayload.actorId,
    role: 'host',
    participant: { actorId: originalPayload.actorId, role: 'host', counted: true },
  });

  const replay = context.executeGroupMutation_('update_target', originalPayload, {});
  assert.equal(replay.duplicate, true);
  assert.throws(
    () => context.executeGroupMutation_('update_target', {
      ...originalPayload,
      targetCount: 4,
    }, {}),
    (error) => error?.code === 'client_mutation_conflict',
  );

  const transitionPayload = {
    action: 'transition_group',
    groupId: originalPayload.groupId,
    actorId: originalPayload.actorId,
    direction: 'next',
    fromStatus: 'recruiting',
    toStatus: 'recruited',
    expectedVersion: 2,
    clientMutationId: 'mutation-transition-contract',
    capabilityHash: 'a'.repeat(64),
  };
  const transitionContract = context.groupMutationContract_('transition_group', transitionPayload);
  context.findMutation_ = () => ({
    groupId: transitionPayload.groupId,
    actorId: transitionPayload.actorId,
    result: { mutationContract: transitionContract },
  });
  assert.equal(
    context.executeGroupMutation_('transition_group', transitionPayload, {}).duplicate,
    true,
  );
  assert.throws(
    () => context.executeGroupMutation_('transition_group', {
      ...transitionPayload,
      toStatus: 'purchased',
    }, {}),
    (error) => error?.code === 'client_mutation_conflict',
  );
});

test('a no-op mark-read still records its idempotency contract', () => {
  const context = appsScriptContext();
  const payload = {
    groupId: 'customer-read-contract',
    actorId: 'visitor-read-contract',
    lastReadSeq: 2,
    clientMutationId: 'mutation-read-contract',
    capabilityHash: 'a'.repeat(64),
  };
  const participant = {
    actorId: payload.actorId,
    role: 'member',
    counted: true,
    lastReadSeq: 2,
    version: 1,
  };
  let appended = null;
  context.findMutation_ = () => null;
  context.authorizeGroupActor_ = () => ({
    actorId: payload.actorId,
    role: 'member',
    participant,
  });
  context.getGroupRecord_ = () => ({ lastMessageSeq: 2 });
  context.appendGroupHistory_ = (_sheets, entry) => { appended = entry; };

  const result = context.executeGroupMutation_('mark_read', payload, {});
  assert.equal(result.unchanged, true);
  assert.equal(appended.result.unchanged, true);
  assert.equal(
    appended.result.mutationContract,
    context.groupMutationContract_('mark_read', payload),
  );
});

test('Apps Script deal deletion is recoverable and preserves owner/order authorization history', () => {
  const context = appsScriptContext();
  const ownerHash = 'a'.repeat(64);
  let existingDeal = {
    id: 'owner-soft-delete',
    source: 'merchant',
    visibility: 'public',
    region: '서울',
    district: '강남구',
    neighborhood: '역삼동',
    _ownerCapabilityHash: ownerHash,
    publishVersion: 1,
  };
  let storedRow = null;
  const sheet = {
    getLastRow() { return 2; },
    getRange(row, column) {
      if (row === 2 && column === 2) {
        return {
          createTextFinder() {
            return {
              matchEntireCell() { return this; },
              findNext() { return { getRow: () => 2 }; },
            };
          },
        };
      }
      if (row === 2 && column === 7) {
        return { getValue: () => JSON.stringify(existingDeal) };
      }
      if (row === 2 && column === 1) {
        return {
          setValues: (rows) => {
            storedRow = rows[0];
            existingDeal = JSON.parse(rows[0][6]);
          },
        };
      }
      throw new Error(`unexpected_range_${row}_${column}`);
    },
    deleteRow() { throw new Error('hard_delete_must_not_run'); },
  };
  context.ensureSheets_ = () => ({ publicDeals: sheet });
  context.acquireScriptLock_ = () => ({ releaseLock() {} });
  context.invalidatePublicDealsCache_ = () => {};
  context.json_ = (value) => value;

  const result = JSON.parse(JSON.stringify(
    context.deletePublicDeal_(
      'owner-soft-delete',
      ownerHash,
      1,
      'delete-owner-soft-delete-v1',
    ),
  ));
  const stored = JSON.parse(storedRow[6]);
  assert.deepEqual(result, { ok: true, deleted: true });
  assert.equal(stored.visibility, 'deleted');
  assert.equal(stored._ownerCapabilityHash, ownerHash);
  assert.match(stored.deletedAt, /^\d{4}-\d{2}-\d{2}T/);

  const lostResponseReplay = JSON.parse(JSON.stringify(
    context.deletePublicDeal_(
      'owner-soft-delete',
      ownerHash,
      1,
      'delete-owner-soft-delete-v1',
    ),
  ));
  assert.deepEqual(lostResponseReplay, { ok: true, deleted: true });

  const alreadyDeleted = JSON.parse(JSON.stringify(
    context.deletePublicDeal_(
      'owner-soft-delete',
      ownerHash,
      1,
      'delete-owner-soft-delete-v2',
    ),
  ));
  assert.deepEqual(alreadyDeleted, { ok: false, error: 'deal_deleted' });
});

test('a delayed publish cannot resurrect a soft-deleted deal with the same owner capability', () => {
  const context = appsScriptContext();
  const ownerHash = 'e'.repeat(64);
  const deletedDeal = {
    id: 'owner-no-stale-resurrection',
    source: 'merchant',
    saleType: 'instant',
    originalPrice: 10000,
    discountRate: 0,
    visibility: 'deleted',
    deletedAt: '2026-09-01T01:00:00.000Z',
    _ownerCapabilityHash: ownerHash,
    publishVersion: 2,
  };
  const sheet = {
    getLastRow() { return 2; },
    getRange(row, column) {
      if (row === 2 && column === 2) {
        return {
          createTextFinder() {
            return {
              matchEntireCell() { return this; },
              findNext() { return { getRow: () => 2 }; },
            };
          },
        };
      }
      if (row === 2 && column === 7) {
        return { getValue: () => JSON.stringify(deletedDeal) };
      }
      throw new Error(`stale_publish_must_not_write_${row}_${column}`);
    },
  };
  context.ensureSheets_ = () => ({ publicDeals: sheet });
  context.acquireScriptLock_ = () => ({ releaseLock() {} });
  context.json_ = (value) => value;

  const result = JSON.parse(JSON.stringify(context.publishPublicDeal_({
    ...deletedDeal,
    visibility: 'public',
    deletedAt: undefined,
    title: '지연된 상품 수정',
    publishVersion: 2,
    expectedPublishVersion: 2,
    publishMutationId: 'publish-stale-after-delete',
  }, ownerHash)));
  assert.deepEqual(result, { ok: false, error: 'deal_deleted' });
});

test('deal_deleted is exposed as a terminal 409 conflict', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
    GOOGLE_SHEETS_COLLECTOR_URL: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
  };
  delete process.env.O2O_DATA_API_ORIGIN;
  delete process.env.O2O_DATA_API_TOKEN;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: false, error: 'deal_deleted' }; },
  });

  try {
    const response = await invoke(publicDealsHandler, {
      action: 'delete',
      dealId: 'owner-no-stale-resurrection',
      capabilityToken: `deal-${'e'.repeat(64)}`,
      expectedPublishVersion: 2,
      clientMutationId: 'delete-replay-after-delete',
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, { ok: false, error: 'deal_deleted' });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('deal_too_large is exposed as terminal 413 instead of a retryable gateway failure', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
    GOOGLE_SHEETS_COLLECTOR_URL: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
  };
  delete process.env.O2O_DATA_API_ORIGIN;
  delete process.env.O2O_DATA_API_TOKEN;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: false, error: 'deal_too_large' }; },
  });

  try {
    const response = await invoke(publicDealsHandler, {
      action: 'publish',
      capabilityToken: `deal-${'e'.repeat(64)}`,
      deal: {
        id: 'owner-too-large-terminal',
        source: 'merchant',
        saleType: 'instant',
        visibility: 'public',
        originalPrice: 10000,
        discountRate: 0,
        totalQuantity: 1,
        expectedPublishVersion: 0,
        publishMutationId: 'publish-too-large-terminal',
      },
    });
    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.body, { ok: false, error: 'deal_too_large' });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('soft-deleted deals cannot provision or accept a new group participant', () => {
  const context = appsScriptContext();
  const deletedDeal = {
    id: 'owner-deleted-group',
    source: 'merchant',
    saleType: 'group',
    visibility: 'deleted',
    totalQuantity: 10,
    targetCount: 5,
  };
  const sheets = {
    publicDeals: {},
    groups: { appendRow() { throw new Error('deleted_deal_must_not_provision'); } },
  };
  context.findExactRow_ = () => 0;
  context.activePublicDealRecord_ = () => null;
  assert.equal(
    context.ensureMerchantGroupForJoin_(
      sheets,
      deletedDeal.id,
      '2026-09-01T01:00:00.000Z',
      deletedDeal,
    ),
    false,
  );

  context.findMutation_ = () => null;
  assert.throws(
    () => context.executeGroupMutation_('join', {
      groupId: deletedDeal.id,
      actorId: 'visitor-deleted-join',
      nickname: '삭제 상품 참여자',
      selectedQuantity: 1,
      capabilityHash: 'b'.repeat(64),
      clientMutationId: 'mutation-deleted-join',
    }, sheets),
    (error) => error?.code === 'deal_not_found',
  );
});

test('soft-deleted deals reject new quantity reservations while keeping prior group state readable', () => {
  const context = appsScriptContext();
  const groupId = 'owner-deleted-reservation';
  context.findMutation_ = () => null;
  context.authorizeGroupActor_ = () => ({
    actorId: 'visitor-deleted-reservation',
    role: 'member',
    participant: {
      actorId: 'visitor-deleted-reservation',
      role: 'member',
      counted: true,
      selectedQuantity: 1,
      version: 1,
    },
  });
  context.getGroupRecord_ = () => ({
    groupId,
    dealId: groupId,
    groupStatus: 'recruiting',
    totalQuantity: 10,
    version: 1,
  });
  context.activePublicDealRecord_ = () => null;

  assert.throws(
    () => context.executeGroupMutation_('reserve_quantity', {
      groupId,
      actorId: 'visitor-deleted-reservation',
      quantity: 1,
      expectedVersion: 1,
      capabilityHash: 'c'.repeat(64),
      clientMutationId: 'mutation-deleted-reserve',
    }, { publicDeals: {} }),
    (error) => error?.code === 'deal_not_found',
  );
});

test('soft-deleted deals reject new orders but allow idempotent updates to an existing order', () => {
  const context = appsScriptContext();
  const capabilityHash = 'd'.repeat(64);
  const deletedDeal = {
    id: 'owner-deleted-order',
    source: 'customer',
    visibility: 'deleted',
  };
  const incomingOrder = orderSnapshot({
    id: 'order-1234567890555',
    dealId: deletedDeal.id,
    deal: { id: deletedDeal.id },
    groupId: '',
    type: 'purchase',
    total: 12000,
  });
  let storedOrder = null;
  const sheets = {
    publicDeals: {},
    events: {},
    customerOrders: {
      getLastRow() { return 1; },
      getRange(row, column) {
        if (row === 2 && column === 1) {
          return {
            setValues(rows) {
              storedOrder = JSON.parse(rows[0][3]);
            },
          };
        }
        throw new Error(`unexpected_range_${row}_${column}`);
      },
    },
  };
  context.ensureSheets_ = () => sheets;
  context.acquireScriptLock_ = () => ({ releaseLock() {} });
  context.publicDealRecord_ = () => deletedDeal;
  context.historicCustomerOrdersById_ = () => [];
  context.appendCustomerOrderSnapshotEvent_ = () => true;
  context.invalidatePublicDealsCache_ = () => {};
  context.json_ = (value) => value;

  const rejected = JSON.parse(JSON.stringify(
    context.publishCustomerOrder_(incomingOrder, incomingOrder.visitorId, capabilityHash, ''),
  ));
  assert.deepEqual(rejected, { ok: false, error: 'deal_not_found' });
  assert.equal(storedOrder, null);

  context.historicCustomerOrdersById_ = () => [{ ...incomingOrder }];
  const legacyTakeover = JSON.parse(JSON.stringify(
    context.publishCustomerOrder_(incomingOrder, incomingOrder.visitorId, capabilityHash, ''),
  ));
  assert.deepEqual(legacyTakeover, { ok: false, error: 'order_ownership_unclaimable' });
  assert.equal(storedOrder, null);

  context.historicCustomerOrdersById_ = () => [{
    ...incomingOrder,
    _customerCapabilityHash: capabilityHash,
  }];
  const replayed = JSON.parse(JSON.stringify(
    context.publishCustomerOrder_(incomingOrder, incomingOrder.visitorId, capabilityHash, ''),
  ));
  assert.equal(replayed.ok, true);
  assert.equal(replayed.order.id, incomingOrder.id);
  assert.equal(storedOrder.id, incomingOrder.id);
  assert.equal(storedOrder._customerCapabilityHash, capabilityHash);
});

test('customer order history fails closed for legacy rows without a capability hash', () => {
  const context = appsScriptContext();
  const visitorId = 'visitor-known-to-merchant';
  const matchingHash = 'a'.repeat(64);
  const orders = [{
    id: 'order-1234567890601',
    visitorId,
    customerPhone: '01012345678',
  }, {
    id: 'order-1234567890602',
    visitorId,
    customerPhone: '01012345678',
    _customerCapabilityHash: matchingHash,
  }, {
    id: 'order-1234567890603',
    visitorId,
    customerPhone: '01012345678',
    _customerCapabilityHash: 'b'.repeat(64),
  }];

  const authorized = context.filterCustomerOrdersForProof_(orders, visitorId, matchingHash);
  assert.deepEqual(authorized.map((order) => order.id), ['order-1234567890602']);
});

test('public deal listing scans past deleted tombstones before applying the 500-item limit', () => {
  const context = appsScriptContext();
  const records = [{
    id: 'owner-visible-before-tombstones',
    visibility: 'public',
    syncedAt: '2026-08-01T00:00:00.000Z',
  }];
  for (let index = 0; index < 500; index += 1) {
    records.push({
      id: `owner-deleted-${index}`,
      visibility: 'deleted',
      syncedAt: `2026-09-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    });
  }
  const sheet = {
    getLastRow() { return records.length + 1; },
    getRange(row, column, count) {
      assert.equal(column, 7);
      return {
        getValues() {
          return records.slice(row - 2, row - 2 + count)
            .map((deal) => [JSON.stringify(deal)]);
        },
      };
    },
  };

  const result = JSON.parse(JSON.stringify(context.latestPublicDealValues_(sheet, 500)));
  assert.deepEqual(result.map((deal) => deal.id), ['owner-visible-before-tombstones']);
});

test('malformed and non-object upstream JSON is classified as a retryable gateway error', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      async json() { throw new SyntaxError('Unexpected token <'); },
    });
    await assert.rejects(
      fetchUpstreamJson('https://collector.example.test'),
      (error) => error?.code === 'upstream_invalid_response' && error?.status === 502,
    );

    globalThis.fetch = async () => ({
      ok: true,
      async json() { return null; },
    });
    await assert.rejects(
      fetchUpstreamJson('https://collector.example.test'),
      (error) => error?.code === 'upstream_invalid_response' && error?.status === 502,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('a legacy data proxy error body cannot masquerade as HTTP 200 success', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
  };
  process.env.O2O_DATA_API_ORIGIN = 'https://legacy-data.example.test';
  process.env.O2O_DATA_API_TOKEN = 'data-api-token';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: false, error: 'collector_busy' }; },
  });

  try {
    const response = await invoke(publicDealsHandler, { action: 'list' });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { ok: false, error: 'collector_busy' });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('a failing group data proxy cannot return a success envelope to the browser', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
  };
  process.env.O2O_DATA_API_ORIGIN = 'https://legacy-data.example.test';
  process.env.O2O_DATA_API_TOKEN = 'data-api-token';
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    async json() { return { ok: true, snapshot: {} }; },
  });

  try {
    const response = await invoke(groupOpsHandler, {
      action: 'snapshot',
      groupId: 'customer-proxy-integrity',
      actorId: 'visitor-proxy-integrity',
      capabilityToken: `group-${'a'.repeat(64)}`,
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { ok: false, error: 'data_api_failed' });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('a failing direct group collector cannot return a success envelope to the browser', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
    GOOGLE_SHEETS_COLLECTOR_URL: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
  };
  delete process.env.O2O_DATA_API_ORIGIN;
  delete process.env.O2O_DATA_API_TOKEN;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    async json() { return { ok: true, snapshot: {} }; },
  });

  try {
    const response = await invoke(groupOpsHandler, {
      action: 'snapshot',
      groupId: 'customer-direct-integrity',
      actorId: 'visitor-direct-integrity',
      capabilityToken: `group-${'b'.repeat(64)}`,
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { ok: false, error: 'data_api_failed' });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('stats use the data proxy without unrelated direct-collector credentials', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
    GOOGLE_SHEETS_COLLECTOR_URL: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
  };
  process.env.O2O_DATA_API_ORIGIN = 'https://legacy-data.example.test';
  process.env.O2O_DATA_API_TOKEN = 'data-api-token';
  delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: true, stats: { events: 12 } }; },
  });

  try {
    const response = await invokeGet(statsHandler);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true, stats: { events: 12 } });
    assert.equal(response.headers['Cache-Control'], 'no-store, max-age=0');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('analytics collection also uses the data proxy without direct-collector credentials', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
    GOOGLE_SHEETS_COLLECTOR_URL: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
  };
  process.env.O2O_DATA_API_ORIGIN = 'https://legacy-data.example.test';
  process.env.O2O_DATA_API_TOKEN = 'data-api-token';
  delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  globalThis.fetch = async () => ({
    ok: true,
    status: 202,
    async json() { return { ok: true, duplicate: false }; },
  });

  try {
    const response = await invoke(collectHandler, {
      event: {
        id: 'event-api-state-integrity',
        name: 'profile_submitted',
        timestamp: '2026-09-01T00:00:00.000Z',
        visitorId: 'visitor-api-state-integrity',
        sessionId: 'session-api-state-integrity',
        properties: { screen: 'home' },
      },
    });
    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.body, { ok: true, duplicate: false });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('stats preserve retryable proxy failures even when legacy HTTP status is 200', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
  };
  process.env.O2O_DATA_API_ORIGIN = 'https://legacy-data.example.test';
  process.env.O2O_DATA_API_TOKEN = 'data-api-token';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: false, error: 'collector_busy' }; },
  });

  try {
    const response = await invokeGet(statsHandler);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { ok: false, error: 'collector_busy' });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('missing participant payment request is a terminal state conflict, not a gateway failure', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
    GOOGLE_SHEETS_COLLECTOR_URL: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
  };
  delete process.env.O2O_DATA_API_ORIGIN;
  delete process.env.O2O_DATA_API_TOKEN;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: false, error: 'payment_request_required' }; },
  });

  try {
    const response = await invoke(customerOrdersHandler, {
      action: 'manage',
      managerType: 'merchant_owner',
      orderId: 'order-1234567890456',
      dealId: 'owner-order-integrity',
      kind: 'payment_status',
      direction: 'next',
      expectedVersion: 1,
      clientMutationId: 'manage-payment-integrity-1',
      ownerCapabilityToken: `owner-${'a'.repeat(64)}`,
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, { ok: false, error: 'payment_request_required' });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('group-order payment linkage failures remain explicit 409 conflicts at the browser boundary', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
    O2O_DATA_API_TOKEN: process.env.O2O_DATA_API_TOKEN,
    GOOGLE_SHEETS_COLLECTOR_URL: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
  };
  delete process.env.O2O_DATA_API_ORIGIN;
  delete process.env.O2O_DATA_API_TOKEN;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';

  try {
    for (const code of ['order_payment_link_required', 'order_payment_state_conflict']) {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        async json() { return { ok: false, error: code }; },
      });
      const response = await invoke(customerOrdersHandler, {
        action: 'manage',
        managerType: 'merchant_owner',
        orderId: 'order-1234567890456',
        dealId: 'owner-order-integrity',
        kind: 'payment_status',
        direction: 'next',
        expectedVersion: 1,
        clientMutationId: `manage-${code}`,
        ownerCapabilityToken: `owner-${'a'.repeat(64)}`,
      });
      assert.equal(response.statusCode, 409, code);
      assert.deepEqual(response.body, { ok: false, error: code });
    }
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});
