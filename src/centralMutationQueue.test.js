import test from 'node:test';
import assert from 'node:assert/strict';

import { runCentralMutation } from './centralMutationQueue.js';

test('central mutation queue serializes writes and prioritizes foreground work', async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  let releaseActive;

  const firstBackground = runCentralMutation(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('background-active');
    await new Promise((resolve) => {
      releaseActive = resolve;
    });
    active -= 1;
  }, { priority: 'background' });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const queuedBackground = runCentralMutation(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('background-queued');
    active -= 1;
  }, { priority: 'background' });

  const foreground = runCentralMutation(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('foreground');
    active -= 1;
  });

  releaseActive();
  await Promise.all([firstBackground, queuedBackground, foreground]);

  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'background-active',
    'foreground',
    'background-queued',
  ]);
});
