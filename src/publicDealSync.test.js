import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgedPublicDealSnapshot,
  applyObservedPublicDealSync,
  applyPublicDealSyncResult,
  fetchPublicDealListRequest,
  isTransientPublicDealError,
  publicDealPublishRetryCount,
  publicDealSyncFingerprint,
  publicDealPublicationState,
  publishPublicDealRequest,
  shouldPublishPublicDeal,
} from './publicDealSync.js';

test('central observations advance an existing matching acknowledgement but never acknowledge unsaved or missing content', () => {
  const previous = { id: 'customer-observed', source: 'customer', visibility: 'public', publishVersion: 1,
    title: '게시된 상품', currentCount: 1, creatorQuantity: 1, version: 1 };
  const observed = { ...previous, currentCount: 2, version: 2, lastMessageSeq: 4 };
  const ack = { [previous.id]: publicDealSyncFingerprint(previous) };
  const next = applyObservedPublicDealSync({ previous, observed, acknowledgements: ack, centralDeal: previous });
  assert.equal(next.acknowledgements[previous.id], publicDealSyncFingerprint(observed));
  assert.equal(shouldPublishPublicDeal(observed, next.acknowledgements, next.issues), false);
  const unacknowledged = {};
  assert.equal(applyObservedPublicDealSync({ previous, observed, acknowledgements: unacknowledged, centralDeal: previous }).acknowledgements, unacknowledged);
  assert.equal(applyObservedPublicDealSync({ previous, observed, acknowledgements: ack }).acknowledgements, ack, 'legacy marker without server proof is not promoted');
  assert.equal(applyObservedPublicDealSync({ previous, observed, acknowledgements: ack, centralDeal: { ...previous, visibility: 'deleted' } }).acknowledgements, ack);
  const pending = applyObservedPublicDealSync({ previous: { ...previous, title: '미게시 변경' }, observed, acknowledgements: ack, centralDeal: previous });
  assert.equal(pending.acknowledgements, ack,
    'a local edit must not be acknowledged just because another group field was observed');
  assert.deepEqual(pending.issues, {});
});

test('unconfirmed legacy and rejected writes stay held across observations without inventing success or blocking real edits', () => {
  const previous = { id: 'customer-local-observed', visibility: 'public', publishVersion: 0, currentCount: 1 };
  const observed = { ...previous, currentCount: 2, version: 3 };
  const ack = { [previous.id]: publicDealSyncFingerprint(previous) };
  const held = applyObservedPublicDealSync({ previous, observed, acknowledgements: ack });
  assert.equal(held.acknowledgements, ack);
  assert.equal(held.issues[previous.id].state, 'unconfirmed');
  assert.equal(shouldPublishPublicDeal(observed, held.acknowledgements, held.issues), false);
  const nextObservation = { ...observed, currentCount: 3, version: 4 };
  const next = applyObservedPublicDealSync({ ...held, previous: observed, observed: nextObservation });
  assert.equal(shouldPublishPublicDeal(nextObservation, next.acknowledgements, next.issues), false);
  assert.equal(shouldPublishPublicDeal({ ...nextObservation, title: '실제 수정' }, next.acknowledgements, next.issues), true);
  const rejected = applyPublicDealSyncResult({ deal: previous, error: { status: 400, code: 'invalid_deal' } });
  const observedRejection = applyObservedPublicDealSync({ ...rejected, previous, observed });
  assert.deepEqual(observedRejection.acknowledgements, {});
  assert.equal(observedRejection.issues[previous.id].state, 'rejected');
  assert.equal(shouldPublishPublicDeal(observed, observedRejection.acknowledgements, observedRejection.issues), false);
});

test('rejected publication never acknowledges success or loops on the same local record', () => {
  const deal = { id: 'owner-rejected-local', title: '미게시 상품', source: 'merchant', visibility: 'public', publishVersion: 0 };
  const original = JSON.stringify(deal);
  const state = applyPublicDealSyncResult({ deal, error: { status: 400, code: 'invalid_deal' } });
  assert.deepEqual(state.acknowledgements, {});
  assert.equal(state.issues[deal.id].state, 'rejected');
  assert.equal(state.issues[deal.id].code, 'invalid_deal');
  assert.equal(shouldPublishPublicDeal(deal, state.acknowledgements, state.issues), false);
  assert.equal(shouldPublishPublicDeal({ ...deal, title: '명시적으로 수정한 내용' }, state.acknowledgements, state.issues), true);
  assert.equal(JSON.stringify(deal), original);
  assert.equal(publicDealPublicationState(deal, [], state.issues).state, 'rejected');
});

test('transient publication remains pending, then success clears only that issue and acknowledges the saved version', () => {
  const deal = { id: 'owner-pending-local', publishVersion: 0, visibility: 'public' };
  const state = applyPublicDealSyncResult({ deal, error: { status: 502, code: 'upstream_invalid_response' },
    issues: { unrelated: { state: 'rejected' } } });
  assert.deepEqual(state.acknowledgements, {});
  assert.equal(shouldPublishPublicDeal(deal, state.acknowledgements, state.issues), true);
  assert.equal(publicDealPublicationState(deal, [], state.issues).state, 'pending');
  const published = { ...deal, publishVersion: 1, syncedAt: '2026-09-10T14:00:00Z' };
  const saved = applyPublicDealSyncResult({ ...state, deal, published });
  assert.deepEqual(saved.issues, { unrelated: { state: 'rejected' } });
  assert.equal(saved.acknowledgements[deal.id], publicDealSyncFingerprint(published));
  assert.equal(shouldPublishPublicDeal(published, saved.acknowledgements, saved.issues), false);
  assert.equal(publicDealPublicationState(published, [published], saved.issues).state, 'confirmed');
});

test('failed edits preserve prior server acknowledgement without acknowledging the rejected content', () => {
  const saved = { id: 'owner-existing', title: '중앙 기록', visibility: 'public', publishVersion: 1 };
  const edit = { ...saved, title: '거절된 수정' };
  const ack = { [saved.id]: publicDealSyncFingerprint(saved) };
  const state = applyPublicDealSyncResult({ deal: edit, acknowledgements: ack,
    error: { status: 409, code: 'state_conflict' } });
  assert.deepEqual(state.acknowledgements, ack);
  assert.equal(shouldPublishPublicDeal(edit, state.acknowledgements, state.issues), false);
  assert.equal(publicDealPublicationState(edit, [saved], state.issues).label, '수정 저장 확인 필요');
});

test('legacy acknowledgement alone cannot confirm central presence or trigger speculative republishing', () => {
  const legacy = { id: 'owner-legacy-local', title: '과거 로컬 기록', visibility: 'public', publishVersion: 0 };
  const ack = { [legacy.id]: publicDealSyncFingerprint(legacy) };
  assert.equal(shouldPublishPublicDeal(legacy, ack), false);
  assert.equal(publicDealPublicationState(legacy, []).state, 'unconfirmed');
  assert.equal(publicDealPublicationState(legacy, [{ id: legacy.id, visibility: 'deleted' }]).state, 'unconfirmed');
  assert.equal(publicDealPublicationState(legacy, [{ ...legacy, publishVersion: 1 }]).state, 'confirmed');
  assert.equal(publicDealPublicationState(legacy, [{ id: 'owner-unrelated', visibility: 'public' }]).state, 'unconfirmed');
});

test('publish acknowledgement uses the saved snapshot including local creator fields', () => {
  const submitted = { id: 'customer-sync-loop', source: 'customer', title: '그룹', image: 'https://example.test/old.jpg',
    publishVersion: 1, creatorQuantity: 1, creatorProductQuantity: 1, targetPeople: 5 };
  const server = { id: submitted.id, source: 'customer', title: submitted.title,
    image: '/api/public-deals?image=saved', publishVersion: 2, syncedAt: '2026-09-10T00:00:00Z' };
  const acknowledged = acknowledgedPublicDealSnapshot(submitted, server);
  const savedCache = { ...submitted, ...acknowledged };
  const fingerprint = publicDealSyncFingerprint(acknowledged);
  assert.equal(publicDealSyncFingerprint(savedCache), fingerprint,
    'the acknowledged cache must not request another publish');
  assert.equal(savedCache.creatorQuantity, 1);
  assert.equal(savedCache.creatorProductQuantity, 1);
  assert.equal(savedCache.targetPeople, 5);
  assert.equal(savedCache.image, server.image);
  for (const edit of [{ title: '미게시 상품명' }, { image: 'https://example.test/new.jpg' }, { targetPeople: 6 }]) {
    assert.notEqual(publicDealSyncFingerprint({ ...savedCache, ...edit }), fingerprint,
      'an unsent local edit must remain pending');
  }
  assert.equal(acknowledgedPublicDealSnapshot(submitted, { id: 'customer-unrelated' }), null);
});

function response(status, payload, { invalidJson = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (invalidJson) throw new SyntaxError('invalid json');
      return payload;
    },
  };
}

test('공개 상품 저장은 502와 503 뒤에도 동일한 요청 본문으로 재시도한다', async () => {
  const bodies = [];
  const waits = [];
  const responses = [
    response(502, { ok: false, error: 'upstream_invalid_response' }),
    response(503, { ok: false, error: 'collector_busy' }),
    response(202, { ok: true, deal: { id: 'customer-retry-test', publishVersion: 1 } }),
  ];
  const payload = {
    action: 'publish',
    capabilityToken: 'deal-capability-test',
    deal: {
      id: 'customer-retry-test',
      publishMutationId: 'publish-customer-retry-test-initial',
      expectedPublishVersion: 0,
    },
  };

  const published = await publishPublicDealRequest(payload, {
    fetchImpl: async (_url, options) => {
      bodies.push(options.body);
      return responses.shift();
    },
    wait: async (delay) => waits.push(delay),
    random: () => 0,
  });

  assert.equal(published.id, payload.deal.id);
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(waits, [700, 1400]);
});

test('정상 HTTP의 깨진 응답도 502로 간주해 재시도한다', async () => {
  let calls = 0;
  const published = await publishPublicDealRequest({
    action: 'publish',
    capabilityToken: 'deal-capability-test',
    deal: { id: 'owner-malformed-response' },
  }, {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response(200, {}, { invalidJson: true })
        : response(202, { ok: true, deal: { id: 'owner-malformed-response' } });
    },
    wait: async () => {},
    random: () => 0,
  });

  assert.equal(published.id, 'owner-malformed-response');
  assert.equal(calls, 2);
});

test('다른 상품 ID 응답은 성공으로 처리하지 않는다', async () => {
  await assert.rejects(
    publishPublicDealRequest({
      action: 'publish',
      capabilityToken: 'deal-capability-test',
      deal: { id: 'owner-expected' },
    }, {
      fetchImpl: async () => response(202, { ok: true, deal: { id: 'owner-wrong' } }),
      wait: async () => {},
      maxRetries: 0,
    }),
    (error) => error.code === 'upstream_invalid_response' && error.status === 502,
  );
});

test('영구 4xx와 중단 요청은 재시도하지 않는다', async () => {
  let semanticCalls = 0;
  await assert.rejects(
    publishPublicDealRequest({
      action: 'publish',
      capabilityToken: 'deal-capability-test',
      deal: { id: 'owner-conflict' },
    }, {
      fetchImpl: async () => {
        semanticCalls += 1;
        return response(409, { ok: false, error: 'state_conflict' });
      },
      wait: async () => {},
    }),
    (error) => error.code === 'state_conflict' && error.status === 409,
  );
  assert.equal(semanticCalls, 1);

  let oversizedCalls = 0;
  await assert.rejects(
    publishPublicDealRequest({
      action: 'publish',
      capabilityToken: 'deal-capability-test',
      deal: { id: 'owner-oversized' },
    }, {
      fetchImpl: async () => {
        oversizedCalls += 1;
        return response(413, { ok: false, error: 'deal_too_large' });
      },
      wait: async () => {},
    }),
    (error) => error.code === 'deal_too_large' && error.status === 413,
  );
  assert.equal(oversizedCalls, 1);
  assert.equal(isTransientPublicDealError({ name: 'AbortError' }), false);
  assert.equal(publicDealPublishRetryCount({ status: 504, code: 'upstream_timeout' }), 1);
});

test('백그라운드 호출은 내부 재시도를 끌 수 있다', async () => {
  let calls = 0;
  await assert.rejects(
    publishPublicDealRequest({
      action: 'publish',
      capabilityToken: 'deal-capability-test',
      deal: { id: 'customer-background' },
    }, {
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError('network down');
      },
      wait: async () => {},
      maxRetries: 0,
    }),
  );
  assert.equal(calls, 1);
});

test('게시 충돌은 서버가 명시한 유효한 현재 버전만 보존하고 없는 값을 0으로 추정하지 않는다', async () => {
  for (const version of [0, 4, undefined, null, '0', -1, 1.5]) {
    let calls = 0;
    await assert.rejects(publishPublicDealRequest({ action: 'publish', capabilityToken: 'synthetic-version-capability',
      deal: { id: 'owner-version-error', expectedPublishVersion: 3 } }, {
      fetchImpl: async () => {
        calls += 1;
        return response(409, { ok: false, error: 'state_conflict', currentPublishVersion: version });
      },
      wait: async () => {},
    }), (error) => {
      assert.equal(error.code, 'state_conflict');
      assert.equal(error.status, 409);
      if (Number.isSafeInteger(version) && version >= 0) assert.equal(error.currentPublishVersion, version);
      else assert.equal(Object.hasOwn(error, 'currentPublishVersion'), false);
      return true;
    });
    assert.equal(calls, 1, 'version conflicts must not retry or reset the expected version');
  }
  await assert.rejects(publishPublicDealRequest({ action: 'publish', deal: { id: 'owner-unrelated-error' } }, {
    fetchImpl: async () => response(403, { ok: false, error: 'forbidden', currentPublishVersion: 0 }),
    wait: async () => {},
  }), (error) => error.code === 'forbidden' && !Object.hasOwn(error, 'currentPublishVersion'));
});

test('공개 상품 목록은 일시적 504를 한 번 재시도하고 마지막 정상 목록을 반환한다', async () => {
  const bodies = [];
  const waits = [];
  const responses = [
    response(504, { ok: false, error: 'upstream_timeout' }),
    response(200, {
      ok: true,
      deals: [{ id: 'owner-read-retry' }],
      deletedDeals: [{ id: 'owner-deleted-retry', visibility: 'deleted' }],
    }),
  ];

  const deals = await fetchPublicDealListRequest({
    fetchImpl: async (_url, options) => {
      bodies.push(options.body);
      return responses.shift();
    },
    wait: async (delay) => waits.push(delay),
  });

  assert.deepEqual(deals.map((deal) => deal.id), ['owner-read-retry', 'owner-deleted-retry']);
  assert.deepEqual(waits, [350]);
  assert.equal(new Set(bodies).size, 1);
});

test('공개 상품 목록은 영구 오류를 재시도하지 않고 깨진 성공 응답은 실패시킨다', async () => {
  let calls = 0;
  await assert.rejects(fetchPublicDealListRequest({
    fetchImpl: async () => {
      calls += 1;
      return response(403, { ok: false, error: 'origin_not_allowed' });
    },
    wait: async () => {},
  }), (error) => error.code === 'origin_not_allowed' && error.status === 403);
  assert.equal(calls, 1);

  await assert.rejects(fetchPublicDealListRequest({
    fetchImpl: async () => response(200, { ok: true, deals: null }),
    wait: async () => {},
    maxRetries: 0,
  }), (error) => error.code === 'upstream_invalid_response' && error.status === 502);
});
