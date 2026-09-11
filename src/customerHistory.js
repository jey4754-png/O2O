export const CUSTOMER_HISTORY_TIMEOUT_MS = 20000;

const ORDER_SYNC_FIELDS = [
  'id', 'createdAt', 'statusUpdatedAt', 'status', 'paymentStatus', 'visitorId',
  'customerNumber', 'customerName', 'customerPhone', 'region', 'district', 'neighborhood',
  'dealId', 'groupId', 'participantActorId', 'reservationMutationId', 'reservationAction',
  'reservationQuantity', 'publishMutationId', 'type', 'method', 'time', 'deadline',
  'selectedCount', 'quantity', 'unitPrice', 'total', 'hostRemainderApplied', 'title', 'store',
  'customerPickupConfirmedAt', 'paymentRequestedAt', 'paymentConfirmedAt', 'cancelledAt',
  'version', 'paymentVersion', 'statusHistory',
];

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
}

/** Read projection hints are not customer-editable order content. */
export function customerOrderWriteContent(order) {
  const { paymentSyncStatus: _paymentSyncStatus, ...content } = order || {};
  return content;
}

/**
 * Fingerprints only the order fields that survive the customer-orders API
 * sanitizer. A central read intentionally returns a compact deal snapshot;
 * comparing that response to richer local display metadata used to enqueue
 * the already accepted order again on every sync cycle.
 */
export function customerOrderSyncFingerprint(order) {
  const {
    syncedAt: _syncedAt,
    clientMutationId = '',
    deal: dealInput,
    ...content
  } = customerOrderWriteContent(order);
  const deal = dealInput && typeof dealInput === 'object' ? dealInput : {};
  const reservationMutationId = content.reservationMutationId || clientMutationId;
  const canonicalContent = Object.fromEntries(ORDER_SYNC_FIELDS
    .filter((key) => Object.hasOwn(content, key))
    .map((key) => [key, content[key]]));
  return JSON.stringify(stableJsonValue({
    ...canonicalContent,
    ...(reservationMutationId ? { reservationMutationId } : {}),
    deal: {
      id: deal.id || content.dealId || '',
      title: deal.title || content.title || '',
      store: deal.store || content.store || '',
      region: deal.region || content.region || '',
      district: deal.district || content.district || '',
      neighborhood: deal.neighborhood || content.neighborhood || '',
    },
  }));
}

/** A history read is never converted to an empty success at this boundary. */
export async function requestCustomerHistory({ phone, visitorId, customerCapabilityToken, groupId }, {
  signal,
  timeoutMs = CUSTOMER_HISTORY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(
    new Error('customer_history_timeout'), { code: 'customer_history_timeout' },
  )), timeoutMs);
  const assertNotAborted = () => {
    if (controller.signal.aborted) throw controller.signal.reason || new Error('customer_history_aborted');
  };
  try {
    const response = await fetchImpl('/api/customer-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', phone, visitorId, customerCapabilityToken, ...(groupId ? { groupId } : {}) }),
      signal: controller.signal,
    });
    assertNotAborted();
    let result = {};
    try { result = await response.json(); } catch {
      // A body can time out after HTTP 200 headers. Preserve cancellation rather
      // than reporting that as an invalid successful response.
      assertNotAborted();
      /* Invalid JSON is a read error, not an empty list. */
    }
    assertNotAborted();
    if (!response.ok || !result.ok || !Array.isArray(result.orders)) {
      const error = new Error(result.error || `customer_orders_${response.status}`);
      error.code = result.error || 'customer_orders_read_failed';
      error.status = response.status;
      throw error;
    }
    return result.orders;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
