#!/usr/bin/env node
import assert from 'node:assert/strict';
import boundary from './windows-miner-release-boundary.json' with { type: 'json' };
assert.equal(boundary.publicMiningActivated, false);
assert.equal(boundary.publicationAllowed, false);
assert.equal(boundary.requiresImmutableRelease, true);
assert.equal(boundary.requiresProvenance, true);
assert.equal(boundary.requiresWindowsSigningEvidence, true);
assert.equal(boundary.doubleClickLauncher, 'ZyronMiner.cmd');
console.log('Windows release boundary: ok');
