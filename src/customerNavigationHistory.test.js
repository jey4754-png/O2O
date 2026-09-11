import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCustomerNavigationState,
  customerNavigationBackSteps,
  customerNavigationDepth,
  readCustomerNavigationState,
} from './customerNavigationHistory.js';

test('customer browser history preserves unrelated state and scopes screens to the route', () => {
  const state = buildCustomerNavigationState(
    { existing: 'value' },
    { route: '/customer', screen: 'room', depth: 4, trail: ['list', 'detail', 'join', 'complete'] },
  );
  assert.equal(state.existing, 'value');
  assert.deepEqual(readCustomerNavigationState(state, '/customer'), {
    route: '/customer', screen: 'room', depth: 4,
    trail: ['list', 'detail', 'join', 'complete'],
  });
  assert.equal(readCustomerNavigationState(state, '/admin'), null);
  assert.equal(customerNavigationDepth(state, '/customer'), 4);
  assert.equal(customerNavigationBackSteps(state, '/customer', 'detail'), 3);
  assert.equal(customerNavigationBackSteps(state, '/customer', 'list'), 4);
  assert.equal(customerNavigationBackSteps(state, '/customer', 'explore'), 0);
});

test('invalid browser history depth is safely treated as the route root', () => {
  const state = buildCustomerNavigationState(null, {
    route: '/customer', screen: 'list', depth: -10,
  });
  assert.equal(customerNavigationDepth(state, '/customer'), 0);
});
