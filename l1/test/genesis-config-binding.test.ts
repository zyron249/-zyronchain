// P0-01 / P0-02 (genesis-config binding, mandatory fixed-supply rules).
//
// Before this change the genesis block hash committed only to the chain ID,
// the genesis timestamp and the initial balances (state root). Configuration
// that carries economic and security rules (validators, activity oracles,
// the activity pool and `allocationLocks`) was not part of the chain identity,
// so a genesis file with the locks removed or an oracle swapped produced the
// same genesis hash, peered normally and could fork silently. Consensus also
// only enforced "at most 50M"; the exact 50M total, the 10/40/40/10 split and
// the presence of the locks were checked only by the offline verifier.
//
// A genesis now opts in with `launchProfile: "fixed-supply-v1"`. Under that
// profile (a) the genesis hash commits to a domain-separated canonical
// encoding of the entire genesis configuration and (b) node startup refuses
// the genesis unless the locks are present, the total is exactly 50,000,000
// ZYN and the four roles hold 5M / 20M / 20M / 5M. Genesis files without the
// profile keep their exact historical genesis hash (pinned below).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { blockHash } from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { merkleRoot } from "../src/merkle.js";
import { authenticateP2PPeer, createP2PNode, registerP2PIdentityProtocol } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { ChainStore } from "../src/storage.js";
import { ATOMS_PER_ZYN, type GenesisConfig } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const PROFILE = "fixed-supply-v1";
const CONFIG_DOMAIN = "zyronchain/genesis-config/v1";
const ZERO_HASH = "0".repeat(64);

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));

const VALIDATOR = 0x51;
const VALIDATOR_2 = 0x52;
const ORACLE = 0x53;
const ORACLE_2 = 0x54;
const FOUNDER = 0x55;
const PUBLIC_DISTRIBUTION = 0x56;
const LIQUIDITY = 0x57;
const ECOSYSTEM = 0x58;
const OTHER = 0x59;

type ProfileGenesis = GenesisConfig & { launchProfile?: string };

/** Placeholder test keys only; no real addresses. */
function legacyFixedSupply(chainId = "zyron-genesis-bind"): GenesisConfig {
  return {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: 5_000_000 * ZYN },
      { address: addr(PUBLIC_DISTRIBUTION), amountAtoms: 20_000_000 * ZYN },
      { address: addr(LIQUIDITY), amountAtoms: 20_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) }
  };
}

function profileGenesis(chainId = "zyron-genesis-bind"): ProfileGenesis {
  return { ...legacyFixedSupply(chainId), launchProfile: PROFILE };
}

function withoutLocks<T extends GenesisConfig>(genesis: T): T {
  const copy = structuredClone(genesis);
  delete copy.allocationLocks;
  return copy;
}

/** Independent recomputation of the profile commitment (not the production helper). */
function expectedConfigCommitment(genesis: ProfileGenesis): string {
  return sha256Hex(canonicalJson({ domain: CONFIG_DOMAIN, genesis }));
}

// ---------------------------------------------------------------------------
// Legacy genesis identities are frozen.
// ---------------------------------------------------------------------------

/**
 * Representative legacy genesis shapes (no launch profile): dev/test chains
 * with partial supply, fixed-supply files with and without locks, multiple
 * validators and oracles. Their genesis hashes were computed on main at
 * b85571d, before this change, and must never move.
 */
const LEGACY_FIXTURES: Record<string, () => GenesisConfig> = {
  "fixed-supply-with-locks": () => legacyFixedSupply(),
  "fixed-supply-without-locks": () => withoutLocks(legacyFixedSupply()),
  "devnet-partial-supply": () => ({
    chainId: "zyron-devnet-1",
    timestampMs: 1_710_000_000_000,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(OTHER), amountAtoms: 1_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 100_000 * ZYN }
    ]
  }),
  "testnet-multi-validator-multi-oracle": () => ({
    chainId: "zyron-testnet-2",
    timestampMs: 1_720_000_000_000,
    validators: [VALIDATOR, VALIDATOR_2, 0x5a, 0x5b].map((n) => ({ address: addr(n), publicKey: pub(n) })),
    activityOracles: [pub(ORACLE), pub(ORACLE_2)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: 10_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 0 }
    ]
  }),
  "zero-timestamp-single-allocation": () => ({
    chainId: "zyron-local",
    timestampMs: 0,
    validators: [{ address: addr(VALIDATOR_2), publicKey: pub(VALIDATOR_2) }],
    activityOracles: [pub(ORACLE_2)],
    activityPool: addr(OTHER),
    allocations: [{ address: addr(OTHER), amountAtoms: 1 }]
  })
};

const LEGACY_GENESIS_HASHES: Record<string, string> = {
  "fixed-supply-with-locks": "a9ea3a1f727ce328265dd708f8c51b8efc51e58907f069f5376f3bdccce518fd",
  "fixed-supply-without-locks": "a9ea3a1f727ce328265dd708f8c51b8efc51e58907f069f5376f3bdccce518fd",
  "devnet-partial-supply": "a448bd482bed70eb0afc4206b6c0e36047798b8d71e3708dc1ed8fe625f64394",
  "testnet-multi-validator-multi-oracle": "643542fa7098bb1972998fe6fa00e969b028b3360cebc4ce09f3a8c44622a1a6",
  "zero-timestamp-single-allocation": "75e6f68da4f2ee61cd5e1dd21e983ccd0fc2c00d2a066a79e4a9fe9d02166909"
};

test("legacy genesis files (no launch profile) keep byte-identical genesis hashes", () => {
  const actual: Record<string, string> = {};
  for (const [name, build] of Object.entries(LEGACY_FIXTURES)) {
    const genesis = build();
    const chain = new ZyronChain(genesis);
    actual[name] = chain.genesisHash;
    // Historical formula: header hash over chainId, timestamp and the state root
    // with a zero previous hash. No configuration field is mixed in.
    const header = {
      version: 1,
      chainId: genesis.chainId,
      height: 0,
      round: 0,
      previousHash: ZERO_HASH,
      timestampMs: genesis.timestampMs,
      transactionRoot: merkleRoot([]),
      stateRoot: chain.tip.header.stateRoot,
      proposer: "GENESIS" as const
    };
    assert.equal(chain.tip.header.previousHash, ZERO_HASH, name);
    assert.equal(chain.genesisHash, blockHash(header), name);
  }
  assert.deepEqual(actual, LEGACY_GENESIS_HASHES);
});

test("legacy genesis files that differ only in allocationLocks still share an identity (documented legacy behaviour)", () => {
  assert.equal(new ZyronChain(legacyFixedSupply()).genesisHash, new ZyronChain(withoutLocks(legacyFixedSupply())).genesisHash);
});

// ---------------------------------------------------------------------------
// P0-01: the fixed-supply profile binds the full configuration.
// ---------------------------------------------------------------------------

test("fixed-supply profile genesis commits to the full configuration", () => {
  const genesis = profileGenesis();
  const chain = new ZyronChain(genesis);
  assert.equal(chain.tip.header.previousHash, expectedConfigCommitment(genesis));
  assert.notEqual(chain.genesisHash, new ZyronChain(legacyFixedSupply()).genesisHash);
  // Deterministic: key order in the file does not matter, values do.
  const reordered = Object.fromEntries(Object.entries(genesis).reverse()) as ProfileGenesis;
  assert.equal(new ZyronChain(reordered).genesisHash, chain.genesisHash);
});

const TAMPERS: Record<string, (genesis: ProfileGenesis) => ProfileGenesis> = {
  "activity oracle swapped": (genesis) => ({ ...genesis, activityOracles: [pub(ORACLE_2)] }),
  "activity oracle added": (genesis) => ({ ...genesis, activityOracles: [pub(ORACLE), pub(ORACLE_2)] }),
  "validator swapped": (genesis) => ({ ...genesis, validators: [{ address: addr(VALIDATOR_2), publicKey: pub(VALIDATOR_2) }] }),
  "validator added": (genesis) => ({
    ...genesis,
    validators: [...genesis.validators, { address: addr(VALIDATOR_2), publicKey: pub(VALIDATOR_2) }]
  }),
  "validator order changed": (genesis) => ({
    ...genesis,
    validators: [
      { address: addr(VALIDATOR_2), publicKey: pub(VALIDATOR_2) },
      { address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }
    ]
  })
};

test("tampered fixed-supply configuration yields a different genesis hash", () => {
  const base = new ZyronChain(profileGenesis()).genesisHash;
  const seen = new Set([base]);
  for (const [name, tamper] of Object.entries(TAMPERS)) {
    const tampered = tamper(profileGenesis());
    const hash = new ZyronChain(tampered).genesisHash;
    assert.notEqual(hash, base, name);
    assert.ok(!seen.has(hash), `${name} collides with another configuration`);
    seen.add(hash);
  }
  // Removing the locks and the profile together falls back to a legacy
  // identity, which is still different from the bound launch identity.
  const stripped = withoutLocks(profileGenesis());
  delete stripped.launchProfile;
  assert.notEqual(new ZyronChain(stripped).genesisHash, base);
});

test("blocks from a chain with a tampered oracle configuration are refused", () => {
  const honest = new ZyronChain(profileGenesis());
  const tampered = new ZyronChain(TAMPERS["activity oracle swapped"]!(profileGenesis()));
  const timestampMs = 1_700_000_010_000;
  let block = tampered.produceBlock([], key(VALIDATOR), { timestampMs });
  block = tampered.attestBlock(block, key(VALIDATOR));
  assert.throws(() => honest.acceptBlock(block, timestampMs));
  assert.equal(honest.height, 0);
});

test("a data directory created for one fixed-supply configuration refuses a tampered one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-genesis-bind-store-"));
  try {
    await ChainStore.open(profileGenesis(), directory);
    await assert.rejects(() => ChainStore.open(TAMPERS["validator swapped"]!(profileGenesis()), directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native P2P refuses a peer whose fixed-supply configuration differs", async () => {
  const honest = new ZyronChain(profileGenesis());
  const tampered = new ZyronChain(TAMPERS["activity oracle swapped"]!(profileGenesis()));
  assert.equal(honest.genesis.chainId, tampered.genesis.chainId);
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-genesis-bind-p2p-a-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-genesis-bind-p2p-b-"));
  const firstIdentity = await loadOrCreateNodeIdentity(firstDir);
  const secondIdentity = await loadOrCreateNodeIdentity(secondDir);
  const first = await createP2PNode(firstIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  const second = await createP2PNode(secondIdentity);
  try {
    const honestIdentity = { chainId: honest.genesis.chainId, genesisHash: honest.genesisHash };
    const tamperedIdentity = { chainId: tampered.genesis.chainId, genesisHash: tampered.genesisHash };
    await registerP2PIdentityProtocol(first, firstIdentity, honestIdentity);
    const address = first.getMultiaddrs()[0];
    assert.ok(address);
    await assert.rejects(
      () => authenticateP2PPeer(second, address, secondIdentity, tamperedIdentity),
      /chain identity mismatch|stream|abort/i
    );
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P0-02: the fixed-supply profile makes the launch rules consensus rules.
// ---------------------------------------------------------------------------

function reallocate(genesis: ProfileGenesis, amounts: number[]): ProfileGenesis {
  return { ...genesis, allocations: genesis.allocations.map((allocation, index) => ({ ...allocation, amountAtoms: amounts[index]! * ZYN })) };
}

/** The refusal must come from the launch rules, not from an unknown-field check. */
const LAUNCH_RULE_REFUSAL = /fixed-supply|allocationLocks|launch profile/i;

const INVALID_PROFILE_GENESIS: Record<string, () => ProfileGenesis> = {
  "allocationLocks missing": () => withoutLocks(profileGenesis()),
  "total below 50M": () => reallocate(profileGenesis(), [5_000_000, 20_000_000, 20_000_000, 4_999_999]),
  "founder/public split wrong": () => reallocate(profileGenesis(), [10_000_000, 15_000_000, 20_000_000, 5_000_000]),
  "liquidity/public split wrong": () => reallocate(profileGenesis(), [5_000_000, 25_000_000, 15_000_000, 5_000_000]),
  "ecosystem/public split wrong": () => reallocate(profileGenesis(), [5_000_000, 15_000_000, 20_000_000, 10_000_000]),
  "fifth allocation account": () => {
    const genesis = reallocate(profileGenesis(), [5_000_000, 19_000_000, 20_000_000, 5_000_000]);
    return { ...genesis, allocations: [...genesis.allocations, { address: addr(OTHER), amountAtoms: 1_000_000 * ZYN }] };
  },
  "only three allocation accounts": () => {
    const genesis = profileGenesis();
    return { ...genesis, allocations: genesis.allocations.filter((allocation) => allocation.address !== addr(PUBLIC_DISTRIBUTION)) };
  },
  "activity pool is not the 5M ecosystem account": () => ({ ...profileGenesis(), activityPool: addr(PUBLIC_DISTRIBUTION) }),
  "locks point at swapped roles": () => ({
    ...profileGenesis(),
    allocationLocks: { founderVesting: addr(LIQUIDITY), permanentLiquidity: addr(FOUNDER) }
  }),
  "unknown launch profile": () => ({ ...profileGenesis(), launchProfile: "fixed-supply-v2" }) as unknown as ProfileGenesis,
  "non-string launch profile": () => ({ ...profileGenesis(), launchProfile: 1 }) as unknown as ProfileGenesis
};

test("fixed-supply profile genesis that breaks the launch rules is refused at construction", () => {
  assert.doesNotThrow(() => new ZyronChain(profileGenesis()));
  for (const [name, build] of Object.entries(INVALID_PROFILE_GENESIS)) {
    assert.throws(() => new ZyronChain(build()), LAUNCH_RULE_REFUSAL, name);
  }
});

test("node startup (ChainStore.open) refuses a fixed-supply profile genesis without locks or with a wrong total", async () => {
  const valid = await mkdtemp(join(tmpdir(), "zyron-genesis-bind-start-ok-"));
  try {
    const store = await ChainStore.open(profileGenesis(), valid);
    assert.equal(store.chain.genesisHash, new ZyronChain(profileGenesis()).genesisHash);
  } finally {
    await rm(valid, { recursive: true, force: true });
  }
  for (const name of ["allocationLocks missing", "total below 50M", "founder/public split wrong"]) {
    const directory = await mkdtemp(join(tmpdir(), "zyron-genesis-bind-start-"));
    try {
      await assert.rejects(() => ChainStore.open(INVALID_PROFILE_GENESIS[name]!(), directory), LAUNCH_RULE_REFUSAL, name);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("legacy genesis files without the profile are unaffected by the launch rules", () => {
  for (const build of Object.values(LEGACY_FIXTURES)) assert.doesNotThrow(() => new ZyronChain(build()));
});
