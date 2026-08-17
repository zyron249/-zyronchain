#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../../.github/workflows/l1-succession-policy.yml', import.meta.url);
const workflow = await readFile(workflowPath, 'utf8');

const required = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'persist-credentials: false',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'node-version: 24',
  'verify-maintainer-succession.mjs',
  'cmp "$evidence/succession-a.json" "$evidence/succession-b.json"',
  'sha256sum maintainer-succession.json l1-maintainer-succession.json > SHA256SUMS',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'l1-maintainer-succession-${{ github.sha }}-${{ github.run_attempt }}',
  'if-no-files-found: error',
  'retention-days: 90'
];

for (const invariant of required) {
  if (!workflow.includes(invariant)) throw new Error(`maintainer succession action custody invariant missing: ${invariant}`);
}

for (const match of workflow.matchAll(/uses:\s+([^\s#]+)/g)) {
  const ref = match[1];
  const at = ref.lastIndexOf('@');
  if (at < 0 || !/^[0-9a-f]{40}$/.test(ref.slice(at + 1))) {
    throw new Error(`mutable or non-SHA action reference rejected: ${ref}`);
  }
}

console.log('maintainer succession action custody policy verified');
