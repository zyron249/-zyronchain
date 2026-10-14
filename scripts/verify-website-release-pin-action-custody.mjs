#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const workflowPath = '.github/workflows/website-release-pin-ci.yml';

export function verifyWebsiteReleasePinWorkflow(text) {
const required = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'fetch-depth: 0',
  'persist-credentials: false',
  'RELEASE_REF=',
  'PR_BASE_SHA:',
  'git cat-file -e',
  'Website release pin is stale:',
  'CHANGED_L1=',
  "connect-src 'none'",
  'Homepage mining retirement disclosure missing',
  'Homepage still advertises retired mining'
];
for (const marker of required) {
  if (!text.includes(marker)) throw new Error(`website release-pin custody invariant missing: ${marker}`);
}

for (const match of text.matchAll(/uses:\s*([^\s#]+)/g)) {
  const ref = match[1];
  if (!/@[0-9a-f]{40}$/.test(ref)) throw new Error(`mutable or non-SHA action reference: ${ref}`);
}

const checkoutStep = text.match(/- name: Checkout full history[\s\S]*?(?=\n\s*- name:|$)/)?.[0];
if (!checkoutStep) throw new Error('checkout step missing');
if (!checkoutStep.includes('persist-credentials: false')) throw new Error('checkout credentials must not persist');
if (!checkoutStep.includes('fetch-depth: 0')) throw new Error('release-pin gate requires full history');

// F-07: the gate must fail closed when git diff fails, and every path it
// compares (in every git diff, F-07 residual) must also trigger the workflow on
// pull requests and on main.
if (/\|\|\s*(?:true\b|:(?=\s|\)|;|$)|exit\s+0\b)/m.test(text)) {
  throw new Error('release-pin gate must not swallow command failures (|| true, || :, || exit 0)');
}
// Round-4 PR984: the strict mode must be an effective shell line, not text in a
// comment or a longer line.
if (!/^[ \t]*set -euo pipefail[ \t]*$/m.test(text)) throw new Error('release-pin gate shell must use set -euo pipefail');
// Round-5 (Codex review of #997): a matching line can still be heredoc data
// (`cat <<'STRICT'` ... `STRICT`) or come after commands that already ran
// without it. Every run block that holds the gate's git diff must start with
// the strict-mode line, before any heredoc can open, and must not switch
// errexit or pipefail off again later.
{
  const lines = text.split('\n');
  let gateBlocks = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s+)(?:-\s+)?run:\s*(.*?)\s*$/);
    if (!m || m[2] !== '|') continue;
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() !== '' && lines[j].length - lines[j].trimStart().length <= indent) break;
      body.push(lines[j]);
    }
    if (!body.some((line) => line.includes('git diff --name-only'))) continue;
    gateBlocks += 1;
    const first = body.find((line) => line.trim() !== '');
    if (first === undefined || first.trim() !== 'set -euo pipefail') {
      throw new Error('release-pin gate run block must start with set -euo pipefail');
    }
    // Round-5 (Codex review of #1009): bash removes quotes and backslashes
    // before it looks a command name up (`s''et +e`, `\set +e`), so the scan
    // runs on a copy without them. ANSI-C / locale quoting (`$'set'`,
    // `$'\163et'`) and `eval` (whose payload can be computed at run time)
    // could spell any command and are refused in the gate block.
    if (body.some((line) => /\$['"]/.test(line))) {
      throw new Error("release-pin gate must not use $'...' or $\"...\" quoting");
    }
    const dequoted = body.map((line) => line.replace(/['"\\]/g, ''));
    if (dequoted.some((line) => /(?:^|[;&|(){}`]|\s)eval(?=\s|$)/.test(line))) {
      throw new Error('release-pin gate must not use eval');
    }
    if (dequoted.some((line) => /(?:^|[;&|({]|\s)(?:set\s+\+|shopt\s+-u)/.test(line))) {
      throw new Error('release-pin gate must not switch strict mode off (set +..., shopt -u)');
    }
    // Round-5 (second Codex review of #1009): bash joins a backslash-newline
    // before it splits words (`se\` + `t +e`), any `+x` operand of `set`
    // switches that option off (`set -u +e`), and `shopt -o -u` does the same
    // for pipefail. The gate refuses line continuations, any `+letter` operand
    // and `shopt`, a command name taken from a variable (`$S +e`, `$X 0`), and
    // any way of ending the step early other than `exit 1`.
    // This block stays a denylist (the gate script is free-form); the release
    // workflow, whose run steps are fixed, is checked against an allowlist.
    if (body.some((line) => /\\\s*$/.test(line))) {
      throw new Error('release-pin gate must not use line continuations');
    }
    if (dequoted.some((line) => /(?:^|\s)\+[A-Za-z]/.test(line))) {
      throw new Error('release-pin gate must not switch shell options off (+e, +o, ...)');
    }
    if (dequoted.some((line) => /(?:^|[\s;&|(){}`])shopt(?=\s|$)/.test(line))) {
      throw new Error('release-pin gate must not use shopt');
    }
    // Command position: the start of a line, or after `;`, `&`, `|`, `(`,
    // `)`, `{`, `then`, `do`, `else` or `!`. A command name that starts with an
    // expansion (`$S +e`, `$X 0`, `"$S" +e`, `${S} +e`, `$(echo exit) 0`) or a
    // backtick substitution (`` `echo exit` 0 ``) is computed at run time and
    // refused. The scan runs on a copy where the inside of every quoted string
    // is masked (only a leading `$` is kept, so `"$S" +e` is still caught while
    // `echo "...; $COUNT ..."` is not) and every `[[ ... ]]` test is dropped
    // (its operands are not commands). A backtick after `(` is not checked: it
    // is the gate's own JavaScript template literal, and `(...)` is a subshell.
    const masked = body.map((line) => line
      .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (q) => `${q[0]}${q[1] === '$' ? '$' : ''}_${q[0]}`)
      .replace(/\[\[.*?\]\]/g, ' true ')
      .trim());
    if (masked.some((line) => /(?:^|[;&|(){]|\b(?:then|do|else)\b|!)\s*['"]?\$[\w{(@*#?$!-]/.test(line) ||
        /(?:^|[;&|{]|\b(?:then|do|else)\b|!)\s*['"]?`/.test(line))) {
      throw new Error('release-pin gate must not take a command name from a variable or a substitution');
    }
    if (dequoted.some((line) => /(?:^|[\s;&|(){}`])(?:return|logout|exec)(?=\s|;|$)/.test(line) ||
        /(?:^|[\s;&|(){}`])exit(?=\s|;|$)(?!\s+1(?:\s|;|$))/.test(line))) {
      throw new Error('release-pin gate may only end early with exit 1');
    }
  }
  if (gateBlocks === 0) throw new Error('release-pin gate run block missing');
}
const diffCommands = [...text.matchAll(/\$\(git diff --name-only ([^\n]*)\)"/g)];
if (diffCommands.length < 1) throw new Error('release-pin gate must compare canonical paths with git diff --name-only');
const comparedPaths = [];
for (const command of diffCommands) {
  // Only refs and quoted pathspecs: nothing inside the substitution may run
  // after git diff or change its exit status.
  const parsed = command[1].match(/^"\$[A-Z0-9_]+"\.\.HEAD --((?:\s+'[^']+')+)$/);
  if (!parsed) throw new Error(`release-pin gate git diff must compare refs and quoted paths only: ${command[1]}`);
  comparedPaths.push(...[...parsed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}
for (const command of text.matchAll(/git diff --name-only/g)) {
  const line = text.slice(text.lastIndexOf('\n', command.index) + 1, text.indexOf('\n', command.index));
  if (!/^\s*if ! [A-Z0-9_]+="\$\(git diff --name-only /.test(line)) {
    throw new Error('release-pin gate git diff must run as `if ! VAR="$(git diff ...)"; then` so a failure stops the job');
  }
}
// Round-4 PR984: line-based and scoped to the event's own block. The previous
// regex could run past an event whose `paths:` directly follows it and read
// the next event's list instead.
const triggerPaths = (event) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${event}:`);
  if (start < 0) throw new Error(`release-pin gate ${event} trigger paths missing`);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^ {3,}\S/.test(lines[end]))) end += 1;
  const block = lines.slice(start + 1, end);
  const pathsAt = block.findIndex((line) => line === '    paths:');
  if (pathsAt < 0 || block.filter((line) => /^ {4}paths:/.test(line)).length !== 1) {
    throw new Error(`release-pin gate ${event} trigger paths missing`);
  }
  const paths = new Set();
  for (const line of block.slice(pathsAt + 1)) {
    const item = line.match(/^      - '([^']+)'$/);
    if (!item) break;
    paths.add(item[1]);
  }
  if (paths.size === 0) throw new Error(`release-pin gate ${event} trigger paths missing`);
  return paths;
};
for (const event of ['pull_request', 'push']) {
  const paths = triggerPaths(event);
  for (const required of [...comparedPaths, 'website/**']) {
    if (!paths.has(required)) throw new Error(`release-pin gate does not trigger on ${event} for compared path ${required}`);
  }
}

}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyWebsiteReleasePinWorkflow(readFileSync(workflowPath, 'utf8'));
  console.log('website-release-pin-action-custody-ok');
}
