const VITE_ENV = import.meta.env || {};

export function featuresForPhase(value) {
  const parsed = Number(value);
  const phase = Number.isInteger(parsed) ? Math.min(12, Math.max(1, parsed)) : 6;
  return Object.freeze({
    phase,
    chat: phase >= 8,
    admin: phase >= 8,
    unreadBadges: phase >= 8,
    sharing: phase >= 9,
    deepLinks: phase >= 9,
  });
}

export const RELEASE_FEATURES = featuresForPhase(VITE_ENV.VITE_RELEASE_PHASE ?? 6);
