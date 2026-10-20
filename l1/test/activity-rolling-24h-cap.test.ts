// Under `launchProfile: "fixed-supply-v1"` the rolling window uses the
// threshold-v1 cap (default 1,000 ZYN): settlements whose block timestamps lie
// within any 24 h window never sum to more than that cap. Genesis files without
// a launch profile keep the historical 10,000 ZYN per-epoch rule, so two
// adjacent epochs can still pay 20,000 ZYN around a boundary
// (activity-oracle-epoch-bound.test.ts). Supply and allocations do not change.
import assert from "node:assert/strict";
import test from "node:test";

import { expectedValidator, validatorQuorumSize } from "../src/block.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { defaultPublicDistributionRelease } from "../src/public-distribution-release.js";
import { allocationLockContext } from "../src/allocation-locks.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import { PUBLIC_LAUNCH_ACTIVITY_CAP_ATOMS } from "../src/activity.js";
import {
  createActivityOracleApprovalV2,
  createActivitySettlement,
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer
} from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type ActivitySettlementTx, type Address, type GenesisConfig } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const EPOCH_MS = 86_400_000;
const LEGACY_CAP = 10_000 * ZYN;
const LAUNCH_CAP = PUBLIC_LAUNCH_ACTIVITY_CAP_ATOMS;
const POOL = 5_000_000 * ZYN;
const ROLLING = /rolling 24-hour/;
const RESERVED = /protocol-reserved/;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 61;
const VALIDATOR_IDS = [VALIDATOR, 80, 81, 82];
const ORACLE = 62;
const ORACLE_2 = 68;
const ORACLE_3 = 69;
const FOUNDER = 63;
const PUBLIC_DISTRIBUTION = 64;
const LIQUIDITY = 65;
const ECOSYSTEM = 66;
const ALICE = 67;
const WINDOW_TIME = `ZYN${"0".repeat(39)}1` as Address;
const WINDOW_AMOUNT = `ZYN${"0".repeat(39)}2` as Address;

function genesisFor(chainId: string, profile: boolean): GenesisConfig {
  const genesis: GenesisConfig = {
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
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) }
  };
  return profile ? {
    ...genesis,
    validators: VALIDATOR_IDS.map((id) => ({ address: addr(id), publicKey: pub(id) })),
    activityOracles: [pub(ORACLE), pub(ORACLE_2), pub(ORACLE_3)],
    activityOracleThreshold: 2,
    activityOraclePolicy: "threshold-v1" as const,
    publicDistributionRelease: defaultPublicDistributionRelease(addr(PUBLIC_DISTRIBUTION)),
    launchProfile: "fixed-supply-v1" as const
  } : genesis;
}

function idFor(address: string): number {
  const id = VALIDATOR_IDS.find((candidate) => addr(candidate) === address);
  if (id === undefined) throw new Error("unexpected validator");
  return id;
}

function proposerKey(chain: ZyronChain): string {
  const height = chain.height + 1;
  return key(idFor(expectedValidator(chain.validatorsAt(height), height, 0).address));
}

function finalize(chain: ZyronChain, txs: Parameters<ZyronChain["produceBlock"]>[0], timestampMs: number): void {
  const height = chain.height + 1;
  const validators = chain.validatorsAt(height);
  let block = chain.produceBlock(txs, proposerKey(chain), { timestampMs });
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

function chainAtVersion(genesis: GenesisConfig, version: number): ZyronChain {
  const chain = new ZyronChain(genesis);
  if (version === 1) return chain;
  const input = { chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101, protocolVersion: version };
  const upgrade = createProtocolUpgrade({
    ...input,
    approvals: genesis.validators.slice(0, validatorQuorumSize(genesis.validators.length)).map((validator) =>
      createProtocolUpgradeApproval(input, key(idFor(validator.address)), validator.publicKey)),
    timestampMs: genesis.timestampMs + 10
  }, key(VALIDATOR), pub(VALIDATOR));
  for (let height = 1; height <= 100; height += 1) {
    finalize(chain, height === 1 ? [upgrade] : [], genesis.timestampMs + height * 1_000);
  }
  assert.equal(chain.protocolVersionAt(chain.height + 1), version);
  return chain;
}

const boundary = (genesis: GenesisConfig, epoch: number) => genesis.timestampMs + epoch * EPOCH_MS;

function settlement(genesis: GenesisConfig, epoch: number, nonce: number, amountAtoms: number, txVersion: 1 | 2): ActivitySettlementTx {
  const entries = [{ receiver: addr(ALICE), amountAtoms }];
  const expiresAtMs = genesis.activityOraclePolicy === "threshold-v1"
    ? genesis.timestampMs + (epoch + 2) * EPOCH_MS - 1
    : undefined;
  return createActivitySettlement({
    chainId: genesis.chainId, nonce, sender: genesis.activityPool, epoch, entries,
    receiptRoot: "00".repeat(32), timestampMs: genesis.timestampMs + 1,
    ...(expiresAtMs === undefined ? {} : {
      attestationExpiresAtMs: expiresAtMs,
      oracleApprovals: [createActivityOracleApprovalV2({
        chainId: genesis.chainId, sender: genesis.activityPool, epoch, entries,
        receiptRoot: "00".repeat(32), expiresAtMs
      }, key(ORACLE_2), pub(ORACLE_2))]
    })
  }, key(ORACLE), pub(ORACLE), txVersion);
}

function totalSupply(chain: ZyronChain, genesis: GenesisConfig): number {
  return [addr(FOUNDER), addr(PUBLIC_DISTRIBUTION), addr(LIQUIDITY), genesis.activityPool, addr(ALICE)]
    .reduce((sum, address) => sum + chain.balance(address), 0);
}

for (const version of [1, 3, 6]) {
  const txVersion = version >= 3 ? 2 : 1;

  test(`ROLLING-24H (v${version}): a boundary burst of two full epochs is rejected on every path`, () => {
    const genesis = genesisFor(`zyron-rolling-burst-v${version}`, true);
    const chain = chainAtVersion(genesis, version);
    finalize(chain, [settlement(genesis, 0, 1, LAUNCH_CAP, txVersion)], boundary(genesis, 2) - 1);
    const second = settlement(genesis, 1, 2, 1, txVersion);
    for (const t of [boundary(genesis, 2), boundary(genesis, 2) + EPOCH_MS / 2, boundary(genesis, 3) - 2]) {
      assert.throws(() => chain.validatePending([second], t), ROLLING, `admission at +${t - boundary(genesis, 2)} ms`);
      assert.throws(() => chain.produceBlock([second], proposerKey(chain), { timestampMs: t }), ROLLING);
    }
    assert.equal(POOL - chain.balance(genesis.activityPool), LAUNCH_CAP);
    assert.equal(totalSupply(chain, genesis), MAX_SUPPLY_ATOMS);
  });

  test(`ROLLING-24H (v${version}): adjacent epochs share the launch cap inside 24 h and a full epoch is allowed once 24 h have passed`, () => {
    const genesis = genesisFor(`zyron-rolling-share-v${version}`, true);
    const chain = chainAtVersion(genesis, version);
    const first = boundary(genesis, 2) - 1;
    finalize(chain, [settlement(genesis, 0, 1, 600 * ZYN, txVersion)], first);
    assert.throws(() => chain.validatePending([settlement(genesis, 1, 2, 400 * ZYN + 1, txVersion)], boundary(genesis, 2)), ROLLING);
    finalize(chain, [settlement(genesis, 1, 2, 400 * ZYN, txVersion)], boundary(genesis, 2));
    // Epoch 2 is settleable from boundary(3); the previous payout (epoch 1, 400 ZYN)
    // was at boundary(2), exactly 24 h earlier, so a full epoch is allowed again.
    // Settle it one minute later so that the next epoch opens less than 24 h after it.
    finalize(chain, [settlement(genesis, 2, 3, LAUNCH_CAP, txVersion)], boundary(genesis, 3) + 60_000);
    // Epoch 3 opens at boundary(4), 23 h 59 min after the full payout: nothing is left.
    assert.throws(() => chain.validatePending([settlement(genesis, 3, 4, 1, txVersion)], boundary(genesis, 4)), ROLLING);
    assert.throws(() => chain.produceBlock([settlement(genesis, 3, 4, 1, txVersion)], proposerKey(chain), { timestampMs: boundary(genesis, 4) }), ROLLING);
    // Epoch 3 is forfeited; epoch 4 opens more than 24 h after the full payout.
    finalize(chain, [settlement(genesis, 4, 4, LAUNCH_CAP, txVersion)], boundary(genesis, 5));
    assert.equal(POOL - chain.balance(genesis.activityPool), 600 * ZYN + 400 * ZYN + 2 * LAUNCH_CAP);
    assert.equal(totalSupply(chain, genesis), MAX_SUPPLY_ATOMS);
  });

  test(`ROLLING-24H (v${version}): a genesis without a launch profile keeps the per-epoch rule`, () => {
    const genesis = genesisFor(`zyron-rolling-legacy-v${version}`, false);
    const chain = chainAtVersion(genesis, version);
    finalize(chain, [settlement(genesis, 0, 1, LEGACY_CAP, txVersion)], boundary(genesis, 2) - 1);
    finalize(chain, [settlement(genesis, 1, 2, LEGACY_CAP, txVersion)], boundary(genesis, 2));
    assert.equal(POOL - chain.balance(genesis.activityPool), 2 * LEGACY_CAP);
    assert.equal(chain.balance(WINDOW_TIME), 0);
  });
}

test("ROLLING-24H: both state appliers enforce the window from the block timestamp", () => {
  const genesis = genesisFor("zyron-rolling-appliers", true);
  const first = settlement(genesis, 0, 1, LAUNCH_CAP, 2);
  const second = settlement(genesis, 1, 2, 1, 2);
  const t1 = boundary(genesis, 2) - 1;
  const t2 = boundary(genesis, 2);
  const ledger = LedgerState.fromGenesis(genesis);
  ledger.apply(first, genesis.activityPool, allocationLockContext(genesis, t1), genesis);
  assert.throws(() => ledger.clone().apply(second, genesis.activityPool, allocationLockContext(genesis, t2), genesis), ROLLING);
  let sparse = stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot());
  sparse = applyStateV2Transaction(sparse, first, genesis.activityPool, allocationLockContext(genesis, t1), genesis);
  assert.throws(() => applyStateV2Transaction(sparse, second, genesis.activityPool, allocationLockContext(genesis, t2), genesis), ROLLING);
  // The window record is part of the committed state (both representations agree).
  assert.equal(ledger.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
  assert.equal(stateV2FromLedgerSnapshot(ledger.snapshot()).root(), sparse.root());
});

test("ROLLING-24H: the window-record addresses are protocol-reserved under the launch profile", () => {
  const genesis = genesisFor("zyron-rolling-reserved", true);
  const chain = new ZyronChain(genesis);
  const t = genesis.timestampMs + 1_000;
  for (const receiver of [WINDOW_TIME, WINDOW_AMOUNT]) {
    const transfer = createTransfer({
      chainId: genesis.chainId, nonce: 1, sender: addr(PUBLIC_DISTRIBUTION), receiver,
      amountAtoms: ZYN, feeAtoms: 0, timestampMs: genesis.timestampMs + 1
    }, key(PUBLIC_DISTRIBUTION), pub(PUBLIC_DISTRIBUTION));
    assert.throws(() => chain.validatePending([transfer], t), RESERVED);
    assert.throws(() => chain.produceBlock([transfer], proposerKey(chain), { timestampMs: t }), RESERVED);
  }
  for (const address of [WINDOW_TIME, WINDOW_AMOUNT]) {
    const bad = genesisFor("zyron-rolling-reserved-genesis", true);
    bad.allocations = bad.allocations.map((allocation) =>
      allocation.address === addr(PUBLIC_DISTRIBUTION) ? { ...allocation, address } : allocation);
    assert.throws(() => new ZyronChain(bad));
  }
});

for (const version of [1, 3]) {
  test(`ROLLING-24H (v${version}): the window record survives a node restart`, async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ChainStore } = await import("../src/storage.js");
    const { NodeService } = await import("../src/node.js");
    const genesis = genesisFor(`zyron-rolling-restart-v${version}`, true);
    const txVersion = version >= 3 ? 2 : 1;
    const directory = await mkdtemp(join(tmpdir(), "zyron-rolling-restart-"));
    try {
      const store = await ChainStore.open(genesis, directory);
      const service = new NodeService(store);
      const finalizeAt = async (txs: Parameters<ZyronChain["produceBlock"]>[0], timestampMs: number) => {
        const height = store.chain.height + 1;
        const validators = store.chain.validatorsAt(height);
        let block = store.chain.produceBlock(txs, proposerKey(store.chain), { timestampMs });
        for (const validator of validators.slice(0, validatorQuorumSize(validators.length))) {
          block = store.chain.attestBlock(block, key(idFor(validator.address)));
        }
        await service.acceptFinalizedBlock(block);
      };
      if (version !== 1) {
        const input = { chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101, protocolVersion: version };
        const upgrade = createProtocolUpgrade({
          ...input,
          approvals: genesis.validators.slice(0, validatorQuorumSize(genesis.validators.length)).map((validator) =>
            createProtocolUpgradeApproval(input, key(idFor(validator.address)), validator.publicKey)),
          timestampMs: genesis.timestampMs + 10
        }, key(VALIDATOR), pub(VALIDATOR));
        for (let height = 1; height <= 100; height += 1) {
          await finalizeAt(height === 1 ? [upgrade] : [], genesis.timestampMs + height * 1_000);
        }
      }
      await finalizeAt([settlement(genesis, 0, 1, LAUNCH_CAP, txVersion)], boundary(genesis, 2) - 1);
      const reopened = await ChainStore.open(genesis, directory);
      {
        assert.equal(reopened.chain.protocolVersionAt(reopened.chain.height + 1), version);
        assert.throws(() => reopened.chain.validatePending([settlement(genesis, 1, 2, 1, txVersion)], boundary(genesis, 2)), ROLLING);
        reopened.chain.validatePending([settlement(genesis, 1, 2, LAUNCH_CAP, txVersion)], boundary(genesis, 3) - 1);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
