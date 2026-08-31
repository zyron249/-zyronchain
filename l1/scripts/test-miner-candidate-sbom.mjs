#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMinerCandidateSbom, verifyMinerCandidateSbom, writeMinerCandidateSbom } from './miner-candidate-sbom.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-sbom-'));
try {
  fs.mkdirSync(path.join(root, 'node_modules', 'dep-a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', '@scope', 'dep-b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@zyronchain/l1', version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'node_modules', 'dep-a', 'package.json'), JSON.stringify({ name: 'dep-a', version: '2.0.0' }));
  fs.writeFileSync(path.join(root, 'node_modules', '@scope', 'dep-b', 'package.json'), JSON.stringify({ name: '@scope/dep-b', version: '3.0.0' }));

  const metadata = { version: '1.2.3', platform: 'linux', arch: 'x64', sourceCommit: 'a'.repeat(40) };
  const first = buildMinerCandidateSbom(root, metadata);
  const second = buildMinerCandidateSbom(root, metadata);
  assert.deepEqual(first, second);
  assert.equal(first.bomFormat, 'CycloneDX');
  assert.equal(first.metadata.component.version, metadata.version);
  assert.equal(first.components.length, 2);
  assert.deepEqual(first.components.map((c) => c.name), ['@scope/dep-b', 'dep-a']);

  writeMinerCandidateSbom(root, metadata);
  assert.deepEqual(verifyMinerCandidateSbom(root, metadata), first);

  const file = path.join(root, 'miner-sbom.cdx.json');
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.metadata.component.properties.find((p) => p.name === 'zyron.sourceCommit').value = 'b'.repeat(40);
  fs.writeFileSync(file, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => verifyMinerCandidateSbom(root, metadata), /verification failed/);

  fs.writeFileSync(file, `${JSON.stringify(first, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'node_modules', 'dep-a', 'package.json'), JSON.stringify({ name: 'dep-a', version: '2.0.1' }));
  assert.throws(() => verifyMinerCandidateSbom(root, metadata), /verification failed/);

  assert.throws(() => buildMinerCandidateSbom(root, { ...metadata, sourceCommit: 'not-a-commit' }), /source commit/);
  assert.throws(() => buildMinerCandidateSbom(root, { ...metadata, platform: 'windows' }), /audited POSIX/);
  assert.throws(() => buildMinerCandidateSbom(root, { ...metadata, version: '9.9.9' }), /package identity/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner candidate SBOM regressions passed');
