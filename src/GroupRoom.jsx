import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Lock,
  MessageCircle,
  RotateCcw,
  Send,
  ShieldCheck,
  Unlock,
  User,
  Users,
} from 'lucide-react';
import { getVisitorId, track, useScreenAnalytics } from './analytics';
import {
  fetchGroupSnapshot,
  getGroupCredential,
  getLastReadSeq,
  getPendingGroupTransition,
  joinGroupRoom,
  markGroupRead,
  recoverLegacyCustomerGroupRoom,
  repairCustomerGroupRoom,
  releaseGroupHost,
  sendGroupMessage,
  setGroupChatLocked,
  transitionGroupStatus,
  transitionParticipantPayment,
  updateGroupTarget,
} from './groupApi';
import {
  GROUP_STATES,
  GROUP_STATUS_LABELS,
  MAX_GROUP_PARTICIPANTS,
  PAYMENT_STATUS_LABELS,
  calculateGroupDealAllocation,
  resolveGroupDealProgress,
} from './trade';
import { RELEASE_FEATURES } from './releasePhase';
import { SCOPED_UI_ACTIONS } from './scopeUi';
import { isOlderGroupSnapshot } from './groupSnapshotFreshness';

const ERROR_MESSAGES = {
  admin_pin_required: '관리자 PIN을 입력해 주세요.',
  invalid_admin_pin: '관리자 PIN이 올바르지 않습니다.',
  admin_rate_limited: '관리자 PIN 입력 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  admin_not_configured: '운영 관리자 PIN 설정을 확인할 수 없습니다. 운영 담당자에게 문의해 주세요.',
  admin_backend_required: '로컬 관리자 테스트 PIN이 설정되지 않았습니다. 중앙 API 연결을 확인해 주세요.',
  forbidden: '이 작업을 수행할 권한이 없습니다.',
  group_full: '이 그룹은 최대 인원 또는 목표 인원에 도달했습니다.',
  group_not_recruiting: '모집이 종료되어 새 참여자로 입장할 수 없습니다.',
  quantity_exceeds_total: '남은 상품 수량을 초과해 선택할 수 없습니다.',
  quantity_reservation_closed: '모집이 종료되어 상품 수량을 추가할 수 없습니다.',
  host_already_claimed: '다른 참여자가 먼저 호스트로 확정되었습니다.',
  host_claim_closed: '현재는 호스트 지원을 받을 수 없는 상태입니다.',
  host_release_closed: '모집 중일 때만 호스트 지원을 취소할 수 있습니다.',
  host_role_payment_locked: '입금 처리가 시작된 뒤에는 부담금이 달라질 수 있어 호스트를 변경할 수 없습니다.',
  host_order_required: '먼저 이 공동구매에 참여한 뒤 그룹 채팅에 입장해 주세요.',
  order_not_cancellable: '현재 상태에서는 참여를 취소할 수 없습니다.',
  payment_already_processed: '입금 처리가 시작된 참여는 취소할 수 없습니다.',
  participation_cancellation_closed: '모집이 종료되어 참여를 취소할 수 없습니다.',
  payments_not_confirmed: '모든 참여자의 입금을 확인한 뒤 주문 확인 단계로 이동해 주세요.',
  payment_reversal_requires_group_rewind: '입금완료를 취소하려면 거래 단계를 먼저 모집 중으로 되돌려 주세요.',
  missing_owner_capability_token: '이 상품의 기존 소유권을 확인할 수 없어 그룹 연결을 복구할 수 없습니다.',
  missing_group_capability_token: '이 브라우저에 저장된 기존 그룹 권한을 확인할 수 없어 자동 복구할 수 없습니다.',
  deal_ownership_unclaimable: '이전 상품에 안전하게 확인할 수 있는 소유권 정보가 없습니다. 운영 담당자에게 문의해 주세요.',
  legacy_recovery_not_authorized: '이전 상품에 안전하게 확인할 수 있는 소유권 정보가 없습니다. 운영 담당자에게 문의해 주세요.',
  deal_owner_proof_required: '이미 공개된 상품은 기존 소유권 확인 후에만 그룹을 연결할 수 있습니다.',
  order_participation_required: '상품 주문 참여가 확인된 사용자만 그룹방에 입장할 수 있습니다.',
  order_sync_pending: '주문 저장을 아직 확인하지 못했습니다. 입금 상태는 변경하지 않았습니다. 잠시 후 다시 시도해 주세요.',
  order_payment_link_required: '과거 주문과 그룹 참여 기록의 연결을 확인해야 합니다. 입금 상태는 변경하지 않았습니다. 관리자 점검을 요청해 주세요.',
  order_payment_state_conflict: '주문과 그룹의 입금 상태가 서로 달라 변경을 중단했습니다. 입금 상태는 변경하지 않았습니다. 관리자 점검을 요청해 주세요.',
  upstream_invalid_response: '서버의 처리 결과를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  upstream_timeout: '서버의 처리 결과를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  participant_not_found: '참여자를 찾을 수 없습니다. 최신 참여자 목록을 확인해 주세요.',
  group_not_found: '이 그룹은 더 이상 존재하지 않습니다. 목록으로 돌아가 주세요.',
  chat_locked: '관리자가 채팅을 잠가 메시지를 보낼 수 없습니다.',
  state_conflict: '다른 사용자의 변경이 먼저 반영되었습니다. 최신 상태를 다시 불러왔습니다.',
  target_locked: '상품 구매 완료 이후에는 목표 인원을 바꿀 수 없습니다.',
  invalid_target: '목표 인원은 현재 참여자 이상, 최대 20명으로 설정해 주세요.',
  target_below_current: '목표 인원은 현재 참여자보다 적게 설정할 수 없습니다.',
  target_update_closed: '상품 구매 완료 이후에는 목표 인원을 바꿀 수 없습니다.',
};

function errorMessage(error) {
  if (error?.preflightPhase) {
    const preflightMessages = {
      checkout_in_flight: '추가 참여 주문을 저장하고 있습니다. 저장이 끝난 뒤 입금을 요청해 주세요.',
      checkout_unresolved: '저장이 확인되지 않은 참여 내역이 남아 있습니다. 참여 화면에서 저장 결과를 확인한 뒤 다시 시도해 주세요.',
      order_missing: '이 그룹의 저장된 주문을 찾지 못했습니다. 내 주문에서 참여 내역을 확인해 주세요.',
      order_binding_conflict: '주문과 참여 내역이 일치하지 않아 입금 요청을 중단했습니다. 관리자 점검을 요청해 주세요.',
      history_read_failed: '서버에서 주문 내역을 불러오지 못했습니다. 잠시 후 입금 상태를 다시 확인해 주세요.',
      publish_failed: '참여 주문의 저장을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      invalid_order_response: '서버에서 주문 저장 결과를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    };
    const message = preflightMessages[error.preflightReason];
    if (message) return `${message} 입금 상태는 변경하지 않았습니다.`;
  }
  return ERROR_MESSAGES[error?.message] || ERROR_MESSAGES[error?.code] || '변경을 반영하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

function messageTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function roleLabel(role) {
  if (role === 'admin') return '관리자';
  if (role === 'host') return '호스트';
  if (role === 'creator') return '그룹 생성자';
  return '참여자';
}

function normalizedRole(role) {
  return role === 'member' ? 'participant' : role;
}

function actionEventName(entityType, direction, fromStatus, toStatus) {
  if (entityType === 'group') return direction === 'previous' ? 'group_status_reverted' : 'group_status_changed';
  if (direction === 'previous') {
    return fromStatus === 'requested' ? 'participant_payment_request_cancelled' : 'participant_payment_reverted';
  }
  return toStatus === 'requested' ? 'participant_payment_requested' : 'participant_payment_confirmed';
}

const HISTORY_ENTITY_LABELS = {
  group: '그룹',
  participant: '참여',
  payment: '입금',
  target: '목표 인원',
  quantity: '선택 수량',
  host: '호스트',
  chat_lock: '채팅',
};

function historyEntityLabel(item) {
  if (
    item.entityType === 'participant'
    && (PAYMENT_STATUS_LABELS[item.fromStatus] || PAYMENT_STATUS_LABELS[item.toStatus])
  ) return '입금';
  return HISTORY_ENTITY_LABELS[item.entityType] || '';
}

function historyValue(item, value) {
  if (!value && item.entityType === 'participant') return '미참여';
  if (item.entityType === 'participant' && value === 'joined') return '참여 완료';
  if (item.entityType === 'target') return `${value}명`;
  if (item.entityType === 'quantity') return `${value || 0}개`;
  if (item.entityType === 'host') return value ? '호스트 확정' : '호스트 모집 중';
  if (item.entityType === 'chat_lock') return value === 'true' ? '잠금' : '대화 가능';
  return GROUP_STATUS_LABELS[value] || PAYMENT_STATUS_LABELS[value] || value || '시작';
}

export default function GroupRoom({
  deal,
  profile,
  adminMode = false,
  initialAdminPin = '',
  isCreator = false,
  ownerCapabilityToken = '',
  canRecoverLegacyGroup = false,
  legacyEventId = '',
  onBack,
  onDealUpdate,
  onRead,
  orders = [],
  onOrderUpdate,
  onBeforePaymentRequest,
  onCancelParticipation,
  withBottomNavigation = false,
}) {
  useScreenAnalytics('group_room', { group_id: deal.id, deal_id: deal.id, admin_mode: adminMode });
  const visitorId = getVisitorId();
  const actorId = adminMode ? `${visitorId}_admin` : visitorId;
  const [credential, setCredential] = useState(() => getGroupCredential(deal.id, actorId));
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A successful snapshot refresh only resolves a read/network error. It
  // must not erase a failed user action (including an order-save preflight).
  const [snapshotError, setSnapshotError] = useState('');
  const [notice, setNotice] = useState('');
  const [paymentFeedback, setPaymentFeedback] = useState(null);
  const [message, setMessage] = useState('');
  const [adminPin, setAdminPin] = useState(initialAdminPin);
  const [targetDraft, setTargetDraft] = useState(Number(deal.target || 1));
  const [pendingTransition, setPendingTransition] = useState(
    () => getPendingGroupTransition(deal.id, actorId),
  );
  const messageEndRef = useRef(null);
  const serverTargetRef = useRef(Number(deal.target || 1));
  const observedPaymentStatusRef = useRef('');
  const observedDealUpdateRef = useRef({ pending: '', applied: '' });
  const automaticRepairRef = useRef('');
  const mutationInFlightRef = useRef(false);
  const roomRevisionRef = useRef(0);
  const mutationRevisionRef = useRef(0);
  const snapshotRef = useRef(null);
  const roomIdentity = `${deal.id}:${actorId}:${adminMode}`;
  const roomIdentityRef = useRef(roomIdentity);
  roomIdentityRef.current = roomIdentity;
  const paymentFeedbackRef = useRef(null);
  const pendingPaymentRecoveryRef = useRef(null);

  useEffect(() => {
    if (!paymentFeedback) return;
    (paymentFeedbackRef.current || pendingPaymentRecoveryRef.current)?.scrollIntoView({ block: 'nearest' });
  }, [paymentFeedback?.phase, paymentFeedback?.message]);

  const currentParticipant = useMemo(
    () => snapshot?.participants?.find((item) => item.actorId === actorId) || null,
    [snapshot, actorId],
  );
  const role = normalizedRole(currentParticipant?.role || credential?.role || (adminMode ? 'admin' : 'participant'));
  const canManageTrade = role === 'host' || role === 'admin';
  const canEditTarget = canManageTrade || role === 'creator';
  const hasSavedGroupCapability = Boolean(
    credential?.capabilityToken && String(credential.capabilityToken).length >= 32,
  );
  const canRepairWithOwner = Boolean(
    isCreator && ownerCapabilityToken && hasSavedGroupCapability,
  );
  const canRecoverLegacy = Boolean(
    canRecoverLegacyGroup && legacyEventId && hasSavedGroupCapability,
  );
  const canEstablishMembership = adminMode || canRepairWithOwner || canRecoverLegacy;
  const group = snapshot?.group;
  const groupStatus = group?.status || group?.groupStatus || 'recruiting';
  const groupStateIndex = Math.max(0, GROUP_STATES.indexOf(groupStatus));
  const visibleParticipants = useMemo(
    () => (snapshot?.participants || []).filter((item) => RELEASE_FEATURES.admin || item.role !== 'admin'),
    [snapshot?.participants],
  );
  const paymentFeedbackHasRow = Boolean(paymentFeedback
    && visibleParticipants.some((participant) => participant.actorId === paymentFeedback.participantActorId));
  const missingPendingPaymentParticipant = Boolean(snapshot && pendingTransition?.action === 'transition_payment'
    && !visibleParticipants.some((participant) => participant.actorId === pendingTransition.participantActorId));
  useEffect(() => {
    if (missingPendingPaymentParticipant) pendingPaymentRecoveryRef.current?.scrollIntoView({ block: 'nearest' });
  }, [missingPendingPaymentParticipant]);
  const paymentsReady = useMemo(() => {
    if (typeof group?.paymentReady === 'boolean') return group.paymentReady;
    const payable = (snapshot?.participants || []).filter((item) => (
      item.counted !== false && item.role !== 'admin'
    ));
    return payable.length > 0
      && payable.every((item) => (item.paymentStatus || 'pending') === 'confirmed');
  }, [group?.paymentReady, snapshot?.participants]);
  const totalQuantity = Math.max(1, Number(group?.totalQuantity || deal.totalQuantity || deal.productQuantity || deal.target || 1));
  const orderedQuantity = Math.max(0, Number(group?.orderedQuantity ?? deal.orderedQuantity ?? deal.creatorQuantity ?? deal.current ?? 0));
  const paymentAllocation = useMemo(() => calculateGroupDealAllocation(
    deal,
    totalQuantity,
    Math.min(1, totalQuantity),
  ), [deal, totalQuantity]);
  const activeOrder = useMemo(() => orders.find((order) => (
    order.type === 'purchase'
    && String(order.groupId || '') === String(deal.groupId || deal.id)
    && String(order.visitorId || '') === String(visitorId)
    && order.status !== 'cancelled'
    && order.paymentStatus !== 'cancelled'
  )) || null, [deal.groupId, deal.id, orders, visitorId]);
  const canReleaseHost = !adminMode && groupStatus === 'recruiting'
    && role === 'host' && group?.hostMode === 'recruiting' && group?.hostActorId === actorId
    && (currentParticipant?.paymentStatus || 'pending') === 'pending';
  const canCancelMyParticipation = SCOPED_UI_ACTIONS.participationCancellation
    && !adminMode && groupStatus === 'recruiting' && role === 'participant'
    && activeOrder?.paymentStatus === 'pending';
  useEffect(() => {
    roomRevisionRef.current += 1;
    mutationRevisionRef.current += 1;
    mutationInFlightRef.current = false;
    snapshotRef.current = null;
    setBusy(false);
    setCredential(getGroupCredential(deal.id, actorId));
    setSnapshot(null);
    setError('');
    setSnapshotError('');
    setNotice('');
    setPaymentFeedback(null);
    observedPaymentStatusRef.current = '';
    setPendingTransition(getPendingGroupTransition(deal.id, actorId));
    return () => { roomRevisionRef.current += 1; mutationRevisionRef.current += 1; };
  }, [actorId, adminMode, deal.id]);

  const applySnapshot = useCallback((next) => {
    if (!next || roomIdentityRef.current !== roomIdentity
      || isOlderGroupSnapshot(next, snapshotRef.current)) return;
    snapshotRef.current = next;
    setSnapshotError('');
    const viewerPaymentStatus = String(
      next.participants?.find((item) => item.actorId === actorId)?.paymentStatus || '',
    );
    if (
      viewerPaymentStatus
      && !next.localOnly
      && viewerPaymentStatus !== observedPaymentStatusRef.current
    ) {
      // The first central snapshot can already be newer than the saved order
      // (for example, another host confirmed payment while this room was shut).
      // Read the authorized order instead of projecting participant state into
      // potentially unrelated or unverified historical order records.
      window.dispatchEvent(new Event('o2o-customer-orders-updated'));
    }
    if (!next.localOnly) observedPaymentStatusRef.current = viewerPaymentStatus;
    setSnapshot(next);
    const nextTarget = Number(next.group?.targetCount || deal.target || 1);
    setTargetDraft((current) => (current === serverTargetRef.current ? nextTarget : current));
    serverTargetRef.current = nextTarget;
    const lastSeq = Number(next.lastSeq || 0);
    if (
      RELEASE_FEATURES.chat
      &&
      lastSeq > getLastReadSeq(deal.id)
      && document.visibilityState === 'visible'
      && getGroupCredential(deal.id, actorId)
    ) {
      onRead?.(deal.id, lastSeq);
      markGroupRead(deal.id, lastSeq, actorId).catch(() => {});
    }
  }, [actorId, deal.id, deal.target, onRead, roomIdentity]);

  const loadSnapshot = useCallback(async ({ quiet = false } = {}) => {
    const revision = mutationRevisionRef.current;
    if (!quiet) setLoading(true);
    try {
      const next = await fetchGroupSnapshot(deal.id, { adminPin, actorId });
      if (revision === mutationRevisionRef.current && !mutationInFlightRef.current) applySnapshot(next);
    } catch (loadError) {
      if (revision === mutationRevisionRef.current) setSnapshotError(errorMessage(loadError));
      throw loadError;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [actorId, adminPin, applySnapshot, deal.id]);

  useEffect(() => {
    if (!credential || credential.active === false) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    let timer;
    let controller;
    let inFlight = false;
    let retryDelay = 5000;
    let terminalMissing = false;

    const schedule = (delay = 5000) => {
      window.clearTimeout(timer);
      if (!cancelled) timer = window.setTimeout(poll, delay);
    };

    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      if (inFlight) return;
      inFlight = true;
      controller?.abort();
      controller = new AbortController();
      const revision = mutationRevisionRef.current;
      try {
        const next = await fetchGroupSnapshot(deal.id, { signal: controller.signal, actorId });
        if (!cancelled && revision === mutationRevisionRef.current && !mutationInFlightRef.current) {
          applySnapshot(next);
          retryDelay = 5000;
        }
      } catch (pollError) {
        if (!cancelled && revision === mutationRevisionRef.current && pollError.name !== 'AbortError') {
          if (pollError.message === 'group_not_found') {
            // A confirmed missing group is terminal for this saved room. Its
            // credential is disabled by fetchGroupSnapshot, so stop polling.
            terminalMissing = true;
            setSnapshotError(errorMessage(pollError));
            setCredential(getGroupCredential(deal.id, actorId));
          } else {
            setSnapshotError(errorMessage(pollError));
            if ([502, 503, 504].includes(pollError.status)) {
              retryDelay = Math.min(60000, retryDelay * 2);
            }
          }
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false);
          if (!terminalMissing) schedule(retryDelay);
        }
      }
    };

    poll();
    const refresh = () => {
      if (terminalMissing) return;
      controller?.abort();
      inFlight = false;
      schedule(0);
    };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('o2o-group-fallback-updated', refresh);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearTimeout(timer);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('o2o-group-fallback-updated', refresh);
    };
  }, [actorId, applySnapshot, credential, deal.id]);

  useEffect(() => {
    track('group_room_opened', {
      group_id: deal.id,
      role,
      admin_mode: adminMode,
    });
  }, [deal.id, role, adminMode]);

  useEffect(() => {
    if (RELEASE_FEATURES.chat) {
      messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [snapshot?.lastSeq]);

  useEffect(() => {
    if (!group || !onDealUpdate) return;
    const progress = resolveGroupDealProgress(deal, group);
    const nextAllocation = calculateGroupDealAllocation(
      deal,
      progress.totalQuantity,
      Math.min(1, progress.totalQuantity),
    );
    const previousProgress = resolveGroupDealProgress(deal);
    if (
      progress.target === previousProgress.target
      && progress.targetCount === previousProgress.targetCount
      && progress.current === previousProgress.current
      && progress.currentCount === previousProgress.currentCount
      && progress.totalQuantity === previousProgress.totalQuantity
      && progress.orderedQuantity === previousProgress.orderedQuantity
      && groupStatus === (deal.groupStatus || 'recruiting')
      && String(group.hostActorId || '') === String(deal.hostActorId || '')
      && String(group.hostMode || 'self') === String(deal.hostMode || 'self')
      && (!RELEASE_FEATURES.chat || Boolean(group.chatLocked) === Boolean(deal.chatLocked))
    ) return;
    const observedDeal = {
      ...deal,
      groupId: group.groupId || group.id || deal.id,
      target: progress.target,
      targetPeople: progress.targetCount,
      targetCount: progress.targetCount,
      current: progress.current,
      currentPeople: progress.currentCount,
      currentCount: progress.currentCount,
      participantCount: progress.currentCount,
      totalQuantity: progress.totalQuantity,
      productQuantity: progress.totalQuantity,
      orderedQuantity: progress.orderedQuantity,
      allocatedProductQuantity: progress.orderedQuantity,
      expectedPerPerson: nextAllocation.unitPrice,
      unitPrice: nextAllocation.unitPrice,
      unitRemainder: nextAllocation.remainder,
      splitRemainder: nextAllocation.remainder,
      approximatePrice: nextAllocation.approximate,
      groupStatus,
      ...(RELEASE_FEATURES.chat ? { chatLocked: Boolean(group.chatLocked) } : {}),
      hostActorId: group.hostActorId ?? deal.hostActorId ?? '',
      creatorActorId: group.creatorActorId ?? deal.creatorActorId ?? '',
      hostMode: group.hostMode || deal.hostMode || 'self',
      hostMatched: Boolean(group.hostMatched ?? group.hostActorId ?? deal.hostMatched),
      ...(RELEASE_FEATURES.chat ? { lastMessageSeq: Number(group.lastMessageSeq ?? snapshot?.lastSeq ?? deal.lastMessageSeq ?? 0) } : {}),
      version: Number(group.version || deal.version || 1),
      menu: Array.isArray(deal.menu)
        ? deal.menu.map((item, index) => (index === 0 ? { ...item, price: nextAllocation.unitPrice } : item))
        : deal.menu,
      updatedAt: group.updatedAt || new Date().toISOString(),
    };
    const observationKey = JSON.stringify([
      group.groupId || group.id || deal.id,
      observedDeal.version,
      observedDeal.groupStatus,
      observedDeal.targetCount,
      observedDeal.currentCount,
      observedDeal.orderedQuantity,
      observedDeal.hostActorId,
      observedDeal.chatLocked,
      observedDeal.lastMessageSeq,
    ]);
    if (
      observedDealUpdateRef.current.pending === observationKey
      || observedDealUpdateRef.current.applied === observationKey
    ) return;
    observedDealUpdateRef.current.pending = observationKey;
    // The group snapshot is already the central source of truth. Apply it
    // locally without publishing a second deal mutation from the polling
    // effect, and contain any background callback failure.
    void Promise.resolve()
      .then(() => onDealUpdate(observedDeal, { sync: false, observed: true }))
      .then(() => {
        observedDealUpdateRef.current.applied = observationKey;
      })
      .catch(() => {})
      .finally(() => {
        if (observedDealUpdateRef.current.pending === observationKey) {
          observedDealUpdateRef.current.pending = '';
        }
      });
  }, [deal, group, groupStatus, onDealUpdate, snapshot?.lastSeq]);

  const ensureMembership = async () => {
    if (joining) return;
    setJoining(true);
    setError('');
    try {
      let result;
      if (adminMode) {
        result = await joinGroupRoom({
          deal,
          actorId,
          nickname: profile.name || '테스트 관리자',
          role: 'admin',
          adminPin,
        });
      } else if (canRepairWithOwner || canRecoverLegacy) {
        try {
          const existingSnapshot = await fetchGroupSnapshot(deal.id, {
            actorId,
            allowLocalFallback: false,
          });
          result = { ok: true, snapshot: existingSnapshot };
        } catch (snapshotError) {
          if (snapshotError?.message !== 'group_not_found') throw snapshotError;
          if (canRepairWithOwner) {
            try {
              result = await repairCustomerGroupRoom({
                deal,
                actorId,
                nickname: profile.name,
                ownerCapabilityToken,
              });
            } catch (repairError) {
              const repairCode = String(repairError?.code || repairError?.message || '');
              if (repairCode !== 'deal_ownership_unclaimable' || !canRecoverLegacy) {
                throw repairError;
              }
              result = await recoverLegacyCustomerGroupRoom({
                deal,
                actorId,
                nickname: profile.name,
                legacyEventId,
              });
            }
          } else {
            result = await recoverLegacyCustomerGroupRoom({
              deal,
              actorId,
              nickname: profile.name,
              legacyEventId,
            });
          }
        }
      } else {
        throw new Error('order_participation_required');
      }
      setCredential(getGroupCredential(deal.id, actorId));
      setAdminPin('');
      applySnapshot(result.snapshot);
      track('group_participant_joined', {
        group_id: deal.id,
        role: normalizedRole(
          result.snapshot?.viewer?.role
          || result.snapshot?.participants?.find((item) => item.actorId === actorId)?.role
          || (adminMode ? 'admin' : isCreator ? (deal.hostMode === 'recruiting' ? 'creator' : 'host') : 'participant'),
        ),
        counted: !adminMode,
      });
    } catch (joinError) {
      setError(errorMessage(joinError));
    } finally {
      setJoining(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (
      adminMode
      || (!canRepairWithOwner && !canRecoverLegacy)
      || (
        credential?.active !== false
        && snapshot?.centralGroupMissing !== true
      )
    ) return;
    const repairKey = [
      deal.id,
      actorId,
      credential.capabilityToken,
      canRepairWithOwner ? 'owner' : '',
      canRecoverLegacy ? legacyEventId : '',
    ].join('::');
    if (automaticRepairRef.current === repairKey) return;
    automaticRepairRef.current = repairKey;
    void ensureMembership();
    // `ensureMembership` deliberately remains user-retryable after this one
    // automatic attempt; the ref prevents render-driven duplicate mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, adminMode, canRecoverLegacy, canRepairWithOwner, credential?.active, credential?.capabilityToken, deal.id, legacyEventId, snapshot?.centralGroupMissing]);

  const runMutation = async (operation, eventFactory, { transitionAction = '', paymentParticipantId = '', paymentDirection = '' } = {}) => {
    if (mutationInFlightRef.current) return;
    const roomRevision = roomRevisionRef.current;
    const isCurrentRoom = () => roomRevisionRef.current === roomRevision
      && roomIdentityRef.current === roomIdentity;
    mutationInFlightRef.current = true;
    mutationRevisionRef.current += 1;
    setBusy(true);
    setError('');
    setNotice('');
    setPaymentFeedback(paymentParticipantId ? {
      participantActorId: paymentParticipantId, direction: paymentDirection,
      phase: 'processing', message: '입금 요청을 확인하고 있습니다. 잠시만 기다려 주세요.',
    } : null);
    try {
      const before = snapshot;
      const result = await operation();
      if (!isCurrentRoom()) return false;
      applySnapshot(result.snapshot);
      if (transitionAction) setPendingTransition(null);
      const event = eventFactory?.(before, result.snapshot, result);
      if (event) track(event.name, event.properties);
      return true;
    } catch (mutationError) {
      if (!isCurrentRoom()) return false;
      if (mutationError.snapshot) applySnapshot(mutationError.snapshot);
      let failureMessage;
      if (mutationError.transitionRetryPending && mutationError.mutationIntent) {
        setPendingTransition(mutationError.mutationIntent);
        failureMessage = '처리 결과를 확인하지 못했습니다. 다시 시도하면 같은 요청의 처리 결과를 확인합니다.';
      } else {
        if (transitionAction) setPendingTransition(null);
        failureMessage = errorMessage(mutationError);
      }
      setError(failureMessage);
      if (paymentParticipantId) setPaymentFeedback({
        participantActorId: paymentParticipantId, direction: paymentDirection,
        phase: 'error', message: failureMessage,
      });
      // Refresh independently. A failed auxiliary snapshot can take several
      // read attempts; it must not keep the user's explicit retry disabled.
      window.dispatchEvent(new Event('o2o-group-fallback-updated'));
      return false;
    } finally {
      if (isCurrentRoom()) {
        mutationRevisionRef.current += 1;
        mutationInFlightRef.current = false;
        setBusy(false);
      }
    }
  };

  const changeGroupStatus = (direction) => {
    if (pendingTransition && pendingTransition.action !== 'transition_group') {
      setError('먼저 결과 확인이 필요한 입금 상태 변경을 다시 시도해 주세요.');
      return;
    }
    const retryIntent = pendingTransition?.action === 'transition_group'
      ? pendingTransition
      : null;
    const effectiveDirection = retryIntent?.direction || direction;
    const fromStatus = retryIntent?.fromStatus || groupStatus;
    const nextIndex = groupStateIndex + (effectiveDirection === 'previous' ? -1 : 1);
    const nextStatus = retryIntent?.toStatus || GROUP_STATES[nextIndex];
    if (!nextStatus) return;
    const prompt = retryIntent
      ? `이전에 요청한 ${GROUP_STATUS_LABELS[fromStatus]} → ${GROUP_STATUS_LABELS[nextStatus]} 변경 결과를 다시 확인할까요?`
      : effectiveDirection === 'previous'
        ? `${GROUP_STATUS_LABELS[groupStatus]} 상태를 취소하고 ${GROUP_STATUS_LABELS[nextStatus]} 단계로 되돌릴까요? 변경 이력이 저장됩니다.`
        : `${GROUP_STATUS_LABELS[nextStatus]} 상태로 변경할까요?`;
    if (!window.confirm(prompt)) return;
    runMutation(
      () => transitionGroupStatus(deal.id, effectiveDirection, actorId, retryIntent),
      (_before, _after, result) => {
        const appliedIntent = result?.mutationIntent || retryIntent;
        return {
          name: actionEventName(
            'group',
            appliedIntent?.direction || effectiveDirection,
            appliedIntent?.fromStatus || fromStatus,
            appliedIntent?.toStatus || nextStatus,
          ),
          properties: {
            group_id: deal.id,
            from_status: appliedIntent?.fromStatus || fromStatus,
            to_status: appliedIntent?.toStatus || nextStatus,
            role,
          },
        };
      },
      { transitionAction: 'transition_group' },
    );
  };

  const changePayment = (participant, direction) => {
    if (mutationInFlightRef.current) return;
    if (pendingTransition && pendingTransition.action !== 'transition_payment') {
      setError('먼저 결과 확인이 필요한 거래 단계 변경을 다시 시도해 주세요.');
      return;
    }
    const retryIntent = pendingTransition?.action === 'transition_payment'
      ? pendingTransition
      : null;
    const effectiveParticipantId = retryIntent?.participantActorId || participant.actorId;
    const effectiveParticipant = snapshot?.participants?.find(
      (item) => item.actorId === effectiveParticipantId,
    ) || participant;
    const effectiveDirection = retryIntent?.direction || direction;
    const states = ['pending', 'requested', 'confirmed'];
    const fromStatus = retryIntent?.fromStatus || effectiveParticipant.paymentStatus || 'pending';
    const nextStatus = retryIntent?.toStatus
      || states[states.indexOf(fromStatus) + (effectiveDirection === 'previous' ? -1 : 1)];
    if (!nextStatus) return;
    const prompt = retryIntent
      ? `이전에 요청한 ${effectiveParticipant.nickname}님의 ${PAYMENT_STATUS_LABELS[fromStatus]} → ${PAYMENT_STATUS_LABELS[nextStatus]} 변경 결과를 다시 확인할까요?`
      : effectiveDirection === 'previous'
        ? `${effectiveParticipant.nickname}님의 ${PAYMENT_STATUS_LABELS[fromStatus]} 반영을 취소하고 ${PAYMENT_STATUS_LABELS[nextStatus]} 상태로 되돌릴까요?`
        : `${effectiveParticipant.nickname}님의 상태를 ${PAYMENT_STATUS_LABELS[nextStatus]}(으)로 변경할까요?`;
    if (!window.confirm(prompt)) return;
    const requestRoomRevision = roomRevisionRef.current;
    runMutation(
      async () => {
        // A creator can enter the room while its durable order publication
        // is still in flight. Do not close the pending reservation before
        // that order is centrally saved. Retries must keep replaying the
        // already-frozen payment intent without re-publishing a stale order.
        if (!retryIntent && !adminMode && effectiveParticipantId === actorId
          && fromStatus === 'pending' && nextStatus === 'requested') {
          setPaymentFeedback({ participantActorId: effectiveParticipantId, direction: effectiveDirection,
            phase: 'checking_order', message: '주문 저장을 확인하고 있습니다. 잠시만 기다려 주세요.' });
          await onBeforePaymentRequest?.(deal.id, actorId);
        }
        if (requestRoomRevision !== roomRevisionRef.current || roomIdentityRef.current !== roomIdentity) {
          throw new Error('operation_context_changed');
        }
        setPaymentFeedback({ participantActorId: effectiveParticipantId, direction: effectiveDirection,
          phase: 'saving', message: retryIntent
            ? '이전 입금 요청의 처리 결과를 확인하고 있습니다. 잠시만 기다려 주세요.'
            : '입금 상태를 저장하고 있습니다. 잠시만 기다려 주세요.' });
        const result = await transitionParticipantPayment(
          deal.id,
          effectiveParticipantId,
          effectiveDirection,
          actorId,
          retryIntent,
          { expectedFromStatus: fromStatus, assertCurrentContext: () => {
            if (requestRoomRevision !== roomRevisionRef.current || roomIdentityRef.current !== roomIdentity) {
              throw new Error('operation_context_changed');
            }
          } },
        );
        if (requestRoomRevision !== roomRevisionRef.current || roomIdentityRef.current !== roomIdentity) return result;
        const updatedOrderActorId = String(
          result?.order?.participantActorId || result?.order?.visitorId || '',
        );
        if (result?.order && updatedOrderActorId === actorId) onOrderUpdate?.(result.order);
        // A payment mutation may update more than one active order for the
        // participant. Refresh the customer collection immediately instead of
        // waiting for the 30-second background poll.
        window.dispatchEvent(new Event('o2o-customer-orders-updated'));
        const linkedOrderUpdated = Boolean(result?.order);
        const successMessage = linkedOrderUpdated
          ? nextStatus === 'confirmed'
            ? '입금완료 상태가 채팅과 내 주문에 반영되었습니다.'
            : nextStatus === 'requested'
              ? '입금확인 요청 상태가 채팅과 내 주문에 반영되었습니다.'
              : '입금확인 요청 취소가 채팅과 내 주문에 반영되었습니다.'
          : nextStatus === 'confirmed'
            ? '입금완료 상태가 채팅에 반영되었습니다. 연결된 주문 기록은 없습니다.'
            : nextStatus === 'requested'
              ? '입금확인 요청 상태가 채팅에 반영되었습니다. 연결된 주문 기록은 없습니다.'
              : '입금확인 요청 취소가 채팅에 반영되었습니다. 연결된 주문 기록은 없습니다.';
        setNotice(successMessage);
        setPaymentFeedback({ participantActorId: effectiveParticipantId, direction: effectiveDirection,
          phase: 'success', message: successMessage });
        return result;
      },
      (_before, _after, result) => {
        const appliedIntent = result?.mutationIntent || retryIntent;
        return {
          name: actionEventName(
            'payment',
            appliedIntent?.direction || effectiveDirection,
            appliedIntent?.fromStatus || fromStatus,
            appliedIntent?.toStatus || nextStatus,
          ),
          properties: {
            group_id: deal.id,
            participant_actor_id: appliedIntent?.participantActorId || effectiveParticipantId,
            from_status: appliedIntent?.fromStatus || fromStatus,
            to_status: appliedIntent?.toStatus || nextStatus,
            role,
          },
        };
      },
      { transitionAction: 'transition_payment', paymentParticipantId: effectiveParticipantId, paymentDirection: effectiveDirection },
    );
  };

  const releaseHost = () => {
    if (!window.confirm('호스트 지원을 취소할까요? 참여 주문은 유지되며 다른 참여자가 호스트로 지원할 수 있습니다.')) return;
    runMutation(
      async () => {
        const result = await releaseGroupHost({ deal, actorId });
        if (result?.order) onOrderUpdate?.(result.order);
        return result;
      },
      () => ({ name: 'host_support_cancelled', properties: { group_id: deal.id } }),
    );
  };

  const cancelMyParticipation = async () => {
    if (!canCancelMyParticipation || !activeOrder || !onCancelParticipation || busy) return;
    if (!window.confirm(`“${deal.title}” 참여를 취소할까요? 배정 수량이 다시 모집 수량으로 돌아갑니다.`)) return;
    setBusy(true);
    setError('');
    try {
      await onCancelParticipation(activeOrder);
      setCredential(getGroupCredential(deal.id, actorId));
      track('participation_cancelled_from_group_room', {
        group_id: deal.id,
        order_id: activeOrder.id,
      });
      onBack();
    } catch (cancelError) {
      setError(errorMessage(cancelError));
      await loadSnapshot({ quiet: true }).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const submitMessage = async (event) => {
    event.preventDefault();
    const body = message.trim();
    if (!body || busy) return;
    const sent = await runMutation(
      () => sendGroupMessage(deal.id, body, actorId),
      () => ({
        name: 'chat_message_sent',
        properties: { group_id: deal.id, role, message_length: body.length },
      }),
    );
    if (sent) setMessage('');
  };

  if (!credential || credential.active === false || snapshot?.centralGroupMissing === true) {
    return (
      <section className={`screen group-room-screen${withBottomNavigation ? ' has-bottom-navigation' : ''}`}>
        <header className="top-nav compact">
          <button className="icon-button" onClick={onBack} aria-label="뒤로"><ArrowLeft size={22} /></button>
          <h1>{RELEASE_FEATURES.chat ? '그룹 채팅' : '거래 상태 관리'}</h1>
          {adminMode && RELEASE_FEATURES.admin ? <ShieldCheck size={20} /> : <Users size={20} />}
        </header>
        <div className="room-join-card">
          {adminMode && RELEASE_FEATURES.admin ? <ShieldCheck size={36} /> : RELEASE_FEATURES.chat ? <MessageCircle size={36} /> : <Users size={36} />}
          <h2>{adminMode ? '관리자 권한 확인' : deal.title}</h2>
          <p>{adminMode
            ? '테스트 안내 메시지로 전달받은 관리자 PIN을 입력해 주세요. PIN이 없다면 운영 담당자에게 문의해 주세요. 관리자는 참여 인원에 포함되지 않습니다.'
            : canEstablishMembership
              ? '그룹 생성자 권한을 확인한 뒤 입장합니다.'
              : '상품 주문 참여가 확인된 사용자만 그룹방에 입장할 수 있습니다. 상품 상세에서 먼저 참여해 주세요.'}</p>
          {adminMode && (
            <label>
              관리자 PIN
              <input
                type="password"
                value={adminPin}
                onChange={(event) => setAdminPin(event.target.value)}
                placeholder="전달받은 관리자 PIN 입력"
                autoComplete="off"
              />
            </label>
          )}
          {(error || snapshotError) && <p className="form-error" role="alert">{error || snapshotError}</p>}
          {canEstablishMembership && (
            <button className="primary-button" disabled={joining || (adminMode && !adminPin)} onClick={ensureMembership}>
              {joining ? '권한 확인 중…' : adminMode ? '관리자로 입장' : RELEASE_FEATURES.chat ? '그룹 채팅 입장' : '거래 관리 입장'}
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={`screen group-room-screen${withBottomNavigation ? ' has-bottom-navigation' : ''}`}>
      <header className="top-nav compact room-nav">
        <button className="icon-button" onClick={onBack} aria-label="뒤로"><ArrowLeft size={22} /></button>
        <div>
          <h1>{deal.title}</h1>
          <span><Users size={13} /> {group?.currentCount ?? snapshot?.participants?.filter((item) => item.counted !== false).length ?? 0} / {group?.targetCount || deal.target}명</span>
        </div>
        <span className={`room-role ${role}`}>{roleLabel(role)}</span>
      </header>

      {loading && !snapshot && <div className="room-loading">그룹 상태를 불러오는 중…</div>}
      {!(paymentFeedbackHasRow && paymentFeedback?.phase === 'error') && (error || snapshotError)
        && <p className={`room-error${paymentFeedback && !paymentFeedbackHasRow ? ' payment-feedback' : ''}`}
          ref={paymentFeedback && !paymentFeedbackHasRow ? paymentFeedbackRef : null} role="alert">{error || snapshotError}</p>}
      {!(paymentFeedbackHasRow && paymentFeedback?.phase === 'success') && notice
        && <p className={`room-notice${paymentFeedback && !paymentFeedbackHasRow ? ' payment-feedback' : ''}`}
          ref={paymentFeedback && !paymentFeedbackHasRow ? paymentFeedbackRef : null} role="status">{notice}</p>}
      {pendingTransition && (
        <p className="room-error" role="status">
          이전 상태 변경의 처리 결과를 확인 중입니다. 해당 상태 버튼을 누르면 새 단계로 넘어가지 않고 같은 요청을 다시 확인합니다.
        </p>
      )}

      {snapshot && (
        <>
          <div className="trade-status-card">
            <div className="trade-status-heading">
              <div>
                <span>현재 거래 진행 상태</span>
                <strong>{GROUP_STATUS_LABELS[groupStatus]}</strong>
              </div>
              {RELEASE_FEATURES.chat && (group?.chatLocked ? <span className="locked"><Lock size={14} /> 채팅 잠금</span> : <span><Unlock size={14} /> 대화 가능</span>)}
            </div>
            <div className="trade-status-steps" aria-label={`거래 상태 ${GROUP_STATUS_LABELS[groupStatus]}`}>
              {GROUP_STATES.map((state, index) => (
                <div key={state} className={index <= groupStateIndex ? 'active' : ''}>
                  <i>{index < groupStateIndex ? <Check size={12} /> : index + 1}</i>
                  <span>{GROUP_STATUS_LABELS[state]}</span>
                </div>
              ))}
            </div>
            <div className="room-allocation-summary">
              <div><span>참여 인원</span><strong>{group?.currentCount || 0} / {group?.targetCount || deal.targetPeople || deal.target || 1}명</strong></div>
              <div><span>상품 배정</span><strong>{orderedQuantity} / {totalQuantity}개</strong></div>
              <div><span>제품 1개</span><strong>약 {paymentAllocation.unitPrice.toLocaleString('ko-KR')}원</strong></div>
            </div>
            {canManageTrade && (
              <div className="state-control-row">
                <button
                  className="secondary-button compact-button"
                  disabled={busy
                    || pendingTransition?.action === 'transition_payment'
                    || (!pendingTransition && groupStateIndex === 0)}
                  onClick={() => changeGroupStatus('previous')}
                >
                  <RotateCcw size={15} /> 이전 단계
                </button>
                <button
                  className="primary-button compact-button"
                  disabled={busy
                    || pendingTransition?.action === 'transition_payment'
                    || (!pendingTransition && (
                      groupStateIndex === GROUP_STATES.length - 1
                      || (groupStatus === 'recruiting' && !paymentsReady)
                    ))}
                  onClick={() => changeGroupStatus('next')}
                >
                  다음 단계 <ChevronRight size={15} />
                </button>
              </div>
            )}
            {canManageTrade && groupStatus === 'recruiting' && !paymentsReady && (
              <p className="trade-transition-hint">
                모든 참여자의 입금을 확인하면 ‘주문 확인’ 단계로 이동할 수 있습니다.
                {Number(group?.pendingPaymentCount || 0) > 0
                  ? ` 미확인 ${Number(group.pendingPaymentCount)}건`
                  : ''}
              </p>
            )}
          </div>

          {canEditTarget && (
            <div className="room-management-card">
              <div>
                <strong>목표 인원</strong>
                <span>현재 참여자 미만으로 줄일 수 없으며 구매 완료 후 잠깁니다.</span>
              </div>
              <div className="target-edit-row">
                <button
                  type="button"
                  aria-label="목표 인원 감소"
                  disabled={busy || targetDraft <= Number(group?.currentCount || 1) || ['purchased', 'delivered'].includes(groupStatus)}
                  onClick={() => setTargetDraft((value) => Math.max(Number(group?.currentCount || 1), value - 1))}
                ><ChevronLeft size={16} /></button>
                <strong>{targetDraft}명</strong>
                <button
                  type="button"
                  aria-label="목표 인원 증가"
                  disabled={busy || targetDraft >= MAX_GROUP_PARTICIPANTS || ['purchased', 'delivered'].includes(groupStatus)}
                  onClick={() => setTargetDraft((value) => Math.min(MAX_GROUP_PARTICIPANTS, value + 1))}
                ><ChevronRight size={16} /></button>
                <button
                  className="secondary-button compact-button"
                  disabled={busy || targetDraft === Number(group?.targetCount || deal.target) || ['purchased', 'delivered'].includes(groupStatus)}
                  onClick={() => runMutation(
                    () => updateGroupTarget(deal.id, targetDraft, actorId),
                    () => ({ name: 'group_target_changed', properties: { group_id: deal.id, target_count: targetDraft, role } }),
                  )}
                >저장</button>
              </div>
              {RELEASE_FEATURES.chat && canManageTrade && (
                <button
                  className="secondary-button lock-toggle"
                  disabled={busy}
                  onClick={() => {
                    const locked = !group?.chatLocked;
                    if (!window.confirm(locked ? '참여자의 새 메시지 작성을 잠글까요?' : '채팅 잠금을 해제할까요?')) return;
                    runMutation(
                      () => setGroupChatLocked(deal.id, locked, actorId),
                      () => ({ name: 'chat_lock_changed', properties: { group_id: deal.id, locked, role } }),
                    );
                  }}
                >
                  {group?.chatLocked ? <Unlock size={16} /> : <Lock size={16} />}
                  {group?.chatLocked ? '채팅 잠금 해제' : '채팅 잠금'}
                </button>
              )}
            </div>
          )}

          {(canReleaseHost || canCancelMyParticipation) && (
            <div className="room-management-card participation-management-card">
              <div>
                <strong>내 참여 관리</strong>
                {canCancelMyParticipation ? (
                  <span>수량 변경은 참여를 취소한 뒤 원하는 수량으로 다시 주문해 주세요.</span>
                ) : (
                  <span>호스트 지원을 취소해도 참여 주문은 유지됩니다.</span>
                )}
              </div>
              {canReleaseHost && (
                <button className="secondary-button compact-button" disabled={busy} onClick={releaseHost}>
                  <RotateCcw size={15} /> 호스트 지원 취소
                </button>
              )}
              {canCancelMyParticipation && (
                <button className="danger-button compact-button" disabled={busy} onClick={cancelMyParticipation}>
                  참여 취소 후 수량 다시 선택
                </button>
              )}
            </div>
          )}

          <details className="participant-panel" open>
            <summary>참여자 및 입금 상태 <span>{visibleParticipants.length}계정</span></summary>
            {missingPendingPaymentParticipant && <div className="payment-feedback" ref={pendingPaymentRecoveryRef}>
              <p className="room-loading" role="status">{busy && paymentFeedback
                ? paymentFeedback.message
                : '이전 입금 요청의 참여자가 현재 목록에 없습니다. 요청 결과를 먼저 확인해 주세요.'}</p>
              <button className="secondary-button compact-button" disabled={busy} onClick={() => changePayment({
                actorId: pendingTransition.participantActorId, nickname: '이전 참여자', paymentStatus: pendingTransition.fromStatus,
              }, pendingTransition.direction)}>{busy ? '이전 요청 확인 중…' : '이전 입금 요청 결과 확인'}</button>
            </div>}
            <div className="participant-list">
              {visibleParticipants.map((participant) => {
                const participantRole = normalizedRole(participant.role);
                const paymentStatus = participant.paymentStatus || 'pending';
                const selectedQuantity = Math.max(0, Number(participant.selectedQuantity ?? 1));
                const baseAmount = paymentAllocation.unitPrice * selectedQuantity;
                const expectedAmount = participantRole === 'host'
                  ? baseAmount + paymentAllocation.remainder
                  : baseAmount;
                const isSelf = participant.actorId === actorId;
                const canSelfRequest = isSelf && participantRole !== 'admin' && expectedAmount > 0 && ['pending', 'requested'].includes(paymentStatus);
                const canOperatorChange = canManageTrade
                  && participantRole !== 'admin'
                  && (['requested', 'confirmed'].includes(paymentStatus) || (role === 'admin' && paymentStatus === 'pending'))
                  && (paymentStatus !== 'confirmed' || groupStatus === 'recruiting');
                const paymentRetryBlocked = pendingTransition?.action === 'transition_group'
                  || (pendingTransition?.action === 'transition_payment'
                    && pendingTransition.participantActorId !== participant.actorId);
                const rowFeedback = paymentFeedback?.participantActorId === participant.actorId ? paymentFeedback : null;
                const paymentProcessing = busy && Boolean(rowFeedback);
                return (
                  <div className="participant-row" key={participant.actorId}>
                    <div className={`participant-avatar ${participantRole}`}><User size={15} /></div>
                    <div>
                      <strong>{participant.nickname || '테스트 참여자'} {isSelf && '(나)'}</strong>
                      <span>{roleLabel(participantRole)}{participant.counted === false ? ' · 인원 제외' : ''}</span>
                      {participantRole !== 'admin' && <span>선택 {selectedQuantity}개 · 예상 부담금 {expectedAmount.toLocaleString('ko-KR')}원</span>}
                    </div>
                    <span className={`payment-chip ${paymentStatus}`}>{participantRole === 'admin' ? '관리 계정' : PAYMENT_STATUS_LABELS[paymentStatus]}</span>
                    {canSelfRequest && (
                      <button className={paymentStatus === 'requested' ? 'secondary-button mini-button' : 'primary-button mini-button'} disabled={busy || paymentRetryBlocked} aria-busy={paymentProcessing} onClick={() => changePayment(participant, paymentStatus === 'requested' ? 'previous' : 'next')}>
                        {paymentProcessing ? '처리 중…' : paymentStatus === 'requested' ? '요청 취소' : '입금했어요'}
                      </button>
                    )}
                    {canOperatorChange && (
                      <button className={paymentStatus === 'confirmed' ? 'secondary-button mini-button' : 'primary-button mini-button'} disabled={busy || paymentRetryBlocked} aria-busy={paymentProcessing} onClick={() => changePayment(participant, paymentStatus === 'confirmed' ? 'previous' : 'next')}>
                        {paymentProcessing ? '처리 중…' : paymentStatus === 'confirmed' ? '완료 취소' : paymentStatus === 'pending' ? '확인 요청으로 변경' : '입금 확인'}
                      </button>
                    )}
                    {role === 'admin' && paymentStatus === 'requested' && groupStatus === 'recruiting' && (
                      <button className="secondary-button mini-button" disabled={busy || paymentRetryBlocked} onClick={() => changePayment(participant, 'previous')}>입금대기로 변경</button>
                    )}
                    {rowFeedback && <div className="payment-feedback" ref={paymentFeedbackRef}>
                      <p className={rowFeedback.phase === 'error' ? 'room-error' : rowFeedback.phase === 'success' ? 'room-notice' : 'room-loading'}
                        role={rowFeedback.phase === 'error' ? 'alert' : 'status'}>{rowFeedback.message}</p>
                      {rowFeedback.phase === 'error' && <button className="secondary-button compact-button"
                        disabled={busy || paymentRetryBlocked} onClick={() => changePayment(participant, rowFeedback.direction)}>
                        {busy ? '최신 상태 확인 중…' : '입금 상태 다시 확인'}
                      </button>}
                    </div>}
                  </div>
                );
              })}
            </div>
          </details>

          {RELEASE_FEATURES.chat && <div className="chat-panel">
            <div className="chat-date-line"><span>최근 대화 100건</span></div>
            {snapshot.messages.length === 0 && (
              <div className="chat-empty"><MessageCircle size={28} /><strong>첫 메시지를 남겨보세요</strong><span>입금액과 전달 방법을 채팅으로 안내할 수 있습니다.</span></div>
            )}
            {snapshot.messages.map((item) => {
              const mine = item.actorId === actorId;
              return (
                <div className={mine ? 'chat-message mine' : 'chat-message'} key={item.messageId || item.id || item.seq}>
                  {!mine && <span className="chat-sender">{item.nickname || item.nicknameSnapshot || '참여자'} · {roleLabel(normalizedRole(item.role || item.actorRole))}</span>}
                  <div><p>{item.body}</p><time>{messageTime(item.createdAt)}</time></div>
                </div>
              );
            })}
            <div ref={messageEndRef} />
          </div>}

          {RELEASE_FEATURES.chat && <form className="chat-composer" onSubmit={submitMessage}>
            <input
              maxLength={500}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={group?.chatLocked && !canManageTrade ? '관리자가 대화를 잠갔습니다' : '메시지 입력'}
              disabled={busy || (group?.chatLocked && !canManageTrade)}
              aria-label="메시지 입력"
            />
            <button type="submit" disabled={busy || !message.trim() || (group?.chatLocked && !canManageTrade)} aria-label="메시지 전송"><Send size={18} /></button>
          </form>}

          {snapshot.history.length > 0 && (
            <details className="history-panel">
              <summary><Clock size={15} /> 상태 변경 이력</summary>
              <ol>
                {[...snapshot.history]
                  .filter((item) => historyEntityLabel(item)
                    && (RELEASE_FEATURES.chat || item.entityType !== 'chat_lock')
                    && (RELEASE_FEATURES.admin || item.actorRole !== 'admin'))
                  .slice(-10)
                  .reverse()
                  .map((item, index) => (
                    <li key={item.id || item.historyId || `${item.createdAt}-${index}`}>
                      <span>{historyEntityLabel(item)} · {roleLabel(normalizedRole(item.actorRole))}</span>
                      <strong>{historyValue(item, item.fromStatus)} → {historyValue(item, item.toStatus)}</strong>
                      <time>{messageTime(item.createdAt || item.timestamp)}</time>
                    </li>
                  ))}
              </ol>
            </details>
          )}
        </>
      )}
    </section>
  );
}
