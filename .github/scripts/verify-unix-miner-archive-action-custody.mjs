#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';
const UPLOAD_ARTIFACT_SHA = '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const ATTEST_SHA = '1e69f48acb82d1966a394da916b4c1698aa569d6';

const workflow = await readFile(new URL('../workflows/unix-miner-archive-candidate.yml', import.meta.url), 'utf8');

const requireExactRef = (action, expected, expectedCount = 1) => {
  const refs = [...workflow.matchAll(new RegExp(`actions/${action}@([0-9a-f]{40})`, 'g'))].map((m) => m[1]);
  if (refs.length !== expectedCount || refs.some((ref) => ref !== expected)) throw new Error(`Unix miner archive ${action} pin drift`);
  if (new RegExp(`actions/${action}@(?![0-9a-f]{40}\\b)[^\\s]+`).test(workflow)) throw new Error(`Mutable ${action} ref in Unix miner archive workflow`);
};

requireExactRef('checkout', CHECKOUT_SHA);
requireExactRef('setup-node', SETUP_NODE_SHA);
requireExactRef('upload-artifact', UPLOAD_ARTIFACT_SHA);
requireExactRef('attest', ATTEST_SHA);

const checkoutIndex = workflow.indexOf(`uses: actions/checkout@${CHECKOUT_SHA}`);
if (checkoutIndex < 0) throw new Error('Unix miner archive checkout missing');
const nextStep = workflow.indexOf('\n      - name:', checkoutIndex + 1);
const checkoutStep = workflow.slice(checkoutIndex, nextStep === -1 ? workflow.length : nextStep);
if (!/^\s*persist-credentials:\s*false\b/m.test(checkoutStep)) throw new Error('Unix miner archive checkout must disable credential persistence');

for (const required of [
  'permissions:\n  contents: read',
  'id-token: write',
  'attestations: write',
  'matrix:\n        os: [ubuntu-24.04, macos-15]',
  'node-version: 22.23.2',
  "test \"$(node -p 'process.version')\" = 'v22.23.2'",
  'npm ci',
  'npm run typecheck',
  'npm audit --omit=dev --audit-level=high',
  'npm sbom --omit=dev --sbom-format=spdx',
  'node scripts/test-unix-miner-package-contract.mjs',
  'bash scripts/verify-unix-miner-tarball.sh',
  'test "$status" -eq 78',
  'test ! -e "$test_home"',
  'publicMiningActivated: false',
  'releaseEligible: false',
  'platformSigningVerified: false',
  'publicationAllowed: false',
  'Generate SHA-256 manifest including archive',
  'Attest Unix end-user archive',
  'if-no-files-found: error',
  'retention-days: 90'
]) {
  if (!workflow.includes(required)) throw new Error(`Required Unix miner archive security invariant missing: ${required}`);
}

if (/publicMiningActivated:\s*true|releaseEligible:\s*true|platformSigningVerified:\s*true|publicationAllowed:\s*true/.test(workflow)) {
  throw new Error('Unix miner archive candidate must remain non-publishable and mining-inactive');
}

console.log('unix-miner-archive-action-custody: ok');
