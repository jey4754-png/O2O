import { expect, test } from '@playwright/test';

const PROFILE = {
  name: '사장님 이력 검증', phone: '010-1111-2222', testerType: '사장님', consent: true,
  region: '경기도', district: '성남시 분당구', neighborhood: '판교동',
};
const OWN_ID = 'owner-history-own';
const FOREIGN_ID = 'owner-history-foreign';
const OWN_CAPABILITY = `owner-${'a'.repeat(64)}`;
const FOREIGN_CAPABILITY = `owner-${'b'.repeat(64)}`;

function deal(id, title) {
  return {
    id, title, source: 'merchant', saleType: 'instant', visibility: 'public', category: '마트',
    region: '경기도', district: '성남시 분당구', neighborhood: '판교동', store: '이력 검증 매장',
    originalPrice: 10000, discountRate: 10, target: 5, totalQuantity: 5, orderedQuantity: 0,
    methods: ['픽업'], pickupPlace: '판교역', menu: [], publishVersion: 1,
    image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  };
}

function order(id, product, title) {
  return {
    id, dealId: product.id, deal: product, title, type: 'purchase', status: 'new',
    paymentStatus: 'pending', version: 1, paymentVersion: 1, quantity: 1, selectedCount: 1,
    total: 9000, method: '픽업', customerName: '이력 검증 사용자', customerPhone: '010-1234-5678',
    createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
  };
}

async function seedOwner(page, { capabilities = {}, scopes = {}, created = [], localOrders = [] } = {}) {
  await page.addInitScript(({ profile, capabilities, scopes, created, localOrders }) => {
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
    localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify(capabilities));
    localStorage.setItem('o2o_mvp_owner_deal_scopes_v1', JSON.stringify(scopes));
    localStorage.setItem('o2o_mvp_created_deals', JSON.stringify(created));
    localStorage.setItem('o2o_mvp_customer_orders', JSON.stringify(localOrders));
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사장님:01011112222', startedAt: Date.now(),
    }));
  }, { profile: PROFILE, capabilities, scopes, created, localOrders });
}

async function mockWorkspace(page, state) {
  const ownerReads = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch { /* GET has no JSON body. */ }
    if (body.action === 'list_owner') {
      ownerReads.push({ path, capabilities: body.capabilities });
      if (state.failReads) return route.fulfill({ status: 503, json: { ok: false, error: 'collector_unavailable' } });
      const allowed = new Set((body.capabilities || [])
        .filter((entry) => entry.dealId === OWN_ID && entry.capabilityToken === OWN_CAPABILITY)
        .map((entry) => entry.dealId));
      return route.fulfill({ json: path === '/api/public-deals'
        ? { ok: true, deals: state.ownedDeals.filter((item) => allowed.has(item.id)) }
        : { ok: true, orders: state.ownedOrders.filter((item) => allowed.has(item.dealId)) } });
    }
    if (path === '/api/public-deals' && route.request().method() === 'GET') {
      return route.fulfill({ json: { ok: true, deals: state.publicDeals } });
    }
    return route.fulfill({ json: { ok: true, deals: [], orders: [], unreadCounts: {}, stats: {} } });
  });
  return ownerReads;
}

test('관리 키 없는 사장님 브라우저는 연결 안내를 표시하고 상품·주문이 없다고 단정하지 않는다', async ({ page }) => {
  await seedOwner(page);
  const reads = await mockWorkspace(page, { ownedDeals: [], ownedOrders: [], publicDeals: [] });
  await page.goto('/owner');
  await page.getByRole('button', { name: '상품 관리', exact: true }).click();
  await expect(page.getByText('이 브라우저에는 연결된 상품 관리키가 없습니다.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '등록한 상품이 없습니다', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '사장님 홈', exact: true }).click();
  await page.getByRole('button', { name: /^주문 \d+건/ }).click();
  await expect(page.getByText('이 브라우저에는 연결된 상품 관리키가 없습니다.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '신규 주문이 없습니다', exact: true })).toHaveCount(0);
  expect(reads).toEqual([]);
});

test('사장님 이력 조회가 실패해도 기존 상품·주문을 보존하고 재시도로 최신 이력을 반영한다', async ({ page }, testInfo) => {
  const own = deal(OWN_ID, '보존되는 기존 상품');
  const savedOrder = order('order-history-own', own, '보존되는 기존 주문');
  const state = { ownedDeals: [own], ownedOrders: [savedOrder], publicDeals: [own], failReads: false };
  await seedOwner(page, { capabilities: { [OWN_ID]: OWN_CAPABILITY }, scopes: { [OWN_ID]: 'phone:01011112222' } });
  const reads = await mockWorkspace(page, state);
  await page.goto('/owner');
  await expect.poll(() => reads.length).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: '상품 관리', exact: true }).click();
  await expect(page.locator('.owner-product-card')).toContainText('보존되는 기존 상품');
  await page.getByRole('button', { name: '사장님 홈', exact: true }).click();
  await page.getByRole('button', { name: /^주문 \d+건/ }).click();
  await expect(page.locator('.owner-order-card')).toContainText('보존되는 기존 주문');

  state.failReads = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('alert')).toContainText('기존 이력을 불러오지 못했습니다.');
  await expect(page.locator('.owner-order-card')).toContainText('보존되는 기존 주문');
  await expect(page.getByRole('heading', { name: '신규 주문이 없습니다', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await page.getByRole('button', { name: '상품 관리', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('마지막으로 확인한 목록을 표시합니다.');
  await expect(page.locator('.owner-product-card')).toContainText('보존되는 기존 상품');
  await expect(page.getByRole('heading', { name: '등록한 상품이 없습니다', exact: true })).toHaveCount(0);

  state.failReads = false;
  state.ownedDeals = [{ ...own, title: '재시도 후 최신 상품', publishVersion: 2 }];
  state.ownedOrders = [{ ...savedOrder, title: '재시도 후 최신 주문', version: 2 }];
  await page.getByRole('button', { name: '이력 다시 불러오기', exact: true }).click();
  await expect(page.getByText('서버에서 조회한 관리 이력을 반영했습니다. 이 브라우저에 남아 있는 기록도 보존합니다.', { exact: true })).toBeVisible();
  await expect(page.locator('.owner-product-card')).toContainText('재시도 후 최신 상품');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '사장님 홈', exact: true }).click();
  await page.getByRole('button', { name: /^주문 \d+건/ }).click();
  await expect(page.locator('.owner-order-card')).toContainText('재시도 후 최신 주문');
  await page.screenshot({ path: testInfo.outputPath('owner-history-recovered.png'), fullPage: true });
});

test('공개 목록과 로컬 저장소에 다른 사장님 상품·주문이 있어도 현재 관리 목록으로 가져오지 않는다', async ({ page }) => {
  const own = deal(OWN_ID, '내 관리 권한 상품');
  const foreign = deal(FOREIGN_ID, '다른 사장님 비공개 관리 이력');
  const ownOrder = order('order-history-own', own, '내 관리 권한 주문');
  const foreignOrder = order('order-history-foreign', foreign, '다른 사장님 주문');
  await seedOwner(page, {
    capabilities: { [OWN_ID]: OWN_CAPABILITY, [FOREIGN_ID]: FOREIGN_CAPABILITY },
    scopes: { [OWN_ID]: 'phone:01011112222', [FOREIGN_ID]: 'phone:01033334444' },
    created: [foreign], localOrders: [foreignOrder],
  });
  const reads = await mockWorkspace(page, { ownedDeals: [own], ownedOrders: [ownOrder], publicDeals: [own, foreign] });
  await page.goto('/owner');
  await expect.poll(() => reads.length).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: '상품 관리', exact: true }).click();
  await expect(page.locator('.owner-product-card')).toHaveCount(1);
  await expect(page.locator('.owner-product-card')).toContainText('내 관리 권한 상품');
  await expect(page.locator('.owner-product-card')).not.toContainText('다른 사장님');
  // A newly created current-scope key must not hide the existing-scope hint.
  await expect(page.getByText('기존 사장님 상품 1개를 확인했습니다', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '기존 번호로 연결', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '사장님 홈', exact: true }).click();
  await page.getByRole('button', { name: /^주문 \d+건/ }).click();
  await expect(page.locator('.owner-order-card')).toHaveCount(1);
  await expect(page.locator('.owner-order-card')).toContainText('내 관리 권한 주문');
  await expect(page.locator('.owner-order-card')).not.toContainText('다른 사장님 주문');
  expect(reads.flatMap((read) => read.capabilities).every((entry) => entry.dealId === OWN_ID)).toBe(true);
});
