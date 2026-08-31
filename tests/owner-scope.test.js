import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import customerOrdersHandler from '../api/customer-orders.js';
import publicDealsHandler from '../api/public-deals.js';

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

async function invoke(handler, body) {
  const response = responseRecorder();
  await handler({
    method: 'POST',
    headers: { origin: 'http://localhost:5173' },
    body,
  }, response);
  return response;
}

function withCollector(testBody) {
  return async () => {
    const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
    const previousFetch = globalThis.fetch;
    process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
    process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
    delete process.env.O2O_DATA_API_ORIGIN;
    try {
      await testBody();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
      else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previousUrl;
      if (previousToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
      else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previousToken;
      if (previousDataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
      else process.env.O2O_DATA_API_ORIGIN = previousDataOrigin;
    }
  };
}

test('owner deal listing hashes every browser capability before collector forwarding', withCollector(async () => {
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push(body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          deals: [{
            id: 'owner-owned-one',
            source: 'merchant',
            saleType: 'group',
            title: '소유 상품',
            image: 'https://example.test/owned.jpg',
            menu: [],
            _ownerCapabilityHash: 'f'.repeat(64),
          }],
        };
      },
    };
  };

  const firstToken = `owner-token-${'a'.repeat(64)}`;
  const secondToken = `owner-token-${'b'.repeat(64)}`;
  const response = await invoke(publicDealsHandler, {
    action: 'list_owner',
    capabilities: [
      { dealId: 'owner-owned-one', capabilityToken: firstToken },
      { dealId: 'owner-owned-two', capabilityToken: secondToken },
    ],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(forwarded[0].action, 'owner_deals');
  assert.equal(forwarded[0].ownerClaims.length, 2);
  forwarded[0].ownerClaims.forEach((claim) => {
    assert.match(claim.ownerCapabilityHash, /^[a-f0-9]{64}$/);
    assert.equal(claim.capabilityToken, undefined);
  });
  assert.doesNotMatch(JSON.stringify(forwarded[0]), new RegExp(`${firstToken}|${secondToken}`));
  assert.equal(response.body.deals[0]._ownerCapabilityHash, undefined);
}));

test('owner order listing forwards only hashed claims and returns scoped canonical orders', withCollector(async () => {
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          orders: [{
            id: 'order-1234567890123',
            createdAt: '2026-08-31T00:00:00.000Z',
            status: 'new',
            paymentStatus: 'pending',
            visitorId: 'visitor-owner-scope',
            customerName: '주문 고객',
            customerPhone: '01012345678',
            dealId: 'owner-owned-orders',
            type: 'purchase',
            selectedCount: 2,
            title: '소유 상품',
            total: 2000,
            version: 1,
          }],
        };
      },
    };
  };

  const rawToken = `owner-token-${'c'.repeat(64)}`;
  const response = await invoke(customerOrdersHandler, {
    action: 'list_owner',
    capabilities: [{ dealId: 'owner-owned-orders', capabilityToken: rawToken }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.orders.length, 1);
  assert.equal(forwarded.action, 'customer_orders_owner');
  assert.match(forwarded.ownerClaims[0].ownerCapabilityHash, /^[a-f0-9]{64}$/);
  assert.equal(forwarded.ownerClaims[0].capabilityToken, undefined);
  assert.doesNotMatch(JSON.stringify(forwarded), new RegExp(rawToken));
}));

test('owner listing rejects empty, duplicate, malformed, and oversized capability sets before fetch', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error('fetch_should_not_run');
  };
  try {
    const token = `owner-token-${'d'.repeat(64)}`;
    const invalidBodies = [
      { action: 'list_owner', capabilities: [] },
      {
        action: 'list_owner',
        capabilities: [
          { dealId: 'owner-duplicate', capabilityToken: token },
          { dealId: 'owner-duplicate', capabilityToken: token },
        ],
      },
      { action: 'list_owner', capabilities: [{ dealId: 'customer-not-owner', capabilityToken: token }] },
      {
        action: 'list_owner',
        capabilities: Array.from({ length: 51 }, (_, index) => ({
          dealId: `owner-too-many-${index}`,
          capabilityToken: token,
        })),
      },
    ];

    for (const body of invalidBodies) {
      const dealResponse = await invoke(publicDealsHandler, body);
      assert.equal(dealResponse.statusCode, 400);
      assert.equal(dealResponse.body.error, 'invalid_owner_claims');

      const orderResponse = await invoke(customerOrdersHandler, body);
      assert.equal(orderResponse.statusCode, 400);
      assert.equal(orderResponse.body.error, 'invalid_owner_claims');
    }
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('owner listing rejects missing, overlong, and oversized request secrets before fetch', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error('fetch_should_not_run');
  };
  try {
    const invalidSecrets = ['', 'short-token', 'x'.repeat(257)];
    for (const capabilityToken of invalidSecrets) {
      const body = {
        action: 'list_owner',
        capabilities: [{ dealId: 'owner-secret-boundary', capabilityToken }],
      };
      const expectedCode = capabilityToken.length < 32
        ? 'missing_owner_capability'
        : 'invalid_owner_capability';
      const dealResponse = await invoke(publicDealsHandler, body);
      assert.equal(dealResponse.statusCode, 403);
      assert.equal(dealResponse.body.error, expectedCode);

      const orderResponse = await invoke(customerOrdersHandler, body);
      assert.equal(orderResponse.statusCode, 403);
      assert.equal(orderResponse.body.error, expectedCode);
    }

    const oversizedBody = {
      action: 'list_owner',
      capabilities: [{ dealId: 'owner-request-too-large', capabilityToken: 'x'.repeat(64) }],
      padding: 'x'.repeat(60000),
    };
    const dealResponse = await invoke(publicDealsHandler, oversizedBody);
    assert.equal(dealResponse.statusCode, 400);
    assert.equal(dealResponse.body.error, 'invalid_request_body');
    const orderResponse = await invoke(customerOrdersHandler, oversizedBody);
    assert.equal(orderResponse.statusCode, 400);
    assert.equal(orderResponse.body.error, 'invalid_request_body');
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Apps Script owner scope accepts only exact merchant capabilities and filters order PII by deal', () => {
  const collector = appsScriptContext();
  const validHash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const deals = {
    'owner-valid': { id: 'owner-valid', source: 'merchant', _ownerCapabilityHash: validHash },
    'owner-wrong-token': { id: 'owner-wrong-token', source: 'merchant', _ownerCapabilityHash: otherHash },
    'owner-not-merchant': { id: 'owner-not-merchant', source: 'customer', _ownerCapabilityHash: validHash },
  };
  collector.publicDealRecord_ = (_sheet, dealId) => deals[dealId] || null;

  const authorized = collector.authorizedOwnerDealIds_({ publicDeals: {} }, [
    { dealId: 'owner-valid', ownerCapabilityHash: validHash },
    { dealId: 'owner-wrong-token', ownerCapabilityHash: validHash },
    { dealId: 'owner-not-merchant', ownerCapabilityHash: validHash },
  ]);
  assert.equal(Boolean(authorized['owner-valid']), true);
  assert.equal(Boolean(authorized['owner-wrong-token']), false);
  assert.equal(Boolean(authorized['owner-not-merchant']), false);

  const scoped = JSON.parse(JSON.stringify(collector.ownerScopedOrders_([
    {
      id: 'order-1234567890124',
      dealId: 'owner-valid',
      customerName: '노출 허용 고객',
      customerPhone: '01011112222',
      createdAt: '2026-08-31T01:00:00.000Z',
    },
    {
      id: 'order-1234567890125',
      dealId: 'owner-wrong-token',
      customerName: '다른 상품 고객',
      customerPhone: '01033334444',
      createdAt: '2026-08-31T02:00:00.000Z',
    },
  ], authorized)));
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].dealId, 'owner-valid');
  assert.equal(scoped[0].customerPhone, '01011112222');
  assert.equal(JSON.stringify(scoped).includes('01033334444'), false);
});
