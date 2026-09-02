#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMinerCandidateProvenance, verifyMinerCandidateProvenance, writeMinerCandidateProvenance } from './miner-candidate-provenance.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-provenance-')));
try {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@zyronchain/l1', version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'miner-sbom.cdx.json'), '{"bomFormat":"CycloneDX","specVersion":"1.5"}\n');
  const metadata = { version: '1.2.3', platform: 'linux', arch: 'x64', sourceCommit: 'a'.repeat(40) };

  const first = buildMinerCandidateProvenance(root, metadata);
  const second = buildMinerCandidateProvenance(root, metadata);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.kind, 'zyron.local-miner-candidate-provenance');
  assert.equal(first.build.sourceCommit, metadata.sourceCommit);
  assert.equal(first.materials.length, 1);
  assert.match(first.materials[0].digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.authority, { type: 'local-evidence-only', signed: false, published: false });

  writeMinerCandidateProvenance(root, metadata);
  assert.deepEqual(verifyMinerCandidateProvenance(root, metadata), first);

  const provenanceFile = path.join(root, 'miner-provenance.json');
  const original = fs.readFileSync(provenanceFile, 'utf8');
  const tampered = JSON.parse(original);
  tampered.build.sourceCommit = 'b'.repeat(40);
  fs.writeFileSync(provenanceFile, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => verifyMinerCandidateProvenance(root, metadata), /verification failed/);

  fs.writeFileSync(provenanceFile, original);
  fs.appendFileSync(path.join(root, 'miner-sbom.cdx.json'), ' ');
  assert.throws(() => verifyMinerCandidateProvenance(root, metadata), /verification failed/);
  fs.writeFileSync(path.join(root, 'miner-sbom.cdx.json'), '{"bomFormat":"CycloneDX","specVersion":"1.5"}\n');

  assert.throws(() => buildMinerCandidateProvenance(root, { ...metadata, sourceCommit: 'A'.repeat(40) }), /source commit/);
  assert.throws(() => buildMinerCandidateProvenance(root, { ...metadata, sourceCommit: 'not-a-commit' }), /source commit/);
  assert.throws(() => buildMinerCandidateProvenance(root, { ...metadata, platform: 'windows' }), /audited POSIX/);
  assert.throws(() => buildMinerCandidateProvenance(root, { ...metadata, version: '9.9.9' }), /package identity/);

  const sbom = path.join(root, 'miner-sbom.cdx.json');
  const sbomReal = path.join(root, 'sbom-real.json');
  fs.renameSync(sbom, sbomReal);
  try {
    fs.symlinkSync(sbomReal, sbom, 'file');
    assert.throws(() => buildMinerCandidateProvenance(root, metadata), /regular file|canonical/);
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
  } finally {
    fs.rmSync(sbom, { force: true });
    fs.renameSync(sbomReal, sbom);
  }

  const originalOpenSync = fs.openSync;
  const replacement = path.join(root, 'sbom-replacement.json');
  fs.writeFileSync(replacement, '{"bomFormat":"replacement"}\n');
  let replaced = false;
  fs.openSync = function patchedOpenSync(file, ...args) {
    if (!replaced && file === sbom) {
      replaced = true;
      fs.renameSync(sbom, `${sbom}.original`);
      fs.renameSync(replacement, sbom);
    }
    return originalOpenSync.call(fs, file, ...args);
  };
  try {
    assert.throws(() => buildMinerCandidateProvenance(root, metadata), /snapshot changed before read/);
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(sbom, { force: true });
    fs.renameSync(`${sbom}.original`, sbom);
    fs.rmSync(replacement, { force: true });
  }

  const originalReadFileSync = fs.readFileSync;
  let descriptorReads = 0;
  fs.readFileSync = function patchedReadFileSync(file, ...args) {
    if (typeof file === 'number') {
      descriptorReads += 1;
      if (descriptorReads === 2) fs.appendFileSync(sbom, ' ');
    }
    return originalReadFileSync.call(fs, file, ...args);
  };
  try {
    assert.throws(() => buildMinerCandidateProvenance(root, metadata), /mutated during read/);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync(sbom, '{"bomFormat":"CycloneDX","specVersion":"1.5"}\n');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner candidate provenance regressions passed');
