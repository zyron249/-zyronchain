// P0-07 follow-ups: the vesting clock and light-client behaviour.
//
// (d) Founder vesting is evaluated at the block's own timestamp, and honest
//     verifiers bound that timestamp by their local clock plus 120 s
//     (block.ts). These tests pin the boundary: a founder spend in a block
//     stamped more than 120 s ahead of the verifier's clock is refused on
//     every acceptance path, a block exactly at the bound is accepted only
//     when the spend is vested at that timestamp, and mempool admission uses
//     the node clock, never the transaction's own timestamp. The worst case
//     is therefore an unlock up to 120 s before the verifier's clock reaches
//     the vesting time (documented in docs/ALLOCATION_LOCKS.md).
//
// (c) The light client verifies finality (proposer signature plus the round
//     or commit certificate of the trusted validator set) and State-v2
//     inclusion proofs; it does not execute transactions and has no local
//     clock bound. It therefore accepts a finalized header whose block spends
//     locked founder funds if the trusted validator quorum signed it. These
//     tests document that trust assumption rather than change it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZyronChain } from "../src/chain.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { verifyLightClientStateProof, verifyNextFinalizedHeader } from "../src/light-client.js";
import { accountKey } from "../src/state-v2.js";
import { ChainStore } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN } from "../src/types.js";
const ZYN = ATOMS_PER_ZYN;
const DAY_MS = 86_400_000;
const CLIFF_MS = 365 * DAY_MS;
const FUTURE_BOUND_MS = 120_000;
const FOUNDER_ATOMS = 5_000_000 * ZYN;
const LIQUIDITY_ATOMS = 20_000_000 * ZYN;
const VESTING = /Founder allocation is still vesting/;
const FUTURE = /Block time too far in future/;
const GENESIS_MS = 1_700_000_000_000;
const CLIFF_AT = GENESIS_MS + CLIFF_MS;
const FEE = 10;
const key = (n) => n.toString(16).padStart(64, "0");
const pub = (n) => publicKeyFromPrivate(key(n));
const addr = (n) => addressFromPublicKey(pub(n));
const VALIDATOR = 0x71, ORACLE = 0x72, FOUNDER = 0x73, PUBLIC_DISTRIBUTION = 0x74, LIQUIDITY = 0x75, ECOSYSTEM = 0x76, BOB = 0x77;
function lockedGenesis(version) {
    return {
        chainId: `zyron-vesting-clock-v${version}`,
        timestampMs: GENESIS_MS,
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
    };
}
function twinGenesis(locked) {
    const { allocationLocks: _dropped, ...twin } = structuredClone(locked);
    return twin;
}
function certify(chain, block) {
    if (isConsensusV6(block.header.version)) {
        block.commitRound = 0;
        block.attestations = [{
                validator: addr(VALIDATOR),
                publicKey: pub(VALIDATOR),
                signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(VALIDATOR))
            }];
        return block;
    }
    return chain.attestBlock(block, key(VALIDATOR));
}
const txVersionFor = (protocolVersion) => (protocolVersion >= 3 ? 2 : 1);
function founderTransfer(genesis, amountAtoms, protocolVersion, timestampMs = genesis.timestampMs + 1) {
    return createTransfer({
        chainId: genesis.chainId, nonce: 1, sender: addr(FOUNDER), receiver: addr(BOB),
        amountAtoms, feeAtoms: FEE, timestampMs
    }, key(FOUNDER), pub(FOUNDER), txVersionFor(protocolVersion));
}
const fixtures = new Map();
function fixture(version) {
    const cached = fixtures.get(version);
    if (cached)
        return cached;
    const locked = lockedGenesis(version);
    const twin = twinGenesis(locked);
    const builder = new ZyronChain(locked);
    const genesisHash = builder.tip.hash;
    assert.equal(new ZyronChain(twin).tip.hash, genesisHash, "legacy twin genesis shares the chain identity");
    let upgrade;
    if (version > 1) {
        const input = { chainId: locked.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101, protocolVersion: version };
        upgrade = createProtocolUpgrade({
            ...input,
            approvals: [createProtocolUpgradeApproval(input, key(VALIDATOR), pub(VALIDATOR))],
            timestampMs: locked.timestampMs + 10
        }, key(VALIDATOR), pub(VALIDATOR));
    }
    const blocks = [];
    const target = 101;
    for (let height = 1; height <= target; height += 1) {
        const timestampMs = locked.timestampMs + height * 1_000;
        const block = certify(builder, builder.produceBlock(height === 1 && upgrade ? [upgrade] : [], key(VALIDATOR), { timestampMs }));
        builder.acceptBlock(block, timestampMs);
        blocks.push(block);
    }
    assert.equal(builder.protocolVersionAt(target + 1), version);
    const replay = (genesis) => {
        const chain = new ZyronChain(genesis);
        for (const block of blocks)
            chain.acceptBlock(structuredClone(block), block.header.timestampMs);
        return chain;
    };
    const built = {
        version, locked, twin, genesisHash, blocks, height: target,
        lockedAtTip: () => replay(locked),
        twinAtTip: () => replay(twin)
    };
    fixtures.set(version, built);
    return built;
}
/** A founder spend at `timestampMs` that is valid under the locked genesis (post-cliff, within the vested amount). */
function vestedFounderBlock(f, timestampMs) {
    const chain = f.lockedAtTip();
    const block = certify(chain, chain.produceBlock([founderTransfer(f.locked, ZYN, f.version)], key(VALIDATOR), { timestampMs }));
    // Control: valid when the verifier's clock has reached the block time.
    chain.validateFinalizedBlock(block, timestampMs);
    return block;
}
function assertUnchanged(chain, f) {
    assert.equal(chain.height, f.height);
    assert.equal(chain.tip.hash, f.blocks[f.blocks.length - 1].hash);
    assert.equal(chain.balance(addr(FOUNDER)), FOUNDER_ATOMS);
}
function anchorAtTip(f, chain) {
    return {
        version: 1,
        chainId: f.locked.chainId,
        genesisHash: f.genesisHash,
        height: chain.height,
        blockHash: chain.tip.hash,
        stateRoot: chain.tip.header.stateRoot,
        timestampMs: chain.tip.header.timestampMs,
        protocolVersion: f.version,
        validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }]
    };
}
function finalityProof(block) {
    const base = {
        header: block.header,
        hash: block.hash,
        proposerPublicKey: block.proposerPublicKey,
        signature: block.signature,
        roundCertificate: block.roundCertificate,
        attestations: block.attestations
    };
    return isConsensusV6(block.header.version)
        ? { version: 2, ...base, commitRound: block.commitRound }
        : { version: 1, ...base };
}
for (const version of [1, 5, 6]) {
    test(`v${version}: (d) a vested founder spend stamped more than 120 s ahead of the verifier clock is refused; exactly 120 s is accepted`, () => {
        const f = fixture(version);
        const blockMs = CLIFF_AT + DAY_MS;
        const block = vestedFounderBlock(f, blockMs);
        const early = f.lockedAtTip();
        assert.throws(() => early.acceptBlock(structuredClone(block), blockMs - FUTURE_BOUND_MS - 1), FUTURE);
        assert.throws(() => early.validateFinalizedBlock(structuredClone(block), blockMs - FUTURE_BOUND_MS - 1), FUTURE);
        // Far-future clock-skew attempt: same refusal, nothing moved.
        assert.throws(() => early.acceptBlock(structuredClone(block), CLIFF_AT - DAY_MS), FUTURE);
        assertUnchanged(early, f);
        const atBound = f.lockedAtTip();
        atBound.acceptBlock(structuredClone(block), blockMs - FUTURE_BOUND_MS);
        assert.equal(atBound.height, f.height + 1);
        assert.equal(atBound.balance(addr(FOUNDER)), FOUNDER_ATOMS - ZYN - FEE);
    });
    test(`v${version}: (d) the 120 s window cannot unlock a spend that is not vested at the block's own timestamp`, () => {
        const f = fixture(version);
        const tx = founderTransfer(f.locked, ZYN, version);
        // Stamped exactly at the cliff (nothing vested yet), verifier clock 120 s
        // behind: the future bound passes, the vesting rule refuses.
        const twin = f.twinAtTip();
        const atCliff = certify(twin, twin.produceBlock([tx], key(VALIDATOR), { timestampMs: CLIFF_AT }));
        twin.validateFinalizedBlock(atCliff, CLIFF_AT);
        const chain = f.lockedAtTip();
        assert.throws(() => chain.acceptBlock(structuredClone(atCliff), CLIFF_AT - FUTURE_BOUND_MS), VESTING);
        assert.throws(() => chain.acceptBlock(structuredClone(atCliff), CLIFF_AT), VESTING);
        assertUnchanged(chain, f);
        // The locked proposer cannot build it either.
        assert.throws(() => chain.produceBlock([tx], key(VALIDATOR), { timestampMs: CLIFF_AT }), VESTING);
    });
    test(`v${version}: (d) mempool admission judges vesting at the node clock, not at the transaction timestamp`, () => {
        const f = fixture(version);
        const chain = f.lockedAtTip();
        const postCliffStamped = founderTransfer(f.locked, ZYN, version, CLIFF_AT + DAY_MS);
        const nextMs = f.blocks[f.blocks.length - 1].header.timestampMs + 1_000;
        assert.throws(() => chain.validateMempoolAdmission(postCliffStamped, nextMs), VESTING);
        assert.throws(() => chain.validateMempoolAdmission(postCliffStamped, CLIFF_AT - 1), VESTING);
        assert.equal(chain.spendableBalance(addr(FOUNDER), CLIFF_AT - 1), 0);
        // Control: once the node clock is past the cliff the same transaction is admissible.
        chain.validateMempoolAdmission(postCliffStamped, CLIFF_AT + DAY_MS);
        assertUnchanged(chain, f);
    });
    test(`v${version}: (c) light client accepts a quorum-signed header whose block spends locked founder funds (documented trust assumption)`, () => {
        const f = fixture(version);
        const locked = f.lockedAtTip();
        const twin = f.twinAtTip();
        const anchor = anchorAtTip(f, locked);
        assert.equal(anchorAtTip(f, twin).blockHash, anchor.blockHash, "both genesis files share history up to H");
        const nextMs = anchor.timestampMs + 1_000;
        const premature = certify(twin, twin.produceBlock([founderTransfer(f.locked, ZYN, version)], key(VALIDATOR), { timestampMs: nextMs }));
        twin.validateFinalizedBlock(premature, nextMs);
        // A full node with the published genesis refuses it ...
        assert.throws(() => locked.acceptBlock(structuredClone(premature), nextMs), VESTING);
        // ... while the light client only checks finality against the trusted validator set.
        const advanced = verifyNextFinalizedHeader(anchor, finalityProof(premature));
        assert.equal(advanced.height, f.height + 1);
        assert.equal(advanced.blockHash, premature.hash);
        // No local clock bound either: a header stamped a year ahead verifies.
        const farFuture = certify(twin, twin.produceBlock([], key(VALIDATOR), { timestampMs: CLIFF_AT + DAY_MS }));
        assert.equal(verifyNextFinalizedHeader(anchor, finalityProof(farFuture)).timestampMs, CLIFF_AT + DAY_MS);
        assert.throws(() => locked.acceptBlock(structuredClone(farFuture), nextMs), FUTURE);
        if (version >= 2) {
            // State-v2 inclusion proofs then report the twin chain's founder balance.
            twin.acceptBlock(structuredClone(premature), nextMs);
            const state = twin.stateV2ForPersistence();
            assert.ok(state);
            const proof = state.prove(accountKey(addr(FOUNDER)));
            assert.equal(verifyLightClientStateProof(advanced, accountKey(addr(FOUNDER)), { balanceAtoms: FOUNDER_ATOMS - ZYN - FEE, nonce: 1 }, proof), true);
        }
    });
}
test("v5: (d) a durable store refuses a future-stamped founder block and keeps refusing after restart", async () => {
    const f = fixture(5);
    const blockMs = CLIFF_AT + DAY_MS;
    const block = vestedFounderBlock(f, blockMs);
    const root = await mkdtemp(join(tmpdir(), "zyron-vesting-clock-"));
    try {
        const dir = join(root, "node");
        const store = await ChainStore.open(f.locked, dir);
        for (const honest of f.blocks)
            await store.commitFinalizedBlock(structuredClone(honest), honest.header.timestampMs);
        await assert.rejects(() => store.commitFinalizedBlock(structuredClone(block), blockMs - FUTURE_BOUND_MS - 1), FUTURE);
        assertUnchanged(store.chain, f);
        const reopened = await ChainStore.open(f.locked, dir);
        assertUnchanged(reopened.chain, f);
        await assert.rejects(() => reopened.commitFinalizedBlock(structuredClone(block), blockMs - FUTURE_BOUND_MS - 1), FUTURE);
        await reopened.commitFinalizedBlock(structuredClone(block), blockMs - FUTURE_BOUND_MS);
        assert.equal(reopened.chain.balance(addr(FOUNDER)), FOUNDER_ATOMS - ZYN - FEE);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
