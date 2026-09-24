import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bodyDigest, deploymentVersion, DEPLOYMENT_ID, mergeRealConfig } from '../scripts/deploy-collector.mjs';

const repo = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const remote = repo
  .replace("const SPREADSHEET_ID = 'REPLACE_WITH_SPREADSHEET_ID';", "const SPREADSHEET_ID = 'real-sheet-id';")
  .replace("const INGEST_TOKEN = 'REPLACE_WITH_RANDOM_TOKEN';", "const INGEST_TOKEN = 'real-token-value';")
  .replace('function samePhone_', 'function samePhoneOld_');

test('배포본은 저장소 코드에 원격의 실제 두 줄만 끼워 넣는다', () => {
  const merged = mergeRealConfig(remote, repo);
  assert.match(merged, /^const SPREADSHEET_ID = 'real-sheet-id';$/m);
  assert.match(merged, /^const INGEST_TOKEN = 'real-token-value';$/m);
  assert.equal(/REPLACE_WITH_/.test(merged.split('\n').slice(0, 5).join('\n')), false);
  assert.equal(bodyDigest(merged), bodyDigest(repo), '설정 두 줄 외에는 저장소 코드 그대로다');
  assert.notEqual(bodyDigest(merged), bodyDigest(remote));
});

test('원격이 자리표시자거나 줄이 없으면 배포를 거부한다', () => {
  assert.throws(() => mergeRealConfig(repo, repo), /is_placeholder/);
  assert.throws(() => mergeRealConfig('function x() {}', repo), /line_missing/);
});

test('실제 값에 $ 같은 치환 문자가 있어도 그대로 옮긴다', () => {
  const tricky = remote.replace("'real-token-value'", () => "'tok$&en$1'");
  assert.match(mergeRealConfig(tricky, repo), /^const INGEST_TOKEN = 'tok\$&en\$1';$/m);
});

test('배포 목록에서 대상 배포의 버전을 읽는다', () => {
  const listing = `Found 2 deployments.\n- AKfyHEAD @HEAD \n- ${DEPLOYMENT_ID} @27 - 2026-09-24 전화번호 조회 수정`;
  assert.equal(deploymentVersion(listing), '27');
  assert.equal(deploymentVersion('- other @3'), null);
});
