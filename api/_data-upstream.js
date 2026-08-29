const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15000;

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

function upstreamTimeoutMs() {
  const configured = Number(process.env.O2O_UPSTREAM_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.max(1000, Math.min(25000, Math.floor(configured)));
}

function timeoutSignal(existingSignal) {
  const deadline = AbortSignal.timeout(upstreamTimeoutMs());
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
  try {
    const upstream = await fetch(url, {
      ...options,
      signal: timeoutSignal(options.signal),
    });
    const result = await upstream.json();
    return { upstream, result };
  } catch (error) {
    throw normalizeFetchError(error);
  }
}
