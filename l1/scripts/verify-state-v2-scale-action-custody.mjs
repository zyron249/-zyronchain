#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workflowPath = resolve(process.cwd(), '..', '.github', 'workflows', 'l1-state-v2-scale.yml');
const workflow = await readFile(workflowPath, 'utf8');

const required = [
  ['reviewed checkout SHA', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'],
  ['checkout credential isolation', 'persist-credentials: false'],
  ['reviewed setup-node SHA', 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'],
  ['Node 24 evidence runtime', 'node-version: 24'],
  ['locked install', 'run: npm ci'],
  ['canonical build', 'run: npm run build'],
  ['100k account scale', 'ZYRON_SCALE_ACCOUNTS: "100000"'],
  ['State-v2 benchmark', 'node l1/dist/bench/state-v2-scale.js'],
  ['normalized evidence', 'normalize-state-v2-scale-evidence.mjs'],
  ['commit-bound archive', 'archive-ci-evidence.mjs'],
  ['SHA-256 manifest', 'sha256sum raw.json result.json evidence.json > SHA256SUMS'],
  ['reviewed upload-artifact SHA', 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'],
  ['commit/run-attempt artifact identity', 'name: l1-state-v2-scale-${{ github.sha }}-${{ github.run_attempt }}'],
  ['fail on missing evidence', 'if-no-files-found: error'],
  ['90 day retention', 'retention-days: 90']
];

for (const [label, needle] of required) {
  if (!workflow.includes(needle)) throw new Error(`State-v2 scale custody policy missing ${label}`);
}

const actionRefs = [...workflow.matchAll(/^\s*uses:\s+([^\s#]+).*$/gm)].map((match) => match[1]);
for (const ref of actionRefs) {
  const at = ref.lastIndexOf('@');
  if (at < 0 || !/^[0-9a-f]{40}$/.test(ref.slice(at + 1))) {
    throw new Error(`State-v2 scale workflow contains mutable/non-SHA action ref: ${ref}`);
  }
}

if (/persist-credentials:\s*true/.test(workflow)) {
  throw new Error('State-v2 scale workflow must not persist checkout credentials');
}

if (!workflow.includes('--accounts 100000')) {
  throw new Error('State-v2 scale normalization must remain explicitly bound to 100000 accounts');
}

console.log('State-v2 scale action custody policy verified');
