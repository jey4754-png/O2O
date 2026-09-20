import test from 'node:test';
import assert from 'node:assert/strict';
import { adminStore } from './helpers/admin-store.js';
import { fakeSheet } from './helpers/product-image-store.js';

const PHONE = '01011112222';
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

function storeWithRecovery() {
  const built = adminStore();
  const recovery = fakeSheet();
  recovery.rows.push(['등록시각', '갱신시각', '식별키', '검증자', '결박해시', '현재해시',
    '결박주문', '결박그룹', '결박상품', '참여자ID', '버전', '마지막변경ID']);
  built.data.recovery = recovery;
  const ensure = built.context.ensureSheets_;
  built.context.ensureSheets_ = () => ({ ...ensure(), recovery });
  return built;
}

const order = (id, hash, overrides = {}) => ({
  id, dealId: 'deal-x', customerPhone: PHONE, type: 'purchase', status: 'new',
  paymentStatus: 'pending', quantity: 1, selectedCount: 1, version: 1, paymentVersion: 1,
  visitorId: 'member-test', _customerCapabilityHash: hash, ...overrides,
});

const enroll = (recovery, { bound = [], boundHash = OLD, currentHash = NEW } = {}) => {
  recovery.rows.push(['2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z', 'identity-key',
    JSON.stringify({ algorithm: 'scrypt-v1' }), boundHash, currentHash,
    JSON.stringify(bound), '[]', '[]', 'member-test', 1, 'mutation-0000001']);
};

const read = (context, hash) => {
  const result = context.getCustomerOrdersResponse_(PHONE, 'member-test', hash);
  // The collector runs in a separate VM realm, so its arrays fail strict deep
  // comparison on prototype identity alone. Copy into this realm first.
  return { ok: result.ok, error: result.error, ids: Array.from(result.orders || [], (o) => String(o.id)) };
};

test('승계된 새 키는 등록 시점에 결박된 주문만 조회한다', () => {
  const { context, data } = storeWithRecovery();
  const mine = order('order-1700000000501', OLD);
  const unbound = order('order-1700000000502', OLD);
  data.customerOrders.rows.push(['', mine.id, PHONE, JSON.stringify(mine)]);
  data.customerOrders.rows.push(['', unbound.id, PHONE, JSON.stringify(unbound)]);
  enroll(data.recovery, { bound: [mine.id] });

  const result = read(context, NEW);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.ids, [mine.id],
    '결박되지 않은 주문은 같은 전화번호·같은 옛 해시라도 승계되지 않는다');
});

test('승계 기록이 없는 키는 아무것도 조회하지 못한다', () => {
  const { context, data } = storeWithRecovery();
  const mine = order('order-1700000000503', OLD);
  data.customerOrders.rows.push(['', mine.id, PHONE, JSON.stringify(mine)]);

  assert.deepEqual(read(context, NEW).ids, [], '등록 없이 새 키를 제시하면 권한이 없다');
  assert.deepEqual(read(context, OLD).ids, [mine.id],
    '원래 키는 그대로 동작한다');
});

test('다른 사람의 키는 승계 대상 주문을 가져가지 못한다', () => {
  const { context, data } = storeWithRecovery();
  const mine = order('order-1700000000504', OLD);
  data.customerOrders.rows.push(['', mine.id, PHONE, JSON.stringify(mine)]);
  enroll(data.recovery, { bound: [mine.id] });

  assert.deepEqual(read(context, OTHER).ids, [],
    '승계표에 등록되지 않은 제3자의 키로는 조회되지 않는다');
});

test('같은 키가 여러 등록을 승계하면 모호하므로 승계하지 않는다', () => {
  const { context, data } = storeWithRecovery();
  const mine = order('order-1700000000505', OLD);
  data.customerOrders.rows.push(['', mine.id, PHONE, JSON.stringify(mine)]);
  enroll(data.recovery, { bound: [mine.id], boundHash: OLD, currentHash: NEW });
  enroll(data.recovery, { bound: [mine.id], boundHash: OTHER, currentHash: NEW });

  assert.deepEqual(read(context, NEW).ids, [],
    '승계가 하나로 확정되지 않으면 권한을 주지 않는다');
});

test('승계는 시트 행을 다시 쓰지 않는다', () => {
  const { context, data } = storeWithRecovery();
  const mine = order('order-1700000000506', OLD);
  data.customerOrders.rows.push(['', mine.id, PHONE, JSON.stringify(mine)]);
  enroll(data.recovery, { bound: [mine.id] });
  const before = JSON.stringify(data.customerOrders.rows);

  read(context, NEW);
  assert.equal(JSON.stringify(data.customerOrders.rows), before,
    '주문 내역은 읽기 전용이어야 부분 실패로 소유 해시가 충돌하지 않는다');
  const stored = JSON.parse(data.customerOrders.rows.at(-1)[3]);
  assert.equal(stored._customerCapabilityHash, OLD, '원래 소유 해시가 보존된다');
});

test('승계 기록이 없으면 기존 동작이 그대로 유지된다', () => {
  const { context, data } = storeWithRecovery();
  const mine = order('order-1700000000507', OLD);
  data.customerOrders.rows.push(['', mine.id, PHONE, JSON.stringify(mine)]);
  assert.deepEqual(read(context, OLD).ids, [mine.id]);
});
