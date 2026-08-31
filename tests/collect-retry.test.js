import test from 'node:test';
import assert from 'node:assert/strict';

import collectHandler from '../api/collect.js';

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

function validEvent() {
  return {
    id: 'event-collect-retry-test',
    name: 'screen_view',
    timestamp: new Date().toISOString(),
    visitorId: 'visitor-collect-retry',
    sessionId: 'session-collect-retry',
    properties: { screen: 'home' },
  };
}

async function invoke() {
  const response = responseRecorder();
  await collectHandler({
    method: 'POST',
    headers: { origin: 'http://localhost:5173' },
    body: { event: validEvent() },
  }, response);
  return response;
}

async function withCollector(fetchImplementation, run) {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
  };
  globalThis.fetch = fetchImplementation;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;
  try {
    await run();
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.collectorUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previous.collectorUrl;
    if (previous.collectorToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previous.collectorToken;
    if (previous.dataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previous.dataOrigin;
  }
}

test('collector busy is preserved as retryable 503', async () => {
  await withCollector(async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: false, error: 'collector_busy' }; },
  }), async () => {
    const response = await invoke();
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { ok: false, error: 'collector_busy' });
    assert.equal(response.headers['Retry-After'], '3');
  });
});

test('collector timeout is preserved as retryable 504', async () => {
  await withCollector(async () => {
    const error = new Error('request timed out');
    error.name = 'TimeoutError';
    throw error;
  }, async () => {
    const response = await invoke();
    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.body, { ok: false, error: 'upstream_timeout' });
    assert.equal(response.headers['Retry-After'], '3');
  });
});
