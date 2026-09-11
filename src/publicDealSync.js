import { runCentralMutation } from './centralMutationQueue.js';

export function publicDealSyncFingerprint(deal) {
  const { syncedAt, ...content } = deal || {};
  return JSON.stringify({ imageSyncVersion: 2, ...content });
}

export function acknowledgedPublicDealSnapshot(submitted, published) {
  if (!published || published.id !== submitted?.id) return null;
  // The server deliberately omits local-only creator fields. Keep those fields
  // in both the saved cache and its acknowledgement so a successful publish
  // does not immediately look like another pending edit.
  return { ...submitted, ...published };
}

export const publicDealSyncIssuesStorageKey = 'o2o_mvp_public_deal_sync_issues_v1';

export function shouldPublishPublicDeal(deal, acknowledgements = {}, issues = {}) {
  const fingerprint = publicDealSyncFingerprint(deal);
  // Legacy acknowledgement entries cannot distinguish a successful publish
  // from a rejected one. Keep them until an explicit edit/save or server proof;
  // clearing them on a missing list row could republish another owner's history.
  if (acknowledgements[deal.id] === fingerprint) return false;
  const issue = issues[deal.id];
  return !(['rejected', 'unconfirmed'].includes(issue?.state) && issue.fingerprint === fingerprint);
}

export function applyPublicDealSyncResult({ deal, published, error, acknowledgements = {}, issues = {} }) {
  const nextAcknowledgements = { ...acknowledgements };
  const nextIssues = { ...issues };
  const acknowledged = acknowledgedPublicDealSnapshot(deal, published);
  if (acknowledged) {
    nextAcknowledgements[deal.id] = publicDealSyncFingerprint(acknowledged);
    delete nextIssues[deal.id];
  } else if (error) {
    const status = Number(error.status || 0);
    nextIssues[deal.id] = {
      state: status >= 400 && status < 500 && !isTransientPublicDealError(error) ? 'rejected' : 'pending',
      fingerprint: publicDealSyncFingerprint(deal),
      code: String(error.code || error.message || 'public_deal_sync_failed'),
      status,
    };
  }
  return { acknowledgements: nextAcknowledgements, issues: nextIssues };
}

export function applyObservedPublicDealSync({ previous, observed, acknowledgements = {}, issues = {}, centralDeal }) {
  // Observation is not a publish. Only move an already acknowledged local
  // snapshot forward when this session also has proof that the deal is central.
  // Missing rows and genuinely unsaved edits must retain their original state.
  if (!previous || previous.id !== observed?.id) return { acknowledgements, issues };
  const before = publicDealSyncFingerprint(previous);
  const after = publicDealSyncFingerprint(observed);
  const issue = issues[previous.id];
  if (['rejected', 'unconfirmed'].includes(issue?.state) && issue.fingerprint === before) {
    // A read can change progress fields, but it cannot turn a rejected/held
    // write into an explicit edit or an acknowledged publication.
    return { acknowledgements, issues: { ...issues, [previous.id]: { ...issue, fingerprint: after } } };
  }
  if (acknowledgements[previous.id] !== before) return { acknowledgements, issues };
  if (centralDeal?.id === previous.id && centralDeal.visibility !== 'deleted') {
    return { acknowledgements: { ...acknowledgements, [previous.id]: after }, issues };
  }
  // Preserve a legacy suppression after a local observation without calling it
  // a successful publish or guessing that a missing central row should exist.
  return { acknowledgements, issues: { ...issues, [previous.id]: {
    state: 'unconfirmed', fingerprint: after, code: 'central_publication_unconfirmed', status: 0,
  } } };
}

export function publicDealPublicationState(deal, centralDeals = [], issues = {}) {
  const confirmed = centralDeals.some((central) => central.id === deal.id && central.visibility !== 'deleted');
  const issue = issues[deal.id];
  const currentIssue = issue?.fingerprint === publicDealSyncFingerprint(deal) ? issue : null;
  if (currentIssue?.state === 'rejected') return {
    state: 'rejected', label: confirmed ? '수정 저장 확인 필요' : '중앙 게시 미확인',
    description: currentIssue.code === 'state_conflict'
      ? '상품 버전이 서버와 다릅니다. 최신 내용을 확인한 뒤 수정해 주세요.'
      : ['forbidden', 'missing_owner_capability', 'invalid_owner_capability', 'deal_ownership_unclaimable'].includes(currentIssue.code)
        ? '이 관리키로 저장을 확인하지 못했습니다. 등록에 사용한 사장님 정보와 기기를 확인해 주세요.'
        : '서버에서 상품 저장을 거절했습니다. 수정에서 내용을 확인한 뒤 같은 상품으로 다시 저장해 주세요.',
  };
  if (currentIssue?.state === 'pending') return {
    state: 'pending', label: confirmed ? '수정 저장 재시도 대기' : '게시 재시도 대기',
    description: '서버의 저장 결과를 확인하지 못했습니다. 기록을 보존하고 연결되면 다시 확인합니다.',
  };
  return confirmed
    ? { state: 'confirmed', label: '중앙 게시 확인', description: '' }
    : { state: 'unconfirmed', label: '중앙 게시 미확인',
        description: '이 브라우저의 기록은 보존되어 있습니다. 수정에서 내용을 확인한 뒤 같은 상품으로 다시 저장할 수 있습니다.' };
}

const TRANSIENT_PUBLIC_DEAL_CODES = new Set([
  'collector_busy',
  'collector_failed',
  'collector_unreachable',
  'data_api_failed',
  'public_deal_sync_failed',
  'upstream_invalid_response',
  'upstream_timeout',
]);

const TRANSIENT_PUBLIC_DEAL_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function waitForRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function publicDealResponseError(response, result, fallback = 'public_deal_read_failed') {
  const malformedSuccess = response?.ok && !result?.error;
  const error = new Error(
    malformedSuccess ? 'upstream_invalid_response' : (result?.error || fallback),
  );
  error.code = malformedSuccess ? 'upstream_invalid_response' : (result?.error || fallback);
  error.status = malformedSuccess ? 502 : Number(response?.status || 0);
  return error;
}

export function isTransientPublicDealError(error = {}) {
  if (error?.name === 'AbortError') return false;
  const status = Number(error?.status || 0);
  const code = String(error?.code || error?.message || '');
  if (TRANSIENT_PUBLIC_DEAL_STATUSES.has(status)) return true;
  if (status >= 400 && status < 500) return false;
  return TRANSIENT_PUBLIC_DEAL_CODES.has(code) || (!status && error?.name === 'TypeError');
}

export function publicDealPublishRetryCount(error = {}) {
  if (!isTransientPublicDealError(error)) return 0;
  const status = Number(error?.status || 0);
  // A timeout can represent a committed write whose response was lost. One
  // idempotent replay is enough and keeps the foreground wait bounded.
  if (status === 504 || String(error?.code || error?.message || '') === 'upstream_timeout') return 1;
  if ([408, 425, 429, 500].includes(status)) return 2;
  return 3;
}

/**
 * Public-list reads are side-effect free, so a single bounded replay is safe.
 * This absorbs an occasional Apps Script cold-start timeout without changing
 * mutation retry semantics or clearing the last good list in the caller.
 */
export async function fetchPublicDealListRequest(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const wait = options.wait || waitForRetry;
  const maxRetries = Number.isInteger(options.maxRetries)
    ? Math.max(0, Math.min(2, options.maxRetries))
    : 1;
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs || 20000)));
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch_unavailable');

  const body = JSON.stringify({ action: 'list' });
  let failedAttempts = 0;
  while (true) {
    try {
      const response = await fetchImpl('/api/public-deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
      });
      let result = {};
      try {
        result = await response.json();
      } catch {
        result = {};
      }
      if (!response.ok || result?.ok !== true || !Array.isArray(result.deals)) {
        throw publicDealResponseError(response, result);
      }
      return result.deals.concat(
        Array.isArray(result.deletedDeals) ? result.deletedDeals : [],
      );
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const retryable = isTransientPublicDealError(error)
        || error?.name === 'TimeoutError';
      if (!retryable || failedAttempts >= maxRetries) throw error;
      const delay = 350 * (2 ** failedAttempts);
      failedAttempts += 1;
      await wait(delay);
    }
  }
}

async function performPublicDealPublish(payload, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const wait = options.wait || waitForRetry;
  const random = options.random || Math.random;
  const maxRetries = Number.isInteger(options.maxRetries)
    ? Math.max(0, options.maxRetries)
    : 3;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch_unavailable');

  // Freeze the complete request once. Every replay must carry the exact same
  // deal id, capability and mutation contract so the server can deduplicate it.
  const body = JSON.stringify(payload);
  const expectedDealId = String(payload?.deal?.id || '');
  let failedAttempts = 0;

  while (true) {
    try {
      const response = await fetchImpl('/api/public-deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      let result = {};
      try {
        result = await response.json();
      } catch {
        result = {};
      }
      const returnedDealId = String(result?.deal?.id || '');
      if (!response.ok || result?.ok !== true || !returnedDealId || returnedDealId !== expectedDealId) {
        const malformedSuccess = response.ok && !result?.error;
        const error = new Error(
          malformedSuccess ? 'upstream_invalid_response' : (result?.error || 'public_deal_sync_failed'),
        );
        error.code = malformedSuccess
          ? 'upstream_invalid_response'
          : (result?.error || 'public_deal_sync_failed');
        error.status = malformedSuccess ? 502 : response.status;
        if (error.code === 'state_conflict'
          && Object.hasOwn(result, 'currentPublishVersion')
          && Number.isSafeInteger(result.currentPublishVersion)
          && result.currentPublishVersion >= 0) {
          error.currentPublishVersion = result.currentPublishVersion;
        }
        throw error;
      }
      return result.deal;
    } catch (error) {
      const retryCount = Math.min(maxRetries, publicDealPublishRetryCount(error));
      if (failedAttempts >= retryCount) throw error;
      const delay = Math.min(3000, 700 * (2 ** failedAttempts))
        + Math.floor(Math.max(0, Number(random() || 0)) * 180);
      failedAttempts += 1;
      await wait(delay);
    }
  }
}

export function publishPublicDealRequest(payload, options = {}) {
  return runCentralMutation(
    () => performPublicDealPublish(payload, options),
    { priority: options.priority },
  );
}
