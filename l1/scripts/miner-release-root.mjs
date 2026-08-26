import fs from 'node:fs';
import path from 'node:path';

export function bindMinerReleaseRoot(projectRoot, releaseRoot, fsOps = fs) {
  const canonicalProjectRoot = fsOps.realpathSync(path.resolve(projectRoot));
  const requestedReleaseRoot = path.resolve(releaseRoot);
  const releaseStat = fsOps.lstatSync(requestedReleaseRoot);
  if (releaseStat.isSymbolicLink() || !releaseStat.isDirectory()) {
    throw new Error('miner release output root must be a real directory');
  }

  const canonicalReleaseRoot = fsOps.realpathSync(requestedReleaseRoot);
  const relative = path.relative(canonicalProjectRoot, canonicalReleaseRoot);
  if (relative !== 'miner-release' || path.isAbsolute(relative)) {
    throw new Error('miner release output root escapes the canonical L1 project root');
  }

  return canonicalReleaseRoot;
}
