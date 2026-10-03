export const PAYMENT_NOTICE_SEEN_KEY = 'o2o_payment_notice_seen_v1';
const LABELS = { pending: '입금대기', requested: '입금확인 요청', confirmed: '입금완료' };
const noticeId = (item) => item.historyId || item.id || item.clientMutationId || `${item.entityId}:${item.version}:${item.createdAt}:${item.toStatus}`;
const inactive = (participant) => participant?.active === false || (participant?.counted === false && participant?.role !== 'admin');

export function latestPaymentNotice(snapshot, actorId, seenId = '') {
  const viewer = snapshot?.participants?.find((participant) => participant.actorId === actorId);
  if (inactive(viewer) || snapshot?.viewer?.active === false) return null;
  const manager = ['host', 'admin'].includes(viewer?.role || snapshot?.viewer?.role);
  const changes = (snapshot?.history || []).filter((item) => item.entityType === 'payment'
    && LABELS[item.toStatus]
    && (item.entityId === actorId || manager));
  const seenIndex = changes.findIndex((item) => noticeId(item) === seenId);
  const latestEntities = new Set();
  // Resolve each participant's latest state before excluding the viewer's own
  // action. Otherwise their confirmation/cancellation exposes an older request.
  for (let index = changes.length - 1; index > seenIndex; index -= 1) {
    const last = changes[index];
    if (latestEntities.has(last.entityId)) continue;
    latestEntities.add(last.entityId);
    const participant = snapshot.participants?.find((item) => item.actorId === last.entityId);
    if (!participant || inactive(participant) || last.actorId === actorId
      || (participant.paymentStatus && participant.paymentStatus !== last.toStatus)) continue;
    return { id: noticeId(last), text: `입금 알림 · ${last.entityId === actorId ? '내 입금 상태' : participant.nickname || '참여자'}: ${LABELS[last.toStatus]}` };
  }
  return null;
}
