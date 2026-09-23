import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import handler from '../api/recovery.js';
import { adminStore } from './helpers/admin-store.js';
import { fakeSheet, imageResponse, imageDeal } from './helpers/product-image-store.js';

const PHONE = '01077778888';
const PIN = '482913';
const ORIGIN = 'https://o2o-ten.vercel.app';
const TOKEN = 'live-customer-capability-token-000000000001';
const GROUP_TOKEN = 'live-participant-capability-token-000000001';
const DEAL_TOKEN = 'live-owner-capability-token-00000000000001';
const NEW_TOKEN = 'fresh-customer-capability-token-00000000002';
const GROUP = 'grp-recovery-room';
const DEAL = 'owner-recovery-deal';
const ORDER = 'order-1700000012001';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const RECOVERY_HEADERS = ['등록시각', '갱신시각', '식별키', '검증자', '결박해시', '현재해시',
  '결박주문', '결박그룹', '결박상품', '참여자ID', '버전', '마지막변경ID'];

function fixture(t) {
  const keys = ['GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN', 'O2O_DATA_API_ORIGIN', 'O2O_DATA_API_TOKEN', 'NODE_ENV'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, { GOOGLE_SHEETS_COLLECTOR_URL: 'https://collector.example.test',
    GOOGLE_SHEETS_COLLECTOR_TOKEN: 'REPLACE_WITH_RANDOM_TOKEN', O2O_DATA_API_ORIGIN: '', O2O_DATA_API_TOKEN: '' });
  const built = adminStore();
  const recovery = fakeSheet();
  recovery.rows.push([...RECOVERY_HEADERS]);
  built.data.recovery = recovery;
  const ensure = built.context.ensureSheets_;
  built.context.ensureSheets_ = () => ({ ...ensure(), recovery });
  const properties = new Map();
  built.context.PropertiesService = { getScriptProperties: () => ({
    getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
    setProperty: (key, value) => properties.set(key, value),
  }) };
  // What the live key owns: one order, one group seat, one merchant deal.
  built.data.customerOrders.rows.push(['', ORDER, PHONE, JSON.stringify({
    id: ORDER, dealId: built.dealId, customerPhone: PHONE, type: 'purchase', status: 'new',
    paymentStatus: 'pending', quantity: 1, selectedCount: 1, version: 1, paymentVersion: 1,
    visitorId: 'member-test', _customerCapabilityHash: sha(TOKEN),
  })]);
  built.data.groups.rows.push([GROUP, GROUP, '복구 검증 그룹', 'recruiting', 5, false,
    'host-test', 0, 1, '', '', '', 'host-test', 'recruiting', 10]);
  built.data.groupParticipants.rows.push([GROUP, 'member-test', '검증 사용자', 'member', true,
    'pending', 0, sha(GROUP_TOKEN), 1, '', '', 1]);
  built.context.publishPublicDeal_({ ...imageDeal(''), id: DEAL, publishMutationId: 'publish-recovery-001' }, sha(DEAL_TOKEN));
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const result = built.context.doPost({ postData: { contents: options.body } });
    return { status: 200, ok: true, json: async () => JSON.parse(JSON.stringify(result)) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { ...built, recovery, properties, calls };
}

async function invoke(body, headers = { origin: ORIGIN }, method = 'POST') {
  const response = imageResponse();
  await handler({ body, headers, method }, response);
  return response;
}

const enrollBody = (overrides = {}) => ({
  action: 'enroll', phone: '010-7777-8888', pin: PIN, actorId: 'member-test',
  clientMutationId: 'recovery-enroll-0001', customerCapabilityToken: TOKEN,
  groups: [{ groupId: GROUP, actorId: 'member-test', capabilityToken: GROUP_TOKEN }],
  deals: [{ dealId: DEAL, capabilityToken: DEAL_TOKEN }],
  ...overrides,
});

const redeemBody = (overrides = {}) => ({
  action: 'redeem', phone: PHONE, pin: PIN, actorId: 'visitor-after-wipe',
  clientMutationId: 'recovery-redeem-0001', customerCapabilityToken: NEW_TOKEN, ...overrides,
});

const orderIds = (context, hash) => Array.from(
  context.getCustomerOrdersResponse_(PHONE, 'member-test', hash).orders || [], (o) => String(o.id),
);

test('등록은 살아있는 키가 소유한 주문·그룹·상품만 묶고, 확인번호 원문은 어디에도 남지 않는다', async (t) => {
  const store = fixture(t);
  const response = await invoke(enrollBody());
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, { ok: true, bound: { orders: 1, groups: 1, deals: 1 } });
  assert.equal(response.headers['Cache-Control'], 'no-store');

  assert.equal(store.recovery.rows.length, 2);
  const row = store.recovery.rows[1];
  assert.match(String(row[2]), /^[a-f0-9]{64}$/, '식별키는 64자리 해시다');
  assert.notEqual(String(row[2]), sha(PHONE), '식별키는 전화번호를 그대로 해시한 값이 아니다');
  const verifier = JSON.parse(row[3]);
  assert.equal(verifier.algorithm, 'scrypt-v1');
  assert.equal(String(row[4]), sha(TOKEN));
  assert.deepEqual(JSON.parse(row[6]), [ORDER]);
  assert.equal(JSON.parse(row[7])[0].groupId, GROUP);
  assert.equal(JSON.parse(row[8])[0].dealId, DEAL);

  const everything = JSON.stringify([store.recovery.rows, [...store.properties.values()], store.calls, response.body]);
  assert.equal(everything.includes(PIN), false, '확인번호 원문이 시트·속성·수집기 요청·응답에 없다');
  assert.equal(everything.includes(TOKEN), false, '권한 토큰 원문이 수집기로 가지 않는다');
  assert.equal(everything.includes(PHONE), false, '전화번호가 수집기 요청에 실리지 않는다');
  assert.deepEqual(store.calls.map((call) => call.payload.operation), ['begin', 'enroll']);
  assert.equal(store.calls[0].payload.scope, 'enroll', '등록은 자기 버킷을 쓴다');
});

test('증명되지 않는 주장은 조용히 빠지고, 아무것도 묶이지 않으면 등록하지 않는다', async (t) => {
  const store = fixture(t);
  const stranger = await invoke(enrollBody({
    customerCapabilityToken: 'stranger-capability-token-0000000000000001',
    groups: [{ groupId: GROUP, actorId: 'member-test', capabilityToken: 'stranger-participant-token-0000000001' }],
    deals: [{ dealId: DEAL, capabilityToken: 'stranger-owner-token-00000000000000001' }],
  }));
  assert.equal(stranger.statusCode, 409);
  assert.equal(stranger.body.error, 'recovery_nothing_to_bind');
  assert.equal(store.recovery.rows.length, 1);
});

test('맞는 확인번호는 새 키에 결박 집합 전체를 넘기고, 응답은 되살릴 그룹·상품만 알려준다', async (t) => {
  const store = fixture(t);
  assert.equal((await invoke(enrollBody())).statusCode, 200);
  assert.deepEqual(orderIds(store.context, sha(NEW_TOKEN)), [], '등록만으로는 새 키에 권한이 없다');

  const response = await invoke(redeemBody());
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, {
    ok: true, actorId: 'member-test', bound: { orders: 1, groups: 1, deals: 1 },
    groups: [{ groupId: GROUP, actorId: 'member-test' }], deals: [DEAL],
  });
  assert.equal(JSON.stringify(response.body).includes(sha(GROUP_TOKEN)), false, '옛 해시는 응답에 나오지 않는다');

  assert.deepEqual(orderIds(store.context, sha(NEW_TOKEN)), [ORDER], '새 키가 결박된 주문을 읽는다');
  assert.deepEqual(orderIds(store.context, sha(TOKEN)), [ORDER], '옛 키도 그대로 동작한다');
  const snapshot = store.context.handleGroupOperation_('snapshot', {
    groupId: GROUP, actorId: 'member-test', capabilityHash: sha(NEW_TOKEN),
  });
  assert.equal(snapshot.ok, true, snapshot.error);
  const deals = store.context.getOwnerPublicDealsResponse_([{ dealId: DEAL, ownerCapabilityHash: sha(NEW_TOKEN) }]);
  assert.deepEqual(Array.from(deals.deals || [], (d) => String(d.id)), [DEAL]);
  assert.deepEqual(store.calls.map((call) => call.payload.operation), ['begin', 'enroll', 'begin', 'redeem']);
  assert.equal(store.calls[3].payload.redeemAssertion, true);

  const replay = await invoke(redeemBody());
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.duplicate, true);
  assert.deepEqual(replay.body.groups, [{ groupId: GROUP, actorId: 'member-test' }]);
  assert.deepEqual(replay.body.deals, [DEAL]);
});

test('틀린 확인번호는 실패로 기록되고 승계를 남기지 않는다', async (t) => {
  const store = fixture(t);
  assert.equal((await invoke(enrollBody())).statusCode, 200);
  const before = JSON.stringify(store.recovery.rows);

  const response = await invoke(redeemBody({ pin: '000000' }));
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, 'invalid_recovery_pin');
  assert.equal(JSON.stringify(store.recovery.rows), before);
  assert.deepEqual(store.calls.slice(2).map((call) => call.payload.operation), ['begin', 'finish']);
  assert.deepEqual(orderIds(store.context, sha(NEW_TOKEN)), []);

  const unenrolled = await invoke(redeemBody({ phone: '01000000000', pin: PIN, clientMutationId: 'recovery-redeem-0002' }));
  assert.equal(unenrolled.statusCode, 403, '등록되지 않은 번호도 같은 실패로 보인다');
  assert.equal(unenrolled.body.error, 'invalid_recovery_pin');
});

test('입력 검증에 걸리면 수집기에 아무 요청도 가지 않는다', async (t) => {
  const store = fixture(t);
  for (const [body, expected, headers, method] of [
    [enrollBody({ phone: '0212345678' }), 'invalid_recovery_phone'],
    [enrollBody({ pin: '12345' }), 'invalid_recovery_pin_format'],
    [enrollBody({ pin: 482913 }), 'invalid_recovery_pin_format'],
    [enrollBody({ pin: '01077778888' }), 'recovery_pin_matches_phone'],
    [enrollBody({ pin: '77778888' }), 'recovery_pin_matches_phone'],
    [enrollBody({ pin: '778888' }), 'recovery_pin_matches_phone'],
    [enrollBody({ customerCapabilityToken: 'short' }), 'missing_customer_capability'],
    [enrollBody({ actorId: 'bad actor' }), 'invalid_actor_id'],
    [enrollBody({ clientMutationId: 'short' }), 'invalid_client_mutation_id'],
    [enrollBody({ groups: [{ groupId: GROUP, actorId: 'member-test', capabilityToken: 'x' }] }), 'invalid_group_claims'],
    [enrollBody({ deals: [{ dealId: 'not-owner', capabilityToken: DEAL_TOKEN }] }), 'invalid_deal_claims'],
    [{ ...enrollBody(), action: 'begin' }, 'invalid_action'],
    [enrollBody(), 'forbidden_origin', { origin: 'https://evil.example' }],
    [enrollBody(), 'method_not_allowed', { origin: ORIGIN }, 'GET'],
  ]) {
    const response = await invoke(body, headers, method);
    assert.equal(response.body.error, expected, JSON.stringify(body));
    assert.equal(store.calls.length, 0);
  }
});

test('입력 제한에 걸리면 풀리는 시각을 알 수 있게 대기 시간을 돌려준다', async (t) => {
  const store = fixture(t);
  assert.equal((await invoke(enrollBody())).statusCode, 200);
  let last;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    last = await invoke(redeemBody({ pin: '000000', clientMutationId: `recovery-redeem-10${attempt}0` }));
  }
  assert.equal(last.statusCode, 429);
  assert.equal(last.body.error, 'recovery_rate_limited');
  assert.ok(last.body.retryAfter > 0 && last.body.retryAfter <= 900, String(last.body.retryAfter));
  assert.equal(last.headers['Retry-After'], String(last.body.retryAfter));
  assert.equal(store.recovery.rows.length, 2);
});

test('같은 기기에서 확인번호를 다시 등록하면 새 숫자로만 되살아난다', async (t) => {
  const store = fixture(t);
  assert.equal((await invoke(enrollBody())).statusCode, 200);
  const again = await invoke(enrollBody({ pin: '731946', clientMutationId: 'recovery-enroll-0002' }));
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.equal(store.recovery.rows.length, 2, '같은 키의 재등록은 행을 늘리지 않고 확인번호만 바꾼다');

  const old = await invoke(redeemBody({ pin: PIN }));
  assert.equal(old.statusCode, 403);
  assert.equal(old.body.error, 'invalid_recovery_pin');
  const fresh = await invoke(redeemBody({ pin: '731946', clientMutationId: 'recovery-redeem-0002' }));
  assert.equal(fresh.statusCode, 200, JSON.stringify(fresh.body));
  assert.deepEqual(orderIds(store.context, sha(NEW_TOKEN)), [ORDER]);
});

test('등록한 기기에서 확인번호가 맞는지 복구 없이 확인할 수 있다', async (t) => {
  const store = fixture(t);
  assert.equal((await invoke(enrollBody())).statusCode, 200);
  const rowsBefore = JSON.stringify(store.recovery.rows);
  const ok = await invoke({ ...redeemBody(), action: 'verify', customerCapabilityToken: TOKEN, clientMutationId: 'recovery-verify-0001' });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { ok: true, verified: true, thisDevice: true });
  const other = await invoke({ ...redeemBody(), action: 'verify', clientMutationId: 'recovery-verify-0002' });
  assert.deepEqual(other.body, { ok: true, verified: true, thisDevice: false });
  const wrong = await invoke({ ...redeemBody(), action: 'verify', pin: '000000', clientMutationId: 'recovery-verify-0003' });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.body.error, 'invalid_recovery_pin');
  assert.equal(JSON.stringify(store.recovery.rows), rowsBefore, '확인은 승계를 기록하지 않는다');
  assert.equal(store.calls.some((call) => call.payload.operation === 'redeem'), false);
  assert.deepEqual(orderIds(store.context, sha(NEW_TOKEN)), []);
});

function busyOn(operation, times) {
  const real = globalThis.fetch;
  let left = times;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.payload?.operation === operation && left > 0) {
      left -= 1;
      return { status: 200, ok: true, json: async () => ({ ok: false, error: 'collector_busy' }) };
    }
    return real(url, options);
  };
  return () => { globalThis.fetch = real; };
}

test('수집기가 잠깐 바쁘면 되살리기 기록을 다시 보내 한 번에 끝낸다', async (t) => {
  const store = fixture(t);
  assert.equal((await invoke(enrollBody())).statusCode, 200);
  const restore = busyOn('redeem', 2);
  t.after(restore);
  const response = await invoke(redeemBody());
  restore();
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.deepEqual(orderIds(store.context, sha(NEW_TOKEN)), [ORDER]);
});

test('숫자가 맞았는데 기록이 끝나지 못하면 그렇게 알리고, 다시 눌러도 틀린 횟수로 세지 않는다', async (t) => {
  const store = fixture(t);
  assert.equal((await invoke(enrollBody())).statusCode, 200);
  const restore = busyOn('redeem', 10);
  t.after(restore);
  const failed = await invoke(redeemBody());
  restore();
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.error, 'recovery_redeem_incomplete');
  assert.equal(store.calls.some((call) => call.payload?.operation === 'finish'), false, '실패 횟수를 올리지 않는다');
  const again = await invoke(redeemBody());
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.deepEqual(orderIds(store.context, sha(NEW_TOKEN)), [ORDER]);
});
