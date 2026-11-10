#!/usr/bin/env node
// Mutation tests for verify-supply-verifier-pin-guard-custody.mjs, the custody
// check of the pull_request_target pin-guard workflow. The real workflow must
// pass and every mutation below must be refused. Each mutation would let a PR
// run its own code, keep a token, widen permissions, use secrets, switch to a
// trigger that runs the PR's copy of the checker, or let the check pass
// without running. Cases tagged [lint] must also be refused by the static
// rules alone (lintPinGuardWorkflow), so an edit of EXPECTED_LINES that
// allowlists them still fails.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PIN_GUARD_WORKFLOW_PATH, lintPinGuardWorkflow, significantLines, verifyPinGuardWorkflow } from './verify-supply-verifier-pin-guard-custody.mjs';

const workflow = await readFile(PIN_GUARD_WORKFLOW_PATH, 'utf8');
assert.doesNotThrow(() => verifyPinGuardWorkflow(workflow), 'the real workflow must pass');
assert.doesNotThrow(() => verifyPinGuardWorkflow(`# extra comment\n\n${workflow}\n# trailing\n`), 'comments and blank lines are free');
assert.doesNotThrow(() => lintPinGuardWorkflow(significantLines(workflow)), 'the real workflow must pass the static rules');

const replaceOnce = (text, from, to) => { assert.ok(text.includes(from), `mutation anchor missing: ${from}`); return text.replace(from, to); };
const at = (anchor, insert) => replaceOnce(workflow, anchor, `${insert}${anchor}`);
const after = (anchor, insert) => replaceOnce(workflow, anchor, `${anchor}${insert}`);
const SETUP = '      - name: Set up Node.js\n';
const CHECK_STEP = '      - name: Check the PR head pin against the merge base with main (data only)\n';
const RUN_START = '          set -euo pipefail\n';
const BEFORE_CHECK = '          if [ ! -f .github/scripts/verify-supply-verifier-pin-guard.mjs ]; then\n';
const CHECKER = 'node .github/scripts/verify-supply-verifier-pin-guard.mjs --merge-base origin/main --head "$PR_HEAD_SHA"';
const NPM = '        run: npm ci --ignore-scripts --no-audit --no-fund\n';
const HEAD_CHECKOUT = '      - name: Checkout PR head\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          path: pr\n';

const mutations = {
  // Architect's required refusals.
  '[lint] npm ci in the run script': after(RUN_START, '          npm ci\n'),
  '[lint] npm install of the PR head after the fetch': at(BEFORE_CHECK, '          npm --prefix pr/l1 install\n'),
  '[lint] npm ci without --ignore-scripts': replaceOnce(workflow, NPM, '        run: npm ci --no-audit --no-fund\n'),
  '[lint] npx in the run script': at(BEFORE_CHECK, '          npx tsc -v\n'),
  '[lint] toolchain installed after the PR head is fetched': replaceOnce(replaceOnce(workflow, `      - name: Install main's l1 TypeScript toolchain (main's lockfile, no install scripts)\n        working-directory: l1\n${NPM}`, ''), '          git cat-file -e', `          (cd l1 && npm ci --ignore-scripts --no-audit --no-fund)\n          git cat-file -e`),
  '[lint] run: references a pr/ script': at(BEFORE_CHECK, '          node pr/tools/supply-verifier/pin-hash.mjs --print\n'),
  '[lint] run: references ./pr/ script': at(BEFORE_CHECK, '          bash ./pr/build.sh\n'),
  '[lint] checker run from a pr/ copy': replaceOnce(workflow, CHECKER, 'node pr/.github/scripts/verify-supply-verifier-pin-guard.mjs --merge-base origin/main --head "$PR_HEAD_SHA"'),
  '[lint] head checkout into pr/ without persist-credentials': at(SETUP, HEAD_CHECKOUT),
  '[lint] head checkout into pr/ with persist-credentials false': at(SETUP, `${HEAD_CHECKOUT}          persist-credentials: false\n`),
  '[lint] persist-credentials missing on the main checkout': replaceOnce(workflow, '          persist-credentials: false\n', ''),
  '[lint] persist-credentials true': replaceOnce(workflow, 'persist-credentials: false', 'persist-credentials: true'),
  '[lint] pull_request instead of pull_request_target': replaceOnce(workflow, '  pull_request_target:\n', '  pull_request:\n'),
  '[lint] pull_request added next to pull_request_target': replaceOnce(workflow, 'on:\n', 'on:\n  pull_request:\n'),
  '[lint] inline trigger list': replaceOnce(workflow, 'on:\n', 'on: [pull_request]\nx:\n'),
  '[lint] top-level contents: write': replaceOnce(workflow, 'permissions:\n  contents: read', 'permissions:\n  contents: write'),
  '[lint] extra top-level permission pull-requests: read': replaceOnce(workflow, 'permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  pull-requests: read\n'),
  '[lint] permissions: write-all': replaceOnce(workflow, 'permissions:\n  contents: read\n', 'permissions: write-all\n'),
  '[lint] job-level permissions': replaceOnce(workflow, '    runs-on: ubuntu-latest\n', '    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n'),
  '[lint] secrets in env': replaceOnce(workflow, '          PR_NUMBER:', '          TOK: ${{ secrets.X }}\n          PR_NUMBER:'),
  '[lint] GITHUB_TOKEN in env': replaceOnce(workflow, '          PR_NUMBER:', '          GH_TOKEN: ${{ github.token }}\n          PR_NUMBER:'),
  '[lint] token: on checkout': after('          fetch-depth: 0\n', '          token: ${{ secrets.PAT }}\n'),
  // Other unsafe shapes.
  '[lint] checkout of the head via ref:': after('          fetch-depth: 0\n', '          ref: ${{ github.event.pull_request.head.sha }}\n'),
  '[lint] head SHA interpolated into the run script': replaceOnce(workflow, CHECKER, 'node .github/scripts/verify-supply-verifier-pin-guard.mjs --merge-base origin/main --head ${{ github.event.pull_request.head.sha }}'),
  '[lint] title injection in the run script': after(RUN_START, '          echo "${{ github.event.pull_request.title }}"\n'),
  '[lint] mutable setup-node tag': replaceOnce(workflow, 'setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'setup-node@v4'),
  '[lint] mutable checkout tag': replaceOnce(workflow, 'checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'checkout@v4'),
  '[lint] local action': at(SETUP, '      - uses: ./.github/actions/x\n'),
  '[lint] npm cache on setup-node': after('          node-version-file: tools/supply-verifier/.nvmrc\n', '          cache: npm\n'),
  '[lint] step allowed to fail': replaceOnce(workflow, '        shell: bash\n', '        shell: bash\n        continue-on-error: true\n'),
  '[lint] step made conditional': replaceOnce(workflow, '        shell: bash\n', '        shell: bash\n        if: false\n'),
  '[lint] missing checker passes again': replaceOnce(workflow, '            exit 1\n', '            exit 0\n'),
  '[lint] checker run without the toolchain (rebuild skipped)': replaceOnce(workflow, ' --toolchain l1/node_modules --scratch "$RUNNER_TEMP/pin-guard"', ''),
  'checker failure ignored with || true': replaceOnce(workflow, '--scratch "$RUNNER_TEMP/pin-guard"\n', '--scratch "$RUNNER_TEMP/pin-guard" || true\n'),
  'set -e dropped': replaceOnce(workflow, RUN_START, '          set -uo pipefail\n'),
  'git archive of head scripts': at(BEFORE_CHECK, '          git archive "$PR_HEAD_SHA" tools | tar -x\n'),
  'git checkout of the head': after(RUN_START, '          git checkout "$PR_HEAD_SHA"\n'),
  'eval of git show output': at(BEFORE_CHECK, '          eval "$(git show "$PR_HEAD_SHA":x.sh)"\n'),
  'node runs a head script read with git show': replaceOnce(workflow, CHECKER, 'git show "$PR_HEAD_SHA":tools/supply-verifier/pin-hash.mjs | node --input-type=module'),
  'base branch other than main': replaceOnce(workflow, '    branches: [main]\n', '    branches: [main, "test/**"]\n'),
  'branch filter removed': replaceOnce(workflow, '    branches: [main]\n', ''),
  'label events removed': replaceOnce(workflow, 'types: [opened, synchronize, reopened, labeled, unlabeled]', 'types: [opened, synchronize, reopened]'),
  'workflow_dispatch trigger added': after('    types: [opened, synchronize, reopened, labeled, unlabeled]\n', '  workflow_dispatch:\n'),
  'second step before the check': at(CHECK_STEP, '      - name: hi\n        run: echo hi\n'),
  'CR line endings': workflow.replace(/\n/g, '\r\n'),
  'TAB indentation smuggled in': replaceOnce(workflow, '          set -euo pipefail', '\tset -euo pipefail'),
  'flow-style step added': at(SETUP, '      - {name: x, run: "bash -c \\"$(git show HEAD:x)\\""}\n'),
};

let lintOnly = 0;
for (const [name, mutated] of Object.entries(mutations)) {
  assert.notEqual(mutated, workflow, `${name}: the mutation changed nothing`);
  assert.throws(() => verifyPinGuardWorkflow(mutated), /supply-verifier pin guard workflow/, `${name} must be refused`);
  if (name.startsWith('[lint]')) {
    assert.throws(() => lintPinGuardWorkflow(significantLines(mutated)), /supply-verifier pin guard workflow/, `${name} must be refused by the static rules alone`);
    lintOnly += 1;
  }
}
console.log(`supply-verifier pin guard custody mutations: ${Object.keys(mutations).length} refused (${lintOnly} also by the static rules alone)`);
