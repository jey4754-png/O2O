import { callDataApiJson, fetchUpstreamJson } from './_data-upstream.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const ORDER_EVENT = 'customer_order_snapshot';
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const CAPABILITY_HASH_PATTERN = /^[a-f0-9]{64}$/;
const OWNER_DEAL_ID_PATTERN = /^owner-[a-zA-Z0-9-]{1,100}$/;
const OWNER_CLAIM_LIMIT = 50;

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

function capabilityProof(body, serviceRequest, {
  hashField,
  tokenField,
  missingCode,
  invalidCode,
  required = true,
} = {}) {
  if (serviceRequest) {
    const hash = text(body[hashField], 64).toLowerCase();
    if (!hash && !required) return '';
    if (!CAPABILITY_HASH_PATTERN.test(hash)) throw requestError(invalidCode, 403);
    return hash;
  }
  const token = text(body[tokenField], 256);
  if (!token && !required) return '';
  if (token.length < 32) throw requestError(missingCode, 403);
  return sha256(token);
}

function ownerClaims(body, serviceRequest) {
  const input = body?.ownerClaims ?? body?.capabilities;
  if (!Array.isArray(input) || input.length < 1 || input.length > OWNER_CLAIM_LIMIT) {
    throw requestError('invalid_owner_claims');
  }
  const seen = new Set();
  return input.map((claim) => {
    const dealId = String(claim?.dealId ?? '');
    if (!OWNER_DEAL_ID_PATTERN.test(dealId) || seen.has(dealId)) {
      throw requestError('invalid_owner_claims');
    }
    seen.add(dealId);
    let ownerCapabilityHash = '';
    if (serviceRequest) {
      const hash = String(claim?.ownerCapabilityHash ?? '').toLowerCase();
      if (!CAPABILITY_HASH_PATTERN.test(hash)) {
        throw requestError('invalid_owner_capability', 403);
      }
      ownerCapabilityHash = hash;
    } else {
      const token = String(claim?.capabilityToken ?? '');
      if (token.length < 32) throw requestError('missing_owner_capability', 403);
      if (token.length > 256) throw requestError('invalid_owner_capability', 403);
      ownerCapabilityHash = sha256(token);
    }
    return { dealId, ownerCapabilityHash };
  });
}

function participantProof(body, serviceRequest, order) {
  if (!order?.groupId) return '';
  return capabilityProof(body, serviceRequest, {
    hashField: 'participantCapabilityHash',
    tokenField: 'participantCapabilityToken',
    missingCode: 'missing_participant_capability',
    invalidCode: 'invalid_participant_capability',
  });
}

function manageRequest(body, serviceRequest) {
  const managerType = text(body.managerType, 30);
  const orderId = text(body.orderId, 40);
  const dealId = text(body.dealId, 128);
  const kind = text(body.kind, 40);
  const direction = text(body.direction, 20);
  const expectedVersion = number(body.expectedVersion);
  const clientMutationId = text(body.clientMutationId, 128);
  if (!['merchant_owner', 'group_manager'].includes(managerType)) {
    throw requestError('invalid_manager_type');
  }
  if (!/^order-\d{10,20}$/.test(orderId)) throw requestError('invalid_order_id');
  if (!ID_PATTERN.test(dealId)) throw requestError('invalid_deal_id');
  if (!['order_status', 'payment_status'].includes(kind)) throw requestError('invalid_manage_kind');
  if (!['next', 'previous'].includes(direction)) throw requestError('invalid_direction');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw requestError('invalid_expected_version');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(clientMutationId)) {
    throw requestError('invalid_client_mutation_id');
  }

  const payload = {
    orderId,
    dealId,
    managerType,
    kind,
    direction,
    expectedVersion,
    clientMutationId,
  };
  if (managerType === 'merchant_owner') {
    payload.ownerCapabilityHash = capabilityProof(body, serviceRequest, {
      hashField: 'ownerCapabilityHash',
      tokenField: 'ownerCapabilityToken',
      missingCode: 'missing_owner_capability',
      invalidCode: 'invalid_owner_capability',
    });
    return payload;
  }

  payload.actorId = text(body.actorId, 128);
  if (!ID_PATTERN.test(payload.actorId)) throw requestError('invalid_actor_id');
  if (serviceRequest) {
    payload.adminAssertion = body.adminAssertion === true;
    if (!payload.adminAssertion) {
      payload.capabilityHash = capabilityProof(body, true, {
        hashField: 'capabilityHash',
        tokenField: 'capabilityToken',
        missingCode: 'missing_capability_token',
        invalidCode: 'invalid_capability',
      });
    }
  } else if (body.adminPin) {
    verifyAdminPin(body.adminPin);
    payload.adminAssertion = true;
  } else {
    payload.capabilityHash = capabilityProof(body, false, {
      hashField: 'capabilityHash',
      tokenField: 'capabilityToken',
      missingCode: 'missing_capability_token',
      invalidCode: 'invalid_capability',
    });
  }
  return payload;
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
  const reservationMutationId = text(input.reservationMutationId || input.clientMutationId, 128);
  if (groupId && (!ID_PATTERN.test(groupId) || groupId !== dealId)) return null;
  if (reservationMutationId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(reservationMutationId)) {
    return null;
  }
  return {
    id: text(input.id, 40),
    createdAt: text(input.createdAt, 80),
    statusUpdatedAt: text(input.statusUpdatedAt, 80),
    status: text(input.status || 'new', 40),
    paymentStatus: ['pending', 'requested', 'confirmed', 'cancelled'].includes(input.paymentStatus)
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
    reservationMutationId,
    reservationAction: text(input.reservationAction, 30),
    reservationQuantity: number(input.reservationQuantity),
    type: text(input.type, 30),
    method: text(input.method, 30),
    time: text(input.time, 80),
    deadline: text(input.deadline, 80),
    selectedCount: number(input.selectedCount),
    quantity: number(input.quantity),
    unitPrice: number(input.unitPrice),
    total: number(input.total),
    hostRemainderApplied: number(input.hostRemainderApplied),
    title: text(input.title || deal.title, 200),
    store: text(input.store || deal.store, 120),
    customerPickupConfirmedAt: text(input.customerPickupConfirmedAt, 80),
    paymentRequestedAt: text(input.paymentRequestedAt, 80),
    paymentConfirmedAt: text(input.paymentConfirmedAt, 80),
    cancelledAt: text(input.cancelledAt, 80),
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
  const { upstream, result } = await fetchUpstreamJson(collectorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: collectorToken, ...body }),
    redirect: 'follow',
  });
  if (!upstream.ok || !result.ok) throw new Error(result.error || 'collector_failed');
  return result;
}

async function dataApiRequest(body) {
  const token = serviceSecret();
  const proxied = await callDataApiJson('/api/customer-orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-o2o-service-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!proxied) return null;
  if (!proxied.upstream.ok || !proxied.result.ok) {
    throw new Error(proxied.result.error || 'data_api_failed');
  }
  return proxied.result;
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

async function listOwnerOrders(body, serviceRequest) {
  const claims = ownerClaims(body, serviceRequest);
  const proxied = serviceRequest
    ? null
    : await dataApiRequest({ action: 'list_owner', ownerClaims: claims });
  const result = proxied || await directCollector({
    action: 'customer_orders_owner',
    ownerClaims: claims,
  });
  return normalizedOrders(result.orders);
}

async function publishOrder(order, proof, participantCapabilityHash = '', allowProxy = true) {
  const request = {
    action: 'publish',
    order,
    visitorId: proof.visitorId,
    customerCapabilityHash: proof.customerCapabilityHash,
    ...(participantCapabilityHash ? { participantCapabilityHash } : {}),
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
    ...(participantCapabilityHash ? { participantCapabilityHash } : {}),
  });
  const published = sanitizeOrder(result.order || order);
  if (!published) throw new Error('invalid_published_order');
  if (result.legacyEventStored !== true) {
    try {
      await publishLegacyOrderEvent(published, proof.customerCapabilityHash);
    } catch {
      // The canonical order is already durable; legacy analytics must not turn it into a failed checkout.
    }
  }
  return published;
}

async function manageOrder(payload, allowProxy = true) {
  const request = { action: 'manage', ...payload };
  const proxied = allowProxy ? await dataApiRequest(request) : null;
  const result = proxied || await directCollector({ action: 'manage_order', payload });
  const managed = sanitizeOrder(result.order);
  if (!managed) throw new Error('invalid_managed_order');
  return managed;
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
      order.cancelledAt || '',
      order.selectedCount || order.quantity || '',
      order.total || '',
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
    'missing_participant_capability',
    'invalid_participant_capability',
    'missing_owner_capability',
    'invalid_owner_capability',
    'forbidden',
  ].includes(code)) return 403;
  if ([
    'order_owner_conflict',
    'order_ownership_unclaimable',
    'order_deal_conflict',
    'order_identity_conflict',
    'order_reservation_conflict',
    'order_reservation_unverified',
    'order_transition_forbidden',
    'order_manager_mismatch',
    'deal_ownership_unclaimable',
    'client_mutation_conflict',
    'invalid_state_transition',
    'quantity_unavailable',
    'state_conflict',
  ].includes(code)) return 409;
  if (['group_not_found', 'participant_not_found', 'deal_not_found', 'order_not_found'].includes(code)) {
    return 404;
  }
  if (String(code).includes('not_configured')) return 503;
  if (code === 'collector_busy') return 503;
  if (code === 'upstream_timeout') return 504;
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
  if (!['list', 'list_owner', 'publish', 'list_group', 'manage'].includes(action)) {
    return response.status(400).json({ ok: false, error: 'invalid_action' });
  }
  if (action === 'list_owner') {
    try {
      const orders = await listOwnerOrders(request.body || {}, serviceRequest);
      return response.status(200).json({ ok: true, orders });
    } catch (error) {
      const code = error.code || error.message || 'owner_order_sync_failed';
      return response.status(error.status || statusForOrderError(code)).json({ ok: false, error: code });
    }
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
  if (action === 'manage') {
    try {
      const payload = manageRequest(request.body || {}, serviceRequest);
      const order = await manageOrder(payload, !serviceRequest);
      return response.status(200).json({ ok: true, order });
    } catch (error) {
      const code = error.code || error.message || 'order_manage_failed';
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
      const participantCapabilityHash = participantProof(request.body || {}, serviceRequest, order);
      const published = await publishOrder(order, proof, participantCapabilityHash, !serviceRequest);
      return response.status(202).json({ ok: true, order: published });
    }
    const orders = await listOrders(customerPhone, proof, !serviceRequest);
    return response.status(200).json({ ok: true, orders });
  } catch (error) {
    const code = error.code || error.message || 'order_sync_failed';
    return response.status(error.status || statusForOrderError(code)).json({ ok: false, error: code });
  }
}
