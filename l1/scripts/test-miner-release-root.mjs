#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindMinerReleaseRoot } from './miner-release-root.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-release-root-'));
try {
  const project = path.join(temp, 'project');
  const releaseRoot = path.join(project, 'miner-release');
  const external = path.join(temp, 'external');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(releaseRoot);
  fs.mkdirSync(external);
  const sentinel = path.join(external, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'outside\n');

  assert.equal(bindMinerReleaseRoot(project, releaseRoot), fs.realpathSync(releaseRoot));

  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.symlinkSync(external, releaseRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => bindMinerReleaseRoot(project, releaseRoot),
    /miner release output root must be a real directory/
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside\n');

  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.writeFileSync(releaseRoot, 'not a directory\n');
  assert.throws(
    () => bindMinerReleaseRoot(project, releaseRoot),
    /miner release output root must be a real directory/
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside\n');

  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const packageSource = fs.readFileSync(path.join(scriptsDir, 'package-miner.mjs'), 'utf8');
  const gateIndex = packageSource.indexOf('assertMinerPackagingCustodyReady();');
  const bindIndex = packageSource.indexOf("const outRoot = bindMinerReleaseRoot(root, resolve(root, 'miner-release'));");
  const materializeIndex = packageSource.indexOf('const bundle = await materializeMinerPackagePosix({ root, outRoot, bundleName, nodeName });');
  assert.ok(gateIndex >= 0, 'package-miner must retain the fail-closed custody activation gate');
  assert.ok(bindIndex > gateIndex, 'custody gate must fail closed before release-root binding');
  assert.ok(materializeIndex > bindIndex, 'release-root binding must precede descriptor-relative package materialization');
  assert.doesNotMatch(packageSource, /from ['"]node:fs\/promises['"]/, 'package-miner must not reintroduce pathname filesystem mutation imports');
  assert.doesNotMatch(packageSource, /await\s+(?:rm|mkdir|cp|writeFile|chmod)\s*\(/, 'package-miner must not reintroduce pathname bundle mutation');

  const zipSource = fs.readFileSync(path.join(scriptsDir, 'package-windows-miner-zip.mjs'), 'utf8');
  const zipImportIndex = zipSource.indexOf("import { bindMinerReleaseRoot } from './miner-release-root.mjs';");
  const zipBindIndex = zipSource.indexOf("const releaseRoot = bindMinerReleaseRoot(root, resolve(root, 'miner-release'));");
  const zipReadIndex = zipSource.indexOf('readdir(releaseRoot, { withFileTypes: true })');
  const zipPowerShellIndex = zipSource.indexOf("spawnSync('powershell.exe'");
  assert.ok(zipImportIndex >= 0, 'Windows ZIP helper must import the canonical release-root binder');
  assert.ok(zipBindIndex > zipImportIndex, 'Windows ZIP helper must bind the canonical release root');
  assert.ok(zipReadIndex > zipBindIndex, 'Windows ZIP helper must bind the release root before bundle discovery');
  assert.ok(zipPowerShellIndex > zipBindIndex, 'Windows ZIP helper must bind the release root before archive operations');

  console.log('miner release root custody regression passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
