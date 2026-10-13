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
