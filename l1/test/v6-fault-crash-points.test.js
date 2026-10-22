// P0-03: crash and power loss at every v6 handler step (block-proposal,
// proposal, prepare, commit, timeout) and every point inside it (consensus-
// state write before/after rename, journal append before/after fsync with the
// unflushed bytes surviving, lost or torn, and after the signature). One run
// per point at n = 4 keeps arming honest validators until every step crashed
// at least once; crashed validators restart from their directories. Each run
// checks the full invariant set of support/v6-fault.ts (no conflicting
// finality or certificates, no honest double-sign on the wire or in the
// journals, every honest signature backed by a durable journal row,
// prefix-consistent chains, bounded liveness after GST, supply).
// More seeds and n = 2, 7: ZYRON_V6_FAULT_SEEDS (see v6-fault-seeds.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { CRASH_POINTS, HANDLER_STEPS, runFault, summarizeFault } from "./support/v6-fault.js";
for (const point of CRASH_POINTS) {
    test(`P0-03 v6 crash points (n=4): ${point} at every handler step, restart, invariants hold`, { timeout: 300_000 }, async () => {
        const result = await runFault({ scenario: "power-loss", n: 4, seed: 1, chaosMs: 300_000, postGstHeights: 3, cover: { point, steps: HANDLER_STEPS } });
        const fired = new Set(result.crashes.filter((item) => item.point === point).map((item) => item.step));
        assert.deepEqual([...fired].sort(), [...HANDLER_STEPS].sort(), `steps that crashed at ${point}`);
        assert.ok(result.restarts >= HANDLER_STEPS.length, summarizeFault(result));
        assert.equal(result.honestDoubleSigns, 0);
        assert.deepEqual(result.unjournaledSignatures, []);
        assert.deepEqual(result.journalViolations, []);
        assert.equal(result.conflictingFinality, 0);
        assert.ok(result.livenessAsserted && result.livenessOk, summarizeFault(result));
        assert.ok(result.ok, summarizeFault(result));
    });
}
test("P0-03 v6 power loss tearing a lock+commit append inside the commit row: both unacknowledged rows are dropped on reopen and the validator rejoins", { timeout: 300_000 }, async () => {
    const result = await runFault({ scenario: "power-loss", n: 4, seed: 3, chaosMs: 200_000, postGstHeights: 3, steps: ["commit"], points: ["journal-unsynced-torn"], cut: 0.75 });
    const torn = result.crashes.filter((item) => item.detail.includes("torn inside the commit row"));
    assert.ok(torn.length >= 1, JSON.stringify(result.crashes));
    assert.deepEqual(result.failStops, []);
    assert.deepEqual(result.permanentFaulty, []);
    assert.ok(result.livenessAsserted && result.livenessOk, summarizeFault(result));
    assert.ok(result.ok, summarizeFault(result));
});
test("P0-03 v6 power loss persisting only the lock row of a lock+commit append: no signature was released, the network stays safe and live", { timeout: 300_000 }, async () => {
    // Current behaviour: reopen refuses the journal ("Torn protocol v6 lock/commit
    // pair") and the validator stays down (counted as faulty, at most f here).
    // Either that or a clean restart without the lock is safe, because the
    // commit signature is only released after the fsync of both rows.
    const result = await runFault({ scenario: "power-loss", n: 4, seed: 3, chaosMs: 200_000, postGstHeights: 3, steps: ["commit"], points: ["journal-unsynced-torn"], cut: "lock-row" });
    const lockOnly = result.crashes.filter((item) => item.detail.includes("lock row persisted without its commit row"));
    assert.equal(lockOnly.length, 1, JSON.stringify(result.crashes));
    for (const item of result.failStops)
        assert.match(item, /Torn protocol v6 lock\/commit pair/);
    assert.ok(result.permanentFaulty.length <= 1);
    assert.deepEqual(result.unjournaledSignatures, []);
    assert.ok(result.livenessAsserted && result.livenessOk, summarizeFault(result));
    assert.ok(result.ok, summarizeFault(result));
});
