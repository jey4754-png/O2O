// A read started before a mutation must never restore an older payment button.
export function isOlderGroupSnapshot(next, current) {
  if (!current || !next || next.group?.id !== current.group?.id) return false;
  if (Number(next.group?.version || 0) < Number(current.group?.version || 0)
    || Number(next.lastSeq || 0) < Number(current.lastSeq || 0)) return true;
  const incoming = new Map((next.participants || []).map((item) => [item.actorId, item]));
  return (current.participants || []).some((item) => incoming.has(item.actorId)
    && Number(incoming.get(item.actorId).version || 0) < Number(item.version || 0));
}
