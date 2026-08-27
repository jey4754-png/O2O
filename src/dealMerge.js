const MERCHANT_PROGRESS_FIELDS = [
  'current',
  'currentCount',
  'currentPeople',
  'participantCount',
  'orderedQuantity',
  'allocatedProductQuantity',
  'quantityTracking',
];

export function dealTimestamp(deal) {
  if (deal?.updatedAt || deal?.syncedAt) {
    return new Date(deal.updatedAt || deal.syncedAt).getTime() || 0;
  }
  if (deal?.createdAt) return new Date(deal.createdAt).getTime() || 0;
  const match = String(deal?.id || '').match(/^(?:owner|customer)-(\d+)/);
  return match ? Number(match[1]) : 0;
}

function serverProgressSnapshot(snapshots) {
  return snapshots.reduce((latest, snapshot) => {
    if (snapshot?.source !== 'merchant' || !snapshot.syncedAt) return latest;
    if (!latest) return snapshot;
    const latestTime = new Date(latest.syncedAt).getTime() || 0;
    const snapshotTime = new Date(snapshot.syncedAt).getTime() || 0;
    return snapshotTime >= latestTime ? snapshot : latest;
  }, null);
}

function withAuthoritativeMerchantProgress(base, snapshots) {
  if (base?.source !== 'merchant') return base;
  const authority = serverProgressSnapshot(snapshots);
  if (!authority) return base;
  const progress = {};
  MERCHANT_PROGRESS_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(authority, field)) {
      progress[field] = authority[field];
    }
  });
  return { ...base, ...progress };
}

export function mergeDeals(...collections) {
  const merged = new Map();
  collections.flat().forEach((deal) => {
    if (!deal?.id) return;
    if (!merged.has(deal.id)) {
      merged.set(deal.id, deal);
      return;
    }
    const preferred = merged.get(deal.id);
    const preferredTime = dealTimestamp(preferred);
    const candidateTime = dealTimestamp(deal);
    const hasVersionedUpdate = Boolean(
      preferred?.updatedAt || preferred?.syncedAt || deal?.updatedAt || deal?.syncedAt,
    );
    let combined;
    if (hasVersionedUpdate && candidateTime > preferredTime) {
      combined = { ...preferred, ...deal };
    } else {
      combined = {
        ...deal,
        ...preferred,
        current: hasVersionedUpdate
          ? Number(preferred.current || 0)
          : Math.max(Number(preferred.current || 0), Number(deal.current || 0)),
        participantCount: hasVersionedUpdate
          ? Number(preferred.participantCount || 0)
          : Math.max(Number(preferred.participantCount || 0), Number(deal.participantCount || 0)),
      };
    }
    merged.set(deal.id, withAuthoritativeMerchantProgress(combined, [preferred, deal]));
  });
  return [...merged.values()].sort((left, right) => dealTimestamp(right) - dealTimestamp(left));
}
