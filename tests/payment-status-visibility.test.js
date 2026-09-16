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
