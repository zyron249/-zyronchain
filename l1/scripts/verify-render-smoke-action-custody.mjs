#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../../.github/workflows/l1-render-private-testnet.yml', import.meta.url);
const text = await readFile(workflowPath, 'utf8');

const requireMatch = (pattern, message) => {
  if (!pattern.test(text)) throw new Error(message);
};

requireMatch(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\s+# v7\.0\.1/, 'Render smoke checkout action must use reviewed immutable v7.0.1 SHA');
requireMatch(/persist-credentials:\s*false/, 'Render smoke checkout must disable credential persistence');
requireMatch(/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\s+# v7\.0\.0/, 'Render smoke setup-node must use reviewed immutable v7.0.0 SHA');
requireMatch(/node-version:\s*24\b/, 'Render smoke must remain on Node 24');
requireMatch(/run:\s*npm ci\b/, 'Render smoke must use locked dependency installation');
requireMatch(/run:\s*npm run build\b/, 'Render smoke must build the canonical L1');
requireMatch(/render-private-testnet\.mjs --smoke/, 'Render smoke rehearsal command is missing');
requireMatch(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a\s+# v7\.0\.1/, 'Render smoke upload-artifact must use reviewed immutable v7.0.1 SHA');
requireMatch(/name:\s*l1-render-private-testnet-smoke-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/, 'Render smoke artifact must be commit/run-attempt bound');
requireMatch(/if-no-files-found:\s*error/, 'Render smoke evidence upload must fail closed if the log is missing');
requireMatch(/retention-days:\s*90\b/, 'Render smoke evidence retention must remain 90 days');

for (const forbidden of ['actions/checkout@v', 'actions/setup-node@v', 'actions/upload-artifact@v']) {
  if (text.includes(forbidden)) throw new Error(`Mutable action ref forbidden in Render smoke workflow: ${forbidden}`);
}

console.log('Render private-testnet smoke action custody policy verified.');
