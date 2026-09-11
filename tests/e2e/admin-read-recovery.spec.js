import { expect, test } from '@playwright/test';

const deal = { id: 'owner-admin-read-recovery', title: '관리자 조회 복구 상품', source: 'owner', publishVersion: 1 };
const order = { id: 'order-1789000000000', customerName: '조회 확인 참여자', paymentStatus: 'pending', selectedCount: 1 };

test('관리자 조회는 인증 뒤 일시 장애만 한 번 재시도하고 인증 실패·변경 요청은 반복하지 않는다', async ({ page }) => {
  let results = [];
  let requests = [];
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/admin-ops') {
      requests.push(route.request().postDataJSON());
      const next = results.shift();
      return route.fulfill(next || { status: 500, json: { ok: false, error: 'unexpected_retry' } });
    }
    return route.fulfill({ json: { ok: true, deals: [], orders: [], stats: {} } });
  });
  await page.goto('/admin');
  const invoke = (fields) => page.evaluate(async (payload) => {
    const { requestAdminOperation } = await import('/src/AdminConsole.jsx');
    try { return { result: await requestAdminOperation('test-only-pin', payload) }; }
    catch (error) { return { error: error.message }; }
  }, fields);

  for (const [action, code, status] of [['list', 'collector_busy', 503], ['orders', 'upstream_timeout', 504]]) {
    requests = [];
    results = [{ status, json: { ok: false, error: code } }, { json: { ok: true, deals: [deal], orders: [order] } }];
    expect((await invoke({ action, dealId: deal.id })).result.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
  }
  requests = [];
  results = Array.from({ length: 2 }, () => ({ status: 503, json: { ok: false, error: 'collector_busy' } }));
  expect(await invoke({ action: 'orders', dealId: deal.id })).toEqual({ error: 'collector_busy' });
  expect(requests).toHaveLength(2);

  for (const [action, code, status] of [
    ['list', 'invalid_admin_pin', 403], ['list', 'admin_rate_limited', 429],
    ['list', 'admin_credential_store_unavailable', 503], ['cancel_order', 'collector_busy', 503],
    ['delete', 'upstream_timeout', 504], ['image', 'upstream_invalid_response', 502],
  ]) {
    requests = [];
    results = [{ status, json: { ok: false, error: code } }];
    expect(await invoke({ action, dealId: deal.id })).toEqual({ error: code });
    expect(requests).toHaveLength(1);
  }
  requests = [];
  results = [{ status: 503, contentType: 'text/html', body: '<h1>Temporarily unavailable</h1>' }];
  expect(await invoke({ action: 'list' })).toEqual({ error: 'upstream_invalid_response' });
  expect(requests).toHaveLength(1);
});

test('관리자 주문 재조회가 지연되거나 실패해도 기존 내역을 0건으로 지우지 않는다', async ({ page }) => {
  let listRequests = 0;
  let orderRequests = 0;
  let releaseFirst;
  let releaseRetry;
  const firstOrderResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const retryOrderResponse = new Promise((resolve) => { releaseRetry = resolve; });
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/admin-ops') {
      return route.fulfill({ json: { ok: true, deals: [], orders: [], stats: {} } });
    }
    const body = route.request().postDataJSON();
    if (body.action === 'list') {
      listRequests += 1;
      if (listRequests === 1) return route.fulfill({ status: 503, json: { ok: false, error: 'collector_busy' } });
      return route.fulfill({ json: { ok: true, deals: [deal] } });
    }
    orderRequests += 1;
    if (orderRequests === 1) {
      await firstOrderResponse;
      return route.fulfill({ json: { ok: true, orders: [order] } });
    }
    if (orderRequests === 3) await retryOrderResponse;
    if (orderRequests <= 3) return route.fulfill({ status: 503, json: { ok: false, error: 'collector_busy' } });
    return route.fulfill({ json: { ok: true, orders: [] } });
  });
  await page.goto('/admin');
  await page.getByLabel('이름', { exact: true }).fill('관리자 조회 검증');
  await page.getByLabel('연락처').fill('010-1234-5678');
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
  await page.getByRole('button', { name: '테스트 시작' }).click();
  await page.getByLabel('관리자 PIN', { exact: true }).fill('test-only-pin');
  await page.getByRole('button', { name: '관리자 확인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '상품·주문 관리', exact: true })).toBeVisible();
  expect(listRequests).toBe(2);
  const product = page.locator('.admin-product').filter({ hasText: deal.id });
  await product.click();
  await expect(page.getByText('주문 내역을 불러오는 중입니다.', { exact: true })).toBeVisible();
  await expect(page.getByText('저장된 주문이 없습니다.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '주문 · 참여 내역', exact: true })).toBeVisible();
  releaseFirst();
  await expect(page.locator('.admin-order')).toContainText(order.customerName);
  await expect(page.getByRole('button', { name: '관리자 참여 취소', exact: true })).toBeEnabled();

  await product.click();
  await expect(page.getByText('주문 내역을 불러오는 중입니다.', { exact: true })).toBeVisible();
  await expect(page.locator('.admin-order')).toContainText(order.customerName);
  await expect(page.getByText('저장된 주문이 없습니다.', { exact: true })).toHaveCount(0);
  await expect.poll(() => orderRequests).toBe(3);
  releaseRetry();
  await expect(page.getByRole('alert')).toContainText('서버에 요청이 몰려');
  await expect(page.getByText(/마지막으로 확인한 내역을 유지합니다/)).toBeVisible();
  await expect(page.locator('.admin-order')).toContainText(order.customerName);
  await expect(page.getByRole('button', { name: '관리자 참여 취소', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByText('저장된 주문이 없습니다.', { exact: true })).toBeVisible();
  await expect(page.locator('.admin-order')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
