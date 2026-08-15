import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { ensureSafeCustodyDirectory, existingSafeSecret } from './miner-launcher-security.mjs';

const root = await mkdtemp(join(tmpdir(), 'zyron-miner-custody-test-'));
try {
  const safe = join(root, 'safe');
  const canonicalSafe = await ensureSafeCustodyDirectory(safe);
  assert.equal(canonicalSafe, await realpath(safe));
  const secret = join(canonicalSafe, 'wallet.json');
  await writeFile(secret, '{}', { mode: 0o600 });
  assert.equal(await existingSafeSecret(secret, 'wallet'), true);

  const target = join(root, 'target');
  const linked = join(root, 'linked');
  await mkdir(target);
  try {
    await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => ensureSafeCustodyDirectory(linked), /symlink|junction/i);
    await assert.rejects(() => ensureSafeCustodyDirectory(join(linked, 'nested')), /symlink|junction/i);

    const secretTarget = join(root, 'secret-target');
    const secretLink = join(root, 'secret-link');
    await writeFile(secretTarget, 'secret', { mode: 0o600 });
    await symlink(secretTarget, secretLink, 'file');
    await assert.rejects(() => existingSafeSecret(secretLink, 'wallet'), /non-symlink/i);
  } catch (error) {
    if (!(process.platform === 'win32' && error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')) throw error;
    console.log('Windows symlink privilege unavailable; regular-file checks still exercised.');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('miner-launcher-custody-security-ok');
