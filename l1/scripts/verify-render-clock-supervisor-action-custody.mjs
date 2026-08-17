#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../../.github/workflows/l1-render-clock-supervisor.yml', import.meta.url);
const text = await readFile(workflowPath, 'utf8');

const requireMatch = (pattern, message) => {
  if (!pattern.test(text)) throw new Error(message);
};

requireMatch(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\s+# v7\.0\.1/, 'clock supervisor checkout must use reviewed immutable v7.0.1 SHA');
requireMatch(/persist-credentials:\s*false/, 'clock supervisor checkout must disable credential persistence');
requireMatch(/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\s+# v7\.0\.0/, 'clock supervisor setup-node must use reviewed immutable v7.0.0 SHA');
requireMatch(/node-version:\s*24\b/, 'clock supervisor must remain on Node 24');
requireMatch(/npm ci && npm run build/, 'clock supervisor must use locked install and canonical build');
requireMatch(/render-clock-supervisor-rehearsal\.mjs/, 'clock-fault rehearsal is missing');
requireMatch(/render-clock-failstop-supervisor\.mjs --smoke/, 'supervised launcher smoke is missing');
requireMatch(/render-clock-failstop-supervisor\.mjs --test-recovery-once/, 'same-data recovery rehearsal is missing');
requireMatch(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a\s+# v7\.0\.1/, 'clock supervisor upload-artifact must use reviewed immutable v7.0.1 SHA');
requireMatch(/name:\s*l1-render-clock-supervisor-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/, 'clock supervisor artifact must be commit/run-attempt bound');
requireMatch(/if-no-files-found:\s*error/, 'clock supervisor evidence upload must fail closed');
requireMatch(/retention-days:\s*90\b/, 'clock supervisor evidence retention must remain 90 days');

for (const forbidden of ['actions/checkout@v', 'actions/setup-node@v', 'actions/upload-artifact@v']) {
  if (text.includes(forbidden)) throw new Error(`mutable action ref forbidden in clock supervisor workflow: ${forbidden}`);
}

console.log('Render clock fail-stop supervisor action custody policy verified.');
