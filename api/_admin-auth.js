import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fetchUpstreamJson } from './_data-upstream.js';

const deriveKey = promisify(scrypt);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MUTATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const RATE_LIMIT_KEY = /^[a-f0-9]{32}$/;
const ADMIN_CREDENTIAL_TIMEOUT_MS = 25000;
export function adminAuthError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function header(request, name) {
  const value = request?.headers?.[name] ?? request?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function rateLimitClientKey(request) {
  const secret = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  if (!secret) throw adminAuthError('admin_not_configured', 503);
  // Vercel appends the trusted peer to X-Forwarded-For. Selecting the
  // right-most value prevents a caller-supplied left-most value from creating
  // an unlimited number of buckets. The raw address never leaves this process.
  const forwarded = header(request, 'x-vercel-forwarded-for')
    || header(request, 'x-real-ip')
    || header(request, 'x-forwarded-for');
  const parts = forwarded.split(',').map((value) => value.trim()).filter(Boolean);
  const address = (parts.at(-1) || request?.socket?.remoteAddress || 'unknown').slice(0, 128);
  return createHmac('sha256', secret).update(`admin-pin:${address}`, 'utf8').digest('hex').slice(0, 32);
}

function rateLimited(retryAfter) {
  const error = adminAuthError('admin_rate_limited', 429);
  const seconds = Number(retryAfter);
  error.retryAfter = Number.isFinite(seconds) && seconds > 0
    ? Math.max(1, Math.min(3600, Math.ceil(seconds)))
    : 1;
  return error;
}

export function applyAdminAuthResponseHeaders(response, error) {
  if (error?.status !== 429) return;
  const upstreamValue = typeof error.headers?.get === 'function'
    ? error.headers.get('retry-after')
    : error.headers?.['retry-after'];
  const seconds = Number(error.retryAfter ?? upstreamValue);
  response.setHeader('Retry-After', String(Number.isFinite(seconds) && seconds > 0
    ? Math.max(1, Math.min(3600, Math.ceil(seconds)))
    : 1));
}

function validRecord(record) {
  return record && !Array.isArray(record) && record.algorithm === 'scrypt-v1'
    && typeof record.salt === 'string' && /^[a-f0-9]{32}$/.test(record.salt)
    && typeof record.hash === 'string' && /^[a-f0-9]{128}$/.test(record.hash)
    && Number.isSafeInteger(record.version) && record.version >= 1
    && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
    && typeof record.updatedBy === 'string' && ID.test(record.updatedBy)
    && typeof record.lastMutationId === 'string' && MUTATION_ID.test(record.lastMutationId);
}

async function credentialRequest(payload) {
  const url = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const token = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  if (!url || !token) throw adminAuthError('admin_not_configured', 503);
  try {
    const body = JSON.stringify({ token, action: 'admin_credentials', payload });
    const retryDelays = [300, 700];
    for (let attempt = 0; ; attempt += 1) {
      const { upstream, result } = await fetchUpstreamJson(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        // A reserved rate-limit slot is lost when this request times out, so a
        // cold collector start must not be cut short. The admin functions allow
        // 60s, which still bounds this call plus the operation that follows.
        timeoutMs: ADMIN_CREDENTIAL_TIMEOUT_MS,
      });
      // These exact GAS responses originate only before acquiring the auth
      // script lock, before reading or changing the limiter. Do not replay an
      // uncertain response, a limiter denial, or any credential mutation.
      if (attempt < retryDelays.length && ['rate_begin', 'rate_success'].includes(payload.operation)
        && upstream.status === 200 && result.ok === false && result.error === 'collector_busy'
        && Object.keys(result).length === 2) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      if (upstream.status >= 400 || result.ok !== true) {
        if (['state_conflict', 'client_mutation_conflict'].includes(result.error)) {
          throw adminAuthError('state_conflict', 409);
        }
        throw adminAuthError('admin_credential_store_unavailable', 503);
      }
      return result;
    }
  } catch (error) {
    // Never expose the collector's body, credentials, or arbitrary exception text.
    if (error.code === 'state_conflict') throw error;
    throw adminAuthError('admin_credential_store_unavailable', 503);
  }
}

async function rateLimitRequest(operation, clientKey) {
  if (!RATE_LIMIT_KEY.test(clientKey)) throw adminAuthError('admin_credential_store_unavailable', 503);
  const result = await credentialRequest({ operation, clientKey });
  if (typeof result.allowed !== 'boolean') {
    throw adminAuthError('admin_credential_store_unavailable', 503);
  }
  if (!result.allowed) throw rateLimited(result.retryAfter);
  if (operation === 'rate_begin' && result.reserved !== true) {
    throw adminAuthError('admin_credential_store_unavailable', 503);
  }
  return result;
}

async function beginAdminPinAttempt(request) {
  const clientKey = rateLimitClientKey(request);
  const result = await rateLimitRequest('rate_begin', clientKey);
  const attempt = { clientKey };
  // New collectors return the credential snapshot from the same locked request
  // that reserves the shared rate-limit slot. Older collectors omit this field,
  // so retain the separate read as a rollout-safe fallback.
  if (Object.hasOwn(result, 'credential')) {
    if (result.credential !== null && !validRecord(result.credential)) {
      throw adminAuthError('admin_credential_store_unavailable', 503);
    }
    attempt.credential = result.credential;
  }
  return attempt;
}

async function evaluateAdminPin(pin, credential, request, checkedClientKey) {
  const clientKey = checkedClientKey || (await beginAdminPinAttempt(request)).clientKey;
  const matched = await matchesAdminPin(pin, credential);
  // Authentication is denied if the shared limiter cannot durably record the
  // result. That fail-closed rule prevents a collector outage from becoming a
  // brute-force bypass and applies equally to valid and invalid candidates.
  await rateLimitRequest(matched ? 'rate_success' : 'rate_failure', clientKey);
  return matched;
}

export async function readAdminCredential() {
  const result = await credentialRequest({ operation: 'read' });
  // An older collector can return {ok:true} for an unknown action. That is not
  // an explicit empty credential store and MUST NOT reactivate the env PIN.
  if (!Object.hasOwn(result, 'credential')
    || (result.credential !== null && !validRecord(result.credential))) {
    throw adminAuthError('admin_credential_store_unavailable', 503);
  }
  return result.credential;
}

export async function matchesAdminPin(pin, credential) {
  if (typeof pin !== 'string' || !pin || pin.length > 128) return false;
  if (credential === null) {
    const expected = process.env.O2O_ADMIN_PIN;
    if (!expected) throw adminAuthError('admin_not_configured', 503);
    const left = Buffer.from(pin);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  if (!validRecord(credential)) throw adminAuthError('admin_credential_store_unavailable', 503);
  const key = await deriveKey(pin, Buffer.from(credential.salt, 'hex'), 64, SCRYPT_OPTIONS);
  return timingSafeEqual(key, Buffer.from(credential.hash, 'hex'));
}

export async function matchesAdminPinWithRateLimit(pin, credential, request) {
  return evaluateAdminPin(pin, credential, request);
}

export async function verifyAdminPin(pin, request) {
  const attempt = await beginAdminPinAttempt(request);
  const clientKey = attempt.clientKey;
  if (typeof pin !== 'string' || !pin || pin.length > 128) {
    await rateLimitRequest('rate_failure', clientKey);
    throw adminAuthError('invalid_admin_pin', 403);
  }
  const credential = Object.hasOwn(attempt, 'credential')
    ? attempt.credential
    : await readAdminCredential();
  if (!await evaluateAdminPin(pin, credential, request, clientKey)) throw adminAuthError('invalid_admin_pin', 403);
  return credential;
}

export async function writeAdminCredential({ newPin, expectedVersion, actorId, clientMutationId }) {
  const salt = randomBytes(16);
  const key = await deriveKey(newPin, salt, 64, SCRYPT_OPTIONS);
  const result = await credentialRequest({
    operation: 'write', adminAssertion: true, expectedVersion, actorId, clientMutationId,
    credential: { algorithm: 'scrypt-v1', salt: salt.toString('hex'), hash: key.toString('hex') },
  });
  if (result.version !== expectedVersion + 1 || typeof result.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(result.updatedAt))) {
    throw adminAuthError('admin_credential_store_unavailable', 503);
  }
  return { ok: true, version: result.version, updatedAt: result.updatedAt };
}
