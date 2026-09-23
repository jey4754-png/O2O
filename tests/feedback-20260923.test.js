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
