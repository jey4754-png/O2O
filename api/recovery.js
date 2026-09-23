import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fetchUpstreamJson } from './_data-upstream.js';

// Self-service recovery of a browser's ownership keys.
//
// A phone number is only the lookup scope here, never proof: the collector
// binds what the live key actually owned at enrollment, and a later redeem
// hands that exact set to the new key. The confirmation number never leaves
// this process — scrypt derivation and comparison happen here, and the
// collector only ever sees the verifier or the matched verifier's ref.

const deriveKey = promisify(scrypt);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MUTATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const PHONE = /^010\d{8}$/;
const PIN = /^\d{6,12}$/;
const OWNER_DEAL_ID = /^owner-[a-zA-Z0-9-]{1,100}$/;
const GROUP_CLAIM_LIMIT = 20;
const DEAL_CLAIM_LIMIT = 50;
const COLLECTOR_TIMEOUT_MS = 25000;
const RETRY_AFTER_LIMIT = 3600;

export const config = { maxDuration: 60 };

function recoveryError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function header(request, name) {
  const value = request?.headers?.[name] ?? request?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function secret() {
  const token = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  if (!token) throw recoveryError('recovery_not_configured', 503);
  return token;
}

function allowedOrigin(request) {
  const origins = new Set([PRODUCTION_ORIGIN,
    ...['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']
      .map((key) => (process.env[key] ? `https://${process.env[key]}` : '')),
  ].filter(Boolean));
  const origin = header(request, 'origin');
  const local = process.env.NODE_ENV !== 'production'
    && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return origins.has(origin) || local;
}

// Keyed by the trusted peer address, like the admin PIN limiter, so a caller
// cannot open a fresh bucket per request. The raw address never leaves here.
function clientKey(request) {
  const forwarded = header(request, 'x-vercel-forwarded-for')
    || header(request, 'x-real-ip')
    || header(request, 'x-forwarded-for');
  const parts = forwarded.split(',').map((value) => value.trim()).filter(Boolean);
  const address = (parts.at(-1) || request?.socket?.remoteAddress || 'unknown').slice(0, 128);
  return createHmac('sha256', secret()).update(`recovery:${address}`, 'utf8').digest('hex').slice(0, 32);
}

// The phone number is keyed with the collector secret rather than hashed
// bare, so the enrollment sheet alone cannot be walked back to phone numbers.
function identityKey(phone) {
  return createHmac('sha256', secret()).update(`recovery-identity:${phone}`, 'utf8').digest('hex');
}

function rateLimited(retryAfter) {
  const seconds = Number(retryAfter);
  const error = recoveryError('recovery_rate_limited', 429);
  error.retryAfter = Number.isFinite(seconds) && seconds > 0
    ? Math.max(1, Math.min(RETRY_AFTER_LIMIT, Math.ceil(seconds)))
    : 1;
  return error;
}

const COLLECTOR_STATUS = {
  invalid_recovery_request: 400,
  invalid_recovery_capability: 400,
  invalid_recovery_verifier: 400,
  invalid_actor_id: 400,
  invalid_client_mutation_id: 400,
  recovery_nothing_to_bind: 409,
  recovery_enrollment_limit: 409,
  recovery_succession_exists: 409,
  recovery_not_enrolled: 403,
  forbidden: 403,
};

async function collector(payload) {
  const url = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const token = secret();
  if (!url) throw recoveryError('recovery_not_configured', 503);
  const body = JSON.stringify({ token, action: 'recovery_credentials', payload });
  const retryDelays = [300, 700];
  for (let attempt = 0; ; attempt += 1) {
    let upstream;
    let result;
    try {
      ({ upstream, result } = await fetchUpstreamJson(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        timeoutMs: COLLECTOR_TIMEOUT_MS,
      }));
    } catch {
      throw recoveryError('recovery_store_unavailable', 503);
    }
    // Only a `begin` that lost the lock race is safe to replay: it has not yet
    // reserved a slot, derived anything, or written a row.
    if (attempt < retryDelays.length && payload.operation === 'begin'
      && upstream.status === 200 && result.ok === false && result.error === 'collector_busy') {
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      continue;
    }
    if (upstream.status >= 400 || result.ok !== true) {
      const code = String(result?.error || '');
      if (Object.hasOwn(COLLECTOR_STATUS, code)) throw recoveryError(code, COLLECTOR_STATUS[code]);
      throw recoveryError('recovery_store_unavailable', 503);
    }
    return result;
  }
}

async function begin(request, identity, scope) {
  const result = await collector({
    operation: 'begin', clientKey: clientKey(request), identityKey: identity,
    ...(scope ? { scope } : {}),
  });
  if (result.allowed === false) throw rateLimited(result.retryAfter);
  if (result.allowed !== true || result.reserved !== true) {
    throw recoveryError('recovery_store_unavailable', 503);
  }
  return result;
}

async function recordFailure(request, identity) {
  try {
    await collector({ operation: 'finish', clientKey: clientKey(request), identityKey: identity });
  } catch {
    // The reserved slot already counts against the caller until it expires;
    // an unrecorded failure must not turn into a different error for them.
  }
}

function validVerifier(record) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && record.algorithm === 'scrypt-v1'
    && typeof record.salt === 'string' && /^[a-f0-9]{32}$/.test(record.salt)
    && typeof record.hash === 'string' && /^[a-f0-9]{128}$/.test(record.hash);
}

function token(value, missingCode) {
  const text = typeof value === 'string' ? value : '';
  if (text.length < 32 || text.length > 256) throw recoveryError(missingCode, 403);
  return text;
}

function parseBody(request) {
  if (typeof request.body === 'string' && request.body.length > 32768) {
    throw recoveryError('payload_too_large', 413);
  }
  let body;
  try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; }
  catch { throw recoveryError('invalid_request'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw recoveryError('invalid_request');
  if (JSON.stringify(body).length > 32768) throw recoveryError('payload_too_large', 413);
  if (!['enroll', 'redeem'].includes(body.action)) throw recoveryError('invalid_action');
  const phone = String(body.phone ?? '').replace(/\D/g, '');
  if (!PHONE.test(phone)) throw recoveryError('invalid_recovery_phone');
  if (typeof body.pin !== 'string' || !PIN.test(body.pin)) throw recoveryError('invalid_recovery_pin_format');
  if (typeof body.actorId !== 'string' || !ID.test(body.actorId)) throw recoveryError('invalid_actor_id');
  if (typeof body.clientMutationId !== 'string' || !MUTATION_ID.test(body.clientMutationId)) {
    throw recoveryError('invalid_client_mutation_id');
  }
  const capabilityToken = token(body.customerCapabilityToken, 'missing_customer_capability');
  return { ...body, phone, capabilityToken };
}

// Claims are hashed here and verified by the collector against what the
// live key actually owns; a claim that does not check out is silently dropped
// there, so a stale local entry can never bind someone else's group or deal.
function groupClaims(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > GROUP_CLAIM_LIMIT) throw recoveryError('invalid_group_claims');
  return input.map((claim) => {
    const groupId = String(claim?.groupId ?? '');
    const actorId = String(claim?.actorId ?? '');
    if (!ID.test(groupId) || !ID.test(actorId)) throw recoveryError('invalid_group_claims');
    return { groupId, actorId, capabilityHash: sha256(token(claim?.capabilityToken, 'invalid_group_claims')) };
  });
}

function dealClaims(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > DEAL_CLAIM_LIMIT) throw recoveryError('invalid_deal_claims');
  return input.map((claim) => {
    const dealId = String(claim?.dealId ?? '');
    if (!OWNER_DEAL_ID.test(dealId)) throw recoveryError('invalid_deal_claims');
    return { dealId, ownerCapabilityHash: sha256(token(claim?.capabilityToken, 'invalid_deal_claims')) };
  });
}

function boundCounts(value) {
  return {
    orders: Number(value?.orders) || 0,
    groups: Number(value?.groups) || 0,
    deals: Number(value?.deals) || 0,
  };
}

// The phone number is shown to merchants and group members, so a number
// derived from it is no secret at all. Customers also read "확인번호" as their
// phone number, register something else, and then fail every restore.
function pinRepeatsPhone(pin, phone) {
  return phone.includes(pin) || pin.includes(phone.slice(3));
}

async function enroll(request, body) {
  if (pinRepeatsPhone(body.pin, body.phone)) throw recoveryError('recovery_pin_matches_phone');
  const groups = groupClaims(body.groups);
  const deals = dealClaims(body.deals);
  const identity = identityKey(body.phone);
  await begin(request, identity, 'enroll');
  const salt = randomBytes(16);
  const key = await deriveKey(body.pin, salt, 64, SCRYPT_OPTIONS);
  const result = await collector({
    operation: 'enroll', identityKey: identity, actorId: body.actorId,
    clientMutationId: body.clientMutationId, capabilityHash: sha256(body.capabilityToken),
    verifier: { algorithm: 'scrypt-v1', salt: salt.toString('hex'), hash: key.toString('hex') },
    groups, deals,
  });
  if (result.duplicate === true) return { ok: true, duplicate: true };
  return { ok: true, bound: boundCounts(result.bound) };
}

async function redeem(request, body) {
  const identity = identityKey(body.phone);
  const started = await begin(request, identity);
  const candidates = Array.isArray(started.verifiers) ? started.verifiers : [];
  if (!candidates.length || !candidates.every((item) => validVerifier(item?.verifier)
    && typeof item.ref === 'string' && /^[a-f0-9]{64}$/.test(item.ref))) {
    throw recoveryError('recovery_store_unavailable', 503);
  }
  // Every candidate is derived, including the decoys the collector pads with,
  // so the work done never reveals how many real enrollments this number has.
  let matched = '';
  for (const item of candidates) {
    const key = await deriveKey(body.pin, Buffer.from(item.verifier.salt, 'hex'), 64, SCRYPT_OPTIONS);
    if (timingSafeEqual(key, Buffer.from(item.verifier.hash, 'hex'))) matched = item.ref;
  }
  if (!matched) {
    await recordFailure(request, identity);
    throw recoveryError('invalid_recovery_pin', 403);
  }
  const result = await collector({
    operation: 'redeem', identityKey: identity, ref: matched, redeemAssertion: true,
    clientMutationId: body.clientMutationId, capabilityHash: sha256(body.capabilityToken),
  });
  const actorId = typeof result.actorId === 'string' && ID.test(result.actorId) ? result.actorId : '';
  return {
    ok: true,
    ...(result.duplicate === true ? { duplicate: true } : {}),
    actorId,
    bound: boundCounts(result.bound),
    // Hashes of the old keys stay on the collector; the browser only needs to
    // know which rooms and deals its new key now stands in for.
    groups: (Array.isArray(result.groups) ? result.groups : [])
      .map((entry) => ({ groupId: String(entry?.groupId || ''), actorId: String(entry?.actorId || '') }))
      .filter((entry) => ID.test(entry.groupId) && ID.test(entry.actorId)),
    deals: (Array.isArray(result.deals) ? result.deals : [])
      .map((entry) => String(entry?.dealId || ''))
      .filter((dealId) => OWNER_DEAL_ID.test(dealId)),
  };
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (!allowedOrigin(request)) throw recoveryError('forbidden_origin', 403);
    const body = parseBody(request);
    const result = body.action === 'enroll' ? await enroll(request, body) : await redeem(request, body);
    return response.status(200).json(result);
  } catch (error) {
    if (error?.status === 429) response.setHeader('Retry-After', String(error.retryAfter || 1));
    // Never echo the collector body, the phone number, or exception text.
    return response.status(error?.status || 503).json({ ok: false, error: error?.code || 'recovery_failed' });
  }
}
