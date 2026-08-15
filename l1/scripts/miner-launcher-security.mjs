import { lstat, mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

function sameResolvedPath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function ensureSafeCustodyDirectory(path) {
  const resolved = resolve(path);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Miner custody path must be a real directory, not a symlink or special file');
  }
  const canonical = await realpath(resolved);
  if (!sameResolvedPath(canonical, resolved)) {
    throw new Error('Miner custody path must not traverse symlinks or junctions');
  }
  return resolved;
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
