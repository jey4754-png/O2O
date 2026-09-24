#!/usr/bin/env node
// Deploys apps-script/Code.gs to the production Apps Script web app without a
// person copying the two real configuration lines by hand.
//
//   node scripts/deploy-collector.mjs --check          read-only: access, deployment, versions
//   node scripts/deploy-collector.mjs --probe          redeploy the CURRENT version (no code change)
//                                                      to prove this account may update the deployment
//   node scripts/deploy-collector.mjs --deploy [-d "설명"]   push this repo's Code.gs as a new version
//   node scripts/deploy-collector.mjs --rollback <N>   point the deployment back at version N
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

export function deploymentVersion(listing, deploymentId = DEPLOYMENT_ID) {
  const line = String(listing).split('\n').find((row) => row.includes(deploymentId));
  if (!line) return null;
  const match = line.match(/@(\d+|HEAD)/);
  return match ? match[1] : null;
}

function clasp(args, cwd) {
  return execFileSync('npx', [...CLASP, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function cloneRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'o2o-collector-'));
  chmodSync(dir, 0o700);
  clasp(['clone', SCRIPT_ID, '--rootDir', '.'], dir);
  const file = readdirSync(dir).find((name) => /\.(gs|js)$/.test(name)
    && CONFIG_LINES.INGEST_TOKEN.test(readFileSync(join(dir, name), 'utf8')));
  if (!file) { rmSync(dir, { recursive: true, force: true }); throw new Error('remote_code_file_not_found'); }
  return { dir, file, source: readFileSync(join(dir, file), 'utf8') };
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
  const { dir, file, source } = cloneRemote();
  try {
    const real = Object.entries(CONFIG_LINES).map(([name, pattern]) => {
      const value = source.match(pattern)?.[1];
      return `${name}: ${value ? (isPlaceholder(value) ? 'PLACEHOLDER' : 'real value present') : 'MISSING'}`;
    });
    console.log(`remote file ${file}: ${real.join(', ')}`);
    const repo = readFileSync(REPO_CODE, 'utf8');
    console.log(`code body: remote ${bodyDigest(source)} / repo ${bodyDigest(repo)} ${bodyDigest(source) === bodyDigest(repo) ? '(same)' : '(differs)'}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await healthCheck();
}

async function probe() {
  const version = currentVersion();
  if (!/^\d+$/.test(version)) throw new Error(`deployment_not_on_a_numbered_version:${version}`);
  console.log(`redeploying the same version ${version} (no code change) to test update permission…`);
  clasp(['update-deployment', DEPLOYMENT_ID, '-V', version, '-d', `permission probe (unchanged v${version})`]);
  console.log(`update permission OK; deployment still at version ${currentVersion()}`);
  if (!await healthCheck()) process.exitCode = 1;
}

async function deploy(description) {
  const before = currentVersion();
  const { dir, file, source } = cloneRemote();
  try {
    const merged = mergeRealConfig(source, readFileSync(REPO_CODE, 'utf8'));
    if (bodyDigest(merged) === bodyDigest(source)) {
      console.log('remote code already matches this repository; nothing to deploy');
      return;
    }
    writeFileSync(join(dir, file), merged, { mode: 0o600 });
    clasp(['push', '--force'], dir);
    const created = clasp(['create-version', description], dir);
    const version = created.match(/version\s+(\d+)/i)?.[1];
    if (!version) throw new Error('could_not_read_new_version_number');
    clasp(['update-deployment', DEPLOYMENT_ID, '-V', version, '-d', description], dir);
    console.log(`deployed: version ${before} → ${version}`);
    console.log(`rollback: node scripts/deploy-collector.mjs --rollback ${before}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!await healthCheck()) {
    console.log(`health check failed — run: node scripts/deploy-collector.mjs --rollback ${before}`);
    process.exitCode = 1;
  }
}

async function rollback(version) {
  if (!/^\d+$/.test(String(version || ''))) throw new Error('usage: --rollback <versionNumber>');
  clasp(['update-deployment', DEPLOYMENT_ID, '-V', version, '-d', `rollback to v${version}`]);
  console.log(`deployment now at version ${currentVersion()}`);
  if (!await healthCheck()) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const descriptionIndex = args.indexOf('-d');
  const description = descriptionIndex >= 0 ? args[descriptionIndex + 1] : `deploy ${new Date().toISOString().slice(0, 16)}`;
  const run = args.includes('--deploy') ? () => deploy(description)
    : args.includes('--probe') ? probe
      : args.includes('--rollback') ? () => rollback(args[args.indexOf('--rollback') + 1])
        : check;
  run().catch((error) => {
    // clasp errors can echo request bodies; show only the first line.
    console.error(`failed: ${String(error.stderr || error.message || error).split('\n')[0].slice(0, 300)}`);
    process.exitCode = 1;
  });
}
