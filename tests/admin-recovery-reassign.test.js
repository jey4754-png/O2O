import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/admin-ops.js';
import { adminStore } from './helpers/admin-store.js';
import { fakeSheet, imageResponse } from './helpers/product-image-store.js';
import { readFileSync } from 'node:fs';

const PHONE = '01055556666';
const LOST = 'a'.repeat(64);
const DEVICE = 'b'.repeat(64);
const STRANGER = 'd'.repeat(64);
const RECOVERY_HEADERS = ['등록시각', '갱신시각', '식별키', '검증자', '결박해시', '현재해시',
  '결박주문', '결박그룹', '결박상품', '참여자ID', '버전', '마지막변경ID'];

function store() {
  const built = adminStore();
  const recovery = fakeSheet();
  recovery.rows.push([...RECOVERY_HEADERS]);
  built.data.recovery = recovery;
  const ensure = built.context.ensureSheets_;
  built.context.ensureSheets_ = () => ({ ...ensure(), recovery });
  return { ...built, recovery };
}

const order = (id, hash, dealId, overrides = {}) => ({
  id, dealId, customerPhone: PHONE, type: 'purchase', status: 'new',
  paymentStatus: 'pending', quantity: 1, selectedCount: 1, version: 1, paymentVersion: 1,
  visitorId: 'visitor-lost-device', _customerCapabilityHash: hash, ...overrides,
});

function seed(built, hashById) {
  const ids = [];
  Object.entries(hashById).forEach(([id, hash]) => {
    const value = order(id, hash, built.dealId);
    built.data.customerOrders.rows.push(['', id, PHONE, JSON.stringify(value)]);
    ids.push(id);
  });
  return ids;
}

const request = (built, overrides = {}) => ({
  action: 'recovery_reassign', adminAssertion: true, actorId: 'operator_admin',
  dealId: built.dealId, clientMutationId: 'admin-recovery-0001',
  reason: '유선 본인확인 완료 · 기기 교체', capabilityHash: DEVICE, ...overrides,
});

// The collector runs in its own VM realm, so its arrays fail a strict deep
// comparison on prototype identity alone. Copy into this realm first.
const readOrderIds = (context, hash) => {
  const result = context.getCustomerOrdersResponse_(PHONE, 'visitor-lost-device', hash);
  assert.equal(result.ok, true, result.error);
  return Array.from(result.orders || [], (item) => String(item.id)).sort();
};

const historyRow = (built) => {
  const rows = built.data.groupHistory.rows;
  return rows.find((row) => String(row[6]) === 'admin_recovery_reassign') || null;
};

test('관리자 승계 등록은 PIN 검증을 통과한 요청에서만 동작한다', () => {
  const built = store();
  const ids = seed(built, { 'order-1700000009001': LOST });

  // handleAdminOperation_ only ever sees adminAssertion from the PIN-verified
  // Vercel function; a forged collector call must not reach the recovery sheet.
  const forged = built.context.handleAdminOperation_({
    ...request(built, { orderIds: ids }), adminAssertion: false,
  });
  assert.equal(forged.error, 'forbidden');
  assert.equal(built.recovery.rows.length, 1, '승계 행이 생기지 않는다');
  assert.equal(historyRow(built), null, '이력도 남지 않는다');
  assert.deepEqual(readOrderIds(built.context, DEVICE), [], '새 기기는 여전히 조회하지 못한다');
});

test('관리자 승계 등록은 지정한 주문만 결박하고 사유를 상태 이력에 남긴다', () => {
  const built = store();
  const [picked, skipped] = seed(built, {
    'order-1700000009101': LOST,
    'order-1700000009102': LOST,
  });
  const before = JSON.stringify(built.data.customerOrders.rows);

  const result = built.context.handleAdminOperation_(request(built, { orderIds: [picked] }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.recovery.orders, 1);

  const row = built.recovery.rows.at(-1);
  assert.equal(row[4], LOST, '옛 소유 해시를 그대로 결박한다');
  assert.equal(row[5], DEVICE, '새 기기 해시가 현재 해시가 된다');
  assert.deepEqual(JSON.parse(row[6]), [picked], '지정한 주문만 결박한다');
  assert.equal(String(row[2]).startsWith('admin:'), true,
    '관리자 승계 행의 식별키는 전화번호 sha256 공간과 겹치지 않는다');

  const history = historyRow(built);
  assert.notEqual(history, null, '상태 이력에 남는다');
  assert.equal(history[9], '유선 본인확인 완료 · 기기 교체', '변경 사유가 그대로 남는다');
  assert.equal(history[7], 'operator_admin');
  assert.equal(history[8], 'admin');
  assert.equal(history[3], built.dealId);
  assert.equal(JSON.parse(history[13]).orderIds[0], picked);

  assert.equal(JSON.stringify(built.data.customerOrders.rows), before,
    '주문 행은 다시 쓰지 않는다');
  assert.deepEqual(readOrderIds(built.context, DEVICE), [picked],
    '재연결된 기기는 지정된 주문만 본다');
  assert.deepEqual(readOrderIds(built.context, LOST), [picked, skipped].sort(),
    '원래 키는 그대로 동작한다');
  assert.deepEqual(readOrderIds(built.context, STRANGER), [],
    '제3자의 키로는 아무것도 조회되지 않는다');
});

test('사유 없는 승계 등록은 거절되고 아무 흔적도 남기지 않는다', () => {
  const built = store();
  const ids = seed(built, { 'order-1700000009201': LOST });
  const denied = built.context.handleAdminOperation_(request(built, { orderIds: ids, reason: '   ' }));
  assert.equal(denied.error, 'reason_required');
  assert.equal(built.recovery.rows.length, 1);
  assert.equal(historyRow(built), null);
});

test('같은 요청을 다시 보내면 중복이고, 내용이 바뀌면 충돌이다', () => {
  const built = store();
  const ids = seed(built, {
    'order-1700000009301': LOST,
    'order-1700000009302': LOST,
  });
  assert.equal(built.context.handleAdminOperation_(request(built, { orderIds: [ids[0]] })).ok, true);

  const retried = built.context.handleAdminOperation_(request(built, { orderIds: [ids[0]] }));
  assert.equal(retried.duplicate, true);
  assert.equal(built.recovery.rows.length, 2, '재시도가 승계 행을 늘리지 않는다');

  const changed = built.context.handleAdminOperation_(request(built, { orderIds: ids }));
  assert.equal(changed.error, 'client_mutation_conflict');
  assert.equal(built.recovery.rows.length, 2);
});

test('한 기기에 두 번째 승계를 기록해 기존 승계를 무효로 만들 수 없다', () => {
  const built = store();
  const ids = seed(built, {
    'order-1700000009401': LOST,
    'order-1700000009402': STRANGER,
  });
  assert.equal(built.context.handleAdminOperation_(request(built, { orderIds: [ids[0]] })).ok, true);

  const second = built.context.handleAdminOperation_(request(built, {
    orderIds: [ids[1]], clientMutationId: 'admin-recovery-0002',
  }));
  // recoverySuccession_ 은 승계가 하나로 확정될 때만 권한을 준다. 두 행을
  // 허용하면 이미 되살린 주문까지 다시 사라진다.
  assert.equal(second.error, 'recovery_succession_exists');
  assert.deepEqual(readOrderIds(built.context, DEVICE), [ids[0]], '첫 승계는 그대로 살아 있다');
});

test('소유 키가 서로 다르거나 없는 주문은 한 번에 결박하지 않는다', () => {
  const built = store();
  const ids = seed(built, {
    'order-1700000009501': LOST,
    'order-1700000009502': STRANGER,
  });
  built.data.customerOrders.rows.push(['', 'order-1700000009503', PHONE,
    JSON.stringify(order('order-1700000009503', '', built.dealId))]);

  assert.equal(built.context.handleAdminOperation_(request(built, { orderIds: ids })).error,
    'recovery_mixed_ownership');
  assert.equal(built.context.handleAdminOperation_(request(built, {
    orderIds: ['order-1700000009503'],
  })).error, 'order_ownership_unclaimable');
  assert.equal(built.context.handleAdminOperation_(request(built, {
    orderIds: ['order-1700000009599'],
  })).error, 'order_not_found');
  assert.equal(built.recovery.rows.length, 1);
});

test('다른 상품의 주문은 선택한 상품의 재연결에 섞일 수 없다', () => {
  const built = store();
  const mine = seed(built, { 'order-1700000009601': LOST });
  const foreign = order('order-1700000009602', LOST, 'owner-another-product');
  built.data.customerOrders.rows.push(['', foreign.id, PHONE, JSON.stringify(foreign)]);

  assert.equal(built.context.handleAdminOperation_(request(built, {
    orderIds: [mine[0], foreign.id],
  })).error, 'order_not_found');
  assert.equal(built.recovery.rows.length, 1);
});

test('새 기기가 이미 소유한 주문은 재연결 대상이 아니다', () => {
  const built = store();
  const ids = seed(built, { 'order-1700000009701': DEVICE });
  assert.equal(built.context.handleAdminOperation_(request(built, { orderIds: ids })).error,
    'recovery_already_owned');
  assert.equal(built.recovery.rows.length, 1);
});

test('관리자 승계 행은 복구 API 의 식별키 조회로 잡히지 않는다', () => {
  const built = store();
  const ids = seed(built, { 'order-1700000009801': LOST });
  assert.equal(built.context.handleAdminOperation_(request(built, { orderIds: ids })).ok, true);
  const identityKey = String(built.recovery.rows.at(-1)[2]);

  // 복구 API 는 전화번호 sha256(64hex)만 식별키로 받는다. 접두사가 붙은 관리자
  // 행은 begin·enroll·redeem 어느 경로에서도 조회되지 않아야 한다.
  assert.equal(/^[a-f0-9]{64}$/.test(identityKey), false);
  const denied = built.context.handleRecoveryCredentials_({
    operation: 'redeem', identityKey, capabilityHash: STRANGER,
    redeemAssertion: true, clientMutationId: 'redeem-attempt-0001',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'invalid_recovery_request');
});

test('관리자 승계 이력은 그룹 채팅방 이력으로 새지 않는다', () => {
  const built = store();
  const ids = seed(built, { 'order-1700000009901': LOST });
  assert.equal(built.context.handleAdminOperation_(request(built, { orderIds: ids })).ok, true);
  const scoped = built.context.historyForGroup_(built.data, built.dealId);
  assert.equal(
    Array.from(scoped, (item) => String(item.action)).includes('admin_recovery_reassign'),
    false,
    '본인 확인 메모가 그룹 참여자에게 보이면 안 된다',
  );
});

test('관리자 API 는 PIN 없이는 재연결을 시작하지 않고 잘못된 입력을 먼저 거른다', async () => {
  const envKeys = ['O2O_ADMIN_PIN', 'O2O_DATA_API_ORIGIN', 'GOOGLE_SHEETS_COLLECTOR_URL',
    'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.O2O_ADMIN_PIN = 'test-private-pin';
  process.env.O2O_DATA_API_ORIGIN = '';
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.invalid/admin-recovery-test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'private-test-token';
  const originalFetch = globalThis.fetch;
  const collectorRequests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    collectorRequests.push(body);
    if (body.action === 'admin_credentials') {
      if (body.payload.operation === 'read') {
        return { status: 200, json: async () => ({ ok: true, credential: null }) };
      }
      return { status: 200, json: async () => ({ ok: true, allowed: true,
        ...(body.payload.operation === 'rate_begin' ? { reserved: true } : {}) }) };
    }
    return { status: 200, json: async () => ({ ok: true, recovery: { version: 1, orders: 1 } }) };
  };
  const base = {
    action: 'recovery_reassign', dealId: 'owner-image-quality-regression', actorId: 'operator_admin',
    clientMutationId: 'admin-recovery-api-001', reason: '대면 본인확인 완료',
    capabilityHash: DEVICE, orderIds: ['order-1700000009001'],
  };
  try {
    for (const [body, expected] of [
      [{ ...base }, 'invalid_admin_pin'],
      [{ ...base, adminPin: 'wrong' }, 'invalid_admin_pin'],
      [{ ...base, adminAssertion: true }, 'invalid_admin_pin'],
      [{ ...base, adminPin: 'test-private-pin', reason: '  ' }, 'reason_required'],
      [{ ...base, adminPin: 'test-private-pin', capabilityHash: `customer-${DEVICE}` }, 'invalid_recovery_capability'],
      [{ ...base, adminPin: 'test-private-pin', capabilityHash: DEVICE.toUpperCase().slice(0, 63) }, 'invalid_recovery_capability'],
      [{ ...base, adminPin: 'test-private-pin', orderIds: [] }, 'invalid_order_ids'],
      [{ ...base, adminPin: 'test-private-pin', orderIds: ['order-1700000009001', 'order-1700000009001'] }, 'invalid_order_ids'],
      [{ ...base, adminPin: 'test-private-pin', orderIds: ['deal-1700000009001'] }, 'invalid_order_id'],
      [{ ...base, adminPin: 'test-private-pin', clientMutationId: 'short' }, 'invalid_client_mutation_id'],
    ]) {
      const response = imageResponse();
      await handler({ method: 'POST', body, headers: { origin: 'http://localhost:5173' } }, response);
      assert.equal(response.body.error, expected, JSON.stringify(body));
      assert.equal(collectorRequests.filter((item) => item.action === 'admin_operation').length, 0,
        '검증 전에는 수집기 작업이 시작되지 않는다');
    }
    const accepted = imageResponse();
    await handler({ method: 'POST', headers: { origin: 'http://localhost:5173' },
      body: { ...base, adminPin: 'test-private-pin' } }, accepted);
    assert.equal(accepted.statusCode, 200, JSON.stringify(accepted.body));
    const forwarded = collectorRequests.filter((item) => item.action === 'admin_operation');
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].payload.capabilityHash, DEVICE);
    assert.deepEqual(Array.from(forwarded[0].payload.orderIds), ['order-1700000009001']);
    assert.equal(forwarded[0].payload.reason, '대면 본인확인 완료');
    assert.equal(forwarded[0].payload.adminAssertion, true);
    assert.equal(JSON.stringify(forwarded[0]).includes('test-private-pin'), false,
      '수집기 토큰 경로로 PIN 을 흘리지 않는다');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test('두 화면이 본인 확인 전제를 밝히고 공개 해시만 주고받는다', () => {
  const adminSource = readFileSync(new URL('../src/AdminConsole.jsx', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

  assert.match(adminSource, /대면 또는 유선으로 본인 확인을 마친 뒤에만 사용하세요/);
  assert.match(adminSource, /대면 또는 유선으로 본인 확인을 마쳤습니까\?/);
  assert.match(adminSource, /action: 'recovery_reassign', dealId: selected\.id, reason: reason\.trim\(\), capabilityHash, orderIds/);
  assert.match(adminSource, /if \(!\/\^\[a-f0-9\]\{64\}\$\/\.test\(capabilityHash\)\)/);
  assert.match(adminSource, /if \(!reason\.trim\(\)\) \{ setError\('변경 사유를 입력해 주세요\.'\); return; \}/);

  // 복구 코드는 공개 식별자인 해시다. 원문 토큰은 어떤 화면에도 나오지 않는다.
  assert.match(appSource, /export async function getCustomerRecoveryCode\(\)/);
  assert.match(appSource, /crypto\.subtle\.digest\('SHA-256', input\)/);
  assert.match(appSource, /복구 코드 보기/);
  assert.equal(/getCustomerOrderCapability\(\)\}/.test(appSource), false,
    '권한 토큰 원문을 화면에 그리지 않는다');
});
