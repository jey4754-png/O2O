import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { historyOrder } from '../helpers/customer-history-store.js';
import { installPaymentPipeline } from '../helpers/payment-pipeline.js';

const token = 'synthetic-historic-detail-capability-00000001';
const hash = createHash('sha256').update(token).digest('hex');

for (const cancelled of [false, true]) {
  test(`공개 목록에 없는 ${cancelled ? '취소된' : '기존'} 주문 상세는 흰 화면이나 재주문 없이 돌아온다`, async ({ page }, testInfo) => {
    const errors = [];
    const writes = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const fixture = await installPaymentPipeline(page, { afterApi(entry) {
      if (entry.path !== '/api/customer-orders') return;
      if (entry.body.action !== 'list') writes.push(entry.body.action);
      if (entry.body.action === 'list' && entry.result.orders?.length) {
        expect(entry.status).toBe(200);
        expect(entry.result.orders[0].deal.menu).toBeUndefined();
      }
    } });
    const order = historyOrder('1234567890890', {
      title: '합성 과거 세제 주문', _customerCapabilityHash: hash,
      ...(cancelled ? { status: 'cancelled', cancelledAt: '2026-10-01T00:00:00Z' } : {}),
    });
    fixture.data.customerOrders.rows.push(['', order.id, order.customerPhone, JSON.stringify(order)]);
    try {
      await page.addInitScript((token) => {
        localStorage.setItem('o2o_mvp_customer_order_capability_v1', token);
        localStorage.setItem('o2o_mvp_profile', JSON.stringify({ name: '합성 사용자', phone: '010-1111-2222',
          testerType: '사용자', consent: true, region: '경기도', district: '성남시 분당구', neighborhood: '판교동' }));
        sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({ profileKey: '사용자:01011112222', startedAt: Date.now() }));
      }, token);
      await page.goto('/customer');
      await page.locator('.bottom-nav').getByRole('button', { name: '내 주문', exact: true }).click();
      const card = page.locator('.order-card').filter({ hasText: '합성 과거 세제 주문' });
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: '상세보기', exact: true }).click();
      await expect(page.locator('.detail-screen'), JSON.stringify(errors)).toBeVisible();
      await expect(page.locator('.detail-screen')).toContainText('상품 상세 정보를 현재 불러올 수 없습니다');
      await expect(page.locator('.detail-screen').getByRole('button', { name: '참여하기', exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('historic-detail-safe.png') });
      await page.locator('.detail-screen').getByRole('button', { name: '뒤로', exact: true }).click();
      await expect(page.locator('#root')).not.toBeEmpty();
      expect(errors).toEqual([]);
      expect(writes).toEqual([]);
      expect(fixture.orders()).toHaveLength(1);
      expect(fixture.failures).toEqual([]);
    } finally { await fixture.close(); }
  });
}
