// P0-03 finding: after protocol v6 is scheduled or active, a quorum-approved
// protocol_upgrade back to a legacy version (v5) was accepted by mempool
// admission and by block validation, and scheduled a return to the legacy
// single-phase consensus (the F-01 split) at its activation height
// (before the fix: admitted by all 4 nodes, included at height 101,
// protocolVersionAt(301) = 5). A downgrade must be refused everywhere:
// mempool admission, block production/validation and checkpoint schedules.
// Legacy rollbacks between versions < 6 stay governed as before (l1.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { roundStart } from "../src/consensus-v6.js";
import { produceFinalizedBlock } from "../src/node.js";
import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { expectedValidator } from "../src/block.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import { ACTIVATION_HEIGHT, MemoryNetwork, closeValidators, finalizedPrefix, openValidator, proposerIndex, testNetwork } from "./support/consensus-harness.js";
test("P0-03 rollback: a governance protocol_upgrade from v6 back to v5 is refused after v6 activation", { timeout: 120_000 }, async () => {
    const H = ACTIVATION_HEIGHT;
    const network = testNetwork(4, 0xc1, "zyron-v6fault-downgrade");
    const validators = [];
    const prefix = finalizedPrefix(network, 6);
    for (let index = 0; index < 4; index += 1)
        validators.push(await openValidator(network, index, prefix));
    try {
        const chain = validators[0].service.store.chain;
        assert.equal(chain.protocolVersionAt(H), 6, "v6 is active at the test height");
        const activationHeight = H + 200;
        const proposal = { chainId: network.chainId, nonce: 2, sender: network.genesis.validators[0].address, activationHeight, protocolVersion: 5 };
        const downgrade = createProtocolUpgrade({
            ...proposal,
            approvals: network.privateKeys.map((key, index) => createProtocolUpgradeApproval(proposal, key, network.publicKeys[index], 2)),
            timestampMs: chain.tip.header.timestampMs + 10
        }, network.privateKeys[0], network.publicKeys[0], 2);
        let admitted = 0;
        for (const validator of validators) {
            try {
                validator.service.submitTransaction(structuredClone(downgrade));
                admitted += 1;
            }
            catch { /* refused */ }
        }
        let now = roundStart(chain.tip.header.timestampMs, 0) + 500;
        const memory = new MemoryNetwork(validators, () => now);
        const leader = proposerIndex(network, H, 0);
        const block = await produceFinalizedBlock(validators[leader].service, memory.peersFor(leader), network.privateKeys[leader], now);
        assert.ok(block, "height H finalizes");
        for (const validator of validators)
            if (validator.service.status().height < H)
                await validator.service.acceptFinalizedBlock(block);
        const included = block.transactions.some((tx) => tx.txid === downgrade.txid);
        now += 1;
        assert.deepEqual({ admitted, included, versionAtActivation: validators[0].service.store.chain.protocolVersionAt(activationHeight) }, { admitted: 0, included: false, versionAtActivation: 6 }, "a v6 chain must not schedule a return to legacy consensus");
    }
    finally {
        await closeValidators(validators);
    }
});
function quorumUpgrade(network, nonce, activationHeight, protocolVersion, timestampMs) {
    const proposal = { chainId: network.chainId, nonce, sender: network.genesis.validators[0].address, activationHeight, protocolVersion };
    return createProtocolUpgrade({
        ...proposal,
        approvals: network.privateKeys.map((key, index) => createProtocolUpgradeApproval(proposal, key, network.publicKeys[index])),
        timestampMs
    }, network.privateKeys[0], network.publicKeys[0]);
}
test("P0-03 rollback: a downgrade below a scheduled (not yet active) v6 is refused by admission and block production; re-scheduling v6 stays possible", () => {
    const network = testNetwork(4, 0xc5, "zyron-v6fault-downgrade-scheduled");
    const config = network.genesis;
    const chain = new ZyronChain(config);
    const commit = (transactions) => {
        const height = chain.height + 1;
        const timestampMs = config.timestampMs + (height * 1_000);
        const proposer = expectedValidator(config.validators, height, 0);
        const proposerKey = network.privateKeys[network.publicKeys.indexOf(proposer.publicKey)];
        let block = chain.produceBlock(transactions, proposerKey, { timestampMs });
        for (const key of network.privateKeys)
            block = chain.attestBlock(block, key);
        chain.acceptBlock(block, timestampMs);
    };
    commit([quorumUpgrade(network, 1, 101, 6, config.timestampMs + 10)]);
    assert.equal(chain.protocolVersionAt(100), 1);
    assert.equal(chain.protocolVersionAt(101), 6);
    for (const version of [1, 2, 3, 4, 5]) {
        const downgrade = quorumUpgrade(network, 2, 201, version, config.timestampMs + 20);
        assert.throws(() => chain.validateMempoolAdmission(downgrade), /Protocol downgrade refused/, `admission v${version}`);
        const proposerKey = network.privateKeys[network.publicKeys.indexOf(expectedValidator(config.validators, 2, 0).publicKey)];
        assert.equal(chain.selectValidPending([downgrade], 10).length, 0, `selection v${version}`);
        // A Byzantine proposer that includes it anyway: block production and
        // validation share validateAndApply, which refuses the downgrade.
        assert.throws(() => chain.produceBlock([downgrade], proposerKey, { timestampMs: config.timestampMs + 2_000 }), /Protocol downgrade refused/);
    }
    // Two upgrades in one block: v6 cannot be followed by a downgrade in the same block either.
    const sameBlock = new ZyronChain(config);
    const sameBlockKey = network.privateKeys[network.publicKeys.indexOf(expectedValidator(config.validators, 1, 0).publicKey)];
    assert.equal(sameBlock.selectValidPending([
        quorumUpgrade(network, 1, 101, 6, config.timestampMs + 10),
        quorumUpgrade(network, 2, 201, 5, config.timestampMs + 11)
    ], 10).length, 1);
    assert.throws(() => sameBlock.produceBlock([
        quorumUpgrade(network, 1, 101, 6, config.timestampMs + 10),
        quorumUpgrade(network, 2, 201, 5, config.timestampMs + 11)
    ], sameBlockKey, { timestampMs: config.timestampMs + 1_000 }), /Protocol downgrade refused/);
    // Re-scheduling v6 itself, or moving forward, is not a downgrade.
    const same = quorumUpgrade(network, 2, 201, 6, config.timestampMs + 20);
    chain.validateMempoolAdmission(same);
    commit([same]);
    assert.equal(chain.protocolVersionAt(201), 6);
});
test("P0-03 rollback: a trusted checkpoint whose protocol schedule moves back below v6 is refused", () => {
    const network = testNetwork(4, 0xc9, "zyron-v6fault-downgrade-checkpoint");
    const prefix = finalizedPrefix(network, 6);
    const chain = new ZyronChain(network.genesis);
    for (const block of prefix)
        chain.acceptBlock(block, block.header.timestampMs);
    const honest = chain.snapshot();
    const anchor = { tipHash: honest.tip.hash, snapshotSha256: sha256Hex(canonicalJson(honest)) };
    ZyronChain.fromTrustedSnapshot(network.genesis, honest, anchor);
    const altered = structuredClone(honest);
    altered.protocolSchedule.push({ activationHeight: 1_000, protocolVersion: 5 });
    assert.throws(() => ZyronChain.fromTrustedSnapshot(network.genesis, altered, { ...anchor, snapshotSha256: sha256Hex(canonicalJson(altered)) }), /downgrade from protocol v6/);
});
