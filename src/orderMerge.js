function orderCreatedAt(order) {
  return new Date(order?.createdAt || 0).getTime() || 0;
}

function mergeOrderValues(fallback, authoritative) {
  return {
    ...(fallback || {}),
    ...(authoritative || {}),
    deal: {
      ...(fallback?.deal || {}),
      ...(authoritative?.deal || {}),
    },
  };
}

/**
 * Builds the merchant workspace order list with server-scoped orders as the
 * source of truth. Local orders are retained only as a fallback when the
 * owner endpoint has no matching order yet.
 */
export function mergeAuthoritativeOwnerOrders(ownerOrders = [], localOrders = []) {
  const merged = new Map();

  localOrders.forEach((order) => {
    if (!order?.id) return;
    merged.set(order.id, mergeOrderValues(merged.get(order.id), order));
  });

  ownerOrders.forEach((order) => {
    if (!order?.id) return;
    merged.set(order.id, mergeOrderValues(merged.get(order.id), order));
  });

  return [...merged.values()].sort((left, right) => orderCreatedAt(right) - orderCreatedAt(left));
}

/**
 * Applies a successful owner-order refresh without discarding records omitted
 * from a transient partial response. The refreshed copy remains authoritative
 * for matching IDs; account changes explicitly clear the list in App.jsx.
 */
export function mergeOwnerOrderRefresh(previousOrders = [], refreshedOrders = []) {
  return mergeAuthoritativeOwnerOrders(refreshedOrders, previousOrders);
}

export function summarizeOwnerOrderDisplay(orders = [], summaries = []) {
  const detailedOrders = orders.filter((order) => Boolean(order?.id));
  const cancelledOrderCount = detailedOrders.filter((order) => (
    order?.status === 'cancelled' || order?.paymentStatus === 'cancelled'
  )).length;
  return {
    detailedOrderCount: detailedOrders.length,
    activeOrderCount: detailedOrders.length - cancelledOrderCount,
    cancelledOrderCount,
    pendingDetailQuantity: summaries.reduce(
      (total, summary) => total + Math.max(0, Number(summary?.pendingQuantity || 0)),
      0,
    ),
  };
}
