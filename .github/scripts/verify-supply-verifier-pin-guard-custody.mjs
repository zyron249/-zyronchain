#!/usr/bin/env node
// Custody of .github/workflows/supply-verifier-pin-guard.yml, the
// pull_request_target job that runs main's pin-guard checker against a PR head
// read as git data only. pull_request_target runs with the base repository's
// token, so this is an ALLOWLIST: apart from full-line comments and blank
// lines, the workflow must equal EXPECTED_LINES exactly (trigger, branch and
// types; top-level contents: read only; no job-level permissions; the two
// pinned actions; one checkout of main with persist-credentials false; one
// install of main's l1 toolchain with --ignore-scripts; the exact run script
// that only fetches refs and runs the checker from main).
// On top of the allowlist, static rules refuse the dangerous shapes even if
// EXPECTED_LINES itself is edited: npm/npx/yarn/pnpm other than the single
// `npm ci --ignore-scripts` of MAIN's l1 lockfile that runs before any PR
// data is fetched, setup-node caching, any reference to a
// pr/ checkout directory, a checkout without persist-credentials: false, a
// pull_request trigger, extra or job-level permissions, secrets or the token,
// a run script that writes files or puts PR content on disk (for example a
// fallback to the PR's l1/package-lock.json),
// ${{ }} in the run script, ref:, if:, continue-on-error.
// Any change to the workflow must change this list in the same reviewed PR.
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PIN_GUARD_WORKFLOW_PATH = new URL('../workflows/supply-verifier-pin-guard.yml', import.meta.url);
export const EXPECTED_LINES = Object.freeze([
  "name: Supply Verifier Pin Guard (main checker)",
  "on:",
  "  pull_request_target:",
  "    branches: [main]",
  "    types: [opened, synchronize, reopened, labeled, unlabeled]",
  "permissions:",
  "  contents: read",
  "concurrency:",
  "  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}",
  "  cancel-in-progress: true",
  "jobs:",
  "  supply-verifier-pin-guard:",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 10",
  "    steps:",
  "      - name: Checkout main (trusted checker)",
  "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          persist-credentials: false",
  "          fetch-depth: 0",
  "      - name: Set up Node.js",
  "        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
  "        with:",
  "          node-version-file: tools/supply-verifier/.nvmrc",
  "      - name: Install main's l1 TypeScript toolchain (main's lockfile, no install scripts)",
  "        working-directory: l1",
  "        run: npm ci --ignore-scripts --no-audit --no-fund",
  "      - name: Check the PR head pin against the merge base with main (data only)",
  "        shell: bash",
  "        env:",
  "          PR_NUMBER: ${{ github.event.pull_request.number }}",
  "          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
  "        run: |",
  "          set -euo pipefail",
  "          [[ \"$PR_NUMBER\" =~ ^[0-9]+$ && \"$PR_HEAD_SHA\" =~ ^[0-9a-f]{40}$ ]]",
  "          git fetch --no-tags --quiet origin '+refs/heads/main:refs/remotes/origin/main' \"+refs/pull/$PR_NUMBER/head:refs/remotes/pr/head\"",
  "          git cat-file -e \"$PR_HEAD_SHA^{commit}\"",
  "          if [ ! -f .github/scripts/verify-supply-verifier-pin-guard.mjs ]; then",
  "            echo \"::error::main has no .github/scripts/verify-supply-verifier-pin-guard.mjs; the pin guard cannot run\"",
  "            exit 1",
  "          fi",
  "          node .github/scripts/verify-supply-verifier-pin-guard.mjs --merge-base origin/main --head \"$PR_HEAD_SHA\" --event \"$GITHUB_EVENT_PATH\" --toolchain l1/node_modules --scratch \"$RUNNER_TEMP/pin-guard\""
]);

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1';

function fail(reason) { throw new Error(`supply-verifier pin guard workflow: ${reason}`); }

/** Significant lines: no blank lines, no full-line comments, trailing spaces trimmed. */
export function significantLines(text) {
  if (/\r|\t/.test(text)) fail('CR or TAB characters are not allowed');
  return text.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

/** Static rules, independent of EXPECTED_LINES. */
export function lintPinGuardWorkflow(lines) {
  const body = lines.join('\n');
  const runStart = lines.findIndex((line) => line.trim() === 'run: |');
  if (runStart < 0) fail('no run block');
  const run = lines.slice(runStart + 1).join('\n');
  if (!/^on:\n  pull_request_target:\n    branches: \[main\]\n    types: \[opened, synchronize, reopened, labeled, unlabeled\]\npermissions:\n  contents: read\nconcurrency:/m.test(body)) fail('trigger, branches, types or top-level permissions changed');
  if (/^\s*-?\s*pull_request\s*:/m.test(body) || /\bpull_request\s*[,\]]/.test(body) || /^on:[ ]*\S/m.test(body)) fail('pull_request (or another inline trigger) is not allowed; use pull_request_target only');
  if (/^\s+permissions\s*:/m.test(body)) fail('job-level permissions are not allowed');
  const NPM_LINE = '        run: npm ci --ignore-scripts --no-audit --no-fund';
  const npmAt = lines.indexOf(NPM_LINE);
  const withoutNpm = lines.filter((line, i) => i !== npmAt).join('\n');
  if (/\bnpm\b|\bnpx\b|\byarn\b|\bpnpm\b|\bcorepack\b|\bnode_modules\/\.bin\b/.test(withoutNpm.replace('--toolchain l1/node_modules', ''))) fail('npm and other package managers are not allowed (only the one npm ci --ignore-scripts of main\'s l1 lockfile)');
  if (npmAt < 0 || lines[npmAt - 1] !== '        working-directory: l1' || npmAt > lines.findIndex((line) => line.includes('git fetch'))) fail('the toolchain install must be npm ci --ignore-scripts in l1/, before any PR data is fetched');
  if (/\bcache\s*:|\bcache-dependency-path\b/.test(body)) fail('setup-node caching is not allowed');
  if ((body.match(/working-directory/g) ?? []).length !== 1) fail('only the toolchain install may set working-directory');
  if (/(?<![\w/.-])(?:\.\/)?pr\//.test(body) || /\bpath\s*:/.test(body)) fail('a pr/ checkout directory (or any checkout path) is not allowed');
  if (/\bsecrets\b|github\.token|GITHUB_TOKEN|\btoken\s*:/.test(body)) fail('secrets and tokens are not allowed');
  if (/\$\{\{/.test(run)) fail('${{ }} expressions are not allowed in the run script');
  // No PR-lockfile fallback and no PR files on disk: the run script never
  // writes files or materializes head content (main's l1/package-lock.json is
  // the only lockfile the toolchain install and the checker may see).
  if (/>/.test(run) || /\bgit\s+(?:show|archive|checkout|restore|switch|worktree|read-tree|checkout-index|apply|am|merge|reset|stash)\b/.test(run) || /\b(?:cp|mv|tee|install|ln|dd|curl|wget)\b/.test(run)) fail('the run script must not write files or put PR content on disk (no PR-lockfile fallback)');
  if (/^\s+ref\s*:/m.test(body) || /^\s+(?:-\s+)?if\s*:/m.test(body) || /continue-on-error/.test(body)) fail('ref:, if: and continue-on-error are not allowed');
  const uses = [...body.matchAll(/\buses\s*:\s*(\S+)/g)].map((m) => m[1]);
  if (uses.length !== 2 || uses[0] !== CHECKOUT || uses[1] !== SETUP_NODE) fail('only the pinned checkout and setup-node actions are allowed, once each');
  const checkoutAt = lines.findIndex((line) => line.includes(CHECKOUT));
  if (lines[checkoutAt + 1] !== '        with:' || lines[checkoutAt + 2] !== '          persist-credentials: false') fail('the checkout must set persist-credentials: false');
  if ((body.match(/persist-credentials/g) ?? []).length !== 1 || /persist-credentials:(?! false$)/m.test(body)) fail('persist-credentials must appear once, as false');
  if (!/^          node \.github\/scripts\/verify-supply-verifier-pin-guard\.mjs --merge-base origin\/main --head "\$PR_HEAD_SHA" --event "\$GITHUB_EVENT_PATH" --toolchain l1\/node_modules --scratch "\$RUNNER_TEMP\/pin-guard"$/m.test(run)) fail('the checker must run from main with the head SHA and the event payload');
  if (!/^          set -euo pipefail$/m.test(run) || !/^            exit 1$/m.test(run)) fail('the run script must fail closed');
}

export function verifyPinGuardWorkflow(text) {
  const actual = significantLines(text);
  const length = Math.max(actual.length, EXPECTED_LINES.length);
  for (let i = 0; i < length; i += 1) {
    if (actual[i] !== EXPECTED_LINES[i]) {
      fail(`line ${i + 1} differs from the allowlisted shape (expected ${JSON.stringify(EXPECTED_LINES[i] ?? '<end>')}, found ${JSON.stringify(actual[i] ?? '<end>')})`);
    }
  }
  lintPinGuardWorkflow(actual);
  return true;
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  verifyPinGuardWorkflow(await readFile(PIN_GUARD_WORKFLOW_PATH, 'utf8'));
  console.log('supply-verifier-pin-guard-custody: ok');
}
