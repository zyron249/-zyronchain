// EXT-04 residual, PR A (tests only, no behaviour change): pin the current
// fail-closed handling of the retired `mining_claim` kind before any later
// clean-up removes the mining code paths (see the EXT-04 mining_claim removal
// design note). Every assertion compares the exact, stable error message, so a
// later refactor that keeps the kind rejected but changes where or how it is
// rejected must update this file deliberately.
//
// Pinned today:
//   (1) a well-formed, correctly signed `mining_claim` is rejected with
//       MINING_RETIRED_MESSAGE at shape validation, mempool admission,
//       pending validation / selection, block production, block validation
//       (proposal and attested block) and by the state appliers (legacy
//       LedgerState, generic State-v2 and the chain-context State-v2 mining
//       applier), under protocol v1, v2, v3, v5 and v6;
//   (2) MINING_TRACKER_ADDRESS stays protocol-reserved in genesis
//       (allocation, activity pool), allocation locks, transfers and activity
//       settlements, with its exact messages.
import assert from "node:assert/strict";
import test from "node:test";

import { validateAllocationLocks } from "../src/allocation-locks.js";
import { createBlockAttestation, createSignedBlock, validateBlockShape } from "../src/block.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import * as chainModule from "../src/chain.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { Mempool } from "../src/mempool.js";
import { MINING_RETIRED_MESSAGE, MINING_TRACKER_ADDRESS } from "../src/mining.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import {
  createActivitySettlement,
  createMiningClaim,
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer,
  validateTransactionShape
} from "../src/transaction.js";
import { ATOMS_PER_ZYN, type GenesisConfig, type MiningClaimTx, type Transaction } from "../src/types.js";

const RETIRED_MESSAGE_TEXT = "Mining is retired: mining_claim transactions are rejected by consensus";
const TRACKER_RESERVED = "Mining tracker address is protocol-reserved";

// The chain dispatches State-v2 mining claims to its own chain-context applier
// (not the generic applyStateV2Transaction); it is looked up at run time so a
// missing export fails this pin instead of the build.
type ChainContextMiningApplier = (state: ReturnType<typeof stateV2FromLedgerSnapshot>, tx: MiningClaimTx) => unknown;
const chainContextMiningApplier = (chainModule as unknown as Record<string, unknown>).applyMiningClaimStateV2 as ChainContextMiningApplier | undefined;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 71;
const ORACLE = 72;
const POOL = 73;
const MINER = 74;
const ALICE = 75;
const FOUNDER = 76;
const LIQUIDITY = 77;

function pinGenesis(chainId: string): GenesisConfig {
  return {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(POOL),
    allocations: [
      { address: addr(POOL), amountAtoms: 1_000 * ATOMS_PER_ZYN },
      { address: addr(ALICE), amountAtoms: 1_000 * ATOMS_PER_ZYN }
    ]
  };
}

/** Assert that `fn` throws an Error whose message is exactly `message`. */
function throwsExactly(fn: () => unknown, message: string, label: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, `${label}: expected an Error to be thrown`);
  assert.equal(thrown.message, message, `${label}: unexpected rejection message`);
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

/** Finalize heights 1..100 with protocol `version` scheduled from height 101. */
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

function wellFormedClaim(chain: ZyronChain, timestampMs: number): MiningClaimTx {
  return createMiningClaim({
    chainId: chain.genesis.chainId,
    nonce: chain.nonce(addr(MINER)) + 1,
    sender: addr(MINER),
    height: chain.height + 1,
    previousHash: chain.tip.hash,
    rewardAtoms: 625_000_000,
    workNonce: "0000000000000000",
    timestampMs
  }, key(MINER), pub(MINER));
}

test("PIN: the retired-mining message is the exact stable string", () => {
  assert.equal(MINING_RETIRED_MESSAGE, RETIRED_MESSAGE_TEXT);
  assert.equal(MINING_TRACKER_ADDRESS, `ZYN${"0".repeat(40)}`);
});

for (const version of [1, 2, 3, 5, 6]) {
  test(`PIN: a well-formed mining_claim is rejected with the exact retired message on every path (protocol v${version})`, () => {
    const genesis = pinGenesis(`zyron-mining-pin-v${version}`);
    const chain = chainAtVersion(genesis, version);
    const blockTime = genesis.timestampMs + 200_000;
    const heightBefore = chain.height;
    const tipBefore = chain.tip.hash;
    const supplyBefore = chain.totalSupplyAtoms();
    const claim = wellFormedClaim(chain, blockTime - 1);
    assert.equal(claim.kind, "mining_claim");

    // Gossip, RPC submission and block decoding all start with shape validation.
    throwsExactly(() => validateTransactionShape(claim), MINING_RETIRED_MESSAGE, "shape");
    // Mempool (standalone and chain admission).
    const mempool = new Mempool();
    throwsExactly(() => mempool.add(claim), MINING_RETIRED_MESSAGE, "mempool.add");
    assert.equal(mempool.size, 0);
    throwsExactly(() => chain.validateMempoolAdmission(claim, blockTime), MINING_RETIRED_MESSAGE, "mempool admission");
    // Pending validation, selection and block production.
    throwsExactly(() => chain.validatePending([claim], blockTime), MINING_RETIRED_MESSAGE, "validatePending");
    assert.deepEqual(chain.selectValidPending([claim], 10, undefined, blockTime), []);
    throwsExactly(
      () => chain.produceBlock([claim], key(VALIDATOR), { timestampMs: blockTime }),
      MINING_RETIRED_MESSAGE,
      "produceBlock"
    );
    // Both raw state appliers, reached without shape validation.
    const ledger = LedgerState.fromGenesis(genesis);
    const ledgerRoot = ledger.root();
    throwsExactly(() => ledger.apply(claim, genesis.activityPool), MINING_RETIRED_MESSAGE, "legacy applier");
    assert.equal(ledger.root(), ledgerRoot);
    assert.equal(ledger.miningClaimCount(), 0);
    const sparse = stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot());
    throwsExactly(
      () => applyStateV2Transaction(sparse, claim, genesis.activityPool),
      MINING_RETIRED_MESSAGE,
      "State-v2 applier"
    );
    // A forged claim from the tracker itself is still refused as retired first.
    const forged = { ...claim, sender: MINING_TRACKER_ADDRESS } as MiningClaimTx;
    throwsExactly(() => validateTransactionShape(forged), MINING_RETIRED_MESSAGE, "shape (tracker sender)");
    throwsExactly(() => LedgerState.fromGenesis(genesis).apply(forged, genesis.activityPool), MINING_RETIRED_MESSAGE, "legacy applier (tracker sender)");
    // The chain-context State-v2 mining applier that block production and
    // block validation dispatch mining claims to, reached without shape
    // validation (EXT-04 PR B must keep this rejection).
    assert.equal(typeof chainContextMiningApplier, "function", "chain-context State-v2 mining applier must be reachable");
    const sparseRoot = sparse.root();
    throwsExactly(() => chainContextMiningApplier!(sparse, claim), MINING_RETIRED_MESSAGE, "chain-context State-v2 mining applier");
    throwsExactly(() => chainContextMiningApplier!(sparse, forged), MINING_RETIRED_MESSAGE, "chain-context State-v2 mining applier (tracker sender)");
    assert.equal(sparse.root(), sparseRoot);

    // Block validation: a validator-signed block that carries the claim.
    const smuggled = createSignedBlock({
      version,
      chainId: genesis.chainId,
      height: chain.height + 1,
      round: 0,
      previousHash: chain.tip.hash,
      timestampMs: blockTime,
      transactions: [claim],
      stateRoot: "00".repeat(32),
      proposerPrivateKey: key(VALIDATOR),
      proposerPublicKey: pub(VALIDATOR)
    });
    throwsExactly(() => validateBlockShape(smuggled), MINING_RETIRED_MESSAGE, "block shape");
    throwsExactly(() => chain.validateProposal(smuggled, blockTime), MINING_RETIRED_MESSAGE, "validateProposal");
    // Give it a genuine finality certificate so only the claim can be the reason.
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
    throwsExactly(() => chain.acceptBlock(smuggled, blockTime), MINING_RETIRED_MESSAGE, "acceptBlock");

    // Nothing moved: no block, no reward, no counter, supply unchanged.
    assert.equal(chain.height, heightBefore);
    assert.equal(chain.tip.hash, tipBefore);
    assert.equal(chain.balance(addr(MINER)), 0);
    assert.equal(chain.nonce(addr(MINER)), 0);
    assert.equal(chain.miningClaimCount(), 0);
    assert.equal(chain.nextMiningRewardAtoms(), 0);
    assert.equal(chain.balance(MINING_TRACKER_ADDRESS), 0);
    assert.equal(chain.totalSupplyAtoms(), supplyBefore);

    // Ordinary blocks keep finalizing at the same height.
    finalize(chain, [], blockTime);
    assert.equal(chain.height, heightBefore + 1);
  });
}

test("PIN: a malformed mining_claim with extra keys fails the exact-key check first", () => {
  const chain = new ZyronChain(pinGenesis("zyron-mining-pin-extra"));
  const claim = wellFormedClaim(chain, chain.genesis.timestampMs + 1);
  throwsExactly(() => validateTransactionShape({ ...claim, extra: 1 }), "Invalid mining claim fields", "extra key");
  const missing: Record<string, unknown> = { ...claim };
  delete missing.workNonce;
  throwsExactly(() => validateTransactionShape(missing), "Invalid mining claim fields", "missing key");
});

test("PIN: MINING_TRACKER_ADDRESS cannot receive a genesis allocation or be the activity pool", () => {
  const base = pinGenesis("zyron-mining-pin-genesis");
  throwsExactly(
    () => new ZyronChain({ ...base, allocations: [...base.allocations, { address: MINING_TRACKER_ADDRESS, amountAtoms: 0 }] }),
    "Mining tracker cannot receive a genesis allocation",
    "genesis allocation (zero)"
  );
  throwsExactly(
    () => new ZyronChain({ ...base, allocations: [...base.allocations, { address: MINING_TRACKER_ADDRESS, amountAtoms: 1 }] }),
    "Mining tracker cannot receive a genesis allocation",
    "genesis allocation (non-zero)"
  );
  throwsExactly(
    () => new ZyronChain({ ...base, activityPool: MINING_TRACKER_ADDRESS }),
    "Mining tracker cannot be the activity pool",
    "activity pool"
  );
});

test("PIN: MINING_TRACKER_ADDRESS cannot be an allocation-lock role", () => {
  const base = pinGenesis("zyron-mining-pin-locks");
  const withLocks = (founderVesting: string, permanentLiquidity: string): GenesisConfig => ({
    ...base,
    allocations: [
      ...base.allocations,
      { address: addr(FOUNDER), amountAtoms: 1_000 * ATOMS_PER_ZYN },
      { address: addr(LIQUIDITY), amountAtoms: 1_000 * ATOMS_PER_ZYN }
    ],
    allocationLocks: { founderVesting, permanentLiquidity }
  } as GenesisConfig);
  const message = "Invalid allocation lock: mining tracker is protocol-reserved";
  throwsExactly(() => validateAllocationLocks(withLocks(MINING_TRACKER_ADDRESS, addr(LIQUIDITY))), message, "founder vesting role");
  throwsExactly(() => validateAllocationLocks(withLocks(addr(FOUNDER), MINING_TRACKER_ADDRESS)), message, "permanent liquidity role");
  // Control: the same genesis with real role addresses is accepted.
  validateAllocationLocks(withLocks(addr(FOUNDER), addr(LIQUIDITY)));
});

test("PIN: MINING_TRACKER_ADDRESS cannot send or receive a transfer (shape, mempool and legacy applier)", () => {
  const genesis = pinGenesis("zyron-mining-pin-transfer");
  const chain = new ZyronChain(genesis);
  const toTracker = createTransfer({
    chainId: genesis.chainId,
    nonce: 1,
    sender: addr(ALICE),
    receiver: MINING_TRACKER_ADDRESS,
    amountAtoms: 1,
    feeAtoms: 0,
    timestampMs: genesis.timestampMs + 1
  }, key(ALICE), pub(ALICE));
  throwsExactly(() => validateTransactionShape(toTracker), TRACKER_RESERVED, "transfer receiver shape");
  throwsExactly(() => chain.validateMempoolAdmission(toTracker), TRACKER_RESERVED, "transfer receiver admission");
  throwsExactly(() => LedgerState.fromGenesis(genesis).apply(toTracker, genesis.activityPool), TRACKER_RESERVED, "transfer receiver legacy applier");

  const fromTracker = { ...toTracker, sender: MINING_TRACKER_ADDRESS, receiver: addr(ALICE) };
  throwsExactly(() => validateTransactionShape(fromTracker), TRACKER_RESERVED, "transfer sender shape");
  throwsExactly(() => LedgerState.fromGenesis(genesis).apply(fromTracker, genesis.activityPool), TRACKER_RESERVED, "transfer sender legacy applier");
  assert.equal(chain.balance(MINING_TRACKER_ADDRESS), 0);
});

test("PIN: MINING_TRACKER_ADDRESS cannot receive or send an activity settlement (shape, mempool and legacy applier)", () => {
  const genesis = pinGenesis("zyron-mining-pin-settlement");
  const chain = new ZyronChain(genesis);
  const toTracker = createActivitySettlement({
    chainId: genesis.chainId,
    nonce: 1,
    sender: genesis.activityPool,
    epoch: 0,
    entries: [{ receiver: MINING_TRACKER_ADDRESS, amountAtoms: 1 }],
    receiptRoot: "00".repeat(32),
    timestampMs: genesis.timestampMs + 1
  }, key(ORACLE), pub(ORACLE));
  throwsExactly(() => validateTransactionShape(toTracker), TRACKER_RESERVED, "settlement entry shape");
  throwsExactly(() => chain.validateMempoolAdmission(toTracker), TRACKER_RESERVED, "settlement entry admission");
  throwsExactly(() => LedgerState.fromGenesis(genesis).apply(toTracker, genesis.activityPool), TRACKER_RESERVED, "settlement entry legacy applier");

  const fromTracker = { ...toTracker, sender: MINING_TRACKER_ADDRESS, entries: [{ receiver: addr(ALICE), amountAtoms: 1 }] };
  throwsExactly(() => validateTransactionShape(fromTracker), TRACKER_RESERVED, "settlement sender shape");
  assert.equal(chain.balance(MINING_TRACKER_ADDRESS), 0);
});
