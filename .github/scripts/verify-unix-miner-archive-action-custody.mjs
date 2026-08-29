#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';

const workflow = await readFile(new URL('../workflows/unix-miner-archive-candidate.yml', import.meta.url), 'utf8');

const requireExactRef = (action, expected, expectedCount = 1) => {
  const refs = [...workflow.matchAll(new RegExp(`actions/${action}@([0-9a-f]{40})`, 'g'))].map((m) => m[1]);
  if (refs.length !== expectedCount || refs.some((ref) => ref !== expected)) throw new Error(`Unix miner archive ${action} pin drift`);
  if (new RegExp(`actions/${action}@(?![0-9a-f]{40}\\b)[^\\s]+`).test(workflow)) throw new Error(`Mutable ${action} ref in Unix miner archive workflow`);
};

requireExactRef('checkout', CHECKOUT_SHA);
requireExactRef('setup-node', SETUP_NODE_SHA);

const checkoutIndex = workflow.indexOf(`uses: actions/checkout@${CHECKOUT_SHA}`);
if (checkoutIndex < 0) throw new Error('Unix miner archive checkout missing');
const nextStep = workflow.indexOf('\n      - name:', checkoutIndex + 1);
const checkoutStep = workflow.slice(checkoutIndex, nextStep === -1 ? workflow.length : nextStep);
if (!/^\s*persist-credentials:\s*false\b/m.test(checkoutStep)) throw new Error('Unix miner archive checkout must disable credential persistence');

for (const required of [
  'permissions:\n  contents: read',
  'matrix:\n        os: [ubuntu-24.04, macos-15]',
  'node-version: 22.23.2',
  "test \"$(node -p 'process.version')\" = 'v22.23.2'",
  'npm ci',
  'npm run typecheck',
  'npm audit --omit=dev --audit-level=high',
  'node scripts/test-unix-miner-package-contract.mjs',
  'node scripts/test-miner-packaging-quarantine.mjs',
  'publicMiningActivated !== false',
  'rpcUrl !== null',
  'genesisFile !== null',
  'if [ -e miner-release ]; then',
  'custody quarantine must not materialize miner-release',
  'Unix miner archive candidate remains intentionally non-materialized pending #761.'
]) {
  if (!workflow.includes(required)) throw new Error(`Required Unix miner archive quarantine invariant missing: ${required}`);
}

for (const forbidden of [
  /actions\/upload-artifact@/,
  /actions\/attest@/,
  /id-token:\s*write/,
  /attestations:\s*write/,
  /npm sbom/,
  /verify-unix-miner-tarball\.sh/,
  /Generate SHA-256 manifest including archive/,
  /Attest Unix end-user archive/,
  /retention-days:/,
  /publicMiningActivated:\s*true/,
  /releaseEligible:\s*true/,
  /platformSigningVerified:\s*true/,
  /publicationAllowed:\s*true/
]) {
  if (forbidden.test(workflow)) throw new Error(`Unsafe Unix miner archive materialization/publication invariant reintroduced: ${forbidden}`);
}

console.log('unix-miner-archive-action-custody: quarantine ok');
