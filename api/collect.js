const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';
const SERVER_ONLY_EVENTS = new Set(['customer_order_snapshot']);

import { callDataApi } from './_data-upstream.js';

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
      return response.status(proxied.status).json(result);
    }

    const upstream = await fetch(collectorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: collectorToken, event }),
      redirect: 'follow',
    });
    const result = await upstream.json();
    if (!upstream.ok || !result.ok) {
      return response.status(502).json({ ok: false, error: 'collector_failed' });
    }
    return response.status(result.duplicate ? 200 : 202).json({
      ok: true,
      duplicate: Boolean(result.duplicate),
    });
  } catch {
    return response.status(502).json({ ok: false, error: 'collector_unreachable' });
  }
}
