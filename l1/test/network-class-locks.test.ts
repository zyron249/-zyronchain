// network-class-v1: a non-test, value-bearing or public-launch genesis must
// declare launchProfile "fixed-supply-v1", which refuses to start unless the
// founder vesting lock and the permanent-liquidity lock are present. Existing
// test and dev genesis files omit networkClass and keep the previous rules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  assertLaunchCeremonyNetworkClass,
  chainIdRequiresStrictNetworkClass,
  STRICT_NETWORK_CLASSES,
  TEST_NETWORK_CLASSES
} from "../src/network-class.js";
import { ChainStore } from "../src/storage.js";
import { createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type GenesisConfig } from "../src/types.js";
import { MINING_RETIRED } from "../src/mining.js";
import { defaultPublicDistributionRelease } from "../src/public-distribution-release.js";

const ZYN = ATOMS_PER_ZYN;
const ZERO = "0".repeat(64);
const T0 = 1_700_000_000_000;
const VESTING = /Founder allocation is still vesting/;
const LIQUIDITY_LOCKED = /Permanent-liquidity reserve is locked/;
const PROFILE_REQUIRED = /launchProfile "fixed-supply-v1"/;
const CLASS_REQUIRED = /requires networkClass/;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 0x21;
const VALIDATOR_COUNT = 4;
const ORACLE = 0x12;
const ORACLE_2 = 0x18;
const ORACLE_3 = 0x19;
const FOUNDER = 0x13;
const PUBLIC = 0x14;
const LIQUIDITY = 0x15;
const ECOSYSTEM = 0x16;
const ALICE = 0x17;

function devGenesis(chainId: string): GenesisConfig {
  return {
    chainId,
    timestampMs: T0,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(ALICE), amountAtoms: 1_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 0 }
    ]
  };
}

function strictGenesis(networkClass: NonNullable<GenesisConfig["networkClass"]> | undefined, chainId: string): GenesisConfig {
  const genesis: GenesisConfig = {
    chainId,
    timestampMs: T0,
    validators: Array.from({ length: VALIDATOR_COUNT }, (_, index) => {
      const id = VALIDATOR + index;
      return { address: addr(id), publicKey: pub(id) };
    }),
    activityOracles: [pub(ORACLE), pub(ORACLE_2), pub(ORACLE_3)],
    activityOracleThreshold: 2,
    activityOraclePolicy: "threshold-v1",
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: 5_000_000 * ZYN },
      { address: addr(PUBLIC), amountAtoms: 20_000_000 * ZYN },
      { address: addr(LIQUIDITY), amountAtoms: 20_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) },
    publicDistributionRelease: defaultPublicDistributionRelease(addr(PUBLIC)),
    launchProfile: "fixed-supply-v1"
  };
  if (networkClass !== undefined) genesis.networkClass = networkClass;
  return genesis;
}

test("supply cap and retired mining claim stay fixed", () => {
  assert.equal(MAX_SUPPLY_ATOMS, 50_000_000 * ZYN);
  assert.equal(MINING_RETIRED, true);
});

test("chain IDs that name a value-bearing class are recognised, test IDs are not", () => {
  for (const chainId of ["zyron-mainnet-1", "mainnet", "zyron-public-launch-1", "value-bearing", "zyron-value-bearing-east"]) {
    assert.equal(chainIdRequiresStrictNetworkClass(chainId), true, chainId);
  }
  for (const chainId of [
    "zyron-local-0123abcd",
    "zyron-wallet-testnet-1",
    "zyron-open-testnet-1",
    "zyron-render-private-testnet-1",
    "zyron-public-testnet-1",
    "zyron-devnet-1",
    "depth-regression"
  ]) {
    assert.equal(chainIdRequiresStrictNetworkClass(chainId), false, chainId);
  }
});

test("existing dev and test chain IDs still start without locks or a network class", async () => {
  const chainIds = [
    "zyron-local-0123abcd",
    "zyron-wallet-testnet-1",
    "zyron-open-testnet-1",
    "zyron-render-private-testnet-1",
    "zyron-devnet-1"
  ];
  for (const chainId of chainIds) {
    const genesis = devGenesis(chainId);
    const chain = new ZyronChain(genesis);
    assert.equal(chain.tip.header.previousHash, ZERO, chainId);
    assert.equal(chain.balance(addr(ALICE)), 1_000 * ZYN);
    const directory = await mkdtemp(join(tmpdir(), "zyron-class-dev-"));
    try {
      const store = await ChainStore.open(genesis, directory);
      assert.equal(store.chain.genesisHash, chain.genesisHash);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("an explicit test network class may omit locks and may keep one validator", () => {
  for (const networkClass of TEST_NETWORK_CLASSES) {
    const genesis = { ...devGenesis(`zyron-${networkClass}-sample`), networkClass };
    const chain = new ZyronChain(genesis);
    assert.equal(chain.genesis.networkClass, networkClass);
    assert.notEqual(chain.tip.header.previousHash, ZERO);
  }
});

test("a legacy devnet genesis hash stays on the historical zero previous-hash formula", () => {
  const genesis: GenesisConfig = {
    chainId: "zyron-devnet-1",
    timestampMs: 1_710_000_000_000,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(0x59), amountAtoms: 1_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 100_000 * ZYN }
    ]
  };
  // Pinned in genesis-config-binding.test.ts from main at b85571d.
  // This fixture uses different keys than that pin, so it only checks the
  // historical formula: a zero previous hash, not a config commitment.
  const chain = new ZyronChain(genesis);
  assert.equal(chain.tip.header.previousHash, ZERO);
  assert.equal(chain.genesis.networkClass, undefined);
});

test("open-testnet fixed-supply profile without a network class still starts", async () => {
  const genesis = strictGenesis(undefined, "zyron-open-testnet-1");
  delete genesis.networkClass;
  const chain = new ZyronChain(genesis);
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
  assert.equal(chain.genesis.activityOraclePolicy, "threshold-v1");
  assert.ok(chain.spendableBalance(addr(PUBLIC), T0 + 1_000) < 20_000_000 * ZYN);
  const missingRelease = structuredClone(genesis);
  delete missingRelease.publicDistributionRelease;
  assert.throws(() => new ZyronChain(missingRelease), /publicDistributionRelease/);
  const directory = await mkdtemp(join(tmpdir(), "zyron-class-open-"));
  try {
    const store = await ChainStore.open(genesis, directory);
    assert.equal(store.chain.height, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("value-bearing classes start only with the fixed-supply profile and both locks", async () => {
  for (const networkClass of STRICT_NETWORK_CLASSES) {
    const chainId = `zyron-${networkClass}-review`;
    const genesis = strictGenesis(networkClass, chainId);
    const chain = new ZyronChain(genesis);
    assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
    assert.equal(chain.spendableBalance(addr(FOUNDER), T0 + 1_000), 0);
    assert.equal(chain.spendableBalance(addr(LIQUIDITY), T0 + 1_000), 0);
    const directory = await mkdtemp(join(tmpdir(), "zyron-class-strict-"));
    try {
      const store = await ChainStore.open(genesis, directory);
      assert.equal(store.chain.genesisHash, chain.genesisHash);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("a value-bearing class without the launch profile is rejected at construction and node start", async () => {
  const genesis = strictGenesis("mainnet", "zyron-review-main");
  delete genesis.launchProfile;
  assert.throws(() => new ZyronChain(genesis), PROFILE_REQUIRED);
  const directory = await mkdtemp(join(tmpdir(), "zyron-class-nolock-"));
  try {
    await assert.rejects(() => ChainStore.open(genesis, directory), PROFILE_REQUIRED);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a value-bearing class cannot drop the locks by keeping only the profile name", () => {
  const genesis = strictGenesis("public-launch", "zyron-review-launch");
  delete genesis.allocationLocks;
  assert.throws(() => new ZyronChain(genesis), /allocationLocks/);
});

test("choosing an unknown launch profile is rejected for every class", () => {
  const genesis = strictGenesis("value-bearing", "zyron-review-value");
  (genesis as { launchProfile: string }).launchProfile = "unlocked-v1";
  assert.throws(() => new ZyronChain(genesis), /Unsupported genesis launch profile/);
  const testGenesis = { ...devGenesis("zyron-devnet-1"), networkClass: "devnet" as const, launchProfile: "unlocked-v1" as "fixed-supply-v1" };
  assert.throws(() => new ZyronChain(testGenesis), /Unsupported genesis launch profile/);
});

test("a chain ID that names mainnet, public-launch, or value-bearing cannot use a test class or omit the class", async () => {
  for (const chainId of ["zyron-mainnet-1", "zyron-public-launch-1", "zyron-value-bearing-1"]) {
    assert.throws(() => new ZyronChain(devGenesis(chainId)), CLASS_REQUIRED);
    const asTest = { ...devGenesis(chainId), networkClass: "testnet" as const };
    assert.throws(() => new ZyronChain(asTest), CLASS_REQUIRED);
    const lockedButUnclassified = strictGenesis("mainnet", chainId);
    delete lockedButUnclassified.networkClass;
    assert.throws(() => new ZyronChain(lockedButUnclassified), CLASS_REQUIRED);
  }
  const directory = await mkdtemp(join(tmpdir(), "zyron-class-named-"));
  try {
    await assert.rejects(() => ChainStore.open(devGenesis("zyron-mainnet-1"), directory), CLASS_REQUIRED);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed network classes fail closed", () => {
  const samples: unknown[] = [null, 1, "", "Mainnet", "public_launch", "test", "local", ["mainnet"], { class: "mainnet" }];
  for (const networkClass of samples) {
    const genesis = { ...devGenesis("zyron-devnet-1"), networkClass };
    assert.throws(() => new ZyronChain(genesis as GenesisConfig), /Unsupported genesis network class/, JSON.stringify(networkClass));
  }
  const extra = { ...devGenesis("zyron-devnet-1"), valueBearing: true };
  assert.throws(() => new ZyronChain(extra as GenesisConfig), /Invalid genesis fields/);
});

test("a value-bearing genesis with the wrong split, swapped locks, or duplicate roles is rejected", () => {
  const swapped = strictGenesis("mainnet", "zyron-review-swap");
  swapped.allocationLocks = { founderVesting: addr(PUBLIC), permanentLiquidity: addr(LIQUIDITY) };
  assert.throws(() => new ZyronChain(swapped), /allocation|fixed-supply|Frozen|match/i);

  const inflated = strictGenesis("mainnet", "zyron-review-inflate");
  inflated.allocations = inflated.allocations.map((allocation) =>
    allocation.address === addr(PUBLIC) ? { ...allocation, amountAtoms: allocation.amountAtoms + 1 } : allocation);
  assert.throws(() => new ZyronChain(inflated), /maximum supply|50,000,000|fixed-supply/);

  const sameRole = strictGenesis("public-launch", "zyron-review-same");
  sameRole.allocationLocks = { founderVesting: addr(FOUNDER), permanentLiquidity: addr(FOUNDER) };
  assert.throws(() => new ZyronChain(sameRole), /distinct|allocationLocks|fixed-supply/);
});

test("networkClass is bound into the genesis hash and key order does not matter", () => {
  const classified = strictGenesis("mainnet", "zyron-bind-review");
  const unclassified = structuredClone(classified);
  delete unclassified.networkClass;
  const bound = new ZyronChain(classified);
  const profileOnly = new ZyronChain(unclassified);
  assert.notEqual(bound.genesisHash, profileOnly.genesisHash);
  assert.notEqual(bound.tip.header.previousHash, ZERO);
  const reordered = Object.fromEntries(Object.entries(classified).reverse()) as GenesisConfig;
  assert.equal(new ZyronChain(reordered).genesisHash, bound.genesisHash);

  const legacy = devGenesis("zyron-devnet-1");
  const opted = { ...legacy, networkClass: "devnet" as const };
  assert.notEqual(new ZyronChain(opted).genesisHash, new ZyronChain(legacy).genesisHash);
  assert.equal(new ZyronChain(legacy).tip.header.previousHash, ZERO);
});

test("a started value-bearing chain rejects founder and liquidity spends inside the cliff", () => {
  const genesis = strictGenesis("mainnet", "zyron-review-spend");
  const chain = new ZyronChain(genesis);
  const founderTx = createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: addr(FOUNDER), receiver: addr(ALICE),
    amountAtoms: 1, feeAtoms: 1, timestampMs: T0 + 1
  }, key(FOUNDER), pub(FOUNDER), 1);
  const liquidityTx = createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: addr(LIQUIDITY), receiver: addr(ALICE),
    amountAtoms: 1, feeAtoms: 0, timestampMs: T0 + 1
  }, key(LIQUIDITY), pub(LIQUIDITY), 1);
  const at = T0 + 60_000;
  assert.throws(() => chain.validateMempoolAdmission(founderTx, at), VESTING);
  assert.throws(() => chain.validateMempoolAdmission(liquidityTx, at), LIQUIDITY_LOCKED);
  assert.deepEqual(chain.selectValidPending([founderTx, liquidityTx], 10, 1_500_000, at), []);
  assert.throws(() => chain.produceBlock([founderTx], key(VALIDATOR), { timestampMs: at }), VESTING);
  assert.throws(() => chain.produceBlock([liquidityTx], key(VALIDATOR), { timestampMs: at }), LIQUIDITY_LOCKED);
  let block = chain.produceBlock([], key(VALIDATOR), { timestampMs: at });
  for (let index = 0; index < 3; index += 1) block = chain.attestBlock(block, key(VALIDATOR + index));
  chain.acceptBlock(block, at);
  assert.equal(chain.height, 1);
  assert.equal(chain.balance(addr(FOUNDER)), 5_000_000 * ZYN);
  assert.equal(chain.balance(addr(LIQUIDITY)), 20_000_000 * ZYN);
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
});

test("the launch ceremony refuses a file that is not an explicit value-bearing class", () => {
  const ready = strictGenesis("public-launch", "zyron-public-launch-ceremony");
  assert.doesNotThrow(() => assertLaunchCeremonyNetworkClass(ready));
  const omitted = structuredClone(ready);
  delete omitted.networkClass;
  assert.throws(() => assertLaunchCeremonyNetworkClass(omitted), /Launch ceremony genesis must declare networkClass/);
  assert.throws(() => assertLaunchCeremonyNetworkClass({ ...devGenesis("zyron-devnet-1"), networkClass: "devnet" }), /Launch ceremony/);
  assert.throws(() => assertLaunchCeremonyNetworkClass({ networkClass: "mainnet-preview" }), /Unsupported genesis network class/);
});

test("tokenomics:check rejects a launch file without the value-bearing class and accepts one with locks", async () => {
  const ready = strictGenesis("value-bearing", "zyron-value-bearing-ceremony");
  const root = await mkdtemp(join(tmpdir(), "zyron-ceremony-"));
  const file = join(root, "genesis.json");
  const argsFor = (genesisPath: string) => [
    "scripts/validate-fixed-supply-genesis.mjs",
    "--genesis", genesisPath,
    "--founder", addr(FOUNDER),
    "--public-distribution", addr(PUBLIC),
    "--liquidity-reserve", addr(LIQUIDITY),
    "--ecosystem-reserve", addr(ECOSYSTEM)
  ];
  const run = async (genesis: GenesisConfig) => {
    await writeFile(file, `${JSON.stringify(genesis, null, 2)}\n`);
    return spawnSync(process.execPath, argsFor(file), { cwd: process.cwd(), encoding: "utf8" });
  };
  try {
    const accepted = await run(ready);
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    assert.match(accepted.stdout, /Network class: value-bearing/);
    assert.match(accepted.stdout, /50,000,000 ZYN/);
    assert.match(accepted.stdout, /decided by owner/);
    const omitted = structuredClone(ready);
    delete omitted.networkClass;
    const refused = await run(omitted);
    assert.notEqual(refused.status, 0);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /networkClass/);
    const unlocked = structuredClone(ready);
    delete unlocked.allocationLocks;
    const noLocks = await run(unlocked);
    assert.notEqual(noLocks.status, 0);
    assert.match(`${noLocks.stdout}\n${noLocks.stderr}`, /allocationLocks|launchProfile|fixed-supply/);
    const noRelease = structuredClone(ready);
    delete noRelease.publicDistributionRelease;
    const missingRelease = await run(noRelease);
    assert.notEqual(missingRelease.status, 0);
    assert.match(`${missingRelease.stdout}\n${missingRelease.stderr}`, /publicDistributionRelease/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
