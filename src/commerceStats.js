import { isCancelledOrder } from './participation.js';

const ORDER_STAGES = [
  { id: 'new', label: '신규 주문' },
  { id: 'preparing', label: '준비 중' },
  { id: 'pickup_waiting', label: '픽업 대기' },
  { id: 'completed', label: '주문 완료' },
];

function orderStage(order) {
  return ORDER_STAGES.find((stage) => stage.id === order.status) || ORDER_STAGES[0];
}

export function buildCommerceStats(orders) {
  const rows = orders
    .filter((order) => order.type === 'purchase')
    .map((order) => {
      const cancelled = isCancelledOrder(order);
      const stage = orderStage(order);
      const ownerCompleted = !cancelled && stage.id === 'completed';
      const customerConfirmed = !cancelled && Boolean(order.customerPickupConfirmedAt);
      const paymentConfirmed = !cancelled && Boolean(order.paymentConfirmedAt);
      return {
        id: order.id,
        title: order.title,
        neighborhood: order.neighborhood || order.deal?.neighborhood || '미설정',
        total: Number(order.total || 0),
        cancelled,
        ownerStatus: cancelled ? '참여 취소' : stage.label,
        ownerCompleted,
        paymentConfirmed,
        customerConfirmed,
        verified: !cancelled && paymentConfirmed && ownerCompleted && customerConfirmed,
        createdAt: order.createdAt,
        accepted: !cancelled && ORDER_STAGES.findIndex((item) => item.id === stage.id) >= 1,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const activeRows = rows.filter((row) => !row.cancelled);

  return {
    rows,
    orderCount: activeRows.length,
    cancelledCount: rows.length - activeRows.length,
    paymentConfirmedCount: activeRows.filter((row) => row.paymentConfirmed).length,
    acceptedCount: activeRows.filter((row) => row.accepted).length,
    ownerCompletedCount: activeRows.filter((row) => row.ownerCompleted).length,
    customerConfirmedCount: activeRows.filter((row) => row.customerConfirmed).length,
    verifiedCount: activeRows.filter((row) => row.verified).length,
    candidateAmount: activeRows.reduce((sum, row) => sum + row.total, 0),
    paymentConfirmedAmount: activeRows.filter((row) => row.paymentConfirmed).reduce((sum, row) => sum + row.total, 0),
    verifiedAmount: activeRows.filter((row) => row.verified).reduce((sum, row) => sum + row.total, 0),
  };
}
