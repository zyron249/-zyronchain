#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../../.github/workflows/l1-render-gateway-redteam.yml', import.meta.url);
const text = await readFile(workflowPath, 'utf8');

const requireMatch = (pattern, message) => {
  if (!pattern.test(text)) throw new Error(message);
};

requireMatch(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\s+# v7\.0\.1/, 'gateway red-team checkout must use reviewed immutable v7.0.1 SHA');
requireMatch(/persist-credentials:\s*false/, 'gateway red-team checkout must disable credential persistence');
requireMatch(/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\s+# v7\.0\.0/, 'gateway red-team setup-node must use reviewed immutable v7.0.0 SHA');
requireMatch(/node-version:\s*24\b/, 'gateway red-team must remain on Node 24');
requireMatch(/working-directory:\s*l1[\s\S]*?run:\s*npm ci/, 'gateway red-team must use locked dependency install');
requireMatch(/Build canonical L1[\s\S]*?run:\s*npm run build/, 'gateway red-team canonical build is missing');
requireMatch(/render-gateway-redteam\.mjs/, 'controlled gateway burst rehearsal is missing');
requireMatch(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a\s+# v7\.0\.1/, 'gateway red-team upload-artifact must use reviewed immutable v7.0.1 SHA');
requireMatch(/name:\s*l1-render-gateway-redteam-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/, 'gateway red-team artifact must be commit/run-attempt bound');
requireMatch(/if-no-files-found:\s*error/, 'gateway red-team evidence upload must fail closed');
requireMatch(/retention-days:\s*90\b/, 'gateway red-team evidence retention must remain 90 days');

for (const forbidden of ['actions/checkout@v', 'actions/setup-node@v', 'actions/upload-artifact@v']) {
  if (text.includes(forbidden)) throw new Error(`mutable action ref forbidden in gateway red-team workflow: ${forbidden}`);
}

console.log('Render gateway red-team action custody policy verified.');
