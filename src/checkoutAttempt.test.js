import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginCheckoutAttempt,
  canQueueReservedGroupOrder,
  checkoutNeedsDurableOrderSync,
  checkoutAttemptStorageKey,
  completeCheckoutAttempt,
  isTerminalOrderSyncError,
  isTransientOrderSyncError,
  hasUnfinishedGroupCheckout,
  listRecoverableCheckoutAttempts,
  orderPublishRetryCount,
  publishCustomerOrderRequest,
  releaseCheckoutAttempt,
  updateCheckoutAttempt,
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

test('payment preflight sees active and interrupted reservations but not prepared or other-account attempts', () => {
  const storage = memoryStorage();
  const nowMs = 1_700_000_000_000;
  const options = { storage, nowMs };
  const attempt = beginCheckoutAttempt(checkout, { ...options, randomValue: 871 });
  assert.equal(hasUnfinishedGroupCheckout(checkout.groupId, checkout.actorId, options), false);
  updateCheckoutAttempt(attempt.orderId, { stage: 'reserving' }, options);
  assert.equal(listRecoverableCheckoutAttempts(options).length, 0, 'the active reservation is absent from the recovery list');
  assert.equal(hasUnfinishedGroupCheckout(checkout.groupId, checkout.actorId, options), true);
  assert.equal(hasUnfinishedGroupCheckout('another-group', checkout.actorId, options), false);
  assert.equal(hasUnfinishedGroupCheckout(checkout.groupId, 'another-actor', options), false);
  releaseCheckoutAttempt(attempt.orderId);
  assert.equal(hasUnfinishedGroupCheckout(checkout.groupId, checkout.actorId, { ...options, nowMs: nowMs + 2 * 86400000 }), true,
    'an old side effect cannot expire into permission to close its unpaid reservation');
  completeCheckoutAttempt(attempt.orderId, options);
  assert.equal(hasUnfinishedGroupCheckout(checkout.groupId, checkout.actorId, options), false);
});

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

test('예약 중 중단된 checkout은 복구 대상으로 남고 다른 수량의 이중 예약을 차단한다', () => {
  const storage = memoryStorage();
  const first = beginCheckoutAttempt({
    ...checkout,
    nickname: '복구 참여자',
    reservationAction: 'join',
  }, {
    storage,
    nowMs: 1_700_000_000_000,
    randomValue: 123,
  });
  updateCheckoutAttempt(first.orderId, {
    stage: 'reserved',
    reservationAction: 'join',
    reservationQuantity: 2,
  }, { storage, nowMs: 1_700_000_001_000 });

  assert.deepEqual(listRecoverableCheckoutAttempts({ storage, nowMs: 1_700_000_002_000 }), []);
  releaseCheckoutAttempt(first.orderId);
  const recoverable = listRecoverableCheckoutAttempts({ storage, nowMs: 1_700_000_002_000 });
  assert.equal(recoverable.length, 1);
  assert.equal(recoverable[0].reservationMutationId, checkout.clientMutationId);
  assert.equal(recoverable[0].reservationQuantity, 2);
  assert.equal(recoverable[0].nickname, '복구 참여자');

  assert.throws(() => beginCheckoutAttempt({
    ...checkout,
    selectedCount: 1,
    total: 6000,
    clientMutationId: 'checkout-conflicting-mutation-5678',
  }, {
    storage,
    nowMs: 1_700_000_003_000,
    randomValue: 456,
  }), /checkout_recovery_pending/);

  assert.equal(completeCheckoutAttempt(first.orderId, { storage }), true);
  assert.deepEqual(listRecoverableCheckoutAttempts({ storage, nowMs: 1_700_000_004_000 }), []);
});

test('중앙 부작용 단계 checkout은 24시간 이후에도 복구되고 같은 그룹의 신규 checkout을 차단한다', () => {
  const storage = memoryStorage();
  const startedAt = 1_700_100_000_000;
  const first = beginCheckoutAttempt({
    ...checkout,
    nickname: '장기 복구 참여자',
    reservationAction: 'join',
  }, {
    storage,
    nowMs: startedAt,
    randomValue: 321,
  });
  updateCheckoutAttempt(first.orderId, {
    stage: 'reserved',
    reservationAction: 'join',
    reservationQuantity: 2,
  }, { storage, nowMs: startedAt + 1_000 });
  releaseCheckoutAttempt(first.orderId);

  const after25Hours = listRecoverableCheckoutAttempts({
    storage,
    nowMs: startedAt + (25 * 60 * 60 * 1_000),
  });
  assert.equal(after25Hours.length, 1);
  assert.equal(after25Hours[0].orderId, first.orderId);

  const after180Days = listRecoverableCheckoutAttempts({
    storage,
    nowMs: startedAt + (180 * 24 * 60 * 60 * 1_000),
  });
  assert.equal(after180Days.length, 1);
  assert.equal(after180Days[0].reservationMutationId, checkout.clientMutationId);

  assert.throws(() => beginCheckoutAttempt({
    ...checkout,
    selectedCount: 1,
    total: 6000,
    clientMutationId: 'checkout-long-lived-conflict-5678',
  }, {
    storage,
    nowMs: startedAt + (180 * 24 * 60 * 60 * 1_000),
    randomValue: 654,
  }), /checkout_recovery_pending/);

  const stored = Object.values(JSON.parse(storage.getItem(checkoutAttemptStorageKey)));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].orderId, first.orderId);
});

test('부작용이 없는 prepared checkout만 24시간 이후 자동 정리한다', () => {
  const storage = memoryStorage();
  const startedAt = 1_700_200_000_000;
  const first = beginCheckoutAttempt(checkout, {
    storage,
    nowMs: startedAt,
    randomValue: 111,
  });
  releaseCheckoutAttempt(first.orderId);

  assert.deepEqual(listRecoverableCheckoutAttempts({
    storage,
    nowMs: startedAt + (25 * 60 * 60 * 1_000),
  }), []);
  assert.deepEqual(JSON.parse(storage.getItem(checkoutAttemptStorageKey)), {});

  const replacement = beginCheckoutAttempt({
    ...checkout,
    clientMutationId: 'checkout-prepared-replacement-5678',
  }, {
    storage,
    nowMs: startedAt + (25 * 60 * 60 * 1_000),
    randomValue: 222,
  });
  assert.notEqual(replacement.orderId, first.orderId);
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
    groupId: 'customer-created-group',
    deal: { source: 'customer' },
  }), true);
});

test('reserved group orders can continue locally after only transient sync failures', () => {
  const order = { groupId: 'customer-timeout-group', type: 'purchase' };
  const timeout = Object.assign(new Error('upstream_timeout'), { status: 504, code: 'upstream_timeout' });
  const invalidGatewayBody = Object.assign(new SyntaxError('Unexpected token'), { status: 503, code: 'order_sync_failed' });
  const invalid = Object.assign(new Error('invalid_order_request'), { status: 400, code: 'invalid_order_request' });

  assert.equal(isTransientOrderSyncError(timeout), true);
  assert.equal(isTransientOrderSyncError(invalidGatewayBody), true);
  assert.equal(canQueueReservedGroupOrder(order, timeout), true);
  assert.equal(canQueueReservedGroupOrder({}, timeout), false);
  assert.equal(canQueueReservedGroupOrder(order, invalid), false);
  assert.equal(isTerminalOrderSyncError(invalid), true);
  assert.equal(isTerminalOrderSyncError(timeout), false);
  assert.equal(isTransientOrderSyncError({ status: 500, code: 'order_sync_failed' }), true);
});

test('instant-order publish retries transient responses with the identical serialized order', async () => {
  const order = {
    id: 'order-1700000000000123',
    createdAt: '2023-11-14T22:13:20.000Z',
    dealId: 'owner-instant-retry',
    type: 'purchase',
    selectedCount: 4,
  };
  const requestBodies = [];
  const delays = [];
  let attempts = 0;
  const published = await publishCustomerOrderRequest({
    action: 'publish',
    order,
    visitorId: 'visitor-instant-retry',
    customerCapabilityToken: 'customer-capability-retry-test-1234567890',
  }, {
    fetchImpl: async (_url, options) => {
      requestBodies.push(options.body);
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 503,
          async json() { return { ok: false, error: 'collector_busy' }; },
        };
      }
      return {
        ok: true,
        status: 202,
        async json() { return { ok: true, order }; },
      };
    },
    wait: async (delay) => { delays.push(delay); },
  });

  assert.equal(attempts, 2);
  assert.equal(delays.length, 1);
  assert.equal(requestBodies[0], requestBodies[1]);
  assert.equal(JSON.parse(requestBodies[1]).order.id, order.id);
  assert.equal(JSON.parse(requestBodies[1]).order.createdAt, order.createdAt);
  assert.deepEqual(published, order);
});

test('instant-order publish retries a network failure but never a semantic client error', async () => {
  const payload = {
    action: 'publish',
    order: {
      id: 'order-1700000000000456',
      createdAt: '2023-11-14T22:13:21.000Z',
    },
  };
  let networkAttempts = 0;
  await publishCustomerOrderRequest(payload, {
    fetchImpl: async () => {
      networkAttempts += 1;
      if (networkAttempts === 1) throw new TypeError('Failed to fetch');
      return {
        ok: true,
        status: 202,
        async json() { return { ok: true, order: payload.order }; },
      };
    },
    wait: async () => {},
  });
  assert.equal(networkAttempts, 2);

  let semanticAttempts = 0;
  await assert.rejects(() => publishCustomerOrderRequest(payload, {
    fetchImpl: async () => {
      semanticAttempts += 1;
      return {
        ok: false,
        status: 400,
        async json() { return { ok: false, error: 'invalid_order_request' }; },
      };
    },
    wait: async () => {},
  }), (error) => error.status === 400 && error.code === 'invalid_order_request');
  assert.equal(semanticAttempts, 1);
});

test('instant-order publish retries a malformed HTTP 200 response as a gateway failure', async () => {
  const payload = {
    action: 'publish',
    order: {
      id: 'order-1700000000000789',
      createdAt: '2023-11-14T22:13:22.000Z',
    },
  };
  let attempts = 0;
  const published = await publishCustomerOrderRequest(payload, {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: true,
          status: 200,
          async json() { throw new SyntaxError('Unexpected token <'); },
        };
      }
      return {
        ok: true,
        status: 202,
        async json() { return { ok: true, order: payload.order }; },
      };
    },
    wait: async () => {},
  });

  assert.equal(attempts, 2);
  assert.deepEqual(published, payload.order);
});

test('order publish retry budget is bounded to transient network and HTTP failures', () => {
  assert.equal(orderPublishRetryCount({ status: 408 }), 3);
  assert.equal(orderPublishRetryCount({ status: 425 }), 3);
  assert.equal(orderPublishRetryCount({ status: 429 }), 3);
  assert.equal(orderPublishRetryCount({ status: 503 }), 3);
  assert.equal(orderPublishRetryCount({ status: 500 }), 3);
  assert.equal(orderPublishRetryCount({ code: 'collector_busy' }), 3);
  assert.equal(orderPublishRetryCount({ code: 'upstream_timeout' }), 3);
  assert.equal(orderPublishRetryCount({ name: 'TypeError' }), 3);
  assert.equal(orderPublishRetryCount({ status: 501 }), 0);
  assert.equal(orderPublishRetryCount({ status: 409 }), 0);
  assert.equal(orderPublishRetryCount({ status: 400 }), 0);
});

test('semantic 4xx responses are terminal even with a generic sync error code', () => {
  const semanticError = { status: 400, code: 'order_sync_failed' };
  assert.equal(isTransientOrderSyncError(semanticError), false);
  assert.equal(isTerminalOrderSyncError(semanticError), true);
});

test('an empty sync error is never treated as a terminal rejection', () => {
  assert.equal(isTerminalOrderSyncError(null), false);
  assert.equal(isTerminalOrderSyncError(undefined), false);
});
