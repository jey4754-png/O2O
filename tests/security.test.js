import test from 'node:test';
import assert from 'node:assert/strict';

import collectHandler from '../api/collect.js';
import customerOrdersHandler from '../api/customer-orders.js';
import groupHandler from '../api/group-ops.js';
import publicDealsHandler from '../api/public-deals.js';
import { dataApiOrigin } from '../api/_data-upstream.js';

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

test('group API forwards host mode, quantity, target edit, claim, and reserve contracts without raw capabilities', async () => {
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
        deals: [{
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
        }],
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
