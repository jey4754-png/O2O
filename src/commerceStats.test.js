import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommerceStats } from './commerceStats.js';

test('cancelled purchases remain visible but are excluded from active commerce KPIs', () => {
  const stats = buildCommerceStats([
    {
      id: 'active-order',
      type: 'purchase',
      title: '활성 주문',
      status: 'completed',
      paymentStatus: 'confirmed',
      paymentConfirmedAt: '2026-08-27T10:00:00.000Z',
      customerPickupConfirmedAt: '2026-08-27T10:30:00.000Z',
      total: 5580,
      createdAt: '2026-08-27T09:00:00.000Z',
    },
    {
      id: 'cancelled-order',
      type: 'purchase',
      title: '취소 주문',
      status: 'cancelled',
      paymentStatus: 'cancelled',
      total: 11160,
      createdAt: '2026-08-27T09:30:00.000Z',
    },
  ]);

  assert.equal(stats.rows.length, 2);
  assert.equal(stats.rows[0].cancelled, true);
  assert.equal(stats.rows[0].ownerStatus, '참여 취소');
  assert.equal(stats.orderCount, 1);
  assert.equal(stats.cancelledCount, 1);
  assert.equal(stats.verifiedCount, 1);
  assert.equal(stats.candidateAmount, 5580);
  assert.equal(stats.verifiedAmount, 5580);
});

test('payment-cancelled orders are also excluded even with stale completion timestamps', () => {
  const stats = buildCommerceStats([{
    id: 'payment-cancelled-order',
    type: 'purchase',
    title: '입금 취소 주문',
    status: 'completed',
    paymentStatus: 'cancelled',
    paymentConfirmedAt: '2026-08-27T10:00:00.000Z',
    customerPickupConfirmedAt: '2026-08-27T10:30:00.000Z',
    total: 9000,
    createdAt: '2026-08-27T09:00:00.000Z',
  }]);

  assert.equal(stats.rows[0].ownerStatus, '참여 취소');
  assert.equal(stats.rows[0].verified, false);
  assert.equal(stats.paymentConfirmedCount, 0);
  assert.equal(stats.ownerCompletedCount, 0);
  assert.equal(stats.candidateAmount, 0);
});
