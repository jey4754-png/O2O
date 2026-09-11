import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_APP_SESSION_KEY,
  clearActiveAppSession,
  isActiveAppSession,
  loadActiveAppSession,
  profileSessionKey,
  startActiveAppSession,
} from './appSession.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const profile = {
  testerType: '사용자',
  phone: '010-1234-5678',
};

test('active app session is tied to the remembered profile and survives a same-tab reload', () => {
  const storage = memoryStorage();
  const now = 1_700_000_000_000;
  const key = startActiveAppSession(profile, storage, now);

  assert.equal(key, '사용자:01012345678');
  assert.equal(loadActiveAppSession(storage), key);
  assert.equal(isActiveAppSession(profile, key), true);
  assert.equal(isActiveAppSession({ ...profile, testerType: '관리자' }, key), false);
});

test('malformed active sessions are removed and treated as signed out', () => {
  const storage = memoryStorage();
  storage.setItem(ACTIVE_APP_SESSION_KEY, '{broken-json');
  assert.equal(loadActiveAppSession(storage), '');
  assert.equal(storage.getItem(ACTIVE_APP_SESSION_KEY), null);

  storage.setItem(ACTIVE_APP_SESSION_KEY, JSON.stringify({
    profileKey: profileSessionKey(profile),
    startedAt: 0,
  }));
  assert.equal(loadActiveAppSession(storage), '');
  assert.equal(storage.getItem(ACTIVE_APP_SESSION_KEY), null);
});

test('launcher and logout can explicitly clear the current app session', () => {
  const storage = memoryStorage();
  startActiveAppSession(profile, storage, 1_700_000_000_000);
  clearActiveAppSession(storage);

  assert.equal(storage.getItem(ACTIVE_APP_SESSION_KEY), null);
  assert.equal(profileSessionKey({ testerType: '사용자', phone: '' }), '');
});
