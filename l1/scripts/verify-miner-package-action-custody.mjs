#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const workflowPath = new URL('../../.github/workflows/miner-package.yml', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8');

const required = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'persist-credentials: false',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'os: [ubuntu-24.04, windows-2022, macos-15]',
  'node: [22, 24]',
  'npm ci',
  'npm run typecheck',
  'node scripts/test-miner-launcher-security.mjs',
  'node scripts/test-miner-release-manifest.mjs',
  'node scripts/test-miner-release-manifest-verify.mjs',
  'node scripts/test-miner-candidate-integrity.mjs',
  'node --check scripts/miner-candidate-integrity.mjs',
  'node --check scripts/test-miner-release-manifest-verify.mjs',
  'p.publicMiningActivated !== false || p.rpcUrl !== null || p.genesisFile !== null',
  "if: runner.os != 'Windows'",
  'run: npm test',
  "if: runner.os == 'Windows'",
  'dist/test/miner-genesis.test.js dist/test/miner-network.test.js dist/test/miner-security.test.js',
  'Prove package materialization is quarantined before filesystem writes',
  'run: node scripts/test-miner-packaging-quarantine.mjs',
  'Construct and verify audited POSIX candidate integrity',
  'node scripts/package-miner.mjs',
  'candidate-integrity.json',
  'verifyCandidateIntegrity',
  'p.sourceCommit!==process.env.GITHUB_SHA',
  'node scripts/generate-miner-sha256sums.mjs "$candidate"',
  'test -f "$candidate/SHA256SUMS"',
  'verifyMinerSha256Sums'
];

for (const needle of required) {
  if (!workflow.includes(needle)) throw new Error(`miner package custody invariant missing: ${needle}`);
}

for (const forbidden of [
  'npm sbom --omit=dev --sbom-format=spdx',
  'npm prune --omit=dev',
  'actions/upload-artifact@',
  'Upload miner bundle',
  'id-token: write',
  'attestations: write',
  'contents: write',
  'gh release'
]) {
  if (workflow.includes(forbidden)) {
    throw new Error(`local Miner Package CI must not gain release-publication authority: ${forbidden}`);
  }
}

if (/uses:\s+[^\n]+@(v\d+|main|master)\b/.test(workflow)) {
  throw new Error('mutable GitHub Action reference is forbidden in Miner Package CI');
}

const checkoutSteps = workflow.split(/\n(?=\s*- name: )/).filter((block) => block.includes('actions/checkout@'));
if (checkoutSteps.length !== 1 || !checkoutSteps[0].includes('persist-credentials: false')) {
  throw new Error('Miner Package checkout must disable credential persistence');
}

console.log('miner package action custody policy: audited local integrity/checksum-bound candidate / no publication authority ok');
