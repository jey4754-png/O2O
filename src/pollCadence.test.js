import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPollDelay } from './pollCadence.js';

test('successful snapshot polling keeps a five-second start-to-start cadence', () => {
  assert.equal(nextPollDelay({
    startedAt: 1_000,
    completedAt: 2_600,
    intervalMs: 5_000,
    retryDelayMs: 5_000,
  }), 3_400);
  assert.equal(nextPollDelay({
    startedAt: 1_000,
    completedAt: 8_000,
    intervalMs: 5_000,
    retryDelayMs: 5_000,
  }), 0);
});

test('failure backoff is measured after completion', () => {
  assert.equal(nextPollDelay({
    startedAt: 1_000,
    completedAt: 8_000,
    intervalMs: 5_000,
    retryDelayMs: 10_000,
  }), 10_000);
});
