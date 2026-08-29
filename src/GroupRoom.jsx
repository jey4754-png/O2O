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
  createGroupRoom,
  fetchGroupSnapshot,
  getGroupCredential,
  getLastReadSeq,
  joinGroupRoom,
  markGroupRead,
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

const ERROR_MESSAGES = {
  admin_pin_required: '관리자 PIN을 입력해 주세요.',
  invalid_admin_pin: '관리자 PIN이 올바르지 않습니다.',
  admin_backend_required: '로컬 관리자 테스트 PIN이 설정되지 않았습니다. 중앙 API 연결을 확인해 주세요.',
  forbidden: '이 작업을 수행할 권한이 없습니다.',
  group_full: '이 그룹은 최대 인원 또는 목표 인원에 도달했습니다.',
  group_not_recruiting: '모집이 종료되어 새 참여자로 입장할 수 없습니다.',
  quantity_exceeds_total: '남은 상품 수량을 초과해 선택할 수 없습니다.',
  quantity_reservation_closed: '모집이 종료되어 상품 수량을 추가할 수 없습니다.',
  host_already_claimed: '다른 참여자가 먼저 호스트로 확정되었습니다.',
  host_claim_closed: '현재는 호스트 지원을 받을 수 없는 상태입니다.',
  host_order_required: '먼저 이 공동구매에 참여한 뒤 그룹 채팅에 입장해 주세요.',
  group_not_found: '그룹 데이터를 아직 찾을 수 없습니다. 잠시 후 다시 시도해 주세요.',
  chat_locked: '관리자가 채팅을 잠가 메시지를 보낼 수 없습니다.',
  state_conflict: '다른 사용자의 변경이 먼저 반영되었습니다. 최신 상태를 다시 불러왔습니다.',
  target_locked: '상품 구매 완료 이후에는 목표 인원을 바꿀 수 없습니다.',
  invalid_target: '목표 인원은 현재 참여자 이상, 최대 20명으로 설정해 주세요.',
  target_below_current: '목표 인원은 현재 참여자보다 적게 설정할 수 없습니다.',
  target_update_closed: '상품 구매 완료 이후에는 목표 인원을 바꿀 수 없습니다.',
};

function errorMessage(error) {
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
  isCreator = false,
  onBack,
  onDealUpdate,
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
  const [message, setMessage] = useState('');
  const [adminPin, setAdminPin] = useState('');
  const [targetDraft, setTargetDraft] = useState(Number(deal.target || 1));
  const messageEndRef = useRef(null);
  const serverTargetRef = useRef(Number(deal.target || 1));

  const currentParticipant = useMemo(
    () => snapshot?.participants?.find((item) => item.actorId === actorId) || null,
    [snapshot, actorId],
  );
  const role = normalizedRole(currentParticipant?.role || credential?.role || (adminMode ? 'admin' : 'participant'));
  const canManageTrade = role === 'host' || role === 'admin';
  const canEditTarget = canManageTrade || role === 'creator';
  const group = snapshot?.group;
  const groupStatus = group?.status || group?.groupStatus || 'recruiting';
  const groupStateIndex = Math.max(0, GROUP_STATES.indexOf(groupStatus));
  const visibleParticipants = useMemo(
    () => (snapshot?.participants || []).filter((item) => RELEASE_FEATURES.admin || item.role !== 'admin'),
    [snapshot?.participants],
  );
  const totalQuantity = Math.max(1, Number(group?.totalQuantity || deal.totalQuantity || deal.productQuantity || deal.target || 1));
  const orderedQuantity = Math.max(0, Number(group?.orderedQuantity ?? deal.orderedQuantity ?? deal.creatorQuantity ?? deal.current ?? 0));
  const paymentAllocation = useMemo(() => calculateGroupDealAllocation(
    deal,
    totalQuantity,
    Math.min(1, totalQuantity),
  ), [deal, totalQuantity]);
  useEffect(() => {
    setCredential(getGroupCredential(deal.id, actorId));
    setSnapshot(null);
    setError('');
  }, [actorId, deal.id]);

  const applySnapshot = useCallback((next) => {
    if (!next) return;
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
      markGroupRead(deal.id, lastSeq, actorId).catch(() => {});
    }
  }, [actorId, deal.id, deal.target]);

  const loadSnapshot = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const next = await fetchGroupSnapshot(deal.id, { adminPin, actorId });
      applySnapshot(next);
      setError('');
    } catch (loadError) {
      if (loadError.message !== 'group_not_found') setError(errorMessage(loadError));
      throw loadError;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [actorId, adminPin, applySnapshot, deal.id]);

  useEffect(() => {
    if (!credential) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    let timer;
    let controller;
    let inFlight = false;
    let retryDelay = 5000;

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
      try {
        const next = await fetchGroupSnapshot(deal.id, { signal: controller.signal, actorId });
        if (!cancelled) {
          applySnapshot(next);
          retryDelay = 5000;
        }
      } catch (pollError) {
        if (!cancelled && pollError.name !== 'AbortError' && pollError.message !== 'group_not_found') {
          setError(errorMessage(pollError));
          if ([502, 503, 504].includes(pollError.status)) {
            retryDelay = Math.min(30000, retryDelay * 2);
          }
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false);
          schedule(retryDelay);
        }
      }
    };

    poll();
    const refresh = () => {
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
    onDealUpdate({
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
    }, { sync: isCreator, observed: true });
  }, [deal, group, groupStatus, isCreator, onDealUpdate, snapshot?.lastSeq]);

  const ensureMembership = async () => {
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
      } else if (isCreator) {
        result = await createGroupRoom({ deal, actorId, nickname: profile.name });
      } else {
        result = await joinGroupRoom({ deal, actorId, nickname: profile.name, role: 'member', selectedQuantity: 0 });
      }
      setCredential(getGroupCredential(deal.id, actorId));
      setAdminPin('');
      applySnapshot(result.snapshot);
      track('group_participant_joined', {
        group_id: deal.id,
        role: normalizedRole(result.snapshot?.viewer?.role || (adminMode ? 'admin' : isCreator ? (deal.hostMode === 'recruiting' ? 'creator' : 'host') : 'participant')),
        counted: !adminMode,
      });
    } catch (joinError) {
      setError(errorMessage(joinError));
    } finally {
      setJoining(false);
      setLoading(false);
    }
  };

  const runMutation = async (operation, eventFactory) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const before = snapshot;
      const result = await operation();
      applySnapshot(result.snapshot);
      const event = eventFactory?.(before, result.snapshot);
      if (event) track(event.name, event.properties);
      return true;
    } catch (mutationError) {
      if (mutationError.snapshot) applySnapshot(mutationError.snapshot);
      setError(errorMessage(mutationError));
      await loadSnapshot({ quiet: true }).catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changeGroupStatus = (direction) => {
    const nextIndex = groupStateIndex + (direction === 'previous' ? -1 : 1);
    const nextStatus = GROUP_STATES[nextIndex];
    if (!nextStatus) return;
    const prompt = direction === 'previous'
      ? `${GROUP_STATUS_LABELS[groupStatus]} 상태를 취소하고 ${GROUP_STATUS_LABELS[nextStatus]} 단계로 되돌릴까요? 변경 이력이 저장됩니다.`
      : `${GROUP_STATUS_LABELS[nextStatus]} 상태로 변경할까요?`;
    if (!window.confirm(prompt)) return;
    runMutation(
      () => transitionGroupStatus(deal.id, direction, actorId),
      () => ({
        name: actionEventName('group', direction, groupStatus, nextStatus),
        properties: { group_id: deal.id, from_status: groupStatus, to_status: nextStatus, role },
      }),
    );
  };

  const changePayment = (participant, direction) => {
    const states = ['pending', 'requested', 'confirmed'];
    const fromStatus = participant.paymentStatus || 'pending';
    const nextStatus = states[states.indexOf(fromStatus) + (direction === 'previous' ? -1 : 1)];
    if (!nextStatus) return;
    const prompt = direction === 'previous'
      ? `${participant.nickname}님의 ${PAYMENT_STATUS_LABELS[fromStatus]} 반영을 취소하고 ${PAYMENT_STATUS_LABELS[nextStatus]} 상태로 되돌릴까요?`
      : `${participant.nickname}님의 상태를 ${PAYMENT_STATUS_LABELS[nextStatus]}(으)로 변경할까요?`;
    if (!window.confirm(prompt)) return;
    runMutation(
      () => transitionParticipantPayment(deal.id, participant.actorId, direction, actorId),
      () => ({
        name: actionEventName('payment', direction, fromStatus, nextStatus),
        properties: {
          group_id: deal.id,
          participant_actor_id: participant.actorId,
          from_status: fromStatus,
          to_status: nextStatus,
          role,
        },
      }),
    );
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

  if (!credential) {
    return (
      <section className="screen group-room-screen">
        <header className="top-nav compact">
          <button className="icon-button" onClick={onBack} aria-label="뒤로"><ArrowLeft size={22} /></button>
          <h1>{RELEASE_FEATURES.chat ? '그룹 채팅' : '거래 상태 관리'}</h1>
          {adminMode && RELEASE_FEATURES.admin ? <ShieldCheck size={20} /> : <Users size={20} />}
        </header>
        <div className="room-join-card">
          {adminMode && RELEASE_FEATURES.admin ? <ShieldCheck size={36} /> : RELEASE_FEATURES.chat ? <MessageCircle size={36} /> : <Users size={36} />}
          <h2>{adminMode ? '관리자 권한 확인' : deal.title}</h2>
          <p>{adminMode ? '지정된 테스트 관리자 PIN으로 입장하면 참여 인원에는 포함되지 않습니다.' : RELEASE_FEATURES.chat ? '입장하면 닉네임이 참여자 목록에 표시되고 그룹 대화에 참여할 수 있습니다.' : '입장하면 닉네임과 입금 상태가 참여자 목록에 표시됩니다.'}</p>
          {adminMode && (
            <label>
              관리자 PIN
              <input type="password" value={adminPin} onChange={(event) => setAdminPin(event.target.value)} autoComplete="current-password" />
            </label>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" disabled={joining || (adminMode && !adminPin)} onClick={ensureMembership}>
            {joining ? '권한 확인 중…' : adminMode ? '관리자로 입장' : RELEASE_FEATURES.chat ? '그룹 채팅 입장' : '거래 관리 입장'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="screen group-room-screen">
      <header className="top-nav compact room-nav">
        <button className="icon-button" onClick={onBack} aria-label="뒤로"><ArrowLeft size={22} /></button>
        <div>
          <h1>{deal.title}</h1>
          <span><Users size={13} /> {group?.currentCount ?? snapshot?.participants?.filter((item) => item.counted !== false).length ?? 0} / {group?.targetCount || deal.target}명</span>
        </div>
        <span className={`room-role ${role}`}>{roleLabel(role)}</span>
      </header>

      {loading && !snapshot && <div className="room-loading">그룹 상태를 불러오는 중…</div>}
      {error && <p className="room-error" role="alert">{error}</p>}

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
                <button className="secondary-button compact-button" disabled={busy || groupStateIndex === 0} onClick={() => changeGroupStatus('previous')}>
                  <RotateCcw size={15} /> 이전 단계
                </button>
                <button className="primary-button compact-button" disabled={busy || groupStateIndex === GROUP_STATES.length - 1} onClick={() => changeGroupStatus('next')}>
                  다음 단계 <ChevronRight size={15} />
                </button>
              </div>
            )}
          </div>

          {canEditTarget && (
            <div className="room-management-card">
              <div>
                <strong>목표 인원</strong>
                <span>현재 참여자 미만으로 줄일 수 없으며 구매 완료 후 잠깁니다.</span>
              </div>
              <div className="target-edit-row">
                <button disabled={busy || targetDraft <= Number(group?.currentCount || 1) || ['purchased', 'delivered'].includes(groupStatus)} onClick={() => setTargetDraft((value) => Math.max(Number(group?.currentCount || 1), value - 1))}><ChevronLeft size={16} /></button>
                <strong>{targetDraft}명</strong>
                <button disabled={busy || targetDraft >= MAX_GROUP_PARTICIPANTS || ['purchased', 'delivered'].includes(groupStatus)} onClick={() => setTargetDraft((value) => Math.min(MAX_GROUP_PARTICIPANTS, value + 1))}><ChevronRight size={16} /></button>
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

          <details className="participant-panel" open>
            <summary>참여자 및 입금 상태 <span>{visibleParticipants.length}계정</span></summary>
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
                const canOperatorChange = canManageTrade && participantRole !== 'admin' && ['requested', 'confirmed'].includes(paymentStatus);
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
                      <button className={paymentStatus === 'requested' ? 'secondary-button mini-button' : 'primary-button mini-button'} disabled={busy} onClick={() => changePayment(participant, paymentStatus === 'requested' ? 'previous' : 'next')}>
                        {paymentStatus === 'requested' ? '요청 취소' : '입금했어요'}
                      </button>
                    )}
                    {canOperatorChange && (
                      <button className={paymentStatus === 'confirmed' ? 'secondary-button mini-button' : 'primary-button mini-button'} disabled={busy} onClick={() => changePayment(participant, paymentStatus === 'confirmed' ? 'previous' : 'next')}>
                        {paymentStatus === 'confirmed' ? '완료 취소' : '입금 확인'}
                      </button>
                    )}
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
