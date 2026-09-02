#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MINER_PROVENANCE_FILE = 'miner-provenance.json';
const SBOM_FILE = 'miner-sbom.cdx.json';
const COMMIT = /^[0-9a-f]{40}$/;
const PACKAGE = '@zyronchain/l1';

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`miner provenance ${label} is invalid`);
  return value;
}

function sameFileSnapshot(expected, actual) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs;
}

function readRegular(file, label) {
  const expectedStat = fs.lstatSync(file);
  if (!expectedStat.isFile() || expectedStat.isSymbolicLink()) throw new Error(`miner provenance ${label} must be a regular file`);
  if (fs.realpathSync(file) !== file) throw new Error(`miner provenance ${label} path must be canonical`);

  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile() || !sameFileSnapshot(expectedStat, openedStat)) {
      throw new Error(`miner provenance ${label} snapshot changed before read`);
    }

    const bytes = fs.readFileSync(fd);
    const completedStat = fs.fstatSync(fd);
    if (!completedStat.isFile() || !sameFileSnapshot(openedStat, completedStat)) {
      throw new Error(`miner provenance ${label} mutated during read`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readJsonRegular(file, label) {
  return JSON.parse(readRegular(file, label).toString('utf8'));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function buildMinerCandidateProvenance(root, metadata) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  if (!fs.lstatSync(canonicalRoot).isDirectory()) throw new Error('miner provenance root must be a directory');
  const pkg = readJsonRegular(path.join(canonicalRoot, 'package.json'), 'package.json');
  const version = assertString(metadata?.version, 'version');
  const platform = assertString(metadata?.platform, 'platform');
  const arch = assertString(metadata?.arch, 'architecture');
  const sourceCommit = assertString(metadata?.sourceCommit, 'source commit');
  if (!['linux', 'macos'].includes(platform)) throw new Error('miner provenance is limited to audited POSIX platforms');
  if (!COMMIT.test(sourceCommit)) throw new Error('miner provenance source commit must be exact lowercase SHA-1');
  if (pkg.name !== PACKAGE || pkg.version !== version) throw new Error('miner provenance package identity does not match candidate metadata');

  const sbomBytes = readRegular(path.join(canonicalRoot, SBOM_FILE), 'SBOM');
  return {
    schemaVersion: 1,
    kind: 'zyron.local-miner-candidate-provenance',
    subject: { name: PACKAGE, version, platform, arch },
    build: { sourceCommit },
    materials: [{ path: SBOM_FILE, algorithm: 'sha256', digest: sha256(sbomBytes) }],
    authority: { type: 'local-evidence-only', signed: false, published: false }
  };
}

export function writeMinerCandidateProvenance(root, metadata) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const provenance = buildMinerCandidateProvenance(canonicalRoot, metadata);
  const finalPath = path.join(canonicalRoot, MINER_PROVENANCE_FILE);
  if (fs.existsSync(finalPath)) throw new Error('miner provenance already exists');
  const tempPath = path.join(canonicalRoot, `.${MINER_PROVENANCE_FILE}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, finalPath);
  const stat = fs.lstatSync(finalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(finalPath) !== finalPath) throw new Error('miner provenance publication path is not a bound regular file');
  return provenance;
}

export function verifyMinerCandidateProvenance(root, expectedMetadata = null) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const file = path.join(canonicalRoot, MINER_PROVENANCE_FILE);
  const provenance = readJsonRegular(file, 'document');
  const metadata = expectedMetadata ?? {
    version: provenance?.subject?.version,
    platform: provenance?.subject?.platform,
    arch: provenance?.subject?.arch,
    sourceCommit: provenance?.build?.sourceCommit
  };
  const expected = buildMinerCandidateProvenance(canonicalRoot, metadata);
  if (JSON.stringify(provenance) !== JSON.stringify(expected)) throw new Error('miner provenance verification failed');
  return provenance;
}
