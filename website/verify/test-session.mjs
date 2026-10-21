// Report builder and retry classification. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
globalThis.ZyronSecp256k1 = require('./vendor/secp256k1-verify.js');
globalThis.ZyronLightClient = require('./light-client.js');
const session = require('./session.js');
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'v6-window.json'), 'utf8'));

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };
const byId = (report, id) => report.checks.find((item) => item.id === id);

function docs(overrides = {}) {
  return {
    genesisBody: {
      network: 'testnet',
      valueBearing: false,
      genesisHash: fixture.genesisHash,
      genesis: {
        chainId: fixture.chainId,
        launchProfile: 'fixed-supply-v1',
        timestampMs: fixture.genesisTimestampMs,
        validators: fixture.validators
      }
    },
    statusBody: {
      network: 'testnet',
      valueBearing: false,
      chainId: fixture.chainId,
      genesisHash: fixture.genesisHash,
      height: 102,
      protocolVersion: 6
    },
    blocks: fixture.blocks,
    ...overrides
  };
}

test('backoff grows and then caps', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(session.backoffDelayMs), [1500, 3000, 6000, 12000, 20000, 20000]);
});

test('cold start, sleep, and a value-bearing response are explicit', () => {
  const cold = session.classifyHealth(200, { ok: false, status: 'starting', phase: 'validators', network: 'testnet', valueBearing: false }, null);
  assert.equal(cold.kind, 'cold');
  assert.equal(cold.retry, true);
  assert.match(cold.detail, /phase validators/);
  const stalled = session.classifyHealth(503, { status: 'stalled', network: 'testnet', valueBearing: false }, null);
  assert.equal(stalled.kind, 'cold');
  const asleep = session.classifyHealth(0, null, Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(asleep.kind, 'asleep');
  assert.match(asleep.detail, /sleep|wake/i);
  const refused = session.classifyHealth(200, { valueBearing: true, network: 'testnet' }, null);
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.retry, false);
  const ready = session.classifyHealth(200, { ok: true, status: 'ready', network: 'testnet', valueBearing: false }, null);
  assert.equal(ready.kind, 'ready');
});

test('v6 window passes signature checks and records a pin mismatch', () => {
  const report = session.buildReport(docs());
  assert.equal(report.network, 'testnet');
  assert.equal(report.kind, 'verified-pin-mismatch');
  assert.equal(report.verifiedHeight, 102);
  assert.equal(byId(report, 'header-hash').status, 'passed');
  assert.equal(byId(report, 'header-chain').status, 'passed');
  assert.equal(byId(report, 'proposer-signature').status, 'passed');
  assert.equal(byId(report, 'finality-quorum').status, 'passed');
  assert.equal(byId(report, 'launch-profile').status, 'passed');
  assert.match(byId(report, 'launch-profile').detail, /4 distinct validators/);
  assert.equal(byId(report, 'state-root').status, 'passed');
  assert.equal(byId(report, 'state-proof').status, 'not available on this network');
  assert.equal(byId(report, 'validator-transition').status, 'not available on this network');
  assert.equal(byId(report, 'protocol-transition').status, 'not available on this network');
  assert.equal(byId(report, 'full-history').status, 'not verified in this pass');
  assert.equal(byId(report, 'repository-pin').status, 'failed');
});

test('a matching pin is a passed check', () => {
  const report = session.buildReport(docs({ pin: fixture.genesisHash }));
  assert.equal(report.kind, 'verified');
  assert.equal(byId(report, 'repository-pin').status, 'passed');
});

test('a summary block is not available, not a fake pass', () => {
  const report = session.buildReport(docs({
    pin: fixture.genesisHash,
    blocks: [{ height: 10, hash: 'aa'.repeat(32), previousHash: 'bb'.repeat(32), attestations: 4, header: { height: 10 } }]
  }));
  assert.equal(report.kind, 'unavailable');
  assert.equal(report.verifiedHeight, null);
  assert.equal(byId(report, 'proposer-signature').status, 'not available on this network');
  assert.equal(byId(report, 'finality-quorum').status, 'not available on this network');
  assert.equal(byId(report, 'state-proof').status, 'not available on this network');
});

test('fewer than 4 launch-profile validators fails closed', () => {
  const input = docs({ pin: fixture.genesisHash });
  input.genesisBody.genesis.validators = fixture.validators.slice(0, 3);
  const report = session.buildReport(input);
  assert.equal(report.kind, 'failed');
  assert.equal(byId(report, 'launch-profile').status, 'failed');
  assert.equal(byId(report, 'header-hash'), undefined);
});

test('a bad proposer signature fails the header check', () => {
  const blocks = structuredClone(fixture.blocks);
  blocks[1].signature = '00'.repeat(64);
  const report = session.buildReport(docs({ pin: fixture.genesisHash, blocks }));
  assert.equal(report.kind, 'failed');
  assert.equal(byId(report, 'proposer-signature').status, 'failed');
});

test('short chains are fetched in full and tall chains keep a bounded window', () => {
  const full = session.blockBatches(250);
  assert.equal(full[0].from, 1);
  assert.equal(full.at(-1).from + full.at(-1).limit - 1, 250);
  assert.ok(full.every((batch) => batch.limit <= session.BATCH));
  const tall = session.blockBatches(session.FULL_CHAIN_MAX + 50);
  assert.deepEqual(tall[0], { from: 1, limit: 1 });
  assert.equal(tall[1].from, session.FULL_CHAIN_MAX + 50 - session.WINDOW + 1);
  assert.equal(tall[1].from + tall[1].limit - 1, session.FULL_CHAIN_MAX + 50);
});

console.log(`verify session tests passed: ${passed}`);
