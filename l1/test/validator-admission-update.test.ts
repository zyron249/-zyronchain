// P1-07 (F-05 residual), part 2: on a chain whose genesis opts in to
// `validatorAdmission` (possession-proof-v1), a `validator_update` must carry
// one possession proof per incoming validator (relative to the latest
// scheduled set it replaces), bound to the chain ID, the genesis hash, the
// activation height and the slot. Chains without the opt-in refuse the field.
// Design: docs/VALIDATOR_POSSESSION_PROOF.md.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBlockAttestation, createSignedBlock, expectedValidator } from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { NodeService } from "../src/node.js";
import { ChainStore } from "../src/storage.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonical, signCanonicalDomain } from "../src/crypto.js";
import { createValidatorApproval, createValidatorSetUpdate, validateTransactionShape } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type Block, type GenesisConfig, type Validator, type ValidatorPossessionProof, type ValidatorSetUpdateTx } from "../src/types.js";
import {
  POSSESSION_PROOF_DOMAIN,
  possessionProofPayload,
  signGenesisPossessionProofs,
  signValidatorUpdatePossessionProof
} from "../src/validator-admission.js";

const ZYN = ATOMS_PER_ZYN;
const T0 = 1_700_000_000_000;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const validator = (n: number): Validator => ({ address: addr(n), publicKey: pub(n) });
const GENESIS_SET = [0x21, 0x22, 0x23, 0x24];
const MISSING = /possession proof/i;
const ID_BY_ADDRESS = new Map([0x21, 0x22, 0x23, 0x24, 0x25, 0x26].map((id) => [addr(id), id]));
function proposerId(chain: ZyronChain): number {
  return ID_BY_ADDRESS.get(expectedValidator(chain.validatorsAt(chain.height + 1), chain.height + 1, 0).address)!;
}
const INVALID = /Invalid validator possession proof/;

function devGenesis(chainId: string): GenesisConfig {
  const pool = addr(0x90);
  return {
    chainId,
    timestampMs: T0,
    validators: GENESIS_SET.map(validator),
    activityOracles: [pub(0x91)],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 1_000 * ZYN }]
  };
}

function optedIn(chainId = "zyron-devnet-admit"): GenesisConfig {
  return signGenesisPossessionProofs(devGenesis(chainId), GENESIS_SET.map(key));
}

function proof(chain: ZyronChain, activationHeight: number, id: number): ValidatorPossessionProof {
  return signValidatorUpdatePossessionProof({
    chainId: chain.genesis.chainId,
    genesisHash: chain.genesisHash,
    activationHeight,
    validator: validator(id)
  }, key(id));
}

function update(
  chain: ZyronChain,
  next: number[],
  options: { activationHeight?: number; nonce?: number; proofs?: ValidatorPossessionProof[] | "omit"; signers?: number[] } = {}
): ValidatorSetUpdateTx {
  const activationHeight = options.activationHeight ?? 150;
  const signers = options.signers ?? GENESIS_SET.slice(0, 3);
  const sender = signers[0]!;
  const input = {
    chainId: chain.genesis.chainId,
    nonce: options.nonce ?? 1,
    sender: addr(sender),
    activationHeight,
    validators: next.map(validator)
  };
  const approvals = signers.map((id) => createValidatorApproval(input, key(id), pub(id)));
  const proofs = options.proofs ?? "omit";
  return createValidatorSetUpdate({
    ...input,
    approvals,
    timestampMs: T0 + 10,
    ...(proofs === "omit" ? {} : { possessionProofs: proofs })
  }, key(sender), pub(sender));
}

function smuggle(chain: ZyronChain, transactions: ValidatorSetUpdateTx[], at: number): Block {
  const block = createSignedBlock({
    version: 1,
    chainId: chain.genesis.chainId,
    height: chain.height + 1,
    round: 0,
    previousHash: chain.tip.hash,
    timestampMs: at,
    transactions,
    stateRoot: "00".repeat(32),
    proposerPrivateKey: key(proposerId(chain)),
    proposerPublicKey: pub(proposerId(chain))
  });
  return block;
}

/** Refused on every chain path: mempool, selection, production, proposal and an attested block. */
function refusedEverywhere(chain: ZyronChain, transactions: ValidatorSetUpdateTx[], pattern: RegExp): void {
  const at = chain.tip.header.timestampMs + 1_000;
  const heightBefore = chain.height;
  const last = transactions[transactions.length - 1]!;
  if (transactions.length === 1) assert.throws(() => chain.validateMempoolAdmission(last, at), pattern, "mempool");
  const selected = chain.selectValidPending(transactions, 10, undefined, at);
  assert.ok(!selected.some((tx) => tx.txid === last.txid), "selection");
  assert.throws(() => chain.produceBlock(transactions, key(proposerId(chain)), { timestampMs: at }), pattern, "produceBlock");
  const block = smuggle(chain, transactions, at);
  assert.throws(() => chain.validateProposal(block, at), pattern, "validateProposal");
  let attested = block;
  for (const id of GENESIS_SET.slice(0, 3)) attested = { ...attested, attestations: [...attested.attestations, createBlockAttestation(block, key(id), pub(id))] };
  assert.throws(() => chain.acceptBlock(attested, at), pattern, "acceptBlock");
  assert.equal(chain.height, heightBefore);
}

function acceptedEverywhere(chain: ZyronChain, transactions: ValidatorSetUpdateTx[]): void {
  const at = chain.tip.header.timestampMs + 1_000;
  const heightBefore = chain.height;
  if (transactions.length === 1) assert.doesNotThrow(() => chain.validateMempoolAdmission(transactions[0]!, at));
  assert.equal(chain.selectValidPending(transactions, 10, undefined, at).length, transactions.length);
  let block = chain.produceBlock(transactions, key(proposerId(chain)), { timestampMs: at });
  assert.doesNotThrow(() => chain.validateProposal(block, at));
  for (const id of GENESIS_SET.slice(0, 3)) block = chain.attestBlock(block, key(id));
  chain.acceptBlock(block, at);
  assert.equal(chain.height, heightBefore + 1);
}

test("opted-in chain: an update adding a validator without a proof is refused on every path", () => {
  const chain = new ZyronChain(optedIn());
  refusedEverywhere(chain, [update(chain, [0x21, 0x22, 0x23, 0x25])], MISSING);
  refusedEverywhere(chain, [update(chain, [0x21, 0x22, 0x23, 0x25], { proofs: [] })], MISSING);
});

test("opted-in chain: a valid proof is accepted, continuing validators need none, and the set activates", () => {
  const chain = new ZyronChain(optedIn());
  const tx = update(chain, [0x21, 0x22, 0x23, 0x25], { proofs: [proof(chain, 150, 0x25)] });
  acceptedEverywhere(chain, [tx]);
  assert.deepEqual(chain.validatorsAt(149).map((item) => item.address), GENESIS_SET.map(addr));
  assert.deepEqual(chain.validatorsAt(150).map((item) => item.address), [0x21, 0x22, 0x23, 0x25].map(addr));

  // Removing a validator (no incoming key) needs an empty array, not a proof.
  const shrink = new ZyronChain(optedIn("zyron-devnet-shrink"));
  acceptedEverywhere(shrink, [update(shrink, [0x21, 0x22, 0x23], { proofs: [] })]);
});

test("proofs by another key, chain, genesis, height, slot or without the domain are refused", () => {
  const chain = new ZyronChain(optedIn());
  const next = [0x21, 0x22, 0x23, 0x25];
  const statement = {
    chainId: chain.genesis.chainId,
    chainBinding: chain.genesisHash,
    activationHeight: 150,
    address: addr(0x25),
    publicKey: pub(0x25)
  };
  const as = (signature: string): ValidatorPossessionProof[] => [{ address: addr(0x25), signature }];
  const variants: Array<[string, string]> = [
    ["another key (an approver)", signCanonicalDomain(POSSESSION_PROOF_DOMAIN, possessionProofPayload(statement), key(0x21))],
    ["another chain ID", signCanonicalDomain(POSSESSION_PROOF_DOMAIN, possessionProofPayload({ ...statement, chainId: "zyron-devnet-other" }), key(0x25))],
    ["a same-chainId twin genesis", signCanonicalDomain(POSSESSION_PROOF_DOMAIN, possessionProofPayload({ ...statement, chainBinding: new ZyronChain(signGenesisPossessionProofs({ ...devGenesis("zyron-devnet-admit"), timestampMs: T0 + 1 }, GENESIS_SET.map(key))).genesisHash }), key(0x25))],
    ["another activation height", signCanonicalDomain(POSSESSION_PROOF_DOMAIN, possessionProofPayload({ ...statement, activationHeight: 151 }), key(0x25))],
    ["another slot", signCanonicalDomain(POSSESSION_PROOF_DOMAIN, possessionProofPayload({ ...statement, address: addr(0x26), publicKey: pub(0x26) }), key(0x25))],
    ["no domain", signCanonical(possessionProofPayload(statement), key(0x25))],
    ["the genesis commitment as binding", signCanonicalDomain(POSSESSION_PROOF_DOMAIN, possessionProofPayload({ ...statement, chainBinding: chain.tip.header.previousHash }), key(0x25))]
  ];
  for (const [name, signature] of variants) {
    assert.throws(() => chain.validateMempoolAdmission(update(chain, next, { proofs: as(signature) }), T0 + 1_000), INVALID, name);
  }
  refusedEverywhere(chain, [update(chain, next, { proofs: as(variants[0]![1]) })], INVALID);
});

test("extra, duplicate, misordered or continuing-validator proofs are refused", () => {
  const chain = new ZyronChain(optedIn());
  const p25 = proof(chain, 150, 0x25);
  const p26 = proof(chain, 150, 0x26);
  const p21 = proof(chain, 150, 0x21);
  const next = [0x21, 0x22, 0x25, 0x26];
  const at = T0 + 1_000;
  assert.doesNotThrow(() => chain.validateMempoolAdmission(update(chain, next, { proofs: [p25, p26] }), at));
  assert.throws(() => chain.validateMempoolAdmission(update(chain, next, { proofs: [p26, p25] }), at), /order/);
  assert.throws(() => chain.validateMempoolAdmission(update(chain, next, { proofs: [p25] }), at), /one possession proof per incoming validator/);
  assert.throws(() => chain.validateMempoolAdmission(update(chain, next, { proofs: [p25, p26, p26] }), at), /one possession proof per incoming validator/);
  assert.throws(() => chain.validateMempoolAdmission(update(chain, next, { proofs: [p25, p25] }), at), /order/);
  assert.throws(() => chain.validateMempoolAdmission(update(chain, next, { proofs: [p21, p25, p26] }), at), /one possession proof per incoming validator/);
  assert.throws(() => chain.validateMempoolAdmission(update(chain, next, { proofs: [p21, p25] }), at), /order/);
  refusedEverywhere(chain, [update(chain, next, { proofs: [p26, p25] })], /order/);
});

test("the possessionProofs field has a strict shape", () => {
  const chain = new ZyronChain(optedIn());
  const p25 = proof(chain, 150, 0x25);
  const base = update(chain, [0x21, 0x22, 0x23, 0x25], { proofs: [p25] });
  assert.doesNotThrow(() => validateTransactionShape(base));
  const bad: unknown[] = [
    "x",
    [null],
    [{ address: p25.address }],
    [{ ...p25, publicKey: pub(0x25) }],
    [{ address: p25.address, signature: "zz".repeat(64) }],
    [{ address: "nope", signature: p25.signature }],
    Array.from({ length: 101 }, () => p25)
  ];
  for (const value of bad) {
    const tx = { ...base, possessionProofs: value } as unknown as ValidatorSetUpdateTx;
    assert.throws(() => validateTransactionShape(tx), /possession proof|Invalid/, JSON.stringify(value).slice(0, 60));
  }
});

test("the replaced set is the latest scheduled set: remove then re-add needs a fresh proof", () => {
  const chain = new ZyronChain(optedIn());
  // Block 1: remove 0x24 at height 150.
  acceptedEverywhere(chain, [update(chain, [0x21, 0x22, 0x23], { proofs: [] })]);
  // Before 150 activates, re-add 0x24 at 300: 0x24 is incoming relative to the set at 150.
  const at = chain.tip.header.timestampMs + 1_000;
  const readdNoProof = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 2, proofs: [] });
  assert.throws(() => chain.validateMempoolAdmission(readdNoProof, at), /one possession proof per incoming validator/);
  assert.deepEqual(chain.selectValidPending([readdNoProof], 10, undefined, at), []);
  assert.throws(() => chain.produceBlock([readdNoProof], key(proposerId(chain)), { timestampMs: at }), /one possession proof per incoming validator/);
  const readd = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 2, proofs: [proof(chain, 300, 0x24)] });
  assert.doesNotThrow(() => chain.validateMempoolAdmission(readd, at));
  assert.equal(chain.selectValidPending([readd], 10, undefined, at).length, 1);
});

test("same block: remove then re-add needs a proof (per-block working schedule)", () => {
  const chain = new ZyronChain(optedIn());
  const remove = update(chain, [0x21, 0x22, 0x23], { proofs: [] });
  const readdNoProof = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 2, proofs: [] });
  refusedEverywhere(chain, [remove, readdNoProof], /one possession proof per incoming validator/);
  // Selection keeps the removal and drops the unproven re-add.
  const at = T0 + 1_000;
  assert.deepEqual(chain.selectValidPending([remove, readdNoProof], 10, undefined, at).map((tx) => tx.txid), [remove.txid]);
  const readd = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 2, proofs: [proof(chain, 300, 0x24)] });
  acceptedEverywhere(chain, [remove, readd]);
  assert.deepEqual(chain.validatorsAt(300).map((item) => item.address), GENESIS_SET.map(addr));
});

test("P1-07-F1: mempool admits a same-block re-add whose proof a pending removal makes necessary", () => {
  const chain = new ZyronChain(optedIn());
  const at = T0 + 1_000;
  const remove = update(chain, [0x21, 0x22, 0x23], { proofs: [] });
  const readd = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 2, proofs: [proof(chain, 300, 0x24)] });
  // Against the persisted schedule alone the proof is extra (0x24 is still scheduled): unchanged.
  assert.throws(() => chain.validateMempoolAdmission(readd, at), /one possession proof per incoming validator/);
  // With the pending removal as its same-block predecessor, the proof is exactly what selection will need.
  assert.doesNotThrow(() => chain.validateMempoolAdmission(readd, at, [remove]));
  assert.deepEqual(chain.selectValidPending([remove, readd], 10, undefined, at).map((tx) => tx.txid), [remove.txid, readd.txid]);
});

test("P1-07-F1: a pending update only counts as predecessor when it is admissible and activates earlier", () => {
  const chain = new ZyronChain(optedIn());
  const at = T0 + 1_000;
  const readd = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 2, proofs: [proof(chain, 300, 0x24)] });
  const later = update(chain, [0x21, 0x22, 0x23], { activationHeight: 300, proofs: [] });
  const afterIt = update(chain, [0x21, 0x22, 0x23], { activationHeight: 400, proofs: [] });
  const unapproved = update(chain, [0x21, 0x22, 0x23], { proofs: [], signers: [0x21, 0x22] });
  const tooSoon = update(chain, [0x21, 0x22, 0x23], { activationHeight: 2, proofs: [] });
  const otherChain = new ZyronChain(optedIn("zyron-devnet-other"));
  const foreign = update(otherChain, [0x21, 0x22, 0x23], { proofs: [] });
  for (const [name, pending] of [["same height", later], ["activates later", afterIt], ["no quorum", unapproved], ["too soon", tooSoon], ["other chain", foreign]] as const) {
    assert.throws(() => chain.validateMempoolAdmission(readd, at, [pending]), /one possession proof per incoming validator/, name);
  }
  // A predecessor never relaxes the update's own checks (a bad proof stays bad).
  const remove = update(chain, [0x21, 0x22, 0x23], { proofs: [] });
  const badProof = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 2, proofs: [proof(chain, 301, 0x24)] });
  assert.throws(() => chain.validateMempoolAdmission(badProof, at, [remove]), INVALID);
  const noQuorum = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 2, proofs: [proof(chain, 300, 0x24)], signers: [0x21, 0x22] });
  assert.throws(() => chain.validateMempoolAdmission(noQuorum, at, [remove]), /quorum/);
});

test("P1-07-F1: NodeService.submitTransaction accepts the same-block remove-then-re-add pair", async () => {
  const genesis = optedIn("zyron-devnet-admit-node");
  const directory = await mkdtemp(join(tmpdir(), "zyron-p107f1-"));
  try {
    const store = await ChainStore.open(genesis, directory);
    const service = new NodeService(store);
    const chain = store.chain;
    const remove = update(chain, [0x21, 0x22, 0x23], { proofs: [] });
    // Same sender (nonce 2) and another sender (its nonce 1) both work.
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 2, proofs: [proof(chain, 300, 0x24)] });
    const readdByOther = update(chain, [0x21, 0x22, 0x23, 0x24], { activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21] });
    assert.throws(() => service.submitTransaction(readd), /one possession proof per incoming validator/, "no predecessor pending yet");
    assert.equal(service.submitTransaction(remove), remove.txid);
    assert.equal(service.submitTransaction(readd), readd.txid);
    const at = chain.tip.header.timestampMs + 1_000;
    assert.deepEqual(chain.selectValidPending(service.mempool.values(), 10, undefined, at).map((tx) => tx.txid), [remove.txid, readd.txid]);

    const other = new NodeService(store);
    assert.equal(other.submitTransaction(remove), remove.txid);
    assert.equal(other.submitTransaction(readdByOther), readdByOther.txid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a chain without the opt-in refuses possessionProofs and is otherwise unchanged", () => {
  const legacy = new ZyronChain(devGenesis("zyron-devnet-legacy"));
  const withField = update(legacy, [0x21, 0x22, 0x23, 0x25], { proofs: [proof(legacy, 150, 0x25)] });
  refusedEverywhere(legacy, [withField], /possessionProofs require validatorAdmission/);
  const empty = update(legacy, [0x21, 0x22, 0x23, 0x25], { proofs: [] });
  refusedEverywhere(legacy, [empty], /possessionProofs require validatorAdmission/);
  // Historical behaviour: no field, no proof, accepted.
  acceptedEverywhere(legacy, [update(legacy, [0x21, 0x22, 0x23, 0x25])]);
});

test("an incoming key that is not a valid secp256k1 point stays refused", () => {
  const chain = new ZyronChain(optedIn());
  const bogus = { address: addressFromPublicKey("11".repeat(64)), publicKey: "11".repeat(64) };
  const input = { chainId: chain.genesis.chainId, nonce: 1, sender: addr(0x21), activationHeight: 150, validators: [validator(0x21), validator(0x22), validator(0x23), bogus] };
  const approvals = [0x21, 0x22, 0x23].map((id) => createValidatorApproval(input, key(id), pub(id)));
  const tx = createValidatorSetUpdate({ ...input, approvals, timestampMs: T0 + 10, possessionProofs: [{ address: bogus.address, signature: "00".repeat(64) }] }, key(0x21), pub(0x21));
  assert.throws(() => chain.validateMempoolAdmission(tx, T0 + 1_000), /secp256k1/);
});
