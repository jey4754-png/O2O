const CHECKOUT_ATTEMPTS_KEY = 'o2o_mvp_checkout_attempts_v1';
const CHECKOUT_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
const ORDER_ID_PATTERN = /^order-\d{10,20}$/;
const MUTATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const TRANSIENT_ORDER_SYNC_CODES = new Set([
  'collector_busy',
  'collector_failed',
  'collector_unreachable',
  'order_sync_failed',
  'upstream_timeout',
]);
const TRANSIENT_ORDER_SYNC_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

let memoryAttempts = {};
const storageMemoryAttempts = new WeakMap();

function availableStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readAttempts(storage) {
  const target = availableStorage(storage);
  if (!target) return { ...memoryAttempts };
  try {
    const serialized = target.getItem(CHECKOUT_ATTEMPTS_KEY);
    if (serialized === null) return { ...(storageMemoryAttempts.get(target) || {}) };
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { ...(storageMemoryAttempts.get(target) || {}) };
  }
}

function writeAttempts(attempts, storage) {
  memoryAttempts = { ...attempts };
  const target = availableStorage(storage);
  if (!target) return;
  storageMemoryAttempts.set(target, { ...attempts });
  try {
    target.setItem(CHECKOUT_ATTEMPTS_KEY, JSON.stringify(attempts));
  } catch {
    // The in-memory copy still keeps retries idempotent for the current page session.
  }
}

function numericValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

export function checkoutAttemptFingerprint(input = {}) {
  return JSON.stringify({
    actorId: String(input.actorId || ''),
    dealId: String(input.dealId || input.deal?.id || ''),
    groupId: String(input.groupId || ''),
    type: String(input.type || ''),
    quantity: Math.max(0, Math.floor(numericValue(input.selectedCount ?? input.quantity))),
    total: numericValue(input.total),
  });
}

function attemptStorageKey(input, fingerprint) {
  return `${String(input.actorId || '')}::${String(input.dealId || input.deal?.id || '')}::${fingerprint}`;
}

function validAttempt(attempt, fingerprint, nowMs) {
  if (!attempt || attempt.fingerprint !== fingerprint) return false;
  if (!ORDER_ID_PATTERN.test(String(attempt.orderId || ''))) return false;
  if (!MUTATION_ID_PATTERN.test(String(attempt.reservationMutationId || ''))) return false;
  const updatedAtMs = Date.parse(attempt.updatedAt || attempt.createdAt || '');
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs <= CHECKOUT_ATTEMPT_TTL_MS;
}

function randomNonce(randomValue) {
  if (Number.isInteger(randomValue)) return Math.abs(randomValue) % 1_000_000;
  const values = new Uint32Array(1);
  try {
    globalThis.crypto?.getRandomValues?.(values);
  } catch {
    // Math.random is sufficient for collision avoidance when secure randomness is unavailable.
  }
  return Number(values[0] || Math.floor(Math.random() * 1_000_000)) % 1_000_000;
}

export function beginCheckoutAttempt(input, options = {}) {
  const actorId = String(input?.actorId || '');
  const dealId = String(input?.dealId || input?.deal?.id || '');
  const requestedMutationId = String(input?.reservationMutationId || input?.clientMutationId || '');
  if (!actorId || !dealId || !MUTATION_ID_PATTERN.test(requestedMutationId)) {
    throw new Error('invalid_checkout_attempt');
  }

  const nowMs = Number(options.nowMs ?? Date.now());
  const fingerprint = checkoutAttemptFingerprint({ ...input, actorId, dealId });
  const key = attemptStorageKey({ actorId, dealId }, fingerprint);
  const attempts = readAttempts(options.storage);
  const existing = attempts[key];
  if (validAttempt(existing, fingerprint, nowMs)) return existing;

  Object.entries(attempts).forEach(([attemptKey, attempt]) => {
    const updatedAtMs = Date.parse(attempt?.updatedAt || attempt?.createdAt || '');
    if (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs > CHECKOUT_ATTEMPT_TTL_MS) {
      delete attempts[attemptKey];
    }
  });

  const nonce = String(randomNonce(options.randomValue)).padStart(6, '0');
  const attempt = {
    actorId,
    dealId,
    fingerprint,
    orderId: `order-${Math.floor(nowMs)}${nonce}`,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    reservationMutationId: requestedMutationId,
  };
  attempts[key] = attempt;
  writeAttempts(attempts, options.storage);
  return attempt;
}

export function completeCheckoutAttempt(orderId, options = {}) {
  const attempts = readAttempts(options.storage);
  let changed = false;
  Object.entries(attempts).forEach(([key, attempt]) => {
    if (attempt?.orderId !== orderId) return;
    delete attempts[key];
    changed = true;
  });
  if (changed) writeAttempts(attempts, options.storage);
  return changed;
}

export function checkoutNeedsDurableOrderSync(order = {}) {
  if (order.type !== 'purchase') return false;
  const deal = order.deal || {};
  return deal.source === 'merchant'
    || deal.source === 'customer'
    || Boolean(order.groupId || deal.groupId);
}

export function isTransientOrderSyncError(error = {}) {
  const status = Number(error.status || 0);
  const code = String(error.code || error.message || '');
  return TRANSIENT_ORDER_SYNC_STATUSES.has(status)
    || TRANSIENT_ORDER_SYNC_CODES.has(code)
    || (!status && error?.name === 'TypeError');
}

export function canQueueReservedGroupOrder(order = {}, error = {}) {
  return Boolean(order.groupId) && isTransientOrderSyncError(error);
}

export function isTerminalOrderSyncError(error = {}) {
  const status = Number(error.status || 0);
  return status >= 400 && status < 500 && !TRANSIENT_ORDER_SYNC_STATUSES.has(status);
}

export const checkoutAttemptStorageKey = CHECKOUT_ATTEMPTS_KEY;
