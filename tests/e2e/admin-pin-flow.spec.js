import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import pinHandler from '../../api/admin-pin.js';
import adminHandler from '../../api/admin-ops.js';
import { adminStore } from '../helpers/admin-store.js';
import { imageResponse } from '../helpers/product-image-store.js';

test('관리자 PIN 변경 전체 흐름: 실제 API·GAS 저장 후 이전 PIN 거절과 새 PIN 재로그인', async ({ page }) => {
  const bootstrapPin = '7148609253';
  const replacementPin = '6802947135';
  const { context, dealId, data } = adminStore();
  const originalOrders = JSON.stringify(data.customerOrders.rows);
  const properties = new Map();
  context.PropertiesService = { getScriptProperties: () => ({
    getProperty: (key) => properties.has(key) ? properties.get(key) : null,
    setProperty: (key, value) => properties.set(key, value),
  }) };
  const collectorRequests = [];
  const apiResponses = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const contents = Buffer.concat(chunks).toString();
    collectorRequests.push(JSON.parse(contents));
    const result = context.doPost({ postData: { contents } });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const envKeys = ['O2O_ADMIN_PIN', 'O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { O2O_ADMIN_PIN: bootstrapPin, O2O_DATA_API_ORIGIN: '', O2O_DATA_API_TOKEN: '',
    GOOGLE_SHEETS_COLLECTOR_URL: `http://127.0.0.1:${server.address().port}`,
    GOOGLE_SHEETS_COLLECTOR_TOKEN: 'REPLACE_WITH_RANDOM_TOKEN' });
  try {
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const handler = path === '/api/admin-pin' ? pinHandler : path === '/api/admin-ops' ? adminHandler : null;
      if (!handler) return route.fulfill({ json: { ok: true, deals: [], orders: [], stats: {} } });
      const response = imageResponse();
      await handler({ method: 'POST', headers: { origin: 'http://127.0.0.1:4187' }, body: route.request().postDataJSON() }, response);
      apiResponses.push({ path, status: response.statusCode, body: response.body });
      await route.fulfill({ status: response.statusCode, headers: response.headers, json: response.body });
    });
    await page.goto('/admin');
    await page.getByLabel('이름', { exact: true }).fill('PIN 전체 흐름 검증');
    await page.getByLabel('연락처').fill('010-1234-5678');
    await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
    await page.getByRole('button', { name: '테스트 시작' }).click();
    await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
    await page.getByLabel('관리자 PIN', { exact: true }).fill(bootstrapPin);
    await page.getByRole('button', { name: '관리자 확인', exact: true }).click();
    await expect(page.locator('.admin-product').filter({ hasText: dealId })).toBeVisible();
    await page.locator('summary').filter({ hasText: '관리자 PIN 변경' }).click();
    await page.getByLabel('현재 PIN', { exact: true }).fill(bootstrapPin);
    await page.getByLabel('새 PIN', { exact: true }).fill(replacementPin);
    await page.getByLabel('새 PIN 확인', { exact: true }).fill(replacementPin);
    await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('관리자 PIN을 변경했습니다');
    expect(apiResponses.find((result) => result.path === '/api/admin-pin')).toMatchObject({ status: 200, body: { ok: true, version: 1 } });
    expect(properties.has('O2O_ADMIN_CREDENTIAL_V1')).toBe(true);
    expect(properties.has('O2O_ADMIN_AUTH_RATE_LIMIT_V1')).toBe(true);
    const credential = JSON.parse(properties.get('O2O_ADMIN_CREDENTIAL_V1'));
    expect(credential).toMatchObject({ algorithm: 'scrypt-v1', version: 1 });
    expect(credential.salt).toMatch(/^[a-f0-9]{32}$/);
    expect(credential.hash).toMatch(/^[a-f0-9]{128}$/);
    await expect(page.getByLabel('관리자 PIN', { exact: true })).toHaveValue(replacementPin);
    const operationCount = collectorRequests.filter((request) => request.action === 'admin_operation').length;
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect.poll(() => collectorRequests.filter((request) => request.action === 'admin_operation').length).toBe(operationCount + 1);
    await expect(page.getByRole('button', { name: '새로고침', exact: true })).toBeEnabled();
    expect(collectorRequests.filter((request) => request.action === 'admin_operation').at(-1).payload.adminCredentialVersion).toBe(1);

    await page.reload();
    await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
    await expect(page.getByLabel('관리자 PIN', { exact: true })).toHaveValue('');
    await expect(page.getByRole('form', { name: '관리자 PIN 변경' })).toHaveCount(0);
    const beforeRejectedLogin = collectorRequests.filter((request) => request.action === 'admin_operation').length;
    await page.getByLabel('관리자 PIN', { exact: true }).fill(bootstrapPin);
    await page.getByRole('button', { name: '관리자 확인', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('PIN이 올바르지');
    expect(apiResponses.at(-1)).toMatchObject({ status: 403, body: { ok: false, error: 'invalid_admin_pin' } });
    expect(collectorRequests.filter((request) => request.action === 'admin_operation')).toHaveLength(beforeRejectedLogin);
    await expect(page.getByRole('form', { name: '관리자 PIN 변경' })).toHaveCount(0);
    await page.getByLabel('관리자 PIN', { exact: true }).fill(replacementPin);
    await page.getByRole('button', { name: '관리자 확인', exact: true }).click();
    await expect(page.locator('.admin-product').filter({ hasText: dealId })).toBeVisible();
    await expect(page.locator('summary').filter({ hasText: '관리자 PIN 변경' })).toBeVisible();
    expect(apiResponses.at(-1)).toMatchObject({ status: 200, body: { ok: true } });
    expect(JSON.stringify(data.customerOrders.rows)).toBe(originalOrders);
    const storedOrReturned = JSON.stringify({ properties: [...properties.values()], collectorRequests, apiResponses });
    const browserStorage = await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage }));
    for (const secret of [bootstrapPin, replacementPin]) {
      expect(storedOrReturned).not.toContain(secret);
      expect(browserStorage).not.toContain(secret);
    }
    expect(JSON.stringify(apiResponses)).not.toContain(credential.hash);
    expect(JSON.stringify(apiResponses)).not.toContain(credential.salt);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
