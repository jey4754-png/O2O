import { applyAdminAuthResponseHeaders, verifyAdminPin } from './_admin-auth.js';
import { callDataApiJson, fetchUpstreamJson } from './_data-upstream.js';
import { sanitizeDealImage } from './public-deals.js';

export const config = { maxDuration: 60 };
const ACTIONS = new Set(['list', 'orders', 'delete', 'image', 'cancel_order']);
const LOGGED_ERRORS = new Set([
  'forbidden_origin', 'payload_too_large', 'invalid_action', 'invalid_actor_id',
  'invalid_deal_id', 'invalid_order_id', 'invalid_client_mutation_id', 'reason_required',
  'invalid_expected_version', 'invalid_image', 'invalid_admin_pin', 'admin_rate_limited',
  'admin_not_configured', 'admin_credential_store_unavailable', 'stale_admin_credential',
  'collector_not_configured', 'collector_busy', 'upstream_timeout', 'upstream_invalid_response',
  'state_conflict', 'client_mutation_conflict', 'order_not_found', 'group_not_found',
  'participant_not_found', 'order_owner_conflict', 'forbidden', 'order_not_cancellable',
  'host_cancellation_requires_recruiting', 'cancel_other_host_orders_first',
  'deal_not_found', 'deal_deleted', 'deal_too_large', 'invalid_order_record',
  'invalid_order_quantity', 'admin_operation_failed',
]);
function logAdminFailure(action, error, status, phase) {
  // Log only fixed enums. Request fields and arbitrary provider exceptions may
  // contain PINs, capabilities, personal data, images, or cancellation reasons.
  console.warn('[admin-ops] request_failure', JSON.stringify({
    action: ACTIONS.has(action) ? action : 'unknown',
    error: LOGGED_ERRORS.has(error) ? error : 'admin_operation_failed',
    status, phase,
  }));
}
function fail(code, status = 400) { throw Object.assign(new Error(code), { status }); }
function identifier(value, pattern, field) {
  if (!pattern.test(String(value || ''))) fail(`invalid_${field}`);
  return String(value);
}
// Never return stored ownership proofs, mutation contracts or private repair plans.
function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.startsWith('_') && !/capability|adminPin|adminAssertion/i.test(key))
    .map(([key, item]) => [key, publicValue(item)]));
}
export function normalizeAdminDealImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const image = sanitizeDealImage(value.image);
  // Historical rows may contain obsolete, mixed-content or malformed image
  // sources. Keep the product/order record visible and let the UI render its
  // stable placeholder instead of dropping the whole record.
  return { ...value, image: image || '' };
}
function normalizeAdminResult(value) {
  const result = publicValue(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return {
    ...result,
    ...(Array.isArray(result.deals) ? { deals: result.deals.map(normalizeAdminDealImage) } : {}),
    ...(result.deal ? { deal: normalizeAdminDealImage(result.deal) } : {}),
  };
}
export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'method_not_allowed' });
  let action = 'unknown';
  let phase = 'validation';
  try {
    const origins = new Set(['https://o2o-ten.vercel.app',
      ...['VERCEL_URL', 'VERCEL_BRANCH_URL'].map((key) => process.env[key] ? `https://${process.env[key]}` : ''),
    ].filter(Boolean));
    const origin = String(request.headers.origin || '');
    const local = process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!origins.has(origin) && !local) fail('forbidden_origin', 403);
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : (request.body || {});
    if (JSON.stringify(body).length > 1560000) fail('payload_too_large', 413);
    action = ACTIONS.has(body.action) ? body.action : 'unknown';
    phase = 'authentication';
    const credential = await verifyAdminPin(body.adminPin, request);
    phase = 'validation';
    if (!ACTIONS.has(body.action)) fail('invalid_action');
    const payload = { action: body.action, adminAssertion: true, adminCredentialVersion: credential?.version || 0,
      actorId: identifier(body.actorId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/, 'actor_id') };
    if (body.action !== 'list') payload.dealId = identifier(body.dealId, /^(owner|customer)-[a-zA-Z0-9-]{1,100}$/, 'deal_id');
    if (['delete', 'image', 'cancel_order'].includes(body.action)) {
      payload.clientMutationId = identifier(body.clientMutationId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/, 'client_mutation_id');
      payload.reason = String(body.reason || '').trim().slice(0, 200);
      if (!payload.reason) fail('reason_required');
      payload.expectedVersion = Number(body.expectedVersion);
      if (!Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion < 0) fail('invalid_expected_version');
    }
    if (body.action === 'cancel_order') {
      payload.orderId = identifier(body.orderId, /^order-\d{10,20}$/, 'order_id');
    }
    if (body.action === 'image') {
      const image = String(body.image || '');
      if (image.length > 1500000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) fail('invalid_image');
      const bytes = Buffer.from(image.slice(23), 'base64');
      if (bytes.length < 4 || bytes.toString('base64') !== image.slice(23)
        || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('invalid_image');
      payload.image = image;
    }
    // The upstream API rechecks the PIN; only the token-protected collector receives the assertion.
    phase = 'operation';
    let upstream = await callDataApiJson('/api/admin-ops', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, adminAssertion: undefined, adminPin: body.adminPin }),
    });
    if (!upstream) {
      if (!process.env.GOOGLE_SHEETS_COLLECTOR_URL || !process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN) fail('collector_not_configured', 503);
      upstream = await fetchUpstreamJson(process.env.GOOGLE_SHEETS_COLLECTOR_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'admin_operation', token: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN, payload }),
      });
    }
    const result = normalizeAdminResult(upstream.result);
    const status = result.ok ? 200
      : upstream.upstream.status >= 400 ? upstream.upstream.status
        : result.error === 'collector_busy' ? 503 : 409;
    if (status === 429) applyAdminAuthResponseHeaders(response, upstream.upstream);
    if (result.ok !== true) logAdminFailure(action, result.error, status, phase);
    return response.status(status).json(result);
  } catch (error) {
    applyAdminAuthResponseHeaders(response, error);
    logAdminFailure(action, error.code || error.message, error.status || 502, phase);
    return response.status(error.status || 502).json({ ok: false, error: error.message || 'admin_operation_failed' });
  }
}
