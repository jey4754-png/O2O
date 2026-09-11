const ADMIN_CUSTOMER_SCREENS = new Set(['list', 'detail', 'room', 'notifications']);
const READ_ONLY_CUSTOMER_SCREENS = new Set(['list', 'detail', 'explore', 'calculator']);

export function resolveCustomerAccess({
  route = '',
  testerType = '',
  ownerPreviewMode = false,
} = {}) {
  const customerRoute = route === '/customer';
  return {
    adminMode: route === '/admin' || (customerRoute && testerType === '관리자'),
    readOnly: Boolean(ownerPreviewMode || (customerRoute && testerType === '사장님')),
  };
}

export function customerAccessMode({ adminMode = false, readOnly = false } = {}) {
  if (adminMode) return 'admin';
  if (readOnly) return 'read_only';
  return 'customer';
}

export function customerScreenAllowed(screen, options = {}) {
  const mode = customerAccessMode(options);
  if (mode === 'admin') return ADMIN_CUSTOMER_SCREENS.has(screen);
  if (mode === 'read_only') return READ_ONLY_CUSTOMER_SCREENS.has(screen);
  return true;
}

export function normalizeCustomerScreen(screen, options = {}) {
  return customerScreenAllowed(screen, options) ? screen : 'list';
}

export function customerCanMutate(options = {}) {
  return customerAccessMode(options) === 'customer';
}

export function customerCanOpenGroupRoom({
  adminMode = false,
  readOnly = false,
  credential = null,
  localCreator = false,
} = {}) {
  return Boolean(
    adminMode
    || (!readOnly && (
      (credential && credential.active !== false)
      || localCreator
    )),
  );
}

export function assertCustomerMutationAllowed(options = {}) {
  if (customerCanMutate(options)) return true;
  const error = new Error('customer_read_only');
  error.code = 'customer_read_only';
  throw error;
}

export function filterCustomerNavigation(items, options = {}) {
  return items.filter((item) => customerScreenAllowed(item.screen, options));
}
