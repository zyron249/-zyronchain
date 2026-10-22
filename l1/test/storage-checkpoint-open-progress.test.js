// Codex review on #1060 (P2, at 2d6fb39): ChainStore.open on a copy with a
// recovery checkpoint first loads and verifies the checkpoint, and
// ZyronChain.fromTrustedSnapshot rebuilds the complete sparse State-v2 tree from
// the snapshot in one synchronous step, before the first onBlockRecord or
// onStateV2Batch callback. The rebuild hashes a key path per account, so on a
// large state (the checkpoint file may be up to 65 MiB) it alone could outlast
// the open-testnet boot liveness window without serving health checks.
//
// Loading the checkpoint must report progress in bounded steps and yield to
// the event loop between them. What is accepted must not change.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import { ChainStore } from "../src/storage.js";
import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
const key = (n) => n.toString(16).padStart(64, "0");
const validatorOnePrivate = key(1);
const validatorTwoPrivate = key(2);
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);
const activityPool = addressFromPublicKey(publicKeyFromPrivate(key(3)));
const ACCOUNTS = 3_000;
function genesis() {
    const allocations = [{ address: activityPool, amountAtoms: 5_000_000_000 }];
    for (let i = 0; i < ACCOUNTS; i += 1)
        allocations.push({ address: addressFromPublicKey(publicKeyFromPrivate(key(1_000 + i))), amountAtoms: 1_000 });
    return {
        chainId: "zyron-checkpoint-open-progress-1",
        timestampMs: 1_700_000_000_000,
        validators: [
            { address: validatorOne, publicKey: validatorOnePublic },
            { address: validatorTwo, publicKey: validatorTwoPublic }
        ],
        activityOracles: [publicKeyFromPrivate(key(4))],
        activityPool,
        allocations
    };
}
test("ChainStore.open reports progress in bounded, yielding steps while it loads a large recovery checkpoint", { timeout: 240_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "zyron-checkpoint-open-progress-"));
    try {
        const config = genesis();
        const store = await ChainStore.open(config, directory);
        const proposal = { chainId: config.chainId, nonce: 1, sender: validatorOne, activationHeight: 101, protocolVersion: 2 };
        const upgrade = createProtocolUpgrade({
            ...proposal,
            approvals: [
                createProtocolUpgradeApproval(proposal, validatorOnePrivate, validatorOnePublic),
                createProtocolUpgradeApproval(proposal, validatorTwoPrivate, validatorTwoPublic)
            ],
            timestampMs: config.timestampMs + 1
        }, validatorOnePrivate, validatorOnePublic);
        for (let height = 1; height <= 101; height += 1) {
            const proposerKey = height % 2 === 1 ? validatorOnePrivate : validatorTwoPrivate;
            let block = store.chain.produceBlock(height === 1 ? [upgrade] : [], proposerKey, { timestampMs: config.timestampMs + height * 100 });
            block = store.chain.attestBlock(block, validatorOnePrivate);
            block = store.chain.attestBlock(block, validatorTwoPrivate);
            await store.commitFinalizedBlock(block, config.timestampMs + height * 100);
        }
        const expectedRoot = store.chain.tip.header.stateRoot;
        await store.writeRecoveryCheckpoint();
        // Every checkpoint step must come before the first block record and be
        // followed by an event-loop turn: each callback schedules a setImmediate
        // and the next callback checks that it ran.
        let steps = 0;
        let stepsBeforeFirstRecord = -1;
        let records = 0;
        let yielded = true;
        let withoutYield = 0;
        const stepMarks = [];
        let firstRecordAt = 0;
        const hooks = {
            onCheckpointStep: () => {
                stepMarks.push(performance.now());
                steps += 1;
                if (!yielded)
                    withoutYield += 1;
                yielded = false;
                setImmediate(() => { yielded = true; });
            },
            onBlockRecord: () => {
                if (records === 0) {
                    stepsBeforeFirstRecord = steps;
                    firstRecordAt = performance.now();
                }
                records += 1;
            }
        };
        const openStarted = performance.now();
        const reopened = await ChainStore.open(config, directory, hooks);
        // Until the first block record the open is (almost) only the checkpoint
        // load; no single gap between progress steps may take most of it (time
        // ratio, so independent of machine speed).
        const openPoints = [openStarted, ...stepMarks.filter((mark) => mark <= firstRecordAt), firstRecordAt];
        let openLongest = 0;
        for (let i = 1; i < openPoints.length; i += 1)
            openLongest = Math.max(openLongest, openPoints[i] - openPoints[i - 1]);
        const openShare = openLongest / (firstRecordAt - openStarted);
        t.diagnostic(`checkpoint open: ${stepsBeforeFirstRecord} steps before the first record, longest gap ${(openShare * 100).toFixed(1)}% of ${(firstRecordAt - openStarted).toFixed(0)} ms`);
        assert.ok(firstRecordAt > 0, "the open read no block record");
        assert.ok(openShare <= 0.6, `one gap between checkpoint progress steps took ${(openShare * 100).toFixed(0)}% of the open before its first block record`);
        // Bounded steps: the state rebuild may not set more than 4096 entries per step.
        const minimumSteps = Math.ceil(ACCOUNTS / 4_096) + 1;
        assert.ok(stepsBeforeFirstRecord >= minimumSteps, `loading a ${ACCOUNTS}-account recovery checkpoint reported ${stepsBeforeFirstRecord} progress step(s) before the first block record, expected at least ${minimumSteps}`);
        assert.equal(withoutYield, 0, "loading the recovery checkpoint did not yield to the event loop between steps");
        assert.ok(records >= 101, `the open read ${records} block records`);
        assert.equal(reopened.chain.height, 101);
        assert.equal(reopened.chain.tip.header.stateRoot, expectedRoot);
        assert.equal(reopened.chain.stateV2ForPersistence()?.root(), expectedRoot);
        // The stepped loader accepts and rejects exactly what the synchronous one does.
        const snapshot = store.chain.snapshot();
        const anchorFor = (value, tipHash = snapshot.tip.hash) => ({ tipHash, snapshotSha256: sha256Hex(canonicalJson(value)) });
        const sync = ZyronChain.fromTrustedSnapshot(config, snapshot, anchorFor(snapshot));
        // No single step may take most of the work: the State-v2 rebuild dominates
        // and must itself be split (time ratio, so independent of machine speed).
        const copy = structuredClone(snapshot);
        const marks = [];
        const started = performance.now();
        const stepped = await ZyronChain.fromTrustedSnapshotInSteps(config, copy, anchorFor(snapshot), () => { marks.push(performance.now()); });
        const finished = performance.now();
        const points = [started, ...marks, finished];
        let longest = 0;
        for (let i = 1; i < points.length; i += 1)
            longest = Math.max(longest, points[i] - points[i - 1]);
        const share = longest / (finished - started);
        t.diagnostic(`stepped checkpoint load: ${marks.length} steps, longest ${(share * 100).toFixed(1)}% of ${(finished - started).toFixed(0)} ms`);
        assert.ok(marks.length >= Math.ceil(ACCOUNTS / 4_096) + 1, `the stepped loader reported ${marks.length} step(s)`);
        assert.ok(share <= 0.6, `one step of the stepped checkpoint loader took ${(share * 100).toFixed(0)}% of the load (${marks.length} steps)`);
        assert.equal(stepped.height, sync.height);
        assert.equal(stepped.tip.hash, sync.tip.hash);
        assert.equal(stepped.stateV2ForPersistence()?.root(), sync.stateV2ForPersistence()?.root());
        assert.deepEqual(stepped.stateV2SemanticKeyPreimages(), sync.stateV2SemanticKeyPreimages());
        assert.equal(canonicalJson(stepped.snapshot()), canonicalJson(sync.snapshot()));
        const balanceChanged = structuredClone(snapshot);
        balanceChanged.state.accounts[0].balanceAtoms += 1;
        const cases = [
            ["digest mismatch", snapshot, { tipHash: snapshot.tip.hash, snapshotSha256: "0".repeat(64) }],
            ["tip anchor mismatch", snapshot, anchorFor(snapshot, "1".repeat(64))],
            ["state differs from the certified root", balanceChanged, anchorFor(balanceChanged)]
        ];
        for (const [label, value, anchor] of cases) {
            let syncError = "";
            try {
                ZyronChain.fromTrustedSnapshot(config, structuredClone(value), anchor);
            }
            catch (error) {
                syncError = error.message;
            }
            assert.ok(syncError, `${label}: the synchronous loader accepted it`);
            await assert.rejects(() => ZyronChain.fromTrustedSnapshotInSteps(config, structuredClone(value), anchor), (error) => {
                assert.equal(error.message, syncError, `${label}: different rejection`);
                return true;
            });
        }
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
