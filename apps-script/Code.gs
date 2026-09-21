// Production values are configured in the deployed Apps Script project.
const SPREADSHEET_ID = 'REPLACE_WITH_SPREADSHEET_ID';
const INGEST_TOKEN = 'REPLACE_WITH_RANDOM_TOKEN';
const EVENT_HEADERS = [
  '수집시각', '발생시각', '사용자명', '사용자유형', '익명ID', '세션ID',
  '이벤트', '시도', '시군구', '읍면동', '화면', '상세데이터', '고객번호', '연락처', '이벤트ID'
];
const SURVEY_HEADERS = [
  '수집시각', '제출시각', '고객번호', '이름', '연락처', '사용자유형',
  '시도', '시군구', '읍면동', '참여 이유', '희망 할인', '호스트 의향',
  '희망 카테고리', '재이용 의향', '피드백', '익명ID', '이벤트ID'
];
const PUBLIC_DEAL_HEADERS = [
  '업데이트시각', '상품ID', '등록유형', '시도', '시군구', '읍면동', '상품데이터'
];
const CUSTOMER_ORDER_HEADERS = [
  '업데이트시각', '주문ID', '연락처', '주문데이터'
];
const GROUP_HEADERS = [
  '그룹ID', '상품ID', '제목', '그룹상태', '목표인원', '채팅잠금',
  '호스트ID', '마지막메시지SEQ', '버전', '생성시각', '수정시각', '수정자',
  '생성자ID', '호스트모드', '총상품수'
];
const GROUP_PARTICIPANT_HEADERS = [
  '그룹ID', '참여자ID', '닉네임', '역할', '인원포함', '입금상태',
  '마지막읽음SEQ', '권한토큰해시', '버전', '참여시각', '수정시각', '선택수량'
];
const GROUP_CHAT_HEADERS = [
  '그룹ID', 'SEQ', '메시지ID', '참여자ID', '닉네임', '역할',
  '메시지', '생성시각', '요청ID'
];
// 복구 등록: 기기의 권한 키가 사라졌을 때 본인 확인 후 접근을 되살리기 위한 표.
// 시트 행을 다시 쓰지 않고 '승계'만 기록한다. 기존 행을 덮어쓰면 부분 실패가
// 그대로 소유 해시 충돌이 되어 filterCustomerOrdersForProof_ 가 그 주문을
// 원래 주인에게까지 영구히 숨기기 때문이다.
const RECOVERY_HEADERS = [
  '등록시각', '갱신시각', '식별키', '검증자', '결박해시', '현재해시',
  '결박주문', '결박그룹', '결박상품', '참여자ID', '버전', '마지막변경ID'
];
const GROUP_HISTORY_HEADERS = [
  '이력ID', '그룹ID', '대상유형', '대상ID', '이전상태', '변경상태',
  '행동', '수행자ID', '수행자역할', '사유', '요청ID', '버전', '변경시각', '결과데이터'
];
const GROUP_STATUSES = ['recruiting', 'recruited', 'purchased', 'delivered'];
const PAYMENT_STATUSES = ['pending', 'requested', 'confirmed'];
const GROUP_MAX_PARTICIPANTS = 20;
const GROUP_MESSAGE_LIMIT = 100;
const OWNER_CLAIM_LIMIT = 50;
const SCRIPT_LOCK_TIMEOUT_MS = 3000;
const CENTRAL_ANALYTICS_LOCK_TIMEOUT_MS = 0;
const CENTRAL_ANALYTICS_EVENT_CACHE_SECONDS = 21600;
const CENTRAL_DASHBOARD_EVENT_NAMES = {
  open_listing: true,
  screen_view: true,
  share_clicked: true
};
const ADMIN_CREDENTIAL_PROPERTY_KEY = 'O2O_ADMIN_CREDENTIAL_V1';
const ADMIN_AUTH_RATE_LIMIT_PROPERTY_KEY = 'O2O_ADMIN_AUTH_RATE_LIMIT_V1';
const ADMIN_AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_AUTH_RATE_BLOCK_MS = 15 * 60 * 1000;
const ADMIN_AUTH_RATE_CLIENT_FAILURE_LIMIT = 5;
const ADMIN_AUTH_RATE_GLOBAL_FAILURE_LIMIT = 40;
const ADMIN_AUTH_RATE_MAX_CLIENTS = 48;
const HISTORIC_CUSTOMER_ORDER_CACHE_PREFIX = 'historic_customer_orders_v1_';
const HISTORIC_CUSTOMER_ORDER_CACHE_SECONDS = 21600;
const HISTORIC_CUSTOMER_ORDER_CACHE_MAX_LENGTH = 90000;
const PUBLIC_DEALS_CACHE_KEY = 'public_deals_v4';
const PUBLIC_DEALS_CACHE_CHUNK_PREFIX = 'public_deals_v4_chunk_';
const PUBLIC_DEALS_CACHE_CHUNK_SIZE = 60000;
const PUBLIC_DEALS_CACHE_MAX_CHUNKS = 12;
const LEGACY_RECOVERY_MANIFEST_KEY = 'legacy_customer_group_recovery_manifest_v1';
const LEGACY_RECOVERY_RECEIPT_CUTOFF = '2026-09-03T10:45:00.000Z';
const LEGACY_RECOVERY_DEAL_IDS = [
  'customer-1783571204389',
  'customer-1784457727675',
  'customer-1784384845725',
  'customer-1785483350356',
  'customer-1785552043946',
  'customer-1786846122026',
  'customer-1785161630634',
  'customer-1785462601846',
  'customer-1784435839176',
  'customer-1785481017294',
  'customer-1785472551468',
  'customer-1784385010638',
  'customer-1785662414776',
  'customer-1784384041363',
  'customer-1783576635933',
  'customer-1785466024342'
];
let RUNTIME_SHEETS_CACHE_ = null;
// 승계 해석은 주문·그룹·상품 세 축의 읽기 경로에서 각각 필요하고, 사장님 경로는
// 한 요청에 소유 주장을 최대 OWNER_CLAIM_LIMIT 개까지 싣는다. 실행 단위로 한 번만
// 읽어 두지 않으면 '복구 등록' 읽기 비용이 주장 수에 비례해 늘어난다. 이 표는
// 자기 자신을 쓰는 요청 밖에서는 바뀌지 않으므로, 그 쓰기에서만 캐시를 버린다.
let RECOVERY_ROWS_CACHE_ = null;

function acquireScriptLock_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(SCRIPT_LOCK_TIMEOUT_MS)) throw groupOperationError_('collector_busy');
  return lock;
}

function isCentralDashboardEvent_(event) {
  const properties = event && event.properties || {};
  return Boolean(CENTRAL_DASHBOARD_EVENT_NAMES[String(event && event.name || '')])
    && properties.screen !== 'analytics_dashboard'
    && properties.app !== 'dashboard'
    && properties.is_internal !== true;
}

function acquireEventIngestLock_(event) {
  const lock = LockService.getScriptLock();
  const timeout = isCentralDashboardEvent_(event)
    ? CENTRAL_ANALYTICS_LOCK_TIMEOUT_MS
    : SCRIPT_LOCK_TIMEOUT_MS;
  if (!lock.tryLock(timeout)) throw groupOperationError_('collector_busy');
  return lock;
}

function centralAnalyticsEventCacheKey_(eventId) {
  const normalized = String(eventId || '');
  return /^[a-zA-Z0-9-]{1,128}$/.test(normalized)
    ? 'central_analytics_event_v1_' + normalized
    : '';
}

function centralAnalyticsEventRecentlyStored_(eventId) {
  const key = centralAnalyticsEventCacheKey_(eventId);
  if (!key) return false;
  try { return CacheService.getScriptCache().get(key) === '1'; }
  catch (error) { return false; }
}

function rememberCentralAnalyticsEvent_(eventId) {
  const key = centralAnalyticsEventCacheKey_(eventId);
  if (!key) return;
  try { CacheService.getScriptCache().put(key, '1', CENTRAL_ANALYTICS_EVENT_CACHE_SECONDS); }
  catch (error) {}
}

function invalidatePublicDealsCache_() {
  try {
    const cache = CacheService.getScriptCache();
    let chunkCount = 0;
    try {
      const manifest = JSON.parse(cache.get(PUBLIC_DEALS_CACHE_KEY) || '{}');
      chunkCount = Math.max(0, Math.min(PUBLIC_DEALS_CACHE_MAX_CHUNKS, Number(manifest.chunks || 0)));
    } catch (error) {}
    const keys = [PUBLIC_DEALS_CACHE_KEY];
    for (let index = 0; index < chunkCount; index += 1) {
      keys.push(PUBLIC_DEALS_CACHE_CHUNK_PREFIX + index);
    }
    cache.removeAll(keys);
  } catch (error) {}
}

function cachedPublicDeals_() {
  try {
    const cache = CacheService.getScriptCache();
    const manifest = JSON.parse(cache.get(PUBLIC_DEALS_CACHE_KEY) || '{}');
    const chunkCount = Number(manifest.chunks || 0);
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > PUBLIC_DEALS_CACHE_MAX_CHUNKS) {
      return null;
    }
    const keys = [];
    for (let index = 0; index < chunkCount; index += 1) {
      keys.push(PUBLIC_DEALS_CACHE_CHUNK_PREFIX + index);
    }
    const chunks = cache.getAll(keys);
    if (keys.some(function(key) { return typeof chunks[key] !== 'string'; })) return null;
    return JSON.parse(keys.map(function(key) { return chunks[key]; }).join(''));
  } catch (error) {
    return null;
  }
}

function cachePublicDeals_(deals) {
  try {
    const serialized = JSON.stringify(deals);
    const chunkCount = Math.ceil(serialized.length / PUBLIC_DEALS_CACHE_CHUNK_SIZE);
    if (chunkCount < 1 || chunkCount > PUBLIC_DEALS_CACHE_MAX_CHUNKS) return;
    const cache = CacheService.getScriptCache();
    const values = {};
    for (let index = 0; index < chunkCount; index += 1) {
      values[PUBLIC_DEALS_CACHE_CHUNK_PREFIX + index] = serialized.slice(
        index * PUBLIC_DEALS_CACHE_CHUNK_SIZE,
        (index + 1) * PUBLIC_DEALS_CACHE_CHUNK_SIZE
      );
    }
    cache.putAll(values, 15);
    cache.put(PUBLIC_DEALS_CACHE_KEY, JSON.stringify({ chunks: chunkCount }), 15);
  } catch (error) {}
}

function doGet() {
  return json_({ ok: true, service: 'UPTWOYOU collector' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (body.token !== INGEST_TOKEN) return json_({ ok: false, error: 'unauthorized' });
    if (body.action !== 'admin_credentials' && body.payload && body.payload.adminAssertion === true) {
      requireCurrentAdminCredential_(body.payload);
    }
    if (body.action === 'freeze_legacy_recovery_manifest') return freezeLegacyRecoveryManifest_();
    if (body.action === 'stats') return json_({ ok: true, stats: getCentralStats_() });
    if (body.action === 'public_deals') return json_({ ok: true, deals: getPublicDeals_(), deletedDeals: getDeletedDealMarkers_() });
    if (body.action === 'public_image') return json_({ ok: true, image: readPublicImage_(body.imageId) });
    if (body.action === 'owner_deals') return getOwnerPublicDealsResponse_(body.ownerClaims || []);
    if (body.action === 'publish_deal') return publishPublicDeal_(body.deal || {}, body.ownerCapabilityHash || '');
    if (body.action === 'delete_deal') return deletePublicDeal_(
      body.dealId || '',
      body.ownerCapabilityHash || '',
      body.expectedPublishVersion,
      body.clientMutationId || ''
    );
    if (body.action === 'customer_orders') {
      return getCustomerOrdersResponse_(
        body.phone || '',
        body.visitorId || '',
        body.customerCapabilityHash || '',
        body.groupId || ''
      );
    }
    if (body.action === 'customer_orders_group') return getCustomerOrdersByGroup_(body.payload || {});
    if (body.action === 'customer_orders_owner') {
      return getOwnerCustomerOrdersResponse_(body.ownerClaims || []);
    }
    if (body.action === 'publish_order') {
      return publishCustomerOrder_(
        body.order || {},
        body.visitorId || '',
        body.customerCapabilityHash || '',
        body.participantCapabilityHash || ''
      );
    }
    if (body.action === 'manage_order') return manageCustomerOrder_(body.payload || {});
    if (body.action === 'admin_operation') return handleAdminOperation_(body.payload || {});
    if (body.action === 'admin_credentials') return handleAdminCredentials_(body.payload);
    if (body.action === 'recovery_credentials') return handleRecoveryCredentials_(body.payload || {});
    if (/^group_(create|repair_customer_group|recover_legacy_customer_group|join|snapshot|send_message|mark_read|transition_group|transition_payment|update_target|toggle_lock|claim_host|release_host|reserve_quantity|rollback_reservation|cancel_participation)$/.test(String(body.action || ''))) {
      return handleGroupOperation_(String(body.action).replace(/^group_/, ''), body.payload || {});
    }
    // Unknown operation names must never fall through into analytics storage.
    if (body.action) return json_({ ok: false, error: 'invalid_action' });
    if (!body.event || typeof body.event !== 'object' || Array.isArray(body.event)
      || !String(body.event.name || '').trim()) {
      return json_({ ok: false, error: 'invalid_event' });
    }
    const event = body.event;
    const properties = event.properties || {};
    const centralDashboardEvent = isCentralDashboardEvent_(event);
    const lock = acquireEventIngestLock_(event);
    try {
      const sheets = ensureSheets_();
      const events = sheets.events;
      const duplicate = event.id && (centralDashboardEvent
        ? centralAnalyticsEventRecentlyStored_(event.id)
        : eventExists_(events, event.id));
      if (duplicate) {
        if (event.name === 'profile_submitted') {
          backfillVisitorProfile_(events, event.visitorId, properties);
        }
        if (event.name === 'survey_submitted' && !surveyExists_(sheets.surveys, event.id)) {
          appendSurveyRow_(sheets.surveys, event, properties);
        }
        CacheService.getScriptCache().remove('central_stats_v2');
        return json_({ ok: true, duplicate: true });
      }
      const storedProperties = JSON.parse(JSON.stringify(properties));
      storedProperties.event_id = event.id || '';
      events.appendRow([
        new Date(), event.timestamp ? new Date(event.timestamp) : new Date(),
        safeCell_(properties.tester_name || '미설정'), safeCell_(properties.tester_type || '미설정'),
        safeCell_(event.visitorId || ''), safeCell_(event.sessionId || ''), safeCell_(event.name || ''),
        safeCell_(properties.region || '미설정'), safeCell_(properties.district || '미설정'),
        safeCell_(properties.neighborhood || '미설정'), safeCell_(properties.screen || ''), JSON.stringify(storedProperties),
        safeCell_(properties.customer_number || ''), safeCell_(properties.customer_phone || ''), safeCell_(event.id || '')
      ]);
      if (event.name === 'profile_submitted') {
        backfillVisitorProfile_(events, event.visitorId, properties);
      }
      if (event.name === 'survey_submitted') {
        appendSurveyRow_(sheets.surveys, event, properties);
      }
      if (centralDashboardEvent) rememberCentralAnalyticsEvent_(event.id);
      CacheService.getScriptCache().remove('central_stats_v2');
    } finally {
      lock.releaseLock();
    }
    return json_({ ok: true });
  } catch (error) {
    return json_({ ok: false, error: error.code || String(error) });
  }
}

// This endpoint is reachable only after doPost's server ingest-token check.
// The API verifies PINs with scrypt. Apps Script never receives or stores a raw PIN.
function adminCredentialKeysMatch_(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every(function(field) {
    return Object.prototype.hasOwnProperty.call(value, field);
  });
}

function validAdminCredentialVerifier_(value) {
  return value && value.algorithm === 'scrypt-v1'
    && typeof value.salt === 'string' && /^[a-f0-9]{32}$/.test(value.salt)
    && typeof value.hash === 'string' && /^[a-f0-9]{128}$/.test(value.hash);
}

function readAdminCredential_(properties) {
  let serialized;
  try { serialized = properties.getProperty(ADMIN_CREDENTIAL_PROPERTY_KEY); }
  catch (error) { throw groupOperationError_('admin_credential_store_unavailable'); }
  if (serialized === null) return null;
  let value;
  try { value = JSON.parse(serialized); }
  catch (error) { throw groupOperationError_('admin_credential_state_invalid'); }
  if (!adminCredentialKeysMatch_(value, ['algorithm', 'salt', 'hash', 'version', 'updatedAt', 'updatedBy', 'lastMutationId'])
      || !validAdminCredentialVerifier_(value)
      || !Number.isSafeInteger(value.version) || value.version < 1
      || typeof value.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)
      || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt
      || typeof value.updatedBy !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.updatedBy)
      || typeof value.lastMutationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value.lastMutationId)) {
    throw groupOperationError_('admin_credential_state_invalid');
  }
  return value;
}

function requireCurrentAdminCredential_(payload) {
  let properties;
  try { properties = PropertiesService.getScriptProperties(); }
  catch (error) { throw groupOperationError_('admin_credential_store_unavailable'); }
  const credential = readAdminCredential_(properties);
  // Immutable older API deployments know only the bootstrap env PIN and omit
  // this version. Once rotated they must not confer admin privileges anymore.
  const suppliedVersion = payload.adminCredentialVersion;
  if (credential === null) {
    if (suppliedVersion === undefined || suppliedVersion === 0) return;
  } else if (Number.isSafeInteger(suppliedVersion) && suppliedVersion === credential.version) {
    return;
  }
  throw groupOperationError_('stale_admin_credential');
}

function validAdminAuthRateBucket_(value) {
  return adminCredentialKeysMatch_(value, ['failures', 'inFlight', 'windowStartedAt', 'blockedUntil', 'lastSeenAt'])
    && Number.isSafeInteger(value.failures) && value.failures >= 0
    && Number.isSafeInteger(value.inFlight) && value.inFlight >= 0
    && Number.isSafeInteger(value.windowStartedAt) && value.windowStartedAt >= 0
    && Number.isSafeInteger(value.blockedUntil) && value.blockedUntil >= 0
    && Number.isSafeInteger(value.lastSeenAt) && value.lastSeenAt >= 0;
}

function readAdminAuthRateState_(properties, propertyKey) {
  let serialized;
  try { serialized = properties.getProperty((propertyKey || ADMIN_AUTH_RATE_LIMIT_PROPERTY_KEY)); }
  catch (error) { throw groupOperationError_('admin_credential_store_unavailable'); }
  if (serialized === null) return { version: 1, global: null, clients: {} };
  let state;
  try { state = JSON.parse(serialized); }
  catch (error) { throw groupOperationError_('admin_auth_rate_limit_state_invalid'); }
  if (!adminCredentialKeysMatch_(state, ['version', 'global', 'clients']) || state.version !== 1
      || (state.global !== null && !validAdminAuthRateBucket_(state.global))
      || !state.clients || typeof state.clients !== 'object' || Array.isArray(state.clients)) {
    throw groupOperationError_('admin_auth_rate_limit_state_invalid');
  }
  const clientKeys = Object.keys(state.clients);
  if (clientKeys.length > ADMIN_AUTH_RATE_MAX_CLIENTS
      || clientKeys.some(function(key) { return !/^[a-f0-9]{32}$/.test(key) || !validAdminAuthRateBucket_(state.clients[key]); })) {
    throw groupOperationError_('admin_auth_rate_limit_state_invalid');
  }
  return state;
}

function activeAdminAuthRateBucket_(bucket, now) {
  if (!bucket) return null;
  if (bucket.blockedUntil > now || bucket.windowStartedAt + ADMIN_AUTH_RATE_WINDOW_MS > now) return bucket;
  return null;
}

function adminAuthRateRetryAfter_(bucket, now) {
  return bucket && bucket.blockedUntil > now
    ? Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000))
    : 0;
}

function nextAdminAuthFailureBucket_(bucket, now, failureLimit) {
  const active = activeAdminAuthRateBucket_(bucket, now);
  if (active && active.blockedUntil > now) return active;
  const failures = (active ? active.failures : 0) + 1;
  return {
    failures: failures,
    inFlight: Math.max(0, (active ? active.inFlight : 0) - 1),
    windowStartedAt: active ? active.windowStartedAt : now,
    blockedUntil: failures >= failureLimit ? now + ADMIN_AUTH_RATE_BLOCK_MS : 0,
    lastSeenAt: now
  };
}

function reserveAdminAuthRateBucket_(bucket, now) {
  const active = activeAdminAuthRateBucket_(bucket, now);
  return {
    failures: active ? active.failures : 0,
    inFlight: (active ? active.inFlight : 0) + 1,
    windowStartedAt: active ? active.windowStartedAt : now,
    blockedUntil: active ? active.blockedUntil : 0,
    lastSeenAt: now
  };
}

function adminAuthRateCapacityRetryAfter_(bucket, now, limit) {
  if (!bucket || bucket.failures + bucket.inFlight < limit) return 0;
  return Math.max(1, Math.ceil((Math.max(
    bucket.blockedUntil,
    bucket.windowStartedAt + ADMIN_AUTH_RATE_WINDOW_MS
  ) - now) / 1000));
}

function finishAdminAuthSuccessBucket_(bucket, now, resetFailures) {
  const active = activeAdminAuthRateBucket_(bucket, now);
  if (!active || active.inFlight < 1) throw groupOperationError_('admin_auth_rate_limit_state_invalid');
  const next = {
    failures: resetFailures ? 0 : active.failures,
    inFlight: active.inFlight - 1,
    windowStartedAt: active.windowStartedAt,
    blockedUntil: active.blockedUntil,
    lastSeenAt: now
  };
  return next.failures || next.inFlight ? next : null;
}

function pruneAdminAuthRateClients_(clients, now) {
  Object.keys(clients).forEach(function(key) {
    if (!activeAdminAuthRateBucket_(clients[key], now)) delete clients[key];
  });
  const keys = Object.keys(clients);
  if (keys.length <= ADMIN_AUTH_RATE_MAX_CLIENTS) return;
  keys.sort(function(left, right) { return clients[left].lastSeenAt - clients[right].lastSeenAt; })
    .slice(0, keys.length - ADMIN_AUTH_RATE_MAX_CLIENTS)
    .forEach(function(key) { delete clients[key]; });
}

function writeAdminAuthRateState_(properties, state, propertyKey) {
  const serialized = JSON.stringify(state);
  try {
    properties.setProperty(propertyKey || ADMIN_AUTH_RATE_LIMIT_PROPERTY_KEY, serialized);
    if (properties.getProperty(propertyKey || ADMIN_AUTH_RATE_LIMIT_PROPERTY_KEY) !== serialized) throw new Error('write_not_visible');
  } catch (error) { throw groupOperationError_('admin_credential_store_unavailable'); }
}

// 같은 잠금 안에서 결과를 다시 읽어야 하는 호출자를 위해 평문 객체를 돌려줄 수 있게 한다.
function recoveryRateResult_(raw, value) { return raw ? value : json_(value); }

function handleAdminAuthRateLimit_(properties, operation, clientKey, propertyKey, raw) {
  const now = Date.now();
  const state = readAdminAuthRateState_(properties, propertyKey);
  state.global = activeAdminAuthRateBucket_(state.global, now);
  pruneAdminAuthRateClients_(state.clients, now);
  const client = activeAdminAuthRateBucket_(state.clients[clientKey], now);
  if (client) state.clients[clientKey] = client;
  else delete state.clients[clientKey];
  const retryAfter = Math.max(
    adminAuthRateRetryAfter_(state.global, now),
    adminAuthRateRetryAfter_(client, now)
  );
  if (retryAfter > 0) return recoveryRateResult_(raw, { ok: true, allowed: false, retryAfter: retryAfter });
  if (operation === 'rate_begin' || operation === 'rate_check') {
    const capacityRetryAfter = Math.max(
      adminAuthRateCapacityRetryAfter_(state.global, now, ADMIN_AUTH_RATE_GLOBAL_FAILURE_LIMIT),
      adminAuthRateCapacityRetryAfter_(client, now, ADMIN_AUTH_RATE_CLIENT_FAILURE_LIMIT)
    );
    if (capacityRetryAfter > 0) {
      return recoveryRateResult_(raw, { ok: true, allowed: false, retryAfter: capacityRetryAfter });
    }
    state.global = reserveAdminAuthRateBucket_(state.global, now);
    state.clients[clientKey] = reserveAdminAuthRateBucket_(client, now);
    pruneAdminAuthRateClients_(state.clients, now);
    writeAdminAuthRateState_(properties, state, propertyKey);
    const result = { ok: true, allowed: true, reserved: true };
    // A PIN check previously needed another cold Apps Script request merely to
    // read the verifier. Return that same snapshot only for a successful
    // rate_begin reservation, while still requiring rate_success/failure to be
    // durably recorded before any privileged operation can run.
    //
    // Only the admin bucket may carry the admin verifier. Other callers share
    // this limiter but must never receive another realm's credential.
    if (operation === 'rate_begin'
      && (propertyKey || ADMIN_AUTH_RATE_LIMIT_PROPERTY_KEY) === ADMIN_AUTH_RATE_LIMIT_PROPERTY_KEY) {
      result.credential = readAdminCredential_(properties);
    }
    return recoveryRateResult_(raw, result);
  }
  if (operation === 'rate_success') {
    state.global = finishAdminAuthSuccessBucket_(state.global, now, false);
    const successfulClient = finishAdminAuthSuccessBucket_(client, now, true);
    if (successfulClient) state.clients[clientKey] = successfulClient;
    else delete state.clients[clientKey];
    writeAdminAuthRateState_(properties, state, propertyKey);
    return recoveryRateResult_(raw, { ok: true, allowed: true });
  }
  if (!state.global || state.global.inFlight < 1 || !client || client.inFlight < 1) {
    throw groupOperationError_('admin_auth_rate_limit_state_invalid');
  }
  state.global = nextAdminAuthFailureBucket_(state.global, now, ADMIN_AUTH_RATE_GLOBAL_FAILURE_LIMIT);
  state.clients[clientKey] = nextAdminAuthFailureBucket_(client, now, ADMIN_AUTH_RATE_CLIENT_FAILURE_LIMIT);
  pruneAdminAuthRateClients_(state.clients, now);
  writeAdminAuthRateState_(properties, state, propertyKey);
  const failureRetryAfter = Math.max(
    adminAuthRateRetryAfter_(state.global, now),
    adminAuthRateRetryAfter_(state.clients[clientKey], now)
  );
  return recoveryRateResult_(raw, { ok: true, allowed: failureRetryAfter === 0,
    ...(failureRetryAfter ? { retryAfter: failureRetryAfter } : {}) });
}

function handleAdminCredentials_(payload) {
  let lock = null;
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || !['read', 'write', 'rate_begin', 'rate_check', 'rate_failure', 'rate_success'].includes(payload.operation)) {
      throw groupOperationError_('invalid_admin_credential_request');
    }
    if (['rate_begin', 'rate_check', 'rate_failure', 'rate_success'].includes(payload.operation)) {
      if (!adminCredentialKeysMatch_(payload, ['operation', 'clientKey'])
          || typeof payload.clientKey !== 'string' || !/^[a-f0-9]{32}$/.test(payload.clientKey)) {
        throw groupOperationError_('invalid_admin_credential_request');
      }
      lock = acquireScriptLock_();
    } else if (payload.operation === 'read') {
      if (!adminCredentialKeysMatch_(payload, ['operation'])) throw groupOperationError_('invalid_admin_credential_request');
    } else {
      if (payload.adminAssertion !== true) throw groupOperationError_('forbidden');
      if (!adminCredentialKeysMatch_(payload, ['operation', 'adminAssertion', 'expectedVersion', 'clientMutationId', 'actorId', 'credential'])) {
        throw groupOperationError_('invalid_admin_credential_request');
      }
      if (!Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion < 0) throw groupOperationError_('invalid_expected_version');
      if (typeof payload.actorId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(payload.actorId)) throw groupOperationError_('invalid_actor_id');
      if (typeof payload.clientMutationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(payload.clientMutationId)) throw groupOperationError_('invalid_client_mutation_id');
      if (!adminCredentialKeysMatch_(payload.credential, ['algorithm', 'salt', 'hash']) || !validAdminCredentialVerifier_(payload.credential)) {
        throw groupOperationError_('invalid_admin_credential');
      }
      lock = acquireScriptLock_();
    }
    let properties;
    try { properties = PropertiesService.getScriptProperties(); }
    catch (error) { throw groupOperationError_('admin_credential_store_unavailable'); }
    if (['rate_begin', 'rate_check', 'rate_failure', 'rate_success'].includes(payload.operation)) {
      return handleAdminAuthRateLimit_(properties, payload.operation, payload.clientKey);
    }
    const existing = readAdminCredential_(properties);
    if (payload.operation === 'read') return json_({ ok: true, credential: existing });
    if (existing && existing.lastMutationId === payload.clientMutationId) {
      if (existing.version !== payload.expectedVersion + 1 || existing.updatedBy !== payload.actorId
          || existing.algorithm !== payload.credential.algorithm || existing.salt !== payload.credential.salt
          || existing.hash !== payload.credential.hash) throw groupOperationError_('client_mutation_conflict');
      return json_({ ok: true, duplicate: true, version: existing.version, updatedAt: existing.updatedAt });
    }
    const version = existing ? existing.version : 0;
    if (version !== payload.expectedVersion) throw groupOperationError_('state_conflict');
    if (version === Number.MAX_SAFE_INTEGER) throw groupOperationError_('admin_credential_version_exhausted');
    const record = {
      algorithm: payload.credential.algorithm, salt: payload.credential.salt, hash: payload.credential.hash,
      version: version + 1, updatedAt: new Date().toISOString(), updatedBy: payload.actorId,
      lastMutationId: payload.clientMutationId
    };
    const serialized = JSON.stringify(record);
    try {
      properties.setProperty(ADMIN_CREDENTIAL_PROPERTY_KEY, serialized);
      if (properties.getProperty(ADMIN_CREDENTIAL_PROPERTY_KEY) !== serialized) throw new Error('write_not_visible');
    } catch (error) { throw groupOperationError_('admin_credential_store_unavailable'); }
    return json_({ ok: true, version: record.version, updatedAt: record.updatedAt });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'admin_credential_store_unavailable' });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function eventExists_(events, eventId) {
  if (!eventId || events.getLastRow() < 2) return false;
  return Boolean(events.getRange(2, EVENT_HEADERS.length, events.getLastRow() - 1, 1)
    .createTextFinder(String(eventId)).matchEntireCell(true).findNext());
}

function surveyExists_(surveys, eventId) {
  if (!eventId || surveys.getLastRow() < 2) return false;
  return Boolean(surveys.getRange(2, SURVEY_HEADERS.length, surveys.getLastRow() - 1, 1)
    .createTextFinder(String(eventId)).matchEntireCell(true).findNext());
}

function appendSurveyRow_(surveys, event, properties) {
  surveys.appendRow(surveyRowValues_(event, properties));
}

function orderSnapshotFingerprint_(order) {
  const history = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  const latestHistory = history.length ? history[history.length - 1] : {};
  const source = [
    order.id,
    order.statusUpdatedAt || order.createdAt || '',
    order.status || '',
    order.paymentStatus || '',
    order.paymentVersion || order.version || '',
    order.paymentRequestedAt || '',
    order.paymentConfirmedAt || '',
    order.customerPickupConfirmedAt || '',
    order.cancelledAt || '',
    order.selectedCount || order.quantity || '',
    order.total || '',
    latestHistory.clientMutationId || latestHistory.timestamp || ''
  ].join('|');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, source, Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + (byte & 255).toString(16)).slice(-2); })
    .join('')
    .slice(0, 24);
}

function appendCustomerOrderSnapshotEvent_(events, order, customerCapabilityHash) {
  const eventId = 'order-sync-' + orderSnapshotFingerprint_(order);
  if (eventExists_(events, eventId)) return true;
  const timestamp = new Date();
  const storedOrder = Object.assign({}, order, {
    _customerCapabilityHash: customerCapabilityHash
  });
  const properties = {
    screen: 'customer_orders',
    tester_name: order.customerName || '',
    tester_type: '사용자',
    customer_number: order.customerNumber || '',
    customer_phone: order.customerPhone || '',
    region: order.region || '',
    district: order.district || '',
    neighborhood: order.neighborhood || '',
    order_snapshot: JSON.stringify(storedOrder),
    event_id: eventId
  };
  events.appendRow([
    timestamp, timestamp,
    safeCell_(properties.tester_name || '미설정'), safeCell_(properties.tester_type),
    safeCell_(order.visitorId || ('customer-' + normalizePhone_(order.customerPhone))),
    safeCell_('order-sync-' + normalizePhone_(order.customerPhone).slice(-4)),
    'customer_order_snapshot',
    safeCell_(properties.region || '미설정'), safeCell_(properties.district || '미설정'),
    safeCell_(properties.neighborhood || '미설정'), 'customer_orders', JSON.stringify(properties),
    safeCell_(properties.customer_number), safeCell_(properties.customer_phone), safeCell_(eventId)
  ]);
  try { CacheService.getScriptCache().remove('central_stats_v2'); } catch (error) {}
  return true;
}

function surveyRowValues_(event, properties) {
  return [
    new Date(), event.timestamp ? new Date(event.timestamp) : new Date(),
    safeCell_(properties.customer_number || ''), safeCell_(properties.tester_name || '미설정'),
    safeCell_(properties.customer_phone || ''), safeCell_(properties.tester_type || '미설정'),
    safeCell_(properties.region || '미설정'), safeCell_(properties.district || '미설정'),
    safeCell_(properties.neighborhood || '미설정'), safeCell_(properties.reason || ''),
    safeCell_(properties.discountExpectation || ''), safeCell_(properties.hostIntent || ''),
    safeCell_(properties.preferredCategory || ''), safeCell_(properties.revisitIntent || ''),
    safeCell_(properties.feedback || ''), safeCell_(event.visitorId || ''), safeCell_(event.id || '')
  ];
}

function safeCell_(value) {
  const text = String(value == null ? '' : value).slice(0, 5000);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function privateCapabilityHash_(value, errorCode) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw groupOperationError_(errorCode || 'invalid_capability');
  return normalized;
}

function normalizeOwnerClaims_(claimsValue) {
  if (!Array.isArray(claimsValue)
    || claimsValue.length < 1
    || claimsValue.length > OWNER_CLAIM_LIMIT) {
    throw groupOperationError_('invalid_owner_claims');
  }
  const seen = Object.create(null);
  return claimsValue.map(function(claim) {
    const dealId = String(claim && claim.dealId || '');
    if (!/^owner-[a-zA-Z0-9-]{1,100}$/.test(dealId) || seen[dealId]) {
      throw groupOperationError_('invalid_owner_claims');
    }
    seen[dealId] = true;
    return {
      dealId: dealId,
      ownerCapabilityHash: privateCapabilityHash_(
        claim && claim.ownerCapabilityHash,
        'invalid_owner_capability'
      )
    };
  });
}

function ownerClaimMatchesDeal_(claim, deal) {
  return Boolean(
    claim
    && deal
    && String(deal.id || '') === String(claim.dealId || '')
    && String(deal.source || '') === 'merchant'
    && /^[a-f0-9]{64}$/.test(String(deal._ownerCapabilityHash || '').toLowerCase())
    && String(deal._ownerCapabilityHash || '').toLowerCase()
      === String(claim.ownerCapabilityHash || '').toLowerCase()
  );
}

function publicDealRecordsByIds_(sheet, dealIds) {
  const requested = Object.create(null);
  (dealIds || []).forEach(function(dealId) {
    const normalized = String(dealId || '');
    if (normalized) requested[normalized] = true;
  });
  const records = Object.create(null);
  if (!sheet || !Object.keys(requested).length || sheet.getLastRow() < 2) return records;
  // An owner can present up to 50 claims. Reading the compact JSON column once
  // avoids one Spreadsheet TextFinder plus one cell read per product. Exact id
  // and capability checks still happen below, so this changes only read cost.
  sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).getValues().forEach(function(row) {
    try {
      const deal = JSON.parse(row[0] || '{}');
      const dealId = String(deal && deal.id || '');
      if (requested[dealId] && deal && typeof deal === 'object' && !Array.isArray(deal)) {
        records[dealId] = deal;
      }
    } catch (error) {}
  });
  return records;
}

function authorizedOwnerDealIds_(sheets, claimsValue) {
  const claims = normalizeOwnerClaims_(claimsValue);
  const records = publicDealRecordsByIds_(sheets.publicDeals, claims.map(function(claim) {
    return claim.dealId;
  }));
  const authorized = Object.create(null);
  claims.forEach(function(claim) {
    const deal = records[claim.dealId] || null;
    if (ownerClaimMatchesDeal_(claim, deal)) {
      authorized[claim.dealId] = true;
      return;
    }
    // 승계도 직접 소유와 같은 판정기를 통과해야 한다. 결박 당시 해시를 주장으로
    // 되돌려 ownerClaimMatchesDeal_ 에 그대로 태우면, 상품 행이 그 사이 바뀐
    // 경우가 자동으로 걸러지고 두 경로의 기준이 갈라지지 않는다.
    const inherited = recoveryDealSuccessionHash_(sheets, claim.dealId, claim.ownerCapabilityHash);
    if (inherited && ownerClaimMatchesDeal_(
      { dealId: claim.dealId, ownerCapabilityHash: inherited }, deal
    )) {
      authorized[claim.dealId] = true;
    }
  });
  return authorized;
}

function getOwnerPublicDealsResponse_(claimsValue) {
  try {
    const sheets = ensureSheets_();
    const authorized = authorizedOwnerDealIds_(sheets, claimsValue);
    const deals = getPublicDeals_().filter(function(deal) {
      return Boolean(authorized[String(deal && deal.id || '')]);
    });
    return json_({ ok: true, deals: deals });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'owner_deals_failed' });
  }
}

function ownerScopedOrders_(orders, authorizedDealIds, sheets) {
  const projectionContext = {};
  return mergeCustomerOrderSnapshots_(orders || []).filter(function(order) {
    return Boolean(authorizedDealIds[customerOrderDealId_(order)]);
  }).map(function(order) {
    return publicOrderValue_(sheets ? projectStoredGroupOrderPayment_(sheets, order, projectionContext) : order);
  });
}

function getOwnerCustomerOrdersResponse_(claimsValue) {
  try {
    const sheets = ensureSheets_();
    const authorized = authorizedOwnerDealIds_(sheets, claimsValue);
    const authorizedDealIds = Object.keys(authorized);
    if (!authorizedDealIds.length) return json_({ ok: true, orders: [] });
    let snapshots = storedCustomerOrders_(sheets.customerOrders);
    // Legacy orders can exist only in the event log. Read those snapshots only
    // after verifying the current product capability, as in the admin view.
    snapshots = snapshots.concat(historicCustomerOrdersForDeals_(sheets.events, authorized));
    // Merge before scoping so an older snapshot cannot override a newer order
    // belonging to another product, or roll back its status/version.
    const orders = ownerScopedOrders_(snapshots, authorized, sheets);
    return json_({ ok: true, orders: orders });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'owner_orders_failed' });
  }
}

function publicDealValue_(deal) {
  const copy = Object.assign({}, deal || {});
  delete copy._adminMutationHistory;
  delete copy._ownerCapabilityHash;
  delete copy._lastDealPublishMutationId;
  delete copy._lastDealPublishMutationContract;
  delete copy._lastDealDeleteMutationId;
  delete copy._lastDealDeleteMutationContract;
  delete copy._groupPublishPending;
  delete copy._groupPublishRepair;
  delete copy.expectedPublishVersion;
  delete copy.publishMutationId;
  return copy;
}

function publicDealPublishMutationId_(deal) {
  const mutationId = String(deal && deal.publishMutationId || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(mutationId)) {
    throw groupOperationError_('invalid_client_mutation_id');
  }
  return mutationId;
}

function sha256Hex_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value || ''),
    Utilities.Charset.UTF_8
  )
    .map(function(byte) { return ('0' + (byte & 255).toString(16)).slice(-2); })
    .join('');
}

// Legacy order snapshots live in the analytics event log, and a phone read has
// to scan that whole sheet to rebuild them. Publishing writes the canonical
// 주문 내역 row instead, so this derived set only changes when the event sheet
// itself gains a row — the row count is therefore a safe cache key. Current
// orders and the participant payment projection are always read fresh, so a
// cache hit can never freeze a live 입금 상태.
function historicCustomerOrderCacheKey_(phone, eventRowCount) {
  return HISTORIC_CUSTOMER_ORDER_CACHE_PREFIX
    + sha256Hex_('historic-orders:' + String(phone || '')).slice(0, 24)
    + '_' + String(eventRowCount);
}

function cachedHistoricCustomerOrders_(phone, eventRowCount) {
  try {
    const value = CacheService.getScriptCache()
      .get(historicCustomerOrderCacheKey_(phone, eventRowCount));
    if (typeof value !== 'string') return null;
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function cacheHistoricCustomerOrders_(phone, eventRowCount, orders) {
  try {
    const serialized = JSON.stringify(orders);
    if (serialized.length > HISTORIC_CUSTOMER_ORDER_CACHE_MAX_LENGTH) return;
    CacheService.getScriptCache().put(
      historicCustomerOrderCacheKey_(phone, eventRowCount),
      serialized,
      HISTORIC_CUSTOMER_ORDER_CACHE_SECONDS
    );
  } catch (error) {}
}

function legacyRecoveryDenied_() {
  return groupOperationError_('legacy_recovery_not_authorized');
}

function legacyRecoveryDealAllowed_(dealId) {
  return LEGACY_RECOVERY_DEAL_IDS.indexOf(String(dealId || '')) !== -1;
}

function canonicalLegacyEventId_(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    String(value || '')
  );
}

function validLegacyRecoveryActorId_(value) {
  // Match the public analytics gateway's historical visitor-id contract.
  return /^[a-zA-Z0-9-]{1,128}$/.test(String(value || ''));
}

function legacyRecoveryMutationId_(eventHash) {
  return 'legacy-recovery-' + sha256Hex_('legacy-recovery:' + String(eventHash || ''));
}

function parseLegacyRecoveryManifest_(serialized) {
  let parsed;
  try { parsed = JSON.parse(String(serialized || '')); } catch (error) { return null; }
  if (!Array.isArray(parsed)) return null;
  const valid = parsed.every(function(entry) {
    return entry && typeof entry === 'object' && !Array.isArray(entry)
      && legacyRecoveryDealAllowed_(entry.dealId)
      && validLegacyRecoveryActorId_(entry.actorId)
      && /^[a-f0-9]{64}$/.test(String(entry.eventHash || ''));
  });
  return valid ? parsed.map(function(entry) {
    return {
      eventHash: String(entry.eventHash),
      actorId: String(entry.actorId),
      dealId: String(entry.dealId)
    };
  }) : null;
}

function legacyRecoveryStatus_(entries, conflictDealIds, includeConflicts) {
  const eligible = {};
  (entries || []).forEach(function(entry) { eligible[String(entry.dealId || '')] = true; });
  const conflicts = {};
  (conflictDealIds || []).forEach(function(dealId) { conflicts[String(dealId || '')] = true; });
  const result = {
    ok: true,
    frozen: true,
    count: (entries || []).length,
    eligibleDealIds: LEGACY_RECOVERY_DEAL_IDS.filter(function(dealId) { return eligible[dealId]; }),
    missingDealIds: LEGACY_RECOVERY_DEAL_IDS.filter(function(dealId) {
      return !eligible[dealId] && !conflicts[dealId];
    })
  };
  if (includeConflicts) {
    result.conflictDealIds = LEGACY_RECOVERY_DEAL_IDS.filter(function(dealId) {
      return conflicts[dealId];
    });
  }
  return result;
}

function eligibleLegacyRecoveryDeal_(sheets, dealId, actorId) {
  const deal = publicDealRecord_(sheets.publicDeals, dealId);
  const recordedCreator = String(deal && deal.creatorActorId || '');
  const recordedGroupStatus = String(deal && deal.groupStatus || '');
  if (!deal
    || String(deal.id || '') !== dealId
    || String(deal.groupId || deal.id || '') !== dealId
    || String(deal.source || '') !== 'customer'
    || String(deal.visibility || '') !== 'public'
    || String(deal._ownerCapabilityHash || '') !== ''
    // This one-time migration reconstructs only groups that were still
    // recruiting when the manifest was frozen. Never roll a completed deal
    // back into a joinable room, even if a historical receipt still exists.
    || (recordedGroupStatus && recordedGroupStatus !== GROUP_STATUSES[0])
    || (recordedCreator && recordedCreator !== actorId)
    || findExactRow_(sheets.groups, 1, dealId)) {
    return null;
  }
  return deal;
}

function firstDefinedLegacyDealValue_(deal, keys, fallback) {
  for (let index = 0; index < keys.length; index += 1) {
    const value = deal[keys[index]];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function canonicalLegacyRecoveryGroup_(deal, actorId, nickname, capabilityHash, now) {
  const title = groupText_(deal.title, 120);
  const targetCount = requireInteger_(
    firstDefinedLegacyDealValue_(deal, ['targetCount', 'targetPeople', 'target'], undefined),
    'target_count',
    1,
    GROUP_MAX_PARTICIPANTS
  );
  const totalQuantity = requireInteger_(
    firstDefinedLegacyDealValue_(deal, ['totalQuantity', 'productQuantity'], targetCount),
    'total_quantity',
    1,
    999
  );
  const selectedQuantity = requireInteger_(
    firstDefinedLegacyDealValue_(deal, ['creatorQuantity', 'creatorProductQuantity', 'selectedQuantity'], 1),
    'selected_quantity',
    1,
    totalQuantity
  );
  const hostMode = String(deal.hostMode || 'self');
  if (!title || (hostMode !== 'self' && hostMode !== 'recruiting')) throw legacyRecoveryDenied_();
  const role = hostMode === 'recruiting' ? 'creator' : 'host';
  return {
    group: {
      groupId: String(deal.id), dealId: String(deal.id), title: title,
      groupStatus: GROUP_STATUSES[0], targetCount: targetCount, chatLocked: false,
      hostActorId: role === 'host' ? actorId : '', lastMessageSeq: 0, version: 1,
      createdAt: now, updatedAt: now, updatedBy: actorId, creatorActorId: actorId,
      hostMode: hostMode, totalQuantity: totalQuantity
    },
    participant: {
      groupId: String(deal.id), actorId: actorId, nickname: nickname, role: role,
      counted: true, paymentStatus: 'pending', lastReadSeq: 0,
      capabilityHash: capabilityHash, version: 1, joinedAt: now, updatedAt: now,
      selectedQuantity: selectedQuantity
    },
    role: role
  };
}

function buildLegacyRecoveryManifest_(sheets) {
  const candidates = {};
  const cutoff = new Date(LEGACY_RECOVERY_RECEIPT_CUTOFF).getTime();
  const events = sheets.events;
  if (events && events.getLastRow() >= 2) {
    const rows = events.getRange(2, 1, events.getLastRow() - 1, EVENT_HEADERS.length).getValues();
    rows.forEach(function(row) {
      // Column 1 is the collector's server receipt time. Column 2 is supplied
      // by the browser and is intentionally never used for this cutoff.
      const receivedAt = new Date(row[0]).getTime();
      const actorId = String(row[4] || '');
      const eventName = String(row[6] || '');
      const eventId = String(row[14] || '');
      if (!Number.isFinite(receivedAt) || receivedAt > cutoff
        || eventName !== 'group_created'
        || !canonicalLegacyEventId_(eventId)
        || !validLegacyRecoveryActorId_(actorId)) return;
      let detail;
      try { detail = JSON.parse(String(row[11] || '{}')); } catch (error) { return; }
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return;
      const dealId = String(detail.deal_id || '');
      if (!legacyRecoveryDealAllowed_(dealId) || String(detail.source || '') !== 'customer') return;
      if (!candidates[dealId]) candidates[dealId] = [];
      candidates[dealId].push({
        eventHash: sha256Hex_(eventId),
        actorId: actorId,
        dealId: dealId
      });
    });
  }

  const entries = [];
  const conflicts = [];
  LEGACY_RECOVERY_DEAL_IDS.forEach(function(dealId) {
    const dealCandidates = candidates[dealId] || [];
    const actors = {};
    dealCandidates.forEach(function(entry) { actors[entry.actorId] = true; });
    const actorIds = Object.keys(actors);
    if (actorIds.length > 1) {
      conflicts.push(dealId);
      return;
    }
    const byHash = {};
    dealCandidates.forEach(function(entry) {
      byHash[entry.eventHash] = entry;
    });
    const unique = Object.keys(byHash).map(function(eventHash) { return byHash[eventHash]; });
    if (actorIds.length !== 1 || !eligibleLegacyRecoveryDeal_(sheets, dealId, actorIds[0])) return;
    unique.forEach(function(entry) { entries.push(entry); });
  });
  entries.sort(function(left, right) {
    return left.dealId.localeCompare(right.dealId) || left.eventHash.localeCompare(right.eventHash);
  });
  return { entries: entries, conflictDealIds: conflicts };
}

function freezeLegacyRecoveryManifest_() {
  let lock = null;
  try {
    lock = acquireScriptLock_();
    const properties = PropertiesService.getScriptProperties();
    const existing = properties.getProperty(LEGACY_RECOVERY_MANIFEST_KEY);
    if (existing !== null && existing !== undefined) {
      const frozenEntries = parseLegacyRecoveryManifest_(existing);
      if (!frozenEntries) throw new Error('invalid_legacy_recovery_manifest');
      return json_(legacyRecoveryStatus_(frozenEntries, [], false));
    }
    const built = buildLegacyRecoveryManifest_(ensureSheets_());
    // The property is immutable by this endpoint. It intentionally contains
    // only the minimum private authorization tuple and never raw event ids.
    properties.setProperty(LEGACY_RECOVERY_MANIFEST_KEY, JSON.stringify(built.entries));
    return json_(legacyRecoveryStatus_(built.entries, built.conflictDealIds, true));
  } catch (error) {
    return json_({ ok: false, error: 'legacy_recovery_manifest_failed' });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (error) {}
    }
  }
}

function requireLegacyRecoveryManifestEntry_(payload) {
  const eventHash = String(payload && payload.legacyEventHash || '').toLowerCase();
  const actorId = String(payload && payload.actorId || '');
  const dealId = String(payload && payload.dealId || '');
  if (!/^[a-f0-9]{64}$/.test(eventHash)
    || !validLegacyRecoveryActorId_(actorId)
    || !legacyRecoveryDealAllowed_(dealId)) throw legacyRecoveryDenied_();
  const serialized = PropertiesService.getScriptProperties().getProperty(LEGACY_RECOVERY_MANIFEST_KEY);
  const entries = parseLegacyRecoveryManifest_(serialized);
  if (!entries || !entries.some(function(entry) {
    return entry.eventHash === eventHash && entry.actorId === actorId && entry.dealId === dealId;
  })) throw legacyRecoveryDenied_();
  return eventHash;
}

function normalizePublicDealPublishContract_(value) {
  const contract = String(value || '');
  if (/^sha256:[a-f0-9]{64}$/i.test(contract)) return contract.toLowerCase();
  return 'sha256:' + sha256Hex_(contract);
}

function publicDealPublishContractMatches_(storedContract, incomingContract) {
  return normalizePublicDealPublishContract_(storedContract)
    === normalizePublicDealPublishContract_(incomingContract);
}

function publicDealPublishContract_(deal) {
  const copy = Object.assign({}, deal || {});
  delete copy._ownerCapabilityHash;
  delete copy._lastDealPublishMutationId;
  delete copy._lastDealPublishMutationContract;
  delete copy._lastDealDeleteMutationId;
  delete copy._lastDealDeleteMutationContract;
  delete copy._groupPublishPending;
  delete copy._groupPublishRepair;
  delete copy.expectedPublishVersion;
  delete copy.publishMutationId;
  delete copy.publishVersion;
  delete copy.createdAt;
  delete copy.updatedAt;
  delete copy.syncedAt;
  return normalizePublicDealPublishContract_(JSON.stringify(copy));
}

function publicOrderValue_(order) {
  const copy = Object.assign({}, order || {});
  delete copy._lastAdminCancelId;
  delete copy._lastAdminCancelContract;
  delete copy._customerCapabilityHash;
  delete copy._reservationMutationId;
  delete copy._reservationAction;
  delete copy._reservationQuantity;
  delete copy._lastPublishMutationId;
  delete copy._lastPublishMutationContract;
  delete copy.customerCapabilityHash;
  delete copy.customerCapabilityToken;
  delete copy.capabilityHash;
  delete copy.capabilityToken;
  return copy;
}

function storedCustomerOrders_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const orders = [];
  sheet.getRange(2, 4, sheet.getLastRow() - 1, 1).getValues().forEach(function(row) {
    try {
      const order = JSON.parse(row[0] || '{}');
      if (order && order.id) orders.push(order);
    } catch (error) {}
  });
  return mergeCustomerOrderSnapshots_(orders);
}

function customerOrderDealId_(order) {
  return String((order && (order.dealId || (order.deal && order.deal.id))) || '');
}

function activePurchaseOrder_(order) {
  return Boolean(
    order
    && String(order.type || '') === 'purchase'
    && String(order.status || '') !== 'cancelled'
    && String(order.paymentStatus || '') !== 'cancelled'
  );
}

function activeGroupOrder_(order) {
  return Boolean(
    order
    && ['purchase', 'group'].includes(String(order.type || ''))
    && String(order.status || '') !== 'cancelled'
    && String(order.paymentStatus || '') !== 'cancelled'
  );
}

function groupPaymentActors_(sheets, groupIdValue, participantsValue) {
  const groupId = String(groupIdValue || '');
  const participants = Array.isArray(participantsValue) ? participantsValue : [];
  const adminActors = Object.create(null);
  const actors = Object.create(null);
  const ensureActor = function(actorKey, actorId) {
    if (!actors[actorKey]) {
      actors[actorKey] = {
        actorId: actorId,
        participantPaymentStatuses: [],
        orderPaymentStatuses: []
      };
    }
    return actors[actorKey];
  };

  participants.forEach(function(participant) {
    const actorId = String(participant && participant.actorId || '');
    if (participant && participant.role === 'admin' && actorId) adminActors[actorId] = true;
  });
  participants.forEach(function(participant, index) {
    if (!participant || participant.role === 'admin' || participant.counted === false) return;
    const actorId = String(participant.actorId || '');
    if (actorId && adminActors[actorId]) return;
    const actorKey = actorId || ('participant:' + String(index));
    ensureActor(actorKey, actorId).participantPaymentStatuses.push(
      String(participant.paymentStatus || 'pending')
    );
  });

  storedCustomerOrders_(sheets && sheets.customerOrders).forEach(function(order, index) {
    if (!activeGroupOrder_(order)
      || String(order.groupId || '') !== groupId
      || customerOrderDealId_(order) !== groupId) return;
    const actorId = String(order.participantActorId || order.visitorId || '');
    if (actorId && adminActors[actorId]) return;
    const actorKey = actorId || ('order:' + String(order.id || index));
    ensureActor(actorKey, actorId).orderPaymentStatuses.push(
      String(order.paymentStatus || 'pending')
    );
  });

  return Object.keys(actors).map(function(actorKey) { return actors[actorKey]; });
}

function allGroupPaymentsConfirmed_(sheets, groupId, participants) {
  const actors = groupPaymentActors_(sheets, groupId, participants);
  return Boolean(actors.length && actors.every(function(actor) {
    return actor.participantPaymentStatuses.concat(actor.orderPaymentStatuses)
      .every(function(paymentStatus) { return paymentStatus === 'confirmed'; });
  }));
}

function verifiedBoundGroupPurchaseOrder_(order, groupIdValue, actorIdValue, reservationHistoryValue) {
  const groupId = String(groupIdValue || '');
  const actorId = String(actorIdValue || '');
  if (!groupId || !actorId || !activeGroupOrder_(order)) return false;
  if (String(order.groupId || '') !== groupId
    || customerOrderDealId_(order) !== groupId
    || String(order.participantActorId || order.visitorId || '') !== actorId) {
    return false;
  }

  const mutationId = String(order._reservationMutationId || '');
  const action = String(order._reservationAction || '');
  const quantity = Number(order._reservationQuantity || 0);
  if (!mutationId || !['create', 'join', 'reserve_quantity'].includes(action)
    || !Number.isInteger(quantity) || quantity < 1
    || String(order.reservationMutationId || '') !== mutationId
    || String(order.reservationAction || '') !== action
    || Number(order.reservationQuantity || 0) !== quantity
    || customerOrderQuantity_(order) !== quantity) {
    return false;
  }

  const history = Array.isArray(reservationHistoryValue) ? reservationHistoryValue : [];
  const reservation = history.find(function(item) {
    return String(item && item.mutationId || '') === mutationId
      && String(item && item.action || '') === action;
  });
  return Boolean(
    reservation
    && activeCustomerOrderReservation_(reservation, history)
    && customerOrderReservationQuantity_(reservation, history, quantity) === quantity
  );
}

function groupPaymentOrderRecords_(sheets, groupIdValue, actorIdValue) {
  const groupId = String(groupIdValue || '');
  const actorId = String(actorIdValue || '');
  const sheet = sheets && sheets.customerOrders;
  if (!sheet || !groupId || !actorId || sheet.getLastRow() < 2) return [];
  const reservationHistory = customerOrderReservationHistory_(sheets, groupId, actorId);
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, CUSTOMER_ORDER_HEADERS.length)
    .getValues()
    .map(function(row, index) {
      try {
        const order = JSON.parse(row[3] || '{}');
        return { rowNumber: index + 2, order: order };
      } catch (error) {
        return null;
      }
    })
    .filter(function(record) {
      return Boolean(
        record
        && verifiedBoundGroupPurchaseOrder_(
          record.order,
          groupId,
          actorId,
          reservationHistory
        )
      );
    });
}

// Old central rows may have lost only their private reservation columns. A
// caller-supplied actor, phone, public reservation id, or repair/recovery group
// history is not ownership evidence. Restore a binding only from a server order
// snapshot of this exact owned order plus the completed, genuine reservation.
// This function is a read-only plan; the payment mutation persists it under the
// existing script lock and durable mutation intent.
function recoverableGroupPaymentOrder_(sheets, order, groupId, actorId, history) {
  if (!activeGroupOrder_(order)
    || !/^order-\d{10,20}$/.test(String(order.id || ''))
    || String(order.groupId || '') !== groupId
    || customerOrderDealId_(order) !== groupId
    || String(order.visitorId || '') !== actorId
    || String(order.participantActorId || order.visitorId || '') !== actorId
    || !/^[a-f0-9]{64}$/.test(String(order._customerCapabilityHash || ''))
    || !sheets.events) return null;
  const participant = getParticipantRecord_(sheets, groupId, actorId, false);
  if (!participant || !participant.counted
    || Number(participant.selectedQuantity || 0) < customerOrderQuantity_(order)) return null;
  // Reads may also receive event-only legacy orders. Never materialize or adopt
  // one here: there must already be one unambiguous central row with this id.
  const central = storedCustomerOrders_(sheets.customerOrders).filter(function(candidate) {
    return String(candidate.id || '') === String(order.id);
  });
  if (central.length !== 1 || JSON.stringify(central[0]) !== JSON.stringify(order)) return null;
  const snapshots = [];
  if (sheets.events.getLastRow() >= 2) {
    sheets.events.getRange(2, 12, sheets.events.getLastRow() - 1, 1)
      .createTextFinder(String(order.id)).matchCase(true).findAll().forEach(function(match) {
        const row = sheets.events.getRange(match.getRow(), 1, 1, EVENT_HEADERS.length).getValues()[0];
        if (String(row[6] || '') !== 'customer_order_snapshot') return;
        try {
          const snapshot = JSON.parse(JSON.parse(row[11] || '{}').order_snapshot || '{}');
          if (String(snapshot.id || '') !== String(order.id)
            || String(row[14] || '') !== 'order-sync-' + orderSnapshotFingerprint_(snapshot)) return;
          snapshots.push(snapshot);
        } catch (error) {}
      });
  }
  const ownership = customerOrderOwnership_(snapshots.concat([order]));
  if (ownership.conflict || ownership.hash !== order._customerCapabilityHash) return null;
  const proven = snapshots.filter(function(snapshot) {
    if (snapshot._customerCapabilityHash !== order._customerCapabilityHash
      || !verifiedBoundGroupPurchaseOrder_(snapshot, groupId, actorId, history)) return false;
    try { requireSameCustomerOrderIdentity_(order, snapshot); } catch (error) { return false; }
    const reservation = history.find(function(item) {
      return item.mutationId === snapshot._reservationMutationId
        && item.action === snapshot._reservationAction;
    });
    let contract;
    try { contract = JSON.parse(reservation.result.mutationContract); } catch (error) { return false; }
    const quantity = Number(contract && (reservation.action === 'reserve_quantity'
      ? contract.quantity : contract.selectedQuantity));
    return reservation.result.pending === false
      && contract.action === reservation.action && contract.groupId === groupId
      && contract.actorId === actorId && Number.isInteger(quantity) && quantity > 0
      && quantity === customerOrderQuantity_(order)
      && !history.some(function(item) {
        return item.rowNumber > reservation.rowNumber
          && ['cancel_participation', 'admin_cancel_order'].includes(item.action);
      });
  });
  if (!proven.length) return null;
  const proof = proven[0];
  const fields = ['reservationMutationId', 'reservationAction', 'reservationQuantity',
    '_reservationMutationId', '_reservationAction', '_reservationQuantity'];
  if (proven.some(function(snapshot) {
    return fields.some(function(field) { return String(snapshot[field]) !== String(proof[field]); });
  })) return null;
  if (storedCustomerOrders_(sheets.customerOrders).some(function(candidate) {
    return String(candidate.id || '') !== String(order.id)
      && String(candidate._reservationMutationId || candidate.reservationMutationId || '')
        === String(proof._reservationMutationId);
  })) {
    return null;
  }
  const repaired = Object.assign({}, order);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    // Missing fields can be recovered; conflicting evidence cannot be erased.
    if (order[field] !== undefined && order[field] !== null && order[field] !== ''
      && String(order[field]) !== String(proof[field])) return null;
    repaired[field] = proof[field];
  }
  return verifiedBoundGroupPurchaseOrder_(repaired, groupId, actorId, history) ? repaired : null;
}

function plannedGroupPaymentOrderRecords_(sheets, groupId, actorId) {
  const records = groupPaymentOrderRecords_(sheets, groupId, actorId);
  const history = customerOrderReservationHistory_(sheets, groupId, actorId);
  const sheet = sheets.customerOrders;
  if (!sheet || sheet.getLastRow() < 2) return records;
  const claimed = Object.create(null);
  records.forEach(function(record) { claimed[record.order._reservationMutationId] = true; });
  const candidates = [];
  sheet.getRange(2, 1, sheet.getLastRow() - 1, CUSTOMER_ORDER_HEADERS.length)
    .getValues().forEach(function(row, index) {
      let order;
      try { order = JSON.parse(row[3] || '{}'); } catch (error) { return; }
      if (verifiedBoundGroupPurchaseOrder_(order, groupId, actorId, history)) return;
      const repaired = recoverableGroupPaymentOrder_(sheets, order, groupId, actorId, history);
      if (repaired) candidates.push({ rowNumber: index + 2, order: repaired, bindingRepaired: true });
    });
  candidates.forEach(function(record) {
    const reservationId = record.order._reservationMutationId;
    if (claimed[reservationId] || candidates.filter(function(candidate) {
      return candidate.order._reservationMutationId === reservationId;
    }).length !== 1) return;
    records.push(record);
  });
  return records;
}

function groupPaymentRequiresOrder_(sheets, group, participant) {
  if (!participant || !participant.counted || Number(participant.selectedQuantity || 0) <= 0) return false;
  const deal = publicDealRecord_(sheets.publicDeals, group.dealId || group.groupId);
  // Text-only groups and free/zero-quantity hosts do not have to place orders.
  return Boolean(deal && groupBackedPublicDeal_(deal) && Number(deal.originalPrice) > 0);
}

function requireCompleteGroupPaymentQuantity_(records, participant) {
  if (!records.length) return;
  const selectedQuantity = Number(participant && participant.selectedQuantity || 0);
  const savedQuantity = records.reduce(function(total, record) {
    return total + customerOrderQuantity_(record.order);
  }, 0);
  // A participant may already have an acknowledged order while an additional
  // reservation is still being published. Do not close payment for only the
  // saved portion; publication of the remaining reservation would then fail.
  if (!Number.isInteger(selectedQuantity) || selectedQuantity <= 0
    || savedQuantity !== selectedQuantity) {
    throw groupOperationError_('order_sync_pending');
  }
}

function canonicalDealTotal_(dealValue, applyDiscount) {
  const deal = dealValue || {};
  const originalPrice = Number(deal.originalPrice);
  if (!Number.isSafeInteger(originalPrice) || originalPrice < 0) {
    throw groupOperationError_('invalid_deal_price');
  }
  if (!applyDiscount) return originalPrice;
  const discountRate = Number(deal.discountRate || 0);
  if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 100) {
    throw groupOperationError_('invalid_deal_price');
  }
  const discountedTotal = Math.max(0, Math.round(originalPrice * (1 - discountRate / 100)));
  if (!Number.isSafeInteger(discountedTotal)) throw groupOperationError_('invalid_deal_price');
  return discountedTotal;
}

function optionalSafeDealMoney_(value) {
  if (value === undefined || value === null || value === '') return true;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0;
}

function publicDealPricingError_(dealValue) {
  const deal = dealValue || {};
  const originalPrice = Number(deal.originalPrice);
  const discountRate = Number(deal.discountRate === undefined ? 0 : deal.discountRate);
  if (!Number.isSafeInteger(originalPrice) || originalPrice <= 0) return 'invalid_deal_price';
  if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 100) {
    return 'invalid_deal_price';
  }
  if (![
    deal.expectedPerPerson,
    deal.unitPrice,
    deal.unitRemainder,
    deal.splitRemainder
  ].every(optionalSafeDealMoney_)) return 'invalid_deal_price';
  if (Array.isArray(deal.menu) && deal.menu.some(function(item) {
    return !item || typeof item !== 'object' || !optionalSafeDealMoney_(item.price);
  })) return 'invalid_deal_price';
  return '';
}

function groupHostRemainder_(sheets, groupValue) {
  const group = groupValue || {};
  const deal = publicDealRecord_(sheets.publicDeals, group.dealId || group.groupId);
  if (!deal) return 0;
  const totalQuantity = Number(
    group.totalQuantity || deal.totalQuantity || deal.productQuantity || deal.target || 0
  );
  if (!Number.isInteger(totalQuantity) || totalQuantity < 1 || totalQuantity > 999) {
    throw groupOperationError_('invalid_deal_capacity');
  }
  const merchantGroup = String(deal.source || '') === 'merchant'
    && String(deal.saleType || '') === 'group';
  const discountedTotal = canonicalDealTotal_(deal, merchantGroup);
  if (!merchantGroup) return discountedTotal % totalQuantity;
  const explicitSplit = Number.isInteger(Number(deal.splitQuantity)) && Number(deal.splitQuantity) > 0
    ? Number(deal.splitQuantity)
    : (deal.splitPricing === true ? totalQuantity : 1);
  const splitQuantity = Math.max(1, Math.min(totalQuantity, Math.floor(explicitSplit)));
  return discountedTotal % splitQuantity;
}

function planHostRemainderOrders_(sheets, group, actorId, applyRemainder, mutationId, nowValue) {
  const remainder = groupHostRemainder_(sheets, group);
  const records = groupPaymentOrderRecords_(sheets, group.groupId, actorId);
  if (applyRemainder && remainder > 0 && !records.length) {
    throw groupOperationError_('host_order_required');
  }

  const now = nowValue || new Date().toISOString();
  const desiredRemainder = applyRemainder ? remainder : 0;
  if (records.some(function(record) {
    return String(record.order && record.order.paymentStatus || 'pending') !== 'pending';
  })) {
    throw groupOperationError_('host_role_payment_locked');
  }
  const changedRecords = [];
  records.forEach(function(record, index) {
    const order = Object.assign({}, record.order || {});
    const previousApplied = Math.max(0, Math.floor(Number(order.hostRemainderApplied || 0)));
    const nextApplied = index === 0 ? desiredRemainder : 0;
    if (previousApplied === nextApplied) return;
    const previousTotal = Math.max(0, Math.floor(Number(order.total || 0)));
    if (previousApplied > previousTotal) throw groupOperationError_('invalid_order_record');
    const nextTotal = previousTotal - previousApplied + nextApplied;
    const previousVersion = secureOrderVersion_(order);
    const nextVersion = previousVersion + 1;
    order.total = nextTotal;
    order.hostRemainderApplied = nextApplied;
    order.statusUpdatedAt = now;
    order.syncedAt = now;
    order.version = nextVersion;
    order.paymentVersion = nextVersion;
    order.statusHistory = (Array.isArray(order.statusHistory) ? order.statusHistory : []).concat([{
      status: String(order.status || 'new'),
      before: previousApplied,
      after: nextApplied,
      actor: String(actorId || ''),
      actorRole: applyRemainder ? 'host' : 'member',
      action: applyRemainder ? 'apply_host_remainder' : 'release_host_remainder',
      clientMutationId: String(mutationId || ''),
      version: nextVersion,
      timestamp: now
    }]).slice(-100);
    changedRecords.push({
      rowNumber: record.rowNumber,
      beforeVersion: previousVersion,
      order: order
    });
  });
  return {
    remainder: remainder,
    changedRecords: changedRecords,
    order: changedRecords.length
      ? changedRecords[0].order
      : (records.length ? records[0].order : null)
  };
}

function applyGroupPaymentStatusToOrder_(
  orderValue,
  fromStatusValue,
  toStatusValue,
  actorIdValue,
  actorRoleValue,
  mutationIdValue,
  nowValue
) {
  const order = Object.assign({}, orderValue || {});
  const before = String(order.paymentStatus || 'pending');
  const fromStatus = String(fromStatusValue || '');
  const toStatus = String(toStatusValue || '');
  const allowed = (fromStatus === 'pending' && toStatus === 'requested' && before === 'pending')
    || (fromStatus === 'requested' && toStatus === 'pending' && before === 'requested')
    || (fromStatus === 'requested' && toStatus === 'confirmed'
      && ['pending', 'requested'].includes(before))
    || (fromStatus === 'confirmed' && toStatus === 'requested' && before === 'confirmed');
  if (!allowed) return { order: order, changed: false };

  const now = nowValue || new Date().toISOString();
  const nextVersion = secureOrderVersion_(order) + 1;
  order.paymentStatus = toStatus;
  order.paymentRequestedAt = toStatus === 'pending'
    ? ''
    : (order.paymentRequestedAt || now);
  order.paymentConfirmedAt = toStatus === 'confirmed' ? now : '';
  order.statusUpdatedAt = now;
  order.syncedAt = now;
  order.version = nextVersion;
  order.paymentVersion = nextVersion;
  order.statusHistory = (Array.isArray(order.statusHistory) ? order.statusHistory : []).concat([{
    status: String(order.status || 'new'),
    before: before,
    after: toStatus,
    actor: String(actorIdValue || ''),
    actorRole: String(actorRoleValue || ''),
    action: 'sync_group_payment_status',
    clientMutationId: String(mutationIdValue || ''),
    version: nextVersion,
    timestamp: now
  }]).slice(-100);
  return { order: order, changed: true };
}

function aggregateGroupOrderPaymentStatus_(ordersValue) {
  const orders = (ordersValue || []).filter(activeGroupOrder_);
  if (!orders.length) return '';
  if (orders.every(function(order) { return String(order.paymentStatus || 'pending') === 'confirmed'; })) {
    return 'confirmed';
  }
  if (orders.some(function(order) { return String(order.paymentStatus || 'pending') === 'requested'; })) {
    return 'requested';
  }
  return 'pending';
}

function projectOrderPaymentFromParticipant_(orderValue, participantValue) {
  const order = Object.assign({}, orderValue || {});
  const participantStatus = String(participantValue && participantValue.paymentStatus || 'pending');
  const orderStatus = String(order.paymentStatus || 'pending');
  const rank = { pending: 0, requested: 1, confirmed: 2 };
  if (rank[participantStatus] === undefined || rank[orderStatus] === undefined
    || rank[participantStatus] <= rank[orderStatus]) {
    return order;
  }
  const timestamp = String(participantValue && participantValue.updatedAt || order.statusUpdatedAt || '');
  order.paymentStatus = participantStatus;
  order.paymentRequestedAt = order.paymentRequestedAt || timestamp;
  order.paymentConfirmedAt = participantStatus === 'confirmed'
    ? (order.paymentConfirmedAt || timestamp)
    : '';
  // This projection does not mutate the stored order or its CAS version, but
  // it must still carry the participant's authoritative update time. Without
  // it, a same-version browser cache can keep rendering the stale payment
  // state returned before the participant transition completed.
  order.statusUpdatedAt = timestamp || order.statusUpdatedAt || '';
  order.syncedAt = timestamp || order.syncedAt || '';
  return order;
}

function projectStoredGroupOrderPayment_(sheets, orderValue, projectionContext) {
  const order = Object.assign({}, orderValue || {});
  const groupId = String(order.groupId || '');
  const actorId = String(order.participantActorId || order.visitorId || '');
  if (!groupId || !actorId || !activeGroupOrder_(order)) return order;
  const reservationHistory = customerOrderReservationHistory_(sheets, groupId, actorId, projectionContext);
  if (!verifiedBoundGroupPurchaseOrder_(order, groupId, actorId, reservationHistory)) {
    const recovered = recoverableGroupPaymentOrder_(sheets, order, groupId, actorId, reservationHistory);
    if (!recovered) return Object.assign({}, order, { paymentSyncStatus: 'repair_required' });
    const recoveredParticipant = getParticipantRecord_(sheets, groupId, actorId, false);
    return recoveredParticipant
      ? Object.assign(projectOrderPaymentFromParticipant_(recovered, recoveredParticipant), {
          paymentSyncStatus: 'verified_history'
        })
      : order;
  }
  const participant = getParticipantRecord_(sheets, groupId, actorId, false);
  return participant ? projectOrderPaymentFromParticipant_(order, participant) : order;
}

function syncGroupPaymentOrders_(
  sheets,
  groupId,
  participantActorId,
  fromStatus,
  toStatus,
  actorId,
  actorRole,
  mutationId,
  now
) {
  const plan = planGroupPaymentOrders_(
    sheets, groupId, participantActorId, fromStatus, toStatus,
    actorId, actorRole, mutationId, now
  );
  plan.changedRecords.forEach(function(record) {
    updateCustomerOrderRecord_(sheets, record);
    try {
      appendCustomerOrderSnapshotEvent_(
        sheets.events,
        record.order,
        String(record.order._customerCapabilityHash || '')
      );
    } catch (error) {}
  });
  return {
    records: plan.records,
    changedCount: plan.changedRecords.length,
    paymentStatus: plan.paymentStatus
  };
}

function planGroupPaymentOrders_(
  sheets,
  groupId,
  participantActorId,
  fromStatus,
  toStatus,
  actorId,
  actorRole,
  mutationId,
  now,
  recoverBindings
) {
  const records = recoverBindings
    ? plannedGroupPaymentOrderRecords_(sheets, groupId, participantActorId)
    : groupPaymentOrderRecords_(sheets, groupId, participantActorId);
  const changedRecords = [];
  records.forEach(function(record) {
    const beforeVersion = secureOrderVersion_(record.order);
    // A proven legacy binding may accompany an order row that missed an old
    // participant transition. Use only that already-authoritative participant
    // state as the basis for the user's explicitly requested next/reverse step.
    const sourceOrder = record.bindingRepaired
      ? projectOrderPaymentFromParticipant_(record.order, {
          paymentStatus: fromStatus,
          updatedAt: getParticipantRecord_(sheets, groupId, participantActorId, true).updatedAt
        })
      : record.order;
    const transition = applyGroupPaymentStatusToOrder_(
      sourceOrder,
      fromStatus,
      toStatus,
      actorId,
      actorRole,
      mutationId,
      now
    );
    if (!transition.changed && !record.bindingRepaired) return;
    if (!transition.changed) {
      const nextVersion = beforeVersion + 1;
      transition.order = Object.assign({}, transition.order, {
        version: nextVersion, paymentVersion: nextVersion,
        syncedAt: now,
        statusHistory: (Array.isArray(transition.order.statusHistory)
          ? transition.order.statusHistory : []).concat([{
          action: 'repair_group_order_binding', actor: actorId, actorRole: actorRole,
          clientMutationId: mutationId, version: nextVersion, timestamp: now
        }]).slice(-100)
      });
    }
    record.order = transition.order;
    record.beforeVersion = beforeVersion;
    if (JSON.stringify(record.order).length > 30000) throw groupOperationError_('order_too_large');
    changedRecords.push(record);
  });
  return {
    records: records,
    changedRecords: changedRecords,
    paymentStatus: aggregateGroupOrderPaymentStatus_(records.map(function(record) { return record.order; }))
  };
}

function syncParticipantPaymentFromOrders_(
  sheets,
  groupIdValue,
  actorIdValue,
  managerActorId,
  managerRole,
  mutationId,
  nowValue
) {
  const groupId = String(groupIdValue || '');
  const actorId = String(actorIdValue || '');
  if (!groupId || !actorId) return { changed: false, paymentStatus: '' };
  const records = groupPaymentOrderRecords_(sheets, groupId, actorId);
  const paymentStatus = aggregateGroupOrderPaymentStatus_(records.map(function(record) { return record.order; }));
  if (!paymentStatus) return { changed: false, paymentStatus: '' };
  const participant = getParticipantRecord_(sheets, groupId, actorId, true);
  if (!participant || participant.paymentStatus === paymentStatus) {
    return { changed: false, paymentStatus: paymentStatus };
  }

  const previous = participant.paymentStatus;
  participant.paymentStatus = paymentStatus;
  participant.version += 1;
  participant.updatedAt = nowValue || new Date().toISOString();
  updateParticipantRow_(sheets, participant);
  appendGroupHistory_(sheets, {
    groupId: groupId,
    entityType: 'payment',
    entityId: actorId,
    fromStatus: previous,
    toStatus: paymentStatus,
    action: 'sync_order_payment_status',
    actorId: String(managerActorId || ''),
    actorRole: String(managerRole || ''),
    clientMutationId: String(mutationId || ''),
    version: participant.version,
    createdAt: participant.updatedAt
  });
  return { changed: true, paymentStatus: paymentStatus };
}

function planParticipantPaymentFromManagedOrder_(
  sheets,
  groupIdValue,
  actorIdValue,
  managedOrder,
  nowValue
) {
  const groupId = String(groupIdValue || '');
  const actorId = String(actorIdValue || '');
  if (!groupId || !actorId || !managedOrder) return null;
  // Use the same verified legacy-binding projection as the read and direct
  // participant-payment paths. manageCustomerOrder_ has not written the
  // repaired private reservation fields yet, so re-reading only the stored
  // rows here would omit that order and leave the chat participant stale.
  const records = plannedGroupPaymentOrderRecords_(sheets, groupId, actorId);
  const orders = records.map(function(record) {
    return String(record.order && record.order.id || '') === String(managedOrder.id || '')
      ? managedOrder
      : record.order;
  });
  const paymentStatus = aggregateGroupOrderPaymentStatus_(orders);
  if (!paymentStatus) return null;
  const participant = getParticipantRecord_(sheets, groupId, actorId, true);
  if (!participant || String(participant.paymentStatus || 'pending') === paymentStatus) return null;
  const beforeVersion = Number(participant.version || 0);
  participant.paymentStatus = paymentStatus;
  participant.version = beforeVersion + 1;
  participant.updatedAt = nowValue || new Date().toISOString();
  return { participant: participant, beforeVersion: beforeVersion };
}

function requireMerchantGroupPaymentRequest_(order, deal, kindValue, directionValue) {
  if (String(kindValue || '') !== 'payment_status' || String(directionValue || '') !== 'next') {
    return true;
  }
  const merchantGroup = String(deal && deal.source || '') === 'merchant'
    && Boolean(String(order && order.groupId || ''))
    && String(order && order.groupId || '') === String(deal && deal.id || '');
  if (merchantGroup && String(order && order.paymentStatus || 'pending') !== 'requested') {
    throw groupOperationError_('payment_request_required');
  }
  return true;
}

function customerOrderQuantity_(order) {
  const value = Number(order && (order.selectedCount || order.quantity || 0));
  return Number.isInteger(value) && value > 0 && value <= 999 ? value : 0;
}

function merchantCapacityError_(totalQuantityValue, allocatedQuantityValue, selectedQuantityValue) {
  const totalQuantity = Number(totalQuantityValue);
  const allocatedQuantity = Number(allocatedQuantityValue);
  const selectedQuantity = Number(selectedQuantityValue);
  if (!Number.isInteger(totalQuantity) || totalQuantity < 1 || totalQuantity > 999) {
    return 'invalid_deal_capacity';
  }
  if (!Number.isInteger(selectedQuantity) || selectedQuantity < 1 || selectedQuantity > 999) {
    return 'invalid_order_quantity';
  }
  if (!Number.isInteger(allocatedQuantity) || allocatedQuantity < 0) {
    return 'invalid_deal_capacity';
  }
  return allocatedQuantity + selectedQuantity > totalQuantity ? 'quantity_unavailable' : '';
}

function merchantCapacityFloorError_(totalQuantityValue, allocatedQuantityValue) {
  const totalQuantity = Number(totalQuantityValue);
  const allocatedQuantity = Number(allocatedQuantityValue);
  if (!Number.isInteger(totalQuantity) || totalQuantity < 1 || totalQuantity > 999) {
    return 'invalid_deal_capacity';
  }
  if (!Number.isInteger(allocatedQuantity) || allocatedQuantity < 0) {
    return 'invalid_deal_capacity';
  }
  return totalQuantity < allocatedQuantity ? 'quantity_below_active_allocations' : '';
}

function activeMerchantAllocation_(sheets, dealId, excludedOrderId) {
  return storedCustomerOrders_(sheets.customerOrders).reduce(function(total, order) {
    if (String(order.id || '') === String(excludedOrderId || '')) return total;
    if (customerOrderDealId_(order) !== String(dealId || '')) return total;
    if (!activePurchaseOrder_(order)) return total;
    return total + customerOrderQuantity_(order);
  }, 0);
}

function activeMerchantActorAllocation_(sheets, dealId, actorId) {
  return storedCustomerOrders_(sheets.customerOrders).reduce(function(total, order) {
    if (customerOrderDealId_(order) !== String(dealId || '')) return total;
    if (String(order.participantActorId || order.visitorId || '') !== String(actorId || '')) return total;
    if (!activePurchaseOrder_(order)) return total;
    return total + customerOrderQuantity_(order);
  }, 0);
}

function activeMerchantAllocationsByActor_(sheets, dealId) {
  return storedCustomerOrders_(sheets.customerOrders).reduce(function(result, order) {
    if (customerOrderDealId_(order) !== String(dealId || '') || !activePurchaseOrder_(order)) {
      return result;
    }
    const actorId = String(order.participantActorId || order.visitorId || '');
    const quantity = customerOrderQuantity_(order);
    if (!quantity) return result;
    result.total += quantity;
    if (!actorId) return result;
    result.byActor[actorId] = Number(result.byActor[actorId] || 0) + quantity;
    return result;
  }, { total: 0, byActor: Object.create(null) });
}

function merchantGroupCapacityUsage_(participantsValue, allocationsValue) {
  const participants = Array.isArray(participantsValue) ? participantsValue : [];
  const allocations = allocationsValue && typeof allocationsValue === 'object'
    ? allocationsValue
    : {};
  const activeByActor = allocations.byActor && typeof allocations.byActor === 'object'
    ? allocations.byActor
    : Object.create(null);
  const actors = Object.create(null);
  const capacityQuantity = function(value) {
    const quantity = Number(value);
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
  };
  let unattributedParticipantQuantity = 0;
  let unattributedParticipantCount = 0;

  participants.forEach(function(participant) {
    if (!participant || !participant.counted) return;
    const quantity = capacityQuantity(participant.selectedQuantity);
    const actorId = String(participant.actorId || '');
    if (!actorId) {
      unattributedParticipantQuantity += quantity;
      unattributedParticipantCount += 1;
      return;
    }
    if (!actors[actorId]) {
      actors[actorId] = { participantQuantity: 0, activeOrderQuantity: 0 };
    }
    actors[actorId].participantQuantity += quantity;
  });

  let attributedActiveQuantity = 0;
  Object.keys(activeByActor).forEach(function(actorId) {
    const quantity = capacityQuantity(activeByActor[actorId]);
    if (!quantity) return;
    attributedActiveQuantity += quantity;
    if (!actors[actorId]) {
      actors[actorId] = { participantQuantity: 0, activeOrderQuantity: 0 };
    }
    actors[actorId].activeOrderQuantity += quantity;
  });

  const byActor = Object.create(null);
  let quantity = unattributedParticipantQuantity;
  let participantCount = unattributedParticipantCount;
  Object.keys(actors).forEach(function(actorId) {
    const actorQuantity = Math.max(
      actors[actorId].participantQuantity,
      actors[actorId].activeOrderQuantity
    );
    byActor[actorId] = actorQuantity;
    quantity += actorQuantity;
    participantCount += 1;
  });

  // Older rows are expected to have an actor id, but keep actor-less orders
  // reserved conservatively instead of dropping them from the stock floor.
  const unattributedActiveQuantity = Math.max(
    0,
    capacityQuantity(allocations.total) - attributedActiveQuantity
  );
  if (unattributedActiveQuantity > 0) {
    quantity += unattributedActiveQuantity;
    participantCount += 1;
  }

  return {
    quantity: quantity,
    participantCount: participantCount,
    byActor: byActor,
    actors: actors
  };
}

function reconcileMerchantGroupParticipants_(participants, allocations) {
  const activeByActor = allocations && allocations.byActor ? allocations.byActor : Object.create(null);
  return (participants || []).map(function(participant) {
    const copy = Object.assign({}, participant);
    const activeQuantity = Math.max(0, Number(activeByActor[String(copy.actorId || '')] || 0));
    copy.selectedQuantity = Math.max(0, Number(copy.selectedQuantity || 0), activeQuantity);
    if (copy.counted && copy.role === 'member' && copy.selectedQuantity <= 0) {
      copy.counted = false;
    }
    return copy;
  });
}

function merchantGroupPublishPlan_(deal, group, participants, allocations, nowValue) {
  if (!group) return { ok: true, changed: false, group: null };
  const totalQuantity = Number(deal.totalQuantity || deal.productQuantity || deal.target || 0);
  if (!Number.isInteger(totalQuantity) || totalQuantity < 1 || totalQuantity > 999) {
    return { ok: false, error: 'invalid_deal_capacity' };
  }
  const capacityUsage = merchantGroupCapacityUsage_(participants, allocations);
  const minimumQuantity = capacityUsage.quantity;
  if (totalQuantity < minimumQuantity) {
    return {
      ok: false,
      error: 'quantity_below_active_allocations',
      minimumQuantity: minimumQuantity
    };
  }
  const currentCount = capacityUsage.participantCount;
  const targetCount = Number(
    deal.targetCount !== undefined
      ? deal.targetCount
      : deal.targetPeople !== undefined
        ? deal.targetPeople
        : group.targetCount
  );
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > GROUP_MAX_PARTICIPANTS) {
    return { ok: false, error: 'invalid_target' };
  }
  if (targetCount < currentCount) {
    return {
      ok: false,
      error: 'target_below_current',
      minimumTarget: currentCount
    };
  }
  const changed = totalQuantity !== Number(group.totalQuantity || 0)
    || targetCount !== Number(group.targetCount || 0);
  if (!changed) return { ok: true, changed: false, group: group };
  return {
    ok: true,
    changed: true,
    group: Object.assign({}, group, {
      totalQuantity: totalQuantity,
      targetCount: targetCount,
      version: Number(group.version || 0) + 1,
      updatedAt: nowValue || new Date().toISOString(),
      updatedBy: groupText_(deal.updatedBy, 128) || ('merchant-' + String(deal.id || ''))
    })
  };
}

function writePublicDealRecord_(sheet, rowNumber, deal) {
  const serialized = JSON.stringify(deal || {});
  if (serialized.length > 45000) throw groupOperationError_('deal_too_large');
  sheet.getRange(rowNumber, 1, 1, PUBLIC_DEAL_HEADERS.length).setValues([[
    new Date(), safeCell_(deal.id), safeCell_(deal.source || ''),
    safeCell_(deal.region || ''), safeCell_(deal.district || ''),
    safeCell_(deal.neighborhood || ''), serialized
  ]]);
}

// Product JPEGs must not be squeezed into the deal JSON's single-cell budget.
// Immutable content-addressed chunks use the existing private spreadsheet only.
const PRODUCT_IMAGE_LIMIT_ = 1500000;
const PRODUCT_IMAGE_CHUNK_SIZE_ = 40000;
const PRODUCT_IMAGE_CHUNKS_ = Math.ceil(PRODUCT_IMAGE_LIMIT_ / PRODUCT_IMAGE_CHUNK_SIZE_);
const PRODUCT_IMAGE_SHEET_ = '상품 이미지';

function productImageSheet_(create) {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = spreadsheet.getSheetByName(PRODUCT_IMAGE_SHEET_);
  if (!sheet && create) sheet = spreadsheet.insertSheet(PRODUCT_IMAGE_SHEET_);
  if (sheet && create) {
    const columns = 4 + PRODUCT_IMAGE_CHUNKS_;
    if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
    if (sheet.getLastRow() === 0) {
      const headers = ['이미지ID', '문자수', '조각수', '생성시각'];
      for (let index = 0; index < PRODUCT_IMAGE_CHUNKS_; index += 1) headers.push('이미지조각' + (index + 1));
      sheet.getRange(1, 1, 1, columns).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function readPublicImage_(imageIdValue) {
  const imageId = String(imageIdValue || '');
  if (!/^[a-f0-9]{64}$/.test(imageId)) throw groupOperationError_('invalid_image_id');
  const sheet = productImageSheet_(false);
  const row = sheet ? findExactRow_(sheet, 1, 'img_' + imageId) : 0;
  if (!row) throw groupOperationError_('image_not_found');
  const metadata = sheet.getRange(row, 2, 1, 2).getValues()[0];
  const length = Number(metadata[0]);
  const count = Number(metadata[1]);
  if (!Number.isInteger(length) || length < 30 || length > PRODUCT_IMAGE_LIMIT_
      || count !== Math.ceil(length / PRODUCT_IMAGE_CHUNK_SIZE_)) {
    throw groupOperationError_('image_integrity_failed');
  }
  const chunks = sheet.getRange(row, 5, 1, count).getValues()[0];
  const image = chunks.map(function(chunk) {
    if (typeof chunk !== 'string' || chunk.charAt(0) !== '~') throw groupOperationError_('image_integrity_failed');
    return chunk.slice(1);
  }).join('');
  if (image.length !== length || sha256Hex_(image) !== imageId) throw groupOperationError_('image_integrity_failed');
  return image;
}

// Called only inside the publication lock, after owner/version/capacity checks.
function storePublicImage_(imageValue) {
  const image = String(imageValue || '');
  if (!image.startsWith('data:')) return image;
  if (image.length > PRODUCT_IMAGE_LIMIT_ || !/^data:image\/jpeg;base64,\/9j\/[a-zA-Z0-9+/]*={0,2}$/.test(image)) {
    throw groupOperationError_('invalid_deal_image');
  }
  // Keep old clients/old API deployments compatible during rollout. Only large
  // JPEGs need separate storage; small/legacy images remain valid inline.
  if (image.length <= 40000) return image;
  const imageId = sha256Hex_(image);
  const sheet = productImageSheet_(true);
  const existingRow = findExactRow_(sheet, 1, 'img_' + imageId);
  if (existingRow) {
    // Fail closed on incomplete storage instead of publishing a broken reference.
    readPublicImage_(imageId);
  } else {
    const count = Math.ceil(image.length / PRODUCT_IMAGE_CHUNK_SIZE_);
    const values = ['img_' + imageId, image.length, count, new Date().toISOString()];
    for (let index = 0; index < count; index += 1) {
      // Prefix keeps even a chunk starting with '=' from becoming a formula.
      values.push('~' + image.slice(index * PRODUCT_IMAGE_CHUNK_SIZE_, (index + 1) * PRODUCT_IMAGE_CHUNK_SIZE_));
    }
    const nextRow = sheet.getLastRow() + 1;
    if (nextRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 100);
    sheet.getRange(nextRow, 1, 1, values.length).setValues([values]);
  }
  return '/api/public-deals?image=' + imageId;
}

function repairPendingMerchantDealPublish_(sheets, dealIdValue) {
  const dealId = String(dealIdValue || '');
  const sheet = sheets && sheets.publicDeals;
  if (!sheet || typeof sheet.getLastRow !== 'function' || sheet.getLastRow() < 2) return null;
  const rowNumber = findExactRow_(sheet, 2, dealId);
  if (!rowNumber) return null;
  const deal = publicDealRecord_(sheet, dealId);
  if (!deal || deal._groupPublishPending !== true) return deal;
  const repair = deal._groupPublishRepair;
  const target = repair && repair.target;
  if (!target || String(target.groupId || '') !== dealId) {
    throw groupOperationError_('invalid_mutation_intent');
  }
  const operationType = repair.type === 'group_append' ? 'group_append' : 'group_update';
  const existingRow = findExactRow_(sheets.groups, 1, dealId);
  const current = existingRow ? getGroupRecord_(sheets, dealId) : null;
  const participants = getParticipantsForGroup_(sheets, dealId, false);
  const allocations = activeMerchantAllocationsByActor_(sheets, dealId);
  const capacity = merchantGroupCapacityUsage_(participants, allocations);
  if (Number(target.totalQuantity || 0) < capacity.quantity
    || Number(target.targetCount || 0) < capacity.participantCount) {
    throw groupOperationError_('deal_update_pending');
  }
  if (operationType === 'group_append') {
    applyGroupRepairOperation_(sheets, { type: 'group_append', target: target });
  } else {
    if (!current) throw groupOperationError_('state_conflict');
    if (Number(current.version || 0) === Number(target.version || 0)) {
      if (!mutationRecordMatches_(current, target, [
        'groupId', 'dealId', 'targetCount', 'totalQuantity', 'version'
      ])) throw groupOperationError_('state_conflict');
    } else {
    if (Number(current.version || 0) !== Number(repair.beforeVersion || 0)) {
      throw groupOperationError_('state_conflict');
    }
    updateGroupRow_(sheets, Object.assign({}, target, { rowNumber: current.rowNumber }));
    }
  }
  const completed = Object.assign({}, deal);
  delete completed._groupPublishPending;
  delete completed._groupPublishRepair;
  writePublicDealRecord_(sheet, rowNumber, completed);
  invalidateGroupSnapshot_(dealId);
  invalidatePublicDealsCache_();
  return completed;
}

function hasActiveBoundGroupOrder_(sheets, groupId, actorId) {
  return storedCustomerOrders_(sheets.customerOrders).some(function(order) {
    return activePurchaseOrder_(order)
      && String(order.groupId || '') === String(groupId || '')
      && String(order.participantActorId || order.visitorId || '') === String(actorId || '')
      && ['join', 'reserve_quantity'].includes(String(order._reservationAction || ''))
      && Boolean(String(order._reservationMutationId || ''))
      && Number.isInteger(Number(order._reservationQuantity || 0))
      && Number(order._reservationQuantity || 0) > 0;
  });
}

function requireHostClaimEligibility_(sheets, participant, groupId, actorId) {
  if (!participant || !participant.counted
    || !['creator', 'member', 'host'].includes(String(participant.role || ''))) {
    throw groupOperationError_('forbidden');
  }
  if (participant.role === 'member' && !hasActiveBoundGroupOrder_(sheets, groupId, actorId)) {
    throw groupOperationError_('host_order_required');
  }
  return true;
}

function publicDealRecord_(sheet, dealId) {
  if (!sheet || sheet.getLastRow() < 2) return null;
  const match = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(dealId || '')).matchEntireCell(true).findNext();
  if (!match) return null;
  try {
    const deal = JSON.parse(sheet.getRange(match.getRow(), 7).getValue() || '{}');
    return deal && typeof deal === 'object' && !Array.isArray(deal) ? deal : null;
  } catch (error) {
    return null;
  }
}

function activePublicDealRecord_(sheet, dealId) {
  const deal = publicDealRecord_(sheet, dealId);
  return deal && String(deal.visibility || '') === 'public' ? deal : null;
}

function latestPublicDealValues_(sheet, limitValue) {
  const limit = Math.max(1, Math.min(500, Number(limitValue || 500)));
  const deals = [];
  let endRow = sheet.getLastRow();
  while (endRow >= 2 && deals.length < limit) {
    const startRow = Math.max(2, endRow - 499);
    const rows = sheet.getRange(startRow, 7, endRow - startRow + 1, 1).getValues();
    for (let index = rows.length - 1; index >= 0 && deals.length < limit; index -= 1) {
      try {
        const deal = JSON.parse(rows[index][0] || '{}');
        if (deal && deal.id && String(deal.visibility || '') === 'public') {
          deals.push(publicDealValue_(deal));
        }
      } catch (error) {}
    }
    endRow = startRow - 1;
  }
  return deals;
}

function publishPublicDeal_(deal, ownerCapabilityHash) {
  if (!deal.id || !/^(owner|customer)-[a-zA-Z0-9-]{1,100}$/.test(String(deal.id))) {
    return json_({ ok: false, error: 'invalid_deal_id' });
  }
  if (String(deal.source || '') === 'customer' && String(deal.groupId || '') !== String(deal.id)) {
    return json_({ ok: false, error: 'invalid_group_deal_binding' });
  }
  if (String(deal.source || '') === 'merchant' && String(deal.saleType || '') === 'group'
    && deal.groupId && String(deal.groupId) !== String(deal.id)) {
    return json_({ ok: false, error: 'invalid_group_deal_binding' });
  }
  const pricingError = publicDealPricingError_(deal);
  if (pricingError) return json_({ ok: false, error: pricingError });
  let incomingHash;
  let publishMutationId;
  let publishMutationContract;
  try {
    incomingHash = privateCapabilityHash_(ownerCapabilityHash, 'invalid_owner_capability');
    publishMutationId = publicDealPublishMutationId_(deal);
    publishMutationContract = publicDealPublishContract_(deal);
  } catch (error) {
    return json_({ ok: false, error: error.code || 'invalid_deal_publish' });
  }

  const lock = acquireScriptLock_();
  try {
    const sheets = ensureSheets_();
    const sheet = sheets.publicDeals;
    let targetRow = sheet.getLastRow() + 1;
    let existingDeal = null;
    if (sheet.getLastRow() >= 2) {
      const match = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
        .createTextFinder(String(deal.id)).matchEntireCell(true).findNext();
      if (match) {
        targetRow = match.getRow();
        try {
          existingDeal = JSON.parse(sheet.getRange(targetRow, 7).getValue() || '{}');
        } catch (error) {
          existingDeal = {};
        }
        if (!existingDeal || typeof existingDeal !== 'object' || Array.isArray(existingDeal)) {
          existingDeal = {};
        }
      }
    }
    let idempotentPublishReplay = false;
    if (existingDeal) {
      const existingHash = String(existingDeal._ownerCapabilityHash || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(existingHash)) {
        return json_({ ok: false, error: 'deal_ownership_unclaimable' });
      }
      if (existingHash !== incomingHash) return json_({ ok: false, error: 'forbidden' });
      if (String(existingDeal.visibility || '') === 'deleted') {
        return json_({ ok: false, error: 'deal_deleted' });
      }
      if (String(existingDeal._lastDealPublishMutationId || '') === publishMutationId) {
        if (!publicDealPublishContractMatches_(
          existingDeal._lastDealPublishMutationContract,
          publishMutationContract
        )) {
          return json_({ ok: false, error: 'client_mutation_conflict' });
        }
        idempotentPublishReplay = true;
      }
    }
    const currentPublishVersion = existingDeal
      ? Math.max(0, Math.floor(Number(existingDeal.publishVersion || 0)))
      : 0;
    if (idempotentPublishReplay && existingDeal._groupPublishPending === true) {
      existingDeal = repairPendingMerchantDealPublish_(sheets, String(deal.id));
      return json_({ ok: true, deal: publicDealValue_(existingDeal) });
    }
    if (idempotentPublishReplay) {
      return json_({ ok: true, deal: publicDealValue_(existingDeal) });
    }
    const expectedPublishVersion = Number(deal.expectedPublishVersion);
    if (!idempotentPublishReplay && (!Number.isSafeInteger(expectedPublishVersion)
      || expectedPublishVersion < 0
      || expectedPublishVersion !== currentPublishVersion)) {
      return json_({
        ok: false,
        error: 'state_conflict',
        currentPublishVersion: currentPublishVersion
      });
    }
    const existingMerchantGroup = existingDeal
      && String(existingDeal.source || '') === 'merchant'
      && String(existingDeal.saleType || '') === 'group';
    const incomingMerchantGroup = String(deal.source || '') === 'merchant'
      && String(deal.saleType || '') === 'group';
    const activeMerchantAllocations = activeMerchantAllocationsByActor_(sheets, deal.id);
    const existingMerchantParticipants = existingMerchantGroup
      && findExactRow_(sheets.groups, 1, String(deal.id))
      ? getParticipantsForGroup_(sheets, String(deal.id), false)
      : [];
    const activeMerchantCapacity = merchantGroupCapacityUsage_(
      existingMerchantParticipants,
      activeMerchantAllocations
    );
    const activeAllocation = activeMerchantCapacity.quantity;
    if (existingMerchantGroup
      && (activeAllocation > 0 || activeMerchantCapacity.participantCount > 0)
      && !incomingMerchantGroup) {
      return json_({ ok: false, error: 'active_allocations_require_group_sale' });
    }
    let incomingMerchantTargetCount = 0;
    let incomingMerchantTotalQuantity = 0;
    if (incomingMerchantGroup) {
      const totalQuantity = Number(deal.totalQuantity || deal.productQuantity || deal.target || 0);
      const capacityFloorError = merchantCapacityFloorError_(totalQuantity, activeAllocation);
      if (capacityFloorError) {
        return json_({
          ok: false,
          error: capacityFloorError,
          minimumQuantity: activeAllocation
        });
      }
      incomingMerchantTargetCount = Number(
        deal.targetCount !== undefined
          ? deal.targetCount
          : deal.targetPeople !== undefined
            ? deal.targetPeople
            : Math.min(GROUP_MAX_PARTICIPANTS, totalQuantity)
      );
      if (!Number.isInteger(incomingMerchantTargetCount)
        || incomingMerchantTargetCount < 1
        || incomingMerchantTargetCount > GROUP_MAX_PARTICIPANTS) {
        return json_({ ok: false, error: 'invalid_target' });
      }
      if (incomingMerchantTargetCount < activeMerchantCapacity.participantCount) {
        return json_({
          ok: false,
          error: 'target_below_current',
          minimumTarget: activeMerchantCapacity.participantCount
        });
      }
      incomingMerchantTotalQuantity = totalQuantity;
    }
    const normalizedDeal = incomingMerchantGroup
      ? Object.assign({}, deal, {
          target: incomingMerchantTotalQuantity,
          totalQuantity: incomingMerchantTotalQuantity,
          productQuantity: incomingMerchantTotalQuantity,
          targetCount: incomingMerchantTargetCount
        })
      : deal;
    const publishNow = new Date().toISOString();
    let merchantGroupPlan = { ok: true, changed: false, group: null, operation: null };
    if (incomingMerchantGroup) {
      if (findExactRow_(sheets.groups, 1, String(deal.id))) {
        const existingGroup = getGroupRecord_(sheets, String(deal.id));
        const groupParticipants = getParticipantsForGroup_(sheets, String(deal.id), false);
        merchantGroupPlan = merchantGroupPublishPlan_(
          normalizedDeal,
          existingGroup,
          groupParticipants,
          activeMerchantAllocations,
          publishNow
        );
        if (!merchantGroupPlan.ok) {
          return json_({
            ok: false,
            error: merchantGroupPlan.error,
            minimumQuantity: merchantGroupPlan.minimumQuantity,
            minimumTarget: merchantGroupPlan.minimumTarget
          });
        }
        if (merchantGroupPlan.changed) {
          merchantGroupPlan.operation = {
            type: 'group_update',
            beforeVersion: Number(merchantGroupPlan.group.version || 1) - 1,
            target: plainMutationRecord_(merchantGroupPlan.group)
          };
        }
      } else {
        const merchantSeed = merchantGroupSeed_(normalizedDeal, String(deal.id));
        if (!merchantSeed) return json_({ ok: false, error: 'invalid_deal_capacity' });
        merchantGroupPlan = {
          ok: true,
          changed: true,
          group: {
            groupId: merchantSeed.groupId,
            dealId: merchantSeed.dealId,
            title: merchantSeed.title,
            groupStatus: GROUP_STATUSES[0],
            targetCount: merchantSeed.targetCount,
            chatLocked: false,
            hostActorId: '',
            lastMessageSeq: 0,
            version: 1,
            createdAt: publishNow,
            updatedAt: publishNow,
            updatedBy: merchantSeed.creatorActorId,
            creatorActorId: merchantSeed.creatorActorId,
            hostMode: 'recruiting',
            totalQuantity: merchantSeed.totalQuantity
          }
        };
        merchantGroupPlan.operation = {
          type: 'group_append',
          target: plainMutationRecord_(merchantGroupPlan.group)
        };
      }
    }
    const storedDeal = Object.assign({}, normalizedDeal, {
      image: storePublicImage_(normalizedDeal.image),
      visibility: 'public',
      syncedAt: publishNow,
      publishVersion: currentPublishVersion + 1,
      _ownerCapabilityHash: incomingHash,
      _lastDealPublishMutationId: publishMutationId,
      _lastDealPublishMutationContract: publishMutationContract
    });
    if (merchantGroupPlan.changed) {
      storedDeal._groupPublishPending = true;
      storedDeal._groupPublishRepair = merchantGroupPlan.operation;
    }
    delete storedDeal.expectedPublishVersion;
    delete storedDeal.publishMutationId;
    try {
      writePublicDealRecord_(sheet, targetRow, storedDeal);
    } catch (error) {
      if (error && error.code) return json_({ ok: false, error: error.code });
      throw error;
    }
    if (merchantGroupPlan.changed) {
      applyGroupRepairOperation_(sheets, merchantGroupPlan.operation);
      invalidateGroupSnapshot_(String(deal.id));
      delete storedDeal._groupPublishPending;
      delete storedDeal._groupPublishRepair;
      writePublicDealRecord_(sheet, targetRow, storedDeal);
    }
    invalidatePublicDealsCache_();
    return json_({ ok: true, deal: publicDealValue_(storedDeal) });
  } finally {
    lock.releaseLock();
  }
}

function getPublicDeals_() {
  const cached = cachedPublicDeals_();
  if (cached) return cached;
  const sheets = ensureSheets_();
  const sheet = sheets.publicDeals;
  if (sheet.getLastRow() < 2) return [];
  const deals = latestPublicDealValues_(sheet, 500);

  const groupsById = Object.create(null);
  if (sheets.groups.getLastRow() >= 2) {
    sheets.groups.getRange(2, 1, sheets.groups.getLastRow() - 1, GROUP_HEADERS.length)
      .getValues()
      .forEach(function(row, index) {
        const group = groupFromRow_(row, index + 2);
        if (group) groupsById[group.groupId] = group;
      });
  }
  const countedByGroup = Object.create(null);
  const orderedByGroup = Object.create(null);
  const participantsByGroup = Object.create(null);
  if (sheets.groupParticipants.getLastRow() >= 2) {
    sheets.groupParticipants.getRange(2, 1, sheets.groupParticipants.getLastRow() - 1, GROUP_PARTICIPANT_HEADERS.length)
      .getValues()
      .forEach(function(row, index) {
        const participant = participantFromRow_(row, index + 2, false);
        const groupId = participant ? participant.groupId : '';
        if (groupId) {
          if (!participantsByGroup[groupId]) participantsByGroup[groupId] = [];
          participantsByGroup[groupId].push(participant);
        }
        if (groupId && participant.counted) {
          countedByGroup[groupId] = Number(countedByGroup[groupId] || 0) + 1;
          orderedByGroup[groupId] = Number(orderedByGroup[groupId] || 0)
            + Number(participant.selectedQuantity || 0);
        }
      });
  }

  const storedOrders = [];
  if (sheets.customerOrders.getLastRow() >= 2) {
    sheets.customerOrders.getRange(2, 4, sheets.customerOrders.getLastRow() - 1, 1)
      .getValues()
      .forEach(function(row) {
        try {
          const order = JSON.parse(row[0] || '{}');
          if (/^[a-f0-9]{64}$/.test(String(order._customerCapabilityHash || '').toLowerCase())) {
            storedOrders.push(order);
          }
        } catch (error) {}
      });
  }
  const merchantProgressByDeal = Object.create(null);
  mergeCustomerOrderSnapshots_(storedOrders).forEach(function(order) {
    if (String(order.type || '') !== 'purchase') return;
    if (String(order.status || '') === 'cancelled' || String(order.paymentStatus || '') === 'cancelled') return;
    const dealId = String(order.dealId || (order.deal && order.deal.id) || '');
    const actorId = String(order.participantActorId || order.visitorId || '');
    if (!dealId) return;
    if (!merchantProgressByDeal[dealId]) {
      merchantProgressByDeal[dealId] = { total: 0, byActor: Object.create(null) };
    }
    const rawQuantity = Number(order.selectedCount || order.quantity || 1);
    const quantity = Number.isFinite(rawQuantity) ? Math.max(1, Math.floor(rawQuantity)) : 1;
    merchantProgressByDeal[dealId].total += quantity;
    if (actorId) {
      merchantProgressByDeal[dealId].byActor[actorId]
        = Number(merchantProgressByDeal[dealId].byActor[actorId] || 0) + quantity;
    }
  });

  const result = deals
    .map(function(deal) {
      if (deal.source !== 'customer') {
        const merchantGroupId = String(deal.id || '');
        const progress = merchantProgressByDeal[merchantGroupId] || {
          total: 0,
          byActor: Object.create(null)
        };
        const capacityUsage = merchantGroupCapacityUsage_(
          participantsByGroup[merchantGroupId] || [],
          progress
        );
        const target = Math.max(1, Number(
          deal.totalQuantity || deal.productQuantity || deal.target || 1
        ));
        const current = Math.min(target, Math.max(0, Number(capacityUsage.quantity || 0)));
        const participantCount = capacityUsage.participantCount;
        const merchantGroup = groupsById[merchantGroupId];
        return Object.assign({}, deal, {
          groupId: String(deal.saleType || '') === 'group' ? merchantGroupId : '',
          current: current,
          currentCount: participantCount,
          currentPeople: participantCount,
          orderedQuantity: current,
          allocatedProductQuantity: current,
          participantCount: participantCount,
          quantityTracking: true,
          groupStatus: merchantGroup ? merchantGroup.groupStatus : (deal.groupStatus || 'recruiting'),
          chatLocked: merchantGroup ? merchantGroup.chatLocked : Boolean(deal.chatLocked),
          creatorActorId: merchantGroup ? merchantGroup.creatorActorId : (deal.creatorActorId || ''),
          hostMode: merchantGroup ? merchantGroup.hostMode : 'recruiting',
          hostActorId: merchantGroup ? merchantGroup.hostActorId : (deal.hostActorId || ''),
          hostMatched: Boolean(merchantGroup ? merchantGroup.hostActorId : deal.hostActorId),
          lastMessageSeq: merchantGroup ? merchantGroup.lastMessageSeq : Number(deal.lastMessageSeq || 0),
          version: merchantGroup ? merchantGroup.version : Number(deal.version || 1),
          stateVersion: merchantGroup ? merchantGroup.version : Number(deal.stateVersion || deal.version || 1),
          updatedAt: merchantGroup ? (merchantGroup.updatedAt || deal.updatedAt) : deal.updatedAt
        });
      }
      const groupId = String(deal.id || '');
      const group = groupsById[groupId];
      if (!group) return deal;
      const currentCount = Number(countedByGroup[groupId] || 0);
      return Object.assign({}, deal, {
        groupId: groupId,
        target: group.targetCount,
        targetCount: group.targetCount,
        current: currentCount,
        currentCount: currentCount,
        participantCount: currentCount,
        groupStatus: group.groupStatus,
        chatLocked: group.chatLocked,
        creatorActorId: group.creatorActorId,
        hostMode: group.hostMode,
        hostActorId: group.hostActorId,
        hostMatched: Boolean(group.hostActorId),
        totalQuantity: group.totalQuantity,
        orderedQuantity: Number(orderedByGroup[groupId] || 0),
        version: group.version,
        stateVersion: group.version,
        lastMessageSeq: group.lastMessageSeq,
        updatedAt: group.updatedAt || deal.updatedAt
      });
    })
    .sort(function(a, b) {
      return String(b.syncedAt || '').localeCompare(String(a.syncedAt || ''));
    });
  cachePublicDeals_(result);
  return result;
}

// Minimal deletion markers prevent another browser's cached registration from
// resurrecting a removed listing. Never expose the retained private record.
function getDeletedDealMarkers_() {
  const sheet = ensureSheets_().publicDeals;
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).getValues().flatMap(function(row) {
    try {
      const deal = JSON.parse(row[0]);
      return deal.visibility === 'deleted' ? [{ id: deal.id, visibility: 'deleted',
        syncedAt: deal.syncedAt || deal.deletedAt, publishVersion: deal.publishVersion || 0 }] : [];
    } catch (ignored) { return []; }
  });
}

function deletePublicDeal_(dealId, ownerCapabilityHash, expectedPublishVersionValue, clientMutationIdValue) {
  if (!/^(owner|customer)-[a-zA-Z0-9-]{1,100}$/.test(String(dealId))) {
    return json_({ ok: false, error: 'invalid_deal_id' });
  }
  let incomingHash;
  const expectedPublishVersion = Number(expectedPublishVersionValue);
  const clientMutationId = String(clientMutationIdValue || '');
  try {
    incomingHash = privateCapabilityHash_(ownerCapabilityHash, 'invalid_owner_capability');
  } catch (error) {
    return json_({ ok: false, error: error.code || 'invalid_owner_capability' });
  }
  if (!Number.isSafeInteger(expectedPublishVersion) || expectedPublishVersion < 0) {
    return json_({ ok: false, error: 'invalid_expected_publish_version' });
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(clientMutationId)) {
    return json_({ ok: false, error: 'invalid_client_mutation_id' });
  }
  const deleteContract = JSON.stringify({
    dealId: String(dealId),
    expectedPublishVersion: expectedPublishVersion
  });
  const lock = acquireScriptLock_();
  try {
    const sheet = ensureSheets_().publicDeals;
    if (sheet.getLastRow() < 2) return json_({ ok: true, deleted: false });
    const match = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
      .createTextFinder(String(dealId)).matchEntireCell(true).findNext();
    if (!match) return json_({ ok: true, deleted: false });
    let existingDeal = {};
    try { existingDeal = JSON.parse(sheet.getRange(match.getRow(), 7).getValue() || '{}'); } catch (error) {}
    if (!existingDeal || typeof existingDeal !== 'object' || Array.isArray(existingDeal)) {
      existingDeal = {};
    }
    const existingHash = String(existingDeal._ownerCapabilityHash || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(existingHash)) {
      return json_({ ok: false, error: 'deal_ownership_unclaimable' });
    }
    if (existingHash !== incomingHash) return json_({ ok: false, error: 'forbidden' });
    if (String(existingDeal._lastDealDeleteMutationId || '') === clientMutationId) {
      if (String(existingDeal._lastDealDeleteMutationContract || '') !== deleteContract) {
        return json_({ ok: false, error: 'client_mutation_conflict' });
      }
      return json_({ ok: true, deleted: true });
    }
    if (String(existingDeal.visibility || 'public') === 'deleted') {
      return json_({ ok: false, error: 'deal_deleted' });
    }
    const currentPublishVersion = Math.max(0, Math.floor(Number(existingDeal.publishVersion || 0)));
    if (expectedPublishVersion !== currentPublishVersion) {
      return json_({
        ok: false,
        error: 'state_conflict',
        currentPublishVersion: currentPublishVersion
      });
    }
    const deletedAt = new Date().toISOString();
    const deletedDeal = Object.assign({}, existingDeal, {
      visibility: 'deleted',
      deletedAt: deletedAt,
      syncedAt: deletedAt,
      publishVersion: currentPublishVersion + 1,
      _lastDealDeleteMutationId: clientMutationId,
      _lastDealDeleteMutationContract: deleteContract
    });
    const serialized = JSON.stringify(deletedDeal);
    if (serialized.length > 45000) return json_({ ok: false, error: 'deal_too_large' });
    sheet.getRange(match.getRow(), 1, 1, PUBLIC_DEAL_HEADERS.length).setValues([[
      new Date(), safeCell_(deletedDeal.id), safeCell_(deletedDeal.source || ''),
      safeCell_(deletedDeal.region || ''), safeCell_(deletedDeal.district || ''),
      safeCell_(deletedDeal.neighborhood || ''), serialized
    ]]);
    invalidatePublicDealsCache_();
    return json_({ ok: true, deleted: true });
  } finally {
    lock.releaseLock();
  }
}

// Only the PIN-verifying API may issue this assertion, behind the ingest token.
// Product removal is a tombstone. Orders, payments, images and chats are retained.
function handleAdminOperation_(payload) {
  let lock = null;
  try {
    if (payload.adminAssertion !== true) throw groupOperationError_('forbidden');
    const actorId = requireGroupId_(payload.actorId, 'actor_id');
    const action = String(payload.action || '');
    if (!['list', 'orders', 'delete', 'image', 'cancel_order'].includes(action)) throw groupOperationError_('invalid_action');
    const sheets = ensureSheets_();
    if (action === 'list') {
      const deals = [];
      if (sheets.publicDeals.getLastRow() >= 2) {
        sheets.publicDeals.getRange(2, 7, sheets.publicDeals.getLastRow() - 1, 1).getValues().forEach(function(row) {
          try { const deal = JSON.parse(row[0]); if (deal && deal.id) deals.push(publicDealValue_(deal)); } catch (ignored) {}
        });
      }
      return json_({ ok: true, deals: deals.reverse() });
    }
    const dealId = requireGroupId_(payload.dealId, 'deal_id');
    if (action === 'orders') {
      const orders = [];
      if (sheets.customerOrders.getLastRow() >= 2) {
        sheets.customerOrders.getRange(2, 4, sheets.customerOrders.getLastRow() - 1, 1).getValues().forEach(function(row) {
          try {
            const order = JSON.parse(row[0]);
            if (String(order.dealId || (order.deal && order.deal.id) || '') === dealId) orders.push(order);
          } catch (ignored) {}
        });
      }
      const historic = historicCustomerOrders_(sheets.events, '', dealId);
      const projectionContext = {};
      return json_({ ok: true, orders: mergeCustomerOrderSnapshots_(orders.concat(historic)).map(function(order) {
        return publicOrderValue_(projectStoredGroupOrderPayment_(sheets, order, projectionContext));
      }) });
    }
    const mutationId = requireMutationId_(payload.clientMutationId);
    const reason = groupText_(payload.reason, 200).trim();
    if (!reason) throw groupOperationError_('reason_required');
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 0, Number.MAX_SAFE_INTEGER);
    const contract = JSON.stringify({ action: action, dealId: dealId, actorId: actorId,
      orderId: String(payload.orderId || ''), expectedVersion: expectedVersion, reason: reason,
      imageHash: action === 'image' ? sha256Hex_(String(payload.image || '')) : '' });
    lock = acquireScriptLock_();
    if (action === 'cancel_order') {
      const record = getCustomerOrderRecord_(sheets, payload.orderId);
      const order = record.order;
      if (String(order.dealId || (order.deal && order.deal.id) || '') !== dealId) throw groupOperationError_('forbidden');
      const groupId = String(order.groupId || '');
      if (groupId) repairPendingGroupMutations_(sheets, groupId);
      // Re-read after repairing a partially committed request.
      const current = getCustomerOrderRecord_(sheets, payload.orderId);
      const value = current.order;
      if (value._lastAdminCancelId === mutationId) {
        if (value._lastAdminCancelContract !== contract) throw groupOperationError_('client_mutation_conflict');
        return json_({ ok: true, duplicate: true, order: publicOrderValue_(value) });
      }
      const version = secureOrderVersion_(value);
      if (version !== expectedVersion) throw groupOperationError_('state_conflict');
      if (value.status === 'cancelled' || value.customerPickupConfirmedAt || value.status === 'completed') throw groupOperationError_('order_not_cancellable');
      const now = new Date().toISOString();
      const operations = [];
      let group = null;
      let participant = null;
      let cancelledQuantity = 0;
      if (groupId) {
        group = getGroupRecord_(sheets, groupId);
        if (group.dealId !== dealId) throw groupOperationError_('order_owner_conflict');
        participant = getParticipantRecord_(sheets, groupId, value.participantActorId || value.visitorId, true);
        if (!['member', 'creator', 'host'].includes(participant.role)) throw groupOperationError_('forbidden');
        const quantity = requireInteger_(value._reservationQuantity || value.selectedCount || value.quantity, 'order_quantity', 1, 999);
        cancelledQuantity = quantity;
        if (participant.selectedQuantity < quantity) throw groupOperationError_('state_conflict');
        if (participant.role === 'host') {
          if (group.hostActorId !== participant.actorId) throw groupOperationError_('state_conflict');
          if (group.groupStatus !== 'recruiting') throw groupOperationError_('host_cancellation_requires_recruiting');
          if (participant.selectedQuantity === quantity) {
            // Last host reservation: release the role without transferring any
            // amount to another person. The cancelled order keeps its totals.
            group.hostActorId = ''; group.hostMode = 'recruiting';
            participant.role = group.creatorActorId === participant.actorId ? 'creator' : 'member';
            value.adminReleasedHost = true;
          } else if (Number(value.hostRemainderApplied || 0) > 0) {
            throw groupOperationError_('cancel_other_host_orders_first');
          }
        }
        const beforeVersion = participant.version;
        participant.selectedQuantity -= quantity;
        participant.counted = participant.selectedQuantity > 0;
        participant.version += 1;
        participant.updatedAt = now;
        const remainingOrders = groupPaymentOrderRecords_(sheets, groupId, participant.actorId)
          .filter(function(item) { return item.order.id !== value.id && item.order.status !== 'cancelled'; });
        participant.paymentStatus = participant.counted && remainingOrders.length
          ? aggregateGroupOrderPaymentStatus_(remainingOrders.map(function(item) { return item.order; }))
          : 'pending';
        operations.push({ type: 'participant_update', beforeVersion: beforeVersion, target: plainMutationRecord_(participant) });
      }
      const previousStatus = value.status || 'new';
      value.paymentStatusBeforeCancellation = value.paymentStatus || 'pending';
      value.refundReviewRequired = value.paymentStatusBeforeCancellation === 'confirmed';
      value.status = 'cancelled';
      value.paymentStatus = 'cancelled';
      value.cancelledAt = now;
      value.statusUpdatedAt = now;
      value.syncedAt = now;
      value.version = version + 1;
      value.paymentVersion = version + 1;
      value._lastAdminCancelId = mutationId;
      value._lastAdminCancelContract = contract;
      value.statusHistory = (value.statusHistory || []).concat([{
        status: 'cancelled', before: previousStatus, after: 'cancelled', actor: actorId,
        actorRole: 'admin', action: 'admin_cancel_order', reason: reason, timestamp: now,
        version: value.version, clientMutationId: mutationId,
        paymentStatusBeforeCancellation: value.paymentStatusBeforeCancellation,
        refundReviewRequired: value.refundReviewRequired
      }]).slice(-100);
      if (group) {
        operations.push({ type: 'order_update', beforeVersion: version, target: plainMutationRecord_(value) });
        const beforeGroupVersion = group.version;
        group.version += 1; group.updatedAt = now; group.updatedBy = actorId;
        operations.push({ type: 'group_update', beforeVersion: beforeGroupVersion, target: plainMutationRecord_(group) });
        commitGroupMutationIntent_(sheets, {
          groupId: groupId, entityType: 'participant', entityId: participant.actorId,
          fromStatus: 'joined', toStatus: participant.counted ? 'joined' : 'cancelled',
          action: 'admin_cancel_order', actorId: actorId, actorRole: 'admin', reason: reason,
          clientMutationId: mutationId, version: participant.version, createdAt: now
        }, contract, { orderId: value.id, participantActorId: participant.actorId, cancelledQuantity: cancelledQuantity, selectedQuantity: participant.selectedQuantity }, operations);
        invalidateGroupSnapshot_(groupId);
      } else {
        updateCustomerOrderRecord_(sheets, { rowNumber: current.rowNumber, order: value });
      }
      invalidatePublicDealsCache_();
      return json_({ ok: true, order: publicOrderValue_(value) });
    }
    repairPendingMerchantDealPublish_(sheets, dealId);
    const deal = publicDealRecord_(sheets.publicDeals, dealId);
    if (!deal) throw groupOperationError_('deal_not_found');
    const receipts = Array.isArray(deal._adminMutationHistory) ? deal._adminMutationHistory : [];
    const receipt = receipts.find(function(item) { return item.id === mutationId; });
    if (receipt) {
      if (receipt.contract !== contract) throw groupOperationError_('client_mutation_conflict');
      return json_({ ok: true, duplicate: true, deal: publicDealValue_(deal) });
    }
    if (deal.visibility === 'deleted') throw groupOperationError_('deal_deleted');
    if (Number(deal.publishVersion || 0) !== expectedVersion) throw groupOperationError_('state_conflict');
    const now = new Date().toISOString();
    if (action === 'image') deal.image = storePublicImage_(payload.image);
    if (action === 'delete') { deal.visibility = 'deleted'; deal.deletedAt = now; }
    deal.publishVersion = expectedVersion + 1;
    deal.syncedAt = now;
    deal._adminMutationHistory = receipts.concat([{ id: mutationId, contract: contract, actorId: actorId, reason: reason, at: now }]).slice(-30);
    const serialized = JSON.stringify(deal);
    if (serialized.length > 45000) throw groupOperationError_('deal_too_large');
    const row = findExactRow_(sheets.publicDeals, 2, dealId);
    sheets.publicDeals.getRange(row, 1, 1, PUBLIC_DEAL_HEADERS.length).setValues([[
      new Date(), safeCell_(deal.id), safeCell_(deal.source || ''), safeCell_(deal.region || ''),
      safeCell_(deal.district || ''), safeCell_(deal.neighborhood || ''), serialized
    ]]);
    invalidatePublicDealsCache_();
    invalidateGroupSnapshot_(dealId);
    return json_({ ok: true, deal: publicDealValue_(deal) });
  } catch (error) {
    return json_({ ok: false, error: error.code || error.message || 'admin_operation_failed' });
  } finally { if (lock) lock.releaseLock(); }
}

function normalizePhone_(value) {
  return String(value || '').replace(/\D/g, '');
}

function validVisitorId_(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(String(value || ''));
}

function secureOrderVersion_(order) {
  const versions = [order && order.version, order && order.paymentVersion]
    .map(function(value) { return Number(value); })
    .filter(function(value) { return Number.isSafeInteger(value) && value >= 1; });
  return versions.length ? Math.max.apply(null, versions) : 1;
}

function requireSecureOrderQuantity_(order) {
  const value = Number(order && (
    order.selectedCount !== undefined && order.selectedCount !== null
      ? order.selectedCount
      : order.quantity
  ));
  if (!Number.isInteger(value) || value < 1 || value > 999) {
    throw groupOperationError_('invalid_order_quantity');
  }
  return value;
}

function customerOrderReservationHistory_(sheets, groupId, actorId, projectionContext) {
  // Only a single read response supplies this context. Mutations always read
  // again under their script lock, and no snapshot survives between requests.
  let records = projectionContext && projectionContext.reservationHistory;
  if (!records) {
    const lastRow = sheets.groupHistory.getLastRow();
    const rows = lastRow < 2 ? [] : sheets.groupHistory
      .getRange(2, 1, lastRow - 1, GROUP_HISTORY_HEADERS.length).getValues();
    records = rows
    .map(function(row, index) {
      let result = {};
      try { result = JSON.parse(row[13] || '{}'); } catch (error) {}
      return {
        rowNumber: index + 2,
        groupId: String(row[1] || ''),
        fromStatus: String(row[4] || ''),
        toStatus: String(row[5] || ''),
        action: String(row[6] || ''),
        entityId: String(row[3] || ''),
        actorId: String(row[7] || ''),
        mutationId: String(row[10] || ''),
        result: result && typeof result === 'object' && !Array.isArray(result) ? result : {}
      };
    });
    if (projectionContext) projectionContext.reservationHistory = records;
  }
  return records.filter(function(item) {
      return item.groupId === groupId
        && (item.actorId === actorId || (item.action === 'admin_cancel_order' && item.entityId === actorId))
        && ['create', 'join', 'reserve_quantity', 'rollback_reservation', 'cancel_participation', 'admin_cancel_order'].includes(item.action);
    });
}

function customerOrderReservationQuantity_(reservation, history, participantQuantity) {
  let contract = {};
  try {
    contract = JSON.parse(String(reservation && reservation.result && reservation.result.mutationContract || '{}'));
  } catch (error) {}
  if (reservation.action === 'reserve_quantity') {
    const contractedQuantity = Number(contract.quantity);
    if (Number.isInteger(contractedQuantity) && contractedQuantity > 0) return contractedQuantity;
  } else if (['create', 'join'].includes(reservation.action)) {
    const contractedQuantity = Number(contract.selectedQuantity);
    if (Number.isInteger(contractedQuantity) && contractedQuantity > 0) return contractedQuantity;
  }
  if (reservation.action === 'reserve_quantity') {
    const before = Number(reservation.fromStatus);
    const after = Number(reservation.toStatus);
    return Number.isInteger(before) && Number.isInteger(after) && after > before ? after - before : 0;
  }
  const nextReservation = history.find(function(item) {
    return item.rowNumber > reservation.rowNumber && item.action === 'reserve_quantity';
  });
  if (nextReservation) {
    const initialQuantity = Number(nextReservation.fromStatus);
    return Number.isInteger(initialQuantity) && initialQuantity > 0 ? initialQuantity : 0;
  }
  const quantity = Number(participantQuantity);
  return Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
}

function customerOrderReservationRolledBack_(reservation, history) {
  if (!reservation || !reservation.mutationId) return false;
  return (history || []).some(function(item) {
    return item.action === 'rollback_reservation'
      && String(item.result && item.result.reservationMutationId || '') === reservation.mutationId;
  });
}

function activeCustomerOrderReservation_(reservation, history) {
  return Boolean(
    reservation
    && ['create', 'join', 'reserve_quantity'].includes(reservation.action)
    && !customerOrderReservationRolledBack_(reservation, history)
  );
}

function selectCustomerOrderReservation_(history, boundMutationIds, order, participant) {
  const quantity = requireSecureOrderQuantity_(order);
  const proposedMutationId = String(order.reservationMutationId || order.clientMutationId || '');
  const exact = proposedMutationId
    ? history.find(function(item) {
        return item.mutationId === proposedMutationId
          && activeCustomerOrderReservation_(item, history);
      })
    : null;
  let reservation = null;
  if (proposedMutationId) {
    if (!exact || customerOrderReservationQuantity_(exact, history, participant.selectedQuantity) !== quantity) {
      throw groupOperationError_('order_reservation_unverified');
    }
    reservation = exact;
  } else {
    reservation = history.find(function(item) {
      return ['create', 'join'].includes(item.action)
        && activeCustomerOrderReservation_(item, history)
        && customerOrderReservationQuantity_(item, history, participant.selectedQuantity) === quantity;
    });
  }
  if (!reservation || !reservation.mutationId) {
    throw groupOperationError_('order_reservation_unverified');
  }
  if (boundMutationIds[reservation.mutationId]) {
    throw groupOperationError_('order_reservation_conflict');
  }
  return {
    action: reservation.action,
    mutationId: reservation.mutationId,
    quantity: quantity
  };
}

function requireParticipantCapability_(participant, participantCapabilityHashValue) {
  const participantCapabilityHash = privateCapabilityHash_(
    participantCapabilityHashValue,
    'invalid_participant_capability'
  );
  if (!participant || !participant.capabilityHash
    || participant.capabilityHash !== participantCapabilityHash) {
    throw groupOperationError_('invalid_participant_capability');
  }
  return participantCapabilityHash;
}

function boundCustomerOrderReservations_(sheet, excludedOrderId) {
  const bound = Object.create(null);
  if (sheet.getLastRow() < 2) return bound;
  sheet.getRange(2, 4, sheet.getLastRow() - 1, 1).getValues().forEach(function(row) {
    try {
      const stored = JSON.parse(row[0] || '{}');
      if (String(stored.id || '') === String(excludedOrderId || '')) return;
      const mutationId = String(stored._reservationMutationId || '');
      if (mutationId) bound[mutationId] = String(stored.id || '');
    } catch (error) {}
  });
  return bound;
}

function legacyGroupOrderCanBind_(sheet, order) {
  const groupId = String(order.groupId || '');
  const actorId = String(order.participantActorId || order.visitorId || '');
  const orderId = String(order.id || '');
  const matching = storedCustomerOrders_(sheet).filter(function(candidate) {
    return activePurchaseOrder_(candidate)
      && String(candidate.groupId || '') === groupId
      && String(candidate.participantActorId || candidate.visitorId || '') === actorId;
  });
  if (!matching.some(function(candidate) { return String(candidate.id || '') === orderId; })) {
    matching.push(order);
  }
  return matching.length === 1 && String(matching[0].id || '') === orderId;
}

function bindInitialGroupOrderReservation_(sheets, order, visitorId, participantCapabilityHashValue) {
  const groupId = String(order.groupId || '');
  if (!groupId) return order;
  const group = getGroupRecord_(sheets, groupId);
  const dealId = String(order.dealId || (order.deal && order.deal.id) || '');
  const participantActorId = String(order.participantActorId || order.visitorId || '');
  if (group.dealId !== dealId || participantActorId !== visitorId
    || !['purchase', 'group'].includes(String(order.type || ''))) {
    throw groupOperationError_('invalid_group_order_binding');
  }
  const participant = getParticipantRecord_(sheets, groupId, visitorId, true);
  if (!participant || !participant.counted || participant.selectedQuantity < requireSecureOrderQuantity_(order)) {
    throw groupOperationError_('order_reservation_unverified');
  }
  requireParticipantCapability_(participant, participantCapabilityHashValue);
  const reservation = selectCustomerOrderReservation_(
    customerOrderReservationHistory_(sheets, groupId, visitorId),
    boundCustomerOrderReservations_(sheets.customerOrders, order.id),
    order,
    participant
  );
  return Object.assign({}, order, {
    reservationMutationId: reservation.mutationId,
    reservationAction: reservation.action,
    reservationQuantity: reservation.quantity,
    _reservationMutationId: reservation.mutationId,
    _reservationAction: reservation.action,
    _reservationQuantity: reservation.quantity
  });
}

function canonicalGroupOrderPricing_(sheets, orderValue, visitorIdValue) {
  const order = Object.assign({}, orderValue || {});
  const groupId = String(order.groupId || '');
  if (!groupId) return order;
  const visitorId = String(visitorIdValue || '');
  const group = getGroupRecord_(sheets, groupId);
  const deal = activePublicDealRecord_(sheets.publicDeals, group.dealId || groupId);
  if (!deal) throw groupOperationError_('deal_not_found');

  const quantity = requireSecureOrderQuantity_(order);
  const totalQuantity = Number(
    group.totalQuantity || deal.totalQuantity || deal.productQuantity || deal.target || 0
  );
  if (!Number.isInteger(totalQuantity) || totalQuantity < 1 || totalQuantity > 999) {
    throw groupOperationError_('invalid_deal_capacity');
  }
  const merchantGroup = String(deal.source || '') === 'merchant'
    && String(deal.saleType || '') === 'group';
  const canonicalTotal = canonicalDealTotal_(deal, merchantGroup);
  const explicitSplit = merchantGroup
    && Number.isInteger(Number(deal.splitQuantity))
    && Number(deal.splitQuantity) > 0
    ? Number(deal.splitQuantity)
    : (merchantGroup && deal.splitPricing !== true ? 1 : totalQuantity);
  const divisor = Math.max(1, Math.min(totalQuantity, Math.floor(explicitSplit)));
  const unitPrice = Math.floor(canonicalTotal / divisor);
  const remainder = canonicalTotal - (unitPrice * divisor);

  const actorRecords = groupPaymentOrderRecords_(sheets, groupId, visitorId);
  const existingRemainderOrder = actorRecords.find(function(record) {
    return Number(record.order && record.order.hostRemainderApplied || 0) > 0;
  });
  const sameOrderAlreadyCarriesRemainder = existingRemainderOrder
    && String(existingRemainderOrder.order && existingRemainderOrder.order.id || '')
      === String(order.id || '');
  const applyRemainder = String(group.hostActorId || '') === visitorId
    && (!existingRemainderOrder || sameOrderAlreadyCarriesRemainder);
  const hostRemainderApplied = applyRemainder ? remainder : 0;
  const orderTotal = (unitPrice * quantity) + hostRemainderApplied;
  if (!Number.isSafeInteger(orderTotal) || orderTotal < 0) {
    throw groupOperationError_('invalid_deal_price');
  }

  return Object.assign({}, order, {
    unitPrice: unitPrice,
    total: orderTotal,
    hostRemainderApplied: hostRemainderApplied
  });
}

function groupBackedPublicDeal_(deal) {
  return Boolean(
    deal
    && (String(deal.source || '') === 'customer'
      || String(deal.saleType || '') === 'group')
  );
}

function canonicalInitialCustomerOrderPricing_(sheets, orderValue, visitorIdValue, dealValue) {
  const order = Object.assign({}, orderValue || {});
  const dealId = customerOrderDealId_(order);
  const deal = dealValue && String(dealValue.visibility || '') === 'public'
    ? dealValue
    : activePublicDealRecord_(sheets.publicDeals, dealId);
  if (!deal) throw groupOperationError_('deal_not_found');

  const quantity = requireSecureOrderQuantity_(order);
  if (groupBackedPublicDeal_(deal)) {
    if (!order.groupId || String(order.groupId) !== dealId) {
      throw groupOperationError_('invalid_group_deal_binding');
    }
    if (String(deal.source || '') === 'merchant' && String(order.type || '') !== 'purchase') {
      throw groupOperationError_('invalid_order_deal_binding');
    }
    const canonicalGroupOrder = canonicalGroupOrderPricing_(sheets, order, visitorIdValue);
    return Object.assign({}, canonicalGroupOrder, {
      title: String(deal.title || order.title || ''),
      store: String(deal.store || order.store || ''),
      region: String(deal.region || order.region || ''),
      district: String(deal.district || order.district || ''),
      neighborhood: String(deal.neighborhood || order.neighborhood || ''),
      deal: Object.assign({}, order.deal || {}, {
        id: dealId,
        title: String(deal.title || ''),
        store: String(deal.store || ''),
        region: String(deal.region || ''),
        district: String(deal.district || ''),
        neighborhood: String(deal.neighborhood || '')
      })
    });
  }
  if (order.groupId || String(order.type || '') !== 'purchase'
    || String(deal.source || '') !== 'merchant'
    || !['', 'instant'].includes(String(deal.saleType || ''))) {
    throw groupOperationError_('invalid_order_deal_binding');
  }

  const unitPrice = canonicalDealTotal_(deal, true);
  const orderTotal = unitPrice * quantity;
  if (!Number.isSafeInteger(unitPrice) || !Number.isSafeInteger(orderTotal)) {
    throw groupOperationError_('invalid_deal_price');
  }
  return Object.assign({}, order, {
    title: String(deal.title || order.title || ''),
    store: String(deal.store || order.store || ''),
    region: String(deal.region || order.region || ''),
    district: String(deal.district || order.district || ''),
    neighborhood: String(deal.neighborhood || order.neighborhood || ''),
    unitPrice: unitPrice,
    total: orderTotal,
    hostRemainderApplied: 0,
    deal: Object.assign({}, order.deal || {}, {
      id: dealId,
      title: String(deal.title || ''),
      store: String(deal.store || ''),
      region: String(deal.region || ''),
      district: String(deal.district || ''),
      neighborhood: String(deal.neighborhood || '')
    })
  });
}

function requireSameCustomerOrderIdentity_(existingOrder, incomingOrder) {
  const fields = ['id', 'visitorId', 'groupId', 'type', 'createdAt'];
  fields.forEach(function(field) {
    if (String(existingOrder[field] || '') !== String(incomingOrder[field] || '')) {
      throw groupOperationError_('order_identity_conflict');
    }
  });
  if (customerOrderDealId_(existingOrder) !== customerOrderDealId_(incomingOrder)
    || String(existingOrder.participantActorId || existingOrder.visitorId || '')
      !== String(incomingOrder.participantActorId || incomingOrder.visitorId || '')
    || normalizePhone_(existingOrder.customerPhone) !== normalizePhone_(incomingOrder.customerPhone)
    || requireSecureOrderQuantity_(existingOrder) !== requireSecureOrderQuantity_(incomingOrder)
    || Number(existingOrder.unitPrice || 0) !== Number(incomingOrder.unitPrice || 0)
    || Number(existingOrder.total || 0) !== Number(incomingOrder.total || 0)
    || Number(existingOrder.hostRemainderApplied || 0)
      !== Number(incomingOrder.hostRemainderApplied || 0)) {
    throw groupOperationError_('order_identity_conflict');
  }
}

function customerOrderPublishMutationId_(order) {
  const mutationId = String(order && order.publishMutationId || [
    'publish',
    String(order && order.id || ''),
    secureOrderVersion_(order),
    String(order && order.status || 'new'),
    String(order && order.paymentStatus || 'pending'),
    order && order.customerPickupConfirmedAt ? 'pickup' : 'no-pickup',
    order && order.cancelledAt ? 'cancelled' : 'active'
  ].join('-'));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(mutationId)) {
    throw groupOperationError_('invalid_client_mutation_id');
  }
  return mutationId;
}

function customerOrderPublishContract_(order) {
  return JSON.stringify({
    id: String(order && order.id || ''),
    version: secureOrderVersion_(order),
    status: String(order && order.status || 'new'),
    paymentStatus: String(order && order.paymentStatus || 'pending'),
    paymentRequested: Boolean(order && order.paymentRequestedAt),
    customerPickupConfirmed: Boolean(order && order.customerPickupConfirmedAt),
    cancelled: Boolean(order && order.cancelledAt)
  });
}

function customerOrderPublishReplayMatches_(existingOrder, incomingContract) {
  return String(existingOrder && existingOrder._lastPublishMutationContract || '') === incomingContract
    || customerOrderPublishContract_(existingOrder) === incomingContract;
}

function mergeCustomerOrderUpdate_(existingOrder, incomingOrder, nowValue) {
  requireSameCustomerOrderIdentity_(existingOrder, incomingOrder);
  const publishMutationId = customerOrderPublishMutationId_(incomingOrder);
  const publishMutationContract = customerOrderPublishContract_(incomingOrder);
  if (String(existingOrder._lastPublishMutationId || '') === publishMutationId) {
    if (!customerOrderPublishReplayMatches_(existingOrder, publishMutationContract)) {
      throw groupOperationError_('client_mutation_conflict');
    }
    return existingOrder;
  }
  const now = nowValue || new Date().toISOString();
  const existingVersion = secureOrderVersion_(existingOrder);
  const incomingVersion = secureOrderVersion_(incomingOrder);
  if (incomingVersion < existingVersion || incomingVersion > existingVersion + 1) {
    throw groupOperationError_('state_conflict');
  }

  const statuses = ['new', 'preparing', 'pickup_waiting', 'completed'];
  const paymentStatuses = ['pending', 'requested', 'confirmed'];
  const currentStatus = String(existingOrder.status || 'new');
  const nextStatus = String(incomingOrder.status || 'new');
  const currentPayment = String(existingOrder.paymentStatus || 'pending');
  const nextPayment = String(incomingOrder.paymentStatus || 'pending');
  const existingCancelled = currentStatus === 'cancelled' || currentPayment === 'cancelled';
  const incomingCancelled = nextStatus === 'cancelled' || nextPayment === 'cancelled';

  if (existingCancelled) {
    if (!incomingCancelled) throw groupOperationError_('state_conflict');
    return existingOrder;
  }

  if (incomingCancelled) {
    if (nextStatus !== 'cancelled' || nextPayment !== 'cancelled' || existingOrder.groupId
      || currentStatus !== 'new' || currentPayment !== 'pending'
      || existingOrder.paymentRequestedAt || existingOrder.paymentConfirmedAt
      || existingOrder.customerPickupConfirmedAt) {
      throw groupOperationError_('order_transition_forbidden');
    }
  } else {
    if (!statuses.includes(currentStatus) || !statuses.includes(nextStatus)
      || !paymentStatuses.includes(currentPayment) || !paymentStatuses.includes(nextPayment)
      || nextStatus !== currentStatus) {
      throw groupOperationError_('order_transition_forbidden');
    }
    const paymentRequestStarted = currentPayment === 'pending' && nextPayment === 'requested';
    if (nextPayment !== currentPayment && !paymentRequestStarted) {
      throw groupOperationError_('order_transition_forbidden');
    }
    if (existingOrder.paymentRequestedAt && incomingOrder.paymentRequestedAt !== existingOrder.paymentRequestedAt) {
      throw groupOperationError_('order_transition_forbidden');
    }
    if ((!existingOrder.paymentRequestedAt && incomingOrder.paymentRequestedAt && !paymentRequestStarted)
      || (paymentRequestStarted && !incomingOrder.paymentRequestedAt)) {
      throw groupOperationError_('order_transition_forbidden');
    }
    if (String(incomingOrder.paymentConfirmedAt || '') !== String(existingOrder.paymentConfirmedAt || '')) {
      throw groupOperationError_('order_transition_forbidden');
    }
    if (existingOrder.customerPickupConfirmedAt
      && incomingOrder.customerPickupConfirmedAt !== existingOrder.customerPickupConfirmedAt) {
      throw groupOperationError_('order_transition_forbidden');
    }
    if (!existingOrder.customerPickupConfirmedAt && incomingOrder.customerPickupConfirmedAt
      && !['pickup_waiting', 'completed'].includes(currentStatus)) {
      throw groupOperationError_('order_transition_forbidden');
    }
  }

  const changed = incomingCancelled
    || currentStatus !== nextStatus
    || currentPayment !== nextPayment
    || (!existingOrder.paymentRequestedAt && Boolean(incomingOrder.paymentRequestedAt))
    || (!existingOrder.paymentConfirmedAt && Boolean(incomingOrder.paymentConfirmedAt))
    || (!existingOrder.customerPickupConfirmedAt && Boolean(incomingOrder.customerPickupConfirmedAt));
  if (!changed) return Object.assign({}, existingOrder, {
    publishMutationId: publishMutationId,
    _lastPublishMutationId: publishMutationId,
    _lastPublishMutationContract: publishMutationContract
  });

  const nextVersion = existingVersion + 1;
  const merged = Object.assign({}, existingOrder, {
    status: incomingCancelled ? 'cancelled' : nextStatus,
    paymentStatus: incomingCancelled ? 'cancelled' : nextPayment,
    paymentRequestedAt: existingOrder.paymentRequestedAt || (incomingOrder.paymentRequestedAt ? now : ''),
    paymentConfirmedAt: existingOrder.paymentConfirmedAt || (incomingOrder.paymentConfirmedAt ? now : ''),
    customerPickupConfirmedAt: existingOrder.customerPickupConfirmedAt || (incomingOrder.customerPickupConfirmedAt ? now : ''),
    cancelledAt: incomingCancelled ? now : '',
    statusUpdatedAt: now,
    syncedAt: now,
    version: nextVersion,
    paymentVersion: nextVersion,
    publishMutationId: publishMutationId,
    _lastPublishMutationId: publishMutationId,
    _lastPublishMutationContract: publishMutationContract
  });
  merged.statusHistory = (Array.isArray(existingOrder.statusHistory) ? existingOrder.statusHistory : []).concat([{
    status: merged.status,
    before: currentStatus,
    after: merged.status,
    actor: String(existingOrder.visitorId || ''),
    actorRole: 'customer',
    action: incomingCancelled ? 'cancel_participation' : 'publish_order_transition',
    version: nextVersion,
    timestamp: now
  }]).slice(-100);
  return merged;
}

function publishCustomerOrder_(
  order,
  visitorIdValue,
  customerCapabilityHash,
  participantCapabilityHashValue
) {
  if (!order.id || !/^order-\d{10,20}$/.test(String(order.id))) {
    return json_({ ok: false, error: 'invalid_order_id' });
  }
  const visitorId = String(visitorIdValue || '');
  if (!validVisitorId_(visitorId) || String(order.visitorId || '') !== visitorId) {
    return json_({ ok: false, error: 'invalid_order_owner' });
  }
  const orderGroupId = String(order.groupId || '');
  const orderDealId = String(order.dealId || (order.deal && order.deal.id) || '');
  if (orderGroupId && (!validVisitorId_(orderGroupId) || orderGroupId !== orderDealId)) {
    return json_({ ok: false, error: 'invalid_group_deal_binding' });
  }
  let incomingHash;
  try {
    incomingHash = privateCapabilityHash_(customerCapabilityHash, 'invalid_customer_capability');
  } catch (error) {
    return json_({ ok: false, error: error.code || 'invalid_customer_capability' });
  }
  const phone = normalizePhone_(order.customerPhone);
  if (phone.length < 8) return json_({ ok: false, error: 'invalid_customer_phone' });
  let publishMutationId;
  let publishMutationContract;
  try {
    publishMutationId = customerOrderPublishMutationId_(order);
    publishMutationContract = customerOrderPublishContract_(order);
  } catch (error) {
    return json_({ ok: false, error: error.code || 'invalid_client_mutation_id' });
  }

  const lock = acquireScriptLock_();
  try {
    const sheets = ensureSheets_();
    if (orderGroupId) {
      repairPendingMerchantDealPublish_(sheets, orderGroupId);
      repairPendingGroupMutations_(sheets, orderGroupId);
    }
    const sheet = sheets.customerOrders;
    let targetRow = sheet.getLastRow() + 1;
    let existingOrder = null;
    if (sheet.getLastRow() >= 2) {
      const match = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
        .createTextFinder(String(order.id)).matchEntireCell(true).findNext();
      if (match) {
        targetRow = match.getRow();
        try {
          existingOrder = JSON.parse(sheet.getRange(targetRow, 4).getValue() || '{}');
        } catch (error) {
          existingOrder = {};
        }
        if (!existingOrder || typeof existingOrder !== 'object' || Array.isArray(existingOrder)) {
          existingOrder = {};
        }
      }
    }
    if (!existingOrder) {
      const historicMatches = historicCustomerOrdersById_(sheets.events, order.id);
      const historicOwnership = customerOrderOwnership_(historicMatches);
      if (historicOwnership.conflict) {
        return json_({ ok: false, error: 'order_ownership_unclaimable' });
      }
      existingOrder = mergeCustomerOrderSnapshots_(historicMatches)[0] || null;
      if (existingOrder && historicOwnership.hash) {
        existingOrder._customerCapabilityHash = historicOwnership.hash;
      }
    }
    if (existingOrder) {
      const existingHash = String(existingOrder._customerCapabilityHash || '').toLowerCase();
      if (/^[a-f0-9]{64}$/.test(existingHash)) {
        if (existingHash !== incomingHash) return json_({ ok: false, error: 'forbidden' });
      } else if (existingHash) {
        return json_({ ok: false, error: 'order_ownership_unclaimable' });
      } else {
        // Visitor ids, phones, and order metadata are visible to merchant and
        // group-manager views. They are not proof that a caller owns an old
        // row, so legacy orders must be migrated through a verified path.
        return json_({ ok: false, error: 'order_ownership_unclaimable' });
      }
      const existingDealId = customerOrderDealId_(existingOrder);
      if (existingDealId && existingDealId !== orderDealId) {
        return json_({ ok: false, error: 'order_deal_conflict' });
      }
    }
    const publicDeal = publicDealRecord_(sheets.publicDeals, orderDealId);
    if (!existingOrder && (!publicDeal || String(publicDeal.visibility || '') !== 'public')) {
      return json_({ ok: false, error: 'deal_not_found' });
    }
    if (!existingOrder && publicDeal && groupBackedPublicDeal_(publicDeal)
      && String(orderGroupId || '') !== orderDealId) {
      return json_({ ok: false, error: 'invalid_group_deal_binding' });
    }
    if (existingOrder
      && String(existingOrder._lastPublishMutationId || '') === publishMutationId) {
      if (!customerOrderPublishReplayMatches_(existingOrder, publishMutationContract)) {
        return json_({ ok: false, error: 'client_mutation_conflict' });
      }
      order = Object.assign({}, order, {
        unitPrice: Number(existingOrder.unitPrice || 0),
        total: Number(existingOrder.total || 0),
        hostRemainderApplied: Number(existingOrder.hostRemainderApplied || 0)
      });
    }
    if (orderGroupId) {
      order = bindInitialGroupOrderReservation_(
        sheets,
        order,
        visitorId,
        participantCapabilityHashValue
      );
      if (!existingOrder) order = canonicalGroupOrderPricing_(sheets, order, visitorId);
    }
    if (!existingOrder) {
      order = canonicalInitialCustomerOrderPricing_(sheets, order, visitorId, publicDeal);
    }
    const merchantPurchaseOrder = publicDeal
      && String(publicDeal.source || '') === 'merchant'
      && String(order.type || '') === 'purchase';
    if (merchantPurchaseOrder && activePurchaseOrder_(order)) {
      const selectedQuantity = customerOrderQuantity_(order);
      const totalQuantity = Number(
        publicDeal.totalQuantity || publicDeal.productQuantity || publicDeal.target || 0
      );
      const allocatedByOtherOrders = activeMerchantAllocation_(sheets, orderDealId, order.id);
      const capacityError = merchantCapacityError_(
        totalQuantity,
        allocatedByOtherOrders,
        selectedQuantity
      );
      if (capacityError) return json_({ ok: false, error: capacityError });
    }
    const now = new Date().toISOString();
    let storedOrder;
    if (existingOrder) {
      storedOrder = mergeCustomerOrderUpdate_(existingOrder, order, now);
      if (storedOrder.groupId && !storedOrder._reservationMutationId) {
        if (!legacyGroupOrderCanBind_(sheets.customerOrders, storedOrder)) {
          return json_({ ok: false, error: 'order_reservation_conflict' });
        }
        storedOrder = bindInitialGroupOrderReservation_(
          sheets,
          storedOrder,
          visitorId,
          participantCapabilityHashValue
        );
        storedOrder = canonicalGroupOrderPricing_(sheets, storedOrder, visitorId);
      }
      storedOrder = Object.assign({}, storedOrder, {
        customerPhone: phone,
        visitorId: visitorId,
        _customerCapabilityHash: incomingHash
      });
    } else {
      if (String(order.status || 'new') !== 'new'
        || String(order.paymentStatus || 'pending') !== 'pending'
        || secureOrderVersion_(order) !== 1
        || order.paymentRequestedAt || order.paymentConfirmedAt
        || order.customerPickupConfirmedAt || order.cancelledAt) {
        return json_({ ok: false, error: 'invalid_initial_order_state' });
      }
      if (orderGroupId) {
        const participant = getParticipantRecord_(sheets, orderGroupId, visitorId, true);
        // Once any payment transition has started, an older unused reservation
        // must not mint a fresh unpaid order that projects as already paid.
        if (String(participant.paymentStatus || 'pending') !== 'pending') {
          return json_({ ok: false, error: 'quantity_reservation_closed' });
        }
      }
      storedOrder = bindInitialGroupOrderReservation_(sheets, Object.assign({}, order, {
        customerPhone: phone,
        visitorId: visitorId,
        syncedAt: now,
        version: 1,
        paymentVersion: 1,
        publishMutationId: publishMutationId,
        _lastPublishMutationId: publishMutationId,
        _lastPublishMutationContract: publishMutationContract,
        _customerCapabilityHash: incomingHash
      }), visitorId, participantCapabilityHashValue);
      storedOrder = canonicalGroupOrderPricing_(sheets, storedOrder, visitorId);
    }
    const serialized = JSON.stringify(storedOrder);
    if (serialized.length > 30000) return json_({ ok: false, error: 'order_too_large' });
    sheet.getRange(targetRow, 1, 1, CUSTOMER_ORDER_HEADERS.length).setValues([[
      new Date(), safeCell_(storedOrder.id), safeCell_(phone), serialized
    ]]);
    let legacyEventStored = false;
    try {
      legacyEventStored = appendCustomerOrderSnapshotEvent_(
        sheets.events,
        storedOrder,
        incomingHash
      );
    } catch (error) {}
    invalidatePublicDealsCache_();
    if (merchantPurchaseOrder && String(publicDeal.saleType || '') === 'group') {
      invalidateGroupSnapshot_(orderDealId);
    }
    return json_({
      ok: true,
      order: publicOrderValue_(storedOrder),
      legacyEventStored: legacyEventStored
    });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'customer_order_publish_failed' });
  } finally {
    lock.releaseLock();
  }
}

function requireMerchantOwnerCapability_(publicDeal, ownerCapabilityHashValue) {
  const suppliedOwnerHash = privateCapabilityHash_(
    ownerCapabilityHashValue,
    'invalid_owner_capability'
  );
  const storedOwnerHash = String(publicDeal && publicDeal._ownerCapabilityHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(storedOwnerHash)) {
    throw groupOperationError_('deal_ownership_unclaimable');
  }
  if (storedOwnerHash !== suppliedOwnerHash) throw groupOperationError_('forbidden');
  return suppliedOwnerHash;
}

function requireCustomerDealOwnerCapability_(publicDeal, groupIdValue, ownerCapabilityHashValue) {
  const groupId = String(groupIdValue || '');
  if (!publicDeal
    || String(publicDeal.id || '') !== groupId
    || String(publicDeal.groupId || publicDeal.id || '') !== groupId
    || String(publicDeal.source || '') !== 'customer'
    || String(publicDeal.visibility || '') !== 'public') {
    throw groupOperationError_('deal_not_found');
  }
  const suppliedOwnerHash = privateCapabilityHash_(
    ownerCapabilityHashValue,
    'invalid_owner_capability'
  );
  const storedOwnerHash = String(publicDeal._ownerCapabilityHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(storedOwnerHash)) {
    throw groupOperationError_('deal_ownership_unclaimable');
  }
  if (storedOwnerHash !== suppliedOwnerHash) throw groupOperationError_('forbidden');
  return suppliedOwnerHash;
}

function applyManagedCustomerOrderTransition_(orderValue, payload, managerRole, managerActorId, nowValue) {
  const order = Object.assign({}, orderValue || {});
  const kind = String(payload && payload.kind || '');
  const direction = String(payload && payload.direction || '');
  const mutationId = requireMutationId_(payload && payload.clientMutationId);
  if (!['order_status', 'payment_status'].includes(kind)) {
    throw groupOperationError_('invalid_manage_kind');
  }
  if (!['next', 'previous'].includes(direction)) throw groupOperationError_('invalid_direction');

  const history = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  const expectedAction = kind === 'order_status'
    ? 'manage_order_status'
    : 'manage_payment_status';
  const duplicate = history.find(function(item) {
    return String(item.clientMutationId || '') === mutationId;
  });
  if (duplicate) {
    if (String(duplicate.action || '') !== expectedAction
      || String(duplicate.direction || '') !== direction
      || (duplicate.expectedVersion !== undefined
        && Number(duplicate.expectedVersion) !== Number(payload.expectedVersion))) {
      throw groupOperationError_('client_mutation_conflict');
    }
    return { order: order, duplicate: true };
  }

  const currentVersion = secureOrderVersion_(order);
  const expectedVersion = requireInteger_(
    payload.expectedVersion,
    'expected_version',
    1,
    Number.MAX_SAFE_INTEGER
  );
  if (expectedVersion !== currentVersion) throw groupOperationError_('state_conflict');

  const now = nowValue || new Date().toISOString();
  let before;
  let after;
  if (kind === 'order_status') {
    const statuses = ['new', 'preparing', 'pickup_waiting', 'completed'];
    before = String(order.status || 'new');
    const currentIndex = statuses.indexOf(before);
    const nextIndex = currentIndex + (direction === 'previous' ? -1 : 1);
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= statuses.length) {
      throw groupOperationError_('invalid_state_transition');
    }
    after = statuses[nextIndex];
    order.status = after;
  } else {
    before = String(order.paymentStatus || 'pending');
    if (direction === 'next') {
      if (managerRole !== 'merchant_owner' && before !== 'requested') {
        throw groupOperationError_('invalid_state_transition');
      }
      if (!['pending', 'requested'].includes(before)) {
        throw groupOperationError_('invalid_state_transition');
      }
      after = 'confirmed';
      order.paymentConfirmedAt = now;
    } else {
      if (before !== 'confirmed') throw groupOperationError_('invalid_state_transition');
      const previousConfirmation = history.slice().reverse().find(function(item) {
        return String(item.action || '') === 'manage_payment_status'
          && String(item.after || item.status || '') === 'confirmed';
      });
      after = ['pending', 'requested'].includes(String(previousConfirmation && previousConfirmation.before || ''))
        ? String(previousConfirmation.before)
        : 'requested';
      order.paymentConfirmedAt = '';
    }
    order.paymentStatus = after;
    order.paymentRequestedAt = after === 'pending'
      ? ''
      : (order.paymentRequestedAt || now);
  }

  const nextVersion = currentVersion + 1;
  order.statusUpdatedAt = now;
  order.syncedAt = now;
  order.version = nextVersion;
  order.paymentVersion = nextVersion;
  order.statusHistory = history.concat([{
    status: kind === 'order_status' ? after : String(order.status || 'new'),
    before: before,
    after: after,
    actor: managerActorId,
    actorRole: managerRole,
    action: expectedAction,
    direction: direction,
    expectedVersion: Number(payload.expectedVersion),
    clientMutationId: mutationId,
    version: nextVersion,
    timestamp: now
  }]).slice(-100);
  return { order: order, duplicate: false };
}

function manageCustomerOrder_(payload) {
  let lock = null;
  try {
    const orderId = groupText_(payload.orderId, 40);
    const dealId = requireGroupId_(payload.dealId, 'deal_id');
    const kind = String(payload.kind || '');
    const direction = String(payload.direction || '');
    const managerType = String(payload.managerType || '');
    const mutationId = requireMutationId_(payload.clientMutationId);
    if (!/^order-\d{10,20}$/.test(orderId)) throw groupOperationError_('invalid_order_id');
    if (!['order_status', 'payment_status'].includes(kind)) {
      throw groupOperationError_('invalid_manage_kind');
    }
    if (!['next', 'previous'].includes(direction)) throw groupOperationError_('invalid_direction');

    lock = acquireScriptLock_();
    const sheets = ensureSheets_();
    let record = getCustomerOrderRecord_(sheets, orderId);
    let order = record.order;
    const pendingGroupId = String(order.groupId || '');
    if (pendingGroupId) {
      repairPendingMerchantDealPublish_(sheets, pendingGroupId);
      repairPendingGroupMutations_(sheets, pendingGroupId);
      record = getCustomerOrderRecord_(sheets, orderId);
      order = record.order;
    }
    if (customerOrderDealId_(order) !== dealId) throw groupOperationError_('order_deal_conflict');
    if (String(order.status || '') === 'cancelled' || String(order.paymentStatus || '') === 'cancelled') {
      throw groupOperationError_('order_transition_forbidden');
    }

    const publicDeal = publicDealRecord_(sheets.publicDeals, dealId);
    if (!publicDeal) throw groupOperationError_('deal_not_found');
    const source = String(publicDeal.source || '');
    let managerActorId = '';
    let managerRole = '';
    if (source === 'merchant') {
      if (managerType !== 'merchant_owner') throw groupOperationError_('order_manager_mismatch');
      requireMerchantOwnerCapability_(publicDeal, payload.ownerCapabilityHash);
      managerActorId = 'merchant-' + dealId;
      managerRole = 'merchant_owner';
    } else if (source === 'customer') {
      if (managerType !== 'group_manager' || String(order.groupId || '') !== dealId) {
        throw groupOperationError_('order_manager_mismatch');
      }
      const actor = authorizeGroupActor_(sheets, dealId, payload);
      const managerGroup = getGroupRecord_(sheets, dealId);
      requireManager_(actor, managerGroup);
      managerActorId = actor.actorId;
      managerRole = actor.role;
    } else {
      throw groupOperationError_('order_manager_mismatch');
    }

    if (String(order.groupId || '')) {
      order = projectStoredGroupOrderPayment_(sheets, order);
    }
    const manageMutationExists = (Array.isArray(order.statusHistory) ? order.statusHistory : [])
      .some(function(item) {
        return String(item && item.clientMutationId || '') === mutationId;
      });
    if (source === 'merchant' && !manageMutationExists) {
      requireMerchantGroupPaymentRequest_(order, publicDeal, kind, direction);
    }
    if (String(order.groupId || '') && kind === 'payment_status') {
      const paymentActorId = String(order.participantActorId || order.visitorId || '');
      const verifiedPaymentRecords = plannedGroupPaymentOrderRecords_(
        sheets,
        String(order.groupId || ''),
        paymentActorId
      );
      const hasVerifiedPaymentBinding = verifiedPaymentRecords.some(function(paymentRecord) {
        return String(paymentRecord && paymentRecord.order && paymentRecord.order.id || '') === orderId;
      });
      if (!hasVerifiedPaymentBinding) {
        // Never acknowledge an order-only payment update for a group order.
        // Without a proven reservation binding the participant/chat state
        // cannot be updated safely, and a partial success would create the
        // exact cross-view divergence this transaction is meant to prevent.
        throw groupOperationError_('order_payment_link_required');
      }
      if (!manageMutationExists) {
        requireCompleteGroupPaymentQuantity_(verifiedPaymentRecords,
          getParticipantRecord_(sheets, String(order.groupId), paymentActorId, true));
      }
    }
    if (String(order.groupId || '') && kind === 'payment_status'
      && direction === 'previous' && !manageMutationExists) {
      const paymentGroup = getGroupRecord_(sheets, String(order.groupId));
      if (paymentGroup.groupStatus !== GROUP_STATUSES[0]) {
        throw groupOperationError_('payment_reversal_requires_group_rewind');
      }
    }

    const transitionNow = new Date().toISOString();
    const transition = applyManagedCustomerOrderTransition_(
      order,
      payload,
      managerRole,
      managerActorId,
      transitionNow
    );
    // paymentSyncStatus is a read-only projection hint. A safely recovered
    // private binding is persisted below, so retaining this hint on the order
    // row would make a later healthy read look like a stale repair state.
    if (Object.prototype.hasOwnProperty.call(transition.order, 'paymentSyncStatus')) {
      delete transition.order.paymentSyncStatus;
    }
    const managedGroupId = String(transition.order.groupId || '');
    const participantActorId = String(
      transition.order.participantActorId || transition.order.visitorId || ''
    );
    const participantPlan = kind === 'payment_status' && managedGroupId
      ? planParticipantPaymentFromManagedOrder_(
        sheets,
        managedGroupId,
        participantActorId,
        transition.order,
        transitionNow
      )
      : null;
    const manageMutationContract = JSON.stringify({
      action: 'manage_customer_order',
      groupId: managedGroupId,
      orderId: orderId,
      dealId: dealId,
      kind: kind,
      direction: direction,
      expectedVersion: Number(payload.expectedVersion)
    });
    if (transition.duplicate) {
      if (participantPlan) {
        commitGroupMutationIntent_(sheets, {
          groupId: managedGroupId,
          entityType: 'payment',
          entityId: participantActorId,
          fromStatus: String(order.paymentStatus || 'pending'),
          toStatus: String(participantPlan.participant.paymentStatus || 'pending'),
          action: 'manage_customer_order',
          actorId: managerActorId,
          actorRole: managerRole,
          clientMutationId: mutationId,
          version: participantPlan.participant.version,
          createdAt: transitionNow
        }, manageMutationContract, { orderId: orderId, duplicate: true }, [{
          type: 'participant_update',
          beforeVersion: participantPlan.beforeVersion,
          target: plainMutationRecord_(participantPlan.participant)
        }]);
      }
      if (managedGroupId) invalidateGroupSnapshot_(managedGroupId);
      return json_({ ok: true, duplicate: true, order: publicOrderValue_(transition.order) });
    }
    record.order = transition.order;
    if (managedGroupId) {
      const operations = [{
        type: 'order_update',
        rowNumber: record.rowNumber,
        beforeVersion: secureOrderVersion_(order),
        target: plainMutationRecord_(record.order)
      }];
      if (participantPlan) {
        operations.push({
          type: 'participant_update',
          beforeVersion: participantPlan.beforeVersion,
          target: plainMutationRecord_(participantPlan.participant)
        });
      }
      commitGroupMutationIntent_(sheets, {
        groupId: managedGroupId,
        entityType: kind === 'payment_status' ? 'payment' : 'order',
        entityId: orderId,
        fromStatus: kind === 'payment_status'
          ? String(order.paymentStatus || 'pending')
          : String(order.status || 'new'),
        toStatus: kind === 'payment_status'
          ? String(record.order.paymentStatus || 'pending')
          : String(record.order.status || 'new'),
        action: 'manage_customer_order',
        actorId: managerActorId,
        actorRole: managerRole,
        clientMutationId: mutationId,
        version: secureOrderVersion_(record.order),
        createdAt: transitionNow
      }, manageMutationContract, { orderId: orderId }, operations);
    } else {
      updateCustomerOrderRecord_(sheets, record);
    }
    try {
      appendCustomerOrderSnapshotEvent_(
        sheets.events,
        record.order,
        String(record.order._customerCapabilityHash || '')
      );
    } catch (error) {}
    if (managedGroupId) invalidateGroupSnapshot_(managedGroupId);
    invalidatePublicDealsCache_();
    return json_({ ok: true, order: publicOrderValue_(record.order) });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'order_manage_failed' });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (error) {}
    }
  }
}

function customerOrderOwnership_(orders) {
  let hash = '';
  let conflict = false;
  orders.forEach(function(order) {
    if (!order) return;
    const storedHash = String(order._customerCapabilityHash || '').toLowerCase();
    if (!storedHash) return;
    if (!/^[a-f0-9]{64}$/.test(storedHash)) {
      conflict = true;
    } else if (!hash) {
      hash = storedHash;
    } else if (hash !== storedHash) {
      conflict = true;
    }
  });
  return { hash: hash, conflict: conflict };
}

// 복구 승계 해석.
//
// 서버는 원본 권한 토큰을 갖고 있지 않고 해시만 갖고 있으므로 "원래 키를 돌려주는"
// 복구는 불가능하다. 대신 새 키가 등록 시점에 증명된 옛 키를 '승계'했다고 기록하고,
// 읽는 시점에만 해석한다. 시트 행은 절대 다시 쓰지 않는다.
//
// 승계는 전화번호가 아니라 '등록 시점에 살아있는 키로 증명된 항목 집합'에만 적용된다.
// 전화번호는 주문 게시 시 클라이언트가 그대로 정하는 값이고(3353행 부근) 사장님·그룹
// 화면에 노출되므로 소유 증명이 될 수 없다. 전화번호를 근거로 삼으면 남의 번호로 주문
// 한 건을 만든 뒤 그 번호 전체를 인수할 수 있다.
const RECOVERY_RATE_LIMIT_PROPERTY_KEY = 'O2O_RECOVERY_AUTH_RATE_LIMIT_V1';
const RECOVERY_IDENTITY_KEY = /^[a-f0-9]{64}$/;
const RECOVERY_HASH = /^[a-f0-9]{64}$/;

function recoveryError_(code) { return groupOperationError_(code); }

const RECOVERY_ROWS_PER_IDENTITY = 8;

// 한 전화번호 아래에 여러 등록이 공존할 수 있다. 등록 행의 주인은 전화번호가
// 아니라 그 행을 만든 권한 키다. 전화번호만으로 행을 특정하면, 번호만 아는
// 제3자가 남의 등록을 덮어써 이미 복구해 둔 접근까지 되돌릴 수 있다.
function recoveryIdentityRows_(sheets, identityKey) {
  return recoveryRowsRaw_(sheets).filter(function(record) {
    return record.identityKey === identityKey;
  });
}

// 같은 키가 확인번호만 바꾸는 재등록은 허용한다. 그 키를 보유한 것 자체가
// 소유 증명이기 때문이다. 다른 키의 행은 절대 건드리지 않는다.
function recoveryOwnRow_(sheets, identityKey, boundHash) {
  const rows = recoveryIdentityRows_(sheets, identityKey);
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].boundHash === boundHash) return rows[index];
  }
  return null;
}

function recoveryRowsRaw_(sheets) {
  if (RECOVERY_ROWS_CACHE_) return RECOVERY_ROWS_CACHE_;
  const sheet = sheets && sheets.recovery;
  RECOVERY_ROWS_CACHE_ = !sheet || sheet.getLastRow() < 2 ? [] : sheet
    .getRange(2, 1, sheet.getLastRow() - 1, RECOVERY_HEADERS.length)
    .getValues()
    .map(function(row, index) { return recoveryRowValue_(row, index + 2); });
  return RECOVERY_ROWS_CACHE_;
}

function invalidateRecoveryRows_() { RECOVERY_ROWS_CACHE_ = null; }

// 등록 시점에 살아있는 키가 실제로 소유한 항목만 모은다. 전화번호는 쓰지 않는다.
function recoveryBoundSet_(sheets, capabilityHash, groupClaims, dealClaims) {
  const orderIds = [];
  const orders = sheets.customerOrders;
  if (orders.getLastRow() >= 2) {
    orders.getRange(2, 2, orders.getLastRow() - 1, 3).getValues().forEach(function(row) {
      let order = null;
      try { order = JSON.parse(row[2] || '{}'); } catch (error) { return; }
      if (!order || !order.id) return;
      if (String(order._customerCapabilityHash || '').toLowerCase() !== capabilityHash) return;
      if (orderIds.indexOf(String(order.id)) === -1) orderIds.push(String(order.id));
    });
  }
  const groups = [];
  (groupClaims || []).forEach(function(claim) {
    if (!claim || typeof claim !== 'object') return;
    const groupId = String(claim.groupId || '');
    const actorId = String(claim.actorId || '');
    const hash = String(claim.capabilityHash || '').toLowerCase();
    if (!groupId || !actorId || !RECOVERY_HASH.test(hash)) return;
    const participant = getParticipantRecord_(sheets, groupId, actorId, false);
    if (!participant || String(participant.capabilityHash || '').toLowerCase() !== hash) return;
    groups.push({ groupId: groupId, actorId: actorId, hash: hash });
  });
  const deals = [];
  (dealClaims || []).forEach(function(claim) {
    if (!claim || typeof claim !== 'object') return;
    const dealId = String(claim.dealId || '');
    const hash = String(claim.ownerCapabilityHash || '').toLowerCase();
    if (!dealId || !RECOVERY_HASH.test(hash)) return;
    const record = publicDealRecord_(sheets.publicDeals, dealId);
    const deal = record && record.deal ? record.deal : null;
    if (!ownerClaimMatchesDeal_({ dealId: dealId, ownerCapabilityHash: hash }, deal)) return;
    deals.push({ dealId: dealId, hash: hash });
  });
  return { orderIds: orderIds, groups: groups, deals: deals };
}

function handleRecoveryCredentials_(payload) {
  let lock = null;
  try {
    const operations = ['begin', 'finish', 'enroll', 'redeem'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || operations.indexOf(payload.operation) === -1) {
      throw recoveryError_('invalid_recovery_request');
    }
    const identityKey = String(payload.identityKey || '');
    if (!RECOVERY_IDENTITY_KEY.test(identityKey)) throw recoveryError_('invalid_recovery_request');

    let properties;
    try { properties = PropertiesService.getScriptProperties(); }
    catch (error) { throw recoveryError_('recovery_store_unavailable'); }

    if (payload.operation === 'begin' || payload.operation === 'finish') {
      const clientKey = String(payload.clientKey || '');
      if (!/^[a-f0-9]{32}$/.test(clientKey)) throw recoveryError_('invalid_recovery_request');
      lock = acquireScriptLock_();
      const limitOperation = payload.operation === 'begin'
        ? 'rate_begin'
        : (payload.outcome === 'success' ? 'rate_success' : 'rate_failure');
      const limited = handleAdminAuthRateLimit_(
        properties, limitOperation, clientKey, RECOVERY_RATE_LIMIT_PROPERTY_KEY, true
      );
      if (payload.operation !== 'begin' || limited.allowed !== true) return json_(limited);
      // 검증자는 예약에 성공한 요청에만, 잠긴 같은 요청 안에서만 돌려준다.
      // 별도의 읽기 오퍼레이션을 두면 저엔트로피 확인번호가 오프라인 대입에 노출된다.
      const candidates = recoveryIdentityRows_(ensureSheets_(), identityKey)
        .filter(function(record) { return validAdminCredentialVerifier_(record.verifier); })
        .slice(0, RECOVERY_ROWS_PER_IDENTITY)
        .map(function(record) { return { ref: record.boundHash, verifier: record.verifier }; });
      // 미끼로 길이를 맞춘다. 검증자 개수가 곧 '이 번호가 몇 번 등록했는가'이고,
      // 0개와 1개의 차이는 계정 열거가 된다. 미끼는 맞출 수 없는 값이며 호출자는
      // 어느 쪽이든 같은 양의 파생 비용을 치른다.
      while (candidates.length < RECOVERY_ROWS_PER_IDENTITY) {
        const seed = sha256Hex_('recovery-decoy:' + identityKey + ':' + candidates.length + ':' + INGEST_TOKEN);
        candidates.push({
          ref: seed,
          verifier: { algorithm: 'scrypt-v1', salt: seed.slice(0, 32), hash: seed + seed }
        });
      }
      return json_(Object.assign({}, limited, { verifiers: candidates }));
    }

    const sheets = ensureSheets_();
    const clientMutationId = String(payload.clientMutationId || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(clientMutationId)) {
      throw recoveryError_('invalid_client_mutation_id');
    }
    lock = acquireScriptLock_();

    if (payload.operation === 'enroll') {
      const capabilityHash = String(payload.capabilityHash || '').toLowerCase();
      if (!RECOVERY_HASH.test(capabilityHash)) throw recoveryError_('invalid_recovery_capability');
      if (!validAdminCredentialVerifier_(payload.verifier)) throw recoveryError_('invalid_recovery_verifier');
      const actorId = String(payload.actorId || '');
      if (!validVisitorId_(actorId)) throw recoveryError_('invalid_actor_id');
      const own = recoveryOwnRow_(sheets, identityKey, capabilityHash);
      if (own && own.lastMutationId === clientMutationId) {
        return json_({ ok: true, duplicate: true });
      }
      // 등록 수를 제한해 한 번호 아래에 행이 무한히 쌓이지 않게 한다.
      if (!own && recoveryIdentityRows_(sheets, identityKey).length >= RECOVERY_ROWS_PER_IDENTITY) {
        throw recoveryError_('recovery_enrollment_limit');
      }
      const bound = recoveryBoundSet_(sheets, capabilityHash, payload.groups, payload.deals);
      // 소유를 하나도 증명하지 못하면 등록하지 않는다. 등록 자체가 권한 근거가 되므로
      // 아무 키나 등록해 두고 나중에 남의 것을 가져가는 경로를 막는다.
      if (!bound.orderIds.length && !bound.groups.length && !bound.deals.length) {
        throw recoveryError_('recovery_nothing_to_bind');
      }
      const now = new Date().toISOString();
      const values = [
        own ? own.createdAt || now : now, now, identityKey,
        JSON.stringify(payload.verifier), capabilityHash, own ? own.currentHash : capabilityHash,
        JSON.stringify(bound.orderIds), JSON.stringify(bound.groups), JSON.stringify(bound.deals),
        actorId, (own ? own.version : 0) + 1, clientMutationId
      ];
      if (own) {
        sheets.recovery.getRange(own.rowNumber, 1, 1, RECOVERY_HEADERS.length).setValues([values]);
      } else {
        sheets.recovery.appendRow(values);
      }
      invalidateRecoveryRows_();
      // 등록 여부·횟수를 응답으로 알려주지 않는다. 그 값이 '이 번호가 등록되어
      // 있는가'를 무제한으로 조회하는 열거 수단이 된다.
      return json_({
        ok: true,
        bound: { orders: bound.orderIds.length, groups: bound.groups.length, deals: bound.deals.length }
      });
    }

    // redeem: 확인번호 검증은 Vercel 에서 끝났고, 여기서는 승계만 기록한다.
    // 어느 등록 행인지는 Vercel 이 맞춘 검증자의 ref 로 지정된다. 미끼를 맞췄다면
    // 그 ref 로는 행을 찾을 수 없으므로 자연히 거절된다.
    const existing = recoveryOwnRow_(sheets, identityKey, String(payload.ref || '').toLowerCase());
    if (!existing) throw recoveryError_('recovery_not_enrolled');
    if (existing.lastMutationId === clientMutationId) {
      return json_({ ok: true, duplicate: true, actorId: existing.actorId });
    }
    if (payload.redeemAssertion !== true) throw recoveryError_('forbidden');
    const newHash = String(payload.capabilityHash || '').toLowerCase();
    if (!RECOVERY_HASH.test(newHash)) throw recoveryError_('invalid_recovery_capability');
    const now = new Date().toISOString();
    sheets.recovery.getRange(existing.rowNumber, 1, 1, RECOVERY_HEADERS.length).setValues([[
      existing.createdAt || now, now, identityKey, JSON.stringify(existing.verifier),
      existing.boundHash, newHash, JSON.stringify(existing.boundOrderIds),
      JSON.stringify(existing.boundGroups), JSON.stringify(existing.boundDeals),
      existing.actorId, existing.version + 1, clientMutationId
    ]]);
    invalidateRecoveryRows_();
    invalidateRecoveryRows_();
    return json_({
      ok: true, actorId: existing.actorId,
      bound: {
        orders: (existing.boundOrderIds || []).length,
        groups: (existing.boundGroups || []).length,
        deals: (existing.boundDeals || []).length
      },
      groups: existing.boundGroups || []
    });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'recovery_failed' });
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (error) {} }
  }
}

function recoveryRowValue_(row, rowNumber) {
  const parse = function(value, fallback) {
    try {
      const parsed = JSON.parse(String(value || ''));
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (error) { return fallback; }
  };
  return {
    rowNumber: rowNumber,
    createdAt: String(row[0] || ''),
    identityKey: String(row[2] || ''),
    verifier: parse(row[3], null),
    boundHash: String(row[4] || '').toLowerCase(),
    currentHash: String(row[5] || '').toLowerCase(),
    boundOrderIds: parse(row[6], []),
    boundGroups: parse(row[7], []),
    boundDeals: parse(row[8], []),
    actorId: String(row[9] || ''),
    version: Number(row[10] || 0),
    lastMutationId: String(row[11] || '')
  };
}

function recoveryRows_(sheets) {
  return recoveryRowsRaw_(sheets).filter(function(record) {
    return RECOVERY_HASH.test(record.boundHash) && RECOVERY_HASH.test(record.currentHash);
  });
}

// 제시된 해시가 승계한 옛 해시를 돌려준다. 승계가 없으면 null.
function recoverySuccession_(sheets, capabilityHash) {
  const hash = String(capabilityHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const matches = recoveryRows_(sheets).filter(function(record) {
    return record.currentHash === hash && record.boundHash !== hash;
  });
  // 한 키가 여러 등록을 승계하는 것은 정상 경로로 생길 수 없다. 모호하면 승계하지 않는다.
  return matches.length === 1 ? matches[0] : null;
}

// 결박 목록에서 이 대상의 '결박 당시 해시'를 하나로 확정한다. 같은 대상에 서로 다른
// 해시가 실려 있으면 어느 쪽이 진짜인지 정할 수 없으므로 승계하지 않는다.
function recoveryBoundEntryHash_(entries, matches) {
  if (!Array.isArray(entries)) return '';
  let found = '';
  let ambiguous = false;
  entries.forEach(function(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !matches(entry)) return;
    const hash = String(entry.hash || '').toLowerCase();
    if (!RECOVERY_HASH.test(hash) || (found && found !== hash)) {
      ambiguous = true;
      return;
    }
    found = hash;
  });
  return ambiguous ? '' : found;
}

// 그룹 축 승계. 주문 축과 같은 원칙이다: 등록 시점에 살아있는 키로 증명된
// (그룹, 참여자) 한 쌍에만 적용하고, 전화번호나 actorId 는 근거로 쓰지 않는다.
// 호출자는 결박 당시 해시가 지금도 참여자 행의 값과 같은지 확인해야 한다.
function recoveryGroupSuccessionHash_(sheets, groupId, actorId, capabilityHash) {
  const succession = recoverySuccession_(sheets, capabilityHash);
  if (!succession) return '';
  return recoveryBoundEntryHash_(succession.boundGroups, function(entry) {
    return String(entry.groupId || '') === String(groupId)
      && String(entry.actorId || '') === String(actorId);
  });
}

// 상품 축 승계. 돌려주는 값은 '결박 당시의 사장님 해시'일 뿐이고, 그 해시가 지금도
// 상품 행에 그대로 있는지는 호출자가 ownerClaimMatchesDeal_ 로 확인한다.
function recoveryDealSuccessionHash_(sheets, dealId, ownerCapabilityHash) {
  const succession = recoverySuccession_(sheets, ownerCapabilityHash);
  if (!succession) return '';
  return recoveryBoundEntryHash_(succession.boundDeals, function(entry) {
    return String(entry.dealId || '') === String(dealId);
  });
}

function filterCustomerOrdersForProof_(orders, visitorId, customerCapabilityHash, succession) {
  const ownershipById = Object.create(null);
  orders.forEach(function(order) {
    if (!order || !order.id) return;
    const key = String(order.id);
    const storedHash = String(order._customerCapabilityHash || '').toLowerCase();
    if (!storedHash) return;
    if (!ownershipById[key]) ownershipById[key] = { hash: '', conflict: false };
    if (!/^[a-f0-9]{64}$/.test(storedHash)) {
      ownershipById[key].conflict = true;
    } else if (!ownershipById[key].hash) {
      ownershipById[key].hash = storedHash;
    } else if (ownershipById[key].hash !== storedHash) {
      ownershipById[key].conflict = true;
    }
  });
  // 승계된 옛 해시는 등록 시점에 증명된 주문에 한해서만 인정한다.
  const successionOrderIds = Object.create(null);
  if (succession) {
    (succession.boundOrderIds || []).forEach(function(orderId) {
      successionOrderIds[String(orderId)] = true;
    });
  }
  return orders.filter(function(order) {
    if (!order || !order.id) return false;
    const ownership = ownershipById[String(order.id)];
    if (ownership && ownership.conflict) return false;
    if (ownership && ownership.hash) {
      if (ownership.hash === customerCapabilityHash) return true;
      return Boolean(succession)
        && successionOrderIds[String(order.id)] === true
        && ownership.hash === succession.boundHash;
    }
    // Phone numbers and visitor ids are exposed to the merchant/group owner
    // views and therefore cannot authenticate old unhashed rows. Legacy rows
    // need an explicit capability migration before customer history can expose
    // them; otherwise an arbitrary token would authorize another user's data.
    return false;
  });
}

function getCustomerOrders_(phoneValue, visitorIdValue, customerCapabilityHashValue, groupIdValue) {
  const phone = normalizePhone_(phoneValue);
  const visitorId = String(visitorIdValue || '');
  const groupId = groupIdValue ? requireGroupId_(groupIdValue, 'group_id') : '';
  if (phone.length < 8) throw groupOperationError_('invalid_customer_phone');
  if (!validVisitorId_(visitorId)) throw groupOperationError_('invalid_order_owner');
  const customerCapabilityHash = privateCapabilityHash_(
    customerCapabilityHashValue,
    'invalid_customer_capability'
  );
  const sheets = ensureSheets_();
  const current = [];
  const sheet = sheets.customerOrders;
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 3, sheet.getLastRow() - 1, 2)
      .getValues()
      .filter(function(row) { return normalizePhone_(row[0]) === phone; })
      .forEach(function(row) {
        try {
          const order = JSON.parse(row[1] || '{}');
          current.push(order);
        } catch (error) {}
      });
  }
  // Ownership conflicts and canonical versions are keyed by order id, not by
  // group. Keep every phone-matching snapshot in those checks so a scoped read
  // cannot revive an older order or hide a conflicting key in another group.
  const eventRowCount = sheets.events.getLastRow();
  let historic = cachedHistoricCustomerOrders_(phone, eventRowCount);
  if (!historic) {
    historic = historicCustomerOrders_(sheets.events, phone, '');
    cacheHistoricCustomerOrders_(phone, eventRowCount, historic);
  }
  // 승계는 직접 소유가 없을 때만 의미가 있으므로 여기서 한 번만 읽는다.
  const succession = recoverySuccession_(sheets, customerCapabilityHash);
  const authorized = filterCustomerOrdersForProof_(
    current.concat(historic),
    visitorId,
    customerCapabilityHash,
    succession
  );
  const projectionContext = {};
  return mergeCustomerOrderSnapshots_(authorized).filter(function(order) {
    return !groupId || String(order.groupId || order.dealId || '') === groupId;
  }).map(function(order) {
    return publicOrderValue_(projectStoredGroupOrderPayment_(sheets, order, projectionContext));
  });
}

function getCustomerOrdersResponse_(phoneValue, visitorId, customerCapabilityHash, groupId) {
  try {
    return json_({
      ok: true,
      orders: getCustomerOrders_(phoneValue, visitorId, customerCapabilityHash, groupId)
    });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'customer_orders_failed' });
  }
}

function matchedEventRows_(events, matches) {
  const rowNumbers = matches.map(function(match) { return match.getRow(); })
    .sort(function(left, right) { return left - right; })
    .filter(function(rowNumber, index, rows) { return index === 0 || rowNumber !== rows[index - 1]; });
  const results = [];
  if (!rowNumbers.length) return results;
  // Keep small reads narrow. For longer histories, spend a bounded amount of
  // extra row I/O to avoid hundreds of remote Spreadsheet calls. This is a
  // per-request plan, not a cache: every original match is still read fresh.
  let narrowWindows = 0;
  let previousStart = -100;
  rowNumbers.forEach(function(rowNumber) {
    if (rowNumber - previousStart >= 100) {
      narrowWindows += 1;
      previousStart = rowNumber;
    }
  });
  const span = rowNumbers[rowNumbers.length - 1] - rowNumbers[0] + 1;
  const windowRows = narrowWindows > 16
    ? Math.min(1000, Math.max(100, Math.ceil(span / 16)))
    : 100;
  // Never allocate more than 1,000 rows at once, or read more than 100 rows
  // per actual match just to bridge a sparse gap. Very distant matches remain
  // separate reads; an absolute RPC cap would require unbounded gap scans.
  let index = 0;
  while (index < rowNumbers.length) {
    const startRow = rowNumbers[index];
    let endIndex = index;
    while (endIndex + 1 < rowNumbers.length
      && rowNumbers[endIndex + 1] - startRow < windowRows
      && rowNumbers[endIndex + 1] - startRow + 1 <= (endIndex - index + 2) * 100) endIndex += 1;
    const rows = events.getRange(startRow, 1, rowNumbers[endIndex] - startRow + 1, EVENT_HEADERS.length).getValues();
    for (; index <= endIndex; index += 1) results.push(rows[rowNumbers[index] - startRow]);
  }
  return results;
}

function matchedEventColumnValues_(events, matches, column) {
  const rowNumbers = matches.map(function(match) { return match.getRow(); })
    .sort(function(left, right) { return left - right; })
    .filter(function(rowNumber, index, rows) { return index === 0 || rowNumber !== rows[index - 1]; });
  const results = Object.create(null);
  if (!rowNumbers.length) return results;
  // Read only the discriminator column for phone/deal matches before touching
  // their larger event payloads. A global event-name TextFinder made every
  // customer history request scan the complete event sheet twice and began
  // timing out as analytics rows accumulated.
  let index = 0;
  while (index < rowNumbers.length) {
    const startRow = rowNumbers[index];
    let endIndex = index;
    while (endIndex + 1 < rowNumbers.length
      && rowNumbers[endIndex + 1] - startRow < 1000
      && rowNumbers[endIndex + 1] - startRow + 1 <= (endIndex - index + 2) * 100) endIndex += 1;
    const values = events.getRange(
      startRow,
      column,
      rowNumbers[endIndex] - startRow + 1,
      1
    ).getValues();
    for (; index <= endIndex; index += 1) {
      results[rowNumbers[index]] = values[rowNumbers[index] - startRow][0];
    }
  }
  return results;
}

// The phone column carries every analytics row for that customer, so a 4-digit
// match returned a huge, sparse match set and this read grew past a 50s budget.
// The order snapshots themselves are a small, bounded set, and matching the
// event name exactly is what the authorized owner/admin read already does in
// production. Select those rows first, then apply the existing phone check
// below, so no snapshot is ever skipped.
function historicCustomerOrders_(events, phone, dealId) {
  if (events.getLastRow() < 2) return [];
  let rows;
  let matches;
  let snapshotMatched = false;
  if (dealId) {
    matches = events.getRange(2, 12, events.getLastRow() - 1, 1)
      .createTextFinder(String(dealId)).matchCase(true).findAll();
  } else if (phone) {
    snapshotMatched = true;
    matches = events.getRange(2, 7, events.getLastRow() - 1, 1)
      .createTextFinder('customer_order_snapshot').matchCase(true).matchEntireCell(true)
      .findAll();
  } else {
    rows = events.getRange(2, 1, events.getLastRow() - 1, EVENT_HEADERS.length).getValues();
  }
  if (matches && snapshotMatched) {
    if (!matches.length) return [];
    rows = matchedEventRows_(events, matches);
  }
  if (matches && !snapshotMatched) {
    if (!matches.length) return [];
    const eventNames = matchedEventColumnValues_(events, matches, 7);
    // Most phone/deal matches are analytics events. Intersect indexes before
    // reading their large payload cells without scanning the complete event
    // sheet a second time. The exact event/phone/deal checks below remain the
    // authorization and canonical-version boundary.
    rows = matchedEventRows_(events, matches.filter(function(match) {
      return String(eventNames[match.getRow()] || '') === 'customer_order_snapshot';
    }));
  }
  const results = [];
  rows.forEach(function(row) {
    if (String(row[6] || '') !== 'customer_order_snapshot') return;
    if (phone && normalizePhone_(row[13]) !== normalizePhone_(phone)) return;
    try {
      const details = JSON.parse(row[11] || '{}');
      const order = JSON.parse(details.order_snapshot || '{}');
      const orderDealId = String(order.dealId || (order.deal && order.deal.id) || '');
      if (dealId && orderDealId !== dealId) return;
      if (order && order.id) results.push(order);
    } catch (error) {}
  });
  return results;
}

function historicCustomerOrdersForDeals_(events, authorizedDealIds) {
  const authorized = authorizedDealIds || Object.create(null);
  if (!Object.keys(authorized).length || !events || events.getLastRow() < 2) return [];
  // Find the immutable order snapshots once and filter their parsed product id
  // against the already capability-authorized set. This keeps the query cost
  // bounded when one owner has many products and cannot widen authorization.
  const matches = events.getRange(2, 7, events.getLastRow() - 1, 1)
    .createTextFinder('customer_order_snapshot').matchCase(true).matchEntireCell(true)
    .findAll();
  if (!matches.length) return [];
  const results = [];
  matchedEventRows_(events, matches).forEach(function(row) {
    if (String(row[6] || '') !== 'customer_order_snapshot') return;
    try {
      const details = JSON.parse(row[11] || '{}');
      const order = JSON.parse(details.order_snapshot || '{}');
      const orderDealId = customerOrderDealId_(order);
      if (order && order.id && authorized[orderDealId]) results.push(order);
    } catch (error) {}
  });
  return results;
}

function historicCustomerOrdersById_(events, orderId) {
  if (!orderId || events.getLastRow() < 2) return [];
  return events.getRange(2, 12, events.getLastRow() - 1, 1)
    .createTextFinder(String(orderId)).matchCase(true).findAll()
    .map(function(match) {
      try {
        const details = JSON.parse(match.getValue() || '{}');
        const order = JSON.parse(details.order_snapshot || '{}');
        return String(order.id || '') === String(orderId) ? order : null;
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function mergeCustomerOrderSnapshots_(orders) {
  const latest = Object.create(null);
  orders.forEach(function(order) {
    if (!order || !order.id) return;
    const key = String(order.id);
    const previous = latest[key];
    const candidateVersion = secureOrderVersion_(order);
    const previousVersion = previous ? secureOrderVersion_(previous) : 0;
    const candidateTime = new Date(order.statusUpdatedAt || order.syncedAt || order.createdAt || 0).getTime() || 0;
    const previousTime = previous
      ? new Date(previous.statusUpdatedAt || previous.syncedAt || previous.createdAt || 0).getTime() || 0
      : -1;
    if (!previous
      || candidateVersion > previousVersion
      || (candidateVersion === previousVersion && candidateTime >= previousTime)) {
      latest[key] = order;
    }
  });
  return Object.keys(latest).map(function(key) { return latest[key]; }).sort(function(a, b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

function groupOperationError_(code, details) {
  const error = new Error(code);
  error.code = code;
  error.details = details || {};
  return error;
}

function groupText_(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength || 500);
}

function requireGroupId_(value, fieldName) {
  const normalized = groupText_(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(normalized)) {
    throw groupOperationError_('invalid_' + (fieldName || 'group_id'));
  }
  return normalized;
}

function requireMutationId_(value) {
  const normalized = groupText_(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(normalized)) {
    throw groupOperationError_('invalid_client_mutation_id');
  }
  return normalized;
}

function requireCapabilityHash_(value) {
  const normalized = groupText_(value, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw groupOperationError_('invalid_capability');
  return normalized;
}

function requireInteger_(value, fieldName, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw groupOperationError_('invalid_' + fieldName);
  }
  return parsed;
}

function isoValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return value.toISOString();
  return String(value || '');
}

function booleanValue_(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function decodedSafeCell_(value) {
  const source = String(value == null ? '' : value);
  return /^'[=+\-@]/.test(source) ? source.slice(1) : source;
}

function findExactRow_(sheet, column, value) {
  if (!value || sheet.getLastRow() < 2) return 0;
  const match = sheet.getRange(2, column, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).findNext();
  return match ? match.getRow() : 0;
}

function findGroupParticipantRow_(sheet, groupId, actorId) {
  if (sheet.getLastRow() < 2) return 0;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (let index = 0; index < rows.length; index += 1) {
    if (String(rows[index][0]) === groupId && String(rows[index][1]) === actorId) return index + 2;
  }
  return 0;
}

function groupFromRow_(row, rowNumber) {
  if (!row || !row[0]) return null;
  const legacyHostActorId = String(row[6] || '');
  const storedHostMode = String(row[13] || '');
  return {
    rowNumber: rowNumber,
    groupId: String(row[0]),
    dealId: String(row[1] || ''),
    title: String(row[2] || ''),
    groupStatus: String(row[3] || GROUP_STATUSES[0]),
    targetCount: Number(row[4] || 1),
    chatLocked: booleanValue_(row[5]),
    hostActorId: legacyHostActorId,
    lastMessageSeq: Number(row[7] || 0),
    version: Number(row[8] || 1),
    createdAt: isoValue_(row[9]),
    updatedAt: isoValue_(row[10]),
    updatedBy: String(row[11] || ''),
    creatorActorId: String(row[12] || legacyHostActorId),
    hostMode: storedHostMode === 'recruiting' ? 'recruiting' : 'self',
    totalQuantity: Math.max(1, Number(row[14] || row[4] || 1))
  };
}

function participantFromRow_(row, rowNumber, includeSecret) {
  if (!row || !row[0] || !row[1]) return null;
  const counted = booleanValue_(row[4]);
  const participant = {
    rowNumber: rowNumber,
    groupId: String(row[0]),
    actorId: String(row[1]),
    nickname: decodedSafeCell_(row[2]),
    role: String(row[3] || 'member'),
    counted: counted,
    paymentStatus: PAYMENT_STATUSES.includes(String(row[5])) ? String(row[5]) : PAYMENT_STATUSES[0],
    lastReadSeq: Number(row[6] || 0),
    version: Number(row[8] || 1),
    joinedAt: isoValue_(row[9]),
    updatedAt: isoValue_(row[10]),
    selectedQuantity: row[11] === '' || row[11] === null || row[11] === undefined
      ? (counted ? 1 : 0)
      : Math.max(0, Number(row[11] || 0))
  };
  if (includeSecret) participant.capabilityHash = String(row[7] || '').toLowerCase();
  return participant;
}

function getGroupRecord_(sheets, groupId) {
  const rowNumber = findExactRow_(sheets.groups, 1, groupId);
  if (!rowNumber) throw groupOperationError_('group_not_found');
  return groupFromRow_(sheets.groups.getRange(rowNumber, 1, 1, GROUP_HEADERS.length).getValues()[0], rowNumber);
}

function getParticipantRecord_(sheets, groupId, actorId, required) {
  const rowNumber = findGroupParticipantRow_(sheets.groupParticipants, groupId, actorId);
  if (!rowNumber) {
    if (required !== false) throw groupOperationError_('participant_not_found');
    return null;
  }
  return participantFromRow_(
    sheets.groupParticipants.getRange(rowNumber, 1, 1, GROUP_PARTICIPANT_HEADERS.length).getValues()[0],
    rowNumber,
    true
  );
}

function authorizeGroupActor_(sheets, groupId, payload) {
  getGroupRecord_(sheets, groupId);
  const actorId = requireGroupId_(payload.actorId, 'actor_id');
  const participant = getParticipantRecord_(sheets, groupId, actorId, false);
  if (payload.adminAssertion === true) {
    return { actorId: actorId, role: 'admin', participant: participant };
  }
  const suppliedHash = requireCapabilityHash_(payload.capabilityHash);
  if (!participant || !participant.capabilityHash) throw groupOperationError_('invalid_capability');
  if (participant.capabilityHash !== suppliedHash) {
    // 복구로 승계한 새 키는 결박 당시 증명된 (그룹, 참여자) 한 쌍에만 통한다.
    // 결박 당시 해시가 지금 행의 값과 다르면 그 사이 정상 경로로 권한 토큰이
    // 바뀐 것이므로 승계는 무효다 — 옛 등록이 이후의 정상 교체를 되돌리면 안 된다.
    // actorId 일치는 증명이 아니다: actorId 는 사장님 주문 화면에 노출된다.
    const inherited = recoveryGroupSuccessionHash_(sheets, groupId, actorId, suppliedHash);
    if (!inherited || inherited !== participant.capabilityHash) {
      throw groupOperationError_('invalid_capability');
    }
  }
  return { actorId: actorId, role: participant.role, participant: participant };
}

function isActiveGroupActor_(actor) {
  return Boolean(actor && (actor.role === 'admin' || (actor.participant && actor.participant.counted)));
}

function requireActiveGroupActor_(actor) {
  if (!isActiveGroupActor_(actor)) throw groupOperationError_('forbidden');
}

function requireManager_(actor, group) {
  if (!actor || !['host', 'admin'].includes(actor.role)) throw groupOperationError_('forbidden');
  // A participant role is not sufficient proof of host authority. A failed
  // multi-row host claim may have left a stale role behind, so always bind
  // host authorization to the group's canonical host actor as well.
  if (actor.role === 'host' && (!group || String(group.hostActorId || '') !== String(actor.actorId || ''))) {
    throw groupOperationError_('forbidden');
  }
}

function requireTargetManager_(actor, group) {
  if (!actor || !['creator', 'host', 'admin'].includes(actor.role)) {
    throw groupOperationError_('forbidden');
  }
  if (actor.role === 'host' && (!group || String(group.hostActorId || '') !== String(actor.actorId || ''))) {
    throw groupOperationError_('forbidden');
  }
  if (actor.role === 'creator' && (!group || String(group.creatorActorId || '') !== String(actor.actorId || ''))) {
    throw groupOperationError_('forbidden');
  }
}

function getParticipantsForGroup_(sheets, groupId, includeSecret) {
  const sheet = sheets.groupParticipants;
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, GROUP_PARTICIPANT_HEADERS.length)
    .getValues()
    .map(function(row, index) { return participantFromRow_(row, index + 2, includeSecret); })
    .filter(function(participant) { return participant && participant.groupId === groupId; });
}

function scanLatestGroupRows_(sheet, groupId, columnCount, limit) {
  const matches = [];
  let endRow = sheet.getLastRow();
  while (endRow >= 2 && matches.length < limit) {
    const startRow = Math.max(2, endRow - 499);
    const rows = sheet.getRange(startRow, 1, endRow - startRow + 1, columnCount).getValues();
    for (let index = rows.length - 1; index >= 0 && matches.length < limit; index -= 1) {
      if (String(rows[index][0]) === groupId || (columnCount === GROUP_HISTORY_HEADERS.length && String(rows[index][1]) === groupId)) {
        matches.push(rows[index]);
      }
    }
    endRow = startRow - 1;
  }
  return matches.reverse();
}

function messagesForGroup_(sheets, groupId) {
  if (sheets.groupChat.getLastRow() < 2) return [];
  return scanLatestGroupRows_(sheets.groupChat, groupId, GROUP_CHAT_HEADERS.length, GROUP_MESSAGE_LIMIT)
    .map(function(row) {
      return {
        groupId: String(row[0]),
        seq: Number(row[1] || 0),
        id: String(row[2] || ''),
        messageId: String(row[2] || ''),
        actorId: String(row[3] || ''),
        nickname: decodedSafeCell_(row[4]),
        actorRole: String(row[5] || 'member'),
        role: String(row[5] || 'member'),
        body: decodedSafeCell_(row[6]),
        createdAt: isoValue_(row[7])
      };
    });
}

function historyForGroup_(sheets, groupId) {
  if (sheets.groupHistory.getLastRow() < 2) return [];
  const rowsForGroup = [];
  let endRow = sheets.groupHistory.getLastRow();
  while (endRow >= 2 && rowsForGroup.length < GROUP_MESSAGE_LIMIT) {
    const startRow = Math.max(2, endRow - 499);
    const rows = sheets.groupHistory
      .getRange(startRow, 1, endRow - startRow + 1, GROUP_HISTORY_HEADERS.length)
      .getValues();
    for (let index = rows.length - 1; index >= 0 && rowsForGroup.length < GROUP_MESSAGE_LIMIT; index -= 1) {
      const action = String(rows[index][6] || '');
      if (String(rows[index][1] || '') === groupId && !['send_message', 'mark_read'].includes(action)) {
        let mutationResult = {};
        try { mutationResult = JSON.parse(rows[index][13] || '{}'); } catch (error) {}
        if (!mutationResult || mutationResult.pending !== true) rowsForGroup.push(rows[index]);
      }
    }
    endRow = startRow - 1;
  }
  return rowsForGroup.reverse()
    .map(function(row) {
      return {
        id: String(row[0] || ''),
        historyId: String(row[0] || ''),
        entityType: String(row[2] || ''),
        entityId: String(row[3] || ''),
        fromStatus: String(row[4] || ''),
        toStatus: String(row[5] || ''),
        action: String(row[6] || ''),
        actorId: String(row[7] || ''),
        actorRole: String(row[8] || ''),
        reason: decodedSafeCell_(row[9]),
        version: Number(row[11] || 0),
        createdAt: isoValue_(row[12])
      };
    });
}

function snapshotCacheKey_(groupId, generation) {
  return 'group_snapshot_v4_' + groupId + '_' + generation;
}

function snapshotGenerationCacheKey_(groupId) {
  return 'group_snapshot_generation_v4_' + groupId;
}

function invalidateGroupSnapshot_(groupId) {
  let cache;
  const generationKey = snapshotGenerationCacheKey_(groupId);
  try {
    cache = CacheService.getScriptCache();
    cache.put(generationKey, Utilities.getUuid(), 21600);
  } catch (error) {
    // A failed rotation must not deliberately retain a reusable generation.
    try { if (cache) cache.remove(generationKey); } catch (removeError) {}
  }
}

function baseGroupSnapshot_(sheets, groupId) {
  let cache = null;
  let key = '';
  try {
    cache = CacheService.getScriptCache();
    const generation = cache.get(snapshotGenerationCacheKey_(groupId));
    // Readers never recreate an evicted generation: doing so could race with
    // an invalidation and restore an obsolete namespace. A missing generation
    // simply bypasses caching until the next committed mutation rotates it.
    if (generation) {
      key = snapshotCacheKey_(groupId, generation);
      const cached = cache.get(key);
      if (cached) return JSON.parse(cached);
    }
  } catch (error) { cache = null; key = ''; }

  const group = getGroupRecord_(sheets, groupId);
  const merchantSeed = merchantGroupSeed_(publicDealRecord_(sheets.publicDeals, groupId), groupId);
  const merchantAllocations = merchantSeed
    ? activeMerchantAllocationsByActor_(sheets, groupId)
    : null;
  const storedParticipants = getParticipantsForGroup_(sheets, groupId, false).map(function(participant) {
    const copy = Object.assign({}, participant);
    delete copy.rowNumber;
    return copy;
  });
  const participants = merchantSeed
    ? reconcileMerchantGroupParticipants_(storedParticipants, merchantAllocations)
    : storedParticipants;
  const capacityUsage = merchantGroupCapacityUsage_(
    storedParticipants,
    merchantSeed ? merchantAllocations : null
  );
  const currentCount = capacityUsage.participantCount;
  const orderedQuantity = capacityUsage.quantity;
  const paymentActors = groupPaymentActors_(sheets, groupId, storedParticipants);
  const pendingPaymentCount = paymentActors.filter(function(actor) {
    return actor.participantPaymentStatuses.concat(actor.orderPaymentStatuses)
      .some(function(paymentStatus) { return paymentStatus !== 'confirmed'; });
  }).length;
  const snapshot = {
    group: {
      id: group.groupId,
      groupId: group.groupId,
      dealId: group.dealId,
      title: group.title,
      groupStatus: group.groupStatus,
      status: group.groupStatus,
      targetCount: group.targetCount,
      currentCount: currentCount,
      chatLocked: group.chatLocked,
      creatorActorId: group.creatorActorId,
      hostMode: group.hostMode,
      hostActorId: group.hostActorId,
      hostMatched: Boolean(group.hostActorId),
      totalQuantity: group.totalQuantity,
      orderedQuantity: orderedQuantity,
      paymentReady: paymentActors.length > 0 && pendingPaymentCount === 0,
      paymentActorCount: paymentActors.length,
      pendingPaymentCount: pendingPaymentCount,
      lastMessageSeq: group.lastMessageSeq,
      version: group.version,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      updatedBy: group.updatedBy
    },
    participants: participants,
    messages: messagesForGroup_(sheets, groupId),
    history: historyForGroup_(sheets, groupId),
    lastSeq: group.lastMessageSeq,
    limits: { maxParticipants: GROUP_MAX_PARTICIPANTS, visibleMessages: GROUP_MESSAGE_LIMIT }
  };
  try {
    const serialized = JSON.stringify(snapshot);
    // Pin the generation selected before reading. A late reader may finish
    // after invalidation, but its write cannot repopulate the new namespace.
    if (cache && key && serialized.length < 90000) cache.put(key, serialized, 15);
  } catch (error) {}
  return snapshot;
}

function buildGroupSnapshot_(sheets, groupId, actor) {
  const base = baseGroupSnapshot_(sheets, groupId);
  const publicViewer = base.participants.find(function(participant) {
    return participant.actorId === actor.actorId;
  });
  const viewer = publicViewer || actor.participant;
  const lastReadSeq = viewer ? Number(viewer.lastReadSeq || 0) : 0;
  if (!isActiveGroupActor_(actor)) {
    return Object.assign({}, base, {
      participants: publicViewer ? [publicViewer] : [],
      messages: [],
      history: [],
      viewer: {
        actorId: actor.actorId,
        role: actor.role,
        lastReadSeq: lastReadSeq,
        active: false
      },
      unreadCount: 0
    });
  }
  return Object.assign({}, base, {
    viewer: {
      actorId: actor.actorId,
      role: actor.role,
      lastReadSeq: lastReadSeq,
      active: true
    },
    unreadCount: Math.max(0, Number(base.group.lastMessageSeq || 0) - lastReadSeq)
  });
}

function findMutation_(sheets, mutationId, action) {
  const rowNumber = findExactRow_(sheets.groupHistory, 11, mutationId);
  if (!rowNumber) return null;
  const row = sheets.groupHistory.getRange(rowNumber, 1, 1, GROUP_HISTORY_HEADERS.length).getValues()[0];
  if (String(row[6] || '') !== action) throw groupOperationError_('client_mutation_conflict');
  let result = {};
  try { result = JSON.parse(row[13] || '{}'); } catch (error) {}
  return {
    groupId: String(row[1] || ''),
    actorId: String(row[7] || ''),
    rowNumber: rowNumber,
    result: result && typeof result === 'object' && !Array.isArray(result) ? result : {}
  };
}

function groupMutationContract_(action, payload) {
  const contract = {
    action: String(action || ''),
    groupId: String(payload && payload.groupId || ''),
    actorId: String(payload && payload.actorId || '')
  };
  if (action === 'create' || action === 'repair_customer_group') {
    contract.dealId = String(payload.dealId || payload.groupId || '');
    contract.title = String(payload.title || '');
    contract.nickname = String(payload.nickname || '');
    contract.targetCount = Number(payload.targetCount);
    contract.hostMode = String(payload.hostMode || 'self');
    contract.totalQuantity = Number(payload.totalQuantity === undefined
      ? payload.targetCount
      : payload.totalQuantity);
    contract.selectedQuantity = Number(payload.selectedQuantity === undefined
      ? Math.min(1, contract.totalQuantity)
      : payload.selectedQuantity);
  } else if (action === 'recover_legacy_customer_group') {
    contract.dealId = String(payload.dealId || payload.groupId || '');
    contract.receipt = sha256Hex_(
      'legacy-recovery-contract:' + String(payload.legacyEventHash || '')
    ).slice(0, 24);
    contract.capabilityReceipt = sha256Hex_(
      'legacy-recovery-capability:' + String(payload.capabilityHash || '')
    ).slice(0, 24);
  } else if (action === 'join') {
    contract.nickname = String(payload.nickname || '');
    contract.requestedRole = payload.requestedRole === 'admin' ? 'admin' : 'member';
    contract.selectedQuantity = Number(payload.selectedQuantity === undefined
      ? (contract.requestedRole === 'admin' ? 0 : 1)
      : payload.selectedQuantity);
  } else if (action === 'reserve_quantity') {
    contract.quantity = Number(payload.quantity);
    contract.expectedVersion = Number(payload.expectedVersion);
  } else if (action === 'rollback_reservation') {
    contract.reservationMutationId = String(payload.reservationMutationId || '');
    contract.quantity = Number(payload.quantity);
  } else if (action === 'cancel_participation') {
    contract.orderId = String(payload.orderId || '');
    contract.expectedVersion = Number(payload.expectedVersion);
    contract.expectedOrderVersion = Number(payload.expectedOrderVersion);
  } else if (action === 'send_message') {
    contract.body = String(payload.body || '');
  } else if (action === 'mark_read') {
    contract.lastReadSeq = Number(payload.lastReadSeq);
  } else if (action === 'release_host') {
    contract.expectedVersion = Number(payload.expectedVersion);
  } else if (action === 'transition_group') {
    contract.direction = String(payload.direction || '');
    contract.fromStatus = String(payload.fromStatus || '');
    contract.toStatus = String(payload.toStatus || '');
    contract.expectedVersion = Number(payload.expectedVersion);
  } else if (action === 'transition_payment') {
    contract.participantActorId = String(payload.participantActorId || '');
    contract.direction = String(payload.direction || '');
    contract.fromStatus = String(payload.fromStatus || '');
    contract.toStatus = String(payload.toStatus || '');
    contract.expectedVersion = Number(payload.expectedVersion);
    contract.reason = String(payload.reason || '');
  } else if (action === 'update_target') {
    contract.targetCount = Number(payload.targetCount);
    contract.expectedVersion = Number(payload.expectedVersion);
  } else if (action === 'toggle_lock') {
    contract.locked = payload.locked === true;
    contract.expectedVersion = Number(payload.expectedVersion);
  }
  return JSON.stringify(contract);
}

function appendGroupHistory_(sheets, data) {
  sheets.groupHistory.appendRow([
    Utilities.getUuid(), safeCell_(data.groupId), safeCell_(data.entityType || ''),
    safeCell_(data.entityId || ''), safeCell_(data.fromStatus || ''), safeCell_(data.toStatus || ''),
    safeCell_(data.action || ''), safeCell_(data.actorId || ''), safeCell_(data.actorRole || ''),
    safeCell_(data.reason || ''), safeCell_(data.clientMutationId || ''), Number(data.version || 0),
    data.createdAt || new Date().toISOString(), JSON.stringify(data.result || { ok: true })
  ]);
  return typeof sheets.groupHistory.getLastRow === 'function'
    ? sheets.groupHistory.getLastRow()
    : 0;
}

function appendParticipant_(sheets, data) {
  sheets.groupParticipants.appendRow([
    safeCell_(data.groupId), safeCell_(data.actorId), safeCell_(data.nickname), safeCell_(data.role),
    Boolean(data.counted), safeCell_(data.paymentStatus || 'pending'), Number(data.lastReadSeq || 0),
    safeCell_(data.capabilityHash || ''), Number(data.version || 1), data.joinedAt, data.updatedAt,
    Number(data.selectedQuantity || 0)
  ]);
}

function updateParticipantRow_(sheets, participant) {
  sheets.groupParticipants.getRange(participant.rowNumber, 1, 1, GROUP_PARTICIPANT_HEADERS.length).setValues([[
    safeCell_(participant.groupId), safeCell_(participant.actorId), safeCell_(participant.nickname), safeCell_(participant.role),
    Boolean(participant.counted), safeCell_(participant.paymentStatus), Number(participant.lastReadSeq || 0),
    safeCell_(participant.capabilityHash || ''), Number(participant.version || 1), participant.joinedAt, participant.updatedAt,
    Number(participant.selectedQuantity || 0)
  ]]);
}

function updateGroupRow_(sheets, group) {
  sheets.groups.getRange(group.rowNumber, 1, 1, GROUP_HEADERS.length).setValues([[
    safeCell_(group.groupId), safeCell_(group.dealId), safeCell_(group.title), safeCell_(group.groupStatus),
    Number(group.targetCount), Boolean(group.chatLocked), safeCell_(group.hostActorId),
    Number(group.lastMessageSeq || 0), Number(group.version || 1), group.createdAt, group.updatedAt,
    safeCell_(group.updatedBy || ''), safeCell_(group.creatorActorId || group.hostActorId || ''),
    safeCell_(group.hostMode === 'recruiting' ? 'recruiting' : 'self'), Number(group.totalQuantity || 1)
  ]]);
}

function getCustomerOrderRecord_(sheets, orderIdValue) {
  const orderId = groupText_(orderIdValue, 40);
  if (!/^order-\d{10,20}$/.test(orderId)) throw groupOperationError_('invalid_order_id');
  const rowNumber = findExactRow_(sheets.customerOrders, 2, orderId);
  if (!rowNumber) throw groupOperationError_('order_not_found');
  let order;
  try {
    order = JSON.parse(sheets.customerOrders.getRange(rowNumber, 4).getValue() || '{}');
  } catch (error) {
    throw groupOperationError_('invalid_order_record');
  }
  if (!order || typeof order !== 'object' || Array.isArray(order) || String(order.id || '') !== orderId) {
    throw groupOperationError_('invalid_order_record');
  }
  return { rowNumber: rowNumber, order: order };
}

function authorizeCustomerOrderCancellation_(sheets, record, payload, actorId, group) {
  const order = record.order;
  const suppliedHash = privateCapabilityHash_(
    payload.customerCapabilityHash,
    'invalid_customer_capability'
  );
  const storedHash = String(order._customerCapabilityHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(storedHash)) {
    throw groupOperationError_('order_ownership_unclaimable');
  }
  if (storedHash !== suppliedHash) throw groupOperationError_('forbidden');
  if (String(order.visitorId || '') !== actorId) throw groupOperationError_('order_owner_conflict');
  const orderGroupId = String(order.groupId || '');
  const orderDealId = String(order.dealId || (order.deal && order.deal.id) || '');
  const participantActorId = String(order.participantActorId || order.visitorId || '');
  if (
    orderGroupId !== group.groupId
    || orderDealId !== group.dealId
    || participantActorId !== actorId
    || String(order.type || '') !== 'purchase'
  ) {
    throw groupOperationError_('order_owner_conflict');
  }
  const reservationMutationId = String(order._reservationMutationId || '');
  const reservationAction = String(order._reservationAction || '');
  const reservationQuantity = Number(order._reservationQuantity || 0);
  if (!reservationMutationId || !['join', 'reserve_quantity'].includes(reservationAction)
    || !Number.isInteger(reservationQuantity) || reservationQuantity < 1
    || String(order.reservationMutationId || '') !== reservationMutationId
    || Number(order.reservationQuantity || 0) !== reservationQuantity) {
    throw groupOperationError_('order_reservation_unverified');
  }
  const reservationHistory = customerOrderReservationHistory_(sheets, group.groupId, actorId);
  const reservation = reservationHistory.find(function(item) {
    return item.mutationId === reservationMutationId && item.action === reservationAction;
  });
  if (!reservation
    || !activeCustomerOrderReservation_(reservation, reservationHistory)
    || customerOrderReservationQuantity_(reservation, reservationHistory, reservationQuantity) !== reservationQuantity) {
    throw groupOperationError_('order_reservation_unverified');
  }
  const conflictingBindings = boundCustomerOrderReservations_(sheets.customerOrders, order.id);
  if (conflictingBindings[reservationMutationId]) {
    throw groupOperationError_('order_reservation_conflict');
  }
  return order;
}

function updateCustomerOrderRecord_(sheets, record) {
  const order = record.order;
  const serialized = JSON.stringify(order);
  if (serialized.length > 30000) throw groupOperationError_('order_too_large');
  sheets.customerOrders.getRange(record.rowNumber, 1, 1, CUSTOMER_ORDER_HEADERS.length).setValues([[
    new Date(), safeCell_(order.id), safeCell_(normalizePhone_(order.customerPhone)), serialized
  ]]);
}

function plainMutationRecord_(value) {
  const copy = Object.assign({}, value || {});
  delete copy.rowNumber;
  return copy;
}

function mutationRecordMatches_(current, target, fields) {
  return (fields || []).every(function(field) {
    if (typeof target[field] === 'boolean') return Boolean(current[field]) === target[field];
    if (typeof target[field] === 'number') return Number(current[field] || 0) === target[field];
    return String(current[field] || '') === String(target[field] || '');
  });
}

function appendGroupRecord_(sheets, group) {
  sheets.groups.appendRow([
    safeCell_(group.groupId), safeCell_(group.dealId), safeCell_(group.title), safeCell_(group.groupStatus),
    Number(group.targetCount), Boolean(group.chatLocked), safeCell_(group.hostActorId),
    Number(group.lastMessageSeq || 0), Number(group.version || 1), group.createdAt, group.updatedAt,
    safeCell_(group.updatedBy || ''), safeCell_(group.creatorActorId || group.hostActorId || ''),
    safeCell_(group.hostMode === 'recruiting' ? 'recruiting' : 'self'), Number(group.totalQuantity || 1)
  ]);
}

function applyGroupRepairOperation_(sheets, operation) {
  const target = operation && operation.target;
  if (!operation || !target) throw groupOperationError_('invalid_mutation_intent');
  if (operation.type === 'group_append') {
    const existing = findExactRow_(sheets.groups, 1, target.groupId)
      ? getGroupRecord_(sheets, target.groupId)
      : null;
    if (!existing) {
      appendGroupRecord_(sheets, target);
      return;
    }
    if (!mutationRecordMatches_(existing, target, [
      'groupId', 'dealId', 'groupStatus', 'targetCount', 'hostActorId', 'version',
      'creatorActorId', 'hostMode', 'totalQuantity'
    ])) throw groupOperationError_('state_conflict');
    return;
  }
  if (operation.type === 'participant_append') {
    const existing = getParticipantRecord_(sheets, target.groupId, target.actorId, false);
    if (!existing) {
      appendParticipant_(sheets, target);
      return;
    }
    if (!mutationRecordMatches_(existing, target, [
      'groupId', 'actorId', 'nickname', 'role', 'counted', 'paymentStatus',
      'lastReadSeq', 'capabilityHash', 'version', 'selectedQuantity'
    ])) throw groupOperationError_('state_conflict');
    return;
  }
  if (operation.type === 'group_update') {
    if (!sheets.groups) {
      updateGroupRow_(sheets, target);
      return;
    }
    const existing = getGroupRecord_(sheets, target.groupId);
    if (Number(existing.version || 0) === Number(target.version || 0)) {
      if (!mutationRecordMatches_(existing, target, [
        'groupId', 'dealId', 'groupStatus', 'targetCount', 'chatLocked', 'hostActorId',
        'lastMessageSeq', 'version', 'creatorActorId', 'hostMode', 'totalQuantity'
      ])) throw groupOperationError_('state_conflict');
      return;
    }
    if (Number(existing.version || 0) !== Number(operation.beforeVersion || 0)) {
      throw groupOperationError_('state_conflict');
    }
    updateGroupRow_(sheets, Object.assign({}, target, { rowNumber: existing.rowNumber }));
    return;
  }
  if (operation.type === 'group_message_update') {
    if (!sheets.groups) {
      updateGroupRow_(sheets, target);
      return;
    }
    const existing = getGroupRecord_(sheets, target.groupId);
    if (Number(existing.lastMessageSeq || 0) === Number(target.lastMessageSeq || 0)) return;
    if (Number(existing.lastMessageSeq || 0) !== Number(operation.beforeSeq || 0)) {
      throw groupOperationError_('state_conflict');
    }
    updateGroupRow_(sheets, Object.assign({}, target, { rowNumber: existing.rowNumber }));
    return;
  }
  if (operation.type === 'participant_update') {
    if (!sheets.groupParticipants) {
      updateParticipantRow_(sheets, target);
      return;
    }
    const existing = getParticipantRecord_(sheets, target.groupId, target.actorId, true);
    if (Number(existing.version || 0) === Number(target.version || 0)) {
      if (!mutationRecordMatches_(existing, target, [
        'groupId', 'actorId', 'role', 'counted', 'paymentStatus', 'lastReadSeq',
        'capabilityHash', 'version', 'selectedQuantity'
      ])) throw groupOperationError_('state_conflict');
      return;
    }
    if (Number(existing.version || 0) !== Number(operation.beforeVersion || 0)) {
      throw groupOperationError_('state_conflict');
    }
    updateParticipantRow_(sheets, Object.assign({}, target, { rowNumber: existing.rowNumber }));
    return;
  }
  if (operation.type === 'participant_read_update') {
    if (!sheets.groupParticipants) {
      updateParticipantRow_(sheets, target);
      return;
    }
    const existing = getParticipantRecord_(sheets, target.groupId, target.actorId, true);
    if (Number(existing.lastReadSeq || 0) >= Number(target.lastReadSeq || 0)) return;
    if (Number(existing.lastReadSeq || 0) !== Number(operation.beforeSeq || 0)) {
      throw groupOperationError_('state_conflict');
    }
    updateParticipantRow_(sheets, Object.assign({}, target, { rowNumber: existing.rowNumber }));
    return;
  }
  if (operation.type === 'order_update') {
    if (!sheets.customerOrders) {
      updateCustomerOrderRecord_(sheets, { order: target, rowNumber: operation.rowNumber || 0 });
      return;
    }
    const record = getCustomerOrderRecord_(sheets, target.id);
    const currentVersion = secureOrderVersion_(record.order);
    const targetVersion = secureOrderVersion_(target);
    if (currentVersion === targetVersion) {
      if (!mutationRecordMatches_(record.order, target, [
        'id', 'status', 'paymentStatus', 'version', 'paymentVersion', 'cancelledAt',
        'paymentRequestedAt', 'paymentConfirmedAt', 'statusUpdatedAt',
        'total', 'hostRemainderApplied'
      ])) throw groupOperationError_('state_conflict');
      return;
    }
    if (currentVersion !== Number(operation.beforeVersion || 0)) {
      throw groupOperationError_('state_conflict');
    }
    record.order = target;
    updateCustomerOrderRecord_(sheets, record);
    return;
  }
  if (operation.type === 'payment_orders_update') {
    const plan = planGroupPaymentOrders_(
      sheets,
      target.groupId,
      target.participantActorId,
      target.fromStatus,
      target.toStatus,
      target.actorId,
      target.actorRole,
      target.clientMutationId,
      target.updatedAt,
      target.recoverBindings === true
    );
    if (Array.isArray(target.expectedOrderIds)) {
      const expectedIds = target.expectedOrderIds.map(String).sort();
      const currentIds = plan.records.map(function(record) { return String(record.order.id); }).sort();
      if (JSON.stringify(expectedIds) !== JSON.stringify(currentIds)) {
        throw groupOperationError_('order_payment_link_required');
      }
      if (plan.records.some(function(record) {
        return String(record.order.paymentStatus || 'pending') !== String(target.toStatus);
      })) throw groupOperationError_('order_payment_state_conflict');
    }
    plan.changedRecords.forEach(function(record) {
      updateCustomerOrderRecord_(sheets, record);
      try {
        appendCustomerOrderSnapshotEvent_(
          sheets.events,
          record.order,
          String(record.order._customerCapabilityHash || '')
        );
      } catch (error) {}
    });
    return;
  }
  if (operation.type === 'chat_append') {
    const existingRow = findExactRow_(sheets.groupChat, 9, operation.clientMutationId);
    if (existingRow) {
      const row = sheets.groupChat.getRange(existingRow, 1, 1, GROUP_CHAT_HEADERS.length).getValues()[0];
      if (String(row[0] || '') !== String(target.groupId || '')
        || String(row[3] || '') !== String(target.actorId || '')
        || decodedSafeCell_(row[6]) !== String(target.body || '')) {
        throw groupOperationError_('client_mutation_conflict');
      }
      return;
    }
    sheets.groupChat.appendRow([
      safeCell_(target.groupId), Number(target.seq), safeCell_(target.messageId), safeCell_(target.actorId),
      safeCell_(target.nickname), safeCell_(target.actorRole), safeCell_(target.body), target.createdAt,
      safeCell_(operation.clientMutationId)
    ]);
    return;
  }
  throw groupOperationError_('invalid_mutation_intent');
}

function updateGroupMutationResult_(sheets, rowNumber, result) {
  if (!rowNumber || !sheets.groupHistory || typeof sheets.groupHistory.getRange !== 'function') return;
  const range = sheets.groupHistory.getRange(rowNumber, 14);
  if (range && typeof range.setValue === 'function') {
    range.setValue(JSON.stringify(result || {}));
  } else if (range && typeof range.setValues === 'function') {
    range.setValues([[JSON.stringify(result || {})]]);
  }
}

function beginGroupMutationIntent_(sheets, history, mutationContract, completionResult, operations) {
  const completed = Object.assign({}, completionResult || {}, { mutationContract: mutationContract });
  return appendGroupHistory_(sheets, Object.assign({}, history, {
    result: Object.assign({}, completed, {
      pending: true,
      mutationContract: mutationContract,
      completionResult: completed,
      repair: { operations: operations || [] }
    })
  }));
}

function finishGroupMutationIntent_(sheets, rowNumber, completionResult) {
  updateGroupMutationResult_(sheets, rowNumber, Object.assign({}, completionResult || {}, { pending: false }));
}

function commitGroupMutationIntent_(sheets, history, mutationContract, completionResult, operations) {
  (operations || []).forEach(function(operation) {
    if (operation && operation.type === 'order_update') {
      const serialized = JSON.stringify(operation.target || {});
      if (serialized.length > 30000) throw groupOperationError_('order_too_large');
    }
  });
  const intentPayload = {
    pending: true,
    mutationContract: mutationContract,
    completionResult: completionResult || {},
    repair: { operations: operations || [] }
  };
  if (JSON.stringify(intentPayload).length > 45000) {
    throw groupOperationError_('mutation_intent_too_large');
  }
  const rowNumber = beginGroupMutationIntent_(
    sheets,
    history,
    mutationContract,
    completionResult,
    operations
  );
  (operations || []).forEach(function(operation) {
    applyGroupRepairOperation_(sheets, operation);
  });
  finishGroupMutationIntent_(sheets, rowNumber, Object.assign({}, completionResult || {}, {
    mutationContract: mutationContract
  }));
  return rowNumber;
}

function repairPendingGroupMutation_(sheets, mutation) {
  const result = mutation && mutation.result || {};
  if (!result.pending) return result;
  const operations = result.repair && Array.isArray(result.repair.operations)
    ? result.repair.operations
    : [];
  operations.forEach(function(operation) { applyGroupRepairOperation_(sheets, operation); });
  const completed = Object.assign({}, result.completionResult || {}, {
    mutationContract: result.mutationContract || (result.completionResult && result.completionResult.mutationContract),
    pending: false
  });
  finishGroupMutationIntent_(sheets, mutation.rowNumber, completed);
  mutation.result = completed;
  invalidateGroupSnapshot_(mutation.groupId);
  invalidatePublicDealsCache_();
  return completed;
}

function repairPendingGroupMutations_(sheets, groupId) {
  const history = sheets && sheets.groupHistory;
  if (!history || typeof history.getLastRow !== 'function' || typeof history.getRange !== 'function') return;
  const lastRow = history.getLastRow();
  if (lastRow < 2) return;
  const groupColumn = history.getRange(2, 2, lastRow - 1, 1);
  const groupMatches = typeof groupColumn.createTextFinder === 'function'
    ? groupColumn
      .createTextFinder(String(groupId || ''))
      .matchEntireCell(true)
      .findAll()
    : groupColumn.getValues().reduce(function(matches, row, index) {
      if (String(row[0] || '') === String(groupId || '')) {
        matches.push({ getRow: function() { return index + 2; } });
      }
      return matches;
    }, []);
  const rowNumbers = (groupMatches || [])
    .map(function(match) { return Number(match.getRow()); })
    .filter(function(rowNumber) { return rowNumber >= 2; })
    .sort(function(left, right) { return left - right; })
    .filter(function(rowNumber, index, rows) { return index === 0 || rowNumber !== rows[index - 1]; });
  // Completed chat/read receipts also live in this sheet. Reading each receipt
  // separately held the global mutation lock for one network round trip per
  // historical action. Use bounded reads without caching across mutations or
  // including another group's neighboring intents in the repair loop.
  let index = 0;
  while (index < rowNumbers.length) {
    const startRow = rowNumbers[index];
    let endIndex = index;
    while (endIndex + 1 < rowNumbers.length && rowNumbers[endIndex + 1] - startRow < 100) endIndex += 1;
    const values = history.getRange(startRow, 14, rowNumbers[endIndex] - startRow + 1, 1).getValues();
    for (; index <= endIndex; index += 1) {
      const rowNumber = rowNumbers[index];
      let result = {};
      try { result = JSON.parse(values[rowNumber - startRow][0] || '{}'); } catch (error) {}
      if (!result || result.pending !== true) continue;
      repairPendingGroupMutation_(sheets, {
        groupId: String(groupId || ''), rowNumber: rowNumber, result: result
      });
    }
  }
}

function ensureAdminParticipant_(sheets, groupId, actor, lastReadSeq, now) {
  if (actor.participant) return actor.participant;
  appendParticipant_(sheets, {
    groupId: groupId, actorId: actor.actorId, nickname: '관리자', role: 'admin', counted: false,
    paymentStatus: 'pending', lastReadSeq: lastReadSeq || 0, capabilityHash: '', version: 1,
    joinedAt: now, updatedAt: now
  });
  actor.participant = getParticipantRecord_(sheets, groupId, actor.actorId, true);
  return actor.participant;
}

function merchantGroupSeed_(deal, groupId) {
  if (!deal || String(deal.id || '') !== String(groupId || '')
    || String(deal.source || '') !== 'merchant'
    || String(deal.saleType || '') !== 'group') return null;
  const totalQuantity = Math.floor(Number(
    deal.totalQuantity || deal.productQuantity || deal.target || 0
  ));
  if (!Number.isInteger(totalQuantity) || totalQuantity < 1 || totalQuantity > 999) return null;
  const requestedTarget = Math.floor(Number(
    deal.targetCount || deal.maxPeople || Math.min(totalQuantity, GROUP_MAX_PARTICIPANTS)
  ));
  const targetCount = Math.max(1, Math.min(GROUP_MAX_PARTICIPANTS, requestedTarget || 1));
  return {
    groupId: String(groupId),
    dealId: String(groupId),
    title: groupText_(deal.title, 120) || '사장님 공동구매',
    targetCount: targetCount,
    totalQuantity: totalQuantity,
    creatorActorId: groupText_(deal.creatorActorId, 128) || ('merchant-' + String(groupId))
  };
}

function ensureMerchantGroupForJoin_(sheets, groupId, now, dealValue) {
  if (findExactRow_(sheets.groups, 1, groupId)) return true;
  const activeDeal = dealValue && String(dealValue.visibility || '') === 'public'
    ? dealValue
    : activePublicDealRecord_(sheets.publicDeals, groupId);
  const seed = merchantGroupSeed_(activeDeal, groupId);
  if (!seed) return false;
  const activeAllocations = activeMerchantAllocationsByActor_(sheets, groupId);
  const capacityUsage = merchantGroupCapacityUsage_([], activeAllocations);
  if (capacityUsage.quantity > seed.totalQuantity) {
    throw groupOperationError_('quantity_exceeds_total');
  }
  if (capacityUsage.participantCount > seed.targetCount) {
    throw groupOperationError_('group_full');
  }
  sheets.groups.appendRow([
    safeCell_(seed.groupId), safeCell_(seed.dealId), safeCell_(seed.title), GROUP_STATUSES[0],
    seed.targetCount, false, '', 0, 1, now, now, safeCell_(seed.creatorActorId),
    safeCell_(seed.creatorActorId), 'recruiting', seed.totalQuantity
  ]);
  appendGroupHistory_(sheets, {
    groupId: seed.groupId, entityType: 'group', entityId: seed.groupId,
    fromStatus: '', toStatus: GROUP_STATUSES[0], action: 'merchant_group_provisioned',
    actorId: seed.creatorActorId, actorRole: 'creator', version: 1, createdAt: now
  });
  invalidateGroupSnapshot_(groupId);
  return true;
}

function executeGroupMutation_(action, payload, sheets) {
  let recoveryEventHash = '';
  if (action === 'recover_legacy_customer_group') {
    recoveryEventHash = requireLegacyRecoveryManifestEntry_(payload);
    payload.clientMutationId = legacyRecoveryMutationId_(recoveryEventHash);
  }
  const mutationId = requireMutationId_(payload.clientMutationId);
  const groupId = requireGroupId_(payload.groupId, 'group_id');
  const actorId = requireGroupId_(payload.actorId, 'actor_id');
  if (action === 'join' && payload.requestedRole !== 'admin') {
    const requestedQuantity = requireInteger_(
      payload.selectedQuantity === undefined ? 1 : payload.selectedQuantity,
      'selected_quantity',
      0,
      999
    );
    // Do not recreate the legacy merchant zero-quantity membership path. It
    // authorized only by caller-selected actor id and could issue a fresh
    // participant capability for an existing customer's order actor. Existing
    // migrated participants and their host-claim path remain unchanged.
    if (requestedQuantity === 0) throw groupOperationError_('invalid_quantity');
  }
  const mutationContract = groupMutationContract_(action, payload);
  const mutationResult = function(result) {
    return Object.assign({}, result || {}, { mutationContract: mutationContract });
  };
  repairPendingMerchantDealPublish_(sheets, groupId);
  // A previous request may have committed only part of a multi-sheet change.
  // Repair it under the same script lock before accepting any newer mutation.
  repairPendingGroupMutations_(sheets, groupId);
  const duplicate = findMutation_(sheets, mutationId, action);
  if (duplicate) {
    if (duplicate.groupId !== groupId || duplicate.actorId !== actorId) {
      throw groupOperationError_('client_mutation_conflict');
    }
    if (duplicate.result.mutationContract
      && String(duplicate.result.mutationContract) !== mutationContract) {
      throw groupOperationError_('client_mutation_conflict');
    }
    if (duplicate.result && duplicate.result.pending === true) {
      repairPendingGroupMutation_(sheets, duplicate);
    }
    const duplicateActor = authorizeGroupActor_(sheets, groupId, payload);
    if (![
      'create', 'repair_customer_group', 'recover_legacy_customer_group',
      'join', 'reserve_quantity', 'rollback_reservation', 'cancel_participation'
    ].includes(action)) {
      requireActiveGroupActor_(duplicateActor);
    }
    if (action === 'cancel_participation') {
      const duplicateOrderId = groupText_(duplicate.result && duplicate.result.orderId, 40);
      const requestedOrderId = groupText_(payload.orderId, 40);
      if (!duplicateOrderId || duplicateOrderId !== requestedOrderId) {
        throw groupOperationError_('client_mutation_conflict');
      }
      const duplicateGroup = getGroupRecord_(sheets, groupId);
      const duplicateRecord = getCustomerOrderRecord_(sheets, requestedOrderId);
      authorizeCustomerOrderCancellation_(sheets, duplicateRecord, payload, actorId, duplicateGroup);
      return { actor: duplicateActor, duplicate: true, order: duplicateRecord.order };
    }
    const duplicateAdjustedOrderId = groupText_(
      duplicate.result && duplicate.result.adjustedOrderId,
      40
    );
    if (action === 'transition_payment') {
      const paymentGroup = getGroupRecord_(sheets, groupId);
      const paymentParticipant = getParticipantRecord_(sheets, groupId, payload.participantActorId, true);
      if (actorId !== paymentParticipant.actorId) requireManager_(duplicateActor, paymentGroup);
      const paymentRecords = plannedGroupPaymentOrderRecords_(sheets, groupId, paymentParticipant.actorId);
      // A pre-fix receipt may say success despite having updated no order.
      // Replaying it must not perpetuate that false success or mutate the old
      // receipt into a newly authorized financial operation.
      if (!paymentRecords.length && groupPaymentRequiresOrder_(sheets, paymentGroup, paymentParticipant)) {
        throw groupOperationError_('order_payment_link_required');
      }
      const paymentRecord = paymentRecords.find(function(record) {
        return String(record.order.id || '') === duplicateAdjustedOrderId;
      }) || paymentRecords[0];
      return {
        actor: duplicateActor, duplicate: true,
        order: !paymentRecord ? undefined
          : (String(paymentRecord.order.paymentStatus || 'pending') === paymentParticipant.paymentStatus
            ? paymentRecord.order
            : projectOrderPaymentFromParticipant_(paymentRecord.order, paymentParticipant))
      };
    }
    if (['claim_host', 'release_host'].includes(action)
      && /^order-\d{10,20}$/.test(duplicateAdjustedOrderId)) {
      return {
        actor: duplicateActor,
        duplicate: true,
        order: getCustomerOrderRecord_(sheets, duplicateAdjustedOrderId).order
      };
    }
    return { actor: duplicateActor, duplicate: true };
  }

  const now = new Date().toISOString();
  let roleAdjustedOrder = null;
  if (action === 'recover_legacy_customer_group') {
    const dealId = requireGroupId_(payload.dealId, 'deal_id');
    if (dealId !== groupId || findExactRow_(sheets.groups, 1, groupId)) {
      throw legacyRecoveryDenied_();
    }
    const deal = eligibleLegacyRecoveryDeal_(sheets, dealId, actorId);
    const nickname = groupText_(payload.nickname, 40);
    if (!deal || !nickname) throw legacyRecoveryDenied_();
    let hash;
    try { hash = requireCapabilityHash_(payload.capabilityHash); } catch (error) {
      throw legacyRecoveryDenied_();
    }
    let canonical;
    try {
      canonical = canonicalLegacyRecoveryGroup_(deal, actorId, nickname, hash, now);
    } catch (error) {
      throw legacyRecoveryDenied_();
    }
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'group', entityId: groupId,
      fromStatus: '', toStatus: GROUP_STATUSES[0], action: action,
      actorId: actorId, actorRole: canonical.role, clientMutationId: mutationId,
      version: 1, createdAt: now
    }, mutationContract, mutationResult(), [
      { type: 'group_append', target: plainMutationRecord_(canonical.group) },
      { type: 'participant_append', target: plainMutationRecord_(canonical.participant) }
    ]);
    invalidateGroupSnapshot_(groupId);
    return { actor: { actorId: actorId, role: canonical.role }, duplicate: false };
  }
  if (action === 'create' || action === 'repair_customer_group') {
    if (findExactRow_(sheets.groups, 1, groupId)) throw groupOperationError_('group_exists');
    const dealId = requireGroupId_(payload.dealId, 'deal_id');
    if (dealId !== groupId) throw groupOperationError_('invalid_group_deal_binding');
    // Merchant groups are seeded from the verified owner-* public deal in the
    // join path. A public create capability must never claim that namespace.
    if (!/^customer-[a-zA-Z0-9-]{1,100}$/.test(groupId)) {
      throw groupOperationError_('invalid_customer_group_id');
    }
    const existingPublicDeal = activePublicDealRecord_(sheets.publicDeals, groupId);
    if (action === 'repair_customer_group') {
      requireCustomerDealOwnerCapability_(existingPublicDeal, groupId, payload.ownerCapabilityHash);
    } else if (existingPublicDeal) {
      // A public customer deal without a central group can only be restored by
      // proving the owner capability stored with that exact deal. Plain create
      // must not let another browser claim a visible orphan id.
      throw groupOperationError_('deal_owner_proof_required');
    }
    const title = groupText_(payload.title, 120);
    const nickname = groupText_(payload.nickname, 40);
    const targetCount = requireInteger_(payload.targetCount, 'target_count', 1, GROUP_MAX_PARTICIPANTS);
    const hostMode = String(payload.hostMode || 'self');
    if (hostMode !== 'self' && hostMode !== 'recruiting') {
      throw groupOperationError_('invalid_host_mode');
    }
    const totalQuantity = requireInteger_(
      payload.totalQuantity === undefined ? targetCount : payload.totalQuantity,
      'total_quantity',
      1,
      999
    );
    const selectedQuantity = requireInteger_(
      payload.selectedQuantity === undefined ? Math.min(1, totalQuantity) : payload.selectedQuantity,
      'selected_quantity',
      0,
      totalQuantity
    );
    if (!title) throw groupOperationError_('invalid_title');
    if (!nickname) throw groupOperationError_('invalid_nickname');
    const role = hostMode === 'recruiting' ? 'creator' : 'host';
    const hostActorId = role === 'host' ? actorId : '';
    const hash = requireCapabilityHash_(payload.capabilityHash);
    const createdGroup = {
      groupId: groupId, dealId: dealId, title: title, groupStatus: GROUP_STATUSES[0],
      targetCount: targetCount, chatLocked: false, hostActorId: hostActorId,
      lastMessageSeq: 0, version: 1, createdAt: now, updatedAt: now,
      updatedBy: actorId, creatorActorId: actorId, hostMode: hostMode,
      totalQuantity: totalQuantity
    };
    const createdParticipant = {
      groupId: groupId, actorId: actorId, nickname: nickname, role: role, counted: role !== 'admin',
      paymentStatus: 'pending', lastReadSeq: 0, capabilityHash: hash, version: 1,
      joinedAt: now, updatedAt: now, selectedQuantity: selectedQuantity
    };
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'group', entityId: groupId, fromStatus: '', toStatus: GROUP_STATUSES[0],
      action: action, actorId: actorId, actorRole: role, clientMutationId: mutationId, version: 1, createdAt: now
    }, mutationContract, mutationResult(), [
      { type: 'group_append', target: plainMutationRecord_(createdGroup) },
      { type: 'participant_append', target: plainMutationRecord_(createdParticipant) }
    ]);
    invalidateGroupSnapshot_(groupId);
    return { actor: { actorId: actorId, role: role }, duplicate: false };
  }

  if (action === 'join') {
    const activeDeal = activePublicDealRecord_(sheets.publicDeals, groupId);
    if (!activeDeal) throw groupOperationError_('deal_not_found');
    if (!findExactRow_(sheets.groups, 1, groupId)
      && !ensureMerchantGroupForJoin_(sheets, groupId, now, activeDeal)) {
      throw groupOperationError_('group_not_found');
    }
    const group = getGroupRecord_(sheets, groupId);
    if (getParticipantRecord_(sheets, groupId, actorId, false)) throw groupOperationError_('actor_already_joined');
    const nickname = groupText_(payload.nickname, 40);
    if (!nickname) throw groupOperationError_('invalid_nickname');
    const role = payload.requestedRole === 'admin' ? 'admin' : 'member';
    if (role === 'admin' && payload.adminAssertion !== true) throw groupOperationError_('forbidden');
    if (role !== 'admin' && group.groupStatus !== GROUP_STATUSES[0]) {
      throw groupOperationError_('group_not_recruiting');
    }
    const participants = getParticipantsForGroup_(sheets, groupId, false);
    const counted = role !== 'admin';
    const selectedQuantity = counted
      ? requireInteger_(payload.selectedQuantity === undefined ? 1 : payload.selectedQuantity, 'selected_quantity', 1, 999)
      : 0;
    const merchantSeed = merchantGroupSeed_(activeDeal, groupId);
    const activeMerchantAllocations = merchantSeed
      ? activeMerchantAllocationsByActor_(sheets, groupId)
      : null;
    const capacityUsage = merchantGroupCapacityUsage_(
      participants,
      merchantSeed ? activeMerchantAllocations : null
    );
    const actorActiveOrderQuantity = counted ? Math.max(
      0,
      Number(capacityUsage.actors[actorId]
        && capacityUsage.actors[actorId].activeOrderQuantity || 0)
    ) : 0;
    // An order actor id is visible in merchant-facing order data and is not a
    // credential. Never mint a new participant capability merely because a
    // caller presents an actor id that already owns a legacy order allocation.
    // New purchases reserve membership before their order is published, so an
    // order-only actor must use an explicit, separately verified migration.
    if (counted && actorActiveOrderQuantity > 0) {
      throw groupOperationError_('order_actor_claim_requires_proof');
    }
    const actorAlreadyAllocated = Boolean(capacityUsage.actors[actorId]);
    if (counted && !actorAlreadyAllocated
      && (capacityUsage.participantCount >= GROUP_MAX_PARTICIPANTS
        || capacityUsage.participantCount >= group.targetCount)) {
      throw groupOperationError_('group_full');
    }
    if (capacityUsage.quantity + selectedQuantity > group.totalQuantity) {
      throw groupOperationError_('quantity_exceeds_total');
    }
    const hash = requireCapabilityHash_(payload.capabilityHash);
    const joinedParticipant = {
      groupId: groupId, actorId: actorId, nickname: nickname, role: role, counted: counted,
      paymentStatus: 'pending', lastReadSeq: group.lastMessageSeq, capabilityHash: hash, version: 1,
      joinedAt: now, updatedAt: now, selectedQuantity: selectedQuantity
    };
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'participant', entityId: actorId, fromStatus: '', toStatus: 'joined',
      action: action, actorId: actorId, actorRole: role, clientMutationId: mutationId, version: 1, createdAt: now
    }, mutationContract, mutationResult(), [
      { type: 'participant_append', target: plainMutationRecord_(joinedParticipant) }
    ]);
    invalidateGroupSnapshot_(groupId);
    return { actor: { actorId: actorId, role: role }, duplicate: false };
  }

  const actor = authorizeGroupActor_(sheets, groupId, payload);
  const group = getGroupRecord_(sheets, groupId);
  if (!['reserve_quantity', 'rollback_reservation'].includes(action)) {
    requireActiveGroupActor_(actor);
  }

  if (action === 'claim_host') {
    const participant = actor.participant;
    if (!participant || !participant.counted || !['creator', 'member', 'host'].includes(participant.role)) {
      throw groupOperationError_('forbidden');
    }
    if (group.hostActorId) {
      if (group.hostActorId !== actorId || participant.role !== 'host') {
        throw groupOperationError_('host_already_claimed');
      }
      const existingHostRemainderPlan = planHostRemainderOrders_(
        sheets, group, actorId, true, mutationId, now
      );
      const existingHostOperations = existingHostRemainderPlan.changedRecords.map(function(record) {
        return {
          type: 'order_update',
          beforeVersion: record.beforeVersion,
          target: plainMutationRecord_(record.order)
        };
      });
      commitGroupMutationIntent_(sheets, {
        groupId: groupId, entityType: 'host', entityId: actorId,
        fromStatus: 'claimed', toStatus: 'claimed', action: action,
        actorId: actorId, actorRole: 'host', clientMutationId: mutationId,
        version: group.version, createdAt: now
      }, mutationContract, mutationResult({
        unchanged: existingHostRemainderPlan.changedRecords.length === 0,
        reconciled: existingHostRemainderPlan.changedRecords.length > 0,
        adjustedOrderId: existingHostRemainderPlan.order && existingHostRemainderPlan.order.id || '',
        hostRemainderApplied: existingHostRemainderPlan.remainder
      }), existingHostOperations);
      roleAdjustedOrder = existingHostRemainderPlan.order;
      invalidateGroupSnapshot_(groupId);
      return {
        actor: actor,
        duplicate: false,
        unchanged: existingHostRemainderPlan.changedRecords.length === 0,
        order: roleAdjustedOrder
      };
    }
    if (group.hostMode !== 'recruiting' || group.groupStatus !== GROUP_STATUSES[0]) {
      throw groupOperationError_('host_claim_closed');
    }
    if (String(participant.paymentStatus || 'pending') !== 'pending') {
      throw groupOperationError_('host_role_payment_locked');
    }
    requireHostClaimEligibility_(sheets, participant, groupId, actorId);
    const hostRemainderPlan = planHostRemainderOrders_(
      sheets, group, actorId, true, mutationId, now
    );
    const previousRole = participant.role;
    const previousParticipantVersion = Number(participant.version || 0);
    const previousGroupVersion = Number(group.version || 0);
    participant.role = 'host';
    participant.version += 1;
    participant.updatedAt = now;
    group.hostActorId = actorId;
    group.version += 1;
    group.updatedAt = now;
    group.updatedBy = actorId;
    const hostClaimOperations = hostRemainderPlan.changedRecords.map(function(record) {
      return {
        type: 'order_update',
        beforeVersion: record.beforeVersion,
        target: plainMutationRecord_(record.order)
      };
    });
    hostClaimOperations.push(
      {
        type: 'participant_update', beforeVersion: previousParticipantVersion,
        target: plainMutationRecord_(participant)
      },
      {
        type: 'group_update', beforeVersion: previousGroupVersion,
        target: plainMutationRecord_(group)
      }
    );
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'host', entityId: actorId,
      fromStatus: previousRole, toStatus: 'host', action: action,
      actorId: actorId, actorRole: previousRole, clientMutationId: mutationId,
      version: group.version, createdAt: now
    }, mutationContract, mutationResult({
      adjustedOrderId: hostRemainderPlan.order && hostRemainderPlan.order.id || '',
      hostRemainderApplied: hostRemainderPlan.remainder
    }), hostClaimOperations);
    roleAdjustedOrder = hostRemainderPlan.order;
    actor.role = 'host';
    actor.participant = participant;
  } else if (action === 'release_host') {
    const participant = actor.participant;
    if (!participant || participant.role !== 'host' || group.hostActorId !== actorId) {
      throw groupOperationError_('forbidden');
    }
    if (group.hostMode !== 'recruiting' || group.groupStatus !== GROUP_STATUSES[0]) {
      throw groupOperationError_('host_release_closed');
    }
    if (String(participant.paymentStatus || 'pending') !== 'pending') {
      throw groupOperationError_('host_role_payment_locked');
    }
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== group.version) throw groupOperationError_('state_conflict');
    const previousParticipantVersion = Number(participant.version || 0);
    const previousGroupVersion = Number(group.version || 0);
    const hostRemainderPlan = planHostRemainderOrders_(
      sheets, group, actorId, false, mutationId, now
    );
    const nextRole = group.creatorActorId === actorId ? 'creator' : 'member';
    participant.role = nextRole;
    participant.version += 1;
    participant.updatedAt = now;
    group.hostActorId = '';
    group.version += 1;
    group.updatedAt = now;
    group.updatedBy = actorId;
    const hostReleaseOperations = hostRemainderPlan.changedRecords.map(function(record) {
      return {
        type: 'order_update',
        beforeVersion: record.beforeVersion,
        target: plainMutationRecord_(record.order)
      };
    });
    hostReleaseOperations.push(
      {
        type: 'participant_update', beforeVersion: previousParticipantVersion,
        target: plainMutationRecord_(participant)
      },
      {
        type: 'group_update', beforeVersion: previousGroupVersion,
        target: plainMutationRecord_(group)
      }
    );
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'host', entityId: actorId,
      fromStatus: 'host', toStatus: nextRole, action: action,
      actorId: actorId, actorRole: 'host', clientMutationId: mutationId,
      version: group.version, createdAt: now
    }, mutationContract, mutationResult({
      adjustedOrderId: hostRemainderPlan.order && hostRemainderPlan.order.id || '',
      hostRemainderApplied: 0
    }), hostReleaseOperations);
    roleAdjustedOrder = hostRemainderPlan.order;
    actor.role = nextRole;
    actor.participant = participant;
  } else if (action === 'reserve_quantity') {
    const activeDeal = activePublicDealRecord_(sheets.publicDeals, groupId);
    if (!activeDeal) throw groupOperationError_('deal_not_found');
    const participant = actor.participant;
    const priorReservationHistory = participant
      ? customerOrderReservationHistory_(sheets, groupId, actorId)
      : [];
    const latestReservationHistory = priorReservationHistory.length
      ? priorReservationHistory[priorReservationHistory.length - 1]
      : null;
    const canReactivateRolledBackReservation = Boolean(
      participant
      && ['creator', 'member'].includes(participant.role)
      && !participant.counted
      && Number(participant.selectedQuantity || 0) === 0
      && participant.paymentStatus === 'pending'
      && latestReservationHistory
      && latestReservationHistory.action === 'rollback_reservation'
      && ['join', 'reserve_quantity'].includes(
        String(latestReservationHistory.result && latestReservationHistory.result.reservationAction || '')
      )
      && Number(latestReservationHistory.result && latestReservationHistory.result.selectedQuantity) === 0
    );
    const canReactivateCancelledParticipation = Boolean(
      participant
      && ['member', 'creator'].includes(participant.role)
      && !participant.counted
      && Number(participant.selectedQuantity || 0) === 0
      && participant.paymentStatus === 'pending'
      && latestReservationHistory
      && ['cancel_participation', 'admin_cancel_order'].includes(latestReservationHistory.action)
      && /^order-\d{10,20}$/.test(String(
        latestReservationHistory.result && latestReservationHistory.result.orderId || ''
      ))
      && Number(latestReservationHistory.result && latestReservationHistory.result.cancelledQuantity || 0) > 0
      && Number(latestReservationHistory.result && latestReservationHistory.result.selectedQuantity) === 0
      && !hasActiveBoundGroupOrder_(sheets, groupId, actorId)
    );
    const canReactivateInactiveParticipation = canReactivateRolledBackReservation
      || canReactivateCancelledParticipation;
    if (!participant
      || (!participant.counted && !canReactivateInactiveParticipation)
      || !['creator', 'host', 'member'].includes(participant.role)) {
      throw groupOperationError_('forbidden');
    }
    if (String(participant.paymentStatus || 'pending') !== 'pending') {
      throw groupOperationError_('quantity_reservation_closed');
    }
    if (group.groupStatus !== GROUP_STATUSES[0]) {
      throw groupOperationError_('quantity_reservation_closed');
    }
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== participant.version) throw groupOperationError_('state_conflict');
    const quantity = requireInteger_(payload.quantity, 'quantity', 1, 999);
    const participants = getParticipantsForGroup_(sheets, groupId, false);
    const merchantSeed = merchantGroupSeed_(activeDeal, groupId);
    const activeMerchantAllocations = merchantSeed
      ? activeMerchantAllocationsByActor_(sheets, groupId)
      : null;
    const capacityUsage = merchantGroupCapacityUsage_(participants, activeMerchantAllocations);
    const actorAlreadyAllocated = Boolean(capacityUsage.actors[actorId]);
    if (canReactivateInactiveParticipation && !actorAlreadyAllocated
      && (capacityUsage.participantCount >= GROUP_MAX_PARTICIPANTS
        || capacityUsage.participantCount >= group.targetCount)) {
      throw groupOperationError_('group_full');
    }
    if (capacityUsage.quantity + quantity > group.totalQuantity) {
      throw groupOperationError_('quantity_exceeds_total');
    }
    const previousQuantity = Math.max(
      Number(participant.selectedQuantity || 0),
      Number(capacityUsage.actors[actorId]
        && capacityUsage.actors[actorId].activeOrderQuantity || 0)
    );
    const previousParticipantVersion = Number(participant.version || 0);
    participant.selectedQuantity = previousQuantity + quantity;
    if (canReactivateInactiveParticipation) participant.counted = true;
    participant.version += 1;
    participant.updatedAt = now;
    group.updatedAt = now;
    group.updatedBy = actorId;
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'quantity', entityId: actorId,
      fromStatus: String(previousQuantity), toStatus: String(participant.selectedQuantity),
      action: action, actorId: actorId, actorRole: actor.role,
      clientMutationId: mutationId, version: participant.version, createdAt: now,
    }, mutationContract, mutationResult({
      reactivated: canReactivateInactiveParticipation,
      reactivationReason: canReactivateCancelledParticipation ? 'cancel_participation' : ''
    }), [
      {
        type: 'participant_update', beforeVersion: previousParticipantVersion,
        target: plainMutationRecord_(participant)
      }
    ]);
    try { updateGroupRow_(sheets, group); } catch (error) {}
    actor.participant = participant;
  } else if (action === 'rollback_reservation') {
    const participant = actor.participant;
    if (!participant || !['creator', 'host', 'member'].includes(participant.role)) {
      throw groupOperationError_('forbidden');
    }
    const reservationMutationId = requireMutationId_(payload.reservationMutationId);
    const quantity = requireInteger_(payload.quantity, 'quantity', 1, 999);
    const reservationHistory = customerOrderReservationHistory_(sheets, groupId, actorId);
    const reservation = reservationHistory.find(function(item) {
      return item.mutationId === reservationMutationId
        && ['create', 'join', 'reserve_quantity'].includes(item.action);
    });
    if (!reservation) throw groupOperationError_('reservation_not_found');
    const reservedQuantity = customerOrderReservationQuantity_(
      reservation,
      reservationHistory,
      participant.selectedQuantity
    );
    if (reservedQuantity !== quantity) {
      throw groupOperationError_('reservation_quantity_mismatch');
    }

    const priorRollback = reservationHistory.find(function(item) {
      return item.action === 'rollback_reservation'
        && String(item.result && item.result.reservationMutationId || '') === reservationMutationId;
    });
    if (priorRollback) {
      appendGroupHistory_(sheets, {
        groupId: groupId, entityType: 'quantity', entityId: actorId,
        fromStatus: String(participant.selectedQuantity), toStatus: String(participant.selectedQuantity),
        action: action, actorId: actorId, actorRole: actor.role,
        reason: 'order_persistence_failed', clientMutationId: mutationId,
        version: participant.version, createdAt: now,
        result: mutationResult({
          unchanged: true,
          reservationMutationId: reservationMutationId,
          reservationAction: reservation.action,
          rolledBackQuantity: quantity,
          originalRollbackMutationId: priorRollback.mutationId,
          selectedQuantity: Number(participant.selectedQuantity || 0)
        })
      });
      invalidateGroupSnapshot_(groupId);
      return { actor: actor, duplicate: false, unchanged: true };
    }

    const boundReservations = boundCustomerOrderReservations_(sheets.customerOrders, '');
    if (boundReservations[reservationMutationId]) {
      throw groupOperationError_('reservation_already_bound');
    }
    const previousQuantity = Number(participant.selectedQuantity || 0);
    if (previousQuantity < quantity) throw groupOperationError_('state_conflict');
    const nextQuantity = previousQuantity - quantity;
    const previousParticipantVersion = Number(participant.version || 0);
    const previousGroupVersion = Number(group.version || 0);
    participant.selectedQuantity = nextQuantity;
    if (nextQuantity === 0) {
      participant.counted = false;
      if (group.hostActorId === actorId) {
        group.hostActorId = '';
        participant.role = 'member';
        actor.role = 'member';
      }
    }
    participant.version += 1;
    participant.updatedAt = now;
    group.version += 1;
    group.updatedAt = now;
    group.updatedBy = actorId;
    const rollbackResult = mutationResult({
      reservationMutationId: reservationMutationId,
      reservationAction: reservation.action,
      rolledBackQuantity: quantity,
      previousQuantity: previousQuantity,
      selectedQuantity: nextQuantity
    });
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'quantity', entityId: actorId,
      fromStatus: String(previousQuantity), toStatus: String(nextQuantity),
      action: action, actorId: actorId, actorRole: actor.role,
      reason: 'order_persistence_failed', clientMutationId: mutationId,
      version: participant.version, createdAt: now
    }, mutationContract, rollbackResult, [
      {
        type: 'participant_update', beforeVersion: previousParticipantVersion,
        target: plainMutationRecord_(participant)
      },
      {
        type: 'group_update', beforeVersion: previousGroupVersion,
        target: plainMutationRecord_(group)
      }
    ]);
    actor.participant = participant;
  } else if (action === 'cancel_participation') {
    const participant = actor.participant;
    if (!participant || actor.role !== 'member' || participant.role !== 'member' || !participant.counted) {
      throw groupOperationError_('forbidden');
    }
    if (group.groupStatus !== GROUP_STATUSES[0]) {
      throw groupOperationError_('participation_cancellation_closed');
    }
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== participant.version) throw groupOperationError_('state_conflict');
    const orderRecord = getCustomerOrderRecord_(sheets, payload.orderId);
    const order = authorizeCustomerOrderCancellation_(sheets, orderRecord, payload, actorId, group);
    const expectedOrderVersion = requireInteger_(
      payload.expectedOrderVersion,
      'expected_order_version',
      1,
      Number.MAX_SAFE_INTEGER
    );
    const orderVersion = secureOrderVersion_(order);
    if (expectedOrderVersion !== orderVersion) throw groupOperationError_('state_conflict');
    if (String(order.status || 'new') !== 'new') throw groupOperationError_('order_not_cancellable');
    if (
      String(order.paymentStatus || 'pending') !== 'pending'
      || participant.paymentStatus !== 'pending'
      || order.paymentRequestedAt
      || order.paymentConfirmedAt
      || order.customerPickupConfirmedAt
    ) {
      throw groupOperationError_('payment_already_processed');
    }
    const orderQuantity = requireInteger_(order._reservationQuantity, 'order_quantity', 1, 999);
    if (participant.selectedQuantity < orderQuantity) throw groupOperationError_('state_conflict');
    const previousQuantity = participant.selectedQuantity;
    const nextQuantity = previousQuantity - orderQuantity;
    const previousParticipantVersion = Number(participant.version || 0);
    const previousGroupVersion = Number(group.version || 0);
    participant.selectedQuantity = nextQuantity;
    participant.counted = nextQuantity > 0;
    participant.version += 1;
    participant.updatedAt = now;

    const nextOrderVersion = orderVersion + 1;
    order.status = 'cancelled';
    order.paymentStatus = 'cancelled';
    order.cancelledAt = now;
    order.statusUpdatedAt = now;
    order.version = nextOrderVersion;
    order.paymentVersion = nextOrderVersion;
    order.statusHistory = (Array.isArray(order.statusHistory) ? order.statusHistory : []).concat([{
      status: 'cancelled',
      before: 'new',
      after: 'cancelled',
      actor: actorId,
      actorRole: 'member',
      action: action,
      reason: 'participant_cancelled',
      clientMutationId: mutationId,
      version: nextOrderVersion,
      timestamp: now
    }]).slice(-100);
    order.syncedAt = now;

    group.version += 1;
    group.updatedAt = now;
    group.updatedBy = actorId;
    const cancellationResult = mutationResult({
      orderId: order.id,
      cancelledQuantity: orderQuantity,
      previousQuantity: previousQuantity,
      selectedQuantity: nextQuantity,
      orderVersion: nextOrderVersion
    });
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'participant', entityId: actorId,
      fromStatus: 'joined', toStatus: nextQuantity > 0 ? 'joined' : 'cancelled', action: action,
      actorId: actorId, actorRole: actor.role, reason: 'participant_cancelled',
      clientMutationId: mutationId, version: participant.version, createdAt: now
    }, mutationContract, cancellationResult, [
      {
        type: 'participant_update', beforeVersion: previousParticipantVersion,
        target: plainMutationRecord_(participant)
      },
      {
        type: 'order_update', beforeVersion: orderVersion,
        target: plainMutationRecord_(order)
      },
      {
        type: 'group_update', beforeVersion: previousGroupVersion,
        target: plainMutationRecord_(group)
      }
    ]);
    actor.participant = participant;
    invalidateGroupSnapshot_(groupId);
    return { actor: actor, duplicate: false, order: order };
  } else if (action === 'send_message') {
    const body = groupText_(payload.body, 500);
    if (!body) throw groupOperationError_('invalid_message_body');
    if (group.chatLocked) {
      if (actor.role === 'admin') {
        // Administrators remain canonical without a participant-host binding.
      } else if (actor.role === 'host') {
        requireManager_(actor, group);
      } else {
        throw groupOperationError_('chat_locked');
      }
    }
    const nextSeq = group.lastMessageSeq + 1;
    const messageId = Utilities.getUuid();
    const participant = actor.participant || ensureAdminParticipant_(sheets, groupId, actor, nextSeq, now);
    const previousMessageSeq = Number(group.lastMessageSeq || 0);
    const previousReadSeq = Number(participant.lastReadSeq || 0);
    group.lastMessageSeq = nextSeq;
    group.updatedAt = now;
    group.updatedBy = actorId;
    participant.lastReadSeq = nextSeq;
    participant.updatedAt = now;
    const messageResult = mutationResult({ messageId: messageId, seq: nextSeq });
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'message', entityId: messageId, action: action,
      actorId: actorId, actorRole: actor.role, clientMutationId: mutationId,
      version: nextSeq, createdAt: now
    }, mutationContract, messageResult, [
      {
        type: 'chat_append', clientMutationId: mutationId,
        target: {
          groupId: groupId, seq: nextSeq, messageId: messageId, actorId: actorId,
          nickname: participant.nickname, actorRole: actor.role, body: body, createdAt: now
        }
      },
      {
        type: 'group_message_update', beforeSeq: previousMessageSeq,
        target: plainMutationRecord_(group)
      },
      {
        type: 'participant_read_update', beforeSeq: previousReadSeq,
        target: plainMutationRecord_(participant)
      }
    ]);
  } else if (action === 'mark_read') {
    const participant = actor.participant || ensureAdminParticipant_(sheets, groupId, actor, 0, now);
    const requestedSeq = requireInteger_(payload.lastReadSeq, 'last_read_seq', 0, Number.MAX_SAFE_INTEGER);
    const previousReadSeq = participant.lastReadSeq;
    const nextReadSeq = Math.min(group.lastMessageSeq, Math.max(participant.lastReadSeq, requestedSeq));
    const readUnchanged = nextReadSeq === previousReadSeq;
    if (!readUnchanged) {
      participant.lastReadSeq = nextReadSeq;
      participant.updatedAt = now;
    }
    const readResult = mutationResult(readUnchanged ? { unchanged: true } : {});
    const readOperations = readUnchanged ? [] : [{
      type: 'participant_read_update', beforeSeq: previousReadSeq,
      target: plainMutationRecord_(participant)
    }];
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'read', entityId: actorId,
      fromStatus: String(previousReadSeq), toStatus: String(nextReadSeq),
      action: action, actorId: actorId, actorRole: actor.role, clientMutationId: mutationId,
      version: participant.version, createdAt: now
    }, mutationContract, readResult, readOperations);
    if (readUnchanged) return { actor: actor, duplicate: false, unchanged: true };
  } else if (action === 'transition_group') {
    requireManager_(actor, group);
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== group.version) throw groupOperationError_('state_conflict');
    const requestedFromStatus = String(payload.fromStatus || '');
    const requestedToStatus = String(payload.toStatus || '');
    if (!GROUP_STATUSES.includes(requestedFromStatus)
      || !GROUP_STATUSES.includes(requestedToStatus)) {
      throw groupOperationError_('invalid_state_transition');
    }
    if (requestedFromStatus !== group.groupStatus) throw groupOperationError_('state_conflict');
    const currentIndex = GROUP_STATUSES.indexOf(group.groupStatus);
    const offset = payload.direction === 'next' ? 1 : payload.direction === 'previous' ? -1 : 0;
    const nextIndex = currentIndex + offset;
    if (!offset || currentIndex < 0 || nextIndex < 0 || nextIndex >= GROUP_STATUSES.length) {
      throw groupOperationError_('invalid_state_transition');
    }
    if (GROUP_STATUSES[nextIndex] !== requestedToStatus) {
      throw groupOperationError_('invalid_state_transition');
    }
    if (group.groupStatus === GROUP_STATUSES[0] && payload.direction === 'next') {
      const groupParticipants = getParticipantsForGroup_(sheets, groupId, false);
      if (!allGroupPaymentsConfirmed_(sheets, groupId, groupParticipants)) {
        throw groupOperationError_('payments_not_confirmed');
      }
    }
    const previous = group.groupStatus;
    const previousGroupVersion = Number(group.version || 0);
    group.groupStatus = GROUP_STATUSES[nextIndex];
    group.version += 1;
    group.updatedAt = now;
    group.updatedBy = actorId;
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'group', entityId: groupId, fromStatus: previous,
      toStatus: group.groupStatus, action: action, actorId: actorId, actorRole: actor.role,
      clientMutationId: mutationId, version: group.version, createdAt: now
    }, mutationContract, mutationResult(), [
      {
        type: 'group_update', beforeVersion: previousGroupVersion,
        target: plainMutationRecord_(group)
      }
    ]);
  } else if (action === 'transition_payment') {
    const participantActorId = requireGroupId_(payload.participantActorId, 'participant_actor_id');
    const participant = getParticipantRecord_(sheets, groupId, participantActorId, true);
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== participant.version) throw groupOperationError_('state_conflict');
    const requestedFromStatus = String(payload.fromStatus || '');
    const requestedToStatus = String(payload.toStatus || '');
    if (!PAYMENT_STATUSES.includes(requestedFromStatus)
      || !PAYMENT_STATUSES.includes(requestedToStatus)) {
      throw groupOperationError_('invalid_state_transition');
    }
    if (requestedFromStatus !== participant.paymentStatus) throw groupOperationError_('state_conflict');
    const direction = payload.direction;
    let nextStatus = '';
    if ((actorId === participantActorId || actor.role === 'admin') && participant.paymentStatus === 'pending' && direction === 'next') {
      nextStatus = 'requested';
    } else if ((actorId === participantActorId || actor.role === 'admin') && participant.paymentStatus === 'requested' && direction === 'previous') {
      nextStatus = 'pending';
    } else if (['host', 'admin'].includes(actor.role) && participant.paymentStatus === 'requested' && direction === 'next') {
      nextStatus = 'confirmed';
    } else if (['host', 'admin'].includes(actor.role) && participant.paymentStatus === 'confirmed' && direction === 'previous') {
      nextStatus = 'requested';
    } else {
      throw groupOperationError_(actorId === participantActorId ? 'invalid_state_transition' : 'forbidden');
    }
    if (nextStatus !== requestedToStatus) throw groupOperationError_('invalid_state_transition');
    if (actorId !== participantActorId) requireManager_(actor, group);
    if (group.groupStatus !== GROUP_STATUSES[0] && nextStatus !== 'confirmed') {
      throw groupOperationError_('payment_reversal_requires_group_rewind');
    }
    const previous = participant.paymentStatus;
    const orderPlan = planGroupPaymentOrders_(
      sheets,
      groupId,
      participantActorId,
      previous,
      nextStatus,
      actorId,
      actor.role,
      mutationId,
      now,
      true
    );
    if (!orderPlan.records.length && groupPaymentRequiresOrder_(sheets, group, participant)) {
      throw groupOperationError_('order_payment_link_required');
    }
    requireCompleteGroupPaymentQuantity_(orderPlan.records, participant);
    if (orderPlan.records.some(function(record) {
      return String(record.order.paymentStatus || 'pending') !== nextStatus;
    })) throw groupOperationError_('order_payment_state_conflict');
    const previousParticipantVersion = Number(participant.version || 0);
    participant.paymentStatus = nextStatus;
    participant.version += 1;
    participant.updatedAt = now;
    const paymentResult = mutationResult({ syncedOrderCount: orderPlan.changedRecords.length });
    paymentResult.adjustedOrderId = orderPlan.records.length
      ? String(orderPlan.records[0].order.id || '')
      : '';
    const paymentOperations = orderPlan.changedRecords.length ? [{
      type: 'payment_orders_update',
      target: {
        groupId: groupId,
        participantActorId: participantActorId,
        fromStatus: previous,
        toStatus: nextStatus,
        actorId: actorId,
        actorRole: actor.role,
        clientMutationId: mutationId,
        updatedAt: now,
        recoverBindings: true,
        expectedOrderIds: orderPlan.records.map(function(record) { return String(record.order.id); })
      }
    }] : [];
    paymentOperations.push({
      type: 'participant_update',
      beforeVersion: previousParticipantVersion,
      target: plainMutationRecord_(participant)
    });
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'payment', entityId: participantActorId,
      fromStatus: previous, toStatus: nextStatus, action: action, actorId: actorId,
      actorRole: actor.role, reason: groupText_(payload.reason, 200), clientMutationId: mutationId,
      version: participant.version, createdAt: now
    }, mutationContract, paymentResult, paymentOperations);
    roleAdjustedOrder = orderPlan.records.length
      ? orderPlan.records[0].order
      : null;
  } else if (action === 'update_target') {
    requireTargetManager_(actor, group);
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== group.version) throw groupOperationError_('state_conflict');
    if (GROUP_STATUSES.indexOf(group.groupStatus) >= GROUP_STATUSES.indexOf('purchased')) {
      throw groupOperationError_('target_locked');
    }
    const targetCount = requireInteger_(payload.targetCount, 'target_count', 1, GROUP_MAX_PARTICIPANTS);
    const targetParticipants = getParticipantsForGroup_(sheets, groupId, false);
    const targetMerchantSeed = merchantGroupSeed_(publicDealRecord_(sheets.publicDeals, groupId), groupId);
    const targetCapacityUsage = merchantGroupCapacityUsage_(
      targetParticipants,
      targetMerchantSeed ? activeMerchantAllocationsByActor_(sheets, groupId) : null
    );
    const currentCount = targetCapacityUsage.participantCount;
    if (targetCount < currentCount) throw groupOperationError_('invalid_target');
    const previous = group.targetCount;
    const previousGroupVersion = Number(group.version || 0);
    if (targetCount !== previous) {
      group.targetCount = targetCount;
      group.version += 1;
      group.updatedAt = now;
      group.updatedBy = actorId;
    }
    const targetOperations = targetCount !== previous ? [{
      type: 'group_update', beforeVersion: previousGroupVersion,
      target: plainMutationRecord_(group)
    }] : [];
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'target', entityId: groupId,
      fromStatus: String(previous), toStatus: String(targetCount), action: action,
      actorId: actorId, actorRole: actor.role, clientMutationId: mutationId,
      version: group.version, createdAt: now
    }, mutationContract, mutationResult(), targetOperations);
  } else if (action === 'toggle_lock') {
    requireManager_(actor, group);
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== group.version) throw groupOperationError_('state_conflict');
    if (typeof payload.locked !== 'boolean') throw groupOperationError_('invalid_locked');
    const previous = group.chatLocked;
    const previousGroupVersion = Number(group.version || 0);
    if (payload.locked !== previous) {
      group.chatLocked = payload.locked;
      group.version += 1;
      group.updatedAt = now;
      group.updatedBy = actorId;
    }
    const lockOperations = payload.locked !== previous ? [{
      type: 'group_update', beforeVersion: previousGroupVersion,
      target: plainMutationRecord_(group)
    }] : [];
    commitGroupMutationIntent_(sheets, {
      groupId: groupId, entityType: 'chat_lock', entityId: groupId,
      fromStatus: String(previous), toStatus: String(payload.locked), action: action,
      actorId: actorId, actorRole: actor.role, clientMutationId: mutationId,
      version: group.version, createdAt: now
    }, mutationContract, mutationResult(), lockOperations);
  } else {
    throw groupOperationError_('invalid_action');
  }

  if (action !== 'mark_read') invalidateGroupSnapshot_(groupId);
  return { actor: actor, duplicate: false, order: roleAdjustedOrder };
}

function handleGroupOperation_(action, payload) {
  const supported = [
    'create', 'repair_customer_group', 'recover_legacy_customer_group',
    'join', 'snapshot', 'send_message', 'mark_read',
    'transition_group', 'transition_payment', 'update_target', 'toggle_lock',
    'claim_host', 'release_host', 'reserve_quantity', 'rollback_reservation', 'cancel_participation'
  ];
  if (!supported.includes(action)) return json_({ ok: false, error: 'invalid_action' });
  let lock = null;
  try {
    const groupId = requireGroupId_(payload.groupId, 'group_id');
    const sheets = ensureSheets_();
    if (action === 'snapshot') {
      const actor = authorizeGroupActor_(sheets, groupId, payload);
      return json_({ ok: true, snapshot: buildGroupSnapshot_(sheets, groupId, actor) });
    }
    lock = acquireScriptLock_();
    const result = executeGroupMutation_(action, payload, sheets);
    if (action !== 'mark_read') invalidatePublicDealsCache_();
    lock.releaseLock();
    lock = null;
    const snapshot = buildGroupSnapshot_(sheets, groupId, result.actor);
    return json_({
      ok: true,
      duplicate: Boolean(result.duplicate),
      unchanged: Boolean(result.unchanged),
      snapshot: snapshot,
      order: result.order ? publicOrderValue_(result.order) : undefined
    });
  } catch (error) {
    const code = action === 'recover_legacy_customer_group'
      ? 'legacy_recovery_not_authorized'
      : error.code || 'group_operation_failed';
    const result = { ok: false, error: code };
    if (code === 'state_conflict') {
      try {
        const sheets = ensureSheets_();
        const groupId = requireGroupId_(payload.groupId, 'group_id');
        const actor = authorizeGroupActor_(sheets, groupId, payload);
        result.snapshot = buildGroupSnapshot_(sheets, groupId, actor);
      } catch (ignored) {}
    }
    return json_(result);
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (error) {}
    }
  }
}

function getCustomerOrdersByGroup_(payload) {
  try {
    const groupId = requireGroupId_(payload.groupId, 'group_id');
    const sheets = ensureSheets_();
    const actor = authorizeGroupActor_(sheets, groupId, payload);
    const group = getGroupRecord_(sheets, groupId);
    requireManager_(actor, group);
    const dealId = payload.dealId ? requireGroupId_(payload.dealId, 'deal_id') : group.dealId;
    if (dealId !== group.dealId) throw groupOperationError_('forbidden');
    const current = [];
    if (sheets.customerOrders.getLastRow() >= 2) {
      sheets.customerOrders.getRange(2, 4, sheets.customerOrders.getLastRow() - 1, 1)
        .getValues()
        .forEach(function(row) {
          try {
            const order = JSON.parse(row[0] || '{}');
            if (
              String(order.groupId || '') === groupId
              && String(order.dealId || (order.deal && order.deal.id) || '') === group.dealId
            ) current.push(order);
          } catch (error) {}
        });
    }
    const historic = historicCustomerOrders_(sheets.events, '', dealId)
      .filter(function(order) { return String(order.groupId || '') === groupId; });
    const projectionContext = {};
    const orders = mergeCustomerOrderSnapshots_(current.concat(historic)).map(function(order) {
      return publicOrderValue_(projectStoredGroupOrderPayment_(sheets, order, projectionContext));
    });
    return json_({ ok: true, orders: orders });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'customer_orders_group_failed' });
  }
}

function preferValue_(preferred, fallback) {
  return preferred && preferred !== '미설정' ? preferred : fallback;
}

function backfillVisitorProfile_(events, visitorId, properties) {
  if (!visitorId || events.getLastRow() < 2) return;
  const rowCount = events.getLastRow() - 1;
  const range = events.getRange(2, 1, rowCount, EVENT_HEADERS.length);
  const values = range.getValues();
  let changed = false;

  values.forEach(function(row) {
    if (String(row[4]) !== String(visitorId)) return;
    if (!row[2] || row[2] === '미설정') row[2] = properties.tester_name || '미설정';
    if (!row[3] || row[3] === '미설정') row[3] = properties.tester_type || '미설정';
    if (!row[7] || row[7] === '미설정') row[7] = properties.region || '미설정';
    if (!row[8] || row[8] === '미설정') row[8] = properties.district || '미설정';
    if (!row[9] || row[9] === '미설정') row[9] = properties.neighborhood || '미설정';
    if (!row[12]) row[12] = properties.customer_number || '';
    if (!row[13]) row[13] = properties.customer_phone || '';
    changed = true;
  });

  if (changed) range.setValues(values);
}

function repairExistingUnsetRows() {
  const events = ensureSheets_().events;
  if (events.getLastRow() < 2) return;
  const rowCount = events.getLastRow() - 1;
  const range = events.getRange(2, 1, rowCount, EVENT_HEADERS.length);
  const values = range.getValues();
  const profiles = Object.create(null);

  values.forEach(function(row) {
    if (row[6] !== 'profile_submitted' || !row[4]) return;
    let details = {};
    try { details = JSON.parse(row[11] || '{}'); } catch (error) {}
    profiles[String(row[4])] = {
      tester_name: row[2], tester_type: row[3], region: row[7], district: row[8], neighborhood: row[9],
      customer_number: row[12] || details.customer_number || '',
      customer_phone: row[13] || details.customer_phone || ''
    };
  });

  values.forEach(function(row) {
    const profile = profiles[String(row[4])];
    if (!profile) return;
    if (!row[2] || row[2] === '미설정') row[2] = profile.tester_name;
    if (!row[3] || row[3] === '미설정') row[3] = profile.tester_type;
    if (!row[7] || row[7] === '미설정') row[7] = profile.region;
    if (!row[8] || row[8] === '미설정') row[8] = profile.district;
    if (!row[9] || row[9] === '미설정') row[9] = profile.neighborhood;
    if (!row[12]) row[12] = profile.customer_number;
    if (!row[13]) row[13] = profile.customer_phone;
  });
  range.setValues(values);
}

function ensureSheets_() {
  if (RUNTIME_SHEETS_CACHE_) return RUNTIME_SHEETS_CACHE_;
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  let events = spreadsheet.getSheetByName('전체 이벤트');
  if (!events) events = spreadsheet.insertSheet('전체 이벤트');
  if (events.getLastRow() === 0) {
    events.getRange(1, 1, 1, EVENT_HEADERS.length).setValues([EVENT_HEADERS]);
    events.setFrozenRows(1);
  } else if (events.getLastColumn() < EVENT_HEADERS.length) {
    events.getRange(1, 1, 1, EVENT_HEADERS.length).setValues([EVENT_HEADERS]);
  }
  let summary = spreadsheet.getSheetByName('통합 현황');
  if (!summary) summary = spreadsheet.insertSheet('통합 현황');
  let surveys = spreadsheet.getSheetByName('설문 응답');
  if (!surveys) surveys = spreadsheet.insertSheet('설문 응답');
  if (surveys.getLastRow() === 0) {
    surveys.getRange(1, 1, 1, SURVEY_HEADERS.length).setValues([SURVEY_HEADERS]);
    surveys.setFrozenRows(1);
  } else if (surveys.getLastColumn() < SURVEY_HEADERS.length) {
    surveys.getRange(1, 1, 1, SURVEY_HEADERS.length).setValues([SURVEY_HEADERS]);
  }
  let publicDeals = spreadsheet.getSheetByName('공개 상품');
  if (!publicDeals) publicDeals = spreadsheet.insertSheet('공개 상품');
  if (publicDeals.getLastRow() === 0) {
    publicDeals.getRange(1, 1, 1, PUBLIC_DEAL_HEADERS.length).setValues([PUBLIC_DEAL_HEADERS]);
    publicDeals.setFrozenRows(1);
  }
  let recovery = spreadsheet.getSheetByName('복구 등록');
  if (!recovery) recovery = spreadsheet.insertSheet('복구 등록');
  ensureHeader_(recovery, RECOVERY_HEADERS);
  let customerOrders = spreadsheet.getSheetByName('주문 내역');
  if (!customerOrders) customerOrders = spreadsheet.insertSheet('주문 내역');
  if (customerOrders.getLastRow() === 0) {
    customerOrders.getRange(1, 1, 1, CUSTOMER_ORDER_HEADERS.length).setValues([CUSTOMER_ORDER_HEADERS]);
    customerOrders.setFrozenRows(1);
  }
  let groups = spreadsheet.getSheetByName('그룹');
  if (!groups) groups = spreadsheet.insertSheet('그룹');
  ensureHeader_(groups, GROUP_HEADERS);
  let groupParticipants = spreadsheet.getSheetByName('그룹 참여자');
  if (!groupParticipants) groupParticipants = spreadsheet.insertSheet('그룹 참여자');
  ensureHeader_(groupParticipants, GROUP_PARTICIPANT_HEADERS);
  let groupChat = spreadsheet.getSheetByName('그룹 채팅');
  if (!groupChat) groupChat = spreadsheet.insertSheet('그룹 채팅');
  ensureHeader_(groupChat, GROUP_CHAT_HEADERS);
  let groupHistory = spreadsheet.getSheetByName('상태 이력');
  if (!groupHistory) groupHistory = spreadsheet.insertSheet('상태 이력');
  ensureHeader_(groupHistory, GROUP_HISTORY_HEADERS);
  RUNTIME_SHEETS_CACHE_ = {
    events, summary, surveys, publicDeals, customerOrders,
    groups, groupParticipants, groupChat, groupHistory, recovery,
  };
  return RUNTIME_SHEETS_CACHE_;
}

function ensureHeader_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function setup() {
  const sheets = ensureSheets_();
  clearLegacyValidations_(sheets.events);
  backfillEventIds_(sheets.events);
  repairExistingUnsetRows();
  backfillSurveyResponses_(sheets.events, sheets.surveys);
  formatEventSheet_(sheets.events);
  formatSurveySheet_(sheets.surveys);
}

function backfillEventIds_(events) {
  if (events.getLastRow() < 2) return;
  const rowCount = events.getLastRow() - 1;
  const details = events.getRange(2, 12, rowCount, 1).getValues();
  const ids = events.getRange(2, EVENT_HEADERS.length, rowCount, 1).getValues();
  let changed = false;
  details.forEach(function(row, index) {
    if (ids[index][0]) return;
    try {
      const properties = JSON.parse(row[0] || '{}');
      if (properties.event_id) {
        ids[index][0] = String(properties.event_id);
        changed = true;
      }
    } catch (error) {}
  });
  if (changed) events.getRange(2, EVENT_HEADERS.length, rowCount, 1).setValues(ids);
}

function clearLegacyValidations_(events) {
  if (events.getMaxRows() < 2) return;
  for (let column = 1; column <= EVENT_HEADERS.length; column += 1) {
    events.getRange(2, column, events.getMaxRows() - 1, 1).clearDataValidations();
  }
}

function backfillSurveyResponses_(events, surveys) {
  if (events.getLastRow() < 2) return;
  const existingIds = Object.create(null);
  if (surveys.getLastRow() >= 2) {
    surveys.getRange(2, SURVEY_HEADERS.length, surveys.getLastRow() - 1, 1)
      .getValues().forEach(function(row, index) { if (row[0]) existingIds[String(row[0])] = index + 2; });
  }
  const rows = events.getRange(2, 1, events.getLastRow() - 1, EVENT_HEADERS.length).getValues();
  rows.forEach(function(row) {
    if (row[6] !== 'survey_submitted') return;
    let properties = {};
    try { properties = JSON.parse(row[11] || '{}'); } catch (error) {}
    const eventId = properties.event_id || '';
    const syntheticEvent = {
      id: eventId || ('legacy-' + row[4] + '-' + new Date(row[1]).getTime()),
      timestamp: row[1],
      visitorId: row[4]
    };
    properties.tester_name = preferValue_(properties.tester_name, row[2]);
    properties.tester_type = preferValue_(properties.tester_type, row[3]);
    properties.region = preferValue_(properties.region, row[7]);
    properties.district = preferValue_(properties.district, row[8]);
    properties.neighborhood = preferValue_(properties.neighborhood, row[9]);
    properties.customer_number = preferValue_(properties.customer_number, row[12]);
    properties.customer_phone = preferValue_(properties.customer_phone, row[13]);
    const values = surveyRowValues_(syntheticEvent, properties);
    const existingRow = existingIds[syntheticEvent.id];
    if (existingRow) {
      values[0] = surveys.getRange(existingRow, 1).getValue() || new Date();
      surveys.getRange(existingRow, 1, 1, SURVEY_HEADERS.length).setValues([values]);
    } else {
      surveys.appendRow(values);
      existingIds[syntheticEvent.id] = surveys.getLastRow();
    }
  });
}

function formatSurveySheet_(surveys) {
  surveys.getRange(1, 1, 1, SURVEY_HEADERS.length)
    .setFontWeight('bold').setBackground('#1f6f5c').setFontColor('#ffffff');
  for (let column = 1; column <= SURVEY_HEADERS.length; column += 1) {
    surveys.autoResizeColumn(column);
  }
  surveys.setColumnWidth(15, 260);
  if (surveys.getMaxRows() > 1) {
    surveys.getRange(2, 3, surveys.getMaxRows() - 1, 1).setNumberFormat('@');
    surveys.getRange(2, 5, surveys.getMaxRows() - 1, 1).setNumberFormat('@');
  }
}

function formatEventSheet_(events) {
  if (events.getMaxRows() > 1) {
    events.getRange(2, 13, events.getMaxRows() - 1, 1).setNumberFormat('@');
    events.getRange(2, 14, events.getMaxRows() - 1, 1).setNumberFormat('@');
    events.getRange(2, EVENT_HEADERS.length, events.getMaxRows() - 1, 1).setNumberFormat('@');
  }
}

function getCentralStats_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('central_stats_v2');
  if (cached) {
    try { return JSON.parse(cached); } catch (error) {}
  }
  const stats = buildCentralStats_();
  try { cache.put('central_stats_v2', JSON.stringify(stats), 4); } catch (error) {}
  return stats;
}

function buildCentralStats_() {
  const events = ensureSheets_().events;
  if (events.getLastRow() < 2) {
    return { generatedAt: new Date().toISOString(), totalEvents: 0, visitors: 0, eventCounts: {}, uniqueByEvent: {}, eventBreakdown: [], neighborhoodBreakdown: [], funnel: [] };
  }
  const rows = events.getRange(2, 1, events.getLastRow() - 1, EVENT_HEADERS.length).getValues();
  const visitors = Object.create(null);
  const eventGroups = Object.create(null);
  const locations = Object.create(null);
  const screenVisitors = Object.create(null);
  const seenEventIds = Object.create(null);
  let totalEvents = 0;

  rows.forEach(function(row) {
    let properties = {};
    try { properties = JSON.parse(row[11] || '{}'); } catch (error) {}
    const eventId = String(row[14] || properties.event_id || '');
    if (eventId && seenEventIds[eventId]) return;
    if (eventId) seenEventIds[eventId] = true;
    const screen = String(row[10] || properties.screen || '');
    if (screen === 'analytics_dashboard' || properties.app === 'dashboard' || properties.is_internal === true) return;
    const visitorId = String(row[4] || 'unknown');
    const name = String(row[6] || 'unknown');
    totalEvents += 1;
    visitors[visitorId] = true;
    if (!eventGroups[name]) eventGroups[name] = { count: 0, visitors: Object.create(null) };
    eventGroups[name].count += 1;
    eventGroups[name].visitors[visitorId] = true;
    const location = [row[7], row[8], row[9]].filter(String).join(' · ') || '미설정';
    if (!locations[location]) locations[location] = { count: 0, visitors: Object.create(null) };
    locations[location].count += 1;
    locations[location].visitors[visitorId] = true;
    if (name === 'screen_view') {
      if (!screenVisitors[screen]) screenVisitors[screen] = Object.create(null);
      screenVisitors[screen][visitorId] = true;
    }
  });

  const eventCounts = Object.create(null);
  const uniqueByEvent = Object.create(null);
  const eventBreakdown = Object.keys(eventGroups).map(function(name) {
    eventCounts[name] = eventGroups[name].count;
    uniqueByEvent[name] = Object.keys(eventGroups[name].visitors).length;
    return { name: name, count: eventGroups[name].count, visitors: uniqueByEvent[name] };
  }).sort(function(a, b) { return b.count - a.count; });

  const neighborhoodBreakdown = Object.keys(locations).map(function(location) {
    return { location: location, count: locations[location].count, visitors: Object.keys(locations[location].visitors).length };
  }).sort(function(a, b) { return b.count - a.count; });

  const listVisitors = Object.keys(screenVisitors.deal_list || {}).length;
  const funnelSeed = Math.max(1, listVisitors);
  const funnel = [
    { label: '리스트 방문', count: listVisitors },
    { label: '상세 진입', count: uniqueByEvent.open_listing || 0 },
    { label: '참여 시작', count: uniqueByEvent.join_started || 0 },
    { label: '참여 완료', count: uniqueByEvent.purchase_completed || 0 },
    { label: '설문 제출', count: uniqueByEvent.survey_submitted || 0 }
  ].map(function(stage) {
    stage.rate = Math.min(100, Math.round(stage.count / funnelSeed * 100));
    return stage;
  });

  return {
    generatedAt: new Date().toISOString(), totalEvents: totalEvents,
    visitors: Object.keys(visitors).length, eventCounts: eventCounts,
    uniqueByEvent: uniqueByEvent, eventBreakdown: eventBreakdown,
    neighborhoodBreakdown: neighborhoodBreakdown, funnel: funnel
  };
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
