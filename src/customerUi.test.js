import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGroupNotifications,
  canOpenOrderGroupRoom,
  canSubmitDealOrder,
  dealHasGroupRoom,
  hostApplyErrorMessage,
  isDealRecruiting,
  isDealHostMatched,
  joinSubmitErrorMessage,
  resolveOrderLinkedDeal,
  shouldKeepOwnerPreview,
  shouldNavigateAfterDealDelete,
} from './customerUi.js';

test('legacy groups without an explicit status use the recruiting default everywhere', () => {
  assert.equal(isDealRecruiting({ source: 'customer' }), true);
  assert.equal(isDealRecruiting({ groupStatus: 'recruiting' }), true);
  assert.equal(isDealRecruiting({ groupStatus: 'recruited' }), false);
  assert.equal(isDealRecruiting({ groupStatus: 'purchased' }), false);
});

test('checkout closes for both customer and merchant groups after recruitment', () => {
  const available = { selectedCount: 1, remaining: 3 };
  assert.equal(canSubmitDealOrder({
    ...available,
    deal: { source: 'merchant', saleType: 'group', groupStatus: 'recruiting' },
  }), true);
  assert.equal(canSubmitDealOrder({
    ...available,
    deal: { source: 'merchant', saleType: 'group', groupStatus: 'recruited' },
  }), false);
  assert.equal(canSubmitDealOrder({
    ...available,
    deal: { source: 'customer', saleType: 'community', groupStatus: 'purchased' },
  }), false);
  assert.equal(canSubmitDealOrder({
    ...available,
    deal: { source: 'merchant', saleType: 'instant', groupStatus: 'purchased' },
  }), true);
});

test('failed or ambiguous deletion results keep the current detail screen open', () => {
  assert.equal(shouldNavigateAfterDealDelete(true), true);
  assert.equal(shouldNavigateAfterDealDelete(false), false);
  assert.equal(shouldNavigateAfterDealDelete(undefined), false);
});

test('merchant customer preview state survives only on the customer route', () => {
  assert.equal(shouldKeepOwnerPreview('/customer'), true);
  assert.equal(shouldKeepOwnerPreview('/owner'), false);
  assert.equal(shouldKeepOwnerPreview('/admin'), false);
  assert.equal(shouldKeepOwnerPreview('/'), false);
});

test('group notifications open unread rooms first and fall back to status details', () => {
  const deals = [
    { id: 'status-only', source: 'customer', saleType: 'community' },
    { id: 'unread-small', source: 'merchant', saleType: 'group' },
    { id: 'unread-large', source: 'customer', saleType: 'community' },
    { id: 'instant', source: 'merchant', saleType: 'instant' },
  ];
  const notifications = buildGroupNotifications(
    deals,
    { 'unread-small': 1, 'unread-large': 4, instant: 9, missing: 7 },
    { 'status-only': 'recruited' },
  );

  assert.deepEqual(notifications.map((item) => [item.deal.id, item.destination]), [
    ['unread-large', 'room'],
    ['unread-small', 'room'],
    ['status-only', 'detail'],
  ]);
});

test('join errors explain quantity conflicts and incomplete merchant room setup', () => {
  assert.match(joinSubmitErrorMessage(new Error('quantity_unavailable')), /최신 수량/);
  assert.match(joinSubmitErrorMessage(new Error('group_not_found')), /그룹 채팅방/);
  assert.match(joinSubmitErrorMessage(new Error('order_sync_pending')), /중복 주문을 막기 위해/);
  assert.match(joinSubmitErrorMessage(new Error('order_sync_failed')), /주문 저장 서버/);
  assert.match(joinSubmitErrorMessage(new Error('collector_busy')), /자동 재시도/);
});

test('주문 영구 거절 후 예약 복구 결과를 사용자에게 명확히 안내한다', () => {
  assert.match(joinSubmitErrorMessage({ reservationRolledBack: true }), /예약 수량을 원래대로 복구/);
  assert.match(joinSubmitErrorMessage({ rollbackError: new Error('network') }), /중복 참여 방지/);
});

test('host claim errors tell non-participants how to recover', () => {
  assert.match(hostApplyErrorMessage(new Error('forbidden')), /먼저.*참여/);
  assert.match(hostApplyErrorMessage(new Error('host_order_required')), /먼저.*참여/);
  assert.match(hostApplyErrorMessage(new Error('host_already_claimed')), /다른 참여자/);
  assert.match(hostApplyErrorMessage(new Error('group_not_found')), /그룹 채팅방/);
});

test('active customer and merchant group purchases can open their room from My Orders', () => {
  const order = { id: 'order-1', type: 'purchase' };
  assert.equal(canOpenOrderGroupRoom({
    order,
    deal: { id: 'customer-1', source: 'customer', saleType: 'community' },
  }), true);
  assert.equal(canOpenOrderGroupRoom({
    order,
    deal: { id: 'merchant-1', source: 'merchant', saleType: 'group' },
  }), true);
  assert.equal(canOpenOrderGroupRoom({
    order: { ...order, groupId: 'unexpected' },
    deal: { id: 'instant-1', source: 'merchant', saleType: 'instant' },
  }), false);
  assert.equal(canOpenOrderGroupRoom({
    order,
    deal: { id: 'merchant-1', source: 'merchant', saleType: 'group' },
    cancelled: true,
  }), false);
});

test('historic grouped orders retain their room linkage after the public product leaves the current list', () => {
  const order = {
    id: 'order-historic-group',
    type: 'purchase',
    dealId: 'historic-group',
    groupId: 'historic-group',
    participantActorId: 'visitor-historic-group',
    deal: {
      id: 'historic-group',
      title: '이전 공동구매',
      store: '이전 매장',
    },
  };
  const linkedDeal = resolveOrderLinkedDeal(order);
  assert.equal(linkedDeal.id, order.dealId);
  assert.equal(linkedDeal.groupId, order.groupId);
  assert.equal(linkedDeal.title, order.deal.title);
  assert.equal(dealHasGroupRoom(linkedDeal), true);
  assert.equal(canOpenOrderGroupRoom({ order, deal: linkedDeal }), true);
});

test('completion only offers chat for deals backed by a group room', () => {
  assert.equal(dealHasGroupRoom({ source: 'merchant', saleType: 'group' }), true);
  assert.equal(dealHasGroupRoom({ source: 'customer', saleType: 'community' }), true);
  assert.equal(dealHasGroupRoom({ source: 'merchant', saleType: 'instant', groupId: 'unexpected' }), false);
});

test('merchant group host state ignores stale legacy browser-only host ids', () => {
  const legacyIds = ['merchant-group'];
  assert.equal(isDealHostMatched({
    id: 'merchant-group',
    source: 'merchant',
    saleType: 'group',
    hostMatched: false,
    hostActorId: '',
  }, legacyIds), false);
  assert.equal(isDealHostMatched({
    id: 'merchant-group',
    source: 'merchant',
    saleType: 'group',
    hostActorId: 'visitor-host',
  }, legacyIds), true);
  assert.equal(isDealHostMatched({
    id: 'merchant-instant',
    source: 'merchant',
    saleType: 'instant',
  }, ['merchant-instant']), true);
});
