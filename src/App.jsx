import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  cancelGroupParticipation,
  claimGroupHost,
  createMutationId,
  createGroupRoom as initializeGroupRoom,
  fetchGroupSnapshot,
  fetchUnreadCounts,
  getGroupCredential,
  isGroupBackedDeal,
  joinGroupRoom,
  reserveGroupQuantity,
  updateGroupTarget,
} from './groupApi';
import {
  applyMerchantParticipationCancellation,
  canCancelParticipation,
  cancelledOrderSnapshot,
  isCancelledOrder,
} from './participation';
import { buildCommerceStats } from './commerceStats';
import { mergeDeals } from './dealMerge';
import {
  buildGroupNotifications,
  canOpenOrderGroupRoom,
  dealHasGroupRoom,
  hostApplyErrorMessage,
  isDealHostMatched,
  joinSubmitErrorMessage,
} from './customerUi';
import {
  beginCheckoutAttempt,
  canQueueReservedGroupOrder,
  checkoutNeedsDurableOrderSync,
  completeCheckoutAttempt,
  isTerminalOrderSyncError,
  publishCustomerOrderRequest,
} from './checkoutAttempt';
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
  adoptLegacyOwnerScopes,
  assignOwnerDealScope,
  chunkOwnerCapabilities,
  completeOwnerScopeMigration,
  hasCompletedOwnerScopeMigration,
  isOwnerDealId,
  isOwnerDealInScope,
  ownerScopeKey,
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
import { clamp, discountedPrice, formatWon } from './utils';

const fallbackImage =
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=900&q=80';
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
const OWNER_SCOPE_MIGRATION_KEY = 'o2o_mvp_owner_scope_migration_v1';
const CUSTOMER_ORDER_CAPABILITY_KEY = 'o2o_mvp_customer_order_capability_v1';
const GROUP_STATUS_SEEN_KEY = 'o2o_mvp_group_status_seen_v1';
const COUNTED_PARTICIPATIONS_KEY = 'o2o_mvp_counted_participations';
const PUBLIC_DEAL_SYNC_INTERVAL_MS = 10000;
const CUSTOMER_ORDER_SYNC_INTERVAL_MS = 30000;
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

function createClientCapability(prefix) {
  const random = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `${prefix}-${random()}-${random()}-${random()}`;
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

function getCustomerOrderCapability() {
  let capability = '';
  try {
    capability = localStorage.getItem(CUSTOMER_ORDER_CAPABILITY_KEY) || '';
    if (!capability) {
      capability = createClientCapability('customer');
      localStorage.setItem(CUSTOMER_ORDER_CAPABILITY_KEY, capability);
    }
  } catch {
    capability = createClientCapability('customer');
  }
  return capability;
}

function compressImage(file, maxSize = 420, quality = 0.72, maxDataUrlLength = 32000) {
  return new Promise((resolve, reject) => {
    if (!file.type?.startsWith('image/')) {
      reject(new Error('JPG, PNG 형식의 이미지를 사용해 주세요.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('JPG, PNG 형식의 이미지를 사용해 주세요.'));
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          let scale = Math.min(1, maxSize / Math.max(image.width, image.height));
          let nextQuality = quality;

          for (let attempt = 0; attempt < 7; attempt += 1) {
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('canvas_unavailable');
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const output = canvas.toDataURL('image/jpeg', nextQuality);
            if (output.length <= maxDataUrlLength) {
              resolve(output);
              return;
            }
            scale *= 0.76;
            nextQuality = Math.max(0.46, nextQuality - 0.07);
          }

          reject(new Error('이미지 용량이 너무 큽니다. 다른 이미지를 선택해 주세요.'));
        } catch {
          reject(new Error('이 이미지는 처리할 수 없습니다. JPG 또는 PNG 이미지를 선택해 주세요.'));
        }
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function compactImageForSync(source, maxSize = 360, quality = 0.68, maxDataUrlLength = 32000) {
  if (!source?.startsWith('data:image/')) return Promise.resolve(source || fallbackImage);
  if (source.startsWith('data:image/jpeg;base64,') && source.length <= maxDataUrlLength) {
    return Promise.resolve(source);
  }
  return new Promise((resolve) => {
    const image = new Image();
    image.onerror = () => resolve(fallbackImage);
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        let scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        let nextQuality = quality;
        for (let attempt = 0; attempt < 7; attempt += 1) {
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext('2d');
          if (!context) break;
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const output = canvas.toDataURL('image/jpeg', nextQuality);
          if (output.length <= maxDataUrlLength) {
            resolve(output);
            return;
          }
          scale *= 0.76;
          nextQuality = Math.max(0.44, nextQuality - 0.07);
        }
      } catch {
        // Use a stable fallback image when a browser cannot resize the local upload.
      }
      resolve(fallbackImage);
    };
    image.src = source;
  });
}

async function fetchPublicDeals() {
  try {
    const response = await fetch('/api/public-deals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
    });
    const result = await response.json();
    return response.ok && result.ok && Array.isArray(result.deals)
      ? result.deals.map((deal) => migrateMerchantSplitDeal({
        ...migrateLocationFields(deal),
        category: normalizeCategory(deal.category),
      }))
      : [];
  } catch {
    return [];
  }
}

async function fetchOwnedRecords(endpoint, resultKey, capabilities) {
  const batches = chunkOwnerCapabilities(capabilities);
  if (!batches.length) return [];
  try {
    const records = [];
    for (const batch of batches) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_owner', capabilities: batch }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result[resultKey])) return null;
      records.push(...result[resultKey]);
    }
    return records;
  } catch {
    return null;
  }
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

async function publishPublicDeal(deal) {
  try {
    const capabilityToken = getDealCapability(deal.id, { create: true });
    const syncedDeal = {
      ...deal,
      visibility: 'public',
      image: await compactImageForSync(deal.image),
    };
    const response = await fetch('/api/public-deals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', deal: syncedDeal, capabilityToken }),
    });
    const result = await response.json();
    return response.ok && result.ok ? result.deal : null;
  } catch {
    return null;
  }
}

async function fetchCustomerOrders(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return [];
  try {
    const response = await fetch('/api/customer-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'list',
        phone: normalizedPhone,
        visitorId: getVisitorId(),
        customerCapabilityToken: getCustomerOrderCapability(),
      }),
    });
    const result = await response.json();
    return response.ok && result.ok && Array.isArray(result.orders)
      ? result.orders.map((order) => migrateLocationFields(order))
      : [];
  } catch {
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
      order,
      visitorId: order.visitorId || getVisitorId(),
      customerCapabilityToken: getCustomerOrderCapability(),
      ...(order.groupId && participantCredential?.capabilityToken
        ? { participantCapabilityToken: participantCredential.capabilityToken }
        : {}),
    });
  } catch (error) {
    if (options.throwOnError) throw error;
    return null;
  }
}

async function manageCustomerOrder(order, deal, { kind, direction }) {
  const managerType = deal?.source === 'customer' ? 'group_manager' : 'merchant_owner';
  const body = {
    action: 'manage',
    orderId: order.id,
    dealId: order.dealId || deal?.id,
    managerType,
    kind,
    direction,
    expectedVersion: Number(order.version || order.paymentVersion || 1),
    clientMutationId: createMutationId(`manage_${kind}`),
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
  const response = await fetch('/api/customer-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok || !result.ok || !result.order) {
    const error = new Error(result.error || `order_manage_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result.order;
}

async function deletePublicDeal(dealId) {
  try {
    const capabilityToken = getDealCapability(dealId);
    if (!capabilityToken) return false;
    const response = await fetch('/api/public-deals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', dealId, capabilityToken }),
    });
    const result = await response.json();
    return response.ok && result.ok;
  } catch {
    return false;
  }
}

function dealSyncFingerprint(deal) {
  const { syncedAt, ...content } = deal || {};
  return JSON.stringify({ imageSyncVersion: 2, ...content });
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

function loadCreatedDeals() {
  const deals = loadJson(CREATED_DEALS_KEY, []);
  const migrated = deals.map((deal) => migrateMerchantSplitDeal({
    ...migrateLocationFields(deal),
    category: normalizeCategory(deal.category),
    visibility: deal.visibility || 'public',
  }));
  if (JSON.stringify(migrated) !== JSON.stringify(deals)) {
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
    statusHistory: order.statusHistory?.length
      ? order.statusHistory
      : [{ status: order.status || 'new', actor: 'legacy', timestamp: order.createdAt || new Date().toISOString() }],
    ...(order.region ? {} : order.deal || {}),
  }));
  if (JSON.stringify(migrated) !== JSON.stringify(orders)) saveJson(CUSTOMER_ORDERS_KEY, migrated);
  return migrated;
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function isOrderForProfile(order, profile, visitorId) {
  if (!profile) return false;
  const profilePhone = normalizePhone(profile.phone);
  const orderPhone = normalizePhone(order.customerPhone);
  if (profilePhone && orderPhone) return profilePhone === orderPhone;
  return Boolean(visitorId && order.visitorId === visitorId);
}

function orderSyncFingerprint(order) {
  const { syncedAt, ...content } = order || {};
  return JSON.stringify(content);
}

function mergeOrders(...collections) {
  const merged = new Map();
  collections.flat().forEach((order) => {
    if (!order?.id) return;
    const current = merged.get(order.id);
    if (!current) {
      merged.set(order.id, order);
      return;
    }
    const currentTime = new Date(current.statusUpdatedAt || current.syncedAt || current.createdAt || 0).getTime();
    const nextTime = new Date(order.statusUpdatedAt || order.syncedAt || order.createdAt || 0).getTime();
    merged.set(order.id, nextTime >= currentTime ? { ...current, ...order } : { ...order, ...current });
  });
  return [...merged.values()].sort((left, right) => (
    new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()
  ));
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
  const [ownerLocation, setOwnerLocation] = useState(() => loadOwnerLocation());
  const [ownerPreviewMode, setOwnerPreviewMode] = useState(false);
  const [previewLocation, setPreviewLocation] = useState(DEFAULT_LOCATION);
  const [customerScreen, setCustomerScreen] = useState(profile ? 'list' : 'onboarding');
  const [ownerScreen, setOwnerScreen] = useState('form');
  const [createdDeals, setCreatedDeals] = useState(() => loadCreatedDeals());
  const [ownerScopeByDeal, setOwnerScopeByDeal] = useState(() => loadJson(OWNER_DEAL_SCOPES_KEY, {}));
  const [ownedDeals, setOwnedDeals] = useState([]);
  const [ownerWorkspaceScope, setOwnerWorkspaceScope] = useState('');
  const [customerGroups, setCustomerGroups] = useState(() => loadCustomerGroups());
  const [remoteDeals, setRemoteDeals] = useState([]);
  const [orders, setOrders] = useState(() => loadOrders());
  const [ownerOrders, setOwnerOrders] = useState([]);
  const [orderSyncIssues, setOrderSyncIssues] = useState(() => loadJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, {}));
  const [favoriteIds, setFavoriteIds] = useState(() => loadJson(FAVORITES_KEY, []));
  const [hostDealIds, setHostDealIds] = useState(() => loadJson(HOST_DEALS_KEY, []));
  const [selectedDeal, setSelectedDeal] = useState(() => loadCreatedDeals()[0] || sampleDeals[0]);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [statusNotices, setStatusNotices] = useState({});
  const [handledDeepLink, setHandledDeepLink] = useState('');
  const activeOwnerScope = useMemo(() => ownerScopeKey(profile), [profile]);
  const scopedCreatedDeals = useMemo(() => createdDeals.filter((deal) => (
    deal?.source === 'merchant'
    && isOwnerDealInScope(deal.id, ownerScopeByDeal, activeOwnerScope)
  )), [activeOwnerScope, createdDeals, ownerScopeByDeal]);
  const scopedOwnedDeals = ownerWorkspaceScope === activeOwnerScope ? ownedDeals : [];
  const scopedOwnerOrders = ownerWorkspaceScope === activeOwnerScope ? ownerOrders : [];

  const updateOrderSyncIssue = useCallback((orderId, issue = null) => {
    if (!orderId) return;
    setOrderSyncIssues((current) => {
      const next = { ...current };
      if (issue) next[orderId] = issue;
      else delete next[orderId];
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      saveJson(CUSTOMER_ORDER_SYNC_ISSUES_KEY, next);
      return next;
    });
  }, []);

  const deals = useMemo(
    () => mergeDeals(
      createdDeals,
      customerGroups,
      remoteDeals,
      sampleDeals.map((deal) => ({ ...deal, category: normalizeCategory(deal.category) })),
      sampleCommunityGroups.map((deal) => ({ ...deal, category: normalizeCategory(deal.category) })),
    ),
    [createdDeals, customerGroups, remoteDeals],
  );

  useEffect(() => {
    if (route !== '/owner' || !activeOwnerScope) return;
    const migrationState = loadJson(OWNER_SCOPE_MIGRATION_KEY, {});
    const migrationCompleted = hasCompletedOwnerScopeMigration(migrationState, activeOwnerScope);
    const result = adoptLegacyOwnerScopes({
      capabilities: loadJson(PUBLIC_DEAL_CAPABILITIES_KEY, {}),
      scopeByDeal: loadJson(OWNER_DEAL_SCOPES_KEY, {}),
      ownerScope: activeOwnerScope,
      createdDeals,
      events: getEvents(),
      migrationCompleted,
    });
    if (migrationCompleted) return;
    if (result.changed && !saveJson(OWNER_DEAL_SCOPES_KEY, result.scopeByDeal)) return;
    setOwnerScopeByDeal(result.scopeByDeal);
    if (result.migrationCompleted) {
      saveJson(
        OWNER_SCOPE_MIGRATION_KEY,
        completeOwnerScopeMigration(migrationState, activeOwnerScope, new Date().toISOString()),
      );
    }
  }, [activeOwnerScope, createdDeals, route]);

  useEffect(() => {
    setOwnedDeals([]);
    setOwnerOrders([]);
    setOwnerWorkspaceScope(activeOwnerScope);
    setOwnerScreen('form');
  }, [activeOwnerScope]);

  useEffect(() => {
    setSelectedDeal((current) => {
      const latest = deals.find((deal) => deal.id === current?.id);
      return latest && latest !== current ? latest : current;
    });
  }, [deals]);

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
        const next = await fetchUnreadCounts({ adminMode: route === '/admin' });
        if (!cancelled) setUnreadCounts(next);
      } finally {
        refreshingUnread = false;
      }
    };
    refreshUnread();
    const timer = window.setInterval(refreshUnread, 10000);
    const handleFocus = () => refreshUnread();
    window.addEventListener('focus', handleFocus);
    window.addEventListener('o2o-group-fallback-updated', handleFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('o2o-group-fallback-updated', handleFocus);
    };
  }, [profile, route]);

  useEffect(() => {
    if (!RELEASE_FEATURES.unreadBadges || !profile || !['/customer', '/admin'].includes(route)) {
      setStatusNotices({});
      return;
    }
    const actorId = route === '/admin' ? `${getVisitorId()}_admin` : getVisitorId();
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
  }, [deals, profile, route]);

  const acknowledgeGroupStatus = (deal) => {
    if (!RELEASE_FEATURES.unreadBadges) return;
    const status = deal?.groupStatus || 'recruiting';
    if (!deal?.id || status === 'recruiting') return;
    const actorId = route === '/admin' ? `${getVisitorId()}_admin` : getVisitorId();
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
    setCustomerScreen(destination === 'room' ? 'room' : 'detail');
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
        const [nextDeals, nextOrders] = await Promise.all([
          fetchOwnedPublicDeals(capabilities),
          fetchOwnedCustomerOrders(capabilities),
        ]);
        if (cancelled) return;
        if (nextDeals) setOwnedDeals(nextDeals);
        if (nextOrders) setOwnerOrders(nextOrders);
        setOwnerWorkspaceScope(activeOwnerScope);
      } finally {
        refreshing = false;
      }
    };
    const handleVisible = () => {
      if (document.visibilityState === 'visible') refreshOwnerWorkspace();
    };
    refreshOwnerWorkspace();
    const timer = window.setInterval(refreshOwnerWorkspace, CUSTOMER_ORDER_SYNC_INTERVAL_MS);
    window.addEventListener('focus', refreshOwnerWorkspace);
    window.addEventListener('online', refreshOwnerWorkspace);
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOwnerWorkspace);
      window.removeEventListener('online', refreshOwnerWorkspace);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [activeOwnerScope, ownerScopeByDeal, route]);

  useEffect(() => {
    if (!RELEASE_FEATURES.deepLinks || !profile || !['/customer', '/admin'].includes(route)) return;
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
  }, [deals, handledDeepLink, profile, route]);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        const next = await fetchPublicDeals();
        if (!cancelled) setRemoteDeals(next);
      } finally {
        refreshing = false;
      }
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
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let syncing = false;
    const syncPendingDeals = async () => {
      if (syncing) return;
      const localPublicDeals = [...scopedCreatedDeals, ...customerGroups]
        .filter((deal) => deal.visibility === 'public');
      if (!localPublicDeals.length) return;
      const fingerprints = loadJson(PUBLIC_DEAL_SYNCED_KEY, {});
      const pending = localPublicDeals.filter(
        (deal) => fingerprints[deal.id] !== dealSyncFingerprint(deal),
      );
      if (!pending.length) return;
      syncing = true;
      try {
        const published = [];
        for (const deal of pending) {
          if (cancelled) break;
          published.push(await publishPublicDeal(deal));
        }
        if (cancelled) return;
        const valid = published.filter(Boolean);
        if (!valid.length) return;
        const nextFingerprints = { ...loadJson(PUBLIC_DEAL_SYNCED_KEY, {}) };
        valid.forEach((deal) => {
          const local = localPublicDeals.find((item) => item.id === deal.id);
          if (local) nextFingerprints[deal.id] = dealSyncFingerprint(local);
        });
        saveJson(PUBLIC_DEAL_SYNCED_KEY, nextFingerprints);
        setRemoteDeals((current) => mergeDeals(valid, current));
      } finally {
        syncing = false;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') syncPendingDeals();
    };
    syncPendingDeals();
    const timer = window.setInterval(syncPendingDeals, 15000);
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
    const handlePopState = () => {
      setRoute(normalizeRoute(window.location.pathname));
      setHandledDeepLink('');
    };
    const handleStorage = (event) => {
      if (event.key === CREATED_DEALS_KEY) setCreatedDeals(loadCreatedDeals());
      if (event.key === OWNER_DEAL_SCOPES_KEY) {
        setOwnerScopeByDeal(loadJson(OWNER_DEAL_SCOPES_KEY, {}));
      }
      if (event.key === CUSTOMER_GROUPS_KEY) setCustomerGroups(loadCustomerGroups());
      if (event.key === CUSTOMER_ORDERS_KEY) setOrders(loadOrders());
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
    const retry = () => flushPendingEvents(profile);
    retry();
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 15000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(timer);
    };
  }, [profile]);

  useEffect(() => {
    const profilePhone = normalizePhone(profile?.phone);
    if (!profilePhone) return undefined;
    let cancelled = false;
    let syncing = false;

    const syncOrders = async () => {
      if (syncing) return;
      syncing = true;
      try {
        const visitorId = getVisitorId();
        const matchingLocalOrders = loadOrders()
          .filter((order) => isOrderForProfile(order, profile, visitorId))
          .map((order) => ({ ...order, customerPhone: profilePhone }));
        const fingerprints = loadJson(CUSTOMER_ORDER_SYNCED_KEY, {});
        const pending = matchingLocalOrders.filter(
          (order) => fingerprints[order.id] !== orderSyncFingerprint(order),
        );
        const published = [];
        const syncErrors = [];
        for (const order of pending) {
          if (cancelled) break;
          try {
            published.push(await publishCustomerOrder(order, { throwOnError: true }));
            syncErrors.push(null);
          } catch (error) {
            published.push(null);
            syncErrors.push(error);
          }
        }
        const nextFingerprints = { ...fingerprints };
        pending.forEach((order, index) => {
          if (published[index]) {
            nextFingerprints[order.id] = orderSyncFingerprint(order);
            completeCheckoutAttempt(order.id);
            updateOrderSyncIssue(order.id);
          }
          if (isTerminalOrderSyncError(syncErrors[index])) {
            nextFingerprints[order.id] = orderSyncFingerprint(order);
            updateOrderSyncIssue(order.id, {
              state: 'failed',
              code: syncErrors[index]?.code || syncErrors[index]?.message || 'terminal_request_error',
              updatedAt: new Date().toISOString(),
            });
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

        const centralOrders = await fetchCustomerOrders(profilePhone);
        if (cancelled) return;
        centralOrders.forEach((order) => {
          nextFingerprints[order.id] = orderSyncFingerprint(order);
          completeCheckoutAttempt(order.id);
          updateOrderSyncIssue(order.id);
        });
        saveJson(CUSTOMER_ORDER_SYNCED_KEY, nextFingerprints);
        setOrders((current) => {
          const merged = mergeOrders(current, centralOrders);
          saveJson(CUSTOMER_ORDERS_KEY, merged);
          return JSON.stringify(merged) === JSON.stringify(current) ? current : merged;
        });
      } finally {
        syncing = false;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') syncOrders();
    };
    syncOrders();
    const timer = window.setInterval(syncOrders, CUSTOMER_ORDER_SYNC_INTERVAL_MS);
    window.addEventListener('online', syncOrders);
    window.addEventListener('pageshow', syncOrders);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('online', syncOrders);
      window.removeEventListener('pageshow', syncOrders);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [profile, orders, updateOrderSyncIssue]);

  useEffect(() => {
    if (analyticsReady) trackPageview();
  }, [route, analyticsReady]);

  const navigateTo = (nextRoute) => {
    const normalizedRoute = normalizeRoute(nextRoute);
    window.history.pushState({}, '', normalizedRoute);
    setHandledDeepLink('');
    if (normalizedRoute !== '/customer') setOwnerPreviewMode(false);
    setRoute(normalizedRoute);
    track('app_opened', { app: normalizedRoute.replace('/', '') || 'launcher' });
  };

  const handleProfileSubmit = (nextProfile) => {
    saveProfile(nextProfile);
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
    const linkedGroupId = new URLSearchParams(window.location.search).get('group');
    setCustomerScreen(linkedGroupId ? 'detail' : 'list');
    track('profile_submitted', {
      region: nextProfile.region,
      district: nextProfile.district,
      neighborhood: nextProfile.neighborhood,
      tester_type: nextProfile.testerType,
    });
  };

  const handleLogout = () => {
    track('profile_logged_out', { neighborhood: profile?.neighborhood || '미설정' });
    clearProfile();
    setAnalyticsReady(false);
    setProfile(null);
    setCustomerScreen('onboarding');
  };

  const handleNeighborhoodChange = (location) => {
    if (!location) return;
    const nextLocation = normalizeLocation(location);
    if (!profile && ownerPreviewMode) {
      if (sameLocation(nextLocation, previewLocation)) return;
      const previousLocation = previewLocation;
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
    }
    track('owner_neighborhood_changed', {
      from_region: previousLocation.region,
      from_district: previousLocation.district,
      from_neighborhood: previousLocation.neighborhood,
      ...nextLocation,
    });
  };

  const addOwnerDeal = (ownerProduct, editingId = null) => {
    if (!activeOwnerScope || (editingId && !isOwnerDealInScope(
      editingId,
      ownerScopeByDeal,
      activeOwnerScope,
    ))) {
      return false;
    }
    const previous = editingId
      ? scopedCreatedDeals.find((deal) => deal.id === editingId)
        || scopedOwnedDeals.find((deal) => deal.id === editingId)
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
    const dealId = editingId || `owner-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
    const capabilityToken = getDealCapability(dealId, {
      create: true,
      ownerScope: activeOwnerScope,
    });
    if (!capabilityToken) return false;
    setOwnerScopeByDeal(loadJson(OWNER_DEAL_SCOPES_KEY, {}));
    const deal = {
      id: dealId,
      createdAt: previous?.createdAt || new Date().toISOString(),
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
    setCreatedDeals((current) => {
      const next = editingId
        ? [deal, ...current.filter((item) => item.id !== editingId)]
        : [deal, ...current];
      saveCreatedDeals(next);
      return next;
    });
    setOwnerWorkspaceScope(activeOwnerScope);
    setOwnedDeals((current) => mergeDeals([deal], current.filter((item) => item.id !== deal.id)));
    setSelectedDeal(deal);
    setOwnerScreen('done');
    return true;
  };

  const updateCustomerDeal = async (deal, options = {}) => {
    const updated = {
      ...deal,
      category: normalizeCategory(deal.category),
      visibility: 'public',
      updatedAt: deal.updatedAt || new Date().toISOString(),
    };
    const isLocallyOwned = customerGroups.some((item) => item.id === updated.id);
    if (!options.observed || isLocallyOwned) {
      setCustomerGroups((current) => {
        const next = [updated, ...current.filter((item) => item.id !== updated.id)];
        saveJson(CUSTOMER_GROUPS_KEY, next);
        return next;
      });
    } else {
      setRemoteDeals((current) => mergeDeals([updated], current.filter((item) => item.id !== updated.id)));
    }
    setSelectedDeal(updated);
    if (!options.observed) track('customer_deal_updated', { deal_id: updated.id });
    if (options.sync !== false) {
      const published = await publishPublicDeal(updated);
      if (published) setRemoteDeals((current) => mergeDeals([published], current));
      return published || updated;
    }
    return updated;
  };

  const updateCustomerGroupTarget = async (
    deal,
    targetCount,
    { mutate = true, expectedVersion } = {},
  ) => {
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
    const deleted = await deletePublicDeal(deal.id);
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
    const now = new Date().toISOString();
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
      stateHistory: [],
      likes: 0,
      image: draft.image || draft.baseDeal.image || fallbackImage,
      menu: [
        {
          id: `customer-menu-${Date.now()}`,
          name: draft.title,
          price: productAllocation.unitPrice,
          option: `${draft.category} · 1개 기준`,
        },
      ],
    };
    setCustomerGroups((current) => {
      const next = [group, ...current.filter((item) => item.id !== group.id)];
      saveJson(CUSTOMER_GROUPS_KEY, next);
      return next;
    });
    setSelectedDeal(group);
    track('group_created', {
      deal_id: group.id,
      source: 'customer',
      category: group.category,
      method: draft.method,
      title: group.title,
      target_people: targetPeople,
      total_quantity: totalQuantity,
      creator_quantity: creatorQuantity,
      host_mode: hostMode,
    });
    await initializeGroupRoom({
      deal: group,
      actorId: creatorActorId,
      nickname: profile?.name || '테스트 호스트',
    });
    const published = await publishPublicDeal(group);
    if (published) setRemoteDeals((current) => mergeDeals([published], current));
    return group;
  };

  const saveCustomerOrder = async (order) => {
    const isPurchase = order.type === 'purchase';
    const isGroupPurchase = isPurchase && isGroupBackedDeal(order.deal);
    const actorId = getVisitorId();
    const requestedReservationMutationId = order.reservationMutationId
      || order.clientMutationId
      || (isPurchase ? createMutationId('checkout_quantity') : '');
    const reconciledOrder = isPurchase
      ? orders.find((candidate) => (
          candidate.dealId === order.dealId
          && candidate.visitorId === actorId
          && [candidate.reservationMutationId, candidate.clientMutationId]
            .includes(requestedReservationMutationId)
        ))
      : null;
    if (reconciledOrder) {
      completeCheckoutAttempt(reconciledOrder.id);
      return reconciledOrder;
    }
    const checkoutAttempt = isPurchase
      ? beginCheckoutAttempt({
          ...order,
          actorId,
          groupId: isGroupPurchase ? (order.groupId || order.deal?.groupId || order.deal?.id) : '',
          reservationMutationId: requestedReservationMutationId,
        })
      : null;
    const reservationMutationId = checkoutAttempt?.reservationMutationId
      || requestedReservationMutationId;
    let groupSnapshot = null;
    if (isGroupPurchase) {
      const selectedQuantity = Math.max(1, Number(order.selectedCount || order.quantity || 1));
      const existingCredential = getGroupCredential(order.deal.id, actorId);
      if (
        existingCredential?.reservationAction === 'join'
        && existingCredential.reservationMutationId === reservationMutationId
        && Number(existingCredential.reservationQuantity) === selectedQuantity
      ) {
        const joined = await joinGroupRoom({
          deal: order.deal,
          actorId,
          nickname: profile?.name || '테스트 참여자',
          role: 'member',
          selectedQuantity,
          clientMutationId: reservationMutationId,
        });
        groupSnapshot = joined?.snapshot || null;
      } else if (existingCredential) {
        const reserved = await reserveGroupQuantity(
          order.deal.id,
          selectedQuantity,
          actorId,
          reservationMutationId,
        );
        groupSnapshot = reserved?.snapshot || null;
      } else {
        const joined = await joinGroupRoom({
          deal: order.deal,
          actorId,
          nickname: profile?.name || '테스트 참여자',
          role: 'member',
          selectedQuantity,
          clientMutationId: reservationMutationId,
        });
        groupSnapshot = joined?.snapshot || null;
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
    const newOrder = {
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
      ...(checkoutAttempt
        ? {
            reservationMutationId,
            clientMutationId: reservationMutationId,
          }
        : {}),
    };
    let storedOrder = newOrder;
    const needsDurableOrderSync = checkoutNeedsDurableOrderSync(newOrder);
    let orderSyncQueued = false;
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
        if (!canQueueReservedGroupOrder(newOrder, error)) throw error;
        orderSyncQueued = true;
        updateOrderSyncIssue(newOrder.id, {
          state: 'pending',
          code: error.code || error.message || 'network_error',
          updatedAt: new Date().toISOString(),
        });
        track('order_sync_queued', {
          order_id: newOrder.id,
          deal_id: newOrder.dealId,
          error_code: error.code || error.message || 'network_error',
        });
      }
    }
    setOrders((current) => {
      const next = mergeOrders(current, [storedOrder]);
      saveJson(CUSTOMER_ORDERS_KEY, next);
      return next;
    });
    if (checkoutAttempt && !orderSyncQueued) completeCheckoutAttempt(orderId);
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
    setOwnerOrders((current) => mergeOrders(current, [mergedManagedOrder]));
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

  const confirmCustomerPickup = (orderId) => {
    const order = orders.find((item) => item.id === orderId);
    if (!order || isCancelledOrder(order) || order.type !== 'purchase' || order.customerPickupConfirmedAt) return;
    if (!['pickup_waiting', 'completed'].includes(getOrderStage(order).id)) return;
    const confirmedAt = new Date().toISOString();
    const next = orders.map((item) => (
      item.id === orderId
        ? {
          ...item,
          customerPickupConfirmedAt: confirmedAt,
          statusHistory: [
            ...(item.statusHistory || []),
            { status: 'customer_pickup_confirmed', actor: 'customer', timestamp: confirmedAt },
          ],
        }
        : item
    ));
    setOrders(next);
    saveJson(CUSTOMER_ORDERS_KEY, next);
    track('customer_pickup_confirmed', {
      order_id: orderId,
      deal_id: order.dealId,
      owner_status: getOrderStage(order).id,
      total: Number(order.total || 0),
      confirmed_at: confirmedAt,
      neighborhood: order.neighborhood || order.deal?.neighborhood,
    });
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
    setFavoriteIds((current) => {
      const active = current.includes(deal.id);
      const next = active ? current.filter((id) => id !== deal.id) : [deal.id, ...current];
      saveJson(FAVORITES_KEY, next);
      track('like_clicked', { deal_id: deal.id, active: !active, source: 'customer_tab' });
      return next;
    });
  };

  const applyHost = async (deal) => {
    const properties = { deal_id: deal.id, method: deal.methods?.join(', ') };
    track('host_apply_clicked', properties);
    if (isGroupBackedDeal(deal)) {
      const actorId = getVisitorId();
      const result = await claimGroupHost({
        deal,
        actorId,
      });
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

  const customerProfile = ownerPreviewMode
    ? {
      ...(profile || {}),
      name: profile?.name || '사장님 미리보기',
      ...previewLocation,
      testerType: '사장님',
      consent: true,
    }
    : profile?.testerType === '사장님'
      ? { ...profile, ...ownerLocation }
      : profile;

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
          eyebrow={route === '/customer' ? '사용자 테스트' : route === '/admin' ? '운영 테스트' : '사장님 등록'}
          title={route === '/customer' ? '사용자 앱' : route === '/admin' ? '관리자 앱' : '사장님 앱'}
          active={route.replace('/', '')}
          onNavigate={navigateTo}
        />

        <PhoneFrame>
          {['/customer', '/admin'].includes(route) && (
            route === '/admin' && profile?.testerType !== '관리자' ? (
              <Onboarding onSubmit={handleProfileSubmit} defaultTesterType="관리자" lockTesterType />
            ) : (
              <CustomerApp
                deals={deals}
                profile={route === '/admin' ? profile : customerProfile}
                orders={orders}
                orderSyncIssues={orderSyncIssues}
                favoriteIds={favoriteIds}
                hostDealIds={hostDealIds}
                selectedDeal={selectedDeal}
                screen={customerScreen}
                adminMode={route === '/admin'}
                unreadCounts={unreadCounts}
                statusNotices={statusNotices}
                onProfileSubmit={handleProfileSubmit}
                onSelectDeal={(deal) => {
                  acknowledgeGroupStatus(deal);
                  setSelectedDeal(deal);
                  setCustomerScreen('detail');
                  track('open_listing', {
                    deal_id: deal.id,
                    category: deal.category,
                    store: deal.store,
                    title: deal.title,
                  });
                }}
                onScreen={setCustomerScreen}
                onOpenNotifications={() => {
                  setCustomerScreen('notifications');
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
                editableDealIds={customerGroups.map((deal) => deal.id)}
                onUpdateDeal={updateCustomerDeal}
                onUpdateTarget={updateCustomerGroupTarget}
                onDeleteDeal={removeDeal}
                onConfirmPickup={confirmCustomerPickup}
                onCancelParticipation={cancelParticipation}
                onNeighborhoodChange={handleNeighborhoodChange}
                onLogout={handleLogout}
              />
            )
          )}
          {route === '/owner' && (profile?.testerType !== '사장님' ? (
            <Onboarding onSubmit={handleProfileSubmit} defaultTesterType="사장님" lockTesterType />
          ) : (
            <OwnerApp
              key={activeOwnerScope}
              screen={ownerWorkspaceScope === activeOwnerScope ? ownerScreen : 'form'}
              selectedDeal={selectedDeal}
              deals={deals}
              onScreen={setOwnerScreen}
              onCreate={addOwnerDeal}
              createdDeals={scopedCreatedDeals}
              ownedDeals={scopedOwnedDeals}
              onDeleteDeal={removeDeal}
              orders={orders}
              ownerOrders={scopedOwnerOrders}
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

function StandaloneHeader({ eyebrow, title, active, onNavigate }) {
  const links = [
    { id: 'customer', label: '사용자 앱', path: '/customer', icon: Users },
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

function CustomerApp({
  deals,
  profile,
  orders,
  orderSyncIssues = {},
  favoriteIds,
  hostDealIds,
  selectedDeal,
  screen,
  adminMode = false,
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
  editableDealIds,
  onUpdateDeal,
  onUpdateTarget,
  onDeleteDeal,
  onConfirmPickup,
  onCancelParticipation,
  onNeighborhoodChange,
  onLogout,
}) {
  const visitorId = profile ? getVisitorId() : null;
  const neighborhoodDeals = deals.filter(
    (deal) => deal.visibility === 'public' || !deal.neighborhood || sameLocation(deal, profile),
  );
  const customerOrders = orders.filter(
    (order) => isOrderForProfile(order, profile, visitorId),
  );

  if (!profile || screen === 'onboarding') {
    return <Onboarding onSubmit={onProfileSubmit} />;
  }

  if (screen === 'detail') {
    return (
      <DealDetail
        deal={selectedDeal}
        onBack={() => onScreen('list')}
        onScreen={onScreen}
        isFavorite={favoriteIds.includes(selectedDeal.id)}
        onToggleFavorite={onToggleFavorite}
        hostMatched={isDealHostMatched(selectedDeal, hostDealIds)}
        onHostApply={onHostApply}
        editable={editableDealIds.includes(selectedDeal.id)}
        onUpdateDeal={onUpdateDeal}
        onUpdateTarget={onUpdateTarget}
        onDeleteDeal={async (deal) => {
          await onDeleteDeal(deal);
          onScreen('list');
        }}
        adminMode={adminMode}
        unreadCount={unreadCounts[selectedDeal.id] || 0}
        onOpenRoom={() => onScreen('room')}
      />
    );
  }

  if (screen === 'room') {
    return (
      <GroupRoom
        deal={selectedDeal}
        profile={profile}
        adminMode={adminMode}
        isCreator={editableDealIds.includes(selectedDeal.id)}
        onBack={() => onScreen('detail')}
        onDealUpdate={onUpdateDeal}
        onRead={onRoomRead}
      />
    );
  }

  if (screen === 'notifications') {
    return (
      <NotificationsTab
        notifications={buildGroupNotifications(deals, unreadCounts, statusNotices)}
        onBack={() => onScreen('list')}
        onOpen={onOpenNotification}
      />
    );
  }

  if (screen === 'calculator') {
    return (
      <SplitCalculator
        initialTotal={selectedDeal?.simulation?.total || 39000}
        initialPeople={selectedDeal?.simulation?.people || 3}
        initialProductQuantity={selectedDeal?.simulation?.totalQuantity || selectedDeal?.simulation?.productQuantity || 3}
        initialSelectedQuantity={selectedDeal?.simulation?.creatorQuantity || selectedDeal?.simulation?.creatorProductQuantity || 1}
        onBack={() => onScreen('list')}
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
          onScreen('group');
        }}
      />
    );
  }

  if (screen === 'join') {
    return (
      <JoinFlow
        deal={selectedDeal}
        orders={customerOrders}
        onBack={() => onScreen('detail')}
        onScreen={onScreen}
        onOrderCreate={onOrderCreate}
        onGroupCreate={onGroupCreate}
      />
    );
  }

  if (screen === 'group') {
    return (
      <GroupCreator
        deal={selectedDeal}
        onBack={() => onScreen(selectedDeal.isNewGroup ? 'explore' : 'detail')}
        onScreen={onScreen}
        onOrderCreate={onOrderCreate}
        onGroupCreate={onGroupCreate}
      />
    );
  }

  if (screen === 'complete') {
    return <Completion deal={selectedDeal} onScreen={onScreen} />;
  }

  if (screen === 'survey') {
    return <Survey onScreen={onScreen} />;
  }

  if (screen === 'explore') {
    return (
      <ExploreTab
        deals={neighborhoodDeals}
        hostDealIds={hostDealIds}
        unreadCounts={unreadCounts}
        statusNotices={statusNotices}
        onSelectDeal={onSelectDeal}
        onScreen={onScreen}
      />
    );
  }

  if (screen === 'orders') {
    return (
      <OrdersTab
        orders={customerOrders}
        orderSyncIssues={orderSyncIssues}
        deals={deals}
        onSelectDeal={onSelectDeal}
        onConfirmPickup={onConfirmPickup}
        onCancelParticipation={onCancelParticipation}
        onScreen={onScreen}
      />
    );
  }

  if (screen === 'favorites') {
    return (
      <FavoritesTab
        favoriteDeals={deals.filter((deal) => favoriteIds.includes(deal.id))}
        hostDealIds={hostDealIds}
        unreadCounts={unreadCounts}
        statusNotices={statusNotices}
        onSelectDeal={onSelectDeal}
        onScreen={onScreen}
      />
    );
  }

  if (screen === 'profile') {
    return (
      <ProfileTab
        profile={profile}
        orders={customerOrders}
        favoriteCount={favoriteIds.length}
        onScreen={onScreen}
        onLogout={onLogout}
      />
    );
  }

  return (
    <DealList
      deals={neighborhoodDeals}
      profile={profile}
      hostDealIds={hostDealIds}
      unreadCounts={unreadCounts}
      statusNotices={statusNotices}
      onSelectDeal={onSelectDeal}
      onScreen={onScreen}
      onOpenNotifications={onOpenNotifications}
      onNeighborhoodChange={onNeighborhoodChange}
    />
  );
}

function Onboarding({ onSubmit, defaultTesterType = '사용자', lockTesterType = false }) {
  useScreenAnalytics('onboarding');
  const [form, setForm] = useState({
    name: '',
    phone: '',
    ...DEFAULT_LOCATION,
    testerType: defaultTesterType,
    consent: false,
  });
  const selectedRegion = getRegion(form.region);
  const selectedDistrict = getDistrict(selectedRegion, form.district);
  const disabled = !form.name.trim() || !form.phone.trim() || !form.consent;

  return (
    <section className="screen onboarding-screen">
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
          if (!disabled) onSubmit({ ...form, name: form.name.trim(), phone: form.phone.trim() });
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
            value={form.phone}
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
            placeholder="010-0000-0000"
            inputMode="tel"
          />
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
            {defaultTesterType === '관리자' ? <ShieldCheck size={18} /> : <Store size={18} />}
            <div>
              <strong>{defaultTesterType} 테스트 계정 등록</strong>
              <span>{defaultTesterType === '관리자' ? '관리자 PIN은 그룹 입장 시 별도로 확인합니다.' : '입력한 정보로 상품과 주문을 구분합니다.'}</span>
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
            <span>같은 동네의 사장님 상품과 주문 상태만 표시됩니다.</span>
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

function DealList({ deals, profile, hostDealIds, unreadCounts = {}, statusNotices = {}, onSelectDeal, onScreen, onOpenNotifications, onNeighborhoodChange }) {
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
          <button className="icon-button" aria-label="예상 부담금 계산기" onClick={() => onScreen('calculator')}>
            <Calculator size={20} />
          </button>
          {RELEASE_FEATURES.unreadBadges && (
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

      <div className="neighborhood-sync-banner">
        <MapPin size={16} />
        <div>
          <strong>{profile.neighborhood} 동네 연동 중</strong>
          <span>동네 상품과 전체 공개 테스트 상품을 함께 표시합니다.</span>
        </div>
      </div>

      <div className="search-field">
        <Search size={18} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="매장 또는 상품 검색" />
      </div>

      <button className="calculator-entry-card" onClick={() => onScreen('calculator')}>
        <Calculator size={22} />
        <div><strong>나눠 사면 1인당 얼마일까요?</strong><span>그룹 참여 없이 판매가와 인원만으로 바로 계산</span></div>
        <ChevronRight size={18} />
      </button>

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
            <strong>{profile.neighborhood}에 표시할 공동구매가 없어요</strong>
            <span>다른 지역을 선택하거나 첫 그룹을 만들어보세요.</span>
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

      <BottomNav active="home" onSelect={onScreen} />
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
                {status && <span>거래 상태 · {GROUP_STATUS_LABELS[status] || status}</span>}
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
    <div className="sheet-backdrop" role="dialog" aria-modal="true">
      <div className="bottom-sheet neighborhood-sheet">
        <div className="sheet-header">
          <div>
            <p className="eyebrow">지역별 공동구매</p>
            <h2>지역 설정</h2>
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
        <p className="neighborhood-help">같은 동네로 설정된 사장님 상품, 사용자 그룹, 주문 상태만 서로 연결됩니다.</p>
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
      <img src={deal.image} alt="" />
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

function ExploreTab({ deals, hostDealIds, unreadCounts = {}, statusNotices = {}, onSelectDeal, onScreen }) {
  useScreenAnalytics('customer_explore');
  const urgentDeals = [...deals].sort((a, b) => b.discountRate - a.discountRate);

  return (
    <section className="screen">
      <header className="top-nav">
        <div>
          <p className="eyebrow">탐색</p>
          <h1>지금 모이는 공구</h1>
        </div>
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
      </header>

      <div className="insight-strip">
        <div>
          <span>근처 진행중</span>
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
            <strong>이 지역에 진행 중인 공구가 없어요</strong>
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

      <BottomNav active="explore" onSelect={onScreen} />
    </section>
  );
}

function OrdersTab({ orders, orderSyncIssues = {}, deals, onSelectDeal, onConfirmPickup, onCancelParticipation, onScreen }) {
  useScreenAnalytics('customer_orders', { order_count: orders.length });
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const [cancellingId, setCancellingId] = useState('');
  const [cancelError, setCancelError] = useState(null);

  const handleCancellation = async (order, deal) => {
    if (cancellingId) return;
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

      {orders.length === 0 ? (
        <EmptyCustomerState
          icon={ShoppingBag}
          title="아직 참여 내역이 없습니다"
          body="공동구매에 참여하면 마감 시간과 수령 방식이 여기에 저장됩니다."
          actionLabel="공구 보러가기"
          onAction={() => onScreen('list')}
        />
      ) : (
        <div className="order-card-list">
          {orders.map((order) => {
            const deal = dealById.get(order.dealId) || order.deal;
            const syncIssue = orderSyncIssues[order.id] || null;
            const cancelled = isCancelledOrder(order);
            const orderStage = getOrderStage(order);
            const paymentStatus = getOrderPaymentStatus(order);
            const orderStageIndex = ORDER_STAGES.findIndex((stage) => stage.id === orderStage.id);
            const groupRole = dealHasGroupRoom(deal)
              ? getGroupCredential(deal.id, order.visitorId)?.role || ''
              : '';
            const canCancel = canCancelParticipation(order, deal, groupRole);
            const canOpenRoom = RELEASE_FEATURES.chat && canOpenOrderGroupRoom({
              order,
              deal,
              cancelled,
            });
            const canConfirmPickup = !cancelled && order.type === 'purchase'
              && ['pickup_waiting', 'completed'].includes(orderStage.id)
              && !order.customerPickupConfirmedAt;
            const verificationComplete = !cancelled && order.type === 'purchase'
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
                {order.type === 'purchase' && cancelled ? (
                  <div className="customer-payment-state cancelled">
                    <strong>참여 취소 완료</strong>
                    <span>선택했던 수량이 공동구매의 남은 수량에 다시 반영되었습니다.</span>
                  </div>
                ) : order.type === 'purchase' && (
                  <div className={`customer-payment-state ${paymentStatus}`}>
                    <strong>{paymentStatus === 'confirmed'
                      ? '입금완료'
                      : paymentStatus === 'requested' ? '입금확인요청 전송 완료' : '입금대기'}</strong>
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
                    <button className="primary-button compact-button" onClick={() => onConfirmPickup(order.id)}>
                      <Check size={15} />
                      픽업 완료 확인
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
  onUpdateDeal,
  onUpdateTarget,
  onDeleteDeal,
  adminMode = false,
  unreadCount = 0,
  onOpenRoom,
}) {
  useScreenAnalytics('deal_detail', { deal_id: deal.id, category: deal.category });
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
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
  const recruitmentOpen = (deal.groupStatus || 'recruiting') === 'recruiting';
  const existingGroupCredential = isGroupDeal
    ? getGroupCredential(deal.id, getVisitorId())
    : null;
  const showMerchantRoom = isMerchantGroup && (adminMode || Boolean(existingGroupCredential));
  const newParticipantCapacityReached = isCustomerGroup
    && !existingGroupCredential
    && split.current >= split.people;
  const canHostApply = !hostMatched && (
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
          <button
            className={isFavorite ? 'icon-button liked' : 'icon-button'}
            onClick={() => {
              onToggleFavorite(deal);
            }}
            aria-label="좋아요"
          >
            <Heart size={20} />
          </button>
        </div>
      </header>

      <img className="hero-image" src={deal.image} alt="" />

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
          <button
            className={hostMatched ? 'secondary-button compact-button' : 'primary-button compact-button'}
            onClick={handleHostApply}
            disabled={hostMatched || hostApplying || !canHostApply}
          >
            <Users size={16} />
            {hostMatched ? '확정됨' : !recruitmentOpen ? '모집 종료' : hostApplying ? '지원 중…' : '호스트 지원하기'}
          </button>
          {hostApplyError && <p className="form-error host-apply-error" role="alert" aria-live="assertive">{hostApplyError}</p>}
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

      {editable && (
        <div className="content-block deal-management">
          <div className="deal-management-heading">
            <div>
              <strong>내가 등록한 상품</strong>
              <p>이 기기에서 등록한 상품만 수정하거나 삭제할 수 있습니다.</p>
            </div>
            <button
              className="secondary-button compact-button"
              disabled={editSaving}
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
          <button
            className="danger-button"
            disabled={editSaving}
            onClick={() => {
              if (window.confirm('이 상품을 전체 공개 목록에서 삭제할까요?')) onDeleteDeal(deal);
            }}
          >
            <Trash2 size={16} />
            상품 삭제
          </button>
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
            <button className="secondary-button room-entry-button" onClick={onOpenRoom}>
              {RELEASE_FEATURES.chat ? <MessageCircle size={18} /> : <Check size={18} />}
              {RELEASE_FEATURES.chat ? `그룹 채팅${unreadCount > 0 ? ` · ${Math.min(99, unreadCount)}` : ''}` : '거래 상태 관리'}
            </button>
            {!adminMode && (
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
            {!isMerchantGroup && (
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
            {!adminMode && (
              <button
                className="primary-button"
                onClick={() => {
                  onScreen('join');
                  track(isInstant ? 'instant_checkout_started' : 'join_started', { deal_id: deal.id });
                }}
              >
                <ShoppingBag size={18} />
                {isInstant ? '선착순 할인 받기' : '참여하기'}
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
    input.value = shareUrl;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    return copied;
  };

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true">
      <div className="bottom-sheet">
        <div className="sheet-header">
          <h2>공동구매 링크 공유</h2>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            <X size={20} />
          </button>
        </div>
        <div className="share-summary">
          <img src={deal.image} alt="" />
          <div>
            <strong>{deal.title}</strong>
            <p>{deal.store}</p>
          </div>
        </div>
        <div className="share-grid">
          {channels.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={async () => {
                let completed = true;
                if (id === 'native') {
                  if (navigator.share) {
                    try {
                      await navigator.share({ title: deal.title, text: shareText, url: shareUrl });
                    } catch (shareError) {
                      if (shareError?.name === 'AbortError') return;
                      completed = await copyLink();
                    }
                  } else {
                    completed = await copyLink();
                  }
                }
                if (id === 'copy') completed = await copyLink();
                if (!completed) return;
                track('share_clicked', { channel: id, deal_id: deal.id });
                track('group_shared', { channel: id, group_id: deal.id, deep_link: true });
                if (id === 'message') {
                  window.location.href = `sms:?&body=${encodeURIComponent(`${shareText}\n${shareUrl}`)}`;
                }
                onClose();
              }}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function JoinFlow({ deal, orders = [], onBack, onScreen, onOrderCreate }) {
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
  const reservationMutationIdRef = useRef(createMutationId('checkout_quantity'));
  const isInstant = deal.saleType === 'instant';
  const isCustomerGroup = deal.source === 'customer';

  const selectedCount = Object.values(quantities).reduce((sum, value) => sum + value, 0);
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
            <Counter value={quantities[item.id]} onMinus={() => changeQuantity(item.id, -1)} onPlus={() => changeQuantity(item.id, 1)} />
          </div>
        ))}
      </div>

      <div className="quantity-status-panel">
        <span>총 수량 {target}개</span>
        <strong>{deal.groupStatus && deal.groupStatus !== 'recruiting'
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

      <div className={submitError ? 'sticky-actions single has-message' : 'sticky-actions single'}>
        {submitError && (
          <p className="form-error join-submit-error sticky-action-message" role="alert" aria-live="assertive">
            {submitError}
          </p>
        )}
        <button
          className="primary-button"
          disabled={submitting || selectedCount === 0 || remaining === 0 || (isCustomerGroup && deal.groupStatus !== 'recruiting')}
          onClick={async () => {
            setSubmitting(true);
            setSubmitError('');
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
              track('purchase_completed', { deal_id: deal.id, total, method, time, note, selected_count: selectedCount });
              onScreen('complete');
            } catch (orderError) {
              setSubmitError(joinSubmitErrorMessage(orderError));
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Check size={18} />
          {submitting ? '처리 중…' : isInstant ? '구매 신청 완료' : '참여 완료하기'}
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
  const [imageError, setImageError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
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

  const handleImage = async (file) => {
    if (!file) return;
    setImageProcessing(true);
    setImageError('');
    try {
      const image = await compressImage(file, 900, 0.7);
      setForm((current) => ({ ...current, image }));
      track('group_image_uploaded', { file_type: file.type, size: file.size, compressed: true });
    } catch (error) {
      setImageError(error.message);
    } finally {
      setImageProcessing(false);
    }
  };

  return (
    <section className="screen">
      <header className="top-nav compact">
        <button className="icon-button" onClick={onBack} aria-label="뒤로">
          <ArrowLeft size={22} />
        </button>
        <h1>공동구매 그룹 생성</h1>
        <Heart size={19} />
      </header>

      {!isStandaloneGroup && (
        <div className="content-block">
          <h2>참고 상품</h2>
          <div className="selected-store">
            <img src={deal.image} alt="" />
            <div>
              <strong>{deal.store}</strong>
              <p>{deal.address}</p>
            </div>
          </div>
        </div>
      )}

      <div className="group-image-uploader">
        <img src={form.image || deal.image} alt="" />
        <label className="secondary-button">
          <Upload size={18} />
          {imageProcessing ? '이미지 처리 중…' : '그룹 이미지 변경'}
          <input type="file" accept="image/*" onChange={(event) => handleImage(event.target.files?.[0])} />
        </label>
        {imageError && <p className="form-error">{imageError}</p>}
      </div>

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

      {submitError && <p className="form-error join-submit-error" role="alert">{submitError}</p>}

      <div className="sticky-actions single">
        <button
          className="primary-button"
          onClick={async () => {
            if (submitting) return;
            setSubmitting(true);
            setSubmitError('');
            try {
              const createdGroup = await onGroupCreate({
                ...form,
                groupId: draftGroupIdRef.current,
                baseDeal: deal,
              });
              await onOrderCreate({
                type: 'group',
                dealId: createdGroup.id,
                groupId: createdGroup.groupId || createdGroup.id,
                deal: createdGroup,
                title: createdGroup.title,
                store: createdGroup.store,
                total: form.hostMode === 'self'
                  ? productPreview.hostSelectedAmount
                  : productPreview.selectedAmount,
                method: form.method,
                deadline: `${form.deadlineDate} ${form.deadlineTime}`,
                quantity: productPreview.selectedQuantity,
                selectedCount: productPreview.selectedQuantity,
                hostRemainderApplied: form.hostMode === 'self' ? productPreview.remainder : 0,
              });
              onScreen('room');
            } catch {
              setSubmitError('그룹방을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.');
            } finally {
              setSubmitting(false);
            }
          }}
          disabled={submitting || imageProcessing || !form.title || !form.category || Number(form.totalPrice) <= 0}
        >
          <Users size={18} />
          {submitting ? '그룹방 생성 중…' : '그룹방 생성'}
        </button>
      </div>
    </section>
  );
}

function Completion({ deal, onScreen }) {
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
      {submitError && <p className="form-error">{submitError}</p>}

      <button
        className="primary-button"
        disabled={submitting || submittedLocally}
        onClick={async () => {
          setSubmitting(true);
          setSubmitError('');
          const event = track('survey_submitted', answer);
          const stored = await event.collectionPromise;
          if (stored) {
            onScreen('list');
            return;
          }
          setSubmitting(false);
          setSubmittedLocally(true);
          setSubmitError('네트워크 연결을 확인해 주세요. 응답은 기기에 보관되며 온라인 상태에서 자동으로 다시 전송됩니다.');
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
  createdDeals,
  ownedDeals,
  orders,
  ownerOrders,
  location,
  onScreen,
  onCreate,
  onDeleteDeal,
  onPreviewCustomer,
  onOrderStatusChange,
  onPaymentConfirm,
  onNeighborhoodChange,
}) {
  const [formVersion, setFormVersion] = useState(0);
  const [editingDeal, setEditingDeal] = useState(null);
  const managedOwnerDeals = useMemo(() => {
    const centralById = new Map(deals.map((deal) => [deal.id, deal]));
    return mergeDeals(createdDeals, ownedDeals).map((ownedDeal) => {
      const centralDeal = centralById.get(ownedDeal.id);
      if (!centralDeal) return ownedDeal;
      const orderedQuantity = Number(centralDeal.orderedQuantity ?? centralDeal.current ?? 0);
      return {
        ...ownedDeal,
        orderedQuantity,
        allocatedProductQuantity: orderedQuantity,
        current: orderedQuantity,
        currentCount: Number(centralDeal.currentCount ?? orderedQuantity),
        participantCount: Number(centralDeal.participantCount || 0),
      };
    });
  }, [createdDeals, deals, ownedDeals]);
  const ownerDealIds = useMemo(
    () => new Set(managedOwnerDeals.map((deal) => deal.id)),
    [managedOwnerDeals],
  );
  const neighborhoodOrders = useMemo(() => mergeOrders(ownerOrders, orders).filter(
    (order) => ['purchase', 'group'].includes(order.type)
      && ownerDealIds.has(order.dealId)
      && (!order.neighborhood || sameLocation(order, location)),
  ), [location, orders, ownerDealIds, ownerOrders]);
  const orderSummaries = useMemo(() => managedOwnerDeals.flatMap((deal) => {
    if (!sameLocation(deal, location)) return [];
    const detailedQuantity = neighborhoodOrders
      .filter((order) => order.dealId === deal.id && !isCancelledOrder(order))
      .reduce((total, order) => total + Math.max(1, Number(order.selectedCount ?? order.quantity ?? 1)), 0);
    const centralQuantity = Math.max(0, Number(deal.orderedQuantity ?? deal.current ?? 0));
    const pendingQuantity = Math.max(0, centralQuantity - detailedQuantity);
    return pendingQuantity > 0 ? [{ deal, pendingQuantity, centralQuantity }] : [];
  }), [location, managedOwnerDeals, neighborhoodOrders]);
  const neighborhoodGroups = deals.filter(
    (deal) => deal.source === 'customer' && sameLocation(deal, location),
  );

  if (screen === 'orders') {
    return (
      <OwnerOrders
        orders={neighborhoodOrders}
        summaries={orderSummaries}
        location={location}
        onBack={() => onScreen('form')}
        onStatusChange={onOrderStatusChange}
        onPaymentConfirm={onPaymentConfirm}
      />
    );
  }
  if (screen === 'products') {
    return (
      <OwnerProducts
        deals={managedOwnerDeals}
        onBack={() => onScreen('form')}
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
      onCreate={(payload) => {
        onCreate(payload, editingDeal?.id || null);
        setEditingDeal(null);
      }}
      onOpenOrders={() => onScreen('orders')}
      onOpenProducts={() => onScreen('products')}
      orderCount={neighborhoodOrders.length + orderSummaries.length}
      communityGroups={neighborhoodGroups}
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
  orderCount,
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
  const [imageError, setImageError] = useState('');

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

  const handleImage = async (file) => {
    if (!file) return;
    setImageProcessing(true);
    setImageError('');
    try {
      const image = await compressImage(file);
      setForm((current) => ({ ...current, image }));
      track('owner_image_uploaded', { file_type: file.type, size: file.size, compressed: true });
    } catch (error) {
      setImageError(error.message);
    } finally {
      setImageProcessing(false);
    }
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
            <span>주문 {orderCount}</span>
          </button>
        </div>
      </header>

      <div className="owner-neighborhood-link">
        <div>
          <MapPin size={17} />
          <span>연동 동네</span>
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
        <p>{formatLocation(form)} 사용자에게 상품과 주문 상태가 표시됩니다.</p>
      </div>

      {communityGroups.length > 0 && (
        <div className="content-block owner-community-groups">
          <div>
            <p className="eyebrow">같은 동네 사용자 수요</p>
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

      <div className="owner-image-uploader">
        {form.image ? <img src={form.image} alt="" /> : <Upload size={38} />}
        <label className="secondary-button">
          <Upload size={18} />
          {imageProcessing ? '이미지 처리 중…' : '이미지 변경'}
          <input type="file" accept="image/*" onChange={(event) => handleImage(event.target.files?.[0])} />
        </label>
        {imageError && <p className="form-error">{imageError}</p>}
      </div>

      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const payload = {
            ...form,
            splitQuantity: form.saleType === 'group' ? groupPricePreview.splitQuantity : 1,
            deadline: form.saleType === 'instant'
              ? `${form.eventStart} ~ ${form.eventEnd}`
              : `${form.deadlineDate} ${form.deadlineTime}`,
            calculatedPrice: price,
          };
          track(initialDeal ? 'owner_product_updated' : 'owner_product_created', {
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
          onCreate(payload);
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

        <button className="primary-button" type="submit" disabled={imageProcessing || !form.storeName.trim() || !form.productName.trim() || Number(form.originalPrice) <= 0 || form.methods.length === 0}>
          <Check size={18} />
          {initialDeal ? '상품 수정 완료' : '상품 등록 완료'}
        </button>
      </form>
    </section>
  );
}

function OwnerProducts({ deals, onBack, onEdit, onDelete }) {
  useScreenAnalytics('owner_products', { product_count: deals.length });
  const [busyDealId, setBusyDealId] = useState('');
  const [deleteError, setDeleteError] = useState('');

  const handleDelete = async (deal) => {
    if (!window.confirm('이 상품을 전체 공개 목록에서 삭제할까요?')) return;
    setBusyDealId(deal.id);
    setDeleteError('');
    try {
      const deleted = await onDelete(deal);
      if (!deleted) {
        setDeleteError('상품을 삭제하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.');
      }
    } catch {
      setDeleteError('상품을 삭제하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.');
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
        <Store size={20} />
      </header>
      {deleteError ? <p className="form-error" role="alert" aria-live="assertive">{deleteError}</p> : null}
      {deals.length === 0 ? (
        <EmptyCustomerState
          icon={Store}
          title="등록한 상품이 없습니다"
          body="상품을 등록하면 이 화면에서 수정하거나 삭제할 수 있습니다."
          actionLabel="상품 등록하기"
          onAction={onBack}
        />
      ) : (
        <div className="owner-product-list">
          {deals.map((deal) => {
            const splitMerchant = isSplitMerchantDeal(deal);
            return (
              <article className="owner-product-card" key={deal.id}>
                <img src={deal.image} alt="" />
                <div>
                  <strong>{deal.title}</strong>
                  <p>{deal.store} · {formatLocation(deal)}</p>
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
                </div>
                <div className="owner-product-actions">
                  <button
                    className="secondary-button compact-button"
                    disabled={Boolean(busyDealId)}
                    onClick={() => onEdit(deal)}
                  >
                    <Pencil size={14} />
                    수정
                  </button>
                  <button
                    className="danger-button compact-button"
                    disabled={Boolean(busyDealId)}
                    onClick={() => handleDelete(deal)}
                  >
                    <Trash2 size={14} />
                    {busyDealId === deal.id ? '삭제 중…' : '삭제'}
                  </button>
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
    <section className="screen complete-screen">
      <div className="success-mark">
        <Check size={34} />
      </div>
      <h1>등록 완료</h1>
      <p>{deal.title} {isInstant
        ? '선착순 즉시할인 상품이 사용자 리스트에 반영되었습니다.'
        : '상품과 공동구매가 하나의 카드로 사용자 리스트에 반영되었습니다.'}</p>
      <img className="done-image" src={deal.image} alt="" />
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

function OwnerOrders({ orders, summaries = [], location, onBack, onStatusChange, onPaymentConfirm }) {
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
        <span className="order-count-badge">{location.neighborhood} · {orders.length + summaries.length}건</span>
      </header>

      <div className="neighborhood-sync-banner owner-sync-banner">
        <MapPin size={16} />
        <div>
          <strong>{formatLocation(location)} 주문만 연동 중</strong>
          <span>같은 동네 사용자의 가상 주문과 수동 결제 상태가 표시됩니다.</span>
        </div>
      </div>
      {actionError && <p className="form-error" role="alert" aria-live="assertive">{actionError}</p>}

      <div className="owner-order-flow">
        {ORDER_STAGES.map((stage, index) => (
          <React.Fragment key={stage.id}>
            <span>{stage.label}</span>
            {index < ORDER_STAGES.length - 1 && <i>→</i>}
          </React.Fragment>
        ))}
      </div>

      {orders.length === 0 && summaries.length === 0 ? (
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
                  <a href={`tel:${order.customerPhone || ''}`}>{order.customerPhone || '연락처 미수집'}</a>
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
            ? `전체 사용자 중앙 데이터 · 5초마다 자동 갱신 · 마지막 반영 ${central.updatedAt}`
            : '전체 사용자 중앙 데이터를 불러오는 중입니다.'}
      </p>

      <div className="dashboard-layout">
        <div className="dashboard-section csv-guide-section">
          <div className="section-title">
            <div>
              <h2>전체 데이터 확인</h2>
              <p>모든 사용자의 신규 이벤트는 Google Sheets로 자동 전송됩니다.</p>
            </div>
          </div>
          <ol className="csv-guide-list">
            <li><code>전체 이벤트</code> 탭에서 원본 기록을 확인합니다.</li>
            <li><code>설문 응답</code> 탭에서 고객번호·이름·연락처와 각 문항 답변을 한 줄로 확인합니다.</li>
            <li>웹 <code>검증 대시보드</code>에서 전체 방문자·참여·설문·지역 지표를 5초 단위로 확인합니다.</li>
            <li>필요한 경우 시트에서 CSV 또는 Excel로 내려받습니다.</li>
          </ol>
          <p className="evidence-note">
            {analyticsReady
              ? <>PostHog 행동 분석과 Google Sheets 원본 기록이 함께 수집됩니다. 설문은 <code>설문 응답</code> 탭에 읽기 쉬운 열로 자동 정리됩니다.</>
              : <>PostHog 키는 아직 설정되지 않았습니다. 중요 행동은 <code>전체 이벤트</code>, 설문은 <code>설문 응답</code> 탭에 중앙 수집됩니다.</>}
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
              <p>모든 신규 이벤트에 지역 값이 태그되며 5초마다 자동 갱신됩니다.</p>
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

function Counter({ value, onMinus, onPlus }) {
  return (
    <div className="counter">
      <button type="button" onClick={onMinus} aria-label="감소">
        <Minus size={14} />
      </button>
      <strong>{value}</strong>
      <button type="button" onClick={onPlus} aria-label="증가">
        <Plus size={14} />
      </button>
    </div>
  );
}

function FieldCounter({ label, value, onMinus, onPlus }) {
  return (
    <div className="field-counter">
      <span>{label}</span>
      <Counter value={value} onMinus={onMinus} onPlus={onPlus} />
    </div>
  );
}

function BottomNav({ active, onSelect }) {
  const items = [
    { id: 'home', screen: 'list', label: '홈', icon: Home },
    { id: 'explore', screen: 'explore', label: '탐색', icon: Users },
    { id: 'calculator', screen: 'calculator', label: '계산', icon: Calculator },
    { id: 'orders', screen: 'orders', label: '내 주문', icon: ShoppingBag },
    { id: 'favorites', screen: 'favorites', label: '찜', icon: Heart },
    { id: 'profile', screen: 'profile', label: '마이', icon: User },
  ];

  return (
    <nav className="bottom-nav">
      {items.map(({ id, screen, label, icon: Icon }) => (
        <button
          key={id}
          className={active === id ? 'active' : ''}
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
      if (inFlight) return;
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
    const timer = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
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
