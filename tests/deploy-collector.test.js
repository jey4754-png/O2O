import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCEPT_RUN_AS_FLAG, assertPublishedSource, assertMayUpdateDeployment, bodyDigest, deploymentVersion, DEPLOYMENT_ID, mergeRealConfig,
  ownerSteps, parseArgs, webAppSettings,
} from '../scripts/deploy-collector.mjs';

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

test('웹 앱 실행 계정 설정을 매니페스트에서 읽는다', () => {
  const manifest = JSON.stringify({ timeZone: 'Asia/Seoul', webapp: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' } });
  assert.deepEqual(webAppSettings(manifest), { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  assert.deepEqual(webAppSettings('{}'), { executeAs: 'UNKNOWN', access: 'UNKNOWN' });
  assert.deepEqual(webAppSettings('not json'), { executeAs: 'UNKNOWN', access: 'UNKNOWN' });
});

test('배포를 갱신하면 실행 계정이 바뀌는 설정에서는 명시적 수락 없이 거부한다', () => {
  for (const executeAs of ['USER_DEPLOYING', 'UNKNOWN']) {
    assert.throws(() => assertMayUpdateDeployment({ executeAs }, false), /would_run_collector_as_this_account/);
    assert.doesNotThrow(() => assertMayUpdateDeployment({ executeAs }, true));
  }
  assert.doesNotThrow(() => assertMayUpdateDeployment({ executeAs: 'USER_ACCESSING' }, false));
});

test('명령 인자를 해석한다', () => {
  assert.equal(parseArgs([]).mode, 'check');
  assert.equal(parseArgs(['--stage', '-d', 'fix: x']).mode, 'stage');
  assert.equal(parseArgs(['--stage', '-d', 'fix: x']).description, 'fix: x');
  assert.equal(parseArgs(['--stage']).acceptRunAsThisAccount, false);
  const rollback = parseArgs(['--rollback', '31', ACCEPT_RUN_AS_FLAG]);
  assert.equal(rollback.mode, 'rollback');
  assert.equal(rollback.rollbackVersion, '31');
  assert.equal(rollback.acceptRunAsThisAccount, true);
  assert.equal(parseArgs(['--deploy']).mode, 'deploy');
  assert.equal(parseArgs(['--probe']).mode, 'probe');
});

test('소유자 안내는 버전만 고르고 실행 계정·액세스 설정은 그대로 두게 한다', () => {
  const steps = ownerSteps('32');
  assert.match(steps, /버전 32/);
  assert.match(steps, /바꾸지 않는다/);
});

test('배포를 바꾸는 명령은 모두 복제한 프로젝트 폴더 안에서 실행한다', () => {
  const source = readFileSync(new URL('../scripts/deploy-collector.mjs', import.meta.url), 'utf8');
  const calls = source.match(/clasp\(\['update-deployment'[^\n]*/g) || [];
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.match(call, /, dir\);$/, `update-deployment 는 .clasp.json 이 있는 폴더에서만 동작한다: ${call}`);
});


test('staging rejects uncommitted source before reaching a remote and refuses unpublished commits', () => {
  const calls = [];
  assert.throws(() => assertPublishedSource((args) => { calls.push(args); return ' M apps-script/Code.gs'; }), /not_committed/);
  assert.equal(calls.length, 1);
  assert.throws(() => assertPublishedSource((args) => {
    if (args[0] === 'merge-base') throw new Error('not ancestor');
    return '';
  }), /not_published/);
  assert.doesNotThrow(() => assertPublishedSource(() => ''));
});
