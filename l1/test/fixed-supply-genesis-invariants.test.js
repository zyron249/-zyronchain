// Owner decision: ZyronChain mining is retired and the full 50,000,000 ZYN
// supply is allocated at genesis. These regressions pin three invariants on
// top of protocol v6:
//   (a) a mining_claim is rejected under every supported protocol version
//       (1, 2, 3, 5, 6) on every consensus path; v4 is unsupported entirely;
//   (b) a fully allocated genesis holds exactly 50M ZYN and total supply never
//       grows afterwards (fees are burned, a valid proof of work mints nothing);
//   (c) the activity pool is outflow-only, so cumulative airdrops are capped by
//       its genesis allocation (5M ZYN for the fixed-supply plan).
// The file deliberately uses only APIs that predate the fixed-supply change so
// it fails on the pre-change code base (mining live from v5, pool refillable).
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockAttestation, createSignedBlock, validateBlockShape } from "../src/block.js";
import { ZyronChain, SUPPORTED_PROTOCOL_VERSIONS } from "../src/chain.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { Mempool } from "../src/mempool.js";
import { INITIAL_MINING_REWARD_ATOMS, meetsMiningDifficulty, miningWorkHash } from "../src/mining.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import { createActivitySettlement, createMiningClaim, createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer, validateTransactionShape } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "../src/types.js";
const RETIRED = /Mining is retired/;
const POOL_INFLOW = /Activity pool cannot receive funds/;
const key = (n) => n.toString(16).padStart(64, "0");
const pub = (n) => publicKeyFromPrivate(key(n));
const addr = (n) => addressFromPublicKey(pub(n));
const VALIDATOR = 91;
const ORACLE = 92;
const MINER = 93;
const FOUNDER = 94;
const PUBLIC_DISTRIBUTION = 95;
const LIQUIDITY = 96;
const ECOSYSTEM = 97; // also the activity pool
const ALICE = 98;
const ZYN = ATOMS_PER_ZYN;
/** 10/40/40/10 split of exactly 50M ZYN (placeholder test keys only). */
function fixedSupplyGenesis(chainId) {
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
        ]
    };
}
/** A genesis that leaves 40M ZYN unallocated: the old mining budget. */
function partialGenesis(chainId) {
    const base = fixedSupplyGenesis(chainId);
    return { ...base, allocations: [{ address: addr(FOUNDER), amountAtoms: 10_000_000 * ZYN }, { address: addr(ECOSYSTEM), amountAtoms: 0 }] };
}
function finalize(chain, txs, timestampMs) {
    let block = chain.produceBlock(txs, key(VALIDATOR), { timestampMs });
    block = chain.attestBlock(block, key(VALIDATOR));
    chain.acceptBlock(block, timestampMs);
}
/** Finalize heights 1..100 with protocol `version` scheduled from height 101. */
function chainAtVersion(genesis, version) {
    const chain = new ZyronChain(genesis);
    if (version === 1)
        return chain;
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
/** Solve a genuine 20-bit proof so a rejection cannot be blamed on bad work. */
function solvedClaim(chain, genesis, rewardAtoms) {
    const work = {
        chainId: genesis.chainId,
        nonce: chain.nonce(addr(MINER)) + 1,
        sender: addr(MINER),
        height: chain.height + 1,
        previousHash: chain.tip.hash,
        rewardAtoms,
        workNonce: "0000000000000000",
        publicKey: pub(MINER)
    };
    for (let counter = 0; counter < 20_000_000; counter += 1) {
        const workNonce = counter.toString(16).padStart(16, "0");
        if (meetsMiningDifficulty(miningWorkHash({ ...work, workNonce }))) {
            return createMiningClaim({
                chainId: work.chainId,
                nonce: work.nonce,
                sender: work.sender,
                height: work.height,
                previousHash: work.previousHash,
                rewardAtoms,
                workNonce,
                timestampMs: chain.tip.header.timestampMs + 1
            }, key(MINER), pub(MINER));
        }
    }
    throw new Error("bounded proof-of-work search did not solve");
}
function unsolvedClaim(chain, genesis) {
    return createMiningClaim({
        chainId: genesis.chainId,
        nonce: 1,
        sender: addr(MINER),
        height: chain.height + 1,
        previousHash: chain.tip.hash,
        rewardAtoms: INITIAL_MINING_REWARD_ATOMS,
        workNonce: "0000000000000000",
        timestampMs: chain.tip.header.timestampMs + 1
    }, key(MINER), pub(MINER));
}
test("FIXED-SUPPLY (a): protocol v4 stays unsupported and the supported set is exactly 1, 2, 3, 5, 6", () => {
    assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS].sort(), [1, 2, 3, 5, 6]);
});
for (const version of [1, 2, 3, 5, 6]) {
    test(`FIXED-SUPPLY (a): mining_claim is rejected under protocol v${version} on every consensus path`, () => {
        const genesis = partialGenesis(`zyron-retired-mining-v${version}`);
        const chain = chainAtVersion(genesis, version);
        const claim = unsolvedClaim(chain, genesis);
        const supplyBefore = chain.totalSupplyAtoms();
        const heightBefore = chain.height;
        const blockTime = chain.tip.header.timestampMs + 100;
        // Gossip, RPC submission and block decoding all start with shape validation.
        assert.throws(() => validateTransactionShape(claim), RETIRED);
        // Mempool: the node-level pool and chain admission.
        assert.throws(() => new Mempool().add(claim), RETIRED);
        assert.throws(() => chain.validateMempoolAdmission(claim), RETIRED);
        // Block production and pending validation.
        assert.throws(() => chain.validatePending([claim]), RETIRED);
        assert.deepEqual(chain.selectValidPending([claim], 10), []);
        assert.throws(() => chain.produceBlock([claim], key(VALIDATOR), { timestampMs: blockTime }), RETIRED);
        // Raw state appliers, reached without any shape validation.
        assert.throws(() => LedgerState.fromGenesis(genesis).apply(claim, genesis.activityPool), RETIRED);
        assert.throws(() => applyStateV2Transaction(stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot()), claim, genesis.activityPool), RETIRED);
        // A validator-signed, attested block that smuggles the claim in.
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
        assert.throws(() => validateBlockShape(smuggled), RETIRED);
        assert.throws(() => chain.validateProposal(smuggled, blockTime), RETIRED);
        // Give the block a genuine finality certificate for its protocol, so the
        // only remaining reason to refuse it is the claim itself (finality and
        // proposer checks run before transaction checks, finding F-11).
        if (isConsensusV6(version)) {
            smuggled.commitRound = 0;
            smuggled.attestations = [{
                    validator: addr(VALIDATOR),
                    publicKey: pub(VALIDATOR),
                    signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(smuggled.header.chainId, smuggled.header.height, 0, smuggled.hash), key(VALIDATOR))
                }];
        }
        else {
            smuggled.attestations.push(createBlockAttestation(smuggled, key(VALIDATOR), pub(VALIDATOR)));
        }
        assert.throws(() => chain.acceptBlock(smuggled, blockTime), RETIRED);
        assert.equal(chain.height, heightBefore);
        assert.equal(chain.totalSupplyAtoms(), supplyBefore);
        assert.equal(chain.balance(addr(MINER)), 0);
    });
}
test("FIXED-SUPPLY (b): a fully allocated genesis holds exactly 50M ZYN and supply never grows", () => {
    const genesis = fixedSupplyGenesis("zyron-fixed-supply-invariant");
    const sum = genesis.allocations.reduce((total, allocation) => total + allocation.amountAtoms, 0);
    assert.equal(sum, MAX_SUPPLY_ATOMS);
    assert.equal(MAX_SUPPLY_ATOMS, 50_000_000 * ZYN);
    const chain = new ZyronChain(genesis);
    assert.equal(chain.genesisSupplyAtoms(), MAX_SUPPLY_ATOMS);
    assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
    // Ordinary activity only moves or burns supply.
    let burned = 0;
    let previous = chain.totalSupplyAtoms();
    for (let index = 1; index <= 5; index += 1) {
        const fee = index * 1_000;
        const transfer = createTransfer({
            chainId: genesis.chainId, nonce: index, sender: addr(PUBLIC_DISTRIBUTION), receiver: addr(ALICE),
            amountAtoms: index * ZYN, feeAtoms: fee, timestampMs: genesis.timestampMs + index * 1_000 - 1
        }, key(PUBLIC_DISTRIBUTION), pub(PUBLIC_DISTRIBUTION));
        finalize(chain, [transfer], genesis.timestampMs + index * 1_000);
        burned += fee;
        const now = chain.totalSupplyAtoms();
        assert.ok(now <= previous, "total supply grew");
        assert.equal(now, MAX_SUPPLY_ATOMS - burned);
        previous = now;
    }
});
test("FIXED-SUPPLY (b): a genuine proof of work after v5/v6 activation mints nothing, even with unallocated headroom", { timeout: 120_000 }, () => {
    for (const version of [5, 6]) {
        const genesis = partialGenesis(`zyron-no-mint-v${version}`);
        const chain = chainAtVersion(genesis, version);
        const supply = chain.totalSupplyAtoms();
        assert.ok(supply < MAX_SUPPLY_ATOMS);
        const claim = solvedClaim(chain, genesis, INITIAL_MINING_REWARD_ATOMS);
        assert.throws(() => chain.validateMempoolAdmission(claim), RETIRED);
        assert.throws(() => chain.validatePending([claim]), RETIRED);
        assert.equal(chain.totalSupplyAtoms(), supply);
        assert.equal(chain.balance(addr(MINER)), 0);
        assert.equal(chain.nextMiningRewardAtoms(), 0);
    }
});
test("FIXED-SUPPLY (c): the activity pool is outflow-only and cumulative airdrops stop at its 5M allocation", () => {
    const genesis = fixedSupplyGenesis("zyron-pool-outflow-only");
    const chain = new ZyronChain(genesis);
    const pool = genesis.activityPool;
    assert.equal(chain.balance(pool), 5_000_000 * ZYN);
    const refill = createTransfer({
        chainId: genesis.chainId, nonce: 1, sender: addr(LIQUIDITY), receiver: pool,
        amountAtoms: 1 * ZYN, feeAtoms: 0, timestampMs: genesis.timestampMs + 1
    }, key(LIQUIDITY), pub(LIQUIDITY));
    assert.throws(() => chain.validateMempoolAdmission(refill), POOL_INFLOW);
    assert.throws(() => chain.validatePending([refill]), POOL_INFLOW);
    assert.throws(() => LedgerState.fromGenesis(genesis).apply(refill, pool), POOL_INFLOW);
    assert.throws(() => applyStateV2Transaction(stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot()), refill, pool), POOL_INFLOW);
    const settle = (epoch, nonce, amountAtoms, receiver = addr(ALICE)) => createActivitySettlement({
        chainId: genesis.chainId, nonce, sender: pool, epoch, entries: [{ receiver, amountAtoms }],
        receiptRoot: "00".repeat(32), timestampMs: genesis.timestampMs + epoch * 1_000 + 1
    }, key(ORACLE), pub(ORACLE));
    // A settlement cannot route funds back into the pool either.
    // (Evaluated inside epoch 0's settlement window, the day after genesis.)
    assert.throws(() => chain.validatePending([settle(0, 1, 1, pool)], genesis.timestampMs + 86_400_000 + 60_000), POOL_INFLOW);
    // ZC-CRY-20260930-010: one settlement can no longer move the whole pool;
    // the pool drains only through >= 500 capped (10,000 ZYN) closed 24 h epochs.
    const EPOCH_MS = 86_400_000;
    const CAP = 10_000 * ZYN;
    const windowOf = (epoch) => genesis.timestampMs + (epoch + 1) * EPOCH_MS + 60_000;
    assert.throws(() => finalize(chain, [settle(0, 1, 5_000_000 * ZYN)], windowOf(0)), /per-epoch activity cap/);
    const epochs = (5_000_000 * ZYN) / CAP;
    for (let epoch = 0; epoch < epochs; epoch += 1)
        finalize(chain, [settle(epoch, epoch + 1, CAP)], windowOf(epoch));
    assert.equal(chain.balance(pool), 0);
    assert.equal(chain.balance(addr(ALICE)), 5_000_000 * ZYN);
    assert.throws(() => chain.validatePending([settle(epochs, epochs + 1, 1)], windowOf(epochs)), /Activity pool exhausted/);
    assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
});
