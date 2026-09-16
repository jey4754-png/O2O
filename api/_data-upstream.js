const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15000;
const MAX_UPSTREAM_TIMEOUT_MS = 55000;

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

function currentDeploymentOrigins() {
  return new Set([
    process.env.VERCEL_URL ? normalizedOrigin(`https://${process.env.VERCEL_URL}`) : '',
    process.env.VERCEL_BRANCH_URL ? normalizedOrigin(`https://${process.env.VERCEL_BRANCH_URL}`) : '',
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? normalizedOrigin(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
      : '',
    process.env.VERCEL_ENV === 'production' ? PRODUCTION_ORIGIN : '',
  ].filter(Boolean));
}

function upstreamTimeoutMs(overrideMs) {
  const configured = Number(overrideMs ?? process.env.O2O_UPSTREAM_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_UPSTREAM_TIMEOUT_MS, Math.floor(configured)));
}

function timeoutSignal(existingSignal, overrideMs) {
  const deadline = AbortSignal.timeout(upstreamTimeoutMs(overrideMs));
  if (!existingSignal) return deadline;
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([existingSignal, deadline])
    : existingSignal;
}

function normalizeFetchError(error) {
  if (error?.name === 'TimeoutError') {
    const timeoutError = new Error('upstream_timeout');
    timeoutError.code = 'upstream_timeout';
    timeoutError.status = 504;
    return timeoutError;
  }
  return error;
}

function upstreamResponseError() {
  const error = new Error('upstream_invalid_response');
  error.code = 'upstream_invalid_response';
  error.status = 502;
  return error;
}

export function dataApiOrigin() {
  const origin = normalizedOrigin(process.env.O2O_DATA_API_ORIGIN);
  const token = String(process.env.O2O_DATA_API_TOKEN || '');
  if (!origin || !token || currentDeploymentOrigins().has(origin)) return '';
  return origin;
}

export async function callDataApi(path, options = {}) {
  const origin = dataApiOrigin();
  if (!origin) return null;
  try {
    return await fetch(`${origin}${path}`, {
      ...options,
      signal: timeoutSignal(options.signal),
      headers: {
        Origin: PRODUCTION_ORIGIN,
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw normalizeFetchError(error);
  }
}

export async function callDataApiJson(path, options = {}) {
  const origin = dataApiOrigin();
  if (!origin) return null;
  return fetchUpstreamJson(`${origin}${path}`, {
    ...options,
    headers: {
      Origin: PRODUCTION_ORIGIN,
      ...(options.headers || {}),
    },
  });
}

export async function fetchUpstreamJson(url, options = {}) {
  // A cold Apps Script run can exceed the shared default before it answers at
  // all. Callers whose request is a single short round trip may wait longer
  // instead of turning that start-up delay into a user-visible failure.
  const { timeoutMs, ...fetchOptions } = options;
  let upstream;
  try {
    upstream = await fetch(url, {
      ...fetchOptions,
      signal: timeoutSignal(options.signal, timeoutMs),
    });
  } catch (error) {
    throw normalizeFetchError(error);
  }

  let result;
  try {
    result = await upstream.json();
  } catch (error) {
    const normalized = normalizeFetchError(error);
    if (normalized !== error || error?.name === 'AbortError') throw normalized;
    throw upstreamResponseError();
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw upstreamResponseError();
  }
  // A redirected collector POST can unexpectedly reach doGet. Its health
  // envelope proves neither a completed write nor an empty read result. Keep
  // the original operation uncertain so callers retain their existing intent
  // and use only the established idempotent retry path.
  if (String(options.method || 'GET').toUpperCase() === 'POST'
    && result.ok === true && result.service === 'UPTWOYOU collector') {
    throw upstreamResponseError();
  }
  return { upstream, result };
}
