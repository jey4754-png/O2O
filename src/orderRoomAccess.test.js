import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrderRoomAccess } from './orderRoomAccess.js';

const order = { groupId: 'original-group', participantActorId: 'original-seat', visitorId: 'new-visitor' };
const deal = { id: 'listing-id', saleType: 'group' };
const credential = { groupId: 'original-group', actorId: 'original-seat', capabilityToken: 'x'.repeat(48), active: true };

test('an existing order resolves its original group and seat, not the current visitor or listing', () => {
  assert.deepEqual(resolveOrderRoomAccess(order, deal, (groupId, actorId) => {
    assert.equal(groupId, 'original-group');
    assert.equal(actorId, 'original-seat');
    return credential;
  }), { groupId: 'original-group', actorId: 'original-seat' });
});

test('legacy orders can use their original visitor id when participantActorId is absent', () => {
  assert.deepEqual(resolveOrderRoomAccess({ visitorId: 'original-seat' }, { id: 'original-group' }, () => credential),
    { groupId: 'original-group', actorId: 'original-seat' });
});

test('a phone number or order alone never authorizes a room', () => {
  assert.equal(resolveOrderRoomAccess({ ...order, phone: '01000001002' }, deal, () => null), null);
  assert.equal(resolveOrderRoomAccess({ groupId: order.groupId, phone: '01000001002' }, deal, () => credential), null);
});

test('wrong group, wrong seat, inactive and invalid credentials cannot be used', () => {
  for (const override of [{ groupId: 'other' }, { actorId: 'other' }, { active: false }, { capabilityToken: '' }]) {
    assert.equal(resolveOrderRoomAccess(order, deal, () => ({ ...credential, ...override })), null);
  }
});

test('cancelled orders and instant purchases cannot open an existing group room', () => {
  for (const override of [{ status: 'cancelled' }, { paymentStatus: 'cancelled' }]) {
    assert.equal(resolveOrderRoomAccess({ ...order, ...override }, deal, () => credential), null);
  }
  assert.equal(resolveOrderRoomAccess(order, { ...deal, saleType: 'instant' }, () => credential), null);
});
