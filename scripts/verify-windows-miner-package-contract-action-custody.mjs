#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const workflowPath = '.github/workflows/windows-miner-package-contract.yml';
const workflow = readFileSync(workflowPath, 'utf8');

const required = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'persist-credentials: false',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'node-version: 22.23.2',
  'run: node scripts/run-windows-package-contracts.mjs'
];

for (const needle of required) {
  if (!workflow.includes(needle)) throw new Error(`Windows miner package contract custody invariant missing: ${needle}`);
}

for (const line of workflow.split(/\r?\n/)) {
  const actionMatch = line.match(/^\s*uses:\s*([^\s#]+)/);
  if (actionMatch) {
    const ref = actionMatch[1];
    const at = ref.lastIndexOf('@');
    const revision = at >= 0 ? ref.slice(at + 1) : '';
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`mutable or non-SHA action ref rejected: ${ref}`);
  }

  const nodeMatch = line.match(/^\s*node-version:\s*['\"]?([^'\"\s#]+)['\"]?/);
  if (nodeMatch && nodeMatch[1] !== '22.23.2') {
    throw new Error(`Windows miner package contract runtime drifted from Node 22.23.2: ${nodeMatch[1]}`);
  }
}

if (/persist-credentials:\s*true/.test(workflow)) throw new Error('checkout credential persistence must remain disabled');

console.log('Windows miner package contract action custody policy: PASS');
