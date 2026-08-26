import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  MAX_BUNDLED_CONTROL_FILE_BYTES,
  ensureSafeCustodyDirectory,
  existingSafeSecret,
  readSafeBundledRegularFile,
  readStableBundledDescriptor,
  safeBundledRegularFile
} from './miner-launcher-security.mjs';

const launcherSource = await readFile(new URL('./miner-launcher.mjs', import.meta.url), 'utf8');
assert.match(
  launcherSource,
  /readSafeBundledRegularFile\(\s*root,\s*['"]miner-network-profile\.json['"],\s*['"]Bundled miner network profile['"]\s*\)/,
  'miner launcher must read its network profile through the descriptor-bound package guard'
);

const securitySource = await readFile(new URL('./miner-launcher-security.mjs', import.meta.url), 'utf8');
assert.match(
  securitySource,
  /requireSameBundledRegularFile\(packageRoot, relativePath, label, canonicalFile, 'after opening'\)/,
  'bundled control-file reads must revalidate the package-owned path after descriptor open'
);
assert.match(
  securitySource,
  /readStableBundledDescriptor\(handle, descriptorMetadata, label, maxBytes\)/,
  'bundled control-file reads must bind bytes to the opened descriptor snapshot'
);
assert.match(
  securitySource,
  /requireSameBundledRegularFile\(packageRoot, relativePath, label, canonicalFile, 'during reading'\)/,
  'bundled control-file reads must revalidate the package-owned path after the bounded descriptor read'
);

const stableMetadata = {
  dev: 1,
  ino: 2,
  size: 4,
  mtimeMs: 10,
  ctimeMs: 20,
  isFile: () => true
};
let zeroPositionReads = 0;
const mutatingHandle = {
  async stat() { return stableMetadata; },
  async read(buffer, offset, length, position) {
    if (position === 4) return { bytesRead: 0, buffer };
    if (position !== 0) throw new Error(`unexpected test read position ${position}`);
    zeroPositionReads += 1;
    const bytes = Buffer.from(zeroPositionReads === 1 ? 'abcd' : 'wxyz');
    const copied = Math.min(length, bytes.length);
    bytes.copy(buffer, offset, 0, copied);
    return { bytesRead: copied, buffer };
  }
};
await assert.rejects(
  () => readStableBundledDescriptor(mutatingHandle, stableMetadata, 'profile', MAX_BUNDLED_CONTROL_FILE_BYTES),
  /content changed during reading/i,
  'same-size same-inode control-file mutation must fail closed even with stable metadata'
);

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

  const profileFile = join(packageRoot, 'miner-network-profile.json');
  await writeFile(profileFile, '{}');
  assert.equal(
    await safeBundledRegularFile(packageRoot, 'miner-network-profile.json', 'profile'),
    await realpath(profileFile)
  );
  const originalAllocUnsafe = Buffer.allocUnsafe;
  const allocationSizes = [];
  Buffer.allocUnsafe = function trackedAllocUnsafe(size) {
    allocationSizes.push(size);
    return originalAllocUnsafe(size);
  };
  try {
    assert.equal(await readSafeBundledRegularFile(packageRoot, 'miner-network-profile.json', 'profile'), '{}');
  } finally {
    Buffer.allocUnsafe = originalAllocUnsafe;
  }
  assert.ok(allocationSizes.length >= 3, 'stable descriptor read must allocate primary, reread, and sentinel buffers');
  assert.ok(Math.max(...allocationSizes) <= 3, 'small control files must not allocate the full 64 KiB ceiling');

  await writeFile(profileFile, 'x'.repeat(MAX_BUNDLED_CONTROL_FILE_BYTES + 1));
  await assert.rejects(
    () => readSafeBundledRegularFile(packageRoot, 'miner-network-profile.json', 'profile'),
    /byte limit/i
  );
  await writeFile(profileFile, '{}');

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

    const outsideProfile = join(root, 'outside-profile.json');
    await writeFile(outsideProfile, '{}');
    const linkedProfile = join(packageRoot, 'linked-profile.json');
    await symlink(outsideProfile, linkedProfile, 'file');
    await assert.rejects(() => safeBundledRegularFile(packageRoot, 'linked-profile.json', 'profile'), /symlink|junction/i);
    await assert.rejects(() => readSafeBundledRegularFile(packageRoot, 'linked-profile.json', 'profile'), /symlink|junction/i);

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