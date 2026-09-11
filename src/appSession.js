export const ACTIVE_APP_SESSION_KEY = 'o2o_mvp_active_app_session_v1';

function defaultSessionStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function profileSessionKey(profile = {}) {
  const testerType = String(profile?.testerType || '').trim();
  const phone = String(profile?.phone || '').replace(/\D/g, '');
  return testerType && phone ? `${testerType}:${phone}` : '';
}

export function loadActiveAppSession(storage = defaultSessionStorage()) {
  if (!storage) return '';
  try {
    const value = JSON.parse(storage.getItem(ACTIVE_APP_SESSION_KEY) || 'null');
    const startedAt = Number(value?.startedAt || 0);
    const profileKey = String(value?.profileKey || '');
    if (
      !profileKey
      || !Number.isFinite(startedAt)
      || startedAt <= 0
    ) {
      storage.removeItem(ACTIVE_APP_SESSION_KEY);
      return '';
    }
    return profileKey;
  } catch {
    try {
      storage.removeItem(ACTIVE_APP_SESSION_KEY);
    } catch {
      // A blocked storage API behaves like a signed-out browser session.
    }
    return '';
  }
}

export function startActiveAppSession(
  profile,
  storage = defaultSessionStorage(),
  now = Date.now(),
) {
  const profileKey = profileSessionKey(profile);
  if (!profileKey) return '';
  if (!storage) return profileKey;
  try {
    storage.setItem(ACTIVE_APP_SESSION_KEY, JSON.stringify({ profileKey, startedAt: now }));
  } catch {
    // Keep the current React session usable even when browser storage is blocked.
  }
  return profileKey;
}

export function clearActiveAppSession(storage = defaultSessionStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(ACTIVE_APP_SESSION_KEY);
  } catch {
    // React state still signs the current page out when storage is unavailable.
  }
}

export function isActiveAppSession(profile, activeProfileKey) {
  const expectedKey = profileSessionKey(profile);
  return Boolean(expectedKey && expectedKey === activeProfileKey);
}
