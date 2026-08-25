#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HASH_BUFFER_BYTES = 64 * 1024;
const MANIFEST_PATH_CONTROL_BYTES = /[\u0000-\u001f\u007f]/;

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

export function releaseManifestPath(canonicalRoot, file) {
  const relative = path.relative(canonicalRoot, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`miner release manifest path escapes release root: ${relative || '<root>'}`);
  }
  if (MANIFEST_PATH_CONTROL_BYTES.test(relative)) {
    throw new Error('miner release manifest path contains non-canonical control characters');
  }
  return relative.replaceAll('\\', '/');
}

export function collectReleaseFiles(root, fsOps = fs) {
  const absoluteRoot = path.resolve(root);
  const manifestPath = path.join(absoluteRoot, 'SHA256SUMS');
  const files = [];

  function walk(dir) {
    for (const entry of fsOps.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
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
  fsOps.writeFileSync(path.join(canonicalRoot, 'SHA256SUMS'), manifest);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || 'miner-release';
  generateMinerSha256Sums(root);
}
