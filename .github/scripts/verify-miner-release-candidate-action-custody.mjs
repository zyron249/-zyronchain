#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';

const workflow = await readFile(new URL('../workflows/miner-release-candidate.yml', import.meta.url), 'utf8');

const requireExactRef = (action, expected, expectedCount = 1) => {
  const refs = [...workflow.matchAll(new RegExp(`actions/${action}@([0-9a-f]{40})`, 'g'))].map((m) => m[1]);
  if (refs.length !== expectedCount || refs.some((ref) => ref !== expected)) throw new Error(`Miner release candidate ${action} pin drift`);
  if (new RegExp(`actions/${action}@(?![0-9a-f]{40}\\b)[^\\s]+`).test(workflow)) throw new Error(`Mutable ${action} ref in miner release candidate workflow`);
};

requireExactRef('checkout', CHECKOUT_SHA);
requireExactRef('setup-node', SETUP_NODE_SHA);

const checkoutIndex = workflow.indexOf(`uses: actions/checkout@${CHECKOUT_SHA}`);
if (checkoutIndex < 0) throw new Error('miner candidate checkout missing');
const nextStep = workflow.indexOf('\n      - name:', checkoutIndex + 1);
const checkoutStep = workflow.slice(checkoutIndex, nextStep === -1 ? workflow.length : nextStep);
if (!/^\s*persist-credentials:\s*false\b/m.test(checkoutStep)) throw new Error('miner candidate checkout must disable credential persistence');

for (const required of [
  'permissions:\n  contents: read',
  'node-version: 22.23.2',
  "test \"$(node -p 'process.version')\" = 'v22.23.2'",
  'npm ci',
  'npm run typecheck',
  'npm audit --omit=dev --audit-level=high',
  'publicMiningActivated !== false',
  'Prove miner packaging platform gate',
  'Construct audited POSIX release candidate',
  "if: runner.os != 'Windows'",
  'run: node scripts/package-miner.mjs',
  'Verify POSIX candidate remains local and inactive',
  'test -d miner-release',
  'materialized candidate must remain activation-gated',
  'Prove Windows package entrypoint fails closed before writes',
  "if: runner.os == 'Windows'",
  'Windows package entrypoint unexpectedly succeeded',
  'unsupported Windows packaging must fail before miner-release state exists'
]) {
  if (!workflow.includes(required)) throw new Error(`Required miner candidate custody invariant missing: ${required}`);
}

for (const forbidden of [
  'id-token: write',
  'attestations: write',
  'actions/upload-artifact@',
  'actions/attest@',
  'gh release',
  'contents: write'
]) {
  if (workflow.includes(forbidden)) throw new Error(`non-publishable miner candidate workflow must not gain publication authority: ${forbidden}`);
}

console.log('miner-release-candidate-action-custody: audited local candidate / unsupported-platform fail-closed ok');
