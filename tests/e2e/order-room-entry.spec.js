import { expect, test } from '@playwright/test';
import { deferred, installPaymentPipeline } from '../helpers/payment-pipeline.js';

async function onboard(page, name, phone) {
  await page.getByLabel('이름', { exact: true }).fill(name);
  await page.getByLabel('연락처').fill(phone);
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
  await page.getByRole('button', { name: '테스트 시작' }).click();
}

async function joinedOrder(page, browser, testInfo, hooks = {}) {
  const pipeline = await installPaymentPipeline(page, hooks);
  const context = await browser.newContext({ ...testInfo.project.use });
  const member = await context.newPage();
  await pipeline.attach(member);
  await page.goto('/customer');
  await onboard(page, '채팅 연결 호스트', '010-0000-1001');
  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();
  await expect(page.locator('.group-room-screen')).toBeVisible();
  await expect.poll(() => pipeline.orders().length).toBe(1);
  const groupId = pipeline.orders()[0].groupId;
  await member.goto(`/customer?group=${groupId}`);
  await onboard(member, '기존 주문 참여자', '010-0000-1002');
  await member.getByRole('button', { name: '참여하기', exact: true }).click();
  await member.getByRole('button', { name: '참여 완료하기' }).click();
  await member.getByRole('button', { name: '그룹 채팅 바로가기' }).click();
  await expect(member.locator('.group-room-screen')).toBeVisible();
  await expect.poll(() => pipeline.orders().length).toBe(2);
  const order = pipeline.orders().find((item) => item.type === 'purchase');
  // The recovered seat still belongs to the original actor; the browser now
  // has a different visitor id. Its valid room key is intentionally retained.
  await member.evaluate(() => localStorage.setItem('o2o_mvp_visitor_id', 'visitor-new-browser-identity'));
  await member.goto('/customer');
  await member.getByRole('button', { name: '내 주문', exact: true }).click();
  await expect(member.locator('.order-card')).toHaveCount(1);
  return { pipeline, member, context, order };
}

for (const changeProfile of [false, true]) {
test(changeProfile ? '입금 응답 전에 로그인 사용자를 바꾸면 이전 주문 결과를 새 프로필에 적용하지 않는다' : '입금 저장 직후 응답 전에 내 주문으로 돌아가도 도착한 중앙 결과를 보존한다', async ({ page, browser }, testInfo) => {
  const committed = deferred();
  const deliver = deferred();
  const f = await joinedOrder(page, browser, testInfo, {
    async afterApi(entry) {
      if (entry.path === '/api/group-ops' && entry.body.action === 'transition_payment' && entry.result?.ok) {
        committed.resolve();
        await deliver.promise;
      }
    },
  });
  try {
    f.member.on('dialog', (dialog) => dialog.accept());
    await f.member.getByRole('button', { name: '그룹 채팅', exact: true }).click();
    await expect(f.member.locator('.group-room-screen')).toBeVisible();
    await f.member.getByRole('button', { name: '입금했어요', exact: true }).click();
    await committed.promise;
    await f.member.goBack();
    await expect(f.member.locator('.order-card')).toHaveCount(1);
    if (changeProfile) {
      await f.member.locator('.bottom-nav').getByRole('button', { name: '마이', exact: true }).click();
      await f.member.getByRole('button', { name: '로그아웃', exact: true }).click();
      await onboard(f.member, '변경된 참여자', '010-0000-2003');
      await f.member.getByRole('button', { name: '내 주문', exact: true }).click();
      await expect(f.member.locator('.order-card')).toHaveCount(0);
      const before = await f.member.evaluate(() => localStorage.getItem('o2o_mvp_customer_orders'));
      const received = f.member.waitForResponse((response) => response.url().endsWith('/api/group-ops')
        && response.request().postDataJSON()?.action === 'transition_payment');
      deliver.resolve();
      await (await received).finished();
      expect(await f.member.evaluate(() => localStorage.getItem('o2o_mvp_customer_orders'))).toBe(before);
      await expect(f.member.locator('.order-card')).toHaveCount(0);
    } else {
      deliver.resolve();
      await expect(f.member.locator('.order-card').filter({ hasText: '입금확인요청' })).toHaveCount(1);
    }
    expect(f.pipeline.orders()).toHaveLength(2);
  } finally {
    deliver.resolve();
    await f.pipeline.close();
    await f.context.close();
  }
});
}

for (const desktop of [false, true]) {
  test(`실제 API·GAS: ${desktop ? '노트북' : '모바일'} 기존 주문의 원래 참여자로 채팅에 바로 입장하며 주문을 추가하지 않는다`, async ({ page, browser }, testInfo) => {
    const f = await joinedOrder(page, browser, testInfo);
    try {
      f.member.on('dialog', (dialog) => dialog.accept());
      if (desktop) await f.member.setViewportSize({ width: 1440, height: 1000 });
      const start = f.pipeline.apiRequests.length;
      await f.member.getByRole('button', { name: '그룹 채팅', exact: true }).click();
      await expect(f.member.locator('.group-room-screen')).toBeVisible({ timeout: 4000 });
      await expect(f.member.locator('.payment-chip.pending').first()).toBeVisible();
      await f.member.getByLabel('메시지 입력').fill('기존 주문에서 재참여 없이 전송');
      await f.member.getByRole('button', { name: '메시지 전송' }).click();
      await expect(f.member.locator('.chat-message').filter({ hasText: '기존 주문에서 재참여 없이 전송' })).toBeVisible();
      const requests = f.pipeline.apiRequests.slice(start);
      const send = requests.find(({ body }) => body.action === 'send_message');
      expect(send?.body.actorId).toBe(f.order.participantActorId);
      expect(requests.filter(({ body }) => ['join', 'reserve_quantity', 'publish'].includes(body.action))).toEqual([]);
      expect(f.pipeline.orders()).toHaveLength(2);
      await f.member.screenshot({ path: testInfo.outputPath('existing-order-direct-chat.png') });
      await f.member.goBack();
      await expect(f.member.locator('.order-card')).toHaveCount(1);
      await f.member.getByRole('button', { name: '그룹 채팅', exact: true }).click();
      await expect(f.member.locator('.group-room-screen')).toBeVisible();
      expect(f.pipeline.orders()).toHaveLength(2);
      await f.member.getByRole('button', { name: '입금했어요', exact: true }).click();
      await expect.poll(() => f.pipeline.orders().find((order) => order.id === f.order.id)?.paymentStatus).toBe('requested');
      await f.member.goBack();
      await expect(f.member.locator('.order-card').filter({ hasText: '입금확인요청' })).toHaveCount(1);
      expect(f.pipeline.orders()).toHaveLength(2);
    } finally { await f.pipeline.close(); await f.context.close(); }
  });
}

test('채팅 키가 없는 기존 주문은 재주문 화면으로 보내지 않고 내 주문에서 안내한다', async ({ page, browser }, testInfo) => {
  const f = await joinedOrder(page, browser, testInfo);
  try {
    await f.member.evaluate(() => localStorage.removeItem('o2o_mvp_group_credentials_v1'));
    const start = f.pipeline.apiRequests.length;
    await f.member.getByRole('button', { name: '그룹 채팅', exact: true }).click();
    await expect(f.member.getByRole('alert').filter({ hasText: '다시 참여하지 마세요' })).toBeVisible();
    await expect(f.member.locator('.order-card')).toHaveCount(1);
    await expect(f.member.getByRole('button', { name: '참여하기', exact: true })).toHaveCount(0);
    expect(f.pipeline.apiRequests.slice(start).filter(({ body }) => ['join', 'reserve_quantity', 'publish'].includes(body.action))).toEqual([]);
    expect(f.pipeline.orders()).toHaveLength(2);
  } finally { await f.pipeline.close(); await f.context.close(); }
});
