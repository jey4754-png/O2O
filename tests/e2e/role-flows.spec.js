import { expect, test } from '@playwright/test';

const FALLBACK_PRODUCT_IMAGE =
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=900&q=80';

async function expectBottomNavigationToFillWidth(page, expectedCount) {
  const nav = page.locator('.bottom-nav');
  const buttons = nav.locator('button');
  await expect(buttons).toHaveCount(expectedCount);
  await expect(nav).toHaveCSS('--nav-count', String(expectedCount));

  const geometry = await nav.evaluate((element) => {
    const navBounds = element.getBoundingClientRect();
    const buttonBounds = [...element.querySelectorAll('button')]
      .map((button) => button.getBoundingClientRect());
    return {
      navLeft: navBounds.left,
      navRight: navBounds.right,
      buttonLefts: buttonBounds.map((bounds) => bounds.left),
      buttonRights: buttonBounds.map((bounds) => bounds.right),
      buttonWidths: buttonBounds.map((bounds) => bounds.width),
    };
  });

  expect(geometry.buttonLefts[0]).toBeCloseTo(geometry.navLeft, 0);
  expect(geometry.buttonRights.at(-1)).toBeCloseTo(geometry.navRight, 0);
  geometry.buttonWidths.forEach((width) => {
    expect(width).toBeCloseTo(geometry.buttonWidths[0], 0);
  });
}

async function mockCentralApis(page, {
  failDealDelete = false,
  dealDeleteAlreadyDeleted = false,
  failDealPublish = false,
  dealPublishFailures = [],
  failGroupCreate = false,
  rejectGroupCreateTerminal = false,
  failOrderPublish = false,
  shouldFailOrderPublish = () => false,
  repairAcceptedOrder = (order) => order,
  abortCommittedOrderResponses = false,
  abortOrderReads = false,
  publishAttempts = [],
  requests = [],
  groupState = new Map(),
  missingGroupIds = new Set(),
  legacyRecoveryReceipts = new Map(),
  legacyOwnerRepairUnclaimableIds = new Set(),
  legacyOwnerRepairForbiddenIds = new Set(),
  committedOrders = new Map(),
  paymentTransitionError = '',
} = {}) {
  let dealPublishFailureIndex = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let request = {};
    try {
      request = route.request().postDataJSON() || {};
    } catch {
      request = {};
    }
    requests.push({ path, action: request.action || '', request });
    const dealDeleteFailed = path.endsWith('/public-deals')
      && request.action === 'delete'
      && failDealDelete;
    const isDealPublish = path.endsWith('/public-deals') && request.action === 'publish';
    const plannedDealPublishFailure = isDealPublish
      ? dealPublishFailures[dealPublishFailureIndex] || null
      : null;
    if (isDealPublish) dealPublishFailureIndex += 1;
    const dealPublishFailed = isDealPublish
      && (failDealPublish || Boolean(plannedDealPublishFailure));
    const groupCreateFailed = path.endsWith('/group-ops')
      && request.action === 'create'
      && failGroupCreate;
    const groupCreateRejected = path.endsWith('/group-ops')
      && request.action === 'create'
      && rejectGroupCreateTerminal;
    const dealAlreadyDeleted = path.endsWith('/public-deals')
      && request.action === 'delete'
      && dealDeleteAlreadyDeleted;
    const orderPublishFailed = path.endsWith('/customer-orders')
      && request.action === 'publish'
      && (failOrderPublish || shouldFailOrderPublish(request));
    const groupSnapshotMissing = path.endsWith('/group-ops')
      && request.action === 'snapshot'
      && missingGroupIds.has(request.groupId)
      && !groupState.has(request.groupId);
    const legacyOwnerRepairUnclaimable = path.endsWith('/group-ops')
      && request.action === 'repair_customer_group'
      && legacyOwnerRepairUnclaimableIds.has(request.groupId);
    const legacyOwnerRepairForbidden = path.endsWith('/group-ops')
      && request.action === 'repair_customer_group'
      && legacyOwnerRepairForbiddenIds.has(request.groupId);
    const legacyRecoveryReceipt = request.action === 'recover_legacy_customer_group'
      ? legacyRecoveryReceipts.get(request.legacyEventId)
      : null;
    const legacyRecoveryDenied = path.endsWith('/group-ops')
      && request.action === 'recover_legacy_customer_group'
      && (
        legacyRecoveryReceipt?.groupId !== request.groupId
        || legacyRecoveryReceipt?.actorId !== request.actorId
      );
    const paymentTransitionBlocked = path.endsWith('/group-ops')
      && request.action === 'transition_payment'
      && paymentTransitionError;
    if (path.endsWith('/customer-orders')
      && request.action === 'publish'
      && abortCommittedOrderResponses) {
      if (request.order?.id && !committedOrders.has(request.order.id)) {
        committedOrders.set(request.order.id, request.order);
      }
      await route.abort('connectionreset');
      return;
    }
    if (path.endsWith('/customer-orders')
      && request.action !== 'publish'
      && abortOrderReads) {
      await route.abort('connectionreset');
      return;
    }
    let payload = { ok: true };
    if (request.action === 'publish' && request.deal?.id) {
      publishAttempts.push(request.deal.id);
    }
    if (dealAlreadyDeleted) {
      payload = { ok: false, error: 'deal_deleted' };
    } else if (groupCreateRejected) {
      payload = { ok: false, error: 'state_conflict' };
    } else if (dealDeleteFailed || dealPublishFailed || groupCreateFailed) {
      payload = {
        ok: false,
        error: plannedDealPublishFailure?.error || 'collector_busy',
      };
    } else if (orderPublishFailed) {
      payload = { ok: false, error: 'order_reservation_unverified' };
    } else if (groupSnapshotMissing) {
      payload = { ok: false, error: 'group_not_found' };
    } else if (legacyOwnerRepairUnclaimable) {
      payload = { ok: false, error: 'deal_ownership_unclaimable' };
    } else if (legacyOwnerRepairForbidden) {
      payload = { ok: false, error: 'forbidden' };
    } else if (legacyRecoveryDenied) {
      payload = { ok: false, error: 'legacy_recovery_not_authorized' };
    } else if (paymentTransitionBlocked) {
      payload = { ok: false, error: paymentTransitionError };
    } else if (path.endsWith('/public-deals')) {
      if (request.action === 'publish') {
        const {
          expectedPublishVersion,
          publishMutationId,
          ...storedDeal
        } = request.deal;
        payload = {
          ok: true,
          deal: {
            ...storedDeal,
            publishVersion: Math.max(0, Number(expectedPublishVersion || 0)) + 1,
            syncedAt: new Date().toISOString(),
          },
        };
      } else {
        payload = { ok: true, deals: [] };
      }
    } else if (path.endsWith('/customer-orders')) {
      if (request.action === 'publish') {
        const acceptedOrder = repairAcceptedOrder(request.order);
        if (acceptedOrder?.id && !committedOrders.has(acceptedOrder.id)) {
          committedOrders.set(acceptedOrder.id, acceptedOrder);
        }
        payload = { ok: true, order: committedOrders.get(acceptedOrder?.id) || acceptedOrder };
      } else {
        payload = { ok: true, orders: [...committedOrders.values()] };
      }
    } else if (path.endsWith('/stats')) {
      payload = { ok: true, events: [], surveys: [], orders: [] };
    } else if (path.endsWith('/group-ops')) {
      const groupId = request.groupId || 'mock-group';
      let transitionedOrder = null;
      const state = groupState.get(groupId) || {
        group: {
          groupId,
          status: 'recruiting',
          targetCount: Number(request.targetCount || 5),
          totalQuantity: Number(request.totalQuantity || 10),
          orderedQuantity: 0,
          version: 1,
        },
        participants: [],
        messages: [],
        history: [],
        reservations: new Map(),
        rollbacks: new Set(),
      };
      const participant = state.participants.find((item) => item.actorId === request.actorId);
      if (['create', 'repair_customer_group', 'recover_legacy_customer_group', 'join'].includes(request.action) && !state.reservations.has(request.clientMutationId)) {
        const role = request.action === 'recover_legacy_customer_group'
          ? legacyRecoveryReceipt.role || 'host'
          : ['create', 'repair_customer_group'].includes(request.action)
          ? (request.hostMode === 'recruiting' ? 'creator' : 'host')
          : request.role || 'member';
        const quantity = request.action === 'recover_legacy_customer_group'
          ? Number(legacyRecoveryReceipt.selectedQuantity || 1)
          : Number(request.selectedQuantity || 0);
        state.participants.push({
          actorId: request.actorId,
          role,
          counted: role !== 'admin',
          selectedQuantity: quantity,
          paymentStatus: 'pending',
          version: 1,
        });
        state.group.orderedQuantity += quantity;
        state.group.version += 1;
        state.reservations.set(request.clientMutationId, { action: request.action, quantity });
      } else if (request.action === 'reserve_quantity' && !state.reservations.has(request.clientMutationId)) {
        const quantity = Number(request.quantity || 0);
        if (participant) {
          participant.selectedQuantity += quantity;
          participant.counted = true;
          participant.version += 1;
        }
        state.group.orderedQuantity += quantity;
        state.group.version += 1;
        state.reservations.set(request.clientMutationId, { action: request.action, quantity });
      } else if (request.action === 'rollback_reservation' && !state.rollbacks.has(request.reservationMutationId)) {
        const reservation = state.reservations.get(request.reservationMutationId);
        const quantity = Number(request.quantity || reservation?.quantity || 0);
        if (participant) {
          participant.selectedQuantity = Math.max(0, participant.selectedQuantity - quantity);
          if (participant.selectedQuantity === 0
            && ['create', 'repair_customer_group', 'recover_legacy_customer_group', 'join'].includes(reservation?.action)) participant.counted = false;
          participant.version += 1;
        }
        state.group.orderedQuantity = Math.max(0, state.group.orderedQuantity - quantity);
        state.group.version += 1;
        state.rollbacks.add(request.reservationMutationId);
      } else if (request.action === 'transition_payment') {
        const paymentParticipant = state.participants.find((item) => (
          item.actorId === request.participantActorId
        ));
        const updatedAt = new Date().toISOString();
        if (paymentParticipant) {
          paymentParticipant.paymentStatus = request.toStatus;
          paymentParticipant.version += 1;
          paymentParticipant.updatedAt = updatedAt;
        }
        committedOrders.forEach((storedOrder, orderId) => {
          if (storedOrder.groupId !== groupId) return;
          const storedActorId = storedOrder.participantActorId || storedOrder.visitorId;
          if (storedActorId !== request.participantActorId) return;
          const nextOrder = {
            ...storedOrder,
            paymentStatus: request.toStatus,
            paymentVersion: Math.max(
              Number(storedOrder.paymentVersion || 0),
              Number(storedOrder.version || 0),
            ) + 1,
            statusUpdatedAt: updatedAt,
            syncedAt: updatedAt,
            updatedAt,
          };
          committedOrders.set(orderId, nextOrder);
          if (!transitionedOrder) transitionedOrder = nextOrder;
        });
      }
      state.group.currentCount = state.participants.filter((item) => item.counted !== false).length;
      groupState.set(groupId, state);
      payload = {
        ok: true,
        unreadCounts: {},
        capabilityToken: request.action === 'recover_legacy_customer_group'
          ? request.capabilityToken
          : ['create', 'repair_customer_group', 'join'].includes(request.action)
          ? `test-capability-${request.actorId}`
          : undefined,
        snapshot: {
          group: { ...state.group },
          participants: state.participants.map((item) => ({ ...item })),
          messages: [...state.messages],
          history: [...state.history],
        },
        order: transitionedOrder || undefined,
      };
    } else {
      payload = { ok: true, unreadCounts: {} };
    }
    await route.fulfill({
      status: plannedDealPublishFailure?.status
        || (dealAlreadyDeleted || groupCreateRejected
        ? 409
        : dealDeleteFailed || dealPublishFailed || groupCreateFailed
        ? 503
        : orderPublishFailed || legacyOwnerRepairUnclaimable ? 409
        : groupSnapshotMissing ? 404
        : legacyOwnerRepairForbidden || legacyRecoveryDenied ? 403
        : 200),
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}

async function completeOnboarding(page, { name, phone = '010-1234-5678' }) {
  await page.getByLabel('이름').fill(name);
  await page.getByLabel('연락처').fill(phone);
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();
  await page.getByRole('button', { name: '테스트 시작' }).click();
}

async function seedLegacyCustomerGroup(page, {
  dealId,
  actorId,
  title,
  groupCapabilityToken,
  ownerCapabilityToken,
  legacyEventId,
}) {
  await page.addInitScript((fixture) => {
    localStorage.setItem('o2o_mvp_visitor_id', fixture.actorId);
    localStorage.setItem('o2o_mvp_events', JSON.stringify([{
      id: fixture.legacyEventId,
      name: 'group_created',
      visitorId: fixture.actorId,
      sessionId: 'legacy-owner-repair-session',
      timestamp: '2026-08-31T10:00:00.000Z',
      properties: {
        deal_id: fixture.dealId,
        source: 'customer',
      },
    }]));
    localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify({
      [fixture.dealId]: fixture.ownerCapabilityToken,
    }));
    localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
      [`${fixture.dealId}::${fixture.actorId}`]: {
        groupId: fixture.dealId,
        actorId: fixture.actorId,
        role: 'host',
        active: true,
        capabilityToken: fixture.groupCapabilityToken,
        credentialRevision: 1,
      },
    }));
    localStorage.setItem('o2o_mvp_group_fallback_v1', JSON.stringify({
      [fixture.dealId]: {
        localOnly: true,
        group: {
          id: fixture.dealId,
          groupId: fixture.dealId,
          dealId: fixture.dealId,
          status: 'recruiting',
          targetCount: 2,
          currentCount: 1,
          totalQuantity: 2,
          orderedQuantity: 1,
          creatorActorId: fixture.actorId,
          hostMode: 'self',
          hostActorId: fixture.actorId,
          version: 1,
        },
        participants: [{
          actorId: fixture.actorId,
          role: 'host',
          counted: true,
          selectedQuantity: 1,
          version: 1,
        }],
        messages: [],
        history: [],
      },
    }));
    localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([{
      id: fixture.dealId,
      groupId: fixture.dealId,
      source: 'customer',
      saleType: 'community',
      visibility: 'public',
      category: '카페',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '판교동',
      store: '레거시 owner 복구',
      title: fixture.title,
      description: '소유권 복구 경계 검증',
      address: '판교역',
      deadline: '2026-09-30 20:00',
      methods: ['픽업'],
      originalPrice: 12000,
      expectedPerPerson: 6000,
      unitPrice: 6000,
      target: 2,
      targetPeople: 2,
      targetCount: 2,
      current: 1,
      currentPeople: 1,
      currentCount: 1,
      participantCount: 1,
      totalQuantity: 2,
      productQuantity: 2,
      creatorQuantity: 1,
      orderedQuantity: 1,
      groupStatus: 'recruiting',
      creatorActorId: fixture.actorId,
      hostMode: 'self',
      hostActorId: fixture.actorId,
      hostMatched: true,
      image: 'https://images.unsplash.com/photo-1511081692775-05d0f180a065',
      menu: [{ id: 'legacy-owner-menu', name: '복구 상품', price: 6000 }],
    }]));
  }, {
    dealId,
    actorId,
    title,
    groupCapabilityToken,
    ownerCapabilityToken,
    legacyEventId,
  });
}

test.beforeEach(async ({ page }) => {
  await mockCentralApis(page);
});

test('사용자 온보딩은 잘못된 휴대전화 번호를 차단한다', async ({ page }) => {
  await page.goto('/customer');
  await page.getByLabel('이름').fill('사용자 검수');
  await page.getByLabel('개인정보 수집 및 테스트 행동 데이터 수집 동의').check();

  const submit = page.getByRole('button', { name: '테스트 시작' });
  await page.getByLabel('연락처').fill('0101234');
  await expect(submit).toBeDisabled();

  await page.getByLabel('연락처').fill('010-1234-5678');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByPlaceholder('매장 또는 상품 검색')).toBeVisible();
});

test('앱 선택 화면을 다시 열면 기억한 정보로 사용자 로그인을 다시 확인한다', async ({ page }) => {
  await page.goto('/customer');
  await completeOnboarding(page, { name: '재로그인 검수', phone: '010-2468-1357' });
  await expect(page.getByPlaceholder('매장 또는 상품 검색')).toBeVisible();

  await page.getByRole('button', { name: '앱 선택' }).click();
  await page.locator('.launcher-card').filter({ hasText: '사용자 앱' }).click();

  await expect(page.getByRole('heading', { name: '모여사요' })).toBeVisible();
  await expect(page.getByLabel('이름')).toHaveValue('재로그인 검수');
  await expect(page.getByLabel('연락처')).toHaveValue('010-2468-1357');
  await expect(page.locator('.bottom-nav')).toHaveCount(0);

  await page.getByRole('button', { name: '테스트 시작' }).click();
  await expect(page.getByPlaceholder('매장 또는 상품 검색')).toBeVisible();
  await expect(page.locator('.bottom-nav')).toBeVisible();
});

test('사장님 기억 정보가 있어도 앱 선택의 사용자 로그인은 사용자 역할과 메뉴 6개를 유지한다', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('o2o_mvp_profile', JSON.stringify({
      name: '이전 사장님',
      phone: '010-2468-1357',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '서현동',
      testerType: '사장님',
      consent: true,
    }));
  });
  await page.goto('/');
  await page.locator('.launcher-card').filter({ hasText: '사용자 앱' }).click();

  await expect(page.getByText('사용자 테스트 계정 등록')).toBeVisible();
  await expect(page.getByRole('button', { name: '사장님', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '테스트 시작' }).click();

  await expectBottomNavigationToFillWidth(page, 6);
  await expect(page.getByRole('button', { name: '내 주문' })).toBeVisible();
  await expect(page.getByRole('button', { name: '찜', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '마이', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '계산', exact: true }).click();
  await expect(page.getByRole('heading', { name: '예상 부담금 계산기' })).toBeVisible();
  await expectBottomNavigationToFillWidth(page, 6);
  await expect(page.locator('.bottom-nav button[aria-current="page"]')).toContainText('계산');
  await expect.poll(async () => JSON.parse(
    await page.evaluate(() => localStorage.getItem('o2o_mvp_profile')),
  ).testerType).toBe('사용자');
});

test('사용자와 사장님을 번갈아 테스트해도 사장님 번호와 등록 상품을 유지한다', async ({ page }) => {
  await page.goto('/owner');
  await completeOnboarding(page, {
    name: '계정 분리 사장님',
    phone: '010-1111-2222',
  });

  await page.getByLabel('매장명').fill('계정 분리 매장');
  await page.getByLabel('상품명').fill('계정 분리 검수 상품');
  await page.getByLabel('정상가').fill('10000');
  await page.locator('.method-grid').getByRole('button', { name: '픽업' }).click();
  await page.getByLabel('픽업 위치').fill('판교역');
  await page.getByRole('button', { name: '상품 등록 완료' }).click();
  await expect(page.getByRole('heading', { name: '등록 완료' })).toBeVisible();

  await page.getByRole('button', { name: '앱 선택' }).click();
  await page.locator('.launcher-card').filter({ hasText: '사용자 앱' }).click();
  await page.getByLabel('이름').fill('계정 분리 사용자');
  await page.getByLabel('연락처').fill('010-3333-4444');
  await page.getByRole('button', { name: '테스트 시작' }).click();
  await expect(page.getByPlaceholder('매장 또는 상품 검색')).toBeVisible();

  await page.getByRole('button', { name: '앱 선택' }).click();
  await page.locator('.launcher-card').filter({ hasText: '사장님 앱' }).click();
  await expect(page.getByLabel('이름')).toHaveValue('계정 분리 사장님');
  await expect(page.getByLabel('연락처')).toHaveValue('010-1111-2222');
  await page.getByRole('button', { name: '테스트 시작' }).click();

  await page.getByRole('button', { name: '상품 관리' }).click();
  await expect(page.locator('.owner-product-card')).toContainText('계정 분리 검수 상품');
});

test('다른 사장님 번호로 덮인 브라우저는 기존 관리키 번호로 상품과 주문 연결을 복구한다', async ({ page }) => {
  await page.addInitScript(() => {
    const currentProfile = {
      name: '현재 사장님',
      phone: '010-3333-4444',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '판교동',
      testerType: '사장님',
      consent: true,
    };
    const deal = {
      id: 'owner-account-reconnect',
      source: 'merchant',
      saleType: 'instant',
      visibility: 'public',
      category: '마트',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '판교동',
      store: '기존 연결 매장',
      title: '기존 연결 상품',
      originalPrice: 10000,
      unitPrice: 9000,
      discountRate: 10,
      target: 5,
      totalQuantity: 5,
      orderedQuantity: 0,
      methods: ['픽업'],
      pickupPlace: '판교역',
      image: 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=900&q=80',
    };
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(currentProfile));
    localStorage.setItem('o2o_mvp_created_deals', JSON.stringify([deal]));
    localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify({
      [deal.id]: `deal-${'a'.repeat(64)}`,
    }));
    localStorage.setItem('o2o_mvp_owner_deal_scopes_v1', JSON.stringify({
      [deal.id]: 'phone:01011112222',
    }));
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사장님:01033334444',
      startedAt: Date.now(),
    }));
  });

  await page.goto('/owner');
  await expect(page.getByText('기존 사장님 상품 1개를 확인했습니다')).toBeVisible();
  await expect(page.getByText(/010-\*\*\*\*-2222/)).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '기존 번호로 연결' }).click();
  await expect.poll(async () => JSON.parse(
    await page.evaluate(() => localStorage.getItem('o2o_mvp_profile')),
  ).phone).toBe('010-1111-2222');

  await page.getByRole('button', { name: '상품 관리' }).click();
  await expect(page.locator('.owner-product-card')).toContainText('기존 연결 상품');
});

test('관리 키가 없는 로컬 상품은 수정·삭제 가능 상태로 표시하지 않는다', async ({ page }) => {
  await page.addInitScript(() => {
    const profile = {
      name: '관리 키 확인 사장님',
      phone: '010-1111-2222',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '판교동',
      testerType: '사장님',
      consent: true,
    };
    const deal = {
      id: 'owner-missing-management-key',
      source: 'merchant',
      saleType: 'instant',
      visibility: 'public',
      category: '마트',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '판교동',
      store: '관리 키 확인 매장',
      title: '관리 키 없는 상품',
      originalPrice: 10000,
      unitPrice: 9000,
      discountRate: 10,
      target: 5,
      totalQuantity: 5,
      orderedQuantity: 0,
      methods: ['픽업'],
      pickupPlace: '판교역',
    };
    localStorage.setItem('o2o_mvp_profile', JSON.stringify(profile));
    localStorage.setItem('o2o_mvp_created_deals', JSON.stringify([deal]));
    localStorage.setItem('o2o_mvp_owner_deal_scopes_v1', JSON.stringify({
      [deal.id]: 'phone:01011112222',
    }));
    sessionStorage.setItem('o2o_mvp_active_app_session_v1', JSON.stringify({
      profileKey: '사장님:01011112222',
      startedAt: Date.now(),
    }));
  });

  await page.goto('/owner');
  await page.getByRole('button', { name: '상품 관리' }).click();

  const product = page.locator('.owner-product-card').filter({ hasText: '관리 키 없는 상품' });
  await expect(product).toContainText('이 기기에는 관리 키가 없어 수정할 수 없습니다.');
  await expect(product.getByRole('button', { name: '수정' })).toBeDisabled();
  await expect(product.getByRole('button', { name: '삭제' })).toHaveCount(0);
});

test('넓고 낮은 화면에서도 사용자 하단 메뉴가 화면 안에 유지된다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '하단 메뉴 검수' });

  const navBounds = await page.locator('.bottom-nav').boundingBox();
  expect(navBounds).not.toBeNull();
  expect(navBounds.y).toBeGreaterThanOrEqual(0);
  expect(navBounds.y + navBounds.height).toBeLessThanOrEqual(720);
});

test('세로 상품 이미지는 상세 화면에서 잘리지 않고 전체 비율로 표시된다', async ({ page }) => {
  await page.goto('/customer');
  await completeOnboarding(page, { name: '세로 이미지 검수' });

  const portraitSource = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    context.fillStyle = '#f5c542';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#1f2937';
    context.fillRect(20, 20, 80, 320);
    const image = canvas.toDataURL('image/jpeg', 0.8);
    localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([{
      id: 'customer-portrait-render-test',
      groupId: 'customer-portrait-render-test',
      source: 'customer',
      saleType: 'community',
      visibility: 'public',
      category: '생활용품',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '서현동',
      store: '세로 이미지 검수',
      title: '세로 이미지 전체 표시',
      description: '세로 캡처 비율 유지 검수',
      address: '서현역',
      deadline: '2026-09-30 20:00',
      methods: ['픽업'],
      originalPrice: 12000,
      expectedPerPerson: 6000,
      unitPrice: 6000,
      target: 2,
      targetPeople: 2,
      targetCount: 2,
      current: 1,
      currentPeople: 1,
      currentCount: 1,
      participantCount: 1,
      totalQuantity: 2,
      productQuantity: 2,
      creatorQuantity: 1,
      orderedQuantity: 1,
      groupStatus: 'recruiting',
      hostMode: 'self',
      hostMatched: true,
      image,
      menu: [{ id: 'portrait-menu', name: '세로 이미지 상품', price: 6000 }],
    }]));
    return image;
  });

  await page.reload();
  await page.getByRole('button', { name: /세로 이미지 전체 표시/ }).click();
  const hero = page.locator('.hero-image');
  await expect(hero).toBeVisible();
  await expect(hero).toHaveCSS('object-fit', 'contain');
  await expect(hero).toHaveAttribute('src', portraitSource);
  const imageState = await hero.evaluate((image) => ({
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  }));
  expect(imageState).toEqual({ complete: true, naturalWidth: 120, naturalHeight: 360 });
});

test('깨진 상품 이미지는 목록·상세·공유에서 기본 이미지로 교체된다', async ({ page }) => {
  const brokenImage = 'https://broken.example.test/product.jpg';
  await page.route('https://broken.example.test/**', (route) => route.abort('failed'));
  await page.goto('/customer');
  await completeOnboarding(page, { name: '이미지 폴백 검수' });

  await page.evaluate((image) => {
    localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([{
      id: 'customer-broken-image-test',
      groupId: 'customer-broken-image-test',
      source: 'customer',
      saleType: 'community',
      visibility: 'public',
      category: '생활용품',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '서현동',
      store: '이미지 폴백 검수',
      title: '깨진 이미지 기본 표시',
      description: '목록 상세 공유 이미지 폴백 검수',
      address: '서현역',
      deadline: '2026-09-30 20:00',
      methods: ['픽업'],
      originalPrice: 12000,
      expectedPerPerson: 6000,
      unitPrice: 6000,
      target: 2,
      targetPeople: 2,
      targetCount: 2,
      current: 1,
      currentPeople: 1,
      currentCount: 1,
      participantCount: 1,
      totalQuantity: 2,
      productQuantity: 2,
      creatorQuantity: 1,
      orderedQuantity: 1,
      groupStatus: 'recruiting',
      hostMode: 'self',
      hostMatched: true,
      image,
      menu: [{ id: 'broken-image-menu', name: '이미지 폴백 상품', price: 6000 }],
    }]));
  }, brokenImage);

  await page.reload();
  const card = page.getByRole('button', { name: /깨진 이미지 기본 표시/ });
  await expect(card.locator('img')).toHaveAttribute('src', FALLBACK_PRODUCT_IMAGE);
  await card.click();
  await expect(page.locator('.hero-image')).toHaveAttribute('src', FALLBACK_PRODUCT_IMAGE);

  await page.getByRole('button', { name: '공유' }).click();
  await expect(page.locator('.share-summary img')).toHaveAttribute('src', FALLBACK_PRODUCT_IMAGE);
});

test('사용자는 설정 지역과 관계없이 모든 공개 사용자 그룹을 확인한다', async ({ page }) => {
  await page.goto('/customer');
  await completeOnboarding(page, { name: '전국 공개 검수' });

  await page.getByRole('button', { name: '사용자', exact: true }).click();
  await expect(page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ })).toBeVisible();
  await expect(page.getByText('지역과 관계없이 모든 공개 테스트 상품을 표시합니다.')).toBeVisible();
});

test('짧은 모바일 화면에서도 역할 전환 온보딩은 이름 입력란부터 시작한다', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 560 });
  await page.goto('/owner');
  const ownerScreen = page.locator('.onboarding-screen');
  await ownerScreen.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => ownerScreen.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole('button', { name: '관리자 앱' }).click();
  const adminScreen = page.locator('.onboarding-screen');
  await expect.poll(() => adminScreen.evaluate((element) => element.scrollTop)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  const nameInput = page.getByLabel('이름');
  await expect.poll(() => nameInput.evaluate((input) => {
    const inputRect = input.getBoundingClientRect();
    const screenRect = input.closest('.onboarding-screen')?.getBoundingClientRect();
    const visualBottom = window.visualViewport?.height ?? window.innerHeight;
    return Boolean(screenRect)
      && inputRect.top >= Math.max(0, screenRect.top)
      && inputRect.bottom <= Math.min(visualBottom, screenRect.bottom);
  })).toBe(true);
  await nameInput.fill('S26 회귀 검수');
  await expect(nameInput).toHaveValue('S26 회귀 검수');
  await expect(page.getByText('관리자 테스트 계정 등록', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '관리자 앱' })).toHaveClass(/active/);
});

test('기존 사용자 그룹도 모집 중이면 실제 참여 단계가 열린다', async ({ page }) => {
  await page.goto('/customer');
  await completeOnboarding(page, { name: '참여 검수' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await page.getByRole('button', { name: '참여하기' }).click();

  const complete = page.getByRole('button', { name: '참여 완료하기' });
  await expect(complete).toBeEnabled();
  await complete.click();
  await expect(page.getByRole('heading', { name: '그룹 참여 완료' })).toBeVisible();
});

test('참여 자격증명 없는 그룹방 딥링크는 상세 화면에서 차단된다', async ({ page }) => {
  await page.goto('/customer?group=community-costco&view=room');
  await completeOnboarding(page, { name: '딥링크 검수' });

  await expect(page.getByRole('heading', { name: '공동구매 상세' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '관리자 권한 확인' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /그룹 채팅|거래 상태 관리/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '참여하기' })).toBeVisible();
});

test('사장님 상품 관리의 홈 버튼은 사장님 등록 화면으로 돌아간다', async ({ page }) => {
  await page.goto('/owner');
  await completeOnboarding(page, { name: '사장님 검수' });

  await expect(page.getByRole('heading', { name: '메뉴 상세' })).toBeVisible();
  await page.getByRole('button', { name: '상품 관리' }).click();
  await expect(page.getByRole('heading', { name: '등록 상품 관리' })).toBeVisible();

  await page.getByRole('button', { name: '사장님 홈' }).click();
  await expect(page.getByRole('heading', { name: '메뉴 상세' })).toBeVisible();
  await expect(page).toHaveURL(/\/owner$/);
});

test('사장님 상품 수량은 등록·재접속·관리 화면까지 동일하게 유지된다', async ({ page }) => {
  const requests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests });
  await page.goto('/owner');
  await completeOnboarding(page, { name: '상품 검수' });

  await page.getByLabel('매장명').fill('검수 매장');
  await page.getByLabel('상품명').fill('수량 검수 상품');
  await page.getByLabel('정상가').fill('10000');
  const totalQuantity = page.locator('.field-counter').filter({ hasText: '공구 총수량' });
  const splitQuantity = page.locator('.field-counter').filter({ hasText: '가격 분할수량' });
  for (let index = 0; index < 4; index += 1) {
    await totalQuantity.getByRole('button', { name: '증가' }).click();
    await splitQuantity.getByRole('button', { name: '증가' }).click();
  }
  await page.locator('.method-grid').getByRole('button', { name: '픽업' }).click();
  await page.getByLabel('픽업 위치').fill('검수 장소');
  await page.getByRole('button', { name: '상품 등록 완료' }).click();

  await expect(page.getByRole('heading', { name: '등록 완료' })).toBeVisible();
  await expect(page.getByText('5개', { exact: true }).last()).toBeVisible();
  await expect(page.locator('.done-image')).toHaveAttribute('src', FALLBACK_PRODUCT_IMAGE);

  await page.reload();
  await page.getByRole('button', { name: '상품 관리' }).click();
  const product = page.locator('.owner-product-card').filter({ hasText: '수량 검수 상품' });
  await expect(product.locator('img')).toHaveAttribute('src', FALLBACK_PRODUCT_IMAGE);
  await expect(product).toContainText('공구 총 5개');
  await expect(product).toContainText('가격 5개 분할');
  await expect(product).toContainText('남은 수량 5개');

  await expect(product.getByRole('button', { name: '삭제' })).toHaveCount(0);
  await expect(product.getByRole('button', { name: '수정' })).toBeEnabled();
  await expect(product).toBeVisible();
  expect(requests.filter(({ action }) => action === 'delete')).toEqual([]);
});

test('등록 완료 사진은 세로 원본 전체를 표시하고 상품 삭제 진입은 노출하지 않는다', async ({ page }) => {
  const requests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests });
  await page.route(FALLBACK_PRODUCT_IMAGE, (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="720"><rect width="240" height="720" fill="white"/><rect width="240" height="120" fill="red"/><rect y="120" width="240" height="480" fill="navy"/><rect y="600" width="240" height="120" fill="lime"/></svg>',
  }));
  await page.goto('/owner');
  await completeOnboarding(page, { name: '완료 사진 검수' });
  await page.getByLabel('매장명').fill('사진 검수 매장');
  await page.getByLabel('상품명').fill('세로 원본 상품');
  await page.getByLabel('정상가').fill('10000');
  await page.locator('.method-grid').getByRole('button', { name: '픽업' }).click();
  await page.getByLabel('픽업 위치').fill('검수 장소');
  await page.getByRole('button', { name: '상품 등록 완료' }).click();
  await expect(page.getByRole('heading', { name: '등록 완료' })).toBeVisible();
  const image = page.locator('.done-image');
  await expect(image).toHaveCSS('object-fit', 'contain');
  await expect(image).toHaveAttribute('src', FALLBACK_PRODUCT_IMAGE);
  await expect.poll(() => image.evaluate((element) => element.naturalHeight)).toBe(720);
  expect(await image.evaluate((element) => element.naturalWidth)).toBe(240);
  const imageBounds = await image.boundingBox();
  const headingBounds = await page.getByRole('heading', { name: '등록 완료' }).boundingBox();
  expect(imageBounds.height).toBeGreaterThan(172);
  expect(headingBounds.y).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('portrait-registration.png') });
  await page.getByRole('button', { name: '사용자 화면에서 보기' }).click();
  await expect(page.locator('.hero-image')).toHaveAttribute('src', FALLBACK_PRODUCT_IMAGE);
  await expect(page.getByRole('button', { name: '상품 삭제', exact: true })).toHaveCount(0);
  expect(requests.filter(({ action }) => action === 'delete')).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_created_deals') || '[]')))
    .toEqual(expect.arrayContaining([expect.objectContaining({ title: '세로 원본 상품', image: FALLBACK_PRODUCT_IMAGE })]));
});

test('사장님 상품은 중앙 저장 성공 전에 완료 처리되지 않고 재시도 ID를 유지한다', async ({ page }) => {
  const publishAttempts = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { failDealPublish: true, publishAttempts });
  await page.goto('/owner');
  await completeOnboarding(page, { name: '등록 실패 검수' });

  await page.getByLabel('매장명').fill('등록 검수 매장');
  await page.getByLabel('상품명').fill('서버 저장 검수 상품');
  await page.getByLabel('정상가').fill('12000');
  await page.locator('.method-grid').getByRole('button', { name: '픽업' }).click();
  await page.getByLabel('픽업 위치').fill('등록 검수 장소');
  await page.getByRole('button', { name: '상품 등록 완료' }).click();

  await expect(page.getByRole('alert')).toContainText('중앙 서버에 저장하지 못했습니다');
  await expect(page.getByRole('heading', { name: '메뉴 상세' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '등록 완료' })).toHaveCount(0);

  await page.unroute('**/api/**');
  await mockCentralApis(page, { publishAttempts });
  await page.getByRole('button', { name: '상품 등록 완료' }).click();

  await expect(page.getByRole('heading', { name: '등록 완료' })).toBeVisible();
  expect(publishAttempts.length).toBeGreaterThan(2);
  expect(new Set(publishAttempts).size).toBe(1);
});

test('사장님 상품등록은 일시적인 502·503을 같은 상품으로 자동 복구한다', async ({ page }) => {
  const requests = [];
  const publishAttempts = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    dealPublishFailures: [
      { status: 502, error: 'upstream_invalid_response' },
      { status: 503, error: 'collector_busy' },
    ],
    publishAttempts,
    requests,
  });
  await page.goto('/owner');
  await completeOnboarding(page, { name: '사장님 자동복구 검수' });

  await page.getByLabel('매장명').fill('자동복구 검수 매장');
  await page.getByLabel('상품명').fill('자동복구 검수 상품');
  await page.getByLabel('정상가').fill('82300');
  await page.locator('.method-grid').getByRole('button', { name: '픽업' }).click();
  await page.getByLabel('픽업 위치').fill('자동복구 검수 장소');
  await page.getByRole('button', { name: '상품 등록 완료' }).click();

  await expect(page.getByRole('heading', { name: '등록 완료' })).toBeVisible({ timeout: 15_000 });
  const publishRequests = requests.filter(({ path, action }) => (
    path.endsWith('/public-deals') && action === 'publish'
  ));
  expect(publishRequests).toHaveLength(3);
  expect(new Set(publishAttempts).size).toBe(1);
  expect(new Set(publishRequests.map(({ request }) => JSON.stringify(request))).size).toBe(1);
  const ownerDeals = await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_created_deals') || '[]',
  ));
  expect(ownerDeals.filter((deal) => deal.title === '자동복구 검수 상품')).toHaveLength(1);
});

test('고객 그룹은 중앙 공개 실패를 완료로 처리하지 않고 재시도 ID를 유지한다', async ({ page }) => {
  const publishAttempts = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { failDealPublish: true, publishAttempts });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '그룹 등록 검수' });

  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await expect(page.getByRole('heading', { name: '공동구매 그룹 생성' })).toBeVisible();

  await page.getByRole('button', { name: '그룹방 생성' }).click();
  await expect(page.getByRole('alert')).toContainText('그룹방을 생성하지 못했습니다');
  await expect(page.getByRole('heading', { name: '공동구매 그룹 생성' })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_customer_groups') || '[]')))
    .toEqual([]);

  await page.unroute('**/api/**');
  await mockCentralApis(page, { publishAttempts });
  await page.getByRole('button', { name: '그룹방 생성' }).click();

  await expect.poll(async () => page.evaluate(() => (
    JSON.parse(localStorage.getItem('o2o_mvp_customer_groups') || '[]').length
  ))).toBe(1);
  expect(publishAttempts.length).toBeGreaterThanOrEqual(2);
  expect(new Set(publishAttempts).size).toBe(1);
});

test('기존 로컬 상품만 남은 사용자 그룹은 같은 ID로 중앙 그룹 연결을 복구한다', async ({ page }) => {
  const requests = [];
  const groupState = new Map();
  const legacyEventId = '9b2c3d4e-5f60-4781-9abc-def012345678';
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    requests,
    groupState,
    missingGroupIds: new Set(['customer-legacy-local-group']),
    legacyRecoveryReceipts: new Map([[
      legacyEventId,
      {
        groupId: 'customer-legacy-local-group',
        actorId: 'visitor-legacy-local-creator',
        role: 'host',
        selectedQuantity: 1,
      },
    ]]),
  });
  await page.addInitScript(({ legacyEventId: storedEventId }) => {
    const actorId = 'visitor-legacy-local-creator';
    const dealId = 'customer-legacy-local-group';
    const groupCapabilityToken = `group-${'g'.repeat(64)}`;
    localStorage.setItem('o2o_mvp_visitor_id', actorId);
    localStorage.setItem('o2o_mvp_events', JSON.stringify([{
      id: storedEventId,
      name: 'group_created',
      visitorId: actorId,
      properties: { deal_id: dealId, source: 'customer' },
    }]));
    localStorage.setItem('o2o_mvp_public_deal_capabilities_v1', JSON.stringify({
      [dealId]: `deal-${'d'.repeat(64)}`,
    }));
    localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
      [`${dealId}::${actorId}`]: {
        groupId: dealId,
        actorId,
        role: 'host',
        active: true,
        capabilityToken: groupCapabilityToken,
        credentialRevision: 1,
      },
    }));
    localStorage.setItem('o2o_mvp_group_fallback_v1', JSON.stringify({
      [dealId]: {
        localOnly: true,
        group: {
          groupId: dealId,
          dealId,
          status: 'recruiting',
          targetCount: 2,
          currentCount: 1,
          totalQuantity: 2,
          orderedQuantity: 1,
          creatorActorId: actorId,
          hostMode: 'self',
          hostActorId: actorId,
          version: 1,
        },
        participants: [{
          actorId,
          role: 'host',
          counted: true,
          selectedQuantity: 1,
          version: 1,
        }],
        messages: [],
        history: [],
      },
    }));
    localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([{
      id: dealId,
      groupId: dealId,
      source: 'customer',
      saleType: 'community',
      visibility: 'public',
      category: '카페',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '판교동',
      store: '기존 등록 그룹',
      title: '중앙 연결 복구 검수',
      description: '예전 버전에서 등록한 그룹',
      address: '판교역',
      deadline: '2026-09-30 20:00',
      methods: ['픽업'],
      originalPrice: 12000,
      expectedPerPerson: 6000,
      unitPrice: 6000,
      target: 2,
      targetPeople: 2,
      targetCount: 2,
      current: 1,
      currentPeople: 1,
      currentCount: 1,
      participantCount: 1,
      totalQuantity: 2,
      productQuantity: 2,
      creatorQuantity: 1,
      orderedQuantity: 1,
      groupStatus: 'recruiting',
      creatorActorId: actorId,
      hostMode: 'self',
      hostActorId: actorId,
      hostMatched: true,
      image: 'https://images.unsplash.com/photo-1511081692775-05d0f180a065',
      menu: [{ id: 'legacy-menu', name: '복구 상품', price: 6000 }],
    }]));
  }, { legacyEventId });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '기존 그룹 복구' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /중앙 연결 복구 검수/ }).click();
  await expect(page.getByRole('button', { name: '그룹 채팅' })).toBeVisible();
  await page.getByRole('button', { name: '그룹 채팅' }).click();

  await expect(page.getByText('참여 인원')).toBeVisible();
  const repairRequest = requests.find(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'repair_customer_group'
  ));
  expect(repairRequest.request.groupId).toBe('customer-legacy-local-group');
  expect(repairRequest.request.dealId).toBe('customer-legacy-local-group');
  expect(repairRequest.request.actorId).toBe('visitor-legacy-local-creator');
  expect(repairRequest.request.ownerCapabilityToken).toBe(`deal-${'d'.repeat(64)}`);
  expect(repairRequest.request.capabilityToken).toBe(`group-${'g'.repeat(64)}`);
  expect(requests.some(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'recover_legacy_customer_group'
  ))).toBe(false);
  expect(groupState.get('customer-legacy-local-group')?.participants.map(({ actorId }) => actorId))
    .toEqual(['visitor-legacy-local-creator']);
  const credential = await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_group_credentials_v1') || '{}',
  )['customer-legacy-local-group::visitor-legacy-local-creator']);
  expect(credential.groupId).toBe('customer-legacy-local-group');
  expect(credential.active).toBe(true);
});

test('owner 복구가 소유권 미바인으로 거절된 레거시 그룹만 receipt로 한 번 복구한다', async ({ page }) => {
  const requests = [];
  const groupState = new Map();
  const dealId = 'customer-owner-unclaimable-recovery';
  const actorId = 'visitor-owner-unclaimable-recovery';
  const legacyEventId = '0f47c12a-30d7-4fb0-90e7-4c1f891b8d52';
  const groupCapabilityToken = `group-${'u'.repeat(64)}`;
  const ownerCapabilityToken = `deal-${'u'.repeat(64)}`;
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    requests,
    groupState,
    missingGroupIds: new Set([dealId]),
    legacyOwnerRepairUnclaimableIds: new Set([dealId]),
    legacyRecoveryReceipts: new Map([[
      legacyEventId,
      { groupId: dealId, actorId, role: 'host', selectedQuantity: 1 },
    ]]),
  });
  await seedLegacyCustomerGroup(page, {
    dealId,
    actorId,
    title: 'owner 미바인 receipt fallback',
    groupCapabilityToken,
    ownerCapabilityToken,
    legacyEventId,
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '미바인 레거시 생성자' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /owner 미바인 receipt fallback/ }).click();
  await page.getByRole('button', { name: '그룹 채팅' }).click();

  await expect(page.getByText('참여 인원')).toBeVisible();
  const recoveryActions = requests.filter(({ path, action }) => (
    path.endsWith('/group-ops')
    && ['repair_customer_group', 'recover_legacy_customer_group'].includes(action)
  ));
  expect(recoveryActions.map(({ action }) => action)).toEqual([
    'repair_customer_group',
    'recover_legacy_customer_group',
  ]);
  expect(recoveryActions[0].request.ownerCapabilityToken).toBe(ownerCapabilityToken);
  expect(recoveryActions[1].request.legacyEventId).toBe(legacyEventId);
  expect(recoveryActions[1].request.capabilityToken).toBe(groupCapabilityToken);
  expect(recoveryActions[1].request.ownerCapabilityToken).toBeUndefined();
  expect(await page.evaluate(({ dealId: storedDealId, actorId: storedActorId }) => JSON.parse(
    localStorage.getItem('o2o_mvp_group_credentials_v1') || '{}',
  )?.[`${storedDealId}::${storedActorId}`]?.active, { dealId, actorId })).toBe(true);
});

test('owner 복구가 forbidden이면 receipt가 있어도 레거시 복구로 내려가지 않는다', async ({ page }) => {
  const requests = [];
  const dealId = 'customer-owner-forbidden-recovery';
  const actorId = 'visitor-owner-forbidden-recovery';
  const legacyEventId = 'f3375d45-5796-4c09-8112-50d44588007d';
  const groupCapabilityToken = `group-${'f'.repeat(64)}`;
  const ownerCapabilityToken = `deal-${'f'.repeat(64)}`;
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    requests,
    missingGroupIds: new Set([dealId]),
    legacyOwnerRepairForbiddenIds: new Set([dealId]),
    legacyRecoveryReceipts: new Map([[
      legacyEventId,
      { groupId: dealId, actorId, role: 'host', selectedQuantity: 1 },
    ]]),
  });
  await seedLegacyCustomerGroup(page, {
    dealId,
    actorId,
    title: 'owner forbidden receipt 차단',
    groupCapabilityToken,
    ownerCapabilityToken,
    legacyEventId,
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '권한 불일치 생성자' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /owner forbidden receipt 차단/ }).click();
  await page.getByRole('button', { name: '그룹 채팅' }).click();

  await expect(page.getByRole('alert')).toContainText('이 작업을 수행할 권한이 없습니다.');
  const recoveryActions = requests.filter(({ path, action }) => (
    path.endsWith('/group-ops')
    && ['repair_customer_group', 'recover_legacy_customer_group'].includes(action)
  ));
  expect(recoveryActions.map(({ action }) => action)).toEqual(['repair_customer_group']);
  expect(recoveryActions[0].request.ownerCapabilityToken).toBe(ownerCapabilityToken);
});

test('원 브라우저의 과거 생성 receipt는 편집 권한 없이 누락된 중앙 그룹만 복구한다', async ({ page }) => {
  const requests = [];
  const groupState = new Map();
  const dealId = 'customer-legacy-receipt-group';
  const actorId = 'visitor-legacy-receipt-creator';
  const legacyEventId = 'f81d4fae-7dec-4a45-8a6f-67c6f0f5e123';
  const groupCapabilityToken = `group-${'r'.repeat(64)}`;
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    requests,
    groupState,
    missingGroupIds: new Set([dealId]),
    legacyRecoveryReceipts: new Map([[
      legacyEventId,
      { groupId: dealId, actorId, role: 'host', selectedQuantity: 1 },
    ]]),
  });
  await page.addInitScript(({ dealId: storedDealId, actorId: storedActorId, legacyEventId: storedEventId, groupCapabilityToken: storedCapabilityToken }) => {
    localStorage.setItem('o2o_mvp_visitor_id', storedActorId);
    localStorage.setItem('o2o_mvp_events', JSON.stringify([{
      id: storedEventId,
      name: 'group_created',
      visitorId: storedActorId,
      sessionId: 'legacy-session',
      timestamp: '2026-08-31T10:00:00.000Z',
      properties: {
        deal_id: storedDealId,
        source: 'customer',
      },
    }]));
    localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
      [`${storedDealId}::${storedActorId}`]: {
        groupId: storedDealId,
        actorId: storedActorId,
        role: 'host',
        active: false,
        capabilityToken: storedCapabilityToken,
        credentialRevision: 1,
      },
    }));
    localStorage.setItem('o2o_mvp_group_fallback_v1', JSON.stringify({
      [storedDealId]: {
        localOnly: true,
        group: {
          id: storedDealId,
          groupId: storedDealId,
          dealId: storedDealId,
          status: 'recruiting',
          targetCount: 2,
          currentCount: 1,
          totalQuantity: 2,
          orderedQuantity: 1,
          creatorActorId: storedActorId,
          hostMode: 'self',
          hostActorId: storedActorId,
          version: 1,
        },
        participants: [{
          actorId: storedActorId,
          role: 'host',
          counted: true,
          selectedQuantity: 1,
          version: 1,
        }],
        messages: [],
        history: [],
      },
    }));
    localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([{
      id: storedDealId,
      groupId: storedDealId,
      source: 'customer',
      saleType: 'community',
      visibility: 'public',
      category: '카페',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '판교동',
      store: '과거 receipt 그룹',
      title: 'receipt 기반 중앙 연결 복구',
      description: '원 등록 브라우저에서만 복구',
      address: '판교역',
      deadline: '2026-09-30 20:00',
      methods: ['픽업'],
      originalPrice: 12000,
      expectedPerPerson: 6000,
      unitPrice: 6000,
      target: 2,
      targetPeople: 2,
      targetCount: 2,
      current: 1,
      currentPeople: 1,
      currentCount: 1,
      participantCount: 1,
      totalQuantity: 2,
      productQuantity: 2,
      creatorQuantity: 1,
      orderedQuantity: 1,
      groupStatus: 'recruiting',
      creatorActorId: storedActorId,
      hostMode: 'self',
      hostActorId: storedActorId,
      hostMatched: true,
      image: 'https://images.unsplash.com/photo-1511081692775-05d0f180a065',
      menu: [{ id: 'legacy-receipt-menu', name: '복구 상품', price: 6000 }],
    }]));
  }, { dealId, actorId, legacyEventId, groupCapabilityToken });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '과거 원 생성자' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /receipt 기반 중앙 연결 복구/ }).click();
  await expect(page.getByRole('button', { name: '수정' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '상품 삭제' })).toHaveCount(0);
  await page.getByRole('button', { name: '그룹 채팅' }).click();

  await expect(page.getByText('참여 인원')).toBeVisible();
  await expect.poll(() => requests.filter(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'recover_legacy_customer_group'
  )).length).toBe(1);
  const recoveryRequest = requests.find(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'recover_legacy_customer_group'
  ));
  expect(recoveryRequest.request).toEqual({
    action: 'recover_legacy_customer_group',
    groupId: dealId,
    dealId,
    actorId,
    nickname: '과거 원 생성자',
    capabilityToken: groupCapabilityToken,
    legacyEventId,
  });
  expect(recoveryRequest.request.ownerCapabilityToken).toBeUndefined();
  expect(recoveryRequest.request.clientMutationId).toBeUndefined();
  expect(await page.evaluate(({ dealId: storedDealId, actorId: storedActorId }) => JSON.parse(
    localStorage.getItem('o2o_mvp_group_credentials_v1') || '{}',
  )?.[`${storedDealId}::${storedActorId}`]?.active, { dealId, actorId })).toBe(true);

  await page.reload();
  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /receipt 기반 중앙 연결 복구/ }).click();
  await expect(page.getByRole('button', { name: '수정' })).toHaveCount(0);
  await page.getByRole('button', { name: '그룹 채팅' }).click();
  await expect(page.getByText('참여 인원')).toBeVisible();
  expect(requests.filter(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'recover_legacy_customer_group'
  ))).toHaveLength(1);
});

test('로컬 상품 표시만 위조해도 기존 소유권 또는 그룹 권한 없이는 중앙 그룹을 만들 수 없다', async ({ page }) => {
  const requests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests });
  await page.addInitScript(() => {
    const actorId = 'visitor-forged-local-creator';
    const dealId = 'customer-forged-local-group';
    localStorage.setItem('o2o_mvp_visitor_id', actorId);
    localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([{
      id: dealId,
      groupId: dealId,
      source: 'customer',
      saleType: 'community',
      visibility: 'public',
      category: '카페',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '판교동',
      store: '위조 로컬 그룹',
      title: '권한 없는 복구 차단 검수',
      description: '로컬 목록만 존재',
      address: '판교역',
      deadline: '2026-09-30 20:00',
      methods: ['픽업'],
      originalPrice: 12000,
      expectedPerPerson: 6000,
      target: 2,
      targetPeople: 2,
      totalQuantity: 2,
      creatorQuantity: 1,
      creatorActorId: actorId,
      hostMode: 'self',
      image: 'https://images.unsplash.com/photo-1511081692775-05d0f180a065',
      menu: [{ id: 'forged-menu', name: '위조 상품', price: 6000 }],
    }]));
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '권한 없는 로컬 사용자' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /권한 없는 복구 차단 검수/ }).click();
  await expect(page.getByRole('button', { name: /그룹 채팅|거래 상태 관리/ })).toHaveCount(0);
  expect(requests.filter(({ path, action }) => (
    path.endsWith('/group-ops')
    && ['create', 'repair_customer_group', 'recover_legacy_customer_group'].includes(action)
  ))).toHaveLength(0);
});

test('사용자가 등록한 그룹은 재로그인 후에도 같은 상품·참여자·채팅으로 연결된다', async ({ page }) => {
  const requests = [];
  const groupState = new Map();
  const committedOrders = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests, groupState, committedOrders });
  await page.goto('/customer');
  await completeOnboarding(page, {
    name: '재로그인 그룹 연동',
    phone: '010-2468-9753',
  });

  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();
  await expect(page.locator('.group-room-screen')).toBeVisible();

  const created = await page.evaluate(() => {
    const [deal] = JSON.parse(localStorage.getItem('o2o_mvp_customer_groups') || '[]');
    const visitorId = localStorage.getItem('o2o_mvp_visitor_id');
    const credentials = JSON.parse(
      localStorage.getItem('o2o_mvp_group_credentials_v1') || '{}',
    );
    return {
      deal,
      visitorId,
      credential: credentials[`${deal.id}::${visitorId}`],
    };
  });
  expect(created.deal.groupId).toBe(created.deal.id);
  expect(created.credential.groupId).toBe(created.deal.id);
  expect(created.credential.actorId).toBe(created.visitorId);
  expect(groupState.get(created.deal.id)?.participants.map(({ actorId }) => actorId))
    .toContain(created.visitorId);

  const persistedMessage = '재로그인 후에도 유지되는 그룹 대화';
  const centralState = groupState.get(created.deal.id);
  centralState.messages.push({
    id: 'persisted-message',
    seq: 1,
    actorId: created.visitorId,
    nickname: '재로그인 그룹 연동',
    body: persistedMessage,
    createdAt: new Date().toISOString(),
  });
  centralState.group.lastMessageSeq = 1;

  await page.getByRole('button', { name: '앱 선택' }).click();
  await page.reload();
  await page.locator('.launcher-card').filter({ hasText: '사용자 앱' }).click();
  await expect(page.getByLabel('이름')).toHaveValue('재로그인 그룹 연동');
  await page.getByRole('button', { name: '테스트 시작' }).click();

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: new RegExp(created.deal.title) }).click();
  await expect(page.getByRole('button', { name: '수정' })).toBeVisible();
  await page.getByRole('button', { name: '그룹 채팅' }).click();

  await expect(page.getByText(persistedMessage)).toBeVisible();
  const latestSnapshot = requests.filter(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'snapshot'
  )).at(-1)?.request;
  expect(latestSnapshot.groupId).toBe(created.deal.id);
  expect(latestSnapshot.actorId).toBe(created.visitorId);
  expect(latestSnapshot.capabilityToken).toBe(created.credential.capabilityToken);
  expect(committedOrders.size).toBe(1);
});

test('사용자 직접등록은 일시적인 502·503을 같은 그룹과 주문으로 자동 복구한다', async ({ page }) => {
  const requests = [];
  const groupState = new Map();
  const committedOrders = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    dealPublishFailures: [
      { status: 502, error: 'upstream_invalid_response' },
      { status: 503, error: 'collector_busy' },
    ],
    requests,
    groupState,
    committedOrders,
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '사용자 직접등록 자동복구' });

  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();

  await expect(page.locator('.group-room-screen')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.bottom-nav button')).toHaveCount(6);
  await expect(page.getByRole('button', { name: '내 주문' })).toBeVisible();
  await expect(page.getByRole('button', { name: '찜', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '마이', exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_profile') || 'null',
  )?.testerType)).toBe('사용자');
  const publishRequests = requests.filter(({ path, action }) => (
    path.endsWith('/public-deals') && action === 'publish'
  ));
  const initialPublishRequests = publishRequests.filter(({ request }) => (
    request.deal.publishMutationId?.endsWith('-initial')
  ));
  expect(initialPublishRequests).toHaveLength(3);
  expect(new Set(publishRequests.map(({ request }) => request.deal.id)).size).toBe(1);
  expect(new Set(initialPublishRequests.map(({ request }) => request.deal.publishMutationId)).size).toBe(1);
  expect(new Set(initialPublishRequests.map(({ request }) => JSON.stringify(request))).size).toBe(1);
  expect(groupState.size).toBe(1);
  expect(committedOrders.size).toBe(1);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_customer_groups') || '[]',
  ))).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_customer_orders') || '[]',
  ))).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_checkout_attempts_v1') || '{}',
  ))).toEqual({});
});

test('사용자 자동계산 등록은 금액·수량을 유지하며 일시 장애를 자동 복구한다', async ({ page }) => {
  const requests = [];
  const groupState = new Map();
  const committedOrders = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    dealPublishFailures: [
      { status: 502, error: 'upstream_invalid_response' },
      { status: 503, error: 'collector_busy' },
    ],
    requests,
    groupState,
    committedOrders,
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '자동계산 자동복구' });

  await page.getByRole('button', { name: '예상 부담금 계산기' }).click();
  await page.getByLabel('상품 판매가').fill('82300');
  await page.getByRole('button', { name: '상품 수량 증가' }).click();
  await page.getByRole('button', { name: '선택 수량 증가' }).click();
  await page.getByRole('button', { name: '이 조건으로 그룹 만들기' }).click();
  await page.getByLabel('그룹 제목').fill('자동계산 등록 검수');
  await page.getByLabel('픽업 위치').fill('자동계산 검수 장소');
  await page.getByRole('button', { name: '그룹방 생성' }).click();

  await expect(page.locator('.group-room-screen')).toBeVisible({ timeout: 15_000 });
  const publishRequests = requests.filter(({ path, action }) => (
    path.endsWith('/public-deals') && action === 'publish'
  ));
  const initialPublishRequests = publishRequests.filter(({ request }) => (
    request.deal.publishMutationId?.endsWith('-initial')
  ));
  expect(initialPublishRequests).toHaveLength(3);
  expect(new Set(publishRequests.map(({ request }) => request.deal.id)).size).toBe(1);
  expect(new Set(initialPublishRequests.map(({ request }) => request.deal.publishMutationId)).size).toBe(1);
  expect(new Set(initialPublishRequests.map(({ request }) => JSON.stringify(request))).size).toBe(1);
  const deal = initialPublishRequests[0].request.deal;
  expect(deal.originalPrice).toBe(82300);
  expect(deal.totalQuantity).toBe(4);
  expect(deal.creatorQuantity).toBe(2);
  expect(deal.unitPrice).toBe(20575);
  expect(deal.menu[0].price).toBe(20575);
  expect(groupState.size).toBe(1);
  expect(committedOrders.size).toBe(1);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_customer_groups') || '[]',
  ))).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_customer_orders') || '[]',
  ))).toHaveLength(1);
});

test('고객 그룹은 중앙 그룹방 생성 실패 시 공개 글과 로컬 완료 상태를 남기지 않는다', async ({ page }) => {
  const requests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { failGroupCreate: true, requests });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '중앙 생성 실패 검수' });

  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();

  await expect(page.getByRole('alert')).toContainText('그룹방을 생성하지 못했습니다');
  expect(requests.some(({ path, action }) => path.endsWith('/public-deals') && action === 'publish')).toBe(false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_customer_groups') || '[]')))
    .toEqual([]);
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('o2o_mvp_group_fallback_v1') || '{}'))))
    .toEqual([]);
});

test('고객 그룹은 공개 등록 전 영구 생성 거절도 삭제 요청 없이 정리한다', async ({ page }) => {
  const requests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { rejectGroupCreateTerminal: true, requests });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '공개 전 보상 검수' });

  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();

  await expect(page.getByRole('alert')).toContainText('안전하게 되돌렸습니다');
  expect(requests.some(({ path, action }) => (
    path.endsWith('/public-deals') && ['publish', 'delete'].includes(action)
  ))).toBe(false);
  expect(requests.some(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'rollback_reservation'
  ))).toBe(true);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_checkout_attempts_v1') || '{}',
  ))).toEqual({});
});

test('고객 그룹 생성 주문은 확인 불가와 복구 실행 뒤에도 같은 ID로 재시도한다', async ({ page }) => {
  const requests = [];
  const committedOrders = new Map();
  const groupState = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    abortCommittedOrderResponses: true,
    abortOrderReads: true,
    requests,
    committedOrders,
    groupState,
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '생성 주문 복구 검수' });

  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();

  await expect(page.getByRole('alert')).toContainText('그룹방을 생성하지 못했습니다');
  await expect(page.getByRole('heading', { name: '공동구매 그룹 생성' })).toBeVisible();
  const pendingOrders = await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_customer_orders') || '[]',
  ));
  expect(pendingOrders).toHaveLength(1);
  expect(pendingOrders[0].type).toBe('group');
  const pendingOrderId = pendingOrders[0].id;
  const publishCountBeforeRecovery = requests.filter(
    ({ path, action }) => path.endsWith('/customer-orders') && action === 'publish',
  ).length;

  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => requests.filter(
    ({ path, action }) => path.endsWith('/customer-orders') && action === 'publish',
  ).length).toBeGreaterThan(publishCountBeforeRecovery);
  const attemptsAfterRecovery = await page.evaluate(() => Object.values(JSON.parse(
    localStorage.getItem('o2o_mvp_checkout_attempts_v1') || '{}',
  )));
  expect(attemptsAfterRecovery.map((attempt) => attempt.orderId)).toEqual([pendingOrderId]);

  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests, committedOrders, groupState });
  await page.getByRole('button', { name: '그룹방 생성' }).click();

  await expect(page.locator('.group-room-screen')).toBeVisible();
  const publishIds = requests
    .filter(({ path, action }) => path.endsWith('/customer-orders') && action === 'publish')
    .map(({ request }) => request.order.id);
  expect(publishIds.length).toBeGreaterThan(1);
  expect(new Set(publishIds)).toEqual(new Set([pendingOrderId]));
  expect(committedOrders.size).toBe(1);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_checkout_attempts_v1') || '{}',
  ))).toEqual({});
});

test('고객 그룹 생성 주문이 영구 거절되면 공개 그룹과 create 예약을 원복하고 새 ID로 재시도한다', async ({ page }) => {
  const failedRequests = [];
  const groupState = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    failOrderPublish: true,
    dealDeleteAlreadyDeleted: true,
    requests: failedRequests,
    groupState,
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '생성 주문 보상 검수' });

  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();

  await expect(page.getByRole('alert')).toContainText('안전하게 되돌렸습니다');
  const createRequest = failedRequests.find(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'create'
  ));
  const deleteRequest = failedRequests.find(({ path, action }) => (
    path.endsWith('/public-deals') && action === 'delete'
  ));
  const rollbackRequest = failedRequests.find(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'rollback_reservation'
  ));
  expect(createRequest).toBeTruthy();
  expect(deleteRequest?.request.dealId).toBe(createRequest.request.groupId);
  expect(rollbackRequest?.request.reservationMutationId)
    .toBe(createRequest.request.clientMutationId);
  expect(rollbackRequest?.request.clientMutationId).toMatch(/^rollback-reservation-/);
  expect(rollbackRequest?.request.quantity).toBe(createRequest.request.selectedQuantity);
  expect(groupState.get(createRequest.request.groupId)?.participants[0]?.counted).toBe(false);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_customer_groups') || '[]',
  ))).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_customer_orders') || '[]',
  ))).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_checkout_attempts_v1') || '{}',
  ))).toEqual({});

  const retryRequests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests: retryRequests, groupState });
  await page.getByRole('button', { name: /그룹방 생성/ }).click();

  await expect(page.locator('.group-room-screen')).toBeVisible();
  const retryCreate = retryRequests.find(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'create'
  ));
  expect(retryCreate).toBeTruthy();
  expect(retryCreate.request.groupId).not.toBe(createRequest.request.groupId);
  expect(retryCreate.request.clientMutationId).not.toBe(createRequest.request.clientMutationId);
});

test('주문 저장이 영구 거절되면 예약 수량을 복구하고 새 ID로 재시도한다', async ({ page }) => {
  const firstRequests = [];
  const groupState = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, { failOrderPublish: true, requests: firstRequests, groupState });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '예약 복구 검수' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await page.getByRole('button', { name: '참여하기' }).click();
  await page.getByRole('button', { name: '참여 완료하기' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  const firstReservation = firstRequests.find(({ action }) => ['join', 'reserve_quantity'].includes(action));
  const rollback = firstRequests.find(({ action }) => action === 'rollback_reservation');
  expect(firstReservation).toBeTruthy();
  expect(rollback?.request.reservationMutationId).toBe(firstReservation.request.clientMutationId);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_customer_orders') || '[]')))
    .toEqual([]);

  const retryRequests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests: retryRequests, groupState });
  await page.getByRole('button', { name: '참여 완료하기' }).click();
  await expect(page.getByRole('heading', { name: '그룹 참여 완료' })).toBeVisible();
  const retriedReservation = retryRequests.find(({ action }) => ['join', 'reserve_quantity'].includes(action));
  expect(retriedReservation).toBeTruthy();
  expect(retriedReservation.request.clientMutationId).not.toBe(firstReservation.request.clientMutationId);
});

test('주문 저장 후 응답만 유실되면 중앙 주문을 재확인하고 중복 없이 완료한다', async ({ page }) => {
  const requests = [];
  const committedOrders = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    abortCommittedOrderResponses: true,
    requests,
    committedOrders,
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '응답 유실 검수' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await page.getByRole('button', { name: '참여하기' }).click();
  await page.getByRole('button', { name: '참여 완료하기' }).click();

  await expect(page.getByRole('heading', { name: '그룹 참여 완료' })).toBeVisible();
  const publishIds = requests
    .filter(({ path, action }) => path.endsWith('/customer-orders') && action === 'publish')
    .map(({ request }) => request.order.id);
  expect(publishIds.length).toBeGreaterThan(1);
  expect(new Set(publishIds).size).toBe(1);
  expect(committedOrders.size).toBe(1);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_checkout_attempts_v1') || '{}',
  ))).toEqual({});
});

test('그룹 채팅의 입금확인 요청은 즉시 내 주문 상태와 안내에 반영된다', async ({ page }) => {
  const requests = [];
  const committedOrders = new Map();
  const groupState = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests, committedOrders, groupState });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '입금 상태 연동 검수' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await page.getByRole('button', { name: '참여하기' }).click();
  await page.getByRole('button', { name: '참여 완료하기' }).click();

  await expect(page.getByRole('heading', { name: '그룹 참여 완료' })).toBeVisible();
  await page.getByRole('button', { name: '그룹 채팅 바로가기' }).click();
  const paymentButton = page.getByRole('button', { name: '입금했어요' });
  await expect(page.getByRole('button', { name: /참여 취소/ })).toHaveCount(0);
  await expect(page.getByText('수량 변경은 참여를 취소한 뒤 원하는 수량으로 다시 주문해 주세요.')).toHaveCount(0);
  await expect(paymentButton).toBeVisible();
  await paymentButton.evaluate((element) => {
    const screen = element.closest('.group-room-screen');
    if (!screen) return;
    const screenBounds = screen.getBoundingClientRect();
    const buttonBounds = element.getBoundingClientRect();
    screen.scrollTop += buttonBounds.top - screenBounds.top - 180;
  });
  page.once('dialog', (dialog) => dialog.accept());
  await paymentButton.click();

  await expect(page.locator('.room-notice')).toContainText(
    '입금확인 요청 상태가 채팅과 내 주문에 반영되었습니다.',
  );
  await expect(page.locator('.payment-chip.requested')).toHaveText('입금확인요청');
  expect(requests.some(({ path, action }) => (
    path.endsWith('/group-ops') && action === 'transition_payment'
  ))).toBe(true);

  await page.getByRole('button', { name: '뒤로' }).click();
  await expect(page.getByRole('heading', { name: '공동구매 상세' })).toBeVisible();
  await page.getByRole('button', { name: '뒤로' }).click();
  await page.getByRole('button', { name: '내 주문' }).click();
  await expect(page.locator('.customer-payment-state.requested')).toContainText(
    '입금확인요청 전송 완료',
  );
  await expect(page.getByRole('button', { name: '참여 취소', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '그룹 채팅', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '요청 취소', exact: true }).click();
  await expect(page.locator('.payment-chip.pending')).toHaveText('입금대기');
  await expect(page.getByRole('button', { name: /참여 취소/ })).toHaveCount(0);
  expect([...committedOrders.values()]).toEqual([
    expect.objectContaining({ paymentStatus: 'pending', selectedCount: 1, status: 'new' }),
  ]);
  expect(requests.filter(({ action }) => ['cancel_participation', 'delete'].includes(action))).toEqual([]);
});

test('주문 연결을 검증할 수 없으면 입금 상태를 바꾸지 않고 관리자 점검을 안내한다', async ({ page }) => {
  const requests = [];
  const committedOrders = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    requests,
    committedOrders,
    paymentTransitionError: 'order_payment_link_required',
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '과거 주문 연결 검수' });
  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await page.getByRole('button', { name: '참여하기' }).click();
  await page.getByRole('button', { name: '참여 완료하기' }).click();
  await page.getByRole('button', { name: '그룹 채팅 바로가기' }).click();

  const paymentButton = page.getByRole('button', { name: '입금했어요', exact: true });
  await paymentButton.evaluate((element) => {
    const screen = element.closest('.group-room-screen');
    screen.scrollTop += element.getBoundingClientRect().top - screen.getBoundingClientRect().top - 180;
  });
  page.once('dialog', (dialog) => dialog.accept());
  await paymentButton.click();

  await expect(page.locator('.room-error')).toContainText('과거 주문과 그룹 참여 기록의 연결을 확인해야 합니다.');
  await expect(page.locator('.room-error')).toContainText('입금 상태는 변경하지 않았습니다.');
  await expect(page.locator('.payment-chip.pending')).toHaveText('입금대기');
  await expect(page.locator('.room-notice')).toHaveCount(0);
  expect([...committedOrders.values()]).toEqual([
    expect.objectContaining({ paymentStatus: 'pending' }),
  ]);
  expect(requests.filter(({ action }) => action === 'transition_payment')).toHaveLength(1);
});

test('호스트 자기 입금은 지연·실패·재시도가 버튼 옆에 보이고 연속 클릭을 한 번만 처리한다', async ({ page }, testInfo) => {
  const requests = [];
  const paymentAttempts = [];
  let releaseFirstAttempt;
  const firstAttemptResponse = new Promise((resolve) => { releaseFirstAttempt = resolve; });
  let holdFailureSnapshot = false;
  let heldSnapshots = 0;
  let releaseFailureSnapshot;
  const failureSnapshotResponse = new Promise((resolve) => { releaseFailureSnapshot = resolve; });
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests });
  await page.route('**/api/group-ops', async (route) => {
    const request = route.request().postDataJSON() || {};
    if (request.action === 'snapshot' && holdFailureSnapshot) {
      heldSnapshots += 1;
      await failureSnapshotResponse;
      return route.fallback();
    }
    if (request.action !== 'transition_payment') return route.fallback();
    paymentAttempts.push(request);
    if (paymentAttempts.length !== 1) return route.fallback();
    await firstAttemptResponse;
    return route.fulfill({ status: 409, json: { ok: false, error: 'order_payment_link_required' } });
  });
  const feedback = page.locator('.payment-feedback');
  const expectFeedbackUnobscured = async () => {
    await expect(feedback).toBeInViewport({ ratio: 1 });
    const geometry = await feedback.evaluate((element) => {
      const screen = element.closest('.group-room-screen');
      const rect = element.getBoundingClientRect();
      const nav = screen.querySelector('.room-nav').getBoundingClientRect();
      const composer = screen.querySelector('.chat-composer').getBoundingClientRect();
      const foreground = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { top: rect.top, bottom: rect.bottom, navBottom: nav.bottom, composerTop: composer.top,
        receivesHit: element === foreground || element.contains(foreground) };
    });
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.navBottom);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.composerTop);
    expect(geometry.receivesHit).toBe(true);
  };
  try {
    await page.goto('/customer');
    await completeOnboarding(page, { name: '호스트 입금 지연 검수' });
    await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
    await page.getByRole('button', { name: '그룹방 만들기' }).click();
    await page.getByRole('button', { name: '그룹방 생성' }).click();
    const paymentButton = page.getByRole('button', { name: '입금했어요', exact: true });
    await paymentButton.evaluate((element) => {
      const screen = element.closest('.group-room-screen');
      screen.scrollTop += element.getBoundingClientRect().top - screen.getBoundingClientRect().top - 180;
    });
    let confirmations = 0;
    page.on('dialog', async (dialog) => { confirmations += 1; await dialog.accept(); });
    await paymentButton.evaluate((element) => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect.poll(() => paymentAttempts.length).toBe(1);
    expect(confirmations).toBe(1);
    await expect(feedback.getByRole('status')).toContainText('입금 상태를 저장하고 있습니다.');
    await expect(page.getByRole('button', { name: '처리 중…', exact: true })).toBeDisabled();
    await expectFeedbackUnobscured();
    await page.screenshot({ path: testInfo.outputPath('host-payment-processing.png'), fullPage: true });

    holdFailureSnapshot = true;
    releaseFirstAttempt();
    await expect(feedback.getByRole('alert')).toContainText('입금 상태는 변경하지 않았습니다.');
    await expect.poll(() => heldSnapshots).toBeGreaterThan(0);
    // A stalled follow-up read must not keep the explicit retry disabled.
    await expect(page.getByRole('button', { name: '입금 상태 다시 확인', exact: true }))
      .toBeEnabled({ timeout: 2000 });
    await expectFeedbackUnobscured();
    await page.screenshot({ path: testInfo.outputPath('host-payment-error-visible.png'), fullPage: true });
    await expect(page.locator('.payment-chip.pending')).toHaveText('입금대기');

    holdFailureSnapshot = false;
    releaseFailureSnapshot();
    await page.getByRole('button', { name: '입금 상태 다시 확인', exact: true }).click();
    await expect(page.locator('.payment-chip.requested')).toHaveText('입금확인요청');
    await expect(feedback.getByRole('status')).toContainText('입금확인 요청 상태');
    await expectFeedbackUnobscured();
    expect(paymentAttempts).toHaveLength(2);
    await expect(page.getByRole('button', { name: '입금 상태 다시 확인', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('host-payment-retried.png'), fullPage: true });
  } finally {
    releaseFirstAttempt();
    releaseFailureSnapshot();
  }
});

test('사라진 참여자의 보류된 입금 요청은 같은 요청으로 확인한 뒤 현재 입금 버튼 잠금을 해제한다', async ({ page }) => {
  const paymentRequests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page);
  await page.route('**/api/group-ops', async (route) => {
    const request = route.request().postDataJSON() || {};
    if (request.action !== 'transition_payment') return route.fallback();
    paymentRequests.push(request);
    return route.fulfill({ status: 409, json: { ok: false, error: 'participant_not_found' } });
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '이전 입금 요청 검수' });
  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();
  await expect(page.getByRole('button', { name: '입금했어요', exact: true })).toBeEnabled();
  const intent = await page.evaluate(() => {
    const credentials = JSON.parse(localStorage.getItem('o2o_mvp_group_credentials_v1'));
    const credential = Object.values(credentials).find((item) => item.role === 'host');
    const intent = { action: 'transition_payment', groupId: credential.groupId, actorId: credential.actorId,
      participantActorId: 'departed-participant', direction: 'next', fromStatus: 'requested', toStatus: 'confirmed',
      expectedVersion: 7, clientMutationId: 'transition-payment-departed-member-001' };
    const key = `${intent.action}::${intent.groupId}::${intent.actorId}::${intent.participantActorId}`;
    localStorage.setItem('o2o_mvp_group_transition_mutations_v1', JSON.stringify({ [key]: intent }));
    return intent;
  });
  await page.goto(`/customer?group=${intent.groupId}&view=room`);
  await expect(page.getByRole('button', { name: '입금했어요', exact: true })).toBeDisabled();
  const retry = page.getByRole('button', { name: '이전 입금 요청 결과 확인', exact: true });
  await expect(retry).toBeInViewport({ ratio: 1 });
  page.once('dialog', (dialog) => dialog.accept());
  await retry.click();
  await expect.poll(() => paymentRequests.length).toBe(1);
  expect(paymentRequests[0]).toMatchObject(intent);
  await expect(page.locator('.room-error')).toContainText('참여자를 찾을 수 없습니다.');
  await expect(page.getByRole('button', { name: '입금했어요', exact: true })).toBeEnabled();
  await expect(retry).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('o2o_mvp_group_transition_mutations_v1')))).toEqual({});
});

test('호스트 입금완료 되돌리기와 요청 취소는 참여 취소 숨김과 무관하게 작동한다', async ({ page }) => {
  const requests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '입금 복구 검수' });
  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();
  await expect(page.locator('.group-room-screen')).toBeVisible();
  for (const [button, status] of [
    ['입금했어요', 'requested'],
    ['입금 확인', 'confirmed'],
    ['완료 취소', 'requested'],
    ['요청 취소', 'pending'],
  ]) {
    const control = page.getByRole('button', { name: button, exact: true });
    await control.evaluate((element) => {
      const screen = element.closest('.group-room-screen');
      screen.scrollTop += element.getBoundingClientRect().top - screen.getBoundingClientRect().top - 180;
    });
    page.once('dialog', (dialog) => dialog.accept());
    await control.click();
    await expect(page.locator(`.payment-chip.${status}`)).toBeVisible();
    await expect(page.getByRole('button', { name: /참여 취소/ })).toHaveCount(0);
  }
  expect(requests.filter(({ action }) => action === 'transition_payment')
    .map(({ request }) => request.toStatus)).toEqual(['requested', 'confirmed', 'requested', 'pending']);
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await expect(page.locator('.deal-management')).toBeVisible();
  await expect(page.locator('.deal-management').getByRole('button', { name: '수정', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '상품 삭제', exact: true })).toHaveCount(0);
  expect(requests.filter(({ action }) => ['cancel_participation', 'delete'].includes(action))).toEqual([]);
});

test('사용자 생성 그룹은 중앙 주문 저장 확인 뒤에만 입금 요청하고 내 주문에 반영한다', async ({ page }) => {
  const requests = [];
  const committedOrders = new Map();
  let failPublication = false;
  let rejectStaleReservation = false;
  let canonicalReservation = null;
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    requests, committedOrders,
    shouldFailOrderPublish: (request) => failPublication
      || (rejectStaleReservation && Boolean(request.order?.reservationMutationId)
        && request.order.reservationMutationId !== canonicalReservation),
    repairAcceptedOrder: (order) => (
      rejectStaleReservation && !order?.reservationMutationId && canonicalReservation
        ? {
            ...order,
            reservationMutationId: canonicalReservation,
            reservationAction: 'create',
            reservationQuantity: Number(order.selectedCount || order.quantity || 1),
          }
        : order
    ),
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '생성자 주문 선저장 검수' });
  await page.getByRole('button', { name: /아메리카노 10잔 번들/ }).click();
  await page.getByRole('button', { name: '그룹방 만들기' }).click();
  await page.getByRole('button', { name: '그룹방 생성' }).click();
  await expect(page.locator('.group-room-screen')).toBeVisible();
  await expect.poll(() => committedOrders.size).toBe(1);
  expect([...committedOrders.values()][0].type).toBe('group');
  canonicalReservation = 'central-create-reservation-repaired';
  await expect.poll(() => page.evaluate(async () => {
    const { customerOrderSyncFingerprint } = await import('/src/customerHistory.js');
    const orders = JSON.parse(localStorage.getItem('o2o_mvp_customer_orders') || '[]');
    const fingerprints = JSON.parse(localStorage.getItem('o2o_mvp_customer_order_sync_fingerprints') || '{}');
    return orders.length === 1 && fingerprints[orders[0].id] === customerOrderSyncFingerprint(orders[0]);
  })).toBe(true);

  // Retain a rejected creator order with no successful acknowledgement. The
  // issue also prevents unrelated background publishing from racing this
  // explicit retry scenario or an earlier read restoring the cleared receipt.
  failPublication = true;
  committedOrders.clear();
  await page.evaluate(async () => {
    const { customerOrderSyncFingerprint } = await import('/src/customerHistory.js');
    const orders = JSON.parse(localStorage.getItem('o2o_mvp_customer_orders') || '[]');
    const key = 'o2o_mvp_customer_order_sync_fingerprints';
    const fingerprints = JSON.parse(localStorage.getItem(key) || '{}');
    const issueKey = 'o2o_mvp_customer_order_sync_issues_v1';
    const issues = JSON.parse(localStorage.getItem(issueKey) || '{}');
    orders.filter((order) => order.type === 'group').forEach((order) => {
      delete fingerprints[order.id];
      issues[order.id] = { state: 'failed', code: 'order_reservation_unverified',
        fingerprint: customerOrderSyncFingerprint(order) };
    });
    localStorage.setItem(key, JSON.stringify(fingerprints));
    localStorage.setItem(issueKey, JSON.stringify(issues));
  });
  const requestButton = page.getByRole('button', { name: '입금했어요', exact: true });
  await expect(requestButton).toBeVisible();
  const scrollPaymentIntoView = () => requestButton.evaluate((element) => {
    const screen = element.closest('.group-room-screen');
    screen.scrollTop += element.getBoundingClientRect().top - screen.getBoundingClientRect().top - 180;
  });
  await scrollPaymentIntoView();
  page.once('dialog', (dialog) => dialog.accept());
  await requestButton.click();
  await expect(page.locator('.room-error')).toContainText('입금 상태는 변경하지 않았습니다.');
  // Mutation failure re-reads the room. Wait for that read and another
  // background refresh: neither may erase the user's failed-action notice.
  await expect(requestButton).toBeEnabled();
  const snapshotsBeforeRefresh = requests.filter(({ action }) => action === 'snapshot').length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => requests.filter(({ action }) => action === 'snapshot').length)
    .toBeGreaterThan(snapshotsBeforeRefresh);
  await expect(page.locator('.room-error')).toContainText('입금 상태는 변경하지 않았습니다.');
  await expect(page.locator('.payment-chip.pending')).toHaveText('입금대기');
  expect(requests.filter(({ action }) => action === 'transition_payment')).toHaveLength(0);

  failPublication = false;
  rejectStaleReservation = true;
  const retryStartIndex = requests.length;
  await scrollPaymentIntoView();
  page.once('dialog', (dialog) => dialog.accept());
  await requestButton.click();
  await expect(page.locator('.payment-chip.requested')).toHaveText('입금확인요청');
  const paymentIndex = requests.findIndex(({ action }) => action === 'transition_payment');
  const recoveryPublishes = requests.slice(retryStartIndex, paymentIndex).filter(({ path, action }) => (
    path.endsWith('/customer-orders') && action === 'publish'
  ));
  expect(recoveryPublishes).toHaveLength(2);
  expect(recoveryPublishes[0].request.order.reservationMutationId).toBeTruthy();
  expect(recoveryPublishes[1].request.order.reservationMutationId).toBeUndefined();
  expect(recoveryPublishes[1].request.order.reservationAction).toBeUndefined();
  expect(recoveryPublishes[1].request.order.reservationQuantity).toBeUndefined();
  expect(recoveryPublishes[1].request.order.clientMutationId).toBeUndefined();
  expect(committedOrders.size).toBe(1);
  expect([...committedOrders.values()][0].paymentStatus).toBe('requested');
  await page.getByRole('button', { name: '내 주문', exact: true }).click();
  await expect(page.locator('.customer-payment-state.requested')).toContainText('입금확인요청 전송 완료');
});

test('다른 기기의 입금완료·되돌리기는 채팅 갱신 후 내 주문에 반영된다', async ({ page }) => {
  const requests = [];
  const committedOrders = new Map();
  const groupState = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests, committedOrders, groupState });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '외부 입금 변경 검수' });
  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await page.getByRole('button', { name: '참여하기' }).click();
  await page.getByRole('button', { name: '참여 완료하기' }).click();
  await page.getByRole('button', { name: '그룹 채팅 바로가기' }).click();
  await expect(page.locator('.payment-chip.pending')).toBeVisible();

  const [initialOrder] = [...committedOrders.values()];
  expect(initialOrder?.groupId).toBeTruthy();
  const state = groupState.get(initialOrder.groupId);
  const participant = state.participants.find((item) => (
    item.actorId === (initialOrder.participantActorId || initialOrder.visitorId)
  ));
  expect(participant).toBeTruthy();

  // Simulate central changes made by a host on a different device. There is
  // no mutation response/onOrderUpdate shortcut in the participant's browser;
  // its normal room poll must trigger a customer-order refresh.
  for (const [paymentStatus, label] of [
    ['requested', '입금확인요청 전송 완료'],
    ['confirmed', '입금완료'],
    ['requested', '입금확인요청 전송 완료'],
    ['pending', '입금대기'],
  ]) {
    const readCount = requests.filter(({ path, action }) => (
      path.endsWith('/customer-orders') && action !== 'publish'
    )).length;
    const updatedAt = new Date().toISOString();
    participant.paymentStatus = paymentStatus;
    participant.version += 1;
    participant.updatedAt = updatedAt;
    const previousOrder = committedOrders.get(initialOrder.id);
    committedOrders.set(initialOrder.id, {
      ...previousOrder,
      paymentStatus,
      paymentVersion: Math.max(previousOrder.paymentVersion || 0, previousOrder.version || 0) + 1,
      statusUpdatedAt: updatedAt,
      syncedAt: updatedAt,
    });

    await expect(page.locator(`.payment-chip.${paymentStatus}`)).toBeVisible();
    await expect.poll(() => requests.filter(({ path, action }) => (
      path.endsWith('/customer-orders') && action !== 'publish'
    )).length).toBeGreaterThan(readCount);
    await page.getByRole('button', { name: '뒤로' }).click();
    await page.getByRole('button', { name: '뒤로' }).click();
    await page.getByRole('button', { name: '내 주문' }).click();
    await expect(page.locator(`.customer-payment-state.${paymentStatus}`)).toContainText(label);
    await page.getByRole('button', { name: '그룹 채팅', exact: true }).click();
    await expect(page.locator(`.payment-chip.${paymentStatus}`)).toBeVisible();
  }
});

test('주문 저장 여부를 확인할 수 없으면 완료로 넘기지 않고 같은 ID로 재시도한다', async ({ page }) => {
  const requests = [];
  const committedOrders = new Map();
  const groupState = new Map();
  await page.unroute('**/api/**');
  await mockCentralApis(page, {
    abortCommittedOrderResponses: true,
    abortOrderReads: true,
    requests,
    committedOrders,
    groupState,
  });
  await page.goto('/customer');
  await completeOnboarding(page, { name: '확인 대기 검수' });

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await page.getByRole('button', { name: '참여하기' }).click();
  await page.getByRole('button', { name: '참여 완료하기' }).click();

  await expect(page.getByRole('alert')).toContainText('중복 주문을 막기 위해');
  await expect(page.getByRole('heading', { name: '메뉴 선택' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '그룹 참여 완료' })).toHaveCount(0);
  const pendingOrders = await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_customer_orders') || '[]',
  ));
  expect(pendingOrders).toHaveLength(1);
  const pendingOrderId = pendingOrders[0].id;

  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests, committedOrders, groupState });
  await page.getByRole('button', { name: '참여 완료하기' }).click();

  await expect(page.getByRole('heading', { name: '그룹 참여 완료' })).toBeVisible();
  const publishIds = requests
    .filter(({ path, action }) => path.endsWith('/customer-orders') && action === 'publish')
    .map(({ request }) => request.order.id);
  expect(publishIds.length).toBeGreaterThan(1);
  expect(new Set(publishIds)).toEqual(new Set([pendingOrderId]));
  expect(committedOrders.size).toBe(1);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_customer_orders') || '[]',
  ))).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('o2o_mvp_checkout_attempts_v1') || '{}',
  ))).toEqual({});
});

test('관리자 화면의 알림 버튼은 알림 목록을 열고 복귀한다', async ({ page }) => {
  await page.goto('/admin');
  await completeOnboarding(page, { name: '관리자 검수' });
  await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '일반 상품 화면 미리보기', exact: true }).click();

  await page.getByRole('button', { name: /그룹 알림 \d+건/ }).click();
  await expect(page.getByRole('heading', { name: '그룹 알림', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '뒤로' }).click();
  await expect(page.getByPlaceholder('매장 또는 상품 검색')).toBeVisible();
});

test('관리자에게 참여자 전용 호스트 지원 액션을 노출하지 않는다', async ({ page }) => {
  await page.goto('/admin');
  await completeOnboarding(page, { name: '관리 권한 검수' });
  await page.getByRole('button', { name: '일반 상품 화면 미리보기', exact: true }).click();

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();

  await expect(page.getByRole('heading', { name: '공동구매 상세' })).toBeVisible();
  await expect(page.getByRole('button', { name: '호스트 지원하기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '참여하기' })).toHaveCount(0);
});

test('관리자 전환은 이전 사용자 탭을 폐기하고 관리 전용 화면만 허용한다', async ({ page }) => {
  await page.goto('/customer');
  await completeOnboarding(page, { name: '일반 사용자' });
  await page.getByRole('button', { name: '내 주문' }).click();
  await expect(page.getByRole('heading', { name: '참여 내역', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '관리자 앱' }).click();
  await completeOnboarding(page, { name: '관리자 전환', phone: '010-9999-8888' });

  await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
  await expect(page.getByLabel('관리자 PIN', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '일반 상품 화면 미리보기', exact: true }).click();
  await expect(page.getByPlaceholder('매장 또는 상품 검색')).toBeVisible();
  await expect(page.getByRole('heading', { name: '참여 내역', exact: true })).toHaveCount(0);
  await expect(page.locator('.bottom-nav button')).toHaveCount(1);
  await expect(page.locator('.bottom-nav button')).toContainText('홈');
  await expect(page.getByRole('button', { name: '예상 부담금 계산기' })).toHaveCount(0);

  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await expect(page.getByRole('button', { name: '좋아요' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '참여하기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '그룹방 만들기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /그룹 채팅|거래 상태 관리/ })).toBeVisible();

  await page.getByRole('button', { name: '뒤로' }).click();
  await page.getByRole('button', { name: '사용자 앱' }).click();
  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.locator('.bottom-nav button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '예상 부담금 계산기' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: '관리자 운영 관리', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '일반 상품 화면 미리보기', exact: true }).click();
  await expect(page.locator('.bottom-nav button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '내 주문' })).toHaveCount(0);
});

test('사장님 헤더의 사용자 앱 전환은 로그인 후 메뉴 6개를 유지하고 직접 주소만 읽기 전용이다', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/owner');
  await completeOnboarding(page, { name: '직접 전환 사장님' });

  await page.getByRole('button', { name: '사용자 앱', exact: true }).click();
  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.getByText('사용자 테스트 계정 등록')).toBeVisible();
  await expect(page.locator('.bottom-nav')).toHaveCount(0);
  await completeOnboarding(page, {
    name: '직접 전환 사용자',
    phone: '010-5678-1234',
  });
  await expectBottomNavigationToFillWidth(page, 6);
  await page.waitForTimeout(1500);
  await expectBottomNavigationToFillWidth(page, 6);
  await expect(page.getByRole('button', { name: '내 주문' })).toBeVisible();
  await expect(page.getByRole('button', { name: '찜', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '마이', exact: true })).toBeVisible();
  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await expect(page.getByRole('button', { name: '참여하기' })).toBeVisible();
  await page.getByRole('button', { name: '뒤로' }).click();

  await page.getByRole('button', { name: '사장님 앱' }).click();
  await expect(page.getByText('사장님 테스트 계정 등록')).toBeVisible();
  await page.getByRole('button', { name: '테스트 시작' }).click();
  await expect(page.getByRole('heading', { name: '메뉴 상세' })).toBeVisible();

  await page.goto('/customer');
  await expect(page.locator('.customer-preview-notice')).toBeVisible();
  await expectBottomNavigationToFillWidth(page, 3);
  await page.locator('.source-filter').getByRole('button', { name: '사용자' }).click();
  await page.getByRole('button', { name: /코스트코 체리 같이 나눠 사실 분/ }).click();
  await expect(page.getByRole('button', { name: '좋아요' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '참여하기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /그룹 채팅|거래 상태 관리/ })).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/owner$/);
  await expect(page.getByRole('heading', { name: '메뉴 상세' })).toBeVisible();
});

test('사장님 읽기 전용 상품 열기는 상태 알림을 읽음 처리하지 않는다', async ({ page }) => {
  const dealId = 'customer-read-only-status-test';
  await page.goto('/owner');
  await completeOnboarding(page, { name: '읽음 보호 사장님' });
  await page.goto('/customer');

  await page.evaluate((groupId) => {
    const actorId = localStorage.getItem('o2o_mvp_visitor_id');
    localStorage.setItem('o2o_mvp_customer_groups', JSON.stringify([{
      id: groupId,
      groupId,
      source: 'customer',
      saleType: 'community',
      visibility: 'public',
      category: '생활용품',
      region: '경기도',
      district: '성남시 분당구',
      neighborhood: '서현동',
      store: '읽음 보호 검수',
      title: '읽기 전용 상태 알림 상품',
      description: '사장님 미리보기 읽음 상태 보호 검수',
      address: '서현역',
      deadline: '2026-09-30 20:00',
      methods: ['픽업'],
      originalPrice: 12000,
      expectedPerPerson: 6000,
      unitPrice: 6000,
      target: 2,
      targetPeople: 2,
      targetCount: 2,
      current: 2,
      currentPeople: 2,
      currentCount: 2,
      participantCount: 2,
      totalQuantity: 2,
      productQuantity: 2,
      creatorQuantity: 1,
      orderedQuantity: 2,
      groupStatus: 'delivered',
      hostMode: 'self',
      hostMatched: true,
      image: '',
      menu: [{ id: 'read-only-status-menu', name: '읽음 보호 상품', price: 6000 }],
    }]));
    localStorage.setItem('o2o_mvp_group_credentials_v1', JSON.stringify({
      [`${groupId}::${actorId}`]: {
        groupId,
        actorId,
        role: 'member',
        active: true,
        capabilityToken: `group-${'s'.repeat(64)}`,
        credentialRevision: 1,
      },
    }));
    localStorage.removeItem('o2o_mvp_group_status_seen_v1');
  }, dealId);

  await page.reload();
  const card = page.locator('.deal-card').filter({ hasText: '읽기 전용 상태 알림 상품' });
  await expect(card).toContainText('새 알림 · 픽업 완료');
  await expect.poll(() => page.evaluate(() => (
    localStorage.getItem('o2o_mvp_group_status_seen_v1')
  ))).toBeNull();

  await card.click();
  await expect(page.getByRole('heading', { name: '공동구매 상세' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('o2o_mvp_group_status_seen_v1'))).toBeNull();

  await page.getByRole('button', { name: '뒤로' }).click();
  await expect(card).toContainText('새 알림 · 픽업 완료');
});

test('사장님 사용자 미리보기는 탐색만 가능하고 고객 데이터를 변경하지 않는다', async ({ page }) => {
  const requests = [];
  await page.unroute('**/api/**');
  await mockCentralApis(page, { requests });
  await page.goto('/owner');
  await completeOnboarding(page, { name: '미리보기 사장님' });

  await page.getByLabel('매장명').fill('미리보기 매장');
  await page.getByLabel('상품명').fill('읽기 전용 상품');
  await page.getByLabel('정상가').fill('15000');
  await page.locator('.method-grid').getByRole('button', { name: '픽업' }).click();
  await page.getByLabel('픽업 위치').fill('미리보기 수령 장소');
  await page.getByRole('button', { name: '상품 등록 완료' }).click();
  await expect(page.getByRole('heading', { name: '등록 완료' })).toBeVisible();

  requests.length = 0;
  await page.getByRole('button', { name: '사용자 화면에서 보기' }).click();
  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.getByRole('heading', { name: '공동구매 상세' })).toBeVisible();
  await expect(page.getByRole('button', { name: '좋아요' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '참여하기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '그룹방 만들기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /그룹 채팅|거래 상태 관리/ })).toHaveCount(0);

  await page.getByRole('button', { name: '뒤로' }).click();
  await expect(page.locator('.customer-preview-notice')).toBeVisible();
  await expectBottomNavigationToFillWidth(page, 3);
  await expect(page.getByRole('button', { name: '내 주문' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '찜' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '마이' })).toHaveCount(0);

  const persistedMerchantProfile = await page.evaluate(() => localStorage.getItem('o2o_mvp_profile'));
  await page.locator('.location-trigger').click();
  const locationDialog = page.getByRole('dialog', { name: '지역 설정' });
  await locationDialog.getByLabel('시·도').selectOption({ label: '서울특별시' });
  await locationDialog.getByRole('button', { name: /적용$/ }).click();
  await expect(page.locator('.location-trigger')).toContainText('개포동');
  expect(await page.evaluate(() => localStorage.getItem('o2o_mvp_profile')))
    .toBe(persistedMerchantProfile);

  await page.getByRole('button', { name: '계산', exact: true }).click();
  await expect(page.getByRole('heading', { name: '예상 부담금 계산기' })).toBeVisible();
  await expectBottomNavigationToFillWidth(page, 3);
  await expect(page.locator('.bottom-nav button[aria-current="page"]')).toContainText('계산');
  await expect(page.getByRole('button', { name: '이 조건으로 그룹 만들기' })).toHaveCount(0);
  await expect(page.getByText('사장님 미리보기에서는 예상 금액만 확인할 수 있습니다.')).toBeVisible();

  await page.reload();
  await expect(page.locator('.customer-preview-notice')).toBeVisible();
  await expectBottomNavigationToFillWidth(page, 3);
  await page.getByRole('button', { name: /읽기 전용 상품/ }).click();
  await expect(page.getByRole('heading', { name: '공동구매 상세' })).toBeVisible();
  await expect(page.getByRole('button', { name: '좋아요' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '참여하기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /그룹 채팅|거래 상태 관리/ })).toHaveCount(0);

  const forbiddenActions = new Set([
    'publish',
    'delete',
    'create',
    'join',
    'reserve',
    'claim_host',
    'cancel_participation',
  ]);
  expect(requests.filter((entry) => forbiddenActions.has(entry.action))).toEqual([]);

  await page.goBack();
  await expect(page).toHaveURL(/\/owner$/);
  await expect(page.getByRole('heading', { name: '메뉴 상세' })).toBeVisible();
});
