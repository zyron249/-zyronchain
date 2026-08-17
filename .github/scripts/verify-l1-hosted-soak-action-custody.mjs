#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';
const UPLOAD_ARTIFACT_SHA = '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';

const workflow = await readFile(new URL('../workflows/l1-hosted-duration-soak-evidence.yml', import.meta.url), 'utf8');

const requireExactRef = (action, expected) => {
  const refs = [...workflow.matchAll(new RegExp(`actions/${action}@([0-9a-f]{40})`, 'g'))].map((m) => m[1]);
  if (refs.length !== 1 || refs[0] !== expected) throw new Error(`Hosted-soak ${action} pin drift`);
  if (new RegExp(`actions/${action}@(?![0-9a-f]{40}\\b)[^\\s]+`).test(workflow)) throw new Error(`Mutable ${action} ref in hosted-soak workflow`);
};

requireExactRef('checkout', CHECKOUT_SHA);
requireExactRef('setup-node', SETUP_NODE_SHA);
requireExactRef('upload-artifact', UPLOAD_ARTIFACT_SHA);

const checkoutIndex = workflow.indexOf(`uses: actions/checkout@${CHECKOUT_SHA}`);
const nextStep = workflow.indexOf('\n      - name:', checkoutIndex + 1);
const checkoutStep = workflow.slice(checkoutIndex, nextStep === -1 ? workflow.length : nextStep);
if (!/^\s*persist-credentials:\s*false\b/m.test(checkoutStep)) throw new Error('hosted-soak checkout must disable credential persistence');

for (const required of [
  'permissions:\n  contents: read',
  'node-version: 24',
  'verify-hosted-duration-soak-evidence.mjs',
  '--policy docs/l1-hosted-duration-soak-policy.json',
  '--evidence l1/test-vectors/hosted-duration-soak-valid.json',
  '--evidence l1/test-vectors/hosted-duration-soak-invalid.json',
  'syntheticValidationOnly !== true',
  'sustainedUptimeEvidenceValidated !== false',
  'publicTestnetActivationEvidence !== false',
  'independentOperatorEvidenceProven !== false',
  'mainnetCertified !== false',
  'sha256sum verified.json l1-hosted-duration-soak-policy.json hosted-duration-soak-valid.json hosted-duration-soak-invalid.json > SHA256SUMS',
  'l1-hosted-duration-soak-verifier-${{ github.sha }}-${{ github.run_attempt }}',
  'if-no-files-found: error',
  'retention-days: 90'
]) {
  if (!workflow.includes(required)) throw new Error(`Required hosted-soak security invariant missing: ${required}`);
}

console.log('l1-hosted-soak-action-custody: ok');
