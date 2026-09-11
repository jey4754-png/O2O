import test from 'node:test';
import assert from 'node:assert/strict';

import { createClientCapability } from './clientCapability.js';

test('client management capabilities require cryptographically secure random bytes', () => {
  let requestedLength = 0;
  const capability = createClientCapability('deal', {
    getRandomValues(bytes) {
      requestedLength = bytes.length;
      bytes.fill(0xab);
      return bytes;
    },
  });

  assert.equal(requestedLength, 32);
  assert.equal(capability, `deal-${'ab'.repeat(32)}`);
  assert.throws(
    () => createClientCapability('deal', {}),
    (error) => error?.code === 'secure_random_unavailable',
  );
});
