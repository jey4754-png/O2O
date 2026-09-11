import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function readOnlySheet(rows) {
  return {
    getLastRow: () => rows.length,
    getRange(row, column, height = 1, width = 1) {
      return {
        getValues: () => rows.slice(row - 1, row - 1 + height)
          .map((cells) => Array.from({ length: width }, (_, index) => cells[column - 1 + index] ?? '')),
        createTextFinder(value) {
          let entireCell = false;
          return {
            matchCase() { return this; },
            matchEntireCell(enabled = true) { entireCell = enabled; return this; },
            findAll: () => rows.slice(row - 1, row - 1 + height).flatMap((cells, index) => (
              (entireCell ? String(cells[column - 1] ?? '') === String(value)
                : String(cells[column - 1] ?? '').includes(String(value))) ? [{ getRow: () => row + index }] : []
            )),
          };
        },
      };
    },
  };
}

export function customerHistoryStore({ current = [], historic = [] } = {}) {
  const context = {};
  runInNewContext(readFileSync(new URL('../../apps-script/Code.gs', import.meta.url), 'utf8'), context);
  const currentRows = [['time', 'id', 'phone', 'snapshot'], ...current.map((order) => [
    '', order.id, order.customerPhone, JSON.stringify(order),
  ])];
  const eventRows = [Array(16).fill('header'), ...historic.map((order) => {
    const row = Array(16).fill('');
    row[6] = 'customer_order_snapshot';
    row[11] = JSON.stringify({ order_snapshot: JSON.stringify(order) });
    row[13] = order.customerPhone;
    return row;
  })];
  const data = { customerOrders: readOnlySheet(currentRows), events: readOnlySheet(eventRows),
    groupHistory: readOnlySheet([[]]), groupParticipants: readOnlySheet([[]]) };
  context.ensureSheets_ = () => data;
  context.json_ = (value) => JSON.parse(JSON.stringify(value));
  return { context, currentRows, eventRows, data };
}

export function historyOrder(id, overrides = {}) {
  return {
    id: `order-${id}`, dealId: 'owner-history-source', type: 'purchase',
    title: '합성 과거 주문', customerName: '합성 사용자', customerPhone: '01011112222',
    visitorId: 'customer-history-visitor', customerNumber: 'UP-customer',
    status: 'new', paymentStatus: 'pending', version: 1, selectedCount: 1, quantity: 1,
    method: '픽업', total: 10000, store: '합성 매장',
    region: '경기도', district: '성남시 분당구', neighborhood: '판교동',
    createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
    statusHistory: [{ status: 'new', actor: 'customer', timestamp: '2026-08-27T00:00:00.000Z' }],
    ...overrides,
  };
}
