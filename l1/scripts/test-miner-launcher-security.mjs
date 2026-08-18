import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { ensureSafeCustodyDirectory, existingSafeSecret, safeBundledRegularFile } from './miner-launcher-security.mjs';

const root = await mkdtemp(join(tmpdir(), 'zyron-miner-custody-test-'));
try {
  const safe = join(root, 'safe');
  const canonicalSafe = await ensureSafeCustodyDirectory(safe);
  assert.equal(canonicalSafe, await realpath(safe));
  const secret = join(canonicalSafe, 'wallet.json');
  await writeFile(secret, '{}', { mode: 0o600 });
  assert.equal(await existingSafeSecret(secret, 'wallet'), true);

  const packageRoot = join(root, 'package');
  const configDir = join(packageRoot, 'config');
  await mkdir(configDir, { recursive: true });
  const genesis = join(configDir, 'genesis.json');
  await writeFile(genesis, '{}');
  assert.equal(await safeBundledRegularFile(packageRoot, 'config/genesis.json', 'genesis'), await realpath(genesis));
  await assert.rejects(() => safeBundledRegularFile(packageRoot, '../outside.json', 'genesis'), /traverse|escaped/i);
  await assert.rejects(() => safeBundledRegularFile(packageRoot, packageRoot, 'genesis'), /relative|escaped/i);

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

    const outsideGenesis = join(root, 'outside-genesis.json');
    await writeFile(outsideGenesis, '{}');
    const linkedGenesis = join(configDir, 'linked-genesis.json');
    await symlink(outsideGenesis, linkedGenesis, 'file');
    await assert.rejects(() => safeBundledRegularFile(packageRoot, 'config/linked-genesis.json', 'genesis'), /symlink|junction/i);

    const outsideDir = join(root, 'outside-dir');
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, 'genesis.json'), '{}');
    const linkedDir = join(packageRoot, 'linked-config');
    await symlink(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => safeBundledRegularFile(packageRoot, 'linked-config/genesis.json', 'genesis'), /symlink|junction|escaped/i);
  } catch (error) {
    if (!(process.platform === 'win32' && error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')) throw error;
    console.log('Windows symlink privilege unavailable; regular-file and traversal checks still exercised.');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('miner-launcher-custody-security-ok');
