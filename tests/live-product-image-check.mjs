// Explicit opt-in operational check. Creates only its own QA deal, verifies the
// stored image, then soft-deletes that exact QA deal using its own capability.
import { chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const deployment = process.env.O2O_VERIFY_DEPLOYMENT;
const fixturePath = process.env.O2O_IMAGE_FIXTURE;
if (!deployment || !/^https:\/\/o2o-[a-z0-9]+-malshues-projects\.vercel\.app$/.test(deployment) || !fixturePath) {
  throw new Error('Explicit O2O_VERIFY_DEPLOYMENT and O2O_IMAGE_FIXTURE required');
}
const call = (path, body) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = spawnSync('npx', ['--yes', 'vercel', 'curl', path, '--deployment', deployment, '--', '--silent', '--show-error', '--fail-with-body', '--max-time', '45', ...(body ? ['-X', 'POST', '-H', 'Content-Type: application/json', '-H', `Origin: ${deployment}`, '--data-binary', '@-'] : [])], { input: body ? JSON.stringify(body) : undefined, maxBuffer: 4000000, timeout: 55000 });
    if (result.status === 0) return result.stdout;
    if (attempt < 3 && /collector_busy|upstream_timeout/.test(result.stdout?.toString() || '')) continue;
    throw new Error(`Verification request failed (${result.status}): ${result.stdout?.toString().slice(0, 200)}`);
  }
};
const capabilityToken = randomBytes(32).toString('hex');
const dealId = `owner-image-qa-${Date.now()}`;
let published;
const browser = await chromium.launch();
// Preserve only this test's management proof across a crash or an unavailable
// cleanup endpoint. Never log the proof or rely on memory-only credentials.
const recoveryDir = mkdtempSync(join(tmpdir(), 'o2o-image-qa-'));
const recoveryPath = join(recoveryDir, 'cleanup.json');
writeFileSync(recoveryPath, JSON.stringify({ deployment, dealId, capabilityToken }), { mode: 0o600 });
let cleanupVerified = false;
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4187/');
  const source = `data:image/png;base64,${readFileSync(fixturePath).toString('base64')}`;
  const prepared = await page.evaluate(async (source) => {
    const { cropImageDataUrl, prepareImageForSync } = await import('/src/imageCrop.js');
    return prepareImageForSync(await cropImageDataUrl(source));
  }, source);
  const body = { action: 'publish', capabilityToken, deal: { id: dealId, source: 'merchant', saleType: 'instant', title: '[개발 검증] 이미지 저장 확인', region: '검증 전용', store: '개발 검증', originalPrice: 1000, discountRate: 0, totalQuantity: 1, image: prepared, expectedPublishVersion: 0, publishMutationId: `publish-${dealId}` } };
  const result = JSON.parse(call('/api/public-deals', body));
  assert.equal(result.ok, true);
  published = result.deal;
  assert.match(published.image, /^\/api\/public-deals\?image=[a-f0-9]{64}$/);
  const received = call(published.image);
  const bytes = Buffer.from(prepared.split(',')[1], 'base64');
  assert.deepEqual(received, bytes);
  const dimensions = await page.evaluate(async (data) => { const image = new Image(); image.src = data; await image.decode(); return [image.naturalWidth, image.naturalHeight]; }, `data:image/jpeg;base64,${received.toString('base64')}`);
  console.log(JSON.stringify({ ok: true, qaDealId: dealId, imageReference: published.image, bytes: received.length, dimensions, byteIdentical: true, sha256: createHash('sha256').update(received).digest('hex') }));
} finally {
  try {
    // Resolve ambiguous publication before cleanup, without touching any other deal.
    if (!published) {
      const owned = JSON.parse(call('/api/public-deals', { action: 'list_owner', capabilities: [{ dealId, capabilityToken }] }));
      published = owned.deals?.find((deal) => deal.id === dealId);
    }
    if (published) {
      const cleanup = JSON.parse(call('/api/public-deals', { action: 'delete', dealId, capabilityToken, expectedPublishVersion: published.publishVersion, clientMutationId: `cleanup-${dealId}` }));
      assert.equal(cleanup.ok, true);
      console.log(JSON.stringify({ qaDealId: dealId, cleanup: 'soft-deleted QA deal only; image retained for audit' }));
    }
    cleanupVerified = true;
  } finally {
    if (cleanupVerified) {
      unlinkSync(recoveryPath);
      rmdirSync(recoveryDir);
    } else {
      console.error(`QA cleanup needs retry; its private recovery record is at ${recoveryPath}`);
    }
    await browser.close();
  }
}
