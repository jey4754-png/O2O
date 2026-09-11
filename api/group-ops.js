import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { callDataApiJson, fetchUpstreamJson } from './_data-upstream.js';
import { applyAdminAuthResponseHeaders, verifyAdminPin } from './_admin-auth.js';

const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const ACTIONS = new Set([
  'create',
  'repair_customer_group',
  'recover_legacy_customer_group',
  'join',
  'snapshot',
  'send_message',
  'mark_read',
  'transition_group',
  'transition_payment',
  'update_target',
  'toggle_lock',
  'claim_host',
  'release_host',
  'reserve_quantity',
  'rollback_reservation',
  'cancel_participation',
]);
const MUTATION_ACTIONS = new Set([...ACTIONS].filter((action) => action !== 'snapshot'));
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MUTATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const PHASE_EIGHT_ACTIONS = new Set(['send_message', 'mark_read', 'toggle_lock']);
const GROUP_TRANSITION_STATES = ['recruiting', 'recruited', 'purchased', 'delivered'];
const PAYMENT_TRANSITION_STATES = ['pending', 'requested', 'confirmed'];
const LEGACY_RECOVERY_DEAL_IDS = new Set([
  'customer-1783571204389',
  'customer-1784457727675',
  'customer-1784384845725',
  'customer-1785483350356',
  'customer-1785552043946',
  'customer-1786846122026',
  'customer-1785161630634',
  'customer-1785462601846',
  'customer-1784435839176',
  'customer-1785481017294',
  'customer-1785472551468',
  'customer-1784385010638',
  'customer-1785662414776',
  'customer-1784384041363',
  'customer-1783576635933',
  'customer-1785466024342',
]);
const CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const config = { maxDuration: 60 };

function releasePhase() {
  const parsed = Number(process.env.O2O_RELEASE_PHASE || 9);
  return Number.isInteger(parsed) ? Math.min(12, Math.max(1, parsed)) : 9;
}

function enforceReleasePhase(action, body) {
  if (releasePhase() >= 8) return;
  if (
    PHASE_EIGHT_ACTIONS.has(action)
    || body.adminPin
    || body.adminAssertion === true
    || (action === 'join' && (body.role === 'admin' || body.requestedRole === 'admin'))
  ) {
    throw requestError('feature_not_available', 404);
  }
}

function text(value, maxLength = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function identifier(value, fieldName, { required = true } = {}) {
  const normalized = text(value, 128);
  if (!normalized && !required) return '';
  if (!ID_PATTERN.test(normalized)) throw requestError(`invalid_${fieldName}`);
  return normalized;
}

function integer(value, fieldName, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
  if ((value === '' || value === null || value === undefined) && !required) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw requestError(`invalid_${fieldName}`);
  }
  return parsed;
}

function orderIdentifier(value) {
  const normalized = text(value, 40);
  if (!/^order-\d{10,20}$/.test(normalized)) throw requestError('invalid_order_id');
  return normalized;
}

function requestError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function configuredOrigins() {
  return new Set([
    PRODUCTION_ORIGIN,
    ...String(process.env.O2O_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean),
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
    process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : '',
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '',
  ].filter(Boolean));
}

function requestHost(request) {
  return text(request.headers['x-forwarded-host'] || request.headers.host, 300).toLowerCase();
}

function isAllowedOrigin(originValue, request) {
  if (!originValue) return false;
  try {
    const origin = new URL(originValue);
    if (configuredOrigins().has(origin.origin)) return true;
    if (['localhost', '127.0.0.1', '::1'].includes(origin.hostname)) {
      return ['http:', 'https:'].includes(origin.protocol);
    }
    const host = requestHost(request);
    return origin.protocol === 'https:' && Boolean(host) && origin.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function serviceSecret() {
  return process.env.O2O_DATA_API_TOKEN || process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN || '';
}

function isServiceRequest(request) {
  const expected = serviceSecret();
  const actual = request.headers['x-o2o-service-token'];
  return Boolean(expected && actual && safeEqual(actual, expected));
}

function capabilitySecret() {
  return process.env.O2O_CAPABILITY_SECRET || serviceSecret();
}

function deterministicValue(label, ...parts) {
  const secret = capabilitySecret();
  if (!secret) throw requestError('capability_secret_not_configured', 503);
  return createHmac('sha256', secret)
    .update([label, ...parts].join('\u001f'))
    .digest('base64url');
}

function capabilityHash(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function legacyRecoveryMutationId(eventHash) {
  // Do not place the collector's event hash itself in the mutation-history
  // request-id column. A second, domain-separated digest is a stable receipt
  // without disclosing the manifest lookup value.
  return `legacy-recovery-${capabilityHash(`legacy-recovery:${eventHash}`)}`;
}

function legacyRecoveryError() {
  return requestError('legacy_recovery_not_authorized', 403);
}

function normalizeLegacyRecoveryPayload(body, { serviceRequest = false } = {}) {
  try {
    const groupId = identifier(body.groupId, 'group_id');
    const dealId = identifier(body.dealId || groupId, 'deal_id');
    const actorId = identifier(body.actorId, 'actor_id');
    const nickname = text(body.nickname, 40);
    if (!nickname || groupId !== dealId || !LEGACY_RECOVERY_DEAL_IDS.has(dealId)) {
      throw legacyRecoveryError();
    }

    let eventHash;
    let returnedCapabilityToken = '';
    let storedCapabilityHash;
    if (serviceRequest) {
      eventHash = text(body.legacyEventHash, 64).toLowerCase();
      storedCapabilityHash = text(body.capabilityHash, 64).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(eventHash) || !/^[a-f0-9]{64}$/.test(storedCapabilityHash)) {
        throw legacyRecoveryError();
      }
    } else {
      const legacyEventId = text(body.legacyEventId, 64);
      returnedCapabilityToken = text(body.capabilityToken, 256);
      if (!CANONICAL_UUID_V4_PATTERN.test(legacyEventId) || returnedCapabilityToken.length < 32) {
        throw legacyRecoveryError();
      }
      eventHash = capabilityHash(legacyEventId);
      storedCapabilityHash = capabilityHash(returnedCapabilityToken);
    }

    return {
      payload: {
        action: 'recover_legacy_customer_group',
        actorId,
        groupId,
        dealId,
        nickname,
        legacyEventHash: eventHash,
        capabilityHash: storedCapabilityHash,
        // The browser cannot choose the receipt key. Retries for one historical
        // event are therefore idempotent across both Vercel and Apps Script.
        clientMutationId: legacyRecoveryMutationId(eventHash),
      },
      returnedCapabilityToken,
    };
  } catch {
    throw legacyRecoveryError();
  }
}

function mutationIdFor(body, action) {
  if (!MUTATION_ACTIONS.has(action)) return '';
  const mutationId = text(body.clientMutationId, 128);
  if (!MUTATION_ID_PATTERN.test(mutationId)) throw requestError('invalid_client_mutation_id');
  return mutationId;
}

function referencedMutationId(value, fieldName = 'reservation_mutation_id') {
  const mutationId = text(value, 128);
  if (!MUTATION_ID_PATTERN.test(mutationId)) throw requestError(`invalid_${fieldName}`);
  return mutationId;
}

function normalizedTransitionFields(body, action) {
  const states = action === 'transition_group'
    ? GROUP_TRANSITION_STATES
    : PAYMENT_TRANSITION_STATES;
  const direction = text(body.direction, 20);
  const fromStatus = text(body.fromStatus, 30);
  const toStatus = text(body.toStatus, 30);
  if (!['next', 'previous'].includes(direction)) throw requestError('invalid_direction');
  if (!states.includes(fromStatus)) throw requestError('invalid_from_status');
  if (!states.includes(toStatus)) throw requestError('invalid_to_status');
  const expectedOffset = direction === 'previous' ? -1 : 1;
  if (states.indexOf(toStatus) !== states.indexOf(fromStatus) + expectedOffset) {
    throw requestError('invalid_state_transition');
  }
  return {
    direction,
    fromStatus,
    toStatus,
    expectedVersion: integer(body.expectedVersion, 'expected_version', { min: 1 }),
  };
}

async function normalizeExternalPayload(body, action, request) {
  if (action === 'recover_legacy_customer_group') {
    return normalizeLegacyRecoveryPayload(body);
  }
  const clientMutationId = mutationIdFor(body, action);
  const actorId = identifier(body.actorId, 'actor_id');
  let groupId = identifier(body.groupId, 'group_id', { required: action === 'create' ? false : true });
  let returnedCapabilityToken = '';

  const payload = {
    action,
    actorId,
    groupId,
    clientMutationId,
  };

  if (['create', 'repair_customer_group'].includes(action)) {
    if (!groupId) {
      groupId = `group-${deterministicValue('group-id', actorId, clientMutationId).slice(0, 24)}`;
      payload.groupId = groupId;
    }
    payload.dealId = identifier(body.dealId || groupId, 'deal_id');
    if (payload.dealId !== groupId) throw requestError('invalid_group_deal_binding');
    // Merchant groups are provisioned only from their centrally owned public
    // deal during join. A browser create must not claim the owner-* namespace.
    if (!/^customer-[a-zA-Z0-9-]{1,100}$/.test(groupId)) {
      throw requestError('invalid_customer_group_id');
    }
    payload.title = text(body.title, 120);
    payload.nickname = text(body.nickname, 40);
    payload.targetCount = integer(body.targetCount, 'target_count', { min: 1, max: 20 });
    payload.hostMode = body.hostMode === undefined ? 'self' : text(body.hostMode, 20);
    if (!['self', 'recruiting'].includes(payload.hostMode)) throw requestError('invalid_host_mode');
    payload.totalQuantity = integer(body.totalQuantity ?? payload.targetCount, 'total_quantity', { min: 1, max: 999 });
    payload.selectedQuantity = integer(
      body.selectedQuantity ?? Math.min(1, payload.totalQuantity),
      'selected_quantity',
      { min: 0, max: payload.totalQuantity },
    );
    if (!payload.title) throw requestError('invalid_title');
    if (!payload.nickname) throw requestError('invalid_nickname');
    payload.requestedRole = payload.hostMode === 'recruiting' ? 'creator' : 'host';
    if (body.adminPin) {
      const credential = await verifyAdminPin(body.adminPin, request);
      payload.adminAssertion = true;
      payload.adminCredentialVersion = credential?.version || 0;
    }
    returnedCapabilityToken = text(body.capabilityToken, 256);
    if (returnedCapabilityToken.length < 32) {
      throw requestError('missing_capability_token', 403);
    }
    payload.capabilityHash = capabilityHash(returnedCapabilityToken);
    if (action === 'repair_customer_group') {
      const ownerCapabilityToken = text(body.ownerCapabilityToken, 256);
      if (ownerCapabilityToken.length < 32) {
        throw requestError('missing_owner_capability_token', 403);
      }
      payload.ownerCapabilityHash = capabilityHash(ownerCapabilityToken);
    }
  } else if (action === 'join') {
    payload.nickname = text(body.nickname, 40);
    if (!payload.nickname) throw requestError('invalid_nickname');
    if (body.role !== undefined && !['member', 'admin'].includes(body.role)) throw requestError('invalid_role');
    payload.requestedRole = body.role === 'admin' ? 'admin' : 'member';
    payload.counted = payload.requestedRole !== 'admin';
    payload.selectedQuantity = integer(
      body.selectedQuantity ?? (payload.requestedRole === 'admin' ? 0 : 1),
      'selected_quantity',
      { min: 0, max: 999 },
    );
    // A counted participant must reserve a positive quantity.  The legacy
    // merchant zero-quantity path trusted caller-supplied actor ids and could
    // mint a group capability for another customer's existing order actor.
    // Existing migrated participants can still use their previously issued
    // capability (including host claim); only new/replayed zero joins close.
    if (payload.counted && payload.selectedQuantity === 0) {
      throw requestError('invalid_quantity');
    }
    if (payload.requestedRole === 'admin') {
      const credential = await verifyAdminPin(body.adminPin, request);
      payload.adminAssertion = true;
      payload.adminCredentialVersion = credential?.version || 0;
    }
    returnedCapabilityToken = text(body.capabilityToken, 256);
    if (returnedCapabilityToken.length < 32) {
      throw requestError('missing_capability_token', 403);
    }
    payload.capabilityHash = capabilityHash(returnedCapabilityToken);
  } else {
    if (body.adminPin) {
      const credential = await verifyAdminPin(body.adminPin, request);
      payload.adminAssertion = true;
      payload.adminCredentialVersion = credential?.version || 0;
    } else {
      const token = text(body.capabilityToken, 256);
      if (token.length < 32) throw requestError('missing_capability_token', 403);
      payload.capabilityHash = capabilityHash(token);
    }
  }

  if (action === 'send_message') {
    payload.body = text(body.body, 500);
    if (!payload.body) throw requestError('invalid_message_body');
  }
  if (action === 'mark_read') {
    payload.lastReadSeq = integer(body.lastReadSeq, 'last_read_seq', { min: 0 });
  }
  if (['transition_group', 'transition_payment'].includes(action)) {
    Object.assign(payload, normalizedTransitionFields(body, action));
  }
  if (action === 'release_host') {
    payload.expectedVersion = integer(body.expectedVersion, 'expected_version', { min: 1 });
  }
  if (action === 'transition_payment') {
    payload.participantActorId = identifier(body.participantActorId, 'participant_actor_id');
    payload.reason = text(body.reason, 200);
  }
  if (action === 'update_target') {
    payload.targetCount = integer(body.targetCount, 'target_count', { min: 1, max: 20 });
    payload.expectedVersion = integer(body.expectedVersion, 'expected_version', { min: 1 });
  }
  if (action === 'toggle_lock') {
    if (typeof body.locked !== 'boolean') throw requestError('invalid_locked');
    payload.locked = body.locked;
    payload.expectedVersion = integer(body.expectedVersion, 'expected_version', { min: 1 });
  }
  if (action === 'reserve_quantity') {
    payload.quantity = integer(body.quantity, 'quantity', { min: 1, max: 999 });
    payload.expectedVersion = integer(body.expectedVersion, 'expected_version', { min: 1 });
  }
  if (action === 'rollback_reservation') {
    payload.quantity = integer(body.quantity, 'quantity', { min: 1, max: 999 });
    payload.reservationMutationId = referencedMutationId(body.reservationMutationId);
  }
  if (action === 'cancel_participation') {
    payload.orderId = orderIdentifier(body.orderId);
    payload.expectedVersion = integer(body.expectedVersion, 'expected_version', { min: 1 });
    payload.expectedOrderVersion = integer(body.expectedOrderVersion, 'expected_order_version', { min: 1 });
    const customerToken = text(body.customerCapabilityToken, 256);
    if (customerToken.length < 32) throw requestError('missing_customer_capability_token', 403);
    payload.customerCapabilityHash = capabilityHash(customerToken);
  }

  return { payload, returnedCapabilityToken };
}

function normalizeServicePayload(body, action) {
  if (action === 'recover_legacy_customer_group') {
    return normalizeLegacyRecoveryPayload(body, { serviceRequest: true });
  }
  const clientMutationId = mutationIdFor(body, action);
  const {
    capabilityToken: _capabilityToken,
    customerCapabilityToken: _customerCapabilityToken,
    ownerCapabilityToken: _ownerCapabilityToken,
    legacyEventId: _legacyEventId,
    ...serviceBody
  } = body;
  const payload = {
    ...serviceBody,
    action,
    actorId: identifier(body.actorId, 'actor_id'),
    groupId: identifier(body.groupId, 'group_id'),
    clientMutationId,
    adminAssertion: body.adminAssertion === true,
    capabilityHash: text(body.capabilityHash, 64).toLowerCase(),
  };
  if (!payload.adminAssertion && !/^[a-f0-9]{64}$/.test(payload.capabilityHash)) {
    throw requestError('invalid_capability_hash', 403);
  }
  if (action === 'repair_customer_group') {
    payload.ownerCapabilityHash = text(body.ownerCapabilityHash, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(payload.ownerCapabilityHash)) {
      throw requestError('invalid_owner_capability_hash', 403);
    }
  }
  if (action === 'cancel_participation') {
    payload.orderId = orderIdentifier(body.orderId);
    payload.expectedVersion = integer(body.expectedVersion, 'expected_version', { min: 1 });
    payload.expectedOrderVersion = integer(body.expectedOrderVersion, 'expected_order_version', { min: 1 });
    payload.customerCapabilityHash = text(body.customerCapabilityHash, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(payload.customerCapabilityHash)) {
      throw requestError('invalid_customer_capability_hash', 403);
    }
  }
  if (action === 'rollback_reservation') {
    payload.quantity = integer(body.quantity, 'quantity', { min: 1, max: 999 });
    payload.reservationMutationId = referencedMutationId(body.reservationMutationId);
  }
  if (['transition_group', 'transition_payment'].includes(action)) {
    Object.assign(payload, normalizedTransitionFields(body, action));
    if (action === 'transition_payment') {
      payload.participantActorId = identifier(body.participantActorId, 'participant_actor_id');
      payload.reason = text(body.reason, 200);
    }
  }
  return { payload, returnedCapabilityToken: '' };
}

function statusForError(code) {
  if ([
    'unauthorized',
    'invalid_capability',
    'invalid_capability_hash',
    'invalid_customer_capability',
    'invalid_customer_capability_hash',
    'missing_capability_token',
    'missing_owner_capability_token',
    'invalid_owner_capability',
    'invalid_owner_capability_hash',
    'deal_owner_proof_required',
    'missing_customer_capability_token',
    'invalid_admin_pin',
    'forbidden',
    'legacy_recovery_not_authorized',
  ].includes(code)) return 403;
  if (['group_not_found', 'participant_not_found', 'order_not_found', 'feature_not_available'].includes(code)) return 404;
  if ([
    'group_exists',
    'actor_already_joined',
    'group_full',
    'group_not_recruiting',
    'state_conflict',
    'invalid_state_transition',
    'client_mutation_conflict',
    'chat_locked',
    'target_below_current',
    'target_update_closed',
    'invalid_target',
    'target_locked',
    'host_already_claimed',
    'host_claim_closed',
    'host_release_closed',
    'host_order_required',
    'host_role_payment_locked',
    'order_actor_claim_requires_proof',
    'quantity_exceeds_total',
    'quantity_reservation_closed',
    'reservation_not_found',
    'reservation_quantity_mismatch',
    'reservation_already_bound',
    'participation_cancellation_closed',
    'order_not_cancellable',
    'payment_already_processed',
    'payment_reversal_requires_group_rewind',
    'payments_not_confirmed',
    'order_owner_conflict',
    'order_ownership_unclaimable',
    'deal_ownership_unclaimable',
  ].includes(code)) return 409;
  if (String(code).includes('not_configured')) return 503;
  if (code === 'deal_update_pending') return 503;
  if (code === 'collector_busy') return 503;
  if (code === 'upstream_timeout') return 504;
  if (code === 'group_operation_failed' || /^Exception:/.test(String(code))) return 502;
  return 400;
}

function logGroupFailure(action, code, status, layer = 'handler') {
  console.warn('[group-ops] request_failure', JSON.stringify({
    action: String(action || 'unknown'),
    code: String(code || 'unknown'),
    status: Number(status || 500),
    layer: String(layer || 'handler'),
  }));
}

function logGroupSuccess(action, result) {
  if (action !== 'transition_payment') return;
  console.info('[group-ops] request_success', JSON.stringify({
    action,
    duplicate: Boolean(result?.duplicate),
    orderUpdated: Boolean(result?.order),
    paymentStatus: String(result?.order?.paymentStatus || 'unknown'),
  }));
}

function publicOrder(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return undefined;
  const {
    _customerCapabilityHash,
    customerCapabilityHash,
    customerCapabilityToken,
    capabilityHash: _capabilityHash,
    capabilityToken: _capabilityToken,
    ...safeOrder
  } = order;
  return safeOrder;
}

function publicSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const phaseEightEnabled = releasePhase() >= 8;
  return {
    ...snapshot,
    unreadCount: phaseEightEnabled ? Number(snapshot.unreadCount || 0) : 0,
    messages: phaseEightEnabled && Array.isArray(snapshot.messages) ? snapshot.messages : [],
    participants: Array.isArray(snapshot.participants)
      ? snapshot.participants.filter((participant) => phaseEightEnabled || participant.role !== 'admin')
      : [],
    group: snapshot.group && typeof snapshot.group === 'object'
      ? {
          ...snapshot.group,
          ...(phaseEightEnabled ? {} : { chatLocked: false }),
        }
      : snapshot.group,
    history: Array.isArray(snapshot.history)
      ? snapshot.history
        .filter((entry) => phaseEightEnabled || (entry.entityType !== 'chat_lock' && entry.actorRole !== 'admin'))
        .map(({ clientMutationId: _clientMutationId, ...entry }) => entry)
      : [],
  };
}

async function callUpstream(payload, allowProxy = true) {
  const token = serviceSecret();
  const proxied = allowProxy ? await callDataApiJson('/api/group-ops', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-o2o-service-token': token } : {}),
    },
    body: JSON.stringify(payload),
  }) : null;
  if (proxied) {
    return { status: proxied.upstream.status, result: proxied.result };
  }

  const collectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const collectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  if (!collectorUrl || !collectorToken) {
    throw requestError('collector_not_configured', 503);
  }
  const { upstream, result } = await fetchUpstreamJson(collectorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: collectorToken,
      action: `group_${payload.action}`,
      payload,
    }),
    redirect: 'follow',
  });
  return {
    status: upstream.ok
      ? (result.ok ? 200 : statusForError(result.error))
      : upstream.status,
    result,
  };
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'private, no-store, max-age=0');
  response.setHeader('Vary', 'Origin');
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

  try {
    if (!request.body || JSON.stringify(request.body).length > 20000) {
      throw requestError('invalid_request_body');
    }
    const action = text(request.body.action, 40);
    if (!ACTIONS.has(action)) throw requestError('invalid_action');
    enforceReleasePhase(action, request.body);
    const normalized = serviceRequest
      ? normalizeServicePayload(request.body, action)
      : await normalizeExternalPayload(request.body, action, request);
    const { status, result } = await callUpstream(normalized.payload, !serviceRequest);
    if (action === 'recover_legacy_customer_group' && (status >= 400 || !result?.ok)) {
      return response.status(403).json({ ok: false, error: 'legacy_recovery_not_authorized' });
    }
    if (status >= 400 && result?.ok) {
      logGroupFailure(action, 'data_api_failed', status, 'upstream_http');
      return response.status(status).json({ ok: false, error: 'data_api_failed' });
    }
    if (!result?.ok) {
      const code = result?.error || 'group_operation_failed';
      const responseStatus = status >= 400 ? status : statusForError(code);
      logGroupFailure(action, code, responseStatus, 'upstream_result');
      return response.status(responseStatus).json({
        ok: false,
        error: code,
        ...(result?.snapshot ? { snapshot: publicSnapshot(result.snapshot) } : {}),
        ...(result?.order ? { order: publicOrder(result.order) } : {}),
      });
    }
    logGroupSuccess(action, result);
    if (action === 'recover_legacy_customer_group') {
      return response.status(status >= 400 ? status : 200).json({
        ok: true,
        duplicate: Boolean(result.duplicate),
        unchanged: Boolean(result.unchanged),
        snapshot: publicSnapshot(result.snapshot),
        ...(result?.order ? { order: publicOrder(result.order) } : {}),
        ...(normalized.returnedCapabilityToken ? { capabilityToken: normalized.returnedCapabilityToken } : {}),
      });
    }
    return response.status(status >= 400 ? status : 200).json({
      ...result,
      snapshot: publicSnapshot(result.snapshot),
      ...(result?.order ? { order: publicOrder(result.order) } : {}),
      ...(normalized.returnedCapabilityToken ? { capabilityToken: normalized.returnedCapabilityToken } : {}),
    });
  } catch (error) {
    applyAdminAuthResponseHeaders(response, error);
    if (error.status === 429) {
      return response.status(429).json({ ok: false, error: error.code || 'admin_rate_limited' });
    }
    if (text(request.body?.action, 40) === 'recover_legacy_customer_group') {
      return response.status(403).json({ ok: false, error: 'legacy_recovery_not_authorized' });
    }
    const code = error.code || 'group_operation_failed';
    const status = error.status || statusForError(code) || 500;
    logGroupFailure(text(request.body?.action, 40), code, status);
    return response.status(status).json({ ok: false, error: code });
  }
}
