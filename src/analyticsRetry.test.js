import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING_EVENT_BATCH_SIZE,
  pendingCentralBackoffDelay,
  pendingCentralBatch,
  processPendingCentralBatch,
} from './analyticsRetry.js';

test('pending analytics retries use a small oldest-first batch', () => {
  const events = Array.from({ length: 6 }, (_, index) => ({
    id: `event-${index + 1}`,
    pendingCentral: index !== 1,
  }));
  const pendingIds = new Set(events.map((event) => event.id));

  assert.deepEqual(
    pendingCentralBatch(events, pendingIds).map((event) => event.id),
    ['event-1', 'event-3', 'event-4'],
  );
  assert.equal(PENDING_EVENT_BATCH_SIZE, 3);
});

test('pending analytics retries keep the bounded batch moving after a failed event', async () => {
  const attempted = [];
  const results = await processPendingCentralBatch(
    [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
    async (event) => {
      attempted.push(event.id);
      return event.id !== 'two';
    },
  );

  assert.deepEqual(attempted, ['one', 'two', 'three']);
  assert.deepEqual(results, [true, false, true]);
});

test('one permanently failing event cannot starve later pending events', async () => {
  const events = Array.from({ length: 5 }, (_, index) => ({
    id: `event-${index + 1}`,
    pendingCentral: true,
  }));
  const attempted = [];

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const pendingIds = new Set(
      events.filter((event) => event.pendingCentral).map((event) => event.id),
    );
    const batch = pendingCentralBatch(events, pendingIds);
    const results = await processPendingCentralBatch(batch, async (event) => {
      attempted.push(event.id);
      return event.id !== 'event-1';
    });
    batch.forEach((event, index) => {
      if (results[index]) event.pendingCentral = false;
    });
  }

  assert.deepEqual(attempted, [
    'event-1',
    'event-2',
    'event-3',
    'event-1',
    'event-4',
    'event-5',
  ]);
  assert.equal(events[0].pendingCentral, true);
  assert.deepEqual(
    events.slice(1).map((event) => event.pendingCentral),
    [false, false, false, false],
  );
});

test('a transiently failing event remains eligible and succeeds on a later batch', async () => {
  const events = [
    { id: 'transient', pendingCentral: true },
    { id: 'later', pendingCentral: true },
  ];
  let transientAttempts = 0;

  const send = async (event) => {
    if (event.id !== 'transient') return true;
    transientAttempts += 1;
    return transientAttempts > 1;
  };

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const pendingIds = new Set(
      events.filter((event) => event.pendingCentral).map((event) => event.id),
    );
    const batch = pendingCentralBatch(events, pendingIds);
    const results = await processPendingCentralBatch(batch, send);
    batch.forEach((event, index) => {
      if (results[index]) event.pendingCentral = false;
    });
  }

  assert.equal(transientAttempts, 2);
  assert.deepEqual(events.map((event) => event.pendingCentral), [false, false]);
});

test('a thrown send error is isolated to its event', async () => {
  const attempted = [];
  const results = await processPendingCentralBatch(
    [{ id: 'bad' }, { id: 'good' }],
    async (event) => {
      attempted.push(event.id);
      if (event.id === 'bad') throw new Error('network failed');
      return true;
    },
  );

  assert.deepEqual(attempted, ['bad', 'good']);
  assert.deepEqual(results, [false, true]);
});

test('pending analytics retry delay grows exponentially with bounded jitter', () => {
  assert.equal(pendingCentralBackoffDelay(1, 0), 12000);
  assert.equal(pendingCentralBackoffDelay(2, 0.5), 30000);
  assert.equal(pendingCentralBackoffDelay(3, 1), 72000);
  assert.ok(pendingCentralBackoffDelay(20, 1) <= 5 * 60 * 1000);
});
