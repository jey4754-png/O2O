import { canonicalOrderVersion } from './orderMerge.js';
import { isCanonicalLegacyReceiptId } from './legacyGroupReceipt.js';
import { runCentralMutation } from './centralMutationQueue.js';

const GROUP_CREDENTIALS_KEY = 'o2o_mvp_group_credentials_v1';
const GROUP_MEMBERSHIP_MUTATIONS_KEY = 'o2o_mvp_group_membership_mutations_v1';
const GROUP_TRANSITION_MUTATIONS_KEY = 'o2o_mvp_group_transition_mutations_v1';
const LOCAL_GROUPS_KEY = 'o2o_mvp_group_fallback_v1';
const GROUP_READ_KEY = 'o2o_mvp_group_last_read_v1';
const MUTATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const VITE_ENV = import.meta.env || {};
const LOCAL_ADMIN_PIN = String(VITE_ENV.VITE_O2O_LOCAL_ADMIN_PIN || '');
const MEMORY_MIRROR_KEYS = new Set([
  GROUP_CREDENTIALS_KEY,
  GROUP_MEMBERSHIP_MUTATIONS_KEY,
  GROUP_TRANSITION_MUTATIONS_KEY,
]);
const memoryJsonMirrors = new Map();
const GROUP_TRANSITION_STATES = ['recruiting', 'recruited', 'purchased', 'delivered'];
const PAYMENT_TRANSITION_STATES = ['pending', 'requested', 'confirmed'];

function localFallbackEnabled() {
  return Boolean(
    VITE_ENV.DEV
    || VITE_ENV.VITE_ENABLE_GROUP_LOCAL_FALLBACK === 'true'
    || (typeof process !== 'undefined'
      && process.env?.VITE_ENABLE_GROUP_LOCAL_FALLBACK === 'true'),
  );
}

function loadJson(key, fallback) {
  const storage = globalThis.localStorage;
  const storedMirror = memoryJsonMirrors.get(key);
  const mirror = storedMirror?.storage === storage ? storedMirror : null;
  try {
    if (mirror?.dirty) return JSON.parse(JSON.stringify(mirror.value));
    const value = JSON.parse(storage.getItem(key) || JSON.stringify(fallback));
    if (MEMORY_MIRROR_KEYS.has(key)) {
      memoryJsonMirrors.set(key, { value, dirty: false, storage });
    }
    return value;
  } catch {
    if (mirror) return JSON.parse(JSON.stringify(mirror.value));
    return fallback;
  }
}

function saveJson(key, value) {
  const mirrored = MEMORY_MIRROR_KEYS.has(key);
  const storage = globalThis.localStorage;
  if (mirrored) {
    memoryJsonMirrors.set(key, {
      value: JSON.parse(JSON.stringify(value)),
      dirty: true,
      storage,
    });
  }
  try {
    storage.setItem(key, JSON.stringify(value));
    if (mirrored) {
      memoryJsonMirrors.set(key, {
        value: JSON.parse(JSON.stringify(value)),
        dirty: false,
        storage,
      });
    }
  } catch {
    // Keep the active session usable when private browsing blocks persistence.
  }
}

export function createMutationId(prefix = 'mutation') {
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${random}`;
}

export function isGroupBackedDeal(deal = {}) {
  return deal.source === 'customer'
    || (deal.source === 'merchant' && deal.saleType === 'group');
}

function membershipMutationKey(action, groupId, actorId, role = '') {
  return `${action}::${groupId}::${actorId}::${role}`;
}

function createCapabilityToken() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('secure_random_unavailable');
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `group-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function getMembershipAttempt(
  action,
  groupId,
  actorId,
  role = '',
  requestedMutationId = '',
  requestedContract = {},
) {
  const mutations = loadJson(GROUP_MEMBERSHIP_MUTATIONS_KEY, {});
  const key = membershipMutationKey(action, groupId, actorId, role);
  const stored = typeof mutations[key] === 'string'
    ? { clientMutationId: mutations[key] }
    : (mutations[key] || {});
  const contract = JSON.stringify(requestedContract || {});
  const existingCredential = getGroupCredential(groupId, actorId);
  // A reload creates a fresh component-level mutation id. If the previous
  // membership request committed but its response was lost, replacing that id
  // (and its capability) makes every later retry look like a different actor
  // trying to join an existing participant. Resume the persisted attempt when
  // its request contract still matches. Legacy attempts did not store a
  // contract, so resume them once and persist the contract now.
  const canResumeStored = Boolean(
    stored.clientMutationId
    && (!stored.contract || stored.contract === contract),
  );
  const clientMutationId = canResumeStored
    ? stored.clientMutationId
    : (requestedMutationId || createMutationId(action));
  const attempt = canResumeStored
    ? stored
    : {};
  if (!attempt.capabilityToken || attempt.capabilityToken.length < 32) {
    attempt.capabilityToken = existingCredential?.capabilityToken || createCapabilityToken();
  }
  attempt.clientMutationId = clientMutationId;
  attempt.contract = contract;
  if (mutations[key]?.clientMutationId !== attempt.clientMutationId
    || mutations[key]?.capabilityToken !== attempt.capabilityToken
    || mutations[key]?.contract !== attempt.contract) {
    mutations[key] = attempt;
    saveJson(GROUP_MEMBERSHIP_MUTATIONS_KEY, mutations);
  }
  return attempt;
}

function clearMembershipAttempt(action, groupId, actorId, role = '', clientMutationId = '') {
  const mutations = loadJson(GROUP_MEMBERSHIP_MUTATIONS_KEY, {});
  const key = membershipMutationKey(action, groupId, actorId, role);
  if (!(key in mutations)) return;
  const storedMutationId = typeof mutations[key] === 'string'
    ? mutations[key]
    : mutations[key]?.clientMutationId;
  if (clientMutationId && storedMutationId && storedMutationId !== clientMutationId) return;
  delete mutations[key];
  saveJson(GROUP_MEMBERSHIP_MUTATIONS_KEY, mutations);
}

function transitionMutationKey(action, groupId, actorId, participantActorId = '') {
  return `${action}::${groupId}::${actorId}::${participantActorId}`;
}

function storedTransitionAttempt(action, groupId, actorId, participantActorId = '') {
  const attempts = loadJson(GROUP_TRANSITION_MUTATIONS_KEY, {});
  return attempts[transitionMutationKey(action, groupId, actorId, participantActorId)] || null;
}

function saveTransitionAttempt(intent) {
  const attempts = loadJson(GROUP_TRANSITION_MUTATIONS_KEY, {});
  const key = transitionMutationKey(
    intent.action,
    intent.groupId,
    intent.actorId,
    intent.participantActorId,
  );
  attempts[key] = intent;
  saveJson(GROUP_TRANSITION_MUTATIONS_KEY, attempts);
  return intent;
}

function clearTransitionAttempt(intent) {
  if (!intent?.clientMutationId) return;
  const attempts = loadJson(GROUP_TRANSITION_MUTATIONS_KEY, {});
  const key = transitionMutationKey(
    intent.action,
    intent.groupId,
    intent.actorId,
    intent.participantActorId,
  );
  if (attempts[key]?.clientMutationId !== intent.clientMutationId) return;
  delete attempts[key];
  saveJson(GROUP_TRANSITION_MUTATIONS_KEY, attempts);
}

function shouldRetainTransitionAttempt(error = {}) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || error?.message || '');
  return !status
    || [408, 425, 429, 500, 502, 503, 504].includes(status)
    || ['collector_busy', 'upstream_timeout'].includes(code);
}

export function getPendingGroupTransition(groupId, actorId) {
  const attempts = loadJson(GROUP_TRANSITION_MUTATIONS_KEY, {});
  return Object.values(attempts).find((intent) => (
    intent?.groupId === groupId
    && intent?.actorId === actorId
    && ['transition_group', 'transition_payment'].includes(intent?.action)
  )) || null;
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
  const previousRevision = Number(credentials[key]?.credentialRevision || 0);
  credentials[key] = {
    ...credentials[key],
    ...credential,
    groupId,
    credentialRevision: previousRevision + 1,
  };
  if (credentials[groupId]?.actorId === credential.actorId) delete credentials[groupId];
  saveJson(GROUP_CREDENTIALS_KEY, credentials);
  return credentials[key];
}

function isGroupNotFoundError(error) {
  return String(error?.code || error?.message || '') === 'group_not_found';
}

function deactivateMissingGroupCredential(
  groupId,
  actorId,
  expectedCapabilityToken,
  expectedCredentialRevision,
) {
  const credential = getGroupCredential(groupId, actorId);
  if (!credential) return;
  if (
    expectedCapabilityToken
    && credential.capabilityToken !== expectedCapabilityToken
  ) return;
  if (Number(credential.credentialRevision || 0) !== expectedCredentialRevision) return;
  saveGroupCredential(groupId, {
    ...credential,
    actorId: credential.actorId || actorId,
    active: false,
  });
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

export function groupOperationRetryCount(error = {}) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || error?.message || '');
  if ([408, 425].includes(status)) return 2;
  if (status === 429) return 3;
  if (status >= 400 && status < 500) return 0;
  if (status === 503 || code === 'collector_busy') return 3;
  if ([500, 502, 504].includes(status) || code === 'upstream_timeout') return 2;
  if (!status && error?.name === 'TypeError') return 2;
  return 0;
}

function waitForRetry(delayMs, signal) {
  const abortError = () => signal?.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' });
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

async function performGroupOperationRequest(payload, signal, assertCurrentContext) {
  // Freeze the request body once so retries cannot accidentally change the
  // mutation identity or reserved quantity across an async backoff boundary.
  const body = JSON.stringify(payload);
  let attempt = 0;
  while (true) {
    try {
      assertCurrentContext?.();
      const response = await fetch('/api/group-ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
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
        error.code = result.error || `group_api_${response.status}`;
        error.status = response.ok && !result.error ? 502 : response.status;
        error.snapshot = result.snapshot
          ? normalizeSnapshot({ snapshot: result.snapshot }, payload.groupId)
          : undefined;
        throw error;
      }
      return result;
    } catch (error) {
      const retryCount = groupOperationRetryCount(error);
      if (signal?.aborted || attempt >= retryCount) throw error;
      const delay = Math.min(2400, 350 * (2 ** attempt)) + Math.floor(Math.random() * 180);
      attempt += 1;
      await waitForRetry(delay, signal);
    }
  }
}

function requestGroupOperation(payload, signal, assertCurrentContext) {
  if (payload?.action === 'snapshot') {
    return performGroupOperationRequest(payload, signal, assertCurrentContext);
  }

  return runCentralMutation(
    () => performGroupOperationRequest(payload, signal, assertCurrentContext),
    { priority: payload?.action === 'mark_read' ? 'background' : 'foreground' },
  );
}

function isFallbackEligible(error) {
  return localFallbackEnabled()
    && (!error?.status || [404, 502, 503, 504].includes(error.status));
}

function getLocalGroups() {
  return loadJson(LOCAL_GROUPS_KEY, {});
}

function legacyCustomerGroupRecoveryContext(deal, actorId) {
  if (
    !deal
    || typeof deal !== 'object'
    || Array.isArray(deal)
    || deal.source !== 'customer'
    || typeof deal.id !== 'string'
    || !deal.id.startsWith('customer-')
    || (deal.groupId || deal.id) !== deal.id
    || typeof actorId !== 'string'
    || !actorId
  ) return null;

  const credential = getGroupCredential(deal.id, actorId);
  if (
    !credential
    || credential.groupId !== deal.id
    || credential.actorId !== actorId
    || !['creator', 'host'].includes(credential.role)
    || typeof credential.capabilityToken !== 'string'
    || credential.capabilityToken.length < 32
  ) return null;

  const groups = getLocalGroups();
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return null;
  const snapshot = groups[deal.id];
  const group = snapshot?.group;
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || !group
    || typeof group !== 'object'
    || Array.isArray(group)
    || group.groupId !== deal.id
    || group.dealId !== deal.id
    || group.creatorActorId !== actorId
    || !Array.isArray(snapshot.participants)
  ) return null;

  const participant = snapshot.participants.find((item) => item?.actorId === actorId);
  if (
    !participant
    || participant.counted === false
    || participant.role !== credential.role
    || !['creator', 'host'].includes(participant.role)
  ) return null;
  if (participant.role === 'host' && group.hostActorId !== actorId) return null;
  if (participant.role === 'creator' && group.hostMode !== 'recruiting') return null;

  return { credential, participant, snapshot };
}

export function hasLegacyCustomerGroupRecoveryState(deal, actorId) {
  return Boolean(legacyCustomerGroupRecoveryContext(deal, actorId));
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

function initialLocalMerchantSnapshot(deal, groupId) {
  const now = new Date().toISOString();
  const totalQuantity = Math.max(1, Math.min(999, Number(
    deal.totalQuantity || deal.productQuantity || deal.target || 1,
  )));
  const targetCount = Math.max(1, Math.min(20, Number(
    deal.targetCount || deal.maxPeople || Math.min(totalQuantity, 20),
  )));
  return {
    localOnly: true,
    group: {
      id: groupId,
      groupId,
      dealId: groupId,
      title: deal.title || '',
      status: 'recruiting',
      targetCount,
      currentCount: 0,
      chatLocked: false,
      creatorActorId: deal.creatorActorId || `merchant-${groupId}`,
      hostMode: 'recruiting',
      hostActorId: '',
      hostMatched: false,
      totalQuantity,
      orderedQuantity: 0,
      version: 1,
      updatedAt: now,
    },
    participants: [],
    messages: [],
    history: [{
      id: createMutationId('history'),
      entityType: 'group',
      entityId: groupId,
      fromStatus: '',
      toStatus: 'recruiting',
      action: 'merchant_group_provisioned',
      actorId: deal.creatorActorId || `merchant-${groupId}`,
      actorRole: 'creator',
      createdAt: now,
    }],
    lastSeq: 0,
  };
}

function localJoin(input, deal = {}) {
  const groups = getLocalGroups();
  const snapshot = groups[input.groupId]
    || (isGroupBackedDeal(deal) && deal.source === 'merchant'
      ? initialLocalMerchantSnapshot(deal, input.groupId)
      : null);
  if (!snapshot) throw new Error('group_not_found');
  const role = input.role === 'admin' ? 'admin' : 'member';
  const counted = role !== 'admin' && input.counted !== false;
  if (role === 'admin' && (!LOCAL_ADMIN_PIN || input.adminPin !== LOCAL_ADMIN_PIN)) {
    throw new Error(LOCAL_ADMIN_PIN ? 'invalid_admin_pin' : 'admin_backend_required');
  }
  if (!snapshot.participants.some((item) => item.actorId === input.actorId)) {
    const currentCount = snapshot.participants.filter((item) => item.counted !== false).length;
    const selectedQuantity = counted ? Number(input.selectedQuantity ?? 1) : 0;
    if (counted && (!Number.isInteger(selectedQuantity) || selectedQuantity < 1 || selectedQuantity > 999)) {
      throw new Error('invalid_quantity');
    }
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
      clientMutationId: input.clientMutationId,
      reservationQuantity: selectedQuantity,
      result: {
        reservationQuantity: selectedQuantity,
        mutationContract: JSON.stringify({
          action: 'join',
          groupId: input.groupId,
          actorId: input.actorId,
          nickname: input.nickname,
          requestedRole: role,
          selectedQuantity,
        }),
      },
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
  clientMutationId = '',
  allowLocalFallback = true,
}) {
  const normalizedHostMode = hostMode === 'recruiting' ? 'recruiting' : 'self';
  const membershipAttempt = getMembershipAttempt(
    'create',
    deal.id,
    actorId,
    normalizedHostMode,
    clientMutationId,
    {
      dealId: deal.id,
      title: deal.title,
      nickname,
      targetCount: Number(deal.target || 1),
      hostMode: normalizedHostMode,
      totalQuantity: Number(totalQuantity),
      selectedQuantity: Number(selectedQuantity),
    },
  );
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
    clientMutationId: membershipAttempt.clientMutationId,
    capabilityToken: membershipAttempt.capabilityToken,
  };
  const result = allowLocalFallback
    ? await withFallback(
        () => requestGroupOperation(input),
        () => localCreate(input),
      )
    : await requestGroupOperation(input);
  const role = normalizedHostMode === 'recruiting' ? 'creator' : 'host';
  if (result.capabilityToken) {
    saveGroupCredential(deal.id, {
      actorId,
      role,
      active: true,
      capabilityToken: result.capabilityToken,
    });
    clearMembershipAttempt(
      'create',
      deal.id,
      actorId,
      normalizedHostMode,
      membershipAttempt.clientMutationId,
    );
  }
  return { ...result, snapshot: normalizeSnapshot(result, deal.id) };
}

export async function repairCustomerGroupRoom({
  deal,
  actorId,
  nickname,
  ownerCapabilityToken,
  hostMode = deal.hostMode || 'self',
  totalQuantity = deal.totalQuantity || deal.target || 1,
  selectedQuantity = deal.creatorQuantity ?? deal.selectedQuantity ?? 1,
  clientMutationId = '',
}) {
  if (!ownerCapabilityToken || String(ownerCapabilityToken).length < 32) {
    throw new Error('missing_owner_capability_token');
  }
  const savedCredential = getGroupCredential(deal.id, actorId);
  if (!savedCredential?.capabilityToken || String(savedCredential.capabilityToken).length < 32) {
    throw new Error('missing_group_capability_token');
  }
  const normalizedHostMode = hostMode === 'recruiting' ? 'recruiting' : 'self';
  const membershipAttempt = getMembershipAttempt(
    'repair_customer_group',
    deal.id,
    actorId,
    normalizedHostMode,
    clientMutationId,
    {
      dealId: deal.id,
      title: deal.title,
      nickname,
      targetCount: Number(deal.target || 1),
      hostMode: normalizedHostMode,
      totalQuantity: Number(totalQuantity),
      selectedQuantity: Number(selectedQuantity),
    },
  );
  const result = await requestGroupOperation({
    action: 'repair_customer_group',
    groupId: deal.id,
    dealId: deal.id,
    title: deal.title,
    targetCount: Number(deal.target || 1),
    totalQuantity: Number(totalQuantity),
    selectedQuantity: Number(selectedQuantity),
    hostMode: normalizedHostMode,
    actorId,
    nickname,
    clientMutationId: membershipAttempt.clientMutationId,
    capabilityToken: membershipAttempt.capabilityToken,
    ownerCapabilityToken,
  });
  const role = normalizedHostMode === 'recruiting' ? 'creator' : 'host';
  if (result.capabilityToken) {
    saveGroupCredential(deal.id, {
      actorId,
      role,
      active: true,
      capabilityToken: result.capabilityToken,
    });
    clearMembershipAttempt(
      'repair_customer_group',
      deal.id,
      actorId,
      normalizedHostMode,
      membershipAttempt.clientMutationId,
    );
  }
  return { ...result, snapshot: normalizeSnapshot(result, deal.id) };
}

export async function recoverLegacyCustomerGroupRoom({
  deal,
  actorId,
  nickname,
  legacyEventId,
}) {
  const recoveryContext = legacyCustomerGroupRecoveryContext(deal, actorId);
  if (
    !recoveryContext
    || typeof nickname !== 'string'
    || !nickname
    || !isCanonicalLegacyReceiptId(legacyEventId)
  ) {
    const error = new Error('legacy_recovery_not_authorized');
    error.code = 'legacy_recovery_not_authorized';
    throw error;
  }

  const result = await requestGroupOperation({
    action: 'recover_legacy_customer_group',
    groupId: deal.id,
    dealId: deal.id,
    actorId,
    nickname,
    capabilityToken: recoveryContext.credential.capabilityToken,
    legacyEventId,
  });
  const snapshot = normalizeSnapshot(result, deal.id);
  const recoveredParticipant = snapshot.participants.find((item) => item.actorId === actorId);
  const recoveredRole = ['creator', 'host'].includes(recoveredParticipant?.role)
    ? recoveredParticipant.role
    : recoveryContext.credential.role;
  saveGroupCredential(deal.id, {
    ...recoveryContext.credential,
    actorId,
    role: recoveredRole,
    active: true,
    capabilityToken: result.capabilityToken || recoveryContext.credential.capabilityToken,
  });
  return { ...result, snapshot };
}

export async function joinGroupRoom({
  deal,
  actorId,
  nickname,
  role = 'member',
  adminPin = '',
  selectedQuantity = role === 'admin' ? 0 : 1,
  clientMutationId = '',
  allowLocalFallback = true,
}) {
  const membershipAttempt = getMembershipAttempt(
    'join',
    deal.id,
    actorId,
    role,
    clientMutationId,
    {
      nickname,
      requestedRole: role === 'admin' ? 'admin' : 'member',
      selectedQuantity: Number(selectedQuantity),
    },
  );
  const membershipMutationId = membershipAttempt.clientMutationId;
  const input = {
    action: 'join',
    groupId: deal.id,
    actorId,
    nickname,
    role,
    counted: role !== 'admin',
    selectedQuantity: Number(selectedQuantity),
    adminPin,
    clientMutationId: membershipMutationId,
    capabilityToken: membershipAttempt.capabilityToken,
  };
  const result = allowLocalFallback
    ? await withFallback(
        () => requestGroupOperation(input),
        () => localJoin(input, deal),
      )
    : await requestGroupOperation(input);
  if (result.capabilityToken) {
    saveGroupCredential(deal.id, {
      actorId,
      role,
      active: role === 'admin' || Number(selectedQuantity) > 0,
      capabilityToken: result.capabilityToken,
      ...(clientMutationId && Number(selectedQuantity) > 0
        ? {
            reservationMutationId: clientMutationId,
            reservationAction: 'join',
            reservationQuantity: Number(selectedQuantity),
          }
        : {}),
    });
    clearMembershipAttempt('join', deal.id, actorId, role, membershipMutationId);
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
  if ((participant.paymentStatus || 'pending') !== 'pending') {
    throw new Error('host_role_payment_locked');
  }
  if (!['creator', 'member'].includes(participant.role)) throw new Error('forbidden');
  if (participant.role === 'member' && Number(participant.selectedQuantity || 0) <= 0) {
    throw new Error('host_order_required');
  }
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

export async function claimGroupHost({ deal, actorId }) {
  const credential = getGroupCredential(deal.id, actorId);
  if (!credential) throw new Error('host_order_required');
  const payload = commonPayload(deal.id, {
    action: 'claim_host',
    actorId,
    clientMutationId: createMutationId('claim_host'),
  });
  // Host assignment changes the canonical order amount when a split remainder
  // exists. Never acknowledge a device-only role change that the order backend
  // did not commit atomically.
  const result = await requestGroupOperation(payload);
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

export async function releaseGroupHost({ deal, actorId }) {
  const credential = getGroupCredential(deal.id, actorId);
  if (!credential) throw new Error('forbidden');
  const result = await mutateGroup(
    deal.id,
    actorId,
    'release_host',
    {},
    (snapshot, actor, localCredentialValue) => {
      if (!actor || actor.role !== 'host' || snapshot.group.hostActorId !== actorId) {
        throw new Error('forbidden');
      }
      if (snapshot.group.hostMode !== 'recruiting' || snapshot.group.status !== 'recruiting') {
        throw new Error('host_release_closed');
      }
      if ((actor.paymentStatus || 'pending') !== 'pending') {
        throw new Error('host_role_payment_locked');
      }
      const nextRole = snapshot.group.creatorActorId === actorId ? 'creator' : 'member';
      actor.role = nextRole;
      actor.version = Number(actor.version || 1) + 1;
      actor.updatedAt = new Date().toISOString();
      snapshot.group.hostActorId = '';
      snapshot.group.hostMatched = false;
      snapshot.history.push({
        id: createMutationId('history'),
        entityType: 'host',
        entityId: actorId,
        fromStatus: 'host',
        toStatus: nextRole,
        action: 'release_host',
        actorId,
        actorRole: 'host',
        createdAt: new Date().toISOString(),
      });
      saveGroupCredential(deal.id, {
        ...localCredentialValue,
        actorId,
        role: nextRole,
        active: true,
      });
    },
    { allowLocalFallback: false },
  );
  const snapshot = normalizeSnapshot(result, deal.id);
  const participant = snapshot.participants.find((item) => item.actorId === actorId);
  if (participant && participant.role !== 'host') {
    saveGroupCredential(deal.id, {
      ...credential,
      actorId,
      role: participant.role,
      active: participant.counted !== false,
    });
  }
  return { ...result, snapshot };
}

export async function fetchGroupSnapshot(
  groupId,
  { signal, adminPin = '', actorId, allowLocalFallback = true } = {},
) {
  const credentialAtRequestStart = getGroupCredential(groupId, actorId);
  const credentialRevisionAtRequestStart = Number(
    credentialAtRequestStart?.credentialRevision || 0,
  );
  const payload = commonPayload(groupId, { action: 'snapshot', adminPin, actorId });
  let remoteGroupMissing = false;
  const remoteCall = async () => {
    try {
      const normalized = normalizeSnapshot(await requestGroupOperation(payload, signal), groupId);
      const credential = getGroupCredential(groupId, actorId);
      if (credential) {
        const viewer = normalized.participants.find((item) => item.actorId === actorId);
        saveGroupCredential(groupId, {
          ...credential,
          actorId,
          active: credential.role === 'admin'
            ? true
            : Boolean(normalized.viewer?.active !== false && viewer && viewer.counted !== false),
        });
      }
      return normalized;
    } catch (error) {
      remoteGroupMissing = error?.status === 404 && isGroupNotFoundError(error);
      throw error;
    }
  };
  if (!allowLocalFallback) return remoteCall();
  try {
    return await withFallback(remoteCall, () => {
      const snapshot = getLocalGroups()[groupId];
      if (!snapshot) throw new Error('group_not_found');
      const normalized = {
        ...normalizeSnapshot(snapshot, groupId),
        localOnly: true,
        ...(remoteGroupMissing ? { centralGroupMissing: true } : {}),
      };
      const credential = getGroupCredential(groupId, actorId);
      const viewer = normalized.participants.find((item) => item.actorId === actorId);
      if (credential?.role !== 'admin' && (credential?.active === false || viewer?.counted === false)) {
        return {
          ...normalized,
          participants: viewer ? [viewer] : [],
          messages: [],
          history: [],
          unreadCount: 0,
          viewer: { ...(normalized.viewer || {}), actorId, active: false },
        };
      }
      return normalized;
    });
  } catch (error) {
    // A confirmed remote 404 with no usable local snapshot is permanent for
    // this saved credential. Disable it so unread polling cannot hammer the
    // collector forever. Transient 5xx/network failures remain active.
    if (remoteGroupMissing && isGroupNotFoundError(error)) {
      deactivateMissingGroupCredential(
        groupId,
        actorId,
        payload.capabilityToken,
        credentialRevisionAtRequestStart,
      );
    }
    throw error;
  }
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
  const latestReservationHistory = [...snapshot.history].reverse().find((item) => (
    (item.actorId === actorId || (item.action === 'admin_cancel_order' && item.entityId === actorId))
    && ['create', 'join', 'reserve_quantity', 'rollback_reservation', 'cancel_participation', 'admin_cancel_order'].includes(item.action)
  ));
  const canReactivateRolledBackReservation = Boolean(
    credential
    && participant
    && ['creator', 'member'].includes(participant.role)
    && participant.counted === false
    && Number(participant.selectedQuantity || 0) === 0
    && (participant.paymentStatus || 'pending') === 'pending'
    && latestReservationHistory?.action === 'rollback_reservation'
    && ['join', 'reserve_quantity'].includes(latestReservationHistory.result?.reservationAction)
    && Number(latestReservationHistory.result?.selectedQuantity) === 0,
  );
  const canReactivateCancelledParticipation = Boolean(
    credential
    && participant
    && ['member', 'creator'].includes(participant.role)
    && participant.counted === false
    && Number(participant.selectedQuantity || 0) === 0
    && (participant.paymentStatus || 'pending') === 'pending'
    && ['cancel_participation', 'admin_cancel_order'].includes(latestReservationHistory?.action)
    && /^order-\d{10,20}$/.test(String(latestReservationHistory.result?.orderId || ''))
    && Number(latestReservationHistory.result?.cancelledQuantity || 0) > 0
    && Number(latestReservationHistory.result?.selectedQuantity) === 0
  );
  const canReactivateInactiveParticipation = canReactivateRolledBackReservation
    || canReactivateCancelledParticipation;
  if (
    !credential
    || !participant
    || (participant.counted === false && !canReactivateInactiveParticipation)
    || !['creator', 'host', 'member'].includes(participant.role)
  ) throw new Error('forbidden');
  if ((participant.paymentStatus || 'pending') !== 'pending') {
    throw new Error('quantity_reservation_closed');
  }
  if (snapshot.group.status !== 'recruiting') throw new Error('quantity_reservation_closed');
  if (Number(participant.version || 1) !== Number(expectedVersion)) throw new Error('state_conflict');
  const delta = Number(quantity);
  if (!Number.isInteger(delta) || delta < 1 || delta > 999) throw new Error('invalid_quantity');
  const activeParticipantCount = snapshot.participants
    .filter((item) => item.counted !== false)
    .length;
  if (canReactivateInactiveParticipation
    && (activeParticipantCount >= 20
      || activeParticipantCount >= Number(snapshot.group.targetCount || 1))) {
    throw new Error('group_full');
  }
  const orderedQuantity = snapshot.participants
    .filter((item) => item.counted !== false)
    .reduce((total, item) => total + Number(item.selectedQuantity || 0), 0);
  if (orderedQuantity + delta > Number(snapshot.group.totalQuantity || 1)) {
    throw new Error('quantity_exceeds_total');
  }
  const now = new Date().toISOString();
  const previous = Number(participant.selectedQuantity || 0);
  participant.selectedQuantity = previous + delta;
  if (canReactivateInactiveParticipation) participant.counted = true;
  participant.version = Number(participant.version || 1) + 1;
  participant.updatedAt = now;
  snapshot.group.orderedQuantity = orderedQuantity + delta;
  snapshot.group.currentCount = snapshot.participants
    .filter((item) => item.counted !== false)
    .length;
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
    reservationQuantity: delta,
    version: participant.version,
    result: {
      reservationQuantity: delta,
      reactivated: canReactivateInactiveParticipation,
      reactivationReason: canReactivateCancelledParticipation ? 'cancel_participation' : '',
      mutationContract: JSON.stringify({
        action: 'reserve_quantity',
        groupId,
        actorId,
        quantity: delta,
        expectedVersion: Number(expectedVersion),
      }),
    },
    createdAt: now,
  });
  return saveLocalGroup(groupId, snapshot);
}

function localReservationQuantity(reservation) {
  const directQuantity = Number(
    reservation?.reservationQuantity
    ?? reservation?.result?.reservationQuantity,
  );
  if (Number.isInteger(directQuantity) && directQuantity > 0) return directQuantity;
  if (reservation?.action === 'reserve_quantity') {
    const before = Number(reservation.fromStatus);
    const after = Number(reservation.toStatus);
    return Number.isInteger(before) && Number.isInteger(after) && after > before
      ? after - before
      : 0;
  }
  return 0;
}

function localRollbackGroupReservation({
  groupId,
  quantity,
  actorId,
  reservationMutationId,
  clientMutationId,
}) {
  const groups = getLocalGroups();
  const snapshot = groups[groupId];
  if (!snapshot) throw new Error('group_not_found');
  if (!Array.isArray(snapshot.history)) snapshot.history = [];

  const duplicate = snapshot.history.find((item) => item.clientMutationId === clientMutationId);
  if (duplicate) {
    if (
      duplicate.action !== 'rollback_reservation'
      || duplicate.actorId !== actorId
      || duplicate.result?.reservationMutationId !== reservationMutationId
      || Number(duplicate.result?.rolledBackQuantity || 0) !== Number(quantity)
    ) throw new Error('client_mutation_conflict');
    return normalizeSnapshot(snapshot, groupId);
  }

  const credential = getGroupCredential(groupId, actorId);
  const participant = snapshot.participants.find((item) => item.actorId === actorId);
  if (!credential || !participant || !['creator', 'host', 'member'].includes(participant.role)) {
    throw new Error('forbidden');
  }
  const reservation = snapshot.history.find((item) => (
    item.actorId === actorId
    && item.clientMutationId === reservationMutationId
    && ['create', 'join', 'reserve_quantity'].includes(item.action)
  ));
  if (!reservation) throw new Error('reservation_not_found');
  const reservedQuantity = localReservationQuantity(reservation);
  if (reservedQuantity !== Number(quantity)) throw new Error('reservation_quantity_mismatch');

  const previousRollback = snapshot.history.find((item) => (
    item.action === 'rollback_reservation'
    && item.actorId === actorId
    && item.result?.reservationMutationId === reservationMutationId
  ));
  const now = new Date().toISOString();
  if (previousRollback) {
    snapshot.history.push({
      id: createMutationId('history'),
      entityType: 'quantity',
      entityId: actorId,
      fromStatus: String(participant.selectedQuantity || 0),
      toStatus: String(participant.selectedQuantity || 0),
      action: 'rollback_reservation',
      actorId,
      actorRole: participant.role,
      reason: 'order_persistence_failed',
      clientMutationId,
      version: Number(participant.version || 1),
      result: {
        unchanged: true,
        reservationMutationId,
        reservationAction: reservation.action,
        rolledBackQuantity: Number(quantity),
        originalRollbackMutationId: previousRollback.clientMutationId,
        selectedQuantity: Number(participant.selectedQuantity || 0),
      },
      createdAt: now,
    });
    return saveLocalGroup(groupId, snapshot);
  }

  const previousQuantity = Number(participant.selectedQuantity || 0);
  if (previousQuantity < Number(quantity)) throw new Error('state_conflict');
  const nextQuantity = previousQuantity - Number(quantity);
  participant.selectedQuantity = nextQuantity;
  if (nextQuantity === 0) {
    participant.counted = false;
    if (snapshot.group.hostActorId === actorId) {
      snapshot.group.hostActorId = '';
      snapshot.group.hostMatched = false;
      participant.role = 'member';
      saveGroupCredential(groupId, { ...credential, actorId, role: 'member' });
    }
  }
  participant.version = Number(participant.version || 1) + 1;
  participant.updatedAt = now;
  snapshot.group.currentCount = snapshot.participants.filter((item) => item.counted !== false).length;
  snapshot.group.orderedQuantity = snapshot.participants
    .filter((item) => item.counted !== false)
    .reduce((total, item) => total + Number(item.selectedQuantity || 0), 0);
  snapshot.group.version = Number(snapshot.group.version || 0) + 1;
  snapshot.group.updatedAt = now;
  snapshot.history.push({
    id: createMutationId('history'),
    entityType: 'quantity',
    entityId: actorId,
    fromStatus: String(previousQuantity),
    toStatus: String(nextQuantity),
    action: 'rollback_reservation',
    actorId,
    actorRole: participant.role,
    reason: 'order_persistence_failed',
    clientMutationId,
    version: participant.version,
    result: {
      reservationMutationId,
      reservationAction: reservation.action,
      rolledBackQuantity: Number(quantity),
      previousQuantity,
      selectedQuantity: nextQuantity,
    },
    createdAt: now,
  });
  return saveLocalGroup(groupId, snapshot);
}

function cancelledLocalOrder(order, actorId, clientMutationId, timestamp, nextVersion) {
  const {
    customerCapabilityToken: _customerCapabilityToken,
    customerCapabilityHash: _customerCapabilityHash,
    capabilityToken: _capabilityToken,
    capabilityHash: _capabilityHash,
    _customerCapabilityHash: _storedCustomerCapabilityHash,
    ...safeOrder
  } = order || {};
  const previousStatus = String(safeOrder.status || 'new');
  return {
    ...safeOrder,
    status: 'cancelled',
    paymentStatus: 'cancelled',
    statusUpdatedAt: timestamp,
    cancelledAt: timestamp,
    version: nextVersion,
    paymentVersion: nextVersion,
    syncedAt: timestamp,
    statusHistory: [
      ...(Array.isArray(safeOrder.statusHistory) ? safeOrder.statusHistory : []),
      {
        status: 'cancelled',
        before: previousStatus,
        after: 'cancelled',
        actor: actorId,
        actorRole: 'member',
        action: 'cancel_participation',
        reason: 'participant_cancelled',
        clientMutationId,
        version: nextVersion,
        timestamp,
      },
    ].slice(-100),
  };
}

function localCancelGroupParticipation({
  groupId,
  order,
  actorId,
  expectedVersion,
  expectedOrderVersion,
  clientMutationId,
}) {
  const groups = getLocalGroups();
  const snapshot = groups[groupId];
  if (!snapshot) throw new Error('group_not_found');

  const credential = getGroupCredential(groupId, actorId);
  const participant = snapshot.participants.find((item) => item.actorId === actorId);
  if (!credential || !participant || participant.role !== 'member') {
    throw new Error('forbidden');
  }

  const cancellationHistory = (Array.isArray(snapshot.history) ? snapshot.history : []).filter((item) => (
    item.action === 'cancel_participation'
    && item.actorId === actorId
  ));
  const previousCancellation = cancellationHistory.find((item) => (
    item.clientMutationId === clientMutationId
  ));
  if (previousCancellation) {
    const previousOrderId = previousCancellation.orderId || previousCancellation.result?.orderId;
    if (previousOrderId !== order.id) throw new Error('client_mutation_conflict');
    const timestamp = previousCancellation.createdAt || new Date().toISOString();
    const nextOrderVersion = Number(
      previousCancellation.orderVersion
      || previousCancellation.result?.orderVersion
      || expectedOrderVersion + 1,
    );
    return {
      snapshot: normalizeSnapshot(snapshot, groupId),
      order: cancelledLocalOrder(
        order,
        actorId,
        previousCancellation.clientMutationId || clientMutationId,
        timestamp,
        nextOrderVersion,
      ),
    };
  }
  if (cancellationHistory.some((item) => (
    (item.orderId || item.result?.orderId) === order.id
  ))) throw new Error('order_not_cancellable');

  if (participant.counted === false) throw new Error('forbidden');
  if ((snapshot.group.status || 'recruiting') !== 'recruiting') {
    throw new Error('participation_cancellation_closed');
  }
  if (String(order.status || 'new') !== 'new') throw new Error('order_not_cancellable');
  if ((participant.paymentStatus || 'pending') !== 'pending'
    || String(order.paymentStatus || 'pending') !== 'pending'
    || order.paymentRequestedAt
    || order.paymentConfirmedAt) throw new Error('payment_already_processed');
  if (order.type && order.type !== 'purchase') throw new Error('order_not_cancellable');
  const orderGroupId = order.groupId || order.dealId || order.deal?.id;
  const orderActorId = order.participantActorId || order.visitorId;
  if (orderGroupId !== groupId || (orderActorId && orderActorId !== actorId)) {
    throw new Error('forbidden');
  }
  if (Number(participant.version || 1) !== Number(expectedVersion)) {
    throw new Error('state_conflict');
  }
  const orderVersion = canonicalOrderVersion(order);
  if (!Number.isInteger(orderVersion) || orderVersion < 1
    || orderVersion !== Number(expectedOrderVersion)) {
    throw new Error('state_conflict');
  }
  const cancelledQuantity = Number(order.selectedCount ?? order.quantity ?? 0);
  const previousQuantity = Number(participant.selectedQuantity || 0);
  if (!Number.isInteger(cancelledQuantity) || cancelledQuantity < 1) {
    throw new Error('invalid_quantity');
  }
  if (cancelledQuantity > previousQuantity) throw new Error('state_conflict');

  const now = new Date().toISOString();
  const nextQuantity = previousQuantity - cancelledQuantity;
  participant.selectedQuantity = nextQuantity;
  participant.counted = nextQuantity > 0;
  participant.version = Number(participant.version || 1) + 1;
  participant.updatedAt = now;
  snapshot.group.orderedQuantity = snapshot.participants
    .filter((item) => item.counted !== false)
    .reduce((total, item) => total + Number(item.selectedQuantity || 0), 0);
  snapshot.group.currentCount = snapshot.participants
    .filter((item) => item.counted !== false)
    .length;
  snapshot.group.version = Number(snapshot.group.version || 0) + 1;
  snapshot.group.updatedAt = now;
  const nextOrderVersion = orderVersion + 1;
  if (!Array.isArray(snapshot.history)) snapshot.history = [];
  snapshot.history.push({
    id: createMutationId('history'),
    entityType: 'participant',
    entityId: actorId,
    orderId: order.id,
    fromStatus: 'joined',
    toStatus: nextQuantity > 0 ? 'joined' : 'cancelled',
    fromQuantity: String(previousQuantity),
    toQuantity: String(nextQuantity),
    action: 'cancel_participation',
    actorId,
    actorRole: participant.role,
    reason: 'participant_cancelled',
    clientMutationId,
    version: participant.version,
    orderVersion: nextOrderVersion,
    result: {
      orderId: order.id,
      cancelledQuantity,
      previousQuantity,
      selectedQuantity: nextQuantity,
      orderVersion: nextOrderVersion,
    },
    createdAt: now,
  });
  return {
    snapshot: saveLocalGroup(groupId, snapshot),
    order: cancelledLocalOrder(
      order,
      actorId,
      clientMutationId,
      now,
      nextOrderVersion,
    ),
  };
}

export async function reserveGroupQuantity(
  groupId,
  quantity,
  actorId,
  clientMutationId = createMutationId('reserve_quantity'),
  { allowLocalFallback = true } = {},
) {
  const delta = Number(quantity);
  if (!Number.isInteger(delta) || delta < 1 || delta > 999) throw new Error('invalid_quantity');
  const snapshot = await fetchGroupSnapshot(groupId, { actorId, allowLocalFallback });
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
  const remoteCall = () => requestGroupOperation(payload);
  const result = allowLocalFallback
    ? await withFallback(remoteCall, () => ({
        ok: true,
        snapshot: localReserveQuantity(groupId, actorId, delta, expectedVersion, clientMutationId),
        localOnly: true,
      }))
    : await remoteCall();
  const normalized = normalizeSnapshot(result, groupId);
  const currentCredential = getGroupCredential(groupId, actorId);
  if (currentCredential) {
    saveGroupCredential(groupId, { ...currentCredential, actorId, active: true });
  }
  return { ...result, snapshot: normalized };
}

export async function rollbackGroupReservation(
  groupId,
  quantity,
  actorId,
  reservationMutationId,
  clientMutationId = createMutationId('rollback_reservation'),
  { allowLocalFallback = false } = {},
) {
  const rollbackQuantity = Number(quantity);
  if (!Number.isInteger(rollbackQuantity) || rollbackQuantity < 1 || rollbackQuantity > 999) {
    throw new Error('invalid_quantity');
  }
  if (!MUTATION_ID_PATTERN.test(String(reservationMutationId || ''))) {
    throw new Error('invalid_reservation_mutation_id');
  }
  if (!MUTATION_ID_PATTERN.test(String(clientMutationId || ''))) {
    throw new Error('invalid_client_mutation_id');
  }
  const payload = commonPayload(groupId, {
    action: 'rollback_reservation',
    actorId,
    quantity: rollbackQuantity,
    reservationMutationId,
    clientMutationId,
  });
  const remoteCall = () => requestGroupOperation(payload);
  const result = allowLocalFallback
    ? await withFallback(remoteCall, () => ({
        ok: true,
        snapshot: localRollbackGroupReservation(payload),
        localOnly: true,
      }))
    : await remoteCall();
  const normalized = normalizeSnapshot(result, groupId);
  const participant = normalized.participants.find((item) => item.actorId === actorId);
  const currentCredential = getGroupCredential(groupId, actorId);
  if (currentCredential) {
    saveGroupCredential(groupId, {
      ...currentCredential,
      actorId,
      active: participant ? participant.counted !== false : false,
    });
  }
  return { ...result, snapshot: normalized };
}

export async function cancelGroupParticipation({
  groupId,
  order,
  actorId,
  customerCapabilityToken,
  clientMutationId = createMutationId('cancel_participation'),
}) {
  if (!groupId || !actorId || !/^order-\d{10,20}$/.test(String(order?.id || ''))) {
    throw new Error('invalid_cancellation_request');
  }
  if (typeof customerCapabilityToken !== 'string' || customerCapabilityToken.length < 32) {
    throw new Error('missing_customer_capability_token');
  }
  const expectedOrderVersion = canonicalOrderVersion(order);
  if (!Number.isInteger(expectedOrderVersion) || expectedOrderVersion < 1) {
    throw new Error('invalid_order_version');
  }
  // A cancelled order and its released group capacity must commit together on
  // the central store. Falling back locally creates a split-brain state where
  // the customer sees a cancellation that the host and other devices cannot.
  const snapshot = await fetchGroupSnapshot(groupId, {
    actorId,
    allowLocalFallback: false,
  });
  const participant = snapshot.participants.find((item) => item.actorId === actorId);
  if (!participant) throw new Error('participant_not_found');
  const expectedVersion = Number(participant.version || 0);
  const payload = commonPayload(groupId, {
    action: 'cancel_participation',
    actorId,
    orderId: order.id,
    expectedVersion,
    expectedOrderVersion,
    customerCapabilityToken,
    clientMutationId,
  });
  const result = await requestGroupOperation(payload);
  const normalized = normalizeSnapshot(result, groupId);
  const participantAfterCancellation = normalized.participants.find((item) => item.actorId === actorId);
  const currentCredential = getGroupCredential(groupId, actorId);
  if (currentCredential) {
    saveGroupCredential(groupId, {
      ...currentCredential,
      actorId,
      active: participantAfterCancellation ? participantAfterCancellation.counted !== false : false,
    });
  }
  return {
    ...result,
    order: result.order || result.cancelledOrder,
    snapshot: normalized,
  };
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
  // A local-only chat acknowledgement is misleading: it disappears on the
  // next central snapshot and can make the sender believe everyone received
  // a message that never left this browser. Chat writes therefore fail closed.
  const result = await requestGroupOperation(payload);
  return { ...result, snapshot: normalizeSnapshot(result, groupId) };
}

export async function markGroupRead(groupId, lastReadSeq, actorId) {
  const credential = getGroupCredential(groupId, actorId);
  if (credential?.role !== 'admin' && credential?.active === false) throw new Error('forbidden');
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

async function mutateGroup(groupId, actorId, action, extras, localMutation, options = {}) {
  const allowLocalFallback = options.allowLocalFallback === true;
  options.assertCurrentContext?.();
  const snapshot = await fetchGroupSnapshot(groupId, { actorId, allowLocalFallback });
  options.assertCurrentContext?.();
  const credential = getGroupCredential(groupId, actorId);
  const actingParticipant = snapshot.participants.find((item) => item.actorId === actorId);
  if (credential?.role !== 'admin' && actingParticipant?.counted === false) {
    throw new Error('forbidden');
  }
  const participantVersion = action === 'transition_payment'
    ? snapshot.participants.find((item) => item.actorId === extras.participantActorId)?.version
    : null;
  let transitionIntent = null;
  if (typeof options.createTransitionIntent === 'function') {
    const participantActorId = action === 'transition_payment' ? extras.participantActorId : '';
    const storedIntent = storedTransitionAttempt(action, groupId, actorId, participantActorId);
    const requestedIntent = options.transitionIntent;
    const matchingIntent = [storedIntent, requestedIntent].find((intent) => (
      intent?.action === action
      && intent?.groupId === groupId
      && intent?.actorId === actorId
      && String(intent?.participantActorId || '') === String(participantActorId || '')
      && MUTATION_ID_PATTERN.test(String(intent?.clientMutationId || ''))
      && Number.isInteger(Number(intent?.expectedVersion))
      && Number(intent.expectedVersion) > 0
    ));
    transitionIntent = matchingIntent || options.createTransitionIntent(snapshot);
    options.assertCurrentContext?.();
    saveTransitionAttempt(transitionIntent);
  }
  const payload = commonPayload(groupId, {
    action,
    actorId,
    expectedVersion: Number(participantVersion ?? snapshot.group.version ?? 0),
    clientMutationId: createMutationId(action),
    ...extras,
    ...(transitionIntent || {}),
  });
  options.assertCurrentContext?.();
  try {
    const result = allowLocalFallback
      ? await withFallback(
          () => requestGroupOperation(payload, undefined, options.assertCurrentContext),
          () => ({ ok: true, snapshot: mutateLocal(groupId, actorId, localMutation), localOnly: true }),
        )
      : await requestGroupOperation(payload, undefined, options.assertCurrentContext);
    if (transitionIntent) clearTransitionAttempt(transitionIntent);
    return {
      ...result,
      snapshot: normalizeSnapshot(result, groupId),
      ...(transitionIntent ? { mutationIntent: transitionIntent } : {}),
    };
  } catch (error) {
    if (transitionIntent) {
      const retryPending = shouldRetainTransitionAttempt(error);
      if (!retryPending) clearTransitionAttempt(transitionIntent);
      error.mutationIntent = transitionIntent;
      error.transitionRetryPending = retryPending;
    }
    throw error;
  }
}

export function transitionGroupStatus(groupId, direction, actorId, transitionIntent = null) {
  return mutateGroup(groupId, actorId, 'transition_group', { direction }, (snapshot, actor) => {
    if (!actor || !['host', 'admin'].includes(actor.role)) throw new Error('forbidden');
    const from = snapshot.group.status || 'recruiting';
    if (from === 'recruiting' && direction === 'next') {
      const payableParticipants = snapshot.participants.filter((item) => (
        item.counted !== false && item.role !== 'admin'
      ));
      if (!payableParticipants.length
        || payableParticipants.some((item) => (item.paymentStatus || 'pending') !== 'confirmed')) {
        throw new Error('payments_not_confirmed');
      }
    }
    const index = GROUP_TRANSITION_STATES.indexOf(from);
    const offset = direction === 'previous' ? -1 : 1;
    const to = GROUP_TRANSITION_STATES[Math.min(GROUP_TRANSITION_STATES.length - 1, Math.max(0, index + offset))];
    if (to === from) throw new Error('invalid_transition');
    snapshot.group.status = to;
    snapshot.history.push({
      id: createMutationId('history'), entityType: 'group', entityId: groupId,
      fromStatus: from, toStatus: to, actorId: actor.actorId, actorRole: actor.role,
      createdAt: new Date().toISOString(),
    });
  }, {
    allowLocalFallback: false,
    transitionIntent,
    createTransitionIntent: (snapshot) => {
      const fromStatus = snapshot.group.status || 'recruiting';
      const index = GROUP_TRANSITION_STATES.indexOf(fromStatus);
      const offset = direction === 'previous' ? -1 : 1;
      const toStatus = GROUP_TRANSITION_STATES[index + offset];
      if (!toStatus) throw new Error('invalid_transition');
      return {
        action: 'transition_group',
        groupId,
        actorId,
        direction,
        fromStatus,
        toStatus,
        expectedVersion: Number(snapshot.group.version || 0),
        clientMutationId: createMutationId('transition_group'),
      };
    },
  });
}

export function transitionParticipantPayment(
  groupId, participantActorId, direction, actorId, transitionIntent = null,
  { expectedFromStatus, assertCurrentContext } = {},
) {
  return mutateGroup(groupId, actorId, 'transition_payment', { participantActorId, direction }, (snapshot, actor) => {
    const participant = snapshot.participants.find((item) => item.actorId === participantActorId);
    if (!actor || !participant) throw new Error('participant_not_found');
    const from = participant.paymentStatus || 'pending';
    const index = PAYMENT_TRANSITION_STATES.indexOf(from);
    const offset = direction === 'previous' ? -1 : 1;
    const to = PAYMENT_TRANSITION_STATES[Math.min(PAYMENT_TRANSITION_STATES.length - 1, Math.max(0, index + offset))];
    const isSelfRequest = actor.actorId === participantActorId
      && ((from === 'pending' && to === 'requested') || (from === 'requested' && to === 'pending'));
    const isOperator = ['host', 'admin'].includes(actor.role)
      && ((from === 'requested' && to === 'confirmed') || (from === 'confirmed' && to === 'requested'));
    if (!isSelfRequest && !isOperator) throw new Error('forbidden');
    if ((snapshot.group.status || 'recruiting') !== 'recruiting' && to !== 'confirmed') {
      throw new Error('payment_reversal_requires_group_rewind');
    }
    participant.paymentStatus = to;
    snapshot.history.push({
      id: createMutationId('history'), entityType: 'payment', entityId: participantActorId,
      fromStatus: from, toStatus: to, actorId: actor.actorId, actorRole: actor.role,
      createdAt: new Date().toISOString(),
    });
  }, {
    allowLocalFallback: false,
    transitionIntent,
    assertCurrentContext,
    createTransitionIntent: (snapshot) => {
      const participant = snapshot.participants.find((item) => item.actorId === participantActorId);
      if (!participant) throw new Error('participant_not_found');
      const fromStatus = participant.paymentStatus || 'pending';
      // A relative "next" click must retain the meaning the user confirmed.
      // An existing frozen intent bypasses this factory and still replays its
      // original receipt when a response was lost after the server committed.
      if (expectedFromStatus !== undefined && expectedFromStatus !== fromStatus) {
        throw Object.assign(new Error('state_conflict'), {
          code: 'state_conflict', status: 409, snapshot,
        });
      }
      const index = PAYMENT_TRANSITION_STATES.indexOf(fromStatus);
      const offset = direction === 'previous' ? -1 : 1;
      const toStatus = PAYMENT_TRANSITION_STATES[index + offset];
      if (!toStatus) throw new Error('invalid_transition');
      return {
        action: 'transition_payment',
        groupId,
        actorId,
        participantActorId,
        direction,
        fromStatus,
        toStatus,
        expectedVersion: Number(participant.version || 0),
        clientMutationId: createMutationId('transition_payment'),
      };
    },
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
  }, { allowLocalFallback: false });
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
  }, { allowLocalFallback: false });
}

export async function fetchUnreadCounts({ adminMode = false, onSnapshot } = {}) {
  const entries = Object.entries(getGroupCredentials())
    .map(([storageKey, credential]) => ({
      groupId: credential?.groupId || storageKey.split('::')[0],
      credential,
    }))
    .filter(({ credential }) => Boolean(credential?.actorId && credential?.capabilityToken))
    .filter(({ credential }) => credential.active !== false)
    .filter(({ credential }) => (adminMode ? credential.role === 'admin' : credential.role !== 'admin'));
  const snapshots = await Promise.all(entries.map(async ({ groupId, credential }) => {
    try {
      const snapshot = await fetchGroupSnapshot(groupId, { actorId: credential.actorId });
      onSnapshot?.(groupId, snapshot, credential.actorId);
      return [groupId, snapshot];
    } catch {
      return [groupId, null];
    }
  }));
  return Object.fromEntries(snapshots.map(([groupId, snapshot]) => [
    groupId,
    snapshot ? resolveUnreadCount(snapshot, getLastReadSeq(groupId)) : 0,
  ]));
}
