#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';
const workflowPath = new URL('../workflows/genesis-message-ci.yml', import.meta.url);
const workflow = await readFile(workflowPath, 'utf8');

for (const pattern of [
  /actions\/checkout@(?![0-9a-f]{40}\b)[^\s]+/g,
  /actions\/setup-node@(?![0-9a-f]{40}\b)[^\s]+/g,
]) {
  const matches = workflow.match(pattern) ?? [];
  if (matches.length) throw new Error(`Mutable genesis-message action reference(s): ${matches.join(', ')}`);
}

const checkoutRefs = [...workflow.matchAll(/actions\/checkout@([0-9a-f]{40})/g)].map((m) => m[1]);
const nodeRefs = [...workflow.matchAll(/actions\/setup-node@([0-9a-f]{40})/g)].map((m) => m[1]);
if (checkoutRefs.length !== 1 || checkoutRefs[0] !== CHECKOUT_SHA) throw new Error('Genesis-message checkout pin drift');
if (nodeRefs.length !== 1 || nodeRefs[0] !== SETUP_NODE_SHA) throw new Error('Genesis-message setup-node pin drift');

if (!/matrix:\s*\n\s*node:\s*\[22, 24\]/m.test(workflow)) throw new Error('Genesis-message Node 22/24 matrix weakened');
if (!/persist-credentials:\s*false\b/m.test(workflow)) throw new Error('Genesis-message checkout must disable credential persistence');
if (!/run:\s*node l1\/scripts\/verify-genesis-message\.mjs\b/m.test(workflow)) throw new Error('Canonical genesis-message verifier missing');

console.log('genesis-message-action-custody: ok');
