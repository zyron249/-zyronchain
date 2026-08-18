#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';
const workflow = await readFile(new URL('../workflows/unix-miner-archive-contract.yml', import.meta.url), 'utf8');

const requireExactRef = (action, expected) => {
  const refs = [...workflow.matchAll(new RegExp(`actions/${action}@([0-9a-f]{40})`, 'g'))].map((m) => m[1]);
  if (refs.length !== 1 || refs[0] !== expected) throw new Error(`Unix miner archive contract ${action} pin drift`);
  if (new RegExp(`actions/${action}@(?![0-9a-f]{40}\\b)[^\\s]+`).test(workflow)) throw new Error(`Mutable ${action} ref in Unix miner archive contract workflow`);
};

requireExactRef('checkout', CHECKOUT_SHA);
requireExactRef('setup-node', SETUP_NODE_SHA);

const checkoutIndex = workflow.indexOf(`uses: actions/checkout@${CHECKOUT_SHA}`);
if (checkoutIndex < 0) throw new Error('Unix miner archive contract checkout missing');
const nextStep = workflow.indexOf('\n      - name:', checkoutIndex + 1);
const checkoutStep = workflow.slice(checkoutIndex, nextStep === -1 ? workflow.length : nextStep);
if (!/^\s*persist-credentials:\s*false\b/m.test(checkoutStep)) throw new Error('Unix miner archive contract checkout must disable credential persistence');

for (const required of [
  'permissions:\n  contents: read',
  'runs-on: ubuntu-24.04',
  'timeout-minutes: 5',
  'node-version: 22.23.2',
  'working-directory: l1',
  'run: node scripts/test-unix-miner-package-contract.mjs'
]) {
  if (!workflow.includes(required)) throw new Error(`Required Unix miner archive contract invariant missing: ${required}`);
}

if (/publicMiningActivated:\s*true|publicationAllowed:\s*true|mainnetActivationAllowed:\s*true|publicTestnetActivationAllowed:\s*true/.test(workflow)) {
  throw new Error('Unix miner archive contract workflow must not activate mining or network launch gates');
}

console.log('unix-miner-archive-contract-action-custody: ok');
