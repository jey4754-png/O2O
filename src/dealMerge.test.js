import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDeals } from './dealMerge.js';

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
