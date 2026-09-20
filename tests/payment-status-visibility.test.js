import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUSTOMER_HISTORY_TIMEOUT_MS } from '../src/customerHistory.js';

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const groupRoomSource = readFileSync(new URL('../src/GroupRoom.jsx', import.meta.url), 'utf8');
const adminAuthSource = readFileSync(new URL('../api/_admin-auth.js', import.meta.url), 'utf8');
const dataUpstreamSource = readFileSync(new URL('../api/_data-upstream.js', import.meta.url), 'utf8');
const customerOrdersSource = readFileSync(new URL('../api/customer-orders.js', import.meta.url), 'utf8');

test('“주문 이력 다시 불러오기” always shows progress and reaches a new read', () => {
  assert.match(appSource, /customerHistoryRetryRef\.current = \(\) => syncOrders\(false, \{ explicit: true \}\)/);
  assert.match(appSource, /const syncOrders = async \(queueIfBusy = false, \{ explicit = false \} = \{\}\) =>/);
  assert.match(appSource, /if \(explicit\) setCustomerHistoryState\(\{ scope: profilePhone, status: 'loading' \}\)/);
  assert.match(appSource, /!explicit && current\.scope === profilePhone && current\.status !== 'loading'/);
});

test('a press is queued past a background refresh but coalesced into its own running one', () => {
  assert.match(appSource, /const coveredByRunningRefresh = explicit && syncingExplicit;/);
  assert.match(appSource, /if \(!coveredByRunningRefresh && \(queueIfBusy === true \|\| explicit\)\) refreshQueued = true/);
  assert.match(appSource, /if \(!coveredByRunningRefresh && explicit\) explicitQueued = true/);
  assert.match(appSource, /syncingExplicit = explicit;/);
  assert.match(appSource, /syncing = false;\s*\n\s*syncingExplicit = false;/);
});

test('an explicit retry queued behind a running refresh is not downgraded to a background pass', () => {
  assert.match(appSource, /const queuedExplicit = explicitQueued;\s*\n\s*explicitQueued = false;/);
  assert.match(appSource, /if \(refreshQueued && isCurrent\(\)\) void syncOrders\(false, \{ explicit: queuedExplicit \}\)/);
});

test('a payment control blocked by another pending request explains what to press', () => {
  assert.match(groupRoomSource, /\{paymentRetryBlocked && !rowFeedback && \(canSelfRequest \|\| canOperatorChange\) && \(/);
  assert.match(groupRoomSource, /이전 거래 단계 변경의 처리 결과를 먼저 확인해야 합니다/);
  assert.match(groupRoomSource, /다른 참여자의 이전 입금 요청 결과를 먼저 확인해야 합니다/);
  // The block itself stays: a payment mutation must not start while the
  // outcome of another state change for this actor is still unknown.
  assert.match(groupRoomSource, /const paymentRetryBlocked = pendingTransition\?\.action === 'transition_group'/);
});

test('the admin credential round trip may outlast the shared upstream default without replaying', () => {
  assert.match(adminAuthSource, /const ADMIN_CREDENTIAL_TIMEOUT_MS = 25000;/);
  assert.match(adminAuthSource, /timeoutMs: ADMIN_CREDENTIAL_TIMEOUT_MS/);
  assert.match(dataUpstreamSource, /const \{ timeoutMs, \.\.\.fetchOptions \} = options;/);
  assert.match(dataUpstreamSource, /signal: timeoutSignal\(options\.signal, timeoutMs\)/);
  assert.match(dataUpstreamSource, /function upstreamTimeoutMs\(overrideMs\)/);
  assert.match(dataUpstreamSource, /Number\(overrideMs \?\? process\.env\.O2O_UPSTREAM_TIMEOUT_MS\)/);
  assert.match(adminAuthSource, /\['rate_begin', 'rate_success'\]\.includes\(payload\.operation\)/,
    'only the responses that prove nothing was reserved stay replayable');
});

test('a slow history read is awaited instead of being reported as unverified', () => {
  assert.equal(CUSTOMER_HISTORY_TIMEOUT_MS, 55000);
  assert.match(customerOrdersSource, /const HISTORY_READ_TIMEOUT_MS = 50000;/);
  assert.match(customerOrdersSource, /\.\.\.\(body\.action === 'list' \? \{ timeoutMs: HISTORY_READ_TIMEOUT_MS \} : \{\}\)/);
  assert.equal(CUSTOMER_HISTORY_TIMEOUT_MS > 50000, true,
    'the browser must outlast the central read it asked for');
});

test('the history screen resolves on the read, not on the publish backlog', () => {
  // A busy collector kept the publish train running for minutes while the
  // screen still said “이력 확인 중”, even though the history was already known.
  assert.match(
    appSource,
    /setCustomerHistoryState\(\{ scope: profilePhone, status: historyReadFailed \? 'error' : 'ready' \}\);\s*\n\s*const centralById = new Map/,
  );
});

test('one sync pass publishes a bounded slice and carries the rest to the next cycle', () => {
  assert.match(appSource, /const CUSTOMER_ORDER_PUBLISH_BUDGET = 3;/);
  assert.match(appSource, /const publishBudget = pending\.slice\(0, CUSTOMER_ORDER_PUBLISH_BUDGET\);/);
  assert.match(appSource, /const deferredPublishCount = pending\.length - publishBudget\.length;/);
  assert.match(appSource, /if \(deferredPublishCount > 0\) refreshQueued = true;/);
  // The commit phase must walk the same slice it published.
  assert.match(appSource, /for \(const order of publishBudget\) \{/);
  assert.match(appSource, /publishBudget\.forEach\(\(order, index\) => \{/);
  assert.match(appSource, /if \(publishBudget\.length\) \{/);
});

test('a stuck publish socket cannot hold the single-file mutation queue open', () => {
  const checkoutSource = readFileSync(new URL('../src/checkoutAttempt.js', import.meta.url), 'utf8');
  assert.match(checkoutSource, /const ORDER_PUBLISH_TIMEOUT_MS = 75000;/);
  assert.match(
    checkoutSource,
    /\.\.\.\(typeof AbortSignal\?\.timeout === 'function'\s*\n\s*\? \{ signal: AbortSignal\.timeout\(ORDER_PUBLISH_TIMEOUT_MS\) \}\s*\n\s*: \{\}\),/,
    'older mobile browsers without AbortSignal.timeout must still publish',
  );
  // An aborted publish has an unknown outcome: it carries no status, so it is
  // neither replayed inline nor treated as a terminal rejection. The sync loop
  // reconciles it with a central read instead.
  assert.match(checkoutSource, /const TRANSIENT_ORDER_PUBLISH_CODES = new Set\(\['collector_busy', 'upstream_timeout'\]\);/);
  assert.match(checkoutSource, /const status = Number\(error\?\.status \|\| 0\);\s*\n\s*return status >= 400 && status < 500/);
});

test('the order ownership key survives a full storage instead of silently rotating', () => {
  // Central reads authorize by this key's hash alone, so a write that quietly
  // fails hands the customer a new identity and hides every past order.
  assert.match(appSource, /function persistCustomerOrderCapability\(capability\) \{/);
  assert.match(appSource, /\[CREATED_DEALS_KEY, CUSTOMER_GROUPS_KEY\]\.forEach\(\(storageKey\) => \{[\s\S]*?\}\);\s*\n\s*try \{\s*\n\s*localStorage\.setItem\(CUSTOMER_ORDER_CAPABILITY_KEY, capability\);\s*\n\s*return true;/);
  assert.match(appSource, /persisted: persistCustomerOrderCapability\(capability\),/);
  // The raw unguarded write must be gone.
  assert.equal(
    /capability = createClientCapability\('customer'\);\s*\n\s*localStorage\.setItem\(CUSTOMER_ORDER_CAPABILITY_KEY, capability\);/.test(appSource),
    false,
    'the ownership key is never written without quota recovery',
  );
});

test('a newly minted ownership key is explained rather than reported as a confirmed history', () => {
  assert.match(appSource, /let customerOrderCapabilityState = \{ created: false, persisted: true, lostKey: false \};/);
  assert.match(appSource, /export function getCustomerOrderCapabilityState\(\)/);
  assert.match(appSource, /customerOrderCapabilityState = \{\s*\n\s*created: true,/);
  // Minting a key on a first visit is normal; only a lost key warns.
  assert.match(appSource, /const freshKey = capability\.lostKey;/);
  assert.match(appSource, /lostKey: ordersWithoutKey,/);
  assert.match(appSource, /ordersWithoutKey = \[CUSTOMER_ORDERS_KEY, CUSTOMER_ORDER_SYNCED_KEY\]\.some/);
  assert.match(appSource, /이 브라우저의 주문 확인 키가 사라져 새로 만들었습니다\./);
  assert.match(appSource, /: <p>조회 가능한 주문 이력을 확인했습니다\.<\/p>\}/);
  assert.match(appSource, /\{!capability\.persisted && \(/);
  assert.match(appSource, /브라우저 저장공간이 부족해 주문 확인 키를 저장하지 못했습니다\./);
  // An empty list under a fresh key must not render the “no participation” state.
  assert.match(
    appSource,
    /orders\.length === 0 && historyStatus === 'ready' && !getCustomerOrderCapabilityState\(\)\.lostKey \?/,
  );
});
