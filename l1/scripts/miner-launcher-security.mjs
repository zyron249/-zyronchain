import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_BUNDLED_CONTROL_FILE_BYTES = 64 * 1024;

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function escapesRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Resolve an existing non-link directory anchor, then create each missing
 * custody component beneath its canonical path one at a time. This accepts
 * platform-owned aliases such as macOS /var -> /private/var without treating
 * them as attacker-controlled custody substitution, while still refusing an
 * existing symlink/junction at any app-owned missing-path boundary.
 */
export async function ensureSafeCustodyDirectory(path) {
  const requested = resolve(path);
  let cursor = requested;
  const missing = [];

  while (true) {
    const info = await lstatIfPresent(cursor);
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('Miner custody path must not traverse symlinks, junctions, or special files');
      }
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('Miner custody path has no usable directory anchor');
    missing.unshift(basename(cursor));
    cursor = parent;
  }

  let canonical = await realpath(cursor);
  for (const component of missing) {
    const next = join(canonical, component);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const info = await lstat(next);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Miner custody path must not traverse symlinks, junctions, or special files');
    }
    const resolvedNext = await realpath(next);
    if (resolvedNext !== next && process.platform !== 'win32') {
      throw new Error('Miner custody path component changed during creation');
    }
    canonical = resolvedNext;
  }

  return canonical;
}

export async function existingSafeSecret(path, label) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Resolve a package-owned regular file without following app-owned symlink or
 * junction boundaries. Both the requested and canonicalized paths must remain
 * beneath the canonical package root on every supported platform.
 */
export async function safeBundledRegularFile(packageRoot, relativePath, label = 'Bundled file') {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) {
    throw new Error(`${label} path is invalid`);
  }
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.startsWith('\\\\')) {
    throw new Error(`${label} path must be relative to the miner package`);
  }
  if (relativePath.split(/[\\/]+/).includes('..')) {
    throw new Error(`${label} path must not traverse outside the miner package`);
  }

  const requestedRoot = resolve(packageRoot);
  const rootInfo = await lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('Miner package root must be a real directory');
  }
  const canonicalRoot = await realpath(requestedRoot);
  const requestedFile = resolve(requestedRoot, relativePath);
  if (requestedFile === requestedRoot || escapesRoot(requestedRoot, requestedFile)) {
    throw new Error(`${label} escaped the miner package`);
  }

  const rel = relative(requestedRoot, requestedFile);
  const components = rel.split(sep).filter(Boolean);
  let cursor = requestedRoot;
  for (let index = 0; index < components.length; index += 1) {
    cursor = join(cursor, components[index]);
    const info = await lstat(cursor);
    const final = index === components.length - 1;
    if (info.isSymbolicLink()) {
      throw new Error(`${label} path must not traverse symlinks or junctions`);
    }
    if (final ? !info.isFile() : !info.isDirectory()) {
      throw new Error(final ? `${label} must be a regular file` : `${label} parent must be a real directory`);
    }
  }

  const canonicalFile = await realpath(requestedFile);
  if (canonicalFile === canonicalRoot || escapesRoot(canonicalRoot, canonicalFile)) {
    throw new Error(`${label} canonical path escaped the miner package`);
  }
  return canonicalFile;
}

/**
 * Read a package-owned control file from the same descriptor that is validated.
 * The path boundary is checked first, POSIX opens refuse symlink/special-file
 * following, descriptor/path identity is rechecked after open, and reads are
 * bounded so replacement or growth cannot cause an unbounded startup read.
 */
export async function readSafeBundledRegularFile(
  packageRoot,
  relativePath,
  label = 'Bundled file',
  maxBytes = MAX_BUNDLED_CONTROL_FILE_BYTES
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`${label} byte limit is invalid`);
  }

  const canonicalFile = await safeBundledRegularFile(packageRoot, relativePath, label);
  const flags = process.platform === 'win32'
    ? 'r'
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(canonicalFile, flags);
  try {
    const descriptorMetadata = await handle.stat();
    const pathMetadata = await lstat(canonicalFile);
    if (pathMetadata.isSymbolicLink()) {
      throw new Error(`${label} changed to a symbolic link while being validated`);
    }
    if (!descriptorMetadata.isFile() || !pathMetadata.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (process.platform !== 'win32' &&
        (descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino)) {
      throw new Error(`${label} changed while being validated`);
    }
    if (descriptorMetadata.size > maxBytes) {
      throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds ${maxBytes} byte limit`);
      }
    }
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    await handle.close();
  }
}
