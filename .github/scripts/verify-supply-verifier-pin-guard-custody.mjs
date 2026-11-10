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
// A third, independent layer parses the YAML with a strict subset parser and
// checks it against a structural allowlist (top-level keys with nothing after
// jobs:, no duplicate keys, one job with allowlisted keys, exact steps, every
// run: command on an allowlist, no env injection); see verifyPinGuardStructure.
// All three layers must pass.
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

// ---------------------------------------------------------------------------
// Structural allowlist on a real parse of the YAML (Security finding 1 on
// #1216). It is independent of EXPECTED_LINES and of the regex rules above.
// All three must pass. The parser is a minimal STRICT subset of YAML written
// here so the check needs nothing outside this file (no npm dependencies, so
// it runs anywhere main's checkout is, before any install). Anything outside
// the subset is refused instead of being interpreted: only 2-space block
// mappings, block sequences of mappings, plain or quoted scalars, one-line
// flow sequences of plain words, and plain `|` block scalars are accepted.
// Refused: duplicate keys at any level, anchors, aliases and merge keys,
// tags, flow mappings, `---` / `...` documents and directives, `|-` `|+` `>`,
// complex or quoted keys, backslash escapes, non-ASCII or control bytes
// (NBSP, zero-width, RTL override, fullwidth marks), TAB and CR.
// ---------------------------------------------------------------------------

function yamlFail(lineNo, reason) { fail(`YAML line ${lineNo}: ${reason}`); }
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Parses the strict subset into plain objects, arrays and strings. */
export function parseStrictYaml(text) {
  if (/[^\n\x20-\x7e]/.test(text)) {
    const at = text.search(/[^\n\x20-\x7e]/);
    yamlFail(text.slice(0, at).split('\n').length, `byte 0x${text.charCodeAt(at).toString(16)} is not allowed (ASCII only; no TAB, CR, NBSP, zero-width or bidi characters)`);
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const [i, line] of lines.entries()) if (/^(?:---|\.\.\.)(?:\s|$)|^%/.test(line)) yamlFail(i + 1, 'document markers and directives are not allowed (one document only)');
  let pos = 0;
  const ignorable = (line) => line.trim() === '' || line.trimStart().startsWith('#');
  const skip = () => { while (pos < lines.length && ignorable(lines[pos])) pos += 1; };
  const indentOf = (line) => line.length - line.trimStart().length;

  function scalar(raw, lineNo) {
    if (raw.startsWith('[')) {
      const m = raw.match(/^\[([^\]]*)\](?: #.*)?$/);
      if (!m) yamlFail(lineNo, 'malformed flow sequence');
      const items = m[1].split(',').map((s) => s.trim());
      if (items.some((s) => !/^[A-Za-z0-9_./-]+$/.test(s))) yamlFail(lineNo, 'flow sequences may hold plain words only');
      return items;
    }
    if (/^[{&*!%@`|>?]/.test(raw) || /^- /.test(raw) || raw === '-') yamlFail(lineNo, `unsupported YAML construct ${JSON.stringify(raw.slice(0, 20))} (no flow mappings, anchors, aliases, tags or block indicators here)`);
    if (raw.startsWith("'")) {
      const m = raw.match(/^'((?:[^']|'')*)'(?: #.*)?$/);
      if (!m) yamlFail(lineNo, 'malformed single-quoted scalar');
      return m[1].replace(/''/g, "'");
    }
    if (raw.startsWith('"')) {
      const m = raw.match(/^"([^"\\]*)"(?: #.*)?$/);
      if (!m) yamlFail(lineNo, 'malformed double-quoted scalar (backslash escapes are not allowed)');
      return m[1];
    }
    const value = raw.replace(/ #.*$/, '').replace(/ +$/, '');
    if (value === '' || /: |:$/.test(value) || value.startsWith('#')) yamlFail(lineNo, `ambiguous plain scalar ${JSON.stringify(value)}`);
    return value;
  }

  function blockScalar(parentIndent, lineNo) {
    const body = [];
    let blockIndent = null;
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.trim() === '') { body.push(''); pos += 1; continue; }
      const ind = indentOf(line);
      if (blockIndent === null) {
        if (ind <= parentIndent) break;
        blockIndent = ind;
      }
      if (ind < blockIndent) {
        if (ind > parentIndent) yamlFail(pos + 1, 'block scalar line is less indented than the block');
        break;
      }
      body.push(line.slice(blockIndent));
      pos += 1;
    }
    while (body.length && body.at(-1) === '') body.pop();
    if (blockIndent === null || body.length === 0) yamlFail(lineNo, 'empty block scalar');
    return `${body.join('\n')}\n`;
  }

  function mapping(indent, firstLine = null) {
    const out = {};
    let first = firstLine;
    for (;;) {
      let line;
      let lineNo;
      if (first !== null) { line = first.text; lineNo = first.lineNo; first = null; }
      else {
        skip();
        if (pos >= lines.length) break;
        const ind = indentOf(lines[pos]);
        if (ind < indent) break;
        if (ind > indent) yamlFail(pos + 1, `unexpected indentation (expected ${indent} spaces)`);
        line = lines[pos].slice(indent);
        lineNo = pos + 1;
        if (line.startsWith('- ') || line === '-') break;
        pos += 1;
      }
      const m = line.match(KEY_RE);
      if (!m) yamlFail(lineNo, `not a plain "key: value" entry: ${JSON.stringify(line.slice(0, 40))}`);
      const [, key, raw = ''] = m;
      if (FORBIDDEN_KEYS.has(key)) yamlFail(lineNo, `key ${key} is not allowed`);
      if (Object.hasOwn(out, key)) yamlFail(lineNo, `duplicate key ${JSON.stringify(key)}`);
      if (raw === '' || /^#/.test(raw)) {
        skip();
        if (pos >= lines.length || indentOf(lines[pos]) <= indent) yamlFail(lineNo, `key ${JSON.stringify(key)} has no value`);
        out[key] = node(indent + 2);
      } else if (raw === '|') {
        out[key] = blockScalar(indent, lineNo);
      } else {
        out[key] = scalar(raw, lineNo);
      }
    }
    return out;
  }

  function sequence(indent) {
    const out = [];
    for (;;) {
      skip();
      if (pos >= lines.length) break;
      const ind = indentOf(lines[pos]);
      if (ind < indent) break;
      if (ind > indent) yamlFail(pos + 1, `unexpected indentation (expected ${indent} spaces)`);
      const line = lines[pos].slice(indent);
      if (!line.startsWith('- ')) break;
      const lineNo = pos + 1;
      const rest = line.slice(2);
      if (!KEY_RE.test(rest)) yamlFail(lineNo, 'sequence items must be block mappings ("- key: value")');
      pos += 1;
      out.push(mapping(indent + 2, { text: rest, lineNo }));
    }
    return out;
  }

  function node(indent) {
    skip();
    const ind = indentOf(lines[pos]);
    if (ind !== indent) yamlFail(pos + 1, `unexpected indentation (expected ${indent} spaces)`);
    const line = lines[pos].slice(indent);
    return line.startsWith('- ') ? sequence(indent) : mapping(indent);
  }

  skip();
  if (pos >= lines.length) fail('YAML: empty document');
  const doc = mapping(0);
  skip();
  if (pos < lines.length) yamlFail(pos + 1, 'content after the top-level mapping');
  return doc;
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function keysExactly(where, value, keys) {
  if (!isMap(value)) fail(`${where} must be a mapping`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((k, i) => k !== keys[i])) fail(`${where} keys must be exactly [${keys.join(', ')}] in that order, found [${actual.join(', ')}]`);
}
function equalExactly(where, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${where} must be ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
}

// Env names that change how bash, node, git, npm or the runner behave.
export const FORBIDDEN_ENV_RE = /^(?:BASH_ENV|ENV|BASH_FUNC_.*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|IFS|CDPATH|GLOBIGNORE|PATH|HOME|TMPDIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_NO_WARNINGS|LD_.*|DYLD_.*|GIT_.*|NPM_.*|npm_.*|PYTHON.*|PERL5.*|PERLLIB|RUBYOPT|RUBYLIB|GITHUB_.*|RUNNER_.*|ACTIONS_.*|INPUT_.*|STATE_.*)$/i;
export const ALLOWED_STEP_ENV = Object.freeze({
  PR_NUMBER: '${{ github.event.pull_request.number }}',
  PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
});
// Every command any run: (single-line or block) may contain, exactly.
export const ALLOWED_COMMANDS = Object.freeze([
  'npm ci --ignore-scripts --no-audit --no-fund',
  'set -euo pipefail',
  '[[ "$PR_NUMBER" =~ ^[0-9]+$ && "$PR_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]',
  'git fetch --no-tags --quiet origin \'+refs/heads/main:refs/remotes/origin/main\' "+refs/pull/$PR_NUMBER/head:refs/remotes/pr/head"',
  'git cat-file -e "$PR_HEAD_SHA^{commit}"',
  'if [ ! -f .github/scripts/verify-supply-verifier-pin-guard.mjs ]; then',
  '  echo "::error::main has no .github/scripts/verify-supply-verifier-pin-guard.mjs; the pin guard cannot run"',
  '  exit 1',
  'fi',
  'node .github/scripts/verify-supply-verifier-pin-guard.mjs --merge-base origin/main --head "$PR_HEAD_SHA" --event "$GITHUB_EVENT_PATH" --toolchain l1/node_modules --scratch "$RUNNER_TEMP/pin-guard"',
]);
const CHECK_RUN = ALLOWED_COMMANDS.slice(1);
export const EXPECTED_STEPS = Object.freeze([
  { name: 'Checkout main (trusted checker)', uses: CHECKOUT, with: { 'persist-credentials': 'false', 'fetch-depth': '0' } },
  { name: 'Set up Node.js', uses: SETUP_NODE, with: { 'node-version-file': 'tools/supply-verifier/.nvmrc' } },
  { name: "Install main's l1 TypeScript toolchain (main's lockfile, no install scripts)", 'working-directory': 'l1', run: [ALLOWED_COMMANDS[0]] },
  { name: 'Check the PR head pin against the merge base with main (data only)', shell: 'bash', env: ALLOWED_STEP_ENV, run: CHECK_RUN },
]);
const JOB_ID = 'supply-verifier-pin-guard';

/** Structural allowlist on the parsed workflow. */
export function verifyPinGuardStructure(doc) {
  keysExactly('top level', doc, ['name', 'on', 'permissions', 'concurrency', 'jobs']);
  equalExactly('name', doc.name, 'Supply Verifier Pin Guard (main checker)');
  keysExactly('on', doc.on, ['pull_request_target']);
  keysExactly('on.pull_request_target', doc.on.pull_request_target, ['branches', 'types']);
  equalExactly('on.pull_request_target.branches', doc.on.pull_request_target.branches, ['main']);
  equalExactly('on.pull_request_target.types', doc.on.pull_request_target.types, ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']);
  keysExactly('permissions', doc.permissions, ['contents']);
  equalExactly('permissions.contents', doc.permissions.contents, 'read');
  keysExactly('concurrency', doc.concurrency, ['group', 'cancel-in-progress']);
  equalExactly('concurrency.group', doc.concurrency.group, '${{ github.workflow }}-${{ github.event.pull_request.number }}');
  equalExactly('concurrency.cancel-in-progress', doc.concurrency['cancel-in-progress'], 'true');
  keysExactly('jobs', doc.jobs, [JOB_ID]);
  const job = doc.jobs[JOB_ID];
  keysExactly(`jobs.${JOB_ID} (no container, services, defaults, env, if, permissions, strategy or other job keys)`, job, ['runs-on', 'timeout-minutes', 'steps']);
  equalExactly('runs-on', job['runs-on'], 'ubuntu-latest');
  equalExactly('timeout-minutes', job['timeout-minutes'], '10');
  if (!Array.isArray(job.steps) || job.steps.length !== EXPECTED_STEPS.length) fail(`exactly ${EXPECTED_STEPS.length} steps are allowed`);
  job.steps.forEach((step, i) => {
    const want = EXPECTED_STEPS[i];
    const where = `step ${i + 1}`;
    keysExactly(where, step, Object.keys(want));
    if (isMap(step.env)) {
      for (const name of Object.keys(step.env)) {
        if (FORBIDDEN_ENV_RE.test(name)) fail(`${where}: env ${name} is an injection vector and is not allowed`);
        if (!Object.hasOwn(ALLOWED_STEP_ENV, name)) fail(`${where}: env ${name} is not on the allowlist`);
      }
    }
    if (Object.hasOwn(step, 'run')) {
      if (typeof step.run !== 'string') fail(`${where}: run must be a string`);
      if (/\$\{\{/.test(step.run)) fail(`${where}: \${{ }} is not allowed in run`);
      const commands = step.run.replace(/\n$/, '').split('\n');
      for (const command of commands) if (!ALLOWED_COMMANDS.includes(command)) fail(`${where}: run command not on the allowlist: ${JSON.stringify(command.slice(0, 120))}`);
      equalExactly(`${where} run commands`, commands, want.run);
    }
    for (const key of Object.keys(want)) if (key !== 'run') equalExactly(`${where} ${key}`, step[key], want[key]);
  });
  return true;
}

/** Parse plus structural allowlist, on the raw workflow text. */
export function lintPinGuardStructure(text) {
  return verifyPinGuardStructure(parseStrictYaml(text));
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
  lintPinGuardStructure(text);
  return true;
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  verifyPinGuardWorkflow(await readFile(PIN_GUARD_WORKFLOW_PATH, 'utf8'));
  console.log('supply-verifier-pin-guard-custody: ok');
}
