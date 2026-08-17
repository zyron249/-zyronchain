#!/usr/bin/env node
import fs from 'node:fs';

const workflowPath = '.github/workflows/miner-website-gate.yml';
const workflow = fs.readFileSync(workflowPath, 'utf8');

const required = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'persist-credentials: false',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  "node-version: '24'",
  'enabled: false',
  'publicMiningActivated: false',
  'assets: Object.freeze({ windows: null, macos: null, linux: null })',
  "connect-src 'none'",
  'never requests a private key, seed phrase, wallet password',
  'Miner download not yet activated'
];

for (const marker of required) {
  if (!workflow.includes(marker)) throw new Error(`miner website gate custody invariant missing: ${marker}`);
}

for (const line of workflow.split(/\r?\n/)) {
  const match = line.match(/^\s*uses:\s*([^\s]+)\s*$/);
  if (!match) continue;
  const ref = match[1].split('@')[1] || '';
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`mutable or non-SHA action ref: ${match[1]}`);
}

if (/persist-credentials:\s*true/.test(workflow)) throw new Error('checkout credentials must remain non-persistent');
if (/enabled:\s*true|publicMiningActivated:\s*true/.test(workflow)) throw new Error('miner website gate must not activate mining');
if (/assets:\s*Object\.freeze\(\{[^}]*https:\/\//s.test(workflow)) throw new Error('miner website gate must keep release assets unbound');

console.log('miner website gate action custody policy: OK');
