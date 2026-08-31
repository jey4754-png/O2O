const OWNER_DEAL_ID_PATTERN = /^owner-[a-zA-Z0-9-]{1,100}$/;
const MIN_CAPABILITY_LENGTH = 32;

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

export function adoptLegacyOwnerScopes({
  capabilities = {},
  scopeByDeal = {},
  ownerScope = '',
  createdDeals = [],
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

  let changed = false;
  createdDeals.forEach((deal) => {
    const dealId = String(deal?.id || '');
    if (
      deal?.source !== 'merchant'
      || !isOwnerDealId(dealId)
      || nextScopeByDeal[dealId]
      || !isUsableOwnerCapability(capabilities?.[dealId])
    ) {
      return;
    }
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
