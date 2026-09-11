import test from 'node:test';
import assert from 'node:assert/strict';

import { featuresForPhase } from './releasePhase.js';

test('phase 6 exposes calculation and trade management without later features', () => {
  assert.deepEqual(featuresForPhase(6), {
    phase: 6,
    chat: false,
    admin: false,
    unreadBadges: false,
    sharing: false,
    deepLinks: false,
  });
});

test('later phases unlock chat, admin, notifications, sharing, and deep links in order', () => {
  assert.equal(featuresForPhase(8).chat, true);
  assert.equal(featuresForPhase(8).admin, true);
  assert.equal(featuresForPhase(8).sharing, false);
  assert.equal(featuresForPhase(9).sharing, true);
  assert.equal(featuresForPhase(9).deepLinks, true);
});

test('invalid phase values safely default to the complete phase 9 release', () => {
  assert.deepEqual(featuresForPhase('not-a-number'), {
    phase: 9,
    chat: true,
    admin: true,
    unreadBadges: true,
    sharing: true,
    deepLinks: true,
  });
  assert.equal(featuresForPhase(0).phase, 1);
  assert.equal(featuresForPhase(99).phase, 12);
});
