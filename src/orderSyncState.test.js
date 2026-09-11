import assert from 'node:assert/strict';
import test from 'node:test';
import { customerOrderSyncFingerprint } from './customerHistory.js';
import { orderSyncStateChanged, rejectedOrderSyncIssue, shouldPublishQueuedOrder } from './orderSyncState.js';

const order = { id: 'order-1789005828813586277', groupId: 'group-test',
  selectedCount: 1, quantity: 1, total: 3340, status: 'new', paymentStatus: 'pending' };

test('a rejected order is held separately from a successful acknowledgement', () => {
  const acknowledgements = {};
  const issues = { [order.id]: rejectedOrderSyncIssue(order, { code: 'invalid_reservation' }) };
  assert.equal(shouldPublishQueuedOrder(order, acknowledgements, issues), false);
  assert.deepEqual(acknowledgements, {});
  assert.equal(shouldPublishQueuedOrder({ ...order, total: 3338 }, acknowledgements, issues), true);
});

test('legacy rejected fingerprints stay held and pending issues never become success', () => {
  const acknowledgements = { [order.id]: customerOrderSyncFingerprint(order) };
  assert.equal(shouldPublishQueuedOrder(order, acknowledgements), false);
  assert.equal(shouldPublishQueuedOrder(order, acknowledgements,
    { [order.id]: { state: 'failed' } }), false);
  assert.equal(shouldPublishQueuedOrder(order, acknowledgements,
    { [order.id]: { state: 'pending' } }), true);
});

test('explicit retry can clear the rejection only after an accepted snapshot', () => {
  const issues = { [order.id]: rejectedOrderSyncIssue(order, { status: 403 }) };
  assert.equal(shouldPublishQueuedOrder(order, {}, issues), false);
  delete issues[order.id];
  assert.equal(shouldPublishQueuedOrder(order, {}, issues), true);
  assert.equal(shouldPublishQueuedOrder(order,
    { [order.id]: customerOrderSyncFingerprint(order) }, issues), false);
});

test('a late failure cannot overwrite a newer acknowledgement or a cleared issue', () => {
  assert.equal(orderSyncStateChanged({ previousOrder: order, currentOrder: order,
    previousIssue: { state: 'pending' }, currentAcknowledgement: 'accepted' }), true);
  assert.equal(orderSyncStateChanged({ previousOrder: order, currentOrder: order,
    previousIssue: { state: 'pending' } }), true);
  assert.equal(orderSyncStateChanged({ previousOrder: order, currentOrder: order }), false);
});

test('orders created during a history read keep their newer acknowledgement and payment', () => {
  const currentOrder = { ...order, paymentStatus: 'requested', paymentVersion: 2 };
  assert.equal(orderSyncStateChanged({ currentOrder,
    currentAcknowledgement: customerOrderSyncFingerprint(currentOrder) }), true);
  assert.equal(orderSyncStateChanged({}), false, 'a genuinely new central row can still be accepted');
});
