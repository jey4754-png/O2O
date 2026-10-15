import { expect, test } from '@playwright/test';

// 2026-10-15 고객 재검수 2·3번.
// 2) 되살린 경기미 방: 자격은 원래 참여자ID(actor-old) 밑에 있는데 상세 화면이 이 기기
//    방문자ID 로만 찾아, 채팅 버튼 대신 '모집 종료'만 보였다(휴대폰·PC 동일).
// 3) 사장님 첫 화면: 목록 요청이 실패했는데 상단에 '주문 0건'이 떠 연동이 안 되는 것으로 읽혔다.
const PROFILE = {
  name: '되살린 방 검증', phone: '010-1111-2222', testerType: '사용자', consent: true,
  region: '경기도', district: '성남시 분당구', neighborhood: '판교동',
};
const ROOM = 'customer-recovered-rice-room';
const OLD_ACTOR = 'actor-old-laptop-0001';
const THIS_BROWSER = 'actor-this-browser-0001';
const CUSTOMER_TOKEN = 'device-customer-capability-token-00000000002';

const fullRoom = {
  id: ROOM, groupId: ROOM, source: 'customer', saleType: 'community', visibility: 'public',
  title: '경기미 20kg 되살린 방', category: '음식·간편식',
  region: '경기도', district: '성남시 분당구', neighborhood: '판교동',
  originalPrice: 65050, discountRate: 0, publishVersion: 1,
  target: 2, targetCount: 2, targetPeople: 2, current: 2, currentCount: 2, currentPeople: 2,
  totalQuantity: 2, productQuantity: 2, orderedQuantity: 2, allocatedProductQuantity: 2,
  participantCount: 2, creatorQuantity: 1, hostMode: 'self', hostMatched: true,
  hostActorId: OLD_ACTOR, creatorActorId: OLD_ACTOR, groupStatus: 'recruiting', version: 3,
  methods: ['픽업'], menu: [{ name: '경기미 20kg(10kg+10kg)', price: 65050 }], store: '판교동 공동구매',
  pickupPlace: '판교역', quantityTracking: true, unitPrice: 32525, unitRemainder: 0,
  updatedAt: '2026-09-15T00:00:00Z', createdAt: '2026-09-10T00:00:00Z',
};

test('되살린 자격만 있는 정원 찬 방도 상세에서 채팅 버튼이 보이고 원래 참여자로 연다', async ({ page }) => {
  await page.addInitScript(({ profile, room, oldActor, thisBrowser, token }) => {
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
    localStorage.setItem('o2o_mvp_visitor_id', thisBrowser);
    localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([room]));
    localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({ [`${room.id}::${oldActor}`]: {
      groupId: room.id, actorId: oldActor, role: 'member', recovered: true, active: true,
      capabilityToken: token, credentialRevision: 1,
    } }));
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사용자:01011112222', startedAt: Date.now(),
    }));
  }, { profile: PROFILE, room: fullRoom, oldActor: OLD_ACTOR, thisBrowser: THIS_BROWSER, token: CUSTOMER_TOKEN });
  const snapshots = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch { /* GET */ }
    if (path === '/api/public-deals' && route.request().method() === 'GET') {
      return route.fulfill({ json: { ok: true, deals: [fullRoom] } });
    }
    if (path === '/api/group-ops' && body.action === 'snapshot') {
      snapshots.push({ actorId: body.actorId, capabilityToken: body.capabilityToken });
      return route.fulfill({ json: { ok: true, snapshot: {
        group: { id: ROOM, dealId: ROOM, status: 'recruiting', targetCount: 2, currentCount: 2,
          orderedQuantity: 2, totalQuantity: 2, hostActorId: OLD_ACTOR, creatorActorId: OLD_ACTOR,
          hostMode: 'self', version: 3, lastMessageSeq: 0, updatedAt: '2026-09-15T00:00:00Z' },
        participants: [
          { actorId: OLD_ACTOR, role: 'host', counted: true, selectedQuantity: 1, paymentStatus: 'requested', version: 2 },
          { actorId: 'actor-other-member', role: 'member', counted: true, selectedQuantity: 1, paymentStatus: 'pending', version: 1 },
        ],
        messages: [], history: [], lastSeq: 0, viewer: { actorId: OLD_ACTOR, role: 'host', active: true },
      } } });
    }
    return route.fulfill({ json: { ok: true, deals: [], orders: [], unreadCounts: {}, stats: {} } });
  });

  await page.goto(`/customer?group=${ROOM}`);
  // 정원이 찼으니 참여 버튼은 '모집 종료'가 맞다. 그래도 이미 참여한 사람의 채팅 입구는 있어야 한다.
  await expect(page.locator('.sticky-actions')).toBeVisible();
  await expect(page.locator('.sticky-actions').getByRole('button', { name: /모집 종료/ })).toBeVisible();
  const chat = page.locator('.room-entry-button');
  await expect(chat).toBeVisible();
  await chat.click();
  await expect(page.locator('.group-room-screen .room-nav')).toContainText(fullRoom.title);
  await expect.poll(() => snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every((call) => call.actorId === OLD_ACTOR && call.capabilityToken === CUSTOMER_TOKEN),
    '되살린 자격의 원래 참여자ID 와 그 토큰을 함께 보낸다').toBe(true);
  // 서버가 이 참여자를 host 로 인정했으니 저장된 역할도 host 로 맞춰진다.
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem('o2o_mvp_group_credentials_v1'))[key]?.role,
    `${ROOM}::${OLD_ACTOR}`)).toBe('host');
});

test('되살린 방도 단계가 바뀌면 목록 카드에 새 알림이 뜬다', async ({ page }) => {
  // 모집 완료 배지도 이 기기 방문자ID 로만 자격을 찾아 되살린 방에는 뜨지 않았다.
  const recruitedRoom = { ...fullRoom, groupStatus: 'recruited' };
  await page.addInitScript(({ profile, room, oldActor, thisBrowser, token }) => {
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
    localStorage.setItem('o2o_mvp_visitor_id', thisBrowser);
    localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([room]));
    localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({ [`${room.id}::${oldActor}`]: {
      groupId: room.id, actorId: oldActor, role: 'member', recovered: true, active: true,
      capabilityToken: token, credentialRevision: 1,
    } }));
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사용자:01011112222', startedAt: Date.now(),
    }));
  }, { profile: PROFILE, room: recruitedRoom, oldActor: OLD_ACTOR, thisBrowser: THIS_BROWSER, token: CUSTOMER_TOKEN });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/public-deals' && route.request().method() === 'GET') {
      return route.fulfill({ json: { ok: true, deals: [recruitedRoom] } });
    }
    return route.fulfill({ json: { ok: true, deals: [], orders: [], unreadCounts: {}, stats: {} } });
  });

  await page.goto('/customer');
  const card = page.locator('.deal-card').filter({ hasText: recruitedRoom.title });
  await expect(card).toContainText('새 알림 · 주문 확인');
});

test('사장님 화면에서는 손님 방 배지를 조회하지 않는다', async ({ page }) => {
  // 같은 브라우저에서 사용자·사장님을 오가면 손님 방 자격이 남아 있다. 사장님 화면에서도
  // 그 방들을 계속 조회해 사장님 목록 요청이 밀려 시간 초과됐다(2026-10-15 17:18).
  const ownerProfile = { ...PROFILE, name: '사장님 부하 검증', testerType: '사장님' };
  await page.addInitScript(({ profile, room, oldActor, token }) => {
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
    localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({ [`${room}::${oldActor}`]: {
      groupId: room, actorId: oldActor, role: 'member', active: true, capabilityToken: token, credentialRevision: 1,
    } }));
    localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify({ 'owner-load-product': `owner-${'b'.repeat(64)}` }));
    localStorage.setItem('o2o_mvp_owner_deal_scopes_v1', JSON.stringify({ 'owner-load-product': 'phone:01011112222' }));
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사장님:01011112222', startedAt: Date.now(),
    }));
  }, { profile: ownerProfile, room: ROOM, oldActor: OLD_ACTOR, token: CUSTOMER_TOKEN });
  const snapshots = [];
  let ownerLists = 0;
  await page.route('**/api/**', async (route) => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch { /* GET */ }
    if (body.action === 'snapshot') snapshots.push(body.groupId);
    if (body.action === 'list_owner') ownerLists += 1;
    return route.fulfill({ json: { ok: true, deals: [], orders: [], unreadCounts: {}, stats: {} } });
  });
  await page.goto('/owner');
  await expect.poll(() => ownerLists).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(snapshots, '사장님 화면에서 손님 방 조회가 나가지 않는다').toHaveLength(0);
});

test('사장님 목록을 못 받았을 때 첫 화면에 주문 0건 대신 확인 실패를 보인다', async ({ page }) => {
  const ownerProfile = { ...PROFILE, name: '사장님 실패 표시 검증', testerType: '사장님' };
  await page.addInitScript(({ profile }) => {
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
    localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify({ 'owner-recovered-product': `owner-${'a'.repeat(64)}` }));
    localStorage.setItem('o2o_mvp_owner_deal_scopes_v1', JSON.stringify({ 'owner-recovered-product': 'phone:01011112222' }));
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사장님:01011112222', startedAt: Date.now(),
    }));
  }, { profile: ownerProfile });
  let failing = true;
  await page.route('**/api/**', async (route) => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch { /* GET */ }
    if (body.action === 'list_owner') {
      if (failing) return route.fulfill({ status: 504, json: { ok: false, error: 'upstream_timeout' } });
      return route.fulfill({ json: { ok: true, deals: [], orders: [] } });
    }
    return route.fulfill({ json: { ok: true, deals: [], orders: [], unreadCounts: {}, stats: {} } });
  });
  await page.goto('/owner');
  await expect(page.getByRole('button', { name: /주문 확인 실패/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^주문 0건/ })).toHaveCount(0);
  // 다시 받아지면 실제 건수를 보인다.
  failing = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: /^주문 \d+건/ })).toBeVisible();
});
