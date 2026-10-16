#!/usr/bin/env node
// Round-11 (D25) regression tests for the browser-policy part of the website
// release-pin gate. The gate's inline `node <<'NODE'` program is extracted from
// the pinned workflow and executed against copies of the real pages. It must
// accept the real site and refuse Content-Security-Policy variants that widen
// what the pages may connect to: a look-alike host that only starts with the
// open-testnet origin, an extra connect source, a duplicate directive placed
// first (browsers honour the first one), a second CSP meta tag, and an open
// connect-src on the pages that must not make network requests at all.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(join(root, '.github/workflows/website-release-pin-ci.yml'), 'utf8');
const lines = workflow.split('\n');
const start = lines.findIndex((line) => line.trim() === "node <<'NODE'");
const end = lines.findIndex((line, index) => index > start && line.trim() === 'NODE');
assert.ok(start > 0 && end > start, 'browser-policy heredoc not found in the release-pin workflow');
const indent = lines[start].match(/^ */)[0].length;
const program = lines.slice(start + 1, end).map((line) => line.slice(indent)).join('\n');

const OPEN = 'https://zyron-open-testnet.onrender.com';
const pages = ['index.html', 'wallet.html', 'validator.html', 'mining.html'];

function runGate(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'release-pin-csp-'));
  try {
    cpSync(join(root, 'website'), join(dir, 'website'), { recursive: true });
    if (mutate) {
      for (const page of pages) {
        const path = join(dir, 'website', page);
        const before = readFileSync(path, 'utf8');
        const after = mutate(page, before);
        if (after !== undefined) writeFileSync(path, after);
      }
    }
    return spawnSync(process.execPath, ['-e', program], { cwd: dir, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const real = runGate();
assert.equal(real.status, 0, `the real website must pass the browser-policy gate: ${real.stderr}`);

const onPage = (target, edit) => (page, html) => (page === target ? edit(html) : undefined);
const mustChange = (html, from, to) => {
  assert.ok(html.includes(from), `mutation anchor missing: ${from}`);
  return html.replace(from, () => to);
};

const mutations = {
  'look-alike host that starts with the open-testnet origin': onPage('index.html', (html) =>
    mustChange(html, `connect-src ${OPEN};`, `connect-src ${OPEN}.attacker.example;`)),
  'extra connect source after the open-testnet origin': onPage('wallet.html', (html) =>
    mustChange(html, `connect-src ${OPEN};`, `connect-src ${OPEN} https://attacker.example;`)),
  'wildcard connect source on a probe page': onPage('index.html', (html) =>
    mustChange(html, `connect-src ${OPEN};`, `connect-src ${OPEN} *;`)),
  'duplicate connect-src placed first on a probe page': onPage('index.html', (html) =>
    mustChange(html, "default-src 'self';", `default-src 'self'; connect-src *;`)),
  'duplicate connect-src placed first on a no-network page': onPage('validator.html', (html) =>
    mustChange(html, "default-src 'self';", `default-src 'self'; connect-src *;`)),
  "extra source next to 'none' on a no-network page": onPage('mining.html', (html) =>
    mustChange(html, "connect-src 'none';", "connect-src 'none' https://attacker.example;")),
  'open-testnet origin on a no-network page': onPage('validator.html', (html) =>
    mustChange(html, "connect-src 'none';", `connect-src ${OPEN};`)),
  'second, weaker CSP meta tag': onPage('wallet.html', (html) =>
    mustChange(html, '<meta http-equiv="Content-Security-Policy"',
      '<meta http-equiv="Content-Security-Policy" content="connect-src *" />\n  <meta http-equiv="Content-Security-Policy"')),
  "script-src widened with 'unsafe-inline'": onPage('index.html', (html) =>
    mustChange(html, "script-src 'self';", "script-src 'self' 'unsafe-inline';")),
  'object-src widened': onPage('wallet.html', (html) =>
    mustChange(html, "object-src 'none';", "object-src 'none' https://attacker.example;")),
};

const accepted = [];
for (const [name, mutate] of Object.entries(mutations)) {
  const result = runGate(mutate);
  if (result.status === 0) accepted.push(name);
}
assert.deepEqual(accepted, [], `browser-policy gate accepted widened CSP variants:\n- ${accepted.join('\n- ')}`);
console.log(`website-release-pin-browser-policy-mutations-ok ${Object.keys(mutations).length}`);
