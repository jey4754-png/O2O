import test from 'node:test';
import assert from 'node:assert/strict';

import publicDealsHandler from '../api/public-deals.js';

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

async function publish(deal) {
  const response = responseRecorder();
  await publicDealsHandler({
    method: 'POST',
    headers: { origin: 'http://localhost:5173' },
    body: {
      action: 'publish',
      capabilityToken: `pricing-${'x'.repeat(64)}`,
      deal,
    },
  }, response);
  return response;
}

async function list() {
  const response = responseRecorder();
  await publicDealsHandler({
    method: 'POST',
    headers: { origin: 'http://localhost:5173' },
    body: { action: 'list' },
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
    const forwardedDeals = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      forwardedDeals.push(body.deal);
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, deal: body.deal };
        },
      };
    };
    try {
      await testBody(forwardedDeals);
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

test('explicit merchant split pricing round-trips without treating stock as its divisor', withCollector(async (forwarded) => {
  const response = await publish({
    id: 'owner-explicit-pricing-roundtrip',
    source: 'merchant',
    saleType: 'group',
    title: '미니 꽃다발',
    originalPrice: 13000,
    discountRate: 15,
    totalQuantity: 5,
    targetCount: 5,
    pricingModel: 'explicit_split',
    pricingVersion: 2,
    splitQuantity: 1,
    splitPricing: false,
    expectedPerPerson: 11050,
    unitPrice: 11050,
    menu: [],
  });

  assert.equal(response.statusCode, 202);
  assert.equal(forwarded.length, 1);
  for (const deal of [forwarded[0], response.body.deal]) {
    assert.equal(deal.totalQuantity, 5);
    assert.equal(deal.productQuantity, 5);
    assert.equal(deal.targetCount, 5);
    assert.equal(deal.splitQuantity, 1);
    assert.equal(deal.splitPricing, false);
    assert.equal(deal.pricingModel, 'explicit_split');
    assert.equal(deal.pricingVersion, 2);
    assert.equal(deal.unitPrice, 11050);
  }
}));

test('legacy customer deals without a stored group id remain visible and use their deal id', async () => {
  const previousUrl = process.env.GOOGLE_SHEETS_COLLECTOR_URL;
  const previousToken = process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
  const previousDataOrigin = process.env.O2O_DATA_API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ok: true,
        deals: [{
          id: 'customer-legacy-without-group-id',
          source: 'customer',
          title: '기존 사용자 공동구매',
          originalPrice: 12000,
          discountRate: 0,
          totalQuantity: 2,
          menu: [],
        }],
      };
    },
  });

  try {
    const response = await list();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.deals.length, 1);
    assert.equal(response.body.deals[0].id, 'customer-legacy-without-group-id');
    assert.equal(response.body.deals[0].groupId, 'customer-legacy-without-group-id');
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

test('explicit split values are bounded while invalid metadata cannot convert a legacy deal', withCollector(async (forwarded) => {
  const clampedResponse = await publish({
    id: 'owner-explicit-pricing-clamped',
    source: 'merchant',
    saleType: 'group',
    title: '분할 공동구매',
    originalPrice: 10000,
    discountRate: 0,
    totalQuantity: 4,
    pricingModel: 'explicit_split',
    pricingVersion: 99,
    splitQuantity: 50,
    splitPricing: false,
    menu: [],
  });
  assert.equal(clampedResponse.statusCode, 202);
  assert.equal(clampedResponse.body.deal.totalQuantity, 4);
  assert.equal(clampedResponse.body.deal.splitQuantity, 4);
  assert.equal(clampedResponse.body.deal.splitPricing, true);
  assert.equal(clampedResponse.body.deal.pricingVersion, 2);

  const minimumResponse = await publish({
    id: 'owner-explicit-pricing-minimum',
    source: 'merchant',
    saleType: 'group',
    title: '최소 분할 공동구매',
    originalPrice: 10000,
    discountRate: 0,
    totalQuantity: 9,
    pricingModel: 'explicit_split',
    pricingVersion: 2,
    splitQuantity: -8,
    splitPricing: true,
    menu: [],
  });
  assert.equal(minimumResponse.statusCode, 202);
  assert.equal(minimumResponse.body.deal.totalQuantity, 9);
  assert.equal(minimumResponse.body.deal.splitQuantity, 1);
  assert.equal(minimumResponse.body.deal.splitPricing, false);

  const legacyResponse = await publish({
    id: 'owner-legacy-pricing-unchanged',
    source: 'merchant',
    saleType: 'group',
    title: '기존 공동구매',
    originalPrice: 10000,
    discountRate: 0,
    totalQuantity: 7,
    pricingModel: 'unsupported_model',
    pricingVersion: 'invalid',
    splitQuantity: 'invalid',
    splitPricing: true,
    menu: [],
  });
  assert.equal(legacyResponse.statusCode, 202);
  assert.equal(legacyResponse.body.deal.totalQuantity, 7);
  assert.equal(legacyResponse.body.deal.splitPricing, true);
  assert.equal('splitQuantity' in legacyResponse.body.deal, false);
  assert.equal('pricingModel' in legacyResponse.body.deal, false);
  assert.equal('pricingVersion' in legacyResponse.body.deal, false);
  assert.equal(forwarded.length, 3);
}));

test('public deal gateway rejects malformed financial fields before collector forwarding', withCollector(async (forwarded) => {
  const validDeal = {
    id: 'owner-invalid-pricing-boundary',
    source: 'merchant',
    saleType: 'group',
    title: '금액 검증 상품',
    originalPrice: 10000,
    discountRate: 10,
    unitPrice: 9000,
    totalQuantity: 2,
    menu: [{ id: 'menu-one', name: '상품', price: 9000 }],
  };
  const invalidDeals = [
    { ...validDeal, originalPrice: -1 },
    { ...validDeal, originalPrice: 1.5 },
    { ...validDeal, originalPrice: Number.MAX_SAFE_INTEGER + 1 },
    { ...validDeal, discountRate: -1 },
    { ...validDeal, discountRate: 101 },
    { ...validDeal, unitPrice: -1 },
    { ...validDeal, unitPrice: 1.5 },
    { ...validDeal, menu: [{ id: 'menu-one', name: '상품', price: -1 }] },
    { ...validDeal, menu: [{ id: 'menu-one', name: '상품', price: 1.5 }] },
  ];

  for (const deal of invalidDeals) {
    const response = await publish(deal);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { ok: false, error: 'invalid_deal_price' });
  }
  assert.equal(forwarded.length, 0);
}));
