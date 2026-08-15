import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
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
