import assert from 'node:assert/strict';
import test from 'node:test';
import { isOlderGroupSnapshot } from './groupSnapshotFreshness.js';

const current = { group: { id: 'group-test', version: 1 }, lastSeq: 7,
  participants: [{ actorId: 'actor-test', paymentStatus: 'requested', version: 2 }] };
test('a late poll cannot restore pending after a successful payment request', () => {
  assert.equal(isOlderGroupSnapshot({ ...current, participants: [
    { actorId: 'actor-test', paymentStatus: 'pending', version: 1 },
  ] }, current), true);
  assert.equal(isOlderGroupSnapshot({ ...current, lastSeq: 6 }, current), true);
});
test('a newer intentional payment reversal and participant removal remain visible', () => {
  assert.equal(isOlderGroupSnapshot({ ...current, participants: [
    { actorId: 'actor-test', paymentStatus: 'pending', version: 3 },
  ] }, current), false);
  assert.equal(isOlderGroupSnapshot({ ...current, group: { id: 'group-test', version: 2 }, participants: [] }, current), false);
  assert.equal(isOlderGroupSnapshot(current, null), false);
});
