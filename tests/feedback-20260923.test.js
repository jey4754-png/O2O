import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { maskedOrderPhone } from '../src/adminRecovery.js';
import { isKakaoInAppBrowser } from '../src/inAppBrowser.js';

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const adminSource = readFileSync(new URL('../src/AdminConsole.jsx', import.meta.url), 'utf8');
const collectorSource = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

test('관리자 화면은 주문 번호 뒤 4자리만 보여 주고 전체 번호는 숨긴다', () => {
  assert.equal(maskedOrderPhone({ customerPhone: '010-3747-4754' }), '010-****-4754');
  assert.equal(maskedOrderPhone({ customerPhone: '01012345678' }), '010-****-5678');
  assert.equal(maskedOrderPhone({ customerPhone: '' }), '');
  assert.equal(maskedOrderPhone({}), '');
});

test('재연결은 서로 다른 번호의 주문을 함께 묶지 않고, 성공 문구가 로그인 번호 조건을 밝힌다', () => {
  assert.match(adminSource, /if \(phones\.length > 1\) \{/);
  assert.match(adminSource, /로그인한 상태에서 내 주문 → “주문 이력 다시 불러오기”를 눌러야 보입니다/);
  // A pre-recovery collector rejects the action as unknown; that is a missing
  // deployment, and the operator must not be told to check the network.
  assert.match(adminSource, /invalid_action: '서버\(Apps Script\)가 이 기능을 모르는 이전 버전입니다/);
  assert.match(adminSource, /customer-… 값은 상품 ID라 복구 코드가 아닙니다/);
});

test('내 주문은 목록이 어느 로그인 번호의 것인지 표시한다', () => {
  assert.match(appSource, /const loginPhone = formatKoreanMobilePhoneInput\(getProfile\(\)\?\.phone\);/);
  assert.match(appSource, /로그인 번호 <strong>\{loginPhone\}<\/strong>로 넣은 주문만 표시합니다/);
});

test('서버가 없는 상품으로 거절한 예시 상품 주문만 체험용으로 안내한다', () => {
  assert.match(appSource, /const SAMPLE_DEAL_IDS = new Set\(\[\.\.\.sampleDeals, \.\.\.sampleCommunityGroups\]\.map\(\(deal\) => deal\.id\)\);/);
  assert.match(appSource, /&& rawSyncIssue\?\.state === 'failed' && rawSyncIssue\?\.code === 'deal_not_found';/);
  assert.match(appSource, /const syncIssue = sampleOrder \? null : rawSyncIssue;/);
  assert.match(appSource, /체험용 예시 상품/);
});

test('배포 직후 시트 생성 경쟁에서 진 요청도 이미 만들어진 시트를 쓴다', () => {
  const context = {};
  runInNewContext(collectorSource, context);
  const sheets = new Map();
  let inserts = 0;
  const spreadsheet = {
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet(name) {
      inserts += 1;
      // Another execution created it between our lookup and our insert.
      sheets.set(name, { name });
      throw new Error(`이름이 ‘${name}’인 시트가 이미 있습니다.`);
    },
  };
  const sheet = context.sheetByNameOrInsert_(spreadsheet, '복구 등록');
  assert.equal(sheet.name, '복구 등록');
  assert.equal(inserts, 1);
  const broken = { getSheetByName: () => null, insertSheet() { throw new Error('quota'); } };
  assert.throws(() => context.sheetByNameOrInsert_(broken, '복구 등록'), /quota/);
});

test('카카오톡 인앱 브라우저를 알아보고 기본 브라우저로 여는 안내를 둔다', () => {
  assert.equal(isKakaoInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 11.4.0'), true);
  assert.equal(isKakaoInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'), false);
  assert.match(appSource, /kakaotalk:\/\/web\/openExternal\?url=\$\{encodeURIComponent\(window\.location\.href\)\}/);
});

test('확인번호는 자리 수만 남기고 숫자 보기로 오타를 가려낼 수 있다', () => {
  assert.match(appSource, /pinLength: pin\.length,/);
  assert.equal(/saveJson\(RECOVERY_ENROLLMENT_KEY, \{[^}]*\bpin\b:/.test(appSource), false, '확인번호 원문을 저장하지 않는다');
  assert.match(appSource, /방금 넣은 숫자는 \$\{pin\.length\}자리입니다/);
  assert.match(appSource, /function RecoveryPinVisibility/);
});

test('확인번호 칸은 비밀번호 칸이 아니어서 브라우저가 저장된 관리자 PIN을 채우지 못한다', () => {
  const helper = appSource.slice(appSource.indexOf('function recoveryPinInput'), appSource.indexOf('function RecoveryPinVisibility'));
  assert.match(helper, /type: 'text'/);
  assert.equal(/'password'/.test(helper), false);
});

test('관리자 복구 상태 점검은 PIN 뒤에서 읽기만 하고 주문 요약만 돌려준다', async () => {
  const { default: handler } = await import('../api/admin-ops.js');
  const { imageResponse } = await import('./helpers/product-image-store.js');
  const keys = ['O2O_ADMIN_PIN', 'O2O_DATA_API_ORIGIN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { O2O_ADMIN_PIN: 'check-test-pin', O2O_DATA_API_ORIGIN: '',
    GOOGLE_SHEETS_COLLECTOR_URL: 'https://collector.invalid/check', GOOGLE_SHEETS_COLLECTOR_TOKEN: 'check-token' });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.action === 'admin_credentials') {
      if (body.payload.operation === 'read') return { status: 200, ok: true, json: async () => ({ ok: true, credential: null }) };
      return { status: 200, ok: true, json: async () => ({ ok: true, allowed: true, ...(body.payload.operation === 'rate_begin' ? { reserved: true } : {}) }) };
    }
    return { status: 200, ok: true, json: async () => ({ ok: true, orders: [
      { id: 'order-1700000013001', title: '경기미', paymentStatus: 'requested', status: 'new', customerPhone: '01011112222', _customerCapabilityHash: 'a'.repeat(64) },
    ] }) };
  };
  const invoke = async (body) => {
    const response = imageResponse();
    await handler({ method: 'POST', headers: { origin: 'http://localhost:5173' }, body: { actorId: 'operator_admin', ...body } }, response);
    return response;
  };
  try {
    assert.equal((await invoke({ action: 'recovery_check', phone: '01011112222', capabilityHash: 'b'.repeat(64) })).body.error, 'invalid_admin_pin');
    assert.equal(calls.some((call) => call.action === 'customer_orders'), false, 'PIN 없이는 조회하지 않는다');
    assert.equal((await invoke({ action: 'recovery_check', adminPin: 'check-test-pin', phone: '0212345678', capabilityHash: 'b'.repeat(64) })).body.error, 'invalid_recovery_phone');
    assert.equal((await invoke({ action: 'recovery_check', adminPin: 'check-test-pin', phone: '01011112222', capabilityHash: 'raw-token' })).body.error, 'invalid_recovery_capability');
    const ok = await invoke({ action: 'recovery_check', adminPin: 'check-test-pin', phone: '010-1111-2222', capabilityHash: 'B'.repeat(64) });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { ok: true, count: 1, orders: [{ id: 'order-1700000013001', title: '경기미', paymentStatus: 'requested', status: 'new' }] });
    const read = calls.filter((call) => call.action === 'customer_orders');
    assert.equal(read.length, 1);
    assert.equal(read[0].phone, '01011112222');
    assert.equal(read[0].customerCapabilityHash, 'b'.repeat(64));
    assert.equal(calls.some((call) => call.action === 'admin_operation'), false, '쓰기 경로를 타지 않는다');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
