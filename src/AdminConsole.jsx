import React, { useRef, useState } from 'react';
import { createMutationId, isGroupBackedDeal } from './groupApi';
import { getVisitorId } from './analytics';
import { canonicalOrderVersion } from './orderMerge';

export const ADMIN_IMAGE_FALLBACK = 'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20160%20180%22%3E%3Crect%20width%3D%22160%22%20height%3D%22180%22%20fill%3D%22%23f1f4f6%22%2F%3E%3Cpath%20d%3D%22M35%20128l31-36%2022%2024%2015-17%2022%2029H35z%22%20fill%3D%22%23c8d1d8%22%2F%3E%3Ccircle%20cx%3D%2254%22%20cy%3D%2254%22%20r%3D%2213%22%20fill%3D%22%23c8d1d8%22%2F%3E%3C%2Fsvg%3E';

export function replaceBrokenAdminImage(event) {
  const target = event.currentTarget;
  if (!target || target.getAttribute('src') === ADMIN_IMAGE_FALLBACK) return;
  target.src = ADMIN_IMAGE_FALLBACK;
}

const MESSAGES = {
  invalid_admin_pin: '관리자 PIN이 올바르지 않습니다.',
  admin_rate_limited: '관리자 PIN 입력 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  admin_not_configured: '서버 관리자 PIN 설정을 확인해 주세요.',
  state_conflict: '다른 변경이 먼저 반영되었습니다. 새로고침 후 다시 확인해 주세요.',
  host_cancellation_requires_recruiting: '호스트 취소는 채팅방에서 그룹 상태를 모집 중으로 되돌린 후 가능합니다.',
  cancel_other_host_orders_first: '호스트 잔액이 포함된 주문입니다. 이 호스트의 다른 주문부터 취소해 주세요.',
  order_not_cancellable: '이미 취소되었거나 수령이 끝난 주문은 취소할 수 없습니다.',
  order_not_found: '변경할 주문의 저장 기록을 찾지 못했습니다. 과거 이력만 남아 있을 수 있으니 상품·주문 ID로 기록 연결을 확인해 주세요.',
  group_not_found: '이 주문에 연결된 그룹 기록을 찾지 못했습니다. 상품·주문 ID로 그룹 연결을 확인해 주세요.',
  participant_not_found: '이 주문에 연결된 참여자 기록을 찾지 못했습니다. 상품·주문 ID로 참여 기록을 확인해 주세요.',
  order_payment_link_required: '과거 주문과 그룹 참여 기록의 연결을 확인해야 합니다. 상품·주문 ID로 연결 상태를 점검해 주세요.',
  deal_deleted: '이미 삭제된 상품입니다.',
  invalid_new_pin: '새 PIN은 숫자 8~12자리로 입력해 주세요.',
  pin_mismatch: '새 PIN과 확인 입력이 일치하지 않습니다.',
  pin_unchanged: '현재 PIN과 다른 새 PIN을 입력해 주세요.',
  admin_credential_store_unavailable: '관리자 인증 저장소 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.',
  admin_response_invalid: '관리자 목록 응답이 올바르지 않습니다. 잠시 후 다시 시도해 주세요.',
  collector_busy: '서버에 요청이 몰려 조회를 완료하지 못했습니다. 잠시 후 새로고침해 주세요.',
  upstream_timeout: '서버 응답이 늦어 요청 결과를 확인하지 못했습니다. 잠시 후 같은 작업을 다시 시도해 주세요.',
  upstream_invalid_response: '서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  TimeoutError: '서버 응답이 늦어 요청 결과를 확인하지 못했습니다. 잠시 후 같은 작업을 다시 시도해 주세요.',
};
export async function requestAdminOperation(pin, fields) {
  const readOnly = fields.action === 'list' || fields.action === 'orders';
  const body = JSON.stringify({ ...fields, actorId: `${getVisitorId()}_admin`, adminPin: pin });
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch('/api/admin-ops', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      signal: AbortSignal.timeout(55000),
    });
    let result;
    try { result = await response.json(); } catch {
      throw new Error('upstream_invalid_response');
    }
    if (!response.ok || result?.ok !== true) {
      const code = result?.error || 'admin_operation_failed';
      // These errors are returned by the operation after PIN verification.
      // Never replay PIN failures, rate-limit responses, credential-store
      // failures, transport failures with an unknown outcome, or mutations.
      if (readOnly && attempt === 0 && response.status >= 500
        && ['collector_busy', 'upstream_timeout', 'upstream_invalid_response'].includes(code)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      throw new Error(code);
    }
    if ((fields.action === 'list' && !Array.isArray(result.deals))
      || (fields.action === 'orders' && !Array.isArray(result.orders))) {
      throw new Error('admin_response_invalid');
    }
    return result;
  }
}
export async function requestAdminPinChange(fields) {
  const response = await fetch('/api/admin-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'change', ...fields, actorId: `${getVisitorId()}_admin` }),
    signal: AbortSignal.timeout(55000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'admin_pin_change_failed');
  return result;
}

export default function AdminConsole({ pin, onPinChange, onOpenRoom, onBack, ImageUploader }) {
  const [verified, setVerified] = useState(false);
  const [deals, setDeals] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [orders, setOrders] = useState([]);
  const [ordersStatus, setOrdersStatus] = useState('idle');
  const [image, setImage] = useState('');
  const [imageBusy, setImageBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const pending = useRef(null);
  const pendingPin = useRef(null);
  const inFlight = useRef(false);
  const run = async (callback) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(''); setMessage('');
    try { await callback(); } catch (failure) {
      if (failure.message === 'state_conflict') pending.current = null;
      setError(MESSAGES[failure.message] || MESSAGES[failure.name] || '요청을 완료하지 못했습니다. 네트워크 확인 후 같은 작업을 다시 시도해 주세요.');
    } finally { inFlight.current = false; setBusy(false); }
  };
  const refresh = () => run(async () => {
    const result = await requestAdminOperation(pin, { action: 'list' });
    setDeals(result.deals); setVerified(true);
    if (selected) {
      const refreshedSelection = result.deals.find((deal) => deal.id === selected.id) || null;
      setSelected(refreshedSelection);
      if (refreshedSelection) {
        setOrdersStatus('loading');
        try {
          const next = await requestAdminOperation(pin, { action: 'orders', dealId: selected.id });
          setOrders(next.orders); setOrdersStatus('ready');
        } catch (failure) { setOrdersStatus('error'); throw failure; }
      } else {
        setOrders([]); setOrdersStatus('idle'); setImage(''); setReason('');
      }
    }
  });
  const select = (deal) => run(async () => {
    if (selected?.id !== deal.id) { setOrders([]); setImage(''); setReason(''); }
    setSelected(deal); setOrdersStatus('loading');
    try {
      const result = await requestAdminOperation(pin, { action: 'orders', dealId: deal.id });
      setOrders(result.orders); setOrdersStatus('ready');
    } catch (failure) { setOrdersStatus('error'); throw failure; }
  });
  const mutate = (action, order) => run(async () => {
    if (!reason.trim()) { setError('변경 사유를 입력해 주세요.'); return; }
    const fields = { action, dealId: selected.id, reason: reason.trim(),
      expectedVersion: order ? canonicalOrderVersion(order) : Number(selected.publishVersion || 0),
      ...(order ? { orderId: order.id } : {}), ...(action === 'image' ? { image } : {}),
    };
    const contract = JSON.stringify(fields);
    if (!pending.current || pending.current.contract !== contract) {
      const text = action === 'delete'
        ? '이 상품을 공개 목록에서 삭제할까요? 기존 주문·입금·채팅 기록은 보존되며 주문은 자동 취소되지 않습니다.'
        : action === 'cancel_order'
          ? '이 주문의 참여를 취소하고 예약 수량을 반환할까요? 호스트의 마지막 주문이면 호스트 역할도 해제됩니다. 실제 환불은 처리되지 않으며, 입금완료 건은 별도 환불 확인이 필요합니다.'
          : '선택한 이미지로 상품 사진을 변경할까요?';
      if (!window.confirm(text)) return;
      pending.current = { contract, fields: { ...fields, clientMutationId: createMutationId(`admin_${action}`) } };
    }
    const result = await requestAdminOperation(pin, pending.current.fields);
    pending.current = null;
    if (result.deal) {
      setSelected(result.deal); setDeals((current) => current.map((item) => item.id === result.deal.id ? result.deal : item));
      setImage('');
      window.dispatchEvent(new CustomEvent('o2o-public-deals-updated', { detail: { deal: result.deal } }));
    }
    if (result.order) setOrders((current) => current.map((item) => item.id === result.order.id ? result.order : item));
    setMessage(action === 'delete' ? '상품을 목록에서 삭제했습니다. 기존 기록은 보존됩니다.'
      : action === 'cancel_order' ? '참여 취소와 수량 반환을 저장했습니다. 입금 내역은 보존되며 환불은 별도 확인해 주세요.' : '상품 이미지를 저장했습니다.');
    window.dispatchEvent(new CustomEvent('o2o-customer-orders-updated'));
  });
  const changePin = () => run(async () => {
    if (!currentPin) { setError('현재 PIN을 입력해 주세요.'); return; }
    if (!/^\d{8,12}$/.test(newPin)) { setError(MESSAGES.invalid_new_pin); return; }
    if (newPin !== confirmPin) { setError(MESSAGES.pin_mismatch); return; }
    if (newPin === currentPin) { setError(MESSAGES.pin_unchanged); return; }
    const fields = { adminPin: currentPin, newPin, confirmPin };
    const contract = JSON.stringify(fields);
    if (!pendingPin.current || pendingPin.current.contract !== contract) {
      pendingPin.current = { contract, fields: { ...fields, clientMutationId: createMutationId('admin_pin') } };
    }
    await requestAdminPinChange(pendingPin.current.fields);
    onPinChange(newPin);
    pendingPin.current = null;
    pending.current = null;
    setCurrentPin(''); setNewPin(''); setConfirmPin('');
    setMessage('관리자 PIN을 변경했습니다. 다음 로그인부터 새 PIN을 사용해 주세요.');
  });
  const resetAuthentication = (nextPin) => {
    onPinChange(nextPin);
    setVerified(false); setDeals([]); setSelected(null); setOrders([]); setOrdersStatus('idle');
    setCurrentPin(''); setNewPin(''); setConfirmPin(''); setError(''); setMessage('');
    pendingPin.current = null; pending.current = null;
  };
  return <section className="screen admin-console">
    <button className="secondary-button" disabled={busy} onClick={onBack}>일반 상품 화면 미리보기</button>
    <header className="top-nav compact"><h1>관리자 운영 관리</h1></header>
    <p>전체 상품·주문을 관리합니다. 변경 사유와 이력이 저장되며 실제 환불은 처리하지 않습니다.</p>
    <form onSubmit={(event) => { event.preventDefault(); refresh(); }} className="admin-login">
      <label>관리자 PIN<input aria-label="관리자 PIN" type="password" autoComplete="off" value={pin} disabled={busy}
        onChange={(event) => resetAuthentication(event.target.value)} /></label>
      <button className="primary-button" disabled={busy || !pin}>{busy ? '처리 중…' : verified ? '새로고침' : '관리자 확인'}</button>
    </form>
    {error && <p role="alert" className="form-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {verified && <>
      <h2>상품·주문 관리</h2>
      <p>관리할 상품을 선택하면 상품 삭제·이미지 변경·주문별 참여 취소와 채팅방 입금 관리를 사용할 수 있습니다.</p>
      <label>상품 검색<input aria-label="상품 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="상품명 또는 상품 ID" /></label>
      {selected && <div className="admin-detail">
        <h2>{selected.title}</h2><small>{selected.id}</small>
        <p>{selected.visibility === 'deleted' ? '목록에서 삭제됨 · 기록 보존' : '공개 상품'}</p>
        {isGroupBackedDeal(selected) && <button className="secondary-button" disabled={busy} onClick={() => onOpenRoom(selected)}>채팅방 · 입금 상태 관리</button>}
        <label>변경 사유 (필수)<input aria-label="변경 사유" aria-describedby="admin-reason-help" value={reason} maxLength={200} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>
        <p id="admin-reason-help">이미지 변경·상품 삭제·참여 취소 시 변경 사유를 먼저 입력해 주세요. 사유가 없으면 버튼을 누를 때 입력 안내가 표시됩니다.</p>
        {selected.visibility !== 'deleted' && <>
          <ImageUploader value={image || selected.image} alt="관리 상품 사진" buttonLabel="관리자 이미지 변경" onChange={setImage} onBusyChange={setImageBusy} className="admin-image" />
          <button className="secondary-button" disabled={busy || imageBusy || !image} onClick={() => mutate('image')}>이미지 저장</button>
          <button className="secondary-button danger-button" disabled={busy} onClick={() => mutate('delete')}>상품 삭제 (기록 보존)</button>
        </>}
        <h3>주문 · 참여 내역{ordersStatus === 'ready' || orders.length ? ` ${orders.length}건` : ''}</h3>
        {ordersStatus === 'loading' && <p role="status">주문 내역을 불러오는 중입니다.</p>}
        {ordersStatus === 'error' && <p>주문 내역을 확인하지 못했습니다.{orders.length ? ' 마지막으로 확인한 내역을 유지합니다.' : ''} 새로고침해 주세요.</p>}
        {ordersStatus === 'ready' && !orders.length && <p>저장된 주문이 없습니다.</p>}
        {orders.map((order) => <article className="admin-order" key={order.id}>
          <strong>{order.customerName || order.nickname || order.visitorId}</strong><small>{order.id}</small>
          <p>수량 {order.selectedCount || order.quantity || 1} · {order.status === 'cancelled' ? '참여 취소' : { pending: '입금대기', requested: '입금확인 요청', confirmed: '입금완료' }[order.paymentStatus] || order.status}</p>
          {order.refundReviewRequired && <p className="form-error">입금완료 후 취소 · 실제 환불 확인 필요</p>}
          {order.status !== 'cancelled' && <button className="secondary-button" disabled={busy || ordersStatus !== 'ready'} onClick={() => mutate('cancel_order', order)}>관리자 참여 취소</button>}
        </article>)}
      </div>}
      <div className="admin-products" aria-label="관리할 상품 목록">{deals.filter((deal) => `${deal.title} ${deal.id}`.toLowerCase().includes(query.toLowerCase())).map((deal) =>
        <button className="admin-product" disabled={busy} key={deal.id} onClick={() => select(deal)}>
          <img src={deal.image || ADMIN_IMAGE_FALLBACK} alt={`${deal.title || '상품'} 이미지`} loading="lazy" decoding="async" onError={replaceBrokenAdminImage} /><span><strong>{deal.title}</strong><small>{deal.id}</small><small>{deal.visibility === 'deleted' ? '삭제됨 · 기록 보존' : deal.source === 'customer' ? '사용자 그룹' : '사장님 상품'}</small><small>상품 · 주문 관리 열기</small></span>
        </button>)}
      </div>
      {!deals.length && <p>조회된 상품이 없습니다.</p>}
      <details>
        <summary>관리자 PIN 변경</summary>
        <form aria-label="관리자 PIN 변경" className="admin-detail" onSubmit={(event) => { event.preventDefault(); changePin(); }}>
          <p id="admin-pin-help">현재 PIN을 확인한 뒤 숫자 8~12자리의 새 PIN으로 변경합니다. 변경 후 다른 관리자도 새 PIN으로 접속해야 합니다.</p>
          <label>현재 PIN<input aria-label="현재 PIN" type="password" autoComplete="current-password" value={currentPin} disabled={busy}
            onChange={(event) => setCurrentPin(event.target.value)} /></label>
          <label>새 PIN<input aria-label="새 PIN" type="password" inputMode="numeric" autoComplete="new-password" aria-describedby="admin-pin-help" maxLength={12} value={newPin} disabled={busy}
            onChange={(event) => setNewPin(event.target.value)} /></label>
          <label>새 PIN 확인<input aria-label="새 PIN 확인" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={confirmPin} disabled={busy}
            onChange={(event) => setConfirmPin(event.target.value)} /></label>
          <button className="primary-button" disabled={busy || !currentPin || !newPin || !confirmPin}>PIN 변경</button>
        </form>
      </details>
    </>}
  </section>;
}
