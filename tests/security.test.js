import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import collectHandler from '../api/collect.js';
import customerOrdersHandler from '../api/customer-orders.js';
import groupHandler from '../api/group-ops.js';
import publicDealsHandler from '../api/public-deals.js';
import { dataApiOrigin } from '../api/_data-upstream.js';

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
  const initialOrder = {
    selectedCount: 2,
    reservationMutationId: 'checkout-client-only-id',
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

  const progressed = collector.mergeCustomerOrderUpdate_(base, {
    ...base,
    status: 'preparing',
  }, now);
  assert.equal(progressed.status, 'preparing');
  assert.equal(progressed.version, 2);
  assert.equal(progressed.statusUpdatedAt, now);

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
