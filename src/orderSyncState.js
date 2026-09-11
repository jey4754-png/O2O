import { customerOrderSyncFingerprint } from './customerHistory.js';

// A rejected payload may be held to avoid an automatic retry loop. It is
// never evidence that the order was accepted by the central store.
export function shouldPublishQueuedOrder(order, acknowledgements = {}, issues = {}) {
  const fingerprint = customerOrderSyncFingerprint(order);
  const issue = issues[order.id];
  if (!issue && acknowledgements[order.id] === fingerprint) return false;
  if (issue?.state === 'failed'
    && (issue.fingerprint || acknowledgements[order.id]) === fingerprint) return false;
  return true;
}

export function rejectedOrderSyncIssue(order, error) {
  return {
    state: 'failed',
    code: error?.code || error?.message || 'terminal_request_error',
    fingerprint: customerOrderSyncFingerprint(order),
    updatedAt: new Date().toISOString(),
  };
}

export function orderSyncStateChanged({ previousOrder, currentOrder,
  previousAcknowledgement, currentAcknowledgement, previousIssue, currentIssue }) {
  return previousAcknowledgement !== currentAcknowledgement
    || JSON.stringify(previousIssue) !== JSON.stringify(currentIssue)
    || Boolean(previousOrder) !== Boolean(currentOrder)
    || Boolean(previousOrder && customerOrderSyncFingerprint(previousOrder) !== customerOrderSyncFingerprint(currentOrder));
}
