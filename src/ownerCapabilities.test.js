import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignOwnerDealScope,
  buildOwnerRecoveryCandidates,
  chunkOwnerCapabilities,
  confirmOwnerRecovery,
  isOwnerDealInScope,
  ownerScopeKey,
  reconcileOwnerRecovery,
  scopedOwnerCapabilityEntries,
  unscopedOwnerCapabilityEntries,
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

test('manual recovery lookup includes valid unscoped browser management keys', () => {
  const currentScope = 'phone:01011112222';
  const capabilities = {
    'owner-already-scoped': token('a'),
    'owner-server-only': token('b'),
    'owner-other-profile': token('c'),
    'owner-short-secret': 'short',
    'customer-invalid': token('d'),
  };
  const scopeByDeal = {
    'owner-already-scoped': currentScope,
    'owner-other-profile': 'phone:01099998888',
  };

  assert.deepEqual(unscopedOwnerCapabilityEntries(capabilities, scopeByDeal), [
    { dealId: 'owner-server-only', capabilityToken: capabilities['owner-server-only'] },
  ]);
});

test('manual recovery candidates contain metadata only for keys verified by owner listing', () => {
  const recoveryScope = 'phone:01011112222';
  const capabilities = {
    'owner-first': token('a'),
    'owner-not-returned': token('b'),
    'owner-already-scoped': token('c'),
  };
  const candidates = buildOwnerRecoveryCandidates({
    capabilities,
    scopeByDeal: { 'owner-already-scoped': recoveryScope },
    verifiedDeals: [
      { id: 'owner-first', title: '오곡 물티슈', store: '판교 마트' },
      { id: 'owner-already-scoped', title: '이미 연결됨', store: '다른 매장' },
      { id: 'customer-invalid', title: '잘못된 ID', store: '잘못된 매장' },
    ],
    recoveryScope,
  });

  assert.deepEqual(candidates, [{
    dealId: 'owner-first',
    capabilityToken: capabilities['owner-first'],
    recoveryScope,
    title: '오곡 물티슈',
    store: '판교 마트',
  }]);
});

test('manual recovery requires both owner listing verification and explicit confirmation', () => {
  const ownerScope = 'phone:01011112222';
  const capabilities = {
    'owner-first': token('a'),
    'owner-second': token('b'),
  };

  const onlyVerified = confirmOwnerRecovery({
    capabilities,
    ownerScope,
    verifiedRecoveryEntries: [
      { dealId: 'owner-first', capabilityToken: capabilities['owner-first'] },
    ],
  });
  assert.equal(onlyVerified.changed, false);
  assert.deepEqual(onlyVerified.recoveredDealIds, []);
  assert.deepEqual(onlyVerified.scopeByDeal, {});

  const onlyConfirmed = confirmOwnerRecovery({
    capabilities,
    ownerScope,
    confirmedDealIds: ['owner-first'],
  });
  assert.equal(onlyConfirmed.changed, false);
  assert.deepEqual(onlyConfirmed.recoveredDealIds, []);
  assert.deepEqual(onlyConfirmed.scopeByDeal, {});
});

test('manual recovery assigns only the owner-listing-verified and confirmed candidate intersection', () => {
  const ownerScope = 'phone:01011112222';
  const anotherScope = 'phone:01033334444';
  const capabilities = {
    'owner-recover': token('a'),
    'owner-not-verified': token('b'),
    'owner-another': token('c'),
    'owner-invalid-secret': 'short',
  };
  const scopeByDeal = {
    'owner-another': anotherScope,
    'owner-preserved': ownerScope,
  };

  const result = confirmOwnerRecovery({
    capabilities,
    scopeByDeal,
    ownerScope,
    verifiedRecoveryEntries: [
      { dealId: 'owner-recover', capabilityToken: capabilities['owner-recover'] },
      { dealId: 'owner-another', capabilityToken: capabilities['owner-another'] },
      { dealId: 'owner-invalid-secret', capabilityToken: capabilities['owner-invalid-secret'] },
    ],
    confirmedDealIds: [
      'owner-recover',
      'owner-recover',
      'owner-not-verified',
      'owner-another',
      'owner-invalid-secret',
      'customer-not-owner',
    ],
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.recoveredDealIds, ['owner-recover']);
  assert.deepEqual(result.scopeByDeal, {
    ...scopeByDeal,
    'owner-recover': ownerScope,
  });
  assert.equal(result.scopeByDeal['owner-another'], anotherScope);
  assert.equal(scopeByDeal['owner-recover'], undefined);
});

test('manual recovery is idempotent and cannot reassign an existing scope', () => {
  const firstScope = 'phone:01011112222';
  const secondScope = 'phone:01033334444';
  const capabilities = { 'owner-recovered': token('a') };
  const recovered = confirmOwnerRecovery({
    capabilities,
    ownerScope: firstScope,
    verifiedRecoveryEntries: [
      { dealId: 'owner-recovered', capabilityToken: capabilities['owner-recovered'] },
    ],
    confirmedDealIds: ['owner-recovered'],
  });
  const repeated = confirmOwnerRecovery({
    capabilities,
    scopeByDeal: recovered.scopeByDeal,
    ownerScope: secondScope,
    verifiedRecoveryEntries: [
      { dealId: 'owner-recovered', capabilityToken: capabilities['owner-recovered'] },
    ],
    confirmedDealIds: ['owner-recovered'],
  });

  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.recoveredDealIds, []);
  assert.equal(repeated.scopeByDeal['owner-recovered'], firstScope);
});

test('manual recovery rejects a capability changed after owner listing verification', () => {
  const dealId = 'owner-token-changed';
  const verifiedToken = token('a');
  const currentToken = token('b');
  const result = confirmOwnerRecovery({
    capabilities: { [dealId]: currentToken },
    ownerScope: 'phone:01011112222',
    verifiedRecoveryEntries: [{ dealId, capabilityToken: verifiedToken }],
    confirmedDealIds: [dealId],
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.recoveredDealIds, []);
  assert.deepEqual(result.scopeByDeal, {});
});

test('in-flight recovery merges into the latest scope map without overwriting another tab', () => {
  const ownerScope = 'phone:01011112222';
  const capabilityToken = token('a');
  const latestScopeByDeal = {
    'owner-existing': ownerScope,
    'owner-other-shop': 'phone:01099998888',
  };
  const result = reconcileOwnerRecovery({
    capabilities: { 'owner-recover': capabilityToken },
    scopeByDeal: latestScopeByDeal,
    expectedOwnerScope: ownerScope,
    currentOwnerScope: ownerScope,
    requestedRecoveryEntries: [
      { dealId: 'owner-recover', capabilityToken, recoveryScope: ownerScope },
    ],
    verifiedDealIds: ['owner-recover'],
  });

  assert.deepEqual(result.recoveredDealIds, ['owner-recover']);
  assert.deepEqual(result.scopeByDeal, {
    ...latestScopeByDeal,
    'owner-recover': ownerScope,
  });
  assert.equal(latestScopeByDeal['owner-recover'], undefined);
});

test('in-flight recovery fails closed when identity, token, scope, or server result changed', () => {
  const requestedScope = 'phone:01011112222';
  const requestedToken = token('a');
  const base = {
    expectedOwnerScope: requestedScope,
    currentOwnerScope: requestedScope,
    requestedRecoveryEntries: [
      {
        dealId: 'owner-recover',
        capabilityToken: requestedToken,
        recoveryScope: requestedScope,
      },
    ],
    verifiedDealIds: ['owner-recover'],
  };

  const identityChanged = reconcileOwnerRecovery({
    ...base,
    capabilities: { 'owner-recover': requestedToken },
    currentOwnerScope: 'phone:01099998888',
  });
  const tokenChanged = reconcileOwnerRecovery({
    ...base,
    capabilities: { 'owner-recover': token('b') },
  });
  const claimedByAnotherTab = reconcileOwnerRecovery({
    ...base,
    capabilities: { 'owner-recover': requestedToken },
    scopeByDeal: { 'owner-recover': 'phone:01099998888' },
  });
  const omittedByServer = reconcileOwnerRecovery({
    ...base,
    capabilities: { 'owner-recover': requestedToken },
    verifiedDealIds: [],
  });

  [identityChanged, tokenChanged, claimedByAnotherTab, omittedByServer].forEach((result) => {
    assert.equal(result.changed, false);
    assert.deepEqual(result.recoveredDealIds, []);
  });
  assert.equal(claimedByAnotherTab.scopeByDeal['owner-recover'], 'phone:01099998888');
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
