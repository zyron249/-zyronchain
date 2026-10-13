#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../../.github/workflows/l1-render-memory-soak.yml', import.meta.url);
const workflow = await readFile(workflowPath, 'utf8');

const required = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'persist-credentials: false',
  'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
  'node-version: 24',
  'run: npm ci && npm run build',
  'render-memory-soak.mjs',
  'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  'l1-render-memory-soak-${{ github.sha }}-${{ github.run_attempt }}',
  'if-no-files-found: error',
  'retention-days: 90'
];
for (const token of required) {
  if (!workflow.includes(token)) throw new Error(`memory-soak action-custody invariant missing: ${token}`);
}

for (const line of workflow.split(/\r?\n/)) {
  const match = line.match(/^\s*uses:\s*([^\s#]+)/);
  if (!match) continue;
  const ref = match[1].split('@')[1] ?? '';
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`mutable action reference rejected: ${match[1]}`);
}

if (/persist-credentials:\s*true/.test(workflow)) {
  throw new Error('checkout credential persistence must stay disabled');
}

console.log('Render memory-soak action custody policy: OK');
