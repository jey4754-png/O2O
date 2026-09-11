import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import collectHandler from '../api/collect.js';
import customerOrdersHandler from '../api/customer-orders.js';
import groupHandler from '../api/group-ops.js';
import publicDealsHandler from '../api/public-deals.js';
import { dataApiOrigin, fetchUpstreamJson } from '../api/_data-upstream.js';
import { mergeCustomerOrderCollections, mergeOwnerOrderRefresh } from '../src/orderMerge.js';

function appsScriptContext() {
  const context = {};
  runInNewContext(
    readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'),
    context,
  );
  addAppsScriptDigestSupport(context);
  return context;
}

function addAppsScriptDigestSupport(context) {
  context.Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(_algorithm, value) {
      return [...createHash('sha256').update(String(value), 'utf8').digest()]
        .map((byte) => (byte > 127 ? byte - 256 : byte));
    },
  };
}

test('Apps Script rejects malformed public deal financial fields before persistence', () => {
  const context = appsScriptContext();
  const validDeal = {
    id: 'owner-apps-script-price-boundary',
    source: 'merchant',
    saleType: 'group',
    originalPrice: 10000,
    discountRate: 10,
    unitPrice: 9000,
    menu: [{ price: 9000 }],
  };
  assert.equal(context.publicDealPricingError_(validDeal), '');

  const invalidDeals = [
    { ...validDeal, originalPrice: -1 },
    { ...validDeal, originalPrice: 1.5 },
    { ...validDeal, originalPrice: Number.MAX_SAFE_INTEGER + 1 },
    { ...validDeal, discountRate: -1 },
    { ...validDeal, discountRate: 101 },
    { ...validDeal, unitPrice: -1 },
    { ...validDeal, unitPrice: 1.5 },
    { ...validDeal, menu: [{ price: -1 }] },
    { ...validDeal, menu: [{ price: 1.5 }] },
  ];
  invalidDeals.forEach((deal) => {
    assert.equal(context.publicDealPricingError_(deal), 'invalid_deal_price');
  });

  context.json_ = (value) => value;
  const rejected = context.publishPublicDeal_({
    ...validDeal,
    originalPrice: -1,
  }, 'a'.repeat(64));
  assert.deepEqual(JSON.parse(JSON.stringify(rejected)), {
    ok: false,
    error: 'invalid_deal_price',
  });
});

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

async function invoke(handler, request) {
  const response = responseRecorder();
  await handler({ method: 'POST', headers: {}, ...request }, response);
  return response;
}

test('data API proxy is used only when its dedicated token is configured', () => {
  const previousOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousToken = process.env.O2O_DATA_API_TOKEN;
  try {
    process.env.O2O_DATA_API_ORIGIN = 'https://legacy-data.example.test/';
    delete process.env.O2O_DATA_API_TOKEN;
    assert.equal(dataApiOrigin(), '');

    process.env.O2O_DATA_API_TOKEN = 'dedicated-data-api-token';
    assert.equal(dataApiOrigin(), 'https://legacy-data.example.test');
  } finally {
    if (previousOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousOrigin;
    if (previousToken === undefined) delete process.env.O2O_DATA_API_TOKEN;
    else process.env.O2O_DATA_API_TOKEN = previousToken;
  }
});

test('merchant group seed binds the public deal id and caps participant target at 20', () => {
  const context = appsScriptContext();
  const seed = JSON.parse(JSON.stringify(context.merchantGroupSeed_({
    id: 'owner-merchant-seed-test',
    source: 'merchant',
    saleType: 'group',
    title: '사과 공동구매',
    target: 80,
    totalQuantity: 80,
  }, 'owner-merchant-seed-test')));

  assert.deepEqual(seed, {
    groupId: 'owner-merchant-seed-test',
    dealId: 'owner-merchant-seed-test',
    title: '사과 공동구매',
    targetCount: 20,
    totalQuantity: 80,
    creatorActorId: 'merchant-owner-merchant-seed-test',
  });
  assert.equal(context.merchantGroupSeed_({
    id: 'owner-instant-seed-test',
    source: 'merchant',
    saleType: 'instant',
    totalQuantity: 5,
  }, 'owner-instant-seed-test'), null);
});

test('merchant publication provisions its group and repairs an interrupted append on replay', () => {
  const context = appsScriptContext();
  let storedDeal = null;
  let groupRow = null;
  let allowGroupAppend = false;

  const textFinder = (matches) => ({
    matchEntireCell() { return this; },
    findNext() { return matches ? { getRow: () => 2 } : null; },
  });
  const publicDeals = {
    getLastRow: () => (storedDeal ? 2 : 1),
    getRange(row, column) {
      if (row === 2 && column === 2) {
        return {
          createTextFinder(value) {
            return textFinder(Boolean(storedDeal && storedDeal.id === String(value)));
          },
        };
      }
      if (row === 2 && column === 7) {
        return { getValue: () => (storedDeal ? JSON.stringify(storedDeal) : '') };
      }
      if (row === 2 && column === 1) {
        return {
          setValues(rows) {
            storedDeal = JSON.parse(rows[0][6]);
          },
        };
      }
      throw new Error(`unexpected public deal range: ${row}:${column}`);
    },
  };
  const groups = {
    getLastRow: () => (groupRow ? 2 : 1),
    getRange(row, column) {
      if (row === 2 && column === 1) {
        return {
          createTextFinder(value) {
            return textFinder(Boolean(groupRow && groupRow[0] === String(value)));
          },
          getValues() {
            return [groupRow.slice()];
          },
        };
      }
      throw new Error(`unexpected group range: ${row}:${column}`);
    },
    appendRow(row) {
      if (!allowGroupAppend) throw new Error('simulated_group_append_failure');
      groupRow = row.slice();
    },
  };
  const sheets = {
    publicDeals,
    groups,
    groupParticipants: { getLastRow: () => 1 },
  };
  context.ensureSheets_ = () => sheets;
  context.acquireScriptLock_ = () => ({ releaseLock() {} });
  context.activeMerchantAllocationsByActor_ = () => ({ total: 0, byActor: {} });
  context.json_ = (value) => value;

  const deal = {
    id: 'owner-merchant-publish-atomic',
    groupId: 'owner-merchant-publish-atomic',
    source: 'merchant',
    saleType: 'group',
    title: '게시와 참여방 동시 생성',
    visibility: 'public',
    originalPrice: 10000,
    discountRate: 0,
    totalQuantity: 5,
    targetCount: 5,
    expectedPublishVersion: 0,
    publishMutationId: 'publish-merchant-atomic-001',
  };

  assert.throws(
    () => context.publishPublicDeal_(deal, 'a'.repeat(64)),
    /simulated_group_append_failure/,
  );
  assert.equal(groupRow, null);
  assert.equal(storedDeal._groupPublishPending, true);
  assert.equal(storedDeal._groupPublishRepair.type, 'group_append');

  allowGroupAppend = true;
  const replay = context.publishPublicDeal_(deal, 'a'.repeat(64));
  assert.equal(replay.ok, true);
  assert.equal(groupRow[0], deal.id);
  assert.equal(groupRow[1], deal.id);
  assert.equal(groupRow[4], 5);
  assert.equal(groupRow[14], 5);
  assert.equal(storedDeal._groupPublishPending, undefined);
  assert.equal(storedDeal._groupPublishRepair, undefined);
});

test('merchant group room capacity uses the actor union without double counting overlapping allocations', () => {
  const context = appsScriptContext();
  const usage = JSON.parse(JSON.stringify(context.merchantGroupCapacityUsage_([
    { actorId: 'participant-only', counted: true, selectedQuantity: 2 },
    { actorId: 'overlap', counted: true, selectedQuantity: 3 },
    { actorId: 'admin', counted: false, selectedQuantity: 99 },
  ], {
    total: 9,
    byActor: { overlap: 4, 'order-only': 5 },
  })));

  assert.equal(usage.quantity, 11);
  assert.equal(usage.participantCount, 3);
  assert.deepEqual(usage.byActor, {
    'participant-only': 2,
    overlap: 4,
    'order-only': 5,
  });
});

test('host role changes stay locked after payment even when the remainder is already zero', () => {
  const context = appsScriptContext();
  context.groupHostRemainder_ = () => 0;
  context.groupPaymentOrderRecords_ = () => [{
    rowNumber: 2,
    order: {
      id: 'order-1234567890777',
      paymentStatus: 'confirmed',
      hostRemainderApplied: 0,
      total: 10000,
      version: 2,
    },
  }];

  assert.throws(
    () => context.planHostRemainderOrders_(
      {},
      { groupId: 'customer-paid-host-role' },
      'visitor-paid-host-role',
      true,
      'mutation-paid-host-claim',
      '2026-09-02T00:00:00.000Z',
    ),
    (error) => error?.code === 'host_role_payment_locked',
  );
  assert.throws(
    () => context.planHostRemainderOrders_(
      {},
      { groupId: 'customer-paid-host-role' },
      'visitor-paid-host-role',
      false,
      'mutation-paid-host-release',
      '2026-09-02T00:00:00.000Z',
    ),
    (error) => error?.code === 'host_role_payment_locked',
  );
});

test('merchant product edits reject disjoint participant and legacy-order actors above target or stock', () => {
  const context = appsScriptContext();
  const group = {
    groupId: 'owner-disjoint-capacity-edit',
    targetCount: 2,
    totalQuantity: 6,
    version: 1,
  };
  const participants = [
    { actorId: 'participant-only', role: 'member', counted: true, selectedQuantity: 2 },
  ];
  const allocations = {
    total: 4,
    byActor: { 'order-only': 4 },
  };

  const belowQuantity = context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 5,
    targetCount: 2,
  }, group, participants, allocations);
  assert.equal(belowQuantity.error, 'quantity_below_active_allocations');
  assert.equal(belowQuantity.minimumQuantity, 6);

  const belowTarget = context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 6,
    targetCount: 1,
  }, group, participants, allocations);
  assert.equal(belowTarget.error, 'target_below_current');
  assert.equal(belowTarget.minimumTarget, 2);
});

test('merchant create and provision paths enforce active legacy actor capacity', () => {
  const context = appsScriptContext();
  const dealId = 'owner-disjoint-capacity-create';
  const activeAllocations = {
    total: 2,
    byActor: { 'legacy-a': 1, 'legacy-b': 1 },
  };
  const publicDeals = { getLastRow: () => 1 };
  context.ensureSheets_ = () => ({ publicDeals });
  context.acquireScriptLock_ = () => ({ releaseLock() {} });
  context.activeMerchantAllocationsByActor_ = () => activeAllocations;
  context.json_ = (value) => value;

  const createResult = context.publishPublicDeal_({
    id: dealId,
    source: 'merchant',
    saleType: 'group',
    visibility: 'public',
    originalPrice: 10000,
    discountRate: 0,
    totalQuantity: 2,
    targetCount: 1,
    publishVersion: 0,
    expectedPublishVersion: 0,
    publishMutationId: 'publish-merchant-capacity-create',
  }, 'a'.repeat(64));
  assert.equal(createResult.error, 'target_below_current');
  assert.equal(createResult.minimumTarget, 2);

  context.findExactRow_ = () => 0;
  assert.throws(
    () => context.ensureMerchantGroupForJoin_({
      publicDeals,
      groups: { appendRow() { throw new Error('under-capacity group must not be provisioned'); } },
    }, dealId, '2026-09-01T02:00:00.000Z', {
      id: dealId,
      source: 'merchant',
      saleType: 'group',
      visibility: 'public',
      totalQuantity: 2,
      targetCount: 1,
    }),
    (error) => error?.code === 'group_full',
  );
});

test('merchant join, reserve, and target update paths enforce disjoint actor union capacity', () => {
  const context = appsScriptContext();
  const groupId = 'owner-disjoint-capacity-mutations';
  const activeDeal = {
    id: groupId,
    source: 'merchant',
    saleType: 'group',
    visibility: 'public',
    totalQuantity: 6,
    targetCount: 3,
  };
  const participants = [
    { actorId: 'participant-a', role: 'member', counted: true, selectedQuantity: 2, version: 1 },
  ];
  const activeAllocations = { total: 3, byActor: { 'order-b': 3 } };
  const group = {
    groupId,
    dealId: groupId,
    groupStatus: 'recruiting',
    targetCount: 3,
    totalQuantity: 5,
    lastMessageSeq: 0,
    version: 1,
  };
  context.findMutation_ = () => null;
  context.activePublicDealRecord_ = () => activeDeal;
  context.findExactRow_ = () => 1;
  context.getGroupRecord_ = () => group;
  context.getParticipantRecord_ = () => null;
  context.getParticipantsForGroup_ = () => participants;
  context.activeMerchantAllocationsByActor_ = () => activeAllocations;

  assert.throws(
    () => context.executeGroupMutation_('join', {
      groupId,
      actorId: 'participant-c',
      nickname: '추가 참여자',
      selectedQuantity: 1,
      capabilityHash: 'b'.repeat(64),
      clientMutationId: 'mutation-disjoint-join',
    }, { publicDeals: {}, groups: {} }),
    (error) => error?.code === 'quantity_exceeds_total',
  );

  const reservingParticipant = {
    actorId: 'participant-c',
    role: 'member',
    counted: true,
    paymentStatus: 'pending',
    selectedQuantity: 1,
    version: 1,
  };
  group.totalQuantity = 6;
  context.authorizeGroupActor_ = () => ({
    actorId: reservingParticipant.actorId,
    role: reservingParticipant.role,
    participant: reservingParticipant,
  });
  context.customerOrderReservationHistory_ = () => [];
  context.getParticipantsForGroup_ = () => participants.concat([reservingParticipant]);
  assert.throws(
    () => context.executeGroupMutation_('reserve_quantity', {
      groupId,
      actorId: reservingParticipant.actorId,
      quantity: 1,
      expectedVersion: 1,
      capabilityHash: 'c'.repeat(64),
      clientMutationId: 'mutation-disjoint-reserve',
    }, { publicDeals: {} }),
    (error) => error?.code === 'quantity_exceeds_total',
  );

  context.authorizeGroupActor_ = () => ({ actorId: 'admin-actor', role: 'admin' });
  context.publicDealRecord_ = () => activeDeal;
  context.getParticipantsForGroup_ = () => participants;
  assert.throws(
    () => context.executeGroupMutation_('update_target', {
      groupId,
      actorId: 'admin-actor',
      targetCount: 1,
      expectedVersion: 1,
      capabilityHash: 'd'.repeat(64),
      clientMutationId: 'mutation-disjoint-target',
    }, {}),
    (error) => error?.code === 'invalid_target',
  );
});

test('merchant order-only actors cannot claim membership and existing members reserve from the active-order baseline', () => {
  const context = appsScriptContext();
  const groupId = 'owner-actor-baseline-reserve';
  const actorId = 'legacy-order-actor';
  const activeDeal = {
    id: groupId,
    source: 'merchant',
    saleType: 'group',
    visibility: 'public',
    totalQuantity: 7,
    targetCount: 1,
  };
  const group = {
    groupId,
    dealId: groupId,
    groupStatus: 'recruiting',
    targetCount: 1,
    totalQuantity: 7,
    lastMessageSeq: 0,
    version: 1,
  };
  const activeAllocations = { total: 5, byActor: { [actorId]: 5 } };
  let participant = null;

  context.findMutation_ = () => null;
  context.activePublicDealRecord_ = () => activeDeal;
  context.findExactRow_ = () => 1;
  context.getGroupRecord_ = () => group;
  context.getParticipantRecord_ = () => participant;
  context.getParticipantsForGroup_ = () => participant ? [participant] : [];
  context.activeMerchantAllocationsByActor_ = () => activeAllocations;
  context.appendParticipant_ = (_sheets, value) => { participant = value; };
  context.appendGroupHistory_ = () => {};
  context.invalidateGroupSnapshot_ = () => {};
  context.updateParticipantRow_ = () => {};
  context.updateGroupRow_ = () => {};
  context.customerOrderReservationHistory_ = () => [];

  assert.throws(
    () => context.executeGroupMutation_('join', {
      groupId,
      actorId,
      nickname: '기존 주문 참여자',
      selectedQuantity: 1,
      capabilityHash: 'e'.repeat(64),
      clientMutationId: 'mutation-baseline-join',
    }, { publicDeals: {}, groups: {} }),
    (error) => error?.code === 'order_actor_claim_requires_proof',
  );
  assert.equal(participant, null);

  participant = {
    actorId,
    nickname: '검증된 기존 참여자',
    role: 'member',
    counted: true,
    paymentStatus: 'pending',
    selectedQuantity: 0,
    version: 1,
  };

  context.authorizeGroupActor_ = () => ({ actorId, role: 'member', participant });
  context.executeGroupMutation_('reserve_quantity', {
    groupId,
    actorId,
    quantity: 1,
    expectedVersion: 1,
    capabilityHash: 'e'.repeat(64),
    clientMutationId: 'mutation-baseline-reserve-one',
  }, { publicDeals: {} });
  assert.equal(participant.selectedQuantity, 6);
  assert.equal(participant.version, 2);

  context.executeGroupMutation_('reserve_quantity', {
    groupId,
    actorId,
    quantity: 1,
    expectedVersion: 2,
    capabilityHash: 'e'.repeat(64),
    clientMutationId: 'mutation-baseline-reserve-two',
  }, { publicDeals: {} });
  assert.equal(participant.selectedQuantity, 7);

  group.totalQuantity = 8;
  participant.paymentStatus = 'confirmed';
  assert.throws(
    () => context.executeGroupMutation_('reserve_quantity', {
      groupId,
      actorId,
      quantity: 1,
      expectedVersion: 3,
      capabilityHash: 'e'.repeat(64),
      clientMutationId: 'mutation-after-payment-confirmed',
    }, { publicDeals: {} }),
    (error) => error?.code === 'quantity_reservation_closed',
  );
  assert.equal(participant.selectedQuantity, 7);
});

test('merchant legacy order allocation is projected into chat without persisting stale quantities', () => {
  const context = appsScriptContext();
  const participants = JSON.parse(JSON.stringify(context.reconcileMerchantGroupParticipants_([
    { actorId: 'legacy-active', role: 'member', counted: true, selectedQuantity: 0 },
    { actorId: 'reserved-new', role: 'member', counted: true, selectedQuantity: 2 },
    { actorId: 'legacy-cancelled', role: 'member', counted: true, selectedQuantity: 0 },
    { actorId: 'admin', role: 'admin', counted: false, selectedQuantity: 0 },
  ], {
    total: 4,
    byActor: { 'legacy-active': 4 },
  })));

  assert.equal(participants[0].selectedQuantity, 4);
  assert.equal(participants[0].counted, true);
  assert.equal(participants[1].selectedQuantity, 2);
  assert.equal(participants[1].counted, true);
  assert.equal(participants[2].selectedQuantity, 0);
  assert.equal(participants[2].counted, false);
  assert.equal(participants[3].counted, false);
});

test('merchant product edits plan group capacity atomically above active quantity and participant floors', () => {
  const context = appsScriptContext();
  const group = {
    groupId: 'owner-merchant-edit-plan',
    targetCount: 2,
    totalQuantity: 6,
    version: 4,
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
  const participants = [
    { actorId: 'reserved-member', role: 'member', counted: true, selectedQuantity: 2 },
    { actorId: 'legacy-member', role: 'member', counted: true, selectedQuantity: 0 },
  ];
  const allocations = {
    total: 4,
    byActor: { 'reserved-member': 2, 'legacy-member': 2 },
  };
  const originalGroup = JSON.parse(JSON.stringify(group));

  const belowQuantity = context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 3,
    targetCount: 2,
  }, group, participants, allocations, '2026-08-29T01:00:00.000Z');
  assert.equal(belowQuantity.ok, false);
  assert.equal(belowQuantity.error, 'quantity_below_active_allocations');
  assert.equal(belowQuantity.minimumQuantity, 4);
  assert.deepEqual(group, originalGroup);

  const belowParticipants = context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 8,
    targetCount: 1,
  }, group, participants, allocations, '2026-08-29T01:00:00.000Z');
  assert.equal(belowParticipants.ok, false);
  assert.equal(belowParticipants.error, 'target_below_current');
  assert.equal(belowParticipants.minimumTarget, 2);
  assert.deepEqual(group, originalGroup);

  assert.equal(context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 1000,
    targetCount: 2,
  }, group, participants, allocations).error, 'invalid_deal_capacity');
  assert.equal(context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 8,
    targetCount: 21,
  }, group, participants, allocations).error, 'invalid_target');

  const updated = JSON.parse(JSON.stringify(context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 8,
    targetCount: 3,
  }, group, participants, allocations, '2026-08-29T01:00:00.000Z')));
  assert.equal(updated.ok, true);
  assert.equal(updated.changed, true);
  assert.equal(updated.group.totalQuantity, 8);
  assert.equal(updated.group.targetCount, 3);
  assert.equal(updated.group.version, 5);
  assert.equal(updated.group.updatedAt, '2026-08-29T01:00:00.000Z');
  assert.deepEqual(group, originalGroup);
});

test('data API proxy bypasses the current Vercel deployment instead of self-calling', () => {
  const previous = {
    origin: process.env.O2O_DATA_API_ORIGIN,
    token: process.env.O2O_DATA_API_TOKEN,
    vercelEnv: process.env.VERCEL_ENV,
    vercelUrl: process.env.VERCEL_URL,
    productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  };
  try {
    process.env.O2O_DATA_API_ORIGIN = 'https://o2o-ten.vercel.app/';
    process.env.O2O_DATA_API_TOKEN = 'dedicated-data-api-token';
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    assert.equal(dataApiOrigin(), '');

    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = 'preview-o2o.example.test';
    process.env.O2O_DATA_API_ORIGIN = 'https://preview-o2o.example.test';
    assert.equal(dataApiOrigin(), '');

    process.env.O2O_DATA_API_ORIGIN = 'https://legacy-data.example.test';
    assert.equal(dataApiOrigin(), 'https://legacy-data.example.test');
  } finally {
    for (const [key, value] of Object.entries({
      O2O_DATA_API_ORIGIN: previous.origin,
      O2O_DATA_API_TOKEN: previous.token,
      VERCEL_ENV: previous.vercelEnv,
      VERCEL_URL: previous.vercelUrl,
      VERCEL_PROJECT_PRODUCTION_URL: previous.productionUrl,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('self-origin bypass sends API traffic directly to the configured collector', async () => {
  const previous = {
    fetch: globalThis.fetch,
    origin: process.env.O2O_DATA_API_ORIGIN,
    dataToken: process.env.O2O_DATA_API_TOKEN,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    vercelEnv: process.env.VERCEL_ENV,
  };
  process.env.O2O_DATA_API_ORIGIN = 'https://o2o-ten.vercel.app';
  process.env.O2O_DATA_API_TOKEN = 'data-api-token';
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  process.env.VERCEL_ENV = 'production';
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(url);
    return {
      ok: true,
      async json() { return { ok: true, deals: [] }; },
    };
  };
  try {
    const response = await invoke(publicDealsHandler, {
      headers: { origin: 'https://o2o-ten.vercel.app' },
      body: { action: 'list' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(requestedUrls, ['https://collector.example.test']);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      O2O_DATA_API_ORIGIN: previous.origin,
      O2O_DATA_API_TOKEN: previous.dataToken,
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      VERCEL_ENV: previous.vercelEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('upstream timeouts are normalized before the Vercel function deadline', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error('request exceeded deadline');
    error.name = 'TimeoutError';
    throw error;
  };
  try {
    await assert.rejects(
      fetchUpstreamJson('https://collector.example.test', { method: 'POST' }),
      (error) => error?.code === 'upstream_timeout' && error?.status === 504,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('data APIs return 504 when Apps Script exceeds the bounded upstream deadline', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
    dataToken: process.env.O2O_DATA_API_TOKEN,
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  process.env.O2O_DATA_API_TOKEN = 'service-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  globalThis.fetch = async () => {
    const error = new Error('request exceeded deadline');
    error.name = 'TimeoutError';
    throw error;
  };

  try {
    const serviceHeaders = { 'x-o2o-service-token': 'service-token' };
    const requests = [
      [publicDealsHandler, { action: 'list' }],
      [customerOrdersHandler, {
        action: 'list',
        phone: '01012345678',
        visitorId: 'visitor-timeout-test',
        customerCapabilityHash: 'a'.repeat(64),
      }],
      [groupHandler, {
        action: 'snapshot',
        groupId: 'customer-timeout-test',
        actorId: 'visitor-timeout-test',
        capabilityHash: 'b'.repeat(64),
      }],
    ];
    for (const [handler, body] of requests) {
      const response = await invoke(handler, { headers: serviceHeaders, body });
      assert.equal(response.statusCode, 504);
      assert.deepEqual(response.body, { ok: false, error: 'upstream_timeout' });
    }
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      O2O_DATA_API_ORIGIN: previous.dataOrigin,
      O2O_DATA_API_TOKEN: previous.dataToken,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Apps Script rejects lock contention quickly with a retryable error', () => {
  const collector = appsScriptContext();
  collector.LockService = {
    getScriptLock() {
      return { tryLock: () => false };
    },
  };
  assert.throws(
    () => collector.acquireScriptLock_(),
    (error) => error?.code === 'collector_busy',
  );
});

test('large public-deal payloads are cached in multiple Apps Script entries', () => {
  const collector = appsScriptContext();
  const values = new Map();
  collector.CacheService = {
    getScriptCache() {
      return {
        get: (key) => values.get(key) || null,
        getAll: (keys) => Object.fromEntries(
          keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)]),
        ),
        put: (key, value) => values.set(key, value),
        putAll: (entries) => Object.entries(entries).forEach(([key, value]) => values.set(key, value)),
        removeAll: (keys) => keys.forEach((key) => values.delete(key)),
      };
    },
  };
  const deals = [{
    id: 'owner-large-cache-test',
    title: '대용량 이미지 상품',
    image: `data:image/jpeg;base64,${'a'.repeat(240000)}`,
  }];

  collector.cachePublicDeals_(deals);
  assert.ok(values.size > 2);
  assert.equal(
    JSON.stringify(collector.cachedPublicDeals_()),
    JSON.stringify(deals),
  );
  collector.invalidatePublicDealsCache_();
  assert.equal(collector.cachedPublicDeals_(), null);
});

test('public-deal mutation contracts are hashed so one image is stored only once', () => {
  const collector = appsScriptContext();
  addAppsScriptDigestSupport(collector);
  const deal = {
    id: 'owner-image-contract-test',
    source: 'merchant',
    title: '이미지 상품 저장 검수',
    image: `data:image/jpeg;base64,${'a'.repeat(31500)}`,
    publishMutationId: 'publish-owner-image-contract-test',
  };
  const legacyContract = JSON.stringify({
    id: deal.id,
    source: deal.source,
    title: deal.title,
    image: deal.image,
  });
  const hashedContract = collector.publicDealPublishContract_(deal);

  assert.match(hashedContract, /^sha256:[a-f0-9]{64}$/);
  assert.equal(collector.publicDealPublishContractMatches_(legacyContract, hashedContract), true);
  assert.equal(collector.publicDealPublishContractMatches_(`${legacyContract}x`, hashedContract), false);
  assert.ok(JSON.stringify({
    ...deal,
    _lastDealPublishMutationContract: hashedContract,
  }).length < 45000);
});

test('public deals reject oversized image input instead of truncating and forwarding it', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let upstreamCalls = 0;
  globalThis.fetch = async (_url, options) => {
    upstreamCalls += 1;
    const request = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, deal: request.deal }; },
    };
  };

  const markerBoundedBytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(1125000, 0),
    Buffer.from([0xff, 0xd9]),
  ]);
  const image = `data:image/jpeg;base64,${markerBoundedBytes.toString('base64')}`;
  const body = {
    action: 'publish',
    capabilityToken: `deal-${'i'.repeat(64)}`,
    deal: {
      id: 'owner-oversized-image-input',
      source: 'merchant',
      saleType: 'instant',
      title: 'oversized image boundary',
      originalPrice: 10000,
      discountRate: 0,
      totalQuantity: 1,
      image,
      publishMutationId: 'publish-oversized-image-input',
    },
  };
  assert.ok(image.length > 1500000);
  assert.ok(JSON.stringify(body).length < 1560000);

  try {
    const response = await invoke(publicDealsHandler, {
      headers: { origin: 'http://localhost:5173' },
      body,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { ok: false, error: 'invalid_deal' });
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      O2O_DATA_API_ORIGIN: previous.dataOrigin,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('public deals reject JPEG data URLs without complete SOI and EOI markers', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let upstreamCalls = 0;
  globalThis.fetch = async (_url, options) => {
    upstreamCalls += 1;
    const request = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, deal: request.deal }; },
    };
  };

  const malformedImages = [
    Buffer.from([0x00, 0x11, 0x22, 0xff, 0xd9]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0x01, 0x02, 0x03]),
  ].map((bytes) => `data:image/jpeg;base64,${bytes.toString('base64')}`);

  try {
    const responses = [];
    for (const [index, image] of malformedImages.entries()) {
      responses.push(await invoke(publicDealsHandler, {
        headers: { origin: 'http://localhost:5173' },
        body: {
          action: 'publish',
          capabilityToken: `deal-${'j'.repeat(64)}`,
          deal: {
            id: `owner-incomplete-jpeg-${index}`,
            source: 'merchant',
            saleType: 'instant',
            title: 'incomplete JPEG boundary',
            originalPrice: 10000,
            discountRate: 0,
            totalQuantity: 1,
            image,
            publishMutationId: `publish-incomplete-jpeg-${index}`,
          },
        },
      }));
    }
    responses.forEach((response) => {
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, { ok: false, error: 'invalid_deal' });
    });
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      O2O_DATA_API_ORIGIN: previous.dataOrigin,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('public deals reject external image URLs that can target local browser services', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error('unsafe image must not be forwarded');
  };

  try {
    const unsafeImages = [
      'https://127.0.0.1/private.jpg',
      'https://[::1]/private.jpg',
      'https://router.local/private.jpg',
      'https://user:secret@example.test/private.jpg',
      'https://example.test:8443/private.jpg',
    ];
    for (const [index, image] of unsafeImages.entries()) {
      const response = await invoke(publicDealsHandler, {
        headers: { origin: 'http://localhost:5173' },
        body: {
          action: 'publish',
          capabilityToken: `deal-${'u'.repeat(64)}`,
          deal: {
            id: `owner-unsafe-image-${index}`,
            source: 'merchant',
            saleType: 'instant',
            title: 'unsafe external image',
            originalPrice: 10000,
            discountRate: 0,
            totalQuantity: 1,
            image,
            publishMutationId: `publish-unsafe-image-${index}`,
          },
        },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, { ok: false, error: 'invalid_deal' });
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      O2O_DATA_API_ORIGIN: previous.dataOrigin,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('deployment policy strips referrers from externally loaded product images', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const headers = config.headers?.flatMap((entry) => entry.headers || []) || [];
  assert.equal(
    headers.some((header) => header.key === 'Referrer-Policy' && header.value === 'no-referrer'),
    true,
  );
});

test('public deal reads retain records with invalid images and degrade only the image', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const malformedImage = 'data:image/png;base64,not-a-jpeg';
  const oversizedImage = `data:image/jpeg;base64,${'a'.repeat(40001)}`;
  const upstreamDeals = [
    {
      id: 'customer-malformed-read-image',
      source: 'customer',
      title: '잘못된 이미지가 있는 기존 상품',
      originalPrice: 10000,
      image: malformedImage,
    },
    {
      id: 'owner-oversized-read-image',
      source: 'merchant',
      saleType: 'instant',
      title: '큰 이미지가 있는 기존 상품',
      originalPrice: 20000,
      image: oversizedImage,
    },
    {
      id: 'owner-valid-read-image',
      source: 'merchant',
      saleType: 'instant',
      title: '정상 이미지 상품',
      originalPrice: 30000,
      image: 'https://example.test/valid.jpg',
    },
  ];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: true, deals: upstreamDeals }; },
  });

  try {
    for (const action of ['list', 'list_owner']) {
      const response = await invoke(publicDealsHandler, {
        headers: {
          origin: 'http://localhost:5173',
          ...(action === 'list_owner'
            ? { 'x-o2o-service-token': 'collector-token' }
            : {}),
        },
        body: {
          action,
          ...(action === 'list_owner' ? {
            ownerClaims: [{
              dealId: 'owner-oversized-read-image',
              ownerCapabilityHash: 'a'.repeat(64),
            }],
          } : {}),
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.deals.length, 3);
      assert.equal(response.body.deals[0].id, 'customer-malformed-read-image');
      assert.equal(response.body.deals[0].image, '');
      assert.equal(response.body.deals[1].id, 'owner-oversized-read-image');
      assert.equal(response.body.deals[1].image, '');
      assert.equal(response.body.deals[2].image, 'https://example.test/valid.jpg');
    }
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      O2O_DATA_API_ORIGIN: previous.dataOrigin,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('new collector responses avoid a second legacy order event request', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() {
        return { ok: true, order: body.order, legacyEventStored: true };
      },
    };
  };
  try {
    const order = {
      id: 'order-1234567890999',
      createdAt: new Date().toISOString(),
      status: 'new',
      paymentStatus: 'pending',
      version: 1,
      visitorId: 'visitor-single-request',
      customerName: '단일 요청 테스트',
      customerPhone: '01012345678',
      dealId: 'owner-single-request',
      type: 'purchase',
      selectedCount: 1,
      deal: { id: 'owner-single-request', title: '단일 요청 상품' },
    };
    const response = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        order,
        visitorId: order.visitorId,
        customerCapabilityToken: `customer-${'z'.repeat(64)}`,
      },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].action, 'publish_order');
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      O2O_DATA_API_ORIGIN: previous.dataOrigin,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('public analytics endpoint rejects server-only order snapshots', async () => {
  const response = await invoke(collectHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      event: {
        id: 'event-12345678',
        name: 'customer_order_snapshot',
        timestamp: new Date().toISOString(),
        visitorId: 'visitor-12345678',
        sessionId: 'session-12345678',
        properties: { order_snapshot: '{}' },
      },
    },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { ok: false, error: 'reserved_event' });
});

test('public analytics rejects private owner proof fields, including nested aliases', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error('fetch_should_not_run');
  };
  try {
    const privateProofProperties = [
      { ownerIdentityHash: 'a'.repeat(64) },
      { _owner_identity_hash: 'b'.repeat(64) },
      { nested: { ownerCapabilityHash: 'c'.repeat(64) } },
      { nested: [{ _owner_capability_hash: 'd'.repeat(64) }] },
    ];
    for (const [index, properties] of privateProofProperties.entries()) {
      const response = await invoke(collectHandler, {
        headers: { origin: 'http://localhost:5173' },
        body: {
          event: {
            id: `event-owner-proof-${index}`,
            name: 'owner_product_created',
            timestamp: new Date().toISOString(),
            visitorId: 'visitor-owner-proof',
            sessionId: 'session-owner-proof',
            properties,
          },
        },
      });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.body, { ok: false, error: 'reserved_event_property' });
    }
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('owner product creation remains analytics-only and is forwarded without ownership authority', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
    dataToken: process.env.O2O_DATA_API_TOKEN,
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  delete process.env.O2O_DATA_API_TOKEN;
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true }; },
    };
  };

  try {
    const response = await invoke(collectHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        event: {
          id: 'event-owner-analytics-only',
          name: 'owner_product_created',
          timestamp: new Date().toISOString(),
          visitorId: 'visitor-owner-analytics',
          sessionId: 'session-owner-analytics',
          properties: {
            deal_id: 'owner-analytics-only',
            product_name: '분석용 상품명',
          },
        },
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.body.ok, true);
    assert.equal(forwarded.event.name, 'owner_product_created');
    assert.equal(forwarded.event.properties.deal_id, 'owner-analytics-only');
    assert.equal(forwarded.event.properties.ownerIdentityHash, undefined);
    assert.equal(forwarded.event.properties.ownerCapabilityHash, undefined);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      O2O_DATA_API_ORIGIN: previous.dataOrigin,
      O2O_DATA_API_TOKEN: previous.dataToken,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('invalid service headers cannot fall back to browser-origin authorization', async () => {
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'expected-service-token';
  try {
    for (const handler of [groupHandler, publicDealsHandler]) {
      const response = await invoke(handler, {
        headers: {
          origin: 'http://localhost:5173',
          'x-o2o-service-token': 'wrong-service-token',
        },
        body: { action: 'list' },
      });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.body, { ok: false, error: 'unauthorized' });
    }
  } finally {
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
  }
});

test('phase 6 group API rejects chat, read, lock, and admin operations', async () => {
  const previousPhase = process.env.O2O_RELEASE_PHASE;
  process.env.O2O_RELEASE_PHASE = '6';
  try {
    const requests = [
      { action: 'send_message' },
      { action: 'mark_read' },
      { action: 'toggle_lock' },
      { action: 'join', role: 'admin' },
      { action: 'snapshot', adminPin: '2468' },
    ];
    for (const body of requests) {
      const response = await invoke(groupHandler, {
        headers: { origin: 'http://localhost:5173' },
        body,
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.body, { ok: false, error: 'feature_not_available' });
    }
  } finally {
    if (previousPhase === undefined) delete process.env.O2O_RELEASE_PHASE;
    else process.env.O2O_RELEASE_PHASE = previousPhase;
  }
});

test('group API defaults to phase 9 when the release phase is missing or invalid', async () => {
  const previousPhase = process.env.O2O_RELEASE_PHASE;
  try {
    for (const phase of [undefined, 'not-a-number']) {
      if (phase === undefined) delete process.env.O2O_RELEASE_PHASE;
      else process.env.O2O_RELEASE_PHASE = phase;
      const response = await invoke(groupHandler, {
        headers: { origin: 'http://localhost:5173' },
        body: { action: 'send_message' },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, { ok: false, error: 'invalid_client_mutation_id' });
    }
  } finally {
    if (previousPhase === undefined) delete process.env.O2O_RELEASE_PHASE;
    else process.env.O2O_RELEASE_PHASE = previousPhase;
  }
});

test('public deal raw capability is hashed before collector forwarding', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { ok: true, deal: forwarded.deal };
      },
    };
  };

  try {
    const rawToken = `deal-${'a'.repeat(64)}`;
    const response = await invoke(publicDealsHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        capabilityToken: rawToken,
        deal: {
          id: 'customer-security-test',
          groupId: 'customer-security-test',
          source: 'customer',
          title: '보안 테스트',
          originalPrice: 10000,
          discountRate: 0,
          image: 'https://example.test/image.jpg',
          menu: [],
          publishVersion: 0,
          expectedPublishVersion: 0,
          publishMutationId: 'publish-merchant-capacity-conflict',
        },
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.body.ok, true);
    assert.equal(forwarded.capabilityToken, undefined);
    assert.match(forwarded.ownerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded.ownerCapabilityHash, rawToken);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('merchant group public deals preserve the canonical room id and recruiting host mode', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      async json() { return { ok: true, deal: forwarded.deal }; },
    };
  };

  try {
    const response = await invoke(publicDealsHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        capabilityToken: `deal-${'m'.repeat(64)}`,
        deal: {
          id: 'owner-merchant-room-test',
          source: 'merchant',
          saleType: 'group',
          title: '사과 공동구매',
          originalPrice: 10000,
          discountRate: 0,
          target: 40,
          totalQuantity: 40,
          current: 7,
          currentCount: 7,
          participantCount: 2,
          image: 'https://example.test/apple.jpg',
          menu: [],
        },
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(forwarded.deal.groupId, 'owner-merchant-room-test');
    assert.equal(response.body.deal.groupId, 'owner-merchant-room-test');
    assert.equal(response.body.deal.hostMode, 'recruiting');
    assert.equal(response.body.deal.groupStatus, 'recruiting');
    assert.equal(forwarded.deal.targetCount, 20);
    assert.equal(response.body.deal.current, 7);
    assert.equal(response.body.deal.currentCount, 2);
    assert.equal(response.body.deal.currentPeople, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('customer order raw capability is hashed before collector forwarding', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() {
        return body.action === 'publish_order'
          ? { ok: true, order: body.order }
          : { ok: true };
      },
    };
  };

  try {
    const rawToken = `customer-${'b'.repeat(64)}`;
    const order = {
      id: 'order-1234567890123',
      createdAt: new Date().toISOString(),
      visitorId: 'visitor-security-test',
      customerName: '테스트 사용자',
      customerPhone: '01012345678',
      dealId: 'owner-security-test',
      selectedCount: 1,
      quantity: 1,
      type: 'purchase',
      publishMutationId: 'publish-order-security-test-initial',
      clientMutationId: 'checkout-quantity-security-test',
      hostRemainderApplied: 7,
      deal: { id: 'owner-security-test', title: '보안 테스트' },
    };
    const response = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        order,
        visitorId: order.visitorId,
        customerCapabilityToken: rawToken,
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.body.ok, true);
    assert.equal(forwarded[0].customerCapabilityToken, undefined);
    assert.match(forwarded[0].customerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[0].customerCapabilityHash, rawToken);
    assert.equal(forwarded[0].order.hostRemainderApplied, 7);
    assert.equal(forwarded[0].order.reservationMutationId, 'checkout-quantity-security-test');
    assert.equal(forwarded[0].order.clientMutationId, undefined);
    assert.equal(response.body.order.hostRemainderApplied, 7);
    assert.equal(response.body.order._customerCapabilityHash, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('group order publish requires and hashes the exact participant capability proof', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() { return { ok: true, order: body.order }; },
    };
  };

  try {
    const customerCapabilityToken = `customer-${'c'.repeat(64)}`;
    const participantCapabilityToken = `participant-${'p'.repeat(64)}`;
    const order = {
      id: 'order-1234567890456',
      createdAt: '2026-08-29T01:00:00.000Z',
      visitorId: 'visitor-participant-proof',
      customerName: '참여자',
      customerPhone: '01012345678',
      dealId: 'customer-participant-proof',
      groupId: 'customer-participant-proof',
      type: 'purchase',
      selectedCount: 2,
      reservationMutationId: 'membership-participant-proof',
      deal: { id: 'customer-participant-proof', title: '참여 권한 테스트' },
    };
    const missing = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        order,
        visitorId: order.visitorId,
        customerCapabilityToken,
      },
    });
    assert.equal(missing.statusCode, 403);
    assert.deepEqual(missing.body, { ok: false, error: 'missing_participant_capability' });
    assert.equal(forwarded.length, 0);

    const response = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        order,
        visitorId: order.visitorId,
        customerCapabilityToken,
        participantCapabilityToken,
      },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(forwarded[0].participantCapabilityToken, undefined);
    assert.match(forwarded[0].participantCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[0].participantCapabilityHash, participantCapabilityToken);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('order manage hashes only the selected merchant or group manager capability', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          order: {
            id: body.payload.orderId,
            createdAt: '2026-08-29T01:00:00.000Z',
            statusUpdatedAt: '2026-08-29T01:01:00.000Z',
            status: 'preparing',
            paymentStatus: 'pending',
            visitorId: 'visitor-managed-order',
            customerName: '관리 대상',
            customerPhone: '01012345678',
            dealId: body.payload.dealId,
            groupId: body.payload.managerType === 'group_manager' ? body.payload.dealId : '',
            type: 'purchase',
            selectedCount: 1,
            version: 2,
          },
        };
      },
    };
  };

  try {
    const ownerToken = `owner-${'o'.repeat(64)}`;
    const merchant = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'manage',
        orderId: 'order-1234567890457',
        dealId: 'owner-managed-order',
        managerType: 'merchant_owner',
        kind: 'order_status',
        direction: 'next',
        expectedVersion: 1,
        clientMutationId: 'manage-owner-order-next',
        ownerCapabilityToken: ownerToken,
      },
    });
    assert.equal(merchant.statusCode, 200);
    assert.equal(forwarded[0].action, 'manage_order');
    assert.match(forwarded[0].payload.ownerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[0].payload.ownerCapabilityHash, ownerToken);
    assert.equal(forwarded[0].payload.ownerCapabilityToken, undefined);

    const groupToken = `group-${'g'.repeat(64)}`;
    const group = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'manage',
        orderId: 'order-1234567890458',
        dealId: 'customer-managed-order',
        managerType: 'group_manager',
        actorId: 'visitor-managed-host',
        capabilityToken: groupToken,
        kind: 'payment_status',
        direction: 'next',
        expectedVersion: 1,
        clientMutationId: 'manage-group-payment-next',
      },
    });
    assert.equal(group.statusCode, 200);
    assert.match(forwarded[1].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[1].payload.capabilityHash, groupToken);
    assert.equal(forwarded[1].payload.capabilityToken, undefined);
    assert.equal(forwarded[1].payload.ownerCapabilityHash, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('customer deals and grouped orders require canonical group/deal binding', async () => {
  const dealResponse = await invoke(publicDealsHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      action: 'publish',
      capabilityToken: `deal-${'c'.repeat(64)}`,
      deal: {
        id: 'customer-canonical-a',
        groupId: 'customer-canonical-b',
        source: 'customer',
        title: '잘못 연결된 그룹',
        originalPrice: 10000,
        discountRate: 0,
        image: 'https://example.test/image.jpg',
        menu: [],
      },
    },
  });
  assert.equal(dealResponse.statusCode, 400);
  assert.deepEqual(dealResponse.body, { ok: false, error: 'invalid_deal' });

  const orderResponse = await invoke(customerOrdersHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      action: 'publish',
      visitorId: 'visitor-canonical-test',
      customerCapabilityToken: `customer-${'d'.repeat(64)}`,
      order: {
        id: 'order-1234567890124',
        createdAt: new Date().toISOString(),
        visitorId: 'visitor-canonical-test',
        customerName: '테스트 사용자',
        customerPhone: '01012345678',
        dealId: 'customer-canonical-a',
        groupId: 'customer-canonical-b',
        deal: { id: 'customer-canonical-a', title: '잘못 연결된 주문' },
      },
    },
  });
  assert.equal(orderResponse.statusCode, 400);
  assert.deepEqual(orderResponse.body, { ok: false, error: 'invalid_order_request' });

  const groupResponse = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      action: 'create',
      groupId: 'customer-canonical-a',
      dealId: 'customer-canonical-b',
      actorId: 'visitor-canonical-test',
      nickname: '테스트 호스트',
      title: '잘못 연결된 그룹',
      targetCount: 3,
      clientMutationId: 'mutation-canonical-test',
    },
  });
  assert.equal(groupResponse.statusCode, 400);
  assert.deepEqual(groupResponse.body, { ok: false, error: 'invalid_group_deal_binding' });
});

test('group API forwards host, quantity, target, transition, and cancellation contracts without raw capabilities', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousCapabilitySecret = process.env.O2O_CAPABILITY_SECRET;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  process.env.O2O_CAPABILITY_SECRET = 'capability-secret-for-tests';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          ...(body.payload.action === 'cancel_participation'
            ? {
                order: {
                  id: body.payload.orderId,
                  status: 'cancelled',
                  paymentStatus: 'cancelled',
                  _customerCapabilityHash: body.payload.customerCapabilityHash,
                  customerCapabilityHash: body.payload.customerCapabilityHash,
                  customerCapabilityToken: 'must-not-leak',
                  capabilityHash: body.payload.capabilityHash,
                  capabilityToken: 'must-not-leak',
                },
              }
            : {}),
          snapshot: {
            group: {
              groupId: body.payload.groupId,
              status: 'recruiting',
              version: 1,
              hostActorId: '',
              hostMode: body.payload.hostMode || 'recruiting',
              totalQuantity: body.payload.totalQuantity || 7,
              orderedQuantity: body.payload.selectedQuantity || 0,
            },
            participants: [],
            history: [],
          },
        };
      },
    };
  };

  try {
    const recruitingCreate = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'create',
        groupId: 'customer-host-recruiting',
        dealId: 'customer-host-recruiting',
        actorId: 'visitor-host-creator',
        nickname: '생성자',
        title: '호스트 모집 그룹',
        targetCount: 3,
        hostMode: 'recruiting',
        totalQuantity: 7,
        selectedQuantity: 3,
        clientMutationId: 'mutation-host-create-recruiting',
        capabilityToken: `group-${'1'.repeat(64)}`,
      },
    });
    assert.equal(recruitingCreate.statusCode, 200);
    assert.equal(forwarded[0].payload.requestedRole, 'creator');
    assert.equal(forwarded[0].payload.hostMode, 'recruiting');
    assert.equal(forwarded[0].payload.totalQuantity, 7);
    assert.equal(forwarded[0].payload.selectedQuantity, 3);
    assert.match(forwarded[0].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.equal(forwarded[0].payload.capabilityToken, undefined);

    const selfCreate = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'create',
        groupId: 'customer-host-self',
        dealId: 'customer-host-self',
        actorId: 'visitor-self-host',
        nickname: '호스트',
        title: '직접 호스트 그룹',
        targetCount: 4,
        clientMutationId: 'mutation-host-create-self',
        capabilityToken: `group-${'2'.repeat(64)}`,
      },
    });
    assert.equal(selfCreate.statusCode, 200);
    assert.equal(forwarded[1].payload.requestedRole, 'host');
    assert.equal(forwarded[1].payload.hostMode, 'self');
    assert.equal(forwarded[1].payload.totalQuantity, 4);
    assert.equal(forwarded[1].payload.selectedQuantity, 1);

    const rawCapability = `group-${'e'.repeat(64)}`;
    const claim = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'claim_host',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-candidate',
        capabilityToken: rawCapability,
        clientMutationId: 'mutation-host-claim-candidate',
      },
    });
    assert.equal(claim.statusCode, 200);
    assert.match(forwarded[2].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[2].payload.capabilityHash, rawCapability);
    assert.equal(forwarded[2].payload.capabilityToken, undefined);

    const reserve = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'reserve_quantity',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-candidate',
        capabilityToken: rawCapability,
        quantity: 2,
        expectedVersion: 3,
        clientMutationId: 'mutation-quantity-reserve-test',
      },
    });
    assert.equal(reserve.statusCode, 200);
    assert.equal(forwarded[3].payload.quantity, 2);
    assert.equal(forwarded[3].payload.expectedVersion, 3);

    const rollback = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'rollback_reservation',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-candidate',
        capabilityToken: rawCapability,
        quantity: 2,
        reservationMutationId: 'mutation-quantity-reserve-test',
        clientMutationId: 'mutation-quantity-rollback-test',
      },
    });
    assert.equal(rollback.statusCode, 200);
    assert.equal(forwarded[4].action, 'group_rollback_reservation');
    assert.equal(forwarded[4].payload.quantity, 2);
    assert.equal(forwarded[4].payload.reservationMutationId, 'mutation-quantity-reserve-test');
    assert.match(forwarded[4].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.equal(forwarded[4].payload.capabilityToken, undefined);

    const targetEdit = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'update_target',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-creator',
        capabilityToken: rawCapability,
        targetCount: 5,
        expectedVersion: 4,
        clientMutationId: 'mutation-target-detail-edit',
      },
    });
    assert.equal(targetEdit.statusCode, 200);
    assert.equal(forwarded[5].payload.targetCount, 5);
    assert.equal(forwarded[5].payload.expectedVersion, 4);
    assert.match(forwarded[5].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.equal(forwarded[5].payload.capabilityToken, undefined);

    const incompleteTransition = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'transition_group',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-creator',
        capabilityToken: rawCapability,
        direction: 'next',
        fromStatus: 'recruiting',
        expectedVersion: 4,
        clientMutationId: 'mutation-group-transition-missing-to',
      },
    });
    assert.equal(incompleteTransition.statusCode, 400);
    assert.deepEqual(incompleteTransition.body, { ok: false, error: 'invalid_to_status' });
    assert.equal(forwarded.length, 6);

    const transition = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'transition_group',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-creator',
        capabilityToken: rawCapability,
        direction: 'next',
        fromStatus: 'recruiting',
        toStatus: 'recruited',
        expectedVersion: 4,
        clientMutationId: 'mutation-group-transition-detail',
      },
    });
    assert.equal(transition.statusCode, 200);
    assert.equal(forwarded[6].payload.direction, 'next');
    assert.equal(forwarded[6].payload.fromStatus, 'recruiting');
    assert.equal(forwarded[6].payload.toStatus, 'recruited');
    assert.equal(forwarded[6].payload.expectedVersion, 4);
    assert.equal(forwarded[6].payload.capabilityToken, undefined);

    const rawCustomerCapability = `customer-${'f'.repeat(64)}`;
    const cancellation = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'cancel_participation',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-candidate',
        capabilityToken: rawCapability,
        customerCapabilityToken: rawCustomerCapability,
        orderId: 'order-1234567890125',
        expectedVersion: 5,
        expectedOrderVersion: 2,
        clientMutationId: 'mutation-participation-cancel-test',
      },
    });
    assert.equal(cancellation.statusCode, 200);
    assert.equal(forwarded[7].action, 'group_cancel_participation');
    assert.equal(forwarded[7].payload.orderId, 'order-1234567890125');
    assert.equal(forwarded[7].payload.expectedVersion, 5);
    assert.equal(forwarded[7].payload.expectedOrderVersion, 2);
    assert.match(forwarded[7].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.match(forwarded[7].payload.customerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[7].payload.capabilityHash, rawCapability);
    assert.notEqual(forwarded[7].payload.customerCapabilityHash, rawCustomerCapability);
    assert.equal(forwarded[7].payload.capabilityToken, undefined);
    assert.equal(forwarded[7].payload.customerCapabilityToken, undefined);
    assert.equal(cancellation.body.order.status, 'cancelled');
    assert.equal(cancellation.body.order._customerCapabilityHash, undefined);
    assert.equal(cancellation.body.order.customerCapabilityHash, undefined);
    assert.equal(cancellation.body.order.customerCapabilityToken, undefined);
    assert.equal(cancellation.body.order.capabilityHash, undefined);
    assert.equal(cancellation.body.order.capabilityToken, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousCapabilitySecret === undefined) delete process.env.O2O_CAPABILITY_SECRET;
    else process.env.O2O_CAPABILITY_SECRET = previousCapabilitySecret;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('participation cancellation validates order version and customer proof before forwarding', async () => {
  const baseBody = {
    action: 'cancel_participation',
    groupId: 'customer-cancel-validation',
    actorId: 'visitor-cancel-validation',
    capabilityToken: `group-${'g'.repeat(64)}`,
    customerCapabilityToken: `customer-${'h'.repeat(64)}`,
    orderId: 'order-1234567890126',
    expectedVersion: 2,
    expectedOrderVersion: 3,
    clientMutationId: 'mutation-cancel-validation-test',
  };

  const missingCustomerProof = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: { ...baseBody, customerCapabilityToken: '' },
  });
  assert.equal(missingCustomerProof.statusCode, 403);
  assert.deepEqual(missingCustomerProof.body, { ok: false, error: 'missing_customer_capability_token' });

  const invalidOrderId = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: { ...baseBody, orderId: 'order-not-valid' },
  });
  assert.equal(invalidOrderId.statusCode, 400);
  assert.deepEqual(invalidOrderId.body, { ok: false, error: 'invalid_order_id' });

  const invalidOrderVersion = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: { ...baseBody, expectedOrderVersion: 0 },
  });
  assert.equal(invalidOrderVersion.statusCode, 400);
  assert.deepEqual(invalidOrderVersion.body, { ok: false, error: 'invalid_expected_order_version' });
});

test('host release requires CAS and forwards only the hashed group proof', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousCapabilitySecret = process.env.O2O_CAPABILITY_SECRET;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  process.env.O2O_CAPABILITY_SECRET = 'capability-secret-for-tests';
  delete process.env.O2O_DATA_API_ORIGIN;
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          snapshot: {
            group: {
              groupId: forwarded.payload.groupId,
              status: 'recruiting',
              version: 8,
              hostMode: 'recruiting',
              hostActorId: '',
            },
            participants: [{
              actorId: forwarded.payload.actorId,
              role: 'member',
              counted: true,
              paymentStatus: 'pending',
              selectedQuantity: 1,
              version: 3,
            }],
            history: [],
          },
        };
      },
    };
  };

  try {
    const rawCapability = `group-${'r'.repeat(64)}`;
    const response = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'release_host',
        groupId: 'customer-release-host',
        actorId: 'visitor-release-host',
        capabilityToken: rawCapability,
        expectedVersion: 7,
        clientMutationId: 'mutation-release-host-test',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(forwarded.action, 'group_release_host');
    assert.equal(forwarded.payload.expectedVersion, 7);
    assert.match(forwarded.payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded.payload.capabilityHash, rawCapability);
    assert.equal(forwarded.payload.capabilityToken, undefined);

    const invalidVersion = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'release_host',
        groupId: 'customer-release-host',
        actorId: 'visitor-release-host',
        capabilityToken: rawCapability,
        expectedVersion: 0,
        clientMutationId: 'mutation-release-host-invalid-version',
      },
    });
    assert.equal(invalidVersion.statusCode, 400);
    assert.deepEqual(invalidVersion.body, { ok: false, error: 'invalid_expected_version' });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousCapabilitySecret === undefined) delete process.env.O2O_CAPABILITY_SECRET;
    else process.env.O2O_CAPABILITY_SECRET = previousCapabilitySecret;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('service cancellation accepts only hashed proofs and strips any raw tokens before collector forwarding', async () => {
  const previousDataToken = process.env.O2O_DATA_API_TOKEN;
  const previousCollectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousCollectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.O2O_DATA_API_TOKEN = 'service-token';
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          order: {
            id: forwarded.payload.orderId,
            status: 'cancelled',
            paymentStatus: 'cancelled',
          },
          snapshot: { group: {}, participants: [], history: [] },
        };
      },
    };
  };

  try {
    const response = await invoke(groupHandler, {
      headers: { 'x-o2o-service-token': 'service-token' },
      body: {
        action: 'cancel_participation',
        groupId: 'customer-cancel-service',
        actorId: 'visitor-cancel-service',
        capabilityHash: 'a'.repeat(64),
        customerCapabilityHash: 'b'.repeat(64),
        capabilityToken: 'raw-group-proof-must-not-forward',
        customerCapabilityToken: 'raw-customer-proof-must-not-forward',
        orderId: 'order-1234567890127',
        expectedVersion: 2,
        expectedOrderVersion: 3,
        clientMutationId: 'mutation-cancel-service-test',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(forwarded.action, 'group_cancel_participation');
    assert.equal(forwarded.payload.capabilityHash, 'a'.repeat(64));
    assert.equal(forwarded.payload.customerCapabilityHash, 'b'.repeat(64));
    assert.equal(forwarded.payload.capabilityToken, undefined);
    assert.equal(forwarded.payload.customerCapabilityToken, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDataToken === undefined) delete process.env.O2O_DATA_API_TOKEN;
    else process.env.O2O_DATA_API_TOKEN = previousDataToken;
    if (previousCollectorUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousCollectorUrl;
    if (previousCollectorToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousCollectorToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('invalid host modes are rejected and host claim conflicts map to 409', async () => {
  const invalidMode = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      action: 'create',
      groupId: 'customer-invalid-host-mode',
      dealId: 'customer-invalid-host-mode',
      actorId: 'visitor-invalid-host-mode',
      nickname: '생성자',
      title: '잘못된 모드',
      targetCount: 3,
      hostMode: 'automatic',
      clientMutationId: 'mutation-invalid-host-mode',
    },
  });
  assert.equal(invalidMode.statusCode, 400);
  assert.deepEqual(invalidMode.body, { ok: false, error: 'invalid_host_mode' });

  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { ok: false, error: 'host_already_claimed' }; },
  });
  try {
    const conflict = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'claim_host',
        groupId: 'customer-host-conflict',
        actorId: 'visitor-host-conflict',
        capabilityToken: `group-${'f'.repeat(64)}`,
        clientMutationId: 'mutation-host-claim-conflict',
      },
    });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.body, { ok: false, error: 'host_already_claimed' });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('merchant member zero-quantity joins are rejected before capability minting or upstream calls', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousCapabilitySecret = process.env.O2O_CAPABILITY_SECRET;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  process.env.O2O_CAPABILITY_SECRET = 'capability-secret-for-zero-join-test';
  delete process.env.O2O_DATA_API_ORIGIN;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          snapshot: { group: {}, participants: [], history: [] },
        };
      },
    };
  };

  try {
    const result = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'join',
        groupId: 'owner-merchant-zero-join',
        actorId: 'victim-order-actor',
        nickname: '공격자',
        role: 'member',
        selectedQuantity: 0,
        clientMutationId: 'mutation-merchant-zero-join',
      },
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { ok: false, error: 'invalid_quantity' });
    assert.equal(upstreamCalls, 0);
    assert.equal(result.body.capabilityToken, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousCapabilitySecret === undefined) delete process.env.O2O_CAPABILITY_SECRET;
    else process.env.O2O_CAPABILITY_SECRET = previousCapabilitySecret;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('create and join never mint capabilities from public mutation identifiers', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };

  try {
    for (const body of [{
      action: 'create',
      groupId: 'customer-public-capability-create',
      dealId: 'customer-public-capability-create',
      actorId: 'visitor-public-capability-create',
      nickname: '생성자',
      title: '공개 식별자 생성 공격',
      targetCount: 2,
      clientMutationId: 'mutation-public-capability-create',
    }, {
      action: 'join',
      groupId: 'owner-public-capability-join',
      actorId: 'victim-public-order-actor',
      nickname: '공격자',
      role: 'member',
      selectedQuantity: 1,
      clientMutationId: 'mutation-public-capability-join',
    }]) {
      const result = await invoke(groupHandler, {
        headers: { origin: 'http://localhost:5173' },
        body,
      });
      assert.equal(result.statusCode, 403);
      assert.deepEqual(result.body, { ok: false, error: 'missing_capability_token' });
      assert.equal(result.body.capabilityToken, undefined);
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('legacy customer-group repair hashes both saved proofs and rejects a missing deal-owner proof', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    forwarded.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          snapshot: { group: {}, participants: [], history: [] },
        };
      },
    };
  };

  try {
    const groupToken = `group-${'g'.repeat(64)}`;
    const ownerToken = `deal-${'o'.repeat(64)}`;
    const response = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'repair_customer_group',
        groupId: 'customer-owned-orphan',
        dealId: 'customer-owned-orphan',
        actorId: 'visitor-owned-orphan',
        nickname: '기존 생성자',
        title: '기존 공개 상품',
        targetCount: 2,
        totalQuantity: 2,
        selectedQuantity: 1,
        hostMode: 'self',
        clientMutationId: 'repair-customer-owned-orphan',
        capabilityToken: groupToken,
        ownerCapabilityToken: ownerToken,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(forwarded[0].action, 'group_repair_customer_group');
    assert.match(forwarded[0].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.match(forwarded[0].payload.ownerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[0].payload.capabilityHash, groupToken);
    assert.notEqual(forwarded[0].payload.ownerCapabilityHash, ownerToken);
    assert.equal(forwarded[0].payload.capabilityToken, undefined);
    assert.equal(forwarded[0].payload.ownerCapabilityToken, undefined);

    const missingOwner = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'repair_customer_group',
        groupId: 'customer-unowned-orphan',
        dealId: 'customer-unowned-orphan',
        actorId: 'visitor-unowned-orphan',
        nickname: '공격자',
        title: '타인 공개 상품',
        targetCount: 2,
        clientMutationId: 'repair-customer-unowned-orphan',
        capabilityToken: groupToken,
      },
    });
    assert.equal(missingOwner.statusCode, 403);
    assert.deepEqual(missingOwner.body, { ok: false, error: 'missing_owner_capability_token' });
    assert.equal(forwarded.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('Apps Script repairs only a missing customer group whose public-deal owner proof matches', () => {
  const context = appsScriptContext();
  const groupId = 'customer-owned-orphan-server';
  const actorId = 'visitor-owned-orphan-server';
  const ownerHash = 'a'.repeat(64);
  const groupHash = 'b'.repeat(64);
  const publicDeal = {
    id: groupId,
    groupId,
    source: 'customer',
    visibility: 'public',
    _ownerCapabilityHash: ownerHash,
  };
  const commits = [];
  context.findMutation_ = () => null;
  context.findExactRow_ = () => 0;
  context.activePublicDealRecord_ = () => publicDeal;
  context.repairPendingMerchantDealPublish_ = () => {};
  context.repairPendingGroupMutations_ = () => {};
  context.commitGroupMutationIntent_ = (...args) => commits.push(args);
  context.invalidateGroupSnapshot_ = () => {};

  const payload = {
    groupId,
    dealId: groupId,
    actorId,
    nickname: '기존 생성자',
    title: '복구할 기존 상품',
    targetCount: 2,
    totalQuantity: 2,
    selectedQuantity: 1,
    hostMode: 'self',
    clientMutationId: 'repair-owned-orphan-server',
    capabilityHash: groupHash,
    ownerCapabilityHash: ownerHash,
  };
  const repaired = context.executeGroupMutation_('repair_customer_group', payload, {
    groups: {},
    publicDeals: {},
  });
  assert.equal(repaired.duplicate, false);
  assert.equal(commits.length, 1);
  assert.equal(commits[0][1].action, 'repair_customer_group');
  assert.equal(commits[0][4][0].target.groupId, groupId);
  assert.equal(commits[0][4][1].target.actorId, actorId);
  assert.equal(commits[0][4][1].target.capabilityHash, groupHash);

  assert.throws(
    () => context.executeGroupMutation_('create', {
      ...payload,
      clientMutationId: 'create-claim-visible-orphan',
    }, { groups: {}, publicDeals: {} }),
    (error) => error?.code === 'deal_owner_proof_required',
  );
  assert.throws(
    () => context.executeGroupMutation_('repair_customer_group', {
      ...payload,
      ownerCapabilityHash: 'c'.repeat(64),
      clientMutationId: 'repair-wrong-owner-proof',
    }, { groups: {}, publicDeals: {} }),
    (error) => error?.code === 'forbidden',
  );
  context.activePublicDealRecord_ = () => null;
  assert.throws(
    () => context.executeGroupMutation_('repair_customer_group', {
      ...payload,
      clientMutationId: 'repair-missing-public-deal',
    }, { groups: {}, publicDeals: {} }),
    (error) => error?.code === 'deal_not_found',
  );
});

test('public deals derive host match and clamp ordered quantity', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        deals: [
          {
            id: 'customer-public-host-test',
            groupId: 'customer-public-host-test',
            source: 'customer',
            title: '공개 그룹',
            visibility: 'public',
            originalPrice: 10000,
            discountRate: 0,
            hostMode: 'recruiting',
            hostActorId: '',
            hostMatched: true,
            totalQuantity: 3,
            orderedQuantity: 8,
            image: 'https://example.test/image.jpg',
            menu: [],
          },
          {
            id: 'owner-public-split-test',
            source: 'merchant',
            saleType: 'group',
            title: '사장님 분할 공구',
            visibility: 'public',
            originalPrice: 60000,
            discountRate: 7,
            splitPricing: true,
            expectedPerPerson: 2790,
            splitRemainder: 0,
            totalQuantity: 20,
            orderedQuantity: 2,
            image: 'https://example.test/image.jpg',
            menu: [{ id: 'owner-menu-1', name: '묶음', price: 2790 }],
          },
        ],
      };
    },
  });
  try {
    const response = await invoke(publicDealsHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: { action: 'list' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.deals[0].hostMatched, false);
    assert.equal(response.body.deals[0].totalQuantity, 3);
    assert.equal(response.body.deals[0].orderedQuantity, 3);
    assert.equal(response.body.deals[1].splitPricing, true);
    assert.equal(response.body.deals[1].expectedPerPerson, 2790);
    assert.equal(response.body.deals[1].unitPrice, 2790);
    assert.equal(response.body.deals[1].totalQuantity, 20);
    assert.equal(response.body.deals[1].menu[0].price, 2790);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('merchant capacity conflicts are returned to browsers as 409 responses', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;

  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return body.action === 'publish_order'
            ? { ok: false, error: 'quantity_unavailable' }
            : { ok: false, error: 'quantity_below_active_allocations' };
        },
      };
    };

    const orderResponse = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        visitorId: 'visitor-merchant-capacity',
        customerCapabilityToken: `customer-${'j'.repeat(64)}`,
        order: {
          id: 'order-1234567890130',
          createdAt: new Date().toISOString(),
          visitorId: 'visitor-merchant-capacity',
          customerName: '테스트 사용자',
          customerPhone: '01012345678',
          type: 'purchase',
          dealId: 'owner-merchant-capacity',
          selectedCount: 2,
          deal: { id: 'owner-merchant-capacity', title: '동시 주문 테스트' },
        },
      },
    });
    assert.equal(orderResponse.statusCode, 409);
    assert.deepEqual(orderResponse.body, { ok: false, error: 'quantity_unavailable' });

    const dealResponse = await invoke(publicDealsHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        capabilityToken: `deal-${'k'.repeat(64)}`,
        deal: {
          id: 'owner-merchant-capacity',
          source: 'merchant',
          saleType: 'group',
          title: '수량 축소 테스트',
          originalPrice: 10000,
          discountRate: 0,
          totalQuantity: 6,
          image: 'https://example.test/image.jpg',
          menu: [],
        },
      },
    });
    assert.equal(dealResponse.statusCode, 409);
    assert.deepEqual(dealResponse.body, {
      ok: false,
      error: 'quantity_below_active_allocations',
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('group order reservations bind once to canonical join or reserve provenance', () => {
  const collector = appsScriptContext();
  const history = [
    {
      rowNumber: 2,
      groupId: 'customer-provenance-test',
      actorId: 'visitor-provenance-test',
      action: 'join',
      mutationId: 'membership-join-provenance-test',
      fromStatus: '',
      toStatus: 'joined',
    },
    {
      rowNumber: 3,
      groupId: 'customer-provenance-test',
      actorId: 'visitor-provenance-test',
      action: 'reserve_quantity',
      mutationId: 'checkout-reserve-provenance-test',
      fromStatus: '2',
      toStatus: '4',
    },
  ];
  const participant = { selectedQuantity: 4 };
  const fabricatedOrder = {
    selectedCount: 2,
    reservationMutationId: 'checkout-client-only-id',
  };
  assert.throws(
    () => collector.selectCustomerOrderReservation_(history, {}, fabricatedOrder, participant),
    (error) => error?.code === 'order_reservation_unverified',
  );

  const initialOrder = {
    selectedCount: 2,
    reservationMutationId: 'membership-join-provenance-test',
  };
  const initial = collector.selectCustomerOrderReservation_(history, {}, initialOrder, participant);
  assert.equal(initial.action, 'join');
  assert.equal(initial.mutationId, 'membership-join-provenance-test');
  assert.equal(initial.quantity, 2);

  assert.throws(
    () => collector.selectCustomerOrderReservation_(
      history,
      { 'membership-join-provenance-test': 'order-1234567890198' },
      initialOrder,
      participant,
    ),
    (error) => error?.code === 'order_reservation_conflict',
  );

  const reserved = collector.selectCustomerOrderReservation_(history, {}, {
    selectedCount: 2,
    reservationMutationId: 'checkout-reserve-provenance-test',
  }, participant);
  assert.equal(reserved.action, 'reserve_quantity');
  assert.equal(reserved.mutationId, 'checkout-reserve-provenance-test');

  assert.throws(
    () => collector.selectCustomerOrderReservation_(history, {}, {
      selectedCount: 1,
      reservationMutationId: 'fabricated-reservation-id',
    }, participant),
    (error) => error?.code === 'order_reservation_unverified',
  );

  const participantCapabilityHash = 'a'.repeat(64);
  assert.equal(
    collector.requireParticipantCapability_({ capabilityHash: participantCapabilityHash }, participantCapabilityHash),
    participantCapabilityHash,
  );
  assert.throws(
    () => collector.requireParticipantCapability_(
      { capabilityHash: participantCapabilityHash },
      'b'.repeat(64),
    ),
    (error) => error?.code === 'invalid_participant_capability',
  );
});

test('customer order snapshots enforce CAS and terminal monotonic transitions', () => {
  const collector = appsScriptContext();
  const now = '2026-08-27T12:00:00.000Z';
  const base = {
    id: 'order-1234567890199',
    createdAt: '2026-08-27T11:00:00.000Z',
    visitorId: 'visitor-order-cas-test',
    participantActorId: 'visitor-order-cas-test',
    customerPhone: '01012345678',
    dealId: 'owner-order-cas-test',
    groupId: '',
    type: 'purchase',
    selectedCount: 2,
    total: 5580,
    status: 'new',
    paymentStatus: 'pending',
    version: 1,
    paymentVersion: 1,
    statusHistory: [],
  };

  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(base, {
      ...base,
      status: 'preparing',
    }, now),
    (error) => error?.code === 'order_transition_forbidden',
  );

  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(base, {
      ...base,
      paymentStatus: 'confirmed',
      paymentConfirmedAt: now,
    }, now),
    (error) => error?.code === 'order_transition_forbidden',
  );

  const paymentRequestInput = {
    ...base,
    paymentStatus: 'requested',
    paymentRequestedAt: now,
    publishMutationId: 'publish-payment-response-loss',
  };
  const paymentRequested = collector.mergeCustomerOrderUpdate_(base, paymentRequestInput, now);
  assert.equal(paymentRequested.status, 'new');
  assert.equal(paymentRequested.paymentStatus, 'requested');
  assert.equal(paymentRequested.version, 2);
  assert.equal(paymentRequested.paymentRequestedAt, now);
  const paymentReplay = collector.mergeCustomerOrderUpdate_(
    paymentRequested,
    paymentRequestInput,
    '2026-08-27T12:00:05.000Z',
  );
  assert.equal(paymentReplay.version, 2);
  assert.equal(paymentReplay.paymentRequestedAt, now);

  const serverManaged = {
    ...paymentRequested,
    status: 'preparing',
    version: 3,
    paymentVersion: 3,
    statusUpdatedAt: '2026-08-27T12:10:00.000Z',
  };
  const currentSnapshotReplay = collector.mergeCustomerOrderUpdate_(
    serverManaged,
    serverManaged,
    '2026-08-27T12:10:05.000Z',
  );
  assert.equal(currentSnapshotReplay.status, 'preparing');
  assert.equal(currentSnapshotReplay.version, 3);
  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(serverManaged, {
      ...serverManaged,
      status: 'new',
    }, now),
    (error) => error?.code === 'client_mutation_conflict',
  );
  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(paymentRequested, {
      ...paymentRequestInput,
      paymentStatus: 'pending',
    }, now),
    (error) => error?.code === 'client_mutation_conflict',
  );

  const cancelled = {
    ...base,
    status: 'cancelled',
    paymentStatus: 'cancelled',
    cancelledAt: now,
    version: 2,
    paymentVersion: 2,
  };
  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(cancelled, base, now),
    (error) => error?.code === 'state_conflict',
  );

  const processed = {
    ...base,
    status: 'preparing',
    paymentStatus: 'confirmed',
    paymentConfirmedAt: '2026-08-27T11:30:00.000Z',
    version: 2,
    paymentVersion: 2,
  };
  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(processed, {
      ...processed,
      status: 'cancelled',
      paymentStatus: 'cancelled',
      version: 3,
      paymentVersion: 3,
    }, now),
    (error) => error?.code === 'order_transition_forbidden',
  );

  assert.throws(
    () => collector.mergeCustomerOrderUpdate_({
      ...base,
      groupId: 'customer-order-cas-test',
      dealId: 'customer-order-cas-test',
    }, {
      ...base,
      groupId: 'customer-order-cas-test',
      dealId: 'customer-order-cas-test',
      status: 'cancelled',
      paymentStatus: 'cancelled',
      version: 2,
      paymentVersion: 2,
    }, now),
    (error) => error?.code === 'order_transition_forbidden',
  );
});

test('manager transitions are one-step, reversible, role-scoped, and compare-and-swap protected', () => {
  const collector = appsScriptContext();
  const now = '2026-08-29T02:00:00.000Z';
  const base = {
    id: 'order-1234567890460',
    createdAt: '2026-08-29T01:00:00.000Z',
    status: 'new',
    paymentStatus: 'pending',
    version: 1,
    paymentVersion: 1,
    statusHistory: [],
  };

  const progressed = collector.applyManagedCustomerOrderTransition_(base, {
    kind: 'order_status',
    direction: 'next',
    expectedVersion: 1,
    clientMutationId: 'manage-status-next-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(progressed.duplicate, false);
  assert.equal(progressed.order.status, 'preparing');
  assert.equal(progressed.order.version, 2);
  assert.equal(progressed.order.statusHistory[0].actorRole, 'merchant_owner');

  const reverted = collector.applyManagedCustomerOrderTransition_(progressed.order, {
    kind: 'order_status',
    direction: 'previous',
    expectedVersion: 2,
    clientMutationId: 'manage-status-prev-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(reverted.order.status, 'new');
  assert.equal(reverted.order.version, 3);

  assert.throws(
    () => collector.applyManagedCustomerOrderTransition_(progressed.order, {
      kind: 'order_status',
      direction: 'next',
      expectedVersion: 1,
      clientMutationId: 'manage-status-stale-one',
    }, 'merchant_owner', 'merchant-owner-test', now),
    (error) => error?.code === 'state_conflict',
  );

  const confirmed = collector.applyManagedCustomerOrderTransition_(base, {
    kind: 'payment_status',
    direction: 'next',
    expectedVersion: 1,
    clientMutationId: 'manage-payment-next-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(confirmed.order.paymentStatus, 'confirmed');
  assert.equal(confirmed.order.paymentConfirmedAt, now);

  const confirmationReverted = collector.applyManagedCustomerOrderTransition_(confirmed.order, {
    kind: 'payment_status',
    direction: 'previous',
    expectedVersion: 2,
    clientMutationId: 'manage-payment-prev-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(confirmationReverted.order.paymentStatus, 'pending');
  assert.equal(confirmationReverted.order.paymentConfirmedAt, '');
  assert.equal(confirmationReverted.order.paymentRequestedAt, '');

  assert.throws(
    () => collector.applyManagedCustomerOrderTransition_(base, {
      kind: 'payment_status',
      direction: 'next',
      expectedVersion: 1,
      clientMutationId: 'manage-group-pending-one',
    }, 'host', 'visitor-host-test', now),
    (error) => error?.code === 'invalid_state_transition',
  );
  const requested = { ...base, paymentStatus: 'requested', paymentRequestedAt: now };
  const hostConfirmed = collector.applyManagedCustomerOrderTransition_(requested, {
    kind: 'payment_status',
    direction: 'next',
    expectedVersion: 1,
    clientMutationId: 'manage-group-request-one',
  }, 'host', 'visitor-host-test', now);
  assert.equal(hostConfirmed.order.paymentStatus, 'confirmed');

  const replay = collector.applyManagedCustomerOrderTransition_(confirmed.order, {
    kind: 'payment_status',
    direction: 'next',
    expectedVersion: 1,
    clientMutationId: 'manage-payment-next-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(replay.duplicate, true);
  assert.throws(
    () => collector.applyManagedCustomerOrderTransition_(confirmed.order, {
      kind: 'payment_status',
      direction: 'next',
      expectedVersion: 2,
      clientMutationId: 'manage-payment-next-one',
    }, 'merchant_owner', 'merchant-owner-test', now),
    (error) => error?.code === 'client_mutation_conflict',
  );
  assert.throws(
    () => collector.applyManagedCustomerOrderTransition_(confirmed.order, {
      kind: 'payment_status',
      direction: 'previous',
      expectedVersion: 2,
      clientMutationId: 'manage-payment-next-one',
    }, 'merchant_owner', 'merchant-owner-test', now),
    (error) => error?.code === 'client_mutation_conflict',
  );
});

test('group payment synchronization accepts active participant and creator orders with exact reservation provenance', () => {
  const collector = appsScriptContext();
  const groupId = 'owner-payment-binding-test';
  const actorId = 'visitor-payment-binding-test';
  const history = [{
    rowNumber: 2,
    groupId,
    fromStatus: '0',
    toStatus: '2',
    action: 'join',
    actorId,
    mutationId: 'join-payment-binding-test',
  }];
  const boundOrder = {
    id: 'order-1234567890463',
    type: 'purchase',
    status: 'new',
    paymentStatus: 'pending',
    groupId,
    dealId: groupId,
    visitorId: actorId,
    participantActorId: actorId,
    selectedCount: 2,
    reservationMutationId: 'join-payment-binding-test',
    reservationAction: 'join',
    reservationQuantity: 2,
    _reservationMutationId: 'join-payment-binding-test',
    _reservationAction: 'join',
    _reservationQuantity: 2,
  };

  assert.equal(
    collector.verifiedBoundGroupPurchaseOrder_(boundOrder, groupId, actorId, history),
    true,
  );
  assert.equal(
    collector.verifiedBoundGroupPurchaseOrder_({ ...boundOrder, type: 'group' }, groupId, actorId, history),
    true,
  );
  [
    { ...boundOrder, type: 'product' },
    { ...boundOrder, status: 'cancelled' },
    { ...boundOrder, participantActorId: 'visitor-other-payment-binding' },
    { ...boundOrder, _reservationMutationId: '' },
    { ...boundOrder, reservationQuantity: 1 },
    { ...boundOrder, selectedCount: 1 },
  ].forEach((invalidOrder) => {
    assert.equal(
      collector.verifiedBoundGroupPurchaseOrder_(invalidOrder, groupId, actorId, history),
      false,
    );
  });
  assert.equal(
    collector.verifiedBoundGroupPurchaseOrder_(boundOrder, groupId, actorId, []),
    false,
  );
});

test('group payment transition updates every verified bound order and ignores unverified lookalikes', () => {
  const collector = appsScriptContext();
  collector.Utilities = { getUuid: () => 'history-payment-sync-test' };
  const groupId = 'owner-payment-sync-test';
  const actorId = 'visitor-payment-sync-test';
  const makeOrder = (id, quantity, mutationId, action) => ({
    id,
    createdAt: '2026-08-31T08:00:00.000Z',
    type: 'purchase',
    status: 'new',
    paymentStatus: 'pending',
    version: 1,
    paymentVersion: 1,
    groupId,
    dealId: groupId,
    visitorId: actorId,
    participantActorId: actorId,
    selectedCount: quantity,
    reservationMutationId: mutationId,
    reservationAction: action,
    reservationQuantity: quantity,
    _reservationMutationId: mutationId,
    _reservationAction: action,
    _reservationQuantity: quantity,
    statusHistory: [],
  });
  const first = makeOrder('order-1234567890464', 2, 'join-payment-sync-test', 'join');
  const second = makeOrder('order-1234567890465', 1, 'reserve-payment-sync-test', 'reserve_quantity');
  const unverified = {
    ...makeOrder('order-1234567890466', 1, 'missing-payment-sync-test', 'reserve_quantity'),
    reservationMutationId: '',
    _reservationMutationId: '',
  };
  const customerRows = [first, second, unverified].map((order) => [
    new Date(order.createdAt), order.id, '01012345678', JSON.stringify(order),
  ]);
  const historyRows = [
    ['', groupId, '', '', '0', '2', 'join', actorId, '', '', 'join-payment-sync-test', 1, '', ''],
    ['', groupId, '', '', '2', '3', 'reserve_quantity', actorId, '', '', 'reserve-payment-sync-test', 2, '', ''],
  ];
  const capabilityHash = 'a'.repeat(64);
  const participantRows = [[
    groupId,
    actorId,
    '결제테스터',
    'member',
    true,
    'requested',
    0,
    capabilityHash,
    4,
    '2026-08-31T08:00:00.000Z',
    '2026-08-31T08:30:00.000Z',
    3,
  ]];
  const memorySheet = (rows) => ({
    getLastRow() { return rows.length + 1; },
    appendRow(value) { rows.push(value.slice()); },
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues() {
          return rows.slice(row - 2, row - 2 + rowCount)
            .map((source) => source.slice(column - 1, column - 1 + columnCount));
        },
        setValues(values) {
          values.forEach((value, index) => {
            rows[row - 2 + index] = value.slice();
          });
        },
      };
    },
  });
  const sheets = {
    customerOrders: memorySheet(customerRows),
    groupHistory: memorySheet(historyRows),
    groupParticipants: memorySheet(participantRows),
    events: {},
  };
  const now = '2026-08-31T09:00:00.000Z';

  const requested = collector.syncGroupPaymentOrders_(
    sheets,
    groupId,
    actorId,
    'pending',
    'requested',
    actorId,
    'member',
    'payment-request-sync-test',
    now,
  );
  assert.equal(requested.changedCount, 2);
  assert.equal(requested.paymentStatus, 'requested');
  assert.equal(JSON.parse(customerRows[0][3]).paymentStatus, 'requested');
  assert.equal(JSON.parse(customerRows[1][3]).paymentStatus, 'requested');
  assert.equal(JSON.parse(customerRows[2][3]).paymentStatus, 'pending');

  const confirmed = collector.syncGroupPaymentOrders_(
    sheets,
    groupId,
    actorId,
    'requested',
    'confirmed',
    'merchant-owner-payment-sync-test',
    'merchant_owner',
    'payment-confirm-sync-test',
    now,
  );
  assert.equal(confirmed.changedCount, 2);
  assert.equal(confirmed.paymentStatus, 'confirmed');
  assert.equal(JSON.parse(customerRows[0][3]).paymentStatus, 'confirmed');
  assert.equal(JSON.parse(customerRows[1][3]).paymentStatus, 'confirmed');

  const participantSync = collector.syncParticipantPaymentFromOrders_(
    sheets,
    groupId,
    actorId,
    'merchant-owner-payment-sync-test',
    'merchant_owner',
    'participant-confirm-sync-test',
    now,
  );
  assert.equal(participantSync.changed, true);
  assert.equal(participantSync.paymentStatus, 'confirmed');
  assert.equal(participantRows[0][5], 'confirmed');
  assert.equal(participantRows[0][7], capabilityHash);
  assert.equal(participantRows[0][8], 5);
});

test('participant payment projection repairs stale owner views without changing CAS versions', () => {
  const collector = appsScriptContext();
  const base = {
    paymentStatus: 'pending',
    version: 7,
    paymentVersion: 7,
    paymentRequestedAt: '',
    paymentConfirmedAt: '',
  };
  const requestedAt = '2026-08-31T09:10:00.000Z';
  const requested = collector.projectOrderPaymentFromParticipant_(base, {
    paymentStatus: 'requested',
    updatedAt: requestedAt,
  });
  assert.equal(requested.paymentStatus, 'requested');
  assert.equal(requested.paymentRequestedAt, requestedAt);
  assert.equal(requested.statusUpdatedAt, requestedAt);
  assert.equal(requested.syncedAt, requestedAt);
  assert.equal(requested.version, 7);
  assert.equal(base.paymentStatus, 'pending');

  const confirmed = collector.projectOrderPaymentFromParticipant_(requested, {
    paymentStatus: 'confirmed',
    updatedAt: requestedAt,
  });
  assert.equal(confirmed.paymentStatus, 'confirmed');
  assert.equal(confirmed.paymentConfirmedAt, requestedAt);
  assert.equal(confirmed.version, 7);
});

test('projected payment timestamps replace a same-version cached order in both lists', () => {
  const collector = appsScriptContext();
  const stored = {
    id: 'order-178877665544332212',
    paymentStatus: 'pending',
    version: 7,
    paymentVersion: 7,
    statusUpdatedAt: '2026-09-08T07:00:00.000Z',
    syncedAt: '2026-09-08T07:00:00.000Z',
  };
  const cached = { ...stored, syncedAt: '2026-09-08T07:01:00.000Z' };
  const projected = collector.projectOrderPaymentFromParticipant_(stored, {
    paymentStatus: 'confirmed',
    updatedAt: '2026-09-08T07:02:00.000Z',
  });
  for (const merge of [mergeCustomerOrderCollections, mergeOwnerOrderRefresh]) {
    assert.equal(merge([cached], [projected])[0].paymentStatus, 'confirmed');
    assert.equal(merge([projected], [cached])[0].paymentStatus, 'confirmed');
  }
  assert.equal(stored.paymentStatus, 'pending');
  assert.equal(projected.version, stored.version);
});

test('merchant group payments require a participant request while instant orders remain directly confirmable', () => {
  const collector = appsScriptContext();
  const groupDeal = {
    id: 'owner-payment-request-test',
    source: 'merchant',
    saleType: 'group',
  };
  assert.throws(
    () => collector.requireMerchantGroupPaymentRequest_({
      groupId: groupDeal.id,
      paymentStatus: 'pending',
    }, groupDeal, 'payment_status', 'next'),
    (error) => error?.code === 'payment_request_required',
  );
  assert.throws(
    () => collector.requireMerchantGroupPaymentRequest_({
      groupId: groupDeal.id,
      paymentStatus: 'pending',
    }, {
      id: groupDeal.id,
      source: 'merchant',
    }, 'payment_status', 'next'),
    (error) => error?.code === 'payment_request_required',
  );
  assert.equal(collector.requireMerchantGroupPaymentRequest_({
    groupId: groupDeal.id,
    paymentStatus: 'requested',
  }, groupDeal, 'payment_status', 'next'), true);
  assert.equal(collector.requireMerchantGroupPaymentRequest_({
    groupId: '',
    paymentStatus: 'pending',
  }, {
    id: 'owner-instant-payment-test',
    source: 'merchant',
    saleType: 'instant',
  }, 'payment_status', 'next'), true);
});

test('merchant order management requires the exact deal owner capability', () => {
  const collector = appsScriptContext();
  const ownerHash = 'a'.repeat(64);
  assert.equal(
    collector.requireMerchantOwnerCapability_({ _ownerCapabilityHash: ownerHash }, ownerHash),
    ownerHash,
  );
  assert.throws(
    () => collector.requireMerchantOwnerCapability_({ _ownerCapabilityHash: ownerHash }, 'b'.repeat(64)),
    (error) => error?.code === 'forbidden',
  );
  assert.throws(
    () => collector.requireMerchantOwnerCapability_({}, ownerHash),
    (error) => error?.code === 'deal_ownership_unclaimable',
  );
});

test('only creators or members with an active bound reservation order may claim host', () => {
  const collector = appsScriptContext();
  const orderSheet = (orders) => ({
    getLastRow() { return orders.length + 1; },
    getRange() {
      return { getValues: () => orders.map((order) => [JSON.stringify(order)]) };
    },
  });
  const activeBoundOrder = {
    id: 'order-1234567890461',
    type: 'purchase',
    status: 'new',
    paymentStatus: 'pending',
    groupId: 'customer-host-order-test',
    participantActorId: 'visitor-host-order-test',
    selectedCount: 2,
    _reservationAction: 'join',
    _reservationMutationId: 'membership-host-order-test',
    _reservationQuantity: 2,
  };
  const merchantDealId = 'merchant-legacy-host-order-test';
  const merchantDealSheet = {
    getLastRow() { return 2; },
    getRange(_row, column) {
      if (column === 2) {
        return {
          createTextFinder() {
            return {
              matchEntireCell() {
                return { findNext: () => ({ getRow: () => 2 }) };
              },
            };
          },
        };
      }
      return {
        getValue: () => JSON.stringify({
          id: merchantDealId,
          source: 'merchant',
          saleType: 'group',
          totalQuantity: 20,
        }),
      };
    },
  };

  assert.equal(collector.requireHostClaimEligibility_(
    { customerOrders: orderSheet([]) },
    { counted: true, role: 'creator' },
    'customer-host-order-test',
    'visitor-creator-test',
  ), true);
  assert.throws(() => collector.requireHostClaimEligibility_({
    customerOrders: orderSheet([{
      id: 'order-1234567890462',
      type: 'purchase',
      status: 'new',
      paymentStatus: 'pending',
      dealId: merchantDealId,
      visitorId: 'visitor-legacy-host-order',
      selectedCount: 3,
    }]),
    publicDeals: merchantDealSheet,
  }, {
    counted: true,
    role: 'member',
  }, merchantDealId, 'visitor-legacy-host-order'),
  (error) => error?.code === 'host_order_required');
  assert.equal(collector.requireHostClaimEligibility_(
    { customerOrders: orderSheet([activeBoundOrder]) },
    { counted: true, role: 'member' },
    'customer-host-order-test',
    'visitor-host-order-test',
  ), true);

  [
    { ...activeBoundOrder, status: 'cancelled', paymentStatus: 'cancelled' },
    { ...activeBoundOrder, _reservationMutationId: '' },
    { ...activeBoundOrder, _reservationQuantity: 0 },
  ].forEach((invalidOrder) => {
    assert.throws(
      () => collector.requireHostClaimEligibility_(
        { customerOrders: orderSheet([invalidOrder]) },
        { counted: true, role: 'member' },
        'customer-host-order-test',
        'visitor-host-order-test',
      ),
      (error) => error?.code === 'host_order_required',
    );
  });
});

test('legacy customer recovery hashes the canonical event receipt at the Vercel boundary', async () => {
  const previous = {
    GOOGLE_SHEETS_COLLECTOR_URL: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
  };
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    forwarded.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          duplicate: false,
          snapshot: { group: {}, participants: [], history: [] },
          legacyEventHash: 'must-not-be-returned',
        };
      },
    };
  };

  const dealId = 'customer-1783571204389';
  const eventId = '8d7be6e4-41e7-4fd7-8bc7-62dd4491a5f1';
  const eventHash = createHash('sha256').update(eventId).digest('hex');
  const mutationReceipt = createHash('sha256')
    .update(`legacy-recovery:${eventHash}`)
    .digest('hex');
  const capabilityToken = `group-${'g'.repeat(64)}`;

  try {
    const response = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'recover_legacy_customer_group',
        groupId: dealId,
        dealId,
        actorId: 'visitor-legacy-recovery',
        nickname: '기존 생성자',
        legacyEventId: eventId,
        capabilityToken,
        clientMutationId: 'browser-chosen-id-is-ignored',
        title: '브라우저가 조작한 제목',
        targetCount: 20,
        totalQuantity: 999,
        selectedQuantity: 999,
        hostMode: 'recruiting',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.capabilityToken, capabilityToken);
    assert.equal(response.body.legacyEventHash, undefined);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].action, 'group_recover_legacy_customer_group');
    assert.equal(forwarded[0].payload.legacyEventHash, eventHash);
    assert.equal(forwarded[0].payload.clientMutationId, `legacy-recovery-${mutationReceipt}`);
    assert.equal(forwarded[0].payload.title, undefined);
    assert.equal(forwarded[0].payload.targetCount, undefined);
    assert.equal(forwarded[0].payload.hostMode, undefined);
    assert.equal(forwarded[0].payload.legacyEventId, undefined);
    assert.equal(JSON.stringify(forwarded[0]).includes(eventId), false);
    assert.equal(JSON.stringify(forwarded[0]).includes(capabilityToken), false);

    for (const invalid of [
      { legacyEventId: 'not-a-uuid', dealId },
      { legacyEventId: eventId, dealId: 'customer-not-allowlisted' },
      { legacyEventId: eventId, dealId, capabilityToken: 'short' },
    ]) {
      const rejected = await invoke(groupHandler, {
        headers: { origin: 'http://localhost:5173' },
        body: {
          action: 'recover_legacy_customer_group',
          groupId: invalid.dealId,
          dealId: invalid.dealId,
          actorId: 'visitor-legacy-recovery',
          nickname: '기존 생성자',
          capabilityToken,
          ...invalid,
        },
      });
      assert.equal(rejected.statusCode, 403);
      assert.deepEqual(rejected.body, { ok: false, error: 'legacy_recovery_not_authorized' });
    }
    assert.equal(forwarded.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test('legacy customer recovery exposes one generic error for upstream authorization failures', async () => {
  const previous = {
    GOOGLE_SHEETS_COLLECTOR_URL: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    O2O_DATA_API_ORIGIN: process.env.O2O_DATA_API_ORIGIN,
  };
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: false, error: 'group_not_found' }; },
  });
  try {
    const response = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'recover_legacy_customer_group',
        groupId: 'customer-1783571204389',
        dealId: 'customer-1783571204389',
        actorId: 'visitor-legacy-recovery',
        nickname: '기존 생성자',
        legacyEventId: '8d7be6e4-41e7-4fd7-8bc7-62dd4491a5f1',
        capabilityToken: `group-${'g'.repeat(64)}`,
      },
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, { ok: false, error: 'legacy_recovery_not_authorized' });
  } finally {
    globalThis.fetch = previousFetch;
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

function legacyRecoveryEventRow({ receivedAt, clientAt, actorId, eventId, dealId }) {
  const row = Array(15).fill('');
  row[0] = new Date(receivedAt);
  row[1] = new Date(clientAt);
  row[4] = actorId;
  row[6] = 'group_created';
  row[11] = JSON.stringify({ deal_id: dealId, source: 'customer' });
  row[14] = eventId;
  return row;
}

test('Apps Script freezes only pre-cutoff server receipts and excludes actor conflicts', () => {
  const context = appsScriptContext();
  const eligibleDealId = 'customer-1783571204389';
  const conflictDealId = 'customer-1784457727675';
  const lateDealId = 'customer-1784384845725';
  const eligibleEventId = '8d7be6e4-41e7-4fd7-8bc7-62dd4491a5f1';
  const rows = [
    legacyRecoveryEventRow({
      receivedAt: '2026-09-03T10:44:59.000Z',
      clientAt: '2099-01-01T00:00:00.000Z',
      actorId: 'visitor-eligible-recovery',
      eventId: eligibleEventId,
      dealId: eligibleDealId,
    }),
    legacyRecoveryEventRow({
      receivedAt: '2026-09-03T10:45:01.000Z',
      clientAt: '2020-01-01T00:00:00.000Z',
      actorId: 'visitor-late-recovery',
      eventId: '67368a1f-a356-44e4-9a7f-3ce77ce6d1c7',
      dealId: lateDealId,
    }),
    legacyRecoveryEventRow({
      receivedAt: '2026-09-03T10:40:00.000Z',
      clientAt: '2026-09-03T10:40:00.000Z',
      actorId: 'visitor-conflict-one',
      eventId: 'c38285d7-609b-4a21-a938-a735a63f8433',
      dealId: conflictDealId,
    }),
    legacyRecoveryEventRow({
      receivedAt: '2026-09-03T10:41:00.000Z',
      clientAt: '2026-09-03T10:41:00.000Z',
      actorId: 'visitor-conflict-two',
      eventId: '136c11cc-1957-4278-83ca-0d762af40086',
      dealId: conflictDealId,
    }),
  ];
  const deals = {
    [eligibleDealId]: {
      id: eligibleDealId,
      groupId: eligibleDealId,
      source: 'customer',
      visibility: 'public',
      creatorActorId: 'visitor-eligible-recovery',
    },
    [lateDealId]: {
      id: lateDealId,
      groupId: lateDealId,
      source: 'customer',
      visibility: 'public',
      creatorActorId: 'visitor-late-recovery',
    },
    [conflictDealId]: {
      id: conflictDealId,
      groupId: conflictDealId,
      source: 'customer',
      visibility: 'public',
      creatorActorId: 'visitor-conflict-one',
    },
  };
  const sheets = {
    events: {
      getLastRow: () => rows.length + 1,
      getRange: () => ({ getValues: () => rows }),
    },
    publicDeals: {},
    groups: {},
  };
  context.publicDealRecord_ = (_sheet, dealId) => deals[dealId] || null;
  context.findExactRow_ = () => 0;
  const built = JSON.parse(JSON.stringify(context.buildLegacyRecoveryManifest_(sheets)));
  assert.equal(built.entries.length, 1);
  assert.equal(built.entries[0].dealId, eligibleDealId);
  assert.equal(
    built.entries[0].eventHash,
    createHash('sha256').update(eligibleEventId).digest('hex'),
  );
  assert.deepEqual(built.conflictDealIds, [conflictDealId]);
  assert.equal(built.entries.some((entry) => entry.dealId === lateDealId), false);

  deals[eligibleDealId].groupStatus = 'purchased';
  const completedDealBuild = JSON.parse(JSON.stringify(context.buildLegacyRecoveryManifest_(sheets)));
  assert.equal(completedDealBuild.entries.some((entry) => entry.dealId === eligibleDealId), false);
  deals[eligibleDealId].groupStatus = 'recruiting';

  const stored = new Map();
  let propertyWrites = 0;
  context.acquireScriptLock_ = () => ({ releaseLock() {} });
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => stored.has(key) ? stored.get(key) : null,
      setProperty(key, value) {
        propertyWrites += 1;
        stored.set(key, value);
      },
    }),
  };
  context.ensureSheets_ = () => sheets;
  context.json_ = (value) => value;
  const first = JSON.parse(JSON.stringify(context.freezeLegacyRecoveryManifest_()));
  assert.equal(first.ok, true);
  assert.equal(first.count, 1);
  assert.deepEqual(first.eligibleDealIds, [eligibleDealId]);
  assert.deepEqual(first.conflictDealIds, [conflictDealId]);
  assert.equal(first.missingDealIds.includes(lateDealId), true);
  assert.equal(JSON.stringify(first).includes(eligibleEventId), false);
  assert.equal(JSON.stringify(first).includes('visitor-eligible-recovery'), false);
  assert.equal(JSON.stringify(first).includes(built.entries[0].eventHash), false);
  const storedManifest = JSON.parse(stored.values().next().value);
  assert.deepEqual(Object.keys(storedManifest[0]).sort(), ['actorId', 'dealId', 'eventHash']);
  assert.equal(JSON.stringify(storedManifest).includes(eligibleEventId), false);

  context.ensureSheets_ = () => { throw new Error('must not rebuild a frozen manifest'); };
  const second = JSON.parse(JSON.stringify(context.freezeLegacyRecoveryManifest_()));
  assert.equal(second.ok, true);
  assert.equal(second.count, 1);
  assert.equal(propertyWrites, 1);
});

test('Apps Script legacy recovery derives group state from the central deal and enforces receipt idempotency', () => {
  const context = appsScriptContext();
  const dealId = 'customer-1783571204389';
  const actorId = 'visitor-legacy-recovery-server';
  const eventHash = createHash('sha256')
    .update('8d7be6e4-41e7-4fd7-8bc7-62dd4491a5f1')
    .digest('hex');
  const capabilityHash = 'a'.repeat(64);
  const manifest = JSON.stringify([{ eventHash, actorId, dealId }]);
  context.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => manifest }),
  };
  context.publicDealRecord_ = () => ({
    id: dealId,
    groupId: dealId,
    source: 'customer',
    visibility: 'public',
    creatorActorId: actorId,
    title: '중앙 상품 제목',
    targetPeople: 3,
    productQuantity: 7,
    creatorProductQuantity: 2,
    hostMode: 'self',
  });
  context.findExactRow_ = () => 0;
  context.findMutation_ = () => null;
  context.repairPendingMerchantDealPublish_ = () => {};
  context.repairPendingGroupMutations_ = () => {};
  const commits = [];
  context.commitGroupMutationIntent_ = (...args) => commits.push(args);
  context.invalidateGroupSnapshot_ = () => {};
  const payload = {
    groupId: dealId,
    dealId,
    actorId,
    nickname: '기존 생성자',
    legacyEventHash: eventHash,
    capabilityHash,
    clientMutationId: 'browser-cannot-choose-this',
    title: '조작된 제목',
    targetCount: 20,
    totalQuantity: 999,
    selectedQuantity: 999,
    hostMode: 'recruiting',
  };

  const recovered = context.executeGroupMutation_('recover_legacy_customer_group', payload, {
    groups: {}, publicDeals: {}, groupHistory: {}, groupParticipants: {},
  });
  assert.equal(recovered.duplicate, false);
  assert.equal(commits.length, 1);
  const history = commits[0][1];
  const operations = commits[0][4];
  const expectedMutation = `legacy-recovery-${createHash('sha256')
    .update(`legacy-recovery:${eventHash}`)
    .digest('hex')}`;
  assert.equal(history.clientMutationId, expectedMutation);
  assert.equal(history.action, 'recover_legacy_customer_group');
  assert.equal(operations[0].target.title, '중앙 상품 제목');
  assert.equal(operations[0].target.targetCount, 3);
  assert.equal(operations[0].target.totalQuantity, 7);
  assert.equal(operations[0].target.hostMode, 'self');
  assert.equal(operations[1].target.selectedQuantity, 2);
  assert.equal(operations[1].target.role, 'host');
  assert.equal(operations[1].target.capabilityHash, capabilityHash);
  assert.equal(JSON.stringify(commits[0]).includes(eventHash), false);

  const storedContract = commits[0][2];
  context.findMutation_ = () => ({
    groupId: dealId,
    actorId,
    result: { mutationContract: storedContract },
  });
  context.authorizeGroupActor_ = () => ({ actorId, role: 'host', participant: { role: 'host', counted: true } });
  const duplicate = context.executeGroupMutation_('recover_legacy_customer_group', {
    ...payload,
    clientMutationId: 'another-browser-value',
  }, { groups: {}, publicDeals: {} });
  assert.equal(duplicate.duplicate, true);
  assert.equal(commits.length, 1);

  assert.throws(
    () => context.executeGroupMutation_('recover_legacy_customer_group', {
      ...payload,
      capabilityHash: 'b'.repeat(64),
    }, { groups: {}, publicDeals: {} }),
    (error) => error?.code === 'client_mutation_conflict',
  );

  context.ensureSheets_ = () => ({ groups: {}, publicDeals: {} });
  context.acquireScriptLock_ = () => ({ releaseLock() {} });
  context.json_ = (value) => value;
  const denied = context.handleGroupOperation_('recover_legacy_customer_group', {
    ...payload,
    legacyEventHash: 'f'.repeat(64),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(denied)), {
    ok: false,
    error: 'legacy_recovery_not_authorized',
  });
});
