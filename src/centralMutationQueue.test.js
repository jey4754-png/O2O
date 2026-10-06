import test from 'node:test';
import assert from 'node:assert/strict';

import { runCentralMutation } from './centralMutationQueue.js';

test('central mutation queue lets foreground work proceed during one slow background response', async () => {
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

  await foreground;
  assert.deepEqual(order, ['background-active', 'foreground']);
  releaseActive();
  await Promise.all([firstBackground, queuedBackground, foreground]);

  assert.equal(maxActive, 2);
  assert.deepEqual(order, [
    'background-active',
    'foreground',
    'background-queued',
  ]);
});

test('foreground writes stay serial and new background work waits for active foreground work', async () => {
  const order = [];
  let releaseFirst;
  const first = runCentralMutation(async () => {
    order.push('first-start');
    await new Promise(resolve => { releaseFirst = resolve; });
    order.push('first-done');
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const background = runCentralMutation(() => order.push('background'), { priority: 'background' });
  const second = runCentralMutation(() => order.push('second'));
  assert.deepEqual(order, ['first-start']);
  releaseFirst();
  await Promise.all([first, second, background]);
  assert.deepEqual(order, ['first-start', 'first-done', 'second', 'background']);
});
