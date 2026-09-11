import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import publicDealsHandler from '../../api/public-deals.js';
import customerOrdersHandler from '../../api/customer-orders.js';
import { adminStore } from '../helpers/admin-store.js';
import { imageResponse } from '../helpers/product-image-store.js';

const OWNER_TOKEN = 'synthetic-owner-edit-capability-for-browser-regression';
const OWNER_HASH = createHash('sha256').update(OWNER_TOKEN).digest('hex');
const CURRENT_TITLE = '중앙 최신 상품 버전 3';

async function setupOwnerEditor(page) {
  const { context, publicDeals, data, dealId } = adminStore();
  data.customerOrders.rows.splice(1);
  data.groupParticipants.rows.splice(1);
  data.groupHistory.rows.splice(1);
  const canonical = {
    id: dealId, source: 'merchant', saleType: 'group', visibility: 'public',
    title: CURRENT_TITLE, category: '음식·간편식', store: '첫 수정 검증 매장',
    region: '경기도', district: '성남시 분당구', neighborhood: '판교동',
    originalPrice: 10000, discountRate: 0, target: 10, targetCount: 5,
    totalQuantity: 10, productQuantity: 10, stock: 10, orderedQuantity: 0,
    current: 0, currentCount: 0, participantCount: 0, allocatedProductQuantity: 0,
    pricingModel: 'explicit_split', pricingVersion: 2, splitPricing: false,
    splitQuantity: 1, expectedPerPerson: 10000, unitPrice: 10000,
    splitRemainder: 0, unitRemainder: 0, approximatePrice: false,
    groupId: dealId, groupStatus: 'recruiting', version: 7, stateVersion: 7,
    hostMode: 'recruiting', hostMatched: false, hostActorId: '',
    address: '합성 테스트 픽업 장소', methods: ['픽업'], deadline: '2026-09-30 20:00',
    image: 'https://example.test/owner-edit-fixture.svg',
    menu: [{ id: 'owner-menu-1', name: CURRENT_TITLE, price: 10000, option: '픽업' }],
    publishVersion: 3, createdAt: '2026-08-27T00:00:00.000Z',
    syncedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
    _ownerCapabilityHash: OWNER_HASH,
  };
  publicDeals.rows[1][6] = JSON.stringify(canonical);
  data.groups.rows[1] = [dealId, dealId, CURRENT_TITLE, 'recruiting', 5, false, '', 0, 7,
    '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', '', '', 'recruiting', 10];
  context.cachedPublicDeals_ = () => null;
  context.cachePublicDeals_ = () => {};
  context.invalidateGroupSnapshot_ = () => {};

  // Reproduce a legitimate old local snapshot whose updatedAt is newer than
  // the central public projection's group.updatedAt, but whose product CAS is old.
  const staleLocal = { ...context.publicDealValue_(canonical), title: '오래된 로컬 상품 버전 1',
    publishVersion: 1, version: 1, stateVersion: 1,
    updatedAt: '2026-09-09T00:00:00.000Z', syncedAt: '2026-08-28T00:00:00.000Z' };
  const projection = context.getPublicDeals_()[0];
  expect(projection.publishVersion).toBe(3);
  expect(projection.updatedAt).toBe('2026-08-27T00:00:00.000Z');
  expect(Date.parse(staleLocal.updatedAt)).toBeGreaterThan(Date.parse(projection.updatedAt));
  const { syncedAt: _syncedAt, ...fingerprintContent } = staleLocal;
  await page.addInitScript(({ deal, token, fingerprint }) => {
    const profile = { name: '첫 수정 회귀 검증', phone: '010-1111-2222', testerType: '사장님',
      consent: true, region: '경기도', district: '성남시 분당구', neighborhood: '판교동' };
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
    localStorage.setItem('o2o_mvp_created_deals', JSON.stringify([deal]));
    localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify({ [deal.id]: token }));
    localStorage.setItem('o2o_mvp_owner_deal_scopes_v1', JSON.stringify({ [deal.id]: 'phone:01011112222' }));
    localStorage.setItem('o2o_mvp_public_deal_sync_fingerprints', JSON.stringify({ [deal.id]: fingerprint }));
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({ profileKey: '사장님:01011112222', startedAt: Date.now() }));
  }, { deal: staleLocal, token: OWNER_TOKEN, fingerprint: JSON.stringify({ imageSyncVersion: 2, ...fingerprintContent }) });

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = context.doPost({ postData: { contents: Buffer.concat(chunks).toString() } });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const keys = ['O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { O2O_DATA_API_ORIGIN: '', O2O_DATA_API_TOKEN: '',
    GOOGLE_SHEETS_COLLECTOR_URL: `http://127.0.0.1:${server.address().port}`, GOOGLE_SHEETS_COLLECTOR_TOKEN: 'REPLACE_WITH_RANDOM_TOKEN' });
  const publishes = [];
  const ownerReads = [];
  await page.route('https://example.test/**', (route) => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#287c76"/></svg>' }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const handler = path === '/api/public-deals' ? publicDealsHandler
      : path === '/api/customer-orders' ? customerOrdersHandler : null;
    if (!handler) return route.fulfill({ json: { ok: true, deals: [], orders: [], unreadCounts: {}, stats: {} } });
    const body = route.request().postDataJSON() || {};
    const response = imageResponse();
    await handler({ method: 'POST', headers: { origin: 'http://127.0.0.1:4187' }, body }, response);
    if (body.action === 'publish') publishes.push({ request: body, status: response.statusCode, result: response.body });
    if (path === '/api/public-deals' && body.action === 'list_owner') ownerReads.push(response.body);
    await route.fulfill({ status: response.statusCode, headers: response.headers, json: response.body });
  });
  return {
    context, publicDeals, data, dealId, canonical, publishes, ownerReads,
    async close() {
      // Stop polling before dismantling the isolated collector; never let a
      // trailing browser request escape the synthetic API routes.
      await page.close();
      await new Promise((resolve) => server.close(resolve));
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    },
  };
}

async function openCurrentEditor(page, fixture) {
  await page.goto('/owner');
  await expect.poll(() => fixture.ownerReads.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '상품 관리', exact: true }).click();
  const card = page.locator('.owner-product-card').filter({ hasText: CURRENT_TITLE });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: '수정', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: '수정', exact: true }).click();
  await expect(page.getByLabel('상품명', { exact: true })).toHaveValue(CURRENT_TITLE);
  // A background sync of the stale local row would itself be a regression.
  expect(fixture.publishes).toHaveLength(0);
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.name === 'mobile', hasTouch: viewport.name === 'mobile' });

    test('사장님 첫 수정은 오래된 로컬 날짜보다 중앙 상품 버전을 우선하여 한 번에 저장된다', async ({ page }, testInfo) => {
      const f = await setupOwnerEditor(page);
      try {
        await openCurrentEditor(page, f);
        await page.getByLabel('상품명', { exact: true }).fill('첫 클릭에 저장한 상품');
        await page.getByRole('button', { name: '상품 수정 완료', exact: true }).click();
        await expect(page.getByRole('heading', { name: '등록 완료', exact: true })).toBeVisible();
        expect(f.publishes).toHaveLength(1);
        expect(f.publishes[0]).toMatchObject({ status: 202, request: { deal: { expectedPublishVersion: 3 } },
          result: { ok: true, deal: { publishVersion: 4, title: '첫 클릭에 저장한 상품' } } });
        const stored = JSON.parse(f.publicDeals.rows[1][6]);
        expect(stored).toMatchObject({ publishVersion: 4, title: '첫 클릭에 저장한 상품', _ownerCapabilityHash: OWNER_HASH });
        expect(f.publicDeals.rows).toHaveLength(2);
        await page.screenshot({ path: testInfo.outputPath('owner-first-edit-success.png'), fullPage: true });
      } finally { await f.close(); }
    });

    test('편집 중 실제 경쟁 수정이 생기면 최신 목록을 받아도 기존 편집 버전으로 충돌을 차단한다', async ({ page }, testInfo) => {
      const f = await setupOwnerEditor(page);
      try {
        await openCurrentEditor(page, f);
        await page.getByLabel('상품명', { exact: true }).fill('덮어쓰면 안 되는 내 편집');
        const competing = f.context.publishPublicDeal_({ ...f.canonical, title: '다른 창에서 먼저 저장한 상품',
          expectedPublishVersion: 3, publishMutationId: 'competing-owner-edit-001' }, OWNER_HASH);
        expect(competing.ok).toBe(true);
        expect(competing.deal.publishVersion).toBe(4);
        const readCount = f.ownerReads.length;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => f.ownerReads.length).toBeGreaterThan(readCount);
        expect(f.ownerReads.at(-1).deals[0].publishVersion).toBe(4);
        await page.getByRole('button', { name: '상품 수정 완료', exact: true }).click();
        await expect(page.getByRole('alert')).toHaveText('다른 창에서 상품이 변경되었습니다. 입력 내용은 유지됩니다. 등록 상품 관리에서 최신 내용을 확인한 뒤 다시 수정해 주세요.');
        await expect(page.getByLabel('상품명', { exact: true })).toHaveValue('덮어쓰면 안 되는 내 편집');
        await expect(page.getByRole('heading', { name: '등록 완료', exact: true })).toHaveCount(0);
        expect(f.publishes).toHaveLength(1);
        expect(f.publishes[0]).toMatchObject({ status: 409, request: { deal: { expectedPublishVersion: 3 } },
          result: { ok: false, error: 'state_conflict', currentPublishVersion: 4 } });
        expect(JSON.parse(f.publicDeals.rows[1][6])).toMatchObject({ publishVersion: 4, title: '다른 창에서 먼저 저장한 상품' });
        await page.screenshot({ path: testInfo.outputPath('owner-real-conflict-preserved.png'), fullPage: true });
      } finally { await f.close(); }
    });

    test('중앙 기록이 없는 상품의 수정 충돌은 기록 확인을 안내하고 입력과 원래 저장 버전을 보존한다', async ({ page }, testInfo) => {
      const f = await setupOwnerEditor(page);
      try {
        await openCurrentEditor(page, f);
        const before = await page.evaluate(() => ({
          capabilities: localStorage.getItem('o2o_mvp_public_deal_capabilities_v1'),
          scopes: localStorage.getItem('o2o_mvp_owner_deal_scopes_v1'),
          deals: localStorage.getItem('o2o_mvp_created_deals'),
        }));
        // Only the isolated collector fixture loses its public record. The
        // original editor still holds the last acknowledged product version.
        f.publicDeals.rows.splice(1);
        await page.getByLabel('상품명', { exact: true }).fill('중앙 확인이 필요한 기존 입력');
        await page.getByRole('button', { name: '상품 수정 완료', exact: true }).click();
        await expect(page.getByRole('alert')).toHaveText('서버에서 이 상품의 중앙 저장 기록을 확인하지 못했습니다. 입력 내용은 유지됩니다. 관리자에게 기록 확인을 요청해 주세요.');
        await expect(page.getByLabel('상품명', { exact: true })).toHaveValue('중앙 확인이 필요한 기존 입력');
        await expect(page.getByRole('heading', { name: '등록 완료', exact: true })).toHaveCount(0);
        expect(f.publishes).toHaveLength(1);
        expect(f.publishes[0]).toMatchObject({ status: 409,
          request: { capabilityToken: OWNER_TOKEN, deal: { id: f.dealId, expectedPublishVersion: 3 } },
          result: { ok: false, error: 'state_conflict', currentPublishVersion: 0 } });
        expect(Object.keys(f.publishes[0].result).sort()).toEqual(['currentPublishVersion', 'error', 'ok']);
        expect(f.publicDeals.rows).toHaveLength(1);
        expect(await page.evaluate(() => ({
          capabilities: localStorage.getItem('o2o_mvp_public_deal_capabilities_v1'),
          scopes: localStorage.getItem('o2o_mvp_owner_deal_scopes_v1'),
          deals: localStorage.getItem('o2o_mvp_created_deals'),
        }))).toEqual(before);
        await page.screenshot({ path: testInfo.outputPath('owner-missing-central-record.png'), fullPage: true });
      } finally { await f.close(); }
    });
  });
}
