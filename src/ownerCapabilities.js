const OWNER_DEAL_ID_PATTERN = /^owner-[a-zA-Z0-9-]{1,100}$/;
const MIN_CAPABILITY_LENGTH = 32;
const LEGACY_EVENT_MAX_TIME_DISTANCE_MS = 15 * 60 * 1000;

export const OWNER_CLAIM_BATCH_SIZE = 50;

export function ownerScopeKey(profile = {}) {
  if (profile?.testerType !== '사장님') return '';
  const phone = String(profile?.phone || '').replace(/\D/g, '');
  return phone.length >= 8 ? `phone:${phone}` : '';
}

export function isOwnerDealId(dealId) {
  return OWNER_DEAL_ID_PATTERN.test(String(dealId || ''));
}

export function isUsableOwnerCapability(capabilityToken) {
  return typeof capabilityToken === 'string' && capabilityToken.length >= MIN_CAPABILITY_LENGTH;
}

export function isOwnerDealInScope(dealId, scopeByDeal = {}, ownerScope = '') {
  return Boolean(
    ownerScope
    && isOwnerDealId(dealId)
    && scopeByDeal?.[dealId] === ownerScope,
  );
}

export function assignOwnerDealScope(scopeByDeal = {}, dealId, ownerScope = '') {
  const nextScopeByDeal = { ...scopeByDeal };
  if (!ownerScope || !isOwnerDealId(dealId)) {
    return { scopeByDeal: nextScopeByDeal, allowed: false, changed: false };
  }
  const existingScope = nextScopeByDeal[dealId] || '';
  if (existingScope && existingScope !== ownerScope) {
    return { scopeByDeal: nextScopeByDeal, allowed: false, changed: false };
  }
  if (!existingScope) {
    nextScopeByDeal[dealId] = ownerScope;
    return { scopeByDeal: nextScopeByDeal, allowed: true, changed: true };
  }
  return { scopeByDeal: nextScopeByDeal, allowed: true, changed: false };
}

function comparableText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
}

function eventOwnerScope(event = {}) {
  if (event?.name !== 'owner_product_created') return '';
  const properties = event?.properties || {};
  if (properties.tester_type !== '사장님') return '';
  const phone = String(properties.customer_phone || '').replace(/\D/g, '');
  return phone.length >= 8 ? `phone:${phone}` : '';
}

function validTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function legacyOwnerEventMatchesDeal(event = {}, deal = {}, ownerScope = '') {
  if (!ownerScope || eventOwnerScope(event) !== ownerScope) return false;
  const properties = event?.properties || {};
  const eventTime = validTimestamp(event.timestamp);
  const dealTime = validTimestamp(deal.createdAt);
  if (
    eventTime === null
    || dealTime === null
    || Math.abs(eventTime - dealTime) > LEGACY_EVENT_MAX_TIME_DISTANCE_MS
  ) {
    return false;
  }

  const pairs = [
    [properties.store_name, deal.store],
    [properties.product_name, deal.title],
    [properties.region, deal.region],
    [properties.district, deal.district],
    [properties.neighborhood, deal.neighborhood],
  ];
  return pairs.every(([eventValue, dealValue]) => {
    const normalizedEventValue = comparableText(eventValue);
    const normalizedDealValue = comparableText(dealValue);
    return Boolean(normalizedEventValue && normalizedDealValue && normalizedEventValue === normalizedDealValue);
  });
}

export function adoptLegacyOwnerScopes({
  capabilities = {},
  scopeByDeal = {},
  ownerScope = '',
  createdDeals = [],
  events = [],
  migrationCompleted = false,
} = {}) {
  const nextScopeByDeal = { ...scopeByDeal };
  if (migrationCompleted || !ownerScope) {
    return {
      scopeByDeal: nextScopeByDeal,
      changed: false,
      migrationCompleted: Boolean(migrationCompleted),
    };
  }

  const eligibleDeals = createdDeals.filter((deal) => {
    const dealId = String(deal?.id || '');
    return !(
      deal?.source !== 'merchant'
      || !isOwnerDealId(dealId)
      || nextScopeByDeal[dealId]
      || !isUsableOwnerCapability(capabilities?.[dealId])
    );
  });
  const eventMatches = new Map();
  const dealMatches = new Map();
  eligibleDeals.forEach((deal) => {
    const matchingEventIndexes = events.flatMap((event, index) => (
      legacyOwnerEventMatchesDeal(event, deal, ownerScope) ? [index] : []
    ));
    dealMatches.set(deal.id, matchingEventIndexes);
    matchingEventIndexes.forEach((index) => {
      eventMatches.set(index, [...(eventMatches.get(index) || []), deal.id]);
    });
  });

  let changed = false;
  eligibleDeals.forEach((deal) => {
    const matchingEventIndexes = dealMatches.get(deal.id) || [];
    if (matchingEventIndexes.length !== 1) return;
    const [eventIndex] = matchingEventIndexes;
    if ((eventMatches.get(eventIndex) || []).length !== 1) return;
    const dealId = String(deal.id);
    nextScopeByDeal[dealId] = ownerScope;
    changed = true;
  });

  return {
    scopeByDeal: nextScopeByDeal,
    changed,
    migrationCompleted: true,
  };
}

export function scopedOwnerCapabilityEntries(
  capabilities = {},
  scopeByDeal = {},
  ownerScope = '',
) {
  if (!ownerScope) return [];
  return Object.entries(capabilities)
    .filter(([dealId, capabilityToken]) => (
      isOwnerDealInScope(dealId, scopeByDeal, ownerScope)
      && isUsableOwnerCapability(capabilityToken)
    ))
    .map(([dealId, capabilityToken]) => ({ dealId, capabilityToken }));
}

export function chunkOwnerCapabilities(
  capabilities = [],
  chunkSize = OWNER_CLAIM_BATCH_SIZE,
) {
  const size = Math.max(1, Math.floor(Number(chunkSize) || OWNER_CLAIM_BATCH_SIZE));
  const chunks = [];
  for (let index = 0; index < capabilities.length; index += size) {
    chunks.push(capabilities.slice(index, index + size));
  }
  return chunks;
}
