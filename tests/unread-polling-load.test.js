import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUnreadCounts, getGroupRoomCredential } from '../src/groupApi.js';

// 2026-10-15 17:11~17:22 운영 기록. 되살리기로 자격이 10개가 된 PC 가 배지 조회 10건을
// 한꺼번에 보내고(그중 2건은 매번 403), 휴대폰까지 열리자 16~20건이 겹쳐 구글이
// 요청을 거절했다. 같은 순간 사장님 목록이 시간 초과·잘못된 응답으로 비었다.
const KEY = 'o2o_mvp_group_credentials_v1';
const OWN_TOKEN = 'own-participant-capability-token-000000000001';
const CUSTOMER_TOKEN = 'device-customer-capability-token-00000000002';

async function withUnreadStore(seed, respond, run) {
  const values = new Map([[KEY, JSON.stringify(seed)]]);
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousFallback = process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const answer = await respond(body);
    if (answer.status !== 200) {
      return { ok: false, status: answer.status, json: async () => ({ ok: false, error: answer.error }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: {
      group: { groupId: body.groupId }, lastSeq: answer.lastSeq ?? 0, messages: [], history: [],
      participants: [{ actorId: body.actorId, role: 'member', counted: true }],
    } }) };
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousFallback === undefined) delete process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK;
    else process.env.VITE_ENABLE_GROUP_LOCAL_FALLBACK = previousFallback;
  }
}

const credential = (groupId, actorId, capabilityToken, extra = {}) => ({
  [`${groupId}::${actorId}`]: { groupId, actorId, capabilityToken, role: 'member', active: true, ...extra },
});

test('한 방에 자격이 둘이어도 배지 조회는 한 번만, 기기 자신의 자격으로 보낸다', async () => {
  await withUnreadStore({
    ...credential('room-dup', 'actor-phone', CUSTOMER_TOKEN, { recovered: true }),
    ...credential('room-dup', 'actor-pc', OWN_TOKEN),
  }, () => ({ status: 200 }), async (calls) => {
    await fetchUnreadCounts();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].actorId, 'actor-pc');
    assert.equal(calls[0].capabilityToken, OWN_TOKEN);
  });
});

test('배지 조회는 동시에 3건까지만 보낸다', async () => {
  const rooms = Array.from({ length: 10 }, (_, index) => `room-load-${index}`);
  const seed = Object.assign({}, ...rooms.map((room) => credential(room, 'actor-load', OWN_TOKEN)));
  let inFlight = 0;
  let peak = 0;
  await withUnreadStore(seed, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { status: 200, lastSeq: 2 };
  }, async (calls) => {
    const counts = await fetchUnreadCounts();
    assert.equal(calls.length, rooms.length, '모든 방을 한 번씩 묻는다');
    assert.equal(peak <= 3, true, `동시 요청 ${peak}건`);
    assert.deepEqual(Object.keys(counts).sort(), [...rooms].sort());
  });
});

test('진행 중인 배지 조회가 있으면 겹쳐 보내지 않는다', async () => {
  const rooms = ['room-overlap-a', 'room-overlap-b'];
  const seed = Object.assign({}, ...rooms.map((room) => credential(room, 'actor-overlap', OWN_TOKEN)));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withUnreadStore(seed, async () => {
    await gate;
    return { status: 200, lastSeq: 5 };
  }, async (calls) => {
    const first = fetchUnreadCounts();
    // 방을 열어 화면 효과가 다시 시작된 상황. 열린 방은 0 으로 받는다.
    const second = fetchUnreadCounts({ skipGroupId: 'room-overlap-a' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const [firstCounts, secondCounts] = await Promise.all([first, second]);
    assert.equal(calls.length, rooms.length, '두 번째 호출이 같은 방을 다시 묻지 않는다');
    assert.equal(firstCounts['room-overlap-a'], 5);
    assert.equal(secondCounts['room-overlap-a'], 0);
    assert.equal(secondCounts['room-overlap-b'], 5);
  });
});

test('권한이 거절된 자격은 5분 동안 다시 묻지 않고, 그 뒤에는 다시 묻는다', async () => {
  const realNow = Date.now;
  await withUnreadStore({
    ...credential('room-denied', 'actor-denied', CUSTOMER_TOKEN, { recovered: true }),
    ...credential('room-fine', 'actor-denied', OWN_TOKEN),
  }, (body) => (body.groupId === 'room-denied'
    ? { status: 403, error: 'invalid_capability' }
    : { status: 200 }), async (calls) => {
    const denied = () => calls.filter((call) => call.groupId === 'room-denied').length;
    try {
      await fetchUnreadCounts();
      assert.equal(denied(), 1);
      const counts = await fetchUnreadCounts({ previousCounts: { 'room-denied': 2 } });
      assert.equal(denied(), 1, '바로 다음 묶음에서는 다시 묻지 않는다');
      assert.equal(counts['room-denied'], 2, '쉬는 동안 직전 배지를 유지한다');
      assert.equal(calls.filter((call) => call.groupId === 'room-fine').length, 2, '다른 방은 그대로 묻는다');
      Date.now = () => realNow() + 5 * 60 * 1000 + 1;
      await fetchUnreadCounts();
      assert.equal(denied(), 2, '5분 뒤에는 다시 묻는다(수집기 보완 반영 후 회복)');
    } finally {
      Date.now = realNow;
    }
  });
});

test('거절된 뒤 자격이 바뀌면 기다리지 않고 바로 묻는다', async () => {
  let token = CUSTOMER_TOKEN;
  await withUnreadStore(credential('room-rotated', 'actor-rotated', token, { recovered: true }),
    (body) => (body.capabilityToken === CUSTOMER_TOKEN ? { status: 403, error: 'invalid_capability' } : { status: 200 }),
    async (calls) => {
      await fetchUnreadCounts();
      token = 'next-customer-capability-token-0000000000003';
      globalThis.localStorage.setItem(KEY, JSON.stringify(credential('room-rotated', 'actor-rotated', token, { recovered: true })));
      await fetchUnreadCounts();
      assert.equal(calls.length, 2);
      assert.equal(calls[1].capabilityToken, token);
    });
});

test('관리자 자격은 사용자 화면의 방 자격으로 고르지 않는다', async () => {
  await withUnreadStore({
    ...credential('room-admin-only', 'actor-pc_admin', OWN_TOKEN, { role: 'admin' }),
  }, () => ({ status: 200 }), async () => {
    assert.equal(getGroupRoomCredential('room-admin-only', 'actor-pc'), null,
      '참여하지 않은 방에 채팅 버튼이 뜨지 않는다');
  });
});
