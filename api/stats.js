import { callDataApiJson, fetchUpstreamJson } from './_data-upstream.js';

export const config = { maxDuration: 60 };
// Aggregate reads can outlast the shared request deadline on a cold collector.
// Leave time for a structured error before the function's 60-second limit.
const STATS_READ_TIMEOUT_MS = 50000;

function statusForStatsError(code, upstreamStatus = 0) {
  if (upstreamStatus >= 400 && upstreamStatus < 600) return upstreamStatus;
  if (code === 'collector_busy') return 503;
  if (code === 'upstream_timeout') return 504;
  if (String(code).includes('not_configured')) return 503;
  return 502;
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const proxied = await callDataApiJson('/api/stats', { timeoutMs: STATS_READ_TIMEOUT_MS });
    if (proxied) {
      const { upstream, result } = proxied;
      if (!upstream.ok || result.ok !== true || !result.stats) {
        const code = result.error || 'collector_failed';
        return response
          .status(statusForStatsError(code, upstream.ok ? 0 : upstream.status))
          .json({ ok: false, error: code });
      }
      return response.status(upstream.status).json({ ok: true, stats: result.stats });
    }

    const collectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    const collectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    if (!collectorUrl || !collectorToken) {
      return response.status(503).json({ ok: false, error: 'collector_not_configured' });
    }
    const { upstream, result } = await fetchUpstreamJson(collectorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: collectorToken, action: 'stats' }),
      redirect: 'follow',
      timeoutMs: STATS_READ_TIMEOUT_MS,
    });
    if (!upstream.ok || !result.ok || !result.stats) {
      const code = result.error || 'collector_failed';
      return response
        .status(statusForStatsError(code, upstream.ok ? 0 : upstream.status))
        .json({ ok: false, error: code });
    }
    return response.status(200).json({ ok: true, stats: result.stats });
  } catch (error) {
    const code = error?.code || 'collector_unreachable';
    return response
      .status(error?.status || statusForStatsError(code))
      .json({ ok: false, error: code });
  }
}
