import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalOrderVersion,
  mergeCompletedCustomerOrderSync,
  mergeAuthoritativeOwnerOrders,
  mergeAuthoritativeCustomerOrderRefresh,
  mergeCustomerOrderCollections,
  mergeOwnerOrderRefresh,
  ownerOrderBelongsToWorkspace,
  summarizeOwnerOrderDisplay,
} from './orderMerge.js';

test('successful customer publish remains visible when the follow-up history read fails', () => {
  const local = {
    id: 'order-customer-publish-fallback',
    createdAt: '2026-09-09T00:00:00.000Z',
    version: 1,
    paymentStatus: 'pending',
    deal: { id: 'customer-publish-fallback', image: 'local-image' },
  };
  const published = {
    ...local,
    version: 2,
    syncedAt: '2026-09-09T00:01:00.000Z',
    paymentStatus: 'requested',
    deal: { id: local.deal.id, store: 'server-store' },
  };

  const [withoutHistory] = mergeCompletedCustomerOrderSync([local], [published], []);
  assert.equal(withoutHistory.version, 2);
  assert.equal(withoutHistory.paymentStatus, 'requested');
  assert.equal(withoutHistory.deal.image, 'local-image');
  assert.equal(withoutHistory.deal.store, 'server-store');

  const [withStaleHistory] = mergeCompletedCustomerOrderSync(
    [local],
    [published],
    [{ ...published, version: 1, paymentStatus: 'pending' }],
  );
  assert.equal(withStaleHistory.version, 2);
  assert.equal(withStaleHistory.paymentStatus, 'requested');
});

test('canonical order version uses the highest valid alias', () => {
  assert.equal(canonicalOrderVersion({ version: 3, paymentVersion: 5 }), 5);
  assert.equal(canonicalOrderVersion({ version: 7, paymentVersion: 4 }), 7);
  assert.equal(canonicalOrderVersion({ version: -1, paymentVersion: 'invalid' }), 0);
});

test('customer order refresh cannot regress a higher server version because of a future local clock', () => {
  const staleLocal = {
    id: 'order-customer-refresh',
    createdAt: '2026-09-01T09:00:00.000Z',
    statusUpdatedAt: '2099-09-01T09:00:00.000Z',
    version: 1,
    paymentVersion: 1,
    paymentStatus: 'pending',
    deal: { id: 'owner-customer-refresh', image: 'local-image' },
  };
  const authoritativeServer = {
    ...staleLocal,
    statusUpdatedAt: '2026-09-01T09:01:00.000Z',
    version: 2,
    paymentVersion: 3,
    paymentStatus: 'confirmed',
    deal: { id: 'owner-customer-refresh', store: 'server-store' },
  };

  const [merged] = mergeCustomerOrderCollections([staleLocal], [authoritativeServer]);
  assert.equal(merged.paymentStatus, 'confirmed');
  assert.equal(canonicalOrderVersion(merged), 3);
  assert.equal(merged.deal.image, 'local-image');
  assert.equal(merged.deal.store, 'server-store');
});

test('customer order refresh uses timestamps only when CAS versions tie', () => {
  const current = {
    id: 'order-customer-timestamp',
    createdAt: '2026-09-01T09:00:00.000Z',
    statusUpdatedAt: '2026-09-01T09:02:00.000Z',
    version: 2,
    paymentVersion: 2,
    paymentStatus: 'requested',
  };
  const older = { ...current, statusUpdatedAt: '2026-09-01T09:01:00.000Z', paymentStatus: 'pending' };
  const newer = { ...current, statusUpdatedAt: '2026-09-01T09:03:00.000Z', paymentStatus: 'confirmed' };

  assert.equal(mergeCustomerOrderCollections([current], [older])[0].paymentStatus, 'requested');
  assert.equal(mergeCustomerOrderCollections([current], [newer])[0].paymentStatus, 'confirmed');
});

test('completed central customer refresh wins a tied future-clock local cache', () => {
  const local = {
    id: 'order-customer-central-projection',
    createdAt: '2026-09-01T09:00:00.000Z',
    statusUpdatedAt: '2099-09-01T09:00:00.000Z',
    version: 1,
    paymentVersion: 1,
    paymentStatus: 'pending',
    deal: { id: 'customer-central-projection', image: 'local-image' },
  };
  const central = {
    ...local,
    statusUpdatedAt: '2026-09-01T09:05:00.000Z',
    paymentStatus: 'confirmed',
    deal: { id: 'customer-central-projection', store: 'central-store' },
  };

  const [merged] = mergeAuthoritativeCustomerOrderRefresh([local], [central]);
  assert.equal(merged.paymentStatus, 'confirmed');
  assert.equal(merged.deal.image, 'local-image');
  assert.equal(merged.deal.store, 'central-store');
});

test('central customer refresh preserves a genuinely higher local CAS version and local-only orders', () => {
  const local = {
    id: 'order-customer-newer-local', createdAt: '2026-09-01T09:00:00.000Z',
    version: 4, paymentVersion: 4, paymentStatus: 'confirmed',
  };
  const localOnly = {
    id: 'order-customer-local-only', createdAt: '2026-09-01T09:01:00.000Z',
    version: 1, paymentStatus: 'pending',
  };
  const staleCentral = { ...local, version: 3, paymentVersion: 3, paymentStatus: 'requested' };

  const merged = mergeAuthoritativeCustomerOrderRefresh([local, localOnly], [staleCentral]);
  assert.equal(merged.find((order) => order.id === local.id).paymentStatus, 'confirmed');
  assert.equal(merged.find((order) => order.id === localOnly.id).paymentStatus, 'pending');
});

test('adopted central reads replace or clear stale payment projection hints at equal and higher versions', () => {
  const local = { id: 'order-customer-repair-hint', version: 3,
    paymentSyncStatus: 'repair_required', paymentStatus: 'pending' };
  for (const version of [3, 4]) {
    for (const hint of [undefined, 'repair_required', 'verified_history']) {
      const central = { id: local.id, version, paymentStatus: 'confirmed',
        ...(hint ? { paymentSyncStatus: hint } : {}) };
      const [merged] = mergeAuthoritativeCustomerOrderRefresh([local], [central]);
      assert.equal(merged.paymentSyncStatus, hint);
      assert.equal(Object.hasOwn(merged, 'paymentSyncStatus'), Boolean(hint));
      assert.equal(merged.paymentStatus, 'confirmed');
      assert.equal(local.paymentSyncStatus, 'repair_required', 'merge does not mutate the local snapshot');
    }
  }
  const [kept] = mergeAuthoritativeCustomerOrderRefresh([local], [{
    id: local.id, version: 2, paymentSyncStatus: 'verified_history', paymentStatus: 'confirmed',
  }]);
  assert.equal(kept.paymentSyncStatus, 'repair_required');
  assert.equal(kept.paymentStatus, 'pending');
});

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

test('server-authorized orders remain manageable after their product is soft-deleted', () => {
  const deletedDealOrder = { id: 'order-soft-deleted-deal', dealId: 'owner-soft-deleted-deal' };
  const unrelatedLocalOrder = { id: 'order-unrelated-local', dealId: 'owner-unrelated-local' };
  const activeLocalOrder = { id: 'order-active-local', dealId: 'owner-active-deal' };
  const ownerDealIds = new Set(['owner-active-deal']);
  const authoritativeOwnerOrderIds = new Set([deletedDealOrder.id]);

  assert.equal(
    ownerOrderBelongsToWorkspace(deletedDealOrder, ownerDealIds, authoritativeOwnerOrderIds),
    true,
  );
  assert.equal(
    ownerOrderBelongsToWorkspace(activeLocalOrder, ownerDealIds, authoritativeOwnerOrderIds),
    true,
  );
  assert.equal(
    ownerOrderBelongsToWorkspace(unrelatedLocalOrder, ownerDealIds, authoritativeOwnerOrderIds),
    false,
  );
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

test('an older in-flight owner refresh cannot regress a completed state transition', () => {
  const previous = {
    id: 'order-versioned-refresh',
    createdAt: '2026-08-31T09:00:00.000Z',
    statusUpdatedAt: '2026-08-31T09:03:00.000Z',
    version: 3,
    paymentStatus: 'confirmed',
    deal: { id: 'owner-versioned-refresh' },
  };
  const staleRefresh = {
    ...previous,
    statusUpdatedAt: '2026-08-31T09:04:00.000Z',
    version: 2,
    paymentStatus: 'requested',
    deal: { id: 'owner-versioned-refresh', store: '새 매장명' },
  };

  const [merged] = mergeOwnerOrderRefresh([previous], [staleRefresh]);
  assert.equal(merged.version, 3);
  assert.equal(merged.paymentStatus, 'confirmed');
  assert.equal(merged.deal.store, '새 매장명');
});

test('a same-version refresh uses the newest authoritative state timestamp', () => {
  const previous = {
    id: 'order-timestamped-refresh',
    createdAt: '2026-08-31T09:00:00.000Z',
    statusUpdatedAt: '2026-08-31T09:05:00.000Z',
    version: 2,
    paymentStatus: 'requested',
  };
  const olderRefresh = {
    ...previous,
    statusUpdatedAt: '2026-08-31T09:04:00.000Z',
    paymentStatus: 'pending',
  };
  const newerRefresh = {
    ...previous,
    statusUpdatedAt: '2026-08-31T09:06:00.000Z',
    paymentStatus: 'confirmed',
  };

  assert.equal(
    mergeOwnerOrderRefresh([previous], [olderRefresh])[0].paymentStatus,
    'requested',
  );
  assert.equal(
    mergeOwnerOrderRefresh([previous], [newerRefresh])[0].paymentStatus,
    'confirmed',
  );
});

test('a higher-version owner refresh wins even when its timestamp is older', () => {
  const previous = {
    id: 'order-higher-version-refresh',
    createdAt: '2026-08-31T09:00:00.000Z',
    statusUpdatedAt: '2026-08-31T09:10:00.000Z',
    version: 2,
    paymentStatus: 'requested',
  };
  const refreshed = {
    ...previous,
    statusUpdatedAt: '2026-08-31T09:09:00.000Z',
    version: 3,
    paymentStatus: 'confirmed',
  };

  const [merged] = mergeOwnerOrderRefresh([previous], [refreshed]);
  assert.equal(merged.version, 3);
  assert.equal(merged.paymentStatus, 'confirmed');
});

test('owner refresh compares the highest valid version alias', () => {
  const previous = {
    id: 'order-version-alias-refresh',
    createdAt: '2026-08-31T09:00:00.000Z',
    statusUpdatedAt: '2026-08-31T09:00:00.000Z',
    version: 3,
    paymentVersion: 5,
    paymentStatus: 'confirmed',
  };
  const staleRefresh = {
    ...previous,
    statusUpdatedAt: '2026-08-31T09:10:00.000Z',
    version: 4,
    paymentVersion: 4,
    paymentStatus: 'requested',
  };

  const [merged] = mergeOwnerOrderRefresh([previous], [staleRefresh]);
  assert.equal(merged.paymentStatus, 'confirmed');
  assert.equal(merged.version, 3);
  assert.equal(merged.paymentVersion, 5);
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
