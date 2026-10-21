// JS light-client verifier against the published vectors. No keys, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(import.meta.url);
globalThis.ZyronSecp256k1 = require('./vendor/secp256k1-verify.js');
const lc = require('./light-client.js');

const load = (name) => JSON.parse(readFileSync(join(repo, 'l1', 'test-vectors', name), 'utf8'));
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

test('sha256 matches the platform hash', () => {
  for (const sample of ['', 'abc', 'ZyronChain/state-v2/key\0']) {
    const bytes = new TextEncoder().encode(sample);
    assert.equal(lc.sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
  }
});

test('canonical key order matches the UTF-16 protocol rule', () => {
  const value = { "\u00e9": 6, z: 4, _: 2, "\u{1F600}": 7, a: 3, "\u00e4": 5, A: 1 };
  const expected = '{"A":1,"_":2,"a":3,"z":4,"\u00e4":5,"\u00e9":6,"\u{1F600}":7}';
  assert.equal(lc.canonicalJson(value), expected);
});

test('light-client-v1.json verifies, including the State-v2 inclusion proof', () => {
  lc.verifyVector(load('light-client-v1.json'));
});

test('header hash substitution fails', () => {
  const vector = load('light-client-v1.json');
  vector.finalityProof.hash = '00'.repeat(32);
  assert.throws(() => lc.verifyVector(vector), /block hash mismatch/);
});

test('proposer signature substitution fails', () => {
  const vector = load('light-client-v1.json');
  vector.finalityProof.signature = '00'.repeat(64);
  assert.throws(() => lc.verifyVector(vector), /proposer signature/);
});

test('finality requires a strict supermajority', () => {
  const vector = load('light-client-v1.json');
  vector.finalityProof.attestations = vector.finalityProof.attestations.slice(0, 2);
  assert.throws(() => lc.verifyNextFinalized(vector.anchor, vector.finalityProof), /quorum/);
});

test('a duplicate attestation does not count twice', () => {
  const vector = load('light-client-v1.json');
  vector.finalityProof.attestations[1] = structuredClone(vector.finalityProof.attestations[0]);
  assert.throws(() => lc.verifyNextFinalized(vector.anchor, vector.finalityProof), /duplicate/);
});

test('a wrong trust anchor fails', () => {
  const vector = load('light-client-v1.json');
  vector.anchor.blockHash = '44'.repeat(32);
  assert.throws(() => lc.verifyNextFinalized(vector.anchor, vector.finalityProof), lc.VerificationError);
});

test('round 1 requires an authenticated skip quorum', () => {
  const vector = load('light-client-v1-round1.json');
  const next = lc.verifyNextFinalized(vector.anchor, vector.finalityProof);
  assert.equal(next.blockHash, vector.finalityProof.hash);
  const short = structuredClone(vector.finalityProof);
  short.roundCertificate = short.roundCertificate.slice(0, 2);
  assert.throws(() => lc.verifyNextFinalized(vector.anchor, short), /skip quorum/);
  const forged = structuredClone(vector.finalityProof);
  forged.roundCertificate[0].signature = '00'.repeat(64);
  assert.throws(() => lc.verifyNextFinalized(vector.anchor, forged), /skip signature/);
});

test('protocol v3 enforces the signing domain', () => {
  const vector = load('light-client-v3-finality.json');
  const next = lc.verifyNextFinalized(vector.anchor, vector.finalityProof);
  assert.equal(lc.canonicalJson(next), lc.canonicalJson(vector.expectedNext));
  const legacy = structuredClone(vector.finalityProof);
  legacy.signature = vector.legacyProposerSignature;
  assert.throws(() => lc.verifyNextFinalized(vector.anchor, legacy), /proposer signature/);
});

test('state root, key, and value substitution fail', () => {
  const vector = load('light-client-v1.json');
  const next = lc.verifyNextFinalized(vector.anchor, vector.finalityProof);
  const state = vector.stateProof;
  assert.equal(lc.verifyStateProof(next, state.key, state.value, state.proof), true);
  assert.equal(lc.verifyStateProof({ ...next, stateRoot: '55'.repeat(32) }, state.key, state.value, state.proof), false);
  assert.equal(lc.verifyStateProof(next, 'account:bob', state.value, state.proof), false);
  const wrong = { ...state.value, balanceAtoms: state.value.balanceAtoms + 1 };
  assert.equal(lc.verifyStateProof(next, state.key, wrong, state.proof), false);
});

test('a state sibling substitution fails', () => {
  const vector = load('light-client-v1.json');
  const next = lc.verifyNextFinalized(vector.anchor, vector.finalityProof);
  const proof = structuredClone(vector.stateProof.proof);
  proof.siblings[0] = '66'.repeat(32);
  assert.equal(lc.verifyStateProof(next, vector.stateProof.key, vector.stateProof.value, proof), false);
});

test('state-v2-nonmembership-v1.json verifies and rejects substitution', () => {
  const vector = load('state-v2-nonmembership-v1.json');
  const anchor = { ...load('light-client-v1.json').expectedNext, stateRoot: vector.root };
  assert.equal(vector.value, null);
  assert.equal(lc.verifyStateProof(anchor, vector.key, null, vector.proof), true);
  assert.equal(lc.verifyStateProof(anchor, 'account:mallory', null, vector.proof), false);
  const forged = structuredClone(vector.proof);
  forged.siblings[0] = '66'.repeat(32);
  assert.equal(lc.verifyStateProof(anchor, vector.key, null, forged), false);
});

test('launch profile fixed-supply-v1 requires at least 4 distinct validators', () => {
  const validators = load('light-client-v1.json').anchor.validators;
  assert.equal(validators.length >= 4, true);
  const ok = lc.assessLaunchProfileValidators(validators);
  assert.equal(ok.ok, true);
  assert.equal(ok.distinct, validators.length);
  const short = lc.assessLaunchProfileValidators(validators.slice(0, 3));
  assert.equal(short.ok, false);
  assert.match(short.detail, /at least 4 distinct validators/);
  const dup = structuredClone(validators);
  dup[1] = structuredClone(dup[0]);
  assert.equal(lc.assessLaunchProfileValidators(dup).ok, false);
});

test('quorum for 4 validators is 3', () => {
  assert.equal(lc.quorumSize(4), 3);
});

test('v6 commit certificate fixture verifies and a short quorum fails', () => {
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'v6-window.json'), 'utf8'));
  const base = {
    chainId: fixture.chainId,
    genesisHash: fixture.genesisHash,
    protocolVersion: 6,
    validators: fixture.validators
  };
  const first = lc.verifyStandaloneHeader(base, lc.mapBlockToProof(fixture.blocks[0]));
  assert.equal(first.authenticity.signers, 3);
  assert.equal(first.authenticity.quorum, 3);
  const second = lc.verifyNextFinalizedDetailed(first.anchor, lc.mapBlockToProof(fixture.blocks[1]));
  assert.equal(second.anchor.height, 102);
  assert.equal(second.anchor.blockHash, fixture.blocks[1].hash);
  const short = lc.mapBlockToProof(fixture.blocks[1]);
  short.attestations = short.attestations.slice(0, 2);
  assert.throws(() => lc.verifyNextFinalized(first.anchor, short), /quorum/);
});

console.log(`light-client tests passed: ${passed}`);
