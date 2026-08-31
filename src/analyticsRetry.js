export const PENDING_EVENT_BATCH_SIZE = 3;
export const PENDING_EVENT_BASE_BACKOFF_MS = 15000;
export const PENDING_EVENT_MAX_BACKOFF_MS = 5 * 60 * 1000;

export function pendingCentralBatch(events, pendingIds, limit = PENDING_EVENT_BATCH_SIZE) {
  const batchSize = Math.max(1, Math.floor(Number(limit) || PENDING_EVENT_BATCH_SIZE));
  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.pendingCentral && pendingIds?.has(event.id))
    .slice(0, batchSize);
}

export function pendingCentralBackoffDelay(failureCount, randomValue = Math.random()) {
  const failures = Math.max(1, Math.floor(Number(failureCount) || 1));
  const exponent = Math.min(6, failures - 1);
  const baseDelay = Math.min(
    PENDING_EVENT_MAX_BACKOFF_MS,
    PENDING_EVENT_BASE_BACKOFF_MS * (2 ** exponent),
  );
  const normalizedRandom = Math.max(0, Math.min(1, Number(randomValue) || 0));
  const jitteredDelay = Math.round(baseDelay * (0.8 + (normalizedRandom * 0.4)));
  return Math.min(PENDING_EVENT_MAX_BACKOFF_MS, jitteredDelay);
}

export async function processPendingCentralBatch(events, sendEvent) {
  const results = [];
  for (const event of events) {
    let stored = false;
    try {
      stored = Boolean(await sendEvent(event));
    } catch {
      stored = false;
    }
    results.push(stored);
  }
  return results;
}
