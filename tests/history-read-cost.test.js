import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adminStore } from './helpers/admin-store.js';
import { customerHistoryStore, historyOrder } from './helpers/customer-history-store.js';

test('one customer history response reads reservation history once and the next response reads fresh rows', () => {
  const { context, data, order } = adminStore();
  data.customerOrders.rows.splice(1);
  for (let index = 0; index < 12; index += 1) {
    const candidate = { ...order, id: `order-${1700000000100 + index}`, customerPhone: '01011112222' };
    data.customerOrders.rows.push(['', candidate.id, candidate.customerPhone, JSON.stringify(candidate)]);
  }
  const getRange = data.groupHistory.getRange.bind(data.groupHistory);
  let historyReads = 0;
  data.groupHistory.getRange = (...args) => { historyReads += 1; return getRange(...args); };
  const read = () => context.getCustomerOrdersResponse_('01011112222', 'member-test', 'b'.repeat(64));
  const first = read();
  assert.equal(first.ok, true, first.error);
  assert.equal(first.orders.length, 12);
  assert.equal(historyReads, 1, 'the full reservation sheet must not be read once per order');
  assert.equal(first.orders.every((item) => !item.paymentSyncStatus), true);
  data.groupHistory.rows.splice(1);
  const second = read();
  assert.equal(second.ok, true, second.error);
  assert.equal(second.orders.every((item) => item.paymentSyncStatus === 'repair_required'), true,
    'no previous request context may hide deleted or changed reservation evidence');
});

test('an administrator order response shares reservation history only within that read', () => {
  const { context, data, dealId, order } = adminStore();
  data.customerOrders.rows.splice(1);
  for (let index = 0; index < 12; index += 1) {
    const candidate = { ...order, id: `order-${1700000000700 + index}` };
    data.customerOrders.rows.push(['', candidate.id, '', JSON.stringify(candidate)]);
  }
  const unrelated = { ...order, id: 'order-1700000000800', dealId: 'customer-other-deal' };
  data.customerOrders.rows.push(['', unrelated.id, '', JSON.stringify(unrelated)]);
  const getRange = data.groupHistory.getRange.bind(data.groupHistory);
  let historyReads = 0;
  data.groupHistory.getRange = (...args) => { historyReads += 1; return getRange(...args); };
  const read = () => context.handleAdminOperation_({
    action: 'orders', dealId, actorId: 'qa_admin', adminAssertion: true,
  });
  const before = JSON.stringify(data);
  const first = read();
  assert.equal(first.ok, true, first.error);
  assert.equal(first.orders.length, 12);
  assert.equal(first.orders.every((item) => item.dealId === dealId && !item.paymentSyncStatus), true);
  assert.equal(historyReads, 1);
  assert.equal(JSON.stringify(data), before);
  data.groupHistory.rows[1][6] = 'mark_read';
  const second = read();
  assert.equal(second.ok, true, second.error);
  assert.equal(second.orders.every((item) => item.paymentSyncStatus === 'repair_required'), true);
  assert.equal(historyReads, 2, 'the next request must not reuse stale reservation evidence');
});

test('nearby matching historical events use bounded reads without returning neighboring users', () => {
  const phone = '01011112222';
  const records = Array.from({ length: 205 }, (_, index) => historyOrder(String(1700000000200 + index), {
    customerPhone: index % 2 === 0 ? phone : '01099992222',
    _customerCapabilityHash: 'b'.repeat(64),
  }));
  const { context, data } = customerHistoryStore({ historic: records });
  const getRange = data.events.getRange.bind(data.events);
  const reads = [];
  data.events.getRange = (...args) => {
    if (args[1] === 1) reads.push(args);
    return getRange(...args);
  };
  const result = context.getCustomerOrdersResponse_(phone, 'customer-history-visitor', 'b'.repeat(64));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.orders.length, 103);
  assert.equal(result.orders.every((item) => item.customerPhone === phone), true);
  assert.equal(reads.length, 3, '205 matching suffixes should use three data reads rather than 205');
  assert.equal(reads.every(([, , height]) => height <= 100), true);
});

test('event match batching preserves sparse matches and ignores unrequested rows', () => {
  const records = Array.from({ length: 240 }, (_, index) => historyOrder(String(1700000000500 + index), {
    customerPhone: [0, 99, 100, 239].includes(index) ? '01011112222' : '01099993333',
  }));
  const { context, data } = customerHistoryStore({ historic: records });
  const matched = context.historicCustomerOrders_(data.events, '01011112222', '');
  assert.deepEqual(Array.from(matched, (item) => item.id), [0, 99, 100, 239].map((index) => records[index].id));
});

test('a scoped two-order read bounds RPCs and each allocation across 20,000 sparse history rows', () => {
  const phone = '01011112222';
  const { context, data, order, dealId } = adminStore();
  data.customerOrders.rows.splice(1);
  for (let index = 0; index < 2; index += 1) {
    const candidate = { ...order, id: `order-${1700000010000 + index}`, customerPhone: phone };
    data.customerOrders.rows.push(['', candidate.id, phone, JSON.stringify(candidate)]);
  }
  const history = customerHistoryStore({ historic: Array.from({ length: 20000 }, (_, index) => (
    historyOrder(String(1700000100000 + index), {
      customerPhone: index % 100 === 0 ? phone : '01099993333',
      _customerCapabilityHash: 'b'.repeat(64),
    })
  )) });
  data.events = history.data.events;
  const getRange = data.events.getRange.bind(data.events);
  const reads = [];
  data.events.getRange = (...args) => {
    if (args[1] === 1) reads.push(args);
    return getRange(...args);
  };
  const before = JSON.stringify([data.customerOrders.rows, history.eventRows]);
  const result = context.getCustomerOrdersResponse_(phone, 'member-test', 'b'.repeat(64), dealId);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.orders.length, 2);
  assert.ok(reads.length <= 20, `sparse history required ${reads.length} data RPCs`);
  assert.ok(reads.every(([, , height]) => height <= 1000), 'each bulk allocation stays bounded');
  assert.ok(reads.reduce((total, [, , height]) => total + height, 0) <= 20000,
    'one matching row cannot cause an unbounded scan of unrelated history');
  assert.equal(JSON.stringify([data.customerOrders.rows, history.eventRows]), before);
});

test('phone-matching analytics events do not cause order snapshot payload reads', () => {
  const phone = '01011112222';
  const records = Array.from({ length: 20000 }, (_, index) => historyOrder(String(1700000200000 + index), {
    customerPhone: index % 100 === 0 ? phone : '01099993333', _customerCapabilityHash: 'b'.repeat(64),
  }));
  const { context, data, eventRows } = customerHistoryStore({ historic: records });
  eventRows.slice(1).forEach((row, index) => { if (![0, 19900].includes(index)) row[6] = 'screen_view'; });
  const getRange = data.events.getRange.bind(data.events);
  const reads = [];
  data.events.getRange = (...args) => {
    if (args[1] === 1) reads.push(args);
    return getRange(...args);
  };
  const result = context.getCustomerOrdersResponse_(phone, 'customer-history-visitor', 'b'.repeat(64));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.orders.map((item) => item.id).sort(), [records[0].id, records[19900].id].sort());
  assert.equal(reads.length, 2, 'non-order event matches must be removed before reading full payloads');
  assert.equal(reads.reduce((total, [, , height]) => total + height, 0), 2);
});

test('very distant matches remain exact bounded reads instead of scanning the gaps', () => {
  const { context } = customerHistoryStore();
  const positions = [2, 1000002, 2000002];
  const reads = [];
  const events = { getRange(row, column, height, width) {
    reads.push({ row, column, height, width });
    assert.ok(height <= 1000, 'never allocate the million-row gaps');
    return { getValues: () => Array.from({ length: height }, (_, index) => [row + index]) };
  } };
  const matches = [...positions].reverse().concat(positions[0]).map((row) => ({ getRow: () => row }));
  const result = context.matchedEventRows_(events, matches);
  assert.deepEqual(Array.from(result, (row) => row[0]), positions);
  assert.equal(reads.length, 3);
  assert.equal(reads.reduce((total, read) => total + read.height, 0), 3);
});

test('production-sized mixed history uses bounded bulk reads without dropping any order snapshots', () => {
  const phone = '01011112222';
  const records = Array.from({ length: 14945 }, (_, index) => historyOrder(String(1700000300000 + index), {
    customerPhone: Math.floor((index + 1) * 11185 / 14945) > Math.floor(index * 11185 / 14945)
      ? phone : '01099993333',
    _customerCapabilityHash: 'b'.repeat(64),
  }));
  const { context, data, eventRows } = customerHistoryStore({ historic: records });
  let matchingPhoneCount = 0;
  const expectedIds = [];
  eventRows.slice(1).forEach((row, index) => {
    row[6] = 'screen_view';
    if (row[13] !== phone) return;
    matchingPhoneCount += 1;
    if (Math.floor(matchingPhoneCount * 4595 / 11185) > Math.floor((matchingPhoneCount - 1) * 4595 / 11185)) {
      row[6] = 'customer_order_snapshot';
      expectedIds.push(records[index].id);
    }
  });
  const getRange = data.events.getRange.bind(data.events);
  const reads = [];
  data.events.getRange = (...args) => {
    if (args[1] === 1) reads.push(args);
    return getRange(...args);
  };
  const result = context.historicCustomerOrders_(data.events, phone, '');
  assert.equal(matchingPhoneCount, 11185);
  assert.equal(expectedIds.length, 4595);
  assert.deepEqual(Array.from(result, (item) => item.id), expectedIds);
  assert.ok(reads.length <= 17, `mixed history required ${reads.length} data RPCs`);
  assert.ok(reads.every(([, , height]) => height <= 1000));
  assert.ok(reads.reduce((total, [, , height]) => total + height, 0) <= 14945);
});

test('a repeated phone history read reuses the legacy event scan but never a stale payment state', () => {
  const { context, data, order } = adminStore();
  const cache = new Map();
  context.CacheService = { getScriptCache: () => ({
    get: (key) => (cache.has(key) ? cache.get(key) : null),
    put: (key, value) => { cache.set(key, value); },
  }) };
  // A live order for this phone, plus a legacy snapshot that only the event log has.
  const live = { ...order, id: 'order-1700000009100', customerPhone: '01011112222' };
  data.customerOrders.rows.push(['', live.id, live.customerPhone, JSON.stringify(live)]);
  data.events.rows.push(['2026-09-01T00:00:00Z', '', '', '', '', '', 'customer_order_snapshot',
    '', '', '', '', JSON.stringify({ ...order, id: 'order-1700000009001', version: 1, paymentStatus: 'pending' }),
    '', '01011112222']);
  let eventScans = 0;
  let orderSheetReads = 0;
  let participantReads = 0;
  const eventsGetRange = data.events.getRange.bind(data.events);
  data.events.getRange = (...args) => { eventScans += 1; return eventsGetRange(...args); };
  const ordersGetRange = data.customerOrders.getRange.bind(data.customerOrders);
  data.customerOrders.getRange = (...args) => { orderSheetReads += 1; return ordersGetRange(...args); };
  const participantsGetRange = data.groupParticipants.getRange.bind(data.groupParticipants);
  data.groupParticipants.getRange = (...args) => { participantReads += 1; return participantsGetRange(...args); };

  const read = () => context.getCustomerOrdersResponse_('01011112222', 'member-test', 'b'.repeat(64));
  const first = read();
  assert.equal(first.ok, true, first.error);
  const scansAfterFirst = eventScans;
  assert.ok(scansAfterFirst > 0, 'the first read still rebuilds legacy orders from the event sheet');
  assert.ok(first.orders.some((item) => item.id === live.id), 'the live order is returned');

  const second = read();
  assert.equal(second.ok, true, second.error);
  assert.equal(eventScans, scansAfterFirst, 'a cached legacy set must not rescan the event sheet');
  assert.deepEqual(second.orders.map((item) => item.id).sort(), first.orders.map((item) => item.id).sort());

  // Only the derived legacy set is cached. The canonical 주문 내역 sheet and the
  // participant payment projection are re-read on every request, so a cache hit
  // cannot freeze a live 입금 상태.
  const ordersBefore = orderSheetReads;
  const participantsBefore = participantReads;
  read();
  assert.equal(eventScans, scansAfterFirst, 'the refresh must not need the event scan');
  assert.ok(orderSheetReads > ordersBefore, '주문 내역 is re-read on every request');
  assert.ok(participantReads > participantsBefore, 'the payment projection is re-read on every request');

  // New rows still need inspection so newly appended order evidence is included.
  data.events.rows.push(['2026-09-02T00:00:00Z', '', '', '', '', '', 'screen_view',
    '', '', '', '', '{}', '', '01011112222']);
  read();
  assert.ok(eventScans > scansAfterFirst, 'new event rows must be inspected');
});

test('analytics appends scan only the suffix and new legacy conflicts still revoke ownership', () => {
  const phone = '01011112222';
  const first = historyOrder('1700000009301', { _customerCapabilityHash: 'b'.repeat(64) });
  const { context, data, eventRows } = customerHistoryStore({ historic: [first] });
  context.Utilities = { DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value)).digest()] };
  const cache = new Map();
  context.CacheService = { getScriptCache: () => ({ get: (key) => cache.get(key) ?? null,
    put: (key, value) => cache.set(key, value) }) };
  for (let i = 0; i < 20000; i++) {
    const row = Array(16).fill(''); row[6] = 'screen_view'; eventRows.push(row);
  }
  const getRange = data.events.getRange.bind(data.events);
  const scans = [];
  data.events.getRange = (...args) => { scans.push(args); return getRange(...args); };
  const read = () => context.getCustomerOrdersResponse_(phone, 'customer-history-visitor', 'b'.repeat(64));
  assert.deepEqual(read().orders.map((item) => item.id), [first.id]);
  const throughRow = eventRows.length;
  const analytics = Array(16).fill(''); analytics[6] = 'screen_view'; eventRows.push(analytics);
  scans.length = 0;
  assert.deepEqual(read().orders.map((item) => item.id), [first.id]);
  assert.deepEqual(scans, [[throughRow + 1, 7, 1, 1]], 'analytics must not rescan 20,000 older events');
  const second = historyOrder('1700000009302', { _customerCapabilityHash: 'b'.repeat(64) });
  const append = (order) => {
    const row = Array(16).fill(''); row[6] = 'customer_order_snapshot'; row[13] = phone;
    row[11] = JSON.stringify({ order_snapshot: JSON.stringify(order) }); eventRows.push(row);
  };
  append(second);
  assert.deepEqual(read().orders.map((item) => item.id).sort(), [first.id, second.id].sort());
  append({ ...first, version: 2, _customerCapabilityHash: 'd'.repeat(64) });
  assert.deepEqual(read().orders.map((item) => item.id), [second.id],
    'a new conflicting ownership snapshot must never be hidden by the cache');
  eventRows.splice(2);
  assert.deepEqual(read().orders.map((item) => item.id), [first.id], 'a truncated sheet requires a full rebuild');
});

test('large repeated history fits a chunked cache while preserving every ownership conflict', () => {
  const phone = '01011112222';
  const mine = 'b'.repeat(64);
  const records = Array.from({ length: 4500 }, (_, index) => historyOrder(String(1700000400000 + index % 90), {
    _customerCapabilityHash: mine, version: index + 1, description: '한글 주문 기록 '.repeat(70),
  }));
  const conflict = { ...records[0], version: 9999, _customerCapabilityHash: 'c'.repeat(64) };
  const { context, data, eventRows } = customerHistoryStore({ historic: records.concat(conflict) });
  context.Utilities = { DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value)).digest()] };
  const cache = new Map();
  context.CacheService = { getScriptCache: () => ({
    get: key => cache.get(key) ?? null, getAll: keys => Object.fromEntries(keys.map(k => [k, cache.get(k)])),
    removeAll(keys) { keys.forEach(key => cache.delete(key)); },
    put(key, value) { assert.ok(Buffer.byteLength(value) < 100000); cache.set(key, value); },
    putAll(values) { for (const [key, value] of Object.entries(values)) {
      assert.ok(Buffer.byteLength(value) < 100000); cache.set(key, value);
    } },
  }) };
  let payloadReads = 0;
  const getRange = data.events.getRange.bind(data.events);
  data.events.getRange = (...args) => { if (args[1] === 1) payloadReads++; return getRange(...args); };
  const read = () => context.getCustomerOrdersResponse_(phone, 'customer-history-visitor', mine);
  const first = read();
  assert.equal(first.ok, true);
  assert.equal(first.orders.length, 89);
  const firstReads = payloadReads;
  const key = context.historicCustomerOrderCacheKey_(phone);
  const manifest = JSON.parse(cache.get(key));
  assert.ok(manifest.chunks > 1, 'a cache larger than one item must still be retained');
  assert.deepEqual(read(), first);
  assert.equal(payloadReads, firstReads, 'repeat reads must reuse the large historic cache');
  const compact = context.cachedHistoricCustomerOrders_(phone, eventRows.length, data.events);
  assert.equal(compact.length, 91);
  assert.deepEqual(Array.from(context.mergeCustomerOrderSnapshots_(records)),
    Array.from(context.mergeCustomerOrderSnapshots_(context.compactHistoricCustomerOrders_(records))));
  // A missing/corrupted generation cannot expose a partial authoritative set.
  cache.delete(`${key}_${manifest.generation}_0`);
  assert.equal(context.cachedHistoricCustomerOrders_(phone, eventRows.length, data.events), null);
  assert.deepEqual(read(), first);
  assert.ok(payloadReads > firstReads);
  const oldChunks = cache.size;
  const analytics = Array(16).fill(''); analytics[6] = 'screen_view'; eventRows.push(analytics);
  assert.deepEqual(read(), first);
  assert.equal(cache.size, oldChunks, 'a new watermark retires old content chunks');
});

test('historic compaction preserves unproved, invalid and conflicting hashes with canonical tie ordering', () => {
  const { context } = customerHistoryStore();
  const id = '1700000409999';
  const records = [
    historyOrder(id, { version: 1, _customerCapabilityHash: 'a'.repeat(64) }),
    historyOrder(id, { version: 1, _customerCapabilityHash: 'b'.repeat(64) }),
    historyOrder(id, { version: 1, title: '후순위 동일 버전', _customerCapabilityHash: 'a'.repeat(64) }),
    historyOrder(id, { version: 1 }),
    historyOrder(id, { version: 1, _customerCapabilityHash: 'invalid-hash' }),
  ];
  const compact = context.compactHistoricCustomerOrders_(records);
  assert.equal(compact.length, 4);
  assert.deepEqual(Array.from(context.mergeCustomerOrderSnapshots_(compact)), Array.from(context.mergeCustomerOrderSnapshots_(records)));
  assert.equal(context.filterCustomerOrdersForProof_(compact, 'customer-history-visitor', 'a'.repeat(64), null).length, 0);
});

test('a phone history read selects order snapshots by exact event name, not by a 4-digit phone match', () => {
  const { context, data } = adminStore();
  // Analytics rows carrying the same last 4 phone digits must not drive the scan.
  for (let index = 0; index < 50; index += 1) {
    data.events.rows.push(['2026-09-01T00:00:00Z', '', '', '', '', '', 'screen_view',
      '', '', '', '', '{}', '', '01011112222']);
  }
  const finders = [];
  const eventsGetRange = data.events.getRange.bind(data.events);
  data.events.getRange = (...args) => {
    const range = eventsGetRange(...args);
    const createTextFinder = range.createTextFinder?.bind(range);
    if (createTextFinder) {
      range.createTextFinder = (needle) => { finders.push({ column: args[1], needle }); return createTextFinder(needle); };
    }
    return range;
  };
  const result = context.getCustomerOrdersResponse_('01011112222', 'member-test', 'b'.repeat(64));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(finders, [{ column: 7, needle: 'customer_order_snapshot' }],
    'the selective scan is the bounded snapshot set, never every row carrying the last 4 phone digits');
});
