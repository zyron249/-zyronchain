#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/miner-release-promotion-gate.yml', 'utf8');
const required = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'persist-credentials: false',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'node-version: 22.23.2',
  'node scripts/verify-miner-release-promotion.mjs',
  'node scripts/verify-miner-release-provenance-subjects.mjs',
  'node scripts/test-miner-release-promotion.mjs',
  'node scripts/test-miner-release-provenance-subjects.mjs'
];
for (const token of required) {
  if (!workflow.includes(token)) throw new Error(`miner promotion custody invariant missing: ${token}`);
}
for (const line of workflow.split(/\r?\n/)) {
  const match = line.match(/^\s*uses:\s*([^\s#]+)/);
  if (!match) continue;
  const ref = match[1].split('@')[1] ?? '';
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`mutable or non-SHA action ref: ${match[1]}`);
}
if (/persist-credentials:\s*true/i.test(workflow)) throw new Error('checkout credential persistence must remain disabled');
if (/\b(?:upload-artifact|attest|release|publish)\b/i.test(workflow)) throw new Error('promotion gate must not acquire publication or attestation authority');
console.log('miner release promotion action custody policy: OK');
