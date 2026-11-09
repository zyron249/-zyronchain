#!/usr/bin/env node
// S2-3 T1 mutation tests: the custody verifier of the pull_request_target
// workflow (verify-l1-t1-trust-append-only-custody.mjs) must accept the real
// workflow and refuse every mutation below (each one would let a PR run its
// own code, widen the token, add a trigger, inject event text, or skip the
// check).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { T1_WORKFLOW_PATH, verifyT1AppendOnlyWorkflow } from './verify-l1-t1-trust-append-only-custody.mjs';

const workflow = await readFile(T1_WORKFLOW_PATH, 'utf8');
assert.doesNotThrow(() => verifyT1AppendOnlyWorkflow(workflow), 'the real workflow must pass');
// Comments and blank lines may change.
assert.doesNotThrow(() => verifyT1AppendOnlyWorkflow(`# extra comment\n\n${workflow}\n# trailing\n`), 'comments and blank lines are free');

const replaceOnce = (text, from, to) => {
  assert.ok(text.includes(from), `mutation anchor missing: ${from}`);
  return text.replace(from, to);
};
const at = (anchor, insert) => replaceOnce(workflow, anchor, `${insert}${anchor}`);
const after = (anchor, insert) => replaceOnce(workflow, anchor, `${anchor}${insert}`);
const SETUP = '      - name: Set up Node.js\n';
const RUN_START = '          set -euo pipefail\n';
const BEFORE_CHECK = '          if [ ! -f l1/scripts/t1-trust-append-only.mjs ]; then\n';
const CHECKER = 'node l1/scripts/t1-trust-append-only.mjs --merge-base origin/main --head "$PR_HEAD_SHA"';

const mutations = {
  // Earlier round (8 cases).
  'checkout of the head via ref:': after('          fetch-depth: 0\n', '          ref: ${{ github.event.pull_request.head.sha }}\n'),
  'top-level contents: write': replaceOnce(workflow, 'permissions:\n  contents: read', 'permissions:\n  contents: write'),
  'credential persistence enabled': replaceOnce(workflow, 'persist-credentials: false', 'persist-credentials: true'),
  'npm ci of the head': after(RUN_START, '          npm ci\n'),
  'git checkout of the head': after(RUN_START, '          git checkout "$PR_HEAD_SHA"\n'),
  'head SHA interpolated into the run script': replaceOnce(workflow, CHECKER, 'node l1/scripts/t1-trust-append-only.mjs --merge-base origin/main --head ${{ github.event.pull_request.head.sha }}'),
  'mutable setup-node tag': replaceOnce(workflow, 'setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'setup-node@v4'),
  'extra top-level permission': replaceOnce(workflow, 'permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  pull-requests: write\n'),
  // Security's 13 cases.
  'S1 checkout head via ref:': after('          fetch-depth: 0\n', '          ref: ${{ github.event.pull_request.head.ref }}\n'),
  'S2 npm ci': after(RUN_START, '          npm ci\n'),
  'S3 extract head scripts via git archive': at(BEFORE_CHECK, '          git archive "$PR_HEAD_SHA" l1/scripts | tar -x\n'),
  'S4 git restore --source head': at(BEFORE_CHECK, '          git restore --source="$PR_HEAD_SHA" -- l1/scripts\n'),
  'S5 job-level permissions write-all': replaceOnce(workflow, '    runs-on: ubuntu-latest\n', '    permissions: write-all\n    runs-on: ubuntu-latest\n'),
  'S6 job-level contents: write': replaceOnce(workflow, '    runs-on: ubuntu-latest\n', '    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n'),
  'S7 title injection in an earlier one-line run': at(SETUP, '      - name: hi\n        run: echo "${{ github.event.pull_request.title }}"\n'),
  'S8 workflow_dispatch trigger added': after('    types: [opened, synchronize, reopened, edited]\n', '  workflow_dispatch:\n'),
  'S9 local action': at(SETUP, '      - uses: ./.github/actions/x\n'),
  'S10 secrets in env': replaceOnce(workflow, '          PR_NUMBER:', '          TOK: ${{ secrets.X }}\n          PR_NUMBER:'),
  'S11 head.ref in run': replaceOnce(workflow, RUN_START, '          echo ${{ github.event.pull_request.head.ref }}\n'),
  'S12 bash eval of a head file': at(BEFORE_CHECK, '          bash -c "$(git show $PR_HEAD_SHA:x.sh)"\n'),
  'S13 second checkout (persisted token)': at(SETUP, '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n'),
  // Further shapes.
  'eval of git show output': at(BEFORE_CHECK, '          eval "$(git show "$PR_HEAD_SHA":l1/scripts/x.sh)"\n'),
  'node runs a head script read with git show': replaceOnce(workflow, CHECKER, 'git show "$PR_HEAD_SHA":l1/scripts/t1-trust-append-only.mjs | node --input-type=module'),
  'checker given the head checkout': replaceOnce(workflow, CHECKER, 'git worktree add head "$PR_HEAD_SHA" && node head/l1/scripts/t1-trust-append-only.mjs --merge-base origin/main'),
  'missing checker passes again': replaceOnce(workflow, '            exit 1\n', '            exit 0\n'),
  'base branch other than main': replaceOnce(workflow, '    branches: [main]\n', '    branches: [main, "test/**"]\n'),
  'branch filter removed': replaceOnce(workflow, '    branches: [main]\n', ''),
  'extra trigger type': replaceOnce(workflow, 'types: [opened, synchronize, reopened, edited]', 'types: [opened, synchronize, reopened, edited, labeled]'),
  'pull_request trigger added': replaceOnce(workflow, 'on:\n', 'on:\n  push:\n'),
  'step allowed to fail': replaceOnce(workflow, '        shell: bash\n', '        shell: bash\n        continue-on-error: true\n'),
  'step made conditional': replaceOnce(workflow, '        shell: bash\n', '        shell: bash\n        if: false\n'),
  'npm cache enabled on setup-node': after('          node-version: 24\n', '          cache: npm\n'),
  'CR line endings': workflow.replace(/\n/g, '\r\n'),
  'TAB indentation smuggled in': replaceOnce(workflow, '          set -euo pipefail', '\tset -euo pipefail'),
  'flow-style step added': at(SETUP, '      - {name: x, run: "bash -c \\"$(git show HEAD:x)\\""}\n'),
};

for (const [name, mutated] of Object.entries(mutations)) {
  assert.notEqual(mutated, workflow, `${name}: the mutation changed nothing`);
  assert.throws(() => verifyT1AppendOnlyWorkflow(mutated), /T1 append-only workflow/, `${name} must be refused`);
}
console.log(`l1-t1-trust-append-only custody mutations: ${Object.keys(mutations).length} refused`);
