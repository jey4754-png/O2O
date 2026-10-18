// Resolve only a seat already backed by a saved credential. An order or phone
// number alone never creates a room credential or authorizes participation.
export function resolveOrderRoomAccess(order, deal, readCredential) {
  const groupId = String(order?.groupId || deal?.groupId || deal?.id || '');
  const actorId = String(order?.participantActorId || order?.visitorId || '');
  if (!groupId || !actorId || order?.status === 'cancelled'
    || order?.paymentStatus === 'cancelled' || deal?.saleType === 'instant') return null;
  const credential = readCredential(groupId, actorId);
  if (!credential || credential.active === false || credential.actorId !== actorId
    || (credential.groupId && credential.groupId !== groupId)
    || String(credential.capabilityToken || '').length < 32) return null;
  return { groupId, actorId };
}

// 이 기기의 내 주문에 그 방의 활성 주문이 있는데 이 기기에 그 방 자격이 하나도 없으면,
// 그 자리는 서버에 이미 있고 다른 기기(또는 사라진 브라우저)의 것이다. 여기서 다시
// 참여하면 409 로 막히거나, 참여자ID 가 다르면 같은 고객의 두 번째 자리와 수량 예약이
// 생긴다(2026-10-18 휴대폰 탐사 메모지). 참여 대신 되살리기로 안내한다.
export const ORDER_SEAT_ELSEWHERE_MESSAGE = '이 기기에는 이 방의 입장 정보가 없습니다. 다시 참여하지 마시고, 내 주문 → ‘이전 주문이 보이지 않나요?’에서 확인번호로 되살려 주세요. 되살린 뒤에도 같으면 운영자에게 이 주문의 채팅 연결 점검을 요청해 주세요.';

export function orderSeatWithoutRoomCredential({ orders, groupIds, credential }) {
  if (credential) return null;
  const ids = new Set((groupIds || []).map((id) => String(id || '')).filter(Boolean));
  if (!ids.size) return null;
  return (orders || []).find((order) => (
    order
    && ['purchase', 'group'].includes(order.type)
    && order.status !== 'cancelled'
    && order.paymentStatus !== 'cancelled'
    && ids.has(String(order.groupId || order.dealId || ''))
  )) || null;
}

// 이 기기에 그 방 자격이 있는데 지금 방문자ID 의 것이 아니면(되살린 다른 참여자ID 의
// 자리 등) 새로 참여하지 않는다. 그 자리가 이미 이 고객의 자리이고, 지금 방문자ID 로
// join 하면 같은 고객의 두 번째 자리와 수량 예약이 생긴다(PC 방문자가 되살린 자리를
// 가진 방). 다른 참여자ID 로 수량을 늘리는 경로는 두지 않는다.
export function roomCredentialUnderAnotherActor({ exactCredential, roomCredential, actorId }) {
  if (exactCredential || !roomCredential) return null;
  if (!roomCredential.actorId || String(roomCredential.actorId) === String(actorId || '')) return null;
  return roomCredential;
}
