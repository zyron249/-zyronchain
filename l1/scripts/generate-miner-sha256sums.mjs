#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HASH_BUFFER_BYTES = 64 * 1024;
const MANIFEST_PATH_CONTROL_BYTES = /[\u0000-\u001f\u007f]/;
const MANIFEST_TEMP_PREFIX = '.SHA256SUMS.';
const MANIFEST_TEMP_SUFFIX = '.tmp';

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sameFileSnapshot(expected, actual) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs;
}

function isManifestPublicationTempName(name) {
  return name.startsWith(MANIFEST_TEMP_PREFIX) && name.endsWith(MANIFEST_TEMP_SUFFIX);
}

export function releaseManifestPath(canonicalRoot, file) {
  const relative = path.relative(canonicalRoot, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`miner release manifest path escapes release root: ${relative || '<root>'}`);
  }
  if (MANIFEST_PATH_CONTROL_BYTES.test(relative)) {
    throw new Error('miner release manifest path contains non-canonical control characters');
  }
  if (path.sep !== '\\' && relative.includes('\\')) {
    throw new Error('miner release manifest path contains ambiguous backslash characters');
  }
  return relative.split(path.sep).join('/');
}

export function collectReleaseFiles(root, fsOps = fs) {
  const absoluteRoot = path.resolve(root);
  const manifestPath = path.join(absoluteRoot, 'SHA256SUMS');
  const files = [];

  function walk(dir) {
    for (const entry of fsOps.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (isManifestPublicationTempName(entry.name)) {
        throw new Error(`stale miner release SHA256SUMS publication temporary entry: ${path.relative(absoluteRoot, full) || entry.name}`);
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) {
        if (path.resolve(full) !== manifestPath) files.push(full);
        continue;
      }
      throw new Error(`unsupported non-regular miner release entry: ${path.relative(absoluteRoot, full) || entry.name}`);
    }
  }

  walk(absoluteRoot);
  return files.sort();
}

function hashBoundReleaseFile(file, canonicalRoot, fsOps) {
  const displayPath = releaseManifestPath(canonicalRoot, file);
  const expectedStat = fsOps.lstatSync(file);
  if (!expectedStat.isFile()) {
    throw new Error(`miner release manifest input must remain a regular file: ${displayPath}`);
  }
  const canonicalFile = fsOps.realpathSync(file);
  if (!isWithinRoot(canonicalRoot, canonicalFile)) {
    throw new Error(`miner release manifest input escapes release root: ${displayPath}`);
  }

  let fd;
  try {
    fd = fsOps.openSync(file, 'r');
    const openedStat = fsOps.fstatSync(fd);
    if (!openedStat.isFile() || !sameFileSnapshot(expectedStat, openedStat)) {
      throw new Error(`miner release manifest input snapshot changed before hashing: ${displayPath}`);
    }

    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    while (true) {
      const bytesRead = fsOps.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }

    const completedStat = fsOps.fstatSync(fd);
    if (!completedStat.isFile() || !sameFileSnapshot(openedStat, completedStat)) {
      throw new Error(`miner release manifest input mutated during hashing: ${displayPath}`);
    }
    return hash.digest('hex');
  } finally {
    if (fd !== undefined) fsOps.closeSync(fd);
  }
}

function publishManifestAtomic(canonicalRoot, manifest, fsOps) {
  const manifestPath = path.join(canonicalRoot, 'SHA256SUMS');
  const constants = fsOps.constants ?? fs.constants;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;
  const tempPath = path.join(canonicalRoot, `.SHA256SUMS.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  let fd;
  let renamed = false;
  try {
    fd = fsOps.openSync(tempPath, flags, 0o600);
    const openedStat = fsOps.fstatSync(fd);
    if (!openedStat.isFile()) {
      throw new Error('miner release SHA256SUMS temporary publication target must be a regular file');
    }
    fsOps.writeFileSync(fd, manifest, { encoding: 'utf8' });
    if (typeof fsOps.fsyncSync === 'function') fsOps.fsyncSync(fd);
    const completedStat = fsOps.fstatSync(fd);
    if (!completedStat.isFile() || openedStat.dev !== completedStat.dev || openedStat.ino !== completedStat.ino) {
      throw new Error('miner release SHA256SUMS temporary publication target identity changed');
    }
    fsOps.closeSync(fd);
    fd = undefined;

    fsOps.renameSync(tempPath, manifestPath);
    renamed = true;

    const pathStat = fsOps.lstatSync(manifestPath);
    if (!pathStat.isFile()) {
      throw new Error('miner release SHA256SUMS publication path became non-regular');
    }
    const canonicalManifest = fsOps.realpathSync(manifestPath);
    if (!isWithinRoot(canonicalRoot, canonicalManifest)) {
      throw new Error('miner release SHA256SUMS publication path escapes release root');
    }
  } finally {
    if (fd !== undefined) fsOps.closeSync(fd);
    if (!renamed) {
      try { fsOps.rmSync(tempPath, { force: true }); } catch {}
    }
  }
}

export function generateMinerSha256Sums(root, fsOps = fs) {
  const absoluteRoot = path.resolve(root);
  const canonicalRoot = fsOps.realpathSync(absoluteRoot);
  const rootStat = fsOps.lstatSync(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new Error('miner release manifest root must be a directory');
  }
  const files = collectReleaseFiles(canonicalRoot, fsOps);
  const lines = files.map((file) => {
    const digest = hashBoundReleaseFile(file, canonicalRoot, fsOps);
    return `${digest}  ${releaseManifestPath(canonicalRoot, file)}`;
  });
  const manifest = `${lines.join('\n')}\n`;
  publishManifestAtomic(canonicalRoot, manifest, fsOps);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || 'miner-release';
  generateMinerSha256Sums(root);
}
