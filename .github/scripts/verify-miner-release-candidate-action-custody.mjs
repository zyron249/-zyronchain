#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';

const workflow = await readFile(new URL('../workflows/miner-release-candidate.yml', import.meta.url), 'utf8');

const requireExactRef = (action, expected, expectedCount = 1) => {
  const refs = [...workflow.matchAll(new RegExp(`actions/${action}@([0-9a-f]{40})`, 'g'))].map((m) => m[1]);
  if (refs.length !== expectedCount || refs.some((ref) => ref !== expected)) {
    throw new Error(`Miner release candidate ${action} pin drift`);
  }
  if (new RegExp(`actions/${action}@(?![0-9a-f]{40}\\b)[^\\s]+`).test(workflow)) {
    throw new Error(`Mutable ${action} ref in miner release candidate workflow`);
  }
};

requireExactRef('checkout', CHECKOUT_SHA);
requireExactRef('setup-node', SETUP_NODE_SHA);

const checkoutIndex = workflow.indexOf(`uses: actions/checkout@${CHECKOUT_SHA}`);
if (checkoutIndex < 0) throw new Error('miner candidate checkout missing');
const nextStep = workflow.indexOf('\n      - name:', checkoutIndex + 1);
const checkoutStep = workflow.slice(checkoutIndex, nextStep === -1 ? workflow.length : nextStep);
if (!/^\s*persist-credentials:\s*false\b/m.test(checkoutStep)) {
  throw new Error('miner candidate checkout must disable credential persistence');
}

for (const required of [
  'permissions:\n  contents: read',
  'node-version: 22.23.2',
  "test \"$(node -p 'process.version')\" = 'v22.23.2'",
  'npm ci',
  'npm run typecheck',
  'npm audit --omit=dev --audit-level=high',
  'node --check scripts/miner-packaging-custody-gate.mjs',
  'node --check scripts/test-miner-packaging-quarantine.mjs',
  'publicMiningActivated !== false',
  'Prove release-candidate materialization is quarantined before filesystem writes',
  'run: node scripts/test-miner-packaging-quarantine.mjs',
  'Assert no release candidate was materialized',
  "if [ -e miner-release ]",
  'Miner release candidate remains intentionally non-materialized pending #761.'
]) {
  if (!workflow.includes(required)) throw new Error(`Required miner candidate quarantine invariant missing: ${required}`);
}

for (const forbidden of [
  'id-token: write',
  'attestations: write',
  'npm sbom --omit=dev --sbom-format=spdx',
  'run: node scripts/package-miner.mjs',
  'actions/upload-artifact@',
  'actions/attest@',
  'Package self-contained miner',
  'Generate SHA-256 manifest',
  'Upload non-publishable release candidate'
]) {
  if (workflow.includes(forbidden)) {
    throw new Error(`quarantined miner release candidate workflow must not materialize/publish evidence: ${forbidden}`);
  }
}

console.log('miner-release-candidate-action-custody: quarantine ok');
