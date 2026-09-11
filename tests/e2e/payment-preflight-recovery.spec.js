import { expect, test } from '@playwright/test';
import { deferred, installPaymentPipeline } from '../helpers/payment-pipeline.js';

async function createGroup(page, pipeline) {
  await page.goto('/customer', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('이름', { exact: true }).fill('저장 응답 복구 검수');
  await page.getByLabel('연락처').fill('010-1234-5678');
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
  await page.getByRole('button', { name: '테스트 시작' }).click();
  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();
  await expect(page.locator('.payment-chip.pending')).toBeVisible();
  await expect.poll(() => pipeline.orders().length).toBe(1);
  await expect.poll(() => page.evaluate(() => Object.keys(JSON.parse(
    localStorage.getItem('o2o_mvp_checkout_attempts_v1') || '{}',
  )).length)).toBe(0);
  await expect.poll(() => page.evaluate(async () => {
    const { customerOrderSyncFingerprint } = await import('/src/customerHistory.js');
    const [order] = JSON.parse(localStorage.getItem('o2o_mvp_customer_orders') || '[]');
    const hashes = JSON.parse(localStorage.getItem('o2o_mvp_customer_order_sync_fingerprints') || '{}');
    return Boolean(order && hashes[order.id] === customerOrderSyncFingerprint(order));
  })).toBe(true);
}

async function clickPayment(page, name = '입금했어요') {
  const button = page.getByRole('button', { name, exact: true });
  await button.evaluate((element) => {
    const screen = element.closest('.group-room-screen');
    screen.scrollTop += element.getBoundingClientRect().top - screen.getBoundingClientRect().top - 180;
  });
  page.once('dialog', (dialog) => dialog.accept());
  await button.click();
}

async function restoreInterruptedAttempt(page) {
  return page.evaluate(() => {
    const [order] = JSON.parse(localStorage.getItem('o2o_mvp_customer_orders') || '[]');
    const attempt = {
      actorId: order.visitorId, groupId: order.groupId, dealId: order.dealId,
      orderId: order.id, reservationMutationId: order.reservationMutationId,
      reservationAction: order.reservationAction, reservationQuantity: order.reservationQuantity,
      stage: 'publishing_order', fingerprint: 'interrupted-committed-checkout',
      createdAt: order.createdAt, updatedAt: order.createdAt, orderPayload: order,
    };
    localStorage.setItem('o2o_mvp_checkout_attempts_v1', JSON.stringify({ interrupted: attempt }));
    return attempt;
  });
}

test('실제 API·GAS: 서버에 저장된 주문과 남은 checkout을 대조한 뒤 입금하며 예약을 재전송하지 않는다', async ({ page }) => {
  const pipeline = await installPaymentPipeline(page);
  try {
    await createGroup(page, pipeline);
    const attempt = await restoreInterruptedAttempt(page);
    const start = pipeline.apiRequests.length;
    await clickPayment(page);
    await expect(page.locator('.payment-chip.requested')).toBeVisible({ timeout: 5000 });
    const requests = pipeline.apiRequests.slice(start);
    expect(requests.filter(({ body }) => body.action === 'list' && body.groupId === attempt.groupId)).toHaveLength(1);
    expect(requests.filter(({ body }) => ['create', 'join', 'reserve_quantity'].includes(body.action))).toHaveLength(0);
    const paymentIndex = requests.findIndex(({ body }) => body.action === 'transition_payment');
    expect(paymentIndex).toBeGreaterThanOrEqual(0);
    expect(requests.slice(0, paymentIndex).filter(({ body }) => body.action === 'publish')).toHaveLength(0);
    expect(requests.filter(({ body }) => body.action === 'transition_payment')).toHaveLength(1);
    expect(pipeline.payments()).toHaveLength(1);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_checkout_attempts_v1') || '{}'))).toEqual({});
    expect(pipeline.failures).toEqual([]);
  } finally {
    await pipeline.close();
  }
});

test('실제 API·GAS: 같은 주문 ID여도 중단된 예약 증명이 다르면 기록을 보존하고 입금을 차단한다', async ({ page }) => {
  const pipeline = await installPaymentPipeline(page);
  try {
    await createGroup(page, pipeline);
    await restoreInterruptedAttempt(page);
    const stored = await page.evaluate(() => {
      const key = 'o2o_mvp_checkout_attempts_v1';
      const attempts = JSON.parse(localStorage.getItem(key));
      attempts.interrupted.reservationMutationId = 'unmatched-reservation-proof';
      localStorage.setItem(key, JSON.stringify(attempts));
      return attempts;
    });
    const orders = structuredClone(pipeline.orders());
    const start = pipeline.apiRequests.length;
    await clickPayment(page);
    await expect(page.locator('.payment-feedback').getByRole('alert')).toBeVisible();
    await expect(page.locator('.payment-chip.pending')).toBeVisible();
    expect(pipeline.apiRequests.slice(start).filter(({ body }) => body.action === 'transition_payment')).toHaveLength(0);
    expect(pipeline.orders()).toEqual(orders);
    expect(pipeline.payments()).toHaveLength(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_checkout_attempts_v1')))).toEqual(stored);
    expect(pipeline.failures).toEqual([]);
  } finally {
    await pipeline.close();
  }
});

test('실제 API·GAS: 추가 수량 예약이 진행 중이면 기존 주문의 확인 지문이 있어도 입금을 보내지 않는다', async ({ page }) => {
  const pipeline = await installPaymentPipeline(page);
  try {
    await createGroup(page, pipeline);
    const attemptId = await page.evaluate(async () => {
      const { beginCheckoutAttempt, updateCheckoutAttempt } = await import('/src/checkoutAttempt.js');
      const { reserveGroupQuantity } = await import('/src/groupApi.js');
      const [order] = JSON.parse(localStorage.getItem('o2o_mvp_customer_orders'));
      const attempt = beginCheckoutAttempt({
        actorId: order.visitorId, groupId: order.groupId, dealId: order.dealId,
        type: 'group', selectedCount: 1, total: order.total,
        reservationMutationId: 'additional-active-reservation', reservationAction: 'reserve_quantity',
      });
      updateCheckoutAttempt(attempt.orderId, { stage: 'reserving' });
      await reserveGroupQuantity(order.groupId, 1, order.visitorId, attempt.reservationMutationId, { allowLocalFallback: false });
      updateCheckoutAttempt(attempt.orderId, { stage: 'reserved' });
      return attempt.orderId;
    });
    const [order] = pipeline.orders();
    const participant = pipeline.context.getParticipantRecord_(pipeline.data, order.groupId, order.visitorId);
    expect(participant.selectedQuantity).toBe(2);
    const start = pipeline.apiRequests.length;
    await clickPayment(page);
    await expect(page.locator('.payment-feedback').getByRole('alert')).toBeVisible();
    expect(pipeline.apiRequests.slice(start).filter(({ body }) => body.action === 'transition_payment')).toHaveLength(0);
    expect(pipeline.orders()).toHaveLength(1);
    expect(pipeline.payments()).toHaveLength(0);
    expect(pipeline.context.getParticipantRecord_(pipeline.data, order.groupId, order.visitorId).selectedQuantity).toBe(2);
    expect(await page.evaluate((id) => Object.values(JSON.parse(localStorage.getItem('o2o_mvp_checkout_attempts_v1')))
      .some((attempt) => attempt.orderId === id && attempt.stage === 'reserved'), attemptId)).toBe(true);
    expect(pipeline.failures).toEqual([]);
  } finally {
    await pipeline.close();
  }
});

test('실제 API·GAS: 입금 완료 뒤 늦게 도착한 이전 조회가 요청 상태와 버튼을 되돌리지 않는다', async ({ page }) => {
  const releaseSnapshot = deferred();
  let holdNextSnapshot = false;
  let heldSnapshot = null;
  const pipeline = await installPaymentPipeline(page, {
    async afterApi(entry) {
      if (holdNextSnapshot && entry.path === '/api/group-ops' && entry.body.action === 'snapshot') {
        holdNextSnapshot = false;
        heldSnapshot = entry;
        await releaseSnapshot.promise;
      }
    },
  });
  try {
    await createGroup(page, pipeline);
    const [order] = pipeline.orders();
    holdNextSnapshot = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => heldSnapshot).not.toBeNull();
    expect(heldSnapshot.result.snapshot.participants.find((item) => item.actorId === order.visitorId))
      .toMatchObject({ paymentStatus: 'pending', version: 1 });
    await clickPayment(page);
    await expect(page.locator('.payment-chip.requested')).toBeVisible();
    await expect(page.getByRole('button', { name: '입금 확인', exact: true })).toBeEnabled();
    const oldResponse = page.waitForResponse(async (response) => {
      if (!response.url().endsWith('/api/group-ops') || response.request().postDataJSON()?.action !== 'snapshot') return false;
      const result = await response.json();
      return result.snapshot?.participants?.some((item) => item.actorId === order.visitorId && item.version === 1);
    });
    releaseSnapshot.resolve();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.payment-chip.requested')).toHaveText('입금확인요청');
    await expect(page.getByRole('button', { name: '입금했어요', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '입금 확인', exact: true })).toBeEnabled();
    expect(pipeline.apiRequests.filter(({ body }) => body.action === 'transition_payment')).toHaveLength(1);
    expect(pipeline.orders()[0]).toMatchObject({ paymentStatus: 'requested', paymentVersion: 2 });
    expect(pipeline.payments()).toHaveLength(1);
    expect(pipeline.failures).toEqual([]);
  } finally {
    releaseSnapshot.resolve();
    await pipeline.close();
  }
});

test('실제 API·GAS: 주문 확인을 기다리는 동안 방을 떠나면 늦은 응답으로 입금 요청하지 않는다', async ({ page }) => {
  const releaseHistory = deferred();
  let holdGroupHistory = false;
  let heldHistory = null;
  const pipeline = await installPaymentPipeline(page, {
    async afterApi(entry) {
      if (holdGroupHistory && entry.path === '/api/customer-orders' && entry.body.action === 'list' && entry.body.groupId) {
        holdGroupHistory = false;
        heldHistory = entry;
        await releaseHistory.promise;
      }
    },
  });
  try {
    await createGroup(page, pipeline);
    await restoreInterruptedAttempt(page);
    holdGroupHistory = true;
    await clickPayment(page);
    await expect.poll(() => heldHistory).not.toBeNull();
    await expect(page.locator('.payment-feedback')).toContainText('주문 저장을 확인하고 있습니다');
    await page.getByRole('button', { name: '뒤로', exact: true }).click();
    await expect(page.locator('.group-room-screen')).toHaveCount(0);
    const historyResponse = page.waitForResponse((response) => response.url().endsWith('/api/customer-orders')
      && response.request().postDataJSON()?.groupId === heldHistory.body.groupId);
    releaseHistory.resolve();
    await (await historyResponse).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.deal-management')).toBeVisible();
    await page.getByRole('button', { name: '그룹 채팅', exact: true }).click();
    await expect(page.locator('.payment-chip.pending')).toHaveText('입금대기');
    expect(pipeline.apiRequests.filter(({ body }) => body.action === 'transition_payment')).toHaveLength(0);
    expect(pipeline.orders()[0]).toMatchObject({ paymentStatus: 'pending', paymentVersion: 1 });
    expect(pipeline.payments()).toHaveLength(0);
    expect(pipeline.failures).toEqual([]);
  } finally {
    releaseHistory.resolve();
    await pipeline.close();
  }
});
