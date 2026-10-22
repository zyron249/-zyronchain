import { createReadStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson, sha256Hex } from "./codec.js";
import { readBoundedRegularControlFile } from "./control-file.js";
import { readBoundedFileBuffer } from "./bounded-file.js";
import { assertBoundedCheckpointJsonStructure } from "./checkpoint-json-complexity.js";
import { assertSigningJournalJsonComplexity } from "./signing-journal-json-complexity.js";
import { ZyronChain } from "./chain.js";
import { ConsensusStateStore } from "./consensus-state-store.js";
import { V6_MAX_ROUND, safeVote } from "./consensus-v6.js";
import { StateV2DiskStore } from "./state-v2-store.js";
import { SparseMerkleState, stateV2TransactionKeyPreimages } from "./state-v2.js";
const STORE_VERSION = 1;
const MAX_STORED_BLOCK_LINE_BYTES = 2_500_000;
const MAX_SIGNING_LINE_BYTES = 1_024;
export const MAX_RECOVERY_CHECKPOINT_FILE_BYTES = 65 * 1024 * 1024;
/** v2 and v3 carry an explicit retained-history boundary (and may describe a pruned log). */
function hasRetainedLayout(checkpoint) {
    return checkpoint.version === 2 || checkpoint.version === 3;
}
const SHA256_HEX = /^[0-9a-f]{64}$/;
/**
 * Finding F-10: a power loss or host crash during an append can leave a torn
 * trailing record (no terminating newline, not parsable). Appends are fsynced
 * before their effect is acknowledged (a journal reservation before its
 * signature is released, a block line before the block is applied), so such a
 * record was never acknowledged and is safe to drop. Only the unterminated
 * final record qualifies; a terminated corrupt line, or corruption before the
 * tail, stays fatal.
 */
function isTornTrailingRecord(record) {
    if (record.terminated)
        return false;
    try {
        JSON.parse(record.text);
        return false;
    }
    catch {
        return true;
    }
}
/** Truncate an append log to `length` bytes durably and log what was dropped. */
async function truncateTornTail(path, length, droppedBytes, label) {
    const handle = await open(path, "r+");
    try {
        await handle.truncate(length);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await syncDirectory(dirname(path));
    console.warn(`Dropped a torn trailing ${label} record (${droppedBytes} bytes, never acknowledged) at byte ${length} of ${path}`);
}
async function repairSigningJournalTail(path) {
    let offset = 0;
    let previous;
    let last;
    try {
        for await (const record of readLines(path, MAX_SIGNING_LINE_BYTES, "Corrupt signing journal")) {
            if (record.text.trim()) {
                if (last)
                    previous = { start: last.start, text: last.record.text };
                last = { start: offset, record };
            }
            offset += record.serializedBytes;
        }
    }
    catch (error) {
        if (isMissingFile(error))
            return { reterminate: false };
        throw error;
    }
    if (!last || last.record.terminated)
        return { reterminate: false };
    if (!isTornTrailingRecord(last.record))
        return { reterminate: true };
    let cut = last.start;
    if (previous) {
        let row;
        try {
            row = JSON.parse(previous.text);
        }
        catch {
            // A corrupt terminated line stays fatal in replay.
        }
        if (isV6LockRowCandidate(row)) {
            // The lock row is dropped with the torn tail only when both are the
            // single lock+commit append this binary writes (reserveV6Commit): the
            // lock row byte-for-byte as v6RowLine serializes it, and the torn tail
            // a prefix of that lock's own commit row, possibly followed by zero
            // fill. Anything else is corruption before the tail: fail stop and
            // leave the file untouched.
            assertTornV6CommitOfLock(previous.text, last.record.text);
            cut = previous.start;
            return { reterminate: false, lockDrop: { cut, tornStart: last.start, droppedBytes: offset - cut } };
        }
    }
    return { reterminate: false, tailDrop: { cut, droppedBytes: offset - cut } };
}
function isV6LockRowCandidate(row) {
    return row !== null && typeof row === "object" && !Array.isArray(row) &&
        row.v === 2 && row.step === "lock";
}
function assertTornV6CommitOfLock(lockText, tornText) {
    const row = JSON.parse(lockText);
    const { height, round, value } = row;
    if (!Number.isSafeInteger(height) || height < 1 ||
        !Number.isSafeInteger(round) || round < 0 || round > V6_MAX_ROUND ||
        typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error("Corrupt signing journal entry");
    }
    const lock = v6RowLine({ v: 2, height: height, round: round, step: "lock", value, lockRound: round });
    if (`${lockText}\n` !== lock)
        throw new Error("Corrupt signing journal entry");
    const commit = v6RowLine({ v: 2, height: height, round: round, step: "commit", value });
    const torn = tornText.replace(/\0+$/, "");
    if (!commit.startsWith(torn)) {
        throw new Error("Torn protocol v6 lock/commit pair in signing journal");
    }
}
const V6_JOURNAL_STEPS = new Set(["block-proposal", "proposal", "prepare", "lock", "commit", "timeout"]);
function v6RowLine(row) {
    const ordered = { v: 2, height: row.height, round: row.round, step: row.step, value: row.value };
    if (row.step === "lock")
        ordered.lockRound = row.lockRound;
    return `${JSON.stringify(ordered)}\n`;
}
export function assertSigningJournalDurabilitySupported(platform = process.platform) {
    if (platform === "win32") {
        throw new Error("Crash-durable validator signing journal requires POSIX directory fsync");
    }
}
export class NodeDataDirectoryLease {
    database;
    closed = false;
    constructor(database) {
        this.database = database;
    }
    static async acquire(dataDir) {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const database = new Database(join(dataDir, "node-writer.lock.sqlite"), { timeout: 0 });
        try {
            database.pragma("journal_mode = DELETE");
            database.exec("BEGIN EXCLUSIVE");
            return new NodeDataDirectoryLease(database);
        }
        catch (error) {
            database.close();
            throw new Error("Node data directory already has an active writer", { cause: error });
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.database.exec("ROLLBACK");
        }
        finally {
            this.database.close();
        }
    }
}
export class ChainStore {
    dataDir;
    chain;
    stateV2Store;
    recoveredFromCheckpointHeight;
    recoveredStateV2FromCorruption;
    persistedHeight;
    persistedBytes;
    blockRanges;
    persistenceFaulted = false;
    retainedFromHeight;
    pendingPruneThroughHeight;
    appendNeedsDelimiter;
    constructor(dataDir, chain, persistedHeight, persistedBytes, blockRanges, appendNeedsDelimiter, stateV2Store, recoveredFromCheckpointHeight = 0, recoveredStateV2FromCorruption = false, retention) {
        this.dataDir = dataDir;
        this.chain = chain;
        this.stateV2Store = stateV2Store;
        this.recoveredFromCheckpointHeight = recoveredFromCheckpointHeight;
        this.recoveredStateV2FromCorruption = recoveredStateV2FromCorruption;
        this.persistedHeight = persistedHeight;
        this.persistedBytes = persistedBytes;
        this.blockRanges = blockRanges;
        this.appendNeedsDelimiter = appendNeedsDelimiter;
        this.retainedFromHeight = blockRanges[0]?.height ?? persistedHeight + 1;
        if (retention && this.retainedFromHeight <= retention.prunedThroughHeight) {
            this.pendingPruneThroughHeight = retention.prunedThroughHeight;
        }
    }
    get firstStoredHeight() {
        return this.retainedFromHeight;
    }
    get persistenceHealthy() {
        return !this.persistenceFaulted;
    }
    static async open(genesis, dataDir, faultHooks = {}) {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const genesisChain = new ZyronChain(genesis);
        const metadataPath = join(dataDir, "metadata.json");
        const expected = {
            version: STORE_VERSION,
            chainId: genesis.chainId,
            genesisHash: genesisChain.tip.hash
        };
        await ensureMetadata(metadataPath, expected);
        const blocksPath = join(dataDir, "blocks.ndjson");
        try {
            const blocksHandle = await open(blocksPath, "a", 0o600);
            try {
                await blocksHandle.sync();
                await faultHooks.afterFileSync?.();
            }
            finally {
                await blocksHandle.close();
            }
            await syncDirectory(dataDir);
            await faultHooks.afterDirectorySync?.();
        }
        catch (error) {
            throw new Error("Finalized block log initialization persistence failed", { cause: error });
        }
        const retention = await loadHistoryRetention(genesis, dataDir);
        const checkpoint = await loadRecoveryCheckpoint(genesis, dataDir, faultHooks.onCheckpointStep);
        if (retention && (!checkpoint || !hasRetainedLayout(checkpoint.checkpoint) ||
            checkpoint.checkpoint.stateV2Root === null ||
            checkpoint.checkpoint.retainedFromHeight < retention.prunedThroughHeight + 1)) {
            throw new Error("Pruned finalized history requires a valid compatible recovery checkpoint");
        }
        let replay;
        if (checkpoint) {
            try {
                replay = await replayStoredBlocks(genesis, blocksPath, checkpoint, faultHooks.onBlockRecord);
            }
            catch (error) {
                if (retention) {
                    throw new Error("Pruned finalized history cannot fall back to full replay", { cause: error });
                }
                // The finalized block log remains authoritative. A stale, ahead, truncated,
                // or otherwise inconsistent local checkpoint can only disable the fast path;
                // it must never prevent a safe full replay.
            }
        }
        replay ??= await replayStoredBlocks(genesis, blocksPath, undefined, faultHooks.onBlockRecord);
        if (replay.tornTailBytes > 0) {
            await truncateTornTail(blocksPath, replay.offset, replay.tornTailBytes, "finalized block log");
        }
        let stateV2Store;
        let recoveredStateV2FromCorruption = false;
        try {
            stateV2Store = await StateV2DiskStore.open(dataDir);
        }
        catch {
            // At this point finalized history/checkpoint replay has already succeeded,
            // so corrupted derived State-v2 files are never a trust source. Preserve
            // them for forensics and rebuild only from the authenticated replay state.
            await quarantineCorruptStateV2(dataDir);
            stateV2Store = await StateV2DiskStore.open(dataDir);
            recoveredStateV2FromCorruption = true;
        }
        const replayedStateV2 = replay.chain.stateV2ForPersistence();
        if (replayedStateV2) {
            const replayedKeys = replay.chain.stateV2SemanticKeyPreimages();
            if (!replayedKeys)
                throw new Error("Active State v2 replay is missing semantic keys");
            const persistedRoot = stateV2Store.state().root();
            // An empty store has the empty root; comparing roots avoids copying every
            // record of a populated store just to test for emptiness.
            if (persistedRoot === SparseMerkleState.empty().root() || persistedRoot !== replayedStateV2.root() ||
                !stateV2Store.semanticIndexWouldBeComplete(replayedStateV2, [])) {
                // The finalized block log is authoritative. A crash can occur after the
                // block fsync and before its State-v2 root pointer commit, leaving a
                // valid but stale state store. Replay has already revalidated the full
                // transition, so catch the store up to that authenticated state.
                await stateV2Store.commit(replayedStateV2, replayedKeys, faultHooks.onStateV2Batch ? { onCatchupBatch: faultHooks.onStateV2Batch } : {});
            }
        }
        return new ChainStore(dataDir, replay.chain, replay.count, replay.offset, replay.blockRanges, replay.appendNeedsDelimiter, stateV2Store, replay.recoveredHeight, recoveredStateV2FromCorruption, retention);
    }
    /**
     * Materialize an externally anchored State-v2 snapshot into a brand-new data
     * directory. The anchor must come from a trusted channel independent of the
     * snapshot transport; peer-provided metadata is deliberately insufficient.
     * Existing node data is never replaced by this operation.
     */
    static async installTrustedSnapshot(genesis, dataDir, value, anchor, faultHooks = {}) {
        // Authenticate every consensus-relevant byte before touching the target.
        const chain = ZyronChain.fromTrustedSnapshot(genesis, value, anchor);
        if (chain.height < 1)
            throw new Error("Trusted snapshot install requires a finalized non-genesis checkpoint");
        const stateV2 = chain.stateV2ForPersistence();
        if (!stateV2)
            throw new Error("Trusted snapshot install requires active State v2");
        const stateV2Keys = chain.stateV2SemanticKeyPreimages();
        if (!stateV2Keys)
            throw new Error("Trusted snapshot install requires State v2 semantic keys");
        const snapshot = chain.snapshot();
        if (sha256Hex(canonicalJson(snapshot)) !== anchor.snapshotSha256) {
            throw new Error("Trusted snapshot normalization changed the externally anchored digest");
        }
        await mkdir(dirname(dataDir), { recursive: true, mode: 0o700 });
        await assertPathMissing(dataDir);
        const staging = `${dataDir}.install-${process.pid}-${randomBytes(8).toString("hex")}`;
        let published = false;
        try {
            await mkdir(staging, { recursive: false, mode: 0o700 });
            const genesisChain = new ZyronChain(genesis);
            await ensureMetadata(join(staging, "metadata.json"), {
                version: STORE_VERSION,
                chainId: genesis.chainId,
                genesisHash: genesisChain.genesisHash
            });
            const blocksHandle = await open(join(staging, "blocks.ndjson"), "wx", 0o600);
            try {
                await blocksHandle.sync();
            }
            finally {
                await blocksHandle.close();
            }
            const stateStore = await StateV2DiskStore.open(staging);
            await stateStore.commit(stateV2, stateV2Keys);
            const checkpoint = {
                version: 3,
                chainId: genesis.chainId,
                genesisHash: genesisChain.genesisHash,
                height: chain.height,
                tipHash: anchor.tipHash,
                stateV2Root: stateV2.root(),
                retainedFromHeight: chain.height + 1,
                blockFileBytes: 0,
                blockFilePrefixSha256: EMPTY_SHA256,
                transition: null,
                snapshotSha256: anchor.snapshotSha256,
                snapshot
            };
            await writeCheckpointFile(join(staging, "recovery-checkpoint.json"), checkpoint);
            await writeHistoryRetention(staging, {
                version: 1,
                chainId: genesis.chainId,
                genesisHash: genesisChain.genesisHash,
                prunedThroughHeight: chain.height
            });
            // Re-enter through the normal recovery path before publishing the directory.
            // This independently validates checkpoint, State-v2 root and pruned boundary.
            const staged = await ChainStore.open(genesis, staging);
            if (staged.chain.height !== chain.height || staged.chain.tip.hash !== anchor.tipHash ||
                staged.chain.tip.header.stateRoot !== stateV2.root() || staged.firstStoredHeight !== chain.height + 1) {
                throw new Error("Staged trusted snapshot failed recovery verification");
            }
            await syncDirectory(staging);
            await faultHooks.afterStagingSync?.();
            // Recheck immediately before the atomic publish. rename() must not be used
            // as an overwrite primitive for an existing node data directory.
            await assertPathMissing(dataDir);
            await rename(staging, dataDir);
            published = true;
            await syncDirectory(dirname(dataDir));
        }
        finally {
            if (!published)
                await rm(staging, { recursive: true, force: true });
        }
        return ChainStore.open(genesis, dataDir);
    }
    /**
     * Installs a portable State-v2 node bundle without weakening the checkpoint
     * trust model. Portable records/preimages are authenticated first, then the
     * reconstructed canonical snapshot goes through the same atomic installer.
     */
    static async installTrustedPortableState(genesis, dataDir, tip, bundle, anchor, faultHooks = {}) {
        const chain = ZyronChain.fromTrustedPortableState(genesis, tip, bundle, anchor);
        return ChainStore.installTrustedSnapshot(genesis, dataDir, chain.snapshot(), anchor, faultHooks);
    }
    async readFinalizedBlocks(from, limit, maxBytes) {
        if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(limit) || limit < 1) {
            throw new Error("Invalid finalized block range");
        }
        if (from < this.firstStoredHeight) {
            throw new Error(`Finalized history pruned below height ${this.firstStoredHeight}`);
        }
        const result = [];
        let responseBytes = Buffer.byteLength('{"blocks":[]}', "utf8");
        const handle = await open(join(this.dataDir, "blocks.ndjson"), "r");
        try {
            // Ranges carry absolute heights. Do not infer a block's height from its
            // array index: pruned stores will intentionally start above height 1.
            const ranges = this.blockRanges.filter((range) => range.height >= from).slice(0, limit);
            for (const range of ranges) {
                if (responseBytes + range.length + (result.length ? 1 : 0) > maxBytes) {
                    if (result.length === 0)
                        throw new Error("Finalized block exceeds sync response byte budget");
                    break;
                }
                const buffer = Buffer.alloc(range.length);
                const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset);
                if (bytesRead !== range.length)
                    throw new Error("Finalized block storage was truncated after startup");
                let block;
                try {
                    block = JSON.parse(buffer.toString("utf8"));
                }
                catch {
                    throw new Error("Finalized block storage changed after startup");
                }
                result.push(block);
                responseBytes += range.length + (result.length > 1 ? 1 : 0);
            }
        }
        finally {
            await handle.close();
        }
        return result;
    }
    async writeSnapshot(path) {
        const snapshot = this.chain.snapshot();
        const canonical = canonicalJson(snapshot);
        const sha256 = sha256Hex(canonical);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, `${canonical}\n`, { flag: "wx", mode: 0o600 });
        return { height: snapshot.height, sha256 };
    }
    async writeRecoveryCheckpoint(faultHooks = {}) {
        if (this.pendingPruneThroughHeight !== undefined) {
            throw new Error("Interrupted pruning must be completed before publishing another recovery checkpoint");
        }
        if (this.chain.height !== this.persistedHeight)
            throw new Error("Cannot checkpoint non-durable chain state");
        return this.publishVerifiedRecoveryCheckpoint(faultHooks);
    }
    /**
     * Write-verify-swap: the new checkpoint is written to a temporary file, read
     * back through the exact startup verification path (and any extra check the
     * caller supplies), and only then atomically renamed over the previous one.
     * A checkpoint that does not verify never replaces the last verified anchor.
     */
    async publishVerifiedRecoveryCheckpoint(faultHooks = {}, extraVerification) {
        const snapshot = this.chain.snapshot();
        const snapshotSha256 = sha256Hex(canonicalJson(snapshot));
        // Unpruned logs keep v1's rule: the root (if any) is taken from the
        // snapshot-backed chain; pruned logs additionally require the durable store.
        const stateV2Root = this.firstStoredHeight === 1
            ? this.chain.stateV2ForPersistence()?.root() ?? null
            : this.requireDurableStateV2ForPruning().root();
        const blockFilePrefixSha256 = await sha256FileRange(join(this.dataDir, "blocks.ndjson"), 0, this.persistedBytes);
        const checkpoint = {
            version: 3,
            chainId: this.chain.genesis.chainId,
            genesisHash: this.chain.genesisHash,
            height: this.persistedHeight,
            tipHash: this.chain.tip.hash,
            stateV2Root,
            retainedFromHeight: this.firstStoredHeight,
            blockFileBytes: this.persistedBytes,
            blockFilePrefixSha256,
            transition: null,
            snapshotSha256,
            snapshot
        };
        const path = join(this.dataDir, "recovery-checkpoint.json");
        const genesis = this.chain.genesis;
        await writeCheckpointFile(path, checkpoint, faultHooks, async (temporaryPath) => {
            let loaded;
            try {
                loaded = await loadRecoveryCheckpointFile(genesis, temporaryPath);
            }
            catch (error) {
                throw new Error("Recovery checkpoint failed verification; previous checkpoint kept", { cause: error });
            }
            if (loaded.checkpoint.height !== checkpoint.height || loaded.checkpoint.tipHash !== checkpoint.tipHash ||
                loaded.checkpoint.snapshotSha256 !== snapshotSha256) {
                throw new Error("Recovery checkpoint failed verification; previous checkpoint kept");
            }
            await extraVerification?.(loaded);
        });
        return { height: checkpoint.height, tipHash: checkpoint.tipHash, snapshotSha256 };
    }
    async pruneFinalizedHistory(faultHooks = {}, retainBlocks = 0) {
        if (this.persistenceFaulted)
            throw new Error("Persistence fault requires node restart");
        if (this.chain.height !== this.persistedHeight)
            throw new Error("Cannot prune non-durable chain state");
        if (this.persistedHeight < 1)
            throw new Error("Cannot prune empty finalized history");
        if (!Number.isSafeInteger(retainBlocks) || retainBlocks < 0 || retainBlocks > this.persistedHeight) {
            throw new Error("Invalid finalized-history retention count");
        }
        const stateV2 = this.requireDurableStateV2ForPruning();
        const blocksPath = join(this.dataDir, "blocks.ndjson");
        const pruneThroughHeight = this.pendingPruneThroughHeight ?? (this.persistedHeight - retainBlocks);
        if (pruneThroughHeight < this.firstStoredHeight) {
            throw new Error("No finalized history eligible for pruning under retention policy");
        }
        const targetRetainedFromHeight = pruneThroughHeight + 1;
        const firstRetained = this.blockRanges.find((range) => range.height >= targetRetainedFromHeight);
        const retainedStartOffset = firstRetained?.offset ?? this.persistedBytes;
        const targetBlockFileBytes = this.persistedBytes - retainedStartOffset;
        if (this.pendingPruneThroughHeight === undefined) {
            // First publish and re-read a normal checkpoint against the currently
            // retained log. Pruning is allowed only after that local finality anchor has
            // independently survived the same startup verification path.
            // The new checkpoint replaces the previous one only after it verifies, so
            // a failed prune can never leave the data directory without a valid anchor.
            try {
                await this.publishVerifiedRecoveryCheckpoint({}, async (loaded) => {
                    const verified = await replayStoredBlocks(this.chain.genesis, blocksPath, loaded);
                    if (verified.count !== this.persistedHeight || verified.chain.tip.hash !== this.chain.tip.hash) {
                        throw new Error("Recovery checkpoint did not reproduce durable finalized tip");
                    }
                });
            }
            catch (error) {
                throw new Error("Verified recovery checkpoint unavailable for pruning", { cause: error });
            }
        }
        else if (this.pendingPruneThroughHeight > this.persistedHeight) {
            throw new Error("Interrupted prune boundary is invalid for durable finalized tip");
        }
        const snapshot = this.chain.snapshot();
        const snapshotSha256 = sha256Hex(canonicalJson(snapshot));
        // Both layouts an interrupted prune can leave on disk are bound: the old
        // retained log [0 .. persistedBytes) and the new suffix log, whose bytes are
        // exactly [retainedStartOffset .. persistedBytes) of the old one.
        const prefixDigests = await sha256FileRanges(blocksPath, [
            [0, this.persistedBytes],
            [retainedStartOffset, this.persistedBytes]
        ]);
        const transition = {
            version: 3,
            chainId: this.chain.genesis.chainId,
            genesisHash: this.chain.genesisHash,
            height: this.persistedHeight,
            tipHash: this.chain.tip.hash,
            stateV2Root: stateV2.root(),
            retainedFromHeight: targetRetainedFromHeight,
            blockFileBytes: targetBlockFileBytes,
            blockFilePrefixSha256: prefixDigests[1],
            transition: {
                fromHeight: this.firstStoredHeight,
                blockFileBytes: this.persistedBytes,
                blockFilePrefixSha256: prefixDigests[0]
            },
            snapshotSha256,
            snapshot
        };
        const checkpointPath = join(this.dataDir, "recovery-checkpoint.json");
        const temporaryBlocks = `${blocksPath}.prune-${process.pid}-${randomBytes(8).toString("hex")}`;
        let blocksRenamed = false;
        try {
            await writeCheckpointFile(checkpointPath, transition);
            await faultHooks.afterPruneCheckpointSync?.();
            await writeHistoryRetention(this.dataDir, {
                version: 1,
                chainId: this.chain.genesis.chainId,
                genesisHash: this.chain.genesisHash,
                prunedThroughHeight: pruneThroughHeight
            });
            await copyFileRangeDurably(blocksPath, temporaryBlocks, retainedStartOffset, this.persistedBytes);
            await faultHooks.afterBlockTemporarySync?.();
            await rename(temporaryBlocks, blocksPath);
            blocksRenamed = true;
            await faultHooks.afterBlockRename?.();
            await syncDirectory(this.dataDir);
            const retainedRanges = this.blockRanges
                .filter((range) => range.height >= targetRetainedFromHeight)
                .map((range) => ({ ...range, offset: range.offset - retainedStartOffset }));
            this.blockRanges.splice(0, this.blockRanges.length, ...retainedRanges);
            this.persistedBytes = targetBlockFileBytes;
            this.retainedFromHeight = targetRetainedFromHeight;
            this.pendingPruneThroughHeight = undefined;
            if (targetBlockFileBytes === 0)
                this.appendNeedsDelimiter = false;
            const stable = { ...transition, transition: null };
            await writeCheckpointFile(checkpointPath, stable);
            // Only explicit finalized-history pruning physically discards historical
            // State-v2 objects. The retained current root is fully re-authenticated
            // before one atomic SQLite GC transaction; archival operation never calls it.
            this.stateV2Store.pruneHistoricalObjects();
            return { prunedThroughHeight: pruneThroughHeight, firstStoredHeight: this.firstStoredHeight };
        }
        catch (error) {
            this.persistenceFaulted = true;
            throw new Error("Pruning interrupted; restart required", { cause: error });
        }
        finally {
            if (!blocksRenamed)
                await rm(temporaryBlocks, { force: true });
        }
    }
    requireDurableStateV2ForPruning() {
        const stateV2 = this.chain.stateV2ForPersistence();
        if (!stateV2)
            throw new Error("Pruning requires active State v2");
        if (this.stateV2Store.state().root() !== stateV2.root()) {
            throw new Error("Pruning requires State v2 root to match durable finalized state");
        }
        return stateV2;
    }
    async commitFinalizedBlock(block, nowMs = Date.now(), faultHooks = {}) {
        if (this.persistenceFaulted)
            throw new Error("Persistence fault requires node restart");
        if (this.pendingPruneThroughHeight !== undefined) {
            throw new Error("Interrupted pruning must be completed before new finalized writes");
        }
        if (block.header.height !== this.persistedHeight + 1) {
            throw new Error("Refusing non-sequential block persistence");
        }
        if (this.chain.height !== this.persistedHeight) {
            throw new Error("In-memory chain and durable height diverged");
        }
        // Validate against the current durable tip before writing. The fsync deliberately
        // happens before mutating in-memory state: a crash after fsync is recovered by
        // replay, while a failed disk write cannot make the live node advertise a tip that
        // was never durably committed.
        const nextStateV2 = this.chain.validatedStateV2ForBlock(block, nowMs);
        const line = `${canonicalJson(block)}\n`;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (lineBytes > MAX_STORED_BLOCK_LINE_BYTES) {
            throw new Error("Block exceeds persistence limit");
        }
        const delimiter = this.appendNeedsDelimiter && this.persistedBytes > 0 ? "\n" : "";
        const delimiterBytes = Buffer.byteLength(delimiter, "utf8");
        try {
            const handle = await open(join(this.dataDir, "blocks.ndjson"), "a", 0o600);
            try {
                await handle.writeFile(`${delimiter}${line}`, "utf8");
                await faultHooks.afterBlockWrite?.();
                await handle.sync();
                await faultHooks.afterBlockSync?.();
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            // Once append/fsync/close has failed, the process cannot know whether a
            // complete record is durable. Never attempt a second finalized append on
            // that uncertain boundary; startup replay is the recovery authority.
            this.persistenceFaulted = true;
            throw new Error("Finalized block persistence failed; restart required", { cause: error });
        }
        if (nextStateV2) {
            try {
                const incrementalKeys = block.transactions.flatMap(stateV2TransactionKeyPreimages);
                const keyPreimages = this.stateV2Store.semanticIndexWouldBeComplete(nextStateV2, incrementalKeys)
                    ? incrementalKeys
                    : this.chain.stateV2SemanticKeyPreimagesForBlock(block);
                await this.stateV2Store.commit(nextStateV2, keyPreimages);
            }
            catch (error) {
                this.persistenceFaulted = true;
                throw new Error("State v2 persistence failed after durable block write; restart required", { cause: error });
            }
        }
        this.chain.acceptBlock(block, nowMs);
        this.blockRanges.push({
            height: block.header.height,
            offset: this.persistedBytes + delimiterBytes,
            length: lineBytes - 1
        });
        this.persistedBytes += delimiterBytes + lineBytes;
        this.persistedHeight = block.header.height;
        this.appendNeedsDelimiter = false;
    }
}
async function quarantineCorruptStateV2(dataDir) {
    const suffix = `.corrupt-${Date.now()}-${randomBytes(6).toString("hex")}`;
    for (const filename of [
        "state-v2.nodes.ndjson",
        "state-v2.nodes.sqlite",
        "state-v2.nodes.sqlite-journal",
        "state-v2.nodes.sqlite-wal",
        "state-v2.nodes.sqlite-shm",
        "state-v2.backend.json",
        "state-v2.keys.backend.json",
        "state-v2.keys.ndjson",
        "state-v2.root.json"
    ]) {
        try {
            await rename(join(dataDir, filename), join(dataDir, `${filename}${suffix}`));
        }
        catch (error) {
            if (!isMissingFile(error))
                throw error;
        }
    }
    await syncDirectory(dataDir);
}
async function loadHistoryRetention(genesis, dataDir) {
    try {
        const value = JSON.parse(await readBoundedRegularControlFile(join(dataDir, "history-retention.json"), "History retention marker"));
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("Invalid history retention marker");
        const record = value;
        if (Object.keys(record).sort().join(",") !== "chainId,genesisHash,prunedThroughHeight,version" ||
            record.version !== 1 || typeof record.chainId !== "string" || typeof record.genesisHash !== "string" ||
            !Number.isSafeInteger(record.prunedThroughHeight) || Number(record.prunedThroughHeight) < 1) {
            throw new Error("Invalid history retention marker");
        }
        const marker = record;
        const genesisHash = new ZyronChain(genesis).genesisHash;
        if (marker.chainId !== genesis.chainId || marker.genesisHash !== genesisHash) {
            throw new Error("History retention marker belongs to a different chain");
        }
        return marker;
    }
    catch (error) {
        if (isMissingFile(error))
            return undefined;
        throw error;
    }
}
async function writeHistoryRetention(dataDir, marker) {
    const path = join(dataDir, "history-retention.json");
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    let renamed = false;
    try {
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(`${canonicalJson(marker)}\n`, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, path);
        renamed = true;
        await syncDirectory(dataDir);
    }
    finally {
        if (!renamed)
            await rm(temporary, { force: true });
    }
}
async function writeCheckpointFile(path, checkpoint, faultHooks = {}, verifyBeforeRename) {
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    let renamed = false;
    try {
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(`${canonicalJson(checkpoint)}\n`, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await faultHooks.afterTemporarySync?.();
        await verifyBeforeRename?.(temporary);
        await rename(temporary, path);
        renamed = true;
        await faultHooks.afterRename?.();
        await syncDirectory(dirname(path));
    }
    finally {
        if (!renamed)
            await rm(temporary, { force: true });
    }
}
async function copyFileRangeDurably(sourcePath, targetPath, start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        throw new Error("Invalid finalized-history copy range");
    }
    const source = await open(sourcePath, "r");
    let target;
    try {
        target = await open(targetPath, "wx", 0o600);
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, end - start)));
        let position = start;
        while (position < end) {
            const requested = Math.min(buffer.length, end - position);
            const { bytesRead } = await source.read(buffer, 0, requested, position);
            if (bytesRead !== requested)
                throw new Error("Finalized block storage changed during pruning");
            await target.write(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        await target.sync();
    }
    finally {
        await source.close();
        await target?.close();
    }
}
async function syncDirectory(path) {
    const directory = await open(path, "r");
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
async function syncDirectoryTree(path) {
    const directories = [];
    let current = resolve(path);
    while (true) {
        directories.push(current);
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    for (const directory of directories.reverse())
        await syncDirectory(directory);
}
export class SigningJournal {
    path;
    leaseDatabase;
    reservations = new Map();
    // Protocol v6 (F-01) rows, kept separately from the legacy attest/skip map.
    legacyHeights = new Set();
    // Heights at which a legacy block proposal or attestation was released by a
    // signer that has no round-keyed reservation for it (remote signer). They
    // are journaled so a v6 action at the same height is refused across restart.
    legacyMarks = new Set();
    v6Heights = new Map();
    v6Rows = [];
    persistenceFaulted = false;
    closed = false;
    /** v6 consensus-state files next to the journal (created lazily; unused by v1-v5). */
    consensusState;
    constructor(path, leaseDatabase) {
        this.path = path;
        this.leaseDatabase = leaseDatabase;
        this.consensusState = new ConsensusStateStore(dirname(path));
    }
    static async open(dataDir, faultHooks = {}) {
        assertSigningJournalDurabilitySupported();
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const leaseDatabase = acquireSigningJournalLease(join(dataDir, "signing-journal.lock.sqlite"));
        const journal = new SigningJournal(join(dataDir, "signing-journal.ndjson"), leaseDatabase);
        try {
            let pendingLock = null;
            let reterminate = false;
            try {
                const repair = await repairSigningJournalTail(journal.path);
                reterminate = repair.reterminate;
                if (repair.lockDrop) {
                    // Validate the full history including the trailing lock before the
                    // repair removes anything (round-4 PR967/PR979). A probe instance
                    // keeps the real journal's in-memory state clean; inconsistent
                    // history fails stop with the file bytes untouched.
                    const probe = new SigningJournal(journal.path, leaseDatabase);
                    const probeLock = await probe.replayRows(repair.lockDrop.tornStart);
                    if (!probeLock)
                        throw new Error("Torn protocol v6 lock/commit pair in signing journal");
                    probe.assertTornAppendLock(probeLock);
                    await truncateTornTail(journal.path, repair.lockDrop.cut, repair.lockDrop.droppedBytes, "signing journal");
                }
                else if (repair.tailDrop) {
                    // Same rule for every other torn tail (round-5 R5-995-L1): replay
                    // everything before the tail on a probe first, so inconsistent or
                    // corrupt history fails stop before the repair removes a byte. The
                    // real replay below runs on the repaired file and repeats every
                    // check, including the lone-lock completion rules.
                    const probe = new SigningJournal(journal.path, leaseDatabase);
                    await probe.replayRows(repair.tailDrop.cut);
                    await truncateTornTail(journal.path, repair.tailDrop.cut, repair.tailDrop.droppedBytes, "signing journal");
                }
            }
            catch (error) {
                journal.close();
                throw error;
            }
            pendingLock = await journal.replayRows();
            // P0-03: the replay ended on a lone lock row. Lock and commit rows are
            // written by one append (section 9.1) and nothing is appended after a
            // pair until it is fsynced, so a lock row is the final record only when
            // power was lost inside that append (the commit row never reached the
            // disk) or, if fsync ordering was violated, after it. Either way the
            // lock is kept and the pair is completed with the matching commit
            // reservation. A reservation without a signature is an ordinary state
            // (crash after fsync, before signing); keeping both rows never forgets
            // a lock or a possibly released commit vote, so it cannot permit a
            // conflicting vote, and it restores liveness instead of fail-stopping
            // forever. A lock row that is not the final record stays fatal above.
            let completion = "";
            let completedSlot = "";
            if (pendingLock) {
                completedSlot = `height ${pendingLock.height}, round ${pendingLock.round}`;
                // Complete only a lock that reserveV6Commit could have written: the
                // round was still open (no timeout at or above it, no later vote)
                // and any own prepare at that round is for the same block. Anything
                // else is not a torn append but inconsistent history: stay fatal.
                journal.assertTornAppendLock(pendingLock);
                const commit = {
                    v: 2, height: pendingLock.height, round: pendingLock.round, step: "commit", value: pendingLock.value
                };
                pendingLock = journal.replayV6Row({ ...commit }, pendingLock);
                if (pendingLock)
                    throw new Error("Torn protocol v6 lock/commit pair in signing journal");
                completion = v6RowLine(commit);
            }
            if (reterminate || completion) {
                // A complete final row that lost only its newline is terminated so the
                // next append starts a new line (F-10); a lone lock row is completed.
                const handle = await open(journal.path, "a", 0o600);
                try {
                    await handle.writeFile(`${reterminate ? "\n" : ""}${completion}`, "utf8");
                    await faultHooks.afterTailRepairWrite?.();
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
                if (completion) {
                    console.warn(`Completed a lone trailing protocol v6 lock row with its commit reservation (${completedSlot}) in ${journal.path}`);
                }
            }
        }
        catch (error) {
            if (!isMissingFile(error)) {
                journal.close();
                throw error;
            }
            try {
                const handle = await open(journal.path, "wx", 0o600);
                try {
                    await handle.sync();
                    await faultHooks.afterFileSync?.();
                }
                finally {
                    await handle.close();
                }
            }
            catch (createError) {
                journal.close();
                throw new Error("Signing journal initialization persistence failed", { cause: createError });
            }
        }
        try {
            await syncDirectoryTree(dirname(journal.path));
            await faultHooks.afterDirectorySync?.();
        }
        catch (syncError) {
            journal.close();
            throw new Error("Signing journal initialization persistence failed", { cause: syncError });
        }
        return journal;
    }
    get persistenceHealthy() {
        return !this.persistenceFaulted;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.leaseDatabase.exec("ROLLBACK");
        }
        finally {
            this.leaseDatabase.close();
        }
    }
    /** Replay journal rows (only those starting before byte offset stopAt, if given). Returns a trailing unpaired lock. */
    async replayRows(stopAt) {
        let pendingLock = null;
        let offset = 0;
        for await (const record of readLines(this.path, MAX_SIGNING_LINE_BYTES, "Corrupt signing journal")) {
            if (stopAt !== undefined && offset >= stopAt)
                break;
            offset += record.serializedBytes;
            const line = record.text;
            if (!line.trim())
                continue;
            assertSigningJournalJsonComplexity(line);
            const parsed = JSON.parse(line);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && parsed.v === 2) {
                pendingLock = this.replayV6Row(parsed, pendingLock);
                continue;
            }
            if (pendingLock)
                throw new Error("Torn protocol v6 lock/commit pair in signing journal");
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && parsed.kind === "legacy") {
                const keys = Object.keys(parsed).sort().join(",");
                if (keys !== "height,kind" || !Number.isSafeInteger(parsed.height) || parsed.height < 1) {
                    throw new Error("Corrupt signing journal entry");
                }
                if (this.v6Heights.has(parsed.height))
                    throw new Error("Mixed legacy and protocol v6 signing journal rows");
                this.legacyMarks.add(parsed.height);
                this.legacyHeights.add(parsed.height);
                continue;
            }
            if (!Number.isSafeInteger(parsed.height) || !Number.isSafeInteger(parsed.round) ||
                (parsed.kind !== "attest" && parsed.kind !== "skip") ||
                typeof parsed.value !== "string" || !/^[0-9a-f]{64}$/.test(parsed.value)) {
                throw new Error("Corrupt signing journal entry");
            }
            const key = `${parsed.height}:${parsed.round}`;
            const reservation = `${parsed.kind}:${parsed.value}`;
            const previous = this.reservations.get(key);
            if (previous && previous !== reservation)
                throw new Error("Conflicting signing journal history");
            if (this.v6Heights.has(parsed.height))
                throw new Error("Mixed legacy and protocol v6 signing journal rows");
            this.reservations.set(key, reservation);
            this.legacyHeights.add(parsed.height);
        }
        return pendingLock;
    }
    /**
     * A trailing lock without its commit is only a torn reserveV6Commit append
     * when this binary could have written it: the round was still open (no
     * timeout at or above it, no later vote) and any own prepare at that round
     * is for the same block. Anything else is inconsistent history.
     */
    assertTornAppendLock(pendingLock) {
        const state = this.v6Heights.get(pendingLock.height);
        const prepared = state.rows.get(`${pendingLock.round}:prepare`);
        if (state.maxTimeoutRound >= pendingLock.round || state.maxVoteRound > pendingLock.round ||
            (prepared !== undefined && prepared !== pendingLock.value)) {
            throw new Error("Torn protocol v6 lock/commit pair in signing journal");
        }
    }
    async reserveAttestation(height, round, blockHash, faultHooks = {}) {
        return this.reserveChoice(height, round, "attest", blockHash, faultHooks);
    }
    async reserveSkip(height, round, previousHash, faultHooks = {}) {
        return this.reserveChoice(height, round, "skip", previousHash, faultHooks);
    }
    async compactThrough(finalizedHeight, faultHooks = {}) {
        if (this.closed)
            throw new Error("Signing journal is closed");
        if (this.persistenceFaulted)
            throw new Error("Signing journal persistence fault requires validator restart");
        if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight < 0)
            throw new Error("Invalid signing journal compaction height");
        const retained = [];
        const removedKeys = [];
        for (const [key, reservation] of this.reservations) {
            const separator = key.indexOf(":");
            const reservationSeparator = reservation.indexOf(":");
            const height = Number(key.slice(0, separator));
            const round = Number(key.slice(separator + 1));
            const kind = reservation.slice(0, reservationSeparator);
            const value = reservation.slice(reservationSeparator + 1);
            if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(round) || round < 0 ||
                (kind !== "attest" && kind !== "skip") || !/^[0-9a-f]{64}$/.test(value)) {
                this.persistenceFaulted = true;
                throw new Error("Signing journal in-memory state is corrupt; validator restart required");
            }
            if (height <= finalizedHeight)
                removedKeys.push(key);
            else
                retained.push({ key, height, round, kind, value });
        }
        const retainedV6 = this.v6Rows.filter((row) => row.height > finalizedHeight);
        const removedV6 = this.v6Rows.length - retainedV6.length;
        const retainedMarks = [...this.legacyMarks].filter((height) => height > finalizedHeight).sort((a, b) => a - b);
        const removedMarks = this.legacyMarks.size - retainedMarks.length;
        if (removedKeys.length === 0 && removedV6 === 0 && removedMarks === 0) {
            await this.pruneConsensusState(finalizedHeight);
            return 0;
        }
        retained.sort((left, right) => left.height - right.height || left.round - right.round || left.key.localeCompare(right.key));
        const temporary = `${this.path}.compact-${process.pid}-${randomBytes(8).toString("hex")}`;
        let renamed = false;
        try {
            const handle = await open(temporary, "wx", 0o600);
            try {
                for (const entry of retained) {
                    const line = `${JSON.stringify({
                        height: entry.height,
                        round: entry.round,
                        kind: entry.kind,
                        value: entry.value
                    })}\n`;
                    if (Buffer.byteLength(line, "utf8") > MAX_SIGNING_LINE_BYTES) {
                        throw new Error("Signing journal compaction entry exceeds line limit");
                    }
                    await handle.writeFile(line, "utf8");
                }
                for (const height of retainedMarks)
                    await handle.writeFile(`${JSON.stringify({ height, kind: "legacy" })}\n`, "utf8");
                // v2 rows keep their append order, so every lock row stays directly
                // followed by its commit row.
                for (const row of retainedV6) {
                    const line = v6RowLine(row);
                    if (Buffer.byteLength(line, "utf8") > MAX_SIGNING_LINE_BYTES) {
                        throw new Error("Signing journal compaction entry exceeds line limit");
                    }
                    await handle.writeFile(line, "utf8");
                }
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await faultHooks.afterTemporarySync?.();
            await rename(temporary, this.path);
            renamed = true;
            await faultHooks.afterRename?.();
            await syncDirectory(dirname(this.path));
        }
        catch (error) {
            this.persistenceFaulted = true;
            throw new Error("Signing journal compaction failed; validator restart required", { cause: error });
        }
        finally {
            if (!renamed)
                await rm(temporary, { force: true });
        }
        for (const key of removedKeys)
            this.reservations.delete(key);
        for (const height of [...this.legacyHeights])
            if (height <= finalizedHeight)
                this.legacyHeights.delete(height);
        for (const height of [...this.legacyMarks])
            if (height <= finalizedHeight)
                this.legacyMarks.delete(height);
        for (const height of [...this.v6Heights.keys()])
            if (height <= finalizedHeight)
                this.v6Heights.delete(height);
        this.v6Rows = retainedV6;
        await this.pruneConsensusState(finalizedHeight);
        return removedKeys.length + removedV6 + removedMarks;
    }
    // Consensus-state files are liveness aids, never safety state; a failed
    // prune is retried at the next finalized height.
    async pruneConsensusState(finalizedHeight) {
        try {
            await this.consensusState.pruneThrough(finalizedHeight);
        }
        catch {
        }
    }
    // ---------------------------------------------------------------------------
    // Protocol v6 rows (spec §6, §9.2)
    // ---------------------------------------------------------------------------
    replayV6Row(parsed, pendingLock) {
        const step = parsed.step;
        const expectedKeys = step === "lock"
            ? ["v", "height", "round", "step", "value", "lockRound"]
            : ["v", "height", "round", "step", "value"];
        const keys = Object.keys(parsed);
        if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => Object.hasOwn(parsed, key)) ||
            typeof step !== "string" || !V6_JOURNAL_STEPS.has(step) ||
            !Number.isSafeInteger(parsed.height) || parsed.height < 1 ||
            !Number.isSafeInteger(parsed.round) || parsed.round < 0 || parsed.round > V6_MAX_ROUND ||
            typeof parsed.value !== "string" || !/^[0-9a-f]{64}$/.test(parsed.value) ||
            (step === "lock" && parsed.lockRound !== parsed.round)) {
            throw new Error("Corrupt signing journal entry");
        }
        const row = {
            v: 2,
            height: parsed.height,
            round: parsed.round,
            step: step,
            value: parsed.value,
            ...(step === "lock" ? { lockRound: parsed.round } : {})
        };
        if (pendingLock) {
            if (row.step !== "commit" || row.height !== pendingLock.height || row.round !== pendingLock.round || row.value !== pendingLock.value) {
                throw new Error("Torn protocol v6 lock/commit pair in signing journal");
            }
        }
        if (this.legacyHeights.has(row.height))
            throw new Error("Mixed legacy and protocol v6 signing journal rows");
        const state = this.v6HeightState(row.height, true);
        if (row.step === "lock") {
            if (state.lock && (state.lock.round > row.round || (state.lock.round === row.round && state.lock.blockHash !== row.value))) {
                throw new Error("Conflicting signing journal history");
            }
            // reserveV6Commit only writes a lock in an open round that agrees with
            // the own prepare there (assertV6RoundOpen); any other lock row is
            // history this binary cannot have written (round-4 PR967).
            const prepared = state.rows.get(`${row.round}:prepare`);
            if (state.maxTimeoutRound >= row.round || state.maxVoteRound > row.round ||
                (prepared !== undefined && prepared !== row.value)) {
                // Same message as the lone-lock completion check: a lock/commit pair
                // that no reserveV6Commit append can have produced.
                throw new Error("Torn protocol v6 lock/commit pair in signing journal");
            }
        }
        else {
            const previous = state.rows.get(`${row.round}:${row.step}`);
            if (previous !== undefined && previous !== row.value)
                throw new Error("Conflicting signing journal history");
        }
        this.applyV6Row(row);
        return row.step === "lock" ? row : null;
    }
    v6HeightState(height, create = false) {
        let state = this.v6Heights.get(height);
        if (!state && create) {
            state = { rows: new Map(), lock: null, maxVoteRound: -1, maxTimeoutRound: -1 };
            this.v6Heights.set(height, state);
        }
        return state;
    }
    applyV6Row(row) {
        const state = this.v6HeightState(row.height, true);
        if (row.step === "lock") {
            state.lock = { round: row.round, blockHash: row.value };
        }
        else {
            state.rows.set(`${row.round}:${row.step}`, row.value);
            if (row.step === "prepare" || row.step === "commit")
                state.maxVoteRound = Math.max(state.maxVoteRound, row.round);
            if (row.step === "timeout")
                state.maxTimeoutRound = Math.max(state.maxTimeoutRound, row.round);
        }
        this.v6Rows.push(row);
    }
    assertV6Writable(height, round, value) {
        if (this.closed)
            throw new Error("Signing journal is closed");
        if (this.persistenceFaulted)
            throw new Error("Signing journal persistence fault requires validator restart");
        if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(round) || round < 0 || round > V6_MAX_ROUND) {
            throw new Error("Invalid signing slot");
        }
        if (!/^[0-9a-f]{64}$/.test(value))
            throw new Error("Invalid signing hash");
        // §6.2-7: one protocol per height.
        if (this.legacyHeights.has(height))
            throw new Error("Protocol v6 validator action refused: legacy journal rows exist at this height");
    }
    // §6.2-2: no proposal/prepare/commit at r after a timeout at r' >= r or a vote at a round > r.
    assertV6RoundOpen(state, round) {
        if (!state)
            return;
        if (state.maxTimeoutRound >= round)
            throw new Error("Protocol v6 validator action refused: round already timed out");
        if (state.maxVoteRound > round)
            throw new Error("Protocol v6 validator action refused: a later round was already voted");
    }
    async appendV6(rows, faultHooks) {
        const text = rows.map(v6RowLine).join("");
        for (const row of rows) {
            if (Buffer.byteLength(v6RowLine(row), "utf8") > MAX_SIGNING_LINE_BYTES)
                throw new Error("Signing journal entry exceeds line limit");
        }
        try {
            const handle = await open(this.path, "a", 0o600);
            try {
                // One write for all rows (the lock+commit pair is a single append, §9.1).
                await handle.writeFile(text, "utf8");
                await faultHooks.afterWrite?.();
                await handle.sync();
                await faultHooks.afterSync?.();
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            this.persistenceFaulted = true;
            throw new Error("Signing journal persistence failed; validator restart required", { cause: error });
        }
        for (const row of rows)
            this.applyV6Row(row);
    }
    /**
     * Reserve a block-proposal, proposal or timeout row (§6.1). Identical
     * re-reservations are idempotent (deterministic signatures); a different
     * value for the same (height, round, step) is refused.
     */
    async reserveV6(height, round, step, value, faultHooks = {}) {
        this.assertV6Writable(height, round, value);
        const state = this.v6HeightState(height);
        const existing = state?.rows.get(`${round}:${step}`);
        if (existing === value)
            return;
        if (existing !== undefined)
            throw new Error("Conflicting validator action prevented for consensus round");
        if (step !== "timeout")
            this.assertV6RoundOpen(state, round);
        await this.appendV6([{ v: 2, height, round, step, value }], faultHooks);
    }
    /** Reserve prepare(H, r) = blockHash, enforcing SAFE-VOTE against the persisted lock (§6.2-4). */
    async reserveV6Prepare(height, round, blockHash, justifyRound, faultHooks = {}) {
        this.assertV6Writable(height, round, blockHash);
        if (!Number.isSafeInteger(justifyRound) || justifyRound < -1 || justifyRound >= round)
            throw new Error("Invalid v6 justify round");
        const state = this.v6HeightState(height);
        const existing = state?.rows.get(`${round}:prepare`);
        if (existing === blockHash)
            return;
        if (existing !== undefined)
            throw new Error("Conflicting validator action prevented for consensus round");
        this.assertV6RoundOpen(state, round);
        if (!safeVote(state?.lock ?? null, blockHash, justifyRound)) {
            throw new Error("Protocol v6 prepare refused: conflicts with the validator's lock");
        }
        await this.appendV6([{ v: 2, height, round, step: "prepare", value: blockHash }], faultHooks);
    }
    /**
     * Reserve lock(H) = (r, blockHash) and commit(H, r) = blockHash in one
     * fsynced append (§9.1). The caller must have verified PrepareQC(H, r,
     * blockHash) and persisted it before calling.
     */
    async reserveV6Commit(height, round, blockHash, faultHooks = {}) {
        this.assertV6Writable(height, round, blockHash);
        const state = this.v6HeightState(height);
        const existing = state?.rows.get(`${round}:commit`);
        if (existing === blockHash)
            return;
        if (existing !== undefined)
            throw new Error("Conflicting validator action prevented for consensus round");
        this.assertV6RoundOpen(state, round);
        const prepared = state?.rows.get(`${round}:prepare`);
        if (prepared !== undefined && prepared !== blockHash)
            throw new Error("Protocol v6 commit refused: differs from own prepare vote");
        const lock = state?.lock ?? null;
        if (lock && (lock.round > round || (lock.round === round && lock.blockHash !== blockHash))) {
            throw new Error("Protocol v6 commit refused: lock may not move backwards");
        }
        await this.appendV6([
            { v: 2, height, round, step: "lock", value: blockHash, lockRound: round },
            { v: 2, height, round, step: "commit", value: blockHash }
        ], faultHooks);
    }
    v6Lock(height) {
        const lock = this.v6Heights.get(height)?.lock;
        return lock ? { ...lock } : null;
    }
    v6Row(height, round, step) {
        return this.v6Heights.get(height)?.rows.get(`${round}:${step}`);
    }
    /** Highest own prepare/commit round and timeout round at a height (-1 when none). */
    v6Rounds(height) {
        const state = this.v6Heights.get(height);
        return { maxVoteRound: state?.maxVoteRound ?? -1, maxTimeoutRound: state?.maxTimeoutRound ?? -1 };
    }
    hasLegacyRows(height) {
        return this.legacyHeights.has(height);
    }
    hasV6Rows(height) {
        return this.v6Heights.has(height);
    }
    /**
     * Durably record that a legacy block proposal or attestation is about to be
     * signed at this height (no round-keyed reservation exists for those). Must
     * complete before the signature is released; afterwards every protocol v6
     * action at this height is refused, including after restart (§6.2-7).
     */
    async reserveLegacyHeight(height, faultHooks = {}) {
        if (this.closed)
            throw new Error("Signing journal is closed");
        if (this.persistenceFaulted)
            throw new Error("Signing journal persistence fault requires validator restart");
        if (!Number.isSafeInteger(height) || height < 1)
            throw new Error("Invalid signing slot");
        if (this.v6Heights.has(height))
            throw new Error("Legacy validator action refused: protocol v6 journal rows exist at this height");
        if (this.legacyHeights.has(height))
            return;
        const line = `${JSON.stringify({ height, kind: "legacy" })}\n`;
        try {
            const handle = await open(this.path, "a", 0o600);
            try {
                await handle.writeFile(line, "utf8");
                await faultHooks.afterWrite?.();
                await handle.sync();
                await faultHooks.afterSync?.();
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            this.persistenceFaulted = true;
            throw new Error("Signing journal persistence failed; validator restart required", { cause: error });
        }
        this.legacyMarks.add(height);
        this.legacyHeights.add(height);
    }
    async reserveChoice(height, round, kind, value, faultHooks) {
        if (this.closed)
            throw new Error("Signing journal is closed");
        if (this.persistenceFaulted)
            throw new Error("Signing journal persistence fault requires validator restart");
        if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(round) || round < 0) {
            throw new Error("Invalid signing slot");
        }
        if (!/^[0-9a-f]{64}$/.test(value))
            throw new Error("Invalid signing hash");
        const key = `${height}:${round}`;
        const reservation = `${kind}:${value}`;
        const existing = this.reservations.get(key);
        if (existing === reservation)
            return;
        if (existing)
            throw new Error("Conflicting validator action prevented for consensus round");
        // §6.2-7: never mix legacy and v6 rows at one height (unreachable unless an
        // operator crosses the activation boundary with the wrong binary).
        if (this.v6Heights.has(height))
            throw new Error("Legacy validator action refused: protocol v6 journal rows exist at this height");
        const line = `${JSON.stringify({ height, round, kind, value })}\n`;
        try {
            const handle = await open(this.path, "a", 0o600);
            try {
                await handle.writeFile(line, "utf8");
                await faultHooks.afterWrite?.();
                await handle.sync();
                await faultHooks.afterSync?.();
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            // The validator must never guess whether a reservation became durable.
            // A retry after an ambiguous append/fsync/close could release a signature
            // for a conflicting choice in the same consensus slot. Fail-stop this
            // journal instance; startup replay is the only safe recovery boundary.
            this.persistenceFaulted = true;
            throw new Error("Signing journal persistence failed; validator restart required", { cause: error });
        }
        this.reservations.set(key, reservation);
        this.legacyHeights.add(height);
    }
}
function acquireSigningJournalLease(path) {
    const database = new Database(path, { timeout: 0 });
    try {
        // Hold an OS-backed SQLite exclusive transaction for the complete journal
        // lifetime. A process crash releases the filesystem lock automatically, so
        // there is no stale PID/lockfile that an operator might incorrectly clear.
        database.pragma("journal_mode = DELETE");
        database.exec("BEGIN EXCLUSIVE");
        return database;
    }
    catch (error) {
        database.close();
        throw new Error("Signing journal data directory already has an active validator writer", { cause: error });
    }
}
async function loadRecoveryCheckpoint(genesis, dataDir, onStep) {
    try {
        return await loadRecoveryCheckpointFile(genesis, join(dataDir, "recovery-checkpoint.json"), onStep);
    }
    catch (error) {
        if (isMissingFile(error))
            return undefined;
        // Recovery metadata is an optimization, never the authority. Corrupt or
        // partially published metadata safely disables it and full replay takes over.
        return undefined;
    }
}
/** Reads and fully verifies one recovery checkpoint file; throws on any defect. */
async function loadRecoveryCheckpointFile(genesis, path, onStep) {
    // With a progress callback, the slow parts (the State-v2 rebuild in
    // particular) run in bounded steps with a callback and an event-loop yield
    // after each (Codex P2 on #1060); the checks and the result are the same.
    const step = async () => {
        if (!onStep)
            return;
        onStep();
        await new Promise((resolve) => setImmediate(resolve));
    };
    const checkpointBytes = await readBoundedFileBuffer(path, MAX_RECOVERY_CHECKPOINT_FILE_BYTES, "Recovery checkpoint");
    await step();
    assertBoundedCheckpointJsonStructure(checkpointBytes);
    const value = JSON.parse(checkpointBytes.toString("utf8"));
    await step();
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid recovery checkpoint");
    const record = value;
    const commonValid = typeof record.chainId === "string" && typeof record.genesisHash === "string" &&
        typeof record.tipHash === "string" && typeof record.snapshotSha256 === "string" &&
        Number.isSafeInteger(record.height) && Number(record.height) >= 0 &&
        Number.isSafeInteger(record.blockFileBytes) && Number(record.blockFileBytes) >= 0;
    if (!commonValid) {
        throw new Error("Invalid recovery checkpoint");
    }
    let checkpoint;
    if (record.version === 1) {
        const expectedKeys = [
            "version", "chainId", "genesisHash", "height", "tipHash", "blockFileBytes", "snapshotSha256", "snapshot"
        ].sort().join(",");
        if (Object.keys(record).sort().join(",") !== expectedKeys)
            throw new Error("Invalid recovery checkpoint");
        checkpoint = record;
    }
    else if (record.version === 2) {
        const expectedKeys = [
            "version", "chainId", "genesisHash", "height", "tipHash", "stateV2Root", "retainedFromHeight",
            "blockFileBytes", "transition", "snapshotSha256", "snapshot"
        ].sort().join(",");
        const transition = record.transition;
        const transitionValid = transition === null || (typeof transition === "object" && !Array.isArray(transition) && transition !== null &&
            Object.keys(transition).sort().join(",") === "blockFileBytes,fromHeight" &&
            Number.isSafeInteger(transition.fromHeight) &&
            Number(transition.fromHeight) >= 1 &&
            Number.isSafeInteger(transition.blockFileBytes) &&
            Number(transition.blockFileBytes) >= 0);
        if (Object.keys(record).sort().join(",") !== expectedKeys || typeof record.stateV2Root !== "string" ||
            !/^[0-9a-f]{64}$/.test(record.stateV2Root) || !Number.isSafeInteger(record.retainedFromHeight) ||
            Number(record.retainedFromHeight) < 1 || Number(record.retainedFromHeight) > Number(record.height) + 1 ||
            !transitionValid) {
            throw new Error("Invalid recovery checkpoint");
        }
        checkpoint = record;
        if (checkpoint.transition && (checkpoint.transition.fromHeight >= checkpoint.retainedFromHeight ||
            checkpoint.transition.fromHeight > checkpoint.height)) {
            throw new Error("Invalid recovery checkpoint transition");
        }
    }
    else if (record.version === 3) {
        const expectedKeys = [
            "version", "chainId", "genesisHash", "height", "tipHash", "stateV2Root", "retainedFromHeight",
            "blockFileBytes", "blockFilePrefixSha256", "transition", "snapshotSha256", "snapshot"
        ].sort().join(",");
        const transition = record.transition;
        const transitionValid = transition === null || (typeof transition === "object" && !Array.isArray(transition) && transition !== null &&
            Object.keys(transition).sort().join(",") === "blockFileBytes,blockFilePrefixSha256,fromHeight" &&
            Number.isSafeInteger(transition.fromHeight) &&
            Number(transition.fromHeight) >= 1 &&
            Number.isSafeInteger(transition.blockFileBytes) &&
            Number(transition.blockFileBytes) >= 0 &&
            typeof transition.blockFilePrefixSha256 === "string" &&
            SHA256_HEX.test(transition.blockFilePrefixSha256));
        const rootValid = record.stateV2Root === null ||
            (typeof record.stateV2Root === "string" && SHA256_HEX.test(record.stateV2Root));
        if (Object.keys(record).sort().join(",") !== expectedKeys || !rootValid ||
            typeof record.blockFilePrefixSha256 !== "string" || !SHA256_HEX.test(record.blockFilePrefixSha256) ||
            !Number.isSafeInteger(record.retainedFromHeight) ||
            Number(record.retainedFromHeight) < 1 || Number(record.retainedFromHeight) > Number(record.height) + 1 ||
            !transitionValid) {
            throw new Error("Invalid recovery checkpoint");
        }
        checkpoint = record;
        if (checkpoint.transition && (checkpoint.transition.fromHeight >= checkpoint.retainedFromHeight ||
            checkpoint.transition.fromHeight > checkpoint.height)) {
            throw new Error("Invalid recovery checkpoint transition");
        }
        // Without State v2 a log cannot have been pruned.
        if (checkpoint.stateV2Root === null && (checkpoint.retainedFromHeight !== 1 || checkpoint.transition !== null)) {
            throw new Error("Invalid recovery checkpoint");
        }
    }
    else {
        throw new Error("Invalid recovery checkpoint version");
    }
    if (checkpoint.chainId !== genesis.chainId || checkpoint.height !== checkpoint.snapshot.height ||
        checkpoint.tipHash !== checkpoint.snapshot.tip?.hash) {
        throw new Error("Recovery checkpoint metadata mismatch");
    }
    const trustedAnchor = { tipHash: checkpoint.tipHash, snapshotSha256: checkpoint.snapshotSha256 };
    const chain = onStep
        ? await ZyronChain.fromTrustedSnapshotInSteps(genesis, checkpoint.snapshot, trustedAnchor, onStep)
        : ZyronChain.fromTrustedSnapshot(genesis, checkpoint.snapshot, trustedAnchor);
    if (checkpoint.genesisHash !== chain.genesisHash)
        throw new Error("Recovery checkpoint genesis mismatch");
    if (checkpoint.height === 0 && checkpoint.blockFileBytes !== 0)
        throw new Error("Invalid genesis recovery boundary");
    if (checkpoint.version === 3 && checkpoint.retainedFromHeight === 1 && checkpoint.transition === null) {
        // Unpruned v3 (the v1 case): the root, or null without active State v2,
        // must be exactly the snapshot-backed chain's.
        if (checkpoint.stateV2Root !== (chain.stateV2ForPersistence()?.root() ?? null)) {
            throw new Error("Recovery checkpoint State v2 root mismatch");
        }
    }
    else if (hasRetainedLayout(checkpoint)) {
        const stateV2 = chain.stateV2ForPersistence();
        if (!stateV2 || checkpoint.stateV2Root !== stateV2.root() || checkpoint.stateV2Root !== chain.tip.header.stateRoot) {
            throw new Error("Recovery checkpoint State v2 root mismatch");
        }
    }
    if (hasRetainedLayout(checkpoint)) {
        if (checkpoint.retainedFromHeight === checkpoint.height + 1 && checkpoint.blockFileBytes !== 0) {
            throw new Error("Invalid empty retained-history boundary");
        }
    }
    return { checkpoint, chain };
}
async function replayStoredBlocks(genesis, blocksPath, loaded, onBlockRecord = () => { }) {
    const chain = loaded?.chain ?? new ZyronChain(genesis);
    const checkpoint = loaded?.checkpoint;
    let checkpointVerified = checkpoint?.height === 0;
    let count = 0;
    let offset = 0;
    let layoutDetermined = !checkpoint || !hasRetainedLayout(checkpoint);
    let checkpointBoundaryBytes = checkpoint?.blockFileBytes ?? 0;
    let expectedPrefixSha256 = checkpoint?.version === 3 ? checkpoint.blockFilePrefixSha256 : undefined;
    let lastLineTerminated = true;
    let tornTailBytes = 0;
    const blockRanges = [];
    // R21-1046-L1: records below a v3 checkpoint are only line-scanned, so the
    // raw bytes the scan reads are hashed at both possible layout boundaries.
    const prefixDigests = checkpoint?.version === 3
        ? new PrefixDigests([checkpoint.blockFileBytes, ...(checkpoint.transition ? [checkpoint.transition.blockFileBytes] : [])])
        : undefined;
    const assertPrefixDigest = () => {
        if (expectedPrefixSha256 === undefined)
            return;
        if (prefixDigests?.digestAt(checkpointBoundaryBytes) !== expectedPrefixSha256) {
            throw new Error("Recovery checkpoint does not match finalized block log");
        }
    };
    for await (const record of readLines(blocksPath, MAX_STORED_BLOCK_LINE_BYTES, "Stored block exceeds line limit", prefixDigests ? (bytes) => prefixDigests.update(bytes) : undefined)) {
        const line = record.text;
        const lineBytes = record.contentBytes;
        lastLineTerminated = record.terminated;
        if (!line.trim()) {
            offset += record.serializedBytes;
            continue;
        }
        if (isTornTrailingRecord(record)) {
            // F-10: never-acknowledged torn final append; ChainStore.open truncates it.
            tornTailBytes = record.serializedBytes;
            lastLineTerminated = true;
            break;
        }
        let parsed;
        if (checkpoint && hasRetainedLayout(checkpoint) && !layoutDetermined) {
            try {
                parsed = JSON.parse(line);
            }
            catch {
                throw new Error("Corrupt stored block at retained-history boundary");
            }
            const firstHeight = parsed.header?.height;
            if (firstHeight === checkpoint.retainedFromHeight) {
                count = checkpoint.retainedFromHeight - 1;
                checkpointBoundaryBytes = checkpoint.blockFileBytes;
                checkpointVerified = checkpoint.retainedFromHeight === checkpoint.height + 1;
            }
            else if (checkpoint.transition && firstHeight === checkpoint.transition.fromHeight) {
                count = checkpoint.transition.fromHeight - 1;
                checkpointBoundaryBytes = checkpoint.transition.blockFileBytes;
                if (checkpoint.version === 3 && checkpoint.transition) {
                    expectedPrefixSha256 = checkpoint.transition.blockFilePrefixSha256;
                }
            }
            else {
                throw new Error("Finalized history does not match checkpoint retention boundary");
            }
            layoutDetermined = true;
        }
        const height = count + 1;
        blockRanges.push({ height, offset, length: lineBytes });
        onBlockRecord();
        if (checkpoint && height < checkpoint.height) {
            count = height;
            offset += record.serializedBytes;
            continue;
        }
        if (parsed === undefined) {
            try {
                parsed = JSON.parse(line);
            }
            catch {
                throw new Error(`Corrupt stored block at line ${height}`);
            }
        }
        if (checkpoint && height === checkpoint.height) {
            if (offset + record.serializedBytes !== checkpointBoundaryBytes ||
                canonicalJson(parsed) !== canonicalJson(checkpoint.snapshot.tip)) {
                throw new Error("Recovery checkpoint does not match finalized block log");
            }
            // Fail before replaying any suffix block on top of an unverified prefix.
            assertPrefixDigest();
            checkpointVerified = true;
        }
        else {
            chain.acceptBlock(parsed, Number.MAX_SAFE_INTEGER);
        }
        count = height;
        offset += record.serializedBytes;
        if ((!checkpoint || height > checkpoint.height) && chain.height !== count) {
            throw new Error("Stored block height discontinuity");
        }
    }
    if (checkpoint && hasRetainedLayout(checkpoint) && !layoutDetermined) {
        if (offset !== 0 || checkpoint.retainedFromHeight !== checkpoint.height + 1 || checkpoint.blockFileBytes !== 0) {
            throw new Error("Recovery checkpoint is ahead of retained finalized block log");
        }
        count = checkpoint.height;
        checkpointVerified = true;
        layoutDetermined = true;
    }
    if (checkpoint && (!checkpointVerified || checkpoint.height > count)) {
        throw new Error("Recovery checkpoint is ahead of finalized block log");
    }
    // Also covers boundaries verified without a tip record (genesis or an empty
    // retained log, both with a zero-byte prefix).
    assertPrefixDigest();
    if (checkpoint?.version === 1 && checkpoint.blockFileBytes > offset) {
        throw new Error("Recovery checkpoint is ahead of finalized block log");
    }
    if (chain.height !== count)
        throw new Error("Stored block height discontinuity");
    return {
        chain,
        count,
        offset,
        blockRanges,
        recoveredHeight: checkpoint?.height ?? 0,
        appendNeedsDelimiter: offset > 0 && !lastLineTerminated,
        tornTailBytes
    };
}
async function ensureMetadata(path, expected) {
    try {
        const existing = JSON.parse(await readBoundedRegularControlFile(path, "Chain metadata"));
        if (existing.version !== expected.version || existing.chainId !== expected.chainId ||
            existing.genesisHash !== expected.genesisHash) {
            throw new Error("Data directory belongs to a different or unsupported chain");
        }
    }
    catch (error) {
        if (!isMissingFile(error))
            throw error;
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(expected)}\n`, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    }
}
async function* readLines(path, maxLineBytes, overflowMessage, onRawBytes) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 0)
        throw new Error("Invalid stored-line byte limit");
    const input = createReadStream(path, { highWaterMark: Math.min(64 * 1024, Math.max(1, maxLineBytes + 1)) });
    let parts = [];
    let bufferedBytes = 0;
    const append = (segment, terminated) => {
        if (segment.length === 0)
            return;
        const nextBytes = bufferedBytes + segment.length;
        const allowsTrailingCr = nextBytes === maxLineBytes + 1 && segment[segment.length - 1] === 0x0d;
        if (nextBytes > maxLineBytes && !(terminated && allowsTrailingCr) && !(!terminated && allowsTrailingCr)) {
            throw new Error(overflowMessage);
        }
        if (nextBytes > maxLineBytes + 1)
            throw new Error(overflowMessage);
        parts.push(segment);
        bufferedBytes = nextBytes;
    };
    const materialize = (terminated) => {
        const rawBytes = bufferedBytes;
        let line = parts.length === 0 ? Buffer.alloc(0) : parts.length === 1 ? parts[0] : Buffer.concat(parts, bufferedBytes);
        if (line.length > 0 && line[line.length - 1] === 0x0d)
            line = line.subarray(0, -1);
        if (line.length > maxLineBytes)
            throw new Error(overflowMessage);
        const result = {
            text: line.toString("utf8"),
            contentBytes: line.length,
            serializedBytes: rawBytes + (terminated ? 1 : 0),
            terminated
        };
        parts = [];
        bufferedBytes = 0;
        return result;
    };
    try {
        for await (const chunkValue of input) {
            const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
            let cursor = 0;
            while (cursor < chunk.length) {
                const newline = chunk.indexOf(0x0a, cursor);
                if (newline === -1) {
                    append(chunk.subarray(cursor), false);
                    onRawBytes?.(chunk.subarray(cursor));
                    break;
                }
                append(chunk.subarray(cursor, newline), true);
                // Raw bytes (line, CR, LF) in file order, fed before the line is yielded.
                onRawBytes?.(chunk.subarray(cursor, newline + 1));
                yield materialize(true);
                cursor = newline + 1;
            }
        }
        if (bufferedBytes > 0)
            yield materialize(false);
    }
    finally {
        input.destroy();
    }
}
const EMPTY_SHA256 = createHash("sha256").digest("hex");
/**
 * Incremental SHA-256 of a byte stream that records the digest of the exact
 * prefix ending at each target offset. Bytes past the last target are ignored.
 */
class PrefixDigests {
    hash = createHash("sha256");
    fed = 0;
    pending;
    digests = new Map();
    constructor(targets) {
        this.pending = [...new Set(targets)].sort((a, b) => a - b);
        while (this.pending[0] === 0) {
            this.pending.shift();
            this.digests.set(0, EMPTY_SHA256);
        }
    }
    update(bytes) {
        let rest = bytes;
        while (rest.length > 0 && this.pending.length > 0) {
            const target = this.pending[0];
            const needed = target - this.fed;
            if (needed > rest.length) {
                this.hash.update(rest);
                this.fed += rest.length;
                return;
            }
            this.hash.update(rest.subarray(0, needed));
            this.fed += needed;
            rest = rest.subarray(needed);
            this.pending.shift();
            this.digests.set(target, this.hash.copy().digest("hex"));
        }
    }
    digestAt(offset) {
        return this.digests.get(offset);
    }
}
/** SHA-256 of each byte range [start, end) of one file, read once in order. */
async function sha256FileRanges(path, ranges) {
    const hashes = ranges.map(() => createHash("sha256"));
    const end = Math.max(0, ...ranges.map(([, rangeEnd]) => rangeEnd));
    let position = 0;
    if (end > 0) {
        const input = createReadStream(path, { start: 0, end: end - 1, highWaterMark: 64 * 1024 });
        try {
            for await (const chunkValue of input) {
                const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
                ranges.forEach(([start, rangeEnd], index) => {
                    const from = Math.max(start, position);
                    const to = Math.min(rangeEnd, position + chunk.length);
                    if (to > from)
                        hashes[index].update(chunk.subarray(from - position, to - position));
                });
                position += chunk.length;
            }
        }
        finally {
            input.destroy();
        }
    }
    if (position !== end)
        throw new Error("Finalized block log is shorter than its durable byte boundary");
    return hashes.map((hash) => hash.digest("hex"));
}
async function sha256FileRange(path, start, end) {
    return (await sha256FileRanges(path, [[start, end]]))[0];
}
function isMissingFile(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
async function assertPathMissing(path) {
    try {
        await lstat(path);
    }
    catch (error) {
        if (isMissingFile(error))
            return;
        throw error;
    }
    throw new Error("Trusted snapshot target data directory already exists");
}
