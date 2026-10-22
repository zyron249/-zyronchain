import { peerIdFromString } from "@libp2p/peer-id";
import { assertHex } from "./codec.js";
import { ConsensusOperationBudget } from "./consensus-operation-budget.js";
import { addressFromPublicKey } from "./crypto.js";
import { PeerInflightLimiter } from "./node.js";
import { readP2PFrameRetained, writeP2PFrame } from "./p2p-frame.js";
import { validateP2PChainIdentity } from "./p2p.js";
import { P2PPeerRateLimiter } from "./p2p-rate.js";
import { validateTransactionShape } from "./transaction.js";
import { validateBlockStructure } from "./block.js";
import { assertV6ProposalBlockIntegrity, validateTimeoutResponseShape } from "./consensus-v6.js";
export const P2P_CONSENSUS_PROTOCOL = "/zyronchain/consensus/1.0.0";
/**
 * Protocol v6 consensus (F-01, spec §10): leader-pulled prepare, commit and
 * timeout votes plus fetching a stored block for re-proposal. Finalized
 * blocks and transactions keep travelling over 1.0.0 (kinds block/transaction),
 * which also stays in use for legacy heights.
 */
export const P2P_CONSENSUS_V6_PROTOCOL = "/zyronchain/consensus/2.0.0";
const MAX_CONSENSUS_FRAME_BYTES = 2_500_000;
const P2P_CONSENSUS_TIMEOUT_MS = 8_000;
const MAX_CONFIGURED_NATIVE_PEERS = 64;
const MAX_NATIVE_GOSSIP_FANOUT = 8;
const MAX_NATIVE_GOSSIP_DEDUP = 4_096;
const MAX_NATIVE_CONSENSUS_INFLIGHT_PER_PEER = 2;
export const MAX_NATIVE_CONSENSUS_OUTBOUND_CONCURRENCY = 8;
export const MAX_NATIVE_CONSENSUS_OUTSTANDING = 32;
export const NATIVE_CONSENSUS_COLLECTION_TIMEOUT_MS = 8_000;
const MAX_CONSENSUS_CHAIN_ID_LENGTH = 128;
const nativeConsensusOperationBudget = new ConsensusOperationBudget(MAX_NATIVE_CONSENSUS_OUTSTANDING, "native consensus");
const NATIVE_CONSENSUS_REQUEST_MAX_BYTES = {
    attest: MAX_CONSENSUS_FRAME_BYTES,
    skip: 128_000,
    block: MAX_CONSENSUS_FRAME_BYTES,
    transaction: 64_000
};
const NATIVE_CONSENSUS_RESPONSE_MAX_BYTES = {
    attest: 8 * 1024,
    skip: 16 * 1024,
    block: 4 * 1024,
    transaction: 4 * 1024
};
const NATIVE_CONSENSUS_V6_REQUEST_MAX_BYTES = {
    prepare: 2_700_000, // block (<= 2.5 MB frame) + proposal + TC (<= 100 timeouts + QC)
    commit: 2_600_000, // block + QC
    timeout: 1_024,
    block: 1_024
};
const NATIVE_CONSENSUS_V6_RESPONSE_MAX_BYTES = {
    prepare: 8 * 1024,
    commit: 8 * 1024,
    timeout: 128_000, // timeout vote + highQC (spec §16.4: ~55 kB at 100 validators)
    block: 2_600_000
};
const MAX_CONSENSUS_V6_FRAME_BYTES = Math.max(...Object.values(NATIVE_CONSENSUS_V6_REQUEST_MAX_BYTES));
export function nativeConsensusV6RequestMaxBytes(kind) {
    return NATIVE_CONSENSUS_V6_REQUEST_MAX_BYTES[kind];
}
export function nativeConsensusV6ResponseMaxBytes(kind) {
    return NATIVE_CONSENSUS_V6_RESPONSE_MAX_BYTES[kind];
}
export function nativeConsensusRequestMaxBytes(kind) {
    return NATIVE_CONSENSUS_REQUEST_MAX_BYTES[kind];
}
export function nativeConsensusResponseMaxBytes(kind) {
    return NATIVE_CONSENSUS_RESPONSE_MAX_BYTES[kind];
}
/**
 * Schedules every eligible target through a bounded worker pool while sharing
 * one wall-clock deadline. Process-wide outstanding work is additionally
 * bounded; saturation skips new transport work instead of queueing waiters.
 */
export async function collectNativeConsensusBounded(targets, request, options = {}) {
    const maxConcurrency = options.maxConcurrency ?? MAX_NATIVE_CONSENSUS_OUTBOUND_CONCURRENCY;
    const timeoutMs = options.timeoutMs ?? NATIVE_CONSENSUS_COLLECTION_TIMEOUT_MS;
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1)
        throw new Error("Invalid native consensus concurrency");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
        throw new Error("Invalid native consensus collection timeout");
    if (targets.length === 0)
        return [];
    const controller = new AbortController();
    const deadlineMs = Date.now() + timeoutMs;
    const results = new Array(targets.length);
    let cursor = 0;
    let resolveDeadline;
    const deadlineReached = new Promise((resolve) => { resolveDeadline = resolve; });
    const timer = setTimeout(() => {
        controller.abort(new Error("Native consensus collection deadline exceeded"));
        resolveDeadline();
    }, timeoutMs);
    const worker = async () => {
        while (!controller.signal.aborted) {
            const index = cursor++;
            if (index >= targets.length)
                return;
            const releaseOperation = nativeConsensusOperationBudget.tryAcquire();
            if (!releaseOperation) {
                results[index] = { status: "rejected", reason: new Error("Native consensus outstanding work limit reached") };
                continue;
            }
            try {
                const value = await request(targets[index], controller.signal, deadlineMs);
                if (!controller.signal.aborted)
                    results[index] = { status: "fulfilled", value };
            }
            catch (reason) {
                results[index] = { status: "rejected", reason };
            }
            finally {
                releaseOperation();
            }
        }
    };
    try {
        const workersDone = Promise.all(Array.from({ length: Math.min(maxConcurrency, targets.length) }, () => worker()));
        await Promise.race([workersDone, deadlineReached]);
        if (controller.signal.aborted) {
            const reason = controller.signal.reason ?? new Error("Native consensus collection deadline exceeded");
            const started = Math.min(cursor, targets.length);
            for (let index = 0; index < started; index += 1) {
                if (results[index] === undefined)
                    results[index] = { status: "rejected", reason };
            }
            void workersDone.catch(() => undefined);
        }
    }
    finally {
        clearTimeout(timer);
        if (!controller.signal.aborted)
            controller.abort();
    }
    return results.filter((result) => result !== undefined);
}
/** Upper bound on operator-configured native consensus peers (F-12). */
export const MAX_NATIVE_CONSENSUS_ALLOWLIST = 256;
/**
 * Parses `--p2p-consensus-peer <PeerId>` values (finding F-12). Returns
 * undefined when none are configured (open native consensus, as before).
 */
export function parseNativeConsensusPeerAllowlist(values) {
    if (values.length === 0)
        return undefined;
    if (values.length > MAX_NATIVE_CONSENSUS_ALLOWLIST)
        throw new Error("Too many --p2p-consensus-peer values");
    const allowed = new Set();
    for (const value of values) {
        let canonical;
        try {
            canonical = peerIdFromString(value).toString();
        }
        catch {
            throw new Error("Invalid --p2p-consensus-peer PeerId");
        }
        if (canonical !== value)
            throw new Error("Invalid --p2p-consensus-peer PeerId");
        allowed.add(canonical);
    }
    return allowed;
}
function consensusPeerAllowed(options, peerId) {
    return options.consensusPeerAllowlist === undefined || options.consensusPeerAllowlist.has(peerId);
}
export async function registerP2PConsensusProtocol(node, identity, service, options = {}) {
    const local = localIdentity(identity, service.status());
    validateP2PChainIdentity(local, service.status(), node.peerId);
    const inflight = new PeerInflightLimiter(MAX_NATIVE_CONSENSUS_INFLIGHT_PER_PEER);
    const rate = new P2PPeerRateLimiter(240, 60_000);
    await node.handle(P2P_CONSENSUS_PROTOCOL, async (stream, connection) => {
        let release;
        let releaseFrame;
        try {
            if (connection.encryption !== "/noise")
                throw new Error("Native consensus requires authenticated Noise");
            const peerId = connection.remotePeer.toString();
            if (!rate.consume(peerId))
                throw new Error("Native consensus rate limit exceeded");
            release = inflight.enter(peerId);
            const retained = await readP2PFrameRetained(stream, MAX_CONSENSUS_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS);
            releaseFrame = retained.release;
            const request = parseConsensusRequest(retained.value, service.status(), connection.remotePeer);
            if (request.kind !== "transaction" && !consensusPeerAllowed(options, peerId)) {
                throw new Error("Native consensus peer is not allowlisted");
            }
            let result;
            if (request.kind === "attest")
                result = await service.attestProposal(request.block);
            else if (request.kind === "skip")
                result = await service.requestSkipVote(request.height, request.round, request.previousCertificate);
            else if (request.kind === "block") {
                await service.acceptFinalizedBlock(request.block);
                result = { accepted: true };
            }
            else {
                result = { txid: service.submitTransaction(request.transaction) };
            }
            await writeP2PFrame(stream, {
                version: 1,
                identity: local,
                kind: request.kind,
                result
            }, nativeConsensusResponseMaxBytes(request.kind), P2P_CONSENSUS_TIMEOUT_MS);
            await stream.close({ signal: AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS) });
        }
        catch (error) {
            stream.abort(error instanceof Error ? error : new Error("Native consensus protocol failure"));
        }
        finally {
            releaseFrame?.();
            release?.();
        }
    }, { maxInboundStreams: 4, maxOutboundStreams: 4 });
    // Protocol v6 (2.0.0) shares the per-peer inflight and rate limits.
    await node.handle(P2P_CONSENSUS_V6_PROTOCOL, async (stream, connection) => {
        let release;
        let releaseFrame;
        try {
            if (connection.encryption !== "/noise")
                throw new Error("Native consensus requires authenticated Noise");
            const peerId = connection.remotePeer.toString();
            // Every v6 kind is a consensus message: refuse before reading the frame.
            if (!consensusPeerAllowed(options, peerId))
                throw new Error("Native consensus peer is not allowlisted");
            if (!rate.consume(peerId))
                throw new Error("Native consensus rate limit exceeded");
            release = inflight.enter(peerId);
            const retained = await readP2PFrameRetained(stream, MAX_CONSENSUS_V6_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS);
            releaseFrame = retained.release;
            const request = parseConsensusV6Request(retained.value, service.status(), connection.remotePeer);
            let result;
            if (request.kind === "prepare")
                result = await service.v6Prepare(request.request);
            else if (request.kind === "commit")
                result = await service.v6Commit(request.request);
            else if (request.kind === "timeout")
                result = await service.v6Timeout(request.height, request.round);
            else
                result = { block: await service.v6FetchBlock(request.height, request.blockHash) };
            await writeP2PFrame(stream, {
                version: 2,
                identity: local,
                kind: request.kind,
                result
            }, nativeConsensusV6ResponseMaxBytes(request.kind), P2P_CONSENSUS_TIMEOUT_MS);
            await stream.close({ signal: AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS) });
        }
        catch (error) {
            stream.abort(error instanceof Error ? error : new Error("Native consensus protocol failure"));
        }
        finally {
            releaseFrame?.();
            release?.();
        }
    }, { maxInboundStreams: 4, maxOutboundStreams: 4 });
}
export class NativeConsensusPeerClient {
    node;
    identity;
    chain;
    gossipCursor = 0;
    blockSeen = new Set();
    transactionSeen = new Set();
    targets;
    constructor(node, targets, identity, chain) {
        this.node = node;
        this.identity = identity;
        this.chain = chain;
        this.targets = [];
        this.replaceTargets(targets);
        validateP2PChainIdentity(localIdentity(identity, chain), chain, node.peerId);
    }
    replaceTargets(targets) {
        if (targets.length > MAX_CONFIGURED_NATIVE_PEERS)
            throw new Error("Too many configured native peers");
        this.targets = [...targets];
        if (this.targets.length === 0)
            this.gossipCursor = 0;
        else
            this.gossipCursor %= this.targets.length;
    }
    async requestAttestations(block) {
        const request = {
            version: 1,
            identity: localIdentity(this.identity, this.chain),
            kind: "attest",
            block
        };
        const results = await collectNativeConsensusBounded(this.targets, (target, signal, deadlineMs) => this.request(target, request, signal, deadlineMs));
        return results.flatMap((result) => result.status === "fulfilled" && result.value.kind === "attest"
            ? [result.value.result]
            : []);
    }
    async requestRoundSkips(height, round, previousCertificate = []) {
        const request = {
            version: 1,
            identity: localIdentity(this.identity, this.chain),
            kind: "skip",
            height,
            round,
            previousCertificate
        };
        const results = await collectNativeConsensusBounded(this.targets, (target, signal, deadlineMs) => this.request(target, request, signal, deadlineMs));
        return results.flatMap((result) => result.status === "fulfilled" && result.value.kind === "skip"
            ? [result.value.result]
            : []);
    }
    async requestV6Prepare(request) {
        return this.collectV6Votes({ version: 2, identity: localIdentity(this.identity, this.chain), kind: "prepare", request });
    }
    async requestV6Commit(request) {
        return this.collectV6Votes({ version: 2, identity: localIdentity(this.identity, this.chain), kind: "commit", request });
    }
    async requestV6Timeouts(height, round) {
        const request = { version: 2, identity: localIdentity(this.identity, this.chain), kind: "timeout", height, round };
        const results = await collectNativeConsensusBounded(this.targets, (target, signal, deadlineMs) => this.requestV6(target, request, signal, deadlineMs));
        return results.flatMap((result) => result.status === "fulfilled" ? [result.value.result] : []);
    }
    /** Ask peers one at a time for a stored next-height block (the caller verifies the hash). */
    async fetchV6Block(height, blockHash) {
        const request = { version: 2, identity: localIdentity(this.identity, this.chain), kind: "block", height, blockHash };
        for (const target of this.targets) {
            try {
                const response = await this.requestV6(target, request);
                const block = response.result.block;
                if (block && block.hash === blockHash) {
                    // A peer serving the right header with another body is skipped.
                    assertV6ProposalBlockIntegrity(block, height, blockHash);
                    return block;
                }
            }
            catch {
                // try the next peer
            }
        }
        return null;
    }
    async collectV6Votes(request) {
        const results = await collectNativeConsensusBounded(this.targets, (target, signal, deadlineMs) => this.requestV6(target, request, signal, deadlineMs));
        return results.flatMap((result) => result.status === "fulfilled" ? [result.value.result] : []);
    }
    async requestV6(target, request, signal, deadlineMs) {
        const operationSignal = signal ?? AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS);
        const timeout = () => {
            if (deadlineMs === undefined)
                return P2P_CONSENSUS_TIMEOUT_MS;
            const remaining = deadlineMs - Date.now();
            if (remaining <= 0)
                throw new Error("Native consensus collection deadline exceeded");
            return Math.max(1, remaining);
        };
        timeout();
        const connection = await this.node.dial(target, { signal: operationSignal });
        if (connection.encryption !== "/noise") {
            connection.abort(new Error("Native consensus requires authenticated Noise"));
            throw new Error("Native consensus requires authenticated Noise");
        }
        timeout();
        const stream = await connection.newStream(P2P_CONSENSUS_V6_PROTOCOL, { signal: operationSignal });
        let releaseFrame;
        try {
            await writeP2PFrame(stream, request, nativeConsensusV6RequestMaxBytes(request.kind), timeout());
            const retained = await readP2PFrameRetained(stream, nativeConsensusV6ResponseMaxBytes(request.kind), timeout());
            releaseFrame = retained.release;
            const response = parseConsensusV6Response(retained.value, this.chain, connection.remotePeer, request.kind);
            await stream.close({ signal: signal ?? AbortSignal.timeout(timeout()) });
            return response;
        }
        catch (error) {
            stream.abort(error instanceof Error ? error : new Error("Native consensus protocol failure"));
            throw error;
        }
        finally {
            releaseFrame?.();
        }
    }
    async broadcastBlock(block) {
        if (!remember(this.blockSeen, block.hash))
            return;
        if (this.targets.length === 0)
            return;
        const count = Math.min(MAX_NATIVE_GOSSIP_FANOUT, this.targets.length);
        const selected = Array.from({ length: count }, (_, offset) => this.targets[(this.gossipCursor + offset) % this.targets.length]);
        this.gossipCursor = (this.gossipCursor + count) % this.targets.length;
        await Promise.allSettled(selected.map((target) => this.request(target, {
            version: 1,
            identity: localIdentity(this.identity, this.chain),
            kind: "block",
            block
        })));
    }
    async broadcastTransaction(transaction) {
        validateTransactionShape(transaction);
        if (!remember(this.transactionSeen, transaction.txid))
            return;
        await this.broadcastGossip({
            version: 1,
            identity: localIdentity(this.identity, this.chain),
            kind: "transaction",
            transaction
        });
    }
    async broadcastGossip(request) {
        if (this.targets.length === 0)
            return;
        const count = Math.min(MAX_NATIVE_GOSSIP_FANOUT, this.targets.length);
        const selected = Array.from({ length: count }, (_, offset) => this.targets[(this.gossipCursor + offset) % this.targets.length]);
        this.gossipCursor = (this.gossipCursor + count) % this.targets.length;
        await Promise.allSettled(selected.map((target) => this.request(target, request)));
    }
    async request(target, request, signal, deadlineMs) {
        const operationSignal = signal ?? AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS);
        const timeout = () => {
            if (deadlineMs === undefined)
                return P2P_CONSENSUS_TIMEOUT_MS;
            const remaining = deadlineMs - Date.now();
            if (remaining <= 0)
                throw new Error("Native consensus collection deadline exceeded");
            return Math.max(1, remaining);
        };
        timeout();
        const connection = await this.node.dial(target, { signal: operationSignal });
        if (connection.encryption !== "/noise") {
            connection.abort(new Error("Native consensus requires authenticated Noise"));
            throw new Error("Native consensus requires authenticated Noise");
        }
        timeout();
        const stream = await connection.newStream(P2P_CONSENSUS_PROTOCOL, { signal: operationSignal });
        let releaseFrame;
        try {
            await writeP2PFrame(stream, request, nativeConsensusRequestMaxBytes(request.kind), timeout());
            const retained = await readP2PFrameRetained(stream, nativeConsensusResponseMaxBytes(request.kind), timeout());
            releaseFrame = retained.release;
            const response = parseConsensusResponse(retained.value, this.chain, connection.remotePeer, request.kind);
            await stream.close({ signal: signal ?? AbortSignal.timeout(timeout()) });
            return response;
        }
        catch (error) {
            stream.abort(error instanceof Error ? error : new Error("Native consensus protocol failure"));
            throw error;
        }
        finally {
            releaseFrame?.();
        }
    }
}
function parseConsensusRequest(value, expected, remotePeer) {
    assertRecord(value, "native consensus request");
    const record = value;
    if (record.version !== 1 || typeof record.kind !== "string")
        throw new Error("Invalid native consensus request");
    const identity = validateP2PChainIdentity(record.identity, expected, remotePeer);
    if (record.kind === "attest" || record.kind === "block") {
        assertExactKeys(record, ["version", "identity", "kind", "block"], "native consensus request");
        return { version: 1, identity, kind: record.kind, block: record.block };
    }
    if (record.kind === "transaction") {
        assertExactKeys(record, ["version", "identity", "kind", "transaction"], "native consensus request");
        validateTransactionShape(record.transaction);
        return { version: 1, identity, kind: "transaction", transaction: record.transaction };
    }
    if (record.kind === "skip") {
        assertExactKeys(record, ["version", "identity", "kind", "height", "round", "previousCertificate"], "native consensus request");
        if (!Number.isSafeInteger(record.height) || Number(record.height) < 1 || !Number.isSafeInteger(record.round) || Number(record.round) < 0 ||
            !Array.isArray(record.previousCertificate) || record.previousCertificate.length > 256)
            throw new Error("Invalid native skip request");
        return {
            version: 1,
            identity,
            kind: "skip",
            height: Number(record.height),
            round: Number(record.round),
            previousCertificate: record.previousCertificate
        };
    }
    throw new Error("Unsupported native consensus request");
}
function parseConsensusV6Request(value, expected, remotePeer) {
    assertRecord(value, "native v6 consensus request");
    const record = value;
    if (record.version !== 2 || typeof record.kind !== "string" || !Object.hasOwn(NATIVE_CONSENSUS_V6_REQUEST_MAX_BYTES, record.kind)) {
        throw new Error("Invalid native v6 consensus request");
    }
    const kind = record.kind;
    // Per-kind request limits (the frame reader enforces only the largest).
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > nativeConsensusV6RequestMaxBytes(kind))
        throw new Error("Native v6 consensus request exceeds its kind limit");
    const identity = validateP2PChainIdentity(record.identity, expected, remotePeer);
    if (kind === "prepare" || kind === "commit") {
        assertExactKeys(record, ["version", "identity", "kind", "request"], "native v6 consensus request");
        assertRecord(record.request, `native v6 ${kind} request`);
        // Full validation happens in NodeService.v6Prepare / v6Commit.
        return kind === "prepare"
            ? { version: 2, identity, kind, request: record.request }
            : { version: 2, identity, kind, request: record.request };
    }
    if (kind === "timeout") {
        assertExactKeys(record, ["version", "identity", "kind", "height", "round"], "native v6 consensus request");
        if (!Number.isSafeInteger(record.height) || Number(record.height) < 1 || !Number.isSafeInteger(record.round) || Number(record.round) < 0) {
            throw new Error("Invalid native v6 timeout request");
        }
        return { version: 2, identity, kind, height: Number(record.height), round: Number(record.round) };
    }
    assertExactKeys(record, ["version", "identity", "kind", "height", "blockHash"], "native v6 consensus request");
    if (!Number.isSafeInteger(record.height) || Number(record.height) < 1 || typeof record.blockHash !== "string") {
        throw new Error("Invalid native v6 block request");
    }
    assertHex(record.blockHash, 32, "native v6 block hash");
    return { version: 2, identity, kind: "block", height: Number(record.height), blockHash: record.blockHash };
}
function parseConsensusV6Response(value, expected, remotePeer, expectedKind) {
    assertRecord(value, "native v6 consensus response");
    const record = value;
    assertExactKeys(record, ["version", "identity", "kind", "result"], "native v6 consensus response");
    if (record.version !== 2 || record.kind !== expectedKind)
        throw new Error("Invalid native v6 consensus response");
    const identity = validateP2PChainIdentity(record.identity, expected, remotePeer);
    validateConsensusV6ResponseResultShape(expectedKind, record.result);
    return { version: 2, identity, kind: expectedKind, result: record.result };
}
export function validateConsensusV6ResponseResultShape(kind, value) {
    assertRecord(value, `native v6 consensus ${kind} result`);
    if (kind === "prepare" || kind === "commit") {
        // Same shape as a legacy attestation; signatures are verified by the leader.
        validateConsensusResponseResultShape("attest", value);
        return;
    }
    if (kind === "timeout") {
        validateTimeoutResponseShape(value);
        return;
    }
    assertExactKeys(value, ["block"], "native v6 consensus block result");
    // Structure only (F-11): the caller authenticates the fetched block by hash,
    // body and proposer signature before verifying its transactions.
    if (value.block !== null)
        validateBlockStructure(value.block);
}
function parseConsensusResponse(value, expected, remotePeer, expectedKind) {
    assertRecord(value, "native consensus response");
    const record = value;
    assertExactKeys(record, ["version", "identity", "kind", "result"], "native consensus response");
    if (record.version !== 1 || record.kind !== expectedKind)
        throw new Error("Invalid native consensus response");
    const identity = validateP2PChainIdentity(record.identity, expected, remotePeer);
    validateConsensusResponseResultShape(expectedKind, record.result);
    return { version: 1, identity, kind: expectedKind, result: record.result };
}
export function validateConsensusResponseResultShape(kind, value) {
    assertRecord(value, `native consensus ${kind} result`);
    if (kind === "attest") {
        assertExactKeys(value, ["validator", "publicKey", "signature"], "native consensus attest result");
        if (typeof value.publicKey !== "string" || typeof value.signature !== "string" || typeof value.validator !== "string") {
            throw new Error("Invalid native consensus attest result");
        }
        assertHex(value.publicKey, 64, "native consensus attestation public key");
        assertHex(value.signature, 64, "native consensus attestation signature");
        if (value.validator !== addressFromPublicKey(value.publicKey))
            throw new Error("Invalid native consensus attestation validator");
        return;
    }
    if (kind === "skip") {
        assertExactKeys(value, ["validator", "publicKey", "chainId", "height", "round", "previousHash", "signature"], "native consensus skip result");
        if (typeof value.publicKey !== "string" || typeof value.signature !== "string" || typeof value.validator !== "string" ||
            typeof value.chainId !== "string" || value.chainId.length < 1 || value.chainId.length > MAX_CONSENSUS_CHAIN_ID_LENGTH ||
            !Number.isSafeInteger(value.height) || Number(value.height) < 1 ||
            !Number.isSafeInteger(value.round) || Number(value.round) < 0 || typeof value.previousHash !== "string") {
            throw new Error("Invalid native consensus skip result");
        }
        assertHex(value.publicKey, 64, "native consensus skip public key");
        assertHex(value.signature, 64, "native consensus skip signature");
        assertHex(value.previousHash, 32, "native consensus skip previous hash");
        if (value.validator !== addressFromPublicKey(value.publicKey))
            throw new Error("Invalid native consensus skip validator");
        return;
    }
    if (kind === "block") {
        assertExactKeys(value, ["accepted"], "native consensus block result");
        if (value.accepted !== true)
            throw new Error("Invalid native consensus block result");
        return;
    }
    assertExactKeys(value, ["txid"], "native consensus transaction result");
    if (typeof value.txid !== "string")
        throw new Error("Invalid native consensus transaction result");
    assertHex(value.txid, 32, "native consensus transaction txid");
}
function localIdentity(identity, chain) {
    return { version: 1, nodeId: identity.nodeId, publicKey: identity.publicKey, chainId: chain.chainId, genesisHash: chain.genesisHash };
}
function assertRecord(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Invalid ${name}`);
}
function assertExactKeys(value, keys, name) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        throw new Error(`Invalid ${name} fields`);
}
function remember(seen, id) {
    if (seen.has(id))
        return false;
    seen.add(id);
    if (seen.size > MAX_NATIVE_GOSSIP_DEDUP) {
        const oldest = seen.values().next().value;
        if (oldest)
            seen.delete(oldest);
    }
    return true;
}
