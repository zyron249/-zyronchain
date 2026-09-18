import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const verifier = await readFile(new URL('./verify-core-action-pins.mjs', import.meta.url), 'utf8');
const workflow = (await readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  for (const mutation of ['none', 'credentials', 'mutable-pin']) {
    test(`${label}: core action custody ${mutation}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'zyron-action-policy-'));
      try {
        await mkdir(join(root, 'scripts'));
        await mkdir(join(root, 'workflows'));
        const script = join(root, 'scripts', 'verify.mjs');
        await writeFile(script, verifier);
        let text = workflow;
        if (mutation === 'credentials') text = text.replace('persist-credentials: false', 'persist-credentials: true');
        if (mutation === 'mutable-pin') text = text.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@main');
        await writeFile(join(root, 'workflows', 'ci.yml'), text.replace(/\n/g, eol));
        const run = () => execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
        if (mutation === 'none') assert.match(run(), /core-action-pin-policy: ok/);
        else assert.throws(run, mutation === 'credentials' ? /must disable credential persistence/ : /Mutable core action reference/);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}
