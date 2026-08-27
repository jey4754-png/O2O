import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appsScriptSource = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const capacity = new Function(`${appsScriptSource}\nreturn { merchantCapacityError_, merchantCapacityFloorError_ };`)();

test('merchant checkout capacity rejects a concurrent order beyond the remaining quantity', () => {
  assert.equal(capacity.merchantCapacityError_(20, 18, 2), '');
  assert.equal(capacity.merchantCapacityError_(20, 19, 2), 'quantity_unavailable');
  assert.equal(capacity.merchantCapacityError_(20, 0, 0), 'invalid_order_quantity');
});

test('merchant total quantity cannot shrink below active allocations', () => {
  assert.equal(capacity.merchantCapacityFloorError_(20, 7), '');
  assert.equal(capacity.merchantCapacityFloorError_(7, 7), '');
  assert.equal(
    capacity.merchantCapacityFloorError_(6, 7),
    'quantity_below_active_allocations',
  );
});
