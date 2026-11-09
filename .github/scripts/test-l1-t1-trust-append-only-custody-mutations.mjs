#!/usr/bin/env node
// S2-3 T1 mutation tests: the custody verifier of the pull_request_target
// workflow (verify-l1-t1-trust-append-only-custody.mjs) must accept the real
// workflow and refuse every mutation below (each one would let a PR run its
// own code, widen the token, add a trigger, inject event text, or skip the
// check).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { L1_WORKFLOW_PATH, T1_WORKFLOW_PATH, verifyL1JobT1Prefix, verifyT1AppendOnlyWorkflow } from './verify-l1-t1-trust-append-only-custody.mjs';

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
  'push trigger added': replaceOnce(workflow, 'on:\n', 'on:\n  push:\n'),
  'pull_request trigger added': replaceOnce(workflow, 'on:\n', 'on:\n  pull_request:\n'),
  'step allowed to fail': replaceOnce(workflow, '        shell: bash\n', '        shell: bash\n        continue-on-error: true\n'),
  'step made conditional': replaceOnce(workflow, '        shell: bash\n', '        shell: bash\n        if: false\n'),
  'npm cache enabled on setup-node': after('          node-version: 24\n', '          cache: npm\n'),
  'CR line endings': workflow.replace(/\n/g, '\r\n'),
  'TAB indentation smuggled in': replaceOnce(workflow, '          set -euo pipefail', '\tset -euo pipefail'),
  // Round 4 (M1-R1e): byte rules. Only ASCII, only LF, only `^ *#` comments,
  // and never inside a run block.
  'NBSP-prefixed # line inside the run block': at(BEFORE_CHECK, '          \u00A0# || echo PWNED\n'),
  'BOM-prefixed # line inside the run block': at(BEFORE_CHECK, '          \uFEFF# || echo PWNED\n'),
  'BOM at the start of the file': `\uFEFF${workflow}`,
  'U+2028 inside a comment line hiding a key': replaceOnce(workflow, '# S2-3 T1', '# S2-3\u2028permissions: write-all T1'),
  'U+2029 inside a comment line': replaceOnce(workflow, '# S2-3 T1', '# S2-3\u2029jobs: {} T1'),
  'NEL (U+0085) inside a comment line': replaceOnce(workflow, '# S2-3 T1', '# S2-3\u0085jobs: {} T1'),
  'vertical-tab-prefixed # line inside the run block': at(BEFORE_CHECK, '          \u000B# || echo PWNED\n'),
  'form-feed-prefixed # line inside the run block': at(BEFORE_CHECK, '          \u000C# || echo PWNED\n'),
  'NUL byte': replaceOnce(workflow, '    timeout-minutes: 5\n', '    timeout-minutes: 5\u0000\n'),
  'trailing NBSP on a line': replaceOnce(workflow, '    timeout-minutes: 5\n', '    timeout-minutes: 5\u00A0\n'),
  'Cyrillic lookalike in an action owner': replaceOnce(workflow, 'uses: actions/setup-node@', 'uses: \u0430ctions/setup-node@'),
  'extra ASCII comment line inside the run block': at(BEFORE_CHECK, '          # harmless? bash comments are part of the allowlisted script\n'),
  'run-block comment removed': replaceOnce(workflow, "          # A later push may already have moved refs/pull/N/head; the event's\n", ''),
  'flow-style step added': at(SETUP, '      - {name: x, run: "bash -c \\"$(git show HEAD:x)\\""}\n'),
};

for (const [name, mutated] of Object.entries(mutations)) {
  assert.notEqual(mutated, workflow, `${name}: the mutation changed nothing`);
  assert.throws(() => verifyT1AppendOnlyWorkflow(mutated), /T1 append-only workflow/, `${name} must be refused`);
}

// ---- l1.yml: the defence-in-depth T1 step (CI-1) ------------------------------
const l1 = await readFile(L1_WORKFLOW_PATH, 'utf8');
assert.doesNotThrow(() => verifyL1JobT1Prefix(l1), 'the real l1.yml must pass');
const l1Replace = (from, to) => replaceOnce(l1, from, to);
const T1_NAME = '      - name: T1 trust files are append-only (trusted checker from main)\n';
const T1_IF = "        if: github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main')\n";
const NPM_CI = '      - name: Install locked dependencies\n        run: npm ci\n';
const L1_JOB = '\n  l1:\n';
const inL1Job = (from, to) => {
  const job = l1.indexOf(L1_JOB);
  const at = l1.indexOf(from, job);
  assert.ok(job >= 0 && at > job && at < l1.indexOf(T1_NAME), `l1 mutation anchor missing: ${from}`);
  return l1.slice(0, at) + to + l1.slice(at + from.length);
};
const beforeT1 = (insert) => l1Replace(T1_NAME, `${insert}${T1_NAME}`);
const t1Start = l1.indexOf(T1_NAME);
const t1End = l1.indexOf(NPM_CI, t1Start);
const t1Block = l1.slice(t1Start, t1End);
const l1Mutations = {
  'T1 step moved after npm ci': l1.slice(0, t1Start) + NPM_CI + t1Block + l1.slice(t1End + NPM_CI.length),
  'moved, with a decoy comment naming the T1 step before npm ci': l1.slice(0, t1Start) + '      # - name: T1 trust files are append-only (trusted checker from main)\n' + NPM_CI + t1Block + l1.slice(t1End + NPM_CI.length),
  'npm install step before T1': beforeT1('      - name: Install\n        run: npm install\n'),
  'npm ci inside a run: | block before T1': beforeT1('      - name: Pre\n        run: |\n          npm ci\n'),
  'npx before T1': beforeT1('      - name: Pre\n        run: npx something\n'),
  'yarn install before T1': beforeT1('      - name: Pre\n        run: yarn install\n'),
  'pnpm i before T1': beforeT1('      - name: Pre\n        run: pnpm i\n'),
  'node script before T1': beforeT1('      - name: Pre\n        run: node scripts/anything.mjs\n'),
  'bash script before T1': beforeT1('      - name: Pre\n        run: bash ./x.sh\n'),
  'quoted run key before T1': beforeT1('      - name: Pre\n        "run": npm ci\n'),
  'flow-style step before T1': beforeT1('      - {name: Pre, run: npm ci}\n'),
  'local action before T1': beforeT1('      - name: Pre\n        uses: ./.github/actions/x\n'),
  'T1 step if: false': l1Replace(T1_IF, '        if: false\n'),
  'T1 step if: always()': l1Replace(T1_IF, "        if: always() && github.event_name == 'pull_request'\n"),
  'T1 step if removed': l1Replace(T1_IF, ''),
  'T1 step continue-on-error before run': l1Replace('        shell: bash\n        env:\n          T1_EVENT', '        shell: bash\n        continue-on-error: true\n        env:\n          T1_EVENT'),
  'T1 step continue-on-error after the run block': l1.slice(0, t1End) + '        continue-on-error: true\n' + l1.slice(t1End),
  'T1 step BASH_ENV in step env': l1Replace('          T1_EVENT: ${{ github.event_name }}\n', '          T1_EVENT: ${{ github.event_name }}\n          BASH_ENV: ./evil.sh\n'),
  'job-level env BASH_ENV': l1Replace(L1_JOB + '    runs-on: ubuntu-latest\n', L1_JOB + '    env:\n      BASH_ENV: ./evil.sh\n    runs-on: ubuntu-latest\n'),
  'workflow-level env BASH_ENV': l1Replace('\njobs:\n', '\nenv:\n  BASH_ENV: ./evil.sh\njobs:\n'),
  'workflow-level defaults shell': l1Replace('\njobs:\n', '\ndefaults:\n  run:\n    shell: bash -c "./x {0}"\njobs:\n'),
  'job container': l1Replace(L1_JOB + '    runs-on: ubuntu-latest\n', L1_JOB + '    runs-on: ubuntu-latest\n    container: attacker/image\n'),
  'setup-node cache path changed in the l1 job': inL1Job('cache-dependency-path: l1/package-lock.json', 'cache-dependency-path: x/package-lock.json'),
  'checkout fetch-depth changed in the l1 job': inL1Job('fetch-depth: 0', 'fetch-depth: 1'),
  'NBSP # line inside the T1 run block': l1Replace('          checker="$RUNNER_TEMP', '          \u00A0# || ./evil.sh\n          checker="$RUNNER_TEMP'),
  'checker taken from the change instead of main': l1Replace('            git show "$trusted_ref:l1/scripts/t1-trust-append-only.mjs" > "$checker"', '            cp scripts/t1-trust-append-only.mjs "$checker"'),
  'CR line endings in l1.yml': l1.replace(/\n/g, '\r\n'),
};
for (const [name, mutated] of Object.entries(l1Mutations)) {
  assert.notEqual(mutated, l1, `${name}: the mutation changed nothing`);
  assert.throws(() => verifyL1JobT1Prefix(mutated), /Standalone L1 T1 step/, `l1.yml: ${name} must be refused`);
}
console.log(`l1-t1-trust-append-only custody mutations: ${Object.keys(mutations).length} (pull_request_target workflow) + ${Object.keys(l1Mutations).length} (l1.yml) refused`);
