import { callDataApiJson, fetchUpstreamJson } from './_data-upstream.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const CAPABILITY_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEAL_ID_PATTERN = /^(owner|customer)-[a-zA-Z0-9-]{1,100}$/;
const OWNER_DEAL_ID_PATTERN = /^owner-[a-zA-Z0-9-]{1,100}$/;
const OWNER_CLAIM_LIMIT = 50;
const EXPLICIT_SPLIT_PRICING_MODEL = 'explicit_split';
const EXPLICIT_SPLIT_PRICING_VERSION = 2;
const MAX_DEAL_IMAGE_LENGTH = 1500000;
const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';
const IMAGE_REFERENCE_PATTERN = /^\/api\/public-deals\?image=[a-f0-9]{64}$/;

export const config = {
  maxDuration: 60,
};

function text(value, maxLength = 500) {
  return String(value ?? '').slice(0, maxLength);
}

export function sanitizeDealImage(value) {
  const image = String(value ?? '');
  if (!image) return '';
  if (image.length > MAX_DEAL_IMAGE_LENGTH) return null;
  if (IMAGE_REFERENCE_PATTERN.test(image)) return image;
  if (/^https:\/\//.test(image)) {
    try {
      const url = new URL(image);
      const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
      // External product images are loaded by the browser, never by this API.
      // Reject local/network literals and local-only names so stored content
      // cannot make a customer's browser probe a private service.
      if (
        url.protocol !== 'https:'
        || url.username
        || url.password
        || (url.port && url.port !== '443')
        || !hostname.includes('.')
        || isIP(hostname)
        || hostname === 'localhost'
        || hostname.endsWith('.localhost')
        || hostname.endsWith('.local')
        || hostname.endsWith('.internal')
      ) return null;
      return image;
    } catch {
      return null;
    }
  }
  if (!image.startsWith(JPEG_DATA_URL_PREFIX)) return null;

  const base64 = image.slice(JPEG_DATA_URL_PREFIX.length);
  const canonicalBase64 = /^[a-zA-Z0-9+/]+={0,2}$/;
  if (!canonicalBase64.test(base64) || base64.length < 8) return null;

  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.length < 4
    || bytes.toString('base64') !== base64
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff
    || bytes[bytes.length - 1] !== 0xd9
  ) {
    return null;
  }
  return image;
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
    let ownerCapabilityHashValue = '';
    if (serviceRequest) {
      const hash = String(claim?.ownerCapabilityHash ?? '').toLowerCase();
      if (hash.length !== 64) throw requestError('invalid_owner_capability', 403);
      ownerCapabilityHashValue = hash;
    } else {
      const token = String(claim?.capabilityToken ?? '');
      if (token.length < 32) throw requestError('missing_owner_capability', 403);
      if (token.length > 256) throw requestError('invalid_owner_capability', 403);
      ownerCapabilityHashValue = sha256(token);
    }
    if (!CAPABILITY_HASH_PATTERN.test(ownerCapabilityHashValue)) {
      throw requestError('invalid_owner_capability', 403);
    }
    return { dealId, ownerCapabilityHash: ownerCapabilityHashValue };
  });
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalSafeMoney(value) {
  if (value === undefined || value === null || value === '') return true;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0;
}

function dealPricingError(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'invalid_deal';
  const originalPrice = Number(input.originalPrice);
  const discountRate = Number(input.discountRate ?? 0);
  if (!Number.isSafeInteger(originalPrice) || originalPrice <= 0) return 'invalid_deal_price';
  if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 100) {
    return 'invalid_deal_price';
  }
  if (![
    input.expectedPerPerson,
    input.unitPrice,
    input.unitRemainder,
    input.splitRemainder,
  ].every(optionalSafeMoney)) return 'invalid_deal_price';
  if (Array.isArray(input.menu) && input.menu.some((item) => (
    !item || typeof item !== 'object' || !optionalSafeMoney(item.price)
  ))) return 'invalid_deal_price';
  return '';
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

function sanitizeDeal(input, { degradeInvalidImage = false } = {}) {
  if (!input || !DEAL_ID_PATTERN.test(String(input.id || ''))) {
    return null;
  }
  if (dealPricingError(input)) return null;
  const id = text(input.id, 120);
  const source = input.source === 'customer' ? 'customer' : 'merchant';
  const saleType = text(input.saleType, 30);
  const groupId = text(input.groupId, 128);
  // Customer deals created before the shared-group rollout did not persist a
  // groupId. They still use the deal id as the canonical group id, so accept
  // that legacy blank value and normalize it below. A conflicting non-empty
  // value remains invalid and must never be rebound silently.
  if (source === 'customer' && groupId && groupId !== id) return null;
  if (source === 'merchant' && groupId && groupId !== id) return null;
  const groupBacked = source === 'customer' || (source === 'merchant' && saleType === 'group');
  const totalQuantity = Math.max(1, Math.min(999, Math.floor(number(input.totalQuantity ?? input.target, 1))));
  const rawPricingVersion = Number(input.pricingVersion);
  const rawSplitQuantity = Number(input.splitQuantity);
  const hasSplitQuantity = Object.prototype.hasOwnProperty.call(input, 'splitQuantity')
    && input.splitQuantity !== ''
    && input.splitQuantity !== null
    && input.splitQuantity !== undefined
    && Number.isFinite(rawSplitQuantity);
  const explicitSplitPricing = source === 'merchant'
    && saleType === 'group'
    && (
      input.pricingModel === EXPLICIT_SPLIT_PRICING_MODEL
      || (Number.isFinite(rawPricingVersion) && Math.floor(rawPricingVersion) >= EXPLICIT_SPLIT_PRICING_VERSION)
      || hasSplitQuantity
    );
  const splitQuantity = explicitSplitPricing
    ? Math.max(1, Math.min(
        totalQuantity,
        Math.floor(hasSplitQuantity ? rawSplitQuantity : 1),
      ))
    : null;
  const orderedQuantity = Math.min(
    totalQuantity,
    Math.max(0, Math.floor(number(input.orderedQuantity ?? input.current, 0))),
  );
  const participantCount = number(input.participantCount);
  const currentCount = source === 'merchant' && saleType === 'group'
    ? number(input.currentPeople ?? input.participantCount ?? input.currentCount)
    : number(input.currentCount ?? input.currentPeople ?? input.participantCount);
  const targetCount = source === 'merchant' && saleType === 'group'
    ? Math.max(1, Math.min(20, Math.floor(number(input.targetCount ?? input.target, 1))))
    : number(input.targetCount ?? input.target);
  const sanitizedImage = sanitizeDealImage(input.image);
  if (sanitizedImage === null && !degradeInvalidImage) return null;
  const image = sanitizedImage ?? '';
  const sanitized = {
    id,
    createdAt: text(input.createdAt, 80),
    updatedAt: text(input.updatedAt, 80),
    syncedAt: text(input.syncedAt, 80),
    visibility: 'public',
    source,
    saleType,
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
    splitPricing: explicitSplitPricing ? splitQuantity > 1 : Boolean(input.splitPricing),
    ...(explicitSplitPricing ? {
      pricingModel: EXPLICIT_SPLIT_PRICING_MODEL,
      pricingVersion: EXPLICIT_SPLIT_PRICING_VERSION,
      splitQuantity,
    } : {}),
    expectedPerPerson: number(input.expectedPerPerson),
    unitPrice: number(input.unitPrice ?? input.expectedPerPerson),
    unitRemainder: number(input.unitRemainder ?? input.splitRemainder),
    splitRemainder: number(input.splitRemainder),
    approximatePrice: Boolean(input.approximatePrice),
    discountRate: number(input.discountRate),
    current: number(input.current),
    participantCount,
    currentPeople: currentCount,
    quantityTracking: Boolean(input.quantityTracking),
    target: number(input.target),
    minPeople: number(input.minPeople, 1),
    maxPeople: number(input.maxPeople ?? input.target, 20),
    groupId: groupBacked ? id : '',
    targetCount,
    currentCount,
    groupStatus: ['recruiting', 'recruited', 'purchased', 'delivered'].includes(input.groupStatus)
      ? input.groupStatus
      : groupBacked ? 'recruiting' : '',
    chatLocked: Boolean(input.chatLocked),
    creatorActorId: text(input.creatorActorId, 128),
    hostMode: input.hostMode === 'recruiting' || (source === 'merchant' && saleType === 'group')
      ? 'recruiting'
      : 'self',
    hostActorId: text(input.hostActorId, 128),
    hostMatched: Boolean(input.hostActorId),
    totalQuantity,
    productQuantity: totalQuantity,
    orderedQuantity,
    allocatedProductQuantity: orderedQuantity,
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
  const publishVersion = Math.max(0, Math.floor(number(input.publishVersion, 0)));
  const expectedPublishVersion = Math.max(
    0,
    Math.floor(number(input.expectedPublishVersion ?? publishVersion, publishVersion)),
  );
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    syncedAt: _syncedAt,
    ...mutationContent
  } = sanitized;
  const publishMutationId = text(input.publishMutationId, 128)
    || `deal-${sha256(JSON.stringify(mutationContent)).slice(0, 48)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(publishMutationId)) return null;
  return {
    ...sanitized,
    publishVersion,
    expectedPublishVersion,
    publishMutationId,
  };
}

function publicResult(result, action) {
  if (!result || typeof result !== 'object') return result;
  const {
    ownerCapabilityHash: _ownerCapabilityHash,
    _ownerCapabilityHash: _storedOwnerCapabilityHash,
    ...safeResult
  } = result;
  if (['list', 'list_owner'].includes(action)) {
    return {
      ...safeResult,
      deletedDeals: (Array.isArray(result.deletedDeals) ? result.deletedDeals : [])
        .filter((deal) => /^(owner|customer)-[a-zA-Z0-9-]{1,100}$/.test(String(deal?.id || '')) && deal.visibility === 'deleted')
        .map((deal) => ({ id: deal.id, visibility: 'deleted', syncedAt: text(deal.syncedAt, 80), publishVersion: number(deal.publishVersion) })),
      deals: (Array.isArray(result.deals) ? result.deals : [])
        .map((deal) => sanitizeDeal(deal, { degradeInvalidImage: true }))
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
  if (['invalid_deal_capacity', 'invalid_target'].includes(code)) return 400;
  if (code === 'deal_too_large') return 413;
  if (code === 'image_not_found') return 404;
  if ([
    'deal_ownership_unclaimable',
    'deal_owner_conflict',
    'deal_deleted',
    'quantity_below_active_allocations',
    'active_allocations_require_group_sale',
    'target_below_current',
    'state_conflict',
    'client_mutation_conflict',
  ].includes(code)) return 409;
  if (String(code).includes('not_configured')) return 503;
  if (code === 'collector_busy') return 503;
  if (code === 'upstream_timeout') return 504;
  if (String(code).startsWith('invalid_')) return 400;
  return 502;
}

function sendFailure(response, { action, code, status, layer, details }) {
  if ([503, 504].includes(status)) response.setHeader('Retry-After', '3');
  if (status >= 500) {
    console.warn('[public-deals] upstream_failure', JSON.stringify({
      action: String(action || 'unknown'),
      code: String(code || 'unknown'),
      status,
      layer: String(layer || 'unknown'),
    }));
  }
  const version = details?.currentPublishVersion;
  return response.status(status).json({
    ok: false,
    error: code,
    ...(action === 'publish' && code === 'state_conflict'
      && Number.isSafeInteger(version) && version >= 0
      ? { currentPublishVersion: version } : {}),
  });
}

async function dataApiRequest(body) {
  const token = serviceSecret();
  return callDataApiJson('/api/public-deals', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-o2o-service-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function readPublicImage(imageId, serviceRequest = false) {
  if (!/^[a-f0-9]{64}$/.test(String(imageId || ''))) throw requestError('invalid_image_id');
  const proxied = serviceRequest ? null : await dataApiRequest({ action: 'image', imageId });
  const collectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const collectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  if (!proxied && (!collectorUrl || !collectorToken)) throw requestError('collector_not_configured', 503);
  const { upstream, result } = proxied || await fetchUpstreamJson(collectorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: collectorToken, action: 'public_image', imageId }),
    redirect: 'follow',
  });
  if (!upstream.ok || result.ok !== true) {
    const code = result.error || 'image_read_failed';
    throw requestError(code, statusForError(code));
  }
  const image = sanitizeDealImage(result.image);
  if (!image?.startsWith(JPEG_DATA_URL_PREFIX) || sha256(image) !== imageId) {
    throw requestError('image_integrity_failed', 502);
  }
  return image;
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET') {
    try {
      const imageId = new URL(request.url, PRODUCTION_ORIGIN).searchParams.get('image');
      const image = await readPublicImage(imageId);
      const bytes = Buffer.from(image.slice(JPEG_DATA_URL_PREFIX.length), 'base64');
      response.setHeader('Content-Type', 'image/jpeg');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.setHeader('ETag', `"${imageId}"`);
      return response.status(200).end(bytes);
    } catch (error) {
      return sendFailure(response, { action: 'image', code: error.code || 'image_read_failed', status: error.status || 502, layer: 'image' });
    }
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
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

  let action = '';
  try {
    const bodyLimit = request.body?.action === 'publish' ? MAX_DEAL_IMAGE_LENGTH + 60000 : 60000;
    if (!request.body || JSON.stringify(request.body).length > bodyLimit) {
      throw requestError('invalid_request_body');
    }
    action = request.body?.action;
    if (action === 'image' && serviceRequest) {
      return response.status(200).json({ ok: true, image: await readPublicImage(request.body.imageId, true) });
    }
    if (!['list', 'list_owner', 'publish', 'delete'].includes(action)) throw requestError('invalid_action');
    const publishPricingError = action === 'publish'
      ? dealPricingError(request.body?.deal)
      : '';
    if (publishPricingError) throw requestError(publishPricingError);
    const deal = action === 'publish' ? sanitizeDeal(request.body?.deal) : null;
    if (action === 'publish' && !deal) throw requestError('invalid_deal');
    const dealId = action === 'delete' ? text(request.body?.dealId, 120) : '';
    if (action === 'delete' && !DEAL_ID_PATTERN.test(dealId)) {
      throw requestError('invalid_deal_id');
    }
    const expectedPublishVersion = action === 'delete'
      ? Number(request.body?.expectedPublishVersion)
      : null;
    if (action === 'delete' && (!Number.isSafeInteger(expectedPublishVersion) || expectedPublishVersion < 0)) {
      throw requestError('invalid_expected_publish_version');
    }
    const clientMutationId = action === 'delete'
      ? text(request.body?.clientMutationId, 128)
      : '';
    if (action === 'delete' && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(clientMutationId)) {
      throw requestError('invalid_client_mutation_id');
    }
    const claims = action === 'list_owner' ? ownerClaims(request.body, serviceRequest) : [];
    const capabilityHash = ['list', 'list_owner'].includes(action)
      ? ''
      : ownerCapabilityHash(request.body, serviceRequest);
    const upstreamBody = {
      action,
      ...(deal ? { deal } : {}),
      ...(dealId ? { dealId } : {}),
      ...(action === 'delete' ? { expectedPublishVersion, clientMutationId } : {}),
      ...(claims.length ? { ownerClaims: claims } : {}),
      ...(capabilityHash ? { ownerCapabilityHash: capabilityHash } : {}),
    };

    const proxied = serviceRequest ? null : await dataApiRequest(upstreamBody);
    if (proxied) {
      if (!proxied.upstream.ok || proxied.result.ok !== true) {
        const code = proxied.result.error || 'data_api_failed';
        const status = proxied.upstream.ok ? statusForError(code) : proxied.upstream.status;
        return sendFailure(response, { action, code, status, layer: 'data_api', details: proxied.result });
      }
      return response
        .status(proxied.upstream.status)
        .json(publicResult(proxied.result, action));
    }

    const collectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    const collectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    if (!collectorUrl || !collectorToken) throw requestError('collector_not_configured', 503);
    const { upstream, result } = await fetchUpstreamJson(collectorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: collectorToken,
        action: action === 'list'
          ? 'public_deals'
          : action === 'list_owner'
            ? 'owner_deals'
          : action === 'delete'
            ? 'delete_deal'
            : 'publish_deal',
        ...(deal ? { deal } : {}),
        ...(dealId ? { dealId } : {}),
        ...(action === 'delete' ? { expectedPublishVersion, clientMutationId } : {}),
        ...(claims.length ? { ownerClaims: claims } : {}),
        ...(capabilityHash ? { ownerCapabilityHash: capabilityHash } : {}),
      }),
      redirect: 'follow',
    });
    if (!upstream.ok || !result.ok) {
      const code = result.error || 'collector_failed';
      return sendFailure(response, {
        action,
        code,
        status: statusForError(code),
        layer: 'collector',
        details: result,
      });
    }
    return response.status(action === 'publish' ? 202 : 200).json(publicResult(result, action));
  } catch (error) {
    const code = error.code || error.message || 'collector_unreachable';
    const status = error.status || (code.startsWith('invalid_') ? 400 : statusForError(code));
    return sendFailure(response, { action, code, status, layer: 'exception' });
  }
}
