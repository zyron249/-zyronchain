#!/usr/bin/env node
import { basename, dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertMinerPackagingCustodyReady } from './miner-packaging-custody-gate.mjs';
import { bindMinerReleaseRoot } from './miner-release-root.mjs';
import { materializeMinerPackagePosix } from './materialize-miner-package-posix.mjs';
import { resolveSourceCommit, verifyCandidateIntegrity, writeCandidateIntegrity } from './miner-candidate-integrity.mjs';

// Filesystem-custody completion (#761/#757/#683/#636) permits candidate
// materialization only on the audited POSIX descriptor-relative path. This is
// independent of public-mining activation, signing, provenance and publication gates.
assertMinerPackagingCustodyReady(process.platform);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outRoot = bindMinerReleaseRoot(root, resolve(root, 'miner-release'));
const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
if (!platform) throw new Error(`Unsupported miner package platform: ${process.platform}`);

const arch = process.arch;
const bundleName = `ZyronMiner-${platform}-${arch}`;
const nodeName = 'node';
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sourceCommit = resolveSourceCommit(root);

const bundle = await materializeMinerPackagePosix({ root, outRoot, bundleName, nodeName });
const integrity = writeCandidateIntegrity(bundle, { version, platform, arch, sourceCommit });
verifyCandidateIntegrity(bundle);

console.log(JSON.stringify({ bundle, bundleName, platform, arch, runtime: basename(process.execPath), sourceCommit, integrityFile: 'candidate-integrity.json', integrityFiles: integrity.files.length }));
