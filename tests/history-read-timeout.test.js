import test from 'node:test';
import assert from 'node:assert/strict';

// 9/28 production: history reads failed with upstream_timeout even though the
// handler meant to wait up to 50 seconds. The wait was keyed to action 'list',
// but the collector call uses 'customer_orders', so it never applied.
test('a history read waits past the shared upstream timeout', async () => {
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.invalid/exec';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'x'.repeat(40);
  process.env.O2O_UPSTREAM_TIMEOUT_MS = '1000';
  delete process.env.O2O_DATA_API_ORIGIN;
  const realFetch = globalThis.fetch;
  let upstreamAction = '';
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    upstreamAction = JSON.parse(options.body).action;
    options.signal?.addEventListener('abort', () => reject(options.signal.reason));
    setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, orders: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })), 1400);
  });
  const quiet = console.info;
  console.info = () => {};
  try {
    const { default: handler } = await import('../api/customer-orders.js');
    const res = {
      headers: {},
      statusCode: 0,
      body: null,
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handler({
      method: 'POST',
      headers: { origin: 'https://o2o-ten.vercel.app', host: 'o2o-ten.vercel.app' },
      body: { action: 'list', phone: '01000000000', visitorId: 'visitor-test', customerCapabilityToken: 'c'.repeat(40) },
    }, res);
    assert.equal(upstreamAction, 'customer_orders');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.orders, []);
  } finally {
    globalThis.fetch = realFetch;
    console.info = quiet;
  }
});

test('a history read through the data-API proxy waits the same way', async () => {
  process.env.O2O_DATA_API_ORIGIN = 'https://data-api.invalid';
  process.env.O2O_DATA_API_TOKEN = 'y'.repeat(40);
  process.env.O2O_UPSTREAM_TIMEOUT_MS = '1000';
  const realFetch = globalThis.fetch;
  let proxiedAction = '';
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    proxiedAction = JSON.parse(options.body).action;
    options.signal?.addEventListener('abort', () => reject(options.signal.reason));
    setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, orders: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })), 1400);
  });
  try {
    const { default: handler } = await import('../api/customer-orders.js');
    const res = {
      headers: {},
      statusCode: 0,
      body: null,
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handler({
      method: 'POST',
      headers: { origin: 'https://o2o-ten.vercel.app', host: 'o2o-ten.vercel.app' },
      body: { action: 'list', phone: '01000000000', visitorId: 'visitor-test', customerCapabilityToken: 'c'.repeat(40) },
    }, res);
    assert.equal(proxiedAction, 'list');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.O2O_DATA_API_ORIGIN;
    delete process.env.O2O_DATA_API_TOKEN;
  }
});
