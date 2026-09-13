import {
  listUnfinishedGroupCheckoutAttempts,
  matchesCheckoutReservation,
  reconcileGroupCheckoutAttempts,
} from './checkoutAttempt.js';
import { customerOrderSyncFingerprint } from './customerHistory.js';
import { isCancelledOrder } from './participation.js';

const SAFE_CAUSE_CODES = new Set([
  'invalid_customer_phone', 'forbidden', 'customer_history_forbidden',
  'missing_customer_capability_token', 'invalid_customer_capability_token',
  'customer_orders_read_failed', 'upstream_timeout', 'upstream_invalid_response',
  'customer_history_timeout',
  'collector_busy', 'collector_failed', 'collector_unreachable', 'order_sync_failed',
  'order_ownership_conflict', 'order_reservation_conflict', 'order_payment_link_required',
  'order_reservation_unverified',
  'order_payment_state_conflict', 'state_conflict', 'order_sync_pending',
]);

function pending(reason) {
  return Object.assign(new Error('order_sync_pending'), { preflightReason: reason });
}

function withoutUnverifiedReservation(order) {
  const {
    reservationMutationId: _reservationMutationId,
    reservationAction: _reservationAction,
    reservationQuantity: _reservationQuantity,
    clientMutationId: _legacyReservationMutationId,
    ...legacyOrder
  } = order;
  return legacyOrder;
}

export function canUseAcknowledgedCheckout(order, acknowledgements = {}, issues = {}, checkoutOptions = {}) {
  return Boolean(order && !issues[order.id]
    && acknowledgements[order.id] === customerOrderSyncFingerprint(order)
    && !listUnfinishedGroupCheckoutAttempts(order.groupId || order.dealId,
      order.participantActorId || order.visitorId, checkoutOptions).length);
}

/** Confirm this participant's frozen orders before creating a payment intent. */
export async function ensureGroupPaymentOrderSaved({
  groupId, actorId, readLocalOrders, readFingerprints, readSyncIssues,
  fetchOrders, publishOrder, persistOrder, checkoutOptions = {},
}) {
  let phase = 'checkout';
  const attempts = () => listUnfinishedGroupCheckoutAttempts(groupId, actorId, checkoutOptions);
  const blockActive = () => {
    if (attempts().some((attempt) => attempt.active)) throw pending('checkout_in_flight');
  };
  const belongs = (order) => order && (order.groupId || order.dealId) === groupId
    && (order.participantActorId || order.visitorId) === actorId && !isCancelledOrder(order);
  try {
    blockActive();
    const localOrders = readLocalOrders().filter(belongs);
    const fingerprints = readFingerprints();
    const issues = readSyncIssues();
    // An old terminal rejection can have a legacy fingerprint. Any unresolved
    // issue or checkout requires a fresh server read, even if that hash matches.
    if (!attempts().length && localOrders.length && localOrders.every((order) => (
      order.groupId === groupId && order.reservationMutationId && !issues[order.id]
      && fingerprints[order.id] === customerOrderSyncFingerprint(order)
    ))) return;

    phase = 'history';
    const response = await fetchOrders();
    if (!Array.isArray(response) || response.some((order) => !order || typeof order !== 'object' || !order.id)) {
      throw pending('invalid_order_response');
    }
    blockActive();
    const central = response.filter(belongs);
    const centralIds = new Set(central.map((order) => order.id));
    const queued = readLocalOrders().filter((order) => belongs(order) && !centralIds.has(order.id));
    phase = 'reconcile';
    for (const attempt of attempts()) {
      const candidates = response.filter((order) => order.id === attempt.orderId);
      if (candidates.length && (candidates.length !== 1 || !matchesCheckoutReservation(candidates[0], attempt))) {
        throw pending('order_binding_conflict');
      }
    }
    reconcileGroupCheckoutAttempts(groupId, actorId, central, checkoutOptions);
    if (!central.length && !queued.length) {
      throw pending(attempts().length ? 'checkout_unresolved' : 'order_missing');
    }
    for (const order of central) persistOrder(order);
    for (const order of queued) {
      blockActive();
      // Unbound legacy display rows remain available, but cannot stand in for
      // reservation receipts. The server checks the complete proven quantity.
      if (central.length && (!order.reservationMutationId
        || !['create', 'join', 'reserve_quantity'].includes(order.reservationAction))) continue;
      const attempt = attempts().find((item) => item.orderId === order.id);
      if (attempt && !matchesCheckoutReservation(order, attempt)) throw pending('order_binding_conflict');
      phase = 'publish';
      // Replay this saved payload only; never reserve a new quantity here.
      let saved;
      try {
        saved = await publishOrder(order);
      } catch (publishError) {
        const publishCode = String(publishError?.code || publishError?.message || '');
        if (publishCode !== 'order_reservation_unverified') throw publishError;
        // Some pre-central-storage browsers retained a provisional reservation
        // id that no longer matches the server's immutable group history. The
        // collector already has a fail-closed legacy binder: it accepts this
        // retry only when exactly one active order can be tied to an existing
        // participant reservation with the same actor, group and quantity.
        // Removing only the untrusted hint lets that server check run; it does
        // not create a participant, reserve quantity or change payment state.
        saved = await publishOrder(withoutUnverifiedReservation(order));
      }
      if (!saved || saved.id !== order.id || !belongs(saved)
        || (attempt && !matchesCheckoutReservation(saved, attempt))) throw pending('invalid_order_response');
      persistOrder({ ...order, ...saved });
      phase = 'reconcile';
      reconcileGroupCheckoutAttempts(groupId, actorId, [saved], checkoutOptions);
    }
    blockActive();
    if (attempts().length) throw pending('checkout_unresolved');
  } catch (cause) {
    const code = String(cause?.code || cause?.message || '');
    throw Object.assign(new Error('order_sync_pending'), {
      code: 'order_sync_pending', cause, preflightPhase: phase,
      preflightReason: cause?.preflightReason
        || (phase === 'history' ? 'history_read_failed' : phase === 'publish' ? 'publish_failed' : 'checkout_unresolved'),
      causeCode: SAFE_CAUSE_CODES.has(code) ? code : 'unknown',
    });
  }
}
