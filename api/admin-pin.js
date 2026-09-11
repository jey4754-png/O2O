import {
  adminAuthError,
  applyAdminAuthResponseHeaders,
  matchesAdminPinWithRateLimit,
  readAdminCredential,
  verifyAdminPin,
  writeAdminCredential,
} from './_admin-auth.js';

export const config = { maxDuration: 60 };

async function duplicateResult(credential, body, request) {
  if (credential?.lastMutationId !== body.clientMutationId || credential.updatedBy !== body.actorId
    || !await matchesAdminPinWithRateLimit(body.newPin, credential, request)) return null;
  return { ok: true, version: credential.version, updatedAt: credential.updatedAt, duplicate: true };
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const origins = new Set(['https://o2o-ten.vercel.app',
      ...['VERCEL_URL', 'VERCEL_BRANCH_URL'].map((key) => process.env[key] ? `https://${process.env[key]}` : ''),
    ].filter(Boolean));
    const origin = String(request.headers?.origin || '');
    const local = process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!origins.has(origin) && !local) throw adminAuthError('forbidden_origin', 403);
    if (typeof request.body === 'string' && request.body.length > 4096) throw adminAuthError('payload_too_large', 413);
    let body;
    try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; }
    catch { throw adminAuthError('invalid_request'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw adminAuthError('invalid_request');
    if (JSON.stringify(body).length > 4096) throw adminAuthError('payload_too_large', 413);
    if (body.action !== 'change') throw adminAuthError('invalid_action');
    if (typeof body.adminPin !== 'string' || !body.adminPin || body.adminPin.length > 128) {
      await verifyAdminPin(body.adminPin, request);
    }
    if (typeof body.newPin !== 'string' || !/^\d{8,12}$/.test(body.newPin)) throw adminAuthError('invalid_new_pin');
    if (body.confirmPin !== body.newPin) throw adminAuthError('pin_mismatch');
    if (body.adminPin === body.newPin) throw adminAuthError('pin_unchanged');
    if (typeof body.actorId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(body.actorId)) throw adminAuthError('invalid_actor_id');
    if (typeof body.clientMutationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(body.clientMutationId)) throw adminAuthError('invalid_client_mutation_id');

    const credential = await readAdminCredential();
    // A response may be lost after commit. Only the same actor/mutation AND
    // knowledge of the new PIN can acknowledge that exact successful change.
    if (credential?.lastMutationId === body.clientMutationId) {
      const duplicate = await duplicateResult(credential, body, request);
      if (duplicate) return response.status(200).json(duplicate);
      throw adminAuthError('state_conflict', 409);
    }
    if (!await matchesAdminPinWithRateLimit(body.adminPin, credential, request)) throw adminAuthError('invalid_admin_pin', 403);
    let result;
    try {
      result = await writeAdminCredential({
        newPin: body.newPin, expectedVersion: credential?.version || 0,
        actorId: body.actorId, clientMutationId: body.clientMutationId,
      });
    } catch (error) {
      // Concurrent identical retries derive different salts. If the other
      // request already committed this exact change, acknowledge its receipt.
      if (error.code !== 'state_conflict') throw error;
      result = await duplicateResult(await readAdminCredential(), body, request);
      if (!result) throw error;
    }
    return response.status(200).json(result);
  } catch (error) {
    applyAdminAuthResponseHeaders(response, error);
    return response.status(error.status || 503).json({ ok: false, error: error.code || 'admin_pin_change_failed' });
  }
}
