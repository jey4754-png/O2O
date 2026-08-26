const GROUP_CREDENTIALS_KEY = 'o2o_mvp_group_credentials_v1';
const GROUP_MEMBERSHIP_MUTATIONS_KEY = 'o2o_mvp_group_membership_mutations_v1';
const LOCAL_GROUPS_KEY = 'o2o_mvp_group_fallback_v1';
const GROUP_READ_KEY = 'o2o_mvp_group_last_read_v1';
const VITE_ENV = import.meta.env || {};
const LOCAL_FALLBACK_ENABLED = VITE_ENV.DEV
  || VITE_ENV.VITE_ENABLE_GROUP_LOCAL_FALLBACK === 'true';
const LOCAL_ADMIN_PIN = String(VITE_ENV.VITE_O2O_LOCAL_ADMIN_PIN || '');

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Keep the active session usable when private browsing blocks persistence.
  }
}

export function createMutationId(prefix = 'mutation') {
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${random}`;
}

function membershipMutationKey(action, groupId, actorId, role = '') {
  return `${action}::${groupId}::${actorId}::${role}`;
}

function getMembershipMutationId(action, groupId, actorId, role = '') {
  const mutations = loadJson(GROUP_MEMBERSHIP_MUTATIONS_KEY, {});
  const key = membershipMutationKey(action, groupId, actorId, role);
  if (!mutations[key]) {
    mutations[key] = createMutationId(action);
    saveJson(GROUP_MEMBERSHIP_MUTATIONS_KEY, mutations);
  }
  return mutations[key];
}

function clearMembershipMutationId(action, groupId, actorId, role = '') {
  const mutations = loadJson(GROUP_MEMBERSHIP_MUTATIONS_KEY, {});
  const key = membershipMutationKey(action, groupId, actorId, role);
  if (!(key in mutations)) return;
  delete mutations[key];
  saveJson(GROUP_MEMBERSHIP_MUTATIONS_KEY, mutations);
}

export function getGroupCredentials() {
  return loadJson(GROUP_CREDENTIALS_KEY, {});
}

function credentialStorageKey(groupId, actorId) {
  return actorId ? `${groupId}::${actorId}` : groupId;
}

export function getGroupCredential(groupId, actorId) {
  const credentials = getGroupCredentials();
  if (actorId) {
    return credentials[credentialStorageKey(groupId, actorId)]
      || (credentials[groupId]?.actorId === actorId ? credentials[groupId] : null);
  }
  if (credentials[groupId]) return credentials[groupId];
  return Object.values(credentials).find((credential) => credential?.groupId === groupId) || null;
}

function saveGroupCredential(groupId, credential) {
  const credentials = getGroupCredentials();
  const key = credentialStorageKey(groupId, credential.actorId);
  credentials[key] = { ...credentials[key], ...credential, groupId };
  if (credentials[groupId]?.actorId === credential.actorId) delete credentials[groupId];
  saveJson(GROUP_CREDENTIALS_KEY, credentials);
  return credentials[key];
}

export function getLastReadSeq(groupId) {
  return Number(loadJson(GROUP_READ_KEY, {})[groupId] || 0);
}

function saveLastReadSeq(groupId, sequence) {
  const reads = loadJson(GROUP_READ_KEY, {});
  reads[groupId] = Math.max(Number(reads[groupId] || 0), Number(sequence || 0));
  saveJson(GROUP_READ_KEY, reads);
}

export function resolveUnreadCount(snapshot = {}, localLastReadSeq = 0) {
  if (snapshot.unreadCount !== undefined && snapshot.unreadCount !== null) {
    const serverUnreadCount = Number(snapshot.unreadCount);
    return Number.isFinite(serverUnreadCount) ? Math.max(0, serverUnreadCount) : 0;
  }

  const lastSeq = Number(snapshot.lastSeq || 0);
  const localReadSeq = Number(localLastReadSeq || 0);
  return Math.max(
    0,
    (Number.isFinite(lastSeq) ? lastSeq : 0) - (Number.isFinite(localReadSeq) ? localReadSeq : 0),
  );
}

export function normalizeSnapshot(result, groupId) {
  const snapshot = result?.snapshot || result || {};
  const group = snapshot.group || snapshot.groupState || {};
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const participants = (Array.isArray(snapshot.participants) ? snapshot.participants : []).map((participant) => ({
    ...participant,
    selectedQuantity: Math.max(
      0,
      Number(participant.selectedQuantity ?? (participant.counted === false ? 0 : 1)),
    ),
    version: Number(participant.version || 1),
  }));
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  const lastSeq = Number(snapshot.lastSeq ?? messages.at(-1)?.seq ?? 0);
  const localLastRead = getLastReadSeq(groupId);
  const hostActorId = group.hostActorId || '';
  const hostMode = group.hostMode === 'recruiting' ? 'recruiting' : 'self';
  const totalQuantity = Math.max(1, Math.min(999, Number(group.totalQuantity || group.targetCount || 1)));
  const orderedQuantity = Number(group.orderedQuantity ?? participants
    .filter((item) => item.counted !== false)
    .reduce((total, item) => total + Number(item.selectedQuantity || 0), 0));
  return {
    ...snapshot,
    group: {
      ...group,
      id: group.id || group.groupId || groupId,
      groupId,
      status: group.status || group.groupStatus || 'recruiting',
      targetCount: Number(group.targetCount || group.target || 1),
      currentCount: Number(group.currentCount ?? group.participantCount ?? participants.filter((item) => item.counted !== false).length),
      chatLocked: Boolean(group.chatLocked),
      creatorActorId: group.creatorActorId || hostActorId,
      hostMode,
      hostActorId,
      hostMatched: Boolean(hostActorId),
      totalQuantity,
      orderedQuantity: Math.max(0, orderedQuantity),
      version: Number(group.version || 0),
      title: group.title || '',
    },
    messages,
    participants,
    history,
    lastSeq,
    unreadCount: resolveUnreadCount({ unreadCount: snapshot.unreadCount, lastSeq }, localLastRead),
  };
}

async function requestGroupOperation(payload, signal) {
  const response = await fetch('/api/group-ops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok || !result.ok) {
    const error = new Error(result.error || `group_api_${response.status}`);
    error.status = response.ok && !result.error ? 502 : response.status;
    error.snapshot = result.snapshot
      ? normalizeSnapshot({ snapshot: result.snapshot }, payload.groupId)
      : undefined;
    throw error;
  }
  return result;
}

function isFallbackEligible(error) {
  return LOCAL_FALLBACK_ENABLED
    && (!error?.status || [404, 502, 503, 504].includes(error.status));
}

function getLocalGroups() {
  return loadJson(LOCAL_GROUPS_KEY, {});
}

function saveLocalGroup(groupId, snapshot) {
  const groups = getLocalGroups();
  groups[groupId] = snapshot;
  saveJson(LOCAL_GROUPS_KEY, groups);
  window.dispatchEvent(new CustomEvent('o2o-group-fallback-updated', { detail: { groupId } }));
  return normalizeSnapshot(snapshot, groupId);
}

function localCredential(groupId, actorId, role) {
  const existing = getGroupCredential(groupId, actorId);
  if (existing) return existing;
  return saveGroupCredential(groupId, {
    actorId,
    role,
    capabilityToken: `local-${createMutationId('capability')}`,
  });
}

function initialLocalSnapshot({
  groupId,
  dealId,
  title,
  targetCount,
  totalQuantity,
  selectedQuantity,
  hostMode = 'self',
  actorId,
  nickname,
}) {
  const now = new Date().toISOString();
  const normalizedHostMode = hostMode === 'recruiting' ? 'recruiting' : 'self';
  const normalizedTotalQuantity = Math.max(1, Math.min(999, Number(totalQuantity || targetCount || 1)));
  const normalizedSelectedQuantity = Math.max(
    0,
    Math.min(normalizedTotalQuantity, Number(selectedQuantity ?? Math.min(1, normalizedTotalQuantity))),
  );
  const role = normalizedHostMode === 'recruiting' ? 'creator' : 'host';
  return {
    localOnly: true,
    group: {
      id: groupId,
      groupId,
      dealId: dealId || groupId,
      title,
      status: 'recruiting',
      targetCount: Math.min(20, Math.max(1, Number(targetCount || 1))),
      currentCount: 1,
      chatLocked: false,
      creatorActorId: actorId,
      hostMode: normalizedHostMode,
      hostActorId: normalizedHostMode === 'self' ? actorId : '',
      hostMatched: normalizedHostMode === 'self',
      totalQuantity: normalizedTotalQuantity,
      orderedQuantity: normalizedSelectedQuantity,
      version: 1,
      updatedAt: now,
    },
    participants: [{
      actorId,
      nickname,
      role,
      counted: true,
      paymentStatus: 'pending',
      selectedQuantity: normalizedSelectedQuantity,
      version: 1,
      joinedAt: now,
    }],
    messages: [],
    history: [{
      id: createMutationId('history'),
      entityType: 'group',
      entityId: groupId,
      fromStatus: '',
      toStatus: 'recruiting',
      action: 'create',
      actorId,
      actorRole: role,
      createdAt: now,
    }],
    lastSeq: 0,
  };
}

function localCreate(input) {
  const groups = getLocalGroups();
  const snapshot = groups[input.groupId] || initialLocalSnapshot(input);
  saveLocalGroup(input.groupId, snapshot);
  const role = snapshot.participants.find((item) => item.actorId === input.actorId)?.role
    || (input.hostMode === 'recruiting' ? 'creator' : 'host');
  const credential = localCredential(input.groupId, input.actorId, role);
  return { ok: true, capabilityToken: credential.capabilityToken, snapshot: normalizeSnapshot(snapshot, input.groupId), localOnly: true };
}

function localJoin(input) {
  const groups = getLocalGroups();
  const snapshot = groups[input.groupId];
  if (!snapshot) throw new Error('group_not_found');
  const role = input.role === 'admin' ? 'admin' : 'member';
  const counted = role !== 'admin' && input.counted !== false;
  if (role === 'admin' && (!LOCAL_ADMIN_PIN || input.adminPin !== LOCAL_ADMIN_PIN)) {
    throw new Error(LOCAL_ADMIN_PIN ? 'invalid_admin_pin' : 'admin_backend_required');
  }
  if (!snapshot.participants.some((item) => item.actorId === input.actorId)) {
    const currentCount = snapshot.participants.filter((item) => item.counted !== false).length;
    const selectedQuantity = counted ? Math.max(0, Number(input.selectedQuantity ?? 1)) : 0;
    const orderedQuantity = snapshot.participants
      .filter((item) => item.counted !== false)
      .reduce((total, item) => total + Number(item.selectedQuantity || 0), 0);
    if (counted && snapshot.group.status !== 'recruiting') throw new Error('group_not_recruiting');
    if (counted && (currentCount >= 20 || currentCount >= Number(snapshot.group.targetCount || 1))) {
      throw new Error('group_full');
    }
    if (orderedQuantity + selectedQuantity > Number(snapshot.group.totalQuantity || 1)) {
      throw new Error('quantity_exceeds_total');
    }
    snapshot.participants.push({
      actorId: input.actorId,
      nickname: input.nickname,
      role,
      counted,
      paymentStatus: 'pending',
      selectedQuantity,
      version: 1,
      joinedAt: new Date().toISOString(),
    });
    snapshot.group.currentCount = currentCount + (counted ? 1 : 0);
    snapshot.group.orderedQuantity = orderedQuantity + selectedQuantity;
    snapshot.group.version += 1;
    snapshot.history.push({
      id: createMutationId('history'),
      entityType: 'participant',
      entityId: input.actorId,
      fromStatus: '',
      toStatus: 'joined',
      action: 'join',
      actorId: input.actorId,
      actorRole: role,
      createdAt: new Date().toISOString(),
    });
  }
  saveLocalGroup(input.groupId, snapshot);
  const credential = localCredential(input.groupId, input.actorId, role);
  return { ok: true, capabilityToken: credential.capabilityToken, snapshot: normalizeSnapshot(snapshot, input.groupId), localOnly: true };
}

async function withFallback(remoteCall, fallbackCall) {
  try {
    return await remoteCall();
  } catch (error) {
    if (!isFallbackEligible(error)) throw error;
    return fallbackCall(error);
  }
}

function commonPayload(groupId, extras = {}) {
  const credential = getGroupCredential(groupId, extras.actorId) || {};
  return {
    ...extras,
    groupId,
    actorId: extras.actorId || credential.actorId,
    capabilityToken: extras.capabilityToken || credential.capabilityToken,
  };
}

export async function createGroupRoom({
  deal,
  actorId,
  nickname,
  hostMode = deal.hostMode || 'self',
  totalQuantity = deal.totalQuantity || deal.target || 1,
  selectedQuantity = deal.creatorQuantity ?? deal.selectedQuantity ?? 1,
}) {
  const normalizedHostMode = hostMode === 'recruiting' ? 'recruiting' : 'self';
  const input = {
    action: 'create',
    groupId: deal.id,
    dealId: deal.id,
    title: deal.title,
    targetCount: Number(deal.target || 1),
    totalQuantity: Number(totalQuantity),
    selectedQuantity: Number(selectedQuantity),
    hostMode: normalizedHostMode,
    actorId,
    nickname,
    clientMutationId: getMembershipMutationId('create', deal.id, actorId, normalizedHostMode),
  };
  const result = await withFallback(
    () => requestGroupOperation(input),
    () => localCreate(input),
  );
  const role = normalizedHostMode === 'recruiting' ? 'creator' : 'host';
  if (result.capabilityToken) {
    saveGroupCredential(deal.id, { actorId, role, capabilityToken: result.capabilityToken });
    clearMembershipMutationId('create', deal.id, actorId, normalizedHostMode);
  }
  return { ...result, snapshot: normalizeSnapshot(result, deal.id) };
}

export async function joinGroupRoom({
  deal,
  actorId,
  nickname,
  role = 'member',
  adminPin = '',
  selectedQuantity = role === 'admin' ? 0 : 1,
}) {
  const input = {
    action: 'join',
    groupId: deal.id,
    actorId,
    nickname,
    role,
    counted: role !== 'admin',
    selectedQuantity: Number(selectedQuantity),
    adminPin,
    clientMutationId: getMembershipMutationId('join', deal.id, actorId, role),
  };
  const result = await withFallback(
    () => requestGroupOperation(input),
    () => localJoin(input),
  );
  if (result.capabilityToken) {
    saveGroupCredential(deal.id, { actorId, role, capabilityToken: result.capabilityToken });
    clearMembershipMutationId('join', deal.id, actorId, role);
  }
  return { ...result, snapshot: normalizeSnapshot(result, deal.id) };
}

function localClaimHost(groupId, actorId) {
  const groups = getLocalGroups();
  const snapshot = groups[groupId];
  if (!snapshot) throw new Error('group_not_found');
  const credential = getGroupCredential(groupId, actorId);
  const participant = snapshot.participants.find((item) => item.actorId === actorId);
  if (!credential || !participant || participant.counted === false) throw new Error('forbidden');
  if (snapshot.group.hostActorId) {
    if (snapshot.group.hostActorId !== actorId || participant.role !== 'host') {
      throw new Error('host_already_claimed');
    }
    saveGroupCredential(groupId, { ...credential, actorId, role: 'host' });
    return normalizeSnapshot(snapshot, groupId);
  }
  if (snapshot.group.hostMode !== 'recruiting' || snapshot.group.status !== 'recruiting') {
    throw new Error('host_claim_closed');
  }
  if (!['creator', 'member'].includes(participant.role)) throw new Error('forbidden');
  const now = new Date().toISOString();
  const previousRole = participant.role;
  participant.role = 'host';
  participant.version = Number(participant.version || 1) + 1;
  participant.updatedAt = now;
  snapshot.group.hostActorId = actorId;
  snapshot.group.hostMatched = true;
  snapshot.group.version = Number(snapshot.group.version || 0) + 1;
  snapshot.group.updatedAt = now;
  snapshot.history.push({
    id: createMutationId('history'),
    entityType: 'host',
    entityId: actorId,
    fromStatus: previousRole,
    toStatus: 'host',
    action: 'claim_host',
    actorId,
    actorRole: previousRole,
    version: snapshot.group.version,
    createdAt: now,
  });
  saveGroupCredential(groupId, { ...credential, actorId, role: 'host' });
  return saveLocalGroup(groupId, snapshot);
}

export async function claimGroupHost({ deal, actorId, nickname }) {
  let credential = getGroupCredential(deal.id, actorId);
  if (!credential) {
    await joinGroupRoom({
      deal,
      actorId,
      nickname,
      role: 'member',
      selectedQuantity: 0,
    });
    credential = getGroupCredential(deal.id, actorId);
  }
  const payload = commonPayload(deal.id, {
    action: 'claim_host',
    actorId,
    clientMutationId: createMutationId('claim_host'),
  });
  const result = await withFallback(
    () => requestGroupOperation(payload),
    () => ({ ok: true, snapshot: localClaimHost(deal.id, actorId), localOnly: true }),
  );
  const snapshot = normalizeSnapshot(result, deal.id);
  if (snapshot.group.hostActorId === actorId) {
    saveGroupCredential(deal.id, {
      ...credential,
      actorId,
      role: 'host',
      capabilityToken: credential?.capabilityToken,
    });
  }
  return { ...result, snapshot };
}

export async function fetchGroupSnapshot(groupId, { signal, adminPin = '', actorId } = {}) {
  const payload = commonPayload(groupId, { action: 'snapshot', adminPin, actorId });
  return withFallback(
    async () => normalizeSnapshot(await requestGroupOperation(payload, signal), groupId),
    () => {
      const snapshot = getLocalGroups()[groupId];
      if (!snapshot) throw new Error('group_not_found');
      return normalizeSnapshot(snapshot, groupId);
    },
  );
}

function mutateLocal(groupId, actorId, mutation) {
  const groups = getLocalGroups();
  const snapshot = groups[groupId];
  if (!snapshot) throw new Error('group_not_found');
  const credential = getGroupCredential(groupId, actorId) || {};
  const actor = snapshot.participants.find((item) => item.actorId === credential.actorId);
  mutation(snapshot, actor, credential);
  snapshot.group.version = Number(snapshot.group.version || 0) + 1;
  snapshot.group.updatedAt = new Date().toISOString();
  return saveLocalGroup(groupId, snapshot);
}

function localReserveQuantity(groupId, actorId, quantity, expectedVersion, clientMutationId) {
  const groups = getLocalGroups();
  const snapshot = groups[groupId];
  if (!snapshot) throw new Error('group_not_found');
  if (snapshot.history.some((item) => (
    item.action === 'reserve_quantity'
    && item.actorId === actorId
    && item.clientMutationId === clientMutationId
  ))) return normalizeSnapshot(snapshot, groupId);
  const credential = getGroupCredential(groupId, actorId);
  const participant = snapshot.participants.find((item) => item.actorId === actorId);
  if (
    !credential
    || !participant
    || participant.counted === false
    || !['creator', 'host', 'member'].includes(participant.role)
  ) throw new Error('forbidden');
  if (snapshot.group.status !== 'recruiting') throw new Error('quantity_reservation_closed');
  if (Number(participant.version || 1) !== Number(expectedVersion)) throw new Error('state_conflict');
  const delta = Number(quantity);
  if (!Number.isInteger(delta) || delta < 1 || delta > 999) throw new Error('invalid_quantity');
  const orderedQuantity = snapshot.participants
    .filter((item) => item.counted !== false)
    .reduce((total, item) => total + Number(item.selectedQuantity || 0), 0);
  if (orderedQuantity + delta > Number(snapshot.group.totalQuantity || 1)) {
    throw new Error('quantity_exceeds_total');
  }
  const now = new Date().toISOString();
  const previous = Number(participant.selectedQuantity || 0);
  participant.selectedQuantity = previous + delta;
  participant.version = Number(participant.version || 1) + 1;
  participant.updatedAt = now;
  snapshot.group.orderedQuantity = orderedQuantity + delta;
  snapshot.group.updatedAt = now;
  snapshot.history.push({
    id: createMutationId('history'),
    entityType: 'quantity',
    entityId: actorId,
    fromStatus: String(previous),
    toStatus: String(participant.selectedQuantity),
    action: 'reserve_quantity',
    actorId,
    actorRole: participant.role,
    clientMutationId,
    version: participant.version,
    createdAt: now,
  });
  return saveLocalGroup(groupId, snapshot);
}

export async function reserveGroupQuantity(
  groupId,
  quantity,
  actorId,
  clientMutationId = createMutationId('reserve_quantity'),
) {
  const delta = Number(quantity);
  if (!Number.isInteger(delta) || delta < 1 || delta > 999) throw new Error('invalid_quantity');
  const snapshot = await fetchGroupSnapshot(groupId, { actorId });
  const participant = snapshot.participants.find((item) => item.actorId === actorId);
  if (!participant) throw new Error('participant_not_found');
  const expectedVersion = Number(participant.version || 0);
  const payload = commonPayload(groupId, {
    action: 'reserve_quantity',
    actorId,
    quantity: delta,
    expectedVersion,
    clientMutationId,
  });
  const result = await withFallback(
    () => requestGroupOperation(payload),
    () => ({
      ok: true,
      snapshot: localReserveQuantity(groupId, actorId, delta, expectedVersion, clientMutationId),
      localOnly: true,
    }),
  );
  return { ...result, snapshot: normalizeSnapshot(result, groupId) };
}

export async function sendGroupMessage(groupId, body, actorId) {
  const text = String(body || '').trim().slice(0, 500);
  if (!text) throw new Error('empty_message');
  const payload = commonPayload(groupId, {
    action: 'send_message',
    actorId,
    body: text,
    clientMutationId: createMutationId('message'),
  });
  const result = await withFallback(
    () => requestGroupOperation(payload),
    () => ({
      ok: true,
      snapshot: mutateLocal(groupId, actorId, (snapshot, actor) => {
        if (!actor) throw new Error('not_a_participant');
        if (snapshot.group.chatLocked && !['host', 'admin'].includes(actor.role)) throw new Error('chat_locked');
        const seq = Number(snapshot.lastSeq || 0) + 1;
        snapshot.lastSeq = seq;
        snapshot.messages.push({
          id: payload.clientMutationId,
          messageId: payload.clientMutationId,
          seq,
          actorId: actor.actorId,
          nickname: actor.nickname,
          role: actor.role,
          body: text,
          createdAt: new Date().toISOString(),
        });
        snapshot.messages = snapshot.messages.slice(-100);
      }),
      localOnly: true,
    }),
  );
  return { ...result, snapshot: normalizeSnapshot(result, groupId) };
}

export async function markGroupRead(groupId, lastReadSeq, actorId) {
  const payload = commonPayload(groupId, {
    action: 'mark_read',
    actorId,
    lastReadSeq: Number(lastReadSeq || 0),
    clientMutationId: createMutationId('read'),
  });
  try {
    await requestGroupOperation(payload);
    saveLastReadSeq(groupId, lastReadSeq);
  } catch (error) {
    if (!isFallbackEligible(error)) throw error;
    saveLastReadSeq(groupId, lastReadSeq);
  }
}

async function mutateGroup(groupId, actorId, action, extras, localMutation) {
  const snapshot = await fetchGroupSnapshot(groupId, { actorId });
  const participantVersion = action === 'transition_payment'
    ? snapshot.participants.find((item) => item.actorId === extras.participantActorId)?.version
    : null;
  const payload = commonPayload(groupId, {
    action,
    actorId,
    expectedVersion: Number(participantVersion ?? snapshot.group.version ?? 0),
    clientMutationId: createMutationId(action),
    ...extras,
  });
  const result = await withFallback(
    () => requestGroupOperation(payload),
    () => ({ ok: true, snapshot: mutateLocal(groupId, actorId, localMutation), localOnly: true }),
  );
  return { ...result, snapshot: normalizeSnapshot(result, groupId) };
}

export function transitionGroupStatus(groupId, direction, actorId) {
  const states = ['recruiting', 'recruited', 'purchased', 'delivered'];
  return mutateGroup(groupId, actorId, 'transition_group', { direction }, (snapshot, actor) => {
    if (!actor || !['host', 'admin'].includes(actor.role)) throw new Error('forbidden');
    const from = snapshot.group.status || 'recruiting';
    const index = states.indexOf(from);
    const offset = direction === 'previous' ? -1 : 1;
    const to = states[Math.min(states.length - 1, Math.max(0, index + offset))];
    if (to === from) throw new Error('invalid_transition');
    snapshot.group.status = to;
    snapshot.history.push({
      id: createMutationId('history'), entityType: 'group', entityId: groupId,
      fromStatus: from, toStatus: to, actorId: actor.actorId, actorRole: actor.role,
      createdAt: new Date().toISOString(),
    });
  });
}

export function transitionParticipantPayment(groupId, participantActorId, direction, actorId) {
  const states = ['pending', 'requested', 'confirmed'];
  return mutateGroup(groupId, actorId, 'transition_payment', { participantActorId, direction }, (snapshot, actor) => {
    const participant = snapshot.participants.find((item) => item.actorId === participantActorId);
    if (!actor || !participant) throw new Error('participant_not_found');
    const from = participant.paymentStatus || 'pending';
    const index = states.indexOf(from);
    const offset = direction === 'previous' ? -1 : 1;
    const to = states[Math.min(states.length - 1, Math.max(0, index + offset))];
    const isSelfRequest = actor.actorId === participantActorId
      && ((from === 'pending' && to === 'requested') || (from === 'requested' && to === 'pending'));
    const isOperator = ['host', 'admin'].includes(actor.role)
      && ((from === 'requested' && to === 'confirmed') || (from === 'confirmed' && to === 'requested'));
    if (!isSelfRequest && !isOperator) throw new Error('forbidden');
    participant.paymentStatus = to;
    snapshot.history.push({
      id: createMutationId('history'), entityType: 'payment', entityId: participantActorId,
      fromStatus: from, toStatus: to, actorId: actor.actorId, actorRole: actor.role,
      createdAt: new Date().toISOString(),
    });
  });
}

export function updateGroupTarget(groupId, targetCount, actorId, expectedVersion) {
  return mutateGroup(groupId, actorId, 'update_target', {
    targetCount: Number(targetCount),
    ...(Number.isInteger(Number(expectedVersion)) && Number(expectedVersion) > 0
      ? { expectedVersion: Number(expectedVersion) }
      : {}),
  }, (snapshot, actor) => {
    if (!actor || !['creator', 'host', 'admin'].includes(actor.role)) throw new Error('forbidden');
    const next = Number(targetCount);
    if (!Number.isInteger(next) || next < snapshot.group.currentCount || next > 20) throw new Error('invalid_target');
    if (['purchased', 'delivered'].includes(snapshot.group.status)) throw new Error('target_locked');
    const previous = snapshot.group.targetCount;
    snapshot.group.targetCount = next;
    snapshot.history.push({
      id: createMutationId('history'), entityType: 'target', entityId: groupId,
      fromStatus: String(previous), toStatus: String(next), actorId: actor.actorId,
      actorRole: actor.role, createdAt: new Date().toISOString(),
    });
  });
}

export function setGroupChatLocked(groupId, locked, actorId) {
  return mutateGroup(groupId, actorId, 'toggle_lock', { locked: Boolean(locked) }, (snapshot, actor) => {
    if (!actor || !['host', 'admin'].includes(actor.role)) throw new Error('forbidden');
    const previous = Boolean(snapshot.group.chatLocked);
    snapshot.group.chatLocked = Boolean(locked);
    snapshot.history.push({
      id: createMutationId('history'), entityType: 'chat_lock', entityId: groupId,
      fromStatus: String(previous), toStatus: String(Boolean(locked)), actorId: actor.actorId,
      actorRole: actor.role, createdAt: new Date().toISOString(),
    });
  });
}

export async function fetchUnreadCounts({ adminMode = false } = {}) {
  const entries = Object.entries(getGroupCredentials())
    .map(([storageKey, credential]) => ({
      groupId: credential?.groupId || storageKey.split('::')[0],
      credential,
    }))
    .filter(({ credential }) => Boolean(credential?.actorId && credential?.capabilityToken))
    .filter(({ credential }) => (adminMode ? credential.role === 'admin' : credential.role !== 'admin'));
  const snapshots = await Promise.all(entries.map(async ({ groupId, credential }) => {
    try {
      return [groupId, await fetchGroupSnapshot(groupId, { actorId: credential.actorId })];
    } catch {
      return [groupId, null];
    }
  }));
  return Object.fromEntries(snapshots.map(([groupId, snapshot]) => [
    groupId,
    snapshot ? resolveUnreadCount(snapshot, getLastReadSeq(groupId)) : 0,
  ]));
}
