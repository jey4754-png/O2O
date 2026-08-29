const QUANTITY_CONFLICT_ERRORS = new Set([
  'quantity_unavailable',
  'quantity_exceeds_total',
  'group_full',
]);

const RECRUITMENT_CLOSED_ERRORS = new Set([
  'quantity_reservation_closed',
  'group_not_recruiting',
  'participation_closed',
]);

function errorCode(error) {
  return String(error?.code || error?.message || '');
}

export function joinSubmitErrorMessage(error) {
  const code = errorCode(error);
  if (QUANTITY_CONFLICT_ERRORS.has(code)) {
    return '다른 참여자가 먼저 남은 수량을 선택했습니다. 상품 상세에서 최신 수량을 확인해 주세요.';
  }
  if (RECRUITMENT_CLOSED_ERRORS.has(code)) {
    return '모집이 종료되어 더 이상 참여할 수 없습니다. 상품 상세에서 현재 상태를 확인해 주세요.';
  }
  if (['group_not_found', 'group_not_ready'].includes(code)) {
    return '그룹 채팅방을 준비하고 있습니다. 잠시 후 상품 화면을 새로고침하여 다시 시도해 주세요.';
  }
  if (['order_sync_failed', 'collector_failed', 'collector_unreachable'].includes(code)) {
    return '주문 저장 서버와 연결하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
  }
  return '참여 신청을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function hostApplyErrorMessage(error) {
  const code = errorCode(error);
  if (code === 'host_already_claimed') return '다른 참여자가 먼저 호스트로 확정되었습니다.';
  if (code === 'host_claim_closed') return '현재는 호스트 지원을 받을 수 없는 상태입니다.';
  if (['forbidden', 'participant_not_found', 'actor_not_joined', 'host_order_required'].includes(code)) {
    return '먼저 이 공동구매에 참여한 뒤 호스트 지원을 다시 눌러 주세요.';
  }
  if (['group_not_found', 'group_not_ready'].includes(code)) {
    return '그룹 채팅방을 준비하고 있습니다. 잠시 후 새로고침하여 다시 시도해 주세요.';
  }
  if (code === 'state_conflict') return '다른 변경이 먼저 반영되었습니다. 새로고침한 뒤 다시 시도해 주세요.';
  return '호스트 지원을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function dealHasGroupRoom(deal) {
  if (!deal || deal.saleType === 'instant') return false;
  return Boolean(
    deal.groupId
    || deal.source === 'customer'
    || (deal.source === 'merchant' && (deal.saleType === 'group' || deal.splitPricing === true)),
  );
}

export function canOpenOrderGroupRoom({ order, deal, cancelled = false }) {
  if (!order || !deal || cancelled || order.type !== 'purchase' || deal.saleType === 'instant') return false;
  return Boolean(order.groupId || dealHasGroupRoom(deal));
}

export function isDealHostMatched(deal = {}, legacyHostDealIds = []) {
  if (deal.source === 'customer') {
    if (deal.hostMode === 'recruiting') return Boolean(deal.hostMatched || deal.hostActorId);
    return deal.hostMode === 'self' || Boolean(deal.hostMatched || deal.hostActorId);
  }
  if (deal.source === 'merchant' && deal.saleType === 'group') {
    return Boolean(deal.hostMatched || deal.hostActorId);
  }
  return Boolean(deal.hostMatched || legacyHostDealIds.includes(deal.id));
}
