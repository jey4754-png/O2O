import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canOpenOrderGroupRoom,
  dealHasGroupRoom,
  hostApplyErrorMessage,
  isDealHostMatched,
  joinSubmitErrorMessage,
} from './customerUi.js';

test('join errors explain quantity conflicts and incomplete merchant room setup', () => {
  assert.match(joinSubmitErrorMessage(new Error('quantity_unavailable')), /최신 수량/);
  assert.match(joinSubmitErrorMessage(new Error('group_not_found')), /그룹 채팅방/);
  assert.match(joinSubmitErrorMessage(new Error('order_sync_failed')), /주문 저장 서버/);
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
