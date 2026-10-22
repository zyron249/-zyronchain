// P0-03: prolonged outage, then recovery through the v6 snapshot path
// (public API: ChainStore.installTrustedSnapshot with an external anchor),
// then the recovered validator takes part in v6 consensus again.
//
// Enabled after NEW-R1 / #963: v6 trusted-snapshot tips are verified with the
// commit certificate. The block-sync recovery path remains covered by the
// prolonged-outage-sync scenario (v6-fault-scenarios.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { ChainStore } from "../src/storage.js";
import { closeValidators, finalizedPrefix, openValidator, testNetwork } from "./support/consensus-harness.js";
import { V6Sim } from "./support/v6-sim.js";
// NEW-R1 / #963 is on main (v6 trusted-snapshot tips use commit certificates), so this path runs.
test("P0-03 v6 state sync: a validator offline for many heights recovers from an anchored v6 snapshot and finalizes again (n=4)", {
    timeout: 300_000
}, async () => {
    const network = testNetwork(4, 0xd1, "zyron-v6fault-state-sync");
    const prefix = finalizedPrefix(network, 6);
    const validators = [];
    for (let index = 0; index < 4; index += 1)
        validators.push(await openValidator(network, index, prefix));
    const tip = validators[0].service.store.chain.tip.header.timestampMs;
    const sim = new V6Sim({ network, prefix, validators, seed: 7, startMs: tip });
    const installedDirectory = await mkdtemp(join(tmpdir(), "zyron-v6fault-installed-"));
    await rm(installedDirectory, { recursive: true, force: true });
    let recovered;
    try {
        const victim = 3;
        sim.crash(victim);
        for (let index = 0; index < 3; index += 1)
            sim.startAt(index, tip + index * 1_000);
        const outageTarget = prefix.length + 12;
        await sim.run(tip + 3_600_000, () => sim.height(0) >= outageTarget);
        assert.ok(sim.height(0) >= outageTarget, "three validators keep finalizing during the outage");
        assert.equal(sim.height(victim), prefix.length);
        // Snapshot from a healthy peer, anchored out of band (tip hash + digest).
        const snapshot = sim.validators[0].service.store.chain.snapshot();
        const anchor = { tipHash: snapshot.tip.hash, snapshotSha256: sha256Hex(canonicalJson(snapshot)) };
        const store = await ChainStore.installTrustedSnapshot(network.genesis, installedDirectory, snapshot, anchor);
        assert.equal(store.chain.tip.hash, anchor.tipHash);
        recovered = await openValidator(network, victim, [], installedDirectory);
        await closeValidators([sim.validators[victim]]);
        sim.validators[victim] = recovered;
        sim.memory.online[victim] = true;
        sim.startAt(victim, sim.time.nowMs);
        const target = sim.height(0) + 4;
        await sim.run(sim.time.nowMs + 3_600_000, () => sim.validators.every((_, index) => sim.height(index) >= target));
        sim.stopAll();
        for (let index = 0; index < 4; index += 1)
            assert.ok(sim.height(index) >= target, `v${index} at ${sim.height(index)}`);
        assert.deepEqual((await sim.assertNoConflictingFinality(snapshot.height + 1)).conflicts, []);
        assert.equal(sim.ledger.conflicts().length, 0);
        assert.ok(sim.finality.some((item) => item.height > snapshot.height && item.leader === victim) ||
            sim.ledger.signedBy(network.publicKeys[victim]).some((item) => item.height > snapshot.height), "the recovered validator signed v6 votes again");
    }
    finally {
        sim.stopAll();
        await closeValidators(sim.validators);
        await rm(installedDirectory, { recursive: true, force: true });
    }
});
