import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import handler from '../../api/admin-ops.js';
import { adminStore } from '../helpers/admin-store.js';
import { imageResponse } from '../helpers/product-image-store.js';

test('관리자 앱 선택은 PIN·상품관리로 진입하고 상세 미리보기와 채팅 뒤에도 관리 동선을 유지한다', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const { context, publicDeals, dealId, orderId } = adminStore();
  const fixtureDeal = { ...JSON.parse(publicDeals.rows[1][6]), title: '관리 진입 경로 검증 상품', saleType: 'group',
    target: 5, totalQuantity: 10, groupId: dealId, neighborhood: '판교동', store: '검증 매장',
    image: 'https://broken-admin-image.example.test/historical-product.jpg',
    methods: ['pickup'], menu: [{ id: 'entry-menu', name: '관리 진입 경로 검증 상품', price: 1000 }] };
  publicDeals.rows[1][6] = JSON.stringify(fixtureDeal);
  const scriptProperties = new Map();
  context.PropertiesService = { getScriptProperties: () => ({
    getProperty: (key) => scriptProperties.has(key) ? scriptProperties.get(key) : null,
    setProperty: (key, value) => scriptProperties.set(key, value),
  }) };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = context.doPost({ postData: { contents: Buffer.concat(chunks).toString() } });
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const keys = ['O2O_ADMIN_PIN', 'O2O_DATA_API_ORIGIN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { O2O_ADMIN_PIN: 'entry-test-pin', O2O_DATA_API_ORIGIN: '',
    GOOGLE_SHEETS_COLLECTOR_URL: `http://127.0.0.1:${server.address().port}`, GOOGLE_SHEETS_COLLECTOR_TOKEN: 'REPLACE_WITH_RANDOM_TOKEN' });
  try {
    await page.route('https://broken-admin-image.example.test/**', (route) => route.abort('failed'));
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON() || {};
      if (path === '/api/admin-ops') {
        const response = imageResponse();
        await handler({ method: 'POST', headers: { origin: 'http://127.0.0.1:4187' }, body }, response);
        return route.fulfill({ status: response.statusCode, json: response.body });
      }
      if (path === '/api/public-deals') return route.fulfill({ json: { ok: true, deals: [fixtureDeal] } });
      if (path === '/api/group-ops') return route.fulfill({ json: { ok: true, capabilityToken: `entry-test-capability-${body.actorId}`,
        snapshot: { group: { id: dealId, groupId: dealId, status: 'recruiting', version: 1, targetCount: 5, totalQuantity: 10 },
          viewer: { actorId: body.actorId, role: 'admin' }, participants: [{ actorId: body.actorId, role: 'admin', counted: false }],
          messages: [], history: [], lastSeq: 0 } } });
      await route.fulfill({ json: { ok: true, deals: [], orders: [], stats: {}, unreadCounts: {} } });
    });
    await page.goto('/customer');
    await page.getByLabel('이름', { exact: true }).fill('관리 진입 검증');
    await page.getByLabel('연락처').fill('010-1234-5678');
    await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
    await page.getByRole('button', { name: '테스트 시작' }).click();
    await page.getByRole('button', { name: /관리 진입 경로 검증 상품/ }).click();
    await expect(page.getByRole('heading', { name: '공동구매 상세', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '관리자 앱', exact: true }).click();
    await page.getByLabel('이름', { exact: true }).fill('관리자 진입 검증');
    await page.getByLabel('연락처').fill('010-1234-5678');
    await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
    await page.getByRole('button', { name: '테스트 시작' }).click();
    await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '공동구매 상세', exact: true })).toHaveCount(0);
    await page.getByLabel('관리자 PIN', { exact: true }).fill('entry-test-pin');
    await page.getByRole('button', { name: '관리자 확인', exact: true }).click();
    await expect(page.getByRole('heading', { name: '상품·주문 관리', exact: true })).toBeVisible();
    const adminProductImage = page.locator('.admin-product').filter({ hasText: dealId }).locator('img');
    await expect(adminProductImage).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await expect(adminProductImage).toHaveAttribute('loading', 'lazy');
    // Refresh reuses the same product row. A previous failed image must not
    // prevent a later unavailable URL from receiving the same safe fallback.
    fixtureDeal.image = 'https://broken-admin-image.example.test/replaced-product.jpg';
    publicDeals.rows[1][6] = JSON.stringify(fixtureDeal);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(page.getByRole('button', { name: '새로고침', exact: true })).toBeEnabled();
    await expect(adminProductImage).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await expect(page.getByLabel('현재 PIN', { exact: true })).toBeHidden();
    await page.locator('.admin-product').filter({ hasText: dealId }).click();
    await expect(page.getByRole('button', { name: '상품 삭제 (기록 보존)', exact: true })).toBeVisible();
    await expect(page.getByText('관리자 이미지 변경', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '관리자 참여 취소', exact: true })).toBeVisible();
    await page.getByLabel('변경 사유', { exact: true }).fill('관리 동선 검증');
    await expect(page.getByRole('button', { name: '상품 삭제 (기록 보존)', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '관리자 참여 취소', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('admin-product-controls.png'), fullPage: true });
    await page.getByRole('button', { name: '채팅방 · 입금 상태 관리', exact: true }).click();
    await expect(page.getByRole('heading', { name: '관리자 권한 확인', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '관리자로 입장', exact: true }).click();
    await expect(page.getByRole('heading', { name: /관리 진입 경로 검증 상품/ })).toBeVisible();
    await page.getByRole('button', { name: '뒤로', exact: true }).click();
    await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '관리자 참여 취소', exact: true })).toBeEnabled();
    await expect(page.locator('.admin-order')).toContainText(orderId);
    await page.getByRole('button', { name: '일반 상품 화면 미리보기', exact: true }).click();
    await page.getByRole('button', { name: /관리 진입 경로 검증 상품/ }).click();
    await expect(page.getByRole('heading', { name: '공동구매 상세', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '참여하기', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '상품·주문 관리자 운영 관리', exact: true }).click();
    await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '공동구매 상세', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '일반 상품 화면 미리보기', exact: true }).click();
    await page.getByRole('button', { name: /관리 진입 경로 검증 상품/ }).click();
    await page.getByRole('button', { name: '관리자 앱', exact: true }).click();
    await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
    await expect(page.getByLabel('관리자 PIN', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '공동구매 상세', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('admin-direct-entry.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
