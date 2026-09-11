import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    let body = {};
    try {
      body = request.postDataJSON() || {};
    } catch {
      body = {};
    }
    const path = new URL(request.url()).pathname;
    let payload = { ok: true };
    if (path.endsWith('/public-deals')) payload = { ok: true, deals: [] };
    if (path.endsWith('/customer-orders')) payload = { ok: true, orders: [] };
    if (path.endsWith('/stats')) payload = { ok: true, events: [], surveys: [], orders: [] };
    if (path.endsWith('/group-ops') && body.action === 'snapshot') {
      payload = { ok: false, error: 'group_not_found' };
    }
    await route.fulfill({
      status: payload.ok === false ? 404 : 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
});

test('모바일 브라우저 뒤로·앞으로와 화면 뒤로가 상품 목록/상세를 일관되게 이동한다', async ({ page }) => {
  await page.goto('/customer');
  await page.getByLabel('이름').fill('모바일 뒤로 검수');
  await page.getByLabel('연락처').fill('010-1234-5678');
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
  await page.getByRole('button', { name: '테스트 시작' }).click();
  await expect(page.getByPlaceholder('매장 또는 상품 검색')).toBeVisible();

  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await expect(page.getByRole('heading', { name: '공동구매 상세' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.getByPlaceholder('매장 또는 상품 검색')).toBeVisible();

  await page.goForward();
  await expect(page.getByRole('heading', { name: '공동구매 상세' })).toBeVisible();
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await expect(page.getByPlaceholder('매장 또는 상품 검색')).toBeVisible();
});
