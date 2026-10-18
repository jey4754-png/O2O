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

test('an active order for a room this device holds no credential for blocks a second join', async () => {
  const { orderSeatWithoutRoomCredential } = await import('./orderRoomAccess.js');
  const memo = { id: 'order-1', type: 'purchase', groupId: 'memo-room', status: 'new', paymentStatus: 'pending' };
  assert.equal(orderSeatWithoutRoomCredential({ orders: [memo], groupIds: ['memo-room'], credential: null }), memo);
  // A saved credential opens the room instead; nothing to guard.
  assert.equal(orderSeatWithoutRoomCredential({ orders: [memo], groupIds: ['memo-room'], credential }), null);
  // Cancelled orders, other rooms and no orders leave joining as it was.
  for (const orders of [[{ ...memo, status: 'cancelled' }], [{ ...memo, paymentStatus: 'cancelled' }],
    [{ ...memo, groupId: 'milk-room' }], []]) {
    assert.equal(orderSeatWithoutRoomCredential({ orders, groupIds: ['memo-room'], credential: null }), null);
  }
  // Older snapshots without groupId match by dealId.
  const legacy = { id: 'order-2', type: 'purchase', dealId: 'memo-room', status: 'new' };
  assert.equal(orderSeatWithoutRoomCredential({ orders: [legacy], groupIds: ['memo-room'], credential: null }), legacy);
});

test('a room credential held under another actor id blocks joining as this visitor', async () => {
  const { roomCredentialUnderAnotherActor, ORDER_SEAT_ELSEWHERE_MESSAGE } = await import('./orderRoomAccess.js');
  const recovered = { ...credential, actorId: 'actor-7aec52', recovered: true };
  // PC 방문자 f03372 가 되살린 7aec52 자리만 가진 방: 지금 방문자ID 로 join 하면 자리가 둘이 된다.
  assert.equal(roomCredentialUnderAnotherActor({
    exactCredential: null, roomCredential: recovered, actorId: 'visitor-f03372',
  }), recovered);
  // 지금 방문자ID 의 자격이 있으면 수량 추가(reserve_quantity)로 간다.
  assert.equal(roomCredentialUnderAnotherActor({
    exactCredential: { ...credential, actorId: 'visitor-f03372' }, roomCredential: recovered, actorId: 'visitor-f03372',
  }), null);
  // 자격이 없거나 같은 참여자ID 이면 막지 않는다.
  assert.equal(roomCredentialUnderAnotherActor({ exactCredential: null, roomCredential: null, actorId: 'visitor-f03372' }), null);
  assert.equal(roomCredentialUnderAnotherActor({
    exactCredential: null, roomCredential: { ...recovered, actorId: 'visitor-f03372' }, actorId: 'visitor-f03372',
  }), null);
  assert.match(ORDER_SEAT_ELSEWHERE_MESSAGE, /되살린 뒤에도 같으면 운영자에게 이 주문의 채팅 연결 점검을 요청해 주세요/);
});
