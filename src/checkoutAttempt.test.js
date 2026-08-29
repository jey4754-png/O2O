import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginCheckoutAttempt,
  checkoutNeedsDurableOrderSync,
  checkoutAttemptStorageKey,
  completeCheckoutAttempt,
} from './checkoutAttempt.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

const checkout = {
  actorId: 'visitor-checkout-retry',
  dealId: 'owner-checkout-retry',
  groupId: 'owner-checkout-retry',
  type: 'purchase',
  selectedCount: 2,
  total: 12000,
  clientMutationId: 'checkout-retry-mutation-1234',
};

test('checkout retry reuses the original order id, timestamp, and reservation mutation', () => {
  const storage = memoryStorage();
  const first = beginCheckoutAttempt(checkout, {
    storage,
    nowMs: 1_700_000_000_000,
    randomValue: 123,
  });
  const retry = beginCheckoutAttempt({
    ...checkout,
    clientMutationId: 'checkout-new-page-mutation-5678',
  }, {
    storage,
    nowMs: 1_700_000_005_000,
    randomValue: 999,
  });

  assert.equal(retry.orderId, first.orderId);
  assert.equal(retry.createdAt, first.createdAt);
  assert.equal(retry.reservationMutationId, checkout.clientMutationId);
  assert.match(first.orderId, /^order-\d{10,20}$/);
});

test('quantity or total changes create a separate checkout identity', () => {
  const storage = memoryStorage();
  const first = beginCheckoutAttempt(checkout, {
    storage,
    nowMs: 1_700_000_000_000,
    randomValue: 123,
  });
  const changed = beginCheckoutAttempt({
    ...checkout,
    selectedCount: 3,
    total: 18000,
    clientMutationId: 'checkout-changed-mutation-9012',
  }, {
    storage,
    nowMs: 1_700_000_001_000,
    randomValue: 456,
  });

  assert.notEqual(changed.orderId, first.orderId);
  assert.equal(changed.reservationMutationId, 'checkout-changed-mutation-9012');
});

test('successful checkout clears only its pending retry identity', () => {
  const storage = memoryStorage();
  const first = beginCheckoutAttempt(checkout, {
    storage,
    nowMs: 1_700_000_000_000,
    randomValue: 123,
  });
  beginCheckoutAttempt({
    ...checkout,
    dealId: 'owner-other-deal',
    groupId: 'owner-other-deal',
  }, {
    storage,
    nowMs: 1_700_000_001_000,
    randomValue: 456,
  });

  assert.equal(completeCheckoutAttempt(first.orderId, { storage }), true);
  const remaining = JSON.parse(storage.getItem(checkoutAttemptStorageKey));
  assert.equal(Object.values(remaining).some((attempt) => attempt.orderId === first.orderId), false);
  assert.equal(Object.keys(remaining).length, 1);
});

test('checkout identity remains stable in memory when browser storage rejects writes', () => {
  const storage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('quota_exceeded');
    },
  };
  const first = beginCheckoutAttempt(checkout, {
    storage,
    nowMs: 1_700_000_000_000,
    randomValue: 123,
  });
  const retry = beginCheckoutAttempt(checkout, {
    storage,
    nowMs: 1_700_000_001_000,
    randomValue: 456,
  });

  assert.equal(retry.orderId, first.orderId);
  assert.equal(retry.reservationMutationId, first.reservationMutationId);
});

test('group reservations are completed only after their durable order sync path', () => {
  assert.equal(checkoutNeedsDurableOrderSync({
    type: 'purchase',
    deal: { source: 'customer', id: 'customer-group' },
  }), true);
  assert.equal(checkoutNeedsDurableOrderSync({
    type: 'purchase',
    deal: { source: 'merchant', saleType: 'group', id: 'merchant-group' },
  }), true);
  assert.equal(checkoutNeedsDurableOrderSync({
    type: 'purchase',
    groupId: 'explicit-group',
    deal: { source: 'unknown' },
  }), true);
  assert.equal(checkoutNeedsDurableOrderSync({
    type: 'group',
    deal: { source: 'customer' },
  }), false);
});
