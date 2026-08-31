import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adoptLegacyOwnerScopes,
  assignOwnerDealScope,
  chunkOwnerCapabilities,
  isOwnerDealInScope,
  ownerScopeKey,
  scopedOwnerCapabilityEntries,
} from './ownerCapabilities.js';

const token = (character) => `deal-${character.repeat(40)}`;

test('merchant scope is stable for formatted versions of the same phone number', () => {
  assert.equal(
    ownerScopeKey({ testerType: '사장님', phone: '010-1234-5678' }),
    'phone:01012345678',
  );
  assert.equal(
    ownerScopeKey({ testerType: '사장님', phone: '010 1234 5678' }),
    'phone:01012345678',
  );
  assert.equal(ownerScopeKey({ testerType: '사용자', phone: '010-1234-5678' }), '');
  assert.equal(ownerScopeKey({ testerType: '사장님', phone: '1234' }), '');
});

test('a merchant deal cannot be reassigned to a switched merchant profile', () => {
  const firstScope = 'phone:01011112222';
  const secondScope = 'phone:01033334444';
  const first = assignOwnerDealScope({}, 'owner-secure-deal', firstScope);
  assert.equal(first.allowed, true);
  assert.equal(first.changed, true);
  assert.equal(isOwnerDealInScope('owner-secure-deal', first.scopeByDeal, firstScope), true);

  const switched = assignOwnerDealScope(first.scopeByDeal, 'owner-secure-deal', secondScope);
  assert.equal(switched.allowed, false);
  assert.equal(switched.changed, false);
  assert.equal(isOwnerDealInScope('owner-secure-deal', switched.scopeByDeal, secondScope), false);
  assert.equal(switched.scopeByDeal['owner-secure-deal'], firstScope);
});

test('legacy unscoped local owner deals are adopted once without taking another owner scope', () => {
  const existingScope = 'phone:01011112222';
  const currentScope = 'phone:01033334444';
  const input = {
    capabilities: {
      'owner-legacy': token('a'),
      'owner-already-owned': token('b'),
      'owner-short-secret': 'short',
      'customer-not-owner': token('c'),
    },
    scopeByDeal: { 'owner-already-owned': existingScope },
    ownerScope: currentScope,
    createdDeals: [
      { id: 'owner-legacy', source: 'merchant' },
      { id: 'owner-already-owned', source: 'merchant' },
      { id: 'owner-short-secret', source: 'merchant' },
      { id: 'customer-not-owner', source: 'customer' },
    ],
  };
  const adopted = adoptLegacyOwnerScopes(input);
  assert.equal(adopted.changed, true);
  assert.equal(adopted.migrationCompleted, true);
  assert.equal(adopted.scopeByDeal['owner-legacy'], currentScope);
  assert.equal(adopted.scopeByDeal['owner-already-owned'], existingScope);
  assert.equal(adopted.scopeByDeal['owner-short-secret'], undefined);

  const attemptedAgain = adoptLegacyOwnerScopes({
    ...input,
    scopeByDeal: adopted.scopeByDeal,
    createdDeals: [...input.createdDeals, { id: 'owner-late-legacy', source: 'merchant' }],
    capabilities: { ...input.capabilities, 'owner-late-legacy': token('d') },
    migrationCompleted: true,
  });
  assert.equal(attemptedAgain.changed, false);
  assert.equal(attemptedAgain.scopeByDeal['owner-late-legacy'], undefined);
});

test('owner claims expose only the active merchant scope', () => {
  const firstScope = 'phone:01011112222';
  const secondScope = 'phone:01033334444';
  const capabilities = {
    'owner-first': token('a'),
    'owner-second': token('b'),
    'owner-unscoped': token('c'),
    'customer-public': token('d'),
  };
  const scopes = {
    'owner-first': firstScope,
    'owner-second': secondScope,
  };

  assert.deepEqual(scopedOwnerCapabilityEntries(capabilities, scopes, firstScope), [
    { dealId: 'owner-first', capabilityToken: capabilities['owner-first'] },
  ]);
  assert.deepEqual(scopedOwnerCapabilityEntries(capabilities, scopes, secondScope), [
    { dealId: 'owner-second', capabilityToken: capabilities['owner-second'] },
  ]);
  assert.deepEqual(scopedOwnerCapabilityEntries(capabilities, scopes, ''), []);
});

test('owner capabilities are batched without silently dropping claims after fifty', () => {
  const capabilities = Array.from({ length: 123 }, (_, index) => ({
    dealId: `owner-${index}`,
    capabilityToken: token(String(index % 10)),
  }));
  const batches = chunkOwnerCapabilities(capabilities);
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 23]);
  assert.deepEqual(batches.flat(), capabilities);
});
