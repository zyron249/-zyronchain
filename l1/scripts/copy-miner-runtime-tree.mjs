import fs from 'node:fs';
import path from 'node:path';

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalDestinationPath(candidate, fsOps) {
  const destinationPath = path.resolve(candidate);
  const parentPath = path.dirname(destinationPath);
  const parentStat = fsOps.lstatSync(parentPath);
  if (!parentStat.isDirectory()) {
    throw new Error('miner runtime destination parent must be a directory');
  }
  const canonicalParent = fsOps.realpathSync(parentPath);
  return path.join(canonicalParent, path.basename(destinationPath));
}

export function copyMinerRuntimeTree(source, destination, fsOps = fs) {
  const sourceRoot = fsOps.realpathSync(source);
  const destinationPath = path.resolve(destination);
  if (fsOps.existsSync(destinationPath)) {
    throw new Error('miner runtime destination must not already exist');
  }
  const destinationRoot = canonicalDestinationPath(destinationPath, fsOps);
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

  try {
    fsOps.mkdirSync(destinationRoot, { recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('miner runtime destination appeared before atomic creation');
    }
    throw error;
  }
  const createdDestinationRoot = fsOps.realpathSync(destinationRoot);
  const createdDestinationStat = fsOps.lstatSync(destinationRoot);
  if (!createdDestinationStat.isDirectory() || createdDestinationRoot !== destinationRoot || isWithinRoot(sourceRoot, createdDestinationRoot)) {
    throw new Error('miner runtime destination identity changed after creation');
  }

  for (const entry of fsOps.readdirSync(sourceRoot)) {
    copyEntry(path.join(sourceRoot, entry), path.join(destinationRoot, entry));
  }
}