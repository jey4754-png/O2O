import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptRecoveredGroupCredential,
  getGroupCredential,
  getGroupCredentials,
  getGroupRoomCredential,
} from '../src/groupApi.js';

// 2026-10-14 17:45 PC 되살리기 직후 PC 자기 방 두 곳의 조회가 1분에 12번씩
// invalid_capability 로 거절됐다(직전 분 0건). 이튿날 고객은 PC 에서 그 두 방에
// 들어가지 못했고, 되살린 경기미 방은 휴대폰·PC 모두 채팅 버튼 대신 '모집 종료'만
// 보였다. 브라우저 쪽 자격 저장·선택을 실제 함수로 확인한다.
const KEY = 'o2o_mvp_group_credentials_v1';
const OWN_TOKEN = 'own-participant-capability-token-000000000001';
const CUSTOMER_TOKEN = 'device-customer-capability-token-00000000002';

function withStorage(seed, run) {
  const values = new Map([[KEY, JSON.stringify(seed)]]);
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

test('되살린 자격이 이 기기 자신의 자격을 덮어쓰지 않는다', () => {
  withStorage({
    'room-milk::actor-pc': { groupId: 'room-milk', actorId: 'actor-pc', capabilityToken: OWN_TOKEN, role: 'host' },
  }, () => {
    adoptRecoveredGroupCredential('room-milk', 'actor-pc', CUSTOMER_TOKEN);
    const kept = getGroupCredential('room-milk', 'actor-pc');
    assert.equal(kept.capabilityToken, OWN_TOKEN, '참여자 행과 바로 맞는 진짜 토큰이 남는다');
    assert.equal(kept.role, 'host', '호스트가 member 로 내려가지 않는다');
    assert.notEqual(kept.recovered, true);
  });
});

test('예전 형식으로 저장된 자기 자격도 덮어쓰지 않는다', () => {
  withStorage({
    'room-milk': { groupId: 'room-milk', actorId: 'actor-pc', capabilityToken: OWN_TOKEN, role: 'host' },
  }, () => {
    adoptRecoveredGroupCredential('room-milk', 'actor-pc', CUSTOMER_TOKEN);
    assert.equal(getGroupCredential('room-milk', 'actor-pc').capabilityToken, OWN_TOKEN);
    assert.ok(getGroupCredentials()['room-milk'], '예전 형식 키가 지워지지 않는다');
  });
});

test('없는 자리에는 되살린 자격을 넣고, 되살린 자격끼리는 새 값으로 바꾼다', () => {
  withStorage({}, () => {
    adoptRecoveredGroupCredential('room-rice', 'actor-old', CUSTOMER_TOKEN);
    const added = getGroupCredential('room-rice', 'actor-old');
    assert.equal(added.capabilityToken, CUSTOMER_TOKEN);
    assert.equal(added.recovered, true);
    const next = 'device-customer-capability-token-00000000003';
    adoptRecoveredGroupCredential('room-rice', 'actor-old', next);
    assert.equal(getGroupCredential('room-rice', 'actor-old').capabilityToken, next);
  });
});

test('방문자ID 로 자격이 없으면 그 방의 되살린 자격으로 연다', () => {
  // 경기미: 되살린 자격은 원래 참여자ID(actor-old) 밑에 있고, 이 기기 방문자ID 는 다르다.
  withStorage({
    'room-rice::actor-old': {
      groupId: 'room-rice', actorId: 'actor-old', capabilityToken: CUSTOMER_TOKEN, role: 'host', recovered: true,
    },
  }, () => {
    assert.equal(getGroupCredential('room-rice', 'actor-this-browser'), null, '예전 조회는 못 찾았다');
    const found = getGroupRoomCredential('room-rice', 'actor-this-browser');
    assert.equal(found?.actorId, 'actor-old');
    assert.equal(found?.capabilityToken, CUSTOMER_TOKEN);
  });
});

test('같은 방에 자기 자격과 되살린 자격이 함께 있으면 자기 자격을 먼저 쓴다', () => {
  withStorage({
    'room-milk::actor-phone': {
      groupId: 'room-milk', actorId: 'actor-phone', capabilityToken: CUSTOMER_TOKEN, role: 'member', recovered: true,
    },
    'room-milk::actor-pc': { groupId: 'room-milk', actorId: 'actor-pc', capabilityToken: OWN_TOKEN, role: 'host' },
  }, () => {
    assert.equal(getGroupRoomCredential('room-milk', 'actor-someone-else')?.actorId, 'actor-pc');
    // 원하는 참여자ID 가 있으면 그것이 우선이다(주문 카드에서 그 주문의 참여로 열 때).
    assert.equal(getGroupRoomCredential('room-milk', 'actor-phone')?.actorId, 'actor-phone');
  });
});

test('비활성 자격이나 다른 방의 자격은 고르지 않는다', () => {
  withStorage({
    'room-milk::actor-pc': {
      groupId: 'room-milk', actorId: 'actor-pc', capabilityToken: OWN_TOKEN, role: 'host', active: false,
    },
    'room-other::actor-pc': { groupId: 'room-other', actorId: 'actor-pc', capabilityToken: OWN_TOKEN, role: 'host' },
  }, () => {
    assert.equal(getGroupRoomCredential('room-milk', 'actor-x'), null);
  });
});
