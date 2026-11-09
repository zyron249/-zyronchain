#!/usr/bin/env node
// S2-3 T1: custody of .github/workflows/l1-t1-trust-append-only.yml, the
// pull_request_target job that runs main's append-only checker against a PR
// head read as git data only. pull_request_target runs with the base
// repository's token, so this is an ALLOWLIST: the file must be ASCII with no
// control character but LF, and apart from blank lines and `^ *#` comment
// lines outside block scalars, it must equal EXPECTED_LINES exactly (trigger and
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
  "          # A later push may already have moved refs/pull/N/head; the event's",
  "          # head SHA is still in its history (that run is then superseded).",
  "          git cat-file -e \"$PR_HEAD_SHA^{commit}\"",
  "          if [ ! -f l1/scripts/t1-trust-append-only.mjs ]; then",
  "            echo \"::error::main has no l1/scripts/t1-trust-append-only.mjs; the T1 trust check cannot run\"",
  "            exit 1",
  "          fi",
  "          node l1/scripts/t1-trust-append-only.mjs --merge-base origin/main --head \"$PR_HEAD_SHA\""
]);

// .github/workflows/l1.yml, job `l1`: everything from the job key through the
// T1 step must be exactly these lines, so the T1 step is the third step,
// after only the pinned checkout and setup-node (no run:, no install, no
// script of the change before it), with its exact if:, env and script.
export const L1_WORKFLOW_PATH = new URL('../workflows/l1.yml', import.meta.url);
export const EXPECTED_L1_JOB_PREFIX = Object.freeze([
  "  l1:",
  "    runs-on: ubuntu-latest",
  "    strategy:",
  "      fail-fast: false",
  "      matrix:",
  "        node-version: [22, 24]",
  "    defaults:",
  "      run:",
  "        working-directory: l1",
  "    steps:",
  "      - name: Checkout code",
  "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          persist-credentials: false",
  "          fetch-depth: 0",
  "      - name: Set up Node.js",
  "        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
  "        with:",
  "          node-version: ${{ matrix.node-version }}",
  "          cache: npm",
  "          cache-dependency-path: l1/package-lock.json",
  "      - name: T1 trust files are append-only (trusted checker from main)",
  "        if: github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main')",
  "        shell: bash",
  "        env:",
  "          T1_EVENT: ${{ github.event_name }}",
  "          T1_PUSH_BEFORE: ${{ github.event.before }}",
  "        run: |",
  "          set -euo pipefail",
  "          if [ \"$(git rev-parse --is-shallow-repository)\" = true ]; then git fetch --no-tags --quiet --unshallow origin; fi",
  "          git fetch --no-tags --quiet origin '+refs/heads/main:refs/remotes/origin/main'",
  "          if [ \"$T1_EVENT\" = pull_request ]; then",
  "            trusted_ref=$(git merge-base origin/main HEAD)",
  "            mode=(--merge-base origin/main)",
  "          else",
  "            trusted_ref=\"$T1_PUSH_BEFORE\"",
  "            if [[ \"$trusted_ref\" =~ ^0+$ ]] || ! git rev-parse --verify --quiet \"$trusted_ref^{commit}\" >/dev/null; then trusted_ref=HEAD^1; fi",
  "            mode=(--push-before \"$T1_PUSH_BEFORE\")",
  "          fi",
  "          checker=\"$RUNNER_TEMP/t1-trust-append-only.trusted.mjs\"",
  "          if git cat-file -e \"$trusted_ref:l1/scripts/t1-trust-append-only.mjs\" 2>/dev/null; then",
  "            git show \"$trusted_ref:l1/scripts/t1-trust-append-only.mjs\" > \"$checker\"",
  "            echo \"Running the trusted checker from $trusted_ref\"",
  "          else",
  "            echo \"::warning::Bootstrap: $trusted_ref has no l1/scripts/t1-trust-append-only.mjs yet; running this change's own copy\"",
  "            cp scripts/t1-trust-append-only.mjs \"$checker\"",
  "          fi",
  "          node \"$checker\" \"${mode[@]}\""
]);

export function assertWorkflowBytes(text, label) {
  if (/[^\x00-\x7f]/.test(text)) throw new Error(`${label}: non-ASCII characters are not allowed (NBSP, BOM, U+2028 and lookalikes included)`);
  if (/[\x00-\x09\x0b-\x1f\x7f]/.test(text)) throw new Error(`${label}: control characters other than LF are not allowed (CR, TAB, VT, FF included)`);
}
/**
 * Significant lines of an ASCII workflow: trailing ASCII spaces are trimmed;
 * blank lines and comment lines (only `^ *#`) are dropped, except inside a
 * block scalar (a line ending in `: |` or `: >`, any chomping/indent
 * indicator, tag, anchor or trailing comment), whose lines are all kept,
 * comments included (bash runs them).
 */
export function significantLines(text, label) {
  assertWorkflowBytes(text, label);
  const out = [];
  let blockIndent = -1;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/ +$/, '');
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line === '' || indent > blockIndent) { if (line !== '') out.push(line); continue; }
      blockIndent = -1;
    }
    if (line === '' || /^ *#/.test(line)) continue;
    out.push(line);
    const block = /^( *)(- +)?[^#]*?: +(?:[!&]\S* +)*[|>][-+0-9]*(?: +#.*)?$/.exec(line);
    if (block) blockIndent = block[1].length + (block[2] ? block[2].length : 0);
  }
  return out;
}

export function verifyT1AppendOnlyWorkflow(text) {
  const actual = significantLines(text, 'T1 append-only workflow');
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

/**
 * Structural check of l1.yml (defence-in-depth T1 step): ASCII and LF-only
 * bytes; no workflow-level env or defaults (BASH_ENV, shell overrides); the
 * `l1` job, parsed by its own indentation, begins with EXPECTED_L1_JOB_PREFIX
 * (header, checkout, setup-node, T1 step), and every step entry of the job
 * is a block mapping that starts with `- name:`.
 */
export function verifyL1JobT1Prefix(text) {
  const label = 'Standalone L1 T1 step';
  const lines = significantLines(text, label);
  const jobsAt = lines.indexOf('jobs:');
  if (jobsAt < 0) throw new Error(`${label}: no jobs`);
  if (lines.slice(0, jobsAt).some((line) => /^(env|defaults|["']?(env|defaults)["']?) *:/.test(line) || /^[^ #a-z]/.test(line))) {
    throw new Error(`${label}: workflow-level env or defaults (or an unusual top-level key) are not allowed`);
  }
  const start = lines.indexOf('  l1:', jobsAt);
  if (start < 0) throw new Error(`${label}: no l1 job`);
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end += 1;
  const job = lines.slice(start, end);
  for (let i = 0; i < EXPECTED_L1_JOB_PREFIX.length; i += 1) {
    if (job[i] !== EXPECTED_L1_JOB_PREFIX[i]) {
      throw new Error(`${label}: l1 job line ${i + 1} differs from the allowlisted prefix (expected ${JSON.stringify(EXPECTED_L1_JOB_PREFIX[i])}, found ${JSON.stringify(job[i] ?? '<end>')})`);
    }
  }
  // After the prefix the next line must start a new step (the T1 step ends there).
  const next = job[EXPECTED_L1_JOB_PREFIX.length];
  if (next !== undefined && !/^ {6}- name: /.test(next)) throw new Error(`${label}: the T1 step has extra lines (${JSON.stringify(next)})`);
  for (const line of job) {
    if (/^ {6}-/.test(line) && !/^ {6}- name: \S/.test(line)) throw new Error(`${label}: every l1 step must be a block mapping starting with "- name:" (${JSON.stringify(line)})`);
  }
  return true;
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  verifyT1AppendOnlyWorkflow(await readFile(T1_WORKFLOW_PATH, 'utf8'));
  verifyL1JobT1Prefix(await readFile(L1_WORKFLOW_PATH, 'utf8'));
  console.log('l1-t1-trust-append-only-custody: ok');
}
