function orderCreatedAt(order) {
  return new Date(order?.createdAt || 0).getTime() || 0;
}

export function canonicalOrderVersion(order) {
  return Math.max(
    ...[order?.version, order?.paymentVersion].map((candidate) => {
      const value = Number(candidate ?? 0);
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }),
  );
}

function orderUpdatedAt(order) {
  return Math.max(
    ...[
      order?.statusUpdatedAt,
      order?.syncedAt,
      order?.updatedAt,
      order?.createdAt,
    ].map((value) => new Date(value || 0).getTime() || 0),
  );
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
 * Merges customer order snapshots without allowing a newer local clock to
 * overwrite a higher compare-and-swap version returned by the server.
 */
export function mergeCustomerOrderCollections(...collections) {
  const merged = new Map();
  collections.flat().forEach((order) => {
    if (!order?.id) return;
    const current = merged.get(order.id);
    if (!current) {
      merged.set(order.id, mergeOrderValues(null, order));
      return;
    }

    const currentVersion = canonicalOrderVersion(current);
    const nextVersion = canonicalOrderVersion(order);
    const nextIsCurrent = nextVersion > currentVersion
      || (nextVersion === currentVersion && orderUpdatedAt(order) >= orderUpdatedAt(current));
    merged.set(
      order.id,
      nextIsCurrent
        ? mergeOrderValues(current, order)
        : mergeOrderValues(order, current),
    );
  });

  return [...merged.values()].sort((left, right) => orderCreatedAt(right) - orderCreatedAt(left));
}

/**
 * Applies a completed central customer-history read. A matching central order
 * is authoritative when its CAS version is at least the locally cached one.
 * This matters for payment projection: the participant state can advance on
 * the server without rewriting an older order row, while a device clock in
 * the future must not keep the cached pending state on screen. A genuinely
 * newer local mutation is still retained until the central read catches up.
 */
export function mergeAuthoritativeCustomerOrderRefresh(
  previousOrders = [],
  refreshedOrders = [],
) {
  const merged = new Map();

  previousOrders.forEach((order) => {
    if (!order?.id) return;
    merged.set(order.id, mergeOrderValues(merged.get(order.id), order));
  });

  refreshedOrders.forEach((order) => {
    if (!order?.id) return;
    const previous = merged.get(order.id);
    if (!previous) {
      merged.set(order.id, mergeOrderValues(null, order));
      return;
    }
    const previousVersion = canonicalOrderVersion(previous);
    const refreshedVersion = canonicalOrderVersion(order);
    if (refreshedVersion >= previousVersion) {
      const authoritative = mergeOrderValues(previous, order);
      // A repaired order may no longer carry a read-only projection hint.
      // Absence on the adopted central snapshot must clear the cached warning.
      if (!['repair_required', 'verified_history'].includes(order.paymentSyncStatus)) {
        delete authoritative.paymentSyncStatus;
      }
      merged.set(order.id, authoritative);
    } else {
      merged.set(order.id, mergeOrderValues(order, previous));
    }
  });

  return [...merged.values()].sort((left, right) => orderCreatedAt(right) - orderCreatedAt(left));
}

/**
 * Completes a customer sync cycle without discarding the authoritative order
 * returned by a successful publish when the follow-up history read is
 * temporarily unavailable. A later history snapshot is still applied last,
 * with the normal CAS guard preventing an older response from regressing it.
 */
export function mergeCompletedCustomerOrderSync(
  previousOrders = [],
  publishedOrders = [],
  refreshedOrders = [],
  rolledBackOrderIds = new Set(),
) {
  const retainedOrders = previousOrders.filter((order) => !rolledBackOrderIds.has(order?.id));
  const acceptedPublishedOrders = publishedOrders.filter(
    (order) => order?.id && !rolledBackOrderIds.has(order.id),
  );
  const acceptedRefreshedOrders = refreshedOrders.filter(
    (order) => order?.id && !rolledBackOrderIds.has(order.id),
  );
  const afterPublish = mergeAuthoritativeCustomerOrderRefresh(
    retainedOrders,
    acceptedPublishedOrders,
  );
  return mergeAuthoritativeCustomerOrderRefresh(afterPublish, acceptedRefreshedOrders);
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
  const merged = new Map();

  previousOrders.forEach((order) => {
    if (!order?.id) return;
    merged.set(order.id, mergeOrderValues(merged.get(order.id), order));
  });

  refreshedOrders.forEach((order) => {
    if (!order?.id) return;
    const previous = merged.get(order.id);
    if (!previous) {
      merged.set(order.id, mergeOrderValues(null, order));
      return;
    }

    const previousVersion = canonicalOrderVersion(previous);
    const refreshedVersion = canonicalOrderVersion(order);
    const refreshedIsCurrent = refreshedVersion > previousVersion
      || (refreshedVersion === previousVersion
        && orderUpdatedAt(order) >= orderUpdatedAt(previous));

    // Owner refreshes can overlap an interactive state transition. A poll
    // started before that transition must not overwrite the newer CAS version
    // when its older response arrives afterwards.
    merged.set(
      order.id,
      refreshedIsCurrent
        ? mergeOrderValues(previous, order)
        : mergeOrderValues(order, previous),
    );
  });

  return [...merged.values()].sort((left, right) => orderCreatedAt(right) - orderCreatedAt(left));
}

/**
 * Keeps local fallback orders only while their product is actively managed,
 * while retaining every exact order returned by the owner-scoped endpoint.
 * The latter is required for orders placed before a product was soft-deleted.
 */
export function ownerOrderBelongsToWorkspace(
  order,
  ownerDealIds = new Set(),
  authoritativeOwnerOrderIds = new Set(),
) {
  if (!order?.id) return false;
  return authoritativeOwnerOrderIds.has(order.id) || ownerDealIds.has(order.dealId);
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
