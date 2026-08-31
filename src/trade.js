import { discountedPrice } from './utils.js';

export const PRODUCT_CATEGORIES = Object.freeze([
  '음식·간편식',
  '카페·음료',
  '간식·디저트',
  '식재료',
  '생활·주방용품',
  '세제·위생용품',
  '뷰티·건강',
  '반려동물용품',
  '유아·육아용품',
  '문구·사무용품',
  '기타',
]);

export const LEGACY_CATEGORY_MAP = Object.freeze({
  '식사': '음식·간편식',
  '음식': '음식·간편식',
  '간편식': '음식·간편식',
  '편의점': '음식·간편식',
  '카페': '카페·음료',
  '음료': '카페·음료',
  '간식': '간식·디저트',
  '디저트': '간식·디저트',
  '장보기': '식재료',
  '장보기/마트': '식재료',
  '마트': '식재료',
  '생활용품': '생활·주방용품',
  '주방용품': '생활·주방용품',
  '세제': '세제·위생용품',
  '위생용품': '세제·위생용품',
  '뷰티': '뷰티·건강',
  '건강': '뷰티·건강',
  '반려동물': '반려동물용품',
  '펫용품': '반려동물용품',
  '유아': '유아·육아용품',
  '육아': '유아·육아용품',
  '문구': '문구·사무용품',
  '사무용품': '문구·사무용품',
});

const normalizeCategoryKey = (value) => String(value ?? '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, '')
  .replace(/[\/ㆍ・&＆]/g, '·');

const categoryByKey = new Map(
  PRODUCT_CATEGORIES.map((category) => [normalizeCategoryKey(category), category]),
);
const legacyCategoryByKey = new Map(
  Object.entries(LEGACY_CATEGORY_MAP).map(([legacy, category]) => [normalizeCategoryKey(legacy), category]),
);

export function normalizeCategory(value, fallback = '기타') {
  const normalizedFallback = categoryByKey.get(normalizeCategoryKey(fallback)) || '기타';
  const key = normalizeCategoryKey(value);
  if (!key) return normalizedFallback;
  return categoryByKey.get(key) || legacyCategoryByKey.get(key) || normalizedFallback;
}

export const GROUP_STATES = Object.freeze([
  'recruiting',
  'recruited',
  'purchased',
  'delivered',
]);

export const GROUP_STATUS_LABELS = Object.freeze({
  recruiting: '모집 중',
  recruited: '모집 완료',
  purchased: '상품 구매 완료',
  delivered: '전달 완료',
});

export function formatGroupQuantityAllocation(quantity = {}, groupStatus = 'recruiting') {
  const total = Math.max(1, Math.floor(Number(quantity.target || 1)));
  const ordered = Math.max(0, Math.min(total, Math.floor(Number(quantity.ordered || 0))));
  const remaining = total - ordered;

  return groupStatus === 'recruiting'
    ? `남은 제품 ${remaining}개`
    : `모집 종료 · 배정 ${ordered}개 / 총 ${total}개 · 미배정 ${remaining}개`;
}

export const PAYMENT_STATES = Object.freeze([
  'pending',
  'requested',
  'confirmed',
]);

export const PAYMENT_STATUS_LABELS = Object.freeze({
  pending: '입금대기',
  requested: '입금확인요청',
  confirmed: '입금완료',
});

export const TRADE_ACTOR_ROLES = Object.freeze([
  'participant',
  'creator',
  'host',
  'admin',
]);

export const MAX_GROUP_PARTICIPANTS = 20;
export const MAX_PRODUCT_QUANTITY = 999;

export function resolveOwnerProductQuantity({
  saleType = 'group',
  stock = 1,
  maxQuantity = 1,
  minimumGroupQuantity = 1,
} = {}) {
  const isGroup = saleType === 'group';
  const minimum = isGroup
    ? Math.max(1, Math.floor(Number(minimumGroupQuantity) || 1))
    : 1;
  const requested = Math.floor(Number(isGroup ? maxQuantity : stock) || 1);
  const quantity = Math.min(MAX_PRODUCT_QUANTITY, Math.max(minimum, requested));
  return {
    quantity,
    stock: quantity,
    maxQuantity: quantity,
  };
}

export function resolveMerchantGroupPricing({
  originalPrice = 0,
  discountRate = 0,
  totalQuantity = 1,
  splitQuantity = 1,
} = {}) {
  const capacity = Math.min(
    MAX_PRODUCT_QUANTITY,
    Math.max(1, Math.floor(Number(totalQuantity) || 1)),
  );
  const divisor = Math.min(
    capacity,
    Math.max(1, Math.floor(Number(splitQuantity) || 1)),
  );
  const discountedTotal = discountedPrice(originalPrice, discountRate);
  const allocation = calculateProductAllocation(discountedTotal, divisor, 1);
  return {
    ...allocation,
    totalQuantity: capacity,
    splitQuantity: divisor,
    discountedTotal,
    splitPricing: divisor > 1,
  };
}

function hasValue(collection, value) {
  return collection.includes(value);
}

function assertKnownStatus(collection, status, label) {
  if (!hasValue(collection, status)) {
    const error = new RangeError(`Unknown ${label}: ${status}`);
    error.code = 'INVALID_STATUS';
    throw error;
  }
}

function transitionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function adjacentStatus(collection, status, delta) {
  assertKnownStatus(collection, status, 'status');
  const nextIndex = collection.indexOf(status) + delta;
  return collection[nextIndex] ?? null;
}

export function getNextGroupStatus(status) {
  return adjacentStatus(GROUP_STATES, status, 1);
}

export function getPreviousGroupStatus(status) {
  return adjacentStatus(GROUP_STATES, status, -1);
}

export function getNextPaymentStatus(status) {
  return adjacentStatus(PAYMENT_STATES, status, 1);
}

export function getPreviousPaymentStatus(status) {
  return adjacentStatus(PAYMENT_STATES, status, -1);
}

function isAdjacent(collection, fromStatus, toStatus) {
  const fromIndex = collection.indexOf(fromStatus);
  const toIndex = collection.indexOf(toStatus);
  return fromIndex >= 0 && toIndex >= 0 && Math.abs(fromIndex - toIndex) === 1;
}

function isManagerRole(actorRole) {
  return actorRole === 'host' || actorRole === 'admin';
}

export function canTransitionGroupStatus(fromStatus, toStatus, actorRole) {
  return isManagerRole(actorRole) && isAdjacent(GROUP_STATES, fromStatus, toStatus);
}

const participantPaymentTransitions = new Set([
  'pending>requested',
  'requested>pending',
]);

const managerPaymentTransitions = new Set([
  'requested>confirmed',
  'confirmed>requested',
]);

export function canTransitionPaymentStatus(fromStatus, toStatus, actorRole) {
  const transition = `${fromStatus}>${toStatus}`;
  if (actorRole === 'participant') return participantPaymentTransitions.has(transition);
  if (isManagerRole(actorRole)) return managerPaymentTransitions.has(transition);
  return false;
}

function normalizeTimestamp(timestamp) {
  const date = timestamp === undefined ? new Date() : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('timestamp must be a valid date value');
  }
  return date.toISOString();
}

export function createTransitionHistoryEntry({
  entityType,
  fromStatus,
  toStatus,
  actorRole,
  actorId = null,
  timestamp,
  reason = '',
}) {
  const states = entityType === 'group'
    ? GROUP_STATES
    : entityType === 'payment'
      ? PAYMENT_STATES
      : null;
  if (!states) throw new TypeError('entityType must be group or payment');
  assertKnownStatus(states, fromStatus, `${entityType} status`);
  assertKnownStatus(states, toStatus, `${entityType} status`);

  const entry = {
    entityType,
    fromStatus,
    toStatus,
    direction: states.indexOf(toStatus) > states.indexOf(fromStatus) ? 'forward' : 'rollback',
    actorRole,
    actorId,
    timestamp: normalizeTimestamp(timestamp),
  };
  if (reason) entry.reason = String(reason).slice(0, 300);
  return entry;
}

export function appendTransitionHistory(history, entry) {
  return [...(Array.isArray(history) ? history : []), entry];
}

function transitionResult(entityType, currentStatus, targetStatus, options) {
  const historyEntry = createTransitionHistoryEntry({
    entityType,
    fromStatus: currentStatus,
    toStatus: targetStatus,
    actorRole: options.actorRole,
    actorId: options.actorId,
    timestamp: options.timestamp,
    reason: options.reason,
  });
  return {
    status: targetStatus,
    historyEntry,
    history: appendTransitionHistory(options.history, historyEntry),
  };
}

export function transitionGroupStatus(currentStatus, targetStatus, options = {}) {
  assertKnownStatus(GROUP_STATES, currentStatus, 'group status');
  assertKnownStatus(GROUP_STATES, targetStatus, 'group status');
  if (!canTransitionGroupStatus(currentStatus, targetStatus, options.actorRole)) {
    throw transitionError(
      'GROUP_TRANSITION_NOT_ALLOWED',
      `Role ${options.actorRole || 'unknown'} cannot transition group ${currentStatus} to ${targetStatus}`,
    );
  }
  return transitionResult('group', currentStatus, targetStatus, options);
}

export function transitionPaymentStatus(currentStatus, targetStatus, options = {}) {
  assertKnownStatus(PAYMENT_STATES, currentStatus, 'payment status');
  assertKnownStatus(PAYMENT_STATES, targetStatus, 'payment status');
  if (!canTransitionPaymentStatus(currentStatus, targetStatus, options.actorRole)) {
    throw transitionError(
      'PAYMENT_TRANSITION_NOT_ALLOWED',
      `Role ${options.actorRole || 'unknown'} cannot transition payment ${currentStatus} to ${targetStatus}`,
    );
  }
  return transitionResult('payment', currentStatus, targetStatus, options);
}

function normalizedInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

export function calculateSplit(total, people, current = 0) {
  const normalizedTotal = normalizedInteger(total);
  const normalizedPeople = normalizedInteger(people);
  const normalizedCurrent = normalizedInteger(current);

  if (normalizedTotal === null || normalizedTotal < 0) {
    throw new RangeError('total must be a non-negative integer');
  }
  if (
    normalizedPeople === null
    || normalizedPeople < 1
    || normalizedPeople > MAX_GROUP_PARTICIPANTS
  ) {
    throw new RangeError(`people must be an integer between 1 and ${MAX_GROUP_PARTICIPANTS}`);
  }
  if (
    normalizedCurrent === null
    || normalizedCurrent < 0
    || normalizedCurrent > MAX_GROUP_PARTICIPANTS
  ) {
    throw new RangeError(`current must be an integer between 0 and ${MAX_GROUP_PARTICIPANTS}`);
  }

  const perPerson = Math.floor(normalizedTotal / normalizedPeople);
  const allocated = perPerson * normalizedPeople;
  const remainder = normalizedTotal - allocated;
  const hostAmount = perPerson + remainder;

  return {
    total: normalizedTotal,
    people: normalizedPeople,
    current: normalizedCurrent,
    perPerson,
    hostAmount,
    allocated,
    approximate: remainder > 0,
    remainder,
    savings: normalizedTotal - perPerson,
    remaining: Math.max(0, normalizedPeople - normalizedCurrent),
  };
}

export function calculateProductAllocation(total, productQuantity, selectedQuantity = 1) {
  const normalizedTotal = normalizedInteger(total);
  const normalizedProductQuantity = normalizedInteger(productQuantity);
  const normalizedSelectedQuantity = normalizedInteger(selectedQuantity);

  if (normalizedTotal === null || normalizedTotal < 0) {
    throw new RangeError('total must be a non-negative integer');
  }
  if (
    normalizedProductQuantity === null
    || normalizedProductQuantity < 1
    || normalizedProductQuantity > MAX_PRODUCT_QUANTITY
  ) {
    throw new RangeError(`productQuantity must be an integer between 1 and ${MAX_PRODUCT_QUANTITY}`);
  }
  if (
    normalizedSelectedQuantity === null
    || normalizedSelectedQuantity < 0
    || normalizedSelectedQuantity > normalizedProductQuantity
  ) {
    throw new RangeError('selectedQuantity must be an integer within the total product quantity');
  }

  const unitPrice = Math.floor(normalizedTotal / normalizedProductQuantity);
  const allocated = unitPrice * normalizedProductQuantity;
  const remainder = normalizedTotal - allocated;
  const selectedAmount = unitPrice * normalizedSelectedQuantity;

  return {
    total: normalizedTotal,
    productQuantity: normalizedProductQuantity,
    selectedQuantity: normalizedSelectedQuantity,
    unitPrice,
    allocated,
    approximate: remainder > 0,
    remainder,
    selectedAmount,
    hostSelectedAmount: selectedAmount + remainder,
    remainingQuantity: normalizedProductQuantity - normalizedSelectedQuantity,
  };
}

export function calculateGroupDealAllocation(deal, productQuantity, selectedQuantity = 1) {
  const merchantGroup = deal?.source === 'merchant' && deal?.saleType === 'group';
  if (!merchantGroup) {
    return calculateProductAllocation(
      Math.max(0, Math.floor(Number(deal?.originalPrice || 0))),
      productQuantity,
      selectedQuantity,
    );
  }

  const capacity = Math.min(
    MAX_PRODUCT_QUANTITY,
    Math.max(1, Math.floor(Number(productQuantity) || 1)),
  );
  const normalizedSelectedQuantity = normalizedInteger(selectedQuantity);
  if (
    normalizedSelectedQuantity === null
    || normalizedSelectedQuantity < 0
    || normalizedSelectedQuantity > capacity
  ) {
    throw new RangeError('selectedQuantity must be an integer within the total product quantity');
  }
  const hasExplicitSplitQuantity = Number.isInteger(Number(deal?.splitQuantity))
    && Number(deal.splitQuantity) > 0;
  const splitQuantity = hasExplicitSplitQuantity
    ? Number(deal.splitQuantity)
    : deal?.splitPricing === true ? capacity : 1;
  const pricing = resolveMerchantGroupPricing({
    originalPrice: deal.originalPrice,
    discountRate: deal.discountRate,
    totalQuantity: capacity,
    splitQuantity,
  });
  const selectedAmount = pricing.unitPrice * normalizedSelectedQuantity;

  return {
    total: pricing.discountedTotal,
    productQuantity: capacity,
    splitQuantity: pricing.splitQuantity,
    selectedQuantity: normalizedSelectedQuantity,
    unitPrice: pricing.unitPrice,
    allocated: pricing.allocated,
    approximate: pricing.approximate,
    remainder: pricing.remainder,
    selectedAmount,
    hostSelectedAmount: selectedAmount + pricing.remainder,
    remainingQuantity: capacity - normalizedSelectedQuantity,
  };
}

export function resolveGroupDealProgress(deal = {}, group = {}) {
  const isMerchantGroup = deal.source === 'merchant' && deal.saleType === 'group';
  const totalQuantity = Math.max(1, Math.floor(Number(
    group.totalQuantity
    ?? deal.totalQuantity
    ?? deal.productQuantity
    ?? deal.target
    ?? 1,
  )));
  const targetCount = Math.max(1, Math.floor(Number(
    group.targetCount
    ?? deal.targetCount
    ?? deal.targetPeople
    ?? (isMerchantGroup ? Math.min(MAX_GROUP_PARTICIPANTS, totalQuantity) : deal.target)
    ?? 1,
  )));
  const currentCount = Math.max(0, Math.floor(Number(
    group.currentCount
    ?? deal.currentCount
    ?? deal.currentPeople
    ?? deal.participantCount
    ?? (isMerchantGroup ? 0 : deal.current)
    ?? 0,
  )));
  const orderedQuantity = Math.max(0, Math.floor(Number(
    group.orderedQuantity
    ?? deal.orderedQuantity
    ?? deal.allocatedProductQuantity
    ?? deal.creatorQuantity
    ?? (isMerchantGroup ? deal.current : currentCount)
    ?? 0,
  )));

  return {
    isMerchantGroup,
    target: isMerchantGroup
      ? Math.max(1, Math.floor(Number(deal.target ?? totalQuantity)))
      : targetCount,
    targetCount,
    current: isMerchantGroup ? orderedQuantity : currentCount,
    currentCount,
    totalQuantity,
    orderedQuantity,
  };
}

export function validateTargetPeople(
  target,
  { current = 0, groupStatus = 'recruiting' } = {},
) {
  const normalizedTarget = normalizedInteger(target);
  const normalizedCurrent = normalizedInteger(current);

  if (!hasValue(GROUP_STATES, groupStatus)) {
    return { valid: false, code: 'INVALID_GROUP_STATUS', message: '그룹 상태가 올바르지 않습니다.' };
  }
  if (normalizedCurrent === null || normalizedCurrent < 0 || normalizedCurrent > MAX_GROUP_PARTICIPANTS) {
    return { valid: false, code: 'INVALID_CURRENT_COUNT', message: '현재 참여 인원이 올바르지 않습니다.' };
  }
  if (normalizedTarget === null || normalizedTarget < 1 || normalizedTarget > MAX_GROUP_PARTICIPANTS) {
    return {
      valid: false,
      code: 'TARGET_OUT_OF_RANGE',
      message: `목표 인원은 1~${MAX_GROUP_PARTICIPANTS}명으로 설정해 주세요.`,
    };
  }
  if (groupStatus === 'purchased' || groupStatus === 'delivered') {
    return { valid: false, code: 'TARGET_LOCKED', message: '상품 구매 완료 이후에는 목표 인원을 변경할 수 없습니다.' };
  }
  if (normalizedTarget < normalizedCurrent) {
    return {
      valid: false,
      code: 'TARGET_BELOW_CURRENT',
      message: '목표 인원은 현재 참여 인원보다 적게 설정할 수 없습니다.',
    };
  }

  return {
    valid: true,
    target: normalizedTarget,
    current: normalizedCurrent,
    max: MAX_GROUP_PARTICIPANTS,
  };
}
