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

/**
 * Returns valid merchant capabilities that have not yet been assigned to any
 * local merchant profile. These are lookup inputs for the existing owner deal
 * listing endpoint. A returned deal proves that the browser-held management key
 * is valid, but it does not prove who is using the browser, so assignment still
 * requires an explicit confirmation in the current merchant profile.
 */
export function unscopedOwnerCapabilityEntries(
  capabilities = {},
  scopeByDeal = {},
) {
  return Object.entries(capabilities)
    .filter(([dealId, capabilityToken]) => (
      isOwnerDealId(dealId)
      && !scopeByDeal?.[dealId]
      && isUsableOwnerCapability(capabilityToken)
    ))
    .map(([dealId, capabilityToken]) => ({ dealId, capabilityToken }));
}

/**
 * Builds manual recovery candidates from unscoped management keys that the
 * standard owner listing endpoint verified. Public title/store metadata is
 * included so the person at the browser can identify each product before
 * explicitly assigning it to the active merchant profile.
 */
export function buildOwnerRecoveryCandidates({
  capabilities = {},
  scopeByDeal = {},
  verifiedDeals = [],
  recoveryScope = '',
} = {}) {
  if (!/^phone:\d{8,}$/.test(String(recoveryScope || ''))) return [];
  const verifiedDealById = new Map(
    (Array.isArray(verifiedDeals) ? verifiedDeals : [])
      .filter((deal) => isOwnerDealId(deal?.id))
      .map((deal) => [String(deal.id), deal]),
  );

  return unscopedOwnerCapabilityEntries(capabilities, scopeByDeal)
    .flatMap((entry) => {
      const deal = verifiedDealById.get(entry.dealId);
      if (!deal) return [];
      return [{
        ...entry,
        recoveryScope,
        title: String(deal.title || '').trim(),
        store: String(deal.store || '').trim(),
      }];
    });
}

/**
 * Assigns explicitly confirmed legacy deals after the standard owner listing
 * endpoint verified the browser-held capability. Existing assignments are never
 * overwritten, and a locally missing/changed capability makes recovery
 * ineligible. This is a management-key recovery, not account authentication.
 */
export function confirmOwnerRecovery({
  capabilities = {},
  scopeByDeal = {},
  ownerScope = '',
  verifiedRecoveryEntries = [],
  confirmedDealIds = [],
} = {}) {
  const nextScopeByDeal = { ...scopeByDeal };
  const candidateIds = new Set(
    unscopedOwnerCapabilityEntries(capabilities, scopeByDeal)
      .map(({ dealId }) => dealId),
  );
  const verifiedCapabilities = new Map();
  (Array.isArray(verifiedRecoveryEntries) ? verifiedRecoveryEntries : [])
    .forEach((entry) => {
      const dealId = String(entry?.dealId || '');
      const capabilityToken = entry?.capabilityToken;
      if (!isOwnerDealId(dealId) || !isUsableOwnerCapability(capabilityToken)) return;
      verifiedCapabilities.set(dealId, capabilityToken);
    });
  const recoveredDealIds = [];

  (Array.isArray(confirmedDealIds) ? confirmedDealIds : []).forEach((value) => {
    const dealId = String(value || '');
    if (
      recoveredDealIds.includes(dealId)
      || !candidateIds.has(dealId)
      || verifiedCapabilities.get(dealId) !== capabilities?.[dealId]
    ) {
      return;
    }
    const assignment = assignOwnerDealScope(nextScopeByDeal, dealId, ownerScope);
    if (!assignment.allowed || !assignment.changed) return;
    Object.assign(nextScopeByDeal, assignment.scopeByDeal);
    recoveredDealIds.push(dealId);
  });

  return {
    scopeByDeal: nextScopeByDeal,
    recoveredDealIds,
    changed: recoveredDealIds.length > 0,
  };
}

/**
 * Reconciles an in-flight recovery request against the browser's current
 * identity and storage snapshot. Callers should load capabilities and scopes
 * again after the server response, then pass those fresh values here.
 *
 * A recovery is rejected when the active merchant changed, a requested token
 * changed, another tab already claimed the deal, or the standard owner listing
 * did not return that exact deal id. Unrelated assignments in the latest scope
 * map are kept.
 */
export function reconcileOwnerRecovery({
  capabilities = {},
  scopeByDeal = {},
  expectedOwnerScope = '',
  currentOwnerScope = '',
  requestedRecoveryEntries = [],
  verifiedDealIds = [],
} = {}) {
  const unchanged = {
    scopeByDeal: { ...scopeByDeal },
    recoveredDealIds: [],
    changed: false,
  };
  if (
    !expectedOwnerScope
    || currentOwnerScope !== expectedOwnerScope
    || !/^phone:\d{8,}$/.test(currentOwnerScope)
  ) {
    return unchanged;
  }

  const verifiedIds = new Set(
    (Array.isArray(verifiedDealIds) ? verifiedDealIds : [])
      .map((dealId) => String(dealId || ''))
      .filter(isOwnerDealId),
  );
  const verifiedRecoveryEntries = (Array.isArray(requestedRecoveryEntries)
    ? requestedRecoveryEntries
    : [])
    .filter((entry) => (
      entry?.recoveryScope === currentOwnerScope
      && verifiedIds.has(String(entry?.dealId || ''))
    ))
    .map(({ dealId, capabilityToken }) => ({ dealId, capabilityToken }));

  return confirmOwnerRecovery({
    capabilities,
    scopeByDeal,
    ownerScope: currentOwnerScope,
    verifiedRecoveryEntries,
    confirmedDealIds: verifiedRecoveryEntries.map(({ dealId }) => dealId),
  });
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
