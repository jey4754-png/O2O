import test from 'node:test';
import assert from 'node:assert/strict';
import { adminStore } from './helpers/admin-store.js';
import { fakeSheet } from './helpers/product-image-store.js';
import { readFileSync } from 'node:fs';

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

const enroll = (
  recovery,
  { bound = [], groups = [], deals = [], boundHash = OLD, currentHash = NEW } = {},
) => {
  recovery.rows.push(['2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z', 'identity-key',
    JSON.stringify({ algorithm: 'scrypt-v1' }), boundHash, currentHash,
    JSON.stringify(bound), JSON.stringify(groups), JSON.stringify(deals),
    'member-test', 1, 'mutation-0000001']);
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

test('복구 레이트리밋은 관리자 자격증명을 절대 돌려주지 않는다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  // rate_begin 은 관리자 버킷일 때만 verifier 를 싣는다. 복구가 같은 리미터를
  // 재사용하므로 이 게이트가 없으면 관리자 PIN 검증자가 복구 응답으로 샌다.
  assert.match(source, /if \(operation === 'rate_begin'\s*\n\s*&& \(propertyKey \|\| ADMIN_AUTH_RATE_LIMIT_PROPERTY_KEY\) === ADMIN_AUTH_RATE_LIMIT_PROPERTY_KEY\) \{\s*\n\s*result\.credential = readAdminCredential_\(properties\);/);
  assert.match(source, /const RECOVERY_RATE_LIMIT_PROPERTY_KEY = 'O2O_RECOVERY_AUTH_RATE_LIMIT_V1';/);
  assert.equal(/RECOVERY_RATE_LIMIT_PROPERTY_KEY === ADMIN_AUTH_RATE_LIMIT_PROPERTY_KEY/.test(source), false);
});

test('등록은 소유를 증명하지 못하면 거부한다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(source, /if \(!bound\.orderIds\.length && !bound\.groups\.length && !bound\.deals\.length\) \{\s*\n\s*throw recoveryError_\('recovery_nothing_to_bind'\);/);
  // 결박 집합은 전화번호가 아니라 제시된 해시의 실제 소유로만 만든다.
  assert.match(source, /if \(String\(order\._customerCapabilityHash \|\| ''\)\.toLowerCase\(\) !== capabilityHash\) return;/);
  assert.equal(/recoveryBoundSet_\(sheets, phone/.test(source), false, '전화번호로 결박 집합을 만들지 않는다');
});

// ── 그룹·상품 축 승계 ──────────────────────────────────────────────────────
// adminStore 가 미리 넣어 두는 값들. 참여자 행의 권한 해시와 상품 행의 사장님
// 해시는 고객 주문 해시와 서로 다른 토큰이므로 축마다 따로 결박된다.
const PARTICIPANT = 'c'.repeat(64);
const DEAL_OWNER = 'a'.repeat(64);
// 등록 시점의 고객 키(결박해시)와 복구로 받은 새 키(현재해시).
const BOUND = 'd'.repeat(64);
const RECOVERED = 'e'.repeat(64);
const STRANGER = 'f'.repeat(64);
// 정상 경로로 권한 토큰이 교체된 뒤의 값.
const ROTATED = '9'.repeat(64);
const SECOND_GROUP = 'owner-second-group';

const addGroup = (data, groupId, participantHash) => {
  data.groups.rows.push([groupId, groupId, '다른 그룹', 'recruiting', 5, false,
    'host-test', 0, 1, '', '', '', 'host-test', 'recruiting', 10]);
  data.groupParticipants.rows.push([groupId, 'member-test', '검증 사용자', 'member', true,
    'pending', 0, participantHash, 1, '', '', 1]);
};

const snapshot = (context, groupId, hash) => {
  const result = context.handleGroupOperation_('snapshot', {
    groupId, actorId: 'member-test', capabilityHash: hash,
  });
  return { ok: result.ok === true, error: result.error };
};

const ownerDeals = (context, claims) => {
  const result = context.getOwnerPublicDealsResponse_(claims);
  return { ok: result.ok, error: result.error, ids: Array.from(result.deals || [], (d) => String(d.id)) };
};

const dealRow = (data) => data.publicDeals.rows.find((row) => row[1] === 'owner-image-quality-regression');

test('승계한 키는 결박된 그룹의 참여자로 인정된다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    groups: [{ groupId: dealId, actorId: 'member-test', hash: PARTICIPANT }],
    boundHash: BOUND, currentHash: RECOVERED,
  });

  const result = snapshot(context, dealId, RECOVERED);
  assert.equal(result.ok, true, result.error);
  assert.equal(snapshot(context, dealId, PARTICIPANT).ok, true, '원래 키도 그대로 동작한다');
});

test('결박되지 않은 그룹은 같은 참여자라도 승계되지 않는다', () => {
  const { context, data, dealId } = storeWithRecovery();
  addGroup(data, SECOND_GROUP, ROTATED);
  enroll(data.recovery, {
    groups: [{ groupId: dealId, actorId: 'member-test', hash: PARTICIPANT }],
    boundHash: BOUND, currentHash: RECOVERED,
  });

  assert.equal(snapshot(context, dealId, RECOVERED).ok, true);
  assert.equal(snapshot(context, SECOND_GROUP, RECOVERED).error, 'invalid_capability',
    '등록 시점에 증명되지 않은 그룹은 승계 대상이 아니다');
});

test('결박 당시 해시가 바뀐 그룹은 승계가 무효다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    groups: [{ groupId: dealId, actorId: 'member-test', hash: PARTICIPANT }],
    boundHash: BOUND, currentHash: RECOVERED,
  });
  // 등록 이후 정상 경로로 참여자 권한 토큰이 교체된 상황.
  data.groupParticipants.rows.at(-1)[7] = ROTATED;

  assert.equal(snapshot(context, dealId, RECOVERED).error, 'invalid_capability',
    '옛 등록이 이후의 정상 교체를 되돌리면 안 된다');
  assert.equal(snapshot(context, dealId, ROTATED).ok, true, '교체된 현재 키는 동작한다');
});

test('제3자 키는 그룹에서 아무것도 얻지 못한다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    groups: [{ groupId: dealId, actorId: 'member-test', hash: PARTICIPANT }],
    boundHash: BOUND, currentHash: RECOVERED,
  });

  assert.equal(snapshot(context, dealId, STRANGER).error, 'invalid_capability',
    '승계표에 없는 키는 actorId 가 맞아도 권한이 없다');
});

test('그룹 승계는 참여자 행을 다시 쓰지 않는다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    groups: [{ groupId: dealId, actorId: 'member-test', hash: PARTICIPANT }],
    boundHash: BOUND, currentHash: RECOVERED,
  });
  const before = JSON.stringify(data.groupParticipants.rows);

  assert.equal(snapshot(context, dealId, RECOVERED).ok, true);
  assert.equal(JSON.stringify(data.groupParticipants.rows), before,
    '승계는 읽기 시점 해석이므로 참여자 행의 권한 해시가 남아 있어야 한다');
});

test('승계한 키는 결박된 상품만 사장님 권한으로 인정된다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    deals: [{ dealId, hash: DEAL_OWNER }],
    boundHash: BOUND, currentHash: RECOVERED,
  });

  const result = ownerDeals(context, [{ dealId, ownerCapabilityHash: RECOVERED }]);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.ids, [dealId]);
});

test('결박되지 않은 상품은 승계되지 않는다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    deals: [{ dealId: 'owner-some-other-product', hash: DEAL_OWNER }],
    boundHash: BOUND, currentHash: RECOVERED,
  });

  assert.deepEqual(ownerDeals(context, [{ dealId, ownerCapabilityHash: RECOVERED }]).ids, [],
    '같은 사장님 해시를 쓰는 상품이라도 결박 목록에 없으면 승계되지 않는다');
});

test('결박 당시 해시가 바뀐 상품은 승계가 무효다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    deals: [{ dealId, hash: DEAL_OWNER }],
    boundHash: BOUND, currentHash: RECOVERED,
  });
  const row = dealRow(data);
  const deal = JSON.parse(row[6]);
  deal._ownerCapabilityHash = ROTATED;
  row[6] = JSON.stringify(deal);

  assert.deepEqual(ownerDeals(context, [{ dealId, ownerCapabilityHash: RECOVERED }]).ids, [],
    '상품 행이 그 사이 바뀌었으면 결박 당시 해시는 더 이상 권한이 아니다');
  assert.deepEqual(ownerDeals(context, [{ dealId, ownerCapabilityHash: ROTATED }]).ids, [dealId]);
});

test('제3자 키는 상품에서 아무것도 얻지 못한다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    deals: [{ dealId, hash: DEAL_OWNER }],
    boundHash: BOUND, currentHash: RECOVERED,
  });

  assert.deepEqual(ownerDeals(context, [{ dealId, ownerCapabilityHash: STRANGER }]).ids, [],
    '승계표에 없는 키는 상품ID 를 알아도 권한이 없다');
});

test('상품 승계는 상품 행을 다시 쓰지 않는다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    deals: [{ dealId, hash: DEAL_OWNER }],
    boundHash: BOUND, currentHash: RECOVERED,
  });
  const before = JSON.stringify(data.publicDeals.rows);

  assert.deepEqual(ownerDeals(context, [{ dealId, ownerCapabilityHash: RECOVERED }]).ids, [dealId]);
  assert.equal(JSON.stringify(data.publicDeals.rows), before);
});

test('승계 조회는 소유 주장이 많아도 복구 등록 시트를 한 번만 읽는다', () => {
  const { context, data, dealId } = storeWithRecovery();
  enroll(data.recovery, {
    deals: [{ dealId, hash: DEAL_OWNER }],
    boundHash: BOUND, currentHash: RECOVERED,
  });
  let reads = 0;
  const getRange = data.recovery.getRange.bind(data.recovery);
  data.recovery.getRange = (...args) => {
    const range = getRange(...args);
    const getValues = range.getValues.bind(range);
    range.getValues = () => { reads += 1; return getValues(); };
    return range;
  };

  // 사장님은 한 요청에 OWNER_CLAIM_LIMIT 개까지 주장을 실을 수 있다. 주장마다
  // 승계표를 다시 읽으면 읽기 비용이 주장 수에 비례한다.
  const claims = [{ dealId, ownerCapabilityHash: RECOVERED }];
  for (let index = 1; index < 50; index += 1) {
    claims.push({ dealId: `owner-filler-${index}`, ownerCapabilityHash: RECOVERED });
  }
  assert.deepEqual(ownerDeals(context, claims).ids, [dealId]);
  assert.equal(reads, 1, `복구 등록 시트를 ${reads}번 읽었다`);
});

test('등록 행의 주인은 전화번호가 아니라 그 행을 만든 권한 키다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  // identityKey 만으로 행을 특정하면 번호만 아는 제3자가 남의 등록을 덮어써
  // 이미 복구해 둔 접근까지 되돌릴 수 있다. 행은 (identityKey, boundHash) 로 잡는다.
  assert.match(source, /function recoveryOwnRow_\(sheets, identityKey, boundHash\) \{/);
  assert.match(source, /if \(rows\[index\]\.boundHash === boundHash\) return rows\[index\];/);
  assert.equal(/function recoveryIdentityRow_\(/.test(source), false,
    '전화번호 단독으로 등록 행을 특정하는 경로는 남아 있으면 안 된다');
  assert.match(source, /const own = recoveryOwnRow_\(sheets, identityKey, capabilityHash\);/);
  assert.match(source, /if \(own\) \{\s*\n\s*sheets\.recovery\.getRange\(own\.rowNumber/);
  assert.match(source, /const RECOVERY_ROWS_PER_IDENTITY = 8;/);
  assert.match(source, /throw recoveryError_\('recovery_enrollment_limit'\);/);
});

test('등록·복구 응답이 등록 여부나 횟수를 알려주지 않는다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function handleRecoveryCredentials_'));
  const body = handler.slice(0, handler.indexOf('\n}\n'));
  assert.equal(/version: \(own \? own\.version : 0\) \+ 1/.test(body), false,
    'enroll 응답의 version 은 그 번호의 등록 여부를 알려주는 열거 수단이다');
  assert.equal(/duplicate: true, version:/.test(body), false);
  // begin 은 검증자 개수를 고정 길이로 패딩한다.
  assert.match(body, /while \(candidates\.length < RECOVERY_ROWS_PER_IDENTITY\) \{/);
  assert.match(body, /recovery-decoy:/);
  assert.match(body, /return json_\(Object\.assign\(\{\}, limited, \{ verifiers: candidates \}\)\);/);
});

test('복구는 Vercel 이 맞춘 검증자의 행에만 적용된다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(source, /const existing = recoveryOwnRow_\(sheets, identityKey, String\(payload\.ref \|\| ''\)\.toLowerCase\(\)\);/);
  assert.match(source, /if \(!existing\) throw recoveryError_\('recovery_not_enrolled'\);/);
  // 승계 기록 뒤에는 캐시를 반드시 비운다. 안 그러면 복구가 한동안 반영되지 않는다.
  assert.match(source, /existing\.actorId, existing\.version \+ 1, clientMutationId\s*\n\s*\]\]\);\s*\n\s*invalidateRecoveryRows_\(\);/);
});

test('등록은 별도 버킷에서 결과와 무관하게 슬롯을 소모한다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  // 실패 리미터는 성공하는 오퍼레이션에 상한을 주지 못한다. rate_success 가
  // 실패 카운터를 0 으로 되돌려, 성공하는 등록을 끼워 넣으면 확인번호 대입
  // 횟수까지 초기화된다.
  assert.match(source, /const RECOVERY_ENROLL_RATE_LIMIT_PROPERTY_KEY = 'O2O_RECOVERY_ENROLL_RATE_LIMIT_V1';/);
  assert.match(source, /const enrolling = payload\.scope === 'enroll';/);
  assert.match(source, /\? RECOVERY_ENROLL_RATE_LIMIT_PROPERTY_KEY\s*\n\s*: RECOVERY_RATE_LIMIT_PROPERTY_KEY;/);
  assert.match(source, /if \(enrolling\) return json_\(limited\);/);
  // 어떤 결과로도 리셋되지 않는다. 이 리미터는 성공을 기록하면 실패 카운터를
  // 0 으로 되돌리고 버킷은 호출자 기준이라, 자기 확인번호를 아는 등록 하나를
  // 성공시킬 때마다 남의 번호에 쌓인 실패가 통째로 지워진다.
  assert.match(source, /const limitOperation = payload\.operation === 'begin' \? 'rate_begin' : 'rate_failure';/);
  assert.equal(/rate_success/.test(source.slice(source.indexOf('function handleRecoveryCredentials_'))), false,
    '복구 흐름은 rate_success 를 쓰지 않는다');
});

test('사장님 상품 결박이 실제로 성립한다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  // publicDealRecord_ 는 거래 객체를 그대로 돌려준다. .deal 래퍼를 기대하면
  // 조건이 늘 거짓이 되어 bound.deals 가 영원히 0 이 된다.
  assert.match(source, /const deal = publicDealRecord_\(sheets\.publicDeals, dealId\);/);
  assert.equal(/record && record\.deal \? record\.deal : null/.test(source), false);
});

test('복구한 기기는 자기 식별자를 바꾸지 않고도 쓰기가 된다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  // 식별자를 교체하게 하면 이 브라우저가 아직 들고 있는 그룹 자격이 전부
  // (그룹, 참여자) 키에서 어긋나 조회 불능이 된다.
  assert.match(source, /function recoveryBoundActorId_\(sheets, presentedHash, storedHash, orderId\) \{/);
  assert.match(source, /if \(recoveryBoundActorId_\(ensureSheets_\(\), incomingHash, storedForOwner, order\.id\)\s*\n\s*!== String\(order\.visitorId \|\| ''\)\) \{/);
  assert.match(source, /&& recoveryBoundActorId_\(sheets, suppliedHash, storedHash, order\.id\) !== String\(order\.visitorId \|\| ''\)\) \{/);
});

test('승계는 쓰기 경로에서도 인정되어 조회 전용 복구로 끝나지 않는다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(source, /function recoveryActsAsHash_\(sheets, presentedHash, storedHash, orderId\) \{/);
  // 게시와 취소 양쪽이 같은 근거를 쓴다.
  assert.match(source, /if \(!recoveryActsAsHash_\(sheets, incomingHash, existingHash, existingOrder\.id\)\) \{\s*\n\s*return json_\(\{ ok: false, error: 'forbidden' \}\);/);
  assert.match(source, /if \(storedHash !== suppliedHash\s*\n\s*&& !recoveryActsAsHash_\(sheets, suppliedHash, storedHash, order\.id\)\) \{/);
  // 결박된 주문에만 적용된다.
  assert.match(source, /return \(succession\.boundOrderIds \|\| \[\]\)\.some\(function\(id\) \{/);
});

test('한 키가 두 등록을 승계하는 상태를 만들지 않는다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  // recoverySuccession_ 은 모호하면 null 을 돌려주므로, 두 번째 승계가 기록되면
  // 그 키가 이미 되살린 접근까지 한꺼번에 사라진다.
  assert.match(source, /const ambiguous = recoveryRowsRaw_\(sheets\)\.some\(function\(row\) \{/);
  assert.match(source, /if \(ambiguous\) throw recoveryError_\('recovery_succession_exists'\);/);
});

test('승계로 인가된 쓰기는 저장된 소유 표시를 바꾸지 않는다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  // 주문 행만 새 해시로 바뀌고 이벤트 로그 스냅샷은 옛 해시로 남으면, 같은
  // 주문에 해시가 둘이 되어 filterCustomerOrdersForProof_ 가 충돌로 판정하고
  // 그 주문이 새 키와 옛 키 양쪽에서 영구히 사라진다. 이벤트 로그는 추가
  // 전용이라 되돌릴 수 없고 관리자 재연결로도 복구되지 않는다.
  assert.match(source, /let writesUnderSuccession = false;/);
  assert.match(source, /writesUnderSuccession = true;/);
  assert.match(
    source,
    /storedOrder = Object\.assign\(\{\}, storedOrder, writesUnderSuccession\s*\n\s*\? \{\s*\n\s*customerPhone: phone,\s*\n\s*visitorId: String\(existingOrder\.visitorId \|\| ''\),\s*\n\s*_customerCapabilityHash: String\(existingOrder\._customerCapabilityHash \|\| ''\)\.toLowerCase\(\)/,
  );
  // 이것이 설계의 제1원칙이다: 시트 행의 소유 표시를 다시 쓰지 않는다.
  assert.match(source, /시트 행을 절대 다시 쓰지 않는다|주문 행은 절대 다시 쓰지 않는다|다시 쓰지 않는다/);
});

test('미끼 검증자가 실제 등록과 구분되지 않는다', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  // 같은 씨앗을 재사용하면 salt 가 ref 의 앞부분과 같고 hash 가 같은 값의
  // 반복이 되어, 호출자가 미끼를 알아보고 등록 수를 그대로 읽어낸다.
  assert.match(source, /ref: sha256Hex_\(base \+ ':ref'\),/);
  assert.match(source, /salt: sha256Hex_\(base \+ ':salt'\)\.slice\(0, 32\),/);
  assert.match(source, /hash: sha256Hex_\(base \+ ':hash-a'\) \+ sha256Hex_\(base \+ ':hash-b'\)/);
  assert.equal(/salt: seed\.slice\(0, 32\), hash: seed \+ seed/.test(source), false);
  // 순서도 정보가 되지 않아야 한다.
  assert.match(source, /candidates\.sort\(function\(left, right\) \{ return left\.ref < right\.ref \? -1 : 1; \}\);/);
});
