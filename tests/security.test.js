import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import collectHandler from '../api/collect.js';
import customerOrdersHandler from '../api/customer-orders.js';
import groupHandler from '../api/group-ops.js';
import publicDealsHandler from '../api/public-deals.js';
import { dataApiOrigin, fetchUpstreamJson } from '../api/_data-upstream.js';

function appsScriptContext() {
  const context = {};
  runInNewContext(
    readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'),
    context,
  );
  return context;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

async function invoke(handler, request) {
  const response = responseRecorder();
  await handler({ method: 'POST', headers: {}, ...request }, response);
  return response;
}

test('data API proxy is used only when its dedicated token is configured', () => {
  const previousOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousToken = process.env.O2O_DATA_API_TOKEN;
  try {
    process.env.O2O_DATA_API_ORIGIN = 'https://legacy-data.example.test/';
    delete process.env.O2O_DATA_API_TOKEN;
    assert.equal(dataApiOrigin(), '');

    process.env.O2O_DATA_API_TOKEN = 'dedicated-data-api-token';
    assert.equal(dataApiOrigin(), 'https://legacy-data.example.test');
  } finally {
    if (previousOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousOrigin;
    if (previousToken === undefined) delete process.env.O2O_DATA_API_TOKEN;
    else process.env.O2O_DATA_API_TOKEN = previousToken;
  }
});

test('merchant group seed binds the public deal id and caps participant target at 20', () => {
  const context = appsScriptContext();
  const seed = JSON.parse(JSON.stringify(context.merchantGroupSeed_({
    id: 'owner-merchant-seed-test',
    source: 'merchant',
    saleType: 'group',
    title: '사과 공동구매',
    target: 80,
    totalQuantity: 80,
  }, 'owner-merchant-seed-test')));

  assert.deepEqual(seed, {
    groupId: 'owner-merchant-seed-test',
    dealId: 'owner-merchant-seed-test',
    title: '사과 공동구매',
    targetCount: 20,
    totalQuantity: 80,
    creatorActorId: 'merchant-owner-merchant-seed-test',
  });
  assert.equal(context.merchantGroupSeed_({
    id: 'owner-instant-seed-test',
    source: 'merchant',
    saleType: 'instant',
    totalQuantity: 5,
  }, 'owner-instant-seed-test'), null);
});

test('merchant group room capacity includes legacy active orders without double counting migrated members', () => {
  const context = appsScriptContext();

  assert.equal(context.groupQuantityCapacityBaseline_(0, 4), 4);
  assert.equal(context.groupQuantityCapacityBaseline_(4, 4), 4);
  assert.equal(context.groupQuantityCapacityBaseline_(6, 4), 6);
});

test('merchant legacy order allocation is projected into chat without persisting stale quantities', () => {
  const context = appsScriptContext();
  const participants = JSON.parse(JSON.stringify(context.reconcileMerchantGroupParticipants_([
    { actorId: 'legacy-active', role: 'member', counted: true, selectedQuantity: 0 },
    { actorId: 'reserved-new', role: 'member', counted: true, selectedQuantity: 2 },
    { actorId: 'legacy-cancelled', role: 'member', counted: true, selectedQuantity: 0 },
    { actorId: 'admin', role: 'admin', counted: false, selectedQuantity: 0 },
  ], {
    total: 4,
    byActor: { 'legacy-active': 4 },
  })));

  assert.equal(participants[0].selectedQuantity, 4);
  assert.equal(participants[0].counted, true);
  assert.equal(participants[1].selectedQuantity, 2);
  assert.equal(participants[1].counted, true);
  assert.equal(participants[2].selectedQuantity, 0);
  assert.equal(participants[2].counted, false);
  assert.equal(participants[3].counted, false);
});

test('merchant product edits plan group capacity atomically above active quantity and participant floors', () => {
  const context = appsScriptContext();
  const group = {
    groupId: 'owner-merchant-edit-plan',
    targetCount: 2,
    totalQuantity: 6,
    version: 4,
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
  const participants = [
    { actorId: 'reserved-member', role: 'member', counted: true, selectedQuantity: 2 },
    { actorId: 'legacy-member', role: 'member', counted: true, selectedQuantity: 0 },
  ];
  const allocations = {
    total: 4,
    byActor: { 'reserved-member': 2, 'legacy-member': 2 },
  };
  const originalGroup = JSON.parse(JSON.stringify(group));

  const belowQuantity = context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 3,
    targetCount: 2,
  }, group, participants, allocations, '2026-08-29T01:00:00.000Z');
  assert.equal(belowQuantity.ok, false);
  assert.equal(belowQuantity.error, 'quantity_below_active_allocations');
  assert.equal(belowQuantity.minimumQuantity, 4);
  assert.deepEqual(group, originalGroup);

  const belowParticipants = context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 8,
    targetCount: 1,
  }, group, participants, allocations, '2026-08-29T01:00:00.000Z');
  assert.equal(belowParticipants.ok, false);
  assert.equal(belowParticipants.error, 'target_below_current');
  assert.equal(belowParticipants.minimumTarget, 2);
  assert.deepEqual(group, originalGroup);

  assert.equal(context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 1000,
    targetCount: 2,
  }, group, participants, allocations).error, 'invalid_deal_capacity');
  assert.equal(context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 8,
    targetCount: 21,
  }, group, participants, allocations).error, 'invalid_target');

  const updated = JSON.parse(JSON.stringify(context.merchantGroupPublishPlan_({
    id: group.groupId,
    totalQuantity: 8,
    targetCount: 3,
  }, group, participants, allocations, '2026-08-29T01:00:00.000Z')));
  assert.equal(updated.ok, true);
  assert.equal(updated.changed, true);
  assert.equal(updated.group.totalQuantity, 8);
  assert.equal(updated.group.targetCount, 3);
  assert.equal(updated.group.version, 5);
  assert.equal(updated.group.updatedAt, '2026-08-29T01:00:00.000Z');
  assert.deepEqual(group, originalGroup);
});

test('data API proxy bypasses the current Vercel deployment instead of self-calling', () => {
  const previous = {
    origin: process.env.O2O_DATA_API_ORIGIN,
    token: process.env.O2O_DATA_API_TOKEN,
    vercelEnv: process.env.VERCEL_ENV,
    vercelUrl: process.env.VERCEL_URL,
    productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  };
  try {
    process.env.O2O_DATA_API_ORIGIN = 'https://o2o-ten.vercel.app/';
    process.env.O2O_DATA_API_TOKEN = 'dedicated-data-api-token';
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    assert.equal(dataApiOrigin(), '');

    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = 'preview-o2o.example.test';
    process.env.O2O_DATA_API_ORIGIN = 'https://preview-o2o.example.test';
    assert.equal(dataApiOrigin(), '');

    process.env.O2O_DATA_API_ORIGIN = 'https://legacy-data.example.test';
    assert.equal(dataApiOrigin(), 'https://legacy-data.example.test');
  } finally {
    for (const [key, value] of Object.entries({
      O2O_DATA_API_ORIGIN: previous.origin,
      O2O_DATA_API_TOKEN: previous.token,
      VERCEL_ENV: previous.vercelEnv,
      VERCEL_URL: previous.vercelUrl,
      VERCEL_PROJECT_PRODUCTION_URL: previous.productionUrl,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('self-origin bypass sends API traffic directly to the configured collector', async () => {
  const previous = {
    fetch: globalThis.fetch,
    origin: process.env.O2O_DATA_API_ORIGIN,
    dataToken: process.env.O2O_DATA_API_TOKEN,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    vercelEnv: process.env.VERCEL_ENV,
  };
  process.env.O2O_DATA_API_ORIGIN = 'https://o2o-ten.vercel.app';
  process.env.O2O_DATA_API_TOKEN = 'data-api-token';
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  process.env.VERCEL_ENV = 'production';
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(url);
    return {
      ok: true,
      async json() { return { ok: true, deals: [] }; },
    };
  };
  try {
    const response = await invoke(publicDealsHandler, {
      headers: { origin: 'https://o2o-ten.vercel.app' },
      body: { action: 'list' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(requestedUrls, ['https://collector.example.test']);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      O2O_DATA_API_ORIGIN: previous.origin,
      O2O_DATA_API_TOKEN: previous.dataToken,
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      VERCEL_ENV: previous.vercelEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('upstream timeouts are normalized before the Vercel function deadline', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error('request exceeded deadline');
    error.name = 'TimeoutError';
    throw error;
  };
  try {
    await assert.rejects(
      fetchUpstreamJson('https://collector.example.test', { method: 'POST' }),
      (error) => error?.code === 'upstream_timeout' && error?.status === 504,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('data APIs return 504 when Apps Script exceeds the bounded upstream deadline', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
    dataToken: process.env.O2O_DATA_API_TOKEN,
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  process.env.O2O_DATA_API_TOKEN = 'service-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  globalThis.fetch = async () => {
    const error = new Error('request exceeded deadline');
    error.name = 'TimeoutError';
    throw error;
  };

  try {
    const serviceHeaders = { 'x-o2o-service-token': 'service-token' };
    const requests = [
      [publicDealsHandler, { action: 'list' }],
      [customerOrdersHandler, {
        action: 'list',
        phone: '01012345678',
        visitorId: 'visitor-timeout-test',
        customerCapabilityHash: 'a'.repeat(64),
      }],
      [groupHandler, {
        action: 'snapshot',
        groupId: 'customer-timeout-test',
        actorId: 'visitor-timeout-test',
        capabilityHash: 'b'.repeat(64),
      }],
    ];
    for (const [handler, body] of requests) {
      const response = await invoke(handler, { headers: serviceHeaders, body });
      assert.equal(response.statusCode, 504);
      assert.deepEqual(response.body, { ok: false, error: 'upstream_timeout' });
    }
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      O2O_DATA_API_ORIGIN: previous.dataOrigin,
      O2O_DATA_API_TOKEN: previous.dataToken,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Apps Script rejects lock contention quickly with a retryable error', () => {
  const collector = appsScriptContext();
  collector.LockService = {
    getScriptLock() {
      return { tryLock: () => false };
    },
  };
  assert.throws(
    () => collector.acquireScriptLock_(),
    (error) => error?.code === 'collector_busy',
  );
});

test('large public-deal payloads are cached in multiple Apps Script entries', () => {
  const collector = appsScriptContext();
  const values = new Map();
  collector.CacheService = {
    getScriptCache() {
      return {
        get: (key) => values.get(key) || null,
        getAll: (keys) => Object.fromEntries(
          keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)]),
        ),
        put: (key, value) => values.set(key, value),
        putAll: (entries) => Object.entries(entries).forEach(([key, value]) => values.set(key, value)),
        removeAll: (keys) => keys.forEach((key) => values.delete(key)),
      };
    },
  };
  const deals = [{
    id: 'owner-large-cache-test',
    title: '대용량 이미지 상품',
    image: `data:image/jpeg;base64,${'a'.repeat(240000)}`,
  }];

  collector.cachePublicDeals_(deals);
  assert.ok(values.size > 2);
  assert.equal(
    JSON.stringify(collector.cachedPublicDeals_()),
    JSON.stringify(deals),
  );
  collector.invalidatePublicDealsCache_();
  assert.equal(collector.cachedPublicDeals_(), null);
});

test('new collector responses avoid a second legacy order event request', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() {
        return { ok: true, order: body.order, legacyEventStored: true };
      },
    };
  };
  try {
    const order = {
      id: 'order-1234567890999',
      createdAt: new Date().toISOString(),
      status: 'new',
      paymentStatus: 'pending',
      version: 1,
      visitorId: 'visitor-single-request',
      customerName: '단일 요청 테스트',
      customerPhone: '01012345678',
      dealId: 'owner-single-request',
      type: 'purchase',
      selectedCount: 1,
      deal: { id: 'owner-single-request', title: '단일 요청 상품' },
    };
    const response = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        order,
        visitorId: order.visitorId,
        customerCapabilityToken: `customer-${'z'.repeat(64)}`,
      },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].action, 'publish_order');
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      GOOGLE_SHEETS_COLLECTOR_URL: previous.collectorUrl,
      GOOGLE_SHEETS_COLLECTOR_TOKEN: previous.collectorToken,
      O2O_DATA_API_ORIGIN: previous.dataOrigin,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('public analytics endpoint rejects server-only order snapshots', async () => {
  const response = await invoke(collectHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      event: {
        id: 'event-12345678',
        name: 'customer_order_snapshot',
        timestamp: new Date().toISOString(),
        visitorId: 'visitor-12345678',
        sessionId: 'session-12345678',
        properties: { order_snapshot: '{}' },
      },
    },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { ok: false, error: 'reserved_event' });
});

test('invalid service headers cannot fall back to browser-origin authorization', async () => {
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'expected-service-token';
  try {
    for (const handler of [groupHandler, publicDealsHandler]) {
      const response = await invoke(handler, {
        headers: {
          origin: 'http://localhost:5173',
          'x-o2o-service-token': 'wrong-service-token',
        },
        body: { action: 'list' },
      });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.body, { ok: false, error: 'unauthorized' });
    }
  } finally {
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
  }
});

test('phase 6 group API rejects chat, read, lock, and admin operations', async () => {
  const previousPhase = process.env.O2O_RELEASE_PHASE;
  process.env.O2O_RELEASE_PHASE = '6';
  try {
    const requests = [
      { action: 'send_message' },
      { action: 'mark_read' },
      { action: 'toggle_lock' },
      { action: 'join', role: 'admin' },
      { action: 'snapshot', adminPin: '2468' },
    ];
    for (const body of requests) {
      const response = await invoke(groupHandler, {
        headers: { origin: 'http://localhost:5173' },
        body,
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.body, { ok: false, error: 'feature_not_available' });
    }
  } finally {
    if (previousPhase === undefined) delete process.env.O2O_RELEASE_PHASE;
    else process.env.O2O_RELEASE_PHASE = previousPhase;
  }
});

test('public deal raw capability is hashed before collector forwarding', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { ok: true, deal: forwarded.deal };
      },
    };
  };

  try {
    const rawToken = `deal-${'a'.repeat(64)}`;
    const response = await invoke(publicDealsHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        capabilityToken: rawToken,
        deal: {
          id: 'customer-security-test',
          groupId: 'customer-security-test',
          source: 'customer',
          title: '보안 테스트',
          image: 'https://example.test/image.jpg',
          menu: [],
        },
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.body.ok, true);
    assert.equal(forwarded.capabilityToken, undefined);
    assert.match(forwarded.ownerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded.ownerCapabilityHash, rawToken);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('merchant group public deals preserve the canonical room id and recruiting host mode', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      async json() { return { ok: true, deal: forwarded.deal }; },
    };
  };

  try {
    const response = await invoke(publicDealsHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        capabilityToken: `deal-${'m'.repeat(64)}`,
        deal: {
          id: 'owner-merchant-room-test',
          source: 'merchant',
          saleType: 'group',
          title: '사과 공동구매',
          target: 40,
          totalQuantity: 40,
          current: 7,
          currentCount: 7,
          participantCount: 2,
          image: 'https://example.test/apple.jpg',
          menu: [],
        },
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(forwarded.deal.groupId, 'owner-merchant-room-test');
    assert.equal(response.body.deal.groupId, 'owner-merchant-room-test');
    assert.equal(response.body.deal.hostMode, 'recruiting');
    assert.equal(response.body.deal.groupStatus, 'recruiting');
    assert.equal(forwarded.deal.targetCount, 20);
    assert.equal(response.body.deal.current, 7);
    assert.equal(response.body.deal.currentCount, 2);
    assert.equal(response.body.deal.currentPeople, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('customer order raw capability is hashed before collector forwarding', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() {
        return body.action === 'publish_order'
          ? { ok: true, order: body.order }
          : { ok: true };
      },
    };
  };

  try {
    const rawToken = `customer-${'b'.repeat(64)}`;
    const order = {
      id: 'order-1234567890123',
      createdAt: new Date().toISOString(),
      visitorId: 'visitor-security-test',
      customerName: '테스트 사용자',
      customerPhone: '01012345678',
      dealId: 'owner-security-test',
      clientMutationId: 'checkout-quantity-security-test',
      hostRemainderApplied: 7,
      deal: { id: 'owner-security-test', title: '보안 테스트' },
    };
    const response = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        order,
        visitorId: order.visitorId,
        customerCapabilityToken: rawToken,
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.body.ok, true);
    assert.equal(forwarded[0].customerCapabilityToken, undefined);
    assert.match(forwarded[0].customerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[0].customerCapabilityHash, rawToken);
    assert.equal(forwarded[0].order.hostRemainderApplied, 7);
    assert.equal(forwarded[0].order.reservationMutationId, 'checkout-quantity-security-test');
    assert.equal(forwarded[0].order.clientMutationId, undefined);
    assert.equal(response.body.order.hostRemainderApplied, 7);
    assert.equal(response.body.order._customerCapabilityHash, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('group order publish requires and hashes the exact participant capability proof', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() { return { ok: true, order: body.order }; },
    };
  };

  try {
    const customerCapabilityToken = `customer-${'c'.repeat(64)}`;
    const participantCapabilityToken = `participant-${'p'.repeat(64)}`;
    const order = {
      id: 'order-1234567890456',
      createdAt: '2026-08-29T01:00:00.000Z',
      visitorId: 'visitor-participant-proof',
      customerName: '참여자',
      customerPhone: '01012345678',
      dealId: 'customer-participant-proof',
      groupId: 'customer-participant-proof',
      type: 'purchase',
      selectedCount: 2,
      reservationMutationId: 'membership-participant-proof',
      deal: { id: 'customer-participant-proof', title: '참여 권한 테스트' },
    };
    const missing = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        order,
        visitorId: order.visitorId,
        customerCapabilityToken,
      },
    });
    assert.equal(missing.statusCode, 403);
    assert.deepEqual(missing.body, { ok: false, error: 'missing_participant_capability' });
    assert.equal(forwarded.length, 0);

    const response = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        order,
        visitorId: order.visitorId,
        customerCapabilityToken,
        participantCapabilityToken,
      },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(forwarded[0].participantCapabilityToken, undefined);
    assert.match(forwarded[0].participantCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[0].participantCapabilityHash, participantCapabilityToken);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('order manage hashes only the selected merchant or group manager capability', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          order: {
            id: body.payload.orderId,
            createdAt: '2026-08-29T01:00:00.000Z',
            statusUpdatedAt: '2026-08-29T01:01:00.000Z',
            status: 'preparing',
            paymentStatus: 'pending',
            visitorId: 'visitor-managed-order',
            customerName: '관리 대상',
            customerPhone: '01012345678',
            dealId: body.payload.dealId,
            groupId: body.payload.managerType === 'group_manager' ? body.payload.dealId : '',
            type: 'purchase',
            selectedCount: 1,
            version: 2,
          },
        };
      },
    };
  };

  try {
    const ownerToken = `owner-${'o'.repeat(64)}`;
    const merchant = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'manage',
        orderId: 'order-1234567890457',
        dealId: 'owner-managed-order',
        managerType: 'merchant_owner',
        kind: 'order_status',
        direction: 'next',
        expectedVersion: 1,
        clientMutationId: 'manage-owner-order-next',
        ownerCapabilityToken: ownerToken,
      },
    });
    assert.equal(merchant.statusCode, 200);
    assert.equal(forwarded[0].action, 'manage_order');
    assert.match(forwarded[0].payload.ownerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[0].payload.ownerCapabilityHash, ownerToken);
    assert.equal(forwarded[0].payload.ownerCapabilityToken, undefined);

    const groupToken = `group-${'g'.repeat(64)}`;
    const group = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'manage',
        orderId: 'order-1234567890458',
        dealId: 'customer-managed-order',
        managerType: 'group_manager',
        actorId: 'visitor-managed-host',
        capabilityToken: groupToken,
        kind: 'payment_status',
        direction: 'next',
        expectedVersion: 1,
        clientMutationId: 'manage-group-payment-next',
      },
    });
    assert.equal(group.statusCode, 200);
    assert.match(forwarded[1].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[1].payload.capabilityHash, groupToken);
    assert.equal(forwarded[1].payload.capabilityToken, undefined);
    assert.equal(forwarded[1].payload.ownerCapabilityHash, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('customer deals and grouped orders require canonical group/deal binding', async () => {
  const dealResponse = await invoke(publicDealsHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      action: 'publish',
      capabilityToken: `deal-${'c'.repeat(64)}`,
      deal: {
        id: 'customer-canonical-a',
        groupId: 'customer-canonical-b',
        source: 'customer',
        title: '잘못 연결된 그룹',
        image: 'https://example.test/image.jpg',
        menu: [],
      },
    },
  });
  assert.equal(dealResponse.statusCode, 400);
  assert.deepEqual(dealResponse.body, { ok: false, error: 'invalid_deal' });

  const orderResponse = await invoke(customerOrdersHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      action: 'publish',
      visitorId: 'visitor-canonical-test',
      customerCapabilityToken: `customer-${'d'.repeat(64)}`,
      order: {
        id: 'order-1234567890124',
        createdAt: new Date().toISOString(),
        visitorId: 'visitor-canonical-test',
        customerName: '테스트 사용자',
        customerPhone: '01012345678',
        dealId: 'customer-canonical-a',
        groupId: 'customer-canonical-b',
        deal: { id: 'customer-canonical-a', title: '잘못 연결된 주문' },
      },
    },
  });
  assert.equal(orderResponse.statusCode, 400);
  assert.deepEqual(orderResponse.body, { ok: false, error: 'invalid_order_request' });

  const groupResponse = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      action: 'create',
      groupId: 'customer-canonical-a',
      dealId: 'customer-canonical-b',
      actorId: 'visitor-canonical-test',
      nickname: '테스트 호스트',
      title: '잘못 연결된 그룹',
      targetCount: 3,
      clientMutationId: 'mutation-canonical-test',
    },
  });
  assert.equal(groupResponse.statusCode, 400);
  assert.deepEqual(groupResponse.body, { ok: false, error: 'invalid_group_deal_binding' });
});

test('group API forwards host, quantity, target, and cancellation contracts without raw capabilities', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousCapabilitySecret = process.env.O2O_CAPABILITY_SECRET;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  process.env.O2O_CAPABILITY_SECRET = 'capability-secret-for-tests';
  delete process.env.O2O_DATA_API_ORIGIN;
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          ...(body.payload.action === 'cancel_participation'
            ? {
                order: {
                  id: body.payload.orderId,
                  status: 'cancelled',
                  paymentStatus: 'cancelled',
                  _customerCapabilityHash: body.payload.customerCapabilityHash,
                  customerCapabilityHash: body.payload.customerCapabilityHash,
                  customerCapabilityToken: 'must-not-leak',
                  capabilityHash: body.payload.capabilityHash,
                  capabilityToken: 'must-not-leak',
                },
              }
            : {}),
          snapshot: {
            group: {
              groupId: body.payload.groupId,
              status: 'recruiting',
              version: 1,
              hostActorId: '',
              hostMode: body.payload.hostMode || 'recruiting',
              totalQuantity: body.payload.totalQuantity || 7,
              orderedQuantity: body.payload.selectedQuantity || 0,
            },
            participants: [],
            history: [],
          },
        };
      },
    };
  };

  try {
    const recruitingCreate = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'create',
        groupId: 'customer-host-recruiting',
        dealId: 'customer-host-recruiting',
        actorId: 'visitor-host-creator',
        nickname: '생성자',
        title: '호스트 모집 그룹',
        targetCount: 3,
        hostMode: 'recruiting',
        totalQuantity: 7,
        selectedQuantity: 3,
        clientMutationId: 'mutation-host-create-recruiting',
      },
    });
    assert.equal(recruitingCreate.statusCode, 200);
    assert.equal(forwarded[0].payload.requestedRole, 'creator');
    assert.equal(forwarded[0].payload.hostMode, 'recruiting');
    assert.equal(forwarded[0].payload.totalQuantity, 7);
    assert.equal(forwarded[0].payload.selectedQuantity, 3);
    assert.match(forwarded[0].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.equal(forwarded[0].payload.capabilityToken, undefined);

    const selfCreate = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'create',
        groupId: 'customer-host-self',
        dealId: 'customer-host-self',
        actorId: 'visitor-self-host',
        nickname: '호스트',
        title: '직접 호스트 그룹',
        targetCount: 4,
        clientMutationId: 'mutation-host-create-self',
      },
    });
    assert.equal(selfCreate.statusCode, 200);
    assert.equal(forwarded[1].payload.requestedRole, 'host');
    assert.equal(forwarded[1].payload.hostMode, 'self');
    assert.equal(forwarded[1].payload.totalQuantity, 4);
    assert.equal(forwarded[1].payload.selectedQuantity, 1);

    const rawCapability = `group-${'e'.repeat(64)}`;
    const claim = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'claim_host',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-candidate',
        capabilityToken: rawCapability,
        clientMutationId: 'mutation-host-claim-candidate',
      },
    });
    assert.equal(claim.statusCode, 200);
    assert.match(forwarded[2].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[2].payload.capabilityHash, rawCapability);
    assert.equal(forwarded[2].payload.capabilityToken, undefined);

    const reserve = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'reserve_quantity',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-candidate',
        capabilityToken: rawCapability,
        quantity: 2,
        expectedVersion: 3,
        clientMutationId: 'mutation-quantity-reserve-test',
      },
    });
    assert.equal(reserve.statusCode, 200);
    assert.equal(forwarded[3].payload.quantity, 2);
    assert.equal(forwarded[3].payload.expectedVersion, 3);

    const targetEdit = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'update_target',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-creator',
        capabilityToken: rawCapability,
        targetCount: 5,
        expectedVersion: 4,
        clientMutationId: 'mutation-target-detail-edit',
      },
    });
    assert.equal(targetEdit.statusCode, 200);
    assert.equal(forwarded[4].payload.targetCount, 5);
    assert.equal(forwarded[4].payload.expectedVersion, 4);
    assert.match(forwarded[4].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.equal(forwarded[4].payload.capabilityToken, undefined);

    const rawCustomerCapability = `customer-${'f'.repeat(64)}`;
    const cancellation = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'cancel_participation',
        groupId: 'customer-host-recruiting',
        actorId: 'visitor-host-candidate',
        capabilityToken: rawCapability,
        customerCapabilityToken: rawCustomerCapability,
        orderId: 'order-1234567890125',
        expectedVersion: 5,
        expectedOrderVersion: 2,
        clientMutationId: 'mutation-participation-cancel-test',
      },
    });
    assert.equal(cancellation.statusCode, 200);
    assert.equal(forwarded[5].action, 'group_cancel_participation');
    assert.equal(forwarded[5].payload.orderId, 'order-1234567890125');
    assert.equal(forwarded[5].payload.expectedVersion, 5);
    assert.equal(forwarded[5].payload.expectedOrderVersion, 2);
    assert.match(forwarded[5].payload.capabilityHash, /^[a-f0-9]{64}$/);
    assert.match(forwarded[5].payload.customerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded[5].payload.capabilityHash, rawCapability);
    assert.notEqual(forwarded[5].payload.customerCapabilityHash, rawCustomerCapability);
    assert.equal(forwarded[5].payload.capabilityToken, undefined);
    assert.equal(forwarded[5].payload.customerCapabilityToken, undefined);
    assert.equal(cancellation.body.order.status, 'cancelled');
    assert.equal(cancellation.body.order._customerCapabilityHash, undefined);
    assert.equal(cancellation.body.order.customerCapabilityHash, undefined);
    assert.equal(cancellation.body.order.customerCapabilityToken, undefined);
    assert.equal(cancellation.body.order.capabilityHash, undefined);
    assert.equal(cancellation.body.order.capabilityToken, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousCapabilitySecret === undefined) delete process.env.O2O_CAPABILITY_SECRET;
    else process.env.O2O_CAPABILITY_SECRET = previousCapabilitySecret;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('participation cancellation validates order version and customer proof before forwarding', async () => {
  const baseBody = {
    action: 'cancel_participation',
    groupId: 'customer-cancel-validation',
    actorId: 'visitor-cancel-validation',
    capabilityToken: `group-${'g'.repeat(64)}`,
    customerCapabilityToken: `customer-${'h'.repeat(64)}`,
    orderId: 'order-1234567890126',
    expectedVersion: 2,
    expectedOrderVersion: 3,
    clientMutationId: 'mutation-cancel-validation-test',
  };

  const missingCustomerProof = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: { ...baseBody, customerCapabilityToken: '' },
  });
  assert.equal(missingCustomerProof.statusCode, 403);
  assert.deepEqual(missingCustomerProof.body, { ok: false, error: 'missing_customer_capability_token' });

  const invalidOrderId = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: { ...baseBody, orderId: 'order-not-valid' },
  });
  assert.equal(invalidOrderId.statusCode, 400);
  assert.deepEqual(invalidOrderId.body, { ok: false, error: 'invalid_order_id' });

  const invalidOrderVersion = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: { ...baseBody, expectedOrderVersion: 0 },
  });
  assert.equal(invalidOrderVersion.statusCode, 400);
  assert.deepEqual(invalidOrderVersion.body, { ok: false, error: 'invalid_expected_order_version' });
});

test('service cancellation accepts only hashed proofs and strips any raw tokens before collector forwarding', async () => {
  const previousDataToken = process.env.O2O_DATA_API_TOKEN;
  const previousCollectorUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousCollectorToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.O2O_DATA_API_TOKEN = 'service-token';
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          order: {
            id: forwarded.payload.orderId,
            status: 'cancelled',
            paymentStatus: 'cancelled',
          },
          snapshot: { group: {}, participants: [], history: [] },
        };
      },
    };
  };

  try {
    const response = await invoke(groupHandler, {
      headers: { 'x-o2o-service-token': 'service-token' },
      body: {
        action: 'cancel_participation',
        groupId: 'customer-cancel-service',
        actorId: 'visitor-cancel-service',
        capabilityHash: 'a'.repeat(64),
        customerCapabilityHash: 'b'.repeat(64),
        capabilityToken: 'raw-group-proof-must-not-forward',
        customerCapabilityToken: 'raw-customer-proof-must-not-forward',
        orderId: 'order-1234567890127',
        expectedVersion: 2,
        expectedOrderVersion: 3,
        clientMutationId: 'mutation-cancel-service-test',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(forwarded.action, 'group_cancel_participation');
    assert.equal(forwarded.payload.capabilityHash, 'a'.repeat(64));
    assert.equal(forwarded.payload.customerCapabilityHash, 'b'.repeat(64));
    assert.equal(forwarded.payload.capabilityToken, undefined);
    assert.equal(forwarded.payload.customerCapabilityToken, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDataToken === undefined) delete process.env.O2O_DATA_API_TOKEN;
    else process.env.O2O_DATA_API_TOKEN = previousDataToken;
    if (previousCollectorUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousCollectorUrl;
    if (previousCollectorToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousCollectorToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('invalid host modes are rejected and host claim conflicts map to 409', async () => {
  const invalidMode = await invoke(groupHandler, {
    headers: { origin: 'http://localhost:5173' },
    body: {
      action: 'create',
      groupId: 'customer-invalid-host-mode',
      dealId: 'customer-invalid-host-mode',
      actorId: 'visitor-invalid-host-mode',
      nickname: '생성자',
      title: '잘못된 모드',
      targetCount: 3,
      hostMode: 'automatic',
      clientMutationId: 'mutation-invalid-host-mode',
    },
  });
  assert.equal(invalidMode.statusCode, 400);
  assert.deepEqual(invalidMode.body, { ok: false, error: 'invalid_host_mode' });

  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { ok: false, error: 'host_already_claimed' }; },
  });
  try {
    const conflict = await invoke(groupHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'claim_host',
        groupId: 'customer-host-conflict',
        actorId: 'visitor-host-conflict',
        capabilityToken: `group-${'f'.repeat(64)}`,
        clientMutationId: 'mutation-host-claim-conflict',
      },
    });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.body, { ok: false, error: 'host_already_claimed' });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('public deals derive host match and clamp ordered quantity', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        deals: [
          {
            id: 'customer-public-host-test',
            groupId: 'customer-public-host-test',
            source: 'customer',
            title: '공개 그룹',
            visibility: 'public',
            hostMode: 'recruiting',
            hostActorId: '',
            hostMatched: true,
            totalQuantity: 3,
            orderedQuantity: 8,
            image: 'https://example.test/image.jpg',
            menu: [],
          },
          {
            id: 'owner-public-split-test',
            source: 'merchant',
            saleType: 'group',
            title: '사장님 분할 공구',
            visibility: 'public',
            originalPrice: 60000,
            discountRate: 7,
            splitPricing: true,
            expectedPerPerson: 2790,
            splitRemainder: 0,
            totalQuantity: 20,
            orderedQuantity: 2,
            image: 'https://example.test/image.jpg',
            menu: [{ id: 'owner-menu-1', name: '묶음', price: 2790 }],
          },
        ],
      };
    },
  });
  try {
    const response = await invoke(publicDealsHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: { action: 'list' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.deals[0].hostMatched, false);
    assert.equal(response.body.deals[0].totalQuantity, 3);
    assert.equal(response.body.deals[0].orderedQuantity, 3);
    assert.equal(response.body.deals[1].splitPricing, true);
    assert.equal(response.body.deals[1].expectedPerPerson, 2790);
    assert.equal(response.body.deals[1].unitPrice, 2790);
    assert.equal(response.body.deals[1].totalQuantity, 20);
    assert.equal(response.body.deals[1].menu[0].price, 2790);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('merchant capacity conflicts are returned to browsers as 409 responses', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;

  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return body.action === 'publish_order'
            ? { ok: false, error: 'quantity_unavailable' }
            : { ok: false, error: 'quantity_below_active_allocations' };
        },
      };
    };

    const orderResponse = await invoke(customerOrdersHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        visitorId: 'visitor-merchant-capacity',
        customerCapabilityToken: `customer-${'j'.repeat(64)}`,
        order: {
          id: 'order-1234567890130',
          createdAt: new Date().toISOString(),
          visitorId: 'visitor-merchant-capacity',
          customerName: '테스트 사용자',
          customerPhone: '01012345678',
          type: 'purchase',
          dealId: 'owner-merchant-capacity',
          selectedCount: 2,
          deal: { id: 'owner-merchant-capacity', title: '동시 주문 테스트' },
        },
      },
    });
    assert.equal(orderResponse.statusCode, 409);
    assert.deepEqual(orderResponse.body, { ok: false, error: 'quantity_unavailable' });

    const dealResponse = await invoke(publicDealsHandler, {
      headers: { origin: 'http://localhost:5173' },
      body: {
        action: 'publish',
        capabilityToken: `deal-${'k'.repeat(64)}`,
        deal: {
          id: 'owner-merchant-capacity',
          source: 'merchant',
          saleType: 'group',
          title: '수량 축소 테스트',
          totalQuantity: 6,
          image: 'https://example.test/image.jpg',
          menu: [],
        },
      },
    });
    assert.equal(dealResponse.statusCode, 409);
    assert.deepEqual(dealResponse.body, {
      ok: false,
      error: 'quantity_below_active_allocations',
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
    if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
  }
});

test('group order reservations bind once to canonical join or reserve provenance', () => {
  const collector = appsScriptContext();
  const history = [
    {
      rowNumber: 2,
      groupId: 'customer-provenance-test',
      actorId: 'visitor-provenance-test',
      action: 'join',
      mutationId: 'membership-join-provenance-test',
      fromStatus: '',
      toStatus: 'joined',
    },
    {
      rowNumber: 3,
      groupId: 'customer-provenance-test',
      actorId: 'visitor-provenance-test',
      action: 'reserve_quantity',
      mutationId: 'checkout-reserve-provenance-test',
      fromStatus: '2',
      toStatus: '4',
    },
  ];
  const participant = { selectedQuantity: 4 };
  const fabricatedOrder = {
    selectedCount: 2,
    reservationMutationId: 'checkout-client-only-id',
  };
  assert.throws(
    () => collector.selectCustomerOrderReservation_(history, {}, fabricatedOrder, participant),
    (error) => error?.code === 'order_reservation_unverified',
  );

  const initialOrder = {
    selectedCount: 2,
    reservationMutationId: 'membership-join-provenance-test',
  };
  const initial = collector.selectCustomerOrderReservation_(history, {}, initialOrder, participant);
  assert.equal(initial.action, 'join');
  assert.equal(initial.mutationId, 'membership-join-provenance-test');
  assert.equal(initial.quantity, 2);

  assert.throws(
    () => collector.selectCustomerOrderReservation_(
      history,
      { 'membership-join-provenance-test': 'order-1234567890198' },
      initialOrder,
      participant,
    ),
    (error) => error?.code === 'order_reservation_conflict',
  );

  const reserved = collector.selectCustomerOrderReservation_(history, {}, {
    selectedCount: 2,
    reservationMutationId: 'checkout-reserve-provenance-test',
  }, participant);
  assert.equal(reserved.action, 'reserve_quantity');
  assert.equal(reserved.mutationId, 'checkout-reserve-provenance-test');

  assert.throws(
    () => collector.selectCustomerOrderReservation_(history, {}, {
      selectedCount: 1,
      reservationMutationId: 'fabricated-reservation-id',
    }, participant),
    (error) => error?.code === 'order_reservation_unverified',
  );

  const participantCapabilityHash = 'a'.repeat(64);
  assert.equal(
    collector.requireParticipantCapability_({ capabilityHash: participantCapabilityHash }, participantCapabilityHash),
    participantCapabilityHash,
  );
  assert.throws(
    () => collector.requireParticipantCapability_(
      { capabilityHash: participantCapabilityHash },
      'b'.repeat(64),
    ),
    (error) => error?.code === 'invalid_participant_capability',
  );
});

test('customer order snapshots enforce CAS and terminal monotonic transitions', () => {
  const collector = appsScriptContext();
  const now = '2026-08-27T12:00:00.000Z';
  const base = {
    id: 'order-1234567890199',
    createdAt: '2026-08-27T11:00:00.000Z',
    visitorId: 'visitor-order-cas-test',
    participantActorId: 'visitor-order-cas-test',
    customerPhone: '01012345678',
    dealId: 'owner-order-cas-test',
    groupId: '',
    type: 'purchase',
    selectedCount: 2,
    total: 5580,
    status: 'new',
    paymentStatus: 'pending',
    version: 1,
    paymentVersion: 1,
    statusHistory: [],
  };

  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(base, {
      ...base,
      status: 'preparing',
    }, now),
    (error) => error?.code === 'order_transition_forbidden',
  );

  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(base, {
      ...base,
      paymentStatus: 'confirmed',
      paymentConfirmedAt: now,
    }, now),
    (error) => error?.code === 'order_transition_forbidden',
  );

  const paymentRequested = collector.mergeCustomerOrderUpdate_(base, {
    ...base,
    paymentStatus: 'requested',
    paymentRequestedAt: now,
  }, now);
  assert.equal(paymentRequested.status, 'new');
  assert.equal(paymentRequested.paymentStatus, 'requested');
  assert.equal(paymentRequested.version, 2);
  assert.equal(paymentRequested.paymentRequestedAt, now);

  const cancelled = {
    ...base,
    status: 'cancelled',
    paymentStatus: 'cancelled',
    cancelledAt: now,
    version: 2,
    paymentVersion: 2,
  };
  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(cancelled, base, now),
    (error) => error?.code === 'state_conflict',
  );

  const processed = {
    ...base,
    status: 'preparing',
    paymentStatus: 'confirmed',
    paymentConfirmedAt: '2026-08-27T11:30:00.000Z',
    version: 2,
    paymentVersion: 2,
  };
  assert.throws(
    () => collector.mergeCustomerOrderUpdate_(processed, {
      ...processed,
      status: 'cancelled',
      paymentStatus: 'cancelled',
      version: 3,
      paymentVersion: 3,
    }, now),
    (error) => error?.code === 'order_transition_forbidden',
  );

  assert.throws(
    () => collector.mergeCustomerOrderUpdate_({
      ...base,
      groupId: 'customer-order-cas-test',
      dealId: 'customer-order-cas-test',
    }, {
      ...base,
      groupId: 'customer-order-cas-test',
      dealId: 'customer-order-cas-test',
      status: 'cancelled',
      paymentStatus: 'cancelled',
      version: 2,
      paymentVersion: 2,
    }, now),
    (error) => error?.code === 'order_transition_forbidden',
  );
});

test('manager transitions are one-step, reversible, role-scoped, and compare-and-swap protected', () => {
  const collector = appsScriptContext();
  const now = '2026-08-29T02:00:00.000Z';
  const base = {
    id: 'order-1234567890460',
    createdAt: '2026-08-29T01:00:00.000Z',
    status: 'new',
    paymentStatus: 'pending',
    version: 1,
    paymentVersion: 1,
    statusHistory: [],
  };

  const progressed = collector.applyManagedCustomerOrderTransition_(base, {
    kind: 'order_status',
    direction: 'next',
    expectedVersion: 1,
    clientMutationId: 'manage-status-next-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(progressed.duplicate, false);
  assert.equal(progressed.order.status, 'preparing');
  assert.equal(progressed.order.version, 2);
  assert.equal(progressed.order.statusHistory[0].actorRole, 'merchant_owner');

  const reverted = collector.applyManagedCustomerOrderTransition_(progressed.order, {
    kind: 'order_status',
    direction: 'previous',
    expectedVersion: 2,
    clientMutationId: 'manage-status-prev-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(reverted.order.status, 'new');
  assert.equal(reverted.order.version, 3);

  assert.throws(
    () => collector.applyManagedCustomerOrderTransition_(progressed.order, {
      kind: 'order_status',
      direction: 'next',
      expectedVersion: 1,
      clientMutationId: 'manage-status-stale-one',
    }, 'merchant_owner', 'merchant-owner-test', now),
    (error) => error?.code === 'state_conflict',
  );

  const confirmed = collector.applyManagedCustomerOrderTransition_(base, {
    kind: 'payment_status',
    direction: 'next',
    expectedVersion: 1,
    clientMutationId: 'manage-payment-next-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(confirmed.order.paymentStatus, 'confirmed');
  assert.equal(confirmed.order.paymentConfirmedAt, now);

  const confirmationReverted = collector.applyManagedCustomerOrderTransition_(confirmed.order, {
    kind: 'payment_status',
    direction: 'previous',
    expectedVersion: 2,
    clientMutationId: 'manage-payment-prev-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(confirmationReverted.order.paymentStatus, 'pending');
  assert.equal(confirmationReverted.order.paymentConfirmedAt, '');
  assert.equal(confirmationReverted.order.paymentRequestedAt, '');

  assert.throws(
    () => collector.applyManagedCustomerOrderTransition_(base, {
      kind: 'payment_status',
      direction: 'next',
      expectedVersion: 1,
      clientMutationId: 'manage-group-pending-one',
    }, 'host', 'visitor-host-test', now),
    (error) => error?.code === 'invalid_state_transition',
  );
  const requested = { ...base, paymentStatus: 'requested', paymentRequestedAt: now };
  const hostConfirmed = collector.applyManagedCustomerOrderTransition_(requested, {
    kind: 'payment_status',
    direction: 'next',
    expectedVersion: 1,
    clientMutationId: 'manage-group-request-one',
  }, 'host', 'visitor-host-test', now);
  assert.equal(hostConfirmed.order.paymentStatus, 'confirmed');

  const replay = collector.applyManagedCustomerOrderTransition_(confirmed.order, {
    kind: 'payment_status',
    direction: 'next',
    expectedVersion: 1,
    clientMutationId: 'manage-payment-next-one',
  }, 'merchant_owner', 'merchant-owner-test', now);
  assert.equal(replay.duplicate, true);
  assert.throws(
    () => collector.applyManagedCustomerOrderTransition_(confirmed.order, {
      kind: 'payment_status',
      direction: 'previous',
      expectedVersion: 2,
      clientMutationId: 'manage-payment-next-one',
    }, 'merchant_owner', 'merchant-owner-test', now),
    (error) => error?.code === 'client_mutation_conflict',
  );
});

test('merchant order management requires the exact deal owner capability', () => {
  const collector = appsScriptContext();
  const ownerHash = 'a'.repeat(64);
  assert.equal(
    collector.requireMerchantOwnerCapability_({ _ownerCapabilityHash: ownerHash }, ownerHash),
    ownerHash,
  );
  assert.throws(
    () => collector.requireMerchantOwnerCapability_({ _ownerCapabilityHash: ownerHash }, 'b'.repeat(64)),
    (error) => error?.code === 'forbidden',
  );
  assert.throws(
    () => collector.requireMerchantOwnerCapability_({}, ownerHash),
    (error) => error?.code === 'deal_ownership_unclaimable',
  );
});

test('only creators or members with an active bound or migrated merchant order may claim host', () => {
  const collector = appsScriptContext();
  const orderSheet = (orders) => ({
    getLastRow() { return orders.length + 1; },
    getRange() {
      return { getValues: () => orders.map((order) => [JSON.stringify(order)]) };
    },
  });
  const activeBoundOrder = {
    id: 'order-1234567890461',
    type: 'purchase',
    status: 'new',
    paymentStatus: 'pending',
    groupId: 'customer-host-order-test',
    participantActorId: 'visitor-host-order-test',
    selectedCount: 2,
    _reservationAction: 'join',
    _reservationMutationId: 'membership-host-order-test',
    _reservationQuantity: 2,
  };
  const merchantDealId = 'merchant-legacy-host-order-test';
  const merchantDealSheet = {
    getLastRow() { return 2; },
    getRange(_row, column) {
      if (column === 2) {
        return {
          createTextFinder() {
            return {
              matchEntireCell() {
                return { findNext: () => ({ getRow: () => 2 }) };
              },
            };
          },
        };
      }
      return {
        getValue: () => JSON.stringify({
          id: merchantDealId,
          source: 'merchant',
          saleType: 'group',
          totalQuantity: 20,
        }),
      };
    },
  };

  assert.equal(collector.requireHostClaimEligibility_(
    { customerOrders: orderSheet([]) },
    { counted: true, role: 'creator' },
    'customer-host-order-test',
    'visitor-creator-test',
  ), true);
  assert.equal(collector.requireHostClaimEligibility_({
    customerOrders: orderSheet([{
      id: 'order-1234567890462',
      type: 'purchase',
      status: 'new',
      paymentStatus: 'pending',
      dealId: merchantDealId,
      visitorId: 'visitor-legacy-host-order',
      selectedCount: 3,
    }]),
    publicDeals: merchantDealSheet,
  }, {
    counted: true,
    role: 'member',
  }, merchantDealId, 'visitor-legacy-host-order'), true);
  assert.equal(collector.requireHostClaimEligibility_(
    { customerOrders: orderSheet([activeBoundOrder]) },
    { counted: true, role: 'member' },
    'customer-host-order-test',
    'visitor-host-order-test',
  ), true);

  [
    { ...activeBoundOrder, status: 'cancelled', paymentStatus: 'cancelled' },
    { ...activeBoundOrder, _reservationMutationId: '' },
    { ...activeBoundOrder, _reservationQuantity: 0 },
  ].forEach((invalidOrder) => {
    assert.throws(
      () => collector.requireHostClaimEligibility_(
        { customerOrders: orderSheet([invalidOrder]) },
        { counted: true, role: 'member' },
        'customer-host-order-test',
        'visitor-host-order-test',
      ),
      (error) => error?.code === 'host_order_required',
    );
  });
});
