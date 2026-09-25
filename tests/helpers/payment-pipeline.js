import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import groupHandler from '../../api/group-ops.js';
import publicDealHandler from '../../api/public-deals.js';
import customerOrderHandler from '../../api/customer-orders.js';
import collectHandler from '../../api/collect.js';
import { fakeSheet, imageResponse } from './product-image-store.js';

// Only Google-hosted service primitives are replaced. Every production handler,
// GAS entry point, capability check, lock acquisition, lookup and state mutation
// executes unchanged against a private in-memory spreadsheet for each test.
export function paymentPipelineStore() {
  const sheets = new Map();
  const properties = new Map();
  const cacheEntries = new Map();
  let locked = false;
  const cache = {
    get(key) {
      const entry = cacheEntries.get(key);
      if (!entry || entry.expiresAt < Date.now()) return null;
      return entry.value;
    },
    put(key, value, seconds = 600) {
      cacheEntries.set(key, { value: String(value), expiresAt: Date.now() + seconds * 1000 });
    },
    getAll(keys) { return Object.fromEntries(keys.map((key) => [key, this.get(key)])); },
    putAll(values, seconds) { Object.entries(values).forEach(([key, value]) => this.put(key, value, seconds)); },
    remove(key) { cacheEntries.delete(key); },
    removeAll(keys) { keys.forEach((key) => cacheEntries.delete(key)); },
  };
  const context = {
    console,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value)).digest()],
      getUuid: randomUUID,
    },
    SpreadsheetApp: { openById: () => ({
      getSheetByName: (name) => sheets.get(name) || null,
      insertSheet(name) {
        const sheet = fakeSheet();
        sheet.getLastColumn = () => Math.max(0, ...sheet.rows.map((row) => row.length));
        sheets.set(name, sheet);
        return sheet;
      },
    }) },
    LockService: { getScriptLock: () => ({
      tryLock() { if (locked) return false; locked = true; return true; },
      releaseLock() { locked = false; },
    }) },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.get(key) ?? null,
      setProperty: (key, value) => properties.set(key, String(value)),
    }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (contents) => ({ contents, setMimeType() { return this; } }),
    },
  };
  runInNewContext(readFileSync(new URL('../../apps-script/Code.gs', import.meta.url), 'utf8'), context);
  const data = context.ensureSheets_();
  return {
    context, sheets, data,
    orders: () => data.customerOrders.rows.slice(1).map((row) => JSON.parse(row[3])),
    payments: () => data.groupHistory.rows.slice(1).filter((row) => row[2] === 'payment'),
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export async function installPaymentPipeline(page, hooks = {}) {
  const store = paymentPipelineStore();
  const apiRequests = [];
  const collectorRequests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const contents = Buffer.concat(chunks).toString();
      const payload = JSON.parse(contents);
      const entry = { payload };
      collectorRequests.push(entry);
      await hooks.beforeCollector?.(entry);
      entry.result = JSON.parse(store.context.doPost({ postData: { contents } }).contents);
      await hooks.afterCollector?.(entry);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(entry.result));
    } catch (error) {
      failures.push(String(error.stack || error));
      response.statusCode = 500;
      response.end(JSON.stringify({ ok: false, error: 'test_collector_exception' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    O2O_DATA_API_ORIGIN: '', O2O_DATA_API_TOKEN: '',
    O2O_CAPABILITY_SECRET: 'isolated-payment-pipeline-secret-no-production-access',
    O2O_RELEASE_PHASE: '9',
    GOOGLE_SHEETS_COLLECTOR_URL: `http://127.0.0.1:${server.address().port}`,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: 'REPLACE_WITH_RANDOM_TOKEN',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const handlers = {
    '/api/group-ops': groupHandler,
    '/api/public-deals': publicDealHandler,
    '/api/customer-orders': customerOrderHandler,
    '/api/collect': collectHandler,
  };
  const attachedPages = new Set();
  const attach = async (page) => {
    attachedPages.add(page);
    await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const handler = handlers[path];
    if (!handler) {
      // The dashboard is unrelated to this payment path. Never synthesize a
      // successful group or order response, including after an unexpected URL.
      if (path === '/api/stats') return route.fulfill({ json: { ok: true, stats: {} } });
      failures.push(`Unexpected API: ${path}`);
      return route.fulfill({ status: 404, json: { ok: false, error: 'unexpected_test_api' } });
    }
    const body = request.postData() ? request.postDataJSON() : {};
    const entry = { path, body, method: request.method() };
    apiRequests.push(entry);
    try {
      await hooks.beforeApi?.(entry);
      const response = imageResponse();
      await handler({
        method: request.method(),
        headers: { ...request.headers(), origin: 'http://127.0.0.1:4187' },
        body, query: Object.fromEntries(url.searchParams),
      }, response);
      entry.status = response.statusCode;
      entry.result = response.body;
      const delivery = await hooks.afterApi?.(entry);
      if (delivery === 'lose-response') return route.abort('connectionreset');
      if (delivery === 'timeout-response') {
        entry.deliveryStatus = 504;
        return route.fulfill({ status: 504, json: { ok: false, error: 'upstream_timeout' } });
      }
      await route.fulfill({ status: response.statusCode, headers: response.headers, json: response.body });
    } catch (error) {
      if (page.isClosed()) return;
      failures.push(String(error.stack || error));
      await route.fulfill({ status: 500, json: { ok: false, error: 'test_handler_exception' } });
    }
  });
  };
  await attach(page);
  return {
    ...store, apiRequests, collectorRequests, failures, attach,
    async close() {
      await Promise.all([...attachedPages].map((attached) => attached.close()));
      await new Promise((resolve) => server.close(resolve));
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    },
  };
}
