import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Calendar,
  Calculator,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Heart,
  Home,
  Link as LinkIcon,
  MapPin,
  MessageCircle,
  Minus,
  Pencil,
  Plus,
  QrCode,
  Search,
  Send,
  Share2,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
  Upload,
  User,
  Users,
  X,
} from 'lucide-react';
import { eventDefinitions, sampleCommunityGroups, sampleDeals } from './data';
import { REGIONS } from './regions';
import SplitCalculator from './Calculator';
import GroupRoom from './GroupRoom';
import { RELEASE_FEATURES } from './releasePhase';
import { SCOPED_UI_ACTIONS } from './scopeUi';
import { createClientCapability } from './clientCapability';
import {
  customerOrderSyncFingerprint,
  customerOrderWriteContent,
  requestCustomerHistory,
} from './customerHistory';
import {
  acknowledgedPublicDealSnapshot,
  applyObservedPublicDealSync,
  applyPublicDealSyncResult,
  fetchPublicDealListRequest,
  publicDealPublicationState,
  publicDealSyncFingerprint as dealSyncFingerprint,
  publicDealSyncIssuesStorageKey,
  publishPublicDealRequest,
  shouldPublishPublicDeal,
} from './publicDealSync';
import {
  cancelGroupParticipation,
  claimGroupHost,
  createMutationId,
  createGroupRoom as initializeGroupRoom,
  fetchGroupSnapshot,
  fetchUnreadCounts,
  getGroupCredential,
  hasLegacyCustomerGroupRecoveryState,
  isGroupBackedDeal,
  joinGroupRoom,
  reserveGroupQuantity,
  rollbackGroupReservation,
  updateGroupTarget,
} from './groupApi';
import {
  applyMerchantParticipationCancellation,
  canCancelParticipation,
  cancelledOrderSnapshot,
  isCancelledOrder,
} from './participation';
import { buildCommerceStats } from './commerceStats';
import { mergeDeals, reconcilePublicDealCache } from './dealMerge';
import {
  canonicalOrderVersion,
  mergeAuthoritativeCustomerOrderRefresh,
  mergeAuthoritativeOwnerOrders,
  mergeCompletedCustomerOrderSync,
  mergeCustomerOrderCollections,
  mergeOwnerOrderRefresh,
  ownerOrderBelongsToWorkspace,
  summarizeOwnerOrderDisplay,
} from './orderMerge';
import {
  buildGroupNotifications,
  canSubmitDealOrder,
  canOpenOrderGroupRoom,
  dealHasGroupRoom,
  hostApplyErrorMessage,
  isDealRecruiting,
  isDealHostMatched,
  joinSubmitErrorMessage,
  resolveOrderLinkedDeal,
  shouldKeepOwnerPreview,
  shouldNavigateAfterDealDelete,
} from './customerUi';
import {
  assertCustomerMutationAllowed,
  customerCanOpenGroupRoom,
  filterCustomerNavigation,
  normalizeCustomerScreen,
  resolveCustomerAccess,
} from './customerAccess';
import {
  buildCustomerNavigationState,
  customerNavigationBackSteps,
  customerNavigationDepth,
  readCustomerNavigationState,
} from './customerNavigationHistory';
import {
  beginCheckoutAttempt,
  checkoutNeedsDurableOrderSync,
  completeCheckoutAttempt,
  isTerminalOrderSyncError,
  listRecoverableCheckoutAttempts,
  reconcileGroupCheckoutAttempts,
  publishCustomerOrderRequest,
  releaseCheckoutAttempt,
  updateCheckoutAttempt,
} from './checkoutAttempt';
import { canUseAcknowledgedCheckout, ensureGroupPaymentOrderSaved } from './paymentOrderPreflight';
import { orderSyncStateChanged, rejectedOrderSyncIssue, shouldPublishQueuedOrder } from './orderSyncState';
import {
  calculateProductAllocation,
  calculateSplit,
  formatGroupQuantityAllocation,
  GROUP_STATUS_LABELS,
  normalizeCategory,
  PRODUCT_CATEGORIES,
  resolveMerchantGroupPricing,
  resolveOwnerProductQuantity,
} from './trade';
import {
  assignOwnerDealScope,
  buildOwnerRecoveryCandidates,
  chunkOwnerCapabilities,
  isOwnerDealId,
  isOwnerDealInScope,
  legacyOwnerScopeKey,
  localOwnerScopeCandidates,
  ownerScopeKey,
  recoverableOwnerCapabilityEntries,
  reconcileOwnerRecovery,
  scopedOwnerCapabilityEntries,
} from './ownerCapabilities';
import {
  clearProfile,
  clearEvents,
  exportEventsCsv,
  exportOrdersCsv,
  flushPendingEvents,
  getEvents,
  getCustomerNumber,
  getProfile,
  getVisitorId,
  initAnalytics,
  saveProfile,
  track,
  trackPageview,
  useScreenAnalytics,
} from './analytics';
import { loadLegacyCustomerGroupReceipt } from './legacyGroupReceipt';
import {
  callableKoreanMobilePhone,
  formatKoreanMobilePhoneInput,
  isValidKoreanMobilePhone,
  KOREAN_MOBILE_PHONE_ERROR,
  normalizeKoreanMobilePhone as normalizePhone,
} from './profileValidation';
import {
  clearActiveAppSession,
  isActiveAppSession,
  loadActiveAppSession,
  startActiveAppSession,
} from './appSession';
import { cropImageDataUrl, prepareImageForSync, PRODUCT_IMAGE_MAX_SIZE, readImageFile } from './imageCrop';
import {
  buildOwnerBackup,
  mergeVerifiedOwnerBackup,
  parseOwnerBackup,
} from './ownerBackup';
import { clamp, discountedPrice, formatWon } from './utils';
import AdminConsole from './AdminConsole';
import { latestPaymentNotice, PAYMENT_NOTICE_SEEN_KEY } from './paymentNotices';

const fallbackImage =
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=900&q=80';

function replaceBrokenImage(event) {
  const image = event.currentTarget;
  if (image.src === fallbackImage) return;
  image.src = fallbackImage;
}

function ImageCropUploader({
  className,
  value,
  alt,
  buttonLabel,
  maxSize = PRODUCT_IMAGE_MAX_SIZE,
  onChange,
  onBusyChange,
  onUploaded,
}) {
  const [source, setSource] = useState('');
  const [crop, setCrop] = useState({ zoom: 1, offsetX: 0, offsetY: 0 });
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    onBusyChange?.(processing || Boolean(source));
  }, [onBusyChange, processing, source]);

  const selectFile = async (file) => {
    if (!file) return;
    setProcessing(true);
    setError('');
    try {
      const nextSource = await readImageFile(file);
      setCrop({ zoom: 1, offsetX: 0, offsetY: 0 });
      setSource(nextSource);
      onUploaded?.(file);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setProcessing(false);
    }
  };

  const applyCrop = async () => {
    if (!source || processing) return;
    setProcessing(true);
    setError('');
    try {
      onChange(await cropImageDataUrl(source, crop, { maxSize }));
      setSource('');
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className={className}>
      <img
        src={value || fallbackImage}
        alt={alt}
        onError={replaceBrokenImage}
      />
      <label className="secondary-button">
        <Upload size={18} />
        {processing ? '이미지 처리 중…' : buttonLabel}
        <input
          type="file"
          accept="image/*"
          disabled={processing}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            selectFile(file);
          }}
        />
      </label>
      {source && (
        <div className="image-crop-editor" role="group" aria-label="상품 이미지 자르기">
          <div className="image-crop-stage">
            <img
              src={source}
              alt="선택 영역 미리보기"
              style={{
                objectPosition: `${50 + crop.offsetX / 2}% ${50 + crop.offsetY / 2}%`,
                transform: `scale(${crop.zoom})`,
              }}
            />
          </div>
          <label>
            <span>사진 크기 <b>{Math.round(crop.zoom * 100)}%</b></span>
            <input
              type="range"
              min="100"
              max="300"
              step="5"
              value={Math.round(crop.zoom * 100)}
              onChange={(event) => setCrop((current) => ({
                ...current,
                zoom: Number(event.target.value) / 100,
              }))}
            />
          </label>
          <label>
            <span>좌우 위치</span>
            <input
              type="range"
              min="-100"
              max="100"
              value={crop.offsetX}
              onChange={(event) => setCrop((current) => ({
                ...current,
                offsetX: Number(event.target.value),
              }))}
            />
          </label>
          <label>
            <span>상하 위치</span>
            <input
              type="range"
              min="-100"
              max="100"
              value={crop.offsetY}
              onChange={(event) => setCrop((current) => ({
                ...current,
                offsetY: Number(event.target.value),
              }))}
            />
          </label>
          <div className="image-crop-actions">
            <button
              type="button"
              className="secondary-button compact-button"
              disabled={processing}
              onClick={() => setSource('')}
            >
              취소
            </button>
            <button
              type="button"
              className="primary-button compact-button"
              disabled={processing}
              onClick={applyCrop}
            >
              선택 영역 적용
            </button>
          </div>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
const CREATED_DEALS_KEY = 'o2o_mvp_created_deals';
const CUSTOMER_GROUPS_KEY = 'o2o_mvp_customer_groups';
const CUSTOMER_ORDERS_KEY = 'o2o_mvp_customer_orders';
const FAVORITES_KEY = 'o2o_mvp_favorite_deal_ids';
const HOST_DEALS_KEY = 'o2o_mvp_host_deal_ids';
const OWNER_NEIGHBORHOOD_KEY = 'o2o_mvp_owner_neighborhood';
const OWNER_LOCATION_KEY = 'o2o_mvp_owner_location';
const PUBLIC_DEAL_SYNCED_KEY = 'o2o_mvp_public_deal_sync_fingerprints';
const CUSTOMER_ORDER_SYNCED_KEY = 'o2o_mvp_customer_order_sync_fingerprints';
const CUSTOMER_ORDER_SYNC_ISSUES_KEY = 'o2o_mvp_customer_order_sync_issues_v1';
const PUBLIC_DEAL_CAPABILITIES_KEY = 'o2o_mvp_public_deal_capabilities_v1';
const OWNER_DEAL_SCOPES_KEY = 'o2o_mvp_owner_deal_scopes_v1';
const OWNER_LEGACY_RECOVERY_SCOPE_KEY = 'o2o_mvp_owner_legacy_recovery_scope_v1';
const ROLE_PROFILES_KEY = 'o2o_mvp_role_profiles_v1';
const CUSTOMER_ORDER_CAPABILITY_KEY = 'o2o_mvp_customer_order_capability_v1';
const GROUP_STATUS_SEEN_KEY = 'o2o_mvp_group_status_seen_v1';
const COUNTED_PARTICIPATIONS_KEY = 'o2o_mvp_counted_participations';
const PUBLIC_DEAL_SYNC_INTERVAL_MS = 60000;
const CUSTOMER_ORDER_SYNC_INTERVAL_MS = 30000;
const CUSTOMER_ORDER_PUBLISH_BUDGET = 3;
const EVENT_MIN_RELEASE_PHASE = Object.freeze({
  chat_message_sent: 8,
  chat_lock_changed: 8,
  unread_badge_viewed: 8,
  group_status_notice_viewed: 8,
  share_clicked: 9,
  group_shared: 9,
  group_deep_link_opened: 9,
});
const isEventVisibleInRelease = (eventName) => (
  Number(EVENT_MIN_RELEASE_PHASE[eventName] || 1) <= RELEASE_FEATURES.phase
);
let memoryCustomerOrderCapability = '';
let customerOrderCapabilityState = { created: false, persisted: true, lostKey: false };
const visibleEventDefinitions = eventDefinitions.filter((event) => isEventVisibleInRelease(event.name));
const DEFAULT_LOCATION = {
  region: '경기도',
  district: '성남시 분당구',
  neighborhood: '판교동',
};
const NEW_CUSTOMER_GROUP_DEAL = {
  id: 'new-customer-group',
  source: 'customer',
  saleType: 'community',
  category: '음식·간편식',
  store: '',
  title: '',
  description: '',
  address: '',
  deadline: '',
  methods: ['그룹배달'],
  originalPrice: 0,
  discountRate: 0,
  current: 0,
  target: 5,
  currentPeople: 0,
  targetPeople: 5,
  totalQuantity: 5,
  orderedQuantity: 0,
  unitPrice: 0,
  unitRemainder: 0,
  hostMode: 'self',
  hostMatched: true,
  image: fallbackImage,
  menu: [],
  isNewGroup: true,
};
const LEGACY_LOCATIONS = {
  '판교': DEFAULT_LOCATION,
  '판교동': DEFAULT_LOCATION,
  '운중동': { region: '경기도', district: '성남시 분당구', neighborhood: '운중동' },
  '화곡': { region: '서울특별시', district: '강서구', neighborhood: '화곡동' },
  '화곡동': { region: '서울특별시', district: '강서구', neighborhood: '화곡동' },
  '목동': { region: '서울특별시', district: '양천구', neighborhood: '목동' },
};
const ORDER_STAGES = [
  { id: 'new', label: '신규 주문', action: '주문 확인' },
  { id: 'preparing', label: '준비 중', action: '준비 완료' },
  { id: 'pickup_waiting', label: '픽업 대기', action: '픽업 완료' },
  { id: 'completed', label: '주문 완료', action: null },
];

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  const serialize = (input, stripImages = false) => JSON.stringify(input, (property, item) => (
    stripImages && property === 'image' && typeof item === 'string' && item.startsWith('data:image/')
      ? fallbackImage
      : item
  ));

  try {
    localStorage.setItem(key, serialize(value));
    return true;
  } catch (error) {
    const isQuotaError = error?.name === 'QuotaExceededError' || error?.code === 22 || error?.code === 1014;
    if (!isQuotaError) {
      console.warn('브라우저 저장소를 사용할 수 없어 이번 변경은 현재 화면에만 유지됩니다.');
      return false;
    }

    [CREATED_DEALS_KEY, CUSTOMER_GROUPS_KEY].forEach((storageKey) => {
      try {
        const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
        localStorage.setItem(storageKey, serialize(stored, true));
      } catch {
        // Keep the current in-memory state if an old malformed value cannot be compacted.
      }
    });

    try {
      localStorage.setItem(key, serialize(value, true));
      return true;
    } catch {
      console.warn('브라우저 저장공간이 부족해 이번 변경은 현재 화면에만 유지됩니다.');
      return false;
    }
  }
}

function getDealCapability(dealId, { create = false, ownerScope = ownerScopeKey(getProfile()) } = {}) {
  const capabilities = loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {});
  if (isOwnerDealId(dealId)) {
    const scopeByDeal = loadJson(OWNER_DEAL_SCOPES_KEY, {});
    if (!isOwnerDealInScope(dealId, scopeByDeal, ownerScope)) {
      if (!create) return '';
      const assignment = assignOwnerDealScope(scopeByDeal, dealId, ownerScope);
      if (!assignment.allowed) return '';
      if (assignment.changed && !saveJson(OWNER_DEAL_SCOPES_KEY, assignment.scopeByDeal)) return '';
    }
  }
  if (!capabilities[dealId] && create) {
    capabilities[dealId] = createClientCapability('deal');
    if (!saveJson(PUBLIC_DEAL_CAPABILITIES_KEY, capabilities)) return '';
  }
  return capabilities[dealId] || '';
}

function getOwnerCapabilityEntries(ownerScope, scopeByDeal) {
  const capabilities = loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {});
  return scopedOwnerCapabilityEntries(capabilities, scopeByDeal, ownerScope);
}

// This key is the only proof of ownership for every past order: the central
// read authorizes by its hash alone. A write that quietly fails hands the
// customer a brand-new identity on the next load and their whole history
// disappears, so it is persisted with the same quota recovery as every other
// stored value and the outcome is reported instead of being swallowed.
function persistCustomerOrderCapability(capability) {
  try {
    localStorage.setItem(CUSTOMER_ORDER_CAPABILITY_KEY, capability);
    return true;
  } catch {
    [CREATED_DEALS_KEY, CUSTOMER_GROUPS_KEY].forEach((storageKey) => {
      try {
        const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
        localStorage.setItem(storageKey, JSON.stringify(stored, (property, item) => (
          property === 'image' && typeof item === 'string' && item.startsWith('data:image/')
            ? fallbackImage
            : item
        )));
      } catch {
        // A malformed cached value must not stop the retry below.
      }
    });
    try {
      localStorage.setItem(CUSTOMER_ORDER_CAPABILITY_KEY, capability);
      return true;
    } catch {
      return false;
    }
  }
}

export function getCustomerOrderCapabilityState() {
  return customerOrderCapabilityState;
}

function getCustomerOrderCapability() {
  let capability = memoryCustomerOrderCapability;
  let stored = null;
  try {
    stored = localStorage.getItem(CUSTOMER_ORDER_CAPABILITY_KEY);
  } catch {
    // Storage is unreadable; fall through to the in-memory value below.
  }
  capability = stored || capability;
  if (!capability) {
    capability = createClientCapability('customer');
    // Minting a key on a first visit is normal. It only signals a problem when
    // this browser still holds orders whose ownership key is gone: the central
    // read authorizes by that key alone, so those orders can no longer be seen
    // and an empty list must not be reported as a checked history.
    let ordersWithoutKey = false;
    try {
      ordersWithoutKey = [CUSTOMER_ORDERS_KEY, CUSTOMER_ORDER_SYNCED_KEY].some((storageKey) => {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.length > 0 : Object.keys(parsed || {}).length > 0;
      });
    } catch {
      // An unreadable cache is not evidence either way.
    }
    customerOrderCapabilityState = {
      created: true,
      persisted: persistCustomerOrderCapability(capability),
      lostKey: ordersWithoutKey,
    };
  } else if (stored && !customerOrderCapabilityState.persisted) {
    customerOrderCapabilityState = { created: false, persisted: true, lostKey: false };
  }
  memoryCustomerOrderCapability = capability;
  return capability;
}

// 복구 코드 = 이 기기 주문 확인 키의 sha256. 서버가 소유 판정에 쓰는 값과 같은
// 공개 식별자라 화면에 보여도 권한이 넘어가지 않는다. 원문 키는 절대 내보내지
// 않는다. sha256 을 계산할 수 없는 환경에서는 틀린 값을 보여 주느니 실패시킨다:
// 잘못된 코드로 재연결하면 사용자는 끝내 자기 주문을 보지 못한다.
export async function getCustomerRecoveryCode() {
  if (!globalThis.crypto?.subtle) throw new Error('recovery_code_unavailable');
  const input = new TextEncoder().encode(getCustomerOrderCapability());
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchPublicDeals() {
  try {
    const deals = await fetchPublicDealListRequest();
    return deals.map((deal) => migrateMerchantSplitDeal({
        ...migrateLocationFields(deal),
        category: normalizeCategory(deal.category),
      }));
  } catch {
    return null;
  }
}

async function fetchOwnedRecords(endpoint, resultKey, capabilities) {
  const batches = chunkOwnerCapabilities(capabilities);
  if (!batches.length) return [];
  const records = [];
  for (const batch of batches) {
    let batchRecords = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list_owner', capabilities: batch }),
          signal: AbortSignal.timeout(20000),
        });
        const result = await response.json();
        if (response.ok && result.ok && Array.isArray(result[resultKey])) {
          batchRecords = result[resultKey];
          break;
        }
        if (![502, 503, 504].includes(response.status)) return null;
      } catch {
        // Retry a single transient owner workspace read before preserving the last good state.
      }
      if (attempt === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
    }
    if (!batchRecords) return null;
    records.push(...batchRecords);
  }
  return records;
}

async function fetchOwnedPublicDeals(capabilities) {
  const records = await fetchOwnedRecords('/api/public-deals', 'deals', capabilities);
  if (!records) return null;
  return records.map((deal) => migrateMerchantSplitDeal({
      ...migrateLocationFields(deal),
      category: normalizeCategory(deal.category),
    }));
}

async function fetchOwnedCustomerOrders(capabilities) {
  const records = await fetchOwnedRecords('/api/customer-orders', 'orders', capabilities);
  return records ? records.map((order) => migrateLocationFields(order)) : null;
}

async function publishPublicDeal(deal, options = {}) {
  try {
    const capabilityToken = getDealCapability(deal.id, { create: true });
    const {
      publishMutationId: _previousPublishMutationId,
      expectedPublishVersion: requestedExpectedPublishVersion,
      ...dealContent
    } = deal;
    const expectedPublishVersion = Math.max(0, Math.floor(Number(
      options.expectedPublishVersion
      ?? requestedExpectedPublishVersion
      ?? deal.publishVersion
      ?? 0
    )));
    const publishMutationId = String(
      options.publishMutationId || '',
    );
    const syncedDeal = {
      ...dealContent,
      visibility: 'public',
      image: await prepareImageForSync(deal.image || fallbackImage),
      publishVersion: Math.max(0, Math.floor(Number(deal.publishVersion || 0))),
      expectedPublishVersion,
      ...(publishMutationId ? { publishMutationId } : {}),
    };
    return await publishPublicDealRequest({
      action: 'publish',
      deal: syncedDeal,
      capabilityToken,
    }, {
      maxRetries: options.maxRetries,
      priority: options.priority,
    });
  } catch (error) {
    if (options.throwOnError) throw error;
    return null;
  }
}

async function fetchCustomerOrders(phone, { strict = false, signal, groupId } = {}) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    if (strict) throw new Error('invalid_customer_phone');
    return [];
  }
  try {
    const records = await requestCustomerHistory({
      phone: normalizedPhone,
      visitorId: getVisitorId(),
      customerCapabilityToken: getCustomerOrderCapability(),
      ...(groupId ? { groupId } : {}),
    }, { signal });
    return records.map((order) => migrateLocationFields(order));
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

async function publishCustomerOrder(order, options = {}) {
  try {
    const participantCredential = order.groupId
      ? getGroupCredential(
        order.groupId,
        order.participantActorId || order.visitorId || getVisitorId(),
      )
      : null;
    return await publishCustomerOrderRequest({
      action: 'publish',
      order: customerOrderWriteContent(order),
      visitorId: order.visitorId || getVisitorId(),
      customerCapabilityToken: getCustomerOrderCapability(),
      ...(order.groupId && participantCredential?.capabilityToken
        ? { participantCapabilityToken: participantCredential.capabilityToken }
        : {}),
    }, { priority: options.priority });
  } catch (error) {
    if (options.throwOnError) throw error;
    return null;
  }
}

async function manageCustomerOrder(order, deal, { kind, direction }) {
  const managerType = deal?.source === 'customer' ? 'group_manager' : 'merchant_owner';
  const expectedVersion = Math.max(1, canonicalOrderVersion(order));
  const clientMutationId = await stableClientMutationId(
    `manage_${kind}`,
    `${order.id}|${order.dealId || deal?.id}|${expectedVersion}|${direction}`,
  );
  const body = {
    action: 'manage',
    orderId: order.id,
    dealId: order.dealId || deal?.id,
    managerType,
    kind,
    direction,
    expectedVersion,
    clientMutationId,
  };
  if (managerType === 'merchant_owner') {
    const ownerCapabilityToken = getDealCapability(body.dealId);
    if (!ownerCapabilityToken) throw new Error('missing_owner_capability');
    body.ownerCapabilityToken = ownerCapabilityToken;
  } else {
    const actorId = getVisitorId();
    const credential = getGroupCredential(order.groupId || body.dealId, actorId);
    if (!credential?.capabilityToken || !['host', 'admin'].includes(credential.role)) {
      throw new Error('manager_capability_required');
    }
    body.actorId = actorId;
    body.capabilityToken = credential.capabilityToken;
  }
  const serializedBody = JSON.stringify(body);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch('/api/customer-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serializedBody,
      });
      let result = {};
      try {
        result = await response.json();
      } catch {
        result = {};
      }
      if (response.ok && result.ok && result.order) return result.order;
      const error = new Error(result.error || `order_manage_${response.status}`);
      error.status = response.status;
      error.code = result.error || '';
      lastError = error;
      if (![502, 503, 504].includes(response.status)) throw error;
    } catch (error) {
      lastError = error;
      const networkFailure = error instanceof TypeError;
      if (attempt >= 1 || (!networkFailure && ![502, 503, 504].includes(error?.status))) throw error;
    }
  }
  throw lastError || new Error('order_manage_failed');
}

async function stableClientMutationId(prefix, value) {
  const input = new TextEncoder().encode(String(value || ''));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `${prefix}-${hex.slice(0, 48)}`;
  }
  let hash = 2166136261;
  input.forEach((byte) => {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  });
  return `${prefix}-${(hash >>> 0).toString(36).padStart(8, '0')}`;
}

async function deletePublicDeal(deal) {
  const dealId = deal?.id;
  const expectedPublishVersion = Math.max(0, Math.floor(Number(deal?.publishVersion || 0)));
  const capabilityToken = getDealCapability(dealId);
  if (!capabilityToken) {
    const error = new Error('missing_owner_capability');
    error.code = 'missing_owner_capability';
    error.status = 403;
    throw error;
  }
  const clientMutationId = await stableClientMutationId(
    'delete-deal',
    `${dealId}:${expectedPublishVersion}`,
  );
  const response = await fetch('/api/public-deals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'delete',
      dealId,
      expectedPublishVersion,
      clientMutationId,
      capabilityToken,
    }),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if ((response.ok && result.ok) || ['deal_deleted', 'deal_not_found'].includes(result?.error)) {
    return true;
  }
  const error = new Error(result?.error || `deal_delete_${response.status}`);
  error.code = result?.error || 'deal_delete_failed';
  error.status = response.status;
  throw error;
}

function dealDeleteErrorMessage(error, networkNoun = '네트워크 연결') {
  const code = error?.code || error?.message;
  if (['missing_owner_capability', 'invalid_owner_capability', 'forbidden'].includes(code)) {
    return '이 기기에는 해당 상품의 관리 키가 없어 수정·삭제할 수 없습니다.';
  }
  if (['state_conflict', 'client_mutation_conflict'].includes(code)) {
    return '다른 변경이 먼저 반영되었습니다. 최신 목록을 확인한 뒤 다시 시도해 주세요.';
  }
  return `상품을 삭제하지 못했습니다. ${networkNoun}을 확인한 뒤 다시 시도해 주세요.`;
}

function getRegion(regionName) {
  return REGIONS.find((region) => region.name === regionName) || REGIONS.find((region) => region.name === DEFAULT_LOCATION.region) || REGIONS[0];
}

function getDistrict(region, districtName) {
  return region.districts.find((district) => district.name === districtName) || region.districts[0];
}

function normalizeLocation(value = {}) {
  const input = value || {};
  const legacy = LEGACY_LOCATIONS[input.neighborhood];
  const source = input.district ? input : (legacy || input);
  const region = getRegion(source.region);
  const district = getDistrict(region, source.district);
  const neighborhood = district.neighborhoods.includes(source.neighborhood)
    ? source.neighborhood
    : district.neighborhoods[0];
  return { region: region.name, district: district.name, neighborhood };
}

function migrateLocationFields(value = {}) {
  return { ...value, ...normalizeLocation(value) };
}

function locationKey(value = {}) {
  const location = normalizeLocation(value);
  return `${location.region}/${location.district}/${location.neighborhood}`;
}

function sameLocation(left = {}, right = {}) {
  return locationKey(left) === locationKey(right);
}

function formatLocation(value = {}, separator = ' · ') {
  const location = normalizeLocation(value);
  return [location.region, location.district, location.neighborhood].join(separator);
}

function preservePublicDealSyncOnMigration(previous, migrated) {
  let syncState = {
    acknowledgements: loadJson(PUBLIC_DEAL_SYNCED_KEY, {}),
    issues: loadJson(publicDealSyncIssuesStorageKey, {}),
  };
  previous.forEach((deal, index) => {
    if (JSON.stringify(deal) === JSON.stringify(migrated[index])) return;
    // Normalizing an old cache is not a new user edit or proof of publication.
    syncState = applyObservedPublicDealSync({ ...syncState, previous: deal, observed: migrated[index] });
  });
  saveJson(PUBLIC_DEAL_SYNCED_KEY, syncState.acknowledgements);
  saveJson(publicDealSyncIssuesStorageKey, syncState.issues);
}

function loadCreatedDeals() {
  const deals = loadJson(CREATED_DEALS_KEY, []);
  const migrated = deals.map((deal) => migrateMerchantSplitDeal({
    ...migrateLocationFields(deal),
    category: normalizeCategory(deal.category),
    visibility: deal.visibility || 'public',
  }));
  if (JSON.stringify(migrated) !== JSON.stringify(deals)) {
    preservePublicDealSyncOnMigration(deals, migrated);
    saveJson(CREATED_DEALS_KEY, migrated);
  }
  return migrated;
}

function saveCreatedDeals(deals) {
  saveJson(CREATED_DEALS_KEY, deals);
}

function loadCustomerGroups() {
  const groups = loadJson(CUSTOMER_GROUPS_KEY, []);
  const fallbackLocation = normalizeLocation(getProfile() || DEFAULT_LOCATION);
  const migrated = groups.map((group) => {
    const targetPeople = Math.min(20, Math.max(1, Number(group.targetPeople || group.target || 1)));
    const currentPeople = Math.max(0, Number(group.currentPeople ?? group.currentCount ?? group.current ?? 1));
    const totalQuantity = Math.min(999, Math.max(1, Number(group.totalQuantity || group.productQuantity || group.target || 1)));
    const creatorQuantity = Math.min(totalQuantity, Math.max(0, Number(group.creatorQuantity ?? group.creatorProductQuantity ?? 1)));
    const orderedQuantity = Math.min(totalQuantity, Math.max(0, Number(group.orderedQuantity ?? group.allocatedProductQuantity ?? creatorQuantity)));
    const allocation = calculateProductAllocation(Math.max(0, Math.floor(Number(group.originalPrice || 0))), totalQuantity, Math.min(1, totalQuantity));
    return migrateLocationFields({
      ...(group.neighborhood ? group : { ...group, ...fallbackLocation }),
      category: normalizeCategory(group.category),
      visibility: group.visibility || 'public',
      target: targetPeople,
      targetPeople,
      targetCount: targetPeople,
      current: currentPeople,
      currentPeople,
      currentCount: currentPeople,
      participantCount: Number(group.participantCount ?? currentPeople),
      quantityTracking: true,
      totalQuantity,
      productQuantity: totalQuantity,
      creatorQuantity,
      creatorProductQuantity: creatorQuantity,
      orderedQuantity,
      allocatedProductQuantity: orderedQuantity,
      unitPrice: Number(group.unitPrice ?? allocation.unitPrice),
      unitRemainder: Number(group.unitRemainder ?? group.splitRemainder ?? allocation.remainder),
      hostMode: group.hostMode === 'recruiting' ? 'recruiting' : 'self',
      hostMatched: group.hostMode === 'recruiting'
        ? Boolean(group.hostMatched || group.hostActorId)
        : true,
    });
  });
  if (JSON.stringify(migrated) !== JSON.stringify(groups)) {
    preservePublicDealSyncOnMigration(groups, migrated);
    saveJson(CUSTOMER_GROUPS_KEY, migrated);
  }
  return migrated;
}

function loadOrders() {
  const orders = loadJson(CUSTOMER_ORDERS_KEY, []);
  const profile = getProfile();
  const visitorId = getVisitorId();
  const migrated = orders.map((order) => migrateLocationFields({
    ...order,
    visitorId: order.visitorId || visitorId,
    customerNumber: order.customerNumber || getCustomerNumber(order.visitorId || visitorId),
    customerName: order.customerName || profile?.name || '테스트 사용자',
    customerPhone: order.customerPhone || profile?.phone || '미설정',
    status: order.status || 'new',
    // An empty central history is valid. Adding a synthetic legacy entry on
    // every read changes its acknowledged fingerprint and republishes forever.
    statusHistory: Array.isArray(order.statusHistory)
      ? order.statusHistory
      : [{ status: order.status || 'new', actor: 'legacy', timestamp: order.createdAt || new Date().toISOString() }],
    ...(order.region ? {} : order.deal || {}),
  }));
  if (JSON.stringify(migrated) !== JSON.stringify(orders)) saveJson(CUSTOMER_ORDERS_KEY, migrated);
  return migrated;
}

function isOrderForProfile(order, profile, visitorId) {
  if (!profile) return false;
  const profilePhone = normalizePhone(profile.phone);
  const orderPhone = normalizePhone(order.customerPhone);
  if (profilePhone && orderPhone) return profilePhone === orderPhone;
  return Boolean(visitorId && order.visitorId === visitorId);
}

function orderSyncFingerprint(order) {
  return customerOrderSyncFingerprint(order);
}

function buildCustomerOrderRecord(order, {
  orderId,
  createdAt,
  actorId,
  profile,
  reservationMutationId = '',
} = {}) {
  return {
    ...order,
    id: orderId,
    createdAt,
    status: 'new',
    paymentStatus: 'pending',
    visitorId: actorId,
    customerNumber: getCustomerNumber(),
    customerName: profile?.name || '테스트 사용자',
    customerPhone: profile?.phone || '미설정',
    region: order.deal?.region || profile?.region || DEFAULT_LOCATION.region,
    district: order.deal?.district || profile?.district || DEFAULT_LOCATION.district,
    neighborhood: order.deal?.neighborhood || profile?.neighborhood || '미설정',
    statusHistory: [{ status: 'new', actor: 'customer', timestamp: createdAt }],
    ...(reservationMutationId
      ? {
          reservationMutationId,
          clientMutationId: reservationMutationId,
        }
      : {}),
    publishMutationId: `publish-${orderId}-initial`,
  };
}

function isCustomerGroupCreatorOrder(order = {}) {
  return order.type === 'group'
    && order.deal?.source === 'customer'
    && Boolean(order.groupId || order.dealId || order.deal?.id);
}

function participationKey(order) {
  return `${order?.visitorId || getVisitorId()}:${order?.dealId || order?.deal?.id || ''}`;
}

function loadOwnerLocation() {
  const stored = loadJson(OWNER_LOCATION_KEY, null);
  let legacyNeighborhood = null;
  try {
    legacyNeighborhood = localStorage.getItem(OWNER_NEIGHBORHOOD_KEY);
  } catch {
    // Use the default owner location when browser storage is unavailable.
  }
  return normalizeLocation(stored || LEGACY_LOCATIONS[legacyNeighborhood] || DEFAULT_LOCATION);
}

function loadProfile() {
  const profile = getProfile();
  if (!profile) return null;
  const migrated = migrateLocationFields(profile);
  if (!isValidKoreanMobilePhone(migrated.phone)) {
    const legacyScope = legacyOwnerScopeKey(migrated);
    if (legacyScope) saveJson(OWNER_LEGACY_RECOVERY_SCOPE_KEY, legacyScope);
    return null;
  }
  if (JSON.stringify(migrated) !== JSON.stringify(profile)) saveProfile(migrated);
  return migrated;
}

function isSplitMerchantDeal(deal = {}) {
  if (deal.source !== 'merchant' || deal.saleType !== 'group' || deal.menu?.length !== 1) return false;
  if (
    deal.pricingModel === 'explicit_split'
    || Number(deal.pricingVersion || 0) >= 2
    || Object.prototype.hasOwnProperty.call(deal, 'splitQuantity')
  ) {
    return Math.max(1, Math.floor(Number(deal.splitQuantity) || 1)) > 1;
  }
  return deal.splitPricing === true
    || Number(deal.expectedPerPerson || 0) > 0
    || (Boolean(deal.approximatePrice) && Number(deal.totalQuantity || 0) > 0);
}

function getMerchantSplitQuantity(deal = {}) {
  const totalQuantity = Math.min(999, Math.max(1, Math.floor(Number(
    deal.totalQuantity ?? deal.productQuantity ?? deal.target ?? 1,
  )) || 1));
  if (Object.prototype.hasOwnProperty.call(deal, 'splitQuantity')) {
    return clamp(Math.floor(Number(deal.splitQuantity) || 1), 1, totalQuantity);
  }
  return isSplitMerchantDeal(deal) ? totalQuantity : 1;
}

function migrateMerchantSplitDeal(deal = {}) {
  const explicitPricing = deal.source === 'merchant'
    && deal.saleType === 'group'
    && (
      deal.pricingModel === 'explicit_split'
      || Number(deal.pricingVersion || 0) >= 2
      || Object.prototype.hasOwnProperty.call(deal, 'splitQuantity')
    );
  if (explicitPricing) {
    const totalQuantity = Math.min(999, Math.max(1, Math.floor(Number(
      deal.totalQuantity ?? deal.productQuantity ?? deal.target ?? 1,
    ))));
    const pricing = resolveMerchantGroupPricing({
      originalPrice: deal.originalPrice,
      discountRate: deal.discountRate,
      totalQuantity,
      splitQuantity: deal.splitQuantity,
    });
    const orderedQuantity = Math.min(
      totalQuantity,
      Math.max(0, Number(deal.orderedQuantity ?? deal.current ?? 0)),
    );
    return {
      ...deal,
      pricingModel: 'explicit_split',
      pricingVersion: 2,
      splitPricing: pricing.splitPricing,
      splitQuantity: pricing.splitQuantity,
      totalQuantity,
      productQuantity: totalQuantity,
      orderedQuantity,
      allocatedProductQuantity: orderedQuantity,
      expectedPerPerson: pricing.unitPrice,
      unitPrice: pricing.unitPrice,
      splitRemainder: pricing.remainder,
      unitRemainder: pricing.remainder,
      approximatePrice: pricing.approximate,
      menu: Array.isArray(deal.menu) && deal.menu.length
        ? deal.menu.map((item, index) => (index === 0 ? { ...item, price: pricing.unitPrice } : item))
        : deal.menu,
    };
  }
  if (isSplitMerchantDeal(deal)) return deal;
  const target = Math.min(999, Math.max(1, Math.floor(Number(deal.totalQuantity ?? deal.target ?? 1))));
  const discountedTotal = discountedPrice(deal.originalPrice, deal.discountRate);
  const isLegacyOwnerBundle = deal.source === 'merchant'
    && deal.saleType === 'group'
    && /^owner-/.test(String(deal.id || ''))
    && deal.menu?.length === 1
    && target > 1
    && Number(deal.menu[0]?.price || 0) === discountedTotal;
  if (!isLegacyOwnerBundle) return deal;
  const allocation = calculateProductAllocation(discountedTotal, target, 1);
  const orderedQuantity = Math.min(target, Math.max(0, Number(deal.orderedQuantity ?? deal.current ?? 0)));
  return {
    ...deal,
    splitPricing: true,
    totalQuantity: target,
    productQuantity: target,
    orderedQuantity,
    allocatedProductQuantity: orderedQuantity,
    expectedPerPerson: allocation.unitPrice,
    unitPrice: allocation.unitPrice,
    splitRemainder: allocation.remainder,
    unitRemainder: allocation.remainder,
    approximatePrice: allocation.approximate,
    menu: [{
      ...deal.menu[0],
      price: allocation.unitPrice,
      option: `${deal.menu[0].option || ''}${deal.menu[0].option ? ' · ' : ''}1개 예상금액`,
    }],
  };
}

function getDealPrice(deal) {
  if (deal.source === 'customer' && deal.menu?.[0]?.price !== undefined) return Number(deal.menu[0].price || 0);
  if (isSplitMerchantDeal(deal)) {
    return Number(deal.expectedPerPerson ?? deal.menu?.[0]?.price ?? 0);
  }
  return discountedPrice(deal.originalPrice, deal.discountRate);
}

function getDealQuantity(deal = {}) {
  const tracksQuantity = Boolean(deal.quantityTracking);
  const target = Math.max(1, Number(
    tracksQuantity
      ? deal.totalQuantity ?? deal.productQuantity ?? deal.target ?? 1
      : deal.target ?? 1,
  ));
  const fallbackOrdered = deal.source === 'customer'
    ? deal.creatorQuantity ?? deal.creatorProductQuantity ?? deal.current ?? 0
    : deal.current ?? 0;
  const ordered = clamp(Number(
    tracksQuantity
      ? deal.orderedQuantity ?? deal.allocatedProductQuantity ?? fallbackOrdered
      : deal.current ?? 0,
  ), 0, target);
  const targetPeople = Math.max(1, Number(deal.targetPeople ?? deal.targetCount ?? deal.target ?? 1));
  const currentPeople = Math.max(0, Number(
    deal.source === 'customer'
      ? deal.currentPeople ?? deal.currentCount ?? deal.participantCount ?? deal.current ?? 0
      : deal.participantCount ?? deal.currentPeople ?? deal.currentCount ?? 0,
  ));
  return {
    target,
    ordered,
    remaining: Math.max(0, target - ordered),
    participants: currentPeople,
    targetPeople,
    currentPeople,
  };
}

function getOrderStage(order) {
  return ORDER_STAGES.find((stage) => stage.id === order.status) || ORDER_STAGES[0];
}

function getOrderPaymentStatus(order = {}) {
  const status = String(order.paymentStatus || '');
  if (['pending', 'requested', 'confirmed'].includes(status)) return status;
  if (order.paymentConfirmedAt) return 'confirmed';
  if (order.paymentRequestedAt) return 'requested';
  return 'pending';
}

function normalizeRoute(pathname) {
  if (pathname === '/admin' && !RELEASE_FEATURES.admin) return '/';
  if (['/customer', '/owner', '/admin', '/dashboard'].includes(pathname)) return pathname;
  return '/';
}

function App() {
  const [analyticsReady, setAnalyticsReady] = useState(() => initAnalytics());
  const [route, setRoute] = useState(() => normalizeRoute(window.location.pathname));
  const [profile, setProfile] = useState(() => loadProfile());
  const [roleProfiles, setRoleProfiles] = useState(() => {
    const remembered = loadJson(ROLE_PROFILES_KEY, {});
    return profile?.testerType ? { ...remembered, [profile.testerType]: profile } : remembered;
  });
  const [activeAppSessionKey, setActiveAppSessionKey] = useState(() => {
    if (normalizeRoute(window.location.pathname) === '/') return '';
    return loadActiveAppSession();
  });
  const hasActiveProfileSession = isActiveAppSession(profile, activeAppSessionKey);
  const [ownerLocation, setOwnerLocation] = useState(() => loadOwnerLocation());
  const [ownerPreviewMode, setOwnerPreviewMode] = useState(false);
  const [previewLocation, setPreviewLocation] = useState(DEFAULT_LOCATION);
  const [customerScreen, setCustomerScreen] = useState(
    () => (hasActiveProfileSession ? 'list' : 'onboarding'),
  );
  const [adminEntryVersion, setAdminEntryVersion] = useState(0);
  const [ownerScreen, setOwnerScreen] = useState('form');
  const [createdDeals, setCreatedDeals] = useState(() => loadCreatedDeals());
  const publicDealSyncInFlight = useRef(new Map());
  const [ownerScopeByDeal, setOwnerScopeByDeal] = useState(() => loadJson(OWNER_DEAL_SCOPES_KEY, {}));
  const [legacyOwnerScope, setLegacyOwnerScope] = useState(() => (
    loadJson(OWNER_LEGACY_RECOVERY_SCOPE_KEY, '')
  ));
  const [ownedDeals, setOwnedDeals] = useState([]);
  const [ownerWorkspaceScope, setOwnerWorkspaceScope] = useState('');
  const [ownerWorkspaceStatus, setOwnerWorkspaceStatus] = useState('loading');
  const [ownerRecoveryCandidates, setOwnerRecoveryCandidates] = useState([]);
  const [ownerRecoveryBusy, setOwnerRecoveryBusy] = useState(false);
  const [ownerRecoveryError, setOwnerRecoveryError] = useState('');
  const [ownerRecoveryLookupVersion, setOwnerRecoveryLookupVersion] = useState(0);
  const [ownerBackupStatus, setOwnerBackupStatus] = useState('');
  const [customerGroups, setCustomerGroups] = useState(() => loadCustomerGroups());
  const [publicDealSyncIssues, setPublicDealSyncIssues] = useState(() => loadJson(publicDealSyncIssuesStorageKey, {}));
  const [remoteDeals, setRemoteDeals] = useState([]);
  const [orders, setOrders] = useState(() => loadOrders());
  const [ownerOrders, setOwnerOrders] = useState([]);
  const [customerHistoryState, setCustomerHistoryState] = useState({ scope: '', status: 'loading' });
  const customerHistoryRetryRef = useRef(null);
  const customerHistoryScope = profile?.testerType === '사용자' ? normalizePhone(profile.phone) : '';
  const customerHistoryScopeRef = useRef(customerHistoryScope);
  customerHistoryScopeRef.current = customerHistoryScope;
  const retryCustomerHistory = useCallback(() => customerHistoryRetryRef.current?.(), []);
  const [orderSyncIssues, setOrderSyncIssues] = useState(() => loadJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, {}));
  const [favoriteIds, setFavoriteIds] = useState(() => loadJson(FAVORITES_KEY, []));
  const [hostDealIds, setHostDealIds] = useState(() => loadJson(HOST_DEALS_KEY, []));
  const [selectedDeal, setSelectedDeal] = useState(() => loadCreatedDeals()[0] || sampleDeals[0]);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [statusNotices, setStatusNotices] = useState({});
  const [handledDeepLink, setHandledDeepLink] = useState('');
  const committedCustomerGroupIdsRef = useRef(new Set(
    customerGroups.map((group) => group.id).filter(Boolean),
  ));
  const activeOwnerScope = useMemo(() => (
    hasActiveProfileSession && profile?.testerType === '사장님' ? ownerScopeKey(profile) : ''
  ), [hasActiveProfileSession, profile]);
  const localOwnerProfiles = useMemo(() => localOwnerScopeCandidates({
    capabilities: loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {}),
    scopeByDeal: ownerScopeByDeal,
    excludeScope: activeOwnerScope,
  }), [activeOwnerScope, ownerScopeByDeal]);
  const ownerAccountHint = activeOwnerScope
    && localOwnerProfiles.length === 1
    ? localOwnerProfiles[0]
    : null;
  const rememberedOwnerProfile = useMemo(() => {
    if (roleProfiles['사장님']) return roleProfiles['사장님'];
    if (profile?.testerType === '사장님') return profile;
    if (localOwnerProfiles.length !== 1) return profile;
    return {
      ...(profile || {}),
      phone: formatKoreanMobilePhoneInput(localOwnerProfiles[0].phone),
      testerType: '사장님',
    };
  }, [localOwnerProfiles, profile, roleProfiles]);
  const scopedCreatedDeals = useMemo(() => createdDeals.filter((deal) => (
    deal?.source === 'merchant'
    && isOwnerDealInScope(deal.id, ownerScopeByDeal, activeOwnerScope)
  )), [activeOwnerScope, createdDeals, ownerScopeByDeal]);
  const scopedOwnedDeals = ownerWorkspaceScope === activeOwnerScope ? ownedDeals : [];
  const scopedOwnerOrders = ownerWorkspaceScope === activeOwnerScope ? ownerOrders : [];
  const customerAccess = resolveCustomerAccess({
    route,
    testerType: hasActiveProfileSession ? profile?.testerType : undefined,
    ownerPreviewMode,
  });
  const customerAdminMode = customerAccess.adminMode;
  const customerReadOnly = customerAccess.readOnly;
  const routeRef = useRef(route);
  routeRef.current = route;
  const navigateCustomerScreen = useCallback((nextScreen, options = {}) => {
    const normalizedScreen = normalizeCustomerScreen(nextScreen, {
      adminMode: customerAdminMode,
      readOnly: customerReadOnly,
    });
    if (!['/customer', '/admin'].includes(route)) {
      setCustomerScreen(normalizedScreen);
      return;
    }

    // Merchant preview is a temporary view layered over the owner workspace.
    // Keep its historical one-step browser return to `/owner`; the in-app
    // back control still uses the fallback branch below.
    if (customerReadOnly && options.historyAction !== 'back') {
      setCustomerScreen(normalizedScreen);
      return;
    }

    const currentDepth = customerNavigationDepth(window.history.state, route);
    const currentEntry = readCustomerNavigationState(window.history.state, route);
    if (options.historyAction === 'back') {
      const backSteps = customerNavigationBackSteps(
        window.history.state,
        route,
        normalizedScreen,
      );
      if (backSteps > 0) {
        window.history.go(-backSteps);
        return;
      }
      window.history.replaceState(
        buildCustomerNavigationState(window.history.state, {
          route,
          screen: normalizedScreen,
          depth: 0,
          trail: [],
        }),
        '',
        window.location.pathname,
      );
      setCustomerScreen(normalizedScreen);
      return;
    }

    if (normalizedScreen !== customerScreen || currentEntry?.screen !== normalizedScreen) {
      window.history.pushState(
        buildCustomerNavigationState(window.history.state, {
          route,
          screen: normalizedScreen,
          depth: currentDepth + 1,
          trail: [...(currentEntry?.trail || []), currentEntry?.screen || customerScreen],
        }),
        '',
        window.location.pathname,
      );
      setHandledDeepLink('');
    }
    setCustomerScreen(normalizedScreen);
  }, [customerAdminMode, customerReadOnly, customerScreen, route]);
  const assertCurrentCustomerMutationAllowed = () => assertCustomerMutationAllowed({
    adminMode: customerAdminMode,
    readOnly: customerReadOnly,
  });

  useLayoutEffect(() => {
    if (route === '/') clearActiveAppSession();
  }, [route]);

  useEffect(() => {
    if (!['/customer', '/admin'].includes(route)) return;
    const currentEntry = readCustomerNavigationState(window.history.state, route);
    if (currentEntry?.screen === customerScreen) return;
    window.history.replaceState(
      buildCustomerNavigationState(window.history.state, {
        route,
        screen: customerScreen,
        depth: currentEntry?.depth || 0,
        trail: currentEntry?.trail || [],
      }),
      '',
      window.location.href,
    );
  }, [customerScreen, route]);

  useEffect(() => {
    saveJson(ROLE_PROFILES_KEY, roleProfiles);
  }, [roleProfiles]);

  const updateOrderSyncIssue = useCallback((orderId, issue = null) => {
    if (!orderId) return;
    // Persist synchronously so another in-flight result sees this decision
    // before React renders it, and cannot resurrect an obsolete failure.
    const next = { ...loadJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, {}) };
    if (issue) next[orderId] = issue;
    else delete next[orderId];
    saveJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, next);
    setOrderSyncIssues(next);
  }, []);

  const commitCustomerGroup = useCallback((group) => {
    if (!group?.id || group.source !== 'customer') return group;
    const firstCommit = !committedCustomerGroupIdsRef.current.has(group.id);
    committedCustomerGroupIdsRef.current.add(group.id);
    setCustomerGroups((current) => {
      const next = [group, ...current.filter((item) => item.id !== group.id)];
      saveJson(CUSTOMER_GROUPS_KEY, next);
      return next;
    });
    setSelectedDeal(group);
    setRemoteDeals((current) => mergeDeals([group], current.filter((item) => item.id !== group.id)));
    const fingerprints = loadJson(PUBLIC_DEAL_SYNCED_KEY, {});
    fingerprints[group.id] = dealSyncFingerprint(group);
    saveJson(PUBLIC_DEAL_SYNCED_KEY, fingerprints);
    if (firstCommit) {
      track('group_created', {
        deal_id: group.id,
        source: 'customer',
        category: group.category,
        method: group.methods?.[0] || '',
        title: group.title,
        target_people: Number(group.targetPeople || group.targetCount || group.target || 1),
        total_quantity: Number(group.totalQuantity || group.productQuantity || 1),
        creator_quantity: Number(group.creatorQuantity || group.creatorProductQuantity || 1),
        host_mode: group.hostMode || 'self',
      });
    }
    return group;
  }, []);

  const discardCustomerGroup = useCallback((groupId) => {
    if (!groupId) return;
    committedCustomerGroupIdsRef.current.delete(groupId);
    setCustomerGroups((current) => {
      const next = current.filter((item) => item.id !== groupId);
      saveJson(CUSTOMER_GROUPS_KEY, next);
      return next;
    });
    setRemoteDeals((current) => current.filter((item) => item.id !== groupId));
    setSelectedDeal((current) => (current?.id === groupId ? null : current));
    const fingerprints = loadJson(PUBLIC_DEAL_SYNCED_KEY, {});
    delete fingerprints[groupId];
    saveJson(PUBLIC_DEAL_SYNCED_KEY, fingerprints);
  }, []);

  const discardCustomerOrder = useCallback((orderId) => {
    if (!orderId) return;
    setOrders((current) => {
      const next = current.filter((item) => item.id !== orderId);
      saveJson(CUSTOMER_ORDERS_KEY, next);
      return next;
    });
    const fingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
    delete fingerprints[orderId];
    saveJson(CUSTOMER_ORDER_SYNCED_KEY, fingerprints);
    updateOrderSyncIssue(orderId);
  }, [updateOrderSyncIssue]);

  const compensateCustomerGroupCreation = useCallback(async (
    order,
    { finalize = true, deletePublishedDeal = true } = {},
  ) => {
    const groupId = order?.groupId || order?.dealId || order?.deal?.id;
    const reservationMutationId = order?.reservationMutationId || order?.clientMutationId;
    const quantity = Math.max(1, Number(order?.selectedCount || order?.quantity || 1));
    if (!groupId || !order?.deal || !reservationMutationId) {
      const error = new Error('group_creation_cleanup_pending');
      error.code = 'group_creation_cleanup_pending';
      throw error;
    }
    if (deletePublishedDeal) {
      const publicDealDeleted = await deletePublicDeal(order.deal);
      if (!publicDealDeleted) {
        const error = new Error('group_creation_cleanup_pending');
        error.code = 'group_creation_cleanup_pending';
        throw error;
      }
    }
    try {
      const rollbackMutationId = await stableClientMutationId(
        'rollback-reservation',
        `${groupId}:${reservationMutationId}:${quantity}`,
      );
      await rollbackGroupReservation(
        groupId,
        quantity,
        order.visitorId || getVisitorId(),
        reservationMutationId,
        rollbackMutationId,
      );
    } catch (rollbackError) {
      const rollbackCode = rollbackError?.code || rollbackError?.message;
      if (!['group_not_found', 'reservation_not_found'].includes(rollbackCode)) {
        const error = new Error('group_creation_cleanup_pending');
        error.code = 'group_creation_cleanup_pending';
        error.cause = rollbackError;
        throw error;
      }
    }
    discardCustomerGroup(groupId);
    if (finalize) {
      discardCustomerOrder(order.id);
      completeCheckoutAttempt(order.id);
    }
    track('group_creation_compensated', {
      group_id: groupId,
      order_id: order.id,
      reservation_mutation_id: reservationMutationId,
    });
    try {
      window.dispatchEvent(new CustomEvent('o2o-group-creation-compensated', {
        detail: { groupId, orderId: order.id },
      }));
    } catch {
      // The persisted cleanup is authoritative even if this tab cannot emit a UI event.
    }
    return true;
  }, [discardCustomerGroup, discardCustomerOrder]);

  const deals = useMemo(
    () => mergeDeals(
      createdDeals,
      customerGroups,
      remoteDeals,
      sampleDeals.map((deal) => ({ ...deal, category: normalizeCategory(deal.category) })),
      sampleCommunityGroups.map((deal) => ({ ...deal, category: normalizeCategory(deal.category) })),
    ).filter((deal) => deal.visibility !== 'deleted'),
    [createdDeals, customerGroups, remoteDeals],
  );

  useEffect(() => {
    setOwnedDeals([]);
    setOwnerOrders([]);
    setOwnerRecoveryCandidates([]);
    setOwnerRecoveryBusy(false);
    setOwnerRecoveryError('');
    setOwnerWorkspaceScope(activeOwnerScope);
    setOwnerScreen('form');
  }, [activeOwnerScope]);

  useEffect(() => {
    setSelectedDeal((current) => {
      const latest = deals.find((deal) => deal.id === current?.id);
      return latest && latest !== current ? latest : current;
    });
  }, [deals]);

  const [paymentNotices, setPaymentNotices] = useState({});
  const paymentNoticeReceipts = useRef({});
  useEffect(() => {
    setPaymentNotices({});
    paymentNoticeReceipts.current = {};
  }, [profile, route]);

  const acknowledgePayments = (groupId) => {
    const receipt = paymentNoticeReceipts.current[groupId];
    if (!receipt) return;
    const seen = loadJson(PAYMENT_NOTICE_SEEN_KEY, {});
    seen[receipt.key] = receipt.id;
    saveJson(PAYMENT_NOTICE_SEEN_KEY, seen);
    setPaymentNotices((current) => { const next = { ...current }; delete next[groupId]; return next; });
  };

  useEffect(() => {
    if (!profile || !RELEASE_FEATURES.unreadBadges) {
      setUnreadCounts({});
      return undefined;
    }
    let cancelled = false;
    let refreshingUnread = false;
    const refreshUnread = async () => {
      if (refreshingUnread || document.visibilityState === 'hidden') return;
      refreshingUnread = true;
      try {
        const next = await fetchUnreadCounts({ adminMode: customerAdminMode, onSnapshot: (groupId, snapshot, actorId) => {
          if (cancelled) return;
          const key = `${groupId}::${actorId}`;
          const seen = loadJson(PAYMENT_NOTICE_SEEN_KEY, {});
          const notice = latestPaymentNotice(snapshot, actorId, seen[key]);
          if (notice) {
            paymentNoticeReceipts.current[groupId] = { key, id: notice.id };
            setPaymentNotices((current) => current[groupId] === notice.text ? current : { ...current, [groupId]: notice.text });
          }
        } });
        if (!cancelled) setUnreadCounts(next);
      } finally {
        refreshingUnread = false;
      }
    };
    refreshUnread();
    const timer = window.setInterval(refreshUnread, 5000);
    const handleFocus = () => refreshUnread();
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pageshow', handleFocus);
    window.addEventListener('online', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);
    window.addEventListener('o2o-group-fallback-updated', handleFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pageshow', handleFocus);
      window.removeEventListener('online', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
      window.removeEventListener('o2o-group-fallback-updated', handleFocus);
    };
  }, [customerAdminMode, profile, route]);

  useEffect(() => {
    if (!RELEASE_FEATURES.unreadBadges || !profile || !['/customer', '/admin'].includes(route)) {
      setStatusNotices({});
      return;
    }
    const actorId = customerAdminMode ? `${getVisitorId()}_admin` : getVisitorId();
    const seen = loadJson(GROUP_STATUS_SEEN_KEY, {});
    const next = {};
    deals.forEach((deal) => {
      if (deal.source !== 'customer' || !getGroupCredential(deal.id, actorId)) return;
      const status = deal.groupStatus || 'recruiting';
      if (status !== 'recruiting' && seen[`${deal.id}::${actorId}`] !== status) {
        next[deal.id] = status;
      }
    });
    setStatusNotices(next);
  }, [customerAdminMode, deals, profile, route]);

  const acknowledgeGroupStatus = (deal) => {
    if (customerReadOnly || !RELEASE_FEATURES.unreadBadges) return;
    acknowledgePayments(deal?.id);
    const status = deal?.groupStatus || 'recruiting';
    if (!deal?.id || status === 'recruiting') return;
    const actorId = customerAdminMode ? `${getVisitorId()}_admin` : getVisitorId();
    const seen = loadJson(GROUP_STATUS_SEEN_KEY, {});
    seen[`${deal.id}::${actorId}`] = status;
    saveJson(GROUP_STATUS_SEEN_KEY, seen);
    setStatusNotices((current) => {
      const next = { ...current };
      delete next[deal.id];
      return next;
    });
    track('group_status_notice_viewed', { group_id: deal.id, group_status: status });
  };

  const openGroupNotification = (deal, destination = 'detail') => {
    if (!deal?.id) return;
    acknowledgeGroupStatus(deal);
    setSelectedDeal(deal);
    navigateCustomerScreen(destination === 'room' ? 'room' : 'detail');
    track('group_notification_opened', {
      group_id: deal.id,
      destination: destination === 'room' ? 'room' : 'detail',
      unread_count: Number(unreadCounts[deal.id] || 0),
      has_status_notice: Boolean(statusNotices[deal.id]),
    });
  };

  const handleRoomRead = useCallback((groupId) => {
    setUnreadCounts((current) => (
      Number(current[groupId] || 0) > 0 ? { ...current, [groupId]: 0 } : current
    ));
  }, []);

  useEffect(() => {
    if (route !== '/owner' || !activeOwnerScope) {
      return undefined;
    }
    let cancelled = false;
    let refreshing = false;
    const refreshOwnerWorkspace = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      const capabilities = getOwnerCapabilityEntries(activeOwnerScope, ownerScopeByDeal);
      refreshing = true;
      try {
        const [verifiedOwnerDeals, nextOrders] = await Promise.all([
          fetchOwnedPublicDeals(capabilities),
          fetchOwnedCustomerOrders(capabilities),
        ]);
        if (cancelled) return;
        if (verifiedOwnerDeals) {
          setOwnedDeals(verifiedOwnerDeals);
        }
        if (nextOrders) {
          setOwnerOrders((current) => mergeOwnerOrderRefresh(current, nextOrders));
        }
        setOwnerWorkspaceStatus(!verifiedOwnerDeals || !nextOrders
          ? 'error' : !capabilities.length ? 'unlinked'
            : verifiedOwnerDeals.length || nextOrders.length ? 'ready' : 'unconfirmed');
        setOwnerWorkspaceScope(activeOwnerScope);
      } finally {
        refreshing = false;
      }
    };
    const handleVisible = () => {
      if (document.visibilityState === 'visible') refreshOwnerWorkspace();
    };
    setOwnerWorkspaceStatus('loading');
    refreshOwnerWorkspace();
    const timer = window.setInterval(refreshOwnerWorkspace, CUSTOMER_ORDER_SYNC_INTERVAL_MS);
    window.addEventListener('focus', refreshOwnerWorkspace);
    window.addEventListener('online', refreshOwnerWorkspace);
    window.addEventListener('pageshow', refreshOwnerWorkspace);
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOwnerWorkspace);
      window.removeEventListener('online', refreshOwnerWorkspace);
      window.removeEventListener('pageshow', refreshOwnerWorkspace);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [activeOwnerScope, ownerRecoveryLookupVersion, ownerScopeByDeal, route]);

  useEffect(() => {
    if (route !== '/owner' || !activeOwnerScope) {
      setOwnerRecoveryCandidates([]);
      return undefined;
    }
    setOwnerRecoveryCandidates([]);
    let cancelled = false;
    let loading = false;
    const loadRecoveryCandidates = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      const storedCapabilities = loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {});
      const recoveryCapabilities = recoverableOwnerCapabilityEntries(
        storedCapabilities,
        ownerScopeByDeal,
        legacyOwnerScope,
      );
      if (!recoveryCapabilities.length) {
        setOwnerRecoveryCandidates([]);
        setOwnerRecoveryError('');
        return;
      }
      loading = true;
      setOwnerRecoveryError('');
      try {
        const recoverableOwnerDeals = await fetchOwnedPublicDeals(recoveryCapabilities);
        if (cancelled) return;
        if (!recoverableOwnerDeals) {
          setOwnerRecoveryError('이 브라우저의 미연결 상품 관리키 확인이 지연되고 있습니다. 다시 확인해 주세요.');
          return;
        }
        setOwnerRecoveryCandidates(
          buildOwnerRecoveryCandidates({
            capabilities: storedCapabilities,
            scopeByDeal: ownerScopeByDeal,
            verifiedDeals: recoverableOwnerDeals,
            recoveryScope: activeOwnerScope,
            legacyScope: legacyOwnerScope,
          }),
        );
      } finally {
        loading = false;
      }
    };
    const handleVisible = () => {
      if (document.visibilityState === 'visible') loadRecoveryCandidates();
    };
    loadRecoveryCandidates();
    window.addEventListener('online', loadRecoveryCandidates);
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('online', loadRecoveryCandidates);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [activeOwnerScope, legacyOwnerScope, ownerRecoveryLookupVersion, ownerScopeByDeal, route]);

  const recoverOwnerDeals = useCallback(async () => {
    if (!activeOwnerScope || ownerRecoveryBusy || ownerRecoveryCandidates.length === 0) return;
    const candidateLines = ownerRecoveryCandidates.slice(0, 5).map((entry) => (
      `- ${entry.title || '상품명 미확인'}${entry.store ? ` · ${entry.store}` : ''}`
    ));
    if (ownerRecoveryCandidates.length > candidateLines.length) {
      candidateLines.push(`- 외 ${ownerRecoveryCandidates.length - candidateLines.length}개`);
    }
    const confirmed = window.confirm(
      `이 브라우저에 저장된 미연결 상품 관리키 ${ownerRecoveryCandidates.length}개를 현재 사장님 화면에 연결할까요?\n\n${candidateLines.join('\n')}\n\n상품명과 매장을 확인해 주세요. 이 관리키는 계정 본인 확인 정보가 아닙니다. 공용 기기이거나 다른 사장님이 사용하던 기기라면 취소해 주세요.`,
    );
    if (!confirmed) return;

    setOwnerRecoveryBusy(true);
    setOwnerRecoveryError('');
    try {
      const requestedOwnerScope = activeOwnerScope;
      const requestCapabilities = loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {});
      const requestedRecoveryEntries = ownerRecoveryCandidates
        .filter((entry) => (
          entry.recoveryScope === requestedOwnerScope
          && requestCapabilities?.[entry.dealId] === entry.capabilityToken
        ));
      if (!requestedRecoveryEntries.length) {
        setOwnerRecoveryError('현재 사장님 정보와 상품 연결 후보가 달라졌습니다. 다시 확인해 주세요.');
        return;
      }
      const recoverableOwnerDeals = await fetchOwnedPublicDeals(
        requestedRecoveryEntries.map(({ dealId, capabilityToken }) => ({
          dealId,
          capabilityToken,
        })),
      );
      if (!recoverableOwnerDeals) {
        setOwnerRecoveryError('상품 관리키를 서버에서 다시 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      const currentOwnerScope = ownerScopeKey(loadProfile());
      if (currentOwnerScope !== requestedOwnerScope) {
        setOwnerRecoveryError('사장님 계정 정보가 변경되어 상품을 연결하지 않았습니다. 다시 확인해 주세요.');
        return;
      }

      // Re-read both stores after the network boundary. This preserves changes
      // from another tab and rejects capabilities that changed while awaiting.
      const currentCapabilities = loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {});
      const currentScopeByDeal = loadJson(OWNER_DEAL_SCOPES_KEY, {});
      const result = reconcileOwnerRecovery({
        capabilities: currentCapabilities,
        scopeByDeal: currentScopeByDeal,
        expectedOwnerScope: requestedOwnerScope,
        currentOwnerScope,
        requestedRecoveryEntries,
        verifiedDealIds: recoverableOwnerDeals.map((deal) => deal.id),
        legacyScope: legacyOwnerScope,
      });
      if (!result.changed || !saveJson(OWNER_DEAL_SCOPES_KEY, result.scopeByDeal)) {
        setOwnerRecoveryError('상품 연결 정보를 확인하지 못했습니다. 새로고침 후 다시 시도해 주세요.');
        return;
      }
      setOwnerScopeByDeal(result.scopeByDeal);
      if (legacyOwnerScope && !Object.values(result.scopeByDeal).includes(legacyOwnerScope)) {
        saveJson(OWNER_LEGACY_RECOVERY_SCOPE_KEY, '');
        setLegacyOwnerScope('');
      }
      setOwnerRecoveryCandidates([]);
      track('owner_products_recovered', { product_count: result.recoveredDealIds.length });
    } finally {
      setOwnerRecoveryBusy(false);
    }
  }, [
    activeOwnerScope,
    ownerRecoveryBusy,
    ownerRecoveryCandidates,
    legacyOwnerScope,
  ]);

  const handleOwnerRecoveryAction = useCallback(() => {
    if (ownerRecoveryCandidates.length > 0) {
      recoverOwnerDeals();
      return;
    }
    setOwnerRecoveryLookupVersion((current) => current + 1);
  }, [ownerRecoveryCandidates.length, recoverOwnerDeals]);

  const exportOwnerManagementBackup = useCallback(() => {
    setOwnerBackupStatus('');
    try {
      const backup = buildOwnerBackup({
        ownerScope: activeOwnerScope,
        capabilities: loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {}),
        scopeByDeal: loadJson(OWNER_DEAL_SCOPES_KEY, {}),
      });
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `o2o-사장님-관리백업-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setOwnerBackupStatus(`상품 관리키 ${backup.entries.length}개를 백업했습니다. 파일은 안전하게 보관해 주세요.`);
      track('owner_management_backup_exported', { product_count: backup.entries.length });
    } catch (error) {
      setOwnerBackupStatus(
        error?.message === 'owner_backup_empty'
          ? '백업할 등록 상품이 없습니다.'
          : '관리 데이터 백업 파일을 만들지 못했습니다.',
      );
    }
  }, [activeOwnerScope]);

  const importOwnerManagementBackup = useCallback(async (file) => {
    if (!file || !activeOwnerScope) return;
    setOwnerBackupStatus('백업 파일을 확인하고 있습니다…');
    try {
      if (Number(file.size || 0) > 256 * 1024) throw new Error('owner_backup_invalid');
      const parsed = parseOwnerBackup(await file.text(), activeOwnerScope);
      const verifiedDeals = await fetchOwnedPublicDeals(parsed.entries);
      if (!verifiedDeals) throw new Error('owner_backup_server_unreachable');
      const previousCapabilities = loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {});
      const previousScopeByDeal = loadJson(OWNER_DEAL_SCOPES_KEY, {});
      const result = mergeVerifiedOwnerBackup({
        ownerScope: activeOwnerScope,
        entries: parsed.entries,
        verifiedDealIds: verifiedDeals.map((deal) => deal.id),
        capabilities: previousCapabilities,
        scopeByDeal: previousScopeByDeal,
      });
      if (!result.restoredDealIds.length) throw new Error('owner_backup_unverified');
      if (!saveJson(PUBLIC_DEAL_CAPABILITIES_KEY, result.capabilities)) {
        throw new Error('owner_backup_save_failed');
      }
      if (!saveJson(OWNER_DEAL_SCOPES_KEY, result.scopeByDeal)) {
        saveJson(PUBLIC_DEAL_CAPABILITIES_KEY, previousCapabilities);
        throw new Error('owner_backup_save_failed');
      }
      setOwnerScopeByDeal(result.scopeByDeal);
      setOwnedDeals(verifiedDeals.filter((deal) => result.restoredDealIds.includes(deal.id)));
      setOwnerWorkspaceScope(activeOwnerScope);
      setOwnerRecoveryLookupVersion((current) => current + 1);
      setOwnerBackupStatus(
        `상품 ${result.restoredDealIds.length}개를 복원했습니다. 주문·이력은 서버에서 다시 불러옵니다.${result.conflicts.length ? ` 충돌 ${result.conflicts.length}개는 제외했습니다.` : ''}`,
      );
      track('owner_management_backup_imported', { product_count: result.restoredDealIds.length });
    } catch (error) {
      setOwnerBackupStatus(
        error?.message === 'owner_backup_server_unreachable'
          ? '서버에 연결하지 못해 복원을 중단했습니다. 네트워크를 확인해 주세요.'
          : error?.message === 'owner_backup_unverified'
            ? '서버에서 확인된 상품 관리키가 없어 복원하지 않았습니다.'
            : '현재 사장님 번호에서 사용할 수 있는 O2O 관리 백업 파일이 아닙니다.',
      );
    }
  }, [activeOwnerScope]);

  useEffect(() => {
    const routeSessionReady = hasActiveProfileSession && (
      route === '/customer' || (route === '/admin' && profile?.testerType === '관리자')
    );
    if (!RELEASE_FEATURES.deepLinks || !profile || !routeSessionReady) return;
    const groupId = new URLSearchParams(window.location.search).get('group');
    if (!groupId) return;
    const requestedView = new URLSearchParams(window.location.search).get('view');
    const deepLinkKey = `${route}:${groupId}:${requestedView || 'detail'}:${profile.phone || profile.name}`;
    if (handledDeepLink === deepLinkKey) return;
    const linkedDeal = deals.find((deal) => deal.id === groupId);
    if (!linkedDeal) return;
    acknowledgeGroupStatus(linkedDeal);
    setSelectedDeal(linkedDeal);
    setCustomerScreen(requestedView === 'room' ? 'room' : 'detail');
    setHandledDeepLink(deepLinkKey);
    track('group_deep_link_opened', {
      group_id: groupId,
      destination: requestedView === 'room' ? 'room' : 'detail',
      signed_in: true,
    });
  }, [deals, handledDeepLink, hasActiveProfileSession, profile, route]);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    const observedMutations = new Map();
    const reconcileCaches = (snapshots) => {
      const reconcileSavedCache = (current, persist) => {
        const next = reconcilePublicDealCache(current, snapshots);
        if (next === current) return current;
        persist(next);
        const nextById = new Map(next.map((deal) => [deal.id, deal]));
        const centralById = new Map(snapshots.map((deal) => [deal.id, deal]));
        let syncState = {
          acknowledgements: loadJson(PUBLIC_DEAL_SYNCED_KEY, {}),
          issues: loadJson(publicDealSyncIssuesStorageKey, {}),
        };
        current.forEach((deal) => {
          if (!nextById.has(deal.id)) {
            delete syncState.acknowledgements[deal.id];
            delete syncState.issues[deal.id];
          } else {
            // This cache was already synced. Updating it from a confirmed read
            // must not turn the refreshed snapshot into a new publish request.
            // Keep any genuinely pending local edit pending.
            syncState = applyObservedPublicDealSync({ ...syncState, previous: deal,
              observed: nextById.get(deal.id), centralDeal: centralById.get(deal.id) });
          }
        });
        saveJson(PUBLIC_DEAL_SYNCED_KEY, syncState.acknowledgements);
        saveJson(publicDealSyncIssuesStorageKey, syncState.issues);
        setPublicDealSyncIssues(syncState.issues);
        return next;
      };
      setCreatedDeals((current) => {
        return reconcileSavedCache(current, saveCreatedDeals);
      });
      setCustomerGroups((current) => {
        return reconcileSavedCache(current, (next) => saveJson(CUSTOMER_GROUPS_KEY, next));
      });
      setOwnedDeals((current) => reconcilePublicDealCache(current, snapshots));
    };
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        const next = await fetchPublicDeals();
        if (!cancelled && Array.isArray(next)) {
          // An earlier public-list request can finish after an administrator
          // saves a newer image or deletion. Keep the confirmed mutation until
          // the list catches up so that response cannot restore the old card.
          const confirmed = mergeDeals([...observedMutations.values()], next);
          setRemoteDeals(confirmed);
          reconcileCaches(confirmed);
        }
      } finally {
        refreshing = false;
      }
    };
    const handlePublishedDeal = (event) => {
      const deal = event.detail?.deal;
      if (!deal?.id) return;
      const confirmed = mergeDeals([deal], [observedMutations.get(deal.id)])[0];
      observedMutations.set(deal.id, confirmed);
      setRemoteDeals((current) => mergeDeals([confirmed], current));
      reconcileCaches([confirmed]);
      refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, PUBLIC_DEAL_SYNC_INTERVAL_MS);
    const handleFocus = () => refresh();
    const handlePageShow = () => refresh();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleFocus);
    window.addEventListener('o2o-public-deals-updated', handlePublishedDeal);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleFocus);
      window.removeEventListener('o2o-public-deals-updated', handlePublishedDeal);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let syncing = false;
    const syncPendingDeals = async () => {
      if (syncing || document.visibilityState === 'hidden') return;
      const localPublicDeals = [...scopedCreatedDeals, ...customerGroups]
        .filter((deal) => deal.visibility === 'public' && Boolean(getDealCapability(deal.id)));
      if (!localPublicDeals.length) return;
      const fingerprints = loadJson(PUBLIC_DEAL_SYNCED_KEY, {});
      const issues = loadJson(publicDealSyncIssuesStorageKey, {});
      const pending = localPublicDeals.filter(
        (deal) => shouldPublishPublicDeal(deal, fingerprints, issues),
      );
      if (!pending.length) return;
      syncing = true;
      try {
        const published = [];
        const syncErrors = [];
        for (const deal of pending) {
          if (cancelled) break;
          try {
            // Effect restarts and slow image conversion can overlap. Join the
            // same in-flight snapshot instead of starting a duplicate publish.
            const requestKey = `${deal.id}:${dealSyncFingerprint(deal)}`;
            let request = publicDealSyncInFlight.current.get(requestKey);
            if (!request) {
              request = publishPublicDeal(deal, {
                throwOnError: true,
                maxRetries: 0,
                priority: 'background',
              }).finally(() => publicDealSyncInFlight.current.delete(requestKey));
              publicDealSyncInFlight.current.set(requestKey, request);
            }
            const result = await request;
            published.push(acknowledgedPublicDealSnapshot(deal, result));
            syncErrors.push(null);
          } catch (error) {
            published.push(null);
            syncErrors.push(error);
          }
        }
        if (cancelled) return;
        const valid = published.filter(Boolean);
        const publishedById = new Map(valid.map((deal) => [deal.id, deal]));
        let nextSyncState = {
          acknowledgements: { ...loadJson(PUBLIC_DEAL_SYNCED_KEY, {}) },
          issues: { ...loadJson(publicDealSyncIssuesStorageKey, {}) },
        };
        const centrallyDeletedDealIds = new Set();
        pending.forEach((deal, index) => {
          const errorCode = syncErrors[index]?.code || syncErrors[index]?.message;
          if (errorCode === 'deal_deleted') {
            centrallyDeletedDealIds.add(deal.id);
            delete nextSyncState.acknowledgements[deal.id];
            delete nextSyncState.issues[deal.id];
          } else {
            nextSyncState = applyPublicDealSyncResult({
              ...nextSyncState, deal, published: published[index], error: syncErrors[index],
            });
          }
        });
        saveJson(PUBLIC_DEAL_SYNCED_KEY, nextSyncState.acknowledgements);
        saveJson(publicDealSyncIssuesStorageKey, nextSyncState.issues);
        setPublicDealSyncIssues(nextSyncState.issues);
        if (valid.length) {
          setCustomerGroups((current) => {
            let changed = false;
            const next = current.map((deal) => {
              const publishedDeal = publishedById.get(deal.id);
              if (!publishedDeal) return deal;
              changed = true;
              return { ...deal, ...publishedDeal };
            });
            if (changed) saveJson(CUSTOMER_GROUPS_KEY, next);
            return changed ? next : current;
          });
          setCreatedDeals((current) => {
            let changed = false;
            const next = current.map((deal) => {
              const publishedDeal = publishedById.get(deal.id);
              if (!publishedDeal) return deal;
              changed = true;
              return { ...deal, ...publishedDeal };
            });
            if (changed) saveCreatedDeals(next);
            return changed ? next : current;
          });
          setSelectedDeal((current) => {
            const publishedDeal = publishedById.get(current?.id);
            return publishedDeal ? { ...current, ...publishedDeal } : current;
          });
          setRemoteDeals((current) => mergeDeals(valid, current));
        }
        if (centrallyDeletedDealIds.size) {
          setCustomerGroups((current) => {
            const next = current.filter((deal) => !centrallyDeletedDealIds.has(deal.id));
            saveJson(CUSTOMER_GROUPS_KEY, next);
            return next;
          });
          setCreatedDeals((current) => {
            const next = current.filter((deal) => !centrallyDeletedDealIds.has(deal.id));
            saveCreatedDeals(next);
            return next;
          });
          setOwnedDeals((current) => current.filter((deal) => !centrallyDeletedDealIds.has(deal.id)));
          setRemoteDeals((current) => current.filter((deal) => !centrallyDeletedDealIds.has(deal.id)));
          setSelectedDeal((current) => (
            centrallyDeletedDealIds.has(current?.id) ? null : current
          ));
          setCustomerScreen((current) => (current === 'detail' || current === 'room' ? 'list' : current));
        }
      } finally {
        syncing = false;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') syncPendingDeals();
    };
    syncPendingDeals();
    const timer = window.setInterval(syncPendingDeals, 30000);
    window.addEventListener('online', syncPendingDeals);
    window.addEventListener('pageshow', syncPendingDeals);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('online', syncPendingDeals);
      window.removeEventListener('pageshow', syncPendingDeals);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [customerGroups, scopedCreatedDeals]);

  useEffect(() => {
    const handlePopState = (event) => {
      const nextRoute = normalizeRoute(window.location.pathname);
      if (!shouldKeepOwnerPreview(nextRoute)) setOwnerPreviewMode(false);
      const previousRoute = routeRef.current;
      const customerNavigation = readCustomerNavigationState(event.state, nextRoute);
      if (nextRoute === '/') {
        clearActiveAppSession();
        setActiveAppSessionKey('');
        setCustomerScreen('onboarding');
      } else if (customerNavigation) {
        setCustomerScreen(customerNavigation.screen);
      }
      setRoute(nextRoute);
      if (nextRoute !== previousRoute) setHandledDeepLink('');
    };
    const handleStorage = (event) => {
      if (event.key === CREATED_DEALS_KEY) setCreatedDeals(loadCreatedDeals());
      if (event.key === OWNER_DEAL_SCOPES_KEY) {
        setOwnerScopeByDeal(loadJson(OWNER_DEAL_SCOPES_KEY, {}));
      }
      if (event.key === CUSTOMER_GROUPS_KEY) setCustomerGroups(loadCustomerGroups());
      if (event.key === publicDealSyncIssuesStorageKey) {
        setPublicDealSyncIssues(loadJson(publicDealSyncIssuesStorageKey, {}));
      }
      if (event.key === CUSTOMER_ORDERS_KEY) setOrders(loadOrders());
      if (event.key === ROLE_PROFILES_KEY) setRoleProfiles(loadJson(ROLE_PROFILES_KEY, {}));
      if ([OWNER_LOCATION_KEY, OWNER_NEIGHBORHOOD_KEY].includes(event.key)) {
        setOwnerLocation(loadOwnerLocation());
      }
    };
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    if (!profile) return undefined;
    const retry = () => {
      if (document.visibilityState !== 'hidden') flushPendingEvents(profile);
    };
    retry();
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 30000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(timer);
    };
  }, [profile]);

  useEffect(() => {
    if (!profile || profile.testerType !== '사용자') return undefined;
    let cancelled = false;
    let recovering = false;

    const recoverInterruptedReservations = async () => {
      if (recovering || document.visibilityState === 'hidden') return;
      recovering = true;
      try {
        const persistedOrders = new Map(loadOrders().map((order) => [order.id, order]));
        const attempts = listRecoverableCheckoutAttempts();
        for (const attempt of attempts) {
          if (cancelled) break;
          let persistedOrder = persistedOrders.get(attempt.orderId);
          if (!persistedOrder
            && attempt.reservationAction === 'create'
            && attempt.workflowDeal
            && attempt.orderPayload) {
            try {
              const recoveredGroup = await initializeGroupRoom({
                deal: attempt.workflowDeal,
                actorId: attempt.actorId,
                nickname: attempt.nickname || profile.name || '테스트 호스트',
                clientMutationId: attempt.reservationMutationId,
                allowLocalFallback: false,
              });
              if (recoveredGroup?.localOnly) throw new Error('group_backend_required');
              updateCheckoutAttempt(attempt.orderId, { stage: 'publishing_deal' });
              const publishedDeal = await publishPublicDeal(attempt.workflowDeal, {
                throwOnError: true,
                maxRetries: 0,
                priority: 'background',
                expectedPublishVersion: 0,
                publishMutationId: attempt.workflowDeal.publishMutationId
                  || `publish-${attempt.groupId}-initial`,
              });
              const recoveredOrder = {
                ...attempt.orderPayload,
                deal: publishedDeal || attempt.workflowDeal,
              };
              updateCheckoutAttempt(attempt.orderId, {
                stage: 'publishing_order',
                workflowDeal: publishedDeal || attempt.workflowDeal,
                orderPayload: recoveredOrder,
              });
              const nextOrders = mergeCustomerOrderCollections(loadOrders(), [recoveredOrder]);
              saveJson(CUSTOMER_ORDERS_KEY, nextOrders);
              setOrders((current) => mergeCustomerOrderCollections(current, [recoveredOrder]));
              persistedOrders.set(recoveredOrder.id, recoveredOrder);
              persistedOrder = recoveredOrder;
              releaseCheckoutAttempt(recoveredOrder.id);
              window.dispatchEvent(new Event('o2o-customer-orders-updated'));
            } catch (error) {
              const recoveryCode = error?.code || error?.message || 'group_creation_recovery_pending';
              if (isTerminalOrderSyncError(error)) {
                track('group_creation_recovery_rejected', {
                  group_id: attempt.groupId,
                  order_id: attempt.orderId,
                  error_code: recoveryCode,
                });
              }
              continue;
            }
          }
          if (persistedOrder) {
            // Legacy fingerprints also marked rejected writes. Only a matching
            // authenticated central receipt may retire this reservation; the
            // order sync below and payment preflight perform that reconciliation.
            continue;
          }
          try {
            if (attempt.reservationAction === 'reserve_quantity') {
              try {
                await rollbackGroupReservation(
                  attempt.groupId,
                  attempt.reservationQuantity,
                  attempt.actorId,
                  attempt.reservationMutationId,
                );
                completeCheckoutAttempt(attempt.orderId);
                track('checkout_interruption_recovered', {
                  order_id: attempt.orderId,
                  deal_id: attempt.dealId,
                  reservation_action: attempt.reservationAction,
                });
                continue;
              } catch (rollbackError) {
                const rollbackCode = rollbackError.code || rollbackError.message;
                if (rollbackCode !== 'reservation_not_found') throw rollbackError;
              }
              await reserveGroupQuantity(
                attempt.groupId,
                attempt.reservationQuantity,
                attempt.actorId,
                attempt.reservationMutationId,
                { allowLocalFallback: false },
              );
            } else if (attempt.reservationAction === 'join') {
              await joinGroupRoom({
                deal: { id: attempt.groupId },
                actorId: attempt.actorId,
                nickname: attempt.nickname || profile.name || '테스트 참여자',
                role: 'member',
                selectedQuantity: attempt.reservationQuantity,
                clientMutationId: attempt.reservationMutationId,
                allowLocalFallback: false,
              });
            } else {
              completeCheckoutAttempt(attempt.orderId);
              continue;
            }
            await rollbackGroupReservation(
              attempt.groupId,
              attempt.reservationQuantity,
              attempt.actorId,
              attempt.reservationMutationId,
            );
            completeCheckoutAttempt(attempt.orderId);
            track('checkout_interruption_recovered', {
              order_id: attempt.orderId,
              deal_id: attempt.dealId,
              reservation_action: attempt.reservationAction,
            });
          } catch (error) {
            const recoveryCode = error.code || error.message;
            if (['reservation_already_bound', 'group_not_found', 'deal_not_found'].includes(recoveryCode)) {
              completeCheckoutAttempt(attempt.orderId);
              track('checkout_interruption_recovery_rejected', {
                order_id: attempt.orderId,
                deal_id: attempt.dealId,
                error_code: recoveryCode || 'terminal_request_error',
              });
            }
          }
        }
      } finally {
        recovering = false;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') recoverInterruptedReservations();
    };
    recoverInterruptedReservations();
    const timer = window.setInterval(recoverInterruptedReservations, 30000);
    window.addEventListener('online', recoverInterruptedReservations);
    window.addEventListener('pageshow', recoverInterruptedReservations);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('online', recoverInterruptedReservations);
      window.removeEventListener('pageshow', recoverInterruptedReservations);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [profile]);

  useEffect(() => {
    const profilePhone = normalizePhone(profile?.phone);
    if (!profilePhone || profile?.testerType !== '사용자') return undefined;
    let cancelled = false;
    let syncing = false;
    let syncingExplicit = false;
    let refreshQueued = false;
    let explicitQueued = false;
    let readController = null;
    const isCurrent = () => !cancelled && customerHistoryScopeRef.current === profilePhone;

    const syncOrders = async (queueIfBusy = false, { explicit = false } = {}) => {
      if (!isCurrent() || document.visibilityState === 'hidden') return;
      // “주문 이력 다시 불러오기” must always show that it is running and must
      // reach a new read. Dropping the press because an unrelated background
      // refresh happened to be in flight left the previous failure notice
      // unchanged, so the button looked dead exactly when it was needed.
      if (explicit) setCustomerHistoryState({ scope: profilePhone, status: 'loading' });
      if (syncing) {
        // Repeated presses during the refresh they already started are covered
        // by it; queueing those would only repeat an expensive history read.
        const coveredByRunningRefresh = explicit && syncingExplicit;
        if (!coveredByRunningRefresh && (queueIfBusy === true || explicit)) refreshQueued = true;
        if (!coveredByRunningRefresh && explicit) explicitQueued = true;
        return;
      }
      syncing = true;
      syncingExplicit = explicit;
      refreshQueued = false;
      explicitQueued = false;
      readController = new AbortController();
      // Keep the last resolved order/payment snapshot visible during a
      // background refresh. Replacing every card with “확인 중” every 30
      // seconds made a healthy confirmed state look stuck while the network
      // request was merely in flight.
      setCustomerHistoryState((current) => (
        !explicit && current.scope === profilePhone && current.status !== 'loading'
          ? current
          : { scope: profilePhone, status: 'loading' }
      ));
      try {
        const visitorId = getVisitorId();
        const matchingLocalOrders = loadOrders()
          .filter((order) => isOrderForProfile(order, profile, visitorId))
          .map((order) => ({ ...order, customerPhone: profilePhone }));
        const fingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
        const issues = loadJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, {});
        // Read the central collection before replaying any locally queued row.
        // A different room or manager can advance an order while this browser
        // still has the older payment version. Publishing that stale copy first
        // creates an avoidable CAS/receipt conflict and can occupy the collector
        // long enough to delay chat and My Orders refreshes.
        let centralOrders = [];
        let historyReadFailed = false;
        try {
          centralOrders = await fetchCustomerOrders(profilePhone, {
            strict: true,
            signal: readController.signal,
          });
        } catch {
          historyReadFailed = true;
        }
        if (!isCurrent()) return;
        // The authoritative read is what this screen reports. Publishing any
        // queued rows happens afterwards and can take a while on a busy
        // collector, so resolving only at the end left “이력 확인 중” on screen
        // for minutes even though the history was already known.
        setCustomerHistoryState({ scope: profilePhone, status: historyReadFailed ? 'error' : 'ready' });
        const centralById = new Map(centralOrders.map((order) => [order.id, order]));
        const recoverableOrderIds = new Set(
          listRecoverableCheckoutAttempts().map((attempt) => attempt.orderId),
        );
        // When the authoritative read is unavailable, keep the local display
        // snapshot and wait. Blind publication cannot distinguish a genuinely
        // new checkout from an old browser copy of an already changed order.
        const pending = matchingLocalOrders.filter((order) => {
          if (!shouldPublishQueuedOrder(order, fingerprints, issues)) return false;
          // A recorded interrupted checkout has a frozen mutation identity and
          // is safe to retry even while the read endpoint is temporarily down.
          if (historyReadFailed) return recoverableOrderIds.has(order.id);
          const centralOrder = centralById.get(order.id);
          if (!centralOrder) return true;
          // Never replay a stale browser copy over a newer canonical payment
          // version. Equal-version content changes remain eligible so a real
          // unsent customer edit/recovery can still complete.
          if (canonicalOrderVersion(centralOrder) > canonicalOrderVersion(order)) return false;
          return customerOrderSyncFingerprint(centralOrder) !== customerOrderSyncFingerprint(order);
        });
        // Publishing runs one request at a time against a single-threaded
        // collector. An unbounded backlog kept that queue busy for minutes and
        // starved the payment and chat requests behind it, so each pass takes a
        // bounded slice and the rest is carried to the next cycle.
        const publishBudget = pending.slice(0, CUSTOMER_ORDER_PUBLISH_BUDGET);
        const deferredPublishCount = pending.length - publishBudget.length;
        const published = [];
        const syncErrors = [];
        const rollbackResults = [];
        for (const order of publishBudget) {
          if (!isCurrent()) return;
          const latestOrder = loadOrders().find((item) => item.id === order.id);
          const latestFingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
          const latestIssues = loadJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, {});
          // The authoritative read can overlap a room action or a persisted
          // failure marker. Recheck the exact input immediately before writing
          // so an older polling pass cannot publish or compensate that order.
          if (orderSyncStateChanged({
            previousOrder: order,
            currentOrder: latestOrder ? { ...latestOrder, customerPhone: profilePhone } : undefined,
            previousAcknowledgement: fingerprints[order.id],
            currentAcknowledgement: latestFingerprints[order.id],
            previousIssue: issues[order.id],
            currentIssue: latestIssues[order.id],
          }) || !latestOrder || !shouldPublishQueuedOrder(
            { ...latestOrder, customerPhone: profilePhone }, latestFingerprints, latestIssues,
          )) {
            published.push(null);
            syncErrors.push(null);
            rollbackResults.push(null);
            continue;
          }
          try {
            published.push(await publishCustomerOrder(order, {
              throwOnError: true,
              priority: 'background',
            }));
            syncErrors.push(null);
            rollbackResults.push(null);
          } catch (error) {
            if (!isCurrent()) return;
            let reconciledOrder = null;
            let reconciliationReadError = null;
            // A definite 4xx rejection proves the central store did not accept
            // this payload. Reconciliation is needed only for uncertain
            // transport/server failures; doing it after every legacy 4xx made
            // one polling pass issue several expensive history reads.
            if (!isTerminalOrderSyncError(error)) {
              try {
                const centralOrders = await fetchCustomerOrders(profilePhone, { strict: true, signal: readController.signal });
                reconciledOrder = centralOrders.find((item) => item.id === order.id) || null;
              } catch (readError) {
                reconciliationReadError = readError;
              }
            }
            if (!isCurrent()) return;
            if (reconciledOrder) {
              published.push(reconciledOrder);
              syncErrors.push(null);
              rollbackResults.push(null);
              continue;
            }
            published.push(null);
            syncErrors.push(isTerminalOrderSyncError(error)
              ? error
              : (reconciliationReadError || error));
            let rollbackResult = null;
            const reservationMutationId = order.reservationMutationId || order.clientMutationId;
            // The user or another refresh can change the local order state while
            // this request is in flight. Never compensate a creator group from
            // an obsolete failure; the later commit phase already treats that
            // result as superseded, and the destructive rollback must obey the
            // same boundary.
            const latestOrder = loadOrders().find((item) => item.id === order.id);
            const failureWasSuperseded = orderSyncStateChanged({
              previousOrder: order,
              currentOrder: latestOrder ? { ...latestOrder, customerPhone: profilePhone } : undefined,
              previousAcknowledgement: fingerprints[order.id],
              currentAcknowledgement: loadJson(CUSTOMER_ORDER_SYNCED_KEY, {})[order.id],
              previousIssue: issues[order.id],
              currentIssue: loadJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, {})[order.id],
            });
            if (!failureWasSuperseded
              && isTerminalOrderSyncError(error)
              && order.groupId
              && reservationMutationId) {
              try {
                if (isCustomerGroupCreatorOrder(order)) {
                  await compensateCustomerGroupCreation(order, { finalize: false });
                  rollbackResult = { ok: true, groupCreationCompensated: true };
                } else {
                  await rollbackGroupReservation(
                    order.groupId,
                    Math.max(1, Number(order.selectedCount || order.quantity || 1)),
                    order.visitorId || visitorId,
                    reservationMutationId,
                  );
                  rollbackResult = { ok: true };
                }
              } catch (rollbackError) {
                rollbackResult = { ok: false, error: rollbackError };
              }
            }
            rollbackResults.push(rollbackResult);
          }
        }
        if (!isCurrent()) return;
        // Only writes need a follow-up read. A read-only refresh already has the
        // newest authorized collection and must not double the expensive
        // history request on every interval.
        if (publishBudget.length) {
          try {
            centralOrders = await fetchCustomerOrders(profilePhone, {
              strict: true,
              signal: readController.signal,
            });
          } catch {
            historyReadFailed = true;
          }
        }
        if (!isCurrent()) return;
        // Another action can finish while either request above is awaiting.
        // Commit only results whose local input/ack/issue has not moved on.
        const currentFingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
        const currentIssues = loadJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, {});
        const currentOrders = new Map(loadOrders().map((order) => [order.id, order]));
        const previousOrders = new Map(matchingLocalOrders.map((order) => [order.id, order]));
        // A deferred remainder is picked up by the next cycle rather than kept
        // on screen as an unfinished refresh.
        if (deferredPublishCount > 0) refreshQueued = true;
        const candidateIds = new Set([...previousOrders.keys(), ...centralOrders.map((order) => order.id),
          ...published.filter(Boolean).map((order) => order.id)]);
        const supersededOrderIds = new Set([...candidateIds].filter((id) => {
          const current = currentOrders.get(id);
          return orderSyncStateChanged({
            previousOrder: previousOrders.get(id),
            currentOrder: current ? { ...current, customerPhone: profilePhone } : undefined,
            previousAcknowledgement: fingerprints[id], currentAcknowledgement: currentFingerprints[id],
            previousIssue: issues[id], currentIssue: currentIssues[id],
          });
        }));
        const nextFingerprints = { ...currentFingerprints };
        const rolledBackOrderIds = new Set();
        publishBudget.forEach((order, index) => {
          if (supersededOrderIds.has(order.id)) {
            published[index] = null;
            return;
          }
          if (published[index]) {
            nextFingerprints[order.id] = orderSyncFingerprint(published[index]);
            reconcileGroupCheckoutAttempts(order.groupId, order.participantActorId || order.visitorId,
              [published[index]]);
            updateOrderSyncIssue(order.id);
            if (isCustomerGroupCreatorOrder(order)) {
              commitCustomerGroup(published[index]?.deal || order.deal);
            }
          }
          if (rollbackResults[index]?.ok) {
            rolledBackOrderIds.add(order.id);
            delete nextFingerprints[order.id];
            completeCheckoutAttempt(order.id);
            updateOrderSyncIssue(order.id);
            track('order_reservation_rolled_back', {
              order_id: order.id,
              deal_id: order.dealId,
              error_code: syncErrors[index]?.code || syncErrors[index]?.message || 'terminal_request_error',
            });
            return;
          }
          if (rollbackResults[index]?.error) {
            updateOrderSyncIssue(order.id, {
              // The publish request was already rejected as a terminal 4xx.
              // Keep the local order for the user and let reservation recovery
              // continue separately, but never republish the same rejected
              // payload every polling interval.
              state: 'failed',
              code: rollbackResults[index].error?.code
                || rollbackResults[index].error?.message
                || 'reservation_rollback_pending',
              fingerprint: customerOrderSyncFingerprint(order),
              cleanupPending: true,
              updatedAt: new Date().toISOString(),
            });
            track('order_reservation_rollback_pending', {
              order_id: order.id,
              deal_id: order.dealId,
              error_code: rollbackResults[index].error?.code
                || rollbackResults[index].error?.message
                || 'reservation_rollback_pending',
            });
            return;
          }
          if (isTerminalOrderSyncError(syncErrors[index])) {
            delete nextFingerprints[order.id];
            updateOrderSyncIssue(order.id, rejectedOrderSyncIssue(order, syncErrors[index]));
            track('order_sync_rejected', {
              order_id: order.id,
              deal_id: order.dealId,
              error_code: syncErrors[index]?.code || syncErrors[index]?.message || 'terminal_request_error',
            });
          } else if (syncErrors[index]) {
            updateOrderSyncIssue(order.id, {
              state: 'pending',
              code: syncErrors[index]?.code || syncErrors[index]?.message || 'network_error',
              updatedAt: new Date().toISOString(),
            });
          }
        });

        const acceptedCentralOrders = centralOrders.filter((order) => (
          !rolledBackOrderIds.has(order.id) && !supersededOrderIds.has(order.id)
        ));
        acceptedCentralOrders.forEach((order) => {
          nextFingerprints[order.id] = orderSyncFingerprint(order);
          reconcileGroupCheckoutAttempts(order.groupId, order.participantActorId || order.visitorId,
            acceptedCentralOrders);
          updateOrderSyncIssue(order.id);
          if (isCustomerGroupCreatorOrder(order)) {
            commitCustomerGroup(order.deal);
          }
        });
        saveJson(CUSTOMER_ORDER_SYNCED_KEY, nextFingerprints);
        setOrders((current) => {
          if (!isCurrent()) return current;
          const merged = mergeCompletedCustomerOrderSync(
            current,
            published,
            acceptedCentralOrders,
            rolledBackOrderIds,
          );
          saveJson(CUSTOMER_ORDERS_KEY, merged);
          return JSON.stringify(merged) === JSON.stringify(current) ? current : merged;
        });
        setCustomerHistoryState({ scope: profilePhone, status: historyReadFailed ? 'error' : 'ready' });
      } catch {
        if (isCurrent()) setCustomerHistoryState({ scope: profilePhone, status: 'error' });
      } finally {
        syncing = false;
        syncingExplicit = false;
        readController = null;
        const queuedExplicit = explicitQueued;
        explicitQueued = false;
        // A room snapshot or completed payment may arrive while the previous
        // read is still returning an older order. Keep one follow-up request
        // instead of dropping that change until the next periodic poll.
        if (refreshQueued && isCurrent()) void syncOrders(false, { explicit: queuedExplicit });
      }
    };
    customerHistoryRetryRef.current = () => syncOrders(false, { explicit: true });
    const refreshChangedOrders = () => syncOrders(true);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshChangedOrders();
    };
    syncOrders();
    const timer = window.setInterval(syncOrders, CUSTOMER_ORDER_SYNC_INTERVAL_MS);
    window.addEventListener('online', refreshChangedOrders);
    window.addEventListener('pageshow', refreshChangedOrders);
    window.addEventListener('o2o-customer-orders-updated', refreshChangedOrders);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      readController?.abort();
      if (customerHistoryRetryRef.current === syncOrders) customerHistoryRetryRef.current = null;
      window.clearInterval(timer);
      window.removeEventListener('online', refreshChangedOrders);
      window.removeEventListener('pageshow', refreshChangedOrders);
      window.removeEventListener('o2o-customer-orders-updated', refreshChangedOrders);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [commitCustomerGroup, compensateCustomerGroupCreation, profile, updateOrderSyncIssue]);

  useEffect(() => {
    if (analyticsReady) trackPageview();
  }, [route, analyticsReady]);

  const navigateTo = (nextRoute) => {
    const normalizedRoute = normalizeRoute(nextRoute);
    if (normalizedRoute === '/admin') {
      setCustomerScreen('list');
      setAdminEntryVersion((current) => current + 1);
    }
    const switchingOwnerToCustomerApp = normalizedRoute === '/customer'
      && route === '/owner'
      && hasActiveProfileSession
      && profile?.testerType === '사장님'
      && !ownerPreviewMode;
    if (switchingOwnerToCustomerApp) {
      clearActiveAppSession();
      setActiveAppSessionKey('');
      setCustomerScreen('onboarding');
    }
    if (normalizedRoute === '/') {
      clearActiveAppSession();
      setActiveAppSessionKey('');
      setCustomerScreen('onboarding');
    }
    window.history.pushState({}, '', normalizedRoute);
    setHandledDeepLink('');
    if (!shouldKeepOwnerPreview(normalizedRoute)) setOwnerPreviewMode(false);
    setRoute(normalizedRoute);
    track('app_opened', { app: normalizedRoute.replace('/', '') || 'launcher' });
  };

  const handleProfileSubmit = (nextProfile) => {
    saveProfile(nextProfile);
    setRoleProfiles((current) => {
      const next = { ...current, [nextProfile.testerType]: nextProfile };
      saveJson(ROLE_PROFILES_KEY, next);
      return next;
    });
    setActiveAppSessionKey(startActiveAppSession(nextProfile));
    setAnalyticsReady(initAnalytics(nextProfile));
    setProfile(nextProfile);
    const nextVisitorId = getVisitorId();
    const nextCustomerNumber = getCustomerNumber(nextVisitorId);
    const nextPhone = normalizePhone(nextProfile.phone);
    if (nextPhone) {
      setOrders((current) => {
        const migrated = current.map((order) => (
          normalizePhone(order.customerPhone) === nextPhone
            ? {
                ...order,
                visitorId: nextVisitorId,
                customerNumber: nextCustomerNumber,
                customerName: nextProfile.name,
                customerPhone: nextProfile.phone,
              }
            : order
        ));
        saveJson(CUSTOMER_ORDERS_KEY, migrated);
        return migrated;
      });
    }
    flushPendingEvents(nextProfile);
    if (nextProfile.testerType === '사장님') {
      const nextLocation = normalizeLocation(nextProfile);
      setOwnerLocation(nextLocation);
      saveJson(OWNER_LOCATION_KEY, nextLocation);
    }
    // A valid deep link is resolved by the dedicated URL effect. Stay on the
    // list until that resolution succeeds so a missing/stale id cannot open an
    // unrelated sample deal after onboarding.
    setCustomerScreen('list');
    track('profile_submitted', {
      region: nextProfile.region,
      district: nextProfile.district,
      neighborhood: nextProfile.neighborhood,
      tester_type: nextProfile.testerType,
    });
  };

  const handleLogout = () => {
    track('profile_logged_out', { neighborhood: profile?.neighborhood || '미설정' });
    clearActiveAppSession();
    clearProfile();
    setActiveAppSessionKey('');
    setAnalyticsReady(false);
    setProfile(null);
    setCustomerScreen('onboarding');
  };

  const handleNeighborhoodChange = (location) => {
    if (!location) return;
    const nextLocation = normalizeLocation(location);
    if (customerReadOnly) {
      const currentPreviewLocation = ownerPreviewMode ? previewLocation : ownerLocation;
      if (sameLocation(nextLocation, currentPreviewLocation)) return;
      const previousLocation = currentPreviewLocation;
      setOwnerPreviewMode(true);
      setPreviewLocation(nextLocation);
      track('neighborhood_changed', {
        from_region: previousLocation.region,
        from_district: previousLocation.district,
        from_neighborhood: previousLocation.neighborhood,
        ...nextLocation,
        source: 'owner_preview',
      });
      return;
    }
    if (!profile || sameLocation(nextLocation, profile)) return;
    const previousLocation = normalizeLocation(profile);
    const nextProfile = {
      ...profile,
      ...nextLocation,
    };
    saveProfile(nextProfile);
    setProfile(nextProfile);
    setRoleProfiles((current) => {
      const next = { ...current, [nextProfile.testerType]: nextProfile };
      saveJson(ROLE_PROFILES_KEY, next);
      return next;
    });
    track('neighborhood_changed', {
      from_region: previousLocation.region,
      from_district: previousLocation.district,
      from_neighborhood: previousLocation.neighborhood,
      ...nextLocation,
    });
  };

  const openOwnerCustomerPreview = (screen = 'list', location = DEFAULT_LOCATION) => {
    const nextLocation = normalizeLocation(location);
    setPreviewLocation(nextLocation);
    setOwnerPreviewMode(true);
    window.history.pushState({}, '', '/customer');
    setRoute('/customer');
    setCustomerScreen(screen);
    track('owner_customer_preview_opened', { screen, ...nextLocation });
  };

  const handleOwnerNeighborhoodChange = (location) => {
    if (!location) return;
    const nextLocation = normalizeLocation(location);
    if (sameLocation(nextLocation, ownerLocation)) return;
    const previousLocation = ownerLocation;
    setOwnerLocation(nextLocation);
    saveJson(OWNER_LOCATION_KEY, nextLocation);
    try {
      localStorage.setItem(OWNER_NEIGHBORHOOD_KEY, nextLocation.neighborhood);
    } catch {
      // The selected location remains available in React state for this session.
    }
    if (profile?.testerType === '사장님') {
      const nextProfile = { ...profile, ...nextLocation };
      saveProfile(nextProfile);
      setProfile(nextProfile);
      setRoleProfiles((current) => {
        const next = { ...current, '사장님': nextProfile };
        saveJson(ROLE_PROFILES_KEY, next);
        return next;
      });
    }
    track('owner_neighborhood_changed', {
      from_region: previousLocation.region,
      from_district: previousLocation.district,
      from_neighborhood: previousLocation.neighborhood,
      ...nextLocation,
    });
  };

  const switchToStoredOwnerProfile = () => {
    if (!ownerAccountHint || profile?.testerType !== '사장님') return;
    const formattedPhone = formatKoreanMobilePhoneInput(ownerAccountHint.phone);
    const maskedPhone = formattedPhone.replace(/^(010)-\d{3,4}-(\d{4})$/, '$1-****-$2');
    if (!window.confirm(
      `이 브라우저에 ${maskedPhone} 번호로 연결된 기존 상품 ${ownerAccountHint.count}개가 있습니다. 해당 사장님 번호로 다시 연결할까요?`,
    )) return;
    const latestCandidate = localOwnerScopeCandidates({
      capabilities: loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {}),
      scopeByDeal: loadJson(OWNER_DEAL_SCOPES_KEY, {}),
      excludeScope: activeOwnerScope,
    }).find((candidate) => candidate.scope === ownerAccountHint.scope);
    if (!latestCandidate) return;
    const nextProfile = {
      ...profile,
      phone: formatKoreanMobilePhoneInput(latestCandidate.phone),
      testerType: '사장님',
    };
    saveProfile(nextProfile);
    setRoleProfiles((current) => {
      const next = { ...current, '사장님': nextProfile };
      saveJson(ROLE_PROFILES_KEY, next);
      return next;
    });
    setActiveAppSessionKey(startActiveAppSession(nextProfile));
    setProfile(nextProfile);
    setOwnerScreen('form');
    track('owner_profile_reconnected', { product_count: latestCandidate.count });
  };

  const addOwnerDeal = async (ownerProduct, editingId = null, editingSnapshot = null) => {
    if (!activeOwnerScope || (editingId && !isOwnerDealInScope(
      editingId,
      ownerScopeByDeal,
      activeOwnerScope,
    ))) {
      return false;
    }
    const previous = editingId
      ? editingSnapshot || mergeDeals(scopedCreatedDeals, scopedOwnedDeals, remoteDeals)
        .find((deal) => deal.id === editingId)
      : null;
    const centralVersion = editingId
      ? remoteDeals.find((deal) => deal.id === editingId)
      : null;
    const previousOrderedQuantity = centralVersion?.syncedAt
      ? Number(centralVersion.orderedQuantity ?? centralVersion.current ?? 0)
      : Math.max(
        Number(previous?.orderedQuantity ?? previous?.current ?? 0),
        Number(centralVersion?.orderedQuantity ?? centralVersion?.current ?? 0),
      );
    const hasActiveGroupOrders = previous?.saleType === 'group' && previousOrderedQuantity > 0;
    const isGroupSale = ownerProduct.saleType === 'group' || hasActiveGroupOrders;
    const requestedTotalQuantity = resolveOwnerProductQuantity({
      saleType: isGroupSale ? 'group' : ownerProduct.saleType,
      stock: ownerProduct.stock,
      maxQuantity: ownerProduct.maxQuantity,
      minimumGroupQuantity: isGroupSale ? previousOrderedQuantity : 1,
    }).quantity;
    const totalQuantity = isGroupSale
      ? Math.max(requestedTotalQuantity, Math.ceil(previousOrderedQuantity))
      : requestedTotalQuantity;
    const discountedTotal = discountedPrice(ownerProduct.originalPrice, ownerProduct.discountRate);
    const groupPricing = resolveMerchantGroupPricing({
      originalPrice: ownerProduct.originalPrice,
      discountRate: ownerProduct.discountRate,
      totalQuantity,
      splitQuantity: ownerProduct.splitQuantity,
    });
    const splitPricing = isGroupSale && groupPricing.splitPricing;
    const orderedQuantity = editingId ? previousOrderedQuantity : 0;
    const dealId = editingId
      || ownerProduct.draftDealId
      || `owner-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
    const capabilityToken = getDealCapability(dealId, {
      create: true,
      ownerScope: activeOwnerScope,
    });
    if (!capabilityToken) return false;
    setOwnerScopeByDeal(loadJson(OWNER_DEAL_SCOPES_KEY, {}));
    const deal = {
      id: dealId,
      createdAt: previous?.createdAt || new Date().toISOString(),
      publishVersion: Math.max(0, Math.floor(Number(
        previous?.publishVersion ?? centralVersion?.publishVersion ?? 0,
      ))),
      visibility: 'public',
      source: 'merchant',
      saleType: isGroupSale ? 'group' : ownerProduct.saleType,
      category: normalizeCategory(ownerProduct.category),
      region: ownerProduct.region,
      district: ownerProduct.district,
      neighborhood: ownerProduct.neighborhood,
      store: ownerProduct.storeName,
      title: ownerProduct.productName,
      description: ownerProduct.description,
      address: ownerProduct.pickupPlace,
      distance: '테스트 매장',
      deadline: ownerProduct.deadline,
      methods: ownerProduct.methods,
      stock: totalQuantity,
      eventStart: ownerProduct.eventStart,
      eventEnd: ownerProduct.eventEnd,
      originalPrice: Number(ownerProduct.originalPrice),
      discountRate: Number(ownerProduct.discountRate),
      current: editingId ? orderedQuantity : 0,
      participantCount: editingId
        ? centralVersion?.syncedAt
          ? Number(centralVersion.participantCount || 0)
          : Math.max(Number(previous?.participantCount || 0), Number(centralVersion?.participantCount || 0))
        : 0,
      quantityTracking: true,
      target: totalQuantity,
      groupId: isGroupSale ? dealId : '',
      targetCount: isGroupSale ? Math.min(20, totalQuantity) : 0,
      currentCount: 0,
      groupStatus: isGroupSale ? 'recruiting' : '',
      chatLocked: false,
      hostMode: isGroupSale ? 'recruiting' : 'self',
      hostActorId: '',
      hostMatched: false,
      totalQuantity,
      productQuantity: totalQuantity,
      orderedQuantity: editingId ? orderedQuantity : 0,
      allocatedProductQuantity: editingId ? orderedQuantity : 0,
      pricingModel: isGroupSale ? 'explicit_split' : '',
      pricingVersion: isGroupSale ? 2 : 0,
      splitPricing,
      splitQuantity: isGroupSale ? groupPricing.splitQuantity : 1,
      expectedPerPerson: isGroupSale ? groupPricing.unitPrice : 0,
      unitPrice: isGroupSale ? groupPricing.unitPrice : discountedTotal,
      splitRemainder: isGroupSale ? groupPricing.remainder : 0,
      unitRemainder: isGroupSale ? groupPricing.remainder : 0,
      approximatePrice: isGroupSale ? groupPricing.approximate : false,
      likes: 0,
      image: ownerProduct.image || fallbackImage,
      menu: [
        {
          id: 'owner-menu-1',
          name: ownerProduct.productName,
          price: isGroupSale ? groupPricing.unitPrice : discountedTotal,
          option: isGroupSale
            ? `${ownerProduct.methods.join(', ')} · ${splitPricing ? `${groupPricing.splitQuantity}개 분할 예상금액` : '할인 후 1개 가격'}`
            : ownerProduct.methods.join(', '),
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    const publishedDeal = await publishPublicDeal(deal, { throwOnError: true });
    if (!publishedDeal) throw new Error('public_deal_sync_failed');
    const savedDeal = migrateMerchantSplitDeal({ ...deal, ...publishedDeal });
    setCreatedDeals((current) => {
      const next = editingId
        ? [savedDeal, ...current.filter((item) => item.id !== editingId)]
        : [savedDeal, ...current.filter((item) => item.id !== savedDeal.id)];
      saveCreatedDeals(next);
      return next;
    });
    const fingerprints = loadJson(PUBLIC_DEAL_SYNCED_KEY, {});
    fingerprints[savedDeal.id] = dealSyncFingerprint(savedDeal);
    saveJson(PUBLIC_DEAL_SYNCED_KEY, fingerprints);
    const syncIssues = loadJson(publicDealSyncIssuesStorageKey, {});
    delete syncIssues[savedDeal.id];
    saveJson(publicDealSyncIssuesStorageKey, syncIssues);
    setPublicDealSyncIssues(syncIssues);
    setOwnerWorkspaceScope(activeOwnerScope);
    setOwnerWorkspaceStatus((current) => current === 'unconfirmed' ? 'ready' : current);
    setOwnedDeals((current) => mergeDeals([savedDeal], current.filter((item) => item.id !== savedDeal.id)));
    setRemoteDeals((current) => mergeDeals([savedDeal], current.filter((item) => item.id !== savedDeal.id)));
    setSelectedDeal(savedDeal);
    setOwnerScreen('done');
    return savedDeal;
  };

  const updateCustomerDeal = async (deal, options = {}) => {
    const isAdminObservation = customerAdminMode
      && options.observed === true
      && options.sync === false;
    if (!isAdminObservation) assertCurrentCustomerMutationAllowed();
    const updated = {
      ...deal,
      category: normalizeCategory(deal.category),
      visibility: 'public',
      updatedAt: deal.updatedAt || new Date().toISOString(),
    };
    let committed = updated;
    if (options.sync !== false) {
      const published = await publishPublicDeal(updated, { throwOnError: true });
      if (!published) throw new Error('public_deal_sync_failed');
      committed = { ...updated, ...published };
    }
    const isLocallyOwned = customerGroups.some((item) => item.id === updated.id);
    if (!options.observed || isLocallyOwned) {
      setCustomerGroups((current) => {
        if (options.observed && options.sync === false) {
          const fingerprints = loadJson(PUBLIC_DEAL_SYNCED_KEY, {});
          const issues = loadJson(publicDealSyncIssuesStorageKey, {});
          const nextSyncState = applyObservedPublicDealSync({
            previous: current.find((item) => item.id === committed.id), observed: committed,
            acknowledgements: fingerprints, issues,
            centralDeal: remoteDeals.find((item) => item.id === committed.id),
          });
          if (nextSyncState.acknowledgements !== fingerprints) saveJson(PUBLIC_DEAL_SYNCED_KEY, nextSyncState.acknowledgements);
          if (nextSyncState.issues !== issues) {
            saveJson(publicDealSyncIssuesStorageKey, nextSyncState.issues);
            setPublicDealSyncIssues(nextSyncState.issues);
          }
        }
        const next = [committed, ...current.filter((item) => item.id !== committed.id)];
        saveJson(CUSTOMER_GROUPS_KEY, next);
        return next;
      });
    } else {
      setRemoteDeals((current) => mergeDeals([committed], current.filter((item) => item.id !== committed.id)));
    }
    setSelectedDeal(committed);
    if (!options.observed) track('customer_deal_updated', { deal_id: committed.id });
    if (options.sync !== false) {
      const fingerprints = loadJson(PUBLIC_DEAL_SYNCED_KEY, {});
      fingerprints[committed.id] = dealSyncFingerprint(committed);
      saveJson(PUBLIC_DEAL_SYNCED_KEY, fingerprints);
      setRemoteDeals((current) => mergeDeals([committed], current));
    }
    return committed;
  };

  const updateCustomerGroupTarget = async (
    deal,
    targetCount,
    { mutate = true, expectedVersion } = {},
  ) => {
    assertCurrentCustomerMutationAllowed();
    const actorId = getVisitorId();
    const result = mutate
      ? await updateGroupTarget(deal.id, targetCount, actorId, expectedVersion)
      : await fetchGroupSnapshot(deal.id, { actorId });
    const group = result?.snapshot?.group || result?.group;
    if (!group) throw new Error('group_update_failed');
    return {
      target: Number(group.targetCount),
      targetPeople: Number(group.targetCount),
      targetCount: Number(group.targetCount),
      current: Number(group.currentCount),
      currentPeople: Number(group.currentCount),
      currentCount: Number(group.currentCount),
      participantCount: Number(group.currentCount),
      groupStatus: group.status || group.groupStatus || deal.groupStatus,
      totalQuantity: Number(group.totalQuantity || deal.totalQuantity || 1),
      orderedQuantity: Number(group.orderedQuantity ?? deal.orderedQuantity ?? 0),
      allocatedProductQuantity: Number(group.orderedQuantity ?? deal.orderedQuantity ?? 0),
      version: Number(group.version || deal.version || 1),
      updatedAt: group.updatedAt || new Date().toISOString(),
    };
  };

  const removeDeal = async (deal) => {
    if (!deal?.id) return false;
    const deleted = await deletePublicDeal(deal);
    if (!deleted) {
      track('deal_delete_failed', { deal_id: deal.id, source: deal.source });
      return false;
    }
    if (deal.source === 'customer') {
      setCustomerGroups((current) => {
        const next = current.filter((item) => item.id !== deal.id);
        saveJson(CUSTOMER_GROUPS_KEY, next);
        return next;
      });
    } else {
      setCreatedDeals((current) => {
        const next = current.filter((item) => item.id !== deal.id);
        saveCreatedDeals(next);
        return next;
      });
      setOwnedDeals((current) => current.filter((item) => item.id !== deal.id));
    }
    setRemoteDeals((current) => current.filter((item) => item.id !== deal.id));
    const fingerprints = loadJson(PUBLIC_DEAL_SYNCED_KEY, {});
    delete fingerprints[deal.id];
    saveJson(PUBLIC_DEAL_SYNCED_KEY, fingerprints);
    track('deal_deleted', { deal_id: deal.id, source: deal.source, central_deleted: deleted });
    return deleted;
  };

  const createCustomerGroup = async (draft) => {
    assertCurrentCustomerMutationAllowed();
    const targetPeople = Math.min(20, Math.max(1, Number(draft.quantity || draft.targetPeople || 1)));
    const totalQuantity = Math.min(999, Math.max(1, Number(
      draft.totalQuantity
      || draft.productQuantity
      || draft.baseDeal?.totalQuantity
      || targetPeople,
    )));
    const creatorQuantity = Math.min(totalQuantity, Math.max(1, Number(
      draft.creatorQuantity || draft.creatorProductQuantity || 1,
    )));
    const totalPrice = Math.max(0, Math.floor(Number(
      draft.totalPrice
      || draft.salePrice
      || draft.baseDeal?.originalPrice
      || draft.expectedPrice
      || 0
    )));
    const split = calculateSplit(totalPrice, targetPeople, 1);
    const productAllocation = calculateProductAllocation(totalPrice, totalQuantity, creatorQuantity);
    const hostMode = draft.hostMode === 'recruiting' ? 'recruiting' : 'self';
    const creatorActorId = getVisitorId();
    // Keep the initial publish body stable when the server commits but its
    // response is lost and the user retries the same submission.
    const now = draft.creationAttemptAt || new Date().toISOString();
    const groupId = draft.groupId || `customer-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
    const group = {
      id: groupId,
      groupId,
      createdAt: now,
      updatedAt: now,
      visibility: 'public',
      source: 'customer',
      saleType: 'community',
      category: normalizeCategory(draft.category),
      region: profile?.region || DEFAULT_LOCATION.region,
      district: profile?.district || DEFAULT_LOCATION.district,
      neighborhood: profile?.neighborhood || '미설정',
      store: `${profile?.neighborhood || '동네'} 공동구매`,
      title: draft.title,
      description: draft.description || draft.memo,
      address: draft.pickupPlace,
      distance: '내 주변',
      deadline: `${draft.deadlineDate} ${draft.deadlineTime}`,
      methods: [draft.method],
      originalPrice: totalPrice,
      expectedPerPerson: productAllocation.unitPrice,
      equalSplitAmount: split.perPerson,
      splitRemainder: productAllocation.remainder,
      approximatePrice: productAllocation.approximate,
      unitPrice: productAllocation.unitPrice,
      unitRemainder: productAllocation.remainder,
      discountRate: 0,
      current: 1,
      currentPeople: 1,
      participantCount: 1,
      quantityTracking: true,
      target: targetPeople,
      targetPeople,
      targetCount: targetPeople,
      currentCount: 1,
      totalQuantity,
      productQuantity: totalQuantity,
      creatorQuantity,
      creatorProductQuantity: creatorQuantity,
      orderedQuantity: creatorQuantity,
      allocatedProductQuantity: creatorQuantity,
      minPeople: Number(draft.minPeople || 1),
      maxPeople: Math.min(20, Number(draft.maxPeople || targetPeople)),
      groupStatus: 'recruiting',
      chatLocked: false,
      creatorActorId,
      hostMode,
      hostMatched: hostMode === 'self',
      hostActorId: hostMode === 'self' ? creatorActorId : '',
      version: 1,
      publishVersion: 0,
      expectedPublishVersion: 0,
      publishMutationId: `publish-${groupId}-initial`,
      stateHistory: [],
      likes: 0,
      image: draft.image || draft.baseDeal.image || fallbackImage,
      menu: [
        {
          id: `customer-menu-${String(groupId).slice(0, 96)}`,
          name: draft.title,
          price: productAllocation.unitPrice,
          option: `${draft.category} · 1개 기준`,
        },
      ],
    };
    const creatorOrderInput = {
      type: 'group',
      dealId: group.id,
      groupId: group.id,
      deal: group,
      title: group.title,
      store: group.store,
      total: hostMode === 'self'
        ? productAllocation.hostSelectedAmount
        : productAllocation.selectedAmount,
      method: draft.method,
      deadline: `${draft.deadlineDate} ${draft.deadlineTime}`,
      quantity: productAllocation.selectedQuantity,
      selectedCount: productAllocation.selectedQuantity,
      hostRemainderApplied: hostMode === 'self' ? productAllocation.remainder : 0,
      clientMutationId: `create-${groupId}`,
    };
    const creationAttempt = beginCheckoutAttempt({
      ...creatorOrderInput,
      actorId: creatorActorId,
      groupId,
      reservationMutationId: creatorOrderInput.clientMutationId,
      reservationAction: 'create',
      reservationQuantity: productAllocation.selectedQuantity,
      nickname: profile?.name || '테스트 호스트',
      workflowDeal: group,
    });
    const preparedCreatorOrder = creationAttempt.orderPayload || buildCustomerOrderRecord(
      creatorOrderInput,
      {
        orderId: creationAttempt.orderId,
        createdAt: creationAttempt.createdAt,
        actorId: creatorActorId,
        profile,
        reservationMutationId: creationAttempt.reservationMutationId,
      },
    );
    updateCheckoutAttempt(creationAttempt.orderId, {
      stage: 'creating_group',
      reservationAction: 'create',
      reservationQuantity: productAllocation.selectedQuantity,
      workflowDeal: group,
      orderPayload: preparedCreatorOrder,
    });
    let publicDealPublished = false;
    try {
      const initializedGroup = await initializeGroupRoom({
        deal: group,
        actorId: creatorActorId,
        nickname: profile?.name || '테스트 호스트',
        clientMutationId: creationAttempt.reservationMutationId,
        allowLocalFallback: false,
      });
      if (initializedGroup?.localOnly) {
        const error = new Error('group_backend_required');
        error.code = 'group_backend_required';
        error.status = 503;
        throw error;
      }
      updateCheckoutAttempt(creationAttempt.orderId, { stage: 'publishing_deal' });
      const published = await publishPublicDeal(group, {
        throwOnError: true,
        expectedPublishVersion: 0,
        publishMutationId: `publish-${groupId}-initial`,
      });
      publicDealPublished = true;
      const committedGroup = published || group;
      const queuedCreatorOrder = {
        ...preparedCreatorOrder,
        deal: committedGroup,
      };
      updateCheckoutAttempt(creationAttempt.orderId, {
        stage: 'publishing_order',
        workflowDeal: committedGroup,
        orderPayload: queuedCreatorOrder,
      });
      const nextOrders = mergeCustomerOrderCollections(loadOrders(), [queuedCreatorOrder]);
      saveJson(CUSTOMER_ORDERS_KEY, nextOrders);
      setOrders((current) => mergeCustomerOrderCollections(current, [queuedCreatorOrder]));
      return committedGroup;
    } catch (error) {
      if (isTerminalOrderSyncError(error)) {
        try {
          await compensateCustomerGroupCreation(preparedCreatorOrder, {
            deletePublishedDeal: publicDealPublished,
          });
          error.groupCreationCompensated = true;
        } catch (cleanupError) {
          error.cleanupError = cleanupError;
          releaseCheckoutAttempt(creationAttempt.orderId);
        }
      } else {
        releaseCheckoutAttempt(creationAttempt.orderId);
      }
      throw error;
    }
  };

  const saveCustomerOrder = async (order) => {
    assertCurrentCustomerMutationAllowed();
    const isPurchase = order.type === 'purchase';
    const isGroupPurchase = isPurchase && isGroupBackedDeal(order.deal);
    const isGroupCreator = isCustomerGroupCreatorOrder(order);
    const needsDurableOrderSync = checkoutNeedsDurableOrderSync(order);
    const actorId = getVisitorId();
    const requestedReservationMutationId = order.reservationMutationId
      || order.clientMutationId
      || (needsDurableOrderSync ? createMutationId('checkout_quantity') : '');
    const localOrders = needsDurableOrderSync ? loadOrders() : orders;
    const matchingLocalOrder = needsDurableOrderSync
      ? localOrders.find((candidate) => (
          candidate.dealId === order.dealId
          && candidate.visitorId === actorId
          && [candidate.reservationMutationId, candidate.clientMutationId]
            .includes(requestedReservationMutationId)
        ))
      : null;
    const syncedOrderFingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
    if (canUseAcknowledgedCheckout(matchingLocalOrder, syncedOrderFingerprints,
      loadJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, {}))) {
      // An acknowledgement can skip an already finished checkout, but must
      // never erase an unresolved reservation or a recorded sync rejection.
      if (isGroupCreator) commitCustomerGroup(matchingLocalOrder.deal || order.deal);
      return matchingLocalOrder;
    }
    const selectedReservationQuantity = isGroupPurchase || isGroupCreator
      ? Math.max(1, Number(order.selectedCount || order.quantity || 1))
      : 0;
    const existingGroupCredential = isGroupPurchase
      ? getGroupCredential(order.deal.id, actorId)
      : null;
    const initialReservationAction = isGroupCreator
      ? 'create'
      : isGroupPurchase
        ? (existingGroupCredential ? 'reserve_quantity' : 'join')
        : '';
    const checkoutAttempt = needsDurableOrderSync
      ? beginCheckoutAttempt({
          ...order,
          actorId,
          groupId: isGroupPurchase || isGroupCreator
            ? (order.groupId || order.deal?.groupId || order.deal?.id)
            : '',
          reservationMutationId: requestedReservationMutationId,
          reservationAction: initialReservationAction,
          reservationQuantity: selectedReservationQuantity,
          nickname: profile?.name || '테스트 참여자',
        })
      : null;
    const reservationMutationId = checkoutAttempt?.reservationMutationId
      || requestedReservationMutationId;
    const reservationAction = checkoutAttempt?.reservationAction || initialReservationAction;
    const frozenPendingOrder = checkoutAttempt
      ? checkoutAttempt.orderPayload
        || localOrders.find((candidate) => candidate.id === checkoutAttempt.orderId)
        || null
      : null;
    let groupSnapshot = null;
    if (isGroupPurchase) {
      updateCheckoutAttempt(checkoutAttempt.orderId, {
        stage: 'reserving',
        reservationAction,
        reservationQuantity: selectedReservationQuantity,
        nickname: profile?.name || '테스트 참여자',
      });
      try {
        if (reservationAction === 'reserve_quantity') {
          const reserved = await reserveGroupQuantity(
            order.deal.id,
            selectedReservationQuantity,
            actorId,
            reservationMutationId,
            { allowLocalFallback: false },
          );
          groupSnapshot = reserved?.snapshot || null;
        } else {
          const joined = await joinGroupRoom({
            deal: order.deal,
            actorId,
            nickname: profile?.name || '테스트 참여자',
            role: 'member',
            selectedQuantity: selectedReservationQuantity,
            clientMutationId: reservationMutationId,
            allowLocalFallback: false,
          });
          groupSnapshot = joined?.snapshot || null;
        }
        updateCheckoutAttempt(checkoutAttempt.orderId, { stage: 'reserved' });
      } catch (error) {
        if (isTerminalOrderSyncError(error)) completeCheckoutAttempt(checkoutAttempt.orderId);
        else releaseCheckoutAttempt(checkoutAttempt.orderId);
        throw error;
      }
    }
    const createdAt = checkoutAttempt?.createdAt || new Date().toISOString();
    let orderId = checkoutAttempt?.orderId || '';
    if (!orderId) {
      const randomValue = new Uint32Array(1);
      globalThis.crypto?.getRandomValues?.(randomValue);
      const orderNonce = String(randomValue[0] || Math.floor(Math.random() * 1_000_000))
        .slice(-6)
        .padStart(6, '0');
      orderId = `order-${Date.now()}${orderNonce}`;
    }
    const participantKey = participationKey({
      visitorId: getVisitorId(),
      dealId: order.dealId,
    });
    const countedParticipations = loadJson(COUNTED_PARTICIPATIONS_KEY, {});
    const isNewDealParticipant = isPurchase && !countedParticipations[participantKey];
    const newOrder = frozenPendingOrder || buildCustomerOrderRecord(order, {
      orderId,
      createdAt,
      actorId,
      profile,
      reservationMutationId: checkoutAttempt ? reservationMutationId : '',
    });
    if (checkoutAttempt) {
      updateCheckoutAttempt(orderId, {
        stage: 'publishing_order',
        reservationAction,
        reservationQuantity: selectedReservationQuantity,
        workflowDeal: newOrder.deal,
        orderPayload: newOrder,
      });
    }
    let storedOrder = newOrder;
    let orderSyncQueued = false;
    let pendingSyncError = null;
    if (needsDurableOrderSync) {
      try {
        const published = await publishCustomerOrder(newOrder, { throwOnError: true });
        if (!published) throw new Error('order_sync_failed');
        storedOrder = {
          ...newOrder,
          ...published,
          deal: { ...newOrder.deal, ...(published.deal || {}) },
        };
        const fingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
        fingerprints[newOrder.id] = orderSyncFingerprint(storedOrder);
        saveJson(CUSTOMER_ORDER_SYNCED_KEY, fingerprints);
        updateOrderSyncIssue(newOrder.id);
      } catch (error) {
        let reconciledPublishedOrder = null;
        let reconciliationReadError = null;
        try {
          const centralOrders = await fetchCustomerOrders(newOrder.customerPhone, { strict: true });
          reconciledPublishedOrder = centralOrders.find((item) => item.id === newOrder.id) || null;
        } catch (readError) {
          reconciliationReadError = readError;
        }
        if (reconciledPublishedOrder) {
          storedOrder = {
            ...newOrder,
            ...reconciledPublishedOrder,
            deal: { ...newOrder.deal, ...(reconciledPublishedOrder.deal || {}) },
          };
          const fingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
          fingerprints[newOrder.id] = orderSyncFingerprint(storedOrder);
          saveJson(CUSTOMER_ORDER_SYNCED_KEY, fingerprints);
          updateOrderSyncIssue(newOrder.id);
        } else if (isTerminalOrderSyncError(error)) {
          if (isGroupCreator && reservationMutationId) {
            try {
              await compensateCustomerGroupCreation(newOrder);
              error.groupCreationCompensated = true;
            } catch (cleanupError) {
              error.cleanupError = cleanupError;
              releaseCheckoutAttempt(orderId);
            }
          } else if (isGroupPurchase && reservationMutationId && groupSnapshot) {
            try {
              await rollbackGroupReservation(
                order.deal.id,
                Math.max(1, Number(order.selectedCount || order.quantity || 1)),
                actorId,
                reservationMutationId,
              );
              completeCheckoutAttempt(orderId);
              error.reservationRolledBack = true;
            } catch (rollbackError) {
              error.rollbackError = rollbackError;
              releaseCheckoutAttempt(orderId);
            }
          } else if (checkoutAttempt) {
            completeCheckoutAttempt(orderId);
          }
          throw error;
        }
        if (!reconciledPublishedOrder) {
          orderSyncQueued = true;
          if (checkoutAttempt) releaseCheckoutAttempt(orderId);
          pendingSyncError = new Error('order_sync_pending');
          pendingSyncError.code = 'order_sync_pending';
          pendingSyncError.orderId = newOrder.id;
          pendingSyncError.cause = reconciliationReadError || error;
          updateOrderSyncIssue(newOrder.id, {
            state: 'pending',
            code: reconciliationReadError?.code
              || reconciliationReadError?.message
              || error.code
              || error.message
              || 'network_error',
            updatedAt: new Date().toISOString(),
          });
          track('order_sync_queued', {
            order_id: newOrder.id,
            deal_id: newOrder.dealId,
            error_code: reconciliationReadError?.code
              || reconciliationReadError?.message
              || error.code
              || error.message
              || 'network_error',
          });
        }
      }
    }
    const persistedOrders = mergeCustomerOrderCollections(loadOrders(), [storedOrder]);
    saveJson(CUSTOMER_ORDERS_KEY, persistedOrders);
    setOrders((current) => {
      const next = mergeCustomerOrderCollections(current, [storedOrder]);
      return next;
    });
    if (pendingSyncError) throw pendingSyncError;
    if (checkoutAttempt && !orderSyncQueued) completeCheckoutAttempt(orderId);
    if (isGroupCreator && !orderSyncQueued) {
      commitCustomerGroup(storedOrder.deal || newOrder.deal);
    }
    if (!needsDurableOrderSync) {
      publishCustomerOrder(newOrder).then((published) => {
        if (!published) return;
        const fingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
        fingerprints[newOrder.id] = orderSyncFingerprint(newOrder);
        saveJson(CUSTOMER_ORDER_SYNCED_KEY, fingerprints);
      });
    }

    if (isPurchase && order.deal?.id) {
      const target = Math.max(1, Number(order.deal.target || 1));
      const orderedQuantityIncrement = Math.max(1, Number(order.selectedCount || order.quantity || 1));
      if (groupSnapshot) {
        const currentCount = Number(groupSnapshot?.group?.currentCount ?? order.deal.current ?? 0);
        const nextOrderedQuantity = Number(
          groupSnapshot?.group?.orderedQuantity
          ?? Number(order.deal.orderedQuantity || 0) + orderedQuantityIncrement,
        );
        const updatedDeal = {
          ...order.deal,
          groupId: order.deal.groupId || order.deal.id,
          current: order.deal.source === 'customer' ? currentCount : nextOrderedQuantity,
          currentPeople: currentCount,
          currentCount,
          participantCount: currentCount,
          orderedQuantity: nextOrderedQuantity,
          allocatedProductQuantity: nextOrderedQuantity,
          groupStatus: groupSnapshot.group.status || groupSnapshot.group.groupStatus || order.deal.groupStatus,
          hostMode: groupSnapshot.group.hostMode || order.deal.hostMode || 'recruiting',
          hostActorId: groupSnapshot.group.hostActorId || order.deal.hostActorId || '',
          hostMatched: Boolean(groupSnapshot.group.hostActorId || order.deal.hostActorId),
          lastMessageSeq: Number(groupSnapshot.group.lastMessageSeq ?? groupSnapshot.lastSeq ?? order.deal.lastMessageSeq ?? 0),
          version: Number(groupSnapshot.group.version || order.deal.version || 1),
          updatedAt: groupSnapshot?.group?.updatedAt || order.deal.updatedAt,
        };
        countedParticipations[participantKey] = true;
        saveJson(COUNTED_PARTICIPATIONS_KEY, countedParticipations);
        setSelectedDeal((current) => (current?.id === updatedDeal.id ? updatedDeal : current));
        setRemoteDeals((current) => mergeDeals(
          [updatedDeal],
          current.filter((item) => item.id !== updatedDeal.id),
        ));
        if (isNewDealParticipant) {
          track('group_participant_joined', {
            group_id: order.deal.id,
            role: 'participant',
            counted: true,
            source: 'checkout',
          });
        }
        if (updatedDeal.source === 'merchant') {
          setCreatedDeals((current) => {
            if (!current.some((item) => item.id === updatedDeal.id)) return current;
            const next = current.map((item) => (item.id === updatedDeal.id ? updatedDeal : item));
            saveCreatedDeals(next);
            return next;
          });
        }
        return storedOrder;
      }
      const participationIncrement = orderedQuantityIncrement;
      const previousOrderedQuantity = Number(
        order.deal.orderedQuantity
        ?? order.deal.allocatedProductQuantity
        ?? order.deal.current
        ?? 0,
      );
      const nextOrderedQuantity = Math.min(target, previousOrderedQuantity + participationIncrement);
      const updatedDeal = {
        ...order.deal,
        quantityTracking: true,
        current: nextOrderedQuantity,
        orderedQuantity: nextOrderedQuantity,
        allocatedProductQuantity: nextOrderedQuantity,
        participantCount: Math.max(0, Number(order.deal.participantCount || 0))
          + (isNewDealParticipant ? 1 : 0),
      };
      if (isNewDealParticipant) {
        countedParticipations[participantKey] = true;
        saveJson(COUNTED_PARTICIPATIONS_KEY, countedParticipations);
      }

      setSelectedDeal((current) => (
        current?.id === updatedDeal.id ? updatedDeal : current
      ));
      setRemoteDeals((current) => mergeDeals(
        [updatedDeal],
        current.filter((item) => item.id !== updatedDeal.id),
      ));

      if (updatedDeal.source === 'customer') {
        setCustomerGroups((current) => {
          const hasLocalDeal = current.some((item) => item.id === updatedDeal.id);
          if (!hasLocalDeal) return current;
          const next = current.map((item) => (
            item.id === updatedDeal.id ? updatedDeal : item
          ));
          saveJson(CUSTOMER_GROUPS_KEY, next);
          return next;
        });
      } else {
        setCreatedDeals((current) => {
          const hasLocalDeal = current.some((item) => item.id === updatedDeal.id);
          if (!hasLocalDeal) return current;
          const next = current.map((item) => (
            item.id === updatedDeal.id ? updatedDeal : item
          ));
          saveCreatedDeals(next);
          return next;
        });
      }
    }
    return storedOrder;
  };

  const cancelParticipation = async (order) => {
    assertCurrentCustomerMutationAllowed();
    const deal = deals.find((item) => item.id === order.dealId) || order.deal;
    if (!deal) throw new Error('deal_not_found');
    const actorId = getVisitorId();
    const mutationId = createMutationId('cancel_participation');
    let cancelledOrder;
    let updatedDeal;
    let cancellationSnapshot = null;

    const isBoundGroupOrder = isGroupBackedDeal(deal) && Boolean(order.groupId);
    if (isBoundGroupOrder) {
      const result = await cancelGroupParticipation({
        groupId: deal.groupId || deal.id,
        order,
        actorId,
        customerCapabilityToken: getCustomerOrderCapability(),
        clientMutationId: mutationId,
      });
      cancelledOrder = result.order;
      cancellationSnapshot = result.snapshot || null;
      const group = cancellationSnapshot?.group || {};
      const currentCount = Number(group.currentCount ?? deal.currentCount ?? deal.participantCount ?? 0);
      const orderedQuantity = Number(group.orderedQuantity ?? deal.orderedQuantity ?? 0);
      updatedDeal = {
        ...deal,
        groupId: deal.groupId || deal.id,
        current: deal.source === 'customer' ? currentCount : orderedQuantity,
        currentPeople: currentCount,
        currentCount,
        participantCount: currentCount,
        orderedQuantity,
        allocatedProductQuantity: orderedQuantity,
        version: Number(group.version ?? deal.version ?? 1),
        stateVersion: Number(group.version ?? deal.stateVersion ?? deal.version ?? 1),
        updatedAt: group.updatedAt || cancelledOrder?.cancelledAt || new Date().toISOString(),
      };
    } else {
      cancelledOrder = cancelledOrderSnapshot(order, {
        timestamp: new Date().toISOString(),
        clientMutationId: mutationId,
      });
      const published = await publishCustomerOrder(cancelledOrder);
      if (!published) throw new Error('participation_cancel_failed');
      cancelledOrder = { ...cancelledOrder, ...published };
      const hasOtherActiveOrder = orders.some((candidate) => (
        candidate.id !== order.id
        && candidate.type === 'purchase'
        && candidate.dealId === order.dealId
        && candidate.visitorId === order.visitorId
        && !isCancelledOrder(candidate)
      ));
      updatedDeal = applyMerchantParticipationCancellation(deal, order, hasOtherActiveOrder);
    }

    if (!cancelledOrder) throw new Error('participation_cancel_failed');
    setOrders((current) => {
      const next = current.map((item) => (
        item.id === order.id ? { ...item, ...cancelledOrder } : item
      ));
      saveJson(CUSTOMER_ORDERS_KEY, next);
      return next;
    });
    const fingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
    fingerprints[cancelledOrder.id] = orderSyncFingerprint(cancelledOrder);
    saveJson(CUSTOMER_ORDER_SYNCED_KEY, fingerprints);
    updateOrderSyncIssue(cancelledOrder.id);

    const participantStorageKey = participationKey(order);
    const countedParticipations = loadJson(COUNTED_PARTICIPATIONS_KEY, {});
    const groupParticipant = cancellationSnapshot?.participants
      ?.find((item) => item.actorId === actorId);
    const stillCounted = cancellationSnapshot
      ? Boolean(groupParticipant?.counted)
      : orders.some((candidate) => (
        candidate.id !== order.id
        && candidate.type === 'purchase'
        && candidate.dealId === order.dealId
        && candidate.visitorId === order.visitorId
        && !isCancelledOrder(candidate)
      ));
    if (stillCounted) countedParticipations[participantStorageKey] = true;
    else delete countedParticipations[participantStorageKey];
    saveJson(COUNTED_PARTICIPATIONS_KEY, countedParticipations);

    setSelectedDeal((current) => (current?.id === updatedDeal.id ? updatedDeal : current));
    setRemoteDeals((current) => mergeDeals(
      [updatedDeal],
      current.filter((item) => item.id !== updatedDeal.id),
    ));
    if (updatedDeal.source === 'customer') {
      setCustomerGroups((current) => {
        if (!current.some((item) => item.id === updatedDeal.id)) return current;
        const next = current.map((item) => (item.id === updatedDeal.id ? updatedDeal : item));
        saveJson(CUSTOMER_GROUPS_KEY, next);
        return next;
      });
    } else {
      setCreatedDeals((current) => {
        if (!current.some((item) => item.id === updatedDeal.id)) return current;
        const next = current.map((item) => (item.id === updatedDeal.id ? updatedDeal : item));
        saveCreatedDeals(next);
        return next;
      });
    }
    track('participation_cancelled', {
      order_id: order.id,
      deal_id: order.dealId,
      selected_count: Number(order.selectedCount ?? order.quantity ?? 0),
      source: deal.source,
    });
    return cancelledOrder;
  };

  const persistManagedOrder = (managedOrder, expectedOwnerScope) => {
    if (
      !expectedOwnerScope
      || ownerScopeKey(getProfile()) !== expectedOwnerScope
      || !isOwnerDealInScope(managedOrder?.dealId, ownerScopeByDeal, expectedOwnerScope)
    ) {
      return false;
    }
    const existingOrder = scopedOwnerOrders.find((item) => item.id === managedOrder.id)
      || orders.find((item) => item.id === managedOrder.id)
      || {};
    const mergedManagedOrder = {
      ...existingOrder,
      ...managedOrder,
      deal: { ...existingOrder.deal, ...(managedOrder.deal || {}) },
    };
    setOrders((current) => {
      const next = current.map((item) => (
        item.id === managedOrder.id
          ? { ...item, ...mergedManagedOrder }
          : item
      ));
      saveJson(CUSTOMER_ORDERS_KEY, next);
      return next;
    });
    setOwnerWorkspaceScope(expectedOwnerScope);
    setOwnerOrders((current) => mergeCustomerOrderCollections(current, [mergedManagedOrder]));
    const fingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
    fingerprints[managedOrder.id] = orderSyncFingerprint(mergedManagedOrder);
    saveJson(CUSTOMER_ORDER_SYNCED_KEY, fingerprints);
    return true;
  };

  const updateOrderStatus = async (orderId, direction = 'next') => {
    const requestOwnerScope = activeOwnerScope;
    const order = scopedOwnerOrders.find((item) => item.id === orderId)
      || orders.find((item) => item.id === orderId);
    if (!order || isCancelledOrder(order)) return;
    const currentStage = getOrderStage(order);
    const currentIndex = ORDER_STAGES.findIndex((stage) => stage.id === currentStage.id);
    const nextStage = ORDER_STAGES[currentIndex + (direction === 'previous' ? -1 : 1)];
    if (!nextStage) return;
    const deal = deals.find((item) => item.id === order.dealId) || order.deal || {};
    if (!isOwnerDealInScope(deal.id, ownerScopeByDeal, requestOwnerScope)) return;
    const managedOrder = await manageCustomerOrder(order, deal, {
      kind: 'order_status',
      direction,
    });
    if (!persistManagedOrder(managedOrder, requestOwnerScope)) return;
    track('owner_order_status_changed', {
      order_id: orderId,
      deal_id: order.dealId,
      from_status: currentStage.id,
      to_status: nextStage.id,
      action: direction === 'previous' ? '이전 단계' : currentStage.action,
      total: Number(order.total || 0),
      status_updated_at: managedOrder.statusUpdatedAt,
    });
    return managedOrder;
  };

  const confirmCustomerPickup = async (orderId) => {
    assertCurrentCustomerMutationAllowed();
    const order = orders.find((item) => item.id === orderId);
    if (!order || isCancelledOrder(order) || order.type !== 'purchase' || order.customerPickupConfirmedAt) return;
    if (!['pickup_waiting', 'completed'].includes(getOrderStage(order).id)) return;
    const confirmedAt = new Date().toISOString();
    const requestedOrder = {
      ...order,
      customerPickupConfirmedAt: confirmedAt,
      publishMutationId: `publish-${order.id}-customer-pickup`,
      statusHistory: [
        ...(order.statusHistory || []),
        { status: 'customer_pickup_confirmed', actor: 'customer', timestamp: confirmedAt },
      ],
    };
    const published = await publishCustomerOrder(requestedOrder, { throwOnError: true });
    if (!published) throw new Error('pickup_confirmation_failed');
    const confirmedOrder = {
      ...requestedOrder,
      ...published,
      deal: { ...requestedOrder.deal, ...(published.deal || {}) },
    };
    setOrders((current) => {
      const next = mergeCustomerOrderCollections(current, [confirmedOrder]);
      saveJson(CUSTOMER_ORDERS_KEY, next);
      return next;
    });
    track('customer_pickup_confirmed', {
      order_id: orderId,
      deal_id: order.dealId,
      owner_status: getOrderStage(order).id,
      total: Number(order.total || 0),
      confirmed_at: confirmedAt,
      neighborhood: order.neighborhood || order.deal?.neighborhood,
    });
    return confirmedOrder;
  };

  const confirmManualPayment = async (orderId, direction = 'next') => {
    const requestOwnerScope = activeOwnerScope;
    const order = scopedOwnerOrders.find((item) => item.id === orderId)
      || orders.find((item) => item.id === orderId);
    if (!order || isCancelledOrder(order) || order.type !== 'purchase') return;
    const paymentStatus = getOrderPaymentStatus(order);
    if (direction === 'next' && paymentStatus === 'confirmed') return;
    if (direction === 'previous' && paymentStatus !== 'confirmed') return;
    if (direction === 'next' && order.groupId && paymentStatus !== 'requested') return;
    const deal = deals.find((item) => item.id === order.dealId) || order.deal || {};
    if (!isOwnerDealInScope(deal.id, ownerScopeByDeal, requestOwnerScope)) return;
    const managedOrder = await manageCustomerOrder(order, deal, {
      kind: 'payment_status',
      direction,
    });
    if (!persistManagedOrder(managedOrder, requestOwnerScope)) return;
    track(direction === 'previous' ? 'manual_payment_confirmation_reverted' : 'manual_payment_confirmed', {
      order_id: orderId,
      deal_id: order.dealId,
      total: Number(order.total || 0),
      confirmed_at: managedOrder.paymentConfirmedAt || '',
      neighborhood: order.neighborhood || order.deal?.neighborhood,
    });
    return managedOrder;
  };

  const toggleFavorite = (deal) => {
    assertCurrentCustomerMutationAllowed();
    setFavoriteIds((current) => {
      const active = current.includes(deal.id);
      const next = active ? current.filter((id) => id !== deal.id) : [deal.id, ...current];
      saveJson(FAVORITES_KEY, next);
      track('like_clicked', { deal_id: deal.id, active: !active, source: 'customer_tab' });
      return next;
    });
  };

  const persistCustomerOrderSnapshot = (order) => {
    if (!order?.id) return;
    setOrders((current) => {
      const next = mergeCustomerOrderCollections(current, [order]);
      saveJson(CUSTOMER_ORDERS_KEY, next);
      return next;
    });
    const fingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
    fingerprints[order.id] = orderSyncFingerprint(order);
    saveJson(CUSTOMER_ORDER_SYNCED_KEY, fingerprints);
    updateOrderSyncIssue(order.id);
  };

  const ensurePaymentOrderSaved = async (groupId, actorId) => {
    const profilePhone = normalizePhone(profile?.phone);
    const assertSameCustomer = () => {
      assertCurrentCustomerMutationAllowed();
      if (!profilePhone || customerHistoryScopeRef.current !== profilePhone
        || actorId !== getVisitorId()) throw new Error('forbidden');
    };
    assertSameCustomer();
    await ensureGroupPaymentOrderSaved({
      groupId, actorId,
      readLocalOrders: loadOrders,
      readFingerprints: () => loadJson(CUSTOMER_ORDER_SYNCED_KEY, {}),
      readSyncIssues: () => loadJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, {}),
      fetchOrders: async () => {
        assertSameCustomer();
        const result = await fetchCustomerOrders(profilePhone, { strict: true, groupId });
        assertSameCustomer();
        return result;
      },
      publishOrder: async (order) => {
        assertSameCustomer();
        const result = await publishCustomerOrder(order, { throwOnError: true });
        assertSameCustomer();
        return result;
      },
      persistOrder: (order) => { assertSameCustomer(); persistCustomerOrderSnapshot(order); },
    });
    assertSameCustomer();
  };

  const applyHost = async (deal) => {
    assertCurrentCustomerMutationAllowed();
    const properties = { deal_id: deal.id, method: deal.methods?.join(', ') };
    track('host_apply_clicked', properties);
    if (isGroupBackedDeal(deal)) {
      const actorId = getVisitorId();
      const result = await claimGroupHost({
        deal,
        actorId,
      });
      if (result?.order) persistCustomerOrderSnapshot(result.order);
      const group = result?.snapshot?.group || {};
      const updatedDeal = {
        ...deal,
        groupId: deal.groupId || deal.id,
        hostMode: group.hostMode || deal.hostMode || 'recruiting',
        hostMatched: Boolean(group.hostMatched ?? group.hostActorId),
        hostActorId: group.hostActorId || actorId,
        creatorActorId: group.creatorActorId || deal.creatorActorId,
        current: deal.source === 'customer'
          ? Number(group.currentCount ?? deal.current ?? 0)
          : Number(group.orderedQuantity ?? deal.orderedQuantity ?? deal.current ?? 0),
        currentPeople: Number(group.currentCount ?? deal.currentPeople ?? deal.current ?? 0),
        currentCount: Number(group.currentCount ?? deal.currentCount ?? deal.current ?? 0),
        participantCount: Number(group.currentCount ?? deal.participantCount ?? deal.current ?? 0),
        orderedQuantity: Number(group.orderedQuantity ?? deal.orderedQuantity ?? 0),
        updatedAt: group.updatedAt || new Date().toISOString(),
      };
      updateCustomerDeal(updatedDeal, { observed: true, sync: false });
    }
    if (!isGroupBackedDeal(deal)) {
      setHostDealIds((current) => {
        const next = current.includes(deal.id) ? current : [deal.id, ...current];
        saveJson(HOST_DEALS_KEY, next);
        return next;
      });
    }
    track('host_apply_completed', properties);
  };

  const customerProfile = customerReadOnly
    ? {
      ...(profile || {}),
      name: profile?.name || '사장님 미리보기',
      ...(ownerPreviewMode ? previewLocation : ownerLocation),
      testerType: '사장님',
      consent: true,
    }
    : profile?.testerType === '사장님'
      ? { ...profile, ...ownerLocation }
      : profile;
  const activeCustomerProfile = hasActiveProfileSession ? customerProfile : null;

  if (route === '/') {
    return <AppLauncher onNavigate={navigateTo} />;
  }

  if (route === '/dashboard') {
    return (
      <main className="app dashboard-app">
        <section className="workspace">
          <StandaloneHeader
            eyebrow="검증 환경"
            title="검증 대시보드"
            active="dashboard"
            onNavigate={navigateTo}
          />
          <Dashboard analyticsReady={analyticsReady} orders={orders} />
        </section>
        <EventMonitor analyticsReady={analyticsReady} />
      </main>
    );
  }

  return (
    <main className="app individual-app">
      <section className="workspace">
        <StandaloneHeader
          eyebrow={route === '/customer'
            ? customerReadOnly ? '사장님 읽기 전용' : '사용자 테스트'
            : route === '/admin' ? '운영 테스트' : '사장님 등록'}
          title={route === '/customer'
            ? customerReadOnly ? '사용자 화면 미리보기' : '사용자 앱'
            : route === '/admin' ? '관리자 앱' : '사장님 앱'}
          active={route.replace('/', '')}
          onNavigate={navigateTo}
          customerPreview={route === '/customer' && customerReadOnly}
        />

        <PhoneFrame>
          {['/customer', '/admin'].includes(route) && (
            route === '/admin' && (!hasActiveProfileSession || profile?.testerType !== '관리자') ? (
              <Onboarding
                key="admin-onboarding"
                onSubmit={handleProfileSubmit}
                defaultTesterType="관리자"
                lockTesterType
                initialProfile={roleProfiles['관리자'] || profile}
              />
            ) : (
              <CustomerApp
                key={customerAdminMode ? `admin-workspace-${adminEntryVersion}` : 'customer-workspace'}
                deals={deals}
                profile={route === '/admin' ? profile : activeCustomerProfile}
                rememberedProfile={roleProfiles['사용자'] || profile}
                orders={orders}
                orderSyncIssues={orderSyncIssues}
                historyStatus={customerHistoryState.scope === customerHistoryScope ? customerHistoryState.status : 'loading'}
                onRetryHistory={retryCustomerHistory}
                favoriteIds={favoriteIds}
                hostDealIds={hostDealIds}
                selectedDeal={selectedDeal}
                screen={customerScreen}
                adminMode={customerAdminMode}
                readOnly={customerReadOnly}
                unreadCounts={unreadCounts}
                statusNotices={{ ...statusNotices, ...paymentNotices }}
                onProfileSubmit={handleProfileSubmit}
                onSelectDeal={(deal) => {
                  acknowledgeGroupStatus(deal);
                  setSelectedDeal(deal);
                  navigateCustomerScreen('detail');
                  track('open_listing', {
                    deal_id: deal.id,
                    category: deal.category,
                    store: deal.store,
                    title: deal.title,
                  });
                }}
                onScreen={navigateCustomerScreen}
                onOpenNotifications={() => {
                  navigateCustomerScreen('notifications');
                  track('notification_center_opened', {
                    notification_count: buildGroupNotifications(deals, unreadCounts, statusNotices).length,
                  });
                }}
                onOpenNotification={openGroupNotification}
                onRoomRead={handleRoomRead}
                onOrderCreate={saveCustomerOrder}
                onGroupCreate={createCustomerGroup}
                onToggleFavorite={toggleFavorite}
                onHostApply={applyHost}
                onOrderUpdate={persistCustomerOrderSnapshot}
                onBeforePaymentRequest={ensurePaymentOrderSaved}
                editableDealIds={customerAdminMode || customerReadOnly
                  ? []
                  : customerGroups
                    .filter((deal) => Boolean(getDealCapability(deal.id)))
                    .map((deal) => deal.id)}
                onUpdateDeal={updateCustomerDeal}
                onUpdateTarget={updateCustomerGroupTarget}
                onDeleteDeal={async (deal) => {
                  assertCurrentCustomerMutationAllowed();
                  return removeDeal(deal);
                }}
                onConfirmPickup={confirmCustomerPickup}
                onCancelParticipation={cancelParticipation}
                onNeighborhoodChange={handleNeighborhoodChange}
                onLogout={handleLogout}
              />
            )
          )}
          {route === '/owner' && (!hasActiveProfileSession || profile?.testerType !== '사장님' ? (
            <Onboarding
              key="owner-onboarding"
              onSubmit={handleProfileSubmit}
              defaultTesterType="사장님"
              lockTesterType
              initialProfile={rememberedOwnerProfile}
            />
          ) : (
            <OwnerApp
              key={activeOwnerScope}
              screen={ownerWorkspaceScope === activeOwnerScope ? ownerScreen : 'form'}
              selectedDeal={selectedDeal}
              deals={deals}
              centralDeals={remoteDeals}
              syncIssues={publicDealSyncIssues}
              onScreen={setOwnerScreen}
              onCreate={addOwnerDeal}
              createdDeals={scopedCreatedDeals}
              ownedDeals={scopedOwnedDeals}
              onDeleteDeal={removeDeal}
              orders={orders}
              ownerOrders={scopedOwnerOrders}
              ownerRecoveryCount={ownerRecoveryCandidates.length}
              ownerRecoveryBusy={ownerRecoveryBusy}
              ownerRecoveryError={ownerRecoveryError}
              workspaceStatus={ownerWorkspaceStatus}
              onRetryWorkspace={() => setOwnerRecoveryLookupVersion((value) => value + 1)}
              ownerAccountHint={ownerAccountHint}
              onRecoverOwnerProducts={handleOwnerRecoveryAction}
              onSwitchOwnerAccount={switchToStoredOwnerProfile}
              ownerBackupStatus={ownerBackupStatus}
              onExportOwnerBackup={exportOwnerManagementBackup}
              onImportOwnerBackup={importOwnerManagementBackup}
              onOrderStatusChange={updateOrderStatus}
              onPaymentConfirm={confirmManualPayment}
              onPreviewCustomer={openOwnerCustomerPreview}
              location={ownerLocation}
              onNeighborhoodChange={handleOwnerNeighborhoodChange}
            />
          ))}
        </PhoneFrame>
      </section>
    </main>
  );
}

function AppLauncher({ onNavigate }) {
  useScreenAnalytics('app_launcher');
  const apps = [
    {
      id: 'customer',
      title: '사용자 앱',
      description: '공동구매 리스트, 상세, 참여, 그룹방 생성, 설문 흐름',
      icon: Users,
      path: '/customer',
    },
    {
      id: 'owner',
      title: '사장님 앱',
      description: '상품 등록, 할인율 자동 계산, 재고/수령 방식/마감 설정',
      icon: Store,
      path: '/owner',
    },
    {
      id: 'admin',
      title: '관리자 앱',
      description: '그룹별 채팅 열람·작성, 거래 상태 관리, 채팅 잠금',
      icon: ShieldCheck,
      path: '/admin',
    },
    {
      id: 'dashboard',
      title: '검증 대시보드',
      description: 'Funnel, 체류시간, 설문, CSV, 이벤트 로그 확인',
      icon: BarChart3,
      path: '/dashboard',
    },
  ].filter((app) => RELEASE_FEATURES.admin || app.id !== 'admin');

  return (
    <main className="launcher-page">
      <section className="launcher-hero">
        <p className="eyebrow">위치기반 공동구매 O2O</p>
        <h1>클릭형 MVP</h1>
        <p>개발 {RELEASE_FEATURES.phase}일차 기능 검수본 · 승인된 기능만 단계적으로 공개합니다.</p>
      </section>
      <section className="launcher-grid">
        {apps.map(({ id, title, description, icon: Icon, path }) => (
          <button key={id} className="launcher-card" onClick={() => onNavigate(path)}>
            <Icon size={28} />
            <strong>{title}</strong>
            <span>{description}</span>
          </button>
        ))}
      </section>
    </main>
  );
}

function StandaloneHeader({ eyebrow, title, active, onNavigate, customerPreview = false }) {
  const links = [
    {
      id: 'customer',
      label: customerPreview ? '사용자 미리보기' : '사용자 앱',
      path: '/customer',
      icon: Users,
    },
    { id: 'owner', label: '사장님 앱', path: '/owner', icon: Store },
    { id: 'admin', label: '관리자 앱', path: '/admin', icon: ShieldCheck },
    { id: 'dashboard', label: '대시보드', path: '/dashboard', icon: BarChart3 },
  ].filter((link) => RELEASE_FEATURES.admin || link.id !== 'admin');

  return (
    <header className="standalone-header">
      <button className="home-link" onClick={() => onNavigate('/')}>
        <Home size={16} />
        앱 선택
      </button>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      <nav className="standalone-links">
        {links.map(({ id, label, path, icon: Icon }) => (
          <button
            key={id}
            className={active === id ? 'active' : ''}
            onClick={() => onNavigate(path)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>
    </header>
  );
}

function PhoneFrame({ children }) {
  return (
    <div className="phone-frame">
      <StatusBar />
      {children}
    </div>
  );
}

function StatusBar() {
  return (
    <div className="status-bar">
      <span>9:41</span>
      <span className="status-icons">●●● 5G ▰</span>
    </div>
  );
}

function CustomerPreviewNotice() {
  return (
    <aside className="customer-preview-notice" role="status">
      <ShieldCheck size={18} aria-hidden="true" />
      <div>
        <strong>사장님 계정의 사용자 화면 미리보기</strong>
        <span>읽기 전용이라 홈·탐색·계산만 표시됩니다. 사용자 로그인에서는 전체 6개 메뉴를 이용할 수 있습니다.</span>
      </div>
    </aside>
  );
}

function CustomerApp({
  deals,
  profile,
  rememberedProfile,
  orders,
  orderSyncIssues = {},
  historyStatus = 'ready',
  onRetryHistory,
  favoriteIds,
  hostDealIds,
  selectedDeal,
  screen,
  adminMode = false,
  readOnly = false,
  unreadCounts = {},
  statusNotices = {},
  onProfileSubmit,
  onSelectDeal,
  onScreen,
  onOpenNotifications,
  onOpenNotification,
  onRoomRead,
  onOrderCreate,
  onGroupCreate,
  onToggleFavorite,
  onHostApply,
  onOrderUpdate,
  onBeforePaymentRequest,
  editableDealIds,
  onUpdateDeal,
  onUpdateTarget,
  onDeleteDeal,
  onConfirmPickup,
  onCancelParticipation,
  onNeighborhoodChange,
  onLogout,
}) {
  const [completionMessage, setCompletionMessage] = useState('');
  const [adminConsolePin, setAdminConsolePin] = useState('');
  const [adminManagement, setAdminManagement] = useState(adminMode);
  const accessOptions = { adminMode, readOnly };
  const visitorId = profile ? getVisitorId() : '';
  const selectedGroupCredential = visitorId && selectedDeal?.id
    ? getGroupCredential(selectedDeal.id, visitorId)
    : null;
  const selectedGroupOwnerCapability = selectedDeal?.source === 'customer'
    && editableDealIds.includes(selectedDeal.id)
    ? getDealCapability(selectedDeal.id)
    : '';
  const selectedGroupIsLocalCreator = Boolean(
    selectedDeal?.source === 'customer'
    && editableDealIds.includes(selectedDeal.id)
    && selectedGroupOwnerCapability
    && selectedGroupCredential?.capabilityToken
    && String(selectedGroupCredential.capabilityToken).length >= 32,
  );
  const selectedGroupLegacyReceipt = selectedDeal?.source === 'customer' && visitorId
    ? loadLegacyCustomerGroupReceipt({ groupId: selectedDeal.id, actorId: visitorId })
    : null;
  const selectedGroupCanRecoverLegacy = Boolean(
    !adminMode
    && !readOnly
    && selectedGroupLegacyReceipt?.eventId
    && hasLegacyCustomerGroupRecoveryState(selectedDeal, visitorId),
  );
  const selectedGroupCanRestore = selectedGroupIsLocalCreator || selectedGroupCanRecoverLegacy;
  const requestedScreen = normalizeCustomerScreen(screen, accessOptions);
  const selectionRequiredScreens = ['detail', 'room', 'join', 'group', 'complete'];
  // A central refresh can remove a deal while one of its screens is open.
  // Render the safe list immediately instead of dereferencing the now-missing
  // selection and blanking the whole customer app.
  const selectedScreen = !selectedDeal && selectionRequiredScreens.includes(requestedScreen)
    ? 'list'
    : requestedScreen;
  const activeScreen = selectedScreen === 'room' && !(
    dealHasGroupRoom(selectedDeal)
    && customerCanOpenGroupRoom({
      adminMode,
      readOnly,
      credential: selectedGroupCredential,
      localCreator: selectedGroupCanRestore,
    })
  )
    ? 'detail'
    : selectedScreen;
  const navigateCustomer = (nextScreen, options) => onScreen(
    normalizeCustomerScreen(nextScreen, accessOptions),
    options,
  );
  const navigateCustomerBack = (fallbackScreen) => navigateCustomer(
    fallbackScreen,
    { historyAction: 'back' },
  );
  const publicDeals = deals.filter((deal) => deal.visibility !== 'private');
  const customerOrders = orders.filter(
    (order) => isOrderForProfile(order, profile, visitorId),
  );

  if (!profile || activeScreen === 'onboarding') {
    return (
      <Onboarding
        onSubmit={onProfileSubmit}
        initialProfile={rememberedProfile}
        defaultTesterType="사용자"
        lockTesterType
      />
    );
  }

  if (adminMode && adminManagement) {
    const roomOpen = activeScreen === 'room';
    return <>
      <div hidden={roomOpen} style={{ height: '100%' }}>
        <AdminConsole pin={adminConsolePin} onPinChange={setAdminConsolePin}
          onBack={() => { setAdminManagement(false); onScreen('list'); }} ImageUploader={ImageCropUploader}
          onOpenRoom={(deal) => { onSelectDeal(deal); onScreen('room'); }} />
      </div>
      {roomOpen && <GroupRoom
        deal={selectedDeal} profile={profile} adminMode initialAdminPin={adminConsolePin}
        isCreator={selectedGroupIsLocalCreator} ownerCapabilityToken={selectedGroupOwnerCapability}
        onBack={() => navigateCustomerBack('list')} onDealUpdate={onUpdateDeal} onRead={onRoomRead}
        orders={customerOrders} onOrderUpdate={onOrderUpdate} onCancelParticipation={onCancelParticipation}
        onBeforePaymentRequest={onBeforePaymentRequest}
        withBottomNavigation={false}
      />}
    </>;
  }

  const renderCustomerScreen = () => {
  if (activeScreen === 'detail') {
    return (
      <DealDetail
        deal={selectedDeal}
        onBack={() => navigateCustomerBack('list')}
        onScreen={navigateCustomer}
        isFavorite={favoriteIds.includes(selectedDeal.id)}
        onToggleFavorite={onToggleFavorite}
        hostMatched={isDealHostMatched(selectedDeal, hostDealIds)}
        onHostApply={onHostApply}
        editable={editableDealIds.includes(selectedDeal.id)}
        canRepairLegacyGroup={selectedGroupCanRestore}
        onUpdateDeal={onUpdateDeal}
        onUpdateTarget={onUpdateTarget}
        onDeleteDeal={async (deal) => {
          const deleted = await onDeleteDeal(deal);
          if (shouldNavigateAfterDealDelete(deleted)) onScreen('list');
          return deleted;
        }}
        adminMode={adminMode}
        readOnly={readOnly}
        unreadCount={unreadCounts[selectedDeal.id] || 0}
        onOpenRoom={() => onScreen('room')}
      />
    );
  }

  if (activeScreen === 'room') {
    const showBottomNavigation = !adminMode && !readOnly;
    return (
      <>
        <GroupRoom
          deal={selectedDeal}
          profile={profile}
          adminMode={adminMode}
          initialAdminPin={adminConsolePin}
          isCreator={selectedGroupIsLocalCreator}
          ownerCapabilityToken={selectedGroupOwnerCapability}
          canRecoverLegacyGroup={selectedGroupCanRecoverLegacy}
          legacyEventId={selectedGroupLegacyReceipt?.eventId || ''}
          onBack={() => navigateCustomerBack('detail')}
          onDealUpdate={onUpdateDeal}
          onRead={onRoomRead}
          orders={customerOrders}
          onOrderUpdate={onOrderUpdate}
          onBeforePaymentRequest={onBeforePaymentRequest}
          onCancelParticipation={onCancelParticipation}
          withBottomNavigation={showBottomNavigation}
        />
        {showBottomNavigation ? <BottomNav active="" onSelect={navigateCustomer} /> : null}
      </>
    );
  }

  if (activeScreen === 'notifications') {
    return (
      <NotificationsTab
        notifications={buildGroupNotifications(deals, unreadCounts, statusNotices)}
        onBack={() => navigateCustomerBack('list')}
        onOpen={onOpenNotification}
      />
    );
  }

  if (activeScreen === 'calculator') {
    return (
      <>
        <SplitCalculator
          initialTotal={selectedDeal?.simulation?.total || 39000}
          initialPeople={selectedDeal?.simulation?.people || 3}
          initialProductQuantity={selectedDeal?.simulation?.totalQuantity || selectedDeal?.simulation?.productQuantity || 3}
          initialSelectedQuantity={selectedDeal?.simulation?.creatorQuantity || selectedDeal?.simulation?.creatorProductQuantity || 1}
          onBack={() => navigateCustomerBack('list')}
          readOnly={readOnly}
          onCreateGroup={(simulation) => {
            onSelectDeal({
              ...NEW_CUSTOMER_GROUP_DEAL,
              originalPrice: simulation.total,
              target: simulation.people,
              targetPeople: simulation.people,
              totalQuantity: simulation.totalQuantity || simulation.productQuantity,
              creatorQuantity: simulation.creatorQuantity || simulation.creatorProductQuantity,
              simulation,
            });
            navigateCustomer('group');
          }}
        />
        <BottomNav active="calculator" onSelect={navigateCustomer} readOnly={readOnly} />
      </>
    );
  }

  if (activeScreen === 'join') {
    return (
      <JoinFlow
        deal={selectedDeal}
        orders={customerOrders}
        onBack={() => navigateCustomerBack('detail')}
        onScreen={navigateCustomer}
        onOrderCreate={onOrderCreate}
        onHostApply={onHostApply}
        onCompletionMessage={setCompletionMessage}
      />
    );
  }

  if (activeScreen === 'group') {
    return (
      <GroupCreator
        deal={selectedDeal}
        onBack={() => navigateCustomerBack(selectedDeal.isNewGroup ? 'explore' : 'detail')}
        onScreen={navigateCustomer}
        onOrderCreate={onOrderCreate}
        onGroupCreate={onGroupCreate}
      />
    );
  }

  if (activeScreen === 'complete') {
    return (
      <Completion
        deal={selectedDeal}
        message={completionMessage}
        onScreen={navigateCustomer}
      />
    );
  }

  if (activeScreen === 'survey') {
    return <Survey onScreen={navigateCustomer} />;
  }

  if (activeScreen === 'explore') {
    return (
      <ExploreTab
        deals={publicDeals}
        hostDealIds={hostDealIds}
        unreadCounts={unreadCounts}
        statusNotices={statusNotices}
        onSelectDeal={onSelectDeal}
        onScreen={navigateCustomer}
        readOnly={readOnly}
      />
    );
  }

  if (activeScreen === 'orders') {
    return (
      <OrdersTab
        orders={customerOrders}
        orderSyncIssues={orderSyncIssues}
        historyStatus={historyStatus}
        onRetryHistory={onRetryHistory}
        deals={deals}
        onSelectDeal={onSelectDeal}
        onConfirmPickup={onConfirmPickup}
        onCancelParticipation={onCancelParticipation}
        onScreen={navigateCustomer}
      />
    );
  }

  if (activeScreen === 'favorites') {
    return (
      <FavoritesTab
        favoriteDeals={deals.filter((deal) => favoriteIds.includes(deal.id))}
        hostDealIds={hostDealIds}
        unreadCounts={unreadCounts}
        statusNotices={statusNotices}
        onSelectDeal={onSelectDeal}
        onScreen={navigateCustomer}
      />
    );
  }

  if (activeScreen === 'profile') {
    return (
      <ProfileTab
        profile={profile}
        orders={customerOrders}
        favoriteCount={favoriteIds.length}
        onScreen={navigateCustomer}
        onLogout={onLogout}
      />
    );
  }

  return (
    <div className="customer-browser-wrapper" style={adminMode ? { height: 'auto', flex: 1, minHeight: 0 } : undefined}>
    <DealList
      deals={publicDeals}
      profile={profile}
      hostDealIds={hostDealIds}
      unreadCounts={unreadCounts}
      statusNotices={statusNotices}
      onSelectDeal={onSelectDeal}
      onScreen={navigateCustomer}
      onOpenNotifications={onOpenNotifications}
      onNeighborhoodChange={onNeighborhoodChange}
      adminMode={adminMode}
      readOnly={readOnly}
    />
    </div>
  );
  };

  return adminMode ? <div className="admin-browser-wrapper">
    <button className="primary-button" onClick={() => { setAdminManagement(true); onScreen('list'); }}>상품·주문 관리자 운영 관리</button>
    {renderCustomerScreen()}
  </div> : renderCustomerScreen();
}

function Onboarding({
  onSubmit,
  defaultTesterType = '사용자',
  lockTesterType = false,
  initialProfile = null,
}) {
  useScreenAnalytics('onboarding');
  const screenRef = useRef(null);
  const [form, setForm] = useState(() => {
    const rememberedProfile = initialProfile ? migrateLocationFields(initialProfile) : null;
    return {
      name: String(rememberedProfile?.name || ''),
      phone: formatKoreanMobilePhoneInput(rememberedProfile?.phone || ''),
      ...normalizeLocation(rememberedProfile || DEFAULT_LOCATION),
      testerType: lockTesterType
        ? defaultTesterType
        : rememberedProfile?.testerType || defaultTesterType,
      consent: rememberedProfile?.consent === true,
    };
  });
  const selectedRegion = getRegion(form.region);
  const selectedDistrict = getDistrict(selectedRegion, form.district);
  const phoneValid = isValidKoreanMobilePhone(form.phone);
  const phoneErrorVisible = Boolean(form.phone) && !phoneValid;
  const disabled = !form.name.trim() || !phoneValid || !form.consent;

  useLayoutEffect(() => {
    const resetScroll = () => {
      if (screenRef.current) screenRef.current.scrollTop = 0;
      window.scrollTo?.(0, 0);
    };
    resetScroll();
    const frame = window.requestAnimationFrame(resetScroll);
    window.addEventListener('pageshow', resetScroll);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pageshow', resetScroll);
    };
  }, [defaultTesterType]);

  return (
    <section ref={screenRef} className="screen onboarding-screen">
      <div className="brand-block">
        <ShoppingBag size={30} />
        <p className="eyebrow">위치기반 공동구매</p>
        <h1>모여사요</h1>
        <span>기본 정보와 활동할 지역·동네를 설정해 주세요.</span>
      </div>

      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) onSubmit({
            ...form,
            name: form.name.trim(),
            phone: formatKoreanMobilePhoneInput(form.phone),
          });
        }}
      >
        <label>
          이름
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="홍길동"
          />
        </label>
        <label>
          연락처
          <input
            type="tel"
            value={form.phone}
            onChange={(event) => setForm({ ...form, phone: formatKoreanMobilePhoneInput(event.target.value) })}
            placeholder="010-0000-0000"
            inputMode="tel"
            autoComplete="tel"
            maxLength={24}
            aria-invalid={phoneErrorVisible}
            aria-describedby={phoneErrorVisible ? 'onboarding-phone-error' : undefined}
          />
          {phoneErrorVisible && (
            <span id="onboarding-phone-error" className="form-error" role="alert">
              {KOREAN_MOBILE_PHONE_ERROR}
            </span>
          )}
        </label>
        <div className="region-neighborhood-fields">
          <label>
            시·도
            <select
              value={form.region}
              onChange={(event) => {
                const region = getRegion(event.target.value);
                const district = region.districts[0];
                setForm({
                  ...form,
                  region: region.name,
                  district: district.name,
                  neighborhood: district.neighborhoods[0],
                });
              }}
            >
              {REGIONS.map((region) => <option key={region.name}>{region.name}</option>)}
            </select>
          </label>
          <label>
            시·군·구
            <select
              value={form.district}
              onChange={(event) => {
                const district = getDistrict(selectedRegion, event.target.value);
                setForm({ ...form, district: district.name, neighborhood: district.neighborhoods[0] });
              }}
            >
              {selectedRegion.districts.map((district) => (
                <option key={district.code} value={district.name}>{district.name}</option>
              ))}
            </select>
          </label>
          <label>
            읍·면·동
            <select
              value={form.neighborhood}
              onChange={(event) => setForm({ ...form, neighborhood: event.target.value })}
            >
              {selectedDistrict.neighborhoods.map((neighborhood) => (
                <option key={neighborhood}>{neighborhood}</option>
              ))}
            </select>
          </label>
        </div>
        {lockTesterType ? (
          <div className="neighborhood-link-preview">
            {defaultTesterType === '관리자'
              ? <ShieldCheck size={18} />
              : defaultTesterType === '사장님'
                ? <Store size={18} />
                : <User size={18} />}
            <div>
              <strong>{defaultTesterType} 테스트 계정 등록</strong>
              <span>
                {defaultTesterType === '관리자'
                  ? '관리자 PIN은 그룹 입장 시 별도로 확인합니다.'
                  : defaultTesterType === '사장님'
                    ? '입력한 정보로 상품과 주문을 구분합니다.'
                    : '입력한 정보로 참여 내역과 주문을 구분합니다.'}
              </span>
            </div>
          </div>
        ) : (
          <div className="segmented-control">
            {['사용자', '사장님', '투자자'].map((type) => (
              <button
                type="button"
                key={type}
                className={form.testerType === type ? 'segment active' : 'segment'}
                onClick={() => setForm({ ...form, testerType: type })}
              >
                {type}
              </button>
            ))}
          </div>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.consent}
            onChange={(event) => setForm({ ...form, consent: event.target.checked })}
          />
          개인정보 수집 및 테스트 행동 데이터 수집 동의
        </label>
        <p className="evidence-note">
          이름·연락처는 검증용 Google Sheets에 저장되며, PostHog에는 연락처와 이름을 제외한 고객번호·지역·행동 이벤트만 전송됩니다.
        </p>
        <div className="neighborhood-link-preview">
          <MapPin size={18} />
          <div>
            <strong>{formatLocation(form)} 화면으로 연결</strong>
            <span>지역은 픽업 안내와 이용 통계에 사용되며, 공개 상품은 전국에서 확인할 수 있습니다.</span>
          </div>
        </div>
        <button className="primary-button" type="submit" disabled={disabled}>
          <Check size={18} />
          테스트 시작
        </button>
      </form>
    </section>
  );
}

function DealList({
  deals,
  profile,
  hostDealIds,
  unreadCounts = {},
  statusNotices = {},
  onSelectDeal,
  onScreen,
  onOpenNotifications,
  onNeighborhoodChange,
  adminMode = false,
  readOnly = false,
}) {
  useScreenAnalytics('deal_list', {
    region: profile.region,
    district: profile.district,
    neighborhood: profile.neighborhood,
  });
  const [category, setCategory] = useState('전체');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [selectingNeighborhood, setSelectingNeighborhood] = useState(false);
  const groupNotifications = buildGroupNotifications(deals, unreadCounts, statusNotices);
  const totalUnread = groupNotifications.reduce((sum, item) => sum + item.unreadCount, 0);
  const totalStatusNotices = groupNotifications.reduce(
    (sum, item) => sum + Number(Boolean(item.status)),
    0,
  );

  useEffect(() => {
    if (totalUnread > 0) {
      track('unread_badge_viewed', { unread_count: totalUnread });
    }
  }, [totalUnread]);

  const categories = ['전체', ...PRODUCT_CATEGORIES];
  const filtered = deals.filter((deal) => {
    const matchCategory = category === '전체' || deal.category === category;
    const matchSource = source === 'all' || deal.source === source;
    const matchQuery = `${deal.title} ${deal.store} ${deal.description || ''}`.includes(query);
    return matchCategory && matchSource && matchQuery;
  });

  return (
    <section className="screen">
      <header className="top-nav">
        <div>
          <p className="eyebrow">현재 위치</p>
          <button className="location-trigger" onClick={() => setSelectingNeighborhood(true)}>
            <MapPin size={19} />
            <span>{profile.neighborhood} 공동구매</span>
          </button>
        </div>
        <div className="inline-actions">
          {!adminMode && (
            <button className="icon-button" aria-label="예상 부담금 계산기" onClick={() => onScreen('calculator')}>
              <Calculator size={20} />
            </button>
          )}
          {RELEASE_FEATURES.unreadBadges && !readOnly && (
            <button
              className="icon-button notification-button"
              aria-label={`그룹 알림 ${totalUnread + totalStatusNotices}건`}
              onClick={onOpenNotifications}
            >
              <Bell size={20} />
              {totalUnread + totalStatusNotices > 0 && (
                <span>{Math.min(99, totalUnread + totalStatusNotices)}</span>
              )}
            </button>
          )}
        </div>
      </header>

      {readOnly && <CustomerPreviewNotice />}

      <div className="neighborhood-sync-banner">
        <MapPin size={16} />
        <div>
          <strong>{profile.neighborhood} 픽업 기준 지역</strong>
          <span>지역과 관계없이 모든 공개 테스트 상품을 표시합니다.</span>
        </div>
      </div>

      <div className="search-field">
        <Search size={18} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="매장 또는 상품 검색" />
      </div>

      {!adminMode && (
        <button className="calculator-entry-card" onClick={() => onScreen('calculator')}>
          <Calculator size={22} />
          <div><strong>나눠 사면 1인당 얼마일까요?</strong><span>그룹 참여 없이 판매가와 인원만으로 바로 계산</span></div>
          <ChevronRight size={18} />
        </button>
      )}

      <div className="source-filter">
        {[
          { id: 'all', label: '전체', icon: ShoppingBag },
          { id: 'merchant', label: '사장님', icon: Store },
          { id: 'customer', label: '사용자', icon: User },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={source === id ? 'active' : ''}
            onClick={() => {
              setSource(id);
              track('source_filter_clicked', { source: id });
            }}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      <div className="chip-row">
        {categories.map((item) => (
          <button
            key={item}
            className={category === item ? 'chip active' : 'chip'}
            onClick={() => {
              setCategory(item);
              track('filter_clicked', { filter: item });
            }}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="deal-list">
        {filtered.length === 0 && (
          <div className="inline-empty-state">
            <MapPin size={26} />
            <strong>현재 공개된 공동구매가 없어요</strong>
            <span>첫 그룹을 만들어 공개 모집을 시작해 보세요.</span>
          </div>
        )}
        {filtered.map((deal) => (
          <DealCard
            key={deal.id}
            deal={deal}
            hostMatched={isDealHostMatched(deal, hostDealIds)}
            unreadCount={unreadCounts[deal.id] || 0}
            statusNotice={statusNotices[deal.id] || ''}
            onClick={() => onSelectDeal(deal)}
          />
        ))}
      </div>

      <BottomNav active="home" onSelect={onScreen} adminMode={adminMode} readOnly={readOnly} />
      {selectingNeighborhood && (
        <NeighborhoodPicker
          current={profile}
          onClose={() => setSelectingNeighborhood(false)}
          onSelect={(location) => {
            onNeighborhoodChange(location);
            setSelectingNeighborhood(false);
          }}
        />
      )}
    </section>
  );
}

function NotificationsTab({ notifications, onBack, onOpen }) {
  useScreenAnalytics('notification_center', { notification_count: notifications.length });
  return (
    <section className="screen notification-center-screen">
      <header className="top-nav compact">
        <button className="icon-button" onClick={onBack} aria-label="뒤로">
          <ArrowLeft size={22} />
        </button>
        <h1>그룹 알림</h1>
        <Bell size={20} />
      </header>

      {notifications.length === 0 ? (
        <EmptyCustomerState
          icon={Bell}
          title="새로운 그룹 알림이 없습니다"
          body="새 메시지나 모집 상태 변경이 생기면 이곳에 그룹별로 표시됩니다."
          actionLabel="공동구매 둘러보기"
          onAction={onBack}
        />
      ) : (
        <div className="notification-list">
          {notifications.map(({ deal, unreadCount, status, destination }) => (
            <button
              className="notification-list-item"
              key={deal.id}
              onClick={() => onOpen(deal, destination)}
            >
              <div className="notification-list-icon">
                {unreadCount > 0 ? <MessageCircle size={19} /> : <Bell size={19} />}
              </div>
              <div>
                <strong>{deal.title}</strong>
                {unreadCount > 0 && <span>확인하지 않은 새 메시지 {unreadCount}개</span>}
                {status && <span>{status.startsWith('입금 알림') ? status : `거래 상태 · ${GROUP_STATUS_LABELS[status] || status}`}</span>}
              </div>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function NeighborhoodPicker({ current, onSelect, onClose }) {
  const [location, setLocation] = useState(() => normalizeLocation(current));
  const selectedRegion = getRegion(location.region);
  const selectedDistrict = getDistrict(selectedRegion, location.district);

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="neighborhood-picker-title">
      <div className="bottom-sheet neighborhood-sheet">
        <div className="sheet-header">
          <div>
            <p className="eyebrow">픽업·통계 기준</p>
            <h2 id="neighborhood-picker-title">지역 설정</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            <X size={20} />
          </button>
        </div>
        <div className="region-neighborhood-fields neighborhood-picker-fields">
          <label>
            시·도
            <select
              value={location.region}
              onChange={(event) => {
                const region = getRegion(event.target.value);
                const district = region.districts[0];
                setLocation({
                  region: region.name,
                  district: district.name,
                  neighborhood: district.neighborhoods[0],
                });
              }}
            >
              {REGIONS.map((region) => <option key={region.code} value={region.name}>{region.name}</option>)}
            </select>
          </label>
          <label>
            시·군·구
            <select
              value={location.district}
              onChange={(event) => {
                const district = getDistrict(selectedRegion, event.target.value);
                setLocation({ ...location, district: district.name, neighborhood: district.neighborhoods[0] });
              }}
            >
              {selectedRegion.districts.map((district) => (
                <option key={district.code} value={district.name}>{district.name}</option>
              ))}
            </select>
          </label>
          <label>
            읍·면·동
            <select
              value={location.neighborhood}
              onChange={(event) => setLocation({ ...location, neighborhood: event.target.value })}
            >
              {selectedDistrict.neighborhoods.map((neighborhood) => (
                <option key={neighborhood}>{neighborhood}</option>
              ))}
            </select>
          </label>
        </div>
        <button className="primary-button" onClick={() => onSelect(location)}>
          <MapPin size={17} />
          {location.neighborhood} 적용
        </button>
        <p className="neighborhood-help">지역은 픽업 위치 안내와 이용 통계에 사용되며, 공개 상품과 그룹의 노출을 제한하지 않습니다.</p>
      </div>
    </div>
  );
}

function DealCard({ deal, hostMatched, unreadCount = 0, statusNotice = '', onClick }) {
  const isCustomerGroup = deal.source === 'customer';
  const isInstant = deal.saleType === 'instant';
  const isSplitMerchant = isSplitMerchantDeal(deal);
  const typeLabel = isCustomerGroup ? '사용자 그룹' : isInstant ? '선착순 즉시할인' : '사장님 공구';
  const TypeIcon = isCustomerGroup ? User : Store;
  const price = getDealPrice(deal);

  return (
    <button className="deal-card" onClick={onClick}>
      <img
        src={deal.image || fallbackImage}
        alt={`${deal.title} 상품 이미지`}
        onError={replaceBrokenImage}
      />
      <div className="deal-content">
        <div className="deal-title-row">
          <strong>{deal.title}</strong>
          <span>{unreadCount > 0
            ? `새 메시지 ${Math.min(99, unreadCount)}`
            : statusNotice
              ? `새 알림 · ${GROUP_STATUS_LABELS[statusNotice] || statusNotice}`
              : isInstant ? '선착순' : deal.deadline}</span>
        </div>
        <div className="deal-badges">
          <span className={isCustomerGroup ? 'type-badge customer' : 'type-badge merchant'}>
            <TypeIcon size={12} />
            {typeLabel}
          </span>
          {hostMatched && <span className="type-badge host">{isCustomerGroup && deal.hostMode !== 'recruiting' ? '생성자가 호스트' : '호스트 모집 완료'}</span>}
          {isCustomerGroup && deal.hostMode === 'recruiting' && !hostMatched && (
            <span className="type-badge host recruiting">호스트 모집 중</span>
          )}
          {isCustomerGroup && (
            <span className="type-badge trade">{GROUP_STATUS_LABELS[deal.groupStatus || 'recruiting']}</span>
          )}
        </div>
        <p>{isCustomerGroup ? deal.description : deal.store}</p>
        <p className="muted-line">
          <MapPin size={14} />
          {deal.address} · {deal.distance}
        </p>
        {isInstant && deal.eventStart && (
          <p className="event-time-line">
            <Clock size={13} />
            오늘 {deal.eventStart} ~ {deal.eventEnd} 진행
          </p>
        )}
        <Progress deal={deal} />
        <div className="price-row">
          <span>{isCustomerGroup || isSplitMerchant ? '제품 1개 예상금액' : `${deal.discountRate}% 할인`}</span>
          <strong>{formatWon(price)}</strong>
        </div>
      </div>
    </button>
  );
}

function ExploreTab({ deals, hostDealIds, unreadCounts = {}, statusNotices = {}, onSelectDeal, onScreen, readOnly = false }) {
  useScreenAnalytics('customer_explore');
  const urgentDeals = [...deals].sort((a, b) => b.discountRate - a.discountRate);

  return (
    <section className="screen">
      <header className="top-nav">
        <div>
          <p className="eyebrow">탐색</p>
          <h1>지금 모이는 공구</h1>
        </div>
        {!readOnly && (
          <button
            className="icon-button"
            aria-label="그룹 만들기"
            onClick={() => {
              track('bottom_tab_action_clicked', { action: 'create_group' });
              onSelectDeal(NEW_CUSTOMER_GROUP_DEAL);
              onScreen('group');
            }}
          >
            <Plus size={20} />
          </button>
        )}
      </header>

      {readOnly && <CustomerPreviewNotice />}

      <div className="insight-strip">
        <div>
          <span>공개 진행중</span>
          <strong>{deals.length}개</strong>
        </div>
        <div>
          <span>최대 할인</span>
          <strong>{deals.length ? Math.max(...deals.map((deal) => deal.discountRate)) : 0}%</strong>
        </div>
        <div>
          <span>그룹배달</span>
          <strong>가능</strong>
        </div>
      </div>

      <div className="section-copy">
        <h2>추천 공동구매</h2>
        <p>할인율과 참여 속도가 높은 상품을 먼저 보여줍니다.</p>
      </div>

      <div className="deal-list compact-deal-list">
        {deals.length === 0 && (
          <div className="inline-empty-state">
            <MapPin size={26} />
            <strong>현재 공개된 공구가 없어요</strong>
          </div>
        )}
        {urgentDeals.map((deal) => (
          <DealCard
            key={deal.id}
            deal={deal}
            hostMatched={isDealHostMatched(deal, hostDealIds)}
            unreadCount={unreadCounts[deal.id] || 0}
            statusNotice={statusNotices[deal.id] || ''}
            onClick={() => onSelectDeal(deal)}
          />
        ))}
      </div>

      <BottomNav active="explore" onSelect={onScreen} readOnly={readOnly} />
    </section>
  );
}

function CustomerHistoryNotice({ status, onRetry }) {
  // A key minted in this browser cannot authorize anything ordered earlier, so
  // an empty list is not a confirmed history. Saying otherwise made a lost
  // ownership key look like deleted orders.
  const capability = getCustomerOrderCapabilityState();
  const freshKey = capability.lostKey;
  return (
    <div className={`customer-history-notice${status === 'error' || freshKey || !capability.persisted ? ' has-error' : ''}`} aria-live="polite">
      {status === 'loading' ? <p role="status">이전 주문·참여 이력을 확인하고 있습니다.</p>
        : status === 'error' ? <p role="alert">이전 이력을 불러오지 못했습니다. 현재 표시된 목록은 유지되며, 이전 주문이 없는 것으로 확정된 것은 아닙니다.</p>
          : <p>조회 가능한 주문 이력을 확인했습니다.</p>}
      {freshKey && (
        <p role="alert">이 브라우저의 주문 확인 키가 사라져 새로 만들었습니다. 브라우저가 저장소를 비웠을 때 생기며, 이전 주문은 이 키로는 조회되지 않습니다. 없어진 것이 아니라 이 브라우저에서 확인할 수 없는 상태이니 원래 사용하던 브라우저에서 확인하거나 관리자 앱으로 조회해 주세요.</p>
      )}
      {!capability.persisted && (
        <p role="alert">브라우저 저장공간이 부족해 주문 확인 키를 저장하지 못했습니다. 지금 넣은 주문은 다음 접속에서 보이지 않을 수 있습니다. 저장공간을 확보한 뒤 다시 확인해 주세요.</p>
      )}
      <button type="button" className="secondary-button compact-button" disabled={status === 'loading'} onClick={onRetry}>
        {status === 'loading' ? '이력 확인 중…' : '주문 이력 다시 불러오기'}
      </button>
      <details>
        <summary>이전 주문이 보이지 않나요?</summary>
        <p>이 브라우저와 현재 프로필에서 조회 권한이 확인된 이력만 표시합니다. 주문했던 같은 브라우저와 전화번호인지 확인해 주세요. 이전 주문의 권한키가 없거나 연결되지 않은 기록은 여기서 자동 복구할 수 없습니다. 브라우저 데이터를 지우지 말고 관리자에게 해당 주문 확인을 요청해 주세요.</p>
        <CustomerRecoveryCode />
      </details>
    </div>
  );
}

function CustomerRecoveryCode() {
  const [code, setCode] = useState('');
  const [failed, setFailed] = useState(false);
  const reveal = async () => {
    setFailed(false);
    try {
      setCode(await getCustomerRecoveryCode());
    } catch {
      setCode('');
      setFailed(true);
    }
  };
  return (
    <>
      <p>관리자가 전화나 대면으로 본인 확인을 한 뒤, 아래 복구 코드로 이 기기에 지난 주문을 다시 연결해 줄 수 있습니다. 이 코드는 이 기기를 가리키는 공개 식별자일 뿐이라 알려 줘도 주문 권한이 넘어가지 않습니다.</p>
      {code
        ? <p><code className="recovery-code">{code}</code><br />이 64자리를 관리자에게 그대로 읽어 주거나 전달해 주세요. 연결이 끝나면 같은 전화번호로 “주문 이력 다시 불러오기”를 눌러 주세요.</p>
        : <button type="button" className="secondary-button compact-button" onClick={reveal}>복구 코드 보기</button>}
      {failed && <p role="alert">이 브라우저에서는 복구 코드를 계산할 수 없습니다. 주소창이 https 인지 확인하거나 다른 브라우저에서 다시 시도해 주세요.</p>}
    </>
  );
}

function OrdersTab({ orders, orderSyncIssues = {}, historyStatus = 'ready', onRetryHistory, deals, onSelectDeal, onConfirmPickup, onCancelParticipation, onScreen }) {
  useScreenAnalytics('customer_orders', { order_count: orders.length });
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const [cancellingId, setCancellingId] = useState('');
  const [cancelError, setCancelError] = useState(null);
  const [confirmingPickupId, setConfirmingPickupId] = useState('');
  const [pickupError, setPickupError] = useState(null);

  const handlePickupConfirmation = async (order) => {
    if (confirmingPickupId) return;
    setConfirmingPickupId(order.id);
    setPickupError(null);
    try {
      await onConfirmPickup(order.id);
    } catch {
      setPickupError({
        orderId: order.id,
        message: '픽업 완료를 서버에 반영하지 못했습니다. 연결을 확인한 뒤 다시 눌러 주세요.',
      });
    } finally {
      setConfirmingPickupId('');
    }
  };

  const handleCancellation = async (order, deal) => {
    if (!SCOPED_UI_ACTIONS.participationCancellation || cancellingId) return;
    const confirmed = window.confirm(
      `“${deal?.title || order.title}” 참여를 취소할까요?\n배정된 수량이 다시 모집 가능 수량으로 돌아갑니다.`,
    );
    if (!confirmed) return;
    setCancellingId(order.id);
    setCancelError(null);
    try {
      await onCancelParticipation(order);
    } catch (error) {
      const message = ['payment_already_processed', 'order_not_cancellable'].includes(error?.message)
        ? '입금 확인 요청 또는 거래 처리가 시작된 주문은 취소할 수 없습니다.'
        : error?.message === 'participation_cancellation_closed'
          ? '모집이 종료되어 이 참여를 취소할 수 없습니다.'
          : error?.message === 'forbidden'
            ? '그룹 생성자·호스트 주문은 여기에서 참여 취소할 수 없습니다.'
            : error?.message === 'state_conflict'
              ? '다른 변경이 먼저 반영되었습니다. 잠시 후 다시 시도해 주세요.'
              : '참여 취소를 반영하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
      setCancelError({ orderId: order.id, message });
    } finally {
      setCancellingId('');
    }
  };

  return (
    <section className="screen">
      <header className="top-nav">
        <div>
          <p className="eyebrow">내 주문</p>
          <h1>참여 내역</h1>
        </div>
        <ShoppingBag size={22} />
      </header>

      <CustomerHistoryNotice status={historyStatus} onRetry={onRetryHistory} />
      {orders.length === 0 && historyStatus === 'ready' && !getCustomerOrderCapabilityState().lostKey ? (
        <EmptyCustomerState
          icon={ShoppingBag}
          title="조회 가능한 참여 내역이 없습니다"
          body="현재 브라우저에서 확인할 수 있는 기록이 없습니다. 이전 주문이 있었다면 위 안내를 확인해 주세요."
          actionLabel="공구 보러가기"
          onAction={() => onScreen('list')}
        />
      ) : (
        <div className="order-card-list">
          {orders.map((order) => {
            const deal = resolveOrderLinkedDeal(order, dealById.get(order.dealId));
            const syncIssue = orderSyncIssues[order.id] || null;
            const cancelled = isCancelledOrder(order);
            const orderStage = getOrderStage(order);
            const paymentStatus = getOrderPaymentStatus(order);
            const paymentStatusLabel = paymentStatus === 'confirmed'
              ? '입금완료'
              : paymentStatus === 'requested' ? '입금확인요청 전송 완료' : '입금대기';
            const paymentHistoryUnconfirmed = historyStatus !== 'ready';
            const paymentNeedsRepair = order.paymentSyncStatus === 'repair_required';
            const tracksPayment = order.type === 'purchase' || Boolean(order.groupId);
            const orderStageIndex = ORDER_STAGES.findIndex((stage) => stage.id === orderStage.id);
            const groupRole = dealHasGroupRoom(deal)
              ? getGroupCredential(
                  order.groupId || deal.id,
                  order.participantActorId || order.visitorId,
                )?.role || ''
              : '';
            const canCancel = SCOPED_UI_ACTIONS.participationCancellation
              && canCancelParticipation(order, deal, groupRole);
            const canOpenRoom = RELEASE_FEATURES.chat && canOpenOrderGroupRoom({
              order,
              deal,
              cancelled,
            });
            const canConfirmPickup = !cancelled && order.type === 'purchase'
              && ['pickup_waiting', 'completed'].includes(orderStage.id)
              && !order.customerPickupConfirmedAt;
            const verificationComplete = !cancelled && order.type === 'purchase'
              && !paymentNeedsRepair
              && orderStage.id === 'completed'
              && Boolean(order.customerPickupConfirmedAt)
              && paymentStatus === 'confirmed';
            return (
              <article className={cancelled ? 'order-card cancelled' : 'order-card'} key={order.id}>
                <div className="order-status-line">
                  <span>{cancelled ? '참여 취소' : order.type === 'group' ? '그룹방 생성' : orderStage.label}</span>
                  <strong>{cancelled ? '수량 배정 복구 완료' : order.type === 'group' ? order.method : '사장님 상태 반영'}</strong>
                </div>
                <h2>{deal?.title || order.title}</h2>
                <p>{deal?.store || order.store}</p>
                {order.type !== 'group' && !cancelled && (
                  <div className="order-status-steps" aria-label={`주문 상태 ${orderStage.label}`}>
                    {ORDER_STAGES.map((stage, index) => (
                      <span key={stage.id} className={index <= orderStageIndex ? 'active' : ''}>
                        {stage.label}
                      </span>
                    ))}
                  </div>
                )}
                <div className="order-meta-grid">
                  <span>{cancelled ? '취소 수량' : '수량'} {order.selectedCount ?? order.quantity ?? 1}개</span>
                  <span>{cancelled ? '취소 전 ' : ''}{formatWon(order.total ?? discountedPrice(deal?.originalPrice, deal?.discountRate))}</span>
                  <span>{order.time || order.deadline || deal?.deadline}</span>
                </div>
                {syncIssue ? (
                  <div className={`customer-payment-state sync-${syncIssue.state === 'failed' ? 'failed' : 'pending'}`}>
                    <strong>{syncIssue.state === 'failed' ? '주문 서버 반영 확인 필요' : '주문 서버 반영 중'}</strong>
                    <span>{syncIssue.state === 'failed'
                      ? '자동 전송이 완료되지 않았습니다. 새로고침 후에도 계속 보이면 운영자에게 알려 주세요.'
                      : '참여 수량은 예약되었으며 연결이 복구되면 주문 정보가 자동으로 전송됩니다.'}</span>
                  </div>
                ) : null}
                {paymentNeedsRepair && (
                  <div className="customer-payment-state sync-failed" role="status">
                    <strong>과거 주문 연결 확인 필요 · 관리자 점검 요청</strong>
                    <span>이 주문과 참여 기록의 연결을 확인하지 못했습니다. 실제 입금 여부를 이 표시만으로 판단하지 말고 관리자에게 확인을 요청해 주세요.</span>
                  </div>
                )}
                {tracksPayment && !paymentNeedsRepair && cancelled ? (
                  <div className="customer-payment-state cancelled">
                    <strong>참여 취소 완료</strong>
                    <span>선택했던 수량이 공동구매의 남은 수량에 다시 반영되었습니다.</span>
                  </div>
                ) : tracksPayment && !paymentNeedsRepair && paymentHistoryUnconfirmed ? (
                  <div className={`customer-payment-state sync-${historyStatus === 'error' ? 'failed' : 'pending'}`} role="status">
                    <strong>{historyStatus === 'error' ? '입금 상태 확인 필요' : '입금 상태 확인 중'}</strong>
                    <span>마지막 확인 상태: {paymentStatusLabel}. {historyStatus === 'error'
                      ? '최신 상태를 확인하지 못했습니다. 위의 “주문 이력 다시 불러오기”를 눌러 주세요.'
                      : '최신 주문 상태를 불러오고 있습니다.'}</span>
                  </div>
                ) : tracksPayment && !paymentNeedsRepair && (
                  <div className={`customer-payment-state ${paymentStatus}`}>
                    <strong>{paymentStatusLabel}</strong>
                    <span>{paymentStatus === 'confirmed'
                      ? '사장님이 입금 완료 상태를 반영했습니다.'
                      : paymentStatus === 'requested'
                        ? '사장님이 실제 입금을 확인하면 완료 상태로 바뀝니다.'
                        : order.groupId
                          ? '입금 후 그룹 채팅에서 “입금했어요”를 눌러 확인을 요청해 주세요.'
                          : '실제 결제 후 사장님이 확인하면 이 화면에 표시됩니다.'}</span>
                  </div>
                )}
                {verificationComplete && (
                  <div className="transaction-verified-label">
                    <Check size={15} />
                    사장님·사용자 양측 픽업 확인 완료
                  </div>
                )}
                {order.customerPickupConfirmedAt && !verificationComplete && (
                  <div className="customer-confirmed-label">사용자 픽업 확인 완료 · 사장님/결제 처리 확인 중</div>
                )}
                {cancelError?.orderId === order.id && (
                  <p className="form-error order-cancel-error" role="alert">{cancelError.message}</p>
                )}
                {pickupError?.orderId === order.id && (
                  <p className="form-error order-cancel-error" role="alert">{pickupError.message}</p>
                )}
                <div className="order-card-actions">
                  <button className="secondary-button compact-button" onClick={() => deal && onSelectDeal(deal)}>
                    상세보기
                  </button>
                  {canOpenRoom && (
                    <button
                      className="secondary-button compact-button room-entry-button"
                      onClick={() => {
                        onSelectDeal(deal);
                        onScreen('room');
                      }}
                    >
                      <MessageCircle size={15} />
                      그룹 채팅
                    </button>
                  )}
                  {canCancel && (
                    <button
                      className="danger-button compact-button"
                      disabled={Boolean(cancellingId)}
                      onClick={() => handleCancellation(order, deal)}
                    >
                      <X size={15} />
                      {cancellingId === order.id ? '취소 반영 중…' : '참여 취소'}
                    </button>
                  )}
                  {canConfirmPickup && (
                    <button
                      className="primary-button compact-button"
                      disabled={Boolean(confirmingPickupId)}
                      onClick={() => handlePickupConfirmation(order)}
                    >
                      <Check size={15} />
                      {confirmingPickupId === order.id ? '픽업 확인 반영 중…' : '픽업 완료 확인'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <BottomNav active="orders" onSelect={onScreen} />
    </section>
  );
}

function FavoritesTab({ favoriteDeals, hostDealIds, unreadCounts = {}, statusNotices = {}, onSelectDeal, onScreen }) {
  useScreenAnalytics('customer_favorites', { favorite_count: favoriteDeals.length });

  return (
    <section className="screen">
      <header className="top-nav">
        <div>
          <p className="eyebrow">찜</p>
          <h1>관심 공동구매</h1>
        </div>
        <Heart size={22} />
      </header>

      {favoriteDeals.length === 0 ? (
        <EmptyCustomerState
          icon={Heart}
          title="찜한 공동구매가 없습니다"
          body="상세 화면의 하트 버튼을 누르면 관심 상품을 다시 볼 수 있습니다."
          actionLabel="홈으로 이동"
          onAction={() => onScreen('list')}
        />
      ) : (
        <div className="deal-list">
          {favoriteDeals.map((deal) => (
            <DealCard
              key={deal.id}
              deal={deal}
              hostMatched={isDealHostMatched(deal, hostDealIds)}
              unreadCount={unreadCounts[deal.id] || 0}
              statusNotice={statusNotices[deal.id] || ''}
              onClick={() => onSelectDeal(deal)}
            />
          ))}
        </div>
      )}

      <BottomNav active="favorites" onSelect={onScreen} />
    </section>
  );
}

function ProfileTab({ profile, orders, favoriteCount, onScreen, onLogout }) {
  useScreenAnalytics('customer_profile');
  const customerNumber = getCustomerNumber();

  return (
    <section className="screen">
      <header className="top-nav">
        <div>
          <p className="eyebrow">마이</p>
          <h1>테스트 프로필</h1>
        </div>
        <User size={22} />
      </header>

      <div className="profile-card">
        <div className="profile-avatar">{profile.name.slice(0, 1)}</div>
        <div>
          <h2>{profile.name}</h2>
          <p>{formatLocation(profile)} · {profile.testerType}</p>
          <p className="customer-number">고객번호 {customerNumber}</p>
        </div>
      </div>

      <div className="insight-strip">
        <div>
          <span>참여</span>
          <strong>{orders.length}</strong>
        </div>
        <div>
          <span>찜</span>
          <strong>{favoriteCount}</strong>
        </div>
        <div>
          <span>동의</span>
          <strong>{profile.consent ? '완료' : '대기'}</strong>
        </div>
      </div>

      <div className="profile-menu">
        <button onClick={() => onScreen('orders')}>
          <ShoppingBag size={18} />
          내 주문 보기
        </button>
        <button onClick={() => onScreen('favorites')}>
          <Heart size={18} />
          찜 목록 보기
        </button>
        <button onClick={() => onScreen('survey')}>
          <MessageCircle size={18} />
          설문 다시 작성
        </button>
        <button onClick={onLogout}>
          <X size={18} />
          로그아웃
        </button>
      </div>

      <BottomNav active="profile" onSelect={onScreen} />
    </section>
  );
}

function EmptyCustomerState({ icon: Icon, title, body, actionLabel, onAction }) {
  return (
    <div className="empty-customer-state">
      <Icon size={34} />
      <h2>{title}</h2>
      <p>{body}</p>
      <button className="secondary-button" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}

function DealDetail({
  deal,
  onBack,
  onScreen,
  isFavorite,
  onToggleFavorite,
  hostMatched,
  onHostApply,
  editable = false,
  canRepairLegacyGroup = false,
  onUpdateDeal,
  onUpdateTarget,
  onDeleteDeal,
  adminMode = false,
  readOnly = false,
  unreadCount = 0,
  onOpenRoom,
}) {
  useScreenAnalytics('deal_detail', { deal_id: deal.id, category: deal.category });
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [hostApplying, setHostApplying] = useState(false);
  const [hostApplyError, setHostApplyError] = useState('');
  const [editForm, setEditForm] = useState({
    title: deal.title,
    description: deal.description || '',
    address: deal.address || '',
    deadline: deal.deadline || '',
    price: String(deal.source === 'customer' ? deal.originalPrice : getDealPrice(deal)),
    target: String(deal.targetCount || deal.targetPeople || deal.target || 1),
  });
  const isCustomerGroup = deal.source === 'customer';
  const isInstant = deal.saleType === 'instant';
  const isSplitMerchant = isSplitMerchantDeal(deal);
  const isMerchantGroup = deal.source === 'merchant' && deal.saleType === 'group';
  const isGroupDeal = isCustomerGroup || isMerchantGroup;
  const writeBlocked = adminMode || readOnly;
  const dealQuantity = getDealQuantity(deal);
  const split = isCustomerGroup
    ? calculateSplit(
      Math.max(0, Math.floor(Number(deal.originalPrice || 0))),
      Math.max(1, Math.min(20, Number(deal.targetPeople || deal.target || 1))),
      Math.max(0, Math.min(20, Number(deal.currentPeople ?? deal.current ?? 0))),
    )
    : null;
  const currentParticipantCount = isCustomerGroup
    ? Math.max(1, Number(deal.currentCount ?? deal.currentPeople ?? deal.current ?? 1) || 1)
    : 0;
  const parsedEditTarget = Number(editForm.target);
  const targetInputInvalid = isCustomerGroup && (
    !Number.isInteger(parsedEditTarget)
    || parsedEditTarget < currentParticipantCount
    || parsedEditTarget > 20
  );
  const targetUpdateLocked = isCustomerGroup
    && ['purchased', 'delivered'].includes(deal.groupStatus || deal.status || 'recruiting');
  const productSplit = isCustomerGroup
    ? calculateProductAllocation(
      Math.max(0, Math.floor(Number(deal.originalPrice || 0))),
      dealQuantity.target,
      Math.min(1, dealQuantity.target),
    )
    : null;
  const expectedPerPerson = isCustomerGroup
    ? Number(deal.unitPrice ?? deal.expectedPerPerson ?? deal.menu?.[0]?.price ?? productSplit.unitPrice)
    : getDealPrice(deal);
  const customerHostRecruiting = isCustomerGroup && deal.hostMode === 'recruiting';
  const recruitmentOpen = isDealRecruiting(deal);
  const merchantPurchaseClosed = dealQuantity.remaining <= 0
    || (isMerchantGroup && !recruitmentOpen);
  const existingGroupCredential = isGroupDeal
    ? getGroupCredential(deal.id, getVisitorId())
    : null;
  const canOpenGroupRoom = customerCanOpenGroupRoom({
    adminMode,
    readOnly,
    credential: existingGroupCredential,
    localCreator: isCustomerGroup && canRepairLegacyGroup,
  });
  const showMerchantRoom = isMerchantGroup && canOpenGroupRoom;
  const newParticipantCapacityReached = isCustomerGroup
    && !existingGroupCredential
    && split.current >= split.people;
  const canHostApply = !writeBlocked && !hostMatched && (
    (customerHostRecruiting && recruitmentOpen)
    || (isMerchantGroup && recruitmentOpen
      && (deal.methods || []).some((method) => ['그룹배달', '픽업'].includes(method)))
  );

  const handleHostApply = async () => {
    if (!canHostApply || hostApplying) return;
    setHostApplying(true);
    setHostApplyError('');
    try {
      await onHostApply(deal);
    } catch (applyError) {
      setHostApplyError(hostApplyErrorMessage(applyError));
    } finally {
      setHostApplying(false);
    }
  };

  const handleEditSave = async () => {
    if (editSaving || !editForm.title.trim() || Number(editForm.price) <= 0 || targetInputInvalid) return;
    setEditSaving(true);
    setEditError('');
    try {
      const price = Number(editForm.price);
      const previousTarget = Number(deal.targetCount || deal.targetPeople || deal.target || 1);
      const targetChanged = isCustomerGroup && parsedEditTarget !== previousTarget;
      if (targetChanged && targetUpdateLocked) throw new Error('target_locked');
      const centralGroupFields = isCustomerGroup
        ? await onUpdateTarget?.(deal, parsedEditTarget, {
          mutate: targetChanged,
          expectedVersion: Number(deal.version || 0) || undefined,
        })
        : {};
      if (isCustomerGroup && !centralGroupFields) throw new Error('group_update_failed');
      const target = Number(centralGroupFields?.target || parsedEditTarget || previousTarget);
      const editedAllocation = isCustomerGroup
        ? calculateProductAllocation(
          Math.floor(price),
          Math.max(1, Number(deal.totalQuantity || deal.productQuantity || target)),
          1,
        )
        : null;
      await onUpdateDeal({
        ...deal,
        title: editForm.title.trim(),
        description: editForm.description.trim(),
        address: editForm.address.trim(),
        deadline: editForm.deadline.trim(),
        originalPrice: price,
        target,
        targetPeople: isCustomerGroup ? target : deal.targetPeople,
        targetCount: isCustomerGroup ? target : deal.targetCount,
        expectedPerPerson: editedAllocation?.unitPrice ?? deal.expectedPerPerson,
        unitPrice: editedAllocation?.unitPrice ?? deal.unitPrice,
        unitRemainder: editedAllocation?.remainder ?? deal.unitRemainder,
        splitRemainder: editedAllocation?.remainder ?? deal.splitRemainder,
        approximatePrice: editedAllocation?.approximate ?? deal.approximatePrice,
        discountRate: 0,
        menu: (deal.menu || []).map((item, index) => (
          index === 0
            ? { ...item, name: editForm.title.trim(), price: editedAllocation?.unitPrice ?? price }
            : item
        )),
        ...centralGroupFields,
        updatedAt: centralGroupFields?.updatedAt || new Date().toISOString(),
      });
      if (targetChanged) {
        track('group_target_changed', {
          group_id: deal.id,
          target_count: target,
          source: 'detail_edit',
        });
      }
      setEditing(false);
    } catch (error) {
      setEditError(
        error?.message === 'state_conflict'
          ? '다른 사용자의 변경이 먼저 반영되었습니다. 최신 화면을 확인한 뒤 다시 시도해 주세요.'
          : error?.message === 'target_locked'
            ? '상품 구매 완료 이후에는 목표 인원을 변경할 수 없습니다.'
            : ['invalid_target', 'target_below_current'].includes(error?.message)
              ? `목표 인원은 현재 참여자 ${currentParticipantCount}명 이상, 최대 20명으로 설정해 주세요.`
              : '수정 내용을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      );
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!SCOPED_UI_ACTIONS.productDeletion || deleting || editSaving) return;
    if (!window.confirm('이 상품을 전체 공개 목록에서 삭제할까요?')) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const deleted = await onDeleteDeal(deal);
      if (!shouldNavigateAfterDealDelete(deleted)) {
        setDeleteError('상품을 삭제하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.');
      }
    } catch (error) {
      setDeleteError(dealDeleteErrorMessage(error, '네트워크 상태'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="screen detail-screen">
      <header className="top-nav compact">
        <button className="icon-button" onClick={onBack} aria-label="뒤로">
          <ArrowLeft size={22} />
        </button>
        <h1>공동구매 상세</h1>
        <div className="inline-actions">
          {RELEASE_FEATURES.sharing && (
            <button className="icon-button" onClick={() => setSharing(true)} aria-label="공유">
              <Share2 size={20} />
            </button>
          )}
          {!writeBlocked && (
            <button
              className={isFavorite ? 'icon-button liked' : 'icon-button'}
              onClick={() => {
                onToggleFavorite(deal);
              }}
              aria-label={isFavorite ? '좋아요 취소' : '좋아요'}
              aria-pressed={isFavorite}
            >
              <Heart size={20} />
            </button>
          )}
        </div>
      </header>

      {readOnly && <CustomerPreviewNotice />}

      <img
        className="hero-image"
        src={deal.image || fallbackImage}
        alt={`${deal.title} 상품 이미지`}
        onError={replaceBrokenImage}
      />

      {customerHostRecruiting && (
        <div className={hostMatched ? 'host-apply-box matched' : 'host-apply-box recruiting'}>
          <div>
            <strong>{hostMatched
              ? '호스트 모집 완료'
              : recruitmentOpen ? '구매·픽업 호스트 모집 중' : '호스트 모집 종료'}</strong>
            <p>{hostMatched
              ? '구매와 픽업을 맡을 참여자가 확정되었습니다.'
              : recruitmentOpen
                ? '이 그룹은 생성자와 별도로 상품 구매·픽업을 맡을 호스트를 찾고 있습니다.'
                : '거래 모집이 종료되어 더 이상 호스트 지원을 받지 않습니다.'}</p>
          </div>
          {!adminMode && (
            <button
              className={hostMatched ? 'secondary-button compact-button' : 'primary-button compact-button'}
              onClick={handleHostApply}
              disabled={hostMatched || hostApplying || !canHostApply}
            >
              <Users size={16} />
              {hostMatched ? '확정됨' : !recruitmentOpen ? '모집 종료' : hostApplying ? '지원 중…' : '호스트 지원하기'}
            </button>
          )}
          {!adminMode && hostApplyError && <p className="form-error host-apply-error" role="alert" aria-live="assertive">{hostApplyError}</p>}
        </div>
      )}

      <div className="content-block">
        <div className="detail-badge-row">
          <span className={isCustomerGroup ? 'type-badge customer' : 'type-badge merchant'}>
            {isCustomerGroup ? <User size={12} /> : <Store size={12} />}
            {isCustomerGroup ? '사용자 공동구매 그룹' : isInstant ? '선착순 즉시할인 상품' : '사장님 공동구매'}
          </span>
          {hostMatched && <span className="type-badge host">{isCustomerGroup && deal.hostMode !== 'recruiting' ? '생성자가 호스트' : '호스트 모집 완료'}</span>}
          {isCustomerGroup && deal.hostMode === 'recruiting' && !hostMatched && (
            <span className="type-badge host recruiting">호스트 모집 중</span>
          )}
        </div>
        <p className="deadline-line">
          <Clock size={15} />
          {isInstant && deal.eventStart ? `오늘 ${deal.eventStart} ~ ${deal.eventEnd} 선착순 즉시할인` : `${deal.deadline} 마감`}
        </p>
        <h2>{deal.store}</h2>
        <p className="body-copy">{deal.description}</p>
        <p className="muted-line">
          <MapPin size={14} />
          {deal.address}
        </p>
      </div>

      <div className="content-block">
        <Progress deal={deal} />
        {isCustomerGroup ? (
          <div className="group-price-comparison">
            <div><span>혼자 구매 시</span><del>{formatWon(deal.originalPrice)}</del></div>
            <div><span>제품 1개당 예상금액</span><strong>{deal.approximatePrice || productSplit.approximate ? '약 ' : ''}{formatWon(expectedPerPerson)}</strong></div>
            <div>
              <span>상품 수량</span>
              <strong>{recruitmentOpen
                ? `배정 ${dealQuantity.ordered}개 · 남은 ${dealQuantity.remaining}개`
                : `모집 종료 · 배정 ${dealQuantity.ordered}개 / 총 ${dealQuantity.target}개`}</strong>
            </div>
            <p>{recruitmentOpen
              ? `목표 ${split.people}명 / 현재 ${split.current}명 / 추가 모집 ${split.remaining}명`
              : `모집 종료 · 참여 ${split.current}명 / 목표 ${split.people}명`}</p>
            <p>{recruitmentOpen
              ? `총 ${dealQuantity.target}개 중 원하는 수량을 선택해 참여할 수 있습니다.`
              : `모집 종료 시점 배정 ${dealQuantity.ordered}개 · 미배정 ${dealQuantity.remaining}개`}</p>
            <p>1인 구매 부담액 <b>{formatWon(Math.max(0, Number(deal.originalPrice || 0) - expectedPerPerson))} 감소</b></p>
            {productSplit.remainder > 0 && <p>나머지 {formatWon(productSplit.remainder)}은 호스트가 부담해 총액을 정확히 맞춥니다.</p>}
          </div>
        ) : isMerchantGroup ? (
          <div className="detail-price-grid split-merchant-price-grid">
            <span>정상가</span>
            <del>{formatWon(deal.originalPrice)}</del>
            <span>{isSplitMerchant ? '할인 후 상품가격' : '할인 후 1개 가격'}</span>
            <strong>{formatWon(discountedPrice(deal.originalPrice, deal.discountRate))}</strong>
            {isSplitMerchant && (
              <>
                <span>분할 1개당 예상금액</span>
                <strong>{deal.approximatePrice ? '약 ' : ''}{formatWon(getDealPrice(deal))}</strong>
              </>
            )}
            <span>가격 분할수량</span>
            <strong>{getMerchantSplitQuantity(deal)}개</strong>
            <span>공구 총수량</span>
            <strong>{dealQuantity.target}개</strong>
          </div>
        ) : (
          <div className="detail-price-grid">
            <span>정상가</span>
            <del>{formatWon(deal.originalPrice)}</del>
            <span>{isInstant ? '선착순 할인가' : '공동구매가'}</span>
            <strong>{formatWon(getDealPrice(deal))}</strong>
          </div>
        )}
      </div>

      {editable && !writeBlocked && (
        <div className="content-block deal-management">
          <div className="deal-management-heading">
            <div>
              <strong>내가 등록한 상품</strong>
              <p>이 기기에서 등록한 상품만 수정할 수 있습니다.</p>
            </div>
            <button
              className="secondary-button compact-button"
              disabled={editSaving || deleting}
              onClick={() => {
                setEditing((value) => !value);
                setEditError('');
              }}
            >
              <Pencil size={15} />
              {editing ? '취소' : '수정'}
            </button>
          </div>
          {editing && (
            <div className="form-stack compact-form">
              <label>
                제목
                <input disabled={editSaving} value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} />
              </label>
              <label>
                설명
                <textarea disabled={editSaving} value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} />
              </label>
              <label>
                수령 위치
                <input disabled={editSaving} value={editForm.address} onChange={(event) => setEditForm({ ...editForm, address: event.target.value })} />
              </label>
              <label>
                마감 시간
                <input disabled={editSaving} value={editForm.deadline} onChange={(event) => setEditForm({ ...editForm, deadline: event.target.value })} />
              </label>
              <label>
                {isCustomerGroup ? '상품 판매가(총액)' : '판매가'}
                <input disabled={editSaving} type="number" min="0" value={editForm.price} onChange={(event) => setEditForm({ ...editForm, price: event.target.value })} />
              </label>
              {isCustomerGroup && (
                <>
                  <label>
                    목표 인원
                    <input
                      type="number"
                      inputMode="numeric"
                      min={currentParticipantCount}
                      max="20"
                      step="1"
                      value={editForm.target}
                      disabled={editSaving || targetUpdateLocked}
                      onChange={(event) => setEditForm({ ...editForm, target: event.target.value })}
                    />
                  </label>
                  <p className={targetInputInvalid ? 'evidence-note form-error' : 'evidence-note'}>
                    {targetUpdateLocked
                      ? '상품 구매 완료 이후에는 목표 인원을 변경할 수 없습니다.'
                      : `현재 참여자 ${currentParticipantCount}명 이상, 최대 20명까지 변경할 수 있습니다.`}
                  </p>
                </>
              )}
              {editError && <p className="form-error" role="alert">{editError}</p>}
              <button
                className="primary-button"
                disabled={
                  editSaving
                  || !editForm.title.trim()
                  || Number(editForm.price) <= 0
                  || targetInputInvalid
                }
                onClick={handleEditSave}
              >
                <Check size={16} />
                {editSaving ? '저장 중…' : '수정 내용 저장'}
              </button>
            </div>
          )}
          {SCOPED_UI_ACTIONS.productDeletion && (
            <button
              className="danger-button"
              disabled={editSaving || deleting}
              onClick={handleDelete}
            >
              <Trash2 size={16} />
              {deleting ? '삭제 중…' : '상품 삭제'}
            </button>
          )}
          {deleteError && <p className="form-error" role="alert" aria-live="assertive">{deleteError}</p>}
        </div>
      )}

      {canHostApply && !customerHostRecruiting && (
        <div className="host-apply-box">
          <div>
            <strong>{hostMatched ? '호스트 매칭 완료' : '호스트 지원 가능'}</strong>
            <p>{hostMatched ? '참여자 중 호스트가 확정된 상태로 표시됩니다.' : '픽업 또는 그룹배달을 맡을 참여자를 모집합니다.'}</p>
          </div>
          <button
            className={hostMatched ? 'secondary-button compact-button' : 'primary-button compact-button'}
            onClick={handleHostApply}
            disabled={hostMatched || hostApplying}
          >
            <Users size={16} />
            {hostMatched ? '확정됨' : hostApplying ? '지원 중…' : '지원하기'}
          </button>
          {hostApplyError && <p className="form-error host-apply-error" role="alert" aria-live="assertive">{hostApplyError}</p>}
        </div>
      )}

      <div className="menu-preview">
        {deal.menu.map((item) => (
          <div key={item.id} className="menu-line">
            <span>{item.name}</span>
            <strong>{formatWon(item.price)}</strong>
          </div>
        ))}
      </div>

      {isMerchantGroup && (
        <p className="evidence-note merchant-direct-group-note">
          사장님 상품 등록과 동시에 이 공동구매가 생성되어, 별도 그룹방을 다시 만들지 않고 바로 참여할 수 있습니다.
        </p>
      )}

      <div className={isMerchantGroup && !showMerchantRoom ? 'sticky-actions single' : 'sticky-actions'}>
        {isCustomerGroup ? (
          <>
            {canOpenGroupRoom && <button className="secondary-button room-entry-button" onClick={onOpenRoom}>
              {RELEASE_FEATURES.chat ? <MessageCircle size={18} /> : <Check size={18} />}
              {RELEASE_FEATURES.chat ? `그룹 채팅${unreadCount > 0 ? ` · ${Math.min(99, unreadCount)}` : ''}` : '거래 상태 관리'}
            </button>}
            {!writeBlocked && (
              <button
                className="primary-button"
                disabled={!recruitmentOpen || dealQuantity.remaining <= 0 || newParticipantCapacityReached}
                onClick={() => {
                  onScreen('join');
                  track('join_started', { deal_id: deal.id });
                }}
              >
                <ShoppingBag size={18} /> {!recruitmentOpen || dealQuantity.remaining <= 0
                  ? '모집 종료'
                  : newParticipantCapacityReached ? '인원 마감' : '참여하기'}
              </button>
            )}
          </>
        ) : (
          <>
            {showMerchantRoom && (
              <button className="secondary-button room-entry-button" onClick={onOpenRoom}>
                {RELEASE_FEATURES.chat ? <MessageCircle size={18} /> : <Check size={18} />}
                {RELEASE_FEATURES.chat ? `그룹 채팅${unreadCount > 0 ? ` · ${Math.min(99, unreadCount)}` : ''}` : '거래 상태 관리'}
              </button>
            )}
            {!writeBlocked && !isMerchantGroup && (
              <button
                className="secondary-button"
                onClick={() => {
                  onScreen('group');
                  track('group_create_started', { deal_id: deal.id });
                }}
              >
                <Users size={18} /> 그룹방 만들기
              </button>
            )}
            {!writeBlocked && (
              <button
                className="primary-button"
                disabled={merchantPurchaseClosed}
                onClick={() => {
                  onScreen('join');
                  track(isInstant ? 'instant_checkout_started' : 'join_started', { deal_id: deal.id });
                }}
              >
                <ShoppingBag size={18} />
                {merchantPurchaseClosed
                  ? isInstant ? '재고 소진' : '모집 종료'
                  : isInstant ? '선착순 할인 받기' : '참여하기'}
              </button>
            )}
          </>
        )}
      </div>

      {RELEASE_FEATURES.sharing && sharing && <ShareSheet deal={deal} onClose={() => setSharing(false)} />}
    </section>
  );
}

function ShareSheet({ deal, onClose }) {
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState('');
  const channels = [
    { id: 'native', label: '카카오·SNS', icon: Share2 },
    { id: 'message', label: '문자', icon: Send },
    { id: 'copy', label: '링크 복사', icon: LinkIcon },
  ];
  const shareUrl = `${window.location.origin}/customer?group=${encodeURIComponent(deal.id)}&view=detail`;
  const shareText = `${deal.title} · 목표 ${deal.target || 1}명 공동구매에 함께해요`;

  const copyLink = async () => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        return true;
      } catch {
        // Fall through to the selection-based copy path.
      }
    }
    const input = document.createElement('textarea');
    try {
      input.value = shareUrl;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      input.remove();
    }
  };

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="share-sheet-title">
      <div className="bottom-sheet">
        <div className="sheet-header">
          <h2 id="share-sheet-title">공동구매 링크 공유</h2>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            <X size={20} />
          </button>
        </div>
        <div className="share-summary">
          <img
            src={deal.image || fallbackImage}
            alt={`${deal.title} 상품 이미지`}
            onError={replaceBrokenImage}
          />
          <div>
            <strong>{deal.title}</strong>
            <p>{deal.store}</p>
          </div>
        </div>
        <div className="share-grid">
          {channels.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              disabled={shareBusy}
              onClick={async () => {
                if (shareBusy) return;
                setShareBusy(true);
                setShareError('');
                try {
                  let completed = true;
                  if (id === 'native') {
                    if (navigator.share) {
                      try {
                        await navigator.share({ title: deal.title, text: shareText, url: shareUrl });
                      } catch (error) {
                        if (error?.name === 'AbortError') return;
                        completed = await copyLink();
                      }
                    } else {
                      completed = await copyLink();
                    }
                  }
                  if (id === 'copy') completed = await copyLink();
                  if (!completed) {
                    setShareError('링크를 복사하지 못했습니다. 브라우저 권한을 확인한 뒤 다시 시도해 주세요.');
                    return;
                  }
                  track('share_clicked', { channel: id, deal_id: deal.id });
                  track('group_shared', { channel: id, group_id: deal.id, deep_link: true });
                  if (id === 'message') {
                    window.location.href = `sms:?&body=${encodeURIComponent(`${shareText}\n${shareUrl}`)}`;
                  }
                  onClose();
                } catch {
                  setShareError('공유를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
                } finally {
                  setShareBusy(false);
                }
              }}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </div>
        {shareError && <p className="form-error" role="alert" aria-live="assertive">{shareError}</p>}
      </div>
    </div>
  );
}

function JoinFlow({
  deal,
  orders = [],
  onBack,
  onScreen,
  onOrderCreate,
  onHostApply,
  onCompletionMessage,
}) {
  useScreenAnalytics('join_flow', { deal_id: deal.id });
  const { target, remaining } = getDealQuantity(deal);
  const initialQuantities = useMemo(
    () => Object.fromEntries(deal.menu.map((item, index) => [item.id, index === 0 && remaining > 0 ? 1 : 0])),
    [deal.id, remaining],
  );
  const receiptMethods = deal.methods?.length ? deal.methods : ['픽업', '배달', '그룹배달', '택배'];
  const [quantities, setQuantities] = useState(initialQuantities);
  const [method, setMethod] = useState(receiptMethods[0]);
  const [time, setTime] = useState('오늘 20:30');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [applyAsHost, setApplyAsHost] = useState(false);
  const reservationMutationIdRef = useRef(createMutationId('checkout_quantity'));
  const isInstant = deal.saleType === 'instant';
  const isCustomerGroup = deal.source === 'customer';
  const recruitmentOpen = isDealRecruiting(deal);
  const hostApplicationAvailable = Boolean(
    isGroupBackedDeal(deal)
    && deal.hostMode === 'recruiting'
    && !deal.hostActorId
    && recruitmentOpen
    && (deal.source === 'customer'
      || (deal.methods || []).some((item) => ['픽업', '그룹배달'].includes(item))),
  );

  const selectedCount = Object.values(quantities).reduce((sum, value) => sum + value, 0);
  const checkoutAvailable = canSubmitDealOrder({
    deal,
    selectedCount,
    remaining,
    submitting,
  });
  const baseTotal = deal.menu.reduce((sum, item) => sum + item.price * quantities[item.id], 0);
  const isCurrentHost = isGroupBackedDeal(deal) && deal.hostActorId === getVisitorId();
  const hostRemainderAlreadyApplied = isCurrentHost && (
    (deal.hostMode !== 'recruiting' && deal.creatorActorId === getVisitorId())
    || orders.some((order) => (
      order.dealId === deal.id
      && order.visitorId === getVisitorId()
      && !isCancelledOrder(order)
      && Number(order.hostRemainderApplied || 0) > 0
    ))
  );
  const hostRemainder = isCurrentHost && selectedCount > 0 && !hostRemainderAlreadyApplied
    ? Number(deal.unitRemainder ?? deal.splitRemainder ?? 0)
    : 0;
  const total = baseTotal + hostRemainder;

  const changeQuantity = (id, delta) => {
    const otherSelected = Object.entries(quantities)
      .filter(([menuId]) => menuId !== id)
      .reduce((sum, [, value]) => sum + value, 0);
    const next = clamp(
      (quantities[id] || 0) + delta,
      0,
      Math.max(0, remaining - otherSelected),
    );
    setQuantities({ ...quantities, [id]: next });
    reservationMutationIdRef.current = createMutationId('checkout_quantity');
    track('quantity_changed', { deal_id: deal.id, menu_id: id, quantity: next });
  };

  return (
    <section className="screen join-flow-screen">
      <header className="top-nav compact">
        <button className="icon-button" onClick={onBack} aria-label="뒤로">
          <ArrowLeft size={22} />
        </button>
        <h1>메뉴 선택</h1>
        <span />
      </header>

      <div className="menu-select-list">
        {deal.menu.map((item) => (
          <div className="menu-select-row" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <p>{item.option}</p>
              <span>{formatWon(item.price)}</span>
            </div>
            <Counter label={item.name} value={quantities[item.id]} onMinus={() => changeQuantity(item.id, -1)} onPlus={() => changeQuantity(item.id, 1)} />
          </div>
        ))}
      </div>

      <div className="quantity-status-panel">
        <span>총 수량 {target}개</span>
        <strong>{!recruitmentOpen
          ? `모집 종료 · 배정 ${target - remaining}개`
          : `남은 수량 ${remaining}개`}</strong>
      </div>

      <div className="content-block">
        <h2>수령 방식</h2>
        <div className="segmented-control">
          {receiptMethods.map((item) => (
            <button
              type="button"
              key={item}
              className={method === item ? 'segment active' : 'segment'}
              onClick={() => {
                setMethod(item);
                track('method_selected', { deal_id: deal.id, method: item });
              }}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="form-stack compact-form">
        <label>
          수령 시간
          <select value={time} onChange={(event) => setTime(event.target.value)}>
            <option>오늘 20:00</option>
            <option>오늘 20:30</option>
            <option>오늘 21:00</option>
          </select>
        </label>
        <label>
          요청사항
          <input maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} placeholder="매장에 전달할 내용" />
        </label>
      </div>

      <div className="join-review">
        <div className="order-summary">
          <div>
            <span>선택 수량</span>
            <strong>{selectedCount}개</strong>
          </div>
          <div>
            <span>주문 금액</span>
            <strong>{formatWon(total)}</strong>
          </div>
          {hostRemainder > 0 && (
            <small>호스트 나머지 부담액 {formatWon(hostRemainder)} 포함</small>
          )}
        </div>
      </div>

      {hostApplicationAvailable && (
        <label className="host-apply-check">
          <input
            type="checkbox"
            checked={applyAsHost}
            disabled={submitting}
            onChange={(event) => setApplyAsHost(event.target.checked)}
          />
          <span>
            <strong>주문과 함께 호스트 지원</strong>
            <small>참여 완료 후 별도로 다시 누르지 않아도 호스트 지원까지 이어집니다.</small>
          </span>
        </label>
      )}

      <div className={submitError ? 'sticky-actions single has-message' : 'sticky-actions single'}>
        {submitError && (
          <p className="form-error join-submit-error sticky-action-message" role="alert" aria-live="assertive">
            {submitError}
          </p>
        )}
        <button
          className="primary-button"
          disabled={!checkoutAvailable}
          onClick={async () => {
            if (!checkoutAvailable) return;
            setSubmitting(true);
            setSubmitError('');
            onCompletionMessage?.('');
            track('checkout_started', { deal_id: deal.id, total, method, time });
            try {
              await onOrderCreate({
                type: 'purchase',
                dealId: deal.id,
                groupId: isGroupBackedDeal(deal) ? (deal.groupId || deal.id) : '',
                deal,
                title: deal.title,
                store: deal.store,
                total,
                method,
                time,
                note,
                selectedCount,
                hostRemainderApplied: hostRemainder,
                clientMutationId: reservationMutationIdRef.current,
              });
              if (applyAsHost && hostApplicationAvailable) {
                try {
                  await onHostApply?.(deal);
                  onCompletionMessage?.('주문 참여와 호스트 지원이 함께 완료되었습니다.');
                  track('checkout_host_apply_completed', { deal_id: deal.id });
                } catch (hostError) {
                  onCompletionMessage?.(
                    `주문 참여는 완료되었습니다. 호스트 지원만 반영되지 않아 상품 상세에서 다시 지원해 주세요. (${hostApplyErrorMessage(hostError)})`,
                  );
                  track('checkout_host_apply_failed', {
                    deal_id: deal.id,
                    error_code: hostError?.code || hostError?.message || 'host_apply_failed',
                  });
                }
              }
              track('purchase_completed', { deal_id: deal.id, total, method, time, note, selected_count: selectedCount });
              onScreen('complete');
            } catch (orderError) {
              if (orderError?.reservationRolledBack) {
                reservationMutationIdRef.current = createMutationId('checkout_quantity');
              }
              setSubmitError(joinSubmitErrorMessage(orderError));
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Check size={18} />
          {submitting
            ? '처리 중…'
            : !recruitmentOpen && isGroupBackedDeal(deal)
              ? '모집 종료'
              : isInstant ? '구매 신청 완료' : '참여 완료하기'}
        </button>
      </div>
    </section>
  );
}

function GroupCreator({ deal, onBack, onScreen, onOrderCreate, onGroupCreate }) {
  useScreenAnalytics('group_creator', { deal_id: deal.id });
  const isStandaloneGroup = Boolean(deal.isNewGroup);
  const draftGroupIdRef = useRef(`customer-${globalThis.crypto?.randomUUID?.() || Date.now()}`);
  const [form, setForm] = useState({
    title: isStandaloneGroup ? '' : deal.source === 'customer' ? deal.title : `${deal.title} 같이 구매해요`,
    category: normalizeCategory(deal.category || '음식·간편식'),
    description: isStandaloneGroup ? '' : deal.description || '',
    image: '',
    minPeople: 2,
    maxPeople: Math.min(20, Number(deal.simulation?.people || deal.target || 5)),
    quantity: Math.min(20, Math.max(1, Number(deal.simulation?.people || deal.target || 5))),
    totalQuantity: Math.min(999, Math.max(1, Number(
      deal.simulation?.totalQuantity
      || deal.simulation?.productQuantity
      || deal.totalQuantity
      || deal.target
      || 5,
    ))),
    creatorQuantity: Math.max(1, Number(
      deal.simulation?.creatorQuantity
      || deal.simulation?.creatorProductQuantity
      || 1,
    )),
    hostMode: deal.hostMode === 'recruiting' ? 'recruiting' : 'self',
    method: '그룹배달',
    totalPrice: String(deal.simulation?.total || (isStandaloneGroup ? '' : deal.originalPrice || getDealPrice(deal))),
    deadlineDate: new Date().toISOString().slice(0, 10),
    deadlineTime: '20:00',
    pickupPlace: isStandaloneGroup ? '' : '아파트 정문 앞',
    conditionSave: true,
    conditionFirstCome: false,
    memo: '',
  });
  const [imageProcessing, setImageProcessing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submissionLocked, setSubmissionLocked] = useState(false);
  const submissionAttemptRef = useRef(null);
  const splitPreview = calculateSplit(
    Math.max(0, Math.floor(Number(form.totalPrice || 0))),
    Math.max(1, Math.min(20, Number(form.quantity || 1))),
    1,
  );
  const productPreview = calculateProductAllocation(
    Math.max(0, Math.floor(Number(form.totalPrice || 0))),
    Math.max(1, Math.min(999, Number(form.totalQuantity || 1))),
    Math.max(1, Math.min(Number(form.totalQuantity || 1), Number(form.creatorQuantity || 1))),
  );

  const resetSubmissionAttempt = useCallback((expectedGroupId = '') => {
    const currentGroupId = submissionAttemptRef.current?.draft?.groupId || '';
    if (expectedGroupId && currentGroupId && expectedGroupId !== currentGroupId) return false;
    submissionAttemptRef.current = null;
    draftGroupIdRef.current = `customer-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
    setSubmissionLocked(false);
    return true;
  }, []);

  useEffect(() => {
    const handleCompensation = (event) => {
      const compensatedGroupId = String(event?.detail?.groupId || '');
      if (!compensatedGroupId
        || submissionAttemptRef.current?.draft?.groupId !== compensatedGroupId) return;
      resetSubmissionAttempt(compensatedGroupId);
      setSubmitError('그룹방을 생성하지 못했습니다. 주문 저장이 거절되어 생성 내용을 안전하게 되돌렸습니다. 다시 누르면 새 그룹으로 생성합니다.');
    };
    window.addEventListener('o2o-group-creation-compensated', handleCompensation);
    return () => window.removeEventListener('o2o-group-creation-compensated', handleCompensation);
  }, [resetSubmissionAttempt]);

  const updateNumber = (key, delta, min, max) => {
    setForm((current) => {
      const nextValue = clamp(current[key] + delta, min, max);
      if (key === 'quantity') {
        return {
          ...current,
          quantity: nextValue,
        };
      }
      if (key === 'totalQuantity') {
        return {
          ...current,
          totalQuantity: nextValue,
          creatorQuantity: Math.min(current.creatorQuantity, nextValue),
        };
      }
      return { ...current, [key]: nextValue };
    });
  };

  return (
    <section className="screen group-creator-screen">
      <header className="top-nav compact">
        <button className="icon-button" onClick={onBack} aria-label="뒤로">
          <ArrowLeft size={22} />
        </button>
        <h1>공동구매 그룹 생성</h1>
        <Heart size={19} />
      </header>

      <fieldset
        disabled={submissionLocked}
        aria-label="공동구매 그룹 입력"
        style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
      >

      {!isStandaloneGroup && (
        <div className="content-block">
          <h2>참고 상품</h2>
          <div className="selected-store">
            <img
              src={deal.image || fallbackImage}
              alt={`${deal.title} 상품 이미지`}
              onError={replaceBrokenImage}
            />
            <div>
              <strong>{deal.store}</strong>
              <p>{deal.address}</p>
            </div>
          </div>
        </div>
      )}

      <ImageCropUploader
        className="group-image-uploader"
        value={form.image || deal.image}
        alt="등록할 공동구매 이미지 미리보기"
        buttonLabel="그룹 이미지 변경"
        maxSize={900}
        onBusyChange={setImageProcessing}
        onChange={(image) => setForm((current) => ({ ...current, image }))}
        onUploaded={(file) => track('group_image_uploaded', {
          file_type: file.type,
          size: file.size,
          crop_editor: true,
        })}
      />

      <div className="form-stack compact-form">
        <label>
          그룹 제목
          <input maxLength={80} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        </label>
        <label>
          카테고리
          <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
            {PRODUCT_CATEGORIES.map((category) => <option key={category}>{category}</option>)}
          </select>
        </label>
        <label>
          간단 설명
          <textarea
            maxLength={500}
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            placeholder="예: 배달비 아끼실 분 같이 주문해요"
          />
        </label>
      </div>

      <div className="creator-grid">
        <FieldCounter label="목표 인원" value={form.quantity} onMinus={() => updateNumber('quantity', -1, 1, 20)} onPlus={() => updateNumber('quantity', 1, 1, 20)} />
        <div className="field-counter fixed-field-counter"><span>현재 인원</span><strong>그룹 생성자 1명</strong></div>
      </div>

      <div className="content-block host-mode-section">
        <h2>구매·픽업 호스트</h2>
        <p>그룹 아이디어만 올리고 실제 구매 담당자를 따로 모집할 수도 있습니다.</p>
        <div className="segmented-control host-mode-control">
          <button
            type="button"
            className={form.hostMode === 'self' ? 'segment active' : 'segment'}
            onClick={() => setForm({ ...form, hostMode: 'self' })}
          >
            호스트로 참여
          </button>
          <button
            type="button"
            className={form.hostMode === 'recruiting' ? 'segment active' : 'segment'}
            onClick={() => setForm({ ...form, hostMode: 'recruiting' })}
          >
            호스트 지원 요청
          </button>
        </div>
        <small>{form.hostMode === 'self'
          ? '그룹 생성자가 구매·픽업과 거래 상태 관리를 맡습니다.'
          : '그룹 생성자는 아이디어를 올리고, 다른 참여자가 호스트로 지원할 수 있습니다.'}</small>
      </div>

      <div className="content-block">
        <h2>마감 시간</h2>
        <div className="date-time-row">
          <label>
            <Calendar size={16} />
            <input
              type="date"
              value={form.deadlineDate}
              onChange={(event) => setForm({ ...form, deadlineDate: event.target.value })}
            />
          </label>
          <label>
            <Clock size={16} />
            <input
              type="time"
              value={form.deadlineTime}
              onChange={(event) => setForm({ ...form, deadlineTime: event.target.value })}
            />
          </label>
        </div>
      </div>

      <div className="form-stack compact-form">
        <label>
          수령 방식
          <select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })}>
            <option>그룹배달</option>
            <option>픽업</option>
            <option>배달</option>
            <option>택배</option>
          </select>
        </label>
        <label>
          상품 판매가(총액)
          <input
            type="number"
            min="0"
            inputMode="numeric"
            value={form.totalPrice}
            onChange={(event) => setForm({ ...form, totalPrice: event.target.value })}
          />
        </label>
        <div className="creator-grid product-allocation-counters">
          <FieldCounter
            label="상품 총수량"
            value={form.totalQuantity}
            onMinus={() => updateNumber('totalQuantity', -1, 1, 999)}
            onPlus={() => updateNumber('totalQuantity', 1, 1, 999)}
          />
          <FieldCounter
            label="내가 가져갈 수량"
            value={form.creatorQuantity}
            onMinus={() => updateNumber('creatorQuantity', -1, 1, form.totalQuantity)}
            onPlus={() => updateNumber('creatorQuantity', 1, 1, form.totalQuantity)}
          />
        </div>
        <div className="group-create-price-preview">
          <span>제품 1개당 예상금액</span>
          <strong>{productPreview.approximate ? '약 ' : ''}{formatWon(productPreview.unitPrice)}</strong>
          <p>내가 {productPreview.selectedQuantity}개 선택 · 약 {formatWon(productPreview.selectedAmount)}</p>
          {productPreview.remainder > 0 && (
            <p>{form.hostMode === 'self'
              ? `호스트 부담액 약 ${formatWon(productPreview.hostSelectedAmount)} · 나머지 ${formatWon(productPreview.remainder)} 포함`
              : `남는 ${formatWon(productPreview.remainder)}은 지원할 호스트가 부담합니다.`}</p>
          )}
          <div className="allocation-inline-summary">
            <span>현재 1명 / 목표 {splitPreview.people}명</span>
            <strong>남은 제품 {productPreview.remainingQuantity}개 / 총 {productPreview.productQuantity}개</strong>
          </div>
          <p>혼자 전체 구매할 때보다 {formatWon(Math.max(0, productPreview.total - productPreview.selectedAmount))} 감소</p>
        </div>
        <label>
          픽업 위치
          <input
            maxLength={200}
            value={form.pickupPlace}
            onChange={(event) => setForm({ ...form, pickupPlace: event.target.value })}
          />
        </label>
        <label>
          기타 조건
          <input maxLength={300} value={form.memo} onChange={(event) => setForm({ ...form, memo: event.target.value })} placeholder="예: 같은 동 주민 우선" />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.conditionSave}
            onChange={(event) => setForm({ ...form, conditionSave: event.target.checked })}
          />
          공동구매 성사 시 할인 적용
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.conditionFirstCome}
            onChange={(event) => setForm({ ...form, conditionFirstCome: event.target.checked })}
          />
          선착순 마감
        </label>
      </div>

      </fieldset>

      {submitError && <p className="form-error join-submit-error" role="alert">{submitError}</p>}

      <div className="sticky-actions single">
        <button
          className="primary-button"
          onClick={async () => {
            if (submitting) return;
            setSubmitting(true);
            setSubmitError('');
            try {
              if (!submissionAttemptRef.current) {
                const draft = {
                  ...form,
                  groupId: draftGroupIdRef.current,
                  creationAttemptAt: new Date().toISOString(),
                  baseDeal: deal,
                };
                const allocation = calculateProductAllocation(
                  Math.max(0, Math.floor(Number(draft.totalPrice || 0))),
                  Math.max(1, Math.min(999, Number(draft.totalQuantity || 1))),
                  Math.max(1, Math.min(Number(draft.totalQuantity || 1), Number(draft.creatorQuantity || 1))),
                );
                submissionAttemptRef.current = { draft, allocation };
                setSubmissionLocked(true);
              }
              const submissionAttempt = submissionAttemptRef.current;
              const { draft, allocation } = submissionAttempt;
              let createdGroup = submissionAttempt.createdGroup || null;
              if (!createdGroup) {
                createdGroup = await onGroupCreate(draft);
                // Keep the centrally created group attached to this UI attempt. A background
                // order reconciliation may finish and clear its checkout record before the
                // user presses retry; recreating the group workflow at that point would mint
                // a second order ID for the same purchase.
                if (submissionAttemptRef.current === submissionAttempt) {
                  submissionAttempt.createdGroup = createdGroup;
                }
              }
              await onOrderCreate({
                type: 'group',
                dealId: createdGroup.id,
                groupId: createdGroup.groupId || createdGroup.id,
                deal: createdGroup,
                title: createdGroup.title,
                store: createdGroup.store,
                total: draft.hostMode === 'self'
                  ? allocation.hostSelectedAmount
                  : allocation.selectedAmount,
                method: draft.method,
                deadline: `${draft.deadlineDate} ${draft.deadlineTime}`,
                quantity: allocation.selectedQuantity,
                selectedCount: allocation.selectedQuantity,
                hostRemainderApplied: draft.hostMode === 'self' ? allocation.remainder : 0,
                clientMutationId: `create-${createdGroup.id}`,
              });
              resetSubmissionAttempt(draft.groupId);
              onScreen('room');
            } catch (creationError) {
              if (creationError?.groupCreationCompensated) {
                if (submissionAttemptRef.current) resetSubmissionAttempt();
                else setSubmissionLocked(false);
                setSubmitError('그룹방을 생성하지 못했습니다. 주문 저장이 거절되어 생성 내용을 안전하게 되돌렸습니다. 다시 누르면 새 그룹으로 생성합니다.');
              } else {
                setSubmissionLocked(true);
                setSubmitError(creationError?.cleanupError
                  ? '그룹방을 생성하지 못했습니다. 생성 취소 정리를 확인 중입니다. 입력값을 유지한 채 같은 내용으로 다시 시도해 주세요.'
                  : '그룹방을 생성하지 못했습니다. 처리 결과를 확인하지 못했습니다. 입력값을 유지한 채 같은 내용으로 다시 시도해 주세요.');
              }
            } finally {
              setSubmitting(false);
            }
          }}
          disabled={submitting || imageProcessing || !form.title || !form.category || Number(form.totalPrice) <= 0}
        >
          <Users size={18} />
          {submitting
            ? '그룹방 생성 중…'
            : submissionLocked
              ? '같은 내용으로 그룹방 생성 다시 시도'
              : '그룹방 생성'}
        </button>
      </div>
    </section>
  );
}

function Completion({ deal, message = '', onScreen }) {
  useScreenAnalytics('completion', { deal_id: deal.id });
  const isInstant = deal.saleType === 'instant';
  const isCustomerGroup = deal.source === 'customer';
  const hasGroupRoom = dealHasGroupRoom(deal);
  return (
    <section className="screen complete-screen">
      <div className="success-mark">
        <Check size={34} />
      </div>
      <h1>{isInstant ? '구매 신청 완료' : isCustomerGroup ? '그룹 참여 완료' : '공동구매 참여 완료'}</h1>
      <p>{deal.store} {isInstant ? '선착순 즉시할인 신청이' : '공동구매 신청이'} 저장되었습니다.</p>

      {message && (
        <div className="completion-payment-note" role="status">
          <strong>처리 결과</strong>
          <span>{message}</span>
        </div>
      )}

      {!isCustomerGroup && (
        <div className="completion-payment-note">
          <strong>가상 주문 접수 완료</strong>
          <span>실제 결제 후 사장님이 ‘결제 확인’을 누르면 내 주문 화면에 반영됩니다.</span>
        </div>
      )}

      <div className="completion-summary">
        <div>
          <span>마감</span>
          <strong>{deal.deadline}</strong>
        </div>
        <div>
          <span>수령 장소</span>
          <strong>{deal.address}</strong>
        </div>
      </div>

      {RELEASE_FEATURES.chat && hasGroupRoom && (
        <button className="primary-button" onClick={() => onScreen('room')}>
          <MessageCircle size={18} />
          그룹 채팅 바로가기
        </button>
      )}
      <button className="primary-button" onClick={() => onScreen('survey')}>
        <MessageCircle size={18} />
        설문 작성
      </button>
      <button className="secondary-button" onClick={() => onScreen('list')}>
        <Home size={18} />
        홈으로
      </button>
    </section>
  );
}

function Survey({ onScreen }) {
  useScreenAnalytics('survey');
  const [submitting, setSubmitting] = useState(false);
  const [submittedLocally, setSubmittedLocally] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [answer, setAnswer] = useState({
    reason: '더 저렴하게 구매할 수 있어서',
    discountExpectation: '15%',
    hostIntent: '조건이 맞으면 해보고 싶다',
    preferredCategory: '음식·간편식',
    revisitIntent: '이용할 것 같다',
    feedback: '',
  });
  const update = (key, value) => setAnswer((current) => ({ ...current, [key]: value }));

  const surveyGroups = [
    {
      key: 'reason',
      title: '이번 공동구매에 참여한 가장 큰 이유',
      options: [
        '더 저렴하게 구매할 수 있어서',
        '배달비를 아낄 수 있어서',
        '대용량 상품을 부담 없이 나눠 살 수 있어서',
        '이웃과 함께 구매하는 것이 편리해서',
        '새로운 공동구매 서비스라서',
      ],
    },
    {
      key: 'discountExpectation',
      title: '참여하고 싶은 할인 혜택',
      options: ['5%', '10%', '15%', '20%', '30% 이상'],
    },
    {
      key: 'hostIntent',
      title: '직접 호스트가 되어볼 의향',
      options: ['적극적으로 해보고 싶다', '조건이 맞으면 해보고 싶다', '참여만 하고 싶다'],
    },
    {
      key: 'preferredCategory',
      title: '가장 이용해 보고 싶은 공동구매',
      options: PRODUCT_CATEGORIES,
    },
    {
      key: 'revisitIntent',
      title: 'UPTWOYOU 재이용 의향',
      options: ['꼭 이용하고 싶다', '이용할 것 같다', '상황에 따라 이용할 것 같다', '아직 잘 모르겠다'],
    },
  ];

  return (
    <section className="screen">
      <header className="top-nav compact">
        <button className="icon-button" onClick={() => onScreen('list')} aria-label="닫기">
          <X size={22} />
        </button>
        <h1>참여 설문</h1>
        <span />
      </header>

      {surveyGroups.map((group) => (
        <div className="survey-group" key={group.key}>
          <h2>{group.title}</h2>
          {group.options.map((item) => (
            <label className="radio-row" key={item}>
              <input
                type="radio"
                checked={answer[group.key] === item}
                onChange={() => update(group.key, item)}
              />
              {item}
            </label>
          ))}
        </div>
      ))}

      <div className="form-stack compact-form">
        <label>
          피드백 및 의견
          <textarea
            maxLength={1000}
            value={answer.feedback}
            onChange={(event) => update('feedback', event.target.value)}
            placeholder="서비스를 이용하면서 느낀 점이나 개선 의견"
          />
        </label>
      </div>

      <p className="evidence-note">제출 즉시 고객번호·이름·연락처·응답 내용·제출 시간이 Google Sheets에 자동 저장됩니다.</p>
      {submitError && <p className="form-error" role="alert" aria-live="assertive">{submitError}</p>}

      <button
        className="primary-button"
        disabled={submitting || submittedLocally}
        onClick={async () => {
          setSubmitting(true);
          setSubmitError('');
          try {
            const event = track('survey_submitted', answer);
            const stored = await event.collectionPromise;
            if (stored) {
              onScreen('list');
              return;
            }
            setSubmittedLocally(true);
            setSubmitError('네트워크 연결을 확인해 주세요. 응답은 기기에 보관되며 온라인 상태에서 자동으로 다시 전송됩니다.');
          } catch {
            setSubmittedLocally(true);
            setSubmitError('네트워크 연결을 확인해 주세요. 응답은 기기에 보관되며 온라인 상태에서 자동으로 다시 전송됩니다.');
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <Check size={18} />
        {submitting ? '설문 저장 중…' : submittedLocally ? '기기에 안전하게 보관됨' : '설문 제출하기'}
      </button>
      {submittedLocally && (
        <button className="secondary-button" onClick={() => onScreen('list')}>
          목록으로 돌아가기
        </button>
      )}
    </section>
  );
}

function OwnerApp({
  screen,
  selectedDeal,
  deals,
  centralDeals = [],
  syncIssues = {},
  createdDeals,
  ownedDeals,
  orders,
  ownerOrders,
  ownerRecoveryCount = 0,
  ownerRecoveryBusy = false,
  ownerRecoveryError = '',
  workspaceStatus = 'ready',
  onRetryWorkspace,
  ownerAccountHint = null,
  location,
  onScreen,
  onCreate,
  onDeleteDeal,
  onRecoverOwnerProducts,
  onSwitchOwnerAccount,
  ownerBackupStatus = '',
  onExportOwnerBackup,
  onImportOwnerBackup,
  onPreviewCustomer,
  onOrderStatusChange,
  onPaymentConfirm,
  onNeighborhoodChange,
}) {
  const [formVersion, setFormVersion] = useState(0);
  const [editingDeal, setEditingDeal] = useState(null);
  const confirmedDeals = useMemo(() => mergeDeals(centralDeals, ownedDeals), [centralDeals, ownedDeals]);
  const managedOwnerDeals = useMemo(() => {
    const centralById = new Map(confirmedDeals.map((deal) => [deal.id, deal]));
    return mergeDeals(createdDeals, ownedDeals).map((ownedDeal) => {
      const centralDeal = centralById.get(ownedDeal.id);
      if (!centralDeal) return ownedDeal;
      const orderedQuantity = Number(centralDeal.orderedQuantity ?? centralDeal.current ?? 0);
      return {
        ...mergeDeals([ownedDeal], [centralDeal])[0],
        orderedQuantity,
        allocatedProductQuantity: orderedQuantity,
        current: orderedQuantity,
        currentCount: Number(centralDeal.currentCount ?? orderedQuantity),
        participantCount: Number(centralDeal.participantCount || 0),
      };
    });
  }, [createdDeals, confirmedDeals, ownedDeals]);
  const ownerDealIds = useMemo(
    () => new Set(managedOwnerDeals.map((deal) => deal.id)),
    [managedOwnerDeals],
  );
  const authoritativeOwnerOrderIds = useMemo(
    () => new Set(ownerOrders.map((order) => order?.id).filter(Boolean)),
    [ownerOrders],
  );
  const managedOrders = useMemo(() => mergeAuthoritativeOwnerOrders(ownerOrders, orders).filter(
    (order) => ['purchase', 'group'].includes(order.type)
      && ownerOrderBelongsToWorkspace(order, ownerDealIds, authoritativeOwnerOrderIds),
  ), [authoritativeOwnerOrderIds, orders, ownerDealIds, ownerOrders]);
  const orderSummaries = useMemo(() => managedOwnerDeals.flatMap((deal) => {
    const detailedQuantity = managedOrders
      .filter((order) => order.dealId === deal.id && !isCancelledOrder(order))
      .reduce((total, order) => total + Math.max(1, Number(order.selectedCount ?? order.quantity ?? 1)), 0);
    const centralQuantity = Math.max(0, Number(deal.orderedQuantity ?? deal.current ?? 0));
    const pendingQuantity = Math.max(0, centralQuantity - detailedQuantity);
    return pendingQuantity > 0 ? [{ deal, pendingQuantity, centralQuantity }] : [];
  }), [managedOwnerDeals, managedOrders]);
  const ownerOrderDisplay = useMemo(
    () => summarizeOwnerOrderDisplay(managedOrders, orderSummaries),
    [managedOrders, orderSummaries],
  );
  const publicCustomerGroups = deals.filter(
    (deal) => deal.source === 'customer' && deal.visibility !== 'private',
  );

  if (screen === 'orders') {
    return (
      <OwnerOrders
        workspaceStatus={workspaceStatus}
        onRetryWorkspace={onRetryWorkspace}
        orders={managedOrders}
        summaries={orderSummaries}
        displayMetrics={ownerOrderDisplay}
        location={location}
        onBack={() => onScreen('form')}
        onStatusChange={onOrderStatusChange}
        onPaymentConfirm={onPaymentConfirm}
        accountHint={ownerAccountHint}
        onSwitchAccount={onSwitchOwnerAccount}
        backupStatus={ownerBackupStatus}
        onExportBackup={onExportOwnerBackup}
        onImportBackup={onImportOwnerBackup}
      />
    );
  }
  if (screen === 'products') {
    return (
      <OwnerProducts
        workspaceStatus={workspaceStatus}
        onRetryWorkspace={onRetryWorkspace}
        deals={managedOwnerDeals}
        centralDeals={confirmedDeals}
        localDeals={createdDeals}
        syncIssues={syncIssues}
        onBack={() => onScreen('form')}
        recoveryCount={ownerRecoveryCount}
        recoveryBusy={ownerRecoveryBusy}
        recoveryError={ownerRecoveryError}
        onRecover={onRecoverOwnerProducts}
        accountHint={ownerAccountHint}
        onSwitchAccount={onSwitchOwnerAccount}
        backupStatus={ownerBackupStatus}
        onExportBackup={onExportOwnerBackup}
        onImportBackup={onImportOwnerBackup}
        onEdit={(deal) => {
          setEditingDeal(deal);
          setFormVersion((current) => current + 1);
          onScreen('form');
        }}
        onDelete={onDeleteDeal}
      />
    );
  }
  if (screen === 'done') {
    return (
      <OwnerDone
        deal={selectedDeal}
        onCreateAnother={() => {
          setEditingDeal(null);
          setFormVersion((current) => current + 1);
          onScreen('form');
        }}
        onOpenOrders={() => onScreen('orders')}
        onPreviewCustomer={onPreviewCustomer}
      />
    );
  }
  return (
    <OwnerForm
      key={formVersion}
      initialDeal={editingDeal}
      onCreate={async (payload) => {
        const savedDeal = await onCreate(payload, editingDeal?.id || null, editingDeal);
        if (savedDeal) setEditingDeal(null);
        return savedDeal;
      }}
      onOpenOrders={() => onScreen('orders')}
      onOpenProducts={() => onScreen('products')}
      orderDisplay={ownerOrderDisplay}
      recoveryCount={ownerRecoveryCount}
      recoveryBusy={ownerRecoveryBusy}
      recoveryError={ownerRecoveryError}
      onRecover={onRecoverOwnerProducts}
      accountHint={ownerAccountHint}
      onSwitchAccount={onSwitchOwnerAccount}
      backupStatus={ownerBackupStatus}
      onExportBackup={onExportOwnerBackup}
      onImportBackup={onImportOwnerBackup}
      communityGroups={publicCustomerGroups}
      location={location}
      onNeighborhoodChange={onNeighborhoodChange}
    />
  );
}

function OwnerForm({
  initialDeal,
  onCreate,
  onOpenOrders,
  onOpenProducts,
  orderDisplay = summarizeOwnerOrderDisplay(),
  recoveryCount = 0,
  recoveryBusy = false,
  recoveryError = '',
  onRecover,
  accountHint = null,
  onSwitchAccount,
  backupStatus = '',
  onExportBackup,
  onImportBackup,
  communityGroups,
  location,
  onNeighborhoodChange,
}) {
  useScreenAnalytics('owner_product_form');
  const deadlineParts = String(initialDeal?.deadline || '').split(' ');
  const activeAllocatedQuantity = initialDeal?.saleType === 'group'
    ? Math.max(0, Math.ceil(Number(
      initialDeal.orderedQuantity
      ?? initialDeal.allocatedProductQuantity
      ?? initialDeal.current
      ?? 0,
    )))
    : 0;
  const initialTotalQuantity = Math.max(
    activeAllocatedQuantity,
    Math.floor(Number(
      initialDeal?.totalQuantity
      ?? initialDeal?.productQuantity
      ?? initialDeal?.target
      ?? 1,
    )) || 1,
  );
  const initialSplitQuantity = initialDeal?.saleType === 'group'
    ? clamp(getMerchantSplitQuantity(initialDeal), 1, initialTotalQuantity)
    : 1;
  const [form, setForm] = useState({
    saleType: 'group',
    ...normalizeLocation(location),
    storeName: '',
    productName: '',
    category: '음식·간편식',
    description: '',
    originalPrice: '',
    discountRate: 15,
    stock: 1,
    maxQuantity: 1,
    splitQuantity: 1,
    deadlineDate: new Date().toISOString().slice(0, 10),
    deadlineTime: '20:00',
    eventStart: '14:30',
    eventEnd: '16:00',
    pickupPlace: '',
    methods: [],
    image: '',
    ...(initialDeal ? {
      saleType: initialDeal.saleType || 'group',
      ...normalizeLocation(initialDeal),
      storeName: initialDeal.store || '',
      productName: initialDeal.title || '',
      category: normalizeCategory(initialDeal.category || '음식·간편식'),
      description: initialDeal.description || '',
      originalPrice: String(initialDeal.originalPrice || ''),
      discountRate: Number(initialDeal.discountRate || 0),
      stock: Math.max(1, Number(
        initialDeal.stock
        || initialDeal.totalQuantity
        || initialDeal.productQuantity
        || initialDeal.target
        || 1,
      )),
      maxQuantity: Math.max(
        activeAllocatedQuantity,
        Number(initialDeal.totalQuantity || initialDeal.productQuantity || initialDeal.target || 1),
      ),
      splitQuantity: initialSplitQuantity,
      deadlineDate: /^\d{4}-\d{2}-\d{2}$/.test(deadlineParts[0]) ? deadlineParts[0] : new Date().toISOString().slice(0, 10),
      deadlineTime: /^\d{2}:\d{2}$/.test(deadlineParts[1]) ? deadlineParts[1] : '20:00',
      eventStart: initialDeal.eventStart || '14:30',
      eventEnd: initialDeal.eventEnd || '16:00',
      pickupPlace: initialDeal.address || '',
      methods: initialDeal.methods || [],
      image: initialDeal.image || '',
    } : {}),
  });
  const [imageProcessing, setImageProcessing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const draftDealId = useRef(
    initialDeal?.id || `owner-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
  ).current;

  const selectedRegion = getRegion(form.region);
  const selectedDistrict = getDistrict(selectedRegion, form.district);

  const price = discountedPrice(form.originalPrice, form.discountRate);
  const canonicalQuantity = resolveOwnerProductQuantity({
    saleType: form.saleType,
    stock: form.stock,
    maxQuantity: form.maxQuantity,
    minimumGroupQuantity: activeAllocatedQuantity,
  });
  const groupTotalQuantity = canonicalQuantity.quantity;
  const groupPricePreview = resolveMerchantGroupPricing({
    originalPrice: form.originalPrice,
    discountRate: form.discountRate,
    totalQuantity: groupTotalQuantity,
    splitQuantity: form.splitQuantity,
  });

  const toggleMethod = (method) => {
    const methods = form.methods.includes(method)
      ? form.methods.filter((item) => item !== method)
      : [...form.methods, method];
    setForm({ ...form, methods });
  };

  return (
    <section className="screen">
      <header className="top-nav">
        <div>
          <p className="eyebrow">사장님 등록</p>
          <h1>메뉴 상세</h1>
        </div>
        <div className="inline-actions">
          <button className="owner-orders-button" onClick={onOpenProducts}>
            <Home size={18} />
            <span>상품 관리</span>
          </button>
          <button className="owner-orders-button" onClick={onOpenOrders}>
            <ShoppingBag size={18} />
            <span>
              주문 {orderDisplay.activeOrderCount}건
              {orderDisplay.pendingDetailQuantity > 0
                ? ` · 동기화 ${orderDisplay.pendingDetailQuantity}개`
                : ''}
            </span>
          </button>
        </div>
      </header>

      <OwnerRecoveryBanner
        count={recoveryCount}
        busy={recoveryBusy}
        error={recoveryError}
        onRecover={onRecover}
        accountHint={accountHint}
        onSwitchAccount={onSwitchAccount}
      />
      <OwnerBackupControls
        status={backupStatus}
        onExport={onExportBackup}
        onImport={onImportBackup}
      />

      <div className="owner-neighborhood-link">
        <div>
          <MapPin size={17} />
          <span>매장·픽업 기준 지역</span>
        </div>
        <div className="region-neighborhood-fields owner-location-fields">
          <label>
            시·도
            <select
              aria-label="사장님 연동 시도"
              value={form.region}
              onChange={(event) => {
                const region = getRegion(event.target.value);
                const district = region.districts[0];
                const nextLocation = {
                  region: region.name,
                  district: district.name,
                  neighborhood: district.neighborhoods[0],
                };
                setForm({ ...form, ...nextLocation });
                onNeighborhoodChange(nextLocation);
              }}
            >
              {REGIONS.map((region) => <option key={region.code} value={region.name}>{region.name}</option>)}
            </select>
          </label>
          <label>
            시·군·구
            <select
              aria-label="사장님 연동 시군구"
              value={form.district}
              onChange={(event) => {
                const district = getDistrict(selectedRegion, event.target.value);
                const nextLocation = {
                  region: selectedRegion.name,
                  district: district.name,
                  neighborhood: district.neighborhoods[0],
                };
                setForm({ ...form, ...nextLocation });
                onNeighborhoodChange(nextLocation);
              }}
            >
              {selectedRegion.districts.map((district) => (
                <option key={district.code} value={district.name}>{district.name}</option>
              ))}
            </select>
          </label>
          <label>
            읍·면·동
            <select
              aria-label="사장님 연동 읍면동"
              value={form.neighborhood}
              onChange={(event) => {
                const nextLocation = { ...normalizeLocation(form), neighborhood: event.target.value };
                setForm({ ...form, ...nextLocation });
                onNeighborhoodChange(nextLocation);
              }}
            >
              {selectedDistrict.neighborhoods.map((neighborhood) => (
                <option key={neighborhood}>{neighborhood}</option>
              ))}
            </select>
          </label>
        </div>
        <p>{formatLocation(form)}을 픽업 안내와 지역 통계 기준으로 사용합니다. 공개 상품과 주문 관리는 지역으로 제한되지 않습니다.</p>
      </div>

      {communityGroups.length > 0 && (
        <div className="content-block owner-community-groups">
          <div>
            <p className="eyebrow">공개 사용자 수요</p>
            <h2>진행 중인 공동구매</h2>
          </div>
          {communityGroups.slice(0, 5).map((group) => {
            const quantityState = getDealQuantity(group);
            const unitAllocation = calculateProductAllocation(
              Number(group.originalPrice || 0),
              quantityState.target,
              Math.min(1, quantityState.target),
            );
            return (
              <article key={group.id}>
                <div>
                  <span>{normalizeCategory(group.category)} · {GROUP_STATUS_LABELS[group.groupStatus || 'recruiting']}</span>
                  <strong>{group.title}</strong>
                  <small>
                    목표 {quantityState.targetPeople}명 / 현재 {quantityState.currentPeople}명 ·{' '}
                    {formatGroupQuantityAllocation(quantityState, group.groupStatus || 'recruiting')}
                  </small>
                </div>
                <b>{group.approximatePrice || unitAllocation.approximate ? '약 ' : ''}{formatWon(group.unitPrice ?? group.expectedPerPerson ?? unitAllocation.unitPrice)} / 1개</b>
              </article>
            );
          })}
        </div>
      )}

      <ImageCropUploader
        className="owner-image-uploader"
        value={form.image}
        alt="등록할 상품 이미지 미리보기"
        buttonLabel="이미지 변경"
        onBusyChange={setImageProcessing}
        onChange={(image) => setForm((current) => ({ ...current, image }))}
        onUploaded={(file) => track('owner_image_uploaded', {
          file_type: file.type,
          size: file.size,
          crop_editor: true,
        })}
      />

      <form
        className="form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting) return;
          setSubmitting(true);
          setSubmitError('');
          const payload = {
            ...form,
            draftDealId,
            splitQuantity: form.saleType === 'group' ? groupPricePreview.splitQuantity : 1,
            deadline: form.saleType === 'instant'
              ? `${form.eventStart} ~ ${form.eventEnd}`
              : `${form.deadlineDate} ${form.deadlineTime}`,
            calculatedPrice: price,
          };
          let savedDeal;
          try {
            savedDeal = await onCreate(payload);
          } catch (error) {
            setSubmitError(error?.code === 'state_conflict' || error?.message === 'state_conflict'
              ? error.currentPublishVersion === 0
                ? '서버에서 이 상품의 중앙 저장 기록을 확인하지 못했습니다. 입력 내용은 유지됩니다. 관리자에게 기록 확인을 요청해 주세요.'
                : '다른 창에서 상품이 변경되었습니다. 입력 내용은 유지됩니다. 등록 상품 관리에서 최신 내용을 확인한 뒤 다시 수정해 주세요.'
              : '상품을 중앙 서버에 저장하지 못했습니다. 입력 내용은 유지되므로 네트워크를 확인한 뒤 다시 눌러 주세요.');
            setSubmitting(false);
            return;
          }
          if (!savedDeal) {
            setSubmitError('상품 정보를 저장하지 못했습니다. 사장님 연락처와 네트워크 상태를 확인한 뒤 다시 시도해 주세요.');
            setSubmitting(false);
            return;
          }
          track(initialDeal ? 'owner_product_updated' : 'owner_product_created', {
            deal_id: savedDeal.id,
            sale_type: form.saleType,
            region: form.region,
            district: form.district,
            neighborhood: form.neighborhood,
            store_name: form.storeName,
            product_name: form.productName,
            category: form.category,
            original_price: Number(form.originalPrice),
            discount_rate: Number(form.discountRate),
            calculated_price: price,
            expected_per_item: form.saleType === 'group' ? groupPricePreview.unitPrice : price,
            total_quantity: canonicalQuantity.quantity,
            split_quantity: form.saleType === 'group' ? groupPricePreview.splitQuantity : 1,
            stock: canonicalQuantity.stock,
            max_quantity: canonicalQuantity.maxQuantity,
            deadline: payload.deadline,
            pickup_place: form.pickupPlace,
            methods: form.methods,
            has_image: Boolean(form.image),
          });
          setSubmitting(false);
        }}
      >
        <div className="content-block flush">
          <h2>판매 방식</h2>
          <div className="sale-type-grid">
            {[
              { id: 'group', title: '공동구매', body: '목표 수량 달성 시 할인' },
              { id: 'instant', title: '선착순 즉시할인', body: '재고 소진형 바로 할인' },
            ].map((item) => (
              <button
                type="button"
                key={item.id}
                className={form.saleType === item.id ? 'sale-type-card active' : 'sale-type-card'}
                disabled={Boolean(
                  initialDeal?.saleType === 'group'
                  && activeAllocatedQuantity > 0
                  && item.id !== 'group'
                )}
                onClick={() => {
                  setForm({ ...form, saleType: item.id });
                  track('sale_type_selected', { sale_type: item.id });
                }}
              >
                <strong>{item.title}</strong>
                <span>{item.body}</span>
              </button>
            ))}
          </div>
        </div>

        <label>
          매장명
          <input maxLength={80} value={form.storeName} onChange={(event) => setForm({ ...form, storeName: event.target.value })} />
        </label>
        <label>
          매장 지역
          <input value={formatLocation(form)} readOnly />
        </label>
        <label>
          상품명
          <input maxLength={120} value={form.productName} onChange={(event) => setForm({ ...form, productName: event.target.value })} />
        </label>
        <label>
          카테고리
          <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
            {PRODUCT_CATEGORIES.map((category) => <option key={category}>{category}</option>)}
          </select>
        </label>
        <label>
          정상가
          <input
            type="number"
            min="0"
            inputMode="numeric"
            value={form.originalPrice}
            onChange={(event) => setForm({ ...form, originalPrice: event.target.value })}
          />
        </label>
        <label>
          할인율 {form.discountRate}%
          <input
            type="range"
            min="0"
            max="70"
            value={form.discountRate}
            onChange={(event) => setForm({ ...form, discountRate: Number(event.target.value) })}
          />
        </label>
        <div className="calculated-price">
          <span>{form.saleType === 'group' ? '할인 후 상품가격' : '자동 계산 할인가'}</span>
          <strong>{formatWon(price)}</strong>
        </div>

        <div className="creator-grid">
          {form.saleType === 'group' ? (
            <>
              <FieldCounter
                label="공구 총수량"
                value={form.maxQuantity}
                onMinus={() => setForm((current) => {
                  const maxQuantity = clamp(
                    current.maxQuantity - 1,
                    Math.max(1, activeAllocatedQuantity),
                    999,
                  );
                  return {
                    ...current,
                    maxQuantity,
                    splitQuantity: clamp(current.splitQuantity, 1, maxQuantity),
                  };
                })}
                onPlus={() => setForm((current) => ({
                  ...current,
                  maxQuantity: clamp(current.maxQuantity + 1, 1, 999),
                }))}
              />
              <FieldCounter
                label="가격 분할수량"
                value={groupPricePreview.splitQuantity}
                onMinus={() => setForm((current) => ({
                  ...current,
                  splitQuantity: clamp(current.splitQuantity - 1, 1, canonicalQuantity.quantity),
                }))}
                onPlus={() => setForm((current) => ({
                  ...current,
                  splitQuantity: clamp(current.splitQuantity + 1, 1, canonicalQuantity.quantity),
                }))}
              />
            </>
          ) : (
            <FieldCounter
              label="재고 수량"
              value={form.stock}
              onMinus={() => setForm({ ...form, stock: clamp(form.stock - 1, 1, 999) })}
              onPlus={() => setForm({ ...form, stock: clamp(form.stock + 1, 1, 999) })}
            />
          )}
        </div>

        {form.saleType === 'group' && (
          <div className="group-create-price-preview owner-split-price-preview" aria-live="polite">
            <span>{groupPricePreview.splitPricing ? '분할 1개당 예상금액' : '할인 후 1개 가격'}</span>
            <strong>{groupPricePreview.approximate ? '약 ' : ''}{formatWon(groupPricePreview.unitPrice)}</strong>
            <div className="allocation-inline-summary">
              <span>할인 후 상품가격 {formatWon(groupPricePreview.discountedTotal)}</span>
              <strong>총 {groupPricePreview.totalQuantity}개 모집 · 가격 {groupPricePreview.splitQuantity}개 분할</strong>
            </div>
            <p>공구 총수량은 주문 가능한 전체 수량이며 가격을 나누지 않습니다.</p>
            <p>가격 분할수량이 1이면 할인 후 상품가격을 그대로 표시하고, 2 이상일 때만 해당 수량으로 나눕니다.</p>
            <p>상품 등록을 완료하면 같은 정보로 사용자 공동구매가 한 번만 생성됩니다.</p>
            {activeAllocatedQuantity > 0 && (
              <p>현재 주문 {activeAllocatedQuantity}개가 있어 공구 총수량은 이보다 작게 줄일 수 없습니다.</p>
            )}
            {groupPricePreview.remainder > 0 && (
              <p>원 단위로 남는 {formatWon(groupPricePreview.remainder)}은 사장님이 별도로 안내합니다.</p>
            )}
          </div>
        )}

        <div className="content-block flush">
          <h2>수령 방식</h2>
          <div className="method-grid">
            {['배달', '픽업', '그룹배달', '택배'].map((method) => (
              <button
                type="button"
                key={method}
                className={form.methods.includes(method) ? 'method-button active' : 'method-button'}
                onClick={() => toggleMethod(method)}
              >
                {method}
              </button>
            ))}
          </div>
        </div>

        {form.saleType === 'group' && (
          <div className="content-block flush">
            <h2>마감 시간</h2>
            <div className="date-time-row">
              <label>
                <Calendar size={16} />
                <input
                  type="date"
                  value={form.deadlineDate}
                  onChange={(event) => setForm({ ...form, deadlineDate: event.target.value })}
                />
              </label>
              <label>
                <Clock size={16} />
                <input
                  type="time"
                  value={form.deadlineTime}
                  onChange={(event) => setForm({ ...form, deadlineTime: event.target.value })}
                />
              </label>
            </div>
          </div>
        )}
        {form.saleType === 'instant' && (
          <div className="content-block flush">
            <h2>이벤트 진행 시간</h2>
            <div className="date-time-row">
              <label>
                <Clock size={16} />
                <input
                  type="time"
                  value={form.eventStart}
                  onChange={(event) => setForm({ ...form, eventStart: event.target.value })}
                />
              </label>
              <label>
                <Clock size={16} />
                <input
                  type="time"
                  value={form.eventEnd}
                  onChange={(event) => setForm({ ...form, eventEnd: event.target.value })}
                />
              </label>
            </div>
          </div>
        )}
        <label>
          픽업 위치
          <input maxLength={200} value={form.pickupPlace} onChange={(event) => setForm({ ...form, pickupPlace: event.target.value })} />
        </label>
        <label>
          설명
          <textarea maxLength={500} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </label>

        {submitError && <p className="form-error" role="alert" aria-live="assertive">{submitError}</p>}
        <button className="primary-button" type="submit" disabled={submitting || imageProcessing || !form.storeName.trim() || !form.productName.trim() || Number(form.originalPrice) <= 0 || form.methods.length === 0}>
          <Check size={18} />
          {submitting ? '중앙 서버에 저장 중…' : initialDeal ? '상품 수정 완료' : '상품 등록 완료'}
        </button>
      </form>
    </section>
  );
}

function OwnerRecoveryBanner({
  count = 0,
  busy = false,
  error = '',
  onRecover,
  accountHint = null,
  onSwitchAccount,
}) {
  if (count <= 0 && !error && !accountHint) return null;
  const maskedPhone = accountHint
    ? formatKoreanMobilePhoneInput(accountHint.phone).replace(/^(010)-\d{3,4}-(\d{4})$/, '$1-****-$2')
    : '';
  return (
    <div className="owner-recovery-banner" role="status" aria-live="polite">
      <div>
        <strong>{accountHint
          ? `기존 사장님 상품 ${accountHint.count}개를 확인했습니다`
          : count > 0 ? `이 브라우저의 미연결 상품 ${count}개를 확인했습니다` : '상품 연결을 확인해 주세요'}</strong>
        <span>{accountHint
          ? `현재 번호와 다른 ${maskedPhone} 번호에 연결된 상품입니다. 기존 번호로 돌아가면 상품과 주문을 다시 불러옵니다.`
          : count > 0
          ? '브라우저에 저장된 상품 관리키를 서버에서 확인했습니다. 상품명과 매장을 확인한 뒤 수동으로 연결해 주세요.'
          : error}</span>
      </div>
      {(accountHint || count > 0 || error) && (
        <button
          className="secondary-button compact-button"
          disabled={busy}
          onClick={accountHint ? onSwitchAccount : onRecover}
        >
          {busy ? '확인 중…' : accountHint ? '기존 번호로 연결' : count > 0 ? '확인 후 연결' : '다시 확인'}
        </button>
      )}
      {count > 0 && error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function OwnerBackupControls() {
  // Removed from the merchant UI at the user's request. Existing keys/files are preserved.
  return null;
}

function OwnerWorkspaceNotice({ status, onRetry }) {
  if (status === 'loading') return <p role="status">기존 상품·주문 이력을 확인하고 있습니다.</p>;
  if (status === 'error') return (
    <div className="form-error" role="alert">
      <p>기존 이력을 불러오지 못했습니다. 기록이 삭제된 것은 아니며, 마지막으로 확인한 목록을 표시합니다.</p>
      <button type="button" className="secondary-button" onClick={onRetry}>이력 다시 불러오기</button>
    </div>
  );
  return (
    <div className="owner-sync-banner">
      <p>{status === 'unlinked' ? '이 브라우저에는 연결된 상품 관리키가 없습니다.'
        : status === 'unconfirmed' ? '이 관리키로 서버에 게시된 상품·주문을 확인하지 못했습니다. 이 브라우저의 기록은 유지합니다.'
          : '서버에서 조회한 관리 이력을 반영했습니다. 이 브라우저에 남아 있는 기록도 보존합니다.'}</p>
      <p>이전 이력이 없다면 상품을 등록했던 같은 브라우저·사장님 프로필로 확인해 주세요. 다른 기기의 기록은 관리자 앱의 상품·주문 관리에서 확인할 수 있습니다.</p>
    </div>
  );
}

function OwnerProducts({
  workspaceStatus = 'ready',
  onRetryWorkspace,
  deals,
  centralDeals = [],
  localDeals = [],
  syncIssues = {},
  onBack,
  onEdit,
  onDelete,
  recoveryCount = 0,
  recoveryBusy = false,
  recoveryError = '',
  onRecover,
  accountHint = null,
  onSwitchAccount,
  backupStatus = '',
  onExportBackup,
  onImportBackup,
}) {
  useScreenAnalytics('owner_products', { product_count: deals.length });
  const [busyDealId, setBusyDealId] = useState('');
  const [deleteError, setDeleteError] = useState('');

  const handleDelete = async (deal) => {
    if (!SCOPED_UI_ACTIONS.productDeletion || busyDealId) return;
    if (!window.confirm('이 상품을 전체 공개 목록에서 삭제할까요?')) return;
    setBusyDealId(deal.id);
    setDeleteError('');
    try {
      const deleted = await onDelete(deal);
      if (!deleted) {
        setDeleteError('상품을 삭제하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.');
      }
    } catch (error) {
      setDeleteError(dealDeleteErrorMessage(error));
    } finally {
      setBusyDealId('');
    }
  };

  return (
    <section className="screen">
      <header className="top-nav compact">
        <button className="icon-button" onClick={onBack} aria-label="뒤로">
          <ArrowLeft size={22} />
        </button>
        <h1>등록 상품 관리</h1>
        <button className="icon-button" onClick={onBack} aria-label="사장님 홈">
          <Home size={20} />
        </button>
      </header>
      <OwnerWorkspaceNotice status={workspaceStatus} onRetry={onRetryWorkspace} />
      <OwnerRecoveryBanner
        count={recoveryCount}
        busy={recoveryBusy}
        error={recoveryError}
        onRecover={onRecover}
        accountHint={accountHint}
        onSwitchAccount={onSwitchAccount}
      />
      <OwnerBackupControls
        status={backupStatus}
        onExport={onExportBackup}
        onImport={onImportBackup}
      />
      {deleteError ? <p className="form-error" role="alert" aria-live="assertive">{deleteError}</p> : null}
      {deals.length === 0 && workspaceStatus === 'ready' ? (
        <EmptyCustomerState
          icon={Store}
          title="등록한 상품이 없습니다"
          body="상품을 등록하면 이 화면에서 수정할 수 있습니다."
          actionLabel="상품 등록하기"
          onAction={onBack}
        />
      ) : (
        <div className="owner-product-list">
          {deals.map((deal) => {
            const splitMerchant = isSplitMerchantDeal(deal);
            const hasManagementKey = Boolean(getDealCapability(deal.id));
            const publication = publicDealPublicationState(
              localDeals.find((local) => local.id === deal.id) || deal, centralDeals, syncIssues,
            );
            return (
              <article className="owner-product-card" key={deal.id}>
                <img
                  src={deal.image || fallbackImage}
                  alt={`${deal.title} 상품 이미지`}
                  onError={replaceBrokenImage}
                />
                <div>
                  <strong>{deal.title}</strong>
                  <p>{deal.store} · {formatLocation(deal)}</p>
                  <p className="owner-publication-state" data-state={publication.state} role="status">
                    <strong>{publication.label}</strong>
                    {publication.description && <span>{publication.description}</span>}
                  </p>
                  <span>{deal.saleType === 'group'
                    ? `${splitMerchant ? '분할 1개 예상 ' : '할인 후 1개 '}${formatWon(getDealPrice(deal))}`
                    : formatWon(getDealPrice(deal))}</span>
                  {splitMerchant && (
                    <small className="owner-bundle-total">
                      할인 후 상품가격 {formatWon(discountedPrice(deal.originalPrice, deal.discountRate))}
                    </small>
                  )}
                  {deal.quantityTracking && (
                    <span className="owner-quantity-state">
                      {deal.saleType === 'group'
                        ? `공구 총 ${getDealQuantity(deal).target}개 · 가격 ${getMerchantSplitQuantity(deal)}개 분할`
                        : `재고 총 ${getDealQuantity(deal).target}개`}
                      {' · '}주문 {getDealQuantity(deal).ordered}개 · 남은 수량 {getDealQuantity(deal).remaining}개
                    </span>
                  )}
                  {!hasManagementKey && (
                    <small className="owner-management-key-warning">
                      이 기기에는 관리 키가 없어 수정할 수 없습니다.
                    </small>
                  )}
                </div>
                <div className="owner-product-actions">
                  <button
                    className="secondary-button compact-button"
                    disabled={Boolean(busyDealId) || !hasManagementKey}
                    onClick={() => onEdit(deal)}
                  >
                    <Pencil size={14} />
                    수정
                  </button>
                  {SCOPED_UI_ACTIONS.productDeletion && (
                    <button
                      className="danger-button compact-button"
                      disabled={Boolean(busyDealId) || !hasManagementKey}
                      onClick={() => handleDelete(deal)}
                    >
                      <Trash2 size={14} />
                      {busyDealId === deal.id ? '삭제 중…' : '삭제'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function OwnerDone({ deal, onCreateAnother, onOpenOrders, onPreviewCustomer }) {
  useScreenAnalytics('owner_product_done', { deal_id: deal.id });
  const isInstant = deal.saleType === 'instant';
  const splitMerchant = isSplitMerchantDeal(deal);
  return (
    <section className="screen complete-screen product-complete-screen">
      <div className="success-mark">
        <Check size={34} />
      </div>
      <h1>등록 완료</h1>
      <p>{deal.title} {isInstant
        ? '선착순 즉시할인 상품이 사용자 리스트에 반영되었습니다.'
        : '상품과 공동구매가 하나의 카드로 사용자 리스트에 반영되었습니다.'}</p>
      <img
        className="done-image"
        src={deal.image || fallbackImage}
        alt={`${deal.title} 상품 이미지`}
        onError={replaceBrokenImage}
      />
      <div className="completion-summary">
        <div>
          <span>{isInstant ? '할인가' : splitMerchant ? '할인 후 상품가격' : '할인 후 1개 가격'}</span>
          <strong>{formatWon(discountedPrice(deal.originalPrice, deal.discountRate))}</strong>
        </div>
        {splitMerchant && (
          <div>
            <span>분할 1개당 예상금액</span>
            <strong>{deal.approximatePrice ? '약 ' : ''}{formatWon(getDealPrice(deal))}</strong>
          </div>
        )}
        {!isInstant && (
          <div>
            <span>가격 분할수량</span>
            <strong>{getMerchantSplitQuantity(deal)}개</strong>
          </div>
        )}
        <div>
          <span>{isInstant ? '재고 수량' : '공구 총수량'}</span>
          <strong>{getDealQuantity(deal).target}개</strong>
        </div>
      </div>
      <button className="primary-button" onClick={() => onPreviewCustomer('detail', deal)}>
        <ShoppingBag size={18} />
        사용자 화면에서 보기
      </button>
      <button className="secondary-button" onClick={onCreateAnother}>
        <Plus size={18} />
        추가 등록
      </button>
      <button className="secondary-button" onClick={onOpenOrders}>
        <ShoppingBag size={18} />
        주문 관리
      </button>
    </section>
  );
}

function OwnerOrders({
  workspaceStatus = 'ready',
  onRetryWorkspace,
  orders,
  summaries = [],
  displayMetrics = summarizeOwnerOrderDisplay(orders, summaries),
  location,
  onBack,
  onStatusChange,
  onPaymentConfirm,
  accountHint = null,
  onSwitchAccount,
  backupStatus = '',
  onExportBackup,
  onImportBackup,
}) {
  useScreenAnalytics('owner_orders', {
    order_count: orders.length,
    aggregate_order_count: summaries.length,
    ...normalizeLocation(location),
  });
  const [busyAction, setBusyAction] = useState('');
  const [actionError, setActionError] = useState('');

  const runOwnerAction = async (actionKey, operation) => {
    if (busyAction) return;
    setBusyAction(actionKey);
    setActionError('');
    try {
      await operation();
    } catch (error) {
      const code = String(error?.message || '');
      setActionError(
        ['missing_owner_capability', 'manager_capability_required', 'forbidden', 'order_manager_mismatch'].includes(code)
          ? '이 주문을 관리할 권한을 확인할 수 없습니다. 상품을 등록한 사장님 계정이나 그룹 호스트·관리자로 접속해 주세요.'
          : code === 'payment_request_required'
            ? '사용자가 “입금했어요”를 눌러 입금확인을 요청한 뒤 완료 처리할 수 있습니다.'
          : code === 'payment_reversal_requires_group_rewind'
            ? '입금완료를 취소하려면 공동구매 진행 단계를 먼저 “모집 중”으로 되돌려 주세요.'
          : code === 'state_conflict'
            ? '다른 변경이 먼저 반영되었습니다. 잠시 후 최신 주문을 확인하고 다시 시도해 주세요.'
            : '주문 상태를 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      );
    } finally {
      setBusyAction('');
    }
  };

  return (
    <section className="screen">
      <header className="top-nav compact">
        <button className="icon-button" onClick={onBack} aria-label="뒤로">
          <ArrowLeft size={22} />
        </button>
        <h1>주문 관리</h1>
        <span className="order-count-badge">
          전체 지역 · 활성 {displayMetrics.activeOrderCount}건
          {displayMetrics.cancelledOrderCount > 0
            ? ` · 취소 ${displayMetrics.cancelledOrderCount}건`
            : ''}
          {displayMetrics.pendingDetailQuantity > 0
            ? ` · 동기화 ${displayMetrics.pendingDetailQuantity}개`
            : ''}
        </span>
      </header>

      <OwnerRecoveryBanner
        accountHint={accountHint}
        onSwitchAccount={onSwitchAccount}
      />
      <OwnerBackupControls
        status={backupStatus}
        onExport={onExportBackup}
        onImport={onImportBackup}
      />

      <div className="neighborhood-sync-banner owner-sync-banner">
        <MapPin size={16} />
        <div>
          <strong>내 관리 상품 주문</strong>
          <span>고객 지역과 관계없이 내가 관리할 수 있는 주문을 표시합니다. {formatLocation(location)}은 픽업·통계 기준입니다.</span>
        </div>
      </div>
      <OwnerWorkspaceNotice status={workspaceStatus} onRetry={onRetryWorkspace} />
      {actionError && <p className="form-error" role="alert" aria-live="assertive">{actionError}</p>}

      <div className="owner-order-flow">
        {ORDER_STAGES.map((stage, index) => (
          <React.Fragment key={stage.id}>
            <span>{stage.label}</span>
            {index < ORDER_STAGES.length - 1 && <i>→</i>}
          </React.Fragment>
        ))}
      </div>

      {orders.length === 0 && summaries.length === 0 && workspaceStatus === 'ready' ? (
        <EmptyCustomerState
          icon={ShoppingBag}
          title="신규 주문이 없습니다"
          body="사용자가 공동구매에 참여하면 여기서 상태를 변경할 수 있습니다."
          actionLabel="상품 등록으로"
          onAction={onBack}
        />
      ) : (
        <div className="owner-order-list">
          {summaries.map(({ deal, pendingQuantity, centralQuantity }) => (
            <article className="owner-order-card" key={`summary-${deal.id}`}>
              <div className="owner-order-heading">
                <div>
                  <span>서버 주문 집계</span>
                  <h2>{deal.title}</h2>
                </div>
                <strong>주문 {centralQuantity}개</strong>
              </div>
              <p>{deal.store} · 상세 주문 {pendingQuantity}개 동기화 중</p>
              <div className="manual-payment-state">
                <div>
                  <strong>주문 수량은 정상 반영됨</strong>
                  <span>사용자별 연락처와 상태는 서버에서 다시 불러오고 있습니다.</span>
                </div>
              </div>
            </article>
          ))}
          {orders.map((order) => {
            const cancelled = isCancelledOrder(order);
            const stage = getOrderStage(order);
            const paymentStatus = getOrderPaymentStatus(order);
            const groupedPayment = Boolean(order.groupId);
            const callablePhone = callableKoreanMobilePhone(order.customerPhone);
            const canAdvancePayment = paymentStatus === 'requested'
              || (!groupedPayment && paymentStatus === 'pending');
            return (
              <article className={cancelled ? 'owner-order-card cancelled' : 'owner-order-card'} key={order.id}>
                <div className="owner-order-heading">
                  <div>
                    <span>{cancelled ? '참여 취소' : stage.label}</span>
                    <h2>{order.title}</h2>
                  </div>
                  <strong>{formatWon(order.total)}</strong>
                </div>
                <p>{order.method} · {order.time} · 수량 {order.selectedCount ?? order.quantity ?? 1}개</p>
                <p className="owner-customer-contact">
                  <User size={14} />
                  <strong>{order.customerName || '테스트 사용자'}</strong>
                  {callablePhone
                    ? <a href={`tel:${callablePhone}`}>{formatKoreanMobilePhoneInput(callablePhone)}</a>
                    : <span>{order.customerPhone && order.customerPhone !== '미설정' ? '연락처 형식 확인 필요' : '연락처 미수집'}</span>}
                </p>
                {cancelled ? (
                  <div className="manual-payment-state cancelled">
                    <div>
                      <strong>사용자 참여 취소 완료</strong>
                      <span>이 주문의 수량은 공동구매 집계에서 제외되었습니다.</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={`manual-payment-state ${paymentStatus}`}>
                      <div>
                        <strong>{paymentStatus === 'confirmed'
                          ? '입금완료'
                          : paymentStatus === 'requested' ? '입금확인요청' : '입금대기'}</strong>
                        <span>{paymentStatus === 'confirmed'
                          ? '사용자 화면에도 입금 완료 상태가 반영됩니다.'
                          : paymentStatus === 'requested'
                            ? '사용자가 “입금했어요”를 눌렀습니다. 실제 입금을 확인해 주세요.'
                            : groupedPayment
                              ? '사용자가 입금확인을 요청하면 여기에서 완료 처리할 수 있습니다.'
                              : '실제 입금·결제를 확인한 뒤 눌러주세요.'}</span>
                      </div>
                      <button
                        className="secondary-button compact-button"
                        disabled={Boolean(busyAction) || (paymentStatus !== 'confirmed' && !canAdvancePayment)}
                        onClick={() => runOwnerAction(
                          `payment-${order.id}`,
                          () => onPaymentConfirm(order.id, paymentStatus === 'confirmed' ? 'previous' : 'next'),
                        )}
                      >
                        {busyAction === `payment-${order.id}`
                          ? '반영 중…'
                          : paymentStatus === 'confirmed'
                            ? '입금완료 취소'
                            : paymentStatus === 'requested' ? '입금완료 처리' : groupedPayment ? '요청 대기' : '입금완료 처리'}
                      </button>
                    </div>
                    <div className={order.customerPickupConfirmedAt ? 'owner-customer-confirm active' : 'owner-customer-confirm'}>
                      <User size={14} />
                      {order.customerPickupConfirmedAt ? '사용자 픽업 확인 완료' : '사용자 픽업 확인 대기'}
                    </div>
                  </>
                )}
                <div className="owner-order-actions">
                  <code>{order.id}</code>
                  {cancelled ? (
                    <span className="completed-order-label">취소 처리 완료</span>
                  ) : (
                    <>
                      {ORDER_STAGES.findIndex((item) => item.id === stage.id) > 0 && (
                        <button
                          className="secondary-button compact-button"
                          disabled={Boolean(busyAction)}
                          onClick={() => runOwnerAction(
                            `status-previous-${order.id}`,
                            () => onStatusChange(order.id, 'previous'),
                          )}
                        >
                          {busyAction === `status-previous-${order.id}` ? '반영 중…' : '이전 단계'}
                        </button>
                      )}
                      {stage.action ? (
                        <button
                          className="primary-button compact-button"
                          disabled={Boolean(busyAction)}
                          onClick={() => runOwnerAction(
                            `status-next-${order.id}`,
                            () => onStatusChange(order.id, 'next'),
                          )}
                        >
                          {busyAction === `status-next-${order.id}` ? '반영 중…' : stage.action}
                        </button>
                      ) : (
                        <span className="completed-order-label">
                          {order.customerPickupConfirmedAt && order.paymentConfirmedAt ? '거래 검증 완료' : '사장님 처리 완료'}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Dashboard({ analyticsReady, orders }) {
  useScreenAnalytics('analytics_dashboard');
  const events = useEvents();
  const central = useCentralStats();
  const [qr, setQr] = useState('');

  useEffect(() => {
    QRCode.toDataURL(window.location.href, { width: 180, margin: 1 }).then(setQr);
  }, []);

  const localStats = useMemo(() => buildStats(events), [events]);
  const stats = useMemo(() => mergeCentralStats(localStats, central.stats), [localStats, central.stats]);
  const commerceStats = useMemo(() => buildCommerceStats(orders), [orders]);

  return (
    <section className="dashboard">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">User Validation / Data Validation</p>
          <h1>검증 대시보드</h1>
        </div>
        <div className="status-pill active">
          {analyticsReady ? 'PostHog + Google Sheets 연동' : 'Google Sheets 중앙 수집'}
        </div>
      </header>

      <div className="metric-grid">
        <Metric label="방문자" value={stats.visitors} />
        <Metric label="상품 등록" value={stats.ownerCreated} />
        <Metric label="상세 진입" value={stats.openListing} />
        <Metric label="참여 완료" value={stats.completed} />
        <Metric label="그룹 생성" value={stats.groupCreated} />
        <Metric label="호스트 지원 클릭" value={stats.hostApplyClicked} />
        <Metric label="호스트 지원 완료" value={stats.hostApplyCompleted} />
        <Metric label="설문 제출자" value={stats.surveys} />
        {RELEASE_FEATURES.sharing && <Metric label="공유 클릭" value={stats.shares} />}
        <Metric label="총 이벤트(발생)" value={stats.totalEvents} />
      </div>
      <p className="metric-note">
        {central.error
          ? central.stats
            ? `중앙 통계 재연결 중 · 마지막 성공 반영 ${central.updatedAt}`
            : '중앙 통계를 불러오지 못해 현재 브라우저 기록을 표시하고 있습니다.'
          : central.stats
            ? `전체 사용자 중앙 데이터 · 30초마다 자동 갱신 · 마지막 반영 ${central.updatedAt}`
            : '전체 사용자 중앙 데이터를 불러오는 중입니다.'}
      </p>

      <div className="dashboard-layout">
        <div className="dashboard-section csv-guide-section">
          <div className="section-title">
            <div>
              <h2>전체 데이터 확인</h2>
              <p>대시보드 지표에 필요한 핵심 검증 이벤트는 Google Sheets로 자동 전송됩니다.</p>
            </div>
          </div>
          <ol className="csv-guide-list">
            <li><code>전체 이벤트</code> 탭에서 원본 기록을 확인합니다.</li>
            <li><code>설문 응답</code> 탭에서 고객번호·이름·연락처와 각 문항 답변을 한 줄로 확인합니다.</li>
            <li>웹 <code>검증 대시보드</code>에서 전체 방문자·참여·설문·지역 지표를 30초 단위로 확인합니다.</li>
            <li>필요한 경우 시트에서 CSV 또는 Excel로 내려받습니다.</li>
          </ol>
          <p className="evidence-note">
            {analyticsReady
              ? <>전체 행동은 PostHog로 분석하고, 대시보드 핵심 지표와 수명주기 이벤트는 Google Sheets에 원본으로 보관합니다. 설문은 <code>설문 응답</code> 탭에 읽기 쉬운 열로 자동 정리됩니다.</>
              : <>PostHog 키는 아직 설정되지 않았습니다. 대시보드 핵심 지표와 수명주기 이벤트는 <code>전체 이벤트</code>, 설문은 <code>설문 응답</code> 탭에 중앙 수집됩니다.</>}
          </p>
        </div>

        <div className="dashboard-section">
          <div className="section-title">
            <h2>Funnel</h2>
            <button className="secondary-button compact-button" onClick={exportEventsCsv}>
              <Download size={16} />
              CSV
            </button>
          </div>
          <div className="funnel-list">
            {stats.funnel.map((stage, index) => (
              <div className="funnel-row" key={stage.label}>
                <div>
                  <span>{index + 1}</span>
                  <strong>{stage.label}</strong>
                </div>
                <div className="funnel-bar">
                  <i style={{ width: `${stage.rate}%` }} />
                </div>
                <b>{stage.count}</b>
              </div>
            ))}
          </div>
        </div>

        <div className="dashboard-section commerce-proof-section">
          <div className="section-title">
            <div>
              <h2>Wizard of Oz 거래 검증</h2>
              <p>사용자 참여와 사장님 처리, 사용자 픽업 확인을 주문별로 연결합니다.</p>
            </div>
            <button className="secondary-button compact-button" onClick={() => exportOrdersCsv(orders)}>
              <Download size={16} />
              거래 CSV
            </button>
          </div>
          <p className="evidence-note">결제·정산 증빙이 아닌 MVP 행동 기록입니다. 수동 결제 확인, 사장님 픽업 완료, 사용자 수령 확인이 모두 있을 때만 ‘양측 검증 완료’로 집계합니다.</p>
          <div className="commerce-metric-grid">
            <Metric label="참여 주문" value={commerceStats.orderCount} />
            <Metric label="참여 취소" value={commerceStats.cancelledCount} />
            <Metric label="수동 결제 확인" value={commerceStats.paymentConfirmedCount} />
            <Metric label="사장님 수락" value={commerceStats.acceptedCount} />
            <Metric label="사장님 픽업 완료" value={commerceStats.ownerCompletedCount} />
            <Metric label="사용자 픽업 확인" value={commerceStats.customerConfirmedCount} />
            <Metric label="양측 검증 완료" value={commerceStats.verifiedCount} />
            <Metric label="참여 거래액" value={formatWon(commerceStats.candidateAmount)} />
            <Metric label="결제 확인 거래액" value={formatWon(commerceStats.paymentConfirmedAmount)} />
            <Metric label="검증 완료 거래액" value={formatWon(commerceStats.verifiedAmount)} />
          </div>
          <div className="transaction-table">
            <div className="transaction-head">
              <span>주문</span>
              <strong>결제</strong>
              <strong>사장님</strong>
              <strong>사용자</strong>
              <strong>검증</strong>
            </div>
            {commerceStats.rows.length === 0 && <p className="empty-state">참여 주문이 생기면 여기에 거래 이력이 표시됩니다.</p>}
            {commerceStats.rows.map((row) => (
              <div className={row.cancelled ? 'cancelled' : ''} key={row.id}>
                <span>
                  <b>{row.title}</b>
                  <code>{row.id}</code>
                  <small>{row.neighborhood} · {formatWon(row.total)}</small>
                </span>
                <strong>{row.cancelled ? '취소' : row.paymentConfirmed ? '확인' : '대기'}</strong>
                <strong>{row.ownerStatus}</strong>
                <strong>{row.cancelled ? '취소' : row.customerConfirmed ? '픽업 확인' : '확인 대기'}</strong>
                <strong className={row.verified ? 'verified' : ''}>
                  {row.cancelled ? '집계 제외' : row.verified ? '완료' : '검증 중'}
                </strong>
              </div>
            ))}
          </div>
        </div>

        <div className="dashboard-section event-breakdown-section">
          <div className="section-title">
            <div>
              <h2>이벤트 종류별 집계</h2>
              <p>발생 횟수와 고유 사용자 수를 나란히 표시합니다.</p>
            </div>
          </div>
          <div className="breakdown-table">
            <div className="breakdown-head">
              <span>이벤트</span>
              <strong>발생</strong>
              <strong>고유 사용자</strong>
            </div>
            {stats.eventBreakdown.map((row) => (
              <div key={row.name}>
                <span>
                  <b>{row.label}</b>
                  <code>{row.name}</code>
                </span>
                <strong>{row.count}</strong>
                <strong>{row.visitors}</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="dashboard-section">
          <div className="section-title">
            <div>
              <h2>지역별 이벤트</h2>
              <p>중앙 수집되는 핵심 검증 이벤트에 지역 값이 태그되며 30초마다 자동 갱신됩니다.</p>
            </div>
          </div>
          <div className="neighborhood-stats">
            {stats.neighborhoodBreakdown.map((row) => (
              <div key={row.location}>
                <span>{row.location}</span>
                <strong>{row.count}건</strong>
                <small>{row.visitors}명</small>
              </div>
            ))}
          </div>
        </div>

        <div className="dashboard-section">
          <div className="section-title">
            <div>
              <h2>현재 기기 화면 체류시간</h2>
              <p>전체 사용자 체류시간은 PostHog에서 확인합니다.</p>
            </div>
          </div>
          <div className="dwell-list">
            {stats.dwell.map((row) => (
              <div key={row.screen}>
                <span>{row.screen}</span>
                <strong>{row.seconds}s</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="dashboard-section">
          <div className="section-title">
            <div>
              <h2>현재 기기 설문 미리보기</h2>
              <p>전체 응답과 연락처는 Google Sheets의 <code>설문 응답</code> 탭에서 확인합니다.</p>
            </div>
          </div>
          <SurveyResponses rows={stats.surveyRows} />
        </div>

        <div className="dashboard-section qr-section">
          <div className="section-title">
            <h2>테스트 접속</h2>
          </div>
          {qr ? <img src={qr} alt="테스트 URL QR 코드" /> : <QrCode size={80} />}
          <button
            className="secondary-button"
            onClick={() => {
              navigator.clipboard?.writeText(window.location.href);
              track('test_url_copied', {});
            }}
          >
            <Copy size={16} />
            URL 복사
          </button>
        </div>
      </div>
    </section>
  );
}

function EventMonitor({ analyticsReady }) {
  const events = useEvents();
  const recent = events.filter((event) => isEventVisibleInRelease(event.name)).slice(-8).reverse();
  const isRecording = events.length > 0;

  return (
    <aside className="event-monitor">
      <div className="monitor-header">
        <div>
          <p className="eyebrow">Tracking</p>
          <h2>이벤트 로그</h2>
        </div>
        <span className={(analyticsReady || isRecording) ? 'dot active' : 'dot'} />
      </div>

      <p className="evidence-note">
        {analyticsReady
          ? 'PostHog와 Google Sheets에 중앙 수집 중입니다.'
          : 'Google Sheets 중앙 수집 중 · 이 화면은 현재 브라우저 기록만 보여주며 전체 합산은 통합 시트에서 확인합니다.'}
      </p>

      <div className="visitor-box">
        <span>고객번호</span>
        <code>{getCustomerNumber()}</code>
      </div>

      <div className="monitor-actions">
        <button className="secondary-button compact-button" onClick={exportEventsCsv}>
          <Download size={16} />
          CSV
        </button>
        <button className="ghost-button" onClick={clearEvents}>
          초기화
        </button>
      </div>

      <div className="event-list">
        {recent.length === 0 && <p className="empty-state">이벤트가 쌓이면 여기에 표시됩니다.</p>}
        {recent.map((event) => (
          <div key={event.id} className="event-row">
            <strong>{event.name}</strong>
            <span>
              {event.properties?.neighborhood || '미설정'} ·{' '}
              {new Date(event.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}
      </div>

      <div className="definition-list">
        <h3>이벤트 정의</h3>
        {visibleEventDefinitions.map((event) => (
          <div key={event.name}>
            <span>{event.label}</span>
            <code>{event.name}</code>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Progress({ deal }) {
  const {
    ordered,
    target,
    remaining,
    participants,
    targetPeople,
  } = getDealQuantity(deal);
  const rate = clamp(Math.round((ordered / target) * 100), 0, 100);
  const tracksQuantity = Boolean(deal.quantityTracking);
  const isCustomerGroup = deal.source === 'customer';
  const groupStatus = deal.groupStatus || 'recruiting';
  const quantityLabel = groupStatus === 'recruiting'
    ? `남은 ${remaining}개 / 총 ${target}개`
    : `${GROUP_STATUS_LABELS[groupStatus] || '모집 종료'} · 배정 ${ordered}개 / 총 ${target}개`;
  return (
    <div className="progress-wrap">
      <div className="progress-label">
        <span>{tracksQuantity
          ? isCustomerGroup
            ? `참여 ${participants}명 / 목표 ${targetPeople}명`
            : `참여 ${participants}명 · 주문 ${ordered}개`
          : `참여 ${ordered}명`}</span>
        <strong>{tracksQuantity ? quantityLabel : `목표 ${target}명`}</strong>
      </div>
      <div className="progress-bar">
        <i style={{ width: `${rate}%` }} />
      </div>
    </div>
  );
}

function Counter({ label = '수량', value, onMinus, onPlus }) {
  return (
    <div className="counter">
      <button type="button" onClick={onMinus} aria-label={`${label} 감소`}>
        <Minus size={14} />
      </button>
      <strong>{value}</strong>
      <button type="button" onClick={onPlus} aria-label={`${label} 증가`}>
        <Plus size={14} />
      </button>
    </div>
  );
}

function FieldCounter({ label, value, onMinus, onPlus }) {
  return (
    <div className="field-counter">
      <span>{label}</span>
      <Counter label={label} value={value} onMinus={onMinus} onPlus={onPlus} />
    </div>
  );
}

function BottomNav({ active, onSelect, adminMode = false, readOnly = false }) {
  const items = filterCustomerNavigation([
    { id: 'home', screen: 'list', label: '홈', icon: Home },
    { id: 'explore', screen: 'explore', label: '탐색', icon: Users },
    { id: 'calculator', screen: 'calculator', label: '계산', icon: Calculator },
    { id: 'orders', screen: 'orders', label: '내 주문', icon: ShoppingBag },
    { id: 'favorites', screen: 'favorites', label: '찜', icon: Heart },
    { id: 'profile', screen: 'profile', label: '마이', icon: User },
  ], { adminMode, readOnly });

  return (
    <nav className="bottom-nav" style={{ '--nav-count': items.length }}>
      {items.map(({ id, screen, label, icon: Icon }) => (
        <button
          key={id}
          className={active === id ? 'active' : ''}
          aria-current={active === id ? 'page' : undefined}
          onClick={() => {
            track('bottom_tab_clicked', { tab: id });
            onSelect(screen);
          }}
        >
          <Icon size={18} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SurveyResponses({ rows }) {
  const pageSize = 5;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = rows.slice(safePage * pageSize, (safePage + 1) * pageSize);

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  return (
    <>
      <div className="survey-table">
        {rows.length === 0 && <p className="empty-state">아직 제출된 설문이 없습니다.</p>}
        {visibleRows.map((row) => (
          <div key={row.id}>
            <span>
              <b>{row.testerName}</b><br />
              <code>{row.customerNumber}</code><br />
              <small>{row.submittedAt}</small><br />
              {row.reason}
            </span>
            <span>{row.hostIntent}</span>
            <strong>{row.revisitIntent}</strong>
          </div>
        ))}
      </div>
      {rows.length > pageSize && (
        <div className="survey-pagination">
          <button className="ghost-button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>이전</button>
          <span>{safePage + 1} / {pageCount} · 총 {rows.length}건</span>
          <button className="ghost-button" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>다음</button>
        </div>
      )}
    </>
  );
}

function useEvents() {
  const [events, setEvents] = useState(() => getEvents());

  useEffect(() => {
    const update = () => setEvents(getEvents());
    window.addEventListener('o2o-events-updated', update);
    return () => window.removeEventListener('o2o-events-updated', update);
  }, []);

  return events;
}

function useCentralStats() {
  const [state, setState] = useState({ stats: null, updatedAt: '', error: false });

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const response = await fetch('/api/stats', { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !result.ok || !result.stats) throw new Error('central_stats_failed');
        if (active) {
          setState({
            stats: result.stats,
            updatedAt: new Date(result.stats.generatedAt || Date.now()).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            error: false,
          });
        }
      } catch {
        if (active) setState((current) => ({ ...current, error: true }));
      } finally {
        inFlight = false;
      }
    };
    load();
    const timer = window.setInterval(load, 30000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', load);
    window.addEventListener('online', load);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener('online', load);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  return state;
}

function mergeCentralStats(localStats, centralStats) {
  if (!centralStats) return { ...localStats, totalEvents: localStats.totalEvents || 0 };
  const counts = centralStats.eventCounts || {};
  const unique = centralStats.uniqueByEvent || {};
  const eventLabelByName = new Map(visibleEventDefinitions.map((definition) => [definition.name, definition.label]));
  const visibleBreakdown = (centralStats.eventBreakdown || [])
    .filter((row) => isEventVisibleInRelease(row.name));
  return {
    ...localStats,
    visitors: centralStats.visitors || 0,
    ownerCreated: counts.owner_product_created || 0,
    openListing: counts.open_listing || 0,
    completed: counts.purchase_completed || 0,
    groupCreated: counts.group_created || 0,
    hostApplyClicked: counts.host_apply_clicked || 0,
    hostApplyCompleted: (counts.host_apply_completed || 0) + (counts.host_applied || 0),
    surveys: unique.survey_submitted || 0,
    shares: RELEASE_FEATURES.sharing ? counts.share_clicked || 0 : 0,
    totalEvents: visibleBreakdown.length
      ? visibleBreakdown.reduce((sum, row) => sum + Number(row.count || 0), 0)
      : localStats.totalEvents,
    funnel: centralStats.funnel || localStats.funnel,
    neighborhoodBreakdown: centralStats.neighborhoodBreakdown || localStats.neighborhoodBreakdown,
    eventBreakdown: visibleBreakdown.map((row) => ({
      ...row,
      label: eventLabelByName.get(row.name) || row.name,
    })),
  };
}

function buildStats(events) {
  events = events.filter((event) => isEventVisibleInRelease(event.name));
  const unique = (predicate) => new Set(events.filter(predicate).map((event) => event.visitorId)).size;
  const visitors = new Set(events.map((event) => event.visitorId)).size;
  const eventLabelByName = new Map(visibleEventDefinitions.map((definition) => [definition.name, definition.label]));
  const funnelSeed = Math.max(1, unique((event) => event.name === 'screen_view' && event.properties.screen === 'deal_list'));
  const funnel = [
    { label: '리스트 방문', count: unique((event) => event.name === 'screen_view' && event.properties.screen === 'deal_list') },
    { label: '상세 진입', count: unique((event) => event.name === 'open_listing') },
    { label: '참여 시작', count: unique((event) => event.name === 'join_started') },
    { label: '참여 완료', count: unique((event) => event.name === 'purchase_completed') },
    { label: '설문 제출', count: unique((event) => event.name === 'survey_submitted') },
  ].map((stage) => ({ ...stage, rate: Math.min(100, Math.round((stage.count / funnelSeed) * 100)) }));

  const dwellMap = events
    .filter((event) => event.name === 'screen_dwell')
    .reduce((acc, event) => {
      const screen = event.properties.screen;
      acc[screen] = acc[screen] || [];
      acc[screen].push(event.properties.dwell_ms || 0);
      return acc;
    }, Object.create(null));

  const dwell = Object.entries(dwellMap)
    .map(([screen, values]) => ({
      screen,
      seconds: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length / 1000),
    }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 6);

  const surveyRows = events
    .filter((event) => event.name === 'survey_submitted')
    .slice()
    .reverse()
    .map((event) => ({
      id: event.id,
      testerName: event.properties.tester_name || '이름 미수집',
      customerNumber: event.properties.customer_number || getCustomerNumber(event.visitorId),
      submittedAt: new Date(event.timestamp).toLocaleString('ko-KR'),
      reason: event.properties.reason,
      hostIntent: event.properties.hostIntent,
      revisitIntent: event.properties.revisitIntent,
    }));

  const eventGroups = events.reduce((acc, event) => {
    acc[event.name] = acc[event.name] || { count: 0, visitors: new Set() };
    acc[event.name].count += 1;
    acc[event.name].visitors.add(event.visitorId);
    return acc;
  }, Object.create(null));

  const eventBreakdown = Object.entries(eventGroups)
    .map(([name, group]) => ({
      name,
      label: eventLabelByName.get(name) || name,
      count: group.count,
      visitors: group.visitors.size,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const neighborhoodGroups = events.reduce((acc, event) => {
    const location = [
      event.properties?.region,
      event.properties?.district,
      event.properties?.neighborhood || '미설정',
    ].filter(Boolean).join(' · ');
    acc[location] = acc[location] || { count: 0, visitors: new Set() };
    acc[location].count += 1;
    acc[location].visitors.add(event.visitorId);
    return acc;
  }, Object.create(null));

  const neighborhoodBreakdown = Object.entries(neighborhoodGroups)
    .map(([location, group]) => ({
      location,
      count: group.count,
      visitors: group.visitors.size,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    visitors,
    ownerCreated: events.filter((event) => event.name === 'owner_product_created').length,
    openListing: events.filter((event) => event.name === 'open_listing').length,
    completed: events.filter((event) => event.name === 'purchase_completed').length,
    groupCreated: events.filter((event) => event.name === 'group_created').length,
    hostApplyClicked: events.filter((event) => event.name === 'host_apply_clicked').length,
    hostApplyCompleted: events.filter((event) => ['host_apply_completed', 'host_applied'].includes(event.name)).length,
    surveys: unique((event) => event.name === 'survey_submitted'),
    shares: events.filter((event) => event.name === 'share_clicked').length,
    totalEvents: events.length,
    funnel,
    dwell,
    surveyRows,
    eventBreakdown,
    neighborhoodBreakdown,
  };
}

export default App;
