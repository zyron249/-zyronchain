#!/usr/bin/env node
// S2-3 T1: custody of .github/workflows/l1-t1-trust-append-only.yml, the
// pull_request_target job that runs main's append-only checker against a PR
// head read as git data only. pull_request_target runs with the base
// repository's token, so this is an ALLOWLIST: apart from full-line comments
// and blank lines, the workflow must equal EXPECTED_LINES exactly (trigger and
// types, top-level read-only permissions, no job-level permissions, the two
// pinned actions with persist-credentials false, and the exact run script
// that only fetches refs, reads the head with git show via the checker on
// main, and never checks out, installs, evaluates or executes head content).
// Any change to the workflow must change this list in the same reviewed PR.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export const T1_WORKFLOW_PATH = new URL('../workflows/l1-t1-trust-append-only.yml', import.meta.url);
export const EXPECTED_LINES = Object.freeze([
  "name: T1 Trust Append-Only (main checker)",
  "on:",
  "  pull_request_target:",
  "    branches: [main]",
  "    types: [opened, synchronize, reopened, edited]",
  "permissions:",
  "  contents: read",
  "concurrency:",
  "  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}",
  "  cancel-in-progress: true",
  "jobs:",
  "  t1-trust-append-only:",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 5",
  "    steps:",
  "      - name: Checkout main (trusted checker)",
  "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          persist-credentials: false",
  "          fetch-depth: 0",
  "      - name: Set up Node.js",
  "        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
  "        with:",
  "          node-version: 24",
  "      - name: Compare PR head trust files with the merge base with main (data only)",
  "        shell: bash",
  "        env:",
  "          PR_NUMBER: ${{ github.event.pull_request.number }}",
  "          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
  "        run: |",
  "          set -euo pipefail",
  "          [[ \"$PR_NUMBER\" =~ ^[0-9]+$ && \"$PR_HEAD_SHA\" =~ ^[0-9a-f]{40}$ ]]",
  "          git fetch --no-tags --quiet origin '+refs/heads/main:refs/remotes/origin/main' \"+refs/pull/$PR_NUMBER/head:refs/remotes/pr/head\"",
  "          git cat-file -e \"$PR_HEAD_SHA^{commit}\"",
  "          if [ ! -f l1/scripts/t1-trust-append-only.mjs ]; then",
  "            echo \"::error::main has no l1/scripts/t1-trust-append-only.mjs; the T1 trust check cannot run\"",
  "            exit 1",
  "          fi",
  "          node l1/scripts/t1-trust-append-only.mjs --merge-base origin/main --head \"$PR_HEAD_SHA\""
]);

/** Significant lines: no blank lines, no full-line comments, trailing spaces trimmed. */
export function significantLines(text) {
  if (/\r|\t/.test(text)) throw new Error('T1 append-only workflow: CR or TAB characters are not allowed');
  return text.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

export function verifyT1AppendOnlyWorkflow(text) {
  const actual = significantLines(text);
  const length = Math.max(actual.length, EXPECTED_LINES.length);
  for (let i = 0; i < length; i += 1) {
    if (actual[i] !== EXPECTED_LINES[i]) {
      throw new Error(`T1 append-only workflow: line ${i + 1} differs from the allowlisted shape (expected ${JSON.stringify(EXPECTED_LINES[i] ?? '<end>')}, found ${JSON.stringify(actual[i] ?? '<end>')})`);
    }
  }
  // Belt and braces on the allowlist itself (guards an edit of EXPECTED_LINES).
  const body = actual.join('\n');
  const runStart = actual.findIndex((line) => line.trim() === 'run: |');
  const run = actual.slice(runStart + 1).join('\n');
  if (!/^on:\n  pull_request_target:\n    branches: \[main\]\n    types: \[opened, synchronize, reopened, edited\]\npermissions:\n  contents: read\n/m.test(body)) throw new Error('T1 append-only workflow: trigger or permissions changed');
  if (/\$\{\{/.test(run) || /\bsecrets\./.test(body) || /^\s+ref:/m.test(body) || /^    permissions:/m.test(body)) throw new Error('T1 append-only workflow: forbidden construct');
  return true;
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  verifyT1AppendOnlyWorkflow(await readFile(T1_WORKFLOW_PATH, 'utf8'));
  console.log('l1-t1-trust-append-only-custody: ok');
}
