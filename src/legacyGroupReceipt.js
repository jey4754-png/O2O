const ANALYTICS_EVENTS_KEY = 'o2o_mvp_events';
const CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalLegacyReceiptId(value) {
  return typeof value === 'string' && CANONICAL_UUID_V4_PATTERN.test(value);
}

/**
 * Finds the oldest local receipt that can be presented to the server for a
 * legacy customer-group recovery. Event display text and deal metadata are
 * deliberately insufficient: every stored binding must match exactly.
 */
export function findLegacyCustomerGroupReceipt(events, { groupId, actorId } = {}) {
  if (!Array.isArray(events) || !groupId || !actorId) return null;

  // The original creation receipt predates any duplicate client-side events.
  // Prefer it so a later post-migration duplicate cannot mask an eligible
  // historical receipt with the same public deal id.
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const properties = event?.properties;
    if (
      !event
      || typeof event !== 'object'
      || Array.isArray(event)
      || event.name !== 'group_created'
      || event.visitorId !== actorId
      || !isCanonicalLegacyReceiptId(event.id)
      || !properties
      || typeof properties !== 'object'
      || Array.isArray(properties)
      || properties.deal_id !== groupId
      || properties.source !== 'customer'
    ) {
      continue;
    }
    return { eventId: event.id };
  }
  return null;
}

export function loadLegacyCustomerGroupReceipt({
  groupId,
  actorId,
  storage = globalThis.localStorage,
} = {}) {
  try {
    const rawEvents = storage?.getItem(ANALYTICS_EVENTS_KEY);
    if (typeof rawEvents !== 'string') return null;
    return findLegacyCustomerGroupReceipt(JSON.parse(rawEvents), { groupId, actorId });
  } catch {
    return null;
  }
}
