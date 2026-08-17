#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const workflowPath = new URL('../../.github/workflows/l1-independent-operator-challenge.yml', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8');

const required = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'persist-credentials: false',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'node-version: 24',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'founderPrivateAssistanceUsed=true',
  'independenceProven!==false',
  'externalReviewRequired!==true',
  'sha256sum verified-test-vector.json challenge-policy.json > SHA256SUMS',
  'l1-independent-operator-challenge-${{ github.sha }}-${{ github.run_attempt }}',
  'if-no-files-found: error',
  'retention-days: 90'
];

for (const needle of required) {
  if (!workflow.includes(needle)) throw new Error(`independent-operator custody invariant missing: ${needle}`);
}

if (/uses:\s+[^\n]+@(v\d+|main|master)\b/.test(workflow)) {
  throw new Error('mutable GitHub Action reference is forbidden in independent-operator evidence workflow');
}

console.log('independent-operator action custody policy: ok');
