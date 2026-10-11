#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const workflowPath = '.github/workflows/website-release-pin-ci.yml';
const text = readFileSync(workflowPath, 'utf8');
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
// compares must also trigger the workflow on pull requests and on main.
if (/\|\|\s*true\b/.test(text)) throw new Error('release-pin gate must not swallow command failures with || true');
const diffLine = text.match(/git diff --name-only[^\n]*?--((?:\s+'[^']+')+)/);
if (!diffLine) throw new Error('release-pin gate must compare canonical paths with git diff --name-only');
const comparedPaths = [...diffLine[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const triggerPaths = (event) => {
  const block = text.match(new RegExp(`\\n  ${event}:\\n[\\s\\S]*?\\n    paths:\\n((?:      - '[^']+'\\n)+)`));
  if (!block) throw new Error(`release-pin gate ${event} trigger paths missing`);
  return new Set([...block[1].matchAll(/- '([^']+)'/g)].map((m) => m[1]));
};
for (const event of ['pull_request', 'push']) {
  const paths = triggerPaths(event);
  for (const required of [...comparedPaths, 'website/**']) {
    if (!paths.has(required)) throw new Error(`release-pin gate does not trigger on ${event} for compared path ${required}`);
  }
}

console.log('website-release-pin-action-custody-ok');
