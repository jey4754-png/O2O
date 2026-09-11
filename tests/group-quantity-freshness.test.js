import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reserveGroupQuantity, updateGroupTarget } from '../src/groupApi.js';
import { adminStore } from './helpers/admin-store.js';

function quantityStore() {
  const store = adminStore();
  const { context, data } = store;
  const groupId = 'customer-quantity-freshness';
  const actorId = 'visitor-quantity-freshness';
  const capabilityToken = `group-${'q'.repeat(64)}`;
  const capabilityHash = createHash('sha256').update(capabilityToken).digest('hex');
  const date = '2026-09-09T00:00:00.000Z';
  const deal = { id: groupId, source: 'customer', saleType: 'group', title: 'Synthetic quantity test',
    visibility: 'public', totalQuantity: 10, targetCount: 5, creatorActorId: actorId,
    originalPrice: 10000, price: 10000, publishVersion: 1, updatedAt: date };
  data.publicDeals.rows[1] = [date, groupId, 'customer', '', '', '', JSON.stringify(deal)];
  data.groups.rows[1] = [groupId, groupId, deal.title, 'recruiting', 5, false, actorId,
    0, 1, date, date, actorId, actorId, 'self', 10];
  data.groupParticipants.rows[1] = [groupId, actorId, 'Synthetic host', 'host', true,
    'pending', 0, capabilityHash, 1, date, date, 1];
  for (const key of ['customerOrders', 'groupHistory', 'groupChat', 'events']) data[key].rows.splice(1);
  const entries = new Map();
  let beforePut;
  context.CacheService = { getScriptCache: () => ({
    get: (key) => entries.get(key) || null,
    remove: (key) => entries.delete(key),
    put(key, value) {
      if (beforePut) { const callback = beforePut; beforePut = null; callback(); }
      entries.set(key, value);
    },
  }) };
  context.invalidateGroupSnapshot_(groupId);
  const base = { groupId, actorId, capabilityHash };
  return { ...store, groupId, actorId, capabilityToken, entries, base,
    raceDuringCacheFill(callback) { beforePut = callback; },
    mutate(action, extra) { return context.executeGroupMutation_(action, { ...base, ...extra }, data); },
  };
}

async function withClient(store, callback, afterSnapshot) {
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  globalThis.localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
    [`${store.groupId}::${store.actorId}`]: { groupId: store.groupId, actorId: store.actorId,
      role: 'host', active: true, capabilityToken: store.capabilityToken },
  }));
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push(payload);
    const gasPayload = { ...payload,
      capabilityHash: createHash('sha256').update(payload.capabilityToken || '').digest('hex') };
    delete gasPayload.capabilityToken;
    const result = store.context.handleGroupOperation_(payload.action, gasPayload);
    if (payload.action === 'snapshot' && afterSnapshot) afterSnapshot();
    return { ok: result.ok, status: result.ok ? 200 : result.error === 'state_conflict' ? 409 : 400,
      json: async () => result };
  };
  try { await callback(requests); }
  finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
}

for (const action of ['reserve_quantity', 'update_target']) {
  test(`a real concurrent ${action} after the client read is still rejected`, async () => {
    const store = quantityStore();
    await withClient(store, async (requests) => {
      const operation = action === 'reserve_quantity'
        ? reserveGroupQuantity(store.groupId, 1, store.actorId, 'quantity-actual-race-001', { allowLocalFallback: false })
        : updateGroupTarget(store.groupId, 7, store.actorId, 1);
      await assert.rejects(operation, (error) => error.code === 'state_conflict' && error.status === 409);
      const mutations = requests.filter((request) => request.action === action);
      assert.equal(mutations.length, 1);
      assert.equal(mutations[0].expectedVersion, 1);
      if (action === 'reserve_quantity') assert.equal(store.data.groupParticipants.rows[1][11], 2);
      else assert.equal(store.data.groups.rows[1][4], 6);
    }, () => store.mutate(action, { expectedVersion: 1, quantity: 1, targetCount: 6,
      clientMutationId: `real-race-${action}-001` }));
  });
}

test('an evicted generation bypasses caching instead of reviving an older namespace', () => {
  const store = quantityStore();
  const generationKey = store.context.snapshotGenerationCacheKey_(store.groupId);
  const previousGeneration = store.entries.get(generationKey);
  store.context.handleGroupOperation_('snapshot', store.base);
  store.mutate('update_target', { expectedVersion: 1, targetCount: 6, clientMutationId: 'cache-eviction-001' });
  assert.notEqual(store.entries.get(generationKey), previousGeneration);
  store.entries.delete(generationKey);
  const writesBeforeRead = [...store.entries.entries()];
  for (let index = 0; index < 2; index += 1) {
    const response = store.context.handleGroupOperation_('snapshot', store.base);
    assert.equal(response.ok, true);
    assert.equal(response.snapshot.group.version, 2);
    assert.equal(response.snapshot.group.targetCount, 6);
  }
  assert.equal(store.entries.has(generationKey), false);
  assert.deepEqual([...store.entries.entries()], writesBeforeRead, 'missing generations do not populate snapshot caches');
  store.context.invalidateGroupSnapshot_(store.groupId);
  assert.notEqual(store.entries.get(generationKey), previousGeneration);
  assert.equal(store.context.handleGroupOperation_('snapshot', store.base).snapshot.group.version, 2);
});

test('legacy v3 snapshots are never read when no generation is present', () => {
  const store = quantityStore();
  store.entries.clear();
  store.entries.set(`group_snapshot_v3_${store.groupId}`, JSON.stringify({ group: { version: 999 } }));
  const response = store.context.handleGroupOperation_('snapshot', store.base);
  assert.equal(response.ok, true);
  assert.equal(response.snapshot.group.version, 1);
  assert.equal(store.entries.size, 1);
});

test('cache acquisition and generation-read errors fall back to the canonical store', () => {
  for (const mode of ['acquisition', 'read']) {
    const store = quantityStore();
    store.context.CacheService = { getScriptCache() {
      if (mode === 'acquisition') throw new Error('synthetic cache unavailable');
      return { get() { throw new Error('synthetic read unavailable'); },
        put() { assert.fail('cache errors must bypass writes'); } };
    } };
    const response = store.context.handleGroupOperation_('snapshot', store.base);
    assert.equal(response.ok, true);
    assert.equal(response.snapshot.group.version, 1);
  }
});

test('failed invalidation removes a previously reusable generation', () => {
  const store = quantityStore();
  const generationKey = store.context.snapshotGenerationCacheKey_(store.groupId);
  store.context.CacheService = { getScriptCache: () => ({
    put() { throw new Error('synthetic put unavailable'); },
    remove: (key) => store.entries.delete(key),
  }) };
  store.context.invalidateGroupSnapshot_(store.groupId);
  assert.equal(store.entries.has(generationKey), false);
});

for (const action of ['reserve_quantity', 'update_target']) {
  test(`a late snapshot cache fill cannot cause the next ${action} to conflict`, async () => {
    const store = quantityStore();
    store.raceDuringCacheFill(() => {
      store.mutate(action, { expectedVersion: 1, quantity: 1, targetCount: 6,
        clientMutationId: `concurrent-${action}-001` });
    });
    // The reader took its snapshot before the competing mutation invalidated
    // the cache, but only reaches cache.put after that mutation committed.
    const firstRead = store.context.handleGroupOperation_('snapshot', store.base);
    assert.equal(firstRead.ok, true);
    assert.equal(firstRead.snapshot.group.version, 1);
    assert.equal(firstRead.snapshot.participants[0].version, 1);
    const currentVersion = action === 'reserve_quantity'
      ? store.data.groupParticipants.rows[1][8] : store.data.groups.rows[1][8];
    assert.equal(currentVersion, 2, 'the concurrent mutation must really commit');
    await withClient(store, async (requests) => {
      const result = action === 'reserve_quantity'
        ? await reserveGroupQuantity(store.groupId, 1, store.actorId, 'quantity-fresh-001', { allowLocalFallback: false })
        : await updateGroupTarget(store.groupId, 7, store.actorId);
      assert.equal(result.ok, true);
      const mutations = requests.filter((request) => request.action === action);
      assert.equal(mutations.length, 1, 'no silent retry or overwrite of a CAS failure');
      assert.equal(mutations[0].expectedVersion, 2);
      if (action === 'reserve_quantity') assert.equal(store.data.groupParticipants.rows[1][11], 3);
      else assert.equal(store.data.groups.rows[1][4], 7);
    });
  });
}
