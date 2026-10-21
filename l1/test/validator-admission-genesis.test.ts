// P1-07 (F-05 residual), genesis part: opt-in `validatorAdmission`
// (policy possession-proof-v1). Every genesis validator proves possession of
// its private key over a domain-separated payload bound to the chain ID and
// the proof-independent genesis configuration commitment. Required for the
// value-bearing network classes; legacy and test genesis files are unchanged.
// Design: docs/VALIDATOR_POSSESSION_PROOF.md.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { createGenesisBlock, genesisConfigCommitment, GENESIS_CONFIG_COMMITMENT_DOMAIN } from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonical, signCanonicalDomain } from "../src/crypto.js";
import { defaultPublicDistributionRelease } from "../src/public-distribution-release.js";
import { ChainStore } from "../src/storage.js";
import { ATOMS_PER_ZYN, type GenesisConfig } from "../src/types.js";
import {
  POSSESSION_PROOF_DOMAIN,
  POSSESSION_PROOF_POLICY_V1,
  genesisPossessionChainBinding,
  possessionProofPayload,
  signGenesisPossessionProofs
} from "../src/validator-admission.js";

const ZYN = ATOMS_PER_ZYN;
const T0 = 1_700_000_000_000;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATORS = [0x21, 0x22, 0x23, 0x24];
const REQUIRED = /Value-bearing, public-launch, and mainnet genesis require validatorAdmission/;
const INVALID_PROOF = /Invalid genesis validator possession proof/;

function strictBase(networkClass: GenesisConfig["networkClass"], chainId: string): GenesisConfig {
  const founder = addr(0x13);
  const distributed = addr(0x14);
  const liquidity = addr(0x15);
  const ecosystem = addr(0x16);
  const genesis: GenesisConfig = {
    chainId,
    timestampMs: T0,
    validators: VALIDATORS.map((id) => ({ address: addr(id), publicKey: pub(id) })),
    activityOracles: [pub(0x12), pub(0x17), pub(0x18)],
    activityOracleThreshold: 2,
    activityOraclePolicy: "threshold-v1",
    activityPool: ecosystem,
    allocations: [
      { address: founder, amountAtoms: 5_000_000 * ZYN },
      { address: distributed, amountAtoms: 20_000_000 * ZYN },
      { address: liquidity, amountAtoms: 20_000_000 * ZYN },
      { address: ecosystem, amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: founder, permanentLiquidity: liquidity },
    launchProfile: "fixed-supply-v1",
    publicDistributionRelease: defaultPublicDistributionRelease(distributed)
  };
  if (networkClass !== undefined) genesis.networkClass = networkClass;
  return genesis;
}

function admitted(genesis: GenesisConfig): GenesisConfig {
  return signGenesisPossessionProofs(genesis, VALIDATORS.map(key));
}

function devGenesis(chainId: string): GenesisConfig {
  const pool = addr(0x90);
  return {
    chainId,
    timestampMs: T0,
    validators: [{ address: addr(0x31), publicKey: pub(0x31) }],
    activityOracles: [pub(0x91)],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 1_000 * ZYN }]
  };
}

function proofFor(genesis: GenesisConfig, id: number, overrides: Record<string, unknown> = {}): string {
  return signCanonicalDomain(POSSESSION_PROOF_DOMAIN, {
    ...possessionProofPayload({
      chainId: genesis.chainId,
      chainBinding: genesisPossessionChainBinding(genesis),
      activationHeight: 0,
      address: addr(id),
      publicKey: pub(id)
    }),
    ...overrides
  }, key(id));
}

async function refusedAtStart(genesis: GenesisConfig, pattern: RegExp): Promise<void> {
  assert.throws(() => new ZyronChain(genesis), pattern);
  const directory = await mkdtemp(join(tmpdir(), "zyron-admission-"));
  try {
    await assert.rejects(() => ChainStore.open(genesis, directory), pattern);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the possession-proof domain and policy are fixed strings", () => {
  assert.equal(POSSESSION_PROOF_DOMAIN, "zyronchain/validator-possession/v1");
  assert.equal(POSSESSION_PROOF_POLICY_V1, "possession-proof-v1");
});

test("a value-bearing class without validatorAdmission is refused at construction and node start", async () => {
  for (const networkClass of ["mainnet", "public-launch", "value-bearing"] as const) {
    await refusedAtStart(strictBase(networkClass, `zyron-review-adm-${networkClass}`), REQUIRED);
  }
});

test("a value-bearing class with valid genesis proofs starts at construction and node start", async () => {
  for (const networkClass of ["mainnet", "public-launch", "value-bearing"] as const) {
    const genesis = admitted(strictBase(networkClass, `zyron-review-ok-${networkClass}`));
    assert.equal(genesis.validatorAdmission?.genesisProofs.length, VALIDATORS.length);
    assert.equal(new ZyronChain(genesis).validatorsAt(1).length, VALIDATORS.length);
  }
  const genesis = admitted(strictBase("mainnet", "zyron-review-ok-store"));
  const directory = await mkdtemp(join(tmpdir(), "zyron-admission-ok-"));
  try {
    const store = await ChainStore.open(genesis, directory);
    assert.equal(store.chain.validatorsAt(1).length, VALIDATORS.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the existing open-testnet shape (fixed-supply-v1, no value-bearing class, no field) keeps its genesis hash", () => {
  const open = strictBase(undefined, "zyron-open-testnet-1");
  const chain = new ZyronChain(open);
  const legacyCommitment = sha256Hex(canonicalJson({ domain: GENESIS_CONFIG_COMMITMENT_DOMAIN, genesis: open }));
  assert.equal(genesisConfigCommitment(open), legacyCommitment);
  assert.equal(chain.genesisHash, createGenesisBlock(open, chain.tip.header.stateRoot).hash);
  assert.equal(chain.tip.header.previousHash, legacyCommitment);
  const tested = strictBase("open-testnet", "zyron-open-testnet-2");
  assert.equal(new ZyronChain(tested).tip.header.previousHash,
    sha256Hex(canonicalJson({ domain: GENESIS_CONFIG_COMMITMENT_DOMAIN, genesis: tested })));
  const legacy = devGenesis("zyron-devnet-legacy");
  assert.equal(new ZyronChain(legacy).tip.header.previousHash, "0".repeat(64));
});

test("validatorAdmission alone binds the configuration into the genesis hash", () => {
  const plain = devGenesis("zyron-devnet-adm");
  const plainChain = new ZyronChain(plain);
  assert.equal(plainChain.tip.header.previousHash, "0".repeat(64));
  const opted = signGenesisPossessionProofs(plain, [key(0x31)]);
  const optedChain = new ZyronChain(opted);
  assert.notEqual(optedChain.tip.header.previousHash, "0".repeat(64));
  assert.equal(optedChain.tip.header.previousHash, genesisConfigCommitment(opted));
  assert.notEqual(optedChain.genesisHash, plainChain.genesisHash);
});

test("the configuration commitment does not depend on the proof bytes", () => {
  const genesis = admitted(strictBase("mainnet", "zyron-review-commit"));
  const stripped = structuredClone(genesis);
  stripped.validatorAdmission!.genesisProofs = [];
  assert.equal(genesisConfigCommitment(genesis), sha256Hex(canonicalJson({ domain: GENESIS_CONFIG_COMMITMENT_DOMAIN, genesis: stripped })));
  assert.equal(genesisPossessionChainBinding(genesis), genesisConfigCommitment(genesis));

  // Another valid (randomized, low-S) signature by the same key over the same payload.
  const alternative = structuredClone(genesis);
  const payload = possessionProofPayload({
    chainId: genesis.chainId,
    chainBinding: genesisPossessionChainBinding(genesis),
    activationHeight: 0,
    address: addr(VALIDATORS[1]!),
    publicKey: pub(VALIDATORS[1]!)
  });
  const message = new TextEncoder().encode(canonicalJson({ domain: POSSESSION_PROOF_DOMAIN, payload }));
  const randomized = Buffer.from(secp256k1.sign(message, Buffer.from(key(VALIDATORS[1]!), "hex"), { format: "compact", extraEntropy: true })).toString("hex");
  assert.notEqual(randomized, genesis.validatorAdmission!.genesisProofs[1]!.signature);
  alternative.validatorAdmission!.genesisProofs[1]!.signature = randomized;
  const a = new ZyronChain(genesis);
  const b = new ZyronChain(alternative);
  assert.equal(a.genesisHash, b.genesisHash);
});

test("missing, extra, duplicate, misordered or foreign genesis proofs are refused", async () => {
  const base = admitted(strictBase("mainnet", "zyron-review-proofs"));
  const proofs = base.validatorAdmission!.genesisProofs;

  const missing = structuredClone(base);
  missing.validatorAdmission!.genesisProofs = proofs.slice(0, 3);
  await refusedAtStart(missing, /one possession proof per genesis validator/);

  const extra = structuredClone(base);
  extra.validatorAdmission!.genesisProofs = [...proofs, proofs[0]!];
  await refusedAtStart(extra, /one possession proof per genesis validator/);

  const duplicate = structuredClone(base);
  duplicate.validatorAdmission!.genesisProofs = [proofs[0]!, proofs[0]!, proofs[2]!, proofs[3]!];
  await refusedAtStart(duplicate, /does not match the genesis validator order/);

  const misordered = structuredClone(base);
  misordered.validatorAdmission!.genesisProofs = [proofs[1]!, proofs[0]!, proofs[2]!, proofs[3]!];
  await refusedAtStart(misordered, /does not match the genesis validator order/);

  const swappedSignature = structuredClone(base);
  swappedSignature.validatorAdmission!.genesisProofs[0]!.signature = proofs[1]!.signature;
  await refusedAtStart(swappedSignature, INVALID_PROOF);

  const notHex = structuredClone(base);
  notHex.validatorAdmission!.genesisProofs[0]!.signature = "zz".repeat(64);
  await refusedAtStart(notHex, /possession proof signature/);

  const extraKey = structuredClone(base);
  (extraKey.validatorAdmission!.genesisProofs[0] as unknown as Record<string, unknown>).publicKey = pub(VALIDATORS[0]!);
  await refusedAtStart(extraKey, /Unexpected .*possession proof/i);
});

test("proofs by another key, for another chain, height, slot or without the domain are refused", () => {
  const base = admitted(strictBase("mainnet", "zyron-review-foreign"));
  const v0 = VALIDATORS[0]!;
  const replace = (signature: string) => {
    const copy = structuredClone(base);
    copy.validatorAdmission!.genesisProofs[0]!.signature = signature;
    return copy;
  };
  const payload = possessionProofPayload({
    chainId: base.chainId,
    chainBinding: genesisPossessionChainBinding(base),
    activationHeight: 0,
    address: addr(v0),
    publicKey: pub(v0)
  });
  // Signed by a different key (a quorum member or an outsider).
  assert.throws(() => new ZyronChain(replace(signCanonicalDomain(POSSESSION_PROOF_DOMAIN, payload, key(0x77)))), INVALID_PROOF);
  // Another chain ID.
  assert.throws(() => new ZyronChain(replace(proofFor(base, v0, { chainId: "zyron-other-main" }))), INVALID_PROOF);
  // Same chain ID, different configuration (twin genesis).
  const twin = admitted(strictBase("mainnet", "zyron-review-foreign"));
  twin.timestampMs = T0 + 1;
  assert.throws(() => new ZyronChain(replace(proofFor(twin, v0))), INVALID_PROOF);
  // Another activation height.
  assert.throws(() => new ZyronChain(replace(proofFor(base, v0, { activationHeight: 1 }))), INVALID_PROOF);
  // Another slot (signed by the right key, naming another validator).
  assert.throws(() => new ZyronChain(replace(proofFor(base, v0, { address: addr(VALIDATORS[1]!), publicKey: pub(VALIDATORS[1]!) }))), INVALID_PROOF);
  // Without the domain (plain canonical signing).
  assert.throws(() => new ZyronChain(replace(signCanonical(payload, key(v0)))), INVALID_PROOF);
  // Under another domain.
  assert.throws(() => new ZyronChain(replace(signCanonicalDomain("zyronchain/validator-set-approval/v1", payload, key(v0)))), INVALID_PROOF);
  // Control: the original is accepted.
  assert.doesNotThrow(() => new ZyronChain(base));
});

test("a proof made for a test genesis cannot be reused when the value-bearing class is added", () => {
  const test = admitted(strictBase(undefined, "zyron-review-reuse"));
  const reused = strictBase("mainnet", "zyron-review-reuse");
  reused.validatorAdmission = structuredClone(test.validatorAdmission);
  assert.throws(() => new ZyronChain(reused), INVALID_PROOF);
});

test("validatorAdmission is a fail-closed record", async () => {
  const base = admitted(strictBase("mainnet", "zyron-review-record"));
  const samples: Array<[unknown, RegExp]> = [
    [null, /validatorAdmission must be a plain record/],
    [[], /validatorAdmission must be a plain record/],
    ["possession-proof-v1", /validatorAdmission must be a plain record/],
    [{ genesisProofs: base.validatorAdmission!.genesisProofs }, /Unsupported validatorAdmission policy|Missing/],
    [{ policy: 1, genesisProofs: base.validatorAdmission!.genesisProofs }, /Unsupported validatorAdmission policy/],
    [{ policy: "possession-proof-v2", genesisProofs: base.validatorAdmission!.genesisProofs }, /Unsupported validatorAdmission policy/],
    [{ policy: "Possession-Proof-V1", genesisProofs: base.validatorAdmission!.genesisProofs }, /Unsupported validatorAdmission policy/],
    [{ policy: "possession-proof-v1" }, /Missing|genesisProofs/],
    [{ policy: "possession-proof-v1", genesisProofs: "x" }, /genesisProofs must be an array/],
    [{ policy: "possession-proof-v1", genesisProofs: base.validatorAdmission!.genesisProofs, extra: true }, /Unexpected/],
    [{ policy: "possession-proof-v1", genesisProofs: [null, null, null, null] }, /possession proof must be a plain record/]
  ];
  for (const [value, pattern] of samples) {
    const copy = structuredClone(base) as unknown as Record<string, unknown>;
    copy.validatorAdmission = value;
    await refusedAtStart(copy as unknown as GenesisConfig, pattern);
  }
  // Also on a test genesis that opts in voluntarily.
  const dev = devGenesis("zyron-devnet-record") as unknown as Record<string, unknown>;
  dev.validatorAdmission = { policy: "possession-proof-v2", genesisProofs: [] };
  assert.throws(() => new ZyronChain(dev as unknown as GenesisConfig), /Unsupported validatorAdmission policy/);
});

test("a test genesis may opt in voluntarily and is then held to the same proofs", () => {
  const dev = signGenesisPossessionProofs(devGenesis("zyron-devnet-optin"), [key(0x31)]);
  assert.doesNotThrow(() => new ZyronChain(dev));
  const bad = structuredClone(dev);
  bad.validatorAdmission!.genesisProofs = [];
  assert.throws(() => new ZyronChain(bad), /one possession proof per genesis validator/);
});

test("signGenesisPossessionProofs refuses a key that does not match the validator slot", () => {
  assert.throws(() => signGenesisPossessionProofs(devGenesis("zyron-devnet-wrongkey"), [key(0x32)]), /does not match/);
  assert.throws(() => signGenesisPossessionProofs(devGenesis("zyron-devnet-count"), []), /one private key per genesis validator/);
});
