import { randomUUID } from 'node:crypto';
import { productImageStore, fakeSheet, imageDeal } from './product-image-store.js';

export function adminStore() {
  const store = productImageStore();
  const { context, publicDeals } = store;
  const sheets = { publicDeals };
  for (const name of ['customerOrders', 'groups', 'groupParticipants', 'groupHistory', 'groupChat', 'events']) {
    sheets[name] = fakeSheet();
    sheets[name].rows.push(['header']);
  }
  context.ensureSheets_ = () => sheets;
  context.Utilities.getUuid = randomUUID;
  context.publishPublicDeal_(imageDeal('data:image/jpeg;base64,/9j/2Q=='), 'a'.repeat(64));
  const dealId = imageDeal('').id;
  const orderId = 'order-1700000000001';
  const order = { id: orderId, dealId, groupId: dealId, participantActorId: 'member-test', visitorId: 'member-test',
    type: 'purchase', status: 'new', paymentStatus: 'confirmed', quantity: 2, selectedCount: 2,
    version: 2, paymentVersion: 2, paymentConfirmedAt: '2026-09-08T00:00:00Z',
    _reservationQuantity: 2, reservationQuantity: 2, _reservationAction: 'join', reservationAction: 'join',
    _reservationMutationId: 'reservation-test-001', reservationMutationId: 'reservation-test-001',
    customerName: '검증 사용자', _customerCapabilityHash: 'b'.repeat(64) };
  sheets.customerOrders.rows.push(['', orderId, '', JSON.stringify(order)]);
  sheets.groups.rows.push([dealId, dealId, '관리 검증 상품', 'recruiting', 5, false, 'host-test', 0, 1, '', '', '', 'host-test', 'recruiting', 10]);
  sheets.groupParticipants.rows.push([dealId, 'member-test', '검증 사용자', 'member', true, 'confirmed', 0, 'c'.repeat(64), 2, '', '', 2]);
  context.appendGroupHistory_(sheets, { groupId: dealId, action: 'join', actorId: 'member-test', entityId: 'member-test',
    clientMutationId: 'reservation-test-001', result: { mutationContract: JSON.stringify({ selectedQuantity: 2 }) } });
  return { ...store, data: sheets, dealId, orderId, order };
}
