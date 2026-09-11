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
