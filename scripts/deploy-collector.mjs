#!/usr/bin/env node
// Deploys apps-script/Code.gs to the production Apps Script web app without a
// person copying the two real configuration lines by hand.
//
//   node scripts/deploy-collector.mjs --check          read-only: access, deployment, versions, run-as account
//   node scripts/deploy-collector.mjs --stage [-d "설명"]    push this repo's Code.gs and create a version,
//                                                      WITHOUT changing the live deployment; the owner then
//                                                      points the deployment at that version in the editor
//   node scripts/deploy-collector.mjs --deploy [-d "설명"]   stage, then point the live deployment at it
//   node scripts/deploy-collector.mjs --probe          point the deployment at its CURRENT version again
//   node scripts/deploy-collector.mjs --rollback <N>   point the deployment back at version N
//
// --deploy, --probe and --rollback update the live deployment. When the web app
// is set to execute as the deploying user (executeAs USER_DEPLOYING), Google runs
// it as whoever updated the deployment last: "The web app runs as the user who
// deployed it." Doing that from an editor account moves production onto that
// account, which fails if the account never authorized the script. These modes
// therefore refuse unless --accept-run-as-this-account is given; use --stage.
//
// The remote project is cloned into a private temporary directory outside the
// repository. The real SPREADSHEET_ID / INGEST_TOKEN lines are read from the
// remote copy and put into the pushed file; they are never printed, logged or
// written inside the repository, and the directory is removed afterwards.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCRIPT_ID = '1S6vmyQPEvYDZrW4TynXrcaZS52rI2xOxepNaD5WaOoepV5dUcNxHL_Ya';
export const DEPLOYMENT_ID = 'AKfycbxot0xyv66E-EhpdUUxlb7Cyfcg-w252jA5osC1UVgJATnaXjspRdd0guG1rptrh9eLEA';
export const WEB_APP_URL = `https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec`;
const CLASP = ['--yes', '@google/clasp@3.4.1'];
const REPO_CODE = fileURLToPath(new URL('../apps-script/Code.gs', import.meta.url));
const CONFIG_LINES = {
  SPREADSHEET_ID: /^const SPREADSHEET_ID = '([^'\n]*)';$/m,
  INGEST_TOKEN: /^const INGEST_TOKEN = '([^'\n]*)';$/m,
};

const isPlaceholder = (value) => /^REPLACE_WITH_/.test(String(value || ''));
export const ACCEPT_RUN_AS_FLAG = '--accept-run-as-this-account';

// Returns the repository source with the remote project's real configuration
// lines substituted. Refuses when the remote lines are missing or placeholders:
// pushing placeholders would stop all central storage unless the collector had
// already stored its configuration, which this tool cannot see.
export function mergeRealConfig(remoteSource, repoSource) {
  let merged = repoSource;
  for (const [name, pattern] of Object.entries(CONFIG_LINES)) {
    const remote = remoteSource.match(pattern);
    if (!remote) throw new Error(`remote_${name.toLowerCase()}_line_missing`);
    if (isPlaceholder(remote[1]) || !remote[1]) throw new Error(`remote_${name.toLowerCase()}_is_placeholder`);
    if (!pattern.test(merged)) throw new Error(`repo_${name.toLowerCase()}_line_missing`);
    merged = merged.replace(pattern, () => `const ${name} = '${remote[1]}';`);
  }
  if (/^const (SPREADSHEET_ID|INGEST_TOKEN) = 'REPLACE_WITH_/m.test(merged)) throw new Error('merged_still_has_placeholder');
  return merged;
}

// Hash of the code below the configuration lines, so two copies can be compared
// without printing either.
export function bodyDigest(source) {
  const body = source.replace(CONFIG_LINES.SPREADSHEET_ID, '').replace(CONFIG_LINES.INGEST_TOKEN, '');
  return createHash('sha256').update(body.replace(/\r\n/g, '\n').trimEnd()).digest('hex').slice(0, 16);
}

// Web app settings from appsscript.json. Neither value is secret.
export function webAppSettings(manifestText) {
  try {
    const webapp = JSON.parse(manifestText)?.webapp || {};
    return { executeAs: webapp.executeAs || 'UNKNOWN', access: webapp.access || 'UNKNOWN' };
  } catch {
    return { executeAs: 'UNKNOWN', access: 'UNKNOWN' };
  }
}

// Updating the live deployment is only identity-neutral when the web app runs as
// the visitor. Anything else needs the caller's explicit acceptance.
export function assertMayUpdateDeployment(settings, acceptRunAsThisAccount) {
  if (settings.executeAs === 'USER_ACCESSING' || acceptRunAsThisAccount) return;
  throw new Error(`deployment_update_would_run_collector_as_this_account(executeAs=${settings.executeAs}); `
    + `use --stage and ask the script owner to deploy the version, or pass ${ACCEPT_RUN_AS_FLAG}`);
}

export function parseArgs(argv) {
  const has = (flag) => argv.includes(flag);
  const after = (flag) => (has(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const mode = has('--deploy') ? 'deploy' : has('--stage') ? 'stage' : has('--probe') ? 'probe'
    : has('--rollback') ? 'rollback' : 'check';
  return {
    mode,
    description: after('-d') || `deploy ${new Date().toISOString().slice(0, 16)}`,
    rollbackVersion: after('--rollback'),
    acceptRunAsThisAccount: has(ACCEPT_RUN_AS_FLAG),
  };
}

export function ownerSteps(version) {
  return `owner (script owner account) in the Apps Script editor: 배포 → 배포 관리 → 웹 앱 배포 선택 → 연필 → 버전 ${version} → 배포 `
    + '(\'다음 사용자 인증 정보로 실행\'·\'액세스 권한\'은 바꾸지 않는다)';
}

export function deploymentVersion(listing, deploymentId = DEPLOYMENT_ID) {
  const line = String(listing).split('\n').find((row) => row.includes(deploymentId));
  if (!line) return null;
  const match = line.match(/@(\d+|HEAD)/);
  return match ? match[1] : null;
}

// Refuse unreleased collector code before making any remote API calls.
export function assertPublishedSource(runGit = (args) => execFileSync('git', args, {
  cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})) {
  if (String(runGit(['status', '--porcelain', '--', 'apps-script/Code.gs'])).trim()) {
    throw new Error('collector_source_not_committed');
  }
  runGit(['fetch', 'origin', 'main']);
  try { runGit(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']); }
  catch { throw new Error('collector_commit_not_published_on_main'); }
}

function clasp(args, cwd) {
  return execFileSync('npx', [...CLASP, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Clones the editor's current code, or the code of a given version.
function cloneRemote(version) {
  const dir = mkdtempSync(join(tmpdir(), 'o2o-collector-'));
  chmodSync(dir, 0o700);
  clasp(['clone', SCRIPT_ID, ...(version ? [String(version)] : []), '--rootDir', '.'], dir);
  const file = readdirSync(dir).find((name) => /\.(gs|js)$/.test(name)
    && CONFIG_LINES.INGEST_TOKEN.test(readFileSync(join(dir, name), 'utf8')));
  if (!file) { rmSync(dir, { recursive: true, force: true }); throw new Error('remote_code_file_not_found'); }
  let manifest = '';
  try { manifest = readFileSync(join(dir, 'appsscript.json'), 'utf8'); } catch { /* reported as UNKNOWN */ }
  return { dir, file, source: readFileSync(join(dir, file), 'utf8'), settings: webAppSettings(manifest) };
}

function printSettings(settings) {
  console.log(`web app: executeAs ${settings.executeAs}, access ${settings.access}`);
  if (settings.executeAs !== 'USER_ACCESSING') {
    console.log('note: updating the live deployment from this account would make the collector run as this account; '
      + 'use --stage and let the script owner deploy the version');
  }
}

async function healthCheck() {
  const response = await fetch(WEB_APP_URL, { redirect: 'follow' });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const ok = response.ok && body?.ok === true && body?.service === 'UPTWOYOU collector';
  console.log(`health: HTTP ${response.status} ${ok ? 'OK (UPTWOYOU collector)' : 'UNEXPECTED'}`);
  return ok;
}

function currentVersion() {
  const listing = clasp(['list-deployments', SCRIPT_ID]);
  const version = deploymentVersion(listing);
  if (!version) throw new Error('deployment_not_found_for_this_account');
  return version;
}

async function check() {
  console.log(clasp(['show-authorized-user']).trim());
  const version = currentVersion();
  console.log(`deployment ${DEPLOYMENT_ID.slice(0, 12)}… is at version ${version}`);
  const { dir, file, source, settings } = cloneRemote();
  try {
    printSettings(settings);
    const real = Object.entries(CONFIG_LINES).map(([name, pattern]) => {
      const value = source.match(pattern)?.[1];
      return `${name}: ${value ? (isPlaceholder(value) ? 'PLACEHOLDER' : 'real value present') : 'MISSING'}`;
    });
    console.log(`remote file ${file}: ${real.join(', ')}`);
    const repo = bodyDigest(readFileSync(REPO_CODE, 'utf8'));
    const editor = bodyDigest(source);
    console.log(`code body: editor ${editor} / repo ${repo} ${editor === repo ? '(same)' : '(differs)'}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The live deployment serves a fixed version, which can differ from the
  // editor's code after --stage or an unsaved edit.
  if (/^\d+$/.test(version)) {
    const deployed = cloneRemote(version);
    rmSync(deployed.dir, { recursive: true, force: true });
    const repo = bodyDigest(readFileSync(REPO_CODE, 'utf8'));
    console.log(`deployed v${version} body ${bodyDigest(deployed.source)} ${bodyDigest(deployed.source) === repo ? '(same as repo)' : '(differs from repo)'}`);
  }
  await healthCheck();
}

// update-deployment needs a project settings file in its working directory, so
// every deployment change runs inside the private clone.
function updateDeployment(version, description, acceptRunAsThisAccount) {
  const { dir, settings } = cloneRemote();
  try {
    printSettings(settings);
    assertMayUpdateDeployment(settings, acceptRunAsThisAccount);
    clasp(['update-deployment', DEPLOYMENT_ID, '-V', version, '-d', description], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function probe({ acceptRunAsThisAccount }) {
  const version = currentVersion();
  if (!/^\d+$/.test(version)) throw new Error(`deployment_not_on_a_numbered_version:${version}`);
  console.log(`redeploying the same version ${version} (same code; the run-as account can change) to test update permission…`);
  updateDeployment(version, `permission probe (unchanged v${version})`, acceptRunAsThisAccount);
  console.log(`update permission OK; deployment still at version ${currentVersion()}`);
  if (!await healthCheck()) process.exitCode = 1;
}

// Pushes the repository code with the remote's real configuration lines and
// creates a version. With promote=false the live deployment is not touched.
async function deploy(description, { promote, acceptRunAsThisAccount }) {
  assertPublishedSource();
  const before = currentVersion();
  const { dir, file, source, settings } = cloneRemote();
  let version = null;
  try {
    printSettings(settings);
    if (promote) assertMayUpdateDeployment(settings, acceptRunAsThisAccount);
    const merged = mergeRealConfig(source, readFileSync(REPO_CODE, 'utf8'));
    if (bodyDigest(merged) === bodyDigest(source)) {
      console.log('remote code already matches this repository; nothing to push');
      return;
    }
    writeFileSync(join(dir, file), merged, { mode: 0o600 });
    clasp(['push', '--force'], dir);
    const created = clasp(['create-version', description], dir);
    version = created.match(/version\s+(\d+)/i)?.[1];
    if (!version) throw new Error('could_not_read_new_version_number');
    if (!promote) {
      console.log(`staged: version ${version} created; live deployment still at version ${before}`);
      console.log(ownerSteps(version));
      console.log(`owner rollback if needed: ${ownerSteps(before)}`);
      return;
    }
    clasp(['update-deployment', DEPLOYMENT_ID, '-V', version, '-d', description], dir);
    console.log(`deployed: version ${before} → ${version}`);
    console.log(`rollback: node scripts/deploy-collector.mjs --rollback ${before} ${ACCEPT_RUN_AS_FLAG}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (promote && version && !await healthCheck()) {
    console.log(`health check failed — run: node scripts/deploy-collector.mjs --rollback ${before} ${ACCEPT_RUN_AS_FLAG}`);
    process.exitCode = 1;
  }
}

async function rollback(version, { acceptRunAsThisAccount }) {
  if (!/^\d+$/.test(String(version || ''))) throw new Error('usage: --rollback <versionNumber>');
  updateDeployment(version, `rollback to v${version}`, acceptRunAsThisAccount);
  console.log(`deployment now at version ${currentVersion()}`);
  if (!await healthCheck()) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const options = parseArgs(process.argv.slice(2));
  const run = {
    check: () => check(),
    stage: () => deploy(options.description, { ...options, promote: false }),
    deploy: () => deploy(options.description, { ...options, promote: true }),
    probe: () => probe(options),
    rollback: () => rollback(options.rollbackVersion, options),
  }[options.mode];
  run().catch((error) => {
    // clasp errors can echo request bodies; show only the first line.
    console.error(`failed: ${String(error.stderr || error.message || error).split('\n')[0].slice(0, 300)}`);
    process.exitCode = 1;
  });
}
