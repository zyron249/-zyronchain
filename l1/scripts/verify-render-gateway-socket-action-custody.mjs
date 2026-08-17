#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../../.github/workflows/l1-render-gateway-socket-redteam.yml', import.meta.url);
const workflow = await readFile(workflowPath, 'utf8');

const required = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'persist-credentials: false',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'node-version: 24',
  'run: npm ci',
  'run: npm run build',
  'render-gateway-socket-redteam.mjs',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'l1-render-gateway-socket-redteam-${{ github.sha }}-${{ github.run_attempt }}',
  'if-no-files-found: error',
  'retention-days: 90'
];
for (const token of required) {
  if (!workflow.includes(token)) throw new Error(`gateway socket action-custody invariant missing: ${token}`);
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

console.log('Render gateway socket red-team action custody policy: OK');
