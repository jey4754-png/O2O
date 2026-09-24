import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { customerHistoryStore, historyOrder } from './helpers/customer-history-store.js';
import { adminStore } from './helpers/admin-store.js';
import { fakeSheet } from './helpers/product-image-store.js';

// Google Sheets returns an all-digit phone written without text formatting as
// a number, so 01011112222 reads back as 1011112222. The tests used to store
// strings and could not see that every phone-scoped read dropped such rows.
const HASH = createHash('sha256').update('coercion-browser-token-000000000000001').digest('hex');
const asSheetsNumber = (phone) => Number(String(phone).replace(/\D/g, ''));

const ids = (result) => Array.from(result.orders || [], (order) => String(order.id)).sort();

test('숫자로 바뀐 전화번호 칸의 현재 주문과 과거 스냅샷도 내 주문에 나온다', () => {
  const store = customerHistoryStore({
    current: [historyOrder('1234567890901', { _customerCapabilityHash: HASH })],
    historic: [historyOrder('1234567890902', { _customerCapabilityHash: HASH })],
  });
  store.currentRows[1][2] = asSheetsNumber(store.currentRows[1][2]);
  store.eventRows[1][13] = asSheetsNumber(store.eventRows[1][13]);
  assert.equal(typeof store.currentRows[1][2], 'number');

  const result = store.context.getCustomerOrdersResponse_('010-1111-2222', 'customer-history-visitor', HASH);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(ids(result), ['order-1234567890901', 'order-1234567890902']);
});

test('다른 번호는 앞자리 0이 없어져도 섞이지 않는다', () => {
  const store = customerHistoryStore({
    current: [historyOrder('1234567890903', { _customerCapabilityHash: HASH, customerPhone: '01033334444' })],
  });
  store.currentRows[1][2] = asSheetsNumber(store.currentRows[1][2]);
  const result = store.context.getCustomerOrdersResponse_('01011112222', 'customer-history-visitor', HASH);
  assert.deepEqual(ids(result), []);
});

test('되살린 키도 숫자로 바뀐 전화번호 칸의 결박 주문을 읽는다', () => {
  const built = adminStore();
  const recovery = fakeSheet();
  recovery.rows.push(['등록시각', '갱신시각', '식별키', '검증자', '결박해시', '현재해시',
    '결박주문', '결박그룹', '결박상품', '참여자ID', '버전', '마지막변경ID']);
  const ensure = built.context.ensureSheets_;
  built.context.ensureSheets_ = () => ({ ...ensure(), recovery });
  const OLD = 'd'.repeat(64);
  const NEW = 'e'.repeat(64);
  const order = { id: 'order-1700000014001', dealId: built.dealId, customerPhone: '01012345678', type: 'purchase',
    status: 'new', paymentStatus: 'requested', quantity: 1, selectedCount: 1, version: 1, paymentVersion: 1,
    visitorId: 'member-test', _customerCapabilityHash: OLD };
  built.data.customerOrders.rows.push(['', order.id, asSheetsNumber(order.customerPhone), JSON.stringify(order)]);
  recovery.rows.push(['2026-09-23', '2026-09-23', 'admin:x', '', OLD, NEW, JSON.stringify([order.id]),
    '[]', '[]', 'member-test', 1, 'admin-recovery-0001']);

  const result = built.context.getCustomerOrdersResponse_('01012345678', 'fresh-visitor', NEW);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(ids(result), [order.id]);
});

test('새로 쓰는 주문 행과 스냅샷의 전화번호는 텍스트로 저장해 0을 지킨다', () => {
  const built = adminStore();
  const writes = [];
  built.data.customerOrders.getRange = (row, column, height, width) => ({
    setValues: (values) => writes.push(values[0]),
    getValues: () => [], getValue: () => '',
  });
  built.context.updateCustomerOrderRecord_(built.data, { rowNumber: 5, order: { id: 'order-1700000014002', customerPhone: '010-1234-5678' } });
  assert.equal(writes[0][2], "'01012345678");
  assert.equal(built.context.textCell_('UP-ABC'), 'UP-ABC');
  assert.equal(built.context.textCell_(''), '');
  assert.equal(built.context.samePhone_(1012345678, '010-1234-5678'), true);
  assert.equal(built.context.samePhone_('', ''), false);
});

test('실제 값이 든 코드가 한 번 돌면 다음 배포는 자리표시자 그대로 붙여넣어도 동작한다', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const properties = new Map();
  let propertyReads = 0;
  const services = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => { propertyReads += 1; return properties.has(key) ? properties.get(key) : null; },
      setProperty: (key, value) => properties.set(key, value),
    }) },
  };
  const cacheFor = () => { const cache = new Map(); return { getScriptCache: () => ({
    get: (key) => (cache.has(key) ? cache.get(key) : null), put: (key, value) => cache.set(key, value),
  }) }; };
  const real = source
    .replace("const SPREADSHEET_ID = 'REPLACE_WITH_SPREADSHEET_ID';", "const SPREADSHEET_ID = 'sheet-real-id';")
    .replace("const INGEST_TOKEN = 'REPLACE_WITH_RANDOM_TOKEN';", "const INGEST_TOKEN = 'token-real-value';");
  const first = { ...services, CacheService: cacheFor() };
  runInNewContext(real, first);
  assert.equal(first.collectorIngestToken_(), 'token-real-value');
  assert.equal(first.collectorSpreadsheetId_(), 'sheet-real-id');
  assert.equal(properties.get('O2O_INGEST_TOKEN'), 'token-real-value');

  const pastedCache = cacheFor();
  const pasted = { ...services, CacheService: pastedCache };
  runInNewContext(source, pasted);
  assert.equal(pasted.collectorIngestToken_(), 'token-real-value', '자리표시자는 저장된 값으로 대체된다');
  assert.equal(pasted.collectorSpreadsheetId_(), 'sheet-real-id');
  // A later run (fresh globals, same script cache) does not touch Script Properties.
  const readsBefore = propertyReads;
  const nextRun = { ...services, CacheService: pastedCache };
  runInNewContext(source, nextRun);
  assert.equal(nextRun.collectorIngestToken_(), 'token-real-value');
  assert.equal(nextRun.collectorIngestToken_(), 'token-real-value');
  assert.equal(propertyReads, readsBefore, '캐시가 있으면 속성 저장소를 읽지 않는다');

  const noStore = {};
  runInNewContext(source, noStore);
  assert.equal(noStore.collectorIngestToken_(), 'REPLACE_WITH_RANDOM_TOKEN', '저장소가 없으면 파일 값 그대로');
  assert.equal(/^const SPREADSHEET_ID = 'REPLACE_WITH_SPREADSHEET_ID';$/m.test(source), true, '저장소 코드에는 실제 값이 없다');
});
