import { canonicalOrderVersion } from './orderMerge.js';

export function isCancelledOrder(order = {}) {
  return order.status === 'cancelled' || order.paymentStatus === 'cancelled';
}

export function canCancelParticipation(order = {}, deal = {}, groupRole = '') {
  if (order.type !== 'purchase' || isCancelledOrder(order)) return false;
  if (order.status !== 'new' || order.paymentStatus !== 'pending') return false;
  if (order.paymentConfirmedAt || order.customerPickupConfirmedAt) return false;
  if (deal.saleType === 'instant') return false;
  if (deal.source === 'customer') {
    return (deal.groupStatus || deal.status || 'recruiting') === 'recruiting'
      && groupRole === 'member';
  }
  if (deal.saleType !== 'group') return false;
  if (order.groupId && ['creator', 'host', 'admin'].includes(groupRole)) return false;
  return true;
}

export function cancelledOrderSnapshot(order = {}, {
  timestamp = new Date().toISOString(),
  clientMutationId = '',
} = {}) {
  const nextVersion = Math.max(1, canonicalOrderVersion(order)) + 1;
  // A cancellation changes the publish contract, so it must never reuse the
  // initial order publish mutation id.
  const cancellationPublishMutationId = clientMutationId
    ? `publish-cancel-${clientMutationId}`
    : `publish-${String(order.id || 'order')}-cancel-v${nextVersion}`;
  return {
    ...order,
    status: 'cancelled',
    paymentStatus: 'cancelled',
    cancelledAt: timestamp,
    statusUpdatedAt: timestamp,
    version: nextVersion,
    paymentVersion: nextVersion,
    publishMutationId: cancellationPublishMutationId,
    statusHistory: [
      ...(Array.isArray(order.statusHistory) ? order.statusHistory : []),
      {
        status: 'cancelled',
        before: order.status || 'new',
        after: 'cancelled',
        action: 'cancel_participation',
        actor: order.visitorId || 'customer',
        actorRole: 'member',
        clientMutationId,
        timestamp,
      },
    ],
  };
}

export function applyMerchantParticipationCancellation(deal = {}, order = {}, hasOtherActiveOrder = false) {
  const selectedQuantity = Math.max(0, Math.floor(Number(order.selectedCount ?? order.quantity ?? 0)));
  const target = Math.max(1, Math.floor(Number(deal.totalQuantity ?? deal.target ?? 1)));
  const ordered = Math.max(0, Math.floor(Number(deal.orderedQuantity ?? deal.current ?? 0)) - selectedQuantity);
  const participantCount = Math.max(
    0,
    Math.floor(Number(deal.participantCount || 0)) - (hasOtherActiveOrder ? 0 : 1),
  );
  return {
    ...deal,
    current: Math.min(target, ordered),
    currentCount: Math.min(target, ordered),
    orderedQuantity: Math.min(target, ordered),
    allocatedProductQuantity: Math.min(target, ordered),
    participantCount,
    updatedAt: new Date().toISOString(),
  };
}
