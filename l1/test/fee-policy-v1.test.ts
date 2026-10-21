// Fee policy v1 (docs/FEE_POLICY_V1.md).
// The rule is opt-in. A genesis without `feePolicy` — including fixed-supply-v1
// testnet genesis files — keeps caller-chosen fees and a full burn. A genesis
// that sets fixed-fee-v1 rejects every other transfer fee, splits the fee
// 50/50 (odd atom to the burn), and does not order or replace by fee.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { expectedValidator, MAX_BLOCK_BYTES, MAX_BLOCK_TRANSACTIONS, validatorQuorumSize } from "../src/block.js";
import { MAX_BLOCK_TRANSACTION_BYTES, ZyronChain } from "../src/chain.js";
import { canonicalJson } from "../src/codec.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  assertMempoolSenderNonce,
  FIXED_FEE_MISMATCH_MESSAGE,
  FIXED_TRANSFER_FEE_ATOMS,
  MAX_MEMPOOL_PENDING_PER_SENDER,
  splitFixedFee
} from "../src/fee-policy.js";
import { DEFAULT_MEMPOOL_NON_MINING_CAPACITY, DEFAULT_MEMPOOL_NON_MINING_MAX_BYTES, Mempool } from "../src/mempool.js";
import { defaultPublicDistributionRelease } from "../src/public-distribution-release.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, stateV2Balance, stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import { createMiningClaim, createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer, validateTransactionShape } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type Address, type GenesisConfig, type Transaction } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const FEE = /Transfer fee must equal the fixed protocol fee/;
const DAY = 86_400_000;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));

const VALIDATOR_IDS = [71, 80, 81, 82];
const VALIDATOR = VALIDATOR_IDS[0]!;
const ORACLE = 72;
const ORACLE_2 = 78;
const ORACLE_3 = 79;
const FOUNDER = 73;
const PUBLIC_DISTRIBUTION = 74;
const LIQUIDITY = 75;
const ECOSYSTEM = 76;
const ALICE = 90;
const BOB = 91;

function profileGenesis(chainId: string, fixedTransferFeeAtoms?: number): GenesisConfig {
  const genesis: GenesisConfig = {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: VALIDATOR_IDS.map((id) => ({ address: addr(id), publicKey: pub(id) })),
    activityOracles: [pub(ORACLE), pub(ORACLE_2), pub(ORACLE_3)],
    activityOracleThreshold: 2,
    activityOraclePolicy: "threshold-v1",
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: 5_000_000 * ZYN },
      { address: addr(PUBLIC_DISTRIBUTION), amountAtoms: 20_000_000 * ZYN },
      { address: addr(LIQUIDITY), amountAtoms: 20_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) },
    publicDistributionRelease: defaultPublicDistributionRelease(addr(PUBLIC_DISTRIBUTION)),
    launchProfile: "fixed-supply-v1"
  };
  if (fixedTransferFeeAtoms !== undefined) {
    genesis.feePolicy = { version: "fixed-fee-v1", fixedTransferFeeAtoms };
  }
  return genesis;
}

function idFor(address: string): number {
  const id = [...VALIDATOR_IDS, PUBLIC_DISTRIBUTION, ALICE, BOB].find((candidate) => addr(candidate) === address);
  if (id === undefined) throw new Error("unexpected address");
  return id;
}

function finalize(chain: ZyronChain, txs: Transaction[], timestampMs: number): void {
  const height = chain.height + 1;
  const validators = chain.validatorsAt(height);
  const proposer = expectedValidator(validators, height, 0);
  let block = chain.produceBlock(txs, key(idFor(proposer.address)), { timestampMs });
  const quorum = validators.slice(0, validatorQuorumSize(validators.length));
  if (isConsensusV6(chain.protocolVersionAt(block.header.height))) {
    block.commitRound = 0;
    block.attestations = quorum.map((validator) => ({
      validator: validator.address,
      publicKey: validator.publicKey,
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(idFor(validator.address)))
    }));
  } else {
    for (const validator of quorum) block = chain.attestBlock(block, key(idFor(validator.address)));
  }
  chain.acceptBlock(block, timestampMs);
}

function transfer(genesis: GenesisConfig, from: number, nonce: number, amountAtoms: number, feeAtoms: number, timestampMs: number, to = ALICE): Transaction {
  return createTransfer({
    chainId: genesis.chainId,
    nonce,
    sender: addr(from),
    receiver: addr(to),
    amountAtoms,
    feeAtoms,
    timestampMs
  }, key(from), pub(from));
}

test("fixed transfer fee default is 0.001 ZYN and the odd atom burns", () => {
  assert.equal(FIXED_TRANSFER_FEE_ATOMS, 100_000);
  assert.equal(FIXED_TRANSFER_FEE_ATOMS, ATOMS_PER_ZYN / 1_000);
  assert.deepEqual(splitFixedFee(100_000), { burnAtoms: 50_000, producerAtoms: 50_000 });
  assert.deepEqual(splitFixedFee(1), { burnAtoms: 1, producerAtoms: 0 });
  assert.deepEqual(splitFixedFee(3), { burnAtoms: 2, producerAtoms: 1 });
  assert.equal(splitFixedFee(3).burnAtoms + splitFixedFee(3).producerAtoms, 3);
});

test("spam limits are the documented caps", () => {
  assert.equal(MAX_MEMPOOL_PENDING_PER_SENDER, 64);
  assert.equal(MAX_BLOCK_TRANSACTIONS, 10_000);
  assert.equal(MAX_BLOCK_BYTES, 2_000_000);
  assert.equal(MAX_BLOCK_TRANSACTION_BYTES, 1_500_000);
  assert.equal(DEFAULT_MEMPOOL_NON_MINING_CAPACITY, 10_000);
  assert.equal(DEFAULT_MEMPOOL_NON_MINING_MAX_BYTES, 64 * 1024 * 1024);
  assert.doesNotThrow(() => assertMempoolSenderNonce(64, 0));
  assert.throws(() => assertMempoolSenderNonce(65, 0), /nonce outside mempool window/);
  assert.throws(() => new ZyronChain(profileGenesis("zyron-fee-limit")).selectValidPending([], 10_001), /Invalid pending selection limit/);
});

test("feePolicy is refused unless it is the single fixed-fee-v1 parameter on fixed-supply-v1", () => {
  const bare = profileGenesis("zyron-fee-bare");
  delete bare.launchProfile;
  delete bare.activityOraclePolicy;
  delete bare.activityOracleThreshold;
  delete bare.publicDistributionRelease;
  bare.validators = bare.validators.slice(0, 1);
  bare.activityOracles = bare.activityOracles.slice(0, 1);
  bare.feePolicy = { version: "fixed-fee-v1", fixedTransferFeeAtoms: FIXED_TRANSFER_FEE_ATOMS };
  assert.throws(() => new ZyronChain(bare), /requires launchProfile fixed-supply-v1/);

  const badVersion = profileGenesis("zyron-fee-version");
  badVersion.feePolicy = { version: "other" as "fixed-fee-v1", fixedTransferFeeAtoms: 1 };
  assert.throws(() => new ZyronChain(badVersion), /Unsupported fixed-fee policy version/);

  const zero = profileGenesis("zyron-fee-zero", 0);
  assert.throws(() => new ZyronChain(zero), /Invalid fixed transfer fee/);

  const extra = profileGenesis("zyron-fee-extra", 1) as GenesisConfig & { feePolicy: Record<string, unknown> };
  extra.feePolicy.note = "no";
  assert.throws(() => new ZyronChain(extra), /Invalid fixed-fee policy/);
});

test("a fixed-supply genesis without feePolicy still burns the whole fee", () => {
  const genesis = profileGenesis("zyron-fee-historical");
  const chain = new ZyronChain(genesis);
  const when = genesis.timestampMs + DAY;
  const tx = transfer(genesis, PUBLIC_DISTRIBUTION, 1, 1_000, 10, when - 1);
  assert.doesNotThrow(() => validateTransactionShape(tx));
  assert.doesNotThrow(() => chain.validateMempoolAdmission(tx, when));
  const proposer = expectedValidator(chain.validatorsAt(1), 1, 0).address;
  finalize(chain, [tx], when);
  assert.equal(chain.balance(proposer), 0);
  assert.equal(chain.balance(addr(ALICE)), 1_000);
  assert.equal(chain.totalSupplyAtoms(), chain.genesisSupplyAtoms() - 10);
  assert.equal(chain.totalSupplyAtoms() + 10, MAX_SUPPLY_ATOMS);
});

test("fixed-fee-v1 rejects any other fee at shape, mempool and block validation", () => {
  const genesis = profileGenesis("zyron-fee-reject", FIXED_TRANSFER_FEE_ATOMS);
  const chain = new ZyronChain(genesis);
  const when = genesis.timestampMs + DAY;
  const wrong = transfer(genesis, PUBLIC_DISTRIBUTION, 1, 1, 10, when - 1);
  const right = transfer(genesis, PUBLIC_DISTRIBUTION, 1, 1, FIXED_TRANSFER_FEE_ATOMS, when - 1);
  assert.throws(() => validateTransactionShape(wrong, FIXED_TRANSFER_FEE_ATOMS), FEE);
  assert.doesNotThrow(() => validateTransactionShape(wrong));
  assert.throws(() => chain.validateMempoolAdmission(wrong, when), FEE);
  assert.throws(() => chain.validatePending([wrong], when), FEE);
  assert.deepEqual(chain.selectValidPending([wrong, right], 10, undefined, when).map((tx) => tx.txid), [right.txid]);
  const proposer = expectedValidator(chain.validatorsAt(1), 1, 0);
  assert.throws(() => chain.produceBlock([wrong], key(idFor(proposer.address)), { timestampMs: when }), FEE);
  assert.throws(() => new Mempool(undefined, undefined, undefined, undefined, {
    fixedTransferFeeAtoms: FIXED_TRANSFER_FEE_ATOMS,
    disableFeeReplacement: true
  }).add(wrong), FEE);
});

test("fixed-fee-v1 splits each fee, never mints, and holds supply at every block", () => {
  const feeAtoms = 3;
  const { burnAtoms, producerAtoms } = splitFixedFee(feeAtoms);
  const genesis = profileGenesis("zyron-fee-split", feeAtoms);
  const chain = new ZyronChain(genesis);
  assert.equal(chain.genesisSupplyAtoms(), MAX_SUPPLY_ATOMS);
  let burned = 0;
  const assertSupply = (): void => {
    assert.equal(chain.totalSupplyAtoms() + burned, chain.genesisSupplyAtoms());
    assert.ok(chain.totalSupplyAtoms() <= chain.genesisSupplyAtoms());
  };
  assertSupply();

  const when = genesis.timestampMs + DAY;
  finalize(chain, [], when);
  assertSupply();

  const tx = transfer(genesis, PUBLIC_DISTRIBUTION, 1, 50, feeAtoms, when);
  const proposer = expectedValidator(chain.validatorsAt(2), 2, 0).address;
  const proposerBefore = chain.balance(proposer);
  const senderBefore = chain.balance(addr(PUBLIC_DISTRIBUTION));
  finalize(chain, [tx], when + 1_000);
  burned += burnAtoms;
  assert.equal(chain.balance(addr(ALICE)), 50);
  assert.equal(chain.balance(proposer), proposerBefore + producerAtoms);
  assert.equal(chain.balance(addr(PUBLIC_DISTRIBUTION)), senderBefore - 50 - feeAtoms);
  assertSupply();

  const claim = createMiningClaim({
    chainId: genesis.chainId,
    nonce: 1,
    sender: addr(ALICE),
    height: chain.height + 1,
    previousHash: chain.tip.hash,
    rewardAtoms: 1,
    workNonce: "0000000000000000",
    timestampMs: when + 1_000
  }, key(ALICE), pub(ALICE));
  assert.throws(() => chain.validateMempoolAdmission(claim), /Mining is retired/);
  assert.throws(() => chain.produceBlock([claim], key(idFor(expectedValidator(chain.validatorsAt(chain.height + 1), chain.height + 1, 0).address)), {
    timestampMs: when + 2_000
  }), /Mining is retired/);
  assertSupply();
  assert.equal(chain.balance(addr(ALICE)), 50);
});

test("both appliers credit the producer share and burn the odd atom", () => {
  const genesis = profileGenesis("zyron-fee-appliers", 3);
  const tx = transfer(genesis, PUBLIC_DISTRIBUTION, 1, 9, 3, genesis.timestampMs + DAY);
  const producer = addr(VALIDATOR);
  const fee = { producer, fixedTransferFeeAtoms: 3 as number };
  const ledger = LedgerState.fromGenesis(genesis);
  const before = ledger.totalSupplyAtoms();
  ledger.apply(tx, genesis.activityPool, undefined, undefined, fee);
  assert.equal(ledger.balance(producer), 1);
  assert.equal(ledger.balance(addr(ALICE)), 9);
  assert.equal(ledger.totalSupplyAtoms() + 2, before);

  const historical = LedgerState.fromGenesis(genesis);
  historical.apply(tx, genesis.activityPool);
  assert.equal(historical.balance(producer), 0);
  assert.equal(historical.totalSupplyAtoms() + 3, before);

  const sparse = applyStateV2Transaction(
    stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot()),
    tx,
    genesis.activityPool,
    undefined,
    undefined,
    fee
  );
  assert.equal(stateV2Balance(sparse, producer), 1);
  assert.equal(stateV2Balance(sparse, addr(ALICE)), 9);
  const senderBefore = LedgerState.fromGenesis(genesis).balance(addr(PUBLIC_DISTRIBUTION));
  assert.equal(stateV2Balance(sparse, addr(PUBLIC_DISTRIBUTION)), senderBefore - 9 - 3);

  assert.throws(() => ledger.apply(
    transfer(genesis, PUBLIC_DISTRIBUTION, 2, 1, 3, genesis.timestampMs + DAY),
    genesis.activityPool,
    undefined,
    undefined,
    { producer: genesis.activityPool, fixedTransferFeeAtoms: 3 }
  ), /Activity pool cannot receive funds/);
});

test("fixed-fee-v1 block selection is arrival order and replacement by fee is disabled", () => {
  const genesis = profileGenesis("zyron-fee-fifo", FIXED_TRANSFER_FEE_ATOMS);
  const chain = new ZyronChain(genesis);
  const when = genesis.timestampMs + DAY;
  finalize(chain, [transfer(genesis, PUBLIC_DISTRIBUTION, 1, 5_000_000, FIXED_TRANSFER_FEE_ATOMS, when - 1, ALICE)], when);
  finalize(chain, [transfer(genesis, PUBLIC_DISTRIBUTION, 2, 5_000_000, FIXED_TRANSFER_FEE_ATOMS, when, BOB)], when + 1_000);
  const early = transfer(genesis, ALICE, 1, 1, FIXED_TRANSFER_FEE_ATOMS, when);
  const late = transfer(genesis, BOB, 1, 1, FIXED_TRANSFER_FEE_ATOMS, when + 50_000, ALICE);
  const selected = chain.selectValidPending([late, early], 10, undefined, when + 2_000);
  assert.deepEqual(selected.map((tx) => tx.txid), [late.txid, early.txid]);
  const budget = Buffer.byteLength(canonicalJson(late), "utf8");
  assert.deepEqual(
    chain.selectValidPending([late, early], 10, budget, when + 2_000).map((tx) => tx.txid),
    [late.txid]
  );
  assert.equal(chain.selectValidPending([late, early], 1, undefined, when + 2_000).length, 1);

  const pool = new Mempool(undefined, undefined, undefined, undefined, {
    disableFeeReplacement: true,
    fixedTransferFeeAtoms: FIXED_TRANSFER_FEE_ATOMS,
    maxPendingPerSender: 2
  });
  pool.add(early);
  const replacement = transfer(genesis, ALICE, 1, 2, FIXED_TRANSFER_FEE_ATOMS, when + 5);
  assert.throws(() => pool.add(replacement), /Conflicting sender nonce/);
  const second = transfer(genesis, ALICE, 2, 1, FIXED_TRANSFER_FEE_ATOMS, when + 6, BOB);
  const third = transfer(genesis, ALICE, 3, 1, FIXED_TRANSFER_FEE_ATOMS, when + 7, BOB);
  pool.add(second);
  assert.throws(() => pool.add(third), /Per-sender mempool cap exceeded/);
  assert.deepEqual(pool.values().map((tx) => tx.txid), [early.txid, second.txid]);
});

test("protocol v2 credits the block producer and keeps the supply identity", () => {
  const feeAtoms = FIXED_TRANSFER_FEE_ATOMS;
  const { burnAtoms, producerAtoms } = splitFixedFee(feeAtoms);
  const genesis = profileGenesis("zyron-fee-v2", feeAtoms);
  const chain = new ZyronChain(genesis);
  const input = {
    chainId: genesis.chainId,
    nonce: 1,
    sender: addr(VALIDATOR),
    activationHeight: 101,
    protocolVersion: 2
  };
  const upgrade = createProtocolUpgrade({
    ...input,
    approvals: genesis.validators.slice(0, validatorQuorumSize(genesis.validators.length)).map((validator) =>
      createProtocolUpgradeApproval(input, key(idFor(validator.address)), validator.publicKey)),
    timestampMs: genesis.timestampMs + 10
  }, key(VALIDATOR), pub(VALIDATOR));
  for (let height = 1; height <= 100; height += 1) {
    finalize(chain, height === 1 ? [upgrade] : [], genesis.timestampMs + height * 1_000);
    assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
  }
  assert.equal(chain.protocolVersionAt(chain.height + 1), 2);
  const when = genesis.timestampMs + DAY;
  const tx = transfer(genesis, PUBLIC_DISTRIBUTION, 1, 100, feeAtoms, when - 1);
  const proposer = expectedValidator(chain.validatorsAt(chain.height + 1), chain.height + 1, 0).address;
  finalize(chain, [tx], when);
  assert.equal(chain.balance(proposer as Address), producerAtoms);
  assert.equal(chain.balance(addr(ALICE)), 100);
  assert.equal(chain.totalSupplyAtoms() + burnAtoms, MAX_SUPPLY_ATOMS);
  const keys = chain.stateV2SemanticKeyPreimages();
  assert.ok(keys?.includes(`account:${proposer}`));
});

function repoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 8; index += 1) {
    if (existsSync(join(current, "l1", "package.json")) &&
        existsSync(join(current, "docs", "l1-launch-authorization.json"))) return current;
    current = resolve(current, "..");
  }
  throw new Error("Could not locate the ZyronChain repository root");
}

test("activation flags stay false and no shipped launch plan turns the fee policy on", () => {
  const root = repoRoot();
  const auth = JSON.parse(readFileSync(join(root, "docs", "l1-launch-authorization.json"), "utf8")) as {
    publicTestnetActivationAllowed: boolean;
    mainnetActivationAllowed: boolean;
  };
  assert.equal(auth.publicTestnetActivationAllowed, false);
  assert.equal(auth.mainnetActivationAllowed, false);
  const plan = JSON.parse(readFileSync(join(root, "docs", "fixed-supply-launch-plan.json"), "utf8")) as {
    feePolicy: { version: string; fixedTransferFeeAtoms: string; consensusEnforcementActivated: boolean };
    activationGates: Record<string, boolean>;
  };
  assert.equal(plan.feePolicy.version, "fixed-fee-v1");
  assert.equal(plan.feePolicy.fixedTransferFeeAtoms, String(FIXED_TRANSFER_FEE_ATOMS));
  assert.equal(plan.feePolicy.consensusEnforcementActivated, false);
  assert.equal(plan.activationGates.fixedFeePolicyV1Activated, false);
  for (const value of Object.values(plan.activationGates)) assert.equal(value, false);
  assert.equal(FIXED_FEE_MISMATCH_MESSAGE.includes("fixed protocol fee"), true);
});
