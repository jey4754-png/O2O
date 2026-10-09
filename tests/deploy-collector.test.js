import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCEPT_RUN_AS_FLAG, assertPublishedSource, assertMayUpdateDeployment, bodyDigest, deploymentVersion, DEPLOYMENT_ID, mergeRealConfig,
  assertDeploymentAllowed, DEPLOY_OVERRIDE, ownerSteps, parseArgs, webAppSettings,
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

test('매니페스트만으로 실행 계정을 확정할 수 없는 설정은 검토 수락 없이 갱신하지 않는다', () => {
  for (const executeAs of ['USER_DEPLOYING', 'UNKNOWN']) {
    assert.throws(() => assertMayUpdateDeployment({ executeAs }, false), /requires_run_as_review/);
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

test('배포 권한이 확인된 계정 안내는 기존 배포의 버전만 고르고 실행·액세스 설정을 유지한다', () => {
  const steps = ownerSteps('32');
  assert.match(steps, /버전 32/);
  assert.match(steps, /바꾸지 않는다/);
  assert.match(steps, /배포 갱신 권한이 확인된 계정/);
  assert.match(steps, /기존 웹 앱 배포 선택/);
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

test('운영 배포·롤백은 막히고, 버전만 만드는 staging 은 열려 있다', () => {
  const kept = process.env[DEPLOY_OVERRIDE];
  try {
    delete process.env[DEPLOY_OVERRIDE];
    assert.throws(() => assertDeploymentAllowed(), /배포 책임/,
      '기본값은 거부다. 배포 주체를 Joo 한 곳으로 고정해 기록 혼선을 없앤다');
    process.env[DEPLOY_OVERRIDE] = '1';
    assert.doesNotThrow(() => assertDeploymentAllowed(),
      '의도를 밝힌 직접 배포까지 막지는 않는다');
  } finally {
    if (kept === undefined) delete process.env[DEPLOY_OVERRIDE];
    else process.env[DEPLOY_OVERRIDE] = kept;
  }

  // 운영 배포를 바꾸는 호출이 더 생기면 그 경로도 잠금을 거쳐야 한다. promote 는
  // updateDeployment_ 를 거치지 않고 clasp 를 직접 부르므로 각각 확인한다.
  const source = readFileSync(new URL('../scripts/deploy-collector.mjs', import.meta.url), 'utf8');
  assert.match(source, /function updateDeployment\([^)]*\) \{\n\s*assertDeploymentAllowed\(\);/);
  assert.match(source, /if \(promote\) assertDeploymentAllowed\(\);/);
  assert.equal((source.match(/assertDeploymentAllowed\(\);/g) || []).length,
    (source.match(/clasp\(\['update-deployment'/g) || []).length,
    '운영 배포를 바꾸는 호출 수와 잠금 호출 수가 같아야 한다');
});

test('편집기가 저장소와 같아도 그 내용의 버전이 없으면 버전을 만든다', () => {
  const source = readFileSync(new URL('../scripts/deploy-collector.mjs', import.meta.url), 'utf8');
  // 운영은 고정된 버전을 띄운다. 편집기만 최신이고 그 내용으로 만든 버전이
  // 없으면 Joo 가 배포 관리에서 고를 것이 없다. 2026-10-08 에 편집기에는 수정이
  // 들어가 있는데 배포된 v38 은 옛 본문이었고, staging 이 '푸시할 게 없다'며
  // 그냥 돌아가 버려 버전이 만들어지지 않았다.
  assert.equal(/nothing to push';\s*\n\s*return;/.test(source), false,
    '푸시할 것이 없다고 해서 버전 생성까지 건너뛰지 않는다');
  assert.match(source, /const alreadyPushed = bodyDigest\(merged\) === bodyDigest\(source\);/);
  // 돌아가도 되는 경우는 하나뿐이다: 운영 버전이 이미 이 코드를 띄우고 있을 때.
  assert.match(source, /if \(liveDigest === bodyDigest\(merged\)\) \{\s*\n\s*console\.log\(`nothing to do: live version \$\{before\} already serves this code`\);\s*\n\s*return;/);
  // create-version 은 두 갈래가 합쳐진 뒤에 한 번만 불린다.
  assert.equal((source.match(/clasp\(\['create-version'/g) || []).length, 1);
});
