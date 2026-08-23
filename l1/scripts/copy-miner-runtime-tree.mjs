import fs from 'node:fs';
import path from 'node:path';

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalProspectivePath(candidate, fsOps) {
  let cursor = path.resolve(candidate);
  const suffix = [];
  while (!fsOps.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonicalBase = fsOps.realpathSync(cursor);
  return path.join(canonicalBase, ...suffix);
}

export function copyMinerRuntimeTree(source, destination, fsOps = fs) {
  const sourceRoot = fsOps.realpathSync(source);
  const destinationRoot = canonicalProspectivePath(destination, fsOps);
  if (isWithinRoot(sourceRoot, destinationRoot)) {
    throw new Error('miner runtime destination must remain outside source root');
  }

  function copyEntry(sourcePath, destinationPath) {
    const stat = fsOps.lstatSync(sourcePath);
    if (stat.isDirectory()) {
      fsOps.mkdirSync(destinationPath, { recursive: true });
      for (const entry of fsOps.readdirSync(sourcePath)) {
        copyEntry(path.join(sourcePath, entry), path.join(destinationPath, entry));
      }
      return;
    }
    if (stat.isFile()) {
      fsOps.copyFileSync(sourcePath, destinationPath);
      fsOps.chmodSync(destinationPath, stat.mode & 0o777);
      return;
    }
    if (stat.isSymbolicLink()) {
      const resolved = fsOps.realpathSync(sourcePath);
      if (!isWithinRoot(sourceRoot, resolved)) {
        throw new Error(`miner runtime symlink escapes source root: ${path.relative(sourceRoot, sourcePath)}`);
      }
      const target = fsOps.statSync(sourcePath);
      if (!target.isFile()) {
        throw new Error(`miner runtime symlink must resolve to a regular file: ${path.relative(sourceRoot, sourcePath)}`);
      }
      fsOps.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fsOps.copyFileSync(resolved, destinationPath);
      fsOps.chmodSync(destinationPath, target.mode & 0o777);
      return;
    }
    throw new Error(`unsupported miner runtime entry: ${path.relative(sourceRoot, sourcePath)}`);
  }

  fsOps.mkdirSync(destinationRoot, { recursive: true });
  for (const entry of fsOps.readdirSync(sourceRoot)) {
    copyEntry(path.join(sourceRoot, entry), path.join(destinationRoot, entry));
  }
}
