#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../workflows/l1-release-rehearsal.yml', import.meta.url), 'utf8');
const mustContain = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'persist-credentials: false',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'node-version: 22',
  'npm ci',
  'npm run typecheck',
  'npm test',
  'npm audit --omit=dev --audit-level=high',
  'npm pack --ignore-scripts',
  'cmp "$first"/zyronchain-l1-*.tgz "$second"/zyronchain-l1-*.tgz',
  'npm sbom --omit=dev --sbom-format=spdx',
  'sha256sum -c SHA256SUMS',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'l1-release-rehearsal-${{ github.sha }}-${{ github.run_attempt }}',
  'if-no-files-found: error',
  'retention-days: 90'
];
for (const token of mustContain) {
  if (!workflow.includes(token)) throw new Error(`release rehearsal custody invariant missing: ${token}`);
}
for (const mutable of ['actions/checkout@v', 'actions/setup-node@v', 'actions/upload-artifact@v']) {
  if (workflow.includes(mutable)) throw new Error(`mutable action reference forbidden: ${mutable}`);
}
if (/persist-credentials:\s*true/.test(workflow)) throw new Error('checkout credential persistence must remain disabled');
console.log('release rehearsal action custody policy verified');
