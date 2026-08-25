import { callDataApi } from './_data-upstream.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const CAPABILITY_HASH_PATTERN = /^[a-f0-9]{64}$/;

export const config = {
  maxDuration: 60,
};

function text(value, maxLength = 500) {
  return String(value ?? '').slice(0, maxLength);
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

function ownerCapabilityHash(body, serviceRequest) {
  if (serviceRequest) {
    const hash = text(body.ownerCapabilityHash, 64).toLowerCase();
    if (!CAPABILITY_HASH_PATTERN.test(hash)) throw requestError('invalid_owner_capability', 403);
    return hash;
  }
  const token = text(body.capabilityToken, 256);
  if (token.length < 32) throw requestError('missing_owner_capability', 403);
  return sha256(token);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function stateHistory(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(-100).map((item) => ({
    fromStatus: text(item?.fromStatus ?? item?.before, 50),
    toStatus: text(item?.toStatus ?? item?.after ?? item?.status, 50),
    action: text(item?.action, 80),
    actorId: text(item?.actorId ?? item?.actor, 128),
    actorRole: text(item?.actorRole, 30),
    reason: text(item?.reason, 200),
    clientMutationId: text(item?.clientMutationId, 128),
    version: number(item?.version),
    timestamp: text(item?.timestamp ?? item?.createdAt, 80),
  }));
}

function sanitizeDeal(input) {
  if (!input || !/^(owner|customer)-[a-zA-Z0-9-]{1,100}$/.test(String(input.id || ''))) {
    return null;
  }
  const id = text(input.id, 120);
  const source = input.source === 'customer' ? 'customer' : 'merchant';
  const groupId = text(input.groupId, 128);
  if (source === 'customer' && groupId !== id) return null;
  const totalQuantity = Math.max(1, Math.min(999, Math.floor(number(input.totalQuantity ?? input.target, 1))));
  const orderedQuantity = Math.min(
    totalQuantity,
    Math.max(0, Math.floor(number(input.orderedQuantity ?? input.current, 0))),
  );
  const image = text(input.image, 40000);
  if (
    image
    && !/^https:\/\//.test(image)
    && !/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(image)
  ) {
    return null;
  }
  return {
    id,
    createdAt: text(input.createdAt, 80),
    updatedAt: text(input.updatedAt, 80),
    syncedAt: text(input.syncedAt, 80),
    visibility: 'public',
    source,
    saleType: text(input.saleType, 30),
    category: text(input.category, 50),
    region: text(input.region, 50),
    district: text(input.district, 80),
    neighborhood: text(input.neighborhood, 80),
    store: text(input.store, 120),
    title: text(input.title, 200),
    description: text(input.description, 1000),
    address: text(input.address, 300),
    distance: text(input.distance, 80),
    deadline: text(input.deadline, 80),
    methods: Array.isArray(input.methods) ? input.methods.slice(0, 5).map((item) => text(item, 30)) : [],
    stock: number(input.stock),
    eventStart: text(input.eventStart, 80),
    eventEnd: text(input.eventEnd, 80),
    originalPrice: number(input.originalPrice),
    expectedPerPerson: number(input.expectedPerPerson),
    splitRemainder: number(input.splitRemainder),
    approximatePrice: Boolean(input.approximatePrice),
    discountRate: number(input.discountRate),
    current: number(input.current),
    participantCount: number(input.participantCount),
    quantityTracking: Boolean(input.quantityTracking),
    target: number(input.target),
    minPeople: number(input.minPeople, 1),
    maxPeople: number(input.maxPeople ?? input.target, 20),
    groupId: source === 'customer' ? groupId : '',
    targetCount: number(input.targetCount ?? input.target),
    currentCount: number(input.currentCount ?? input.participantCount),
    groupStatus: ['recruiting', 'recruited', 'purchased', 'delivered'].includes(input.groupStatus)
      ? input.groupStatus
      : '',
    chatLocked: Boolean(input.chatLocked),
    creatorActorId: text(input.creatorActorId, 128),
    hostMode: input.hostMode === 'recruiting' ? 'recruiting' : 'self',
    hostActorId: text(input.hostActorId, 128),
    hostMatched: Boolean(input.hostActorId),
    totalQuantity,
    orderedQuantity,
    lastMessageSeq: number(input.lastMessageSeq),
    version: number(input.version ?? input.stateVersion, 1),
    stateVersion: number(input.stateVersion ?? input.version, 1),
    updatedBy: text(input.updatedBy, 128),
    stateHistory: stateHistory(input.stateHistory),
    likes: number(input.likes),
    image,
    menu: Array.isArray(input.menu)
      ? input.menu.slice(0, 10).map((item) => ({
          id: text(item?.id, 120),
          name: text(item?.name, 200),
          price: number(item?.price),
          option: text(item?.option, 200),
        }))
      : [],
  };
}

function publicResult(result, action) {
  if (!result || typeof result !== 'object') return result;
  const {
    ownerCapabilityHash: _ownerCapabilityHash,
    _ownerCapabilityHash: _storedOwnerCapabilityHash,
    ...safeResult
  } = result;
  if (action === 'list') {
    return {
      ...safeResult,
      deals: (Array.isArray(result.deals) ? result.deals : [])
        .map((deal) => sanitizeDeal(deal))
        .filter(Boolean),
    };
  }
  if (result.deal) {
    return { ...safeResult, deal: sanitizeDeal(result.deal) };
  }
  return safeResult;
}

function statusForError(code) {
  if (['missing_owner_capability', 'invalid_owner_capability', 'forbidden'].includes(code)) return 403;
  if (['deal_ownership_unclaimable', 'deal_owner_conflict'].includes(code)) return 409;
  if (String(code).includes('not_configured')) return 503;
  return 502;
}

async function dataApiRequest(body) {
  const token = serviceSecret();
  const upstream = await callDataApi('/api/public-deals', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-o2o-service-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
  return upstream;
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const serviceRequest = isServiceRequest(request);
  if (request.headers['x-o2o-service-token'] && !serviceRequest) {
    return response.status(403).json({ ok: false, error: 'unauthorized' });
  }
  const origin = request.headers.origin;
  if (!serviceRequest && !isAllowedOrigin(origin, request)) {
    return response.status(403).json({ ok: false, error: 'origin_not_allowed' });
  }

  try {
    if (!request.body || JSON.stringify(request.body).length > 60000) {
      throw requestError('invalid_request_body');
    }
    const action = request.body?.action;
    if (!['list', 'publish', 'delete'].includes(action)) throw requestError('invalid_action');
    const deal = action === 'publish' ? sanitizeDeal(request.body?.deal) : null;
    if (action === 'publish' && !deal) throw requestError('invalid_deal');
    const dealId = action === 'delete' ? text(request.body?.dealId, 120) : '';
    if (action === 'delete' && !/^(owner|customer)-[a-zA-Z0-9-]{1,100}$/.test(dealId)) {
      throw requestError('invalid_deal_id');
    }
    const capabilityHash = action === 'list' ? '' : ownerCapabilityHash(request.body, serviceRequest);
    const upstreamBody = {
      action,
      ...(deal ? { deal } : {}),
      ...(dealId ? { dealId } : {}),
      ...(capabilityHash ? { ownerCapabilityHash: capabilityHash } : {}),
    };

    const proxied = serviceRequest ? null : await dataApiRequest(upstreamBody);
    if (proxied) {
      const result = await proxied.json();
      return response.status(proxied.status).json(publicResult(result, action));
    }

    const collectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    const collectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    if (!collectorUrl || !collectorToken) throw requestError('collector_not_configured', 503);
    const upstream = await fetch(collectorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: collectorToken,
        action: action === 'list'
          ? 'public_deals'
          : action === 'delete'
            ? 'delete_deal'
            : 'publish_deal',
        ...(deal ? { deal } : {}),
        ...(dealId ? { dealId } : {}),
        ...(capabilityHash ? { ownerCapabilityHash: capabilityHash } : {}),
      }),
      redirect: 'follow',
    });
    const result = await upstream.json();
    if (!upstream.ok || !result.ok) {
      const code = result.error || 'collector_failed';
      return response.status(statusForError(code)).json({ ok: false, error: code });
    }
    return response.status(action === 'publish' ? 202 : 200).json(publicResult(result, action));
  } catch (error) {
    const code = error.code || error.message || 'collector_unreachable';
    const status = error.status || (code.startsWith('invalid_') ? 400 : statusForError(code));
    return response.status(status).json({ ok: false, error: code });
  }
}
