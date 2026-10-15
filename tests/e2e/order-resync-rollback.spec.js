import { expect, test } from '@playwright/test';

// 2026-10-15 17:11 운영 기록. 백그라운드 재전송이 이미 서버에 있는 주문을 고치지 못하자
// ('forbidden') 곧바로 그 주문의 자리 예약을 되돌리려 했다. 그때는 자격이 맞지 않아
// 되돌리기도 거절됐지만, 되살린 자격이 인정되면 정상 참여 수량이 줄 수 있다.
// 서버는 주문에 묶인 예약만 막고 예약 표시가 없는 예전 주문은 막지 못한다.
const PROFILE = {
  name: '재전송 되돌리기 검증', phone: '010-1111-2222', testerType: '사용자', consent: true,
  region: '경기도', district: '성남시 분당구', neighborhood: '판교동',
};
const ROOM = 'customer-resync-room';
const ACTOR = 'actor-resync-browser-0001';
const room = {
  id: ROOM, groupId: ROOM, source: 'customer', saleType: 'community', visibility: 'public',
  title: '재전송 검증 방', category: '음식·간편식', region: '경기도', district: '성남시 분당구', neighborhood: '판교동',
  originalPrice: 20000, discountRate: 0, publishVersion: 1, target: 4, targetCount: 4, current: 2, currentCount: 2,
  totalQuantity: 4, productQuantity: 4, hostMode: 'self', groupStatus: 'recruiting', version: 2,
  methods: ['픽업'], menu: [{ name: '검증 상품', price: 20000 }], store: '판교동 공동구매', pickupPlace: '판교역',
  quantityTracking: true, unitPrice: 5000, updatedAt: '2026-09-15T00:00:00Z', createdAt: '2026-09-10T00:00:00Z',
};
const order = {
  id: 'order-1760000000001', type: 'purchase', dealId: ROOM, groupId: ROOM, deal: room,
  title: room.title, store: room.store, quantity: 1, selectedCount: 1, total: 5000, unitPrice: 5000,
  status: 'new', paymentStatus: 'pending', version: 1, paymentVersion: 1,
  visitorId: ACTOR, participantActorId: ACTOR, customerPhone: PROFILE.phone, customerName: PROFILE.name,
  reservationMutationId: 'join-resync-reservation-0001', clientMutationId: 'join-resync-reservation-0001',
  createdAt: '2026-09-15T00:00:00Z',
};

async function openWithRejectedPublish(page, publishError) {
  await page.addInitScript(({ profile, actor, seededOrder, roomId }) => {
    if (sessionStorage.getItem('resync-seeded')) return;
    sessionStorage.setItem('resync-seeded', 'yes');
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
    localStorage.setItem('o2o_mvp_visitor_id', actor);
    localStorage.setItem('o2o_mvp_customer_order_capability_v1', `customer-${'r'.repeat(64)}`);
    localStorage.setItem('o2o_mvp_customer_orders', JSON.stringify([seededOrder]));
    localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({ [`${roomId}::${actor}`]: {
      groupId: roomId, actorId: actor, role: 'member', active: true,
      capabilityToken: `participant-${'p'.repeat(64)}`, credentialRevision: 1,
    } }));
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사용자:01011112222', startedAt: Date.now(),
    }));
  }, { profile: PROFILE, actor: ACTOR, seededOrder: order, roomId: ROOM });
  const calls = { publish: 0, rollback: 0 };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch { /* GET */ }
    if (path === '/api/public-deals' && route.request().method() === 'GET') {
      return route.fulfill({ json: { ok: true, deals: [room] } });
    }
    if (path === '/api/customer-orders' && body.action === 'publish') {
      calls.publish += 1;
      return route.fulfill({ status: publishError.status, json: { ok: false, error: publishError.code } });
    }
    if (path === '/api/group-ops' && body.action === 'rollback_reservation') {
      calls.rollback += 1;
      return route.fulfill({ status: 409, json: { ok: false, error: 'reservation_already_bound' } });
    }
    return route.fulfill({ json: { ok: true, deals: [], orders: [], unreadCounts: {}, stats: {} } });
  });
  await page.goto('/customer');
  await expect.poll(() => calls.publish).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  return calls;
}

test('이미 서버에 있는 주문을 고치지 못한 재전송 실패는 자리 예약을 되돌리지 않는다', async ({ page }) => {
  const calls = await openWithRejectedPublish(page, { status: 403, code: 'forbidden' });
  expect(calls.rollback, '살아 있는 참여 수량을 건드리지 않는다').toBe(0);
});

test('주문이 저장되지 않은 재전송 실패는 예전처럼 자리 예약을 되돌린다', async ({ page }) => {
  const calls = await openWithRejectedPublish(page, { status: 400, code: 'invalid_group_order_binding' });
  expect(calls.rollback).toBeGreaterThan(0);
});
