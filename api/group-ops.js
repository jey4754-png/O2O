import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { callDataApiJson, fetchUpstreamJson } from './_data-upstream.js';

const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const ACTIONS = new Set([
  'create',
  'join',
  'snapshot',
  'send_message',
  'mark_read',
  'transition_group',
  'transition_payment',
  'update_target',
  'toggle_lock',
  'claim_host',
  'reserve_quantity',
  'cancel_participation',
]);
const MUTATION_ACTIONS = new Set([...ACTIONS].filter((action) => action !== 'snapshot'));
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MUTATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const PHASE_EIGHT_ACTIONS = new Set(['send_message', 'mark_read', 'toggle_lock']);

export const config = { maxDuration: 60 };

function releasePhase() {
  const parsed = Number(process.env.O2O_RELEASE_PHASE || 6);
  return Number.isInteger(parsed) ? Math.min(12, Math.max(1, parsed)) : 6;
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

function verifyAdminPin(pin) {
  const expected = process.env.O2O_ADMIN_PIN;
  if (!expected) throw requestError('admin_not_configured', 503);
  if (!safeEqual(pin, expected)) throw requestError('invalid_admin_pin', 403);
  return true;
}

function mutationIdFor(body, action) {
  if (!MUTATION_ACTIONS.has(action)) return '';
  const mutationId = text(body.clientMutationId, 128);
  if (!MUTATION_ID_PATTERN.test(mutationId)) throw requestError('invalid_client_mutation_id');
  return mutationId;
}

function normalizeExternalPayload(body, action) {
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

  if (action === 'create') {
    if (!groupId) {
      groupId = `group-${deterministicValue('group-id', actorId, clientMutationId).slice(0, 24)}`;
      payload.groupId = groupId;
    }
    payload.dealId = identifier(body.dealId || groupId, 'deal_id');
    if (payload.dealId !== groupId) throw requestError('invalid_group_deal_binding');
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
      verifyAdminPin(body.adminPin);
      payload.adminAssertion = true;
    }
    returnedCapabilityToken = deterministicValue('capability', action, groupId, actorId, clientMutationId);
    payload.capabilityHash = capabilityHash(returnedCapabilityToken);
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
    if (payload.requestedRole === 'admin') {
      verifyAdminPin(body.adminPin);
      payload.adminAssertion = true;
    }
    returnedCapabilityToken = deterministicValue('capability', action, groupId, actorId, clientMutationId);
    payload.capabilityHash = capabilityHash(returnedCapabilityToken);
  } else {
    if (body.adminPin) {
      verifyAdminPin(body.adminPin);
      payload.adminAssertion = true;
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
    if (!['next', 'previous'].includes(body.direction)) throw requestError('invalid_direction');
    payload.direction = body.direction;
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
  const clientMutationId = mutationIdFor(body, action);
  const {
    capabilityToken: _capabilityToken,
    customerCapabilityToken: _customerCapabilityToken,
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
  if (action === 'cancel_participation') {
    payload.orderId = orderIdentifier(body.orderId);
    payload.expectedVersion = integer(body.expectedVersion, 'expected_version', { min: 1 });
    payload.expectedOrderVersion = integer(body.expectedOrderVersion, 'expected_order_version', { min: 1 });
    payload.customerCapabilityHash = text(body.customerCapabilityHash, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(payload.customerCapabilityHash)) {
      throw requestError('invalid_customer_capability_hash', 403);
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
    'missing_customer_capability_token',
    'invalid_admin_pin',
    'forbidden',
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
    'host_order_required',
    'quantity_exceeds_total',
    'quantity_reservation_closed',
    'participation_cancellation_closed',
    'order_not_cancellable',
    'payment_already_processed',
    'order_owner_conflict',
    'order_ownership_unclaimable',
  ].includes(code)) return 409;
  if (String(code).includes('not_configured')) return 503;
  if (code === 'collector_busy') return 503;
  if (code === 'upstream_timeout') return 504;
  if (code === 'group_operation_failed' || /^Exception:/.test(String(code))) return 502;
  return 400;
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
  const { result } = await fetchUpstreamJson(collectorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: collectorToken,
      action: `group_${payload.action}`,
      payload,
    }),
    redirect: 'follow',
  });
  return { status: result.ok ? 200 : statusForError(result.error), result };
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
      : normalizeExternalPayload(request.body, action);
    const { status, result } = await callUpstream(normalized.payload, !serviceRequest);
    if (!result?.ok) {
      return response.status(statusForError(result?.error || 'group_operation_failed')).json({
        ok: false,
        error: result?.error || 'group_operation_failed',
        ...(result?.snapshot ? { snapshot: publicSnapshot(result.snapshot) } : {}),
        ...(result?.order ? { order: publicOrder(result.order) } : {}),
      });
    }
    return response.status(status >= 400 ? status : 200).json({
      ...result,
      snapshot: publicSnapshot(result.snapshot),
      ...(result?.order ? { order: publicOrder(result.order) } : {}),
      ...(normalized.returnedCapabilityToken ? { capabilityToken: normalized.returnedCapabilityToken } : {}),
    });
  } catch (error) {
    const code = error.code || 'group_operation_failed';
    return response.status(error.status || statusForError(code) || 500).json({ ok: false, error: code });
  }
}
