#!/usr/bin/env node
import { basename, dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertMinerPackagingCustodyReady } from './miner-packaging-custody-gate.mjs';
import { bindMinerReleaseRoot } from './miner-release-root.mjs';
import { materializeMinerPackagePosix } from './materialize-miner-package-posix.mjs';
import { resolveSourceCommit, verifyCandidateIntegrity, writeCandidateIntegrity } from './miner-candidate-integrity.mjs';
import { verifyMinerCandidateSbom, writeMinerCandidateSbom } from './miner-candidate-sbom.mjs';
import { verifyMinerCandidateProvenance, writeMinerCandidateProvenance } from './miner-candidate-provenance.mjs';

// Filesystem-custody completion (#761/#757/#683/#636) permits candidate
// materialization only on the audited POSIX descriptor-relative path. This is
// independent of public-mining activation, signing, external attestation and publication gates.
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
const metadata = { version, platform, arch, sourceCommit };

const bundle = await materializeMinerPackagePosix({ root, outRoot, bundleName, nodeName });
const sbom = writeMinerCandidateSbom(bundle, metadata);
verifyMinerCandidateSbom(bundle, metadata);
const provenance = writeMinerCandidateProvenance(bundle, metadata);
verifyMinerCandidateProvenance(bundle, metadata);
const integrity = writeCandidateIntegrity(bundle, metadata);
verifyCandidateIntegrity(bundle);

console.log(JSON.stringify({
  bundle,
  bundleName,
  platform,
  arch,
  runtime: basename(process.execPath),
  sourceCommit,
  sbomFile: 'miner-sbom.cdx.json',
  sbomComponents: sbom.components.length,
  provenanceFile: 'miner-provenance.json',
  provenanceMaterials: provenance.materials.length,
  integrityFile: 'candidate-integrity.json',
  integrityFiles: integrity.files.length
}));
