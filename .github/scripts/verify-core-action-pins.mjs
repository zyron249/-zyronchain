#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_PYTHON_SHA = '5fda3b95a4ea91299a34e894583c3862153e4b97';
const workflowPath = new URL('../workflows/ci.yml', import.meta.url);
const workflow = await readFile(workflowPath, 'utf8');

const mutableCoreRefs = [
  /actions\/checkout@(?![0-9a-f]{40}\b)[^\s]+/g,
  /actions\/setup-python@(?![0-9a-f]{40}\b)[^\s]+/g,
];
for (const pattern of mutableCoreRefs) {
  const matches = workflow.match(pattern) ?? [];
  if (matches.length) throw new Error(`Mutable core action reference(s): ${matches.join(', ')}`);
}

const checkoutRefs = [...workflow.matchAll(/actions\/checkout@([0-9a-f]{40})/g)].map((match) => match[1]);
const pythonRefs = [...workflow.matchAll(/actions\/setup-python@([0-9a-f]{40})/g)].map((match) => match[1]);
if (checkoutRefs.length !== 2 || checkoutRefs.some((ref) => ref !== CHECKOUT_SHA)) {
  throw new Error('Core CI checkout pin drift');
}
if (pythonRefs.length !== 2 || pythonRefs.some((ref) => ref !== SETUP_PYTHON_SHA)) {
  throw new Error('Core CI setup-python pin drift');
}

const checkoutBlocks = workflow.split(/\n\s*- name: Checkout code\n/).slice(1);
if (checkoutBlocks.length !== 2 || checkoutBlocks.some((block) => !/^\s*uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s*with:\n\s*persist-credentials: false\b/m.test(block))) {
  throw new Error('Core CI checkout must disable credential persistence');
}

console.log('core-action-pin-policy: ok');
