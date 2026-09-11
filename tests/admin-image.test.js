import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdminDealImage } from '../api/admin-ops.js';

const storedReference = `/api/public-deals?image=${'a'.repeat(64)}`;
const inlineJpeg = 'data:image/jpeg;base64,/9j/2Q==';

test('admin historical/deleted records retain valid legacy image links and degrade broken sources only', () => {
  for (const image of [storedReference, inlineJpeg, 'https://cdn.example.test/legacy-product.jpg']) {
    const deal = normalizeAdminDealImage({
      id: 'owner-legacy-image', title: '과거 상품', visibility: 'deleted', image,
    });
    assert.equal(deal.image, image);
    assert.equal(deal.id, 'owner-legacy-image');
    assert.equal(deal.visibility, 'deleted');
  }
  for (const image of ['', 'http://cdn.example.test/mixed-content.jpg', 'javascript:alert(1)',
    '/api/public-deals?image=broken', 'data:image/png;base64,AAAA']) {
    const deal = normalizeAdminDealImage({
      id: 'owner-legacy-image', title: '과거 상품', visibility: 'deleted', image,
    });
    assert.equal(deal.image, '', `broken legacy source must degrade: ${image}`);
    assert.equal(deal.title, '과거 상품', 'an image failure must not remove its product record');
  }
});
