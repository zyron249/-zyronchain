import fs from 'node:fs';
import path from 'node:path';

const COPY_BUFFER_BYTES = 64 * 1024;

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sameFileIdentity(expected, actual) {
  return expected.dev === actual.dev && expected.ino === actual.ino;
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

function copyBoundRegularFile(sourcePath, destinationPath, expectedStat, fsOps, displayPath) {
  let sourceFd;
  let destinationFd;
  try {
    sourceFd = fsOps.openSync(sourcePath, 'r');
    const openedStat = fsOps.fstatSync(sourceFd);
    if (!openedStat.isFile() || !sameFileIdentity(expectedStat, openedStat)) {
      throw new Error(`miner runtime source identity changed before copy: ${displayPath}`);
    }

    destinationFd = fsOps.openSync(destinationPath, 'wx', expectedStat.mode & 0o777);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    while (true) {
      const bytesRead = fsOps.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += fsOps.writeSync(destinationFd, buffer, written, bytesRead - written, null);
      }
    }
    fsOps.fchmodSync(destinationFd, expectedStat.mode & 0o777);
  } finally {
    if (destinationFd !== undefined) fsOps.closeSync(destinationFd);
    if (sourceFd !== undefined) fsOps.closeSync(sourceFd);
  }
}

export function copyMinerRuntimeTree(source, destination, fsOps = fs) {
  const sourceRoot = fsOps.realpathSync(source);
  const sourceRootStat = fsOps.lstatSync(sourceRoot);
  if (!sourceRootStat.isDirectory()) {
    throw new Error('miner runtime source root must be a directory');
  }

  const destinationPath = path.resolve(destination);
  if (fsOps.existsSync(destinationPath)) {
    throw new Error('miner runtime destination must not already exist');
  }
  const destinationRoot = canonicalDestinationPath(destinationPath, fsOps);
  if (isWithinRoot(sourceRoot, destinationRoot)) {
    throw new Error('miner runtime destination must remain outside source root');
  }

  function assertSourceWithinRoot(sourcePath, displayPath) {
    const canonical = fsOps.realpathSync(sourcePath);
    if (!isWithinRoot(sourceRoot, canonical)) {
      throw new Error(`miner runtime source escapes source root: ${displayPath}`);
    }
    return canonical;
  }

  function assertDirectoryIdentity(sourcePath, expectedStat, displayPath) {
    const currentStat = fsOps.lstatSync(sourcePath);
    if (!currentStat.isDirectory() || !sameFileIdentity(expectedStat, currentStat)) {
      throw new Error(`miner runtime source directory identity changed before traversal: ${displayPath || '.'}`);
    }
    assertSourceWithinRoot(sourcePath, displayPath || '.');
  }

  function readBoundDirectory(sourcePath, expectedStat, displayPath) {
    assertDirectoryIdentity(sourcePath, expectedStat, displayPath);
    const entries = fsOps.readdirSync(sourcePath);
    assertDirectoryIdentity(sourcePath, expectedStat, displayPath);
    return entries;
  }

  function copyEntry(sourcePath, destinationPath) {
    const stat = fsOps.lstatSync(sourcePath);
    const displayPath = path.relative(sourceRoot, sourcePath);
    assertSourceWithinRoot(sourcePath, displayPath);

    if (stat.isDirectory()) {
      const entries = readBoundDirectory(sourcePath, stat, displayPath);
      fsOps.mkdirSync(destinationPath, { recursive: true });
      for (const entry of entries) {
        assertDirectoryIdentity(sourcePath, stat, displayPath);
        copyEntry(path.join(sourcePath, entry), path.join(destinationPath, entry));
        assertDirectoryIdentity(sourcePath, stat, displayPath);
      }
      return;
    }
    if (stat.isFile()) {
      copyBoundRegularFile(sourcePath, destinationPath, stat, fsOps, displayPath);
      return;
    }
    if (stat.isSymbolicLink()) {
      const resolved = fsOps.realpathSync(sourcePath);
      if (!isWithinRoot(sourceRoot, resolved)) {
        throw new Error(`miner runtime symlink escapes source root: ${displayPath}`);
      }
      const target = fsOps.statSync(sourcePath);
      if (!target.isFile()) {
        throw new Error(`miner runtime symlink must resolve to a regular file: ${displayPath}`);
      }
      fsOps.mkdirSync(path.dirname(destinationPath), { recursive: true });
      copyBoundRegularFile(resolved, destinationPath, target, fsOps, displayPath);
      return;
    }
    throw new Error(`unsupported miner runtime entry: ${displayPath}`);
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

  const rootEntries = readBoundDirectory(sourceRoot, sourceRootStat, '');
  for (const entry of rootEntries) {
    assertDirectoryIdentity(sourceRoot, sourceRootStat, '');
    copyEntry(path.join(sourceRoot, entry), path.join(destinationRoot, entry));
    assertDirectoryIdentity(sourceRoot, sourceRootStat, '');
  }
}