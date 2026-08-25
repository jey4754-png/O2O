import { callDataApi } from './_data-upstream.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const ORDER_EVENT = 'customer_order_snapshot';
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const CAPABILITY_HASH_PATTERN = /^[a-f0-9]{64}$/;

export const config = { maxDuration: 60 };

function text(value, maxLength = 500) {
  return String(value ?? '').slice(0, maxLength);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function phone(value) {
  return text(value, 30).replace(/\D/g, '');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function serviceSecret() {
  return process.env.O2O_DATA_API_TOKEN || process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN || '';
}

function isServiceRequest(request) {
  const expected = serviceSecret();
  const actual = request.headers['x-o2o-service-token'];
  return Boolean(expected && actual && safeEqual(actual, expected));
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function requestError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function customerProof(body, serviceRequest) {
  const visitorId = text(body.visitorId, 128);
  if (!ID_PATTERN.test(visitorId)) throw requestError('invalid_order_owner');
  if (serviceRequest) {
    const customerCapabilityHash = text(body.customerCapabilityHash, 64).toLowerCase();
    if (!CAPABILITY_HASH_PATTERN.test(customerCapabilityHash)) {
      throw requestError('invalid_customer_capability', 403);
    }
    return { visitorId, customerCapabilityHash };
  }
  const token = text(body.customerCapabilityToken, 256);
  if (token.length < 32) throw requestError('missing_customer_capability', 403);
  return { visitorId, customerCapabilityHash: sha256(token) };
}

function isAllowedOrigin(originValue, request) {
  if (!originValue) return false;
  try {
    const origin = new URL(originValue);
    const configured = new Set([
      PRODUCTION_ORIGIN,
      ...String(process.env.O2O_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean),
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
      process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : '',
      process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '',
    ].filter(Boolean));
    if (configured.has(origin.origin)) return true;
    if (['localhost', '127.0.0.1', '::1'].includes(origin.hostname)) {
      return ['http:', 'https:'].includes(origin.protocol);
    }
    const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').toLowerCase();
    return origin.protocol === 'https:' && Boolean(host) && origin.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function sanitizeOrder(input) {
  if (!input || !/^order-\d{10,20}$/.test(String(input.id || ''))) return null;
  const customerPhone = phone(input.customerPhone);
  if (customerPhone.length < 8) return null;
  const deal = input.deal || {};
  const dealId = text(input.dealId || deal.id, 120);
  const groupId = text(input.groupId, 128);
  if (groupId && (!ID_PATTERN.test(groupId) || groupId !== dealId)) return null;
  return {
    id: text(input.id, 40),
    createdAt: text(input.createdAt, 80),
    statusUpdatedAt: text(input.statusUpdatedAt, 80),
    status: text(input.status || 'new', 40),
    paymentStatus: ['pending', 'requested', 'confirmed'].includes(input.paymentStatus)
      ? input.paymentStatus
      : 'pending',
    visitorId: text(input.visitorId, 120),
    customerNumber: text(input.customerNumber, 80),
    customerName: text(input.customerName, 100),
    customerPhone,
    region: text(input.region, 50),
    district: text(input.district, 80),
    neighborhood: text(input.neighborhood, 80),
    dealId,
    groupId,
    participantActorId: text(input.participantActorId || input.visitorId, 128),
    type: text(input.type, 30),
    method: text(input.method, 30),
    time: text(input.time, 80),
    deadline: text(input.deadline, 80),
    selectedCount: number(input.selectedCount),
    quantity: number(input.quantity),
    total: number(input.total),
    hostRemainderApplied: number(input.hostRemainderApplied),
    title: text(input.title || deal.title, 200),
    store: text(input.store || deal.store, 120),
    customerPickupConfirmedAt: text(input.customerPickupConfirmedAt, 80),
    paymentRequestedAt: text(input.paymentRequestedAt, 80),
    paymentConfirmedAt: text(input.paymentConfirmedAt, 80),
    version: number(input.version ?? input.paymentVersion, 1),
    paymentVersion: number(input.paymentVersion ?? input.version, 1),
    statusHistory: Array.isArray(input.statusHistory)
      ? input.statusHistory.slice(-100).map((item) => ({
          status: text(item?.status, 50),
          before: text(item?.before ?? item?.fromStatus, 50),
          after: text(item?.after ?? item?.toStatus ?? item?.status, 50),
          actor: text(item?.actor ?? item?.actorId, 128),
          actorRole: text(item?.actorRole, 30),
          action: text(item?.action, 100),
          reason: text(item?.reason, 200),
          clientMutationId: text(item?.clientMutationId, 128),
          version: number(item?.version),
          timestamp: text(item?.timestamp ?? item?.createdAt, 80),
        }))
      : [],
    deal: {
      id: text(deal.id || input.dealId, 120),
      title: text(deal.title || input.title, 200),
      store: text(deal.store || input.store, 120),
      region: text(deal.region || input.region, 50),
      district: text(deal.district || input.district, 80),
      neighborhood: text(deal.neighborhood || input.neighborhood, 80),
    },
  };
}

function normalizedOrders(input) {
  const latest = new Map();
  (Array.isArray(input) ? input : []).forEach((item) => {
    const candidate = sanitizeOrder(item);
    if (!candidate) return;
    const previous = latest.get(candidate.id);
    const candidateTime = Date.parse(candidate.statusUpdatedAt || candidate.createdAt) || 0;
    const previousTime = previous ? Date.parse(previous.statusUpdatedAt || previous.createdAt) || 0 : -1;
    if (!previous || candidateTime >= previousTime) latest.set(candidate.id, candidate);
  });
  return [...latest.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function directCollector(body) {
  const collectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const collectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  if (!collectorUrl || !collectorToken) throw new Error('collector_not_configured');
  const upstream = await fetch(collectorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: collectorToken, ...body }),
    redirect: 'follow',
  });
  const result = await upstream.json();
  if (!upstream.ok || !result.ok) throw new Error(result.error || 'collector_failed');
  return result;
}

async function dataApiRequest(body) {
  const token = serviceSecret();
  const upstream = await callDataApi('/api/customer-orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-o2o-service-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!upstream) return null;
  const result = await upstream.json();
  if (!upstream.ok || !result.ok) throw new Error(result.error || 'data_api_failed');
  return result;
}

async function listOrders(customerPhone, proof, allowProxy = true) {
  const request = {
    action: 'list',
    phone: customerPhone,
    visitorId: proof.visitorId,
    customerCapabilityHash: proof.customerCapabilityHash,
  };
  const proxied = allowProxy ? await dataApiRequest(request) : null;
  const result = proxied || await directCollector({
    action: 'customer_orders',
    phone: customerPhone,
    visitorId: proof.visitorId,
    customerCapabilityHash: proof.customerCapabilityHash,
  });
  return normalizedOrders(result.orders);
}

async function publishOrder(order, proof, allowProxy = true) {
  const request = {
    action: 'publish',
    order,
    visitorId: proof.visitorId,
    customerCapabilityHash: proof.customerCapabilityHash,
  };
  const proxied = allowProxy ? await dataApiRequest(request) : null;
  if (proxied) {
    const proxiedOrder = sanitizeOrder(proxied.order || order);
    if (!proxiedOrder) throw new Error('invalid_published_order');
    return proxiedOrder;
  }
  const result = await directCollector({
    action: 'publish_order',
    order,
    visitorId: proof.visitorId,
    customerCapabilityHash: proof.customerCapabilityHash,
  });
  const published = sanitizeOrder(result.order || order);
  if (!published) throw new Error('invalid_published_order');
  await publishLegacyOrderEvent(published, proof.customerCapabilityHash);
  return published;
}

function legacyOrderEvent(order, customerCapabilityHash) {
  const timestamp = new Date().toISOString();
  const latestHistory = order.statusHistory?.[order.statusHistory.length - 1] || {};
  const storedOrder = {
    ...order,
    _customerCapabilityHash: customerCapabilityHash,
  };
  const fingerprint = createHash('sha256')
    .update([
      order.id,
      order.statusUpdatedAt || order.createdAt || '',
      order.status || '',
      order.paymentStatus || '',
      order.paymentVersion || order.version || '',
      order.paymentRequestedAt || '',
      order.paymentConfirmedAt || '',
      order.customerPickupConfirmedAt || '',
      latestHistory.clientMutationId || latestHistory.timestamp || '',
    ].join('|'))
    .digest('hex')
    .slice(0, 24);
  return {
    id: `order-sync-${fingerprint}`,
    name: ORDER_EVENT,
    timestamp,
    visitorId: order.visitorId || `customer-${order.customerPhone}`,
    sessionId: `order-sync-${order.customerPhone.slice(-4)}`,
    properties: {
      screen: 'customer_orders',
      tester_name: order.customerName,
      tester_type: '사용자',
      customer_number: order.customerNumber,
      customer_phone: order.customerPhone,
      region: order.region,
      district: order.district,
      neighborhood: order.neighborhood,
      order_snapshot: JSON.stringify(storedOrder),
    },
  };
}

async function publishLegacyOrderEvent(order, customerCapabilityHash) {
  await directCollector({ event: legacyOrderEvent(order, customerCapabilityHash) });
}

function verifyAdminPin(pin) {
  const expected = process.env.O2O_ADMIN_PIN;
  if (!expected) throw new Error('admin_not_configured');
  if (!safeEqual(pin, expected)) throw new Error('invalid_admin_pin');
}

async function listGroupOrders(body, serviceRequest) {
  const groupId = text(body.groupId, 128);
  const dealId = text(body.dealId, 128);
  const actorId = text(body.actorId, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(groupId)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(actorId)) {
    throw new Error('invalid_group_order_request');
  }
  const payload = { groupId, dealId, actorId };
  if (serviceRequest) {
    payload.adminAssertion = body.adminAssertion === true;
    payload.capabilityHash = text(body.capabilityHash, 64).toLowerCase();
  } else if (body.adminPin) {
    verifyAdminPin(body.adminPin);
    payload.adminAssertion = true;
  } else {
    const token = text(body.capabilityToken, 256);
    if (token.length < 32) throw new Error('missing_capability_token');
    payload.capabilityHash = sha256(token);
  }
  if (!payload.adminAssertion && !/^[a-f0-9]{64}$/.test(payload.capabilityHash)) {
    throw new Error('invalid_capability');
  }

  const proxied = serviceRequest ? null : await dataApiRequest({ action: 'list_group', ...payload });
  const result = proxied || await directCollector({ action: 'customer_orders_group', payload });
  return normalizedOrders(result.orders);
}

function statusForOrderError(code) {
  if ([
    'invalid_admin_pin',
    'missing_capability_token',
    'invalid_capability',
    'missing_customer_capability',
    'invalid_customer_capability',
    'forbidden',
  ].includes(code)) return 403;
  if (['order_owner_conflict', 'order_ownership_unclaimable'].includes(code)) return 409;
  if (code === 'group_not_found' || code === 'participant_not_found') return 404;
  if (String(code).includes('not_configured')) return 503;
  if (String(code).startsWith('invalid_')) return 400;
  return 502;
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'private, no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const serviceRequest = isServiceRequest(request);
  if (request.headers['x-o2o-service-token'] && !serviceRequest) {
    return response.status(403).json({ ok: false, error: 'unauthorized' });
  }
  if (!serviceRequest && !isAllowedOrigin(request.headers.origin, request)) {
    return response.status(403).json({ ok: false, error: 'origin_not_allowed' });
  }
  if (!request.body || JSON.stringify(request.body).length > 60000) {
    return response.status(400).json({ ok: false, error: 'invalid_request_body' });
  }
  const action = request.body?.action;
  if (!['list', 'publish', 'list_group'].includes(action)) {
    return response.status(400).json({ ok: false, error: 'invalid_action' });
  }
  if (action === 'list_group') {
    try {
      const orders = await listGroupOrders(request.body || {}, serviceRequest);
      return response.status(200).json({ ok: true, orders });
    } catch (error) {
      const code = error.code || error.message || 'group_order_sync_failed';
      return response.status(error.status || statusForOrderError(code)).json({ ok: false, error: code });
    }
  }
  const customerPhone = phone(request.body?.phone || request.body?.order?.customerPhone);
  const order = action === 'publish' ? sanitizeOrder(request.body?.order) : null;
  if (customerPhone.length < 8 || (action === 'publish' && !order)) {
    return response.status(400).json({ ok: false, error: 'invalid_order_request' });
  }
  try {
    const proof = customerProof(request.body || {}, serviceRequest);
    if (order && order.visitorId !== proof.visitorId) throw requestError('invalid_order_owner');
    if (action === 'publish') {
      const published = await publishOrder(order, proof, !serviceRequest);
      return response.status(202).json({ ok: true, order: published });
    }
    const orders = await listOrders(customerPhone, proof, !serviceRequest);
    return response.status(200).json({ ok: true, orders });
  } catch (error) {
    const code = error.code || error.message || 'order_sync_failed';
    return response.status(error.status || statusForOrderError(code)).json({ ok: false, error: code });
  }
}
