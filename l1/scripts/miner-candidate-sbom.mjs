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

function collectDependencyComponents(root) {
  const nodeModules = path.join(root, 'node_modules');
  const stat = fs.lstatSync(nodeModules);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('miner SBOM node_modules must be a regular directory');
  const components = new Map();

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.bin') continue;
      const full = path.join(dir, entry.name);
      const entryStat = fs.lstatSync(full);
      if (entryStat.isSymbolicLink()) throw new Error(`miner SBOM rejects dependency symlink: ${path.relative(root, full)}`);
      if (!entryStat.isDirectory()) continue;

      const packageJson = path.join(full, 'package.json');
      if (fs.existsSync(packageJson)) {
        const pkg = readJsonRegular(packageJson, 'dependency package.json');
        const name = assertString(pkg.name, 'dependency name');
        const version = assertString(pkg.version, 'dependency version');
        const component = { type: 'library', name, version, 'bom-ref': `npm:${name}@${version}` };
        components.set(componentKey(component), component);
      }

      walk(full);
    }
  }

  walk(nodeModules);
  return [...components.values()].sort((a, b) => componentKey(a).localeCompare(componentKey(b)));
}

export function buildMinerCandidateSbom(root, metadata) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  if (!fs.lstatSync(canonicalRoot).isDirectory()) throw new Error('miner SBOM root must be a directory');
  const packageJson = readJsonRegular(path.join(canonicalRoot, 'package.json'), 'package.json');
  const version = assertString(metadata?.version, 'version');
  const platform = assertString(metadata?.platform, 'platform');
  const arch = assertString(metadata?.arch, 'architecture');
  const sourceCommit = assertString(metadata?.sourceCommit, 'source commit').toLowerCase();
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
