// Security finding (2026-10-13): under `launchProfile: "fixed-supply-v1"` the
// 5M ZYN ecosystem/activity-pool reserve could be moved by a plain transfer
// signed by the pool address key, bypassing the m-of-n oracle and the rolling
// 10,000 ZYN / 24 h cap. Allocation locks only covered the founder and
// permanent-liquidity accounts. Consensus now refuses every debit of the pool
// other than an authorized activity settlement, on every path (mempool
// admission, block production/validation, both state appliers used for replay).
// Genesis files without the launch profile keep the historical behaviour.
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
import { createActivityOracleApprovalV2, createActivitySettlement, createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "../src/types.js";
const ZYN = ATOMS_PER_ZYN;
const POOL = 5_000_000 * ZYN;
const BLOCKED = /Activity pool can only be debited by activity settlements/;
const key = (n) => n.toString(16).padStart(64, "0");
const pub = (n) => publicKeyFromPrivate(key(n));
const addr = (n) => addressFromPublicKey(pub(n));
const VALIDATOR = 71, ORACLE = 72, ORACLE_2 = 78, ORACLE_3 = 79, FOUNDER = 73, PUBLIC_DISTRIBUTION = 74, LIQUIDITY = 75, ECOSYSTEM = 76, MALLORY = 77;
const VALIDATOR_IDS = [VALIDATOR, 80, 81, 82];
function genesisFor(chainId, profile) {
    const genesis = {
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
        activityOraclePolicy: "threshold-v1",
        publicDistributionRelease: defaultPublicDistributionRelease(addr(PUBLIC_DISTRIBUTION)),
        launchProfile: "fixed-supply-v1"
    } : genesis;
}
function idFor(address) {
    const id = VALIDATOR_IDS.find((candidate) => addr(candidate) === address);
    if (id === undefined)
        throw new Error("unexpected validator");
    return id;
}
function finalize(chain, txs, timestampMs) {
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
    }
    else {
        for (const validator of quorum)
            block = chain.attestBlock(block, key(idFor(validator.address)));
    }
    chain.acceptBlock(block, timestampMs);
}
function chainAtVersion(genesis, version) {
    const chain = new ZyronChain(genesis);
    if (version === 1)
        return chain;
    const input = { chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101, protocolVersion: version };
    const upgrade = createProtocolUpgrade({
        ...input,
        approvals: genesis.validators.slice(0, validatorQuorumSize(genesis.validators.length)).map((validator) => createProtocolUpgradeApproval(input, key(idFor(validator.address)), validator.publicKey)),
        timestampMs: genesis.timestampMs + 10
    }, key(VALIDATOR), pub(VALIDATOR));
    for (let height = 1; height <= 100; height += 1) {
        finalize(chain, height === 1 ? [upgrade] : [], genesis.timestampMs + height * 1_000);
    }
    return chain;
}
function poolTransfer(genesis, nonce, amountAtoms, feeAtoms, txVersion) {
    return createTransfer({
        chainId: genesis.chainId, nonce, sender: genesis.activityPool, receiver: addr(MALLORY),
        amountAtoms, feeAtoms, timestampMs: genesis.timestampMs + 1
    }, key(ECOSYSTEM), pub(ECOSYSTEM), txVersion);
}
for (const version of [1, 3, 6]) {
    const txVersion = version >= 3 ? 2 : 1;
    test(`POOL-DEBIT (v${version}): a pool-key transfer is refused on admission and block production`, () => {
        const genesis = genesisFor(`zyron-pool-debit-v${version}`, true);
        const chain = chainAtVersion(genesis, version);
        const t = chain.tip.header.timestampMs + 1_000;
        for (const tx of [poolTransfer(genesis, 1, POOL, 0, txVersion), poolTransfer(genesis, 1, 1, 1, txVersion), poolTransfer(genesis, 1, 1, 0, txVersion)]) {
            assert.throws(() => chain.validatePending([tx], t), BLOCKED);
            assert.throws(() => chain.produceBlock([tx], key(idFor(expectedValidator(chain.validatorsAt(chain.height + 1), chain.height + 1, 0).address)), { timestampMs: t }), BLOCKED);
        }
        assert.equal(chain.balance(genesis.activityPool), POOL);
        assert.equal(chain.balance(addr(MALLORY)), 0);
        // Authorized settlements still pay out from the pool.
        const expiresAtMs = genesis.timestampMs + 2 * 86_400_000 - 1;
        const entries = [{ receiver: addr(MALLORY), amountAtoms: 10 * ZYN }];
        const settlement = createActivitySettlement({
            chainId: genesis.chainId, nonce: 1, sender: genesis.activityPool, epoch: 0, entries,
            receiptRoot: "00".repeat(32), timestampMs: genesis.timestampMs + 1,
            attestationExpiresAtMs: expiresAtMs,
            oracleApprovals: [createActivityOracleApprovalV2({
                    chainId: genesis.chainId, sender: genesis.activityPool, epoch: 0, entries,
                    receiptRoot: "00".repeat(32), expiresAtMs
                }, key(ORACLE_2), pub(ORACLE_2))]
        }, key(ORACLE), pub(ORACLE), txVersion);
        finalize(chain, [settlement], genesis.timestampMs + 86_400_000 + 1);
        assert.equal(chain.balance(genesis.activityPool), POOL - 10 * ZYN);
    });
    test(`POOL-DEBIT (v${version}): a genesis without the launch profile keeps the historical behaviour`, () => {
        const genesis = genesisFor(`zyron-pool-debit-legacy-v${version}`, false);
        const chain = chainAtVersion(genesis, version);
        finalize(chain, [poolTransfer(genesis, 1, ZYN, 0, txVersion)], chain.tip.header.timestampMs + 1_000);
        assert.equal(chain.balance(addr(MALLORY)), ZYN);
    });
}
test("POOL-DEBIT: both state appliers (block validation and replay) refuse a pool debit", () => {
    const genesis = genesisFor("zyron-pool-debit-appliers", true);
    const t = genesis.timestampMs + 1_000;
    const tx = poolTransfer(genesis, 1, ZYN, 0, 2);
    const ledger = LedgerState.fromGenesis(genesis);
    assert.throws(() => ledger.apply(tx, genesis.activityPool, allocationLockContext(genesis, t), genesis), BLOCKED);
    const sparse = stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot());
    assert.throws(() => applyStateV2Transaction(sparse, tx, genesis.activityPool, allocationLockContext(genesis, t), genesis), BLOCKED);
    assert.equal(ledger.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
});
