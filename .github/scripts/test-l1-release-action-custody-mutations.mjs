#!/usr/bin/env node
// F-08 mutation tests: the release-policy verifier must reject workflows in
// which a required step is commented out, made conditional, or allowed to
// fail, and must still accept the real workflow.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyL1ReleaseWorkflow } from './verify-l1-release-action-custody.mjs';

const workflow = await readFile(new URL('../workflows/l1-release.yml', import.meta.url), 'utf8');
assert.doesNotThrow(() => verifyL1ReleaseWorkflow(workflow), 'the real release workflow must pass');

const replaceOnce = (text, from, to) => {
  assert.ok(text.includes(from), `mutation anchor missing: ${from}`);
  return text.replace(from, to);
};

const mutations = {
  'npm test commented out': replaceOnce(workflow, '        run: npm test', '        # run: npm test\n        run: echo skipped'),
  'npm test moved into a comment string': replaceOnce(workflow, '        run: npm test', '        run: echo ok # npm test'),
  'typecheck commented out': replaceOnce(workflow, '        run: npm run typecheck', '        run: echo skipped # npm run typecheck'),
  'test step allowed to fail': replaceOnce(workflow, '        run: npm test', '        continue-on-error: true\n        run: npm test'),
  'test step made conditional': replaceOnce(workflow, '        run: npm test', "        if: ${{ false }}\n        run: npm test"),
  'audit removed': replaceOnce(workflow, 'npm audit --omit=dev --audit-level=high', 'echo audit'),
  'credential persistence enabled': replaceOnce(workflow, 'persist-credentials: false', 'persist-credentials: true'),
  // Round-6 independent retest (PR1013, Info): YAML reads a quoted key as the
  // same key, so these were accepted before.
  'test step allowed to fail under a quoted key': replaceOnce(workflow, '        run: npm test', '        "continue-on-error": true\n        run: npm test'),
  'test step made conditional under a quoted key': replaceOnce(workflow, '        run: npm test', "        'if': false\n        run: npm test"),
  'test step with a zero timeout under a quoted key': replaceOnce(workflow, '        run: npm test', '        "timeout-minutes": 0\n        run: npm test'),
  // Round-7 independent retest (PR1016, Medium): flow-style steps put keys
  // inside `{...}`, so the line-start quoted/tag/explicit checks miss them.
  'attest step as flow map with if:false': (() => {
    const start = workflow.indexOf('      - name: Attest release');
    const end = workflow.indexOf('      - name: Upload release', start);
    assert.ok(start >= 0 && end > start, 'attest/upload anchors missing');
    return workflow.slice(0, start)
      + '      - {name: Attest release tarball, if: false, uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6, with: {subject-path: l1/release/SBOM.spdx.json}}\n'
      + workflow.slice(end);
  })(),
  'attest step as flow map with quoted timeout-minutes:0': (() => {
    const start = workflow.indexOf('      - name: Attest release');
    const end = workflow.indexOf('      - name: Upload release', start);
    assert.ok(start >= 0 && end > start, 'attest/upload anchors missing');
    return workflow.slice(0, start)
      + '      - {name: Attest release tarball, "timeout-minutes": 0, uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6, with: {subject-path: l1/release/SBOM.spdx.json}}\n'
      + workflow.slice(end);
  })(),
  'attest step as flow map with continue-on-error:true': (() => {
    const start = workflow.indexOf('      - name: Attest release');
    const end = workflow.indexOf('      - name: Upload release', start);
    assert.ok(start >= 0 && end > start, 'attest/upload anchors missing');
    return workflow.slice(0, start)
      + '      - {name: Attest release tarball, continue-on-error: true, uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6, with: {subject-path: l1/release/SBOM.spdx.json}}\n'
      + workflow.slice(end);
  })()
};

for (const [name, mutated] of Object.entries(mutations)) {
  assert.throws(() => verifyL1ReleaseWorkflow(mutated), Error, `mutation must be rejected: ${name}`);
}
console.log(`l1-release-action-custody-mutations: ok (${Object.keys(mutations).length} mutations rejected)`);
