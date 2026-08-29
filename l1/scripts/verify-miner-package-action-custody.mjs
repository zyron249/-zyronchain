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
  'node scripts/test-miner-release-manifest-snapshot.mjs',
  'node scripts/test-miner-release-manifest-root-relative.mjs',
  'node scripts/test-miner-release-manifest-path-controls.mjs',
  'node --check scripts/miner-packaging-custody-gate.mjs',
  'node --check scripts/test-miner-packaging-quarantine.mjs',
  'p.publicMiningActivated !== false || p.rpcUrl !== null || p.genesisFile !== null',
  "if: runner.os != 'Windows'",
  'run: npm test',
  "if: runner.os == 'Windows'",
  'dist/test/miner-genesis.test.js dist/test/miner-network.test.js dist/test/miner-security.test.js',
  'Prove package materialization is quarantined before filesystem writes',
  'run: node scripts/test-miner-packaging-quarantine.mjs'
];

for (const needle of required) {
  if (!workflow.includes(needle)) throw new Error(`miner package custody invariant missing: ${needle}`);
}

for (const forbidden of [
  'npm sbom --omit=dev --sbom-format=spdx',
  'npm prune --omit=dev',
  'run: node scripts/package-miner.mjs',
  'Generate SHA-256 manifest',
  'actions/upload-artifact@',
  'Upload miner bundle'
]) {
  if (workflow.includes(forbidden)) {
    throw new Error(`quarantined Miner Package CI must not materialize or publish artifacts: ${forbidden}`);
  }
}

if (/uses:\s+[^\n]+@(v\d+|main|master)\b/.test(workflow)) {
  throw new Error('mutable GitHub Action reference is forbidden in Miner Package CI');
}

if (workflow.includes("crypto.createHash('sha256')") || workflow.includes('fs.readFileSync(file)')) {
  throw new Error('Miner Package CI must not bypass the custody quarantine with inline artifact hashing');
}

const checkoutSteps = workflow.split(/\n(?=\s*- name: )/).filter((block) => block.includes('actions/checkout@'));
if (checkoutSteps.length !== 1 || !checkoutSteps[0].includes('persist-credentials: false')) {
  throw new Error('Miner Package checkout must disable credential persistence');
}

console.log('miner package action custody policy: quarantine ok');
