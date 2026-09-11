import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDeals, reconcilePublicDealCache } from './dealMerge.js';

for (const source of ['merchant', 'customer']) {
  test(`${source}: first edit uses the published revision even when group activity has an older timestamp`, () => {
    const local = { id: `${source}-stale`, source, title: 'old', publishVersion: 1,
      updatedAt: '2026-09-09T02:00:00Z', version: 1 };
    const remote = { ...local, title: 'latest', publishVersion: 3,
      updatedAt: '2026-09-08T02:00:00Z', syncedAt: '2026-09-09T03:00:00Z', version: 4, targetCount: 8 };
    for (const snapshots of [[local, remote], [remote, local]]) {
      const [merged] = mergeDeals(snapshots);
      assert.equal(merged.publishVersion, 3);
      assert.equal(merged.title, 'latest');
      assert.equal(merged.version, 4);
      assert.equal(merged.targetCount, 8);
    }
  });
}

test('new product content does not revert a newer group version or target', () => {
  const [merged] = mergeDeals([
    { id: 'customer-state', source: 'customer', publishVersion: 4, title: 'new', version: 2, targetCount: 3 },
    { id: 'customer-state', source: 'customer', publishVersion: 3, title: 'old', version: 5, targetCount: 8 },
  ]);
  assert.equal(merged.title, 'new');
  assert.equal(merged.publishVersion, 4);
  assert.equal(merged.version, 5);
  assert.equal(merged.targetCount, 8);
});

test('server merchant progress wins when local and remote deal timestamps tie', () => {
  const updatedAt = '2026-08-27T09:00:00.000Z';
  const local = {
    id: 'owner-server-progress',
    source: 'merchant',
    title: '로컬 상품명',
    updatedAt,
    current: 1,
    currentCount: 1,
    orderedQuantity: 1,
    allocatedProductQuantity: 1,
    participantCount: 1,
  };
  const remote = {
    ...local,
    title: '서버의 오래된 상품명',
    syncedAt: '2026-08-27T09:01:00.000Z',
    current: 4,
    currentCount: 4,
    orderedQuantity: 4,
    allocatedProductQuantity: 4,
    participantCount: 2,
    quantityTracking: true,
  };

  const [merged] = mergeDeals([local], [remote]);
  assert.equal(merged.title, '로컬 상품명');
  assert.equal(merged.orderedQuantity, 4);
  assert.equal(merged.current, 4);
  assert.equal(merged.currentCount, 4);
  assert.equal(merged.participantCount, 2);
});

test('server merchant cancellation progress can decrease stale local totals', () => {
  const local = {
    id: 'owner-server-cancellation',
    source: 'merchant',
    updatedAt: '2026-08-27T09:00:00.000Z',
    current: 5,
    currentCount: 5,
    orderedQuantity: 5,
    allocatedProductQuantity: 5,
    participantCount: 3,
  };
  const remote = {
    ...local,
    syncedAt: '2026-08-27T09:00:30.000Z',
    current: 3,
    currentCount: 3,
    orderedQuantity: 3,
    allocatedProductQuantity: 3,
    participantCount: 2,
  };

  const [merged] = mergeDeals([local], [remote]);
  assert.equal(merged.orderedQuantity, 3);
  assert.equal(merged.current, 3);
  assert.equal(merged.participantCount, 2);
});

test('unsynced merchant snapshots keep the legacy maximum-progress fallback', () => {
  const [merged] = mergeDeals(
    [{ id: 'owner-legacy', source: 'merchant', current: 2, participantCount: 1 }],
    [{ id: 'owner-legacy', source: 'merchant', current: 4, participantCount: 3 }],
  );
  assert.equal(merged.current, 4);
  assert.equal(merged.participantCount, 3);
});

test('newer explicit merchant pricing keeps stock capacity separate from its price divisor', () => {
  const local = {
    id: 'owner-explicit-pricing',
    source: 'merchant',
    saleType: 'group',
    updatedAt: '2026-08-31T09:00:00.000Z',
    totalQuantity: 5,
    productQuantity: 5,
    splitQuantity: 5,
    pricingModel: 'explicit_split',
    pricingVersion: 2,
  };
  const remote = {
    ...local,
    updatedAt: '2026-08-31T09:01:00.000Z',
    syncedAt: '2026-08-31T09:01:01.000Z',
    totalQuantity: 10,
    productQuantity: 10,
    splitQuantity: 1,
    splitPricing: false,
  };

  const [merged] = mergeDeals([local], [remote]);
  assert.equal(merged.totalQuantity, 10);
  assert.equal(merged.productQuantity, 10);
  assert.equal(merged.splitQuantity, 1);
  assert.equal(merged.splitPricing, false);
  assert.equal(merged.pricingModel, 'explicit_split');
  assert.equal(merged.pricingVersion, 2);
});

test('public reconciliation removes only confirmed tombstones and preserves unlisted local history', () => {
  const missing = { id: 'owner-local-beer', title: '맥주 60캔', visibility: 'public' };
  const deleted = { id: 'customer-deleted', title: '중앙 삭제된 그룹', visibility: 'public' };
  const cached = [missing, deleted];
  assert.equal(reconcilePublicDealCache(cached, []), cached);
  const next = reconcilePublicDealCache(cached, [{ id: deleted.id, visibility: 'deleted' }]);
  assert.deepEqual(next, [missing]);
  assert.deepEqual(cached, [missing, deleted], 'reconciliation must not mutate the saved input');
});

test('public reconciliation refreshes a cached image by product revision without importing unrelated records', () => {
  const cached = [{ id: 'owner-image-cache', source: 'merchant', title: '이미지 상품',
    image: 'https://example.test/old.jpg', publishVersion: 1, updatedAt: '2099-01-01T00:00:00Z' }];
  const central = { ...cached[0], image: '/api/public-deals?image=new-image', publishVersion: 2,
    updatedAt: '2026-09-10T00:00:00Z' };
  const next = reconcilePublicDealCache(cached, [central, { id: 'owner-other', title: '다른 사장님 상품' }]);
  assert.equal(next.length, 1);
  assert.equal(next[0].image, central.image);
  assert.equal(next[0].publishVersion, 2);
  assert.equal(reconcilePublicDealCache(next, cached)[0].image, central.image,
    'a stale list read must not undo the cached mutation');
});
