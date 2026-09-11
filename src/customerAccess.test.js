import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCustomerMutationAllowed,
  customerCanMutate,
  customerCanOpenGroupRoom,
  customerScreenAllowed,
  filterCustomerNavigation,
  normalizeCustomerScreen,
  resolveCustomerAccess,
} from './customerAccess.js';

test('persisted tester type determines customer access after direct navigation or reload', () => {
  assert.deepEqual(
    resolveCustomerAccess({ route: '/customer', testerType: '관리자' }),
    { adminMode: true, readOnly: false },
  );
  assert.deepEqual(
    resolveCustomerAccess({ route: '/customer', testerType: '사장님' }),
    { adminMode: false, readOnly: true },
  );
  assert.deepEqual(
    resolveCustomerAccess({ route: '/owner', testerType: '사장님' }),
    { adminMode: false, readOnly: false },
  );
  assert.deepEqual(
    resolveCustomerAccess({ route: '/customer', testerType: '사용자', ownerPreviewMode: true }),
    { adminMode: false, readOnly: true },
  );
});

test('admin customer shell only exposes monitoring and management screens', () => {
  const options = { adminMode: true };
  ['list', 'detail', 'room', 'notifications'].forEach((screen) => {
    assert.equal(customerScreenAllowed(screen, options), true);
  });
  ['calculator', 'group', 'join', 'explore', 'orders', 'favorites', 'profile', 'survey', 'complete']
    .forEach((screen) => assert.equal(customerScreenAllowed(screen, options), false));
  assert.equal(normalizeCustomerScreen('orders', options), 'list');
});

test('merchant customer preview stays read-only while retaining browse and calculator screens', () => {
  const options = { readOnly: true };
  ['list', 'detail', 'explore', 'calculator'].forEach((screen) => {
    assert.equal(customerScreenAllowed(screen, options), true);
  });
  ['room', 'notifications', 'join', 'group', 'orders', 'favorites', 'profile', 'survey', 'complete']
    .forEach((screen) => assert.equal(customerScreenAllowed(screen, options), false));

  const items = [
    { screen: 'list' },
    { screen: 'explore' },
    { screen: 'calculator' },
    { screen: 'orders' },
  ];
  assert.deepEqual(
    filterCustomerNavigation(items, options).map((item) => item.screen),
    ['list', 'explore', 'calculator'],
  );
});

test('customer mutations fail closed for admin and merchant preview modes', () => {
  assert.equal(customerCanMutate(), true);
  assert.equal(assertCustomerMutationAllowed(), true);
  assert.equal(customerCanMutate({ adminMode: true }), false);
  assert.equal(customerCanMutate({ readOnly: true }), false);
  assert.throws(
    () => assertCustomerMutationAllowed({ adminMode: true }),
    (error) => error?.code === 'customer_read_only',
  );
  assert.throws(
    () => assertCustomerMutationAllowed({ readOnly: true }),
    (error) => error?.code === 'customer_read_only',
  );
});

test('group rooms require an admin session, an existing credential, or a locally owned legacy group', () => {
  assert.equal(customerCanOpenGroupRoom(), false);
  assert.equal(customerCanOpenGroupRoom({ credential: { role: 'member' } }), true);
  assert.equal(customerCanOpenGroupRoom({ credential: { role: 'creator' } }), true);
  assert.equal(customerCanOpenGroupRoom({ credential: { role: 'member', active: false } }), false);
  assert.equal(customerCanOpenGroupRoom({ credential: { role: 'creator', active: false } }), false);
  assert.equal(customerCanOpenGroupRoom({ localCreator: true }), true);
  assert.equal(
    customerCanOpenGroupRoom({ credential: { role: 'creator', active: false }, localCreator: true }),
    true,
  );
  assert.equal(customerCanOpenGroupRoom({ adminMode: true }), true);
  assert.equal(
    customerCanOpenGroupRoom({ readOnly: true, credential: { role: 'host' } }),
    false,
  );
  assert.equal(customerCanOpenGroupRoom({ readOnly: true, localCreator: true }), false);
});
