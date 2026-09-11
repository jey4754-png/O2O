const CUSTOMER_NAVIGATION_STATE_KEY = 'o2oCustomerNavigation';

export function readCustomerNavigationState(state, route) {
  const entry = state?.[CUSTOMER_NAVIGATION_STATE_KEY];
  if (!entry || entry.route !== route || typeof entry.screen !== 'string') return null;
  const depth = Number(entry.depth);
  return {
    route,
    screen: entry.screen,
    depth: Number.isSafeInteger(depth) && depth >= 0 ? depth : 0,
    trail: Array.isArray(entry.trail)
      ? entry.trail.filter((screen) => typeof screen === 'string').slice(-20)
      : [],
  };
}

export function buildCustomerNavigationState(state, navigation) {
  return {
    ...(state && typeof state === 'object' ? state : {}),
    [CUSTOMER_NAVIGATION_STATE_KEY]: {
      route: navigation.route,
      screen: navigation.screen,
      depth: Math.max(0, Number(navigation.depth) || 0),
      trail: Array.isArray(navigation.trail)
        ? navigation.trail.filter((screen) => typeof screen === 'string').slice(-20)
        : [],
    },
  };
}

export function customerNavigationDepth(state, route) {
  return readCustomerNavigationState(state, route)?.depth || 0;
}

export function customerNavigationBackSteps(state, route, fallbackScreen) {
  const entry = readCustomerNavigationState(state, route);
  if (!entry) return 0;
  const targetIndex = entry.trail.lastIndexOf(fallbackScreen);
  return targetIndex < 0 ? 0 : entry.trail.length - targetIndex;
}
