// Production values are configured in the deployed Apps Script project.
const SPREADSHEET_ID = 'REPLACE_WITH_SPREADSHEET_ID';
const INGEST_TOKEN = 'REPLACE_WITH_RANDOM_TOKEN';
const EVENT_HEADERS = [
  '수집시각', '발생시각', '사용자명', '사용자유형', '익명ID', '세션ID',
  '이벤트', '시도', '시군구', '읍면동', '화면', '상세데이터', '고객번호', '연락처', '이벤트ID'
];
const SURVEY_HEADERS = [
  '수집시각', '제출시각', '고객번호', '이름', '연락처', '사용자유형',
  '시도', '시군구', '읍면동', '참여 이유', '희망 할인', '호스트 의향',
  '희망 카테고리', '재이용 의향', '피드백', '익명ID', '이벤트ID'
];
const PUBLIC_DEAL_HEADERS = [
  '업데이트시각', '상품ID', '등록유형', '시도', '시군구', '읍면동', '상품데이터'
];
const CUSTOMER_ORDER_HEADERS = [
  '업데이트시각', '주문ID', '연락처', '주문데이터'
];
const GROUP_HEADERS = [
  '그룹ID', '상품ID', '제목', '그룹상태', '목표인원', '채팅잠금',
  '호스트ID', '마지막메시지SEQ', '버전', '생성시각', '수정시각', '수정자',
  '생성자ID', '호스트모드', '총상품수'
];
const GROUP_PARTICIPANT_HEADERS = [
  '그룹ID', '참여자ID', '닉네임', '역할', '인원포함', '입금상태',
  '마지막읽음SEQ', '권한토큰해시', '버전', '참여시각', '수정시각', '선택수량'
];
const GROUP_CHAT_HEADERS = [
  '그룹ID', 'SEQ', '메시지ID', '참여자ID', '닉네임', '역할',
  '메시지', '생성시각', '요청ID'
];
const GROUP_HISTORY_HEADERS = [
  '이력ID', '그룹ID', '대상유형', '대상ID', '이전상태', '변경상태',
  '행동', '수행자ID', '수행자역할', '사유', '요청ID', '버전', '변경시각', '결과데이터'
];
const GROUP_STATUSES = ['recruiting', 'recruited', 'purchased', 'delivered'];
const PAYMENT_STATUSES = ['pending', 'requested', 'confirmed'];
const GROUP_MAX_PARTICIPANTS = 20;
const GROUP_MESSAGE_LIMIT = 100;

function doGet() {
  return json_({ ok: true, service: 'UPTWOYOU collector' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (body.token !== INGEST_TOKEN) return json_({ ok: false, error: 'unauthorized' });
    if (body.action === 'stats') return json_({ ok: true, stats: getCentralStats_() });
    if (body.action === 'public_deals') return json_({ ok: true, deals: getPublicDeals_() });
    if (body.action === 'publish_deal') return publishPublicDeal_(body.deal || {}, body.ownerCapabilityHash || '');
    if (body.action === 'delete_deal') return deletePublicDeal_(body.dealId || '', body.ownerCapabilityHash || '');
    if (body.action === 'customer_orders') {
      return getCustomerOrdersResponse_(
        body.phone || '',
        body.visitorId || '',
        body.customerCapabilityHash || ''
      );
    }
    if (body.action === 'customer_orders_group') return getCustomerOrdersByGroup_(body.payload || {});
    if (body.action === 'publish_order') {
      return publishCustomerOrder_(
        body.order || {},
        body.visitorId || '',
        body.customerCapabilityHash || ''
      );
    }
    if (/^group_(create|join|snapshot|send_message|mark_read|transition_group|transition_payment|update_target|toggle_lock|claim_host|reserve_quantity)$/.test(String(body.action || ''))) {
      return handleGroupOperation_(String(body.action).replace(/^group_/, ''), body.payload || {});
    }
    const event = body.event || {};
    const properties = event.properties || {};
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheets = ensureSheets_();
      const events = sheets.events;
      if (event.id && eventExists_(events, event.id)) {
        if (event.name === 'profile_submitted') {
          backfillVisitorProfile_(events, event.visitorId, properties);
        }
        if (event.name === 'survey_submitted' && !surveyExists_(sheets.surveys, event.id)) {
          appendSurveyRow_(sheets.surveys, event, properties);
        }
        CacheService.getScriptCache().remove('central_stats_v2');
        return json_({ ok: true, duplicate: true });
      }
      const storedProperties = JSON.parse(JSON.stringify(properties));
      storedProperties.event_id = event.id || '';
      events.appendRow([
        new Date(), event.timestamp ? new Date(event.timestamp) : new Date(),
        safeCell_(properties.tester_name || '미설정'), safeCell_(properties.tester_type || '미설정'),
        safeCell_(event.visitorId || ''), safeCell_(event.sessionId || ''), safeCell_(event.name || ''),
        safeCell_(properties.region || '미설정'), safeCell_(properties.district || '미설정'),
        safeCell_(properties.neighborhood || '미설정'), safeCell_(properties.screen || ''), JSON.stringify(storedProperties),
        safeCell_(properties.customer_number || ''), safeCell_(properties.customer_phone || ''), safeCell_(event.id || '')
      ]);
      if (event.name === 'profile_submitted') {
        backfillVisitorProfile_(events, event.visitorId, properties);
      }
      if (event.name === 'survey_submitted') {
        appendSurveyRow_(sheets.surveys, event, properties);
      }
      CacheService.getScriptCache().remove('central_stats_v2');
    } finally {
      lock.releaseLock();
    }
    return json_({ ok: true });
  } catch (error) {
    return json_({ ok: false, error: String(error) });
  }
}

function eventExists_(events, eventId) {
  if (!eventId || events.getLastRow() < 2) return false;
  return Boolean(events.getRange(2, EVENT_HEADERS.length, events.getLastRow() - 1, 1)
    .createTextFinder(String(eventId)).matchEntireCell(true).findNext());
}

function surveyExists_(surveys, eventId) {
  if (!eventId || surveys.getLastRow() < 2) return false;
  return Boolean(surveys.getRange(2, SURVEY_HEADERS.length, surveys.getLastRow() - 1, 1)
    .createTextFinder(String(eventId)).matchEntireCell(true).findNext());
}

function appendSurveyRow_(surveys, event, properties) {
  surveys.appendRow(surveyRowValues_(event, properties));
}

function surveyRowValues_(event, properties) {
  return [
    new Date(), event.timestamp ? new Date(event.timestamp) : new Date(),
    safeCell_(properties.customer_number || ''), safeCell_(properties.tester_name || '미설정'),
    safeCell_(properties.customer_phone || ''), safeCell_(properties.tester_type || '미설정'),
    safeCell_(properties.region || '미설정'), safeCell_(properties.district || '미설정'),
    safeCell_(properties.neighborhood || '미설정'), safeCell_(properties.reason || ''),
    safeCell_(properties.discountExpectation || ''), safeCell_(properties.hostIntent || ''),
    safeCell_(properties.preferredCategory || ''), safeCell_(properties.revisitIntent || ''),
    safeCell_(properties.feedback || ''), safeCell_(event.visitorId || ''), safeCell_(event.id || '')
  ];
}

function safeCell_(value) {
  const text = String(value == null ? '' : value).slice(0, 5000);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function privateCapabilityHash_(value, errorCode) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw groupOperationError_(errorCode || 'invalid_capability');
  return normalized;
}

function publicDealValue_(deal) {
  const copy = Object.assign({}, deal || {});
  delete copy._ownerCapabilityHash;
  return copy;
}

function publicOrderValue_(order) {
  const copy = Object.assign({}, order || {});
  delete copy._customerCapabilityHash;
  return copy;
}

function publishPublicDeal_(deal, ownerCapabilityHash) {
  if (!deal.id || !/^(owner|customer)-[a-zA-Z0-9-]{1,100}$/.test(String(deal.id))) {
    return json_({ ok: false, error: 'invalid_deal_id' });
  }
  if (String(deal.source || '') === 'customer' && String(deal.groupId || '') !== String(deal.id)) {
    return json_({ ok: false, error: 'invalid_group_deal_binding' });
  }
  let incomingHash;
  try {
    incomingHash = privateCapabilityHash_(ownerCapabilityHash, 'invalid_owner_capability');
  } catch (error) {
    return json_({ ok: false, error: error.code || 'invalid_owner_capability' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheets_().publicDeals;
    let targetRow = sheet.getLastRow() + 1;
    let existingDeal = null;
    if (sheet.getLastRow() >= 2) {
      const match = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
        .createTextFinder(String(deal.id)).matchEntireCell(true).findNext();
      if (match) {
        targetRow = match.getRow();
        try {
          existingDeal = JSON.parse(sheet.getRange(targetRow, 7).getValue() || '{}');
        } catch (error) {
          existingDeal = {};
        }
        if (!existingDeal || typeof existingDeal !== 'object' || Array.isArray(existingDeal)) {
          existingDeal = {};
        }
      }
    }
    if (existingDeal) {
      const existingHash = String(existingDeal._ownerCapabilityHash || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(existingHash)) {
        return json_({ ok: false, error: 'deal_ownership_unclaimable' });
      }
      if (existingHash !== incomingHash) return json_({ ok: false, error: 'forbidden' });
    }
    const storedDeal = Object.assign({}, deal, {
      visibility: 'public',
      syncedAt: new Date().toISOString(),
      _ownerCapabilityHash: incomingHash
    });
    const serialized = JSON.stringify(storedDeal);
    if (serialized.length > 45000) return json_({ ok: false, error: 'deal_too_large' });
    sheet.getRange(targetRow, 1, 1, PUBLIC_DEAL_HEADERS.length).setValues([[
      new Date(), safeCell_(storedDeal.id), safeCell_(storedDeal.source || ''),
      safeCell_(storedDeal.region || ''), safeCell_(storedDeal.district || ''),
      safeCell_(storedDeal.neighborhood || ''), serialized
    ]]);
    return json_({ ok: true, deal: publicDealValue_(storedDeal) });
  } finally {
    lock.releaseLock();
  }
}

function getPublicDeals_() {
  const sheets = ensureSheets_();
  const sheet = sheets.publicDeals;
  if (sheet.getLastRow() < 2) return [];
  const startRow = Math.max(2, sheet.getLastRow() - 499);
  const deals = sheet.getRange(startRow, 7, sheet.getLastRow() - startRow + 1, 1)
    .getValues()
    .map(function(row) {
      try { return publicDealValue_(JSON.parse(row[0] || '{}')); } catch (error) { return null; }
    })
    .filter(function(deal) { return deal && deal.id && deal.visibility === 'public'; });

  const groupsById = Object.create(null);
  if (sheets.groups.getLastRow() >= 2) {
    sheets.groups.getRange(2, 1, sheets.groups.getLastRow() - 1, GROUP_HEADERS.length)
      .getValues()
      .forEach(function(row, index) {
        const group = groupFromRow_(row, index + 2);
        if (group) groupsById[group.groupId] = group;
      });
  }
  const countedByGroup = Object.create(null);
  const orderedByGroup = Object.create(null);
  if (sheets.groupParticipants.getLastRow() >= 2) {
    sheets.groupParticipants.getRange(2, 1, sheets.groupParticipants.getLastRow() - 1, GROUP_PARTICIPANT_HEADERS.length)
      .getValues()
      .forEach(function(row, index) {
        const participant = participantFromRow_(row, index + 2, false);
        const groupId = participant ? participant.groupId : '';
        if (groupId && participant.counted) {
          countedByGroup[groupId] = Number(countedByGroup[groupId] || 0) + 1;
          orderedByGroup[groupId] = Number(orderedByGroup[groupId] || 0)
            + Number(participant.selectedQuantity || 0);
        }
      });
  }

  const storedOrders = [];
  if (sheets.customerOrders.getLastRow() >= 2) {
    sheets.customerOrders.getRange(2, 4, sheets.customerOrders.getLastRow() - 1, 1)
      .getValues()
      .forEach(function(row) {
        try {
          const order = JSON.parse(row[0] || '{}');
          if (/^[a-f0-9]{64}$/.test(String(order._customerCapabilityHash || '').toLowerCase())) {
            storedOrders.push(order);
          }
        } catch (error) {}
      });
  }
  const merchantProgressByDeal = Object.create(null);
  mergeCustomerOrderSnapshots_(storedOrders).forEach(function(order) {
    if (String(order.type || '') !== 'purchase') return;
    const dealId = String(order.dealId || (order.deal && order.deal.id) || '');
    const visitorId = String(order.visitorId || '');
    if (!dealId || !visitorId) return;
    if (!merchantProgressByDeal[dealId]) {
      merchantProgressByDeal[dealId] = { quantity: 0, visitors: Object.create(null) };
    }
    const rawQuantity = Number(order.selectedCount || order.quantity || 1);
    const quantity = Number.isFinite(rawQuantity) ? Math.max(1, Math.floor(rawQuantity)) : 1;
    merchantProgressByDeal[dealId].quantity += quantity;
    merchantProgressByDeal[dealId].visitors[visitorId] = true;
  });

  return deals
    .map(function(deal) {
      if (deal.source !== 'customer') {
        const progress = merchantProgressByDeal[String(deal.id || '')] || {
          quantity: 0,
          visitors: Object.create(null)
        };
        const target = Math.max(1, Number(deal.target || deal.targetCount || 1));
        const current = Math.min(target, Math.max(0, Number(progress.quantity || 0)));
        return Object.assign({}, deal, {
          current: current,
          currentCount: current,
          participantCount: Object.keys(progress.visitors).length,
          quantityTracking: true
        });
      }
      const groupId = String(deal.id || '');
      const group = groupsById[groupId];
      if (!group) return deal;
      const currentCount = Number(countedByGroup[groupId] || 0);
      return Object.assign({}, deal, {
        groupId: groupId,
        target: group.targetCount,
        targetCount: group.targetCount,
        current: currentCount,
        currentCount: currentCount,
        participantCount: currentCount,
        groupStatus: group.groupStatus,
        chatLocked: group.chatLocked,
        creatorActorId: group.creatorActorId,
        hostMode: group.hostMode,
        hostActorId: group.hostActorId,
        hostMatched: Boolean(group.hostActorId),
        totalQuantity: group.totalQuantity,
        orderedQuantity: Number(orderedByGroup[groupId] || 0),
        version: group.version,
        stateVersion: group.version,
        lastMessageSeq: group.lastMessageSeq,
        updatedAt: group.updatedAt || deal.updatedAt
      });
    })
    .sort(function(a, b) {
      return String(b.syncedAt || '').localeCompare(String(a.syncedAt || ''));
    });
}

function deletePublicDeal_(dealId, ownerCapabilityHash) {
  if (!/^(owner|customer)-[a-zA-Z0-9-]{1,100}$/.test(String(dealId))) {
    return json_({ ok: false, error: 'invalid_deal_id' });
  }
  let incomingHash;
  try {
    incomingHash = privateCapabilityHash_(ownerCapabilityHash, 'invalid_owner_capability');
  } catch (error) {
    return json_({ ok: false, error: error.code || 'invalid_owner_capability' });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheets_().publicDeals;
    if (sheet.getLastRow() < 2) return json_({ ok: true, deleted: false });
    const match = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
      .createTextFinder(String(dealId)).matchEntireCell(true).findNext();
    if (!match) return json_({ ok: true, deleted: false });
    let existingDeal = {};
    try { existingDeal = JSON.parse(sheet.getRange(match.getRow(), 7).getValue() || '{}'); } catch (error) {}
    if (!existingDeal || typeof existingDeal !== 'object' || Array.isArray(existingDeal)) {
      existingDeal = {};
    }
    const existingHash = String(existingDeal._ownerCapabilityHash || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(existingHash)) {
      return json_({ ok: false, error: 'deal_ownership_unclaimable' });
    }
    if (existingHash !== incomingHash) return json_({ ok: false, error: 'forbidden' });
    sheet.deleteRow(match.getRow());
    return json_({ ok: true, deleted: true });
  } finally {
    lock.releaseLock();
  }
}

function normalizePhone_(value) {
  return String(value || '').replace(/\D/g, '');
}

function validVisitorId_(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(String(value || ''));
}

function publishCustomerOrder_(order, visitorIdValue, customerCapabilityHash) {
  if (!order.id || !/^order-\d{10,20}$/.test(String(order.id))) {
    return json_({ ok: false, error: 'invalid_order_id' });
  }
  const visitorId = String(visitorIdValue || '');
  if (!validVisitorId_(visitorId) || String(order.visitorId || '') !== visitorId) {
    return json_({ ok: false, error: 'invalid_order_owner' });
  }
  const orderGroupId = String(order.groupId || '');
  const orderDealId = String(order.dealId || (order.deal && order.deal.id) || '');
  if (orderGroupId && (!validVisitorId_(orderGroupId) || orderGroupId !== orderDealId)) {
    return json_({ ok: false, error: 'invalid_group_deal_binding' });
  }
  let incomingHash;
  try {
    incomingHash = privateCapabilityHash_(customerCapabilityHash, 'invalid_customer_capability');
  } catch (error) {
    return json_({ ok: false, error: error.code || 'invalid_customer_capability' });
  }
  const phone = normalizePhone_(order.customerPhone);
  if (phone.length < 8) return json_({ ok: false, error: 'invalid_customer_phone' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheets = ensureSheets_();
    const sheet = sheets.customerOrders;
    let targetRow = sheet.getLastRow() + 1;
    let existingOrder = null;
    if (sheet.getLastRow() >= 2) {
      const match = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
        .createTextFinder(String(order.id)).matchEntireCell(true).findNext();
      if (match) {
        targetRow = match.getRow();
        try {
          existingOrder = JSON.parse(sheet.getRange(targetRow, 4).getValue() || '{}');
        } catch (error) {
          existingOrder = {};
        }
        if (!existingOrder || typeof existingOrder !== 'object' || Array.isArray(existingOrder)) {
          existingOrder = {};
        }
      }
    }
    if (!existingOrder) {
      const historicMatches = historicCustomerOrders_(sheets.events, '', '')
        .filter(function(candidate) { return String(candidate.id || '') === String(order.id); });
      const historicOwnership = customerOrderOwnership_(historicMatches);
      if (historicOwnership.conflict) {
        return json_({ ok: false, error: 'order_ownership_unclaimable' });
      }
      existingOrder = mergeCustomerOrderSnapshots_(historicMatches)[0] || null;
      if (existingOrder && historicOwnership.hash) {
        existingOrder._customerCapabilityHash = historicOwnership.hash;
      }
    }
    if (existingOrder) {
      const existingHash = String(existingOrder._customerCapabilityHash || '').toLowerCase();
      if (/^[a-f0-9]{64}$/.test(existingHash)) {
        if (existingHash !== incomingHash) return json_({ ok: false, error: 'forbidden' });
      } else if (existingHash) {
        return json_({ ok: false, error: 'order_ownership_unclaimable' });
      } else if (String(existingOrder.visitorId || '') !== visitorId) {
        return json_({ ok: false, error: 'order_owner_conflict' });
      }
    }
    const storedOrder = Object.assign({}, order, {
      customerPhone: phone,
      visitorId: visitorId,
      syncedAt: new Date().toISOString(),
      _customerCapabilityHash: incomingHash
    });
    const serialized = JSON.stringify(storedOrder);
    if (serialized.length > 30000) return json_({ ok: false, error: 'order_too_large' });
    sheet.getRange(targetRow, 1, 1, CUSTOMER_ORDER_HEADERS.length).setValues([[
      new Date(), safeCell_(storedOrder.id), safeCell_(phone), serialized
    ]]);
    return json_({ ok: true, order: publicOrderValue_(storedOrder) });
  } finally {
    lock.releaseLock();
  }
}

function customerOrderOwnership_(orders) {
  let hash = '';
  let conflict = false;
  orders.forEach(function(order) {
    if (!order) return;
    const storedHash = String(order._customerCapabilityHash || '').toLowerCase();
    if (!storedHash) return;
    if (!/^[a-f0-9]{64}$/.test(storedHash)) {
      conflict = true;
    } else if (!hash) {
      hash = storedHash;
    } else if (hash !== storedHash) {
      conflict = true;
    }
  });
  return { hash: hash, conflict: conflict };
}

function filterCustomerOrdersForProof_(orders, visitorId, customerCapabilityHash) {
  const ownershipById = Object.create(null);
  orders.forEach(function(order) {
    if (!order || !order.id) return;
    const key = String(order.id);
    const storedHash = String(order._customerCapabilityHash || '').toLowerCase();
    if (!storedHash) return;
    if (!ownershipById[key]) ownershipById[key] = { hash: '', conflict: false };
    if (!/^[a-f0-9]{64}$/.test(storedHash)) {
      ownershipById[key].conflict = true;
    } else if (!ownershipById[key].hash) {
      ownershipById[key].hash = storedHash;
    } else if (ownershipById[key].hash !== storedHash) {
      ownershipById[key].conflict = true;
    }
  });
  return orders.filter(function(order) {
    if (!order || !order.id) return false;
    const ownership = ownershipById[String(order.id)];
    if (ownership && ownership.conflict) return false;
    if (ownership && ownership.hash) return ownership.hash === customerCapabilityHash;
    return String(order.visitorId || '') === visitorId;
  });
}

function getCustomerOrders_(phoneValue, visitorIdValue, customerCapabilityHashValue) {
  const phone = normalizePhone_(phoneValue);
  const visitorId = String(visitorIdValue || '');
  if (phone.length < 8) throw groupOperationError_('invalid_customer_phone');
  if (!validVisitorId_(visitorId)) throw groupOperationError_('invalid_order_owner');
  const customerCapabilityHash = privateCapabilityHash_(
    customerCapabilityHashValue,
    'invalid_customer_capability'
  );
  const sheets = ensureSheets_();
  const current = [];
  const sheet = sheets.customerOrders;
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 3, sheet.getLastRow() - 1, 2)
      .getValues()
      .filter(function(row) { return normalizePhone_(row[0]) === phone; })
      .forEach(function(row) {
        try { current.push(JSON.parse(row[1] || '{}')); } catch (error) {}
      });
  }
  const historic = historicCustomerOrders_(sheets.events, phone, '');
  const authorized = filterCustomerOrdersForProof_(
    current.concat(historic),
    visitorId,
    customerCapabilityHash
  );
  return mergeCustomerOrderSnapshots_(authorized).map(publicOrderValue_);
}

function getCustomerOrdersResponse_(phoneValue, visitorId, customerCapabilityHash) {
  try {
    return json_({
      ok: true,
      orders: getCustomerOrders_(phoneValue, visitorId, customerCapabilityHash)
    });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'customer_orders_failed' });
  }
}

function historicCustomerOrders_(events, phone, dealId) {
  if (events.getLastRow() < 2) return [];
  const rows = events.getRange(2, 1, events.getLastRow() - 1, EVENT_HEADERS.length).getValues();
  const results = [];
  rows.forEach(function(row) {
    if (String(row[6] || '') !== 'customer_order_snapshot') return;
    if (phone && normalizePhone_(row[13]) !== normalizePhone_(phone)) return;
    try {
      const details = JSON.parse(row[11] || '{}');
      const order = JSON.parse(details.order_snapshot || '{}');
      const orderDealId = String(order.dealId || (order.deal && order.deal.id) || '');
      if (dealId && orderDealId !== dealId) return;
      if (order && order.id) results.push(order);
    } catch (error) {}
  });
  return results;
}

function mergeCustomerOrderSnapshots_(orders) {
  const latest = Object.create(null);
  orders.forEach(function(order) {
    if (!order || !order.id) return;
    const key = String(order.id);
    const previous = latest[key];
    const candidateTime = new Date(order.statusUpdatedAt || order.syncedAt || order.createdAt || 0).getTime() || 0;
    const previousTime = previous
      ? new Date(previous.statusUpdatedAt || previous.syncedAt || previous.createdAt || 0).getTime() || 0
      : -1;
    if (!previous || candidateTime >= previousTime) latest[key] = order;
  });
  return Object.keys(latest).map(function(key) { return latest[key]; }).sort(function(a, b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

function groupOperationError_(code, details) {
  const error = new Error(code);
  error.code = code;
  error.details = details || {};
  return error;
}

function groupText_(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength || 500);
}

function requireGroupId_(value, fieldName) {
  const normalized = groupText_(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(normalized)) {
    throw groupOperationError_('invalid_' + (fieldName || 'group_id'));
  }
  return normalized;
}

function requireMutationId_(value) {
  const normalized = groupText_(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(normalized)) {
    throw groupOperationError_('invalid_client_mutation_id');
  }
  return normalized;
}

function requireCapabilityHash_(value) {
  const normalized = groupText_(value, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw groupOperationError_('invalid_capability');
  return normalized;
}

function requireInteger_(value, fieldName, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw groupOperationError_('invalid_' + fieldName);
  }
  return parsed;
}

function isoValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return value.toISOString();
  return String(value || '');
}

function booleanValue_(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function decodedSafeCell_(value) {
  const source = String(value == null ? '' : value);
  return /^'[=+\-@]/.test(source) ? source.slice(1) : source;
}

function findExactRow_(sheet, column, value) {
  if (!value || sheet.getLastRow() < 2) return 0;
  const match = sheet.getRange(2, column, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).findNext();
  return match ? match.getRow() : 0;
}

function findGroupParticipantRow_(sheet, groupId, actorId) {
  if (sheet.getLastRow() < 2) return 0;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (let index = 0; index < rows.length; index += 1) {
    if (String(rows[index][0]) === groupId && String(rows[index][1]) === actorId) return index + 2;
  }
  return 0;
}

function groupFromRow_(row, rowNumber) {
  if (!row || !row[0]) return null;
  const legacyHostActorId = String(row[6] || '');
  const storedHostMode = String(row[13] || '');
  return {
    rowNumber: rowNumber,
    groupId: String(row[0]),
    dealId: String(row[1] || ''),
    title: String(row[2] || ''),
    groupStatus: String(row[3] || GROUP_STATUSES[0]),
    targetCount: Number(row[4] || 1),
    chatLocked: booleanValue_(row[5]),
    hostActorId: legacyHostActorId,
    lastMessageSeq: Number(row[7] || 0),
    version: Number(row[8] || 1),
    createdAt: isoValue_(row[9]),
    updatedAt: isoValue_(row[10]),
    updatedBy: String(row[11] || ''),
    creatorActorId: String(row[12] || legacyHostActorId),
    hostMode: storedHostMode === 'recruiting' ? 'recruiting' : 'self',
    totalQuantity: Math.max(1, Number(row[14] || row[4] || 1))
  };
}

function participantFromRow_(row, rowNumber, includeSecret) {
  if (!row || !row[0] || !row[1]) return null;
  const counted = booleanValue_(row[4]);
  const participant = {
    rowNumber: rowNumber,
    groupId: String(row[0]),
    actorId: String(row[1]),
    nickname: decodedSafeCell_(row[2]),
    role: String(row[3] || 'member'),
    counted: counted,
    paymentStatus: PAYMENT_STATUSES.includes(String(row[5])) ? String(row[5]) : PAYMENT_STATUSES[0],
    lastReadSeq: Number(row[6] || 0),
    version: Number(row[8] || 1),
    joinedAt: isoValue_(row[9]),
    updatedAt: isoValue_(row[10]),
    selectedQuantity: row[11] === '' || row[11] === null || row[11] === undefined
      ? (counted ? 1 : 0)
      : Math.max(0, Number(row[11] || 0))
  };
  if (includeSecret) participant.capabilityHash = String(row[7] || '').toLowerCase();
  return participant;
}

function getGroupRecord_(sheets, groupId) {
  const rowNumber = findExactRow_(sheets.groups, 1, groupId);
  if (!rowNumber) throw groupOperationError_('group_not_found');
  return groupFromRow_(sheets.groups.getRange(rowNumber, 1, 1, GROUP_HEADERS.length).getValues()[0], rowNumber);
}

function getParticipantRecord_(sheets, groupId, actorId, required) {
  const rowNumber = findGroupParticipantRow_(sheets.groupParticipants, groupId, actorId);
  if (!rowNumber) {
    if (required !== false) throw groupOperationError_('participant_not_found');
    return null;
  }
  return participantFromRow_(
    sheets.groupParticipants.getRange(rowNumber, 1, 1, GROUP_PARTICIPANT_HEADERS.length).getValues()[0],
    rowNumber,
    true
  );
}

function authorizeGroupActor_(sheets, groupId, payload) {
  getGroupRecord_(sheets, groupId);
  const actorId = requireGroupId_(payload.actorId, 'actor_id');
  const participant = getParticipantRecord_(sheets, groupId, actorId, false);
  if (payload.adminAssertion === true) {
    return { actorId: actorId, role: 'admin', participant: participant };
  }
  const suppliedHash = requireCapabilityHash_(payload.capabilityHash);
  if (!participant || !participant.capabilityHash || participant.capabilityHash !== suppliedHash) {
    throw groupOperationError_('invalid_capability');
  }
  return { actorId: actorId, role: participant.role, participant: participant };
}

function requireManager_(actor) {
  if (!actor || !['host', 'admin'].includes(actor.role)) throw groupOperationError_('forbidden');
}

function requireTargetManager_(actor) {
  if (!actor || !['creator', 'host', 'admin'].includes(actor.role)) {
    throw groupOperationError_('forbidden');
  }
}

function getParticipantsForGroup_(sheets, groupId, includeSecret) {
  const sheet = sheets.groupParticipants;
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, GROUP_PARTICIPANT_HEADERS.length)
    .getValues()
    .map(function(row, index) { return participantFromRow_(row, index + 2, includeSecret); })
    .filter(function(participant) { return participant && participant.groupId === groupId; });
}

function scanLatestGroupRows_(sheet, groupId, columnCount, limit) {
  const matches = [];
  let endRow = sheet.getLastRow();
  while (endRow >= 2 && matches.length < limit) {
    const startRow = Math.max(2, endRow - 499);
    const rows = sheet.getRange(startRow, 1, endRow - startRow + 1, columnCount).getValues();
    for (let index = rows.length - 1; index >= 0 && matches.length < limit; index -= 1) {
      if (String(rows[index][0]) === groupId || (columnCount === GROUP_HISTORY_HEADERS.length && String(rows[index][1]) === groupId)) {
        matches.push(rows[index]);
      }
    }
    endRow = startRow - 1;
  }
  return matches.reverse();
}

function messagesForGroup_(sheets, groupId) {
  if (sheets.groupChat.getLastRow() < 2) return [];
  return scanLatestGroupRows_(sheets.groupChat, groupId, GROUP_CHAT_HEADERS.length, GROUP_MESSAGE_LIMIT)
    .map(function(row) {
      return {
        groupId: String(row[0]),
        seq: Number(row[1] || 0),
        id: String(row[2] || ''),
        messageId: String(row[2] || ''),
        actorId: String(row[3] || ''),
        nickname: decodedSafeCell_(row[4]),
        actorRole: String(row[5] || 'member'),
        role: String(row[5] || 'member'),
        body: decodedSafeCell_(row[6]),
        createdAt: isoValue_(row[7])
      };
    });
}

function historyForGroup_(sheets, groupId) {
  if (sheets.groupHistory.getLastRow() < 2) return [];
  const rowsForGroup = [];
  let endRow = sheets.groupHistory.getLastRow();
  while (endRow >= 2 && rowsForGroup.length < GROUP_MESSAGE_LIMIT) {
    const startRow = Math.max(2, endRow - 499);
    const rows = sheets.groupHistory
      .getRange(startRow, 1, endRow - startRow + 1, GROUP_HISTORY_HEADERS.length)
      .getValues();
    for (let index = rows.length - 1; index >= 0 && rowsForGroup.length < GROUP_MESSAGE_LIMIT; index -= 1) {
      const action = String(rows[index][6] || '');
      if (String(rows[index][1] || '') === groupId && !['send_message', 'mark_read'].includes(action)) {
        rowsForGroup.push(rows[index]);
      }
    }
    endRow = startRow - 1;
  }
  return rowsForGroup.reverse()
    .map(function(row) {
      return {
        id: String(row[0] || ''),
        historyId: String(row[0] || ''),
        entityType: String(row[2] || ''),
        entityId: String(row[3] || ''),
        fromStatus: String(row[4] || ''),
        toStatus: String(row[5] || ''),
        action: String(row[6] || ''),
        actorId: String(row[7] || ''),
        actorRole: String(row[8] || ''),
        reason: decodedSafeCell_(row[9]),
        version: Number(row[11] || 0),
        createdAt: isoValue_(row[12])
      };
    });
}

function snapshotCacheKey_(groupId) {
  return 'group_snapshot_v2_' + groupId;
}

function invalidateGroupSnapshot_(groupId) {
  try { CacheService.getScriptCache().remove(snapshotCacheKey_(groupId)); } catch (error) {}
}

function baseGroupSnapshot_(sheets, groupId) {
  const cache = CacheService.getScriptCache();
  const key = snapshotCacheKey_(groupId);
  try {
    const cached = cache.get(key);
    if (cached) return JSON.parse(cached);
  } catch (error) {}

  const group = getGroupRecord_(sheets, groupId);
  const participants = getParticipantsForGroup_(sheets, groupId, false).map(function(participant) {
    const copy = Object.assign({}, participant);
    delete copy.rowNumber;
    return copy;
  });
  const currentCount = participants.filter(function(participant) { return participant.counted; }).length;
  const orderedQuantity = participants
    .filter(function(participant) { return participant.counted; })
    .reduce(function(total, participant) { return total + Number(participant.selectedQuantity || 0); }, 0);
  const snapshot = {
    group: {
      id: group.groupId,
      groupId: group.groupId,
      dealId: group.dealId,
      title: group.title,
      groupStatus: group.groupStatus,
      status: group.groupStatus,
      targetCount: group.targetCount,
      currentCount: currentCount,
      chatLocked: group.chatLocked,
      creatorActorId: group.creatorActorId,
      hostMode: group.hostMode,
      hostActorId: group.hostActorId,
      hostMatched: Boolean(group.hostActorId),
      totalQuantity: group.totalQuantity,
      orderedQuantity: orderedQuantity,
      lastMessageSeq: group.lastMessageSeq,
      version: group.version,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      updatedBy: group.updatedBy
    },
    participants: participants,
    messages: messagesForGroup_(sheets, groupId),
    history: historyForGroup_(sheets, groupId),
    lastSeq: group.lastMessageSeq,
    limits: { maxParticipants: GROUP_MAX_PARTICIPANTS, visibleMessages: GROUP_MESSAGE_LIMIT }
  };
  try {
    const serialized = JSON.stringify(snapshot);
    if (serialized.length < 90000) cache.put(key, serialized, 5);
  } catch (error) {}
  return snapshot;
}

function buildGroupSnapshot_(sheets, groupId, actor) {
  const base = baseGroupSnapshot_(sheets, groupId);
  const viewer = base.participants.find(function(participant) { return participant.actorId === actor.actorId; });
  const lastReadSeq = viewer ? Number(viewer.lastReadSeq || 0) : 0;
  return Object.assign({}, base, {
    viewer: {
      actorId: actor.actorId,
      role: actor.role,
      lastReadSeq: lastReadSeq
    },
    unreadCount: Math.max(0, Number(base.group.lastMessageSeq || 0) - lastReadSeq)
  });
}

function findMutation_(sheets, mutationId, action) {
  const rowNumber = findExactRow_(sheets.groupHistory, 11, mutationId);
  if (!rowNumber) return null;
  const row = sheets.groupHistory.getRange(rowNumber, 1, 1, GROUP_HISTORY_HEADERS.length).getValues()[0];
  if (String(row[6] || '') !== action) throw groupOperationError_('client_mutation_conflict');
  return {
    groupId: String(row[1] || ''),
    actorId: String(row[7] || ''),
    rowNumber: rowNumber
  };
}

function appendGroupHistory_(sheets, data) {
  sheets.groupHistory.appendRow([
    Utilities.getUuid(), safeCell_(data.groupId), safeCell_(data.entityType || ''),
    safeCell_(data.entityId || ''), safeCell_(data.fromStatus || ''), safeCell_(data.toStatus || ''),
    safeCell_(data.action || ''), safeCell_(data.actorId || ''), safeCell_(data.actorRole || ''),
    safeCell_(data.reason || ''), safeCell_(data.clientMutationId || ''), Number(data.version || 0),
    data.createdAt || new Date().toISOString(), JSON.stringify(data.result || { ok: true })
  ]);
}

function appendParticipant_(sheets, data) {
  sheets.groupParticipants.appendRow([
    safeCell_(data.groupId), safeCell_(data.actorId), safeCell_(data.nickname), safeCell_(data.role),
    Boolean(data.counted), safeCell_(data.paymentStatus || 'pending'), Number(data.lastReadSeq || 0),
    safeCell_(data.capabilityHash || ''), Number(data.version || 1), data.joinedAt, data.updatedAt,
    Number(data.selectedQuantity || 0)
  ]);
}

function updateParticipantRow_(sheets, participant) {
  sheets.groupParticipants.getRange(participant.rowNumber, 1, 1, GROUP_PARTICIPANT_HEADERS.length).setValues([[
    safeCell_(participant.groupId), safeCell_(participant.actorId), safeCell_(participant.nickname), safeCell_(participant.role),
    Boolean(participant.counted), safeCell_(participant.paymentStatus), Number(participant.lastReadSeq || 0),
    safeCell_(participant.capabilityHash || ''), Number(participant.version || 1), participant.joinedAt, participant.updatedAt,
    Number(participant.selectedQuantity || 0)
  ]]);
}

function updateGroupRow_(sheets, group) {
  sheets.groups.getRange(group.rowNumber, 1, 1, GROUP_HEADERS.length).setValues([[
    safeCell_(group.groupId), safeCell_(group.dealId), safeCell_(group.title), safeCell_(group.groupStatus),
    Number(group.targetCount), Boolean(group.chatLocked), safeCell_(group.hostActorId),
    Number(group.lastMessageSeq || 0), Number(group.version || 1), group.createdAt, group.updatedAt,
    safeCell_(group.updatedBy || ''), safeCell_(group.creatorActorId || group.hostActorId || ''),
    safeCell_(group.hostMode === 'recruiting' ? 'recruiting' : 'self'), Number(group.totalQuantity || 1)
  ]]);
}

function ensureAdminParticipant_(sheets, groupId, actor, lastReadSeq, now) {
  if (actor.participant) return actor.participant;
  appendParticipant_(sheets, {
    groupId: groupId, actorId: actor.actorId, nickname: '관리자', role: 'admin', counted: false,
    paymentStatus: 'pending', lastReadSeq: lastReadSeq || 0, capabilityHash: '', version: 1,
    joinedAt: now, updatedAt: now
  });
  actor.participant = getParticipantRecord_(sheets, groupId, actor.actorId, true);
  return actor.participant;
}

function executeGroupMutation_(action, payload, sheets) {
  const mutationId = requireMutationId_(payload.clientMutationId);
  const groupId = requireGroupId_(payload.groupId, 'group_id');
  const actorId = requireGroupId_(payload.actorId, 'actor_id');
  const duplicate = findMutation_(sheets, mutationId, action);
  if (duplicate) {
    if (duplicate.groupId !== groupId || duplicate.actorId !== actorId) {
      throw groupOperationError_('client_mutation_conflict');
    }
    const duplicateActor = authorizeGroupActor_(sheets, groupId, payload);
    return { actor: duplicateActor, duplicate: true };
  }

  const now = new Date().toISOString();
  if (action === 'create') {
    if (findExactRow_(sheets.groups, 1, groupId)) throw groupOperationError_('group_exists');
    const dealId = requireGroupId_(payload.dealId, 'deal_id');
    if (dealId !== groupId) throw groupOperationError_('invalid_group_deal_binding');
    const title = groupText_(payload.title, 120);
    const nickname = groupText_(payload.nickname, 40);
    const targetCount = requireInteger_(payload.targetCount, 'target_count', 1, GROUP_MAX_PARTICIPANTS);
    const hostMode = String(payload.hostMode || 'self');
    if (hostMode !== 'self' && hostMode !== 'recruiting') {
      throw groupOperationError_('invalid_host_mode');
    }
    const totalQuantity = requireInteger_(
      payload.totalQuantity === undefined ? targetCount : payload.totalQuantity,
      'total_quantity',
      1,
      999
    );
    const selectedQuantity = requireInteger_(
      payload.selectedQuantity === undefined ? Math.min(1, totalQuantity) : payload.selectedQuantity,
      'selected_quantity',
      0,
      totalQuantity
    );
    if (!title) throw groupOperationError_('invalid_title');
    if (!nickname) throw groupOperationError_('invalid_nickname');
    const role = hostMode === 'recruiting' ? 'creator' : 'host';
    const hostActorId = role === 'host' ? actorId : '';
    const hash = requireCapabilityHash_(payload.capabilityHash);
    sheets.groups.appendRow([
      safeCell_(groupId), safeCell_(dealId), safeCell_(title), GROUP_STATUSES[0], targetCount, false,
      safeCell_(hostActorId), 0, 1, now, now, safeCell_(actorId), safeCell_(actorId),
      safeCell_(hostMode), totalQuantity
    ]);
    appendParticipant_(sheets, {
      groupId: groupId, actorId: actorId, nickname: nickname, role: role, counted: role !== 'admin',
      paymentStatus: 'pending', lastReadSeq: 0, capabilityHash: hash, version: 1,
      joinedAt: now, updatedAt: now, selectedQuantity: selectedQuantity
    });
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'group', entityId: groupId, fromStatus: '', toStatus: GROUP_STATUSES[0],
      action: action, actorId: actorId, actorRole: role, clientMutationId: mutationId, version: 1, createdAt: now
    });
    invalidateGroupSnapshot_(groupId);
    return { actor: { actorId: actorId, role: role }, duplicate: false };
  }

  if (action === 'join') {
    const group = getGroupRecord_(sheets, groupId);
    if (getParticipantRecord_(sheets, groupId, actorId, false)) throw groupOperationError_('actor_already_joined');
    const nickname = groupText_(payload.nickname, 40);
    if (!nickname) throw groupOperationError_('invalid_nickname');
    const role = payload.requestedRole === 'admin' ? 'admin' : 'member';
    if (role === 'admin' && payload.adminAssertion !== true) throw groupOperationError_('forbidden');
    if (role !== 'admin' && group.groupStatus !== GROUP_STATUSES[0]) {
      throw groupOperationError_('group_not_recruiting');
    }
    const participants = getParticipantsForGroup_(sheets, groupId, false);
    const counted = role !== 'admin';
    const selectedQuantity = counted
      ? requireInteger_(payload.selectedQuantity === undefined ? 1 : payload.selectedQuantity, 'selected_quantity', 0, 999)
      : 0;
    const currentCount = participants.filter(function(item) { return item.counted; }).length;
    if (counted && (currentCount >= GROUP_MAX_PARTICIPANTS || currentCount >= group.targetCount)) {
      throw groupOperationError_('group_full');
    }
    const orderedQuantity = participants
      .filter(function(item) { return item.counted; })
      .reduce(function(total, item) { return total + Number(item.selectedQuantity || 0); }, 0);
    if (orderedQuantity + selectedQuantity > group.totalQuantity) {
      throw groupOperationError_('quantity_exceeds_total');
    }
    const hash = requireCapabilityHash_(payload.capabilityHash);
    appendParticipant_(sheets, {
      groupId: groupId, actorId: actorId, nickname: nickname, role: role, counted: counted,
      paymentStatus: 'pending', lastReadSeq: group.lastMessageSeq, capabilityHash: hash, version: 1,
      joinedAt: now, updatedAt: now, selectedQuantity: selectedQuantity
    });
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'participant', entityId: actorId, fromStatus: '', toStatus: 'joined',
      action: action, actorId: actorId, actorRole: role, clientMutationId: mutationId, version: 1, createdAt: now
    });
    invalidateGroupSnapshot_(groupId);
    return { actor: { actorId: actorId, role: role }, duplicate: false };
  }

  const actor = authorizeGroupActor_(sheets, groupId, payload);
  const group = getGroupRecord_(sheets, groupId);

  if (action === 'claim_host') {
    const participant = actor.participant;
    if (!participant || !participant.counted || !['creator', 'member', 'host'].includes(participant.role)) {
      throw groupOperationError_('forbidden');
    }
    if (group.hostActorId) {
      if (group.hostActorId !== actorId || participant.role !== 'host') {
        throw groupOperationError_('host_already_claimed');
      }
      appendGroupHistory_(sheets, {
        groupId: groupId, entityType: 'host', entityId: actorId,
        fromStatus: 'claimed', toStatus: 'claimed', action: action,
        actorId: actorId, actorRole: 'host', clientMutationId: mutationId,
        version: group.version, createdAt: now, result: { unchanged: true }
      });
      invalidateGroupSnapshot_(groupId);
      return { actor: actor, duplicate: false, unchanged: true };
    }
    if (group.hostMode !== 'recruiting' || group.groupStatus !== GROUP_STATUSES[0]) {
      throw groupOperationError_('host_claim_closed');
    }
    const previousRole = participant.role;
    participant.role = 'host';
    participant.version += 1;
    participant.updatedAt = now;
    updateParticipantRow_(sheets, participant);
    group.hostActorId = actorId;
    group.version += 1;
    group.updatedAt = now;
    group.updatedBy = actorId;
    updateGroupRow_(sheets, group);
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'host', entityId: actorId,
      fromStatus: previousRole, toStatus: 'host', action: action,
      actorId: actorId, actorRole: previousRole, clientMutationId: mutationId,
      version: group.version, createdAt: now
    });
    actor.role = 'host';
    actor.participant = participant;
  } else if (action === 'reserve_quantity') {
    const participant = actor.participant;
    if (!participant || !participant.counted || !['creator', 'host', 'member'].includes(participant.role)) {
      throw groupOperationError_('forbidden');
    }
    if (group.groupStatus !== GROUP_STATUSES[0]) {
      throw groupOperationError_('quantity_reservation_closed');
    }
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== participant.version) throw groupOperationError_('state_conflict');
    const quantity = requireInteger_(payload.quantity, 'quantity', 1, 999);
    const participants = getParticipantsForGroup_(sheets, groupId, false);
    const orderedQuantity = participants
      .filter(function(item) { return item.counted; })
      .reduce(function(total, item) { return total + Number(item.selectedQuantity || 0); }, 0);
    if (orderedQuantity + quantity > group.totalQuantity) {
      throw groupOperationError_('quantity_exceeds_total');
    }
    const previousQuantity = participant.selectedQuantity;
    participant.selectedQuantity += quantity;
    participant.version += 1;
    participant.updatedAt = now;
    updateParticipantRow_(sheets, participant);
    group.updatedAt = now;
    group.updatedBy = actorId;
    updateGroupRow_(sheets, group);
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'quantity', entityId: actorId,
      fromStatus: String(previousQuantity), toStatus: String(participant.selectedQuantity),
      action: action, actorId: actorId, actorRole: actor.role,
      clientMutationId: mutationId, version: participant.version, createdAt: now
    });
    actor.participant = participant;
  } else if (action === 'send_message') {
    const body = groupText_(payload.body, 500);
    if (!body) throw groupOperationError_('invalid_message_body');
    if (group.chatLocked && !['host', 'admin'].includes(actor.role)) throw groupOperationError_('chat_locked');
    const nextSeq = group.lastMessageSeq + 1;
    const messageId = Utilities.getUuid();
    const participant = actor.participant || ensureAdminParticipant_(sheets, groupId, actor, nextSeq, now);
    sheets.groupChat.appendRow([
      safeCell_(groupId), nextSeq, safeCell_(messageId), safeCell_(actorId), safeCell_(participant.nickname),
      safeCell_(actor.role), safeCell_(body), now, safeCell_(mutationId)
    ]);
    group.lastMessageSeq = nextSeq;
    group.updatedAt = now;
    group.updatedBy = actorId;
    updateGroupRow_(sheets, group);
    participant.lastReadSeq = nextSeq;
    participant.updatedAt = now;
    updateParticipantRow_(sheets, participant);
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'message', entityId: messageId, action: action,
      actorId: actorId, actorRole: actor.role, clientMutationId: mutationId,
      version: nextSeq, createdAt: now, result: { messageId: messageId, seq: nextSeq }
    });
  } else if (action === 'mark_read') {
    const participant = actor.participant || ensureAdminParticipant_(sheets, groupId, actor, 0, now);
    const requestedSeq = requireInteger_(payload.lastReadSeq, 'last_read_seq', 0, Number.MAX_SAFE_INTEGER);
    const previousReadSeq = participant.lastReadSeq;
    const nextReadSeq = Math.min(group.lastMessageSeq, Math.max(participant.lastReadSeq, requestedSeq));
    if (nextReadSeq === previousReadSeq) {
      return { actor: actor, duplicate: false, unchanged: true };
    }
    participant.lastReadSeq = nextReadSeq;
    participant.updatedAt = now;
    updateParticipantRow_(sheets, participant);
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'read', entityId: actorId,
      fromStatus: String(previousReadSeq), toStatus: String(nextReadSeq),
      action: action, actorId: actorId, actorRole: actor.role, clientMutationId: mutationId,
      version: participant.version, createdAt: now
    });
  } else if (action === 'transition_group') {
    requireManager_(actor);
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== group.version) throw groupOperationError_('state_conflict');
    const currentIndex = GROUP_STATUSES.indexOf(group.groupStatus);
    const offset = payload.direction === 'next' ? 1 : payload.direction === 'previous' ? -1 : 0;
    const nextIndex = currentIndex + offset;
    if (!offset || currentIndex < 0 || nextIndex < 0 || nextIndex >= GROUP_STATUSES.length) {
      throw groupOperationError_('invalid_state_transition');
    }
    const previous = group.groupStatus;
    group.groupStatus = GROUP_STATUSES[nextIndex];
    group.version += 1;
    group.updatedAt = now;
    group.updatedBy = actorId;
    updateGroupRow_(sheets, group);
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'group', entityId: groupId, fromStatus: previous,
      toStatus: group.groupStatus, action: action, actorId: actorId, actorRole: actor.role,
      clientMutationId: mutationId, version: group.version, createdAt: now
    });
  } else if (action === 'transition_payment') {
    const participantActorId = requireGroupId_(payload.participantActorId, 'participant_actor_id');
    const participant = getParticipantRecord_(sheets, groupId, participantActorId, true);
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== participant.version) throw groupOperationError_('state_conflict');
    const direction = payload.direction;
    let nextStatus = '';
    if (actorId === participantActorId && participant.paymentStatus === 'pending' && direction === 'next') {
      nextStatus = 'requested';
    } else if (actorId === participantActorId && participant.paymentStatus === 'requested' && direction === 'previous') {
      nextStatus = 'pending';
    } else if (['host', 'admin'].includes(actor.role) && participant.paymentStatus === 'requested' && direction === 'next') {
      nextStatus = 'confirmed';
    } else if (['host', 'admin'].includes(actor.role) && participant.paymentStatus === 'confirmed' && direction === 'previous') {
      nextStatus = 'requested';
    } else {
      throw groupOperationError_(actorId === participantActorId ? 'invalid_state_transition' : 'forbidden');
    }
    const previous = participant.paymentStatus;
    participant.paymentStatus = nextStatus;
    participant.version += 1;
    participant.updatedAt = now;
    updateParticipantRow_(sheets, participant);
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'payment', entityId: participantActorId,
      fromStatus: previous, toStatus: nextStatus, action: action, actorId: actorId,
      actorRole: actor.role, reason: groupText_(payload.reason, 200), clientMutationId: mutationId,
      version: participant.version, createdAt: now
    });
  } else if (action === 'update_target') {
    requireTargetManager_(actor);
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== group.version) throw groupOperationError_('state_conflict');
    if (GROUP_STATUSES.indexOf(group.groupStatus) >= GROUP_STATUSES.indexOf('purchased')) {
      throw groupOperationError_('target_locked');
    }
    const targetCount = requireInteger_(payload.targetCount, 'target_count', 1, GROUP_MAX_PARTICIPANTS);
    const currentCount = getParticipantsForGroup_(sheets, groupId, false)
      .filter(function(participant) { return participant.counted; }).length;
    if (targetCount < currentCount) throw groupOperationError_('invalid_target');
    const previous = group.targetCount;
    if (targetCount !== previous) {
      group.targetCount = targetCount;
      group.version += 1;
      group.updatedAt = now;
      group.updatedBy = actorId;
      updateGroupRow_(sheets, group);
    }
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'target', entityId: groupId,
      fromStatus: String(previous), toStatus: String(targetCount), action: action,
      actorId: actorId, actorRole: actor.role, clientMutationId: mutationId,
      version: group.version, createdAt: now
    });
  } else if (action === 'toggle_lock') {
    requireManager_(actor);
    const expectedVersion = requireInteger_(payload.expectedVersion, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== group.version) throw groupOperationError_('state_conflict');
    if (typeof payload.locked !== 'boolean') throw groupOperationError_('invalid_locked');
    const previous = group.chatLocked;
    if (payload.locked !== previous) {
      group.chatLocked = payload.locked;
      group.version += 1;
      group.updatedAt = now;
      group.updatedBy = actorId;
      updateGroupRow_(sheets, group);
    }
    appendGroupHistory_(sheets, {
      groupId: groupId, entityType: 'chat_lock', entityId: groupId,
      fromStatus: String(previous), toStatus: String(payload.locked), action: action,
      actorId: actorId, actorRole: actor.role, clientMutationId: mutationId,
      version: group.version, createdAt: now
    });
  } else {
    throw groupOperationError_('invalid_action');
  }

  invalidateGroupSnapshot_(groupId);
  return { actor: actor, duplicate: false };
}

function handleGroupOperation_(action, payload) {
  const supported = [
    'create', 'join', 'snapshot', 'send_message', 'mark_read',
    'transition_group', 'transition_payment', 'update_target', 'toggle_lock',
    'claim_host', 'reserve_quantity'
  ];
  if (!supported.includes(action)) return json_({ ok: false, error: 'invalid_action' });
  let lock = null;
  try {
    const groupId = requireGroupId_(payload.groupId, 'group_id');
    const sheets = ensureSheets_();
    if (action === 'snapshot') {
      const actor = authorizeGroupActor_(sheets, groupId, payload);
      return json_({ ok: true, snapshot: buildGroupSnapshot_(sheets, groupId, actor) });
    }
    lock = LockService.getScriptLock();
    lock.waitLock(10000);
    const result = executeGroupMutation_(action, payload, sheets);
    const snapshot = buildGroupSnapshot_(sheets, groupId, result.actor);
    return json_({
      ok: true,
      duplicate: Boolean(result.duplicate),
      unchanged: Boolean(result.unchanged),
      snapshot: snapshot
    });
  } catch (error) {
    const code = error.code || 'group_operation_failed';
    const result = { ok: false, error: code };
    if (code === 'state_conflict') {
      try {
        const sheets = ensureSheets_();
        const groupId = requireGroupId_(payload.groupId, 'group_id');
        const actor = authorizeGroupActor_(sheets, groupId, payload);
        result.snapshot = buildGroupSnapshot_(sheets, groupId, actor);
      } catch (ignored) {}
    }
    return json_(result);
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (error) {}
    }
  }
}

function getCustomerOrdersByGroup_(payload) {
  try {
    const groupId = requireGroupId_(payload.groupId, 'group_id');
    const sheets = ensureSheets_();
    const actor = authorizeGroupActor_(sheets, groupId, payload);
    requireManager_(actor);
    const group = getGroupRecord_(sheets, groupId);
    const dealId = payload.dealId ? requireGroupId_(payload.dealId, 'deal_id') : group.dealId;
    if (dealId !== group.dealId) throw groupOperationError_('forbidden');
    const current = [];
    if (sheets.customerOrders.getLastRow() >= 2) {
      sheets.customerOrders.getRange(2, 4, sheets.customerOrders.getLastRow() - 1, 1)
        .getValues()
        .forEach(function(row) {
          try {
            const order = JSON.parse(row[0] || '{}');
            if (
              String(order.groupId || '') === groupId
              && String(order.dealId || (order.deal && order.deal.id) || '') === group.dealId
            ) current.push(order);
          } catch (error) {}
        });
    }
    const historic = historicCustomerOrders_(sheets.events, '', dealId)
      .filter(function(order) { return String(order.groupId || '') === groupId; });
    const orders = mergeCustomerOrderSnapshots_(current.concat(historic)).map(publicOrderValue_);
    return json_({ ok: true, orders: orders });
  } catch (error) {
    return json_({ ok: false, error: error.code || 'customer_orders_group_failed' });
  }
}

function preferValue_(preferred, fallback) {
  return preferred && preferred !== '미설정' ? preferred : fallback;
}

function backfillVisitorProfile_(events, visitorId, properties) {
  if (!visitorId || events.getLastRow() < 2) return;
  const rowCount = events.getLastRow() - 1;
  const range = events.getRange(2, 1, rowCount, EVENT_HEADERS.length);
  const values = range.getValues();
  let changed = false;

  values.forEach(function(row) {
    if (String(row[4]) !== String(visitorId)) return;
    if (!row[2] || row[2] === '미설정') row[2] = properties.tester_name || '미설정';
    if (!row[3] || row[3] === '미설정') row[3] = properties.tester_type || '미설정';
    if (!row[7] || row[7] === '미설정') row[7] = properties.region || '미설정';
    if (!row[8] || row[8] === '미설정') row[8] = properties.district || '미설정';
    if (!row[9] || row[9] === '미설정') row[9] = properties.neighborhood || '미설정';
    if (!row[12]) row[12] = properties.customer_number || '';
    if (!row[13]) row[13] = properties.customer_phone || '';
    changed = true;
  });

  if (changed) range.setValues(values);
}

function repairExistingUnsetRows() {
  const events = ensureSheets_().events;
  if (events.getLastRow() < 2) return;
  const rowCount = events.getLastRow() - 1;
  const range = events.getRange(2, 1, rowCount, EVENT_HEADERS.length);
  const values = range.getValues();
  const profiles = Object.create(null);

  values.forEach(function(row) {
    if (row[6] !== 'profile_submitted' || !row[4]) return;
    let details = {};
    try { details = JSON.parse(row[11] || '{}'); } catch (error) {}
    profiles[String(row[4])] = {
      tester_name: row[2], tester_type: row[3], region: row[7], district: row[8], neighborhood: row[9],
      customer_number: row[12] || details.customer_number || '',
      customer_phone: row[13] || details.customer_phone || ''
    };
  });

  values.forEach(function(row) {
    const profile = profiles[String(row[4])];
    if (!profile) return;
    if (!row[2] || row[2] === '미설정') row[2] = profile.tester_name;
    if (!row[3] || row[3] === '미설정') row[3] = profile.tester_type;
    if (!row[7] || row[7] === '미설정') row[7] = profile.region;
    if (!row[8] || row[8] === '미설정') row[8] = profile.district;
    if (!row[9] || row[9] === '미설정') row[9] = profile.neighborhood;
    if (!row[12]) row[12] = profile.customer_number;
    if (!row[13]) row[13] = profile.customer_phone;
  });
  range.setValues(values);
}

function ensureSheets_() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  let events = spreadsheet.getSheetByName('전체 이벤트');
  if (!events) events = spreadsheet.insertSheet('전체 이벤트');
  if (events.getLastRow() === 0) {
    events.getRange(1, 1, 1, EVENT_HEADERS.length).setValues([EVENT_HEADERS]);
    events.setFrozenRows(1);
  } else if (events.getLastColumn() < EVENT_HEADERS.length) {
    events.getRange(1, 1, 1, EVENT_HEADERS.length).setValues([EVENT_HEADERS]);
  }
  let summary = spreadsheet.getSheetByName('통합 현황');
  if (!summary) summary = spreadsheet.insertSheet('통합 현황');
  let surveys = spreadsheet.getSheetByName('설문 응답');
  if (!surveys) surveys = spreadsheet.insertSheet('설문 응답');
  if (surveys.getLastRow() === 0) {
    surveys.getRange(1, 1, 1, SURVEY_HEADERS.length).setValues([SURVEY_HEADERS]);
    surveys.setFrozenRows(1);
  } else if (surveys.getLastColumn() < SURVEY_HEADERS.length) {
    surveys.getRange(1, 1, 1, SURVEY_HEADERS.length).setValues([SURVEY_HEADERS]);
  }
  let publicDeals = spreadsheet.getSheetByName('공개 상품');
  if (!publicDeals) publicDeals = spreadsheet.insertSheet('공개 상품');
  if (publicDeals.getLastRow() === 0) {
    publicDeals.getRange(1, 1, 1, PUBLIC_DEAL_HEADERS.length).setValues([PUBLIC_DEAL_HEADERS]);
    publicDeals.setFrozenRows(1);
  }
  let customerOrders = spreadsheet.getSheetByName('주문 내역');
  if (!customerOrders) customerOrders = spreadsheet.insertSheet('주문 내역');
  if (customerOrders.getLastRow() === 0) {
    customerOrders.getRange(1, 1, 1, CUSTOMER_ORDER_HEADERS.length).setValues([CUSTOMER_ORDER_HEADERS]);
    customerOrders.setFrozenRows(1);
  }
  let groups = spreadsheet.getSheetByName('그룹');
  if (!groups) groups = spreadsheet.insertSheet('그룹');
  ensureHeader_(groups, GROUP_HEADERS);
  let groupParticipants = spreadsheet.getSheetByName('그룹 참여자');
  if (!groupParticipants) groupParticipants = spreadsheet.insertSheet('그룹 참여자');
  ensureHeader_(groupParticipants, GROUP_PARTICIPANT_HEADERS);
  let groupChat = spreadsheet.getSheetByName('그룹 채팅');
  if (!groupChat) groupChat = spreadsheet.insertSheet('그룹 채팅');
  ensureHeader_(groupChat, GROUP_CHAT_HEADERS);
  let groupHistory = spreadsheet.getSheetByName('상태 이력');
  if (!groupHistory) groupHistory = spreadsheet.insertSheet('상태 이력');
  ensureHeader_(groupHistory, GROUP_HISTORY_HEADERS);
  return {
    events, summary, surveys, publicDeals, customerOrders,
    groups, groupParticipants, groupChat, groupHistory
  };
}

function ensureHeader_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function setup() {
  const sheets = ensureSheets_();
  clearLegacyValidations_(sheets.events);
  backfillEventIds_(sheets.events);
  repairExistingUnsetRows();
  backfillSurveyResponses_(sheets.events, sheets.surveys);
  formatEventSheet_(sheets.events);
  formatSurveySheet_(sheets.surveys);
}

function backfillEventIds_(events) {
  if (events.getLastRow() < 2) return;
  const rowCount = events.getLastRow() - 1;
  const details = events.getRange(2, 12, rowCount, 1).getValues();
  const ids = events.getRange(2, EVENT_HEADERS.length, rowCount, 1).getValues();
  let changed = false;
  details.forEach(function(row, index) {
    if (ids[index][0]) return;
    try {
      const properties = JSON.parse(row[0] || '{}');
      if (properties.event_id) {
        ids[index][0] = String(properties.event_id);
        changed = true;
      }
    } catch (error) {}
  });
  if (changed) events.getRange(2, EVENT_HEADERS.length, rowCount, 1).setValues(ids);
}

function clearLegacyValidations_(events) {
  if (events.getMaxRows() < 2) return;
  for (let column = 1; column <= EVENT_HEADERS.length; column += 1) {
    events.getRange(2, column, events.getMaxRows() - 1, 1).clearDataValidations();
  }
}

function backfillSurveyResponses_(events, surveys) {
  if (events.getLastRow() < 2) return;
  const existingIds = Object.create(null);
  if (surveys.getLastRow() >= 2) {
    surveys.getRange(2, SURVEY_HEADERS.length, surveys.getLastRow() - 1, 1)
      .getValues().forEach(function(row, index) { if (row[0]) existingIds[String(row[0])] = index + 2; });
  }
  const rows = events.getRange(2, 1, events.getLastRow() - 1, EVENT_HEADERS.length).getValues();
  rows.forEach(function(row) {
    if (row[6] !== 'survey_submitted') return;
    let properties = {};
    try { properties = JSON.parse(row[11] || '{}'); } catch (error) {}
    const eventId = properties.event_id || '';
    const syntheticEvent = {
      id: eventId || ('legacy-' + row[4] + '-' + new Date(row[1]).getTime()),
      timestamp: row[1],
      visitorId: row[4]
    };
    properties.tester_name = preferValue_(properties.tester_name, row[2]);
    properties.tester_type = preferValue_(properties.tester_type, row[3]);
    properties.region = preferValue_(properties.region, row[7]);
    properties.district = preferValue_(properties.district, row[8]);
    properties.neighborhood = preferValue_(properties.neighborhood, row[9]);
    properties.customer_number = preferValue_(properties.customer_number, row[12]);
    properties.customer_phone = preferValue_(properties.customer_phone, row[13]);
    const values = surveyRowValues_(syntheticEvent, properties);
    const existingRow = existingIds[syntheticEvent.id];
    if (existingRow) {
      values[0] = surveys.getRange(existingRow, 1).getValue() || new Date();
      surveys.getRange(existingRow, 1, 1, SURVEY_HEADERS.length).setValues([values]);
    } else {
      surveys.appendRow(values);
      existingIds[syntheticEvent.id] = surveys.getLastRow();
    }
  });
}

function formatSurveySheet_(surveys) {
  surveys.getRange(1, 1, 1, SURVEY_HEADERS.length)
    .setFontWeight('bold').setBackground('#1f6f5c').setFontColor('#ffffff');
  for (let column = 1; column <= SURVEY_HEADERS.length; column += 1) {
    surveys.autoResizeColumn(column);
  }
  surveys.setColumnWidth(15, 260);
  if (surveys.getMaxRows() > 1) {
    surveys.getRange(2, 3, surveys.getMaxRows() - 1, 1).setNumberFormat('@');
    surveys.getRange(2, 5, surveys.getMaxRows() - 1, 1).setNumberFormat('@');
  }
}

function formatEventSheet_(events) {
  if (events.getMaxRows() > 1) {
    events.getRange(2, 13, events.getMaxRows() - 1, 1).setNumberFormat('@');
    events.getRange(2, 14, events.getMaxRows() - 1, 1).setNumberFormat('@');
    events.getRange(2, EVENT_HEADERS.length, events.getMaxRows() - 1, 1).setNumberFormat('@');
  }
}

function getCentralStats_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('central_stats_v2');
  if (cached) {
    try { return JSON.parse(cached); } catch (error) {}
  }
  const stats = buildCentralStats_();
  try { cache.put('central_stats_v2', JSON.stringify(stats), 4); } catch (error) {}
  return stats;
}

function buildCentralStats_() {
  const events = ensureSheets_().events;
  if (events.getLastRow() < 2) {
    return { generatedAt: new Date().toISOString(), totalEvents: 0, visitors: 0, eventCounts: {}, uniqueByEvent: {}, eventBreakdown: [], neighborhoodBreakdown: [], funnel: [] };
  }
  const rows = events.getRange(2, 1, events.getLastRow() - 1, EVENT_HEADERS.length).getValues();
  const visitors = Object.create(null);
  const eventGroups = Object.create(null);
  const locations = Object.create(null);
  const screenVisitors = Object.create(null);
  const seenEventIds = Object.create(null);
  let totalEvents = 0;

  rows.forEach(function(row) {
    let properties = {};
    try { properties = JSON.parse(row[11] || '{}'); } catch (error) {}
    const eventId = String(row[14] || properties.event_id || '');
    if (eventId && seenEventIds[eventId]) return;
    if (eventId) seenEventIds[eventId] = true;
    const screen = String(row[10] || properties.screen || '');
    if (screen === 'analytics_dashboard' || properties.app === 'dashboard' || properties.is_internal === true) return;
    const visitorId = String(row[4] || 'unknown');
    const name = String(row[6] || 'unknown');
    totalEvents += 1;
    visitors[visitorId] = true;
    if (!eventGroups[name]) eventGroups[name] = { count: 0, visitors: Object.create(null) };
    eventGroups[name].count += 1;
    eventGroups[name].visitors[visitorId] = true;
    const location = [row[7], row[8], row[9]].filter(String).join(' · ') || '미설정';
    if (!locations[location]) locations[location] = { count: 0, visitors: Object.create(null) };
    locations[location].count += 1;
    locations[location].visitors[visitorId] = true;
    if (name === 'screen_view') {
      if (!screenVisitors[screen]) screenVisitors[screen] = Object.create(null);
      screenVisitors[screen][visitorId] = true;
    }
  });

  const eventCounts = Object.create(null);
  const uniqueByEvent = Object.create(null);
  const eventBreakdown = Object.keys(eventGroups).map(function(name) {
    eventCounts[name] = eventGroups[name].count;
    uniqueByEvent[name] = Object.keys(eventGroups[name].visitors).length;
    return { name: name, count: eventGroups[name].count, visitors: uniqueByEvent[name] };
  }).sort(function(a, b) { return b.count - a.count; });

  const neighborhoodBreakdown = Object.keys(locations).map(function(location) {
    return { location: location, count: locations[location].count, visitors: Object.keys(locations[location].visitors).length };
  }).sort(function(a, b) { return b.count - a.count; });

  const listVisitors = Object.keys(screenVisitors.deal_list || {}).length;
  const funnelSeed = Math.max(1, listVisitors);
  const funnel = [
    { label: '리스트 방문', count: listVisitors },
    { label: '상세 진입', count: uniqueByEvent.open_listing || 0 },
    { label: '참여 시작', count: uniqueByEvent.join_started || 0 },
    { label: '참여 완료', count: uniqueByEvent.purchase_completed || 0 },
    { label: '설문 제출', count: uniqueByEvent.survey_submitted || 0 }
  ].map(function(stage) {
    stage.rate = Math.min(100, Math.round(stage.count / funnelSeed * 100));
    return stage;
  });

  return {
    generatedAt: new Date().toISOString(), totalEvents: totalEvents,
    visitors: Object.keys(visitors).length, eventCounts: eventCounts,
    uniqueByEvent: uniqueByEvent, eventBreakdown: eventBreakdown,
    neighborhoodBreakdown: neighborhoodBreakdown, funnel: funnel
  };
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
