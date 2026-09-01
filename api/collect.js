const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const SERVER_ONLY_EVENTS = new Set(['customer_order_snapshot']);
const SERVER_ONLY_EVENT_PROPERTY_NAMES = new Set([
  'ownercapabilityhash',
  'owneridentityhash',
]);

import { callDataApi, fetchUpstreamJson } from './_data-upstream.js';

function collectorErrorStatus(code, fallbackStatus = 502) {
  if (code === 'collector_busy') return 503;
  if (code === 'upstream_timeout') return 504;
  return fallbackStatus >= 400 ? fallbackStatus : 502;
}

function sendCollectorError(response, code, fallbackStatus = 502) {
  const status = collectorErrorStatus(code, fallbackStatus);
  if ([503, 504].includes(status)) response.setHeader('Retry-After', '3');
  return response.status(status).json({ ok: false, error: code });
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

function containsServerOnlyEventProperty(value) {
  const pending = [value];
  let inspected = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    inspected += 1;
    if (inspected > 5000) return true;
    for (const [key, nestedValue] of Object.entries(current)) {
      const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (SERVER_ONLY_EVENT_PROPERTY_NAMES.has(normalizedKey)) return true;
      if (nestedValue && typeof nestedValue === 'object') pending.push(nestedValue);
    }
  }
  return false;
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const origin = request.headers.origin;
  if (!isAllowedOrigin(origin, request)) {
    return response.status(403).json({ ok: false, error: 'origin_not_allowed' });
  }

  const event = request.body?.event;
  if (!event?.id || !event?.name || !event?.timestamp || !event?.visitorId) {
    return response.status(400).json({ ok: false, error: 'invalid_event' });
  }
  if (SERVER_ONLY_EVENTS.has(event.name)) {
    return response.status(403).json({ ok: false, error: 'reserved_event' });
  }
  // `owner_product_created` remains a client analytics event. Ownership is
  // established only by the private deal capability path, never by event data.
  if (containsServerOnlyEventProperty(event.properties)) {
    return response.status(403).json({ ok: false, error: 'reserved_event_property' });
  }
  if (
    !/^[a-z][a-z0-9_]{0,63}$/.test(event.name)
    || !/^[a-zA-Z0-9-]{1,128}$/.test(String(event.id))
    || !/^[a-zA-Z0-9-]{1,128}$/.test(String(event.visitorId))
    || !/^[a-zA-Z0-9-]{1,128}$/.test(String(event.sessionId || ''))
    || Number.isNaN(Date.parse(event.timestamp))
    || !event.properties
    || typeof event.properties !== 'object'
    || Array.isArray(event.properties)
    || JSON.stringify(event).length > 45000
  ) {
    return response.status(400).json({ ok: false, error: 'invalid_event' });
  }

  const collectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const collectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  if (!collectorUrl || !collectorToken) {
    return response.status(503).json({ ok: false, error: 'collector_not_configured' });
  }

  try {
    const proxied = await callDataApi('/api/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
    });
    if (proxied) {
      const result = await proxied.json();
      if (!proxied.ok || !result?.ok) {
        return sendCollectorError(
          response,
          result?.error || 'collector_failed',
          proxied.status,
        );
      }
      return response.status(proxied.status).json(result);
    }

    const { upstream, result } = await fetchUpstreamJson(collectorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: collectorToken, event }),
      redirect: 'follow',
    });
    if (!upstream.ok || !result.ok) {
      return sendCollectorError(
        response,
        result?.error || 'collector_failed',
        502,
      );
    }
    return response.status(result.duplicate ? 200 : 202).json({
      ok: true,
      duplicate: Boolean(result.duplicate),
    });
  } catch (error) {
    if (error?.code === 'upstream_timeout') {
      return sendCollectorError(response, 'upstream_timeout', 504);
    }
    return response.status(502).json({ ok: false, error: 'collector_unreachable' });
  }
}
