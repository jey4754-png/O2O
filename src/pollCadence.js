export function nextPollDelay({ startedAt, completedAt, intervalMs, retryDelayMs }) {
  const interval = Math.max(0, Number(intervalMs) || 0);
  const retryDelay = Math.max(0, Number(retryDelayMs) || 0);
  if (retryDelay !== interval) return retryDelay;
  const elapsed = Math.max(0, Number(completedAt) - Number(startedAt));
  return Math.max(0, interval - elapsed);
}
