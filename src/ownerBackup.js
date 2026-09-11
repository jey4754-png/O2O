const BACKUP_VERSION = 1;
const DEAL_ID_PATTERN = /^owner-[a-zA-Z0-9-]{1,100}$/;
const OWNER_SCOPE_PATTERN = /^phone:010\d{8}$/;

function usableToken(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 256;
}
export function buildOwnerBackup({
  ownerScope = '',
  capabilities = {},
  scopeByDeal = {},
} = {}) {
  if (!OWNER_SCOPE_PATTERN.test(ownerScope)) throw new Error('invalid_owner_scope');
  const entries = Object.entries(capabilities)
    .filter(([dealId, capabilityToken]) => (
      DEAL_ID_PATTERN.test(dealId)
      && scopeByDeal?.[dealId] === ownerScope
      && usableToken(capabilityToken)
    ))
    .map(([dealId, capabilityToken]) => ({ dealId, capabilityToken }))
    .slice(0, 500);
  if (!entries.length) throw new Error('owner_backup_empty');
  return {
    type: 'o2o-owner-management-backup',
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    ownerScope,
    entries,
  };
}

export function parseOwnerBackup(serialized, expectedOwnerScope = '') {
  let backup;
  try {
    backup = JSON.parse(String(serialized || ''));
  } catch {
    throw new Error('owner_backup_invalid');
  }
  if (
    !backup
    || backup.type !== 'o2o-owner-management-backup'
    || backup.version !== BACKUP_VERSION
    || !OWNER_SCOPE_PATTERN.test(backup.ownerScope)
    || backup.ownerScope !== expectedOwnerScope
    || !Array.isArray(backup.entries)
    || backup.entries.length < 1
    || backup.entries.length > 500
  ) {
    throw new Error('owner_backup_invalid');
  }
  const seen = new Set();
  const entries = backup.entries.map((entry) => {
    const dealId = String(entry?.dealId || '');
    const capabilityToken = String(entry?.capabilityToken || '');
    if (!DEAL_ID_PATTERN.test(dealId) || !usableToken(capabilityToken) || seen.has(dealId)) {
      throw new Error('owner_backup_invalid');
    }
    seen.add(dealId);
    return { dealId, capabilityToken };
  });
  return { ownerScope: backup.ownerScope, entries };
}

export function mergeVerifiedOwnerBackup({
  ownerScope = '',
  entries = [],
  verifiedDealIds = [],
  capabilities = {},
  scopeByDeal = {},
} = {}) {
  const verified = new Set(verifiedDealIds.map((value) => String(value || '')));
  const nextCapabilities = { ...capabilities };
  const nextScopeByDeal = { ...scopeByDeal };
  const restoredDealIds = [];
  const conflicts = [];
  entries.forEach(({ dealId, capabilityToken }) => {
    if (!verified.has(dealId)) return;
    const existingToken = nextCapabilities[dealId];
    const existingScope = nextScopeByDeal[dealId];
    if ((existingToken && existingToken !== capabilityToken)
      || (existingScope && existingScope !== ownerScope)) {
      conflicts.push(dealId);
      return;
    }
    nextCapabilities[dealId] = capabilityToken;
    nextScopeByDeal[dealId] = ownerScope;
    restoredDealIds.push(dealId);
  });
  return {
    capabilities: nextCapabilities,
    scopeByDeal: nextScopeByDeal,
    restoredDealIds,
    conflicts,
  };
}
