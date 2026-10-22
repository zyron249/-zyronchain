// P0-03: rollback refusal at and after the v6 activation height, and the
// operator rule "never restore a validator from an old disk/VM snapshot".
//
// A node whose next height is governed by protocol v6 must not fall back to
// v5 rules: legacy-format blocks (version-5 header, legacy finality
// attestations, no commit round) are refused at v6 heights, legacy
// attest/skip handlers refuse to sign there, and the journal refuses legacy
// rows at a height that has v6 rows. The last test is a negative control: it
// shows that restoring an old copy of a validator directory defeats the
// journal (the restored validator can sign a conflicting vote), which is why
// the operator rule exists and why such a validator counts as faulty.
import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlockAttestation, createSignedBlock, expectedValidator } from "../src/block.js";
import { roundStart } from "../src/consensus-v6.js";
import { produceFinalizedBlock } from "../src/node.js";
import { SigningJournal } from "../src/storage.js";
import { ACTIVATION_HEIGHT, MemoryNetwork, closeValidators, finalizedPrefix, finalizedPrefixSchedule, openValidator, proposerIndex, testNetwork } from "./support/consensus-harness.js";
const H = ACTIVATION_HEIGHT;
/** A fully attested legacy-format (version 5) block for the next height of `validator`'s chain. */
function legacyBlockFor(network, validator, version) {
    const chain = validator.service.store.chain;
    const height = chain.height + 1;
    const leader = expectedValidator(chain.validatorsAt(height), height, 0);
    const leaderIndex = network.publicKeys.indexOf(leader.publicKey);
    const unsigned = chain.prepareBlock([], leader.publicKey, { round: 0, timestampMs: chain.tip.header.timestampMs + 1_000 });
    const block = createSignedBlock({
        version,
        chainId: network.chainId,
        height,
        round: 0,
        previousHash: chain.tip.hash,
        timestampMs: unsigned.header.timestampMs,
        transactions: [],
        stateRoot: unsigned.header.stateRoot,
        proposerPrivateKey: network.privateKeys[leaderIndex],
        proposerPublicKey: leader.publicKey
    });
    for (let index = 0; index < network.privateKeys.length; index += 1) {
        block.attestations.push(createBlockAttestation(block, network.privateKeys[index], network.publicKeys[index]));
    }
    return block;
}
test("P0-03 rollback: a v6 node refuses legacy-format finalized blocks, legacy handlers and legacy journal rows at v6 heights", { timeout: 120_000 }, async () => {
    const network = testNetwork(4, 0xa1, "zyron-v6fault-rollback");
    const prefix = finalizedPrefix(network, 6);
    const validators = [];
    for (let index = 0; index < 4; index += 1)
        validators.push(await openValidator(network, index, prefix));
    try {
        const chain = validators[0].service.store.chain;
        assert.equal(chain.height, H - 1);
        assert.equal(chain.protocolVersionAt(H), 6);
        // The governed schedule never returns to a legacy version by itself.
        for (const height of [H, H + 1, H + 1_000, H + 1_000_000])
            assert.equal(chain.protocolVersionAt(height), 6);
        // Legacy-format blocks (v5 header, legacy finality attestations from every validator) are refused at H.
        for (const version of [5, 3, 1]) {
            const legacy = legacyBlockFor(network, validators[1], version);
            await assert.rejects(validators[1].service.acceptFinalizedBlock(structuredClone(legacy)), /Unexpected protocol version/);
            assert.equal(validators[1].service.status().height, H - 1);
            // Legacy handlers refuse to attest it or to skip a round at a v6 height.
            await assert.rejects(validators[2].service.attestProposal(structuredClone(legacy), legacy.header.timestampMs + 500), /protocol v6 heights/);
        }
        await assert.rejects(validators[2].service.requestSkipVote(H, 0, [], chain.tip.header.timestampMs + 60_000), /protocol v6/i);
        // A v6-version header certified with legacy attestations (no commit round) is refused too.
        const v6Legacy = legacyBlockFor(network, validators[1], 6);
        delete v6Legacy.commitRound;
        await assert.rejects(validators[1].service.acceptFinalizedBlock(v6Legacy), /Invalid block fields/);
        // v6 finalizes H; afterwards the node keeps refusing legacy-format blocks at H + 1.
        const memory = new MemoryNetwork(validators, () => now);
        let now = roundStart(chain.tip.header.timestampMs, 0) + 500;
        const leader = proposerIndex(network, H, 0);
        const block = await produceFinalizedBlock(validators[leader].service, memory.peersFor(leader), network.privateKeys[leader], now);
        assert.ok(block);
        assert.equal(block.header.version, 6);
        for (const validator of validators)
            if (validator.service.status().height < H)
                await validator.service.acceptFinalizedBlock(block);
        now = roundStart(block.header.timestampMs, 0) + 500;
        await assert.rejects(validators[0].service.acceptFinalizedBlock(legacyBlockFor(network, validators[0], 5)), /Unexpected protocol version/);
        assert.equal(validators[0].service.status().height, H);
        // Journal: legacy rows are refused at a height that already has v6 rows (§6.2-7).
        const journal = validators[3].journal;
        await journal.reserveV6Prepare(H + 1, 0, "ab".repeat(32), -1);
        await assert.rejects(journal.reserveAttestation(H + 1, 0, "ab".repeat(32)), /protocol v6 journal rows exist/);
        await assert.rejects(journal.reserveSkip(H + 1, 0, "cd".repeat(32)), /protocol v6 journal rows exist/);
    }
    finally {
        await closeValidators(validators);
    }
});
test("P0-03 rollback: after a v5 -> v6 schedule, every height from the activation height on stays v6 and legacy blocks stay refused", { timeout: 120_000 }, async () => {
    const A = 110;
    const network = testNetwork(4, 0xb1, "zyron-v6fault-rollback-schedule");
    const prefix = finalizedPrefixSchedule(network, [
        { protocolVersion: 5, activationHeight: ACTIVATION_HEIGHT },
        { protocolVersion: 6, activationHeight: A }
    ], A - 1);
    const validator = await openValidator(network, 0, prefix);
    try {
        const chain = validator.service.store.chain;
        assert.equal(chain.protocolVersionAt(A - 1), 5);
        for (const height of [A, A + 1, A + 100_000])
            assert.equal(chain.protocolVersionAt(height), 6);
        await assert.rejects(validator.service.acceptFinalizedBlock(legacyBlockFor(network, validator, 5)), /Unexpected protocol version/);
        assert.equal(chain.height, A - 1);
    }
    finally {
        await closeValidators([validator]);
    }
});
test("P0-03 operator rule (negative control): restoring an old copy of a validator directory defeats the journal", { timeout: 60_000 }, async () => {
    // This is why restoring a validator from an old disk or VM snapshot is
    // forbidden and counts as a faulty validator (docs/V6_SAFETY_PROOF_OBLIGATIONS.md).
    const directory = await mkdtemp(join(tmpdir(), "zyron-v6fault-restore-"));
    const backup = await mkdtemp(join(tmpdir(), "zyron-v6fault-backup-"));
    try {
        const A = "a".repeat(64);
        const B = "b".repeat(64);
        let journal = await SigningJournal.open(directory);
        journal.close();
        await cp(directory, backup, { recursive: true }); // the "old snapshot"
        journal = await SigningJournal.open(directory);
        await journal.reserveV6Prepare(200, 0, A, -1);
        await journal.reserveV6Commit(200, 0, A);
        await assert.rejects(journal.reserveV6Prepare(200, 0, B, -1), /Conflicting validator action/);
        await assert.rejects(journal.reserveV6Prepare(200, 1, B, -1), /conflicts with the validator's lock/);
        journal.close();
        // The operator restores the old copy: the lock and the prepare row are gone.
        await rm(directory, { recursive: true, force: true });
        await cp(backup, directory, { recursive: true });
        journal = await SigningJournal.open(directory);
        try {
            assert.equal(journal.v6Lock(200), null);
            await journal.reserveV6Prepare(200, 0, B, -1); // a conflicting vote is now possible: equivocation
            assert.equal(journal.v6Row(200, 0, "prepare"), B);
        }
        finally {
            journal.close();
        }
    }
    finally {
        await rm(directory, { recursive: true, force: true });
        await rm(backup, { recursive: true, force: true });
    }
});
