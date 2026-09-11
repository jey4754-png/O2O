import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginCheckoutAttempt, updateCheckoutAttempt, releaseCheckoutAttempt, checkoutAttemptStorageKey,
  listUnfinishedGroupCheckoutAttempts, matchesCheckoutReservation, reconcileGroupCheckoutAttempts,
} from './checkoutAttempt.js';
import { customerOrderSyncFingerprint } from './customerHistory.js';
import { canUseAcknowledgedCheckout, ensureGroupPaymentOrderSaved } from './paymentOrderPreflight.js';

let nonce = 9000;
function fixture({ active = false } = {}) {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const checkoutOptions = { storage, nowMs: 1_700_000_000_000, randomValue: ++nonce };
  const attempt = beginCheckoutAttempt({
    actorId: 'visitor-proof', groupId: 'customer-proof', dealId: 'customer-proof', type: 'group',
    reservationMutationId: `reservation-proof-${nonce}`, reservationAction: 'create', selectedCount: 1,
  }, checkoutOptions);
  updateCheckoutAttempt(attempt.orderId, { stage: 'publishing_order' }, checkoutOptions);
  if (!active) releaseCheckoutAttempt(attempt.orderId);
  const order = {
    id: attempt.orderId, groupId: attempt.groupId, dealId: attempt.dealId,
    visitorId: attempt.actorId, participantActorId: attempt.actorId,
    reservationMutationId: attempt.reservationMutationId, reservationAction: attempt.reservationAction,
    reservationQuantity: 1, selectedCount: 1, quantity: 1, version: 1, paymentVersion: 1,
    status: 'new', paymentStatus: 'pending',
  };
  const state = { local: [structuredClone(order)], central: [structuredClone(order)], fingerprints: {}, issues: {}, reads: 0, published: [], persisted: [] };
  const args = {
    groupId: attempt.groupId, actorId: attempt.actorId, checkoutOptions,
    readLocalOrders: () => state.local, readFingerprints: () => state.fingerprints, readSyncIssues: () => state.issues,
    fetchOrders: async () => { state.reads += 1; return state.central; },
    publishOrder: async (value) => { state.published.push(structuredClone(value)); return structuredClone(value); },
    persistOrder: (value) => state.persisted.push(structuredClone(value)),
  };
  return { attempt, order, state, args, storage,
    remaining: () => listUnfinishedGroupCheckoutAttempts(args.groupId, args.actorId, checkoutOptions),
    serialized: () => storage.getItem(checkoutAttemptStorageKey),
  };
}

test('a committed canonical order reconciles an interrupted checkout without reserving or republishing', async () => {
  const f = fixture();
  f.state.fingerprints[f.order.id] = customerOrderSyncFingerprint(f.order);
  await ensureGroupPaymentOrderSaved(f.args);
  assert.equal(f.state.reads, 1, 'the stored fingerprint cannot complete the attempt');
  assert.deepEqual(f.state.published, []);
  assert.deepEqual(f.state.persisted, [f.order]);
  assert.deepEqual(f.remaining(), []);
});

test('a committed canonical order restores its missing local snapshot and reconciles only its own attempt', async () => {
  const f = fixture();
  f.state.local = [];
  const unrelated = beginCheckoutAttempt({
    actorId: 'visitor-another-account', groupId: f.args.groupId, dealId: f.args.groupId,
    selectedCount: 1, reservationMutationId: 'another-account-reservation', reservationAction: 'join',
  }, { ...f.args.checkoutOptions, randomValue: ++nonce });
  updateCheckoutAttempt(unrelated.orderId, { stage: 'reserved' }, f.args.checkoutOptions);
  releaseCheckoutAttempt(unrelated.orderId);
  await ensureGroupPaymentOrderSaved(f.args);
  assert.deepEqual(f.state.persisted, [f.order]);
  assert.deepEqual(f.state.published, []);
  assert.deepEqual(f.remaining(), []);
  assert.equal(listUnfinishedGroupCheckoutAttempts(f.args.groupId, unrelated.actorId, f.args.checkoutOptions).length, 1);
});

test('duplicate canonical IDs are ambiguous and cannot remove an interrupted attempt', async () => {
  const f = fixture();
  f.state.central.push(structuredClone(f.order));
  const before = f.serialized();
  await assert.rejects(ensureGroupPaymentOrderSaved(f.args), { preflightReason: 'order_binding_conflict' });
  assert.equal(f.serialized(), before);
  assert.deepEqual(f.state.persisted, []);
});

for (const [field, value] of [
  ['id', 'order-1700000000000999999'], ['groupId', 'customer-other'], ['dealId', 'customer-other'],
  ['visitorId', 'visitor-other'], ['participantActorId', 'visitor-other'],
  ['reservationMutationId', 'reservation-unrelated'], ['reservationAction', 'join'],
  ['reservationQuantity', 2], ['quantity', 2], ['selectedCount', 2],
  ['status', 'cancelled'], ['paymentStatus', 'cancelled'], ['cancelledAt', '2026-09-10'],
  ['paymentSyncStatus', 'repair_required'],
]) {
  test(`a canonical order with a different ${field} cannot erase the reservation attempt`, () => {
    const f = fixture();
    const before = f.serialized();
    const invalid = { ...f.order, [field]: value };
    assert.equal(matchesCheckoutReservation(invalid, f.attempt), false);
    assert.deepEqual(reconcileGroupCheckoutAttempts(f.args.groupId, f.args.actorId, [invalid], f.args.checkoutOptions), []);
    assert.equal(f.serialized(), before);
  });
}

test('a conflicting canonical binding blocks preflight before replacing the local record', async () => {
  const f = fixture();
  f.state.central[0].reservationMutationId = 'reservation-unrelated';
  const before = f.serialized();
  await assert.rejects(ensureGroupPaymentOrderSaved(f.args), { code: 'order_sync_pending', preflightReason: 'order_binding_conflict' });
  assert.equal(f.serialized(), before);
  assert.deepEqual(f.state.persisted, []);
  assert.deepEqual(f.state.published, []);
});

test('an active checkout is never completed, even when an accepted snapshot already exists', async () => {
  const f = fixture({ active: true });
  try {
    const before = f.serialized();
    assert.deepEqual(reconcileGroupCheckoutAttempts(f.args.groupId, f.args.actorId, [f.order], f.args.checkoutOptions), []);
    await assert.rejects(ensureGroupPaymentOrderSaved(f.args), { preflightPhase: 'checkout', preflightReason: 'checkout_in_flight' });
    assert.equal(f.state.reads, 0);
    assert.equal(f.serialized(), before);
    assert.deepEqual(f.state.persisted, []);
  } finally { releaseCheckoutAttempt(f.order.id); }
});

test('an active additional reservation blocks payment of an already acknowledged earlier order', async () => {
  const f = fixture({ active: true });
  try {
    f.state.local = [{ ...f.order, id: 'order-1700000000000123456', reservationMutationId: 'earlier-reservation-proof' }];
    f.state.central = structuredClone(f.state.local);
    f.state.fingerprints[f.state.local[0].id] = customerOrderSyncFingerprint(f.state.local[0]);
    const before = f.serialized();
    await assert.rejects(ensureGroupPaymentOrderSaved(f.args), { preflightReason: 'checkout_in_flight' });
    assert.equal(f.serialized(), before);
    assert.equal(f.state.reads, 0);
    assert.deepEqual(f.state.published, []);
  } finally { releaseCheckoutAttempt(f.order.id); }
});

test('an unmatched interrupted additional reservation stays blocked after a successful central read', async () => {
  const f = fixture();
  f.state.local = [{ ...f.order, id: 'order-1700000000000123456', reservationMutationId: 'earlier-reservation-proof' }];
  f.state.central = structuredClone(f.state.local);
  const before = f.serialized();
  await assert.rejects(ensureGroupPaymentOrderSaved(f.args), { preflightReason: 'checkout_unresolved' });
  assert.equal(f.serialized(), before);
  assert.equal(f.state.reads, 1);
  assert.deepEqual(f.state.published, []);
});

test('a checkout resumed during a pending read is rechecked before applying its result', async () => {
  const f = fixture();
  f.args.fetchOrders = async () => {
    beginCheckoutAttempt({
      actorId: f.attempt.actorId, groupId: f.attempt.groupId, dealId: f.attempt.dealId, type: 'group',
      selectedCount: 1, reservationMutationId: f.attempt.reservationMutationId,
    }, f.args.checkoutOptions);
    return f.state.central;
  };
  try {
    await assert.rejects(ensureGroupPaymentOrderSaved(f.args), { preflightReason: 'checkout_in_flight' });
    assert.equal(f.remaining().length, 1);
    assert.deepEqual(f.state.persisted, []);
  } finally { releaseCheckoutAttempt(f.order.id); }
});

for (const failure of ['upstream_timeout', 'upstream_invalid_response', 'forbidden', 'malformed']) {
  test(`${failure} preserves the order and attempt and allows a later successful read retry`, async () => {
    const f = fixture();
    const before = f.serialized();
    const fetchOrders = f.args.fetchOrders;
    f.args.fetchOrders = async () => {
      if (failure === 'malformed') return { ok: true, service: 'UPTWOYOU collector' };
      throw Object.assign(new Error(failure), { code: failure });
    };
    await assert.rejects(ensureGroupPaymentOrderSaved(f.args), {
      code: 'order_sync_pending', preflightPhase: 'history',
      preflightReason: failure === 'malformed' ? 'invalid_order_response' : 'history_read_failed',
      causeCode: failure === 'malformed' ? 'order_sync_pending' : failure,
    });
    assert.equal(f.serialized(), before);
    assert.deepEqual(f.state.persisted, []);
    assert.deepEqual(f.state.published, []);
    f.args.fetchOrders = fetchOrders;
    await ensureGroupPaymentOrderSaved(f.args);
    assert.deepEqual(f.remaining(), []);
    assert.deepEqual(f.state.persisted, [f.order]);
  });
}

test('a queued bound order uses its frozen identity and completes only after exact publication acknowledgement', async () => {
  const f = fixture();
  f.state.central = [];
  await ensureGroupPaymentOrderSaved(f.args);
  assert.deepEqual(f.state.published, [f.order]);
  assert.deepEqual(f.remaining(), []);
});

test('an invalid publication acknowledgement preserves the interrupted attempt and local order', async () => {
  const f = fixture();
  f.state.central = [];
  f.args.publishOrder = async () => ({ ...f.order, reservationQuantity: 2 });
  const before = f.serialized();
  await assert.rejects(ensureGroupPaymentOrderSaved(f.args), { preflightPhase: 'publish', preflightReason: 'invalid_order_response' });
  assert.equal(f.serialized(), before);
  assert.deepEqual(f.state.persisted, []);
});

test('a terminal publish rejection keeps the unresolved reservation and reports a bounded cause', async () => {
  const f = fixture();
  f.state.central = [];
  f.args.publishOrder = async () => { throw Object.assign(new Error('private provider detail'), { code: 'order_ownership_conflict', status: 409 }); };
  const before = f.serialized();
  await assert.rejects(ensureGroupPaymentOrderSaved(f.args), {
    message: 'order_sync_pending', preflightPhase: 'publish', preflightReason: 'publish_failed', causeCode: 'order_ownership_conflict',
  });
  assert.equal(f.serialized(), before);
  assert.deepEqual(f.state.persisted, []);
});

test('a failed legacy fingerprint never skips canonical verification', async () => {
  const f = fixture();
  reconcileGroupCheckoutAttempts(f.args.groupId, f.args.actorId, [f.order], f.args.checkoutOptions);
  f.state.fingerprints[f.order.id] = customerOrderSyncFingerprint(f.order);
  f.state.issues[f.order.id] = { state: 'failed', code: 'order_ownership_conflict' };
  f.args.fetchOrders = async () => { f.state.reads += 1; throw new Error('upstream_timeout'); };
  await assert.rejects(ensureGroupPaymentOrderSaved(f.args), { preflightReason: 'history_read_failed' });
  assert.equal(f.state.reads, 1);
  assert.deepEqual(f.state.persisted, []);
});

test('manual checkout cannot treat a legacy rejected fingerprint or unresolved attempt as saved', () => {
  const f = fixture();
  const acknowledgements = { [f.order.id]: customerOrderSyncFingerprint(f.order) };
  assert.equal(canUseAcknowledgedCheckout(f.order, acknowledgements, {}, f.args.checkoutOptions), false,
    'a fingerprint cannot complete the interrupted attempt');
  reconcileGroupCheckoutAttempts(f.args.groupId, f.args.actorId, [f.order], f.args.checkoutOptions);
  assert.equal(canUseAcknowledgedCheckout(f.order, acknowledgements, {}, f.args.checkoutOptions), true);
  for (const state of ['failed', 'pending']) {
    assert.equal(canUseAcknowledgedCheckout(f.order, acknowledgements, {
      [f.order.id]: { state, code: 'order_sync_failed' },
    }, f.args.checkoutOptions), false);
  }
});
