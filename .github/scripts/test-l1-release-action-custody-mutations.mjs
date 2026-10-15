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
  })(),
  // Round-7b independent retest (PR1019, Medium): YAML lets the flow mapping
  // of a sequence entry start on the line after a lone `-` (optionally after a
  // comment), and a whole steps list can be a flow sequence, so `- {` alone
  // did not catch them. Each of these really sets the control on the step.
  ...Object.fromEntries([
    ['if: false', 'if'],
    ['continue-on-error: true', 'continue-on-error'],
    ['timeout-minutes: 0', 'timeout-minutes']
  ].flatMap(([control, label]) => {
    const start = workflow.indexOf('      - name: Attest release');
    const end = workflow.indexOf('      - name: Upload release', start);
    assert.ok(start >= 0 && end > start, 'attest/upload anchors missing');
    const step = (dash) => workflow.slice(0, start)
      + dash
      + `        { name: Attest release tarball, ${control},\n`
      + '          uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6,\n'
      + '          with: { subject-path: l1/release/SBOM.spdx.json }\n'
      + '        }\n\n'
      + workflow.slice(end);
    return [
      [`attest step as flow map after a lone dash with ${label}`, step('      -\n')],
      [`attest step as flow map after a dash and comment with ${label}`, step('      - # attest\n')]
    ];
  })),
  'whole steps list as a flow sequence with if:false on the test step': (() => {
    const start = workflow.indexOf('    steps:\n');
    assert.ok(start >= 0, 'steps anchor missing');
    const entry = (fields, run) => `      { ${fields},\n        run: ${run}\n      },\n`;
    return workflow.slice(0, start)
      + '    steps: [\n'
      + '      { name: Checkout code,\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1,\n        with: {\n          persist-credentials: false\n        }\n      },\n'
      + '      { name: Set up Node.js,\n        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1\n      },\n'
      + entry('name: Install', 'npm ci')
      + entry('name: Typecheck', 'npm run typecheck')
      + entry('name: Test, if: false', 'npm test')
      + entry('name: Audit', 'npm audit --omit=dev --audit-level=high')
      + entry('name: Build', 'npm run build')
      + entry('name: Release dir', 'mkdir -p release')
      + entry('name: Pack', 'npm pack --ignore-scripts --pack-destination release')
      + entry('name: SBOM', 'npm sbom --omit=dev --sbom-format=spdx > release/SBOM.spdx.json')
      + entry('name: Checksums, working-directory: l1/release', 'sha256sum SBOM.spdx.json zyronchain-l1-*.tgz > SHA256SUMS')
      + '      { name: Attest,\n        uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6\n      },\n'
      + '      { name: Upload,\n        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9\n      }\n'
      + '    ]\n';
  })()
};

for (const [name, mutated] of Object.entries(mutations)) {
  assert.throws(() => verifyL1ReleaseWorkflow(mutated), Error, `mutation must be rejected: ${name}`);
}
console.log(`l1-release-action-custody-mutations: ok (${Object.keys(mutations).length} mutations rejected)`);
