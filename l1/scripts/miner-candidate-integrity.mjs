#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CANDIDATE_INTEGRITY_FILE = 'candidate-integrity.json';
const EXCLUDED_METADATA = new Set([CANDIDATE_INTEGRITY_FILE, 'SHA256SUMS']);
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function within(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function snapshot(stat) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameSnapshot(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function canonicalRelative(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`candidate integrity path escapes root: ${rel || '<root>'}`);
  if (CONTROL_BYTES.test(rel)) throw new Error('candidate integrity path contains control characters');
  if (path.sep !== '\\' && rel.includes('\\')) throw new Error('candidate integrity path contains ambiguous backslash characters');
  return rel.split(path.sep).join('/');
}

function collect(root) {
  const files = [];
  const seen = new Set();
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = canonicalRelative(root, full);
      if (seen.has(rel)) throw new Error(`duplicate candidate integrity path: ${rel}`);
      seen.add(rel);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`candidate integrity rejects symlink: ${rel}`);
      if (stat.isDirectory()) { walk(full); continue; }
      if (!stat.isFile()) throw new Error(`candidate integrity rejects non-regular entry: ${rel}`);
      if (!EXCLUDED_METADATA.has(rel)) files.push({ full, rel });
    }
  }
  walk(root);
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function hashBoundFile(root, file, rel) {
  const expected = fs.lstatSync(file);
  if (!expected.isFile()) throw new Error(`candidate integrity input is not a regular file: ${rel}`);
  const canonical = fs.realpathSync(file);
  if (!within(root, canonical)) throw new Error(`candidate integrity input escapes root: ${rel}`);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameSnapshot(snapshot(expected), snapshot(opened))) throw new Error(`candidate integrity input changed before hashing: ${rel}`);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const completed = fs.fstatSync(fd);
    if (!sameSnapshot(snapshot(opened), snapshot(completed))) throw new Error(`candidate integrity input mutated during hashing: ${rel}`);
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export function resolveSourceCommit(root, env = process.env) {
  const candidate = (env.GITHUB_SHA || env.ZYRON_SOURCE_COMMIT || '').trim().toLowerCase();
  if (candidate) {
    if (!COMMIT.test(candidate)) throw new Error('candidate source commit must be an exact 40-character lowercase hex commit id');
    return candidate;
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const commit = (result.stdout || '').trim().toLowerCase();
  if (result.status !== 0 || !COMMIT.test(commit)) throw new Error('unable to resolve exact candidate source commit');
  return commit;
}

export function buildCandidateIntegrity(root, metadata) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  if (!fs.lstatSync(canonicalRoot).isDirectory()) throw new Error('candidate integrity root must be a directory');
  const { version, platform, arch, sourceCommit } = metadata;
  if (typeof version !== 'string' || !version) throw new Error('candidate version is required');
  if (!['linux', 'macos'].includes(platform)) throw new Error('candidate integrity is limited to audited POSIX platforms');
  if (typeof arch !== 'string' || !arch) throw new Error('candidate architecture is required');
  if (!COMMIT.test(sourceCommit)) throw new Error('candidate source commit must be exact lowercase SHA-1');
  const files = collect(canonicalRoot).map(({ full, rel }) => ({ path: rel, sha256: hashBoundFile(canonicalRoot, full, rel) }));
  return { schemaVersion: 1, package: '@zyronchain/l1', version, platform, arch, sourceCommit, files };
}

export function writeCandidateIntegrity(root, metadata) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const manifest = buildCandidateIntegrity(canonicalRoot, metadata);
  const finalPath = path.join(canonicalRoot, CANDIDATE_INTEGRITY_FILE);
  if (fs.existsSync(finalPath)) throw new Error('candidate integrity manifest already exists');
  const tempPath = path.join(canonicalRoot, `.${CANDIDATE_INTEGRITY_FILE}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, finalPath);
  const stat = fs.lstatSync(finalPath);
  if (!stat.isFile() || fs.realpathSync(finalPath) !== finalPath) throw new Error('candidate integrity publication path is not a bound regular file');
  return manifest;
}

export function verifyCandidateIntegrity(root) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const manifestPath = path.join(canonicalRoot, CANDIDATE_INTEGRITY_FILE);
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('candidate integrity manifest must be a regular file');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expected = buildCandidateIntegrity(canonicalRoot, manifest);
  if (!Array.isArray(manifest.files) || manifest.files.some((entry) => typeof entry?.path !== 'string' || !SHA256.test(entry?.sha256 || ''))) throw new Error('candidate integrity manifest contains invalid file entries');
  if (JSON.stringify(expected) !== JSON.stringify(manifest)) throw new Error('candidate integrity verification failed');
  return manifest;
}
