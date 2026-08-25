import posthog from 'posthog-js';
import { useEffect, useMemo, useRef } from 'react';

const VISITOR_KEY = 'o2o_mvp_visitor_id';
const PROFILE_KEY = 'o2o_mvp_profile';
const EVENTS_KEY = 'o2o_mvp_events';
const SESSION_KEY = 'o2o_mvp_session_id';
const POSTHOG_PRIVATE_KEYS = new Set([
  'customer_phone',
  'customer_name',
  'tester_name',
  'user_name',
  'display_name',
  'sender_name',
  'sender_nickname',
  'participant_name',
  'participant_nickname',
  'host_name',
  'admin_name',
  'phone',
  'phone_number',
  'mobile',
  'mobile_number',
  'tel',
  'telephone',
  'contact',
  'contact_info',
  'email',
  'name',
  'nickname',
  'message',
  'messages',
  'message_text',
  'message_body',
  'chat_text',
  'chat_body',
  'chat_message',
  'chat_messages',
  'chat_history',
  'conversation',
  'conversation_history',
  'body',
  'content',
  'text',
  'el_text',
  'last_message',
  'latest_message',
  'feedback',
  'note',
  'memo',
  'description',
  'address',
  'pickup_place',
  'title',
  'group_title',
]);

function normalizeAnalyticsKey(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isPosthogPrivateKey(key) {
  const normalized = normalizeAnalyticsKey(key);
  if (POSTHOG_PRIVATE_KEYS.has(normalized)) return true;

  return (
    /(?:^|_)(?:customer|tester|user|sender|participant|host|admin|display)_(?:name|nickname)$/.test(normalized)
    || /(?:^|_)(?:phone|phone_number|mobile|mobile_number|tel|telephone|email)(?:$|_)/.test(normalized)
    || /(?:^|_)(?:message|chat)_(?:body|text|content|raw)(?:$|_)/.test(normalized)
    || /(?:^|_)(?:last|latest)_(?:message|chat)(?:$|_)/.test(normalized)
  );
}

let posthogReady = false;
let posthogInitialized = false;
let lastPageviewPath = null;
let volatileVisitorId = null;
let volatileSessionId = null;
let volatileProfile = null;
const centralRequests = new Map();
let centralQueue = Promise.resolve();

function sanitizeAnalyticsProperties(input, {
  maxString = 2000,
  maxTotal = 12000,
  omitKeys = new Set(),
  omitKey = null,
} = {}) {
  const state = { remaining: maxTotal };
  const seen = new WeakSet();

  const sanitize = (value, key = '', depth = 0) => {
    const normalizedKey = normalizeAnalyticsKey(key);
    if (
      state.remaining <= 0
      || omitKeys.has(normalizedKey)
      || (omitKey && omitKey(normalizedKey))
    ) return undefined;
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      if (/^data:/i.test(value)) return undefined;
      const length = Math.min(value.length, maxString, state.remaining);
      state.remaining -= length;
      return value.slice(0, length);
    }
    if (typeof value !== 'object' || depth >= 3) {
      return String(value).slice(0, Math.min(maxString, state.remaining));
    }
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
      return value
        .slice(0, 20)
        .map((item) => sanitize(item, key, depth + 1))
        .filter((item) => item !== undefined);
    }

    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
      if (state.remaining <= 0) break;
      state.remaining -= Math.min(childKey.length, 100);
      const sanitized = sanitize(childValue, childKey, depth + 1);
      if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
  };

  return sanitize(input) || {};
}

function redactPosthogProperties(input, seen = new WeakSet()) {
  if (input === null || input === undefined || typeof input !== 'object') return input;
  if (seen.has(input)) return undefined;
  seen.add(input);

  if (Array.isArray(input)) {
    return input
      .map((item) => redactPosthogProperties(item, seen))
      .filter((item) => item !== undefined);
  }

  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (isPosthogPrivateKey(key)) continue;
    const redacted = redactPosthogProperties(value, seen);
    if (redacted !== undefined) result[key] = redacted;
  }
  return result;
}

function redactPosthogEvent(event) {
  if (!event?.properties) return event;
  return {
    ...event,
    properties: redactPosthogProperties(event.properties),
  };
}

function setLocalItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    if (key !== EVENTS_KEY) {
      try {
        const recentEvents = JSON.parse(localStorage.getItem(EVENTS_KEY) || '[]').slice(-100);
        localStorage.setItem(EVENTS_KEY, JSON.stringify(recentEvents));
        localStorage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function getVisitorId() {
  let stored = null;
  try {
    stored = localStorage.getItem(VISITOR_KEY);
  } catch {
    // Fall back to the stable in-memory identifier below.
  }
  if (stored) return stored;
  if (volatileVisitorId) return volatileVisitorId;

  const next = crypto?.randomUUID?.() ?? `visitor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  volatileVisitorId = next;
  setLocalItem(VISITOR_KEY, next);
  return next;
}

export function getCustomerNumber(visitorId = getVisitorId()) {
  return `UP-${String(visitorId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()}`;
}

export function getSessionId() {
  let stored = null;
  try {
    stored = sessionStorage.getItem(SESSION_KEY);
  } catch {
    // Fall back to the stable in-memory identifier below.
  }
  if (stored) return stored;
  if (volatileSessionId) return volatileSessionId;

  const next = crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  volatileSessionId = next;
  try {
    sessionStorage.setItem(SESSION_KEY, next);
  } catch {
    // Keep a stable in-memory session when browser storage is unavailable.
  }
  return next;
}

export function getProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null') || volatileProfile;
  } catch {
    return volatileProfile;
  }
}

export function saveProfile(profile) {
  volatileProfile = profile;
  setLocalItem(PROFILE_KEY, JSON.stringify(profile));
  if (posthogReady && profile?.consent) identifyProfile(profile);
}

export function flushPendingEvents(profile = getProfile()) {
  if (!profile) return Promise.resolve([]);
  const events = getEvents();
  const pending = events.filter((event) => event.pendingCentral);
  if (pending.length === 0) return Promise.resolve([]);

  const fillProfileValue = (current, fallback) => (
    current && current !== '미설정' ? current : fallback
  );

  const normalized = events.map((event) => {
    if (!event.pendingCentral) return event;
    return {
      ...event,
      pendingCentral: true,
      properties: sanitizeAnalyticsProperties({
        ...event.properties,
        tester_name: fillProfileValue(event.properties?.tester_name, profile.name),
        tester_type: fillProfileValue(event.properties?.tester_type, profile.testerType),
        customer_phone: fillProfileValue(event.properties?.customer_phone, profile.phone),
        customer_number: fillProfileValue(event.properties?.customer_number, getCustomerNumber(event.visitorId)),
        region: fillProfileValue(event.properties?.region, profile.region),
        district: fillProfileValue(event.properties?.district, profile.district),
        neighborhood: fillProfileValue(event.properties?.neighborhood, profile.neighborhood),
      }),
    };
  });

  persistEvents(normalized);
  const pendingIds = new Set(pending.map((event) => event.id));
  return Promise.all(normalized.filter((event) => pendingIds.has(event.id)).map(collectEvent));
}

export function clearProfile() {
  try {
    localStorage.removeItem(PROFILE_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // The in-memory values below are still cleared when storage is unavailable.
  }
  if (posthogInitialized) {
    posthog.reset();
    posthog.opt_out_capturing();
  }
  posthogReady = false;
  lastPageviewPath = null;
  volatileSessionId = null;
  volatileProfile = null;
}

function profileProperties(profile) {
  return {
    customer_number: getCustomerNumber(),
    tester_type: profile.testerType,
    region: profile.region,
    district: profile.district,
    neighborhood: profile.neighborhood,
  };
}

function identifyProfile(profile) {
  posthog.identify(getVisitorId(), profileProperties(profile));
}

export function initAnalytics(profileOverride) {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  const host = import.meta.env.VITE_POSTHOG_HOST || 'https://app.posthog.com';
  const profile = profileOverride || getProfile();

  if (!key || !profile?.consent) return false;
  if (posthogReady) {
    identifyProfile(profile);
    trackPageview();
    return true;
  }

  if (!posthogInitialized) {
    posthog.init(key, {
      api_host: host,
      autocapture: true,
      capture_pageview: false,
      capture_pageleave: true,
      disable_session_recording: false,
      mask_all_text: true,
      mask_all_element_attributes: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '*',
        recordHeaders: false,
        recordBody: false,
      },
      before_send: redactPosthogEvent,
      persistence: 'localStorage',
      person_profiles: 'identified_only',
    });
    posthogInitialized = true;
  }
  posthog.opt_in_capturing({ captureEventName: false });
  identifyProfile(profile);
  posthogReady = true;
  trackPageview();
  return true;
}

export function trackPageview() {
  if (!posthogReady) return false;

  const pagePath = window.location.pathname;
  if (pagePath === lastPageviewPath) return false;
  lastPageviewPath = pagePath;

  posthog.capture('$pageview', {
    $current_url: `${window.location.origin}${window.location.pathname}`,
    $host: window.location.host,
    $pathname: window.location.pathname,
  });
  return true;
}

export function getEvents() {
  try {
    return JSON.parse(localStorage.getItem(EVENTS_KEY) || '[]');
  } catch {
    return [];
  }
}

export function persistEvents(events) {
  for (const limit of [1000, 500, 250, 100]) {
    try {
      localStorage.setItem(EVENTS_KEY, JSON.stringify(events.slice(-limit)));
      window.dispatchEvent(new CustomEvent('o2o-events-updated'));
      return true;
    } catch (error) {
      const isQuotaError = error?.name === 'QuotaExceededError' || error?.code === 22 || error?.code === 1014;
      if (!isQuotaError) break;
    }
  }
  console.warn('브라우저 저장공간이 부족해 이벤트를 로컬에 보관하지 못했습니다. 중앙 수집은 계속 시도합니다.');
  return false;
}

export function clearEvents() {
  try {
    localStorage.removeItem(EVENTS_KEY);
  } catch {
    // The UI still receives the reset signal below.
  }
  window.dispatchEvent(new CustomEvent('o2o-events-updated'));
}

function collectEvent(payload) {
  if (centralRequests.has(payload.id)) return centralRequests.get(payload.id);

  const request = centralQueue.catch(() => undefined).then(async () => {
    try {
      const response = await fetch('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: payload }),
        keepalive: true,
      });
      if (!response.ok) {
        const retryable = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
        if (!retryable && response.status >= 400 && response.status < 500) {
          const events = getEvents();
          const next = events.map((event) => {
            if (event.id !== payload.id) return event;
            const { pendingCentral, ...stored } = event;
            return { ...stored, centralRejected: response.status };
          });
          persistEvents(next);
        }
        return false;
      }
      const events = getEvents();
      const next = events.map((event) => {
        if (event.id !== payload.id) return event;
        const { pendingCentral, ...stored } = event;
        return stored;
      });
      persistEvents(next);
      return true;
    } catch {
      return false;
    } finally {
      centralRequests.delete(payload.id);
    }
  });

  centralRequests.set(payload.id, request);
  centralQueue = request.then(() => undefined, () => undefined);
  return request;
}

export function track(name, properties = {}) {
  const profile = getProfile();
  const normalizedProperties = sanitizeAnalyticsProperties({
    ...properties,
    tester_name: properties.tester_name || profile?.name || '미설정',
    tester_type: properties.tester_type || profile?.testerType || '미설정',
    customer_phone: properties.customer_phone || profile?.phone || '미설정',
    customer_number: properties.customer_number || getCustomerNumber(),
    region: properties.region || profile?.region || '미설정',
    district: properties.district || profile?.district || '미설정',
    neighborhood: properties.neighborhood || profile?.neighborhood || '미설정',
  });
  const payload = {
    id: crypto?.randomUUID?.() ?? `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    visitorId: getVisitorId(),
    sessionId: getSessionId(),
    timestamp: new Date().toISOString(),
    properties: normalizedProperties,
    pendingCentral: true,
  };

  persistEvents([...getEvents(), payload]);
  const collectionPromise = profile ? collectEvent(payload) : Promise.resolve(false);

  if (posthogReady) {
    const posthogProperties = sanitizeAnalyticsProperties(normalizedProperties, {
      maxString: 300,
      maxTotal: 6000,
      omitKeys: POSTHOG_PRIVATE_KEYS,
      omitKey: isPosthogPrivateKey,
    });
    posthog.capture(name, {
      ...posthogProperties,
      visitor_id: payload.visitorId,
      session_id: payload.sessionId,
    });
  }

  return { ...payload, collectionPromise };
}

export function useScreenAnalytics(screenName, properties = {}) {
  const stableProperties = useMemo(() => properties, [JSON.stringify(properties)]);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    startedAt.current = Date.now();
    track('screen_view', { screen: screenName, ...stableProperties });

    return () => {
      track('screen_dwell', {
        screen: screenName,
        dwell_ms: Date.now() - startedAt.current,
        ...stableProperties,
      });
    };
  }, [screenName, stableProperties]);
}

export function exportEventsCsv() {
  const events = getEvents();
  const profile = getProfile();
  const rows = [
    ['timestamp', 'tester_name', 'tester_type', 'customer_number', 'visitorId', 'sessionId', 'event', 'region', 'district', 'neighborhood', 'screen', 'properties'],
    ...events.map((event) => [
      event.timestamp,
      event.properties?.tester_name || profile?.name || '미설정',
      event.properties?.tester_type || profile?.testerType || '미설정',
      event.properties?.customer_number || getCustomerNumber(event.visitorId),
      event.visitorId,
      event.sessionId,
      event.name,
      event.properties?.region || '미설정',
      event.properties?.district || '미설정',
      event.properties?.neighborhood || '미설정',
      event.properties?.screen || '',
      JSON.stringify(event.properties || {}),
    ]),
  ];

  const csv = rows
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safePart = (value, fallback) => String(value || fallback).trim().replace(/[\\/:*?"<>|\s]+/g, '-');
  const tester = safePart(profile?.name, '이름미설정');
  const location = safePart([profile?.district, profile?.neighborhood].filter(Boolean).join('-'), '지역미설정');
  a.download = `o2o-설문-${tester}-${location}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  track('csv_exported', { count: events.length });
}

export function exportOrdersCsv(orders) {
  const purchaseOrders = orders.filter((order) => order.type === 'purchase');
  const historyTimestamp = (order, status) => (
    order.statusHistory?.find((entry) => entry.status === status)?.timestamp || ''
  );
  const rows = [
    [
      'order_id',
      'visitor_id',
      'region',
      'district',
      'neighborhood',
      'deal_id',
      'title',
      'store',
      'total_amount',
      'method',
      'quantity',
      'customer_joined_at',
      'manual_payment_confirmed_at',
      'owner_accepted_at',
      'preparation_completed_at',
      'owner_pickup_completed_at',
      'customer_pickup_confirmed_at',
      'verification_status',
    ],
    ...purchaseOrders.map((order) => [
      order.id,
      order.visitorId || '',
      order.region || order.deal?.region || '미설정',
      order.district || order.deal?.district || '미설정',
      order.neighborhood || order.deal?.neighborhood || '미설정',
      order.dealId,
      order.title,
      order.store,
      Number(order.total || 0),
      order.method,
      order.selectedCount || order.quantity || 1,
      historyTimestamp(order, 'new') || order.createdAt,
      order.paymentConfirmedAt || historyTimestamp(order, 'manual_payment_confirmed'),
      historyTimestamp(order, 'preparing'),
      historyTimestamp(order, 'pickup_waiting'),
      historyTimestamp(order, 'completed'),
      order.customerPickupConfirmedAt || '',
      order.paymentConfirmedAt && order.status === 'completed' && order.customerPickupConfirmedAt
        ? '결제·양측 확인 완료'
        : '검증 중',
    ]),
  ];

  const csv = rows
    .map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `o2o-wizard-of-oz-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  track('transaction_csv_exported', {
    count: purchaseOrders.length,
    verified_count: purchaseOrders.filter(
      (order) => order.paymentConfirmedAt && order.status === 'completed' && order.customerPickupConfirmedAt,
    ).length,
  });
}
