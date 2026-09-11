// Explicit operator-only verification; never part of automated test discovery.
// Connection settings are generated locally under ignored .vercel and removed after use.
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('../.vercel/admin-collector-verification.json', import.meta.url), 'utf8'));
const call = async (payload) => {
  const response = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'admin_operation', token: config.token, payload: { adminAssertion: true, actorId: 'codex_operator_admin', ...payload } }),
    signal: AbortSignal.timeout(55000) });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || 'admin_check_failed');
  return result;
};
const command = process.argv[2] || 'list';
if (command === 'list') {
  const { deals } = await call({ action: 'list' });
  console.log(JSON.stringify({ total: deals.length, matches: deals.filter(d => /테스트|커큐민|비비고|천하장사/.test(d.title)).map(d => ({
    id: d.id, title: d.title, source: d.source, saleType: d.saleType, deadline: d.deadline,
    description: d.description, originalPrice: d.originalPrice, expectedPerPerson: d.expectedPerPerson,
    totalQuantity: d.totalQuantity, visibility: d.visibility, version: d.publishVersion
  })) }, null, 2));
} else if (command === 'orders') {
  const { orders } = await call({ action: 'orders', dealId: process.argv[3] });
  console.log(JSON.stringify(orders.map(o => ({ id: o.id, dealId: o.dealId, groupId: o.groupId,
    type: o.type, status: o.status, paymentStatus: o.paymentStatus, version: o.version, paymentVersion: o.paymentVersion,
    updatedAt: o.statusUpdatedAt, reservation: Boolean(o.reservationMutationId), quantity: o.selectedCount || o.quantity,
    paymentConfirmedAt: o.paymentConfirmedAt })), null, 2));
} else if (command === 'delete-requested-tests') {
  // Exact IDs resolved from the four screenshots. No search-based or bulk deletion.
  const targets = [
    { id: 'customer-666500af-db49-482e-a5bd-4f211b0f7017', title: '테스트 2', deadline: '2026-09-08 20:00', price: 2000 },
    { id: 'owner-95707807-84ec-44ac-8b5e-e08cc667108c', title: '[파격세일] 비비고 고등어구이, 60g, 20개', deadline: '2026-09-07 20:00', price: 3530 },
    { id: 'customer-cb8c4436-01eb-44fd-8b81-5e574798d1c5', title: '강황 수용성 커큐민 식약청 HACCP 인증 (대용량), 120정', deadline: '2026-09-04 20:00', price: 11720 },
    { id: 'owner-6a724b81-be23-49fb-a183-a497a5e4dc08', title: '테스트', deadline: '2026-09-07 20:00', price: 1030 },
  ];
  const { deals } = await call({ action: 'list' });
  for (const target of targets) {
    const deal = deals.find(d => d.id === target.id);
    if (!deal || deal.title.trim() !== target.title || deal.deadline !== target.deadline || Number(deal.expectedPerPerson) !== target.price) throw new Error(`target_mismatch:${target.id}`);
  }
  for (const target of targets) {
    const deal = deals.find(d => d.id === target.id);
    const before = (await call({ action: 'orders', dealId: target.id })).orders;
    if (deal.visibility !== 'deleted') await call({ action: 'delete', dealId: target.id,
      expectedVersion: Number(deal.publishVersion || 0), clientMutationId: `feedback-delete-20260909-${target.id}`,
      reason: '2026-09-08 고객 피드백에서 특정한 테스트 상품 삭제 요청 반영' });
    const after = (await call({ action: 'orders', dealId: target.id })).orders;
    const unchanged = JSON.stringify(before.map(o => [o.id, o.version, o.paymentVersion, o.status, o.paymentStatus]).sort())
      === JSON.stringify(after.map(o => [o.id, o.version, o.paymentVersion, o.status, o.paymentStatus]).sort());
    console.log(JSON.stringify({ id: target.id, title: target.title, hidden: true, retainedOrders: after.length, orderStatesUnchanged: unchanged }));
    if (!unchanged) throw new Error('concurrent_order_change_needs_review');
  }
} else throw new Error('unknown_command');
