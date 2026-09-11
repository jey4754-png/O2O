import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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

function dashboardEvent(name, properties = {}) {
  return {
    id: `event-central-${name.replaceAll('_', '-')}`,
    name,
    timestamp: '2026-09-09T00:00:00.000Z',
    visitorId: 'visitor-central-dashboard',
    sessionId: 'session-central-dashboard',
    properties: {
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '판교동',
      ...properties,
    },
  };
}

function eventRow(event) {
  return [
    new Date(event.timestamp),
    new Date(event.timestamp),
    '테스터',
    '사용자',
    event.visitorId,
    event.sessionId,
    event.name,
    event.properties.region,
    event.properties.district,
    event.properties.neighborhood,
    event.properties.screen || '',
    JSON.stringify({ ...event.properties, event_id: event.id }),
    'UP-CENTRAL',
    '',
    event.id,
  ];
}

function appsScriptStats(rows) {
  const context = {};
  runInNewContext(
    readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'),
    context,
  );
  context.ensureSheets_ = () => ({
    events: {
      getLastRow: () => rows.length + 1,
      getRange: () => ({ getValues: () => rows }),
    },
  });
  return JSON.parse(JSON.stringify(context.buildCentralStats_()));
}

function appsScriptContext() {
  const context = {};
  runInNewContext(
    readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'),
    context,
  );
  return context;
}

test('dashboard-critical UI events reach the central collector and its aggregate', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
  };
  const forwarded = [];
  globalThis.fetch = async (_url, options) => {
    forwarded.push(JSON.parse(options.body).event);
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true }; },
    };
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  delete process.env.O2O_DATA_API_ORIGIN;

  try {
    for (const event of [
      dashboardEvent('screen_view', { screen: 'deal_list' }),
      dashboardEvent('open_listing', { screen: 'deal_detail' }),
      dashboardEvent('share_clicked', { screen: 'deal_detail', channel: 'copy' }),
    ]) {
      const response = responseRecorder();
      await collectHandler({
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
        body: { event },
      }, response);
      assert.equal(response.statusCode, 202);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.stored, true);
    }

    assert.deepEqual(forwarded.map((event) => event.name), [
      'screen_view',
      'open_listing',
      'share_clicked',
    ]);
    // At-least-once delivery may append a retry after the short cache entry is
    // evicted; the durable aggregate must still count the event ID only once.
    const stats = appsScriptStats([...forwarded, forwarded[0]].map(eventRow));
    assert.equal(stats.visitors, 1);
    assert.equal(stats.eventCounts.screen_view, 1);
    assert.equal(stats.eventCounts.open_listing, 1);
    assert.equal(stats.eventCounts.share_clicked, 1);
    assert.equal(stats.totalEvents, 3);
    assert.deepEqual(stats.funnel.slice(0, 2).map(({ count }) => count), [1, 1]);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.collectorUrl === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_URL;
    else process.env.GOOGLE_SHEETS_COLLECTOR_URL = previous.collectorUrl;
    if (previous.collectorToken === undefined) delete process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN;
    else process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = previous.collectorToken;
    if (previous.dataOrigin === undefined) delete process.env.O2O_DATA_API_ORIGIN;
    else process.env.O2O_DATA_API_ORIGIN = previous.dataOrigin;
  }
});

test('dashboard telemetry never waits behind the commerce lock', () => {
  const context = appsScriptContext();
  const waitTimes = [];
  context.LockService = {
    getScriptLock() {
      return {
        tryLock(waitMs) {
          waitTimes.push(waitMs);
          return false;
        },
      };
    },
  };

  assert.throws(
    () => context.acquireEventIngestLock_(dashboardEvent('screen_view', { screen: 'deal_list' })),
    (error) => error?.code === 'collector_busy',
  );
  assert.throws(
    () => context.acquireEventIngestLock_(dashboardEvent('survey_submitted')),
    (error) => error?.code === 'collector_busy',
  );
  assert.deepEqual(waitTimes, [0, 3000]);
});

test('Apps Script rejects unknown operations and empty events before opening storage', () => {
  const context = appsScriptContext();
  context.ensureSheets_ = () => { throw new Error('invalid requests must not access storage'); };
  context.ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
  };
  for (const [body, expected] of [
    [{ action: 'group_operation' }, 'invalid_action'],
    [{ action: 'unknown_action', event: { name: 'screen_view' } }, 'invalid_action'],
    [{}, 'invalid_event'],
    [{ event: {} }, 'invalid_event'],
  ]) {
    const result = JSON.parse(context.doPost({ postData: {
      contents: JSON.stringify({ token: 'REPLACE_WITH_RANDOM_TOKEN', ...body }),
    } }).text);
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
  }
});

test('Apps Script appends a dashboard event once without scanning the event sheet', () => {
  const context = appsScriptContext();
  const rows = [];
  const cache = new Map();
  const lockWaits = [];
  const events = {
    getLastRow: () => rows.length + 1,
    getRange() {
      throw new Error('dashboard ingestion must not scan the full event sheet');
    },
    appendRow(row) {
      rows.push(row);
    },
  };
  context.ensureSheets_ = () => ({ events, surveys: {} });
  context.LockService = {
    getScriptLock: () => ({
      tryLock(waitMs) {
        lockWaits.push(waitMs);
        return true;
      },
      releaseLock() {},
    }),
  };
  context.CacheService = {
    getScriptCache: () => ({
      get: (key) => cache.get(key) || null,
      put: (key, value) => cache.set(key, value),
      remove: (key) => cache.delete(key),
    }),
  };
  context.ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({
      text,
      setMimeType() { return this; },
    }),
  };

  const event = dashboardEvent('screen_view', { screen: 'deal_list' });
  const request = {
    postData: {
      contents: JSON.stringify({ token: 'REPLACE_WITH_RANDOM_TOKEN', event }),
    },
  };
  const first = JSON.parse(context.doPost(request).text);
  const duplicate = JSON.parse(context.doPost(request).text);

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(duplicate, { ok: true, duplicate: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][6], 'screen_view');
  assert.deepEqual(lockWaits, [0, 0]);
});

test('dashboard events bypass an older data proxy and persist at the collector boundary', async () => {
  const previous = {
    fetch: globalThis.fetch,
    collectorUrl: process.env.GOOGLE_SHEETS_COLLECTOR_URL,
    collectorToken: process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN,
    dataOrigin: process.env.O2O_DATA_API_ORIGIN,
    dataToken: process.env.O2O_DATA_API_TOKEN,
  };
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true }; },
    };
  };
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.example.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'collector-token';
  process.env.O2O_DATA_API_ORIGIN = 'https://older-data-proxy.example.test';
  process.env.O2O_DATA_API_TOKEN = 'data-api-token';

  try {
    const response = responseRecorder();
    await collectHandler({
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
      body: { event: dashboardEvent('open_listing', { screen: 'deal_detail' }) },
    }, response);
    assert.equal(response.statusCode, 202);
    assert.equal(response.body.stored, true);
    assert.deepEqual(requestedUrls, ['https://collector.example.test']);
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
