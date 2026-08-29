import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMerchantParticipationCancellation,
  canCancelParticipation,
  cancelledOrderSnapshot,
  isCancelledOrder,
} from './participation.js';

const order = {
  id: 'order-1234567890123',
  type: 'purchase',
  status: 'new',
  paymentStatus: 'pending',
  visitorId: 'visitor-1',
  selectedCount: 2,
  quantity: 2,
  total: 5580,
  version: 1,
};

test('participation cancellation is limited to recruiting, unpaid member orders', () => {
  assert.equal(canCancelParticipation(order, { source: 'customer', groupStatus: 'recruiting' }, 'member'), true);
  assert.equal(canCancelParticipation(order, { source: 'customer', groupStatus: 'recruited' }, 'member'), false);
  assert.equal(canCancelParticipation(order, { source: 'customer', groupStatus: 'recruiting' }, 'host'), false);
  assert.equal(canCancelParticipation({ ...order, groupId: 'owner-bound-group' }, { source: 'merchant', saleType: 'group' }, 'host'), false);
  assert.equal(canCancelParticipation({ ...order, groupId: 'owner-bound-group' }, { source: 'merchant', saleType: 'group' }, 'member'), true);
  assert.equal(canCancelParticipation({ ...order, paymentStatus: 'requested' }, { source: 'merchant', saleType: 'group' }), false);
  assert.equal(canCancelParticipation(order, { source: 'merchant', saleType: 'instant' }), false);
});

test('cancelled order keeps the original quantity and amount as an audit record', () => {
  const cancelled = cancelledOrderSnapshot(order, {
    timestamp: '2026-08-27T12:00:00.000Z',
    clientMutationId: 'cancel-test-1234',
  });
  assert.equal(isCancelledOrder(cancelled), true);
  assert.equal(cancelled.selectedCount, 2);
  assert.equal(cancelled.total, 5580);
  assert.equal(cancelled.version, 2);
  assert.equal(cancelled.statusHistory.at(-1).action, 'cancel_participation');
});

test('merchant cancellation restores quantity and only removes the last visitor once', () => {
  const deal = {
    totalQuantity: 20,
    orderedQuantity: 7,
    current: 7,
    participantCount: 3,
  };
  const lastOrder = applyMerchantParticipationCancellation(deal, order, false);
  assert.equal(lastOrder.orderedQuantity, 5);
  assert.equal(lastOrder.current, 5);
  assert.equal(lastOrder.participantCount, 2);

  const oneOfMany = applyMerchantParticipationCancellation(deal, order, true);
  assert.equal(oneOfMany.orderedQuantity, 5);
  assert.equal(oneOfMany.participantCount, 3);
});
