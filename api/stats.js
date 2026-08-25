import { callDataApi } from './_data-upstream.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const collectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const collectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  if (!collectorUrl || !collectorToken) {
    return response.status(503).json({ ok: false, error: 'collector_not_configured' });
  }

  try {
    const proxied = await callDataApi('/api/stats');
    if (proxied) {
      const result = await proxied.json();
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      return response.status(proxied.status).json(result);
    }

    const upstream = await fetch(collectorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: collectorToken, action: 'stats' }),
      redirect: 'follow',
    });
    const result = await upstream.json();
    if (!upstream.ok || !result.ok || !result.stats) {
      return response.status(502).json({ ok: false, error: 'collector_failed' });
    }
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    return response.status(200).json({ ok: true, stats: result.stats });
  } catch {
    return response.status(502).json({ ok: false, error: 'collector_unreachable' });
  }
}
