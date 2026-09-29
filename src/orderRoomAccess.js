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
