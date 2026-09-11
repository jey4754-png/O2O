import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findLegacyCustomerGroupReceipt,
  isCanonicalLegacyReceiptId,
  loadLegacyCustomerGroupReceipt,
} from './legacyGroupReceipt.js';

const GROUP_ID = 'customer-legacy-receipt';
const ACTOR_ID = 'visitor-legacy-receipt';
const RECEIPT_ID = 'f81d4fae-7dec-4a45-8a6f-67c6f0f5e123';

function receipt(overrides = {}) {
  return {
    id: RECEIPT_ID,
    name: 'group_created',
    visitorId: ACTOR_ID,
    properties: {
      deal_id: GROUP_ID,
      source: 'customer',
    },
    ...overrides,
  };
}

test('legacy customer-group receipts require every stored binding to match exactly', () => {
  assert.deepEqual(
    findLegacyCustomerGroupReceipt([receipt()], { groupId: GROUP_ID, actorId: ACTOR_ID }),
    { eventId: RECEIPT_ID },
  );

  const invalid = [
    receipt({ id: 'event-not-a-uuid' }),
    receipt({ name: 'group_created_extra' }),
    receipt({ visitorId: `${ACTOR_ID}-other` }),
    receipt({ properties: { deal_id: `${GROUP_ID}-other`, source: 'customer' } }),
    receipt({ properties: { deal_id: GROUP_ID, source: 'merchant' } }),
    receipt({ properties: null }),
    receipt({ properties: [] }),
  ];
  invalid.forEach((event) => {
    assert.equal(
      findLegacyCustomerGroupReceipt([event], { groupId: GROUP_ID, actorId: ACTOR_ID }),
      null,
    );
  });
});

test('legacy receipt lookup returns the oldest exact canonical UUID only', () => {
  const newerId = '9b2c3d4e-5f60-4781-9abc-def012345678';
  assert.equal(isCanonicalLegacyReceiptId(RECEIPT_ID), true);
  assert.equal(isCanonicalLegacyReceiptId(RECEIPT_ID.toUpperCase()), false);
  assert.equal(isCanonicalLegacyReceiptId('f81d4fae-7dec-3a45-8a6f-67c6f0f5e123'), false);
  assert.equal(isCanonicalLegacyReceiptId('f81d4fae7dec4a458a6f67c6f0f5e123'), false);
  assert.equal(isCanonicalLegacyReceiptId('00000000-0000-0000-0000-000000000000'), false);
  assert.deepEqual(
    findLegacyCustomerGroupReceipt([
      receipt(),
      receipt({ id: newerId }),
    ], { groupId: GROUP_ID, actorId: ACTOR_ID }),
    { eventId: RECEIPT_ID },
  );
});

test('stored legacy receipt lookup fails closed for malformed, non-array, or unreadable storage', () => {
  const stored = (value) => ({ getItem: () => value });
  assert.equal(loadLegacyCustomerGroupReceipt({
    groupId: GROUP_ID,
    actorId: ACTOR_ID,
    storage: stored('{broken'),
  }), null);
  assert.equal(loadLegacyCustomerGroupReceipt({
    groupId: GROUP_ID,
    actorId: ACTOR_ID,
    storage: stored(JSON.stringify({ event: receipt() })),
  }), null);
  assert.equal(loadLegacyCustomerGroupReceipt({
    groupId: GROUP_ID,
    actorId: ACTOR_ID,
    storage: { getItem() { throw new Error('storage_blocked'); } },
  }), null);
  assert.equal(loadLegacyCustomerGroupReceipt({
    groupId: GROUP_ID,
    actorId: ACTOR_ID,
    storage: null,
  }), null);
});
