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

function withLatestGroupState(base, snapshots) {
  const latest = snapshots.reduce((current, item) => (
    Number(item?.stateVersion ?? item?.version ?? 0) > Number(current?.stateVersion ?? current?.version ?? 0)
      ? item : current
  ), base);
  if (latest === base) return base;
  const fields = ['version', 'stateVersion', 'groupStatus', 'chatLocked', 'hostActorId',
    'hostMode', 'hostMatched', 'lastMessageSeq', 'currentCount', 'participantCount'];
  if (base.source === 'customer') fields.push('target', 'targetCount', 'targetPeople',
    'current', 'currentPeople', 'orderedQuantity', 'allocatedProductQuantity');
  const state = {};
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(latest, field)) state[field] = latest[field];
  });
  return { ...base, ...state };
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
    if (preferred.visibility === 'deleted' || deal.visibility === 'deleted') {
      merged.set(deal.id, preferred.visibility === 'deleted' ? preferred : deal);
      return;
    }
    const preferredTime = dealTimestamp(preferred);
    const candidateTime = dealTimestamp(deal);
    const hasVersionedUpdate = Boolean(
      preferred?.updatedAt || preferred?.syncedAt || deal?.updatedAt || deal?.syncedAt,
    );
    let combined;
    // Group activity can replace updatedAt in public projections. It is not the
    // product revision: an older local timestamp must never roll publishVersion
    // back and cause the very first edit to submit a stale CAS token.
    const preferredVersion = Number(preferred.publishVersion || 0);
    const candidateVersion = Number(deal.publishVersion || 0);
    const preferCandidate = candidateVersion !== preferredVersion
      ? candidateVersion > preferredVersion
      : hasVersionedUpdate && candidateTime > preferredTime;
    if (preferCandidate) {
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
    merged.set(deal.id, withLatestGroupState(
      withAuthoritativeMerchantProgress(combined, [preferred, deal]), [preferred, deal],
    ));
  });
  return [...merged.values()].sort((left, right) => dealTimestamp(right) - dealTimestamp(left));
}

// Reconcile only records already held by this browser. Absence from a bounded
// public list is not proof of deletion and must never erase local history.
export function reconcilePublicDealCache(cachedDeals, centralDeals) {
  const centralById = new Map(mergeDeals(centralDeals).map((deal) => [deal.id, deal]));
  let changed = false;
  const next = cachedDeals.flatMap((cached) => {
    const central = centralById.get(cached.id);
    if (!central) return [cached];
    if (central.visibility === 'deleted') {
      changed = true;
      return [];
    }
    const merged = mergeDeals([cached], [central])[0];
    if (JSON.stringify(merged) === JSON.stringify(cached)) return [cached];
    changed = true;
    return [merged];
  });
  return changed ? next : cachedDeals;
}
