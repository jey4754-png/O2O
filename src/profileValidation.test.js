import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callableKoreanMobilePhone,
  formatKoreanMobilePhoneInput,
  isValidKoreanMobilePhone,
  normalizeKoreanMobilePhone,
} from './profileValidation.js';

test('Korean mobile validation accepts only a complete 010 number', () => {
  assert.equal(isValidKoreanMobilePhone('010-1234-5678'), true);
  assert.equal(isValidKoreanMobilePhone('010 1234 5678'), true);
  assert.equal(isValidKoreanMobilePhone('0101234'), false);
  assert.equal(isValidKoreanMobilePhone('011-123-4567'), false);
  assert.equal(isValidKoreanMobilePhone('02-1234-5678'), false);
  assert.equal(isValidKoreanMobilePhone('010-1234-56789'), false);
});

test('only valid mobile numbers become callable contact targets', () => {
  assert.equal(callableKoreanMobilePhone('010-1234-5678'), '01012345678');
  assert.equal(callableKoreanMobilePhone('0101234'), '');
  assert.equal(callableKoreanMobilePhone('미설정'), '');
});

test('Korean mobile input is normalized and formatted without hiding extra invalid digits', () => {
  assert.equal(normalizeKoreanMobilePhone('010-12a34-567890'), '0101234567890');
  assert.equal(formatKoreanMobilePhoneInput('010-12a34-567890'), '010-1234-567890');
  assert.equal(formatKoreanMobilePhoneInput('0101'), '010-1');
  assert.equal(formatKoreanMobilePhoneInput('01012345'), '010-1234-5');
  assert.equal(formatKoreanMobilePhoneInput('01012345678'), '010-1234-5678');
});
