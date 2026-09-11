import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import handler from '../../api/public-deals.js';
import { productImageStore, imageResponse } from '../helpers/product-image-store.js';

test('photo keeps its resolution and exact JPEG bytes through publication and reload', async ({ page }, testInfo) => {
  const { context } = productImageStore();
  const originalFetch = globalThis.fetch;
  const previous = { ...process.env };
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
  await page.route('**/api/**', async (route) => {
    if (!route.request().url().includes('/api/public-deals')) return route.fulfill({ json: { ok: true } });
    if (route.request().postDataJSON()?.action === 'list') return route.fulfill({ json: { ok: true, deals: [] } });
    const response = imageResponse();
    await handler({ method: route.request().method(), headers: route.request().headers(), url: route.request().url(), body: route.request().postDataJSON() }, response);
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: Buffer.isBuffer(response.body) ? response.body : JSON.stringify(response.body) });
  });
  try {
    await page.goto('/');
    const source = process.env.O2O_IMAGE_FIXTURE
      ? `data:image/png;base64,${readFileSync(process.env.O2O_IMAGE_FIXTURE).toString('base64')}` : '';
    const evidence = await page.evaluate(async (sourceValue) => {
      const { cropImageDataUrl, prepareImageForSync, encodeCanvasJpegWithinLimit, squareCropRect } = await import('/src/imageCrop.js');
      const decode = async (src) => { const image = new Image(); image.src = src; await image.decode(); return image; };
      let source = sourceValue;
      if (!source) {
        const fixture = document.createElement('canvas');
        fixture.width = fixture.height = 1200;
        const ctx = fixture.getContext('2d');
        for (let y = 0; y < 1200; y += 24) for (let x = 0; x < 1200; x += 24) {
          ctx.fillStyle = `rgb(${(x * 17 + y * 13) % 256},${(x * 3 + y * 7) % 256},${(x * 11 + y * 19) % 256})`;
          ctx.fillRect(x, y, 24, 24);
        }
        source = fixture.toDataURL('image/png');
      }
      const original = await decode(source);
      const rect = squareCropRect(original.naturalWidth, original.naturalHeight);
      const canvas = document.createElement('canvas');
      let size = Math.min(900, Math.round(rect.width));
      let legacy = '';
      for (let attempt = 0; attempt < 10; attempt += 1) {
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(original, rect.x, rect.y, rect.width, rect.height, 0, 0, size, size);
        legacy = encodeCanvasJpegWithinLimit(canvas, { quality: 0.82, minQuality: 0.46, maxDataUrlLength: 32000 });
        if (legacy) break;
        size = Math.round(size * 0.86);
      }
      const prepared = await cropImageDataUrl(source);
      const publishedImage = await prepareImageForSync(prepared);
      const publish = await fetch('/api/public-deals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'publish', capabilityToken: 'a'.repeat(64), deal: { id: 'owner-photo-browser-regression', source: 'merchant', saleType: 'instant', originalPrice: 10000, discountRate: 0, title: 'quality regression', image: publishedImage } }) });
      const result = await publish.json();
      if (!result.ok) throw new Error(JSON.stringify(result));
      const reloaded = await fetch(result.deal.image);
      const stored = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reloaded.blob().then(blob => reader.readAsDataURL(blob)); });
      const image = await decode(result.deal.image);
      document.body.innerHTML = '<main style="font-family:sans-serif;padding:12px"><h2>같은 사진 · 같은 표시 크기</h2><p>수정 전 / 수정 후 저장·재조회</p><div style="display:flex;gap:12px"></div></main>';
      for (const [label, src] of [[legacy ? `이전 ${size}px` : '이전 저장 실패 (용량 제한)', legacy], [`수정 ${image.naturalWidth}px`, result.deal.image]]) {
        const figure = document.createElement('figure'); figure.style.cssText = 'margin:0;width:48%';
        const caption = document.createElement('figcaption'); caption.textContent = label;
        figure.append(caption);
        if (src) { const preview = await decode(src); preview.style.cssText = 'width:100%;height:auto'; figure.append(preview); }
        document.querySelector('main div').append(figure);
      }
      return { sourceWidth: original.naturalWidth, sourceHeight: original.naturalHeight, legacyWidth: legacy ? size : 0, legacyRejected: !legacy, legacyDataUrlLength: legacy.length, newWidth: image.naturalWidth, newHeight: image.naturalHeight, newDataUrlLength: prepared.length, syncUnchanged: publishedImage === prepared, storageUnchanged: stored === prepared, imageReference: result.deal.image };
    }, source);
    expect(evidence.newWidth).toBe(Math.min(1600, evidence.sourceWidth, evidence.sourceHeight));
    expect(evidence.newWidth).toBeGreaterThan(evidence.legacyWidth);
    expect(evidence.syncUnchanged).toBe(true);
    expect(evidence.storageUnchanged).toBe(true);
    console.log('Photo quality evidence:', JSON.stringify(evidence));
    await testInfo.attach('quality-metrics', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('photo-quality-comparison.png'), fullPage: true });
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of ['O2O_DATA_API_ORIGIN', 'GOOGLE_SHEETS_COLLECTOR_URL', 'GOOGLE_SHEETS_COLLECTOR_TOKEN']) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});
