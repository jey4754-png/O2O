import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import customerOrdersHandler from '../../api/customer-orders.js';
import { customerHistoryStore, historyOrder } from '../helpers/customer-history-store.js';
import { imageResponse } from '../helpers/product-image-store.js';

const TOKEN = 'synthetic-customer-history-browser-capability-001';
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const OLD_ID = 'order-1234567890701';
const NEW_ID = 'order-1234567890702';

async function setup(page, { failReads = false, holdFirst = false, onlyUnlinked = false, repairRequired = false } = {}) {
  const fixture = customerHistoryStore({
    current: [historyOrder('1234567890702', { title: '새로 만든 합성 주문', _customerCapabilityHash: HASH }),
      historyOrder('1234567890703', { title: '다른 키의 주문', _customerCapabilityHash: 'b'.repeat(64) }),
      historyOrder('1234567890704', { title: '권한 연결 없는 과거 주문' }),
      historyOrder('1234567890705', { title: '다른 프로필 주문', customerPhone: '01033334444', _customerCapabilityHash: HASH })],
    historic: [historyOrder('1234567890701', { title: '중앙에서 복구한 과거 주문', _customerCapabilityHash: HASH,
      ...(repairRequired ? { groupId: 'owner-history-source' } : {}) })],
  });
  if (onlyUnlinked) {
    fixture.currentRows.splice(1, 2);
    fixture.eventRows.splice(1);
  }
  const state = { failReads, reads: [], writes: [], heldReads: 0, releasedReads: 0, releaseFirst: null };
  let released = false;
  const gate = new Promise((resolve) => { state.releaseFirst = () => { released = true; resolve(); }; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const result = fixture.context.doPost({ postData: { contents: JSON.stringify(body) } });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const keys = ['O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { O2O_DATA_API_ORIGIN: '', O2O_DATA_API_TOKEN: '',
    GOOGLE_SHEETS_COLLECTOR_URL: `http://127.0.0.1:${server.address().port}`, GOOGLE_SHEETS_COLLECTOR_TOKEN: 'REPLACE_WITH_RANDOM_TOKEN' });
  await page.addInitScript(({ token }) => {
    if (localStorage.getItem('history-test-seeded')) return;
    localStorage.setItem('history-test-seeded', 'yes');
    const profile = { name: '고객 이력 검증', phone: '010-1111-2222', testerType: '사용자',
      consent: true, region: '경기도', district: '성남시 분당구', neighborhood: '판교동' };
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
    localStorage.setItem('o2o_mvp_visitor_id', 'customer-history-visitor');
    localStorage.setItem('o2o_mvp_customer_order_capability_v1', token);
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사용자:01011112222', startedAt: Date.now(),
    }));
  }, { token: TOKEN });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() || {};
    if (path !== '/api/customer-orders') return route.fulfill({ json: {
      ok: true, deals: [], orders: [], unreadCounts: {}, stats: {}, events: [],
    } });
    // This fixture is read-only: background sync cannot change synthetic rows.
    if (body.action !== 'list') {
      state.writes.push(body);
      return route.fulfill({ status: 403, json: { ok: false, error: 'fixture_read_only' } });
    }
    state.reads.push({ phone: body.phone, action: body.action });
    const response = imageResponse();
    await customerOrdersHandler({ method: 'POST', headers: { origin: 'http://127.0.0.1:4187' }, body }, response);
    const held = holdFirst && !released && body.phone === '01011112222';
    if (held) {
      state.heldReads += 1;
      await gate;
    }
    if (state.failReads) return route.fulfill({ status: 503, json: { ok: false, error: 'collector_unavailable' } });
    await route.fulfill({ status: response.statusCode, headers: response.headers, json: response.body }).catch(() => {});
    if (held) state.releasedReads += 1;
  });
  return { ...fixture, state, async close() {
    state.releaseFirst();
    await page.close();
    await new Promise((resolve) => server.close(resolve));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  } };
}

async function openOrders(page) {
  await page.locator('.bottom-nav').getByRole('button', { name: '내 주문', exact: true }).click();
}

test('실제 권한 조회로 과거+신규 주문을 표시하고 조회 실패 시 보존 후 재시도한다', async ({ page }, testInfo) => {
  const f = await setup(page, { holdFirst: true });
  try {
    await page.goto('/customer');
    await openOrders(page);
    await expect(page.getByText('이전 주문·참여 이력을 확인하고 있습니다.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '조회 가능한 참여 내역이 없습니다' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '이력 확인 중…' })).toBeDisabled();
    f.state.releaseFirst();
    await expect(page.locator('.order-card')).toHaveCount(2);
    await expect(page.locator('.order-card-list')).toContainText('중앙에서 복구한 과거 주문');
    await expect(page.locator('.order-card-list')).not.toContainText('다른 키의 주문');
    await expect(page.locator('.order-card-list')).not.toContainText('권한 연결 없는 과거 주문');
    f.state.failReads = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('alert')).toContainText('이전 이력을 불러오지 못했습니다.');
    await expect(page.locator('.order-card')).toHaveCount(2);
    f.state.failReads = false;
    const readsBeforeRetry = f.state.reads.length;
    await page.getByRole('button', { name: '주문 이력 다시 불러오기', exact: true }).evaluate((button) => { button.click(); button.click(); });
    await expect(page.getByText('조회 가능한 주문 이력을 확인했습니다.', { exact: true })).toBeVisible();
    expect(f.state.reads.length).toBe(readsBeforeRetry + 1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.order-card')).toHaveCount(2);
    const savedIds = await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_customer_orders')).map((order) => order.id));
    expect(savedIds.sort()).toEqual([OLD_ID, NEW_ID]);
    await page.screenshot({ path: testInfo.outputPath('customer-history-restored.png'), fullPage: true });
  } finally { await f.close(); }
});

test('첫 조회 실패와 권한 미연결 빈 결과는 구분하고 자동 복구를 약속하지 않는다', async ({ page }) => {
  const f = await setup(page, { failReads: true, onlyUnlinked: true });
  try {
    await page.goto('/customer');
    await openOrders(page);
    await expect(page.getByRole('alert')).toContainText('이전 이력을 불러오지 못했습니다.');
    await expect(page.getByRole('heading', { name: '조회 가능한 참여 내역이 없습니다' })).toHaveCount(0);
    f.state.failReads = false;
    await page.getByRole('button', { name: '주문 이력 다시 불러오기', exact: true }).click();
    await expect(page.getByRole('heading', { name: '조회 가능한 참여 내역이 없습니다' })).toBeVisible();
    // A checked-but-empty list opens the recovery guidance and shows the code
    // without any extra tap: a wiped mobile store leaves no other symptom.
    await expect(page.getByText(/이전 주문의 권한키가 없거나 연결되지 않은 기록은 여기서 자동 복구할 수 없습니다/)).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('주문 확인 키가 사라진 상태입니다');
    await expect(page.locator('.recovery-code')).toHaveText(/^[a-f0-9]{64}$/);
    await expect(page.getByRole('button', { name: '복구 코드 보기' })).toHaveCount(0);
    expect(f.currentRows.length).toBe(3);
  } finally { await f.close(); }
});

test('프로필 변경 뒤 도착한 이전 고객의 응답은 목록과 저장소에 적용되지 않는다', async ({ page }) => {
  const f = await setup(page, { holdFirst: true });
  try {
    await page.goto('/customer');
    await expect.poll(() => f.state.heldReads).toBeGreaterThanOrEqual(1);
    await page.locator('.bottom-nav').getByRole('button', { name: '마이', exact: true }).click();
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.getByLabel('이름').fill('변경된 고객');
    await page.getByLabel('연락처').fill('01033334444');
    await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
    await page.getByRole('button', { name: '테스트 시작' }).click();
    await openOrders(page);
    await expect(page.locator('.order-card')).toHaveCount(1);
    await expect(page.locator('.order-card')).toContainText('다른 프로필 주문');
    f.state.releaseFirst();
    await expect.poll(() => f.state.releasedReads).toBe(f.state.heldReads);
    await expect(page.getByText('조회 가능한 주문 이력을 확인했습니다.', { exact: true })).toBeVisible();
    const ids = await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_customer_orders') || '[]').map((order) => order.id));
    expect(ids).toEqual(['order-1234567890705']);
    await expect(page.locator('.order-card')).toHaveCount(1);
  } finally { await f.close(); }
});

test('권한은 있으나 참여 연결이 검증되지 않은 주문은 점검 안내를 표시하고 조회 힌트를 재게시하지 않는다', async ({ page }) => {
  const f = await setup(page, { repairRequired: true });
  try {
    await page.goto('/customer');
    await openOrders(page);
    const oldCard = page.locator('.order-card').filter({ hasText: '중앙에서 복구한 과거 주문' });
    await expect(oldCard).toContainText('과거 주문 연결 확인 필요 · 관리자 점검 요청');
    await expect(oldCard.getByText('입금대기', { exact: true })).toHaveCount(0);
    await expect(oldCard).not.toContainText('입금완료');
    const readsBefore = f.state.reads.length;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => f.state.reads.length).toBeGreaterThan(readsBefore);
    await expect(page.getByRole('button', { name: '주문 이력 다시 불러오기', exact: true })).toBeEnabled();
    expect(f.state.writes).toEqual([]);
    await page.evaluate((id) => {
      const orders = JSON.parse(localStorage.getItem('o2o_mvp_customer_orders'));
      orders.find((order) => order.id === id).title = '합성 로컬 미전송 변경';
      localStorage.setItem('o2o_mvp_customer_orders', JSON.stringify(orders));
      window.dispatchEvent(new Event('online'));
    }, OLD_ID);
    await expect.poll(() => f.state.writes.length).toBeGreaterThan(0);
    expect(f.state.writes[0].action).toBe('publish');
    expect(f.state.writes[0].order.paymentSyncStatus).toBeUndefined();
    expect(f.eventRows).toHaveLength(2);
    expect(f.currentRows).toHaveLength(5);
  } finally { await f.close(); }
});
