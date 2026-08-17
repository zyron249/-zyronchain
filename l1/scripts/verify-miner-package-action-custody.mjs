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
  'p.publicMiningActivated !== false || p.rpcUrl !== null || p.genesisFile !== null',
  "if: runner.os != 'Windows'",
  'run: npm test',
  "if: runner.os == 'Windows'",
  'dist/test/miner-genesis.test.js dist/test/miner-network.test.js dist/test/miner-security.test.js',
  'npm sbom --omit=dev --sbom-format=spdx',
  'npm prune --omit=dev',
  'node scripts/package-miner.mjs',
  'if [ "$STATUS" -ne 78 ]',
  "if [ -e \"$TEST_HOME\" ]; then echo 'inactive launcher touched custody directory'",
  'SHA256SUMS',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'if-no-files-found: error',
  'retention-days: 14'
];

for (const needle of required) {
  if (!workflow.includes(needle)) throw new Error(`miner package custody invariant missing: ${needle}`);
}

if (/uses:\s+[^\n]+@(v\d+|main|master)\b/.test(workflow)) {
  throw new Error('mutable GitHub Action reference is forbidden in Miner Package CI');
}

const checkoutSteps = workflow.split(/\n(?=\s*- name: )/).filter((block) => block.includes('actions/checkout@'));
if (checkoutSteps.length !== 1 || !checkoutSteps[0].includes('persist-credentials: false')) {
  throw new Error('Miner Package checkout must disable credential persistence');
}

console.log('miner package action custody policy: ok');