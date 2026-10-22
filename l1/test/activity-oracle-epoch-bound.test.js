// Characterization of the activity-oracle per-epoch rule for a genesis WITHOUT
// a launch profile (independent retest, round 2, ORACLE boundary burst). There
// the cap is per closed fixed 24 h epoch: epoch e settles once, in order, only
// in a block timestamped inside epoch e + 1, so two adjacent epochs can be
// settled one millisecond apart around an epoch boundary (2 x 10,000 ZYN):
//   - any 24 h window pays at most 20,000 ZYN;
//   - any window of length W pays at most (ceil(W / 24 h) + 1) x 10,000 ZYN;
//   - the long-run average stays at most 10,000 ZYN per day.
// This is kept unchanged so existing chains do not fork. A genesis with
// `launchProfile: "fixed-supply-v1"` additionally enforces the rolling 24 h
// cap of 10,000 ZYN (activity-rolling-24h-cap.test.ts, docs/ACTIVITY_ORACLE_CAP.md).
import assert from "node:assert/strict";
import test from "node:test";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createActivitySettlement, createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import { ATOMS_PER_ZYN } from "../src/types.js";
const ZYN = ATOMS_PER_ZYN;
const EPOCH_MS = 86_400_000;
const CAP = 10_000 * ZYN;
const POOL = 5_000_000 * ZYN;
const NOT_CLOSED = /Activity epoch is not closed yet/;
const key = (n) => n.toString(16).padStart(64, "0");
const pub = (n) => publicKeyFromPrivate(key(n));
const addr = (n) => addressFromPublicKey(pub(n));
const VALIDATOR = 61;
const ORACLE = 62;
const ECOSYSTEM = 66;
const ALICE = 67;
function genesisFor(chainId) {
    return {
        chainId,
        timestampMs: 1_700_000_000_000,
        validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
        activityOracles: [pub(ORACLE)],
        activityPool: addr(ECOSYSTEM),
        allocations: [
            { address: addr(63), amountAtoms: 5_000_000 * ZYN },
            { address: addr(64), amountAtoms: 20_000_000 * ZYN },
            { address: addr(65), amountAtoms: 20_000_000 * ZYN },
            { address: addr(ECOSYSTEM), amountAtoms: POOL }
        ]
    };
}
function finalize(chain, txs, timestampMs) {
    let block = chain.produceBlock(txs, key(VALIDATOR), { timestampMs });
    if (isConsensusV6(chain.protocolVersionAt(block.header.height))) {
        block.commitRound = 0;
        block.attestations = [{
                validator: addr(VALIDATOR),
                publicKey: pub(VALIDATOR),
                signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(VALIDATOR))
            }];
    }
    else {
        block = chain.attestBlock(block, key(VALIDATOR));
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
        approvals: [createProtocolUpgradeApproval(input, key(VALIDATOR), pub(VALIDATOR))],
        timestampMs: genesis.timestampMs + 10
    }, key(VALIDATOR), pub(VALIDATOR));
    for (let height = 1; height <= 100; height += 1) {
        finalize(chain, height === 1 ? [upgrade] : [], genesis.timestampMs + height * 1_000);
    }
    return chain;
}
for (const version of [1, 6]) {
    test(`ORACLE epoch bound (v${version}): boundary burst is 2 x cap and the next epoch waits for the next boundary`, () => {
        const genesis = genesisFor(`zyron-oracle-epoch-bound-v${version}`);
        const chain = chainAtVersion(genesis, version);
        const txVersion = version >= 3 ? 2 : 1;
        const settle = (epoch, nonce) => createActivitySettlement({
            chainId: genesis.chainId, nonce, sender: genesis.activityPool, epoch,
            entries: [{ receiver: addr(ALICE), amountAtoms: CAP }],
            receiptRoot: "00".repeat(32), timestampMs: genesis.timestampMs + 1
        }, key(ORACLE), pub(ORACLE), txVersion);
        const paid = () => POOL - chain.balance(genesis.activityPool);
        const boundary = (epoch) => genesis.timestampMs + epoch * EPOCH_MS;
        // Last millisecond of epoch 1 settles epoch 0; first millisecond of epoch 2 settles epoch 1.
        const burstStart = boundary(2) - 1;
        finalize(chain, [settle(0, 1)], burstStart);
        finalize(chain, [settle(1, 2)], boundary(2));
        assert.equal(paid(), 2 * CAP, "documented worst case: two adjacent epochs one millisecond apart");
        // Epoch 2 cannot be settled anywhere inside the 24 h window opened by the burst.
        for (const t of [boundary(2) + 1, boundary(2) + EPOCH_MS / 2, boundary(3) - 1]) {
            assert.throws(() => chain.validatePending([settle(2, 3)], t), NOT_CLOSED);
            assert.throws(() => chain.produceBlock([settle(2, 3)], key(VALIDATOR), { timestampMs: t }), NOT_CLOSED);
        }
        assert.ok(boundary(3) - burstStart > EPOCH_MS, "the third payout is outside every 24 h window that holds the burst");
        // From the next boundary on the schedule continues at one epoch per day.
        finalize(chain, [settle(2, 3)], boundary(3));
        finalize(chain, [settle(3, 4)], boundary(4));
        // Window [burstStart, boundary(4)] is 2 days + 1 ms long and holds 4 settlements = (ceil(W / 24 h) + 1) x cap.
        assert.equal(paid(), 4 * CAP);
    });
}
