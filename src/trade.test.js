import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_STATES,
  GROUP_STATUS_LABELS,
  MAX_GROUP_PARTICIPANTS,
  MAX_PRODUCT_QUANTITY,
  PAYMENT_STATUS_LABELS,
  PRODUCT_CATEGORIES,
  appendTransitionHistory,
  calculateProductAllocation,
  calculateSplit,
  canTransitionGroupStatus,
  canTransitionPaymentStatus,
  createTransitionHistoryEntry,
  formatGroupQuantityAllocation,
  getNextGroupStatus,
  getPreviousGroupStatus,
  normalizeCategory,
  transitionGroupStatus,
  transitionPaymentStatus,
  validateTargetPeople,
} from './trade.js';

test('PRODUCT_CATEGORIES contains the exact agreed 11 categories', () => {
  assert.deepEqual(PRODUCT_CATEGORIES, [
    '음식·간편식',
    '카페·음료',
    '간식·디저트',
    '식재료',
    '생활·주방용품',
    '세제·위생용품',
    '뷰티·건강',
    '반려동물용품',
    '유아·육아용품',
    '문구·사무용품',
    '기타',
  ]);
});

test('normalizeCategory preserves canonical values and migrates legacy values', () => {
  assert.equal(normalizeCategory('카페·음료'), '카페·음료');
  assert.equal(normalizeCategory(' 카페 / 음료 '), '카페·음료');
  assert.equal(normalizeCategory('식사'), '음식·간편식');
  assert.equal(normalizeCategory('편의점'), '음식·간편식');
  assert.equal(normalizeCategory('장보기/마트'), '식재료');
  assert.equal(normalizeCategory('생활용품'), '생활·주방용품');
  assert.equal(normalizeCategory('알 수 없음'), '기타');
  assert.equal(normalizeCategory('', '문구·사무용품'), '문구·사무용품');
});

test('group status helpers expose labels and adjacent boundaries', () => {
  assert.deepEqual(GROUP_STATES, ['recruiting', 'recruited', 'purchased', 'delivered']);
  assert.equal(GROUP_STATUS_LABELS.recruiting, '모집 중');
  assert.equal(GROUP_STATUS_LABELS.delivered, '전달 완료');
  assert.equal(getNextGroupStatus('recruiting'), 'recruited');
  assert.equal(getNextGroupStatus('delivered'), null);
  assert.equal(getPreviousGroupStatus('delivered'), 'purchased');
  assert.equal(getPreviousGroupStatus('recruiting'), null);
  assert.throws(() => getNextGroupStatus('unknown'), { code: 'INVALID_STATUS' });
});

test('group quantity allocation copy changes after recruitment without hiding unassigned units', () => {
  const quantity = { target: 3, ordered: 1, remaining: 2 };

  assert.equal(formatGroupQuantityAllocation(quantity, 'recruiting'), '남은 제품 2개');
  assert.equal(
    formatGroupQuantityAllocation(quantity, 'recruited'),
    '모집 종료 · 배정 1개 / 총 3개 · 미배정 2개',
  );
  assert.equal(
    formatGroupQuantityAllocation(quantity, 'delivered'),
    '모집 종료 · 배정 1개 / 총 3개 · 미배정 2개',
  );
});

test('only host and admin can move a group by one step in either direction', () => {
  assert.equal(canTransitionGroupStatus('recruiting', 'recruited', 'host'), true);
  assert.equal(canTransitionGroupStatus('recruited', 'recruiting', 'admin'), true);
  assert.equal(canTransitionGroupStatus('recruiting', 'recruited', 'participant'), false);
  assert.equal(canTransitionGroupStatus('recruiting', 'purchased', 'host'), false);

  const result = transitionGroupStatus('purchased', 'recruited', {
    actorRole: 'host',
    actorId: 'host-1',
    timestamp: '2026-08-21T03:00:00.000Z',
    reason: '실수로 구매 완료를 누름',
    history: [],
  });
  assert.equal(result.status, 'recruited');
  assert.deepEqual(result.historyEntry, {
    entityType: 'group',
    fromStatus: 'purchased',
    toStatus: 'recruited',
    direction: 'rollback',
    actorRole: 'host',
    actorId: 'host-1',
    timestamp: '2026-08-21T03:00:00.000Z',
    reason: '실수로 구매 완료를 누름',
  });
  assert.deepEqual(result.history, [result.historyEntry]);
  assert.throws(
    () => transitionGroupStatus('recruiting', 'purchased', { actorRole: 'admin' }),
    { code: 'GROUP_TRANSITION_NOT_ALLOWED' },
  );
});

test('payment transitions enforce participant and manager permissions', () => {
  assert.equal(PAYMENT_STATUS_LABELS.pending, '입금대기');
  assert.equal(PAYMENT_STATUS_LABELS.requested, '입금확인요청');
  assert.equal(PAYMENT_STATUS_LABELS.confirmed, '입금완료');

  assert.equal(canTransitionPaymentStatus('pending', 'requested', 'participant'), true);
  assert.equal(canTransitionPaymentStatus('requested', 'pending', 'participant'), true);
  assert.equal(canTransitionPaymentStatus('requested', 'confirmed', 'participant'), false);
  assert.equal(canTransitionPaymentStatus('requested', 'confirmed', 'host'), true);
  assert.equal(canTransitionPaymentStatus('confirmed', 'requested', 'admin'), true);
  assert.equal(canTransitionPaymentStatus('requested', 'pending', 'host'), false);
  assert.equal(canTransitionPaymentStatus('pending', 'requested', 'host'), false);
  assert.equal(canTransitionPaymentStatus('confirmed', 'pending', 'admin'), false);

  const requested = transitionPaymentStatus('pending', 'requested', {
    actorRole: 'participant',
    actorId: 'user-1',
    timestamp: '2026-08-21T04:00:00.000Z',
  });
  assert.equal(requested.status, 'requested');
  assert.equal(requested.historyEntry.direction, 'forward');

  const reverted = transitionPaymentStatus('confirmed', 'requested', {
    actorRole: 'admin',
    actorId: 'admin-1',
    timestamp: '2026-08-21T04:01:00.000Z',
    history: requested.history,
  });
  assert.equal(reverted.status, 'requested');
  assert.equal(reverted.history.length, 2);
  assert.equal(reverted.historyEntry.direction, 'rollback');

  assert.throws(
    () => transitionPaymentStatus('requested', 'confirmed', { actorRole: 'participant' }),
    { code: 'PAYMENT_TRANSITION_NOT_ALLOWED' },
  );
});

test('history helpers append immutable before/after records', () => {
  const initialHistory = [{ fromStatus: 'legacy', toStatus: 'pending' }];
  const entry = createTransitionHistoryEntry({
    entityType: 'payment',
    fromStatus: 'requested',
    toStatus: 'pending',
    actorRole: 'participant',
    actorId: 'user-1',
    timestamp: new Date('2026-08-21T05:00:00.000Z'),
  });
  const nextHistory = appendTransitionHistory(initialHistory, entry);
  assert.equal(initialHistory.length, 1);
  assert.equal(nextHistory.length, 2);
  assert.equal(entry.fromStatus, 'requested');
  assert.equal(entry.toStatus, 'pending');
  assert.equal(entry.timestamp, '2026-08-21T05:00:00.000Z');
});

test('calculateSplit floors the per-person amount and never exceeds the total', () => {
  assert.deepEqual(calculateSplit(39000, 3, 1), {
    total: 39000,
    people: 3,
    current: 1,
    perPerson: 13000,
    hostAmount: 13000,
    allocated: 39000,
    approximate: false,
    remainder: 0,
    savings: 26000,
    remaining: 2,
  });

  const uneven = calculateSplit(10000, 3, 1);
  assert.equal(uneven.perPerson, 3333);
  assert.equal(uneven.hostAmount, 3334);
  assert.equal(uneven.approximate, true);
  assert.equal(uneven.remainder, 1);
  assert.equal(uneven.savings, 6667);
  assert.equal(uneven.remaining, 2);
  assert.ok(uneven.allocated <= uneven.total);
  assert.equal(uneven.hostAmount + uneven.perPerson * (uneven.people - 1), uneven.total);
  const clientExample = calculateSplit(50000, 3, 1);
  assert.equal(clientExample.perPerson, 16666);
  assert.equal(clientExample.hostAmount, 16668);
  assert.equal(clientExample.hostAmount + clientExample.perPerson * 2, 50000);
  assert.equal(calculateSplit(10000, 3, 5).remaining, 0);
  assert.equal(calculateSplit(0, 1).perPerson, 0);
});

test('calculateSplit rejects invalid numeric boundaries', () => {
  assert.throws(() => calculateSplit(-1, 3), /non-negative integer/);
  assert.throws(() => calculateSplit(10000.5, 3), /non-negative integer/);
  assert.throws(() => calculateSplit(10000, 0), /between 1 and 20/);
  assert.throws(() => calculateSplit(10000, MAX_GROUP_PARTICIPANTS + 1), /between 1 and 20/);
  assert.throws(() => calculateSplit(10000, 3.5), /between 1 and 20/);
  assert.throws(() => calculateSplit(10000, 3, -1), /between 0 and 20/);
});

test('calculateProductAllocation shows unit, selected, remaining, and host remainder amounts', () => {
  assert.deepEqual(calculateProductAllocation(41500, 7, 3), {
    total: 41500,
    productQuantity: 7,
    selectedQuantity: 3,
    unitPrice: 5928,
    allocated: 41496,
    approximate: true,
    remainder: 4,
    selectedAmount: 17784,
    hostSelectedAmount: 17788,
    remainingQuantity: 4,
  });
  const even = calculateProductAllocation(39000, 3, 1);
  assert.equal(even.unitPrice, 13000);
  assert.equal(even.hostSelectedAmount, 13000);
  assert.equal(even.remainingQuantity, 2);

  const merchantBundle = calculateProductAllocation(55800, 20, 2);
  assert.equal(merchantBundle.unitPrice, 2790);
  assert.equal(merchantBundle.selectedAmount, 5580);
  assert.equal(merchantBundle.hostSelectedAmount, 5580);
  assert.equal(merchantBundle.remainingQuantity, 18);
  assert.equal(merchantBundle.allocated, 55800);
});

test('calculateProductAllocation rejects invalid quantities', () => {
  assert.throws(() => calculateProductAllocation(-1, 7, 1), /non-negative integer/);
  assert.throws(() => calculateProductAllocation(41500, 0, 0), /between 1/);
  assert.throws(() => calculateProductAllocation(41500, MAX_PRODUCT_QUANTITY + 1, 1), /between 1/);
  assert.throws(() => calculateProductAllocation(41500, 7, 8), /within the total/);
  assert.throws(() => calculateProductAllocation(41500, 7, 1.5), /within the total/);
});

test('target validation enforces max 20, current count, and post-purchase lock', () => {
  assert.deepEqual(validateTargetPeople(20, { current: 20, groupStatus: 'recruited' }), {
    valid: true,
    target: 20,
    current: 20,
    max: 20,
  });
  assert.equal(validateTargetPeople(21).code, 'TARGET_OUT_OF_RANGE');
  assert.equal(validateTargetPeople(0).code, 'TARGET_OUT_OF_RANGE');
  assert.equal(validateTargetPeople(3.5).code, 'TARGET_OUT_OF_RANGE');
  assert.equal(validateTargetPeople(2, { current: 3 }).code, 'TARGET_BELOW_CURRENT');
  assert.equal(validateTargetPeople(3, { current: 3 }).valid, true);
  assert.equal(validateTargetPeople(5, { current: 3, groupStatus: 'purchased' }).code, 'TARGET_LOCKED');
  assert.equal(validateTargetPeople(5, { current: 3, groupStatus: 'delivered' }).code, 'TARGET_LOCKED');
  assert.equal(validateTargetPeople(5, { current: 3, groupStatus: 'recruited' }).valid, true);
  assert.equal(validateTargetPeople(5, { current: 21 }).code, 'INVALID_CURRENT_COUNT');
  assert.equal(validateTargetPeople(5, { groupStatus: 'unknown' }).code, 'INVALID_GROUP_STATUS');
});
