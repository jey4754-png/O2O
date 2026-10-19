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
  // collector_busy means the script lock was never taken, so nothing was read
  // or written and any operation may be replayed. A restore at 16:47 on
  // 2026-09-23 failed on exactly this while the collector was saturated.
  const retryDelays = [300, 700, 1500];
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
    if (attempt < retryDelays.length
      && upstream.status === 200 && result.ok === false && result.error === 'collector_busy') {
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      continue;
    }
    if (upstream.status >= 400 || result.ok !== true) {
      const code = String(result?.error || '');
      if (Object.hasOwn(COLLECTOR_STATUS, code)) throw recoveryError(code, COLLECTOR_STATUS[code]);
      throw Object.assign(recoveryError('recovery_store_unavailable', 503), { upstream: code.slice(0, 60) });
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
  if (!['enroll', 'redeem', 'verify'].includes(body.action)) throw recoveryError('invalid_action');
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

// Finds the enrollment the confirmation number opens, or records a failure.
async function matchEnrollment(request, body) {
  const identity = identityKey(body.phone);
  const started = await begin(request, identity);
  const candidates = Array.isArray(started.verifiers) ? started.verifiers : [];
  if (!candidates.length || !candidates.every((item) => validVerifier(item?.verifier)
    && typeof item.ref === 'string' && /^[a-f0-9]{64}$/.test(item.ref))) {
    throw recoveryError('recovery_store_unavailable', 503);
  }
  // Every candidate is derived, including the decoys the collector pads with,
  // so the work done never reveals how many real enrollments this number has.
  const matchedRefs = [];
  for (const item of candidates) {
    const key = await deriveKey(body.pin, Buffer.from(item.verifier.salt, 'hex'), 64, SCRYPT_OPTIONS);
    if (timingSafeEqual(key, Buffer.from(item.verifier.hash, 'hex'))) matchedRefs.push(item.ref);
  }
  if (!matchedRefs.length) {
    await recordFailure(request, identity);
    throw recoveryError('invalid_recovery_pin', 403);
  }
  // 같은 숫자를 여러 기기에서 등록해 두면 여러 행이 함께 맞는다. 이 기기가 직접
  // 등록한 행으로 되살리면 이 기기를 이 기기에 더하는 셈이라 아무것도 바뀌지
  // 않는다. 예전에는 마지막으로 맞은 행을 골랐고, 후보가 ref 순으로 정렬되어
  // 있어 어느 행이 걸릴지 사실상 무작위였다. 다른 기기가 등록한 행을 먼저 고른다.
  const own = body.capabilityToken ? sha256(body.capabilityToken) : '';
  const others = matchedRefs.filter((ref) => ref !== own);
  return { identity, others, matchedRefs };
}

// Checks a number right after registering it, on the device that holds it,
// without restoring anything. A pass there and a failure on another device
// then points at the device or phone, never at the digits typed.
async function verify(request, body) {
  const { matchedRefs } = await matchEnrollment(request, body);
  return { ok: true, verified: true, thisDevice: matchedRefs.includes(sha256(body.capabilityToken)) };
}

async function redeem(request, body) {
  const { identity, others, matchedRefs } = await matchEnrollment(request, body);
  // 맞은 등록이 모두 이 기기가 직접 한 등록이면, 되살리기는 이 기기를 이 기기에
  // 더할 뿐이라 아무것도 바뀌지 않는다. 그런데도 성공으로 답하면 화면은 '주문 N건을
  // 볼 수 있습니다'라고 하고 목록은 그대로라, 고객은 기능이 고장 났다고 본다
  // (2026-10-14 16:30 실제 사례: PC 에서 PC 의 번호로 되살리기). 숫자는 맞았으니
  // 틀린 횟수로 세지 않고, 무엇을 해야 하는지 알려 준다.
  if (matchedRefs.every((ref) => ref === sha256(body.capabilityToken))) {
    throw recoveryError('recovery_own_enrollment', 409);
  }
  // 같은 번호가 다른 기기의 등록 여러 개와 맞으면, 이 기기가 이미 연결된 등록이 어느
  // 것인지 여기서는 알 수 없다(기기 목록은 수집기에만 있다). 앞의 등록을 승계하면 이
  // 기기가 두 승계에 걸리는 경우 수집기는 쓰기 전에 recovery_succession_exists 로
  // 거절하므로, 그때만 다음 맞은 등록으로 넘어간다. 2026-10-19 11:40 실제 사례: 휴대폰이
  // 연결된 9/23 등록과 PC 자기 등록이 같은 번호였고 PC 행의 ref 가 먼저 정렬돼, 휴대폰의
  // 되살리기가 PC 행에 걸려 거절됐다. 넘어가도 승계 규칙은 수집기가 행마다 그대로
  // 판정하고, 모든 등록이 거절하면 거절이 그대로 전달된다.
  let result;
  for (let index = 0; ; index += 1) {
    try {
      result = await collector({
        operation: 'redeem', identityKey: identity, ref: others[index], redeemAssertion: true,
        clientMutationId: body.clientMutationId, capabilityHash: sha256(body.capabilityToken),
      });
      break;
    } catch (error) {
      if (error?.code === 'recovery_succession_exists' && index + 1 < others.length) continue;
      // The number was right; only the write did not land. Saying so keeps the
      // customer from doubting the digits, and pressing again is safe: the
      // collector replays the same request as the same restore.
      if (error?.status === 503) throw Object.assign(recoveryError('recovery_redeem_incomplete', 503), { upstream: error.upstream });
      throw error;
    }
  }
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
    const result = body.action === 'enroll' ? await enroll(request, body)
      : body.action === 'verify' ? await verify(request, body)
        : await redeem(request, body);
    return response.status(200).json(result);
  } catch (error) {
    // Stage and collector code only: never the phone, number, or tokens.
    console.warn('[recovery] request_failure', JSON.stringify({
      action: String(request.body?.action || 'unknown').slice(0, 20),
      code: String(error?.code || 'recovery_failed'), status: Number(error?.status || 503),
      ...(error?.upstream ? { upstream: error.upstream } : {}),
    }));
    if (error?.status === 429) response.setHeader('Retry-After', String(error.retryAfter || 1));
    // Never echo the collector body, the phone number, or exception text. The
    // wait is safe to tell: it is the caller's own lock, not anyone's record.
    return response.status(error?.status || 503).json({
      ok: false, error: error?.code || 'recovery_failed',
      ...(error?.status === 429 ? { retryAfter: Number(error.retryAfter) || 1 } : {}),
    });
  }
}
