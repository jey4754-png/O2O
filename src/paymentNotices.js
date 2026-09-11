export const PAYMENT_NOTICE_SEEN_KEY = 'o2o_payment_notice_seen_v1';
const LABELS = { pending: '입금대기', requested: '입금확인 요청', confirmed: '입금완료' };

export function latestPaymentNotice(snapshot, actorId, seenId = '') {
  const viewer = snapshot?.participants?.find((participant) => participant.actorId === actorId);
  const manager = ['host', 'admin'].includes(viewer?.role || snapshot?.viewer?.role);
  const changes = (snapshot?.history || []).filter((item) => item.entityType === 'payment'
    && LABELS[item.toStatus]
    && (item.entityId === actorId || manager)
    && item.actorId !== actorId);
  const last = changes.at(-1);
  if (!last) return null;
  const id = last.historyId || last.id || last.clientMutationId || `${last.entityId}:${last.version}:${last.createdAt}:${last.toStatus}`;
  if (id === seenId) return null;
  const participant = snapshot.participants?.find((item) => item.actorId === last.entityId);
  return { id, text: `입금 알림 · ${last.entityId === actorId ? '내 입금 상태' : participant?.nickname || '참여자'}: ${LABELS[last.toStatus]}` };
}
