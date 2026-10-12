#!/usr/bin/env node
// F-07 / F-08 residual mutation tests (independent retest, round 3): the
// website release-pin verifier and the L1 release-policy verifier must reject
// ineffective variants of their workflows and still accept the real ones.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyWebsiteReleasePinWorkflow } from './verify-website-release-pin-action-custody.mjs';
import { verifyL1ReleaseWorkflow } from '../.github/scripts/verify-l1-release-action-custody.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const website = await read('.github/workflows/website-release-pin-ci.yml');
const release = await read('.github/workflows/l1-release.yml');
assert.doesNotThrow(() => verifyWebsiteReleasePinWorkflow(website), 'the real website release-pin workflow must pass');
assert.doesNotThrow(() => verifyL1ReleaseWorkflow(release), 'the real release workflow must pass');

const replaceOnce = (text, from, to) => {
  assert.ok(text.includes(from), `mutation anchor missing: ${from}`);
  return text.replace(from, to);
};

const websiteMutations = {
  'l1/** removed from both triggers': website.replaceAll("      - 'l1/**'\n", ''),
  'second diff compares a path missing from the triggers':
    replaceOnce(website, "'docs/STANDALONE_L1_READINESS.md')", "'docs/STANDALONE_L1_READINESS.md' 'extra-canonical/**')"),
  'diff failure masked with a shell no-op':
    replaceOnce(website, "'docs/STANDALONE_L1_READINESS.md')", "'docs/STANDALONE_L1_READINESS.md' || :)"),
  'diff failure masked with exit 0':
    replaceOnce(website, "'docs/STANDALONE_L1_READINESS.md')", "'docs/STANDALONE_L1_READINESS.md' || exit 0)"),
  'pipefail removed': replaceOnce(website, 'set -euo pipefail', 'set -eu')
};
for (const [name, mutated] of Object.entries(websiteMutations)) {
  assert.notEqual(mutated, website, `mutation has no effect: ${name}`);
  assert.throws(() => verifyWebsiteReleasePinWorkflow(mutated), Error, `website mutation must be rejected: ${name}`);
}

const releaseMutations = {
  'audit printed instead of run':
    replaceOnce(release, 'run: npm audit --omit=dev --audit-level=high', 'run: echo npm audit --omit=dev --audit-level=high'),
  'continue-on-error as the first step property':
    replaceOnce(release, '- name: Test\n        run: npm test', '- continue-on-error: true\n        name: Test\n        run: npm test'),
  'test command after exit 0': replaceOnce(release, 'run: npm test', 'run: |\n          exit 0\n          npm test'),
  'condition as the first step property':
    replaceOnce(release, '- name: Test\n        run: npm test', "- if: ${{ false }}\n        name: Test\n        run: npm test")
};
for (const [name, mutated] of Object.entries(releaseMutations)) {
  assert.throws(() => verifyL1ReleaseWorkflow(mutated), Error, `release mutation must be rejected: ${name}`);
}
console.log(`ci-verifier-mutations: ok (${Object.keys(websiteMutations).length + Object.keys(releaseMutations).length} mutations rejected)`);
