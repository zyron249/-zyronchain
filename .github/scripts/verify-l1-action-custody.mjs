#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';
const SETUP_PYTHON_SHA = '5fda3b95a4ea91299a34e894583c3862153e4b97';
const UPLOAD_ARTIFACT_SHA = '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const workflowPath = new URL('../workflows/l1.yml', import.meta.url);
const workflow = await readFile(workflowPath, 'utf8');

for (const action of ['checkout', 'setup-node', 'setup-python', 'upload-artifact']) {
  const mutable = workflow.match(new RegExp(`actions/${action}@(?![0-9a-f]{40}\\b)[^\\s]+`, 'g')) ?? [];
  if (mutable.length) throw new Error(`Mutable ${action} reference(s): ${mutable.join(', ')}`);
}

const assertRefs = (action, expected, minimum = 1) => {
  const refs = [...workflow.matchAll(new RegExp(`actions/${action}@([0-9a-f]{40})`, 'g'))].map((match) => match[1]);
  if (refs.length < minimum || refs.some((ref) => ref !== expected)) {
    throw new Error(`Standalone L1 ${action} pin drift`);
  }
};

assertRefs('checkout', CHECKOUT_SHA, 7);
assertRefs('setup-node', SETUP_NODE_SHA, 5);
assertRefs('setup-python', SETUP_PYTHON_SHA, 1);
assertRefs('upload-artifact', UPLOAD_ARTIFACT_SHA, 4);

const checkoutSteps = [...workflow.matchAll(/- name: Checkout[^\n]*\n\s*uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s*with:\n([\s\S]*?)(?=\n\s*- name:|\n\s*[a-zA-Z0-9_-]+:|$)/g)];
if (checkoutSteps.length < 7) throw new Error('Standalone L1 checkout step count unexpectedly decreased');
for (const [, withBlock] of checkoutSteps) {
  if (!/^\s*persist-credentials:\s*false\b/m.test(withBlock)) {
    throw new Error('Standalone L1 checkout must disable credential persistence');
  }
}

for (const required of ['node-version: [22, 24]', 'npm audit --omit=dev --audit-level=high', 'npm sbom --omit=dev --sbom-format=spdx', 'python -m pip install --require-hashes']) {
  if (!workflow.includes(required)) throw new Error(`Required Standalone L1 security check missing: ${required}`);
}

console.log('l1-action-custody-policy: ok');
