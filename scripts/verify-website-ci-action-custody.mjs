#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';
const workflows = [
  {
    path: '.github/workflows/website-ci.yml',
    requireFetchDepthZero: true,
    requiredCommands: [
      'node --check website/app.js',
      'website-wallet-validator-contract-ok'
    ]
  },
  {
    path: '.github/workflows/miner-website-promotion-binding.yml',
    requiredCommands: ['node scripts/verify-miner-website-promotion-binding.mjs']
  },
  {
    path: '.github/workflows/miner-manual-platform-alternatives.yml',
    requiredCommands: ['node website/test-miner-platform-alternatives.mjs']
  }
];

for (const workflow of workflows) {
  const source = await readFile(workflow.path, 'utf8');
  const checkoutRefs = [...source.matchAll(/uses:\s*actions\/checkout@([^\s]+)/g)].map((match) => match[1]);
  const setupNodeRefs = [...source.matchAll(/uses:\s*actions\/setup-node@([^\s]+)/g)].map((match) => match[1]);
  if (checkoutRefs.length !== 1 || checkoutRefs[0] !== CHECKOUT_SHA) {
    throw new Error(`${workflow.path} must use reviewed checkout ${CHECKOUT_SHA}`);
  }
  if (setupNodeRefs.length !== 1 || setupNodeRefs[0] !== SETUP_NODE_SHA) {
    throw new Error(`${workflow.path} must use reviewed setup-node ${SETUP_NODE_SHA}`);
  }
  if (!/persist-credentials:\s*false/.test(source) || /persist-credentials:\s*true/.test(source)) {
    throw new Error(`${workflow.path} must disable checkout credential persistence`);
  }
  const nodeVersions = [...source.matchAll(/node-version:\s*['"]?([^'"\s]+)['"]?/g)].map((match) => match[1]);
  if (nodeVersions.length !== 1 || nodeVersions[0] !== '24') {
    throw new Error(`${workflow.path} must stay on Node 24`);
  }
  if (workflow.requireFetchDepthZero && !/fetch-depth:\s*0/.test(source)) {
    throw new Error(`${workflow.path} must retain full history for canonical release ancestry validation`);
  }
  for (const command of workflow.requiredCommands) {
    if (!source.includes(command)) throw new Error(`${workflow.path} missing required security contract: ${command}`);
  }
  for (const ref of [...checkoutRefs, ...setupNodeRefs]) {
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`${workflow.path} contains a mutable/non-SHA action ref`);
  }
}

console.log('website-ci-action-custody-ok');
