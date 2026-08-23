#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyMinerRuntimeTree } from './copy-miner-runtime-tree.mjs';
import { collectReleaseFiles, generateMinerSha256Sums } from './generate-miner-sha256sums.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-manifest-'));
try {
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'b.txt'), 'bravo');
  fs.writeFileSync(path.join(root, 'nested', 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), 'stale manifest must be excluded');

  const manifest = generateMinerSha256Sums(root);
  const expected = [
    [path.join(root, 'b.txt'), 'bravo'],
    [path.join(root, 'nested', 'a.txt'), 'alpha']
  ].sort(([a], [b]) => a.localeCompare(b)).map(([file, contents]) => {
    const digest = crypto.createHash('sha256').update(contents).digest('hex');
    return `${digest}  ${path.relative(process.cwd(), file).replaceAll('\\', '/')}`;
  }).join('\n') + '\n';
  assert.equal(manifest, expected, 'manifest must deterministically hash every regular file except itself');

  const fakeDirent = {
    name: 'unsupported-entry',
    isDirectory: () => false,
    isFile: () => false
  };
  assert.throws(
    () => collectReleaseFiles(root, { readdirSync: () => [fakeDirent] }),
    /unsupported non-regular miner release entry/,
    'non-regular entries must fail closed'
  );

  if (process.platform !== 'win32') {
    const link = path.join(root, 'linked-file');
    fs.symlinkSync(path.join(root, 'b.txt'), link);
    assert.throws(
      () => collectReleaseFiles(root),
      /unsupported non-regular miner release entry: linked-file/,
      'symlinks must not be followed or silently omitted'
    );
    fs.rmSync(link);

    const sourceTree = path.join(root, 'runtime-source');
    const copiedTree = path.join(root, 'runtime-candidate');
    fs.mkdirSync(path.join(sourceTree, '.bin'), { recursive: true });
    fs.writeFileSync(path.join(sourceTree, 'tool.js'), 'runtime-tool');
    fs.symlinkSync(path.join('..', 'tool.js'), path.join(sourceTree, '.bin', 'tool'));
    copyMinerRuntimeTree(sourceTree, copiedTree);
    assert.equal(fs.lstatSync(path.join(copiedTree, '.bin', 'tool')).isFile(), true, 'internal npm executable shim must be materialized as a regular file');
    assert.doesNotThrow(() => collectReleaseFiles(copiedTree), 'materialized runtime trees must be fully checksum-coverable');

    const outside = path.join(root, 'outside-secret.txt');
    fs.writeFileSync(outside, 'must-not-enter-release');

    const regularRaceTree = path.join(root, 'runtime-regular-race-source');
    const regularRaceSource = path.join(regularRaceTree, 'tool.js');
    const regularRaceDestination = path.join(root, 'runtime-regular-race-candidate');
    fs.mkdirSync(regularRaceTree);
    fs.writeFileSync(regularRaceSource, 'validated-runtime-tool');
    let regularRaceInjected = false;
    const regularRacingFsOps = new Proxy(fs, {
      get(target, property) {
        if (property === 'openSync') {
          return (candidate, ...args) => {
            if (!regularRaceInjected && path.resolve(candidate) === path.resolve(regularRaceSource)) {
              regularRaceInjected = true;
              fs.rmSync(regularRaceSource);
              fs.symlinkSync(outside, regularRaceSource);
            }
            return fs.openSync(candidate, ...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    assert.throws(
      () => copyMinerRuntimeTree(regularRaceTree, regularRaceDestination, regularRacingFsOps),
      /miner runtime source identity changed before copy: tool\.js/,
      'regular source replacement after lstat must fail closed before candidate bytes are written'
    );
    assert.equal(regularRaceInjected, true, 'regular source race regression must exercise the descriptor-open boundary');
    assert.equal(fs.existsSync(path.join(regularRaceDestination, 'tool.js')), false, 'raced regular source bytes must not enter the candidate');

    const symlinkRaceTree = path.join(root, 'runtime-symlink-race-source');
    const symlinkTarget = path.join(symlinkRaceTree, 'target.js');
    const symlinkEntry = path.join(symlinkRaceTree, 'tool');
    const symlinkRaceDestination = path.join(root, 'runtime-symlink-race-candidate');
    fs.mkdirSync(symlinkRaceTree);
    fs.writeFileSync(symlinkTarget, 'validated-symlink-target');
    fs.symlinkSync('target.js', symlinkEntry);
    let symlinkRaceInjected = false;
    const symlinkRacingFsOps = new Proxy(fs, {
      get(target, property) {
        if (property === 'openSync') {
          return (candidate, ...args) => {
            if (!symlinkRaceInjected && path.resolve(candidate) === path.resolve(symlinkTarget)) {
              symlinkRaceInjected = true;
              fs.rmSync(symlinkTarget);
              fs.symlinkSync(outside, symlinkTarget);
            }
            return fs.openSync(candidate, ...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    assert.throws(
      () => copyMinerRuntimeTree(symlinkRaceTree, symlinkRaceDestination, symlinkRacingFsOps),
      /miner runtime source identity changed before copy: tool/,
      'npm symlink target replacement after validation must fail closed before candidate bytes are written'
    );
    assert.equal(symlinkRaceInjected, true, 'symlink target race regression must exercise the descriptor-open boundary');
    assert.equal(fs.existsSync(path.join(symlinkRaceDestination, 'tool')), false, 'raced symlink target bytes must not enter the candidate');

    const existingEmptyDestination = path.join(root, 'runtime-existing-empty');
    fs.mkdirSync(existingEmptyDestination);
    assert.throws(
      () => copyMinerRuntimeTree(sourceTree, existingEmptyDestination),
      /miner runtime destination must not already exist/,
      'runtime packaging must reject an already-existing empty destination'
    );
    assert.deepEqual(fs.readdirSync(existingEmptyDestination), [], 'existing empty destination rejection must not mutate destination material');

    const existingSeededDestination = path.join(root, 'runtime-existing-seeded');
    fs.mkdirSync(existingSeededDestination);
    fs.writeFileSync(path.join(existingSeededDestination, 'stale.txt'), 'stale-release-state');
    assert.throws(
      () => copyMinerRuntimeTree(sourceTree, existingSeededDestination),
      /miner runtime destination must not already exist/,
      'runtime packaging must reject a pre-seeded destination'
    );
    assert.equal(fs.readFileSync(path.join(existingSeededDestination, 'stale.txt'), 'utf8'), 'stale-release-state', 'pre-seeded destination rejection must not mutate prior material');
    assert.equal(fs.existsSync(path.join(existingSeededDestination, 'tool.js')), false, 'pre-seeded destination rejection must not copy source material');

    const racedDestination = path.join(root, 'runtime-raced-destination');
    const racedDestinationCanonical = path.join(fs.realpathSync(path.dirname(racedDestination)), path.basename(racedDestination));
    let injectedRace = false;
    const racingFsOps = new Proxy(fs, {
      get(target, property) {
        if (property === 'mkdirSync') {
          return (candidate, options) => {
            if (!injectedRace && path.resolve(candidate) === path.resolve(racedDestinationCanonical)) {
              injectedRace = true;
              fs.mkdirSync(racedDestination);
            }
            return fs.mkdirSync(candidate, options);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    assert.throws(
      () => copyMinerRuntimeTree(sourceTree, racedDestination, racingFsOps),
      /miner runtime destination appeared before atomic creation/,
      'runtime packaging must fail closed if the destination appears between preflight and atomic creation'
    );
    assert.equal(injectedRace, true, 'destination race regression must exercise the atomic creation boundary');
    assert.deepEqual(fs.readdirSync(racedDestination), [], 'raced destination must not receive source material');
    assert.equal(fs.existsSync(path.join(racedDestination, 'tool.js')), false, 'destination race must fail before copying source files');

    const nestedDestination = path.join(sourceTree, 'candidate');
    assert.throws(
      () => copyMinerRuntimeTree(sourceTree, nestedDestination),
      /miner runtime destination must remain outside source root/,
      'runtime packaging must reject a destination nested beneath the source tree'
    );
    assert.equal(fs.existsSync(nestedDestination), false, 'nested destination rejection must occur before creating destination material');
    assert.throws(
      () => copyMinerRuntimeTree(sourceTree, sourceTree),
      /miner runtime destination must not already exist/,
      'runtime packaging must reject the source root as its own destination before mutation'
    );
    assert.equal(fs.readFileSync(path.join(sourceTree, 'tool.js'), 'utf8'), 'runtime-tool', 'same-root rejection must not mutate source material');

    const escapeTree = path.join(root, 'runtime-escape-source');
    fs.mkdirSync(escapeTree);
    fs.symlinkSync(outside, path.join(escapeTree, 'escape'));
    assert.throws(
      () => copyMinerRuntimeTree(escapeTree, path.join(root, 'runtime-escape-candidate')),
      /miner runtime symlink escapes source root/,
      'runtime packaging must not dereference a symlink outside node_modules'
    );
  }

  const packageMinerSource = fs.readFileSync(path.resolve(process.cwd(), 'scripts/package-miner.mjs'), 'utf8');
  assert.match(
    packageMinerSource,
    /copyMinerRuntimeTree\(join\(root, 'node_modules'\), join\(bundle, 'node_modules'\)\)/,
    'canonical miner packaging must use the bounded runtime-tree materializer'
  );
  assert.doesNotMatch(
    packageMinerSource,
    /node_modules[^\n]+dereference:\s*true/,
    'canonical miner packaging must not globally dereference untrusted runtime symlinks'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner release manifest regressions passed');