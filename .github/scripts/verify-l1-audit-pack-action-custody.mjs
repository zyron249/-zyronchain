#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';
const UPLOAD_ARTIFACT_SHA = '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';

const workflow = await readFile(new URL('../workflows/l1-audit-pack.yml', import.meta.url), 'utf8');

const requireExactRef = (action, expected) => {
  const refs = [...workflow.matchAll(new RegExp(`actions/${action}@([0-9a-f]{40})`, 'g'))].map((m) => m[1]);
  if (refs.length !== 1 || refs[0] !== expected) throw new Error(`External audit pack ${action} pin drift`);
  if (new RegExp(`actions/${action}@(?![0-9a-f]{40}\\b)[^\\s]+`).test(workflow)) throw new Error(`Mutable ${action} ref in external audit-pack workflow`);
};

requireExactRef('checkout', CHECKOUT_SHA);
requireExactRef('setup-node', SETUP_NODE_SHA);
requireExactRef('upload-artifact', UPLOAD_ARTIFACT_SHA);

const checkoutIndex = workflow.indexOf(`uses: actions/checkout@${CHECKOUT_SHA}`);
if (checkoutIndex < 0) throw new Error('audit-pack checkout missing');
const nextStep = workflow.indexOf('\n      - name:', checkoutIndex + 1);
const checkoutStep = workflow.slice(checkoutIndex, nextStep === -1 ? workflow.length : nextStep);
if (!/^\s*persist-credentials:\s*false\b/m.test(checkoutStep)) throw new Error('audit-pack checkout must disable credential persistence');

for (const required of [
  'permissions:\n  contents: read',
  'node-version: 24',
  'npm ci',
  'npm run typecheck',
  'build-external-audit-pack.mjs',
  'cmp "$audit/audit-pack-a.json" "$audit/audit-pack-b.json"',
  'npm sbom --omit=dev --sbom-format=spdx',
  'npm audit --omit=dev --audit-level=high',
  'sha256sum audit-pack.json l1-audit-scope.json runtime-sbom.spdx.json > SHA256SUMS',
  'retention-days: 90'
]) {
  if (!workflow.includes(required)) throw new Error(`Required audit-pack security invariant missing: ${required}`);
}

console.log('l1-audit-pack-action-custody: ok');
