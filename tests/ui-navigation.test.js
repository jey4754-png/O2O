import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCOPED_UI_ACTIONS } from '../src/scopeUi.js';

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const adminConsoleSource = readFileSync(new URL('../src/AdminConsole.jsx', import.meta.url), 'utf8');
const groupRoomSource = readFileSync(new URL('../src/GroupRoom.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('onboarding blocks incomplete phone numbers and exposes a validation error', () => {
  assert.match(appSource, /const phoneValid = isValidKoreanMobilePhone\(form\.phone\)/);
  assert.match(appSource, /const disabled = !form\.name\.trim\(\) \|\| !phoneValid \|\| !form\.consent/);
  assert.match(appSource, /aria-invalid=\{phoneErrorVisible\}/);
  assert.match(appSource, /\{KOREAN_MOBILE_PHONE_ERROR\}/);
});

test('onboarding resets retained mobile scroll and starts from the first field', () => {
  assert.match(appSource, /useLayoutEffect\(\(\) => \{/);
  assert.match(appSource, /screenRef\.current\.scrollTop = 0/);
  assert.match(appSource, /requestAnimationFrame\(resetScroll\)/);
  assert.match(appSource, /addEventListener\('pageshow', resetScroll\)/);
  assert.match(appSource, /key="owner-onboarding"/);
  assert.match(appSource, /key="admin-onboarding"/);
  assert.match(appSource, /window\.scrollTo\?\.\(0, 0\)/);
  assert.match(stylesSource, /\.onboarding-screen\s*\{[^}]*justify-content:\s*flex-start/s);
});

test('scope-aligned UI hides destructive entry points but keeps payment and host controls', () => {
  assert.deepEqual(SCOPED_UI_ACTIONS, { participationCancellation: false, productDeletion: false });
  assert.equal(Object.isFrozen(SCOPED_UI_ACTIONS), true);
  assert.match(appSource, /const canCancel = SCOPED_UI_ACTIONS\.participationCancellation/);
  assert.match(groupRoomSource, /const canCancelMyParticipation = SCOPED_UI_ACTIONS\.participationCancellation/);
  assert.equal(appSource.match(/\{SCOPED_UI_ACTIONS\.productDeletion && \(/g)?.length, 2);
  assert.match(appSource, /if \(!SCOPED_UI_ACTIONS\.participationCancellation \|\| cancellingId\) return/);
  assert.equal(appSource.match(/if \(!SCOPED_UI_ACTIONS\.productDeletion/g)?.length, 2);
  assert.match(groupRoomSource, /if \(!canCancelMyParticipation/);
  assert.match(groupRoomSource, /paymentStatus === 'requested' \? '요청 취소' : '입금했어요'/);
  assert.match(groupRoomSource, /paymentStatus === 'confirmed' \? '완료 취소' : paymentStatus === 'pending' \? '확인 요청으로 변경' : '입금 확인'/);
  assert.match(groupRoomSource, /releaseGroupHost\(\{ deal, actorId \}\)/);
  assert.match(groupRoomSource, /호스트 지원 취소/);
  assert.match(groupRoomSource, /참여 취소 후 수량 다시 선택/);
  assert.match(groupRoomSource, /groupStatus === 'recruiting' && !paymentsReady/);
  assert.match(groupRoomSource, /typeof group\?\.paymentReady === 'boolean'/);
  assert.match(groupRoomSource, /pendingPaymentCount/);
  assert.match(groupRoomSource, /updatedOrderActorId === actorId\) onOrderUpdate\?\.\(result\.order\)/);
  assert.match(groupRoomSource, /o2o-customer-orders-updated/);
  assert.match(groupRoomSource, /viewerPaymentStatus !== observedPaymentStatusRef\.current/);
  assert.match(groupRoomSource, /입금확인 요청 상태가 채팅과 내 주문에 반영되었습니다/);
  assert.match(appSource, /const tracksPayment = order\.type === 'purchase' \|\| Boolean\(order\.groupId\)/);
});

test('group polling applies its central snapshot locally without republishing or leaking a rejection', () => {
  assert.match(groupRoomSource, /observedDealUpdateRef/);
  assert.match(groupRoomSource, /onDealUpdate\(observedDeal, \{ sync: false, observed: true \}\)/);
  assert.match(groupRoomSource, /\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(groupRoomSource, /\{ sync: isCreator, observed: true \}/);
});

test('financially coupled group mutations never fall back to browser-only state', () => {
  const groupApiSource = readFileSync(new URL('../src/groupApi.js', import.meta.url), 'utf8');
  const cancellation = groupApiSource.slice(
    groupApiSource.indexOf('export async function cancelGroupParticipation'),
    groupApiSource.indexOf('export async function sendGroupMessage'),
  );
  assert.match(cancellation, /allowLocalFallback:\s*false/);
  assert.match(cancellation, /await requestGroupOperation\(payload\)/);
  assert.doesNotMatch(cancellation, /withFallback|localCancelGroupParticipation/);
  assert.match(groupApiSource, /transition_group[\s\S]*?allowLocalFallback:\s*false/);
  assert.match(groupApiSource, /transition_payment[\s\S]*?allowLocalFallback:\s*false/);
  assert.match(groupApiSource, /update_target[\s\S]*?allowLocalFallback:\s*false/);
  assert.match(groupApiSource, /toggle_lock[\s\S]*?allowLocalFallback:\s*false/);
  assert.match(groupApiSource, /const allowLocalFallback = options\.allowLocalFallback === true/);
});

test('group messages never report a browser-only success', () => {
  const groupApiSource = readFileSync(new URL('../src/groupApi.js', import.meta.url), 'utf8');
  const messageMutation = groupApiSource.slice(
    groupApiSource.indexOf('export async function sendGroupMessage'),
    groupApiSource.indexOf('export async function markGroupRead'),
  );
  assert.match(messageMutation, /await requestGroupOperation\(payload\)/);
  assert.doesNotMatch(messageMutation, /withFallback|mutateLocal|localOnly/);
});

test('ambiguous order responses stay pending and reuse the frozen order identity', () => {
  assert.match(appSource, /const frozenPendingOrder = checkoutAttempt/);
  assert.match(appSource, /const newOrder = frozenPendingOrder \|\| buildCustomerOrderRecord\(order/);
  assert.match(appSource, /centralOrders\.find\(\(item\) => item\.id === newOrder\.id\)/);
  assert.match(appSource, /pendingSyncError = new Error\('order_sync_pending'\)/);
  assert.match(appSource, /saveJson\(CUSTOMER_ORDERS_KEY, persistedOrders\)/);
  assert.match(appSource, /if \(pendingSyncError\) throw pendingSyncError/);
});

test('legacy recruitment defaults are shared by detail and checkout screens', () => {
  assert.equal(appSource.match(/const recruitmentOpen = isDealRecruiting\(deal\);/g)?.length, 2);
  assert.match(appSource, /const checkoutAvailable = canSubmitDealOrder\(/);
  assert.match(appSource, /disabled=\{!checkoutAvailable\}/);
});

test('failed deal deletion does not navigate away from the detail screen', () => {
  assert.match(appSource, /if \(shouldNavigateAfterDealDelete\(deleted\)\) onScreen\('list'\)/);
  assert.match(appSource, /setDeleteError\('상품을 삭제하지 못했습니다\./);
});

test('browser navigation clears merchant preview outside the customer route', () => {
  assert.match(
    appSource,
    /const nextRoute = normalizeRoute\(window\.location\.pathname\);\s*if \(!shouldKeepOwnerPreview\(nextRoute\)\) setOwnerPreviewMode\(false\)/,
  );
});

test('missing or malformed customer contacts are not rendered as empty telephone links', () => {
  assert.doesNotMatch(appSource, /href=\{`tel:\$\{order\.customerPhone \|\| ''\}`\}/);
  assert.match(appSource, /const callablePhone = callableKoreanMobilePhone\(order\.customerPhone\)/);
});

test('group room controls guard duplicate entry and label icon-only target controls', () => {
  assert.match(groupRoomSource, /const ensureMembership = async \(\) => \{\s*if \(joining\) return;/);
  assert.match(groupRoomSource, /aria-label="목표 인원 감소"/);
  assert.match(groupRoomSource, /aria-label="목표 인원 증가"/);
});

test('portrait product images remain complete in detail and upload previews', () => {
  assert.match(stylesSource, /\.done-image\s*\{[^}]*height:\s*auto;[^}]*object-fit:\s*contain;/s);
  assert.match(stylesSource, /\.product-complete-screen\s*\{[^}]*justify-content:\s*flex-start;/s);
  assert.match(
    stylesSource,
    /\.hero-image\s*\{[^}]*height:\s*auto;[^}]*max-height:[^;}]+;[^}]*object-fit:\s*contain;/s,
  );
  assert.match(
    stylesSource,
    /\.group-image-uploader img\s*\{[^}]*object-fit:\s*contain;/s,
  );
  assert.match(
    stylesSource,
    /\.owner-image-uploader img\s*\{[^}]*object-fit:\s*contain;/s,
  );
  assert.match(appSource, /className="hero-image"[\s\S]*?onError=\{replaceBrokenImage\}/);
});

test('every product image surface uses an empty-value and load-error fallback', () => {
  assert.equal(appSource.match(/onError=\{replaceBrokenImage\}/g)?.length, 7);
  assert.match(appSource, /className="deal-card"[\s\S]*?src=\{deal\.image \|\| fallbackImage\}[\s\S]*?onError=\{replaceBrokenImage\}/);
  assert.match(appSource, /className="share-summary"[\s\S]*?src=\{deal\.image \|\| fallbackImage\}[\s\S]*?onError=\{replaceBrokenImage\}/);
  assert.match(appSource, /className="owner-product-card"[\s\S]*?src=\{deal\.image \|\| fallbackImage\}[\s\S]*?onError=\{replaceBrokenImage\}/);
  assert.match(appSource, /className="done-image"\s*src=\{deal\.image \|\| fallbackImage\}[\s\S]*?onError=\{replaceBrokenImage\}/);
  assert.match(appSource, /function ImageCropUploader[\s\S]*?src=\{value \|\| fallbackImage\}[\s\S]*?onError=\{replaceBrokenImage\}/);
  assert.equal(appSource.match(/<ImageCropUploader/g)?.length, 2);
  assert.match(appSource, /<ImageCropUploader\s+className="owner-image-uploader"/);
  assert.match(appSource, /<ImageCropUploader\s+className="group-image-uploader"/);
  assert.match(appSource, /function ImageCropUploader\([\s\S]*?maxSize = PRODUCT_IMAGE_MAX_SIZE,/);
  assert.match(appSource, /image: await prepareImageForSync\(deal.image \|\| fallbackImage\)/);
  assert.doesNotMatch(appSource, /function compactImageForSync/);
  assert.match(adminConsoleSource,
    /className="admin-product"[\s\S]*?src=\{deal\.image \|\| ADMIN_IMAGE_FALLBACK\}[\s\S]*?loading="lazy"[\s\S]*?onError=\{replaceBrokenAdminImage\}/);
});

test('calculator keeps role-filtered bottom navigation and read-only opens do not acknowledge status', () => {
  assert.match(
    appSource,
    /<BottomNav active="calculator" onSelect=\{navigateCustomer\} readOnly=\{readOnly\} \/>/,
  );
  assert.match(
    appSource,
    /const acknowledgeGroupStatus = \(deal\) => \{\s*if \(customerReadOnly \|\| !RELEASE_FEATURES\.unreadBadges\) return;/,
  );
});
