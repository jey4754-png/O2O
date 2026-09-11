import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOwnerBackup,
  mergeVerifiedOwnerBackup,
  parseOwnerBackup,
} from './ownerBackup.js';

const ownerScope = 'phone:01012345678';
const token = `deal-${'a'.repeat(64)}`;

test('owner backup contains only management keys in the active phone scope', () => {
  const backup = buildOwnerBackup({
    ownerScope,
    capabilities: {
      'owner-current': token,
      'owner-other': `deal-${'b'.repeat(64)}`,
      'customer-public': `deal-${'c'.repeat(64)}`,
    },
    scopeByDeal: {
      'owner-current': ownerScope,
      'owner-other': 'phone:01099998888',
      'customer-public': ownerScope,
    },
  });
  assert.deepEqual(backup.entries, [{ dealId: 'owner-current', capabilityToken: token }]);
  assert.deepEqual(parseOwnerBackup(JSON.stringify(backup), ownerScope).entries, backup.entries);
});

test('owner backup rejects another phone scope and malformed or duplicate keys', () => {
  const backup = buildOwnerBackup({
    ownerScope,
    capabilities: { 'owner-current': token },
    scopeByDeal: { 'owner-current': ownerScope },
  });
  assert.throws(() => parseOwnerBackup(JSON.stringify(backup), 'phone:01099998888'));
  backup.entries.push(backup.entries[0]);
  assert.throws(() => parseOwnerBackup(JSON.stringify(backup), ownerScope));
});

test('owner restore persists only server-verified non-conflicting keys', () => {
  const result = mergeVerifiedOwnerBackup({
    ownerScope,
    entries: [
      { dealId: 'owner-valid', capabilityToken: token },
      { dealId: 'owner-unverified', capabilityToken: `deal-${'b'.repeat(64)}` },
      { dealId: 'owner-conflict', capabilityToken: `deal-${'c'.repeat(64)}` },
    ],
    verifiedDealIds: ['owner-valid', 'owner-conflict'],
    capabilities: { 'owner-conflict': `deal-${'d'.repeat(64)}` },
    scopeByDeal: {},
  });
  assert.deepEqual(result.restoredDealIds, ['owner-valid']);
  assert.deepEqual(result.conflicts, ['owner-conflict']);
  assert.equal(result.capabilities['owner-valid'], token);
  assert.equal(result.capabilities['owner-unverified'], undefined);
});
