import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import handler from '../api/public-deals.js';
import { PRODUCT_IMAGE_DATA_URL_LIMIT, prepareImageForSync, encodeCanvasJpegWithinLimit } from '../src/imageCrop.js';
import { productImageStore, imageResponse, imageDeal } from './helpers/product-image-store.js';

const bytes = Buffer.concat([Buffer.from([255,216,255,224]), Buffer.alloc(600000, 81), Buffer.from([255,217])]);
const image = `data:image/jpeg;base64,${bytes.toString('base64')}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');

test('large prepared JPEGs are not re-encoded and defaults never fall below 90% quality', async () => {
  assert.ok(image.length < PRODUCT_IMAGE_DATA_URL_LIMIT);
  assert.equal(await prepareImageForSync(image), image);
  const qualities = [];
  assert.equal(encodeCanvasJpegWithinLimit({ toDataURL(_type, quality) { qualities.push(quality); return 'x'.repeat(PRODUCT_IMAGE_DATA_URL_LIMIT + 1); } }), '');
  assert.deepEqual(qualities, [0.92, 0.9]);
});

test('publication stores high-quality JPEG separately, replays safely, and checks ownership before writing images', () => {
  const { context, sheets, publicDeals } = productImageStore();
  assert.equal(context.storePublicImage_('data:image/jpeg;base64,/9j/2Q=='), 'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(sheets.size, 0);
  const deal = imageDeal(image);
  const result = context.publishPublicDeal_(deal, 'a'.repeat(64));
  assert.equal(result.ok, true);
  assert.equal(result.deal.image, `/api/public-deals?image=${digest(image)}`);
  assert.ok(publicDeals.rows[1][6].length < 45000);
  assert.equal(context.readPublicImage_(digest(image)), image);
  const sheet = sheets.get('상품 이미지');
  assert.equal(sheet.rows.length, 2);
  assert.ok(sheet.rows[1].slice(4).every((cell) => cell.startsWith('~') && cell.length <= 40001));
  assert.equal(context.publishPublicDeal_(deal, 'a'.repeat(64)).deal.image, result.deal.image);
  assert.equal(sheet.rows.length, 2);
  assert.equal(context.publishPublicDeal_({ ...deal, image: `${image.slice(0, -4)}AAAA`, expectedPublishVersion: 1, publishMutationId: 'publish-image-other-001' }, 'b'.repeat(64)).error, 'forbidden');
  assert.equal(sheet.rows.length, 2);
  assert.equal(context.publishPublicDeal_({ ...deal, expectedPublishVersion: 1, publishMutationId: 'publish-image-edit-002', image: result.deal.image, title: 'edited' }, 'a'.repeat(64)).ok, true);
  sheet.rows[1][5] = '~corrupt';
  assert.throws(() => context.readPublicImage_(digest(image)), (error) => error.code === 'image_integrity_failed');
});

test('API publish → spreadsheet → GET returns identical JPEG bytes; malformed/missing images are not cached', async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  const { context } = productImageStore();
  delete process.env.O2O_DATA_API_ORIGIN;
  process.env.GOOGLE_SHEETS_COLLECTOR_URL = 'https://collector.test';
  process.env.GOOGLE_SHEETS_COLLECTOR_TOKEN = 'test-token';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    let result;
    try {
      result = body.action === 'public_image'
        ? { ok: true, image: context.readPublicImage_(body.imageId) }
        : context.publishPublicDeal_(body.deal, body.ownerCapabilityHash);
    } catch (error) { result = { ok: false, error: error.code }; }
    return { ok: true, status: 200, json: async () => result };
  };
  try {
    const publish = imageResponse();
    await handler({ method: 'POST', headers: { origin: 'http://localhost:4187' }, body: { action: 'publish', capabilityToken: 'a'.repeat(64), deal: imageDeal(image) } }, publish);
    assert.equal(publish.statusCode, 202);
    const get = imageResponse();
    await handler({ method: 'GET', headers: {}, url: publish.body.deal.image }, get);
    assert.equal(get.statusCode, 200);
    assert.deepEqual(get.body, bytes);
    assert.equal(get.headers['Content-Type'], 'image/jpeg');
    assert.match(get.headers['Cache-Control'], /immutable/);
    for (const [query, status] of [['invalid', 400], ['f'.repeat(64), 404]]) {
      const failed = imageResponse();
      await handler({ method: 'GET', headers: {}, url: `/api/public-deals?image=${query}` }, failed);
      assert.equal(failed.statusCode, status);
      assert.equal(failed.headers['Cache-Control'], 'no-store');
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of ['O2O_DATA_API_ORIGIN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN']) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});
