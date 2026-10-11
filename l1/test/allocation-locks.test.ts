// Launch blocker (owner-approved token model): the 5M founder allocation must
// vest on-chain (12-month cliff, then 36-month linear release) and the 20M
// permanent-liquidity reserve must never move. Before this change both were
// ordinary accounts that could spend everything in the first block.
//
// A genesis now names both accounts in `allocationLocks`. Every chain path
// (mempool admission, pending validation and selection, block production,
// proposal/prepared/finalized validation, acceptBlock) must enforce the locks
// under every supported protocol version (see docs/ALLOCATION_LOCKS.md).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBlockAttestation, createSignedBlock, createUnsignedBlock } from "../src/block.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeService } from "../src/node.js";
import { ChainStore } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type GenesisConfig, type Transaction } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const DAY_MS = 86_400_000;
const CLIFF_MS = 365 * DAY_MS;
const LINEAR_MS = 1_095 * DAY_MS;
const FOUNDER_ATOMS = 5_000_000 * ZYN;
const LIQUIDITY_ATOMS = 20_000_000 * ZYN;
const VESTING = /Founder allocation is still vesting/;
const LIQUIDITY_LOCKED = /Permanent-liquidity reserve is locked/;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 81;
const ORACLE = 82;
const FOUNDER = 83;
const PUBLIC_DISTRIBUTION = 84;
const LIQUIDITY = 85;
const ECOSYSTEM = 86;
const ALICE = 87;

function lockedGenesis(chainId: string, timestampMs = 1_700_000_000_000): GenesisConfig {
  return {
    chainId,
    timestampMs,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: FOUNDER_ATOMS },
      { address: addr(PUBLIC_DISTRIBUTION), amountAtoms: 20_000_000 * ZYN },
      { address: addr(LIQUIDITY), amountAtoms: LIQUIDITY_ATOMS },
      { address: addr(ECOSYSTEM), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) }
  } as GenesisConfig;
}

/** Exact BigInt reference for the founder schedule at `elapsedMs` after genesis. */
function vestedAt(elapsedMs: number): number {
  if (elapsedMs <= CLIFF_MS) return 0;
  const linear = BigInt(Math.min(elapsedMs - CLIFF_MS, LINEAR_MS));
  return Number((BigInt(FOUNDER_ATOMS) * linear) / BigInt(LINEAR_MS));
}

function finalize(chain: ZyronChain, txs: Transaction[], timestampMs: number): void {
  let block = chain.produceBlock(txs, key(VALIDATOR), { timestampMs });
  if (isConsensusV6(chain.protocolVersionAt(block.header.height))) {
    block.commitRound = 0;
    block.attestations = [{
      validator: addr(VALIDATOR),
      publicKey: pub(VALIDATOR),
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(VALIDATOR))
    }];
  } else {
    block = chain.attestBlock(block, key(VALIDATOR));
  }
  chain.acceptBlock(block, timestampMs);
}

/** Finalize heights 1..100 (1 s apart) with protocol `version` scheduled from height 101. */
function chainAtVersion(genesis: GenesisConfig, version: number): ZyronChain {
  const chain = new ZyronChain(genesis);
  if (version === 1) return chain;
  const input = { chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101, protocolVersion: version };
  const upgrade = createProtocolUpgrade({
    ...input,
    approvals: [createProtocolUpgradeApproval(input, key(VALIDATOR), pub(VALIDATOR))],
    timestampMs: genesis.timestampMs + 10
  }, key(VALIDATOR), pub(VALIDATOR));
  for (let height = 1; height <= 100; height += 1) {
    finalize(chain, height === 1 ? [upgrade] : [], genesis.timestampMs + height * 1_000);
  }
  assert.equal(chain.protocolVersionAt(chain.height + 1), version);
  return chain;
}

const txVersionFor = (protocolVersion: number) => (protocolVersion >= 3 ? 2 : 1);

function transfer(
  genesis: GenesisConfig,
  sender: number,
  nonce: number,
  amountAtoms: number,
  feeAtoms: number,
  txVersion: 1 | 2,
  receiver = ALICE
) {
  return createTransfer({
    chainId: genesis.chainId, nonce, sender: addr(sender), receiver: addr(receiver),
    amountAtoms, feeAtoms, timestampMs: genesis.timestampMs + 1
  }, key(sender), pub(sender), txVersion);
}

/** Assert that `tx` is refused by every chain path at `blockTime` and that nothing changed. */
function assertRejectedEverywhere(chain: ZyronChain, tx: Transaction, blockTime: number, error: RegExp): void {
  const genesis = chain.genesis;
  const heightBefore = chain.height;
  const senderBefore = chain.balance(tx.sender);
  assert.throws(() => chain.validateMempoolAdmission(tx, blockTime), error, "mempool admission");
  assert.throws(() => chain.validatePending([tx], blockTime), error, "pending validation");
  assert.deepEqual(chain.selectValidPending([tx], 10, undefined, blockTime), [], "pending selection");
  assert.throws(() => chain.produceBlock([tx], key(VALIDATOR), { timestampMs: blockTime }), error, "block production");
  assert.throws(() => chain.prepareBlock([tx], pub(VALIDATOR), { timestampMs: blockTime }), error, "block preparation");
  // A proposer-signed block that smuggles the transaction in (state root is
  // irrelevant: the lock fires while applying the transactions).
  const version = chain.protocolVersionAt(chain.height + 1);
  const smuggled = createSignedBlock({
    version,
    chainId: genesis.chainId,
    height: chain.height + 1,
    round: 0,
    previousHash: chain.tip.hash,
    timestampMs: blockTime,
    transactions: [tx],
    stateRoot: "00".repeat(32),
    proposerPrivateKey: key(VALIDATOR),
    proposerPublicKey: pub(VALIDATOR)
  });
  assert.throws(() => chain.validateProposal(smuggled, blockTime), error, "proposal validation");
  const unsigned = createUnsignedBlock({
    version,
    chainId: genesis.chainId,
    height: chain.height + 1,
    round: 0,
    previousHash: chain.tip.hash,
    timestampMs: blockTime,
    transactions: [tx],
    stateRoot: "00".repeat(32),
    proposerPublicKey: pub(VALIDATOR),
    roundCertificate: []
  });
  assert.throws(() => chain.validatePreparedUnsignedBlock(unsigned, blockTime), error, "prepared validation");
  if (isConsensusV6(version)) {
    smuggled.commitRound = 0;
    smuggled.attestations = [{
      validator: addr(VALIDATOR),
      publicKey: pub(VALIDATOR),
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(smuggled.header.chainId, smuggled.header.height, 0, smuggled.hash), key(VALIDATOR))
    }];
  } else {
    smuggled.attestations.push(createBlockAttestation(smuggled, key(VALIDATOR), pub(VALIDATOR)));
  }
  assert.throws(() => chain.validateFinalizedBlock(smuggled, blockTime), error, "finalized validation");
  assert.throws(() => chain.acceptBlock(smuggled, blockTime), error, "finalized block acceptance");
  assert.equal(chain.height, heightBefore);
  assert.equal(chain.balance(tx.sender), senderBefore);
}

function assertAcceptedEverywhere(chain: ZyronChain, tx: Transaction, blockTime: number): void {
  chain.validateMempoolAdmission(tx, blockTime);
  chain.validatePending([tx], blockTime);
  assert.deepEqual(chain.selectValidPending([tx], 10, undefined, blockTime).map((item) => item.txid), [tx.txid]);
  finalize(chain, [tx], blockTime);
}

for (const version of [1, 2, 3, 5, 6]) {
  test(`ALLOCATION-LOCKS: founder vesting is enforced on every chain path under protocol v${version}`, () => {
    const genesis = lockedGenesis(`zyron-founder-lock-v${version}`);
    const chain = chainAtVersion(genesis, version);
    const txVersion = txVersionFor(version);
    const g = genesis.timestampMs;

    // During the cliff nothing is spendable (the next block is at height 1 or 101).
    const early = chain.tip.header.timestampMs + 1_000;
    assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, 1, 0, txVersion), early, VESTING);
    // A fee alone is also an outflow.
    assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, 1, 1, txVersion), early, VESTING);
    // Exactly at the cliff nothing has vested yet.
    assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, 1, 0, txVersion), g + CLIFF_MS, VESTING);

    // Mid-linear: exactly the vested amount (amount + fee) moves; one more atom does not.
    const mid = g + CLIFF_MS + LINEAR_MS / 3 + 12_345;
    const vested = vestedAt(mid - g);
    assert.ok(vested > 0 && vested < FOUNDER_ATOMS);
    assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, vested - 10, 11, txVersion), mid, VESTING);
    assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, vested + 1, 0, txVersion), mid, VESTING);
    assertAcceptedEverywhere(chain, transfer(genesis, FOUNDER, 1, vested - 10, 10, txVersion), mid);
    assert.equal(chain.balance(addr(FOUNDER)), FOUNDER_ATOMS - vested);
    assert.equal(chain.balance(addr(ALICE)), vested - 10);
    // One millisecond later only that millisecond's release is spendable.
    const delta = vestedAt(mid + 1 - g) - vested;
    assert.ok(delta > 0);
    assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 2, delta + 1, 0, txVersion), mid + 1, VESTING);
    assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS - 10, "fees are burned, nothing is minted");
  });

  test(`ALLOCATION-LOCKS: the permanent-liquidity reserve can never send under protocol v${version}`, () => {
    const genesis = lockedGenesis(`zyron-liquidity-lock-v${version}`);
    const chain = chainAtVersion(genesis, version);
    const txVersion = txVersionFor(version);
    const g = genesis.timestampMs;
    for (const blockTime of [chain.tip.header.timestampMs + 1_000, g + CLIFF_MS + LINEAR_MS + 1, g + 100 * 366 * DAY_MS]) {
      assertRejectedEverywhere(chain, transfer(genesis, LIQUIDITY, 1, 1, 0, txVersion), blockTime, LIQUIDITY_LOCKED);
      assertRejectedEverywhere(chain, transfer(genesis, LIQUIDITY, 1, 1, 1, txVersion), blockTime, LIQUIDITY_LOCKED);
      assertRejectedEverywhere(chain, transfer(genesis, LIQUIDITY, 1, LIQUIDITY_ATOMS, 0, txVersion), blockTime, LIQUIDITY_LOCKED);
    }
    // Inflows are accepted and stay locked: the lock follows the address.
    const inflowTime = chain.tip.header.timestampMs + 2_000;
    assertAcceptedEverywhere(chain, transfer(genesis, PUBLIC_DISTRIBUTION, 1, 7 * ZYN, 1, txVersion, LIQUIDITY), inflowTime);
    assert.equal(chain.balance(addr(LIQUIDITY)), LIQUIDITY_ATOMS + 7 * ZYN);
    assertRejectedEverywhere(chain, transfer(genesis, LIQUIDITY, 1, 7 * ZYN, 0, txVersion), inflowTime + 1_000, LIQUIDITY_LOCKED);
  });
}

test("ALLOCATION-LOCKS: founder linear release at 1 ms and 1 day past the cliff", () => {
  const genesis = lockedGenesis("zyron-founder-boundary");
  const chain = new ZyronChain(genesis);
  const g = genesis.timestampMs;
  const oneMs = vestedAt(CLIFF_MS + 1);
  assert.equal(oneMs, Math.floor(FOUNDER_ATOMS / LINEAR_MS));
  assert.ok(oneMs > 0);
  assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, oneMs + 1, 0, 1), g + CLIFF_MS + 1, VESTING);
  assertAcceptedEverywhere(chain, transfer(genesis, FOUNDER, 1, oneMs, 0, 1), g + CLIFF_MS + 1);

  const oneDay = vestedAt(CLIFF_MS + DAY_MS);
  assert.equal(oneDay, Math.floor(FOUNDER_ATOMS / 1_095));
  assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 2, oneDay - oneMs, 1, 1), g + CLIFF_MS + DAY_MS, VESTING);
  assertAcceptedEverywhere(chain, transfer(genesis, FOUNDER, 2, oneDay - oneMs - 1, 1, 1), g + CLIFF_MS + DAY_MS);
  assert.equal(chain.balance(addr(FOUNDER)), FOUNDER_ATOMS - oneDay);
});

test("ALLOCATION-LOCKS: the whole founder balance is spendable once the schedule ends", () => {
  const genesis = lockedGenesis("zyron-founder-end");
  const chain = new ZyronChain(genesis);
  const g = genesis.timestampMs;
  // One millisecond before the end, one millisecond's release is still locked.
  assert.equal(vestedAt(CLIFF_MS + LINEAR_MS - 1), FOUNDER_ATOMS - Math.ceil(FOUNDER_ATOMS / LINEAR_MS));
  assert.equal(vestedAt(CLIFF_MS + LINEAR_MS), FOUNDER_ATOMS);
  assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, FOUNDER_ATOMS, 0, 1), g + CLIFF_MS + LINEAR_MS - 1, VESTING);
  assertAcceptedEverywhere(chain, transfer(genesis, FOUNDER, 1, FOUNDER_ATOMS - 1, 1, 1), g + CLIFF_MS + LINEAR_MS);
  assert.equal(chain.balance(addr(FOUNDER)), 0);
});

test("ALLOCATION-LOCKS: founder inflows are spendable during the cliff, the allocation is not", () => {
  const genesis = lockedGenesis("zyron-founder-inflow");
  const chain = new ZyronChain(genesis);
  const t = genesis.timestampMs + 1_000;
  assertAcceptedEverywhere(chain, transfer(genesis, PUBLIC_DISTRIBUTION, 1, 100, 0, 1, FOUNDER), t);
  assert.equal(chain.spendableBalance(addr(FOUNDER), t + 1_000), 100);
  assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, 100, 1, 1), t + 1_000, VESTING);
  assertAcceptedEverywhere(chain, transfer(genesis, FOUNDER, 1, 99, 1, 1), t + 1_000);
  assert.equal(chain.balance(addr(FOUNDER)), FOUNDER_ATOMS);
});

test("ALLOCATION-LOCKS: spendableBalance reflects the locks while balance is unchanged", () => {
  const genesis = lockedGenesis("zyron-spendable");
  const chain = new ZyronChain(genesis);
  const g = genesis.timestampMs;
  assert.equal(chain.balance(addr(FOUNDER)), FOUNDER_ATOMS);
  assert.equal(chain.balance(addr(LIQUIDITY)), LIQUIDITY_ATOMS);
  assert.equal(chain.spendableBalance(addr(FOUNDER), g + 1_000), 0);
  assert.equal(chain.spendableBalance(addr(FOUNDER), g + CLIFF_MS), 0);
  assert.equal(chain.spendableBalance(addr(FOUNDER), g + CLIFF_MS + LINEAR_MS / 2), FOUNDER_ATOMS / 2);
  assert.equal(chain.spendableBalance(addr(FOUNDER), g + 10 * CLIFF_MS), FOUNDER_ATOMS);
  assert.equal(chain.spendableBalance(addr(LIQUIDITY), g + 100 * 366 * DAY_MS), 0);
  assert.equal(chain.spendableBalance(addr(PUBLIC_DISTRIBUTION), g + 1_000), 20_000_000 * ZYN);
});

test("ALLOCATION-LOCKS: a genesis without allocationLocks keeps the previous behaviour", () => {
  const genesis = lockedGenesis("zyron-unlocked");
  delete (genesis as { allocationLocks?: unknown }).allocationLocks;
  const chain = new ZyronChain(genesis);
  const t = genesis.timestampMs + 1_000;
  assertAcceptedEverywhere(chain, transfer(genesis, FOUNDER, 1, FOUNDER_ATOMS - 1, 1, 1), t);
  assertAcceptedEverywhere(chain, transfer(genesis, LIQUIDITY, 1, LIQUIDITY_ATOMS, 0, 1), t + 1_000);
});

test("ALLOCATION-LOCKS: node mempool rejects single and aggregate founder spends above the unlocked balance", async () => {
  // Genesis placed so that roughly half of the founder allocation has vested now.
  const genesis = lockedGenesis("zyron-lock-mempool", Date.now() - CLIFF_MS - LINEAR_MS / 2);
  const directory = await mkdtemp(join(tmpdir(), "zyron-allocation-locks-"));
  try {
    const store = await ChainStore.open(genesis, directory);
    const service = new NodeService(store);
    const unlocked = store.chain.spendableBalance(addr(FOUNDER));
    assert.ok(unlocked >= FOUNDER_ATOMS / 2 && unlocked < FOUNDER_ATOMS * 0.51);
    // Single: more than the unlocked balance.
    assert.throws(() => service.submitTransaction(transfer(genesis, FOUNDER, 1, FOUNDER_ATOMS * 0.6, 0, 1)), VESTING);
    // Aggregate: each spend fits on its own, together they exceed the unlocked balance.
    const first = transfer(genesis, FOUNDER, 1, FOUNDER_ATOMS * 0.3, 0, 1);
    assert.equal(service.submitTransaction(first), first.txid);
    assert.throws(
      () => service.submitTransaction(transfer(genesis, FOUNDER, 2, FOUNDER_ATOMS * 0.3, 0, 1)),
      /Pending transfers exceed unlocked balance/
    );
    // Liquidity reserve: refused at submission.
    assert.throws(() => service.submitTransaction(transfer(genesis, LIQUIDITY, 1, 1, 0, 1)), LIQUIDITY_LOCKED);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ALLOCATION-LOCKS: founder spends at height 1 and exactly at the cliff are refused", () => {
  const genesis = lockedGenesis("zyron-founder-height-one");
  const chain = new ZyronChain(genesis);
  const g = genesis.timestampMs;
  assert.equal(chain.height, 0);
  assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, 1, 0, 1), g + 1, VESTING);
  assertRejectedEverywhere(chain, transfer(genesis, FOUNDER, 1, 1, 0, 1), g + CLIFF_MS, VESTING);
  assert.equal(chain.spendableBalance(addr(FOUNDER), g + CLIFF_MS), 0);
  assert.equal(chain.height, 0);
});

test("ALLOCATION-LOCKS: locks still apply after the node store is reopened", async () => {
  const genesis = lockedGenesis("zyron-lock-reopen", Date.now() - 10 * DAY_MS);
  const directory = await mkdtemp(join(tmpdir(), "zyron-allocation-locks-reopen-"));
  try {
    const first = await ChainStore.open(genesis, directory);
    const service = new NodeService(first);
    let block = first.chain.produceBlock([], key(VALIDATOR), { timestampMs: Date.now() });
    block = first.chain.attestBlock(block, key(VALIDATOR));
    await service.acceptFinalizedBlock(block);
    const reopened = await ChainStore.open(genesis, directory);
    assert.equal(reopened.chain.height, 1);
    assert.equal(reopened.chain.spendableBalance(addr(FOUNDER)), 0);
    assert.equal(reopened.chain.spendableBalance(addr(LIQUIDITY)), 0);
    assert.throws(() => reopened.chain.validatePending([transfer(genesis, FOUNDER, 1, 1, 0, 1)]), VESTING);
    assert.throws(() => reopened.chain.validatePending([transfer(genesis, LIQUIDITY, 1, 1, 0, 1)]), LIQUIDITY_LOCKED);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ALLOCATION-LOCKS: the genesis lock declaration is part of the chain configuration", () => {
  const genesis = lockedGenesis("zyron-lock-config");
  const chain = new ZyronChain(genesis);
  const locks = (chain.genesis as { allocationLocks?: unknown }).allocationLocks;
  assert.deepEqual(locks, { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) });
  // The stored configuration is a copy: mutating the input cannot unlock anything.
  (genesis as { allocationLocks?: { founderVesting: string } }).allocationLocks!.founderVesting = addr(ALICE);
  assert.throws(() => chain.validatePending([transfer(genesis, FOUNDER, 1, 1, 0, 1)], genesis.timestampMs + 1), VESTING);
});
