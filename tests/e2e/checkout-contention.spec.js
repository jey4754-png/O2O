import { expect, test } from '@playwright/test';
import { installPaymentPipeline } from '../helpers/payment-pipeline.js';

async function onboard(page, name, phone) {
  await page.getByLabel('이름', { exact: true }).fill(name);
  await page.getByLabel('연락처').fill(phone);
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
  await page.getByRole('button', { name: '테스트 시작' }).click();
}

test('실제 API·GAS: 잠금 경합 후 같은 참여를 재시도하면 주문과 수량이 한 번만 저장되고 내 주문에서 채팅에 진입한다', async ({ page, browser }, testInfo) => {
  let busy = false;
  let currentAction = '';
  const pipeline = await installPaymentPipeline(page, {
    beforeCollector(entry) { currentAction = entry.payload.action; },
  });
  const originalLock = pipeline.context.LockService.getScriptLock;
  pipeline.context.LockService.getScriptLock = () => {
    const lock = originalLock();
    const reject = busy && currentAction === 'group_join';
    return { tryLock: (...args) => reject ? false : lock.tryLock(...args), releaseLock: () => lock.releaseLock() };
  };
  const context = await browser.newContext({ ...testInfo.project.use });
  const member = await context.newPage();
  await pipeline.attach(member);
  try {
    await page.goto('/customer');
    await onboard(page, '잠금 경합 호스트', '010-0000-2001');
    await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
    await page.getByRole('button', { name: '그룹방 만들기' }).click();
    await page.getByRole('button', { name: '그룹방 생성' }).click();
    await expect(page.locator('.group-room-screen')).toBeVisible();
    await expect.poll(() => pipeline.orders().length).toBe(1);
    const groupId = pipeline.orders()[0].groupId;
    await member.goto(`/customer?group=${groupId}&view=detail`);
    await onboard(member, '잠금 경합 참여자', '010-0000-2002');
    await member.getByRole('button', { name: '참여하기', exact: true }).click();
    busy = true;
    await member.getByRole('button', { name: '참여 완료하기', exact: true }).click();
    await expect(member.getByRole('alert').filter({ hasText: '신청 정보를 유지했습니다' })).toBeVisible();
    const requests = () => pipeline.apiRequests.filter(({ path, body }) => path === '/api/group-ops' && body.action === 'join');
    expect(requests()).toHaveLength(4);
    expect(pipeline.orders()).toHaveLength(1);
    expect(pipeline.context.getParticipantsForGroup_(pipeline.data, groupId)).toHaveLength(1);
    const frozen = requests()[0].body;
    expect(requests().every(({ body }) => JSON.stringify(body) === JSON.stringify(frozen))).toBe(true);
    busy = false;
    await member.getByRole('button', { name: '참여 완료하기', exact: true }).click();
    await member.getByRole('button', { name: '그룹 채팅 바로가기', exact: true }).click();
    await expect(member.locator('.group-room-screen')).toBeVisible();
    await expect.poll(() => pipeline.orders().length).toBe(2);
    expect(requests().at(-1).body).toEqual(frozen);
    expect(pipeline.context.getParticipantsForGroup_(pipeline.data, groupId)).toHaveLength(2);
    const memberOrder = pipeline.orders().find((order) => order.type === 'purchase');
    expect(memberOrder.selectedCount).toBe(1);
    await member.goto('/customer');
    await member.getByRole('button', { name: '내 주문', exact: true }).click();
    await expect(member.locator('.order-card')).toHaveCount(1);
    const count = requests().length;
    await member.getByRole('button', { name: '그룹 채팅', exact: true }).click();
    await expect(member.locator('.group-room-screen')).toBeVisible();
    expect(requests()).toHaveLength(count);
    expect(pipeline.orders()).toHaveLength(2);
    expect(pipeline.failures).toEqual([]);
    await member.screenshot({ path: testInfo.outputPath('contention-retry-chat.png') });
  } finally {
    await pipeline.close();
    await context.close();
  }
});
