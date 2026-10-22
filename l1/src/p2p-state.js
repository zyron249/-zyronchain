import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { blockHash, validateBlockSelfAuthentication, validateBlockShape, validateBlockStructure, validateBlockTransactions } from "./block.js";
import { canonicalJsonDigest } from "./codec.js";
import { ZyronChain } from "./chain.js";
import { pruneDurableStateCache } from "./p2p-state-cache.js";
import { readP2PFrameRetained, writeP2PFrame } from "./p2p-frame.js";
import { P2PPeerRateLimiter } from "./p2p-rate.js";
import { validateP2PChainIdentity } from "./p2p.js";
import { createStateV2PortableBundle, MAX_PORTABLE_STATE_KEYS, MAX_PORTABLE_STATE_NODES, parsePortableStateKeyPreimage, parsePortableStateNodeRecord } from "./state-v2-portable.js";
import { discardPortableStateResumeDirectory, PortableStateResumeMismatchError, PortableStateResumeStore } from "./state-v2-resume.js";
import { StateV2AnchoredRecordStream } from "./state-v2.js";
export const P2P_STATE_PROTOCOL = "/zyronchain/state/1.0.0";
export const MAX_STATE_RECORDS_PER_CHUNK = 128;
export const MAX_STATE_KEYS_PER_CHUNK = 1_024;
const MAX_STATE_REQUEST_BYTES = 4_096;
export const MAX_STATE_RECORD_RESPONSE_BYTES = 20 * 1024 * 1024;
export const MAX_STATE_KEY_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_STATE_MANIFEST_BYTES = 2_500_000;
const P2P_STATE_TIMEOUT_MS = 8_000;
const P2P_STATE_RETRIES = 2;
const P2P_STATE_MIN_REQUEST_INTERVAL_MS = 50;
export const MAX_STATE_SYNC_PEERS = 8;
/**
 * F-09(b): cumulative bounds for one state-sync attempt against one peer.
 * Every record and key preimage is checked against the anchored state root as
 * it arrives (P1-08), so these mainly bound slow or stalling peers and wasted
 * retries; they cap the bytes and time a peer can make the client spend. An honest transfer at the protocol maxima (2,000,000 records,
 * 1,000,000 key preimages) stays well below both.
 */
export const MAX_STATE_SYNC_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_STATE_SYNC_DURATION_MS = 6 * 60 * 60 * 1000;
const STATE_SYNC_BYTE_BUDGET_MESSAGE = "State sync byte budget exceeded";
const STATE_SYNC_TIME_LIMIT_MESSAGE = "State sync time limit exceeded";
function resolveStateSyncLimits(limits = {}) {
    const maxTotalBytes = limits.maxTotalBytes ?? MAX_STATE_SYNC_TOTAL_BYTES;
    const maxDurationMs = limits.maxDurationMs ?? MAX_STATE_SYNC_DURATION_MS;
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > MAX_STATE_SYNC_TOTAL_BYTES ||
        !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > MAX_STATE_SYNC_DURATION_MS) {
        throw new Error("Invalid state sync limits");
    }
    return { maxTotalBytes, maxDurationMs };
}
export function stateResponseMaxBytes(kind) {
    if (kind === "manifest")
        return MAX_STATE_MANIFEST_BYTES;
    return kind === "records" ? MAX_STATE_RECORD_RESPONSE_BYTES : MAX_STATE_KEY_RESPONSE_BYTES;
}
/**
 * Serves independently addressable State-v2 chunks. The caller must already
 * know the exact finalized tip and canonical full-snapshot digest. Neither the
 * manifest nor a peer response is a source of checkpoint trust.
 */
export async function registerP2PStateProtocol(node, identity, service) {
    const local = localIdentity(identity, service.status());
    validateP2PChainIdentity(local, service.status(), node.peerId);
    const rate = new P2PPeerRateLimiter(1_200, 60_000);
    const cache = new Map();
    const durableCacheRoot = join(service.store.dataDir, "p2p-state-checkpoints");
    await mkdir(durableCacheRoot, { recursive: true, mode: 0o700 });
    await pruneDurableCache(durableCacheRoot, 2);
    const activeCounts = new Map();
    let selectionTail = Promise.resolve();
    const acquirePortableState = async (request) => {
        const previous = selectionTail;
        let release;
        selectionTail = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            const selected = await selectPortableState(cache, durableCacheRoot, new Set(activeCounts.keys()), service, request);
            activeCounts.set(selected.store.dataDir, (activeCounts.get(selected.store.dataDir) ?? 0) + 1);
            return selected;
        }
        finally {
            release();
        }
    };
    await node.handle(P2P_STATE_PROTOCOL, async (stream, connection) => {
        let selected;
        let releaseFrame;
        try {
            if (connection.encryption !== "/noise")
                throw new Error("State transfer requires authenticated Noise");
            if (!rate.consume(connection.remotePeer.toString()))
                throw new Error("State transfer rate limit exceeded");
            const retained = await readP2PFrameRetained(stream, MAX_STATE_REQUEST_BYTES, P2P_STATE_TIMEOUT_MS);
            releaseFrame = retained.release;
            const request = parseRequest(retained.value, service.status(), connection.remotePeer);
            selected = await acquirePortableState(request);
            const response = await responseForRequest(local, selected, request);
            await writeP2PFrame(stream, response, stateResponseMaxBytes(request.kind), P2P_STATE_TIMEOUT_MS);
            await stream.close({ signal: AbortSignal.timeout(P2P_STATE_TIMEOUT_MS) });
        }
        catch (error) {
            stream.abort(error instanceof Error ? error : new Error("State transfer failed"));
        }
        finally {
            releaseFrame?.();
            if (selected) {
                const remaining = (activeCounts.get(selected.store.dataDir) ?? 1) - 1;
                if (remaining > 0)
                    activeCounts.set(selected.store.dataDir, remaining);
                else
                    activeCounts.delete(selected.store.dataDir);
            }
        }
    }, { maxInboundStreams: 1, maxOutboundStreams: 1 });
}
/**
 * Fetches an indexed portable state under one immutable external anchor.
 * Completed chunks remain in memory while an interrupted chunk is retried;
 * every response is bound to the same authenticated Noise peer and anchor.
 */
export async function fetchTrustedPortableStateFromPeer(node, target, identity, genesis, anchor, limits) {
    return fetchTrustedPortableState(node, target, identity, genesis, anchor, undefined, limits);
}
/** Same trust model as the in-memory fetch, with crash-safe untrusted chunk staging. */
export async function fetchTrustedPortableStateResumableFromPeer(node, target, identity, genesis, anchor, resumeDir, limits) {
    if (resumeDir.length < 1)
        throw new Error("Portable state resume directory is required");
    return fetchTrustedPortableState(node, target, identity, genesis, anchor, resumeDir, limits);
}
/**
 * Tries a bounded operator-selected peer set under one immutable anchor and
 * one durable progress directory. A completed poisoned assembly is discarded;
 * the same peer gets one clean retry before failover so poison inherited from
 * an earlier partial peer cannot make an honest source fail permanently.
 */
export async function fetchTrustedPortableStateFromAnyPeer(node, targets, identity, genesis, anchor, resumeDir, limits) {
    if (targets.length < 1 || targets.length > MAX_STATE_SYNC_PEERS)
        throw new Error("Invalid portable state peer count");
    let lastError;
    for (const target of targets) {
        try {
            return await fetchTrustedPortableState(node, target, identity, genesis, anchor, resumeDir, limits);
        }
        catch (error) {
            lastError = error;
            if (!(error instanceof PortableStateAssemblyError))
                continue;
            try {
                return await fetchTrustedPortableState(node, target, identity, genesis, anchor, resumeDir, limits);
            }
            catch (retryError) {
                lastError = retryError;
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error("All portable state peers failed");
}
async function fetchTrustedPortableState(node, target, identity, genesis, anchor, resumeDir, limits) {
    assertAnchor(anchor);
    const { maxTotalBytes, maxDurationMs } = resolveStateSyncLimits(limits);
    // One deadline for the whole attempt. The timer aborts any in-flight dial,
    // stream open, write, read or close, and every await boundary below re-checks
    // the wall clock, so neither a slow nor a failing peer can extend the attempt
    // past it (round-4 PR986 residual).
    const deadline = Date.now() + maxDurationMs;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(new StateSyncLimitError(STATE_SYNC_TIME_LIMIT_MESSAGE)), maxDurationMs);
    try {
        return await fetchTrustedPortableStateWithinLimits(node, target, identity, genesis, anchor, resumeDir, { maxTotalBytes, deadline, deadlineSignal: deadlineController.signal });
    }
    finally {
        clearTimeout(deadlineTimer);
    }
}
/**
 * Settle with `operation`, or reject with the deadline error as soon as
 * `signal` aborts. A value that arrives after the deadline is handed to
 * `onLate` so retained resources (frame byte budget, streams) are released.
 */
function untilDeadline(operation, signal, onLate) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            reject(signal.reason instanceof Error ? signal.reason : new StateSyncLimitError(STATE_SYNC_TIME_LIMIT_MESSAGE));
        };
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener("abort", onAbort, { once: true });
        operation.then((value) => {
            signal.removeEventListener("abort", onAbort);
            if (settled) {
                onLate?.(value);
                return;
            }
            settled = true;
            resolve(value);
        }, (error) => {
            signal.removeEventListener("abort", onAbort);
            if (settled)
                return;
            settled = true;
            reject(error);
        });
    });
}
async function fetchTrustedPortableStateWithinLimits(node, target, identity, genesis, anchor, resumeDir, limits) {
    const { maxTotalBytes, deadline, deadlineSignal } = limits;
    const assertWithinDeadline = () => {
        if (deadlineSignal.aborted || Date.now() >= deadline)
            throw new StateSyncLimitError(STATE_SYNC_TIME_LIMIT_MESSAGE);
    };
    const operationSignal = () => AbortSignal.any([AbortSignal.timeout(P2P_STATE_TIMEOUT_MS), deadlineSignal]);
    // Cumulative body bytes received from this peer in this attempt, including
    // bytes of responses that failed to decode or validate and were retried.
    let receivedBytes = 0;
    const expectedChain = new ZyronChain(genesis);
    const expected = { chainId: genesis.chainId, genesisHash: expectedChain.genesisHash };
    const local = localIdentity(identity, expected);
    validateP2PChainIdentity(local, expected, node.peerId);
    let lastRequestAt = 0;
    const request = async (kind, start, limit) => {
        const delay = P2P_STATE_MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
        if (delay > 0)
            await untilDeadline(new Promise((resolve) => setTimeout(resolve, delay)), deadlineSignal);
        assertWithinDeadline();
        lastRequestAt = Date.now();
        let lastError;
        for (let attempt = 0; attempt <= P2P_STATE_RETRIES; attempt += 1) {
            // Never start a retry after the deadline.
            assertWithinDeadline();
            let stream;
            let releaseFrame;
            try {
                const connection = await untilDeadline(node.dial(target, { signal: operationSignal() }), deadlineSignal);
                if (connection.encryption !== "/noise") {
                    connection.abort(new Error("State transfer requires authenticated Noise"));
                    throw new Error("State transfer requires authenticated Noise");
                }
                stream = await untilDeadline(connection.newStream(P2P_STATE_PROTOCOL, { signal: operationSignal() }), deadlineSignal, (late) => late.abort(new StateSyncLimitError(STATE_SYNC_TIME_LIMIT_MESSAGE)));
                const body = {
                    version: 1, identity: local, tipHash: anchor.tipHash, snapshotSha256: anchor.snapshotSha256,
                    kind, start, limit
                };
                await untilDeadline(writeP2PFrame(stream, body, MAX_STATE_REQUEST_BYTES, P2P_STATE_TIMEOUT_MS), deadlineSignal);
                const attemptStartBytes = receivedBytes;
                const retained = await untilDeadline(readP2PFrameRetained(stream, stateResponseMaxBytes(kind), P2P_STATE_TIMEOUT_MS, undefined, {
                    // Refuse a frame whose declared length cannot fit before buffering it.
                    admit: (declared) => {
                        if (attemptStartBytes > maxTotalBytes - declared)
                            throw new StateSyncLimitError(STATE_SYNC_BYTE_BUDGET_MESSAGE);
                    },
                    // Charge bytes as they arrive, whether or not the frame later decodes.
                    record: (bytes) => {
                        receivedBytes += bytes;
                        if (receivedBytes > maxTotalBytes)
                            throw new StateSyncLimitError(STATE_SYNC_BYTE_BUDGET_MESSAGE);
                    }
                }), deadlineSignal, (late) => late.release());
                releaseFrame = retained.release;
                assertWithinDeadline();
                await untilDeadline(stream.close({ signal: operationSignal() }), deadlineSignal);
                // The close is an await boundary too: re-check before handing data on.
                assertWithinDeadline();
                const reply = { value: retained.value, remotePeer: connection.remotePeer, release: retained.release };
                releaseFrame = undefined;
                return reply;
            }
            catch (caught) {
                releaseFrame?.();
                // A deadline that passed while an operation failed for another reason
                // (for example an aborted dial) is still the deadline.
                const error = !(caught instanceof StateSyncLimitError) && (deadlineSignal.aborted || Date.now() >= deadline)
                    ? new StateSyncLimitError(STATE_SYNC_TIME_LIMIT_MESSAGE, { cause: caught })
                    : caught;
                stream?.abort(error instanceof Error ? error : new Error("State transfer failed"));
                // A spent budget or deadline is final for this attempt; never retry past it.
                if (error instanceof StateSyncLimitError)
                    throw error;
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error("State transfer failed after bounded retries");
    };
    const manifestReply = await request("manifest", 0, 1);
    const manifest = (() => {
        try {
            return parseManifest(manifestReply.value, expected, manifestReply.remotePeer, anchor);
        }
        finally {
            manifestReply.release();
        }
    })();
    const resumeManifest = resumeDir ? {
        version: 1,
        chainId: expected.chainId,
        genesisHash: expected.genesisHash,
        tipHash: anchor.tipHash,
        snapshotSha256: anchor.snapshotSha256,
        height: manifest.height,
        stateRoot: manifest.stateRoot,
        recordCount: manifest.recordCount,
        keyCount: manifest.keyCount,
        tip: manifest.tip
    } : undefined;
    let resume = resumeDir && resumeManifest ? await openResumeDiscardingPeerMismatch(resumeDir, resumeManifest) : undefined;
    // R6-1010-M1: records are fetched from the end of the post-order list (the
    // root first), so every record is checked against the anchored state root in
    // the chunk that carries it. A partial staging written in the old ascending
    // order cannot be checked that way and is discarded (untrusted download state).
    if (resume && resumeDir && resumeManifest && resume.nextRecordStart() > 0 && resume.nextRecordStart() < manifest.recordCount) {
        console.warn("Discarding ascending portable state staging; records are now staged root first");
        await discardPortableStateResumeDirectory(resumeDir);
        resume = await PortableStateResumeStore.open(resumeDir, resumeManifest);
    }
    let anchored = new StateV2AnchoredRecordStream(manifest.stateRoot);
    const acceptFromEnd = (items) => {
        for (let index = items.length - 1; index >= 0; index -= 1)
            anchored.accept(items[index]);
    };
    // Records staged by an earlier attempt came from some peer: re-check them
    // against the anchored root, from the end, before fetching more, and
    // discard the staging (untrusted download state) if they do not match.
    if (resume && resumeDir && resumeManifest) {
        try {
            const recordSuffix = resume.nextRecordSuffixStart();
            for (let end = manifest.recordCount; end > recordSuffix;) {
                const limit = Math.min(MAX_STATE_RECORDS_PER_CHUNK, end - recordSuffix);
                const staged = await resume.records(end - limit, limit);
                for (const item of staged)
                    parsePortableStateNodeRecord(item);
                acceptFromEnd(staged);
                end -= limit;
            }
        }
        catch (error) {
            console.warn(`Discarding portable state staging that does not match the anchored root (${error.message})`);
            await discardPortableStateResumeDirectory(resumeDir);
            resume = await PortableStateResumeStore.open(resumeDir, resumeManifest);
            anchored = new StateV2AnchoredRecordStream(manifest.stateRoot);
        }
    }
    const recordChunks = [];
    for (let start = resume?.nextRecordSuffixStart() ?? manifest.recordCount; start > 0;) {
        const limit = Math.min(MAX_STATE_RECORDS_PER_CHUNK, start);
        const reply = await request("records", start - limit, limit);
        try {
            const chunk = parseChunk(reply.value, expected, reply.remotePeer, anchor, "records", start - limit, limit);
            acceptFromEnd(chunk.items);
            if (resume)
                await resume.putRecordsBefore(start - limit, chunk.items);
            else
                recordChunks.push(chunk.items);
            start -= chunk.items.length;
        }
        finally {
            reply.release();
        }
    }
    anchored.finish(manifest.recordCount);
    const records = [];
    for (let index = recordChunks.length - 1; index >= 0; index -= 1)
        records.push(...recordChunks[index]);
    recordChunks.length = 0;
    // P1-08 (F-09(b) residual): the record count is authenticated by the
    // anchored stream above (no record outside the anchored tree is accepted and
    // finish() requires every one of them). The complete anchored tree also fixes
    // the key-preimage set, so a manifest key count that differs from the number
    // of anchored leaves is rejected before any key is requested, and every key
    // preimage must hash to a distinct anchored leaf key in the chunk that
    // carries it.
    const anchoredKeys = anchored.keyPreimageStream();
    if (manifest.keyCount !== anchoredKeys.total) {
        throw new Error("State manifest key count does not match the anchored state root");
    }
    const acceptKeys = (items, into) => {
        for (const item of items)
            into.accept(parsePortableStateKeyPreimage(item));
    };
    // Keys staged by an earlier attempt are untrusted download state too.
    if (resume && resume.nextKeyStart() > 0) {
        try {
            for (let start = 0; start < resume.nextKeyStart();) {
                const limit = Math.min(MAX_STATE_KEYS_PER_CHUNK, resume.nextKeyStart() - start);
                acceptKeys(await resume.keys(start, limit), anchoredKeys);
                start += limit;
            }
        }
        catch (error) {
            await resume.discard();
            throw new PortableStateAssemblyError("Staged portable state key preimages do not match the anchored state root", { cause: error });
        }
    }
    const keys = [];
    for (let start = resume?.nextKeyStart() ?? 0; start < manifest.keyCount;) {
        const limit = Math.min(MAX_STATE_KEYS_PER_CHUNK, manifest.keyCount - start);
        const reply = await request("keys", start, limit);
        try {
            const chunk = parseChunk(reply.value, expected, reply.remotePeer, anchor, "keys", start, limit);
            acceptKeys(chunk.items, anchoredKeys);
            if (resume)
                await resume.putKeys(start, chunk.items);
            else
                keys.push(...chunk.items);
            start += chunk.items.length;
        }
        finally {
            reply.release();
        }
    }
    if (!resume && (records.length !== manifest.recordCount || keys.length !== manifest.keyCount)) {
        throw new Error("State transfer chunk counts changed during transfer");
    }
    // Every anchored leaf received exactly one key preimage (P1-08).
    anchoredKeys.finish();
    const bundle = resume ? await resume.bundle() : {
        version: 1,
        root: manifest.stateRoot,
        records,
        keyPreimages: keys
    };
    try {
        ZyronChain.fromTrustedPortableState(genesis, manifest.tip, bundle, anchor);
    }
    catch (error) {
        await resume?.discard();
        throw new PortableStateAssemblyError("Portable state assembly failed anchored validation", { cause: error });
    }
    const result = { tip: structuredClone(manifest.tip), bundle: structuredClone(bundle) };
    // Success is reported only within the whole-fetch deadline; the copy above
    // is synchronous and can be long at the protocol maxima, so check after it.
    assertWithinDeadline();
    return result;
}
class PortableStateAssemblyError extends Error {
}
class StateSyncLimitError extends Error {
}
/**
 * F-09: the record/key counts in a peer manifest are only authenticated by the
 * anchored root once the records arrive (P1-08), after the staging manifest is
 * written. A staging directory left by an earlier peer whose counts disagree
 * with this peer's (same anchored checkpoint) is untrusted download state, so
 * it is discarded and restarted instead of blocking every later peer. A
 * staging directory for a different checkpoint stays fatal.
 */
async function openResumeDiscardingPeerMismatch(resumeDir, manifest) {
    try {
        return await PortableStateResumeStore.open(resumeDir, manifest);
    }
    catch (error) {
        if (!(error instanceof PortableStateResumeMismatchError))
            throw error;
        console.warn(`Discarding untrusted portable state staging (${error.message}); restarting the download`);
        await discardPortableStateResumeDirectory(resumeDir);
        return PortableStateResumeStore.open(resumeDir, manifest);
    }
}
async function selectPortableState(cache, durableCacheRoot, activePaths, service, request) {
    const cached = cache.get(request.tipHash);
    if (cached) {
        if (cached.snapshotSha256 !== request.snapshotSha256)
            throw new Error("Requested State-v2 digest is unavailable");
        return cached;
    }
    const expected = service.status();
    const durablePath = portableCachePath(durableCacheRoot, request.tipHash, request.snapshotSha256);
    let reusableCurrentStore;
    try {
        const store = await PortableStateResumeStore.openExisting(durablePath, {
            chainId: expected.chainId,
            genesisHash: expected.genesisHash,
            tipHash: request.tipHash,
            snapshotSha256: request.snapshotSha256
        });
        if (store.complete()) {
            const selected = cachedStateFromStore(store);
            rememberPortableState(cache, selected);
            try {
                await pruneDurableCache(durableCacheRoot, 2, new Set([
                    ...activePaths,
                    ...[...cache.values()].map((entry) => entry.store.dataDir)
                ]));
            }
            catch (error) {
                cache.delete(selected.tipHash);
                throw error;
            }
            return selected;
        }
        if (request.tipHash !== expected.tipHash)
            throw new Error("Historical durable State-v2 serving checkpoint is incomplete");
        reusableCurrentStore = store;
    }
    catch (error) {
        if (!isMissingFile(error) && request.tipHash !== expected.tipHash)
            throw error;
        if (request.tipHash === expected.tipHash && !isMissingFile(error)) {
            if (activePaths.has(durablePath))
                throw error;
            await rm(durablePath, { recursive: true, force: true });
        }
    }
    const status = service.status();
    if (request.tipHash !== status.tipHash)
        throw new Error("Requested State-v2 tip is not locally finalized or durably cached");
    const snapshot = service.store.chain.snapshot();
    const snapshotSha256 = canonicalJsonDigest(snapshot).sha256;
    if (snapshotSha256 !== request.snapshotSha256)
        throw new Error("Requested State-v2 digest is unavailable");
    const state = service.store.chain.stateV2ForPersistence();
    if (!state)
        throw new Error("State transfer requires active State v2");
    const bundle = createStateV2PortableBundle(state, snapshot.state, {
        validatorSchedule: snapshot.validatorSchedule,
        protocolSchedule: snapshot.protocolSchedule,
        ...(snapshot.version === 2 ? { activityOracleGovernance: snapshot.activityOracleGovernance } : {})
    });
    const manifest = {
        version: 1, chainId: status.chainId, genesisHash: status.genesisHash,
        tipHash: snapshot.tip.hash, snapshotSha256, height: snapshot.height,
        stateRoot: bundle.root, recordCount: bundle.records.length,
        keyCount: bundle.keyPreimages.length, tip: structuredClone(snapshot.tip)
    };
    const store = reusableCurrentStore ?? await PortableStateResumeStore.open(durablePath, manifest);
    for (let start = store.nextRecordStart(); start < bundle.records.length;) {
        const items = bundle.records.slice(start, start + MAX_STATE_RECORDS_PER_CHUNK);
        await store.putRecords(start, items);
        start += items.length;
    }
    for (let start = store.nextKeyStart(); start < bundle.keyPreimages.length;) {
        const items = bundle.keyPreimages.slice(start, start + MAX_STATE_KEYS_PER_CHUNK);
        await store.putKeys(start, items);
        start += items.length;
    }
    const selected = cachedStateFromStore(store);
    rememberPortableState(cache, selected);
    try {
        await pruneDurableCache(durableCacheRoot, 2, new Set([
            ...activePaths,
            ...[...cache.values()].map((entry) => entry.store.dataDir)
        ]));
    }
    catch (error) {
        cache.delete(selected.tipHash);
        throw error;
    }
    return selected;
}
async function responseForRequest(identity, state, request) {
    if (request.kind === "manifest") {
        return {
            version: 1, identity, tipHash: state.tipHash, snapshotSha256: state.snapshotSha256,
            height: state.height, stateRoot: state.stateRoot, recordCount: state.recordCount,
            keyCount: state.keyCount, tip: structuredClone(state.tip)
        };
    }
    const total = request.kind === "records" ? state.recordCount : state.keyCount;
    if (request.start >= total || request.start + request.limit > total)
        throw new Error("State chunk range exceeds manifest bounds");
    const items = request.kind === "records"
        ? await state.store.records(request.start, request.limit)
        : await state.store.keys(request.start, request.limit);
    return {
        version: 1, identity, tipHash: state.tipHash, snapshotSha256: state.snapshotSha256,
        kind: request.kind, start: request.start, items
    };
}
function cachedStateFromStore(store) {
    const manifest = store.manifest;
    validateBlockShape(manifest.tip);
    if (manifest.tip.hash !== manifest.tipHash || manifest.tip.header.height !== manifest.height ||
        manifest.tip.header.stateRoot !== manifest.stateRoot)
        throw new Error("Durable State-v2 serving manifest is inconsistent");
    return {
        tipHash: manifest.tipHash,
        snapshotSha256: manifest.snapshotSha256,
        height: manifest.height,
        tip: structuredClone(manifest.tip),
        stateRoot: manifest.stateRoot,
        recordCount: manifest.recordCount,
        keyCount: manifest.keyCount,
        store
    };
}
function rememberPortableState(cache, selected) {
    if (!cache.has(selected.tipHash) && cache.size >= 2)
        cache.delete(cache.keys().next().value);
    cache.set(selected.tipHash, selected);
}
function portableCachePath(root, tipHash, snapshotSha256) {
    return join(root, `${tipHash}-${snapshotSha256}`);
}
async function pruneDurableCache(root, keep, protectedPaths = new Set()) {
    await pruneDurableStateCache(root, keep, protectedPaths);
}
function isMissingFile(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function parseRequest(value, expected, remotePeer) {
    assertExactRecord(value, ["version", "identity", "tipHash", "snapshotSha256", "kind", "start", "limit"], "state request");
    if (value.version !== 1 || !isHash(value.tipHash) || !isHash(value.snapshotSha256) ||
        (value.kind !== "manifest" && value.kind !== "records" && value.kind !== "keys") ||
        !Number.isSafeInteger(value.start) || Number(value.start) < 0 ||
        !Number.isSafeInteger(value.limit) || Number(value.limit) < 1)
        throw new Error("Invalid state request");
    const kind = value.kind;
    const start = Number(value.start);
    const limit = Number(value.limit);
    if (kind === "manifest" ? (start !== 0 || limit !== 1) :
        kind === "records" ? (start >= MAX_PORTABLE_STATE_NODES || limit > MAX_STATE_RECORDS_PER_CHUNK) :
            (start >= MAX_PORTABLE_STATE_KEYS || limit > MAX_STATE_KEYS_PER_CHUNK))
        throw new Error("Invalid state request bounds");
    return {
        version: 1,
        identity: validateP2PChainIdentity(value.identity, expected, remotePeer),
        tipHash: value.tipHash,
        snapshotSha256: value.snapshotSha256,
        kind, start, limit
    };
}
function parseManifest(value, expected, remotePeer, anchor) {
    assertExactRecord(value, ["version", "identity", "tipHash", "snapshotSha256", "height", "stateRoot", "recordCount", "keyCount", "tip"], "state manifest");
    if (value.version !== 1 || value.tipHash !== anchor.tipHash || value.snapshotSha256 !== anchor.snapshotSha256 ||
        !Number.isSafeInteger(value.height) || Number(value.height) < 1 || !isHash(value.stateRoot) ||
        !Number.isSafeInteger(value.recordCount) || Number(value.recordCount) < 1 || Number(value.recordCount) > MAX_PORTABLE_STATE_NODES ||
        !Number.isSafeInteger(value.keyCount) || Number(value.keyCount) < 1 || Number(value.keyCount) > MAX_PORTABLE_STATE_KEYS) {
        throw new Error("Invalid state manifest");
    }
    const identity = validateP2PChainIdentity(value.identity, expected, remotePeer);
    if (!value.tip || typeof value.tip !== "object" || Array.isArray(value.tip))
        throw new Error("Invalid state manifest tip");
    const candidate = value.tip;
    const header = candidate.header;
    if (!header || typeof header !== "object" || Array.isArray(header))
        throw new Error("Invalid state manifest tip");
    const headerRecord = header;
    // Cheap checks first (round 3): the header must hash to the anchored tip hash,
    // which binds height and state root to the operator's anchor before anything
    // is staged (F-09). Only a tip that matches the anchor gets the full block
    // validation, which verifies every transaction signature.
    if (candidate.hash !== anchor.tipHash || blockHash(header) !== anchor.tipHash ||
        headerRecord.height !== Number(value.height) || headerRecord.stateRoot !== value.stateRoot) {
        throw new Error("State manifest tip does not match anchored metadata");
    }
    // Round-4 PR980: then the O(1) body binding and proposer signature, before
    // the per-transaction signatures and long before any record is requested.
    validateBlockStructure(value.tip);
    validateBlockSelfAuthentication(value.tip);
    validateBlockTransactions(value.tip);
    const tip = value.tip;
    return {
        version: 1, identity, tipHash: value.tipHash, snapshotSha256: value.snapshotSha256,
        height: Number(value.height), stateRoot: value.stateRoot, recordCount: Number(value.recordCount),
        keyCount: Number(value.keyCount), tip: structuredClone(tip)
    };
}
function parseChunk(value, expected, remotePeer, anchor, kind, start, limit) {
    assertExactRecord(value, ["version", "identity", "tipHash", "snapshotSha256", "kind", "start", "items"], "state chunk");
    if (value.version !== 1 || value.tipHash !== anchor.tipHash || value.snapshotSha256 !== anchor.snapshotSha256 ||
        value.kind !== kind || value.start !== start || !Array.isArray(value.items) || value.items.length !== limit) {
        throw new Error("Invalid state chunk");
    }
    const identity = validateP2PChainIdentity(value.identity, expected, remotePeer);
    // F-09(b): reject invalid items in the chunk that carries them instead of
    // after the whole claimed transfer (bounded per chunk by the frame limit).
    // Validation only: the retained decoded items are passed on without a copy.
    for (const item of value.items) {
        if (kind === "records")
            parsePortableStateNodeRecord(item);
        else
            parsePortableStateKeyPreimage(item);
    }
    return {
        version: 1, identity, tipHash: value.tipHash,
        snapshotSha256: value.snapshotSha256, kind, start, items: value.items
    };
}
function localIdentity(identity, chain) {
    return { version: 1, nodeId: identity.nodeId, publicKey: identity.publicKey, chainId: chain.chainId, genesisHash: chain.genesisHash };
}
function assertAnchor(anchor) {
    if (!isHash(anchor.tipHash) || !isHash(anchor.snapshotSha256))
        throw new Error("Invalid trusted checkpoint anchor");
}
function isHash(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function assertExactRecord(value, keys, name) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Invalid ${name}`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        throw new Error(`Invalid ${name} fields`);
}
