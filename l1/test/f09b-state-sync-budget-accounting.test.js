// F-09(b) residual (independent retest, round 4 on #986): the cumulative
// state-sync byte budget and the whole-fetch deadline must hold on every path.
// - Body bytes of failed, rejected or retried responses count toward the
//   budget, not only bytes of frames that decoded successfully.
// - The deadline interrupts an in-flight read and no retry starts after it.
// - The deadline is checked again after the final stream close and before the
//   transfer is reported as successful.
//
// The peer is a transport double only: production serialization, the frame
// reader, manifest/chunk parsing, signature validation and the final anchored
// assembly all run unmodified.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { fetchTrustedPortableStateFromPeer, MAX_STATE_MANIFEST_BYTES, MAX_STATE_SYNC_DURATION_MS } from "../src/p2p-state.js";
import { createP2PNode } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createStateV2PortableBundle } from "../src/state-v2-portable.js";
import { ChainStore } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
const validatorPrivate = "21".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validator = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("22".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("23".padStart(64, "0")));
function genesis() {
    return {
        chainId: "zyron-portable-state-p2p-1",
        timestampMs: 1_700_000_000_000,
        validators: [{ address: validator, publicKey: validatorPublic }],
        activityOracles: [oraclePublic],
        activityPool,
        allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
    };
}
async function advanceToStateV2(store) {
    const config = genesis();
    const proposal = { chainId: config.chainId, nonce: 1, sender: validator, activationHeight: 101, protocolVersion: 2 };
    const upgrade = createProtocolUpgrade({
        ...proposal,
        approvals: [createProtocolUpgradeApproval(proposal, validatorPrivate, validatorPublic)],
        timestampMs: config.timestampMs + 1
    }, validatorPrivate, validatorPublic);
    for (let height = 1; height <= 101; height += 1) {
        let block = store.chain.produceBlock(height === 1 ? [upgrade] : [], validatorPrivate, {
            timestampMs: config.timestampMs + (height * 100)
        });
        block = store.chain.attestBlock(block, validatorPrivate);
        await store.commitFinalizedBlock(block, config.timestampMs + (height * 100));
    }
}
let fixture;
before(async () => {
    const root = await mkdtemp(join(tmpdir(), "zyron-p2p-state-budget-"));
    const config = genesis();
    const store = await ChainStore.open(config, join(root, "source"));
    await advanceToStateV2(store);
    const snapshot = store.chain.snapshot();
    const state = store.chain.stateV2ForPersistence();
    assert.ok(state);
    const sourceIdentity = await loadOrCreateNodeIdentity(join(root, "source"));
    const clientIdentity = await loadOrCreateNodeIdentity(join(root, "client"));
    fixture = {
        root, config, store,
        anchor: { tipHash: snapshot.tip.hash, snapshotSha256: sha256Hex(canonicalJson(snapshot)) },
        tip: snapshot.tip,
        bundle: createStateV2PortableBundle(state, snapshot.state, {
            validatorSchedule: snapshot.validatorSchedule,
            protocolSchedule: snapshot.protocolSchedule
        }),
        sourceIdentity, clientIdentity,
        sourceNode: await createP2PNode(sourceIdentity),
        clientNode: await createP2PNode(clientIdentity)
    };
});
after(async () => {
    if (!fixture)
        return;
    await Promise.allSettled([fixture.sourceNode.stop(), fixture.clientNode.stop()]);
    await rm(fixture.root, { recursive: true, force: true });
});
function peerIdentity() {
    return {
        version: 1,
        nodeId: fixture.sourceIdentity.nodeId,
        publicKey: fixture.sourceIdentity.publicKey,
        chainId: fixture.config.chainId,
        genesisHash: fixture.store.chain.genesisHash
    };
}
function honestResponse(request) {
    const common = {
        version: 1, identity: peerIdentity(), tipHash: fixture.anchor.tipHash, snapshotSha256: fixture.anchor.snapshotSha256
    };
    if (request.kind === "manifest") {
        return {
            ...common, height: fixture.tip.header.height, stateRoot: fixture.bundle.root,
            recordCount: fixture.bundle.records.length, keyCount: fixture.bundle.keyPreimages.length, tip: fixture.tip
        };
    }
    const source = request.kind === "records" ? fixture.bundle.records : fixture.bundle.keyPreimages;
    return { ...common, kind: request.kind, start: request.start, items: source.slice(request.start, request.start + request.limit) };
}
function transport(hooks = {}) {
    const stats = { requests: [], bodyBytes: 0 };
    const node = {
        peerId: fixture.clientNode.peerId,
        async dial() {
            return {
                encryption: "/noise",
                remotePeer: fixture.sourceNode.peerId,
                abort() { },
                async newStream() {
                    const sent = [];
                    let request;
                    let closes = 0;
                    let aborted;
                    return {
                        inactivityTimeout: 0,
                        send(bytes) { sent.push(Buffer.from(bytes)); return true; },
                        async onDrain() { },
                        async close() {
                            closes += 1;
                            if (closes === 1) {
                                request = JSON.parse(Buffer.concat(sent).subarray(4).toString("utf8"));
                                stats.requests.push(request);
                            }
                            await hooks.close?.(request, closes);
                        },
                        abort(error) { aborted = error; },
                        async *[Symbol.asyncIterator]() {
                            await hooks.beforeRead?.(request);
                            if (aborted)
                                throw aborted;
                            let body = Buffer.from(JSON.stringify(honestResponse(request)), "utf8");
                            body = hooks.body?.(body, request) ?? body;
                            const header = Buffer.alloc(4);
                            header.writeUInt32BE(body.length, 0);
                            const chunks = hooks.chunks?.(header, body, request);
                            if (chunks) {
                                for (const chunk of chunks)
                                    yield chunk;
                                return;
                            }
                            yield header;
                            stats.bodyBytes += body.length;
                            yield body;
                        }
                    };
                }
            };
        }
    };
    return {
        stats,
        fetch: (limits) => fetchTrustedPortableStateFromPeer(node, "fixture", fixture.clientIdentity, fixture.config, fixture.anchor, limits)
    };
}
test("state sync budget: an honest transfer succeeds at the exact cumulative body-byte boundary", async () => {
    const first = transport();
    const expected = await first.fetch();
    const second = transport();
    const actual = await second.fetch({ maxTotalBytes: first.stats.bodyBytes });
    assert.deepEqual(actual, expected);
    assert.equal(actual.tip.hash, fixture.anchor.tipHash);
    assert.equal(actual.bundle.root, fixture.bundle.root);
});
test("state sync budget: valid chunks that cumulatively exceed the budget stop without retry", async () => {
    const baseline = transport();
    await baseline.fetch();
    const probe = transport();
    await assert.rejects(() => probe.fetch({ maxTotalBytes: baseline.stats.bodyBytes - 1 }), /State sync byte budget exceeded/);
    assert.equal(probe.stats.requests.length, baseline.stats.requests.length);
});
test("round-4 PR986: body bytes of failed frames count toward the transfer byte budget", async () => {
    const baseline = transport();
    await baseline.fetch();
    const limit = baseline.stats.bodyBytes;
    const attempts = new Map();
    // Every request is answered with two complete, bounded, invalid-JSON bodies
    // before the honest response, so the real frame reader receives and scans
    // all of those body bytes before failing and retrying.
    const probe = transport({
        body(body, request) {
            const key = `${request.kind}:${request.start}`;
            const attempt = (attempts.get(key) ?? 0) + 1;
            attempts.set(key, attempt);
            if (attempt < 3) {
                const corrupt = Buffer.from(body);
                corrupt[0] = 0x21;
                return corrupt;
            }
            return body;
        }
    });
    await assert.rejects(() => probe.fetch({ maxTotalBytes: limit }), /State sync byte budget exceeded/);
    assert.ok(probe.stats.requests.length < 3 * baseline.stats.requests.length, "the client must stop once the budget is spent instead of completing every retry");
});
test("round-4 PR986: the overall deadline interrupts a failed read and prevents retries after expiry", async () => {
    const probe = transport({
        async beforeRead() {
            await sleep(120);
            throw new Error("fixture interrupted response");
        }
    });
    const started = performance.now();
    await assert.rejects(() => probe.fetch({ maxDurationMs: 20 }), /State sync time limit exceeded/);
    const elapsed = performance.now() - started;
    assert.equal(probe.stats.requests.length, 1, "no request may be retried after the overall deadline");
    assert.ok(elapsed < 100, `the deadline must cancel the in-flight read (elapsed ${Math.round(elapsed)} ms)`);
});
test("round-4 PR986: the whole-fetch deadline is checked after the final close and before success", async () => {
    // Advance the wall clock at the final await boundary; no production function is replaced.
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
        const probe = transport({
            close(request, closes) {
                if (request.kind === "keys" && closes === 2)
                    offset = MAX_STATE_SYNC_DURATION_MS + 1_000;
            }
        });
        await assert.rejects(() => probe.fetch(), /State sync time limit exceeded/);
    }
    finally {
        Date.now = realNow;
    }
});
test("round-4 PR986 follow-up: oversized transport chunks count toward the transfer byte budget", async () => {
    const baseline = transport();
    await baseline.fetch();
    const limit = baseline.stats.bodyBytes;
    const attempts = new Map();
    // The first two answers to every request are one transport chunk larger
    // than the frame envelope, which the frame reader rejects outright; the
    // third answer is honest. The rejected bytes were still received.
    const probe = transport({
        chunks(header, body, request) {
            const key = `${request.kind}:${request.start}`;
            const attempt = (attempts.get(key) ?? 0) + 1;
            attempts.set(key, attempt);
            if (attempt >= 3)
                return undefined;
            const oversized = Buffer.alloc(MAX_STATE_MANIFEST_BYTES + 5, 0x20);
            header.copy(oversized, 0);
            return [oversized];
        }
    });
    await assert.rejects(() => probe.fetch({ maxTotalBytes: limit }), /State sync byte budget exceeded/);
    assert.equal(probe.stats.requests.length, 1, "the first oversized response already exceeds the budget");
});
test("round-4 PR986 follow-up: the deadline is checked after the result is copied", async () => {
    // Advance the wall clock while the final result is copied (a synchronous
    // step that can be long at the protocol maxima); no production function is replaced.
    const realNow = Date.now;
    const realClone = globalThis.structuredClone;
    let offset = 0;
    Date.now = () => realNow() + offset;
    globalThis.structuredClone = ((value, options) => {
        const copy = realClone(value, options);
        if (value && typeof value === "object" && "keyPreimages" in value)
            offset = MAX_STATE_SYNC_DURATION_MS + 1_000;
        return copy;
    });
    try {
        await assert.rejects(() => transport().fetch(), /State sync time limit exceeded/);
    }
    finally {
        Date.now = realNow;
        globalThis.structuredClone = realClone;
    }
});
