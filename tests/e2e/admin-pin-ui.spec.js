import { expect, test } from '@playwright/test';

const initialPin = '4719582063';
const replacementPin = '6028149753';

async function openConsole(page, onRequest = async () => ({ ok: true })) {
  const requests = [];
  let activePin = initialPin;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    if (path === '/api/admin-pin') {
      requests.push(body);
      const result = await onRequest(body, requests.length);
      if (result.ok) activePin = body.newPin;
      await route.fulfill({ status: result.ok ? 200 : (result.status || 400), json: result });
    } else if (path === '/api/admin-ops') {
      await route.fulfill({ status: body.adminPin === activePin ? 200 : 401,
        json: body.adminPin === activePin ? { ok: true, deals: [] } : { ok: false, error: 'invalid_admin_pin' } });
    } else await route.fulfill({ json: { ok: true, deals: [], orders: [], stats: {} } });
  });
  await page.goto('/admin');
  await page.getByLabel('이름', { exact: true }).fill('PIN 화면 검증');
  await page.getByLabel('연락처').fill('010-1234-5678');
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
  await page.getByRole('button', { name: '테스트 시작' }).click();
  await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: '관리자 PIN 변경' })).toHaveCount(0);
  await page.getByLabel('관리자 PIN', { exact: true }).fill(initialPin);
  await page.getByRole('button', { name: '관리자 확인', exact: true }).click();
  await page.locator('summary').filter({ hasText: '관리자 PIN 변경' }).click();
  await expect(page.getByRole('form', { name: '관리자 PIN 변경' })).toBeVisible();
  return requests;
}

async function fillChange(page, currentPin, newPin, confirmPin = newPin) {
  await page.getByLabel('현재 PIN', { exact: true }).fill(currentPin);
  await page.getByLabel('새 PIN', { exact: true }).fill(newPin);
  await page.getByLabel('새 PIN 확인', { exact: true }).fill(confirmPin);
}

test('관리자 PIN 변경: 입력 검증 → 비밀번호 전송 → 성공 후 새 PIN과 비밀정보 정리', async ({ page }, testInfo) => {
  const requests = await openConsole(page);
  await fillChange(page, initialPin, '1234567');
  await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('숫자 8~12자리');
  await fillChange(page, initialPin, replacementPin, '11112222');
  await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('일치하지');
  await fillChange(page, initialPin, initialPin);
  await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('다른 새 PIN');
  expect(requests).toHaveLength(0);

  await fillChange(page, initialPin, replacementPin);
  for (const label of ['현재 PIN', '새 PIN', '새 PIN 확인']) {
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute('type', 'password');
  }
  await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('관리자 PIN을 변경했습니다');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ action: 'change', adminPin: initialPin, newPin: replacementPin, confirmPin: replacementPin });
  expect(requests[0].actorId).toMatch(/_admin$/);
  expect(requests[0].clientMutationId).toMatch(/^admin_pin/);
  for (const label of ['현재 PIN', '새 PIN', '새 PIN 확인']) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
  }
  await expect(page.getByLabel('관리자 PIN', { exact: true })).toHaveValue(replacementPin);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('form', { name: '관리자 PIN 변경' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const storage = await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage }));
  expect(storage).not.toContain(initialPin);
  expect(storage).not.toContain(replacementPin);
  const visibleText = await page.locator('body').innerText();
  expect(visibleText).not.toContain(initialPin);
  expect(visibleText).not.toContain(replacementPin);
  await page.screenshot({ path: testInfo.outputPath('admin-pin-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await page.getByLabel('관리자 PIN', { exact: true }).fill('different');
  await expect(page.getByRole('form', { name: '관리자 PIN 변경' })).toHaveCount(0);
});

test('관리자 PIN 변경: 실패 후 기존 인증 유지, 동일 입력 재시도 ID 유지와 중복 제출 차단', async ({ page }) => {
  let finishFirst;
  const firstResponse = new Promise((resolve) => { finishFirst = resolve; });
  const requests = await openConsole(page, async (_body, count) => count === 1 ? firstResponse : { ok: true });
  await fillChange(page, initialPin, replacementPin);
  await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
  await expect(page.getByRole('button', { name: 'PIN 변경', exact: true })).toBeDisabled();
  await expect(page.getByLabel('현재 PIN', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('관리자 PIN', { exact: true })).toHaveValue(initialPin);
  finishFirst({ ok: false, error: 'upstream_private_secret_must_not_render' });
  await expect(page.getByRole('alert')).toContainText('요청을 완료하지 못했습니다');
  await expect(page.getByRole('alert')).not.toContainText('upstream_private_secret');
  await expect(page.getByLabel('관리자 PIN', { exact: true })).toHaveValue(initialPin);
  await expect(page.getByLabel('새 PIN', { exact: true })).toHaveValue(replacementPin);
  await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('관리자 PIN을 변경했습니다');
  expect(requests).toHaveLength(2);
  expect(requests[1].clientMutationId).toBe(requests[0].clientMutationId);
});

test('관리자 PIN 변경: 현재 PIN 오류 표시 및 변경된 입력은 새 재시도 ID 사용', async ({ page }) => {
  const requests = await openConsole(page, async (_body, count) => count === 1 ? { ok: false, error: 'invalid_admin_pin' } : { ok: true });
  await fillChange(page, 'wrong-pin', replacementPin);
  await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('PIN이 올바르지');
  await expect(page.getByLabel('관리자 PIN', { exact: true })).toHaveValue(initialPin);
  await page.getByLabel('현재 PIN', { exact: true }).fill(initialPin);
  await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('관리자 PIN을 변경했습니다');
  expect(requests).toHaveLength(2);
  expect(requests[1].clientMutationId).not.toBe(requests[0].clientMutationId);
});

test('관리자 PIN 변경: 시도 제한은 사용자 안내 문구로 표시하고 PIN 입력을 보존한다', async ({ page }) => {
  await openConsole(page, async () => ({ ok: false, error: 'admin_rate_limited', status: 429 }));
  await fillChange(page, initialPin, replacementPin);
  await page.getByRole('button', { name: 'PIN 변경', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('PIN 입력 시도가 너무 많습니다');
  await expect(page.getByRole('alert')).toContainText('잠시 후 다시 시도');
  await expect(page.getByLabel('현재 PIN', { exact: true })).toHaveValue(initialPin);
  await expect(page.getByLabel('새 PIN', { exact: true })).toHaveValue(replacementPin);
});
