import test from 'node:test';
import assert from 'node:assert/strict';
import { latestPaymentNotice } from './paymentNotices.js';
const snapshot = {
  participants: [{ actorId: 'me', role: 'member', nickname: '참여자' }, { actorId: 'host', role: 'host' }],
  history: [{ id: 'pay-1', entityType: 'payment', entityId: 'me', actorId: 'host', toStatus: 'confirmed' }],
};
test('payment history creates a persistent unread notice for its participant, not unrelated viewers', () => {
  assert.match(latestPaymentNotice(snapshot, 'me').text, /입금완료/);
  assert.equal(latestPaymentNotice(snapshot, 'me', 'pay-1'), null);
  assert.equal(latestPaymentNotice(snapshot, 'stranger'), null);
  assert.equal(latestPaymentNotice(snapshot, 'host'), null);
});
test('host sees other participant requests and reversal notices have distinct IDs', () => {
  const next = { ...snapshot, history: [...snapshot.history,
    { id: 'pay-2', entityType: 'payment', entityId: 'me', actorId: 'me', toStatus: 'requested' }] };
  assert.match(latestPaymentNotice(next, 'host').text, /입금확인 요청/);
  const reversed = { ...snapshot, history: [...snapshot.history,
    { id: 'pay-3', entityType: 'payment', entityId: 'me', actorId: 'host', toStatus: 'pending' }] };
  assert.match(latestPaymentNotice(reversed, 'me', 'pay-1').text, /입금대기/);
});

test('a later action by the viewer supersedes an older payment notification', () => {
  const next = { ...snapshot, history: [...snapshot.history,
    { id: 'pay-new', entityType: 'payment', entityId: 'me', actorId: 'me', toStatus: 'requested' }] };
  assert.equal(latestPaymentNotice(next, 'me'), null);
});

test('cancelled participants and obsolete states do not revive old payment requests', () => {
  const request = { id: 'old-request', entityType: 'payment', entityId: 'me', actorId: 'me', toStatus: 'requested' };
  const inactive = { participants: [{ actorId: 'me', role: 'member', active: false }, { actorId: 'host', role: 'host' }], history: [request] };
  assert.equal(latestPaymentNotice(inactive, 'host'), null);
  assert.equal(latestPaymentNotice({ ...inactive, participants: [{ actorId: 'me', role: 'member', counted: false }, { actorId: 'host', role: 'host' }] }, 'host'), null);
  assert.equal(latestPaymentNotice({ ...inactive, participants: [{ actorId: 'me', role: 'member', paymentStatus: 'confirmed' }, { actorId: 'host', role: 'host' }] }, 'host'), null);
});

test('reading the latest notice also keeps older participant requests from resurfacing', () => {
  const next = { participants: [...snapshot.participants, { actorId: 'other', role: 'member', paymentStatus: 'requested' }],
    history: [
      { id: 'older', entityType: 'payment', entityId: 'other', actorId: 'other', toStatus: 'requested' },
      { id: 'newer', entityType: 'payment', entityId: 'me', actorId: 'me', toStatus: 'requested' },
    ] };
  assert.equal(latestPaymentNotice(next, 'host', 'newer'), null);
});

test('a new request after acknowledgement still notifies and active participant notices survive other removals', () => {
  const next = { participants: [...snapshot.participants, { actorId: 'removed', active: false }],
    history: [...snapshot.history,
      { id: 'new-request', entityType: 'payment', entityId: 'me', actorId: 'me', toStatus: 'requested' },
      { id: 'removed-request', entityType: 'payment', entityId: 'removed', actorId: 'removed', toStatus: 'requested' }] };
  assert.equal(latestPaymentNotice(next, 'host', 'pay-1')?.id, 'new-request');
});
