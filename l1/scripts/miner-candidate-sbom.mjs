#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MINER_SBOM_FILE = 'miner-sbom.cdx.json';
const COMMIT = /^[0-9a-f]{40}$/;
const PACKAGE = '@zyronchain/l1';

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`miner SBOM ${label} is invalid`);
  return value;
}

function readJsonRegular(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`miner SBOM ${label} must be a regular file`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function componentKey(component) {
  return `${component.name}\u0000${component.version}`;
}

function assertRegularDirectory(dir, root, label) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`miner SBOM ${label} must be a regular directory: ${path.relative(root, dir)}`);
  }
}

function collectDependencyComponents(root) {
  const nodeModules = path.join(root, 'node_modules');
  assertRegularDirectory(nodeModules, root, 'node_modules');
  const components = new Map();

  function recordPackage(packageDir) {
    assertRegularDirectory(packageDir, root, 'dependency package directory');
    const packageJson = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJson)) throw new Error(`miner SBOM dependency package.json is missing: ${path.relative(root, packageDir)}`);
    const pkg = readJsonRegular(packageJson, 'dependency package.json');
    const name = assertString(pkg.name, 'dependency name');
    const version = assertString(pkg.version, 'dependency version');
    const component = { type: 'library', name, version, 'bom-ref': `npm:${name}@${version}` };
    components.set(componentKey(component), component);

    const nestedNodeModules = path.join(packageDir, 'node_modules');
    if (fs.existsSync(nestedNodeModules)) scanNodeModules(nestedNodeModules);
  }

  function scanScope(scopeDir) {
    assertRegularDirectory(scopeDir, root, 'dependency scope directory');
    const entries = fs.readdirSync(scopeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(scopeDir, entry.name);
      const entryStat = fs.lstatSync(full);
      if (entryStat.isSymbolicLink()) throw new Error(`miner SBOM rejects dependency symlink: ${path.relative(root, full)}`);
      if (!entryStat.isDirectory()) throw new Error(`miner SBOM scoped dependency entry must be a directory: ${path.relative(root, full)}`);
      recordPackage(full);
    }
  }

  function scanNodeModules(dir) {
    assertRegularDirectory(dir, root, 'node_modules');
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
      const full = path.join(dir, entry.name);
      const entryStat = fs.lstatSync(full);
      if (entryStat.isSymbolicLink()) throw new Error(`miner SBOM rejects dependency symlink: ${path.relative(root, full)}`);
      if (entry.name.startsWith('@')) {
        if (!entryStat.isDirectory()) throw new Error(`miner SBOM dependency scope must be a directory: ${path.relative(root, full)}`);
        scanScope(full);
        continue;
      }
      if (!entryStat.isDirectory()) throw new Error(`miner SBOM dependency entry must be a directory: ${path.relative(root, full)}`);
      recordPackage(full);
    }
  }

  scanNodeModules(nodeModules);
  return [...components.values()].sort((a, b) => componentKey(a).localeCompare(componentKey(b)));
}

export function buildMinerCandidateSbom(root, metadata) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  if (!fs.lstatSync(canonicalRoot).isDirectory()) throw new Error('miner SBOM root must be a directory');
  const packageJson = readJsonRegular(path.join(canonicalRoot, 'package.json'), 'package.json');
  const version = assertString(metadata?.version, 'version');
  const platform = assertString(metadata?.platform, 'platform');
  const arch = assertString(metadata?.arch, 'architecture');
  const sourceCommit = assertString(metadata?.sourceCommit, 'source commit');
  if (!['linux', 'macos'].includes(platform)) throw new Error('miner SBOM is limited to audited POSIX platforms');
  if (!COMMIT.test(sourceCommit)) throw new Error('miner SBOM source commit must be exact lowercase SHA-1');
  if (packageJson.name !== PACKAGE || packageJson.version !== version) throw new Error('miner SBOM package identity does not match candidate metadata');

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: PACKAGE,
        version,
        'bom-ref': `npm:${PACKAGE}@${version}`,
        properties: [
          { name: 'zyron.arch', value: arch },
          { name: 'zyron.platform', value: platform },
          { name: 'zyron.sourceCommit', value: sourceCommit }
        ]
      }
    },
    components: collectDependencyComponents(canonicalRoot)
  };
}

export function writeMinerCandidateSbom(root, metadata) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const sbom = buildMinerCandidateSbom(canonicalRoot, metadata);
  const finalPath = path.join(canonicalRoot, MINER_SBOM_FILE);
  if (fs.existsSync(finalPath)) throw new Error('miner SBOM already exists');
  const tempPath = path.join(canonicalRoot, `.${MINER_SBOM_FILE}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, finalPath);
  const stat = fs.lstatSync(finalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(finalPath) !== finalPath) throw new Error('miner SBOM publication path is not a bound regular file');
  return sbom;
}

export function verifyMinerCandidateSbom(root, expectedMetadata = null) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const file = path.join(canonicalRoot, MINER_SBOM_FILE);
  const sbom = readJsonRegular(file, 'document');
  const props = Object.fromEntries((sbom?.metadata?.component?.properties || []).map((p) => [p?.name, p?.value]));
  const metadata = expectedMetadata ?? {
    version: sbom?.metadata?.component?.version,
    platform: props['zyron.platform'],
    arch: props['zyron.arch'],
    sourceCommit: props['zyron.sourceCommit']
  };
  const expected = buildMinerCandidateSbom(canonicalRoot, metadata);
  if (JSON.stringify(sbom) !== JSON.stringify(expected)) throw new Error('miner SBOM verification failed');
  return sbom;
}
