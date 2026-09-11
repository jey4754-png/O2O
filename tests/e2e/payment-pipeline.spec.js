import { expect, test } from '@playwright/test';
import { deferred, installPaymentPipeline } from '../helpers/payment-pipeline.js';

async function createSelfHostedGroup(page) {
  await page.goto('/customer');
  await page.getByLabel('이름', { exact: true }).fill('호스트 본인 입금 검수');
  await page.getByLabel('연락처').fill('010-1234-5678');
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
  await page.getByRole('button', { name: '테스트 시작' }).click();
  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();
  await expect(page.locator('.group-room-screen')).toBeVisible();
  await expect(page.locator('.payment-chip.pending')).toHaveText('입금대기');
}

async function clickPayment(page, name) {
  const button = page.getByRole('button', { name, exact: true });
  await button.evaluate((element) => {
    const screen = element.closest('.group-room-screen');
    screen.scrollTop += element.getBoundingClientRect().top - screen.getBoundingClientRect().top - 180;
  });
  page.once('dialog', (dialog) => dialog.accept());
  await button.click();
}

async function openMyOrders(page) {
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await expect(page.locator('.deal-management')).toBeVisible();
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await page.getByRole('button', { name: '내 주문', exact: true }).click();
}

function paymentRequests(pipeline) {
  return pipeline.apiRequests.filter(({ path, body }) => path === '/api/group-ops' && body.action === 'transition_payment');
}

async function waitForOrderAcknowledgement(page, pipeline) {
  await expect.poll(() => pipeline.orders().length).toBe(1);
  await expect.poll(() => page.evaluate(async () => {
    const { customerOrderSyncFingerprint } = await import('/src/customerHistory.js');
    const orders = JSON.parse(localStorage.getItem('o2o_mvp_customer_orders') || '[]');
    const acknowledged = JSON.parse(localStorage.getItem('o2o_mvp_customer_order_sync_fingerprints') || '{}');
    return orders.length === 1 && acknowledged[orders[0].id] === customerOrderSyncFingerprint(orders[0]);
  })).toBe(true);
}

function assertCentralPayment(pipeline, status, version) {
  expect(pipeline.orders()).toHaveLength(1);
  const [order] = pipeline.orders();
  expect(order).toMatchObject({ paymentStatus: status, participantActorId: order.visitorId });
  const participant = pipeline.context.getParticipantRecord_(pipeline.data, order.groupId, order.visitorId);
  expect(participant).toMatchObject({ role: 'host', paymentStatus: status, counted: true });
  expect(order.paymentVersion).toBe(version);
  expect(participant.version).toBe(version);
  expect(pipeline.failures).toEqual([]);
}

test('실제 API·GAS: 호스트 본인 입금 요청·취소·재요청·확인이 내 주문과 재접속에 보존된다', async ({ page }) => {
  const pipeline = await installPaymentPipeline(page);
  try {
    await createSelfHostedGroup(page);
    await expect.poll(() => pipeline.orders().length).toBe(1);
    const startingVersion = pipeline.context.getParticipantRecord_(pipeline.data,
      pipeline.orders()[0].groupId, pipeline.orders()[0].visitorId).version;
    let version = startingVersion;
    for (const [button, status] of [
      ['입금했어요', 'requested'], ['요청 취소', 'pending'],
      ['입금했어요', 'requested'], ['입금 확인', 'confirmed'],
    ]) {
      await clickPayment(page, button);
      await expect(page.locator(`.payment-chip.${status}`)).toBeVisible();
      await expect(page.locator('.room-notice')).toContainText('채팅과 내 주문에 반영되었습니다');
      assertCentralPayment(pipeline, status, ++version);
    }
    expect(paymentRequests(pipeline).map(({ body }) => body.toStatus)).toEqual([
      'requested', 'pending', 'requested', 'confirmed',
    ]);
    expect(pipeline.payments().map((row) => row[5])).toEqual(['requested', 'pending', 'requested', 'confirmed']);
    expect(pipeline.collectorRequests.some(({ payload }) => payload.action === 'publish_order')).toBe(true);
    expect(pipeline.collectorRequests.filter(({ payload }) => payload.action === 'group_transition_payment')).toHaveLength(4);
    await openMyOrders(page);
    await expect(page.locator('.customer-payment-state.confirmed')).toContainText('입금완료');
    await page.reload();
    await page.getByRole('button', { name: '내 주문', exact: true }).click();
    await expect(page.locator('.customer-payment-state.confirmed')).toContainText('입금완료');
    await page.getByRole('button', { name: '상세보기', exact: true }).click();
    await page.getByRole('button', { name: '그룹 채팅', exact: true }).click();
    await expect(page.locator('.payment-chip.confirmed')).toHaveText('입금완료');
    assertCentralPayment(pipeline, 'confirmed', version);
    expect(pipeline.payments()).toHaveLength(4);
  } finally {
    await pipeline.close();
  }
});

test('실제 API·GAS: 전체 이력 504·늦은 이전 상태·저장 응답 유실에도 확인된 호스트 주문은 한 번만 입금 요청된다', async ({ page }) => {
  const heldRead = deferred();
  const releaseRead = deferred();
  const paymentCommitted = deferred();
  const releasePayment = deferred();
  let delayRead = false;
  let loseResponse = true;
  let failFullHistory = false;
  const pipeline = await installPaymentPipeline(page, {
    async afterApi(entry) {
      if (delayRead && entry.path === '/api/customer-orders' && entry.body.action === 'list' && !entry.body.groupId) {
        delayRead = false;
        heldRead.resolve();
        await releaseRead.promise;
        return undefined;
      }
      if (failFullHistory && entry.path === '/api/customer-orders' && entry.body.action === 'list' && !entry.body.groupId) {
        return 'timeout-response';
      }
      if (loseResponse && entry.path === '/api/group-ops' && entry.body.action === 'transition_payment'
        && entry.result?.ok) {
        loseResponse = false;
        paymentCommitted.resolve();
        await releasePayment.promise;
        return 'lose-response';
      }
      return undefined;
    },
  });
  try {
    await createSelfHostedGroup(page);
    await waitForOrderAcknowledgement(page, pipeline);
    const initialVersion = pipeline.context.getParticipantRecord_(pipeline.data,
      pipeline.orders()[0].groupId, pipeline.orders()[0].visitorId).version;
    delayRead = true;
    failFullHistory = true;
    await page.evaluate(() => window.dispatchEvent(new Event('o2o-customer-orders-updated')));
    await heldRead.promise;
    const fullHistoryRequest = pipeline.apiRequests.find(({ path, body }) => (
      path === '/api/customer-orders' && body.action === 'list' && !body.groupId
    )).body;
    expect(await page.evaluate(async (body) => {
      const response = await fetch('/api/customer-orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return response.status;
    }, fullHistoryRequest)).toBe(504);
    const requestStart = pipeline.apiRequests.length;
    await clickPayment(page, '입금했어요');
    await paymentCommitted.promise;
    await expect(page.getByRole('button', { name: '처리 중…', exact: true }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: '처리 중…', exact: true }).first()).toHaveAttribute('aria-busy', 'true');
    expect(paymentRequests(pipeline)).toHaveLength(1);
    expect(pipeline.payments()).toHaveLength(1);
    releasePayment.resolve();
    await expect(page.locator('.payment-chip.requested')).toBeVisible();
    releaseRead.resolve();
    await expect.poll(() => paymentRequests(pipeline).length).toBe(2);
    const requests = paymentRequests(pipeline);
    expect(requests[0].body).toEqual(requests[1].body);
    expect(requests[0].result.duplicate).not.toBe(true);
    expect(requests[1].result.duplicate).toBe(true);
    expect(pipeline.apiRequests.slice(requestStart).filter(({ path, body }) => (
      path === '/api/customer-orders' && body.action === 'list' && body.groupId
    ))).toEqual([]);
    await expect.poll(() => pipeline.apiRequests.some((entry) => entry.deliveryStatus === 504)).toBe(true);
    assertCentralPayment(pipeline, 'requested', initialVersion + 1);
    expect(pipeline.payments()).toHaveLength(1);
    failFullHistory = false;
    await openMyOrders(page);
    await expect(page.locator('.customer-payment-state.requested')).toContainText('입금확인요청 전송 완료');
    await page.reload();
    await page.getByRole('button', { name: '내 주문', exact: true }).click();
    await expect(page.locator('.customer-payment-state.requested')).toContainText('입금확인요청 전송 완료');
    assertCentralPayment(pipeline, 'requested', initialVersion + 1);
    expect(pipeline.payments()).toHaveLength(1);
  } finally {
    releaseRead.resolve();
    releasePayment.resolve();
    await pipeline.close();
  }
});

test('실제 API·GAS: 동기화 확인이 없는 호스트 주문은 해당 그룹을 조회하고 백그라운드 재전송도 최신 입금 상태를 보존한다', async ({ page }) => {
  const releaseReads = deferred();
  let holdFullHistory = false;
  const pipeline = await installPaymentPipeline(page, {
    async afterApi(entry) {
      if (holdFullHistory && entry.path === '/api/customer-orders' && entry.body.action === 'list' && !entry.body.groupId) {
        await releaseReads.promise;
      }
    },
  });
  try {
    await createSelfHostedGroup(page);
    await waitForOrderAcknowledgement(page, pipeline);
    const [order] = pipeline.orders();
    holdFullHistory = true;
    await page.evaluate(() => localStorage.removeItem('o2o_mvp_customer_order_sync_fingerprints'));
    const requestStart = pipeline.apiRequests.length;
    await clickPayment(page, '입금했어요');
    await expect(page.locator('.payment-chip.requested')).toBeVisible();
    const requests = pipeline.apiRequests.slice(requestStart);
    expect(requests.filter(({ path, body }) => path === '/api/customer-orders' && body.groupId)).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ action: 'list', groupId: order.groupId }), result: expect.objectContaining({ ok: true }) }),
    ]);
    const firstPayment = requests.findIndex(({ body }) => body.action === 'transition_payment');
    expect(firstPayment).toBeGreaterThanOrEqual(0);
    // Preflight accepts the scoped canonical read instead of publishing. A
    // separate background sync may have queued the same unacknowledged order;
    // it must use the existing publish receipt and preserve the newer state.
    expect(requests.slice(0, firstPayment).filter(({ path, body }) => (
      path === '/api/customer-orders' && body.action === 'publish'
    ))).toEqual([]);
    const background = requests.filter(({ path, body }) => path === '/api/customer-orders' && body.action === 'publish');
    for (const entry of background) {
      expect(entry.body.order).toMatchObject({ id: order.id, publishMutationId: order.publishMutationId });
      await expect.poll(() => entry.result?.order?.paymentStatus).toBe('requested');
    }
    expect(pipeline.collectorRequests.filter(({ payload }) => payload.action === 'customer_orders' && payload.groupId === order.groupId)).toHaveLength(1);
    assertCentralPayment(pipeline, 'requested', 2);
    expect(pipeline.payments()).toHaveLength(1);
  } finally {
    holdFullHistory = false;
    releaseReads.resolve();
    await pipeline.close();
  }
});

test('실제 API·GAS: 로컬 동기화 확인이 있어도 중앙 주문 연결이 없으면 입금 상태를 바꾸지 않는다', async ({ page }) => {
  let loseCentralOrder = false;
  const pipeline = await installPaymentPipeline(page, {
    async beforeApi(entry) {
      if (loseCentralOrder && entry.path === '/api/group-ops' && entry.body.action === 'transition_payment') {
        // Simulate a missing canonical row only in this isolated spreadsheet.
        // The browser's existing acknowledgement must never bypass GAS proof.
        pipeline.data.customerOrders.rows.splice(1);
      }
    },
  });
  try {
    await createSelfHostedGroup(page);
    await waitForOrderAcknowledgement(page, pipeline);
    const [order] = pipeline.orders();
    const previous = pipeline.context.getParticipantRecord_(pipeline.data, order.groupId, order.visitorId);
    const history = JSON.stringify(pipeline.data.groupHistory.rows);
    loseCentralOrder = true;
    await clickPayment(page, '입금했어요');
    await expect(page.locator('.room-error')).toContainText('과거 주문과 그룹 참여 기록의 연결을 확인해야 합니다');
    expect(paymentRequests(pipeline)).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ ok: false, error: 'order_payment_link_required' }) }),
    ]);
    await expect(page.locator('.payment-chip.pending')).toHaveText('입금대기');
    const current = pipeline.context.getParticipantRecord_(pipeline.data, order.groupId, order.visitorId);
    expect(current.paymentStatus).toBe('pending');
    expect(current.version).toBe(previous.version);
    expect(JSON.stringify(pipeline.data.groupHistory.rows)).toBe(history);
    expect(pipeline.payments()).toEqual([]);
    expect(pipeline.failures).toEqual([]);
  } finally {
    await pipeline.close();
  }
});

test('실제 API·GAS: 예약 증명 없는 과거 로컬 주문이 정상 중앙 호스트 주문의 입금 요청을 막지 않는다', async ({ page }, testInfo) => {
  const heldRead = deferred();
  const releaseRead = deferred();
  let holdFullHistory = false;
  const pipeline = await installPaymentPipeline(page, {
    async afterApi(entry) {
      if (holdFullHistory && entry.path === '/api/customer-orders' && entry.body.action === 'list' && !entry.body.groupId) {
        heldRead.resolve();
        await releaseRead.promise;
      }
    },
  });
  try {
    await createSelfHostedGroup(page);
    await waitForOrderAcknowledgement(page, pipeline);
    const [order] = pipeline.orders();
    holdFullHistory = true;
    await page.evaluate(() => window.dispatchEvent(new Event('o2o-customer-orders-updated')));
    await heldRead.promise;
    await page.evaluate(() => {
      const key = 'o2o_mvp_customer_orders';
      const orders = JSON.parse(localStorage.getItem(key) || '[]');
      const legacy = {
        ...orders[0], id: 'order-1700000000999999',
        createdAt: '2023-11-14T22:13:20.000Z', type: 'purchase',
      };
      for (const field of [
        'reservationMutationId', 'reservationAction', 'reservationQuantity',
        'clientMutationId', 'publishMutationId', 'syncedAt',
      ]) delete legacy[field];
      localStorage.setItem(key, JSON.stringify([...orders, legacy]));
    });
    const requestStart = pipeline.apiRequests.length;
    await clickPayment(page, '입금했어요');
    try {
      await expect(page.locator('.payment-chip.requested')).toBeVisible({ timeout: 5000 });
    } finally {
      await testInfo.attach('legacy-local-preflight-result', {
        contentType: 'application/json',
        body: JSON.stringify({
          centralOrders: pipeline.orders().map(({ id, paymentStatus }) => ({ id, paymentStatus })),
          requests: pipeline.apiRequests.slice(requestStart).map(({ path, body, status, result }) => ({
            path, action: body.action, groupId: body.groupId || body.order?.groupId,
            orderId: body.order?.id, reservationMutationId: body.order?.reservationMutationId,
            status, error: result?.error,
          })),
          paymentHistoryCount: pipeline.payments().length,
        }, null, 2),
      });
    }
    expect(pipeline.apiRequests.slice(requestStart).filter(({ path, body }) => (
      path === '/api/customer-orders' && body.action === 'publish'
    ))).toEqual([]);
    expect(pipeline.orders()).toHaveLength(1);
    expect(pipeline.orders()[0].id).toBe(order.id);
    assertCentralPayment(pipeline, 'requested', 2);
  } finally {
    holdFullHistory = false;
    releaseRead.resolve();
    await pipeline.close();
  }
});

test('실제 API·GAS: 입금 처리 뒤 health 응답이 와도 같은 요청으로 확인하며 이력과 내 주문을 한 번만 변경한다', async ({ page }) => {
  let replacePaymentResponses = 3;
  const pipeline = await installPaymentPipeline(page, {
    afterCollector(entry) {
      if (entry.payload.action === 'group_transition_payment' && replacePaymentResponses > 0) {
        // The real GAS operation has already committed (or found its receipt).
        // Replace only the delivered envelope, as observed on the live POST.
        entry.committedResult = entry.result;
        entry.result = { ok: true, service: 'UPTWOYOU collector' };
        replacePaymentResponses -= 1;
      }
    },
  });
  try {
    await createSelfHostedGroup(page);
    await waitForOrderAcknowledgement(page, pipeline);
    const [order] = pipeline.orders();
    const initialVersion = pipeline.context.getParticipantRecord_(pipeline.data, order.groupId, order.visitorId).version;
    await clickPayment(page, '입금했어요');
    await expect(page.locator('.payment-feedback').getByRole('alert')).toContainText('처리 결과를 확인하지 못했습니다. 다시 시도하면 같은 요청의 처리 결과를 확인합니다.');
    await expect(page.getByRole('button', { name: '입금 상태 다시 확인', exact: true })).toBeEnabled();
    expect(paymentRequests(pipeline)).toHaveLength(3);
    for (const entry of paymentRequests(pipeline)) {
      expect(entry).toMatchObject({ status: 502, result: { ok: false, error: 'upstream_invalid_response' } });
    }
    // A fresh snapshot can already show the committed result. Retrying must
    // still use pending -> requested, never advance that result to confirmed.
    await expect(page.locator('.payment-chip.requested')).toBeVisible();
    assertCentralPayment(pipeline, 'requested', initialVersion + 1);
    expect(pipeline.payments()).toHaveLength(1);
    const pendingIntents = await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_group_transition_mutations_v1') || '{}'));
    expect(Object.values(pendingIntents)).toEqual([
      expect.objectContaining({ clientMutationId: paymentRequests(pipeline)[0].body.clientMutationId, fromStatus: 'pending', toStatus: 'requested' }),
    ]);
    await clickPayment(page, '입금 상태 다시 확인');
    await expect(page.locator('.room-notice')).toContainText('채팅과 내 주문에 반영되었습니다');
    expect(paymentRequests(pipeline)).toHaveLength(4);
    const [first, ...retries] = paymentRequests(pipeline);
    for (const entry of retries) expect(entry.body).toEqual(first.body);
    expect(retries.at(-1).result.duplicate).toBe(true);
    const collected = pipeline.collectorRequests.filter(({ payload }) => payload.action === 'group_transition_payment');
    expect(collected).toHaveLength(4);
    expect(collected.map((entry) => Boolean((entry.committedResult || entry.result).duplicate))).toEqual([false, true, true, true]);
    for (const entry of collected) expect(entry.payload).toEqual(collected[0].payload);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_group_transition_mutations_v1') || '{}'))).toEqual({});
    await openMyOrders(page);
    await expect(page.locator('.customer-payment-state.requested')).toContainText('입금확인요청 전송 완료');
    await page.reload();
    await page.getByRole('button', { name: '내 주문', exact: true }).click();
    await expect(page.locator('.customer-payment-state.requested')).toContainText('입금확인요청 전송 완료');
    assertCentralPayment(pipeline, 'requested', initialVersion + 1);
    expect(pipeline.payments()).toHaveLength(1);
  } finally {
    await pipeline.close();
  }
});

test('실제 API·GAS: 주문조회 health 응답은 빈 목록으로 확정하지 않고 기존 입금 상태를 보존한다', async ({ page }) => {
  let replaceHistoryResponses = false;
  const pipeline = await installPaymentPipeline(page, {
    afterCollector(entry) {
      if (replaceHistoryResponses && entry.payload.action === 'customer_orders') {
        entry.committedResult = entry.result;
        entry.result = { ok: true, service: 'UPTWOYOU collector' };
      }
    },
  });
  try {
    await createSelfHostedGroup(page);
    await waitForOrderAcknowledgement(page, pipeline);
    await clickPayment(page, '입금했어요');
    await expect(page.locator('.payment-chip.requested')).toBeVisible();
    await openMyOrders(page);
    await expect(page.locator('.order-card')).toHaveCount(1);
    await expect(page.getByText('조회 가능한 주문 이력을 확인했습니다.', { exact: true })).toBeVisible();
    const [order] = pipeline.orders();
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_customer_orders') || '[]'));
    const requestStart = pipeline.apiRequests.length;
    replaceHistoryResponses = true;
    await page.evaluate(() => window.dispatchEvent(new Event('o2o-customer-orders-updated')));
    await expect(page.getByRole('alert')).toContainText('이전 이력을 불러오지 못했습니다.');
    const failedRead = pipeline.apiRequests.slice(requestStart).find(({ path, body }) => path === '/api/customer-orders' && body.action === 'list');
    expect(failedRead).toMatchObject({ status: 502, result: { ok: false, error: 'upstream_invalid_response' } });
    await expect(page.locator('.order-card')).toHaveCount(1);
    await expect(page.locator('.customer-payment-state.sync-failed')).toContainText('입금 상태 확인 필요');
    await expect(page.locator('.customer-payment-state.sync-failed')).toContainText('마지막 확인 상태: 입금확인요청 전송 완료');
    await expect(page.getByRole('heading', { name: '조회 가능한 참여 내역이 없습니다' })).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_customer_orders') || '[]'))).toEqual(before);
    expect(pipeline.orders()[0]).toMatchObject({ id: order.id, paymentStatus: 'requested', paymentVersion: order.paymentVersion });
    expect(pipeline.payments()).toHaveLength(1);
    replaceHistoryResponses = false;
    await page.getByRole('button', { name: '주문 이력 다시 불러오기', exact: true }).click();
    await expect(page.getByText('조회 가능한 주문 이력을 확인했습니다.', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.order-card')).toHaveCount(1);
    await expect(page.locator('.customer-payment-state.requested')).toContainText('입금확인요청 전송 완료');
    expect(pipeline.failures).toEqual([]);
  } finally {
    await pipeline.close();
  }
});

test('실제 API·GAS: 호스트의 오래된 입금대기 카드는 조회 실패 중 마지막 상태로 구분하고 재조회로 갱신한다', async ({ page }) => {
  let failHistory = false;
  const pipeline = await installPaymentPipeline(page, {
    afterApi(entry) {
      if (failHistory && entry.path === '/api/customer-orders' && entry.body.action === 'list') {
        return 'timeout-response';
      }
    },
  });
  try {
    await createSelfHostedGroup(page);
    await waitForOrderAcknowledgement(page, pipeline);
    const stale = await page.evaluate(() => ({
      orders: localStorage.getItem('o2o_mvp_customer_orders'),
      acknowledgement: localStorage.getItem('o2o_mvp_customer_order_sync_fingerprints'),
    }));
    await clickPayment(page, '입금했어요');
    await expect(page.locator('.payment-chip.requested')).toBeVisible();
    await clickPayment(page, '입금 확인');
    await expect(page.locator('.payment-chip.confirmed')).toBeVisible();
    const [order] = pipeline.orders();
    expect(order.type).toBe('group');
    expect(order.paymentStatus).toBe('confirmed');
    failHistory = true;
    // Retain the genuine earlier order/receipt, as on another old browser.
    // Only this isolated browser cache changes; the canonical order stays paid.
    await page.addInitScript((saved) => {
      if (sessionStorage.getItem('stale-payment-cache-seeded')) return;
      sessionStorage.setItem('stale-payment-cache-seeded', 'yes');
      localStorage.setItem('o2o_mvp_customer_orders', saved.orders);
      localStorage.setItem('o2o_mvp_customer_order_sync_fingerprints', saved.acknowledgement);
    }, stale);
    await page.goto(`/customer?group=${order.groupId}&view=room`);
    await expect(page.locator('.payment-chip.confirmed')).toBeVisible();
    await page.getByRole('button', { name: '내 주문', exact: true }).click();
    await expect(page.locator('.customer-history-notice.has-error')).toBeVisible();
    await expect(page.locator('.order-card')).toHaveCount(1);
    await expect(page.locator('.order-card')).toContainText('입금 상태 확인 필요');
    await expect(page.locator('.order-card')).toContainText('마지막 확인 상태: 입금대기');
    await expect(page.locator('.order-card').getByText('입금대기', { exact: true })).toHaveCount(0);
    await expect(page.locator('.order-card')).not.toContainText('“입금했어요”를 눌러');
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('o2o_mvp_customer_orders')))[0].paymentStatus).toBe('pending');
    failHistory = false;
    await page.getByRole('button', { name: '주문 이력 다시 불러오기', exact: true }).click();
    await expect(page.locator('.customer-payment-state.confirmed')).toContainText('입금완료');
    expect(pipeline.payments()).toHaveLength(2);
    expect(pipeline.orders()[0].paymentStatus).toBe('confirmed');
    expect(pipeline.failures).toEqual([]);
  } finally { await pipeline.close(); }
});

test('실제 API·GAS: 첫 입금완료 채팅 조회가 진행 중인 오래된 주문 조회 뒤에 후속 갱신을 예약한다', async ({ page }) => {
  const heldRead = deferred();
  const releaseRead = deferred();
  let holdNextRead = false;
  const pipeline = await installPaymentPipeline(page, {
    async afterApi(entry) {
      if (holdNextRead && entry.path === '/api/customer-orders' && entry.body.action === 'list') {
        holdNextRead = false;
        heldRead.resolve();
        await releaseRead.promise;
      }
    },
  });
  try {
    await createSelfHostedGroup(page);
    await waitForOrderAcknowledgement(page, pipeline);
    await openMyOrders(page);
    await expect(page.getByText('조회 가능한 주문 이력을 확인했습니다.', { exact: true })).toBeVisible();
    const [order] = pipeline.orders();
    holdNextRead = true;
    await page.evaluate(() => window.dispatchEvent(new Event('o2o-customer-orders-updated')));
    await heldRead.promise;
    await expect(page.locator('.order-card')).toContainText('입금 상태 확인 중');
    // Use the real API/GAS transitions without GroupRoom's local mutation
    // callback, representing a host update from a different open window.
    await page.evaluate(async ({ groupId, visitorId }) => {
      const { transitionParticipantPayment } = await import('/src/groupApi.js');
      await transitionParticipantPayment(groupId, visitorId, 'next', visitorId);
      await transitionParticipantPayment(groupId, visitorId, 'next', visitorId);
    }, order);
    expect(pipeline.orders()[0].paymentStatus).toBe('confirmed');
    await page.getByRole('button', { name: '상세보기', exact: true }).click();
    await page.getByRole('button', { name: '그룹 채팅', exact: true }).click();
    await expect(page.locator('.payment-chip.confirmed')).toBeVisible();
    const beforeRelease = pipeline.apiRequests.filter(({ path, body }) => (
      path === '/api/customer-orders' && body.action === 'list'
    )).length;
    releaseRead.resolve();
    await expect.poll(() => pipeline.apiRequests.filter(({ path, body }) => (
      path === '/api/customer-orders' && body.action === 'list'
    )).length, { timeout: 5000 }).toBeGreaterThan(beforeRelease);
    await page.getByRole('button', { name: '내 주문', exact: true }).click();
    await expect(page.locator('.customer-payment-state.confirmed')).toContainText('입금완료');
    expect(pipeline.payments()).toHaveLength(2);
    expect(pipeline.orders()).toHaveLength(1);
    expect(pipeline.failures).toEqual([]);
  } finally { releaseRead.resolve(); await pipeline.close(); }
});

test('실제 API·GAS: 중앙 주문의 빈 변경 이력을 임의 보강해 반복 게시하지 않는다', async ({ page }) => {
  const pipeline = await installPaymentPipeline(page);
  try {
    await createSelfHostedGroup(page);
    await waitForOrderAcknowledgement(page, pipeline);
    await openMyOrders(page);
    await expect(page.getByText('조회 가능한 주문 이력을 확인했습니다.', { exact: true })).toBeVisible();
    const [order] = pipeline.orders();
    // A valid canonical legacy record can have no status-history entries.
    // Give it the newer version so the fixture's old creation event cannot
    // take precedence over the current central record during history merging.
    const legacy = { ...order, statusHistory: [], version: 20, paymentVersion: 20 };
    pipeline.data.customerOrders.rows.slice(1)
      .find((row) => JSON.parse(row[3]).id === order.id)[3] = JSON.stringify(legacy);
    const publishCount = () => pipeline.apiRequests.filter(({ path, body }) => (
      path === '/api/customer-orders' && body.action === 'publish'
    )).length;
    const publicationsBefore = publishCount();
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const readsBefore = pipeline.apiRequests.filter(({ path, body }) => (
        path === '/api/customer-orders' && body.action === 'list'
      )).length;
      await page.evaluate(() => window.dispatchEvent(new Event('o2o-customer-orders-updated')));
      await expect.poll(() => pipeline.apiRequests.filter(({ path, body }) => (
        path === '/api/customer-orders' && body.action === 'list'
      )).length).toBeGreaterThan(readsBefore);
      await expect(page.getByText('조회 가능한 주문 이력을 확인했습니다.', { exact: true })).toBeVisible();
      expect(publishCount()).toBe(publicationsBefore);
      expect(pipeline.orders()[0].statusHistory).toEqual([]);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_customer_orders'))[0].statusHistory)).toEqual([]);
    }
    expect(pipeline.orders()).toHaveLength(1);
    expect(pipeline.payments()).toEqual([]);
    expect(pipeline.failures).toEqual([]);
  } finally { await pipeline.close(); }
});
