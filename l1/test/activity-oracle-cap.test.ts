// ZC-CRY-20260930-010 (launch blocker): a single genesis activity-oracle key
// could settle the whole activity pool in one batch, and could settle any
// unsettled epoch number in any order (including far-future epochs).
//
// Consensus now enforces (see docs/ACTIVITY_ORACLE_CAP.md):
//   (1) a per-settlement cap of 10,000 ZYN; every epoch settles at most once,
//       so this is also the per-epoch cap;
//   (2) a wall-clock window: epoch e (24 h, counted from the genesis
//       timestamp) can be settled only by a block whose timestamp lies in the
//       following epoch, i.e. only the most recently closed epoch is
//       settleable; missed epochs are forfeited, so idle time never
//       accumulates into a larger burst;
//   (3) strictly increasing epochs: a settlement is rejected when a later
//       epoch is already settled (state appliers and chain paths).
// The file uses only APIs that predate the change (optional trailing
// timestamp arguments are ignored by the old code) so it fails before the fix.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBlockAttestation, createSignedBlock, validateBlockShape } from "../src/block.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeService } from "../src/node.js";
import { LedgerState } from "../src/state.js";
import { ChainStore } from "../src/storage.js";
import { applyStateV2Transaction, stateV2Balance, stateV2FromLedgerSnapshot, type SparseMerkleState } from "../src/state-v2.js";
import {
  createActivitySettlement,
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  validateTransactionShape
} from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type ActivitySettlementTx, type GenesisConfig } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const EPOCH_MS = 86_400_000;
const CAP = 10_000 * ZYN;
const POOL = 5_000_000 * ZYN;
const OVER_CAP = /exceeds the per-epoch activity cap/;
const NOT_CLOSED = /Activity epoch is not closed yet/;
const WINDOW_CLOSED = /Activity epoch settlement window has closed/;
const ORDER = /Activity epochs must settle in increasing order/;
const SETTLED = /Activity epoch already settled/;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 61;
const ORACLE = 62;
const FOUNDER = 63;
const PUBLIC_DISTRIBUTION = 64;
const LIQUIDITY = 65;
const ECOSYSTEM = 66; // also the activity pool
const ALICE = 67;

function capGenesis(chainId: string): GenesisConfig {
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
      { address: addr(ECOSYSTEM), amountAtoms: POOL }
    ]
  };
}

/** A timestamp inside the settlement window of `epoch` (= inside epoch + 1). */
const windowOf = (genesis: GenesisConfig, epoch: number, offsetMs = 60_000) =>
  genesis.timestampMs + (epoch + 1) * EPOCH_MS + offsetMs;

function finalize(chain: ZyronChain, txs: Parameters<ZyronChain["produceBlock"]>[0], timestampMs: number): void {
  let block = chain.produceBlock(txs, key(VALIDATOR), { timestampMs });
  if (isConsensusV6(chain.protocolVersionAt(block.header.height))) {
    // v6 finality: a commit certificate for round 0 from the single validator.
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

function settle(
  genesis: GenesisConfig,
  epoch: number,
  nonce: number,
  amountAtoms: number,
  txVersion: 1 | 2 = 1,
  signer = ORACLE
): ActivitySettlementTx {
  return createActivitySettlement({
    chainId: genesis.chainId, nonce, sender: genesis.activityPool, epoch,
    entries: [{ receiver: addr(ALICE), amountAtoms }],
    receiptRoot: "00".repeat(32), timestampMs: genesis.timestampMs + 1
  }, key(signer), pub(signer), txVersion);
}

for (const version of [1, 2, 3, 5, 6]) {
  test(`ORACLE-CAP: one oracle key cannot drain the activity pool under protocol v${version} on any path`, () => {
    const genesis = capGenesis(`zyron-oracle-cap-v${version}`);
    const chain = chainAtVersion(genesis, version);
    const txVersion = version >= 3 ? 2 : 1;
    const blockTime = windowOf(genesis, 0);
    const heightBefore = chain.height;

    for (const amount of [POOL, CAP + 1]) {
      const drain = settle(genesis, 0, 1, amount, txVersion);
      // Gossip, RPC submission and block decoding all start with shape validation.
      assert.throws(() => validateTransactionShape(drain), OVER_CAP);
      // Mempool admission, pending validation and block production.
      assert.throws(() => chain.validateMempoolAdmission(drain, blockTime), OVER_CAP);
      assert.throws(() => chain.validatePending([drain], blockTime), OVER_CAP);
      assert.deepEqual(chain.selectValidPending([drain], 10, undefined, blockTime), []);
      assert.throws(() => chain.produceBlock([drain], key(VALIDATOR), { timestampMs: blockTime }), OVER_CAP);
      // Raw state appliers, reached without shape validation.
      assert.throws(() => LedgerState.fromGenesis(genesis).apply(drain, genesis.activityPool), OVER_CAP);
      assert.throws(() => applyStateV2Transaction(stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot()), drain, genesis.activityPool), OVER_CAP);
      // A validator-signed, attested block that carries the drain.
      const smuggled = createSignedBlock({
        version,
        chainId: genesis.chainId,
        height: chain.height + 1,
        round: 0,
        previousHash: chain.tip.hash,
        timestampMs: blockTime,
        transactions: [drain],
        stateRoot: "00".repeat(32),
        proposerPrivateKey: key(VALIDATOR),
        proposerPublicKey: pub(VALIDATOR)
      });
      assert.throws(() => validateBlockShape(smuggled), OVER_CAP);
      assert.throws(() => chain.validateProposal(smuggled, blockTime), OVER_CAP);
      // Give the block a genuine finality certificate for its protocol, so the
      // only remaining reason to refuse it is the drain itself (finality and
      // proposer checks run before transaction checks, finding F-11).
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
      assert.throws(() => chain.acceptBlock(smuggled, blockTime), OVER_CAP);
    }
    assert.equal(chain.height, heightBefore);
    assert.equal(chain.balance(genesis.activityPool), POOL);

    // A settlement of exactly the cap in the right window still pays out.
    const ok = settle(genesis, 0, 1, CAP, txVersion);
    chain.validateMempoolAdmission(ok, blockTime);
    assert.deepEqual(chain.selectValidPending([ok], 10, undefined, blockTime).map((tx) => tx.txid), [ok.txid]);
    finalize(chain, [ok], blockTime);
    assert.equal(chain.balance(addr(ALICE)), CAP);
    assert.equal(chain.balance(genesis.activityPool), POOL - CAP);
    assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
  });

  test(`ORACLE-CAP: epochs settle once, only after they close, strictly in order (protocol v${version})`, () => {
    const genesis = capGenesis(`zyron-oracle-epochs-v${version}`);
    const chain = chainAtVersion(genesis, version);
    const txVersion = version >= 3 ? 2 : 1;
    let nonce = 1;

    // Before epoch 0 has closed nothing is settleable, and future epochs never are.
    const early = genesis.timestampMs + EPOCH_MS - 1;
    assert.throws(() => chain.validateMempoolAdmission(settle(genesis, 0, nonce, 1, txVersion), early), NOT_CLOSED);
    assert.throws(() => chain.produceBlock([settle(genesis, 0, nonce, 1, txVersion)], key(VALIDATOR), { timestampMs: early }), NOT_CLOSED);
    const day1 = windowOf(genesis, 0);
    for (const future of [1, 2, 365, 1_000_000]) {
      const tx = settle(genesis, future, nonce, 1, txVersion);
      assert.throws(() => chain.validateMempoolAdmission(tx, day1), NOT_CLOSED);
      assert.throws(() => chain.validatePending([tx], day1), NOT_CLOSED);
      assert.deepEqual(chain.selectValidPending([tx], 10, undefined, day1), []);
      assert.throws(() => chain.produceBlock([tx], key(VALIDATOR), { timestampMs: day1 }), NOT_CLOSED);
    }

    // Epoch 0 in its window: accepted once.
    finalize(chain, [settle(genesis, 0, nonce++, CAP, txVersion)], day1);
    const replay = settle(genesis, 0, nonce, CAP, txVersion);
    assert.throws(() => chain.validateMempoolAdmission(replay, day1 + 1_000), SETTLED);
    assert.throws(() => chain.produceBlock([replay], key(VALIDATOR), { timestampMs: day1 + 1_000 }), SETTLED);

    // Next day: epoch 1. Epoch 0 stays settled.
    const day2 = windowOf(genesis, 1);
    finalize(chain, [settle(genesis, 1, nonce++, CAP, txVersion)], day2);
    // Epoch 0 is both settled and outside its window now.
    assert.throws(() => chain.produceBlock([settle(genesis, 0, nonce, 1, txVersion)], key(VALIDATOR), { timestampMs: day2 + 1_000 }), WINDOW_CLOSED);

    // Idle for ten epochs: only the most recently closed epoch (11) is settleable;
    // the missed epochs 2..10 are forfeited instead of accumulating into a burst.
    const day12 = windowOf(genesis, 11);
    for (const missed of [2, 5, 10]) {
      const tx = settle(genesis, missed, nonce, CAP, txVersion);
      assert.throws(() => chain.validateMempoolAdmission(tx, day12), WINDOW_CLOSED);
      assert.throws(() => chain.produceBlock([tx], key(VALIDATOR), { timestampMs: day12 }), WINDOW_CLOSED);
    }
    // Two settlements in one block cannot double the epoch budget either.
    assert.throws(() => chain.produceBlock([
      settle(genesis, 10, nonce, CAP, txVersion),
      settle(genesis, 11, nonce + 1, CAP, txVersion)
    ], key(VALIDATOR), { timestampMs: day12 }), WINDOW_CLOSED);
    finalize(chain, [settle(genesis, 11, nonce++, CAP, txVersion)], day12);
    assert.throws(() => chain.produceBlock([settle(genesis, 10, nonce, 1, txVersion)], key(VALIDATOR), { timestampMs: day12 + 1_000 }), WINDOW_CLOSED);

    assert.equal(chain.balance(addr(ALICE)), 3 * CAP, "three closed-epoch settlements, each at most the cap");
    assert.equal(chain.balance(genesis.activityPool), POOL - 3 * CAP);
    assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
  });
}

test("ORACLE-CAP: state appliers refuse replayed and out-of-order epochs", () => {
  const genesis = capGenesis("zyron-oracle-appliers");
  const ledger = LedgerState.fromGenesis(genesis);
  ledger.apply(settle(genesis, 3, 1, CAP), genesis.activityPool);
  assert.throws(() => ledger.clone().apply(settle(genesis, 3, 2, 1), genesis.activityPool), SETTLED);
  assert.throws(() => ledger.clone().apply(settle(genesis, 2, 2, 1), genesis.activityPool), ORDER);
  ledger.apply(settle(genesis, 4, 2, CAP), genesis.activityPool);
  assert.equal(ledger.balance(addr(ALICE)), 2 * CAP);

  let sparse: SparseMerkleState = stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot());
  sparse = applyStateV2Transaction(sparse, settle(genesis, 3, 1, CAP, 2), genesis.activityPool);
  const afterThree = sparse;
  assert.throws(() => applyStateV2Transaction(afterThree, settle(genesis, 3, 2, 1, 2), genesis.activityPool), SETTLED);
  assert.throws(() => applyStateV2Transaction(afterThree, settle(genesis, 2, 2, 1, 2), genesis.activityPool), ORDER);
  sparse = applyStateV2Transaction(sparse, settle(genesis, 4, 2, CAP, 2), genesis.activityPool);
  assert.equal(stateV2Balance(sparse, addr(ALICE)), 2 * CAP);
});

test("ORACLE-CAP: the 5M pool needs at least 500 capped epochs and never pays more than 5M", () => {
  const genesis = capGenesis("zyron-oracle-cumulative");
  const ledger = LedgerState.fromGenesis(genesis);
  for (let epoch = 0; epoch < POOL / CAP; epoch += 1) {
    ledger.apply(settle(genesis, epoch, epoch + 1, CAP), genesis.activityPool);
  }
  assert.equal(ledger.balance(genesis.activityPool), 0);
  assert.equal(ledger.balance(addr(ALICE)), POOL);
  assert.throws(() => ledger.apply(settle(genesis, POOL / CAP, POOL / CAP + 1, 1), genesis.activityPool), /Activity pool exhausted/);
  assert.equal(ledger.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
});

test("ORACLE-CAP: a settlement whose window has closed is reported as expired for mempool pruning", () => {
  const genesis = capGenesis("zyron-oracle-expiry");
  const chain = new ZyronChain(genesis);
  const tx = settle(genesis, 0, 1, CAP);
  const isExpired = (chain as unknown as { isActivitySettlementExpired?: (t: ActivitySettlementTx) => boolean })
    .isActivitySettlementExpired?.bind(chain);
  assert.equal(typeof isExpired, "function");
  assert.equal(isExpired!(tx), false);
  finalize(chain, [], windowOf(genesis, 0));
  assert.equal(isExpired!(tx), false, "still inside its window");
  finalize(chain, [], windowOf(genesis, 1));
  assert.equal(isExpired!(tx), true, "every later block is past the window");
});

test("ORACLE-CAP: the node mempool drops a settlement once its window has closed", async () => {
  const genesis = capGenesis("zyron-oracle-prune");
  const directory = await mkdtemp(join(tmpdir(), "zyron-oracle-prune-"));
  try {
    const store = await ChainStore.open(genesis, directory);
    const service = new NodeService(store);
    const finalizeAt = async (timestampMs: number) => {
      let block = store.chain.produceBlock([], key(VALIDATOR), { timestampMs });
      block = store.chain.attestBlock(block, key(VALIDATOR));
      await service.acceptFinalizedBlock(block);
    };
    const pending = settle(genesis, 0, 1, CAP);
    service.mempool.add(pending);
    await finalizeAt(windowOf(genesis, 0));
    assert.deepEqual(service.mempool.values().map((tx) => tx.txid), [pending.txid], "kept while still includable");
    await finalizeAt(windowOf(genesis, 1));
    assert.equal(service.mempool.size, 0, "expired settlement no longer pins the pool nonce");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
