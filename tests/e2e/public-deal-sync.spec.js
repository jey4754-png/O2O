import { expect, test } from '@playwright/test';
import { publicDealSyncFingerprint } from '../../src/publicDealSync.js';

const OWNER_SCOPE = 'phone:01011112222';
const OWNER_TOKEN = 'synthetic-public-sync-owner-capability-long-enough';

async function ownerSyncFixture(page, { legacyAcknowledgement = false } = {}) {
  const local = {
    id: 'owner-local-only-publish', source: 'merchant', saleType: 'instant', visibility: 'public',
    title: '이 브라우저에 남은 기존 상품', category: '음식·간편식', store: '게시 검증 매장',
    region: '경기도', district: '성남시 분당구', neighborhood: '판교동',
    originalPrice: 10000, discountRate: 10, totalQuantity: 5, target: 5,
    orderedQuantity: 0, methods: ['픽업'], address: '합성 테스트 매장', menu: [],
    publishVersion: 0, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  };
  await page.addInitScript(({ deal, token, scope, fingerprint }) => {
    if (!localStorage.getItem('synthetic-owner-sync-seeded')) {
      const profile = { name: '게시 상태 검증', phone: '010-1111-2222', testerType: '사장님',
        consent: true, region: '경기도', district: '성남시 분당구', neighborhood: '판교동' };
      localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
      localStorage.setItem('o2o_mvp_created_deals', JSON.stringify([deal]));
      localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify({ [deal.id]: token }));
      localStorage.setItem('o2o_mvp_owner_deal_scopes_v1', JSON.stringify({ [deal.id]: scope }));
      localStorage.setItem('o2o_mvp_public_deal_sync_fingerprints', JSON.stringify(fingerprint ? { [deal.id]: fingerprint } : {}));
      localStorage.setItem('synthetic-owner-sync-seeded', 'true');
    }
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사장님:01011112222', startedAt: Date.now(),
    }));
  }, { deal: local, token: OWNER_TOKEN, scope: OWNER_SCOPE,
    fingerprint: legacyAcknowledgement ? publicDealSyncFingerprint(local) : '' });
  const state = { central: [], publishes: [], ownerReads: 0, publicReads: 0, rejection: 'invalid_deal' };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() || {};
    if (path === '/api/public-deals') {
      if (body.action === 'publish') {
        state.publishes.push(body);
        if (state.rejection) return route.fulfill({ status: 400, json: { ok: false, error: state.rejection } });
        const { expectedPublishVersion, publishMutationId, ...published } = body.deal;
        state.central = [{ ...published, publishVersion: Number(published.publishVersion || 0) + 1 }];
        return route.fulfill({ status: 202, json: { ok: true, deal: state.central[0] } });
      }
      if (body.action === 'list_owner') state.ownerReads += 1;
      else state.publicReads += 1;
      return route.fulfill({ json: { ok: true, deals: state.central } });
    }
    return route.fulfill({ json: { ok: true, orders: [], deals: [], stats: {}, unreadCounts: {} } });
  });
  const readSaved = () => page.evaluate(() => ({
    deals: JSON.parse(localStorage.getItem('o2o_mvp_created_deals') || '[]'),
    acknowledgements: JSON.parse(localStorage.getItem('o2o_mvp_public_deal_sync_fingerprints') || '{}'),
    issues: JSON.parse(localStorage.getItem('o2o_mvp_public_deal_sync_issues_v1') || '{}'),
    capabilities: JSON.parse(localStorage.getItem('o2o_mvp_public_deal_capabilities_v1') || '{}'),
    scopes: JSON.parse(localStorage.getItem('o2o_mvp_owner_deal_scopes_v1') || '{}'),
  }));
  return { local, state, readSaved };
}

async function openOwnerProducts(page, fixture) {
  await page.goto('/owner');
  await expect.poll(() => fixture.state.ownerReads).toBeGreaterThan(0);
  await page.getByRole('button', { name: '상품 관리', exact: true }).click();
  await expect(page.locator('.owner-product-card')).toHaveCount(1);
  await expect(page.getByText('이 관리키로 서버에 게시된 상품·주문을 확인하지 못했습니다. 이 브라우저의 기록은 유지합니다.', { exact: true })).toBeVisible();
}

test('거절된 로컬 상품은 성공 처리나 반복 게시 없이 보존하고 원래 ID의 수정을 허용한다', async ({ page }, testInfo) => {
  const fixture = await ownerSyncFixture(page);
  const { local, state, readSaved } = fixture;
  await openOwnerProducts(page, fixture);
  const card = page.locator('.owner-product-card');
  await expect(card.locator('[data-state="rejected"]')).toContainText('중앙 게시 미확인');
  await expect(card).toContainText('서버에서 상품 저장을 거절했습니다.');
  expect(state.publishes).toHaveLength(1);
  const rejected = await readSaved();
  expect(rejected.acknowledgements[local.id]).toBeUndefined();
  expect(rejected.issues[local.id]).toMatchObject({ state: 'rejected', code: 'invalid_deal', status: 400 });
  expect(rejected.deals).toEqual([local]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = state.publicReads;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => state.publicReads).toBeGreaterThan(before);
    expect(state.publishes).toHaveLength(1);
  }
  await page.reload();
  await page.getByRole('button', { name: '상품 관리', exact: true }).click();
  await expect(card.locator('[data-state="rejected"]')).toBeVisible();
  expect(state.publishes).toHaveLength(1);
  const preserved = await readSaved();
  expect(preserved.capabilities).toEqual({ [local.id]: OWNER_TOKEN });
  expect(preserved.scopes).toEqual({ [local.id]: OWNER_SCOPE });
  expect(preserved.deals).toEqual([local]);
  await page.screenshot({ path: testInfo.outputPath('owner-central-unconfirmed.png'), fullPage: true });

  state.rejection = '';
  await card.getByRole('button', { name: '수정', exact: true }).click();
  await page.getByLabel('상품명', { exact: true }).fill('원래 상품의 확인된 수정');
  await page.getByRole('button', { name: '상품 수정 완료', exact: true }).click();
  await expect(page.getByRole('heading', { name: '등록 완료', exact: true })).toBeVisible();
  expect(state.publishes).toHaveLength(2);
  expect(state.publishes[1]).toMatchObject({ capabilityToken: OWNER_TOKEN,
    deal: { id: local.id, expectedPublishVersion: 0 } });
  const saved = await readSaved();
  expect(saved.deals).toHaveLength(1);
  expect(saved.deals[0]).toMatchObject({ id: local.id, title: '원래 상품의 확인된 수정', publishVersion: 1 });
  expect(saved.acknowledgements[local.id]).toBe(publicDealSyncFingerprint(saved.deals[0]));
  expect(saved.issues[local.id]).toBeUndefined();
  expect(saved.capabilities).toEqual(preserved.capabilities);
  expect(saved.scopes).toEqual(preserved.scopes);
  await page.goto('/owner');
  await page.getByRole('button', { name: '상품 관리', exact: true }).click();
  await expect(card.locator('[data-state="confirmed"]')).toHaveText('중앙 게시 확인');
  expect(state.publishes).toHaveLength(2);
});

test('과거의 모호한 게시 표식과 로컬 카드만으로 중앙 게시·관리 이력이 확인되었다고 표시하지 않는다', async ({ page }) => {
  const fixture = await ownerSyncFixture(page, { legacyAcknowledgement: true });
  await openOwnerProducts(page, fixture);
  await expect(page.locator('.owner-product-card [data-state="unconfirmed"]')).toContainText('중앙 게시 미확인');
  await expect(page.locator('.owner-product-card')).toContainText('같은 상품으로 다시 저장할 수 있습니다.');
  expect(fixture.state.publishes).toHaveLength(0);
  const before = fixture.state.publicReads;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => fixture.state.publicReads).toBeGreaterThan(before);
  const saved = await fixture.readSaved();
  expect(saved.deals).toEqual([fixture.local]);
  expect(saved.acknowledgements[fixture.local.id]).toBe(publicDealSyncFingerprint(fixture.local));
  expect(fixture.state.publishes).toHaveLength(0);
});

for (const { centrallyPublished, legacyMigration } of [
  { centrallyPublished: true, legacyMigration: false },
  { centrallyPublished: false, legacyMigration: false },
  { centrallyPublished: false, legacyMigration: true },
]) {
  test(`그룹방 관찰은 ${centrallyPublished ? '중앙 게시 확인된' : legacyMigration ? '자동 정규화된 과거 로컬' : '중앙 게시 미확인인'} 기존 상품을 새 게시 요청으로 바꾸지 않는다`, async ({ page }) => {
    const actorId = 'visitor-public-observation';
    const local = { id: 'customer-room-observation', source: 'customer', saleType: 'community', visibility: 'public',
      title: '중앙 관찰과 게시 구분', category: '음식·간편식',
      region: '경기도', district: '성남시 분당구', neighborhood: '판교동',
      originalPrice: 5000, discountRate: 0, publishVersion: centrallyPublished ? 1 : 0,
      target: 5, targetCount: 5, targetPeople: 5, current: 1, currentCount: 1, currentPeople: 1,
      totalQuantity: 5, productQuantity: 5, orderedQuantity: 1, allocatedProductQuantity: 1,
      participantCount: 1, creatorQuantity: 1, creatorProductQuantity: 1,
      hostMode: 'self', hostMatched: true, hostActorId: actorId, creatorActorId: actorId,
      groupStatus: 'recruiting', version: 1, methods: ['픽업'], menu: [],
      quantityTracking: true, unitPrice: 1000, unitRemainder: 0,
      updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' };
    if (legacyMigration) {
      delete local.quantityTracking;
      delete local.unitPrice;
      delete local.unitRemainder;
    }
    const fingerprint = publicDealSyncFingerprint(local);
    await page.addInitScript(({ deal, actorId, fingerprint }) => {
      localStorage.setItem('o2o_mvp_profile', JSON.stringify({ name: '그룹 관찰 검증', phone: '010-1111-2222',
        testerType: '사용자', consent: true, region: '경기도', district: '성남시 분당구', neighborhood: '판교동' }));
      localStorage.setItem('o2o_mvp_visitor_id', actorId);
      localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([deal]));
      localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify({ [deal.id]: 'synthetic-observation-owner-capability-long-enough' }));
      localStorage.setItem('o2o_mvp_public_deal_sync_fingerprints', JSON.stringify({ [deal.id]: fingerprint }));
      localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({ [`${deal.id}::${actorId}`]: {
        groupId: deal.id, actorId, role: 'host', active: true,
        capabilityToken: 'synthetic-observation-group-capability-long-enough', credentialRevision: 1,
      } }));
      sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
        profileKey: '사용자:01011112222', startedAt: Date.now(),
      }));
    }, { deal: local, actorId, fingerprint });
    let publicReads = 0;
    let publishes = 0;
    let observedCount = 2;
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON() || {};
      if (path === '/api/public-deals') {
        if (body.action === 'publish') {
          publishes += 1;
          return route.fulfill({ status: 400, json: { ok: false, error: 'unexpected_observation_publish' } });
        }
        publicReads += 1;
        return route.fulfill({ json: { ok: true, deals: centrallyPublished ? [local] : [] } });
      }
      if (path === '/api/group-ops' && body.action === 'snapshot') {
        return route.fulfill({ json: { ok: true, snapshot: {
          group: { id: local.id, dealId: local.id, status: 'recruiting', targetCount: 5,
            currentCount: observedCount, orderedQuantity: observedCount, totalQuantity: 5,
            hostActorId: actorId, creatorActorId: actorId, hostMode: 'self', version: observedCount,
            lastMessageSeq: 0, updatedAt: '2026-09-10T00:00:00Z' },
          participants: [{ actorId, role: 'host', counted: true, selectedQuantity: 1, paymentStatus: 'pending', version: 1 }],
          messages: [], history: [], lastSeq: 0, viewer: { actorId, role: 'host', active: true },
        } } });
      }
      return route.fulfill({ json: { ok: true, deals: [], orders: [], unreadCounts: {}, stats: {} } });
    });
    await page.goto(`/customer?group=${local.id}&view=room`);
    await expect(page.locator('.group-room-screen .room-nav')).toContainText(local.title);
    const savedState = () => page.evaluate(() => ({
      deal: JSON.parse(localStorage.getItem('o2o_mvp_customer_groups'))[0],
      acknowledgements: JSON.parse(localStorage.getItem('o2o_mvp_public_deal_sync_fingerprints') || '{}'),
      issues: JSON.parse(localStorage.getItem('o2o_mvp_public_deal_sync_issues_v1') || '{}'),
    }));
    await expect.poll(async () => (await savedState()).deal.currentCount).toBe(2);
    let saved = await savedState();
    if (centrallyPublished) {
      expect(saved.acknowledgements[local.id]).toBe(publicDealSyncFingerprint(saved.deal));
    } else {
      expect(saved.acknowledgements[local.id]).toBe(fingerprint);
      expect(saved.issues[local.id]).toMatchObject({ state: 'unconfirmed', fingerprint: publicDealSyncFingerprint(saved.deal) });
    }
    expect(publishes).toBe(0);
    observedCount = 3;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(async () => (await savedState()).deal.currentCount).toBe(3);
    const before = publicReads;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => publicReads).toBeGreaterThan(before);
    saved = await savedState();
    expect(publishes).toBe(0);
    if (!centrallyPublished) expect(saved.acknowledgements[local.id]).toBe(fingerprint);
    expect(saved.deal).toMatchObject({ id: local.id, title: local.title, creatorQuantity: 1 });
  });
}

test('공개 상품 동기화는 로컬 생성자 필드를 보존하고 재조회에서 반복 게시하지 않는다', async ({ page }) => {
  const local = { id: 'customer-local-creator-sync', source: 'customer', saleType: 'group', visibility: 'public',
    title: '게시 동기화 검증 그룹', originalPrice: 5000, discountRate: 0, publishVersion: 1,
    region: '경기도', district: '성남시 분당구', neighborhood: '판교동', category: '음식·간편식',
    creatorQuantity: 1, creatorProductQuantity: 1, targetPeople: 5, target: 5,
    totalQuantity: 5, productQuantity: 5, currentPeople: 1, currentCount: 1, participantCount: 1,
    orderedQuantity: 1, allocatedProductQuantity: 1, hostMode: 'self', hostMatched: true,
    image: 'https://example.test/sync.jpg', methods: ['픽업'], menu: [],
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
  await page.addInitScript((deal) => {
    localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify({
      [deal.id]: 'synthetic-customer-sync-capability-long-enough',
    }));
  }, local);
  const publishes = [];
  let currentCentral = null;
  let listReads = 0;
  await page.route('https://example.test/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const body = route.request().postDataJSON() || {};
    if (new URL(route.request().url()).pathname === '/api/public-deals') {
      if (body.action === 'publish') {
        publishes.push(body.deal);
        const { creatorQuantity, creatorProductQuantity, targetPeople, currentPeople,
          expectedPublishVersion, publishMutationId, ...central } = body.deal;
        currentCentral = { ...central, publishVersion: Number(central.publishVersion) + 1,
          syncedAt: '2026-09-10T00:00:00Z' };
        return route.fulfill({ json: { ok: true, deal: currentCentral } });
      }
      listReads += 1;
      return route.fulfill({ json: { ok: true, deals: currentCentral ? [currentCentral] : [] } });
    }
    return route.fulfill({ json: { ok: true, deals: [], orders: [], stats: {}, unreadCounts: {} } });
  });
  const cacheIsAcknowledged = () => page.evaluate(() => {
    const deal = JSON.parse(localStorage.getItem('o2o_mvp_customer_groups'))[0];
    const fingerprints = JSON.parse(localStorage.getItem('o2o_mvp_public_deal_sync_fingerprints') || '{}');
    const { syncedAt, ...content } = deal;
    return fingerprints[deal.id] === JSON.stringify({ imageSyncVersion: 2, ...content });
  });
  await page.goto('/customer');
  await expect(page.getByLabel('이름', { exact: true })).toBeVisible();
  await page.evaluate((deal) => {
    const key = 'o2o_mvp_customer_groups';
    const newValue = JSON.stringify([deal]);
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
  }, local);
  await expect.poll(() => publishes.length).toBe(1);
  await expect.poll(cacheIsAcknowledged).toBe(true);
  for (let index = 0; index < 3; index += 1) {
    const previousReads = listReads;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => listReads).toBeGreaterThan(previousReads);
    await expect.poll(cacheIsAcknowledged).toBe(true);
    expect(publishes).toHaveLength(1);
  }
  // A genuine edit arriving from another tab must still be published.
  await page.evaluate(() => {
    const key = 'o2o_mvp_customer_groups';
    const groups = JSON.parse(localStorage.getItem(key));
    groups[0].title = '실제 미게시 변경';
    const newValue = JSON.stringify(groups);
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
  });
  await expect.poll(() => publishes.length).toBe(2);
  await expect.poll(cacheIsAcknowledged).toBe(true);
  expect(publishes[1].title).toBe('실제 미게시 변경');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_customer_groups'))[0]);
  expect(saved).toMatchObject({ creatorQuantity: 1, creatorProductQuantity: 1, targetPeople: 5,
    title: '실제 미게시 변경', publishVersion: 3 });
});
