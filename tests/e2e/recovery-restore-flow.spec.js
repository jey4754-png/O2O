import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import recoveryHandler from '../../api/recovery.js';
import customerOrdersHandler from '../../api/customer-orders.js';
import { customerHistoryStore, historyOrder } from '../helpers/customer-history-store.js';
import { fakeSheet, imageResponse } from '../helpers/product-image-store.js';

// Reproduces the customer's 2026-09-23 19:15 path end to end with the real
// Vercel handlers and the real collector: a laptop key owns the orders and is
// enrolled, then a fresh browser restores with the number and must list them.
const LAPTOP_TOKEN = 'laptop-customer-capability-token-000000000001';
const LAPTOP_HASH = createHash('sha256').update(LAPTOP_TOKEN).digest('hex');
const PHONE = '01011112222';
const PIN = '731946';

function store() {
  const fixture = customerHistoryStore({
    current: [historyOrder('1234567890801', { title: '노트북에서 넣은 경기미', _customerCapabilityHash: LAPTOP_HASH }),
      historyOrder('1234567890802', { title: '노트북에서 넣은 메모지', _customerCapabilityHash: LAPTOP_HASH })],
    historic: [historyOrder('1234567890803', { title: '과거 스냅샷 주문', _customerCapabilityHash: LAPTOP_HASH })],
  });
  const recovery = fakeSheet();
  recovery.rows.push(['등록시각', '갱신시각', '식별키', '검증자', '결박해시', '현재해시',
    '결박주문', '결박그룹', '결박상품', '참여자ID', '버전', '마지막변경ID']);
  fixture.data.recovery = recovery;
  const properties = new Map();
  Object.assign(fixture.context, {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
      setProperty: (key, value) => properties.set(key, value),
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' }, getUuid: randomUUID,
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value)).digest()],
    },
  });
  return { ...fixture, recovery };
}

async function viaHandler(handler, route, fixture) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const result = fixture.context.doPost({ postData: { contents: options.body } });
    return { status: 200, ok: true, json: async () => JSON.parse(JSON.stringify(result)) };
  };
  try {
    const response = imageResponse();
    await handler({ method: 'POST', headers: { origin: 'http://127.0.0.1:4187' }, body: route.request().postDataJSON() }, response);
    await route.fulfill({ status: response.statusCode, json: response.body });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('확인번호로 되살리면 새 브라우저의 내 주문에 노트북 주문이 뜬다', async ({ page }) => {
  const fixture = store();
  const keys = ['O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { O2O_DATA_API_ORIGIN: '', O2O_DATA_API_TOKEN: '',
    GOOGLE_SHEETS_COLLECTOR_URL: 'https://collector.example.test', GOOGLE_SHEETS_COLLECTOR_TOKEN: 'REPLACE_WITH_RANDOM_TOKEN' });
  try {
    // The laptop enrolls through the real handler while it still holds its key.
    const enroll = imageResponse();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => ({ status: 200, ok: true,
      json: async () => JSON.parse(JSON.stringify(fixture.context.doPost({ postData: { contents: options.body } }))) });
    await recoveryHandler({ method: 'POST', headers: { origin: 'http://127.0.0.1:4187' }, body: {
      action: 'enroll', phone: PHONE, pin: PIN, actorId: 'customer-history-visitor',
      clientMutationId: 'laptop-enroll-0001', customerCapabilityToken: LAPTOP_TOKEN, groups: [], deals: [],
    } }, enroll);
    globalThis.fetch = originalFetch;
    expect(enroll.statusCode, JSON.stringify(enroll.body)).toBe(200);
    expect(enroll.body.bound.orders).toBe(3);

    await page.addInitScript(() => {
      if (localStorage.getItem('restore-test-seeded')) return;
      localStorage.setItem('restore-test-seeded', 'yes');
      localStorage.setItem('o2o_mvp_profile', JSON.stringify({ name: '새 브라우저', phone: '010-1111-2222',
        testerType: '사용자', consent: true, region: '경기도', district: '성남시 분당구', neighborhood: '판교동' }));
      sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({ profileKey: '사용자:01011112222', startedAt: Date.now() }));
    });
    const reads = [];
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/recovery') return viaHandler(recoveryHandler, route, fixture);
      if (path === '/api/customer-orders') {
        const body = route.request().postDataJSON() || {};
        if (body.action === 'list') reads.push(body);
        if (body.action !== 'list') return route.fulfill({ status: 403, json: { ok: false, error: 'fixture_read_only' } });
        return viaHandler(customerOrdersHandler, route, fixture);
      }
      return route.fulfill({ json: { ok: true, deals: [], orders: [], unreadCounts: {}, stats: {}, events: [] } });
    });
    await page.goto('/customer');
    await page.locator('.bottom-nav').getByRole('button', { name: '내 주문', exact: true }).click();
    await expect(page.getByRole('heading', { name: '조회 가능한 참여 내역이 없습니다' })).toBeVisible();
    await page.getByLabel('복구 확인번호').fill(PIN);
    await page.getByRole('button', { name: '확인번호로 되살리기', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '주문 3건' })).toBeVisible();
    await expect(page.locator('.order-card')).toHaveCount(3);
    await expect(page.locator('.order-card-list')).toContainText('노트북에서 넣은 경기미');
    await expect(page.locator('.order-card-list')).toContainText('과거 스냅샷 주문');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
