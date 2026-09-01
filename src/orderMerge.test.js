import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeAuthoritativeOwnerOrders,
  mergeOwnerOrderRefresh,
  summarizeOwnerOrderDisplay,
} from './orderMerge.js';

test('owner server payment request wins over a newer local pending snapshot', () => {
  const local = {
    id: 'order-1234567890601',
    createdAt: '2026-08-31T09:00:00.000Z',
    statusUpdatedAt: '2026-08-31T09:10:00.000Z',
    paymentStatus: 'pending',
    title: '로컬 주문명',
    deal: { id: 'owner-payment-merge', image: 'local-image' },
  };
  const owner = {
    id: local.id,
    createdAt: local.createdAt,
    statusUpdatedAt: '2026-08-31T09:05:00.000Z',
    paymentStatus: 'requested',
    paymentRequestedAt: '2026-08-31T09:05:00.000Z',
    title: '서버 주문명',
    deal: { id: 'owner-payment-merge', store: '서버 매장' },
  };

  const [merged] = mergeAuthoritativeOwnerOrders([owner], [local]);
  assert.equal(merged.paymentStatus, 'requested');
  assert.equal(merged.paymentRequestedAt, owner.paymentRequestedAt);
  assert.equal(merged.title, '서버 주문명');
  assert.equal(merged.deal.image, 'local-image');
  assert.equal(merged.deal.store, '서버 매장');
});

test('owner server confirmation remains distinct for each order', () => {
  const localOrders = [
    {
      id: 'order-1234567890602',
      createdAt: '2026-08-31T09:02:00.000Z',
      paymentStatus: 'pending',
    },
    {
      id: 'order-1234567890603',
      createdAt: '2026-08-31T09:03:00.000Z',
      paymentStatus: 'pending',
    },
  ];
  const ownerOrders = [
    { ...localOrders[0], paymentStatus: 'requested' },
    { ...localOrders[1], paymentStatus: 'confirmed', paymentConfirmedAt: '2026-08-31T09:04:00.000Z' },
  ];

  const merged = mergeAuthoritativeOwnerOrders(ownerOrders, localOrders);
  const byId = new Map(merged.map((order) => [order.id, order]));
  assert.equal(byId.get(localOrders[0].id).paymentStatus, 'requested');
  assert.equal(byId.get(localOrders[1].id).paymentStatus, 'confirmed');
  assert.equal(byId.get(localOrders[1].id).paymentConfirmedAt, '2026-08-31T09:04:00.000Z');
});

test('local orders absent from the owner response remain as a fallback', () => {
  const localOnly = {
    id: 'order-1234567890604',
    createdAt: '2026-08-31T09:04:00.000Z',
    paymentStatus: 'pending',
  };
  const serverOnly = {
    id: 'order-1234567890605',
    createdAt: '2026-08-31T09:05:00.000Z',
    paymentStatus: 'requested',
  };

  const merged = mergeAuthoritativeOwnerOrders([serverOnly], [localOnly]);
  assert.deepEqual(merged.map((order) => order.id), [serverOnly.id, localOnly.id]);
  assert.equal(merged.find((order) => order.id === localOnly.id).paymentStatus, 'pending');
});

test('partial owner refresh preserves earlier server orders while updating returned IDs', () => {
  const previousOrders = [
    {
      id: 'order-existing-one',
      createdAt: '2026-08-31T09:01:00.000Z',
      paymentStatus: 'pending',
    },
    {
      id: 'order-existing-two',
      createdAt: '2026-08-31T09:02:00.000Z',
      paymentStatus: 'requested',
    },
  ];
  const refreshedOrders = [
    { ...previousOrders[0], paymentStatus: 'confirmed' },
  ];

  const merged = mergeOwnerOrderRefresh(previousOrders, refreshedOrders);
  const byId = new Map(merged.map((order) => [order.id, order]));

  assert.equal(merged.length, 2);
  assert.equal(byId.get('order-existing-one').paymentStatus, 'confirmed');
  assert.equal(byId.get('order-existing-two').paymentStatus, 'requested');
});

test('merge does not mutate server or local order snapshots', () => {
  const local = {
    id: 'order-1234567890606',
    createdAt: '2026-08-31T09:06:00.000Z',
    paymentStatus: 'pending',
    deal: { id: 'owner-immutable-order', image: 'local-image' },
  };
  const owner = {
    ...local,
    paymentStatus: 'confirmed',
    deal: { id: 'owner-immutable-order', store: '서버 매장' },
  };
  const localBefore = structuredClone(local);
  const ownerBefore = structuredClone(owner);

  mergeAuthoritativeOwnerOrders([owner], [local]);

  assert.deepEqual(local, localBefore);
  assert.deepEqual(owner, ownerBefore);
});

test('aggregate sync placeholders do not inflate the displayed order count', () => {
  const metrics = summarizeOwnerOrderDisplay(
    [
      { id: 'order-one' },
      { id: 'order-two', status: 'cancelled', paymentStatus: 'cancelled' },
    ],
    [
      { deal: { id: 'owner-one' }, pendingQuantity: 4 },
      { deal: { id: 'owner-two' }, pendingQuantity: 3 },
    ],
  );

  assert.equal(metrics.detailedOrderCount, 2);
  assert.equal(metrics.activeOrderCount, 1);
  assert.equal(metrics.cancelledOrderCount, 1);
  assert.equal(metrics.pendingDetailQuantity, 7);
});
