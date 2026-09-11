import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import handler from '../../api/admin-ops.js';
import { adminStore } from '../helpers/admin-store.js';
import { imageResponse } from '../helpers/product-image-store.js';

test('관리자 기록 연결 오류는 PIN 오류와 구분하고 선택·주문·사유를 보존한다', async ({ page }) => {
  const { context, data, dealId, orderId } = adminStore();
  const initialRows = JSON.stringify(data);
  const mutationRequests = [];
  let failureCode = '';
  let invalidPin = false;
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/admin-ops') {
      return route.fulfill({ json: { ok: true, deals: [], orders: [], stats: {} } });
    }
    const payload = route.request().postDataJSON();
    if (invalidPin) return route.fulfill({ status: 403, json: { ok: false, error: 'invalid_admin_pin' } });
    if (payload.action === 'cancel_order') {
      mutationRequests.push(payload);
      // Inject only the operation response to cover UI preservation; all
      // fixture reads and the final successful cancellation use real GAS.
      if (failureCode) return route.fulfill({ status: 409, json: { ok: false, error: failureCode } });
    }
    const result = context.handleAdminOperation_({ ...payload, adminAssertion: true });
    return route.fulfill({ status: result.ok ? 200 : 409, json: result });
  });
  await page.goto('/admin');
  await page.getByLabel('이름', { exact: true }).fill('관리자 오류 안내 검증');
  await page.getByLabel('연락처').fill('010-1234-5678');
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
  await page.getByRole('button', { name: '테스트 시작' }).click();
  await page.getByLabel('관리자 PIN', { exact: true }).fill('test-only-pin');
  await page.getByRole('button', { name: '관리자 확인', exact: true }).click();
  await page.locator('.admin-product').filter({ hasText: dealId }).click();
  const selected = page.locator('.admin-detail').filter({ hasText: dealId });
  const reason = '기존 기록 연결 확인';
  await page.getByLabel('변경 사유', { exact: true }).fill(reason);
  const initialOrderText = await page.locator('.admin-order').textContent();
  let confirmations = 0;
  page.on('dialog', async (dialog) => { confirmations += 1; await dialog.accept(); });
  const cases = [
    ['order_not_found', '변경할 주문의 저장 기록을 찾지 못했습니다.'],
    ['group_not_found', '이 주문에 연결된 그룹 기록을 찾지 못했습니다.'],
    ['participant_not_found', '이 주문에 연결된 참여자 기록을 찾지 못했습니다.'],
    ['order_payment_link_required', '과거 주문과 그룹 참여 기록의 연결을 확인해야 합니다.'],
  ];
  for (const [code, message] of cases) {
    failureCode = code;
    await page.getByRole('button', { name: '관리자 참여 취소', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(page.getByRole('alert')).not.toContainText('PIN');
    await expect(selected).toBeVisible();
    await expect(page.locator('.admin-order')).toHaveCount(1);
    await expect(page.locator('.admin-order')).toHaveText(initialOrderText);
    await expect(page.getByLabel('변경 사유', { exact: true })).toHaveValue(reason);
    await expect(page.getByRole('button', { name: '관리자 참여 취소', exact: true })).toBeEnabled();
    expect(JSON.stringify(data)).toBe(initialRows);
  }
  expect(mutationRequests).toHaveLength(cases.length);
  for (const request of mutationRequests) expect(request).toEqual(mutationRequests[0]);
  expect(confirmations).toBe(1);
  failureCode = '';
  await page.getByRole('button', { name: '관리자 참여 취소', exact: true }).click();
  await expect(page.locator('.admin-order')).toContainText('참여 취소');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(mutationRequests.at(-1)).toEqual(mutationRequests[0]);
  expect(context.getCustomerOrderRecord_(data, orderId).order.status).toBe('cancelled');
  invalidPin = true;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('관리자 PIN이 올바르지 않습니다.');
  await expect(selected).toBeVisible();
  await expect(page.getByLabel('변경 사유', { exact: true })).toHaveValue(reason);
});

test('관리자 PIN → 실제 API/GAS 저장 → 취소·삭제 이력과 모바일 화면', async ({ page }, testInfo) => {
  const { context, data, dealId, orderId } = adminStore();
  const initialDeal = JSON.parse(data.publicDeals.rows[1][6]);
  const localOnlyDeal = { ...initialDeal, id: 'owner-local-history-only', title: '미연결 로컬 이력 상품' };
  await page.addInitScript(({ initialDeal, localOnlyDeal }) => {
    if (!localStorage.getItem('o2o_mvp_created_deals')) {
      localStorage.setItem('o2o_mvp_created_deals', JSON.stringify([initialDeal, localOnlyDeal]));
    }
  }, { initialDeal, localOnlyDeal });
  const collectorRequests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    collectorRequests.push(body);
    const result = body.token !== 'private-test-token' ? { ok: false, error: 'forbidden' }
      : body.action === 'admin_credentials' && body.payload.operation === 'read' ? { ok: true, credential: null }
        : body.action === 'admin_credentials' && body.payload.operation === 'rate_begin' ? { ok: true, allowed: true, reserved: true }
          : body.action === 'admin_credentials' && ['rate_failure', 'rate_success'].includes(body.payload.operation) ? { ok: true, allowed: true }
        : body.action === 'admin_operation' ? context.handleAdminOperation_(body.payload)
          : { ok: false, error: 'forbidden' };
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const envKeys = ['O2O_ADMIN_PIN', 'O2O_DATA_API_ORIGIN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.O2O_ADMIN_PIN = '2468';
  process.env.O2O_DATA_API_ORIGIN = '';
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'private-test-token';
  try {
    await page.route('**/api/**', async (route) => {
      if (new URL(route.request().url()).pathname === '/api/admin-ops') {
        const response = imageResponse();
        await handler({ method: 'POST', headers: { origin: 'http://127.0.0.1:4187' }, body: route.request().postDataJSON() }, response);
        await route.fulfill({ status: response.statusCode, json: response.body });
      } else if (new URL(route.request().url()).pathname === '/api/public-deals') {
        // Keep returning a delayed, pre-delete public snapshot. The confirmed
        // administrator response must win without a full-page reload.
        await route.fulfill({ json: { ok: true, deals: [initialDeal] } });
      } else await route.fulfill({ json: { ok: true, deals: [], orders: [], stats: {} } });
    });
    await page.goto('/admin');
    await page.getByLabel('이름', { exact: true }).fill('관리자 검증');
    await page.getByLabel('연락처').fill('010-1234-5678');
    await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
    await page.getByRole('button', { name: '테스트 시작' }).click();
    await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
    await page.getByLabel('관리자 PIN').fill('wrong');
    await page.getByRole('button', { name: '관리자 확인' }).click();
    await expect(page.getByRole('alert')).toContainText('PIN이 올바르지');
    expect(collectorRequests.filter((request) => request.action === 'admin_credentials')
      .map((request) => request.payload.operation)).toEqual(['rate_begin', 'read', 'rate_failure']);
    expect(collectorRequests.filter((request) => request.action === 'admin_operation')).toHaveLength(0);
    await page.getByLabel('관리자 PIN').fill('2468');
    await page.getByRole('button', { name: '관리자 확인' }).click();
    await page.locator('.admin-product').filter({ hasText: dealId }).click();
    await expect(page.locator('.admin-order')).toContainText('입금완료');
    await expect(page.getByText('변경 사유 (필수)')).toBeVisible();
    await expect(page.getByRole('button', { name: '상품 삭제 (기록 보존)', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '관리자 참여 취소', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '관리자 참여 취소', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('변경 사유를 입력');
    expect(collectorRequests.filter((request) => request.action === 'admin_operation')).toHaveLength(2);
    await page.getByLabel('변경 사유').fill('QA 취소 검증');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '관리자 참여 취소', exact: true }).click();
    await expect(page.locator('.admin-order')).toContainText('참여 취소');
    await expect(page.locator('.admin-order')).toContainText('실제 환불 확인 필요');
    expect(context.getCustomerOrderRecord_(data, orderId).order.status).toBe('cancelled');
    expect(context.getParticipantRecord_(data, dealId, 'member-test').selectedQuantity).toBe(0);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '상품 삭제 (기록 보존)', exact: true }).click();
    await expect(page.locator('.admin-detail').filter({ hasText: dealId })).toContainText('목록에서 삭제됨');
    expect(JSON.parse(data.publicDeals.rows[1][6]).visibility).toBe('deleted');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_created_deals') || '[]')
      .map((deal) => deal.id))).toEqual([localOnlyDeal.id]);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(page.locator('.admin-detail').filter({ hasText: dealId })).toContainText('목록에서 삭제됨');
    await page.screenshot({ path: testInfo.outputPath('admin-mobile.png'), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
    expect(await page.evaluate(() => JSON.stringify(localStorage).includes('2468'))).toBe(false);
    await page.getByRole('button', { name: '일반 상품 화면 미리보기', exact: true }).click();
    await expect(page.locator('.deal-card').filter({ hasText: initialDeal.title })).toHaveCount(0);
    await expect(page.locator('.deal-card').filter({ hasText: localOnlyDeal.title })).toHaveCount(1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
