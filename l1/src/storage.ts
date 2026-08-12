import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";

import { canonicalJson, sha256Hex } from "./codec.js";
import { ZyronChain } from "./chain.js";
import { StateV2DiskStore } from "./state-v2-store.js";
import { stateV2TransactionKeyPreimages } from "./state-v2.js";
import type { StateV2PortableBundleV1 } from "./state-v2-portable.js";
import type { Block, GenesisConfig } from "./types.js";

const STORE_VERSION = 1;
const MAX_STORED_BLOCK_LINE_BYTES = 2_500_000;
const MAX_SIGNING_LINE_BYTES = 1_024;

interface StoreMetadata {
  version: number;
  chainId: string;
  genesisHash: string;
}

interface HistoryRetentionV1 {
  version: 1;
  chainId: string;
  genesisHash: string;
  prunedThroughHeight: number;
}

interface RecoveryCheckpointV1 {
  version: 1;
  chainId: string;
  genesisHash: string;
  height: number;
  tipHash: string;
  blockFileBytes: number;
  snapshotSha256: string;
  snapshot: ReturnType<ZyronChain["snapshot"]>;
}

interface RecoveryCheckpointV2 {
  version: 2;
  chainId: string;
  genesisHash: string;
  height: number;
  tipHash: string;
  stateV2Root: string;
  retainedFromHeight: number;
  blockFileBytes: number;
  transition: null | {
    fromHeight: number;
    blockFileBytes: number;
  };
  snapshotSha256: string;
  snapshot: ReturnType<ZyronChain["snapshot"]>;
}

type RecoveryCheckpoint = RecoveryCheckpointV1 | RecoveryCheckpointV2;

interface StoredBlockRange {
  height: number;
  offset: number;
  length: number;
}

export interface RecoveryCheckpointFaultHooks {
  afterTemporarySync?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
}

export interface PruneFaultHooks {
  afterPruneCheckpointSync?: () => void | Promise<void>;
  afterBlockTemporarySync?: () => void | Promise<void>;
  afterBlockRename?: () => void | Promise<void>;
}

export interface SigningJournalFaultHooks {
  afterWrite?: () => void | Promise<void>;
  afterSync?: () => void | Promise<void>;
}

export interface SigningJournalCompactionFaultHooks {
  afterTemporarySync?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
}

export interface SigningJournalOpenFaultHooks {
  afterFileSync?: () => void | Promise<void>;
  afterDirectorySync?: () => void | Promise<void>;
}

export class NodeDataDirectoryLease {
  private closed = false;
  private constructor(private readonly database: Database.Database) {}

  static async acquire(dataDir: string): Promise<NodeDataDirectoryLease> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const database = new Database(join(dataDir, "node-writer.lock.sqlite"), { timeout: 0 });
    try {
      database.pragma("journal_mode = DELETE");
      database.exec("BEGIN EXCLUSIVE");
      return new NodeDataDirectoryLease(database);
    } catch (error) {
      database.close();
      throw new Error("Node data directory already has an active writer", { cause: error });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.exec("ROLLBACK");
    } finally {
      this.database.close();
    }
  }
}

export interface TrustedSnapshotAnchor {
  tipHash: string;
  snapshotSha256: string;
}

export interface TrustedSnapshotInstallFaultHooks {
  afterStagingSync?: () => void | Promise<void>;
}

export interface FinalizedBlockFaultHooks {
  afterBlockWrite?: () => void | Promise<void>;
  afterBlockSync?: () => void | Promise<void>;
}

export class ChainStore {
  private persistedHeight: number;
  private persistedBytes: number;
  private readonly blockRanges: StoredBlockRange[];
  private persistenceFaulted = false;
  private retainedFromHeight: number;
  private pendingPruneThroughHeight: number | undefined;

  private constructor(
    readonly dataDir: string,
    readonly chain: ZyronChain,
    persistedHeight: number,
    persistedBytes: number,
    blockRanges: StoredBlockRange[],
    private readonly stateV2Store: StateV2DiskStore,
    readonly recoveredFromCheckpointHeight = 0,
    readonly recoveredStateV2FromCorruption = false,
    retention?: HistoryRetentionV1
  ) {
    this.persistedHeight = persistedHeight;
    this.persistedBytes = persistedBytes;
    this.blockRanges = blockRanges;
    this.retainedFromHeight = blockRanges[0]?.height ?? persistedHeight + 1;
    if (retention && this.retainedFromHeight <= retention.prunedThroughHeight) {
      this.pendingPruneThroughHeight = retention.prunedThroughHeight;
    }
  }

  get firstStoredHeight(): number {
    return this.retainedFromHeight;
  }

  get persistenceHealthy(): boolean {
    return !this.persistenceFaulted;
  }

  static async open(genesis: GenesisConfig, dataDir: string): Promise<ChainStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const genesisChain = new ZyronChain(genesis);
    const metadataPath = join(dataDir, "metadata.json");
    const expected: StoreMetadata = {
      version: STORE_VERSION,
      chainId: genesis.chainId,
      genesisHash: genesisChain.tip.hash
    };
    await ensureMetadata(metadataPath, expected);

    const blocksPath = join(dataDir, "blocks.ndjson");
    const blocksHandle = await open(blocksPath, "a", 0o600);
    await blocksHandle.close();
    const retention = await loadHistoryRetention(genesis, dataDir);
    const checkpoint = await loadRecoveryCheckpoint(genesis, dataDir);
    if (retention && (!checkpoint || checkpoint.checkpoint.version !== 2 ||
        checkpoint.checkpoint.retainedFromHeight < retention.prunedThroughHeight + 1)) {
      throw new Error("Pruned finalized history requires a valid compatible recovery checkpoint");
    }
    let replay: Awaited<ReturnType<typeof replayStoredBlocks>> | undefined;
    if (checkpoint) {
      try {
        replay = await replayStoredBlocks(genesis, blocksPath, checkpoint);
      } catch (error) {
        if (retention) {
          throw new Error("Pruned finalized history cannot fall back to full replay", { cause: error });
        }
        // The finalized block log remains authoritative. A stale, ahead, truncated,
        // or otherwise inconsistent local checkpoint can only disable the fast path;
        // it must never prevent a safe full replay.
      }
    }
    replay ??= await replayStoredBlocks(genesis, blocksPath);
    let stateV2Store: StateV2DiskStore;
    let recoveredStateV2FromCorruption = false;
    try {
      stateV2Store = await StateV2DiskStore.open(dataDir);
    } catch {
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
      if (!replayedKeys) throw new Error("Active State v2 replay is missing semantic keys");
      const persistedRoot = stateV2Store.state().root();
      if (stateV2Store.state().nodeRecords().length === 0 || persistedRoot !== replayedStateV2.root() ||
          !stateV2Store.semanticIndexWouldBeComplete(replayedStateV2, [])) {
        // The finalized block log is authoritative. A crash can occur after the
        // block fsync and before its State-v2 root pointer commit, leaving a
        // valid but stale state store. Replay has already revalidated the full
        // transition, so catch the store up to that authenticated state.
        await stateV2Store.commit(replayedStateV2, replayedKeys);
      }
    }
    return new ChainStore(
      dataDir,
      replay.chain,
      replay.count,
      replay.offset,
      replay.blockRanges,
      stateV2Store,
      replay.recoveredHeight,
      recoveredStateV2FromCorruption,
      retention
    );
  }

  /**
   * Materialize an externally anchored State-v2 snapshot into a brand-new data
   * directory. The anchor must come from a trusted channel independent of the
   * snapshot transport; peer-provided metadata is deliberately insufficient.
   * Existing node data is never replaced by this operation.
   */
  static async installTrustedSnapshot(
    genesis: GenesisConfig,
    dataDir: string,
    value: unknown,
    anchor: TrustedSnapshotAnchor,
    faultHooks: TrustedSnapshotInstallFaultHooks = {}
  ): Promise<ChainStore> {
    // Authenticate every consensus-relevant byte before touching the target.
    const chain = ZyronChain.fromTrustedSnapshot(genesis, value, anchor);
    if (chain.height < 1) throw new Error("Trusted snapshot install requires a finalized non-genesis checkpoint");
    const stateV2 = chain.stateV2ForPersistence();
    if (!stateV2) throw new Error("Trusted snapshot install requires active State v2");
    const stateV2Keys = chain.stateV2SemanticKeyPreimages();
    if (!stateV2Keys) throw new Error("Trusted snapshot install requires State v2 semantic keys");
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
      } finally {
        await blocksHandle.close();
      }

      const stateStore = await StateV2DiskStore.open(staging);
      await stateStore.commit(stateV2, stateV2Keys);
      const checkpoint: RecoveryCheckpointV2 = {
        version: 2,
        chainId: genesis.chainId,
        genesisHash: genesisChain.genesisHash,
        height: chain.height,
        tipHash: anchor.tipHash,
        stateV2Root: stateV2.root(),
        retainedFromHeight: chain.height + 1,
        blockFileBytes: 0,
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
    } finally {
      if (!published) await rm(staging, { recursive: true, force: true });
    }
    return ChainStore.open(genesis, dataDir);
  }

  /**
   * Installs a portable State-v2 node bundle without weakening the checkpoint
   * trust model. Portable records/preimages are authenticated first, then the
   * reconstructed canonical snapshot goes through the same atomic installer.
   */
  static async installTrustedPortableState(
    genesis: GenesisConfig,
    dataDir: string,
    tip: Block,
    bundle: StateV2PortableBundleV1,
    anchor: TrustedSnapshotAnchor,
    faultHooks: TrustedSnapshotInstallFaultHooks = {}
  ): Promise<ChainStore> {
    const chain = ZyronChain.fromTrustedPortableState(genesis, tip, bundle, anchor);
    return ChainStore.installTrustedSnapshot(genesis, dataDir, chain.snapshot(), anchor, faultHooks);
  }

  async readFinalizedBlocks(from: number, limit: number, maxBytes: number): Promise<Block[]> {
    if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Invalid finalized block range");
    }
    if (from < this.firstStoredHeight) {
      throw new Error(`Finalized history pruned below height ${this.firstStoredHeight}`);
    }
    const result: Block[] = [];
    let responseBytes = Buffer.byteLength('{"blocks":[]}', "utf8");
    const handle = await open(join(this.dataDir, "blocks.ndjson"), "r");
    try {
      // Ranges carry absolute heights. Do not infer a block's height from its
      // array index: pruned stores will intentionally start above height 1.
      const ranges = this.blockRanges.filter((range) => range.height >= from).slice(0, limit);
      for (const range of ranges) {
        if (responseBytes + range.length + (result.length ? 1 : 0) > maxBytes) {
          if (result.length === 0) throw new Error("Finalized block exceeds sync response byte budget");
          break;
        }
        const buffer = Buffer.alloc(range.length);
        const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset);
        if (bytesRead !== range.length) throw new Error("Finalized block storage was truncated after startup");
        let block: Block;
        try {
          block = JSON.parse(buffer.toString("utf8")) as Block;
        } catch {
          throw new Error("Finalized block storage changed after startup");
        }
        result.push(block);
        responseBytes += range.length + (result.length > 1 ? 1 : 0);
      }
    } finally {
      await handle.close();
    }
    return result;
  }

  async writeSnapshot(path: string): Promise<{ height: number; sha256: string }> {
    const snapshot = this.chain.snapshot();
    const canonical = canonicalJson(snapshot);
    const sha256 = sha256Hex(canonical);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${canonical}\n`, { flag: "wx", mode: 0o600 });
    return { height: snapshot.height, sha256 };
  }

  async writeRecoveryCheckpoint(
    faultHooks: RecoveryCheckpointFaultHooks = {}
  ): Promise<{ height: number; tipHash: string; snapshotSha256: string }> {
    if (this.pendingPruneThroughHeight !== undefined) {
      throw new Error("Interrupted pruning must be completed before publishing another recovery checkpoint");
    }
    if (this.chain.height !== this.persistedHeight) throw new Error("Cannot checkpoint non-durable chain state");
    const snapshot = this.chain.snapshot();
    const snapshotSha256 = sha256Hex(canonicalJson(snapshot));
    let checkpoint: RecoveryCheckpoint;
    if (this.firstStoredHeight === 1) {
      checkpoint = {
        version: 1,
        chainId: this.chain.genesis.chainId,
        genesisHash: this.chain.genesisHash,
        height: this.persistedHeight,
        tipHash: this.chain.tip.hash,
        blockFileBytes: this.persistedBytes,
        snapshotSha256,
        snapshot
      };
    } else {
      const stateV2 = this.requireDurableStateV2ForPruning();
      checkpoint = {
        version: 2,
        chainId: this.chain.genesis.chainId,
        genesisHash: this.chain.genesisHash,
        height: this.persistedHeight,
        tipHash: this.chain.tip.hash,
        stateV2Root: stateV2.root(),
        retainedFromHeight: this.firstStoredHeight,
        blockFileBytes: this.persistedBytes,
        transition: null,
        snapshotSha256,
        snapshot
      };
    }
    const path = join(this.dataDir, "recovery-checkpoint.json");
    await writeCheckpointFile(path, checkpoint, faultHooks);
    return { height: checkpoint.height, tipHash: checkpoint.tipHash, snapshotSha256 };
  }

  async pruneFinalizedHistory(
    faultHooks: PruneFaultHooks = {},
    retainBlocks = 0
  ): Promise<{ prunedThroughHeight: number; firstStoredHeight: number }> {
    if (this.persistenceFaulted) throw new Error("Persistence fault requires node restart");
    if (this.chain.height !== this.persistedHeight) throw new Error("Cannot prune non-durable chain state");
    if (this.persistedHeight < 1) throw new Error("Cannot prune empty finalized history");
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
      await this.writeRecoveryCheckpoint();
      const loaded = await loadRecoveryCheckpoint(this.chain.genesis, this.dataDir);
      if (!loaded) throw new Error("Verified recovery checkpoint unavailable for pruning");
      const verified = await replayStoredBlocks(this.chain.genesis, blocksPath, loaded);
      if (verified.count !== this.persistedHeight || verified.chain.tip.hash !== this.chain.tip.hash) {
        throw new Error("Recovery checkpoint did not reproduce durable finalized tip");
      }
    } else if (this.pendingPruneThroughHeight > this.persistedHeight) {
      throw new Error("Interrupted prune boundary is invalid for durable finalized tip");
    }

    const snapshot = this.chain.snapshot();
    const snapshotSha256 = sha256Hex(canonicalJson(snapshot));
    const transition: RecoveryCheckpointV2 = {
      version: 2,
      chainId: this.chain.genesis.chainId,
      genesisHash: this.chain.genesisHash,
      height: this.persistedHeight,
      tipHash: this.chain.tip.hash,
      stateV2Root: stateV2.root(),
      retainedFromHeight: targetRetainedFromHeight,
      blockFileBytes: targetBlockFileBytes,
      transition: {
        fromHeight: this.firstStoredHeight,
        blockFileBytes: this.persistedBytes
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

      const stable: RecoveryCheckpointV2 = { ...transition, transition: null };
      await writeCheckpointFile(checkpointPath, stable);
      // Only explicit finalized-history pruning physically discards historical
      // State-v2 objects. The retained current root is fully re-authenticated
      // before one atomic SQLite GC transaction; archival operation never calls it.
      this.stateV2Store.pruneHistoricalObjects();
      return { prunedThroughHeight: pruneThroughHeight, firstStoredHeight: this.firstStoredHeight };
    } catch (error) {
      this.persistenceFaulted = true;
      throw new Error("Pruning interrupted; restart required", { cause: error });
    } finally {
      if (!blocksRenamed) await rm(temporaryBlocks, { force: true });
    }
  }

  private requireDurableStateV2ForPruning() {
    const stateV2 = this.chain.stateV2ForPersistence();
    if (!stateV2) throw new Error("Pruning requires active State v2");
    if (this.stateV2Store.state().root() !== stateV2.root()) {
      throw new Error("Pruning requires State v2 root to match durable finalized state");
    }
    return stateV2;
  }

  async commitFinalizedBlock(
    block: Block,
    nowMs = Date.now(),
    faultHooks: FinalizedBlockFaultHooks = {}
  ): Promise<void> {
    if (this.persistenceFaulted) throw new Error("Persistence fault requires node restart");
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
    try {
      const handle = await open(join(this.dataDir, "blocks.ndjson"), "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
        await faultHooks.afterBlockWrite?.();
        await handle.sync();
        await faultHooks.afterBlockSync?.();
      } finally {
        await handle.close();
      }
    } catch (error) {
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
      } catch (error) {
        this.persistenceFaulted = true;
        throw new Error("State v2 persistence failed after durable block write; restart required", { cause: error });
      }
    }
    this.chain.acceptBlock(block, nowMs);
    this.blockRanges.push({ height: block.header.height, offset: this.persistedBytes, length: lineBytes - 1 });
    this.persistedBytes += lineBytes;
    this.persistedHeight = block.header.height;
  }
}

async function quarantineCorruptStateV2(dataDir: string): Promise<void> {
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
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  await syncDirectory(dataDir);
}

async function loadHistoryRetention(genesis: GenesisConfig, dataDir: string): Promise<HistoryRetentionV1 | undefined> {
  try {
    const value = JSON.parse(await readFile(join(dataDir, "history-retention.json"), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history retention marker");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "chainId,genesisHash,prunedThroughHeight,version" ||
        record.version !== 1 || typeof record.chainId !== "string" || typeof record.genesisHash !== "string" ||
        !Number.isSafeInteger(record.prunedThroughHeight) || Number(record.prunedThroughHeight) < 1) {
      throw new Error("Invalid history retention marker");
    }
    const marker = record as unknown as HistoryRetentionV1;
    const genesisHash = new ZyronChain(genesis).genesisHash;
    if (marker.chainId !== genesis.chainId || marker.genesisHash !== genesisHash) {
      throw new Error("History retention marker belongs to a different chain");
    }
    return marker;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeHistoryRetention(dataDir: string, marker: HistoryRetentionV1): Promise<void> {
  const path = join(dataDir, "history-retention.json");
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(marker)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(dataDir);
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

async function writeCheckpointFile(
  path: string,
  checkpoint: RecoveryCheckpoint,
  faultHooks: RecoveryCheckpointFaultHooks = {}
): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(checkpoint)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await faultHooks.afterTemporarySync?.();
    await rename(temporary, path);
    renamed = true;
    await faultHooks.afterRename?.();
    await syncDirectory(dirname(path));
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

async function copyFileRangeDurably(sourcePath: string, targetPath: string, start: number, end: number): Promise<void> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error("Invalid finalized-history copy range");
  }
  const source = await open(sourcePath, "r");
  let target: Awaited<ReturnType<typeof open>> | undefined;
  try {
    target = await open(targetPath, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, end - start)));
    let position = start;
    while (position < end) {
      const requested = Math.min(buffer.length, end - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (bytesRead !== requested) throw new Error("Finalized block storage changed during pruning");
      await target.write(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    await target.sync();
  } finally {
    await source.close();
    await target?.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class SigningJournal {
  private readonly reservations = new Map<string, string>();
  private persistenceFaulted = false;
  private closed = false;
  private constructor(
    readonly path: string,
    private readonly leaseDatabase: Database.Database
  ) {}

  static async open(
    dataDir: string,
    faultHooks: SigningJournalOpenFaultHooks = {}
  ): Promise<SigningJournal> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const leaseDatabase = acquireSigningJournalLease(join(dataDir, "signing-journal.lock.sqlite"));
    const journal = new SigningJournal(join(dataDir, "signing-journal.ndjson"), leaseDatabase);
    try {
      try {
        for await (const line of readLines(journal.path)) {
          if (!line.trim()) continue;
          if (Buffer.byteLength(line, "utf8") > MAX_SIGNING_LINE_BYTES) throw new Error("Corrupt signing journal");
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (!Number.isSafeInteger(parsed.height) || !Number.isSafeInteger(parsed.round) ||
              (parsed.kind !== "attest" && parsed.kind !== "skip") ||
              typeof parsed.value !== "string" || !/^[0-9a-f]{64}$/.test(parsed.value)) {
            throw new Error("Corrupt signing journal entry");
          }
          const key = `${parsed.height}:${parsed.round}`;
          const reservation = `${parsed.kind}:${parsed.value}`;
          const previous = journal.reservations.get(key);
          if (previous && previous !== reservation) throw new Error("Conflicting signing journal history");
          journal.reservations.set(key, reservation);
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        const handle = await open(journal.path, "wx", 0o600);
        try {
          await handle.sync();
          await faultHooks.afterFileSync?.();
        } finally {
          await handle.close();
        }
      }
      await syncDirectory(dirname(journal.path));
      await faultHooks.afterDirectorySync?.();
      return journal;
    } catch (error) {
      journal.close();
      throw new Error("Signing journal initialization persistence failed", { cause: error });
    }
  }

  get persistenceHealthy(): boolean {
    return !this.persistenceFaulted;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.leaseDatabase.exec("ROLLBACK");
    } finally {
      this.leaseDatabase.close();
    }
  }

  async reserveAttestation(
    height: number,
    round: number,
    blockHash: string,
    faultHooks: SigningJournalFaultHooks = {}
  ): Promise<void> {
    return this.reserveChoice(height, round, "attest", blockHash, faultHooks);
  }

  async reserveSkip(
    height: number,
    round: number,
    previousHash: string,
    faultHooks: SigningJournalFaultHooks = {}
  ): Promise<void> {
    return this.reserveChoice(height, round, "skip", previousHash, faultHooks);
  }

  async compactThrough(
    finalizedHeight: number,
    faultHooks: SigningJournalCompactionFaultHooks = {}
  ): Promise<number> {
    if (this.closed) throw new Error("Signing journal is closed");
    if (this.persistenceFaulted) throw new Error("Signing journal persistence fault requires validator restart");
    if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight < 0) throw new Error("Invalid signing journal compaction height");

    const retained: Array<{ key: string; height: number; round: number; kind: "attest" | "skip"; value: string }> = [];
    const removedKeys: string[] = [];
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
      if (height <= finalizedHeight) removedKeys.push(key);
      else retained.push({ key, height, round, kind, value });
    }
    if (removedKeys.length === 0) return 0;

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
        await handle.sync();
      } finally {
        await handle.close();
      }
      await faultHooks.afterTemporarySync?.();
      await rename(temporary, this.path);
      renamed = true;
      await faultHooks.afterRename?.();
      await syncDirectory(dirname(this.path));
    } catch (error) {
      this.persistenceFaulted = true;
      throw new Error("Signing journal compaction failed; validator restart required", { cause: error });
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }

    for (const key of removedKeys) this.reservations.delete(key);
    return removedKeys.length;
  }

  private async reserveChoice(
    height: number,
    round: number,
    kind: "attest" | "skip",
    value: string,
    faultHooks: SigningJournalFaultHooks
  ): Promise<void> {
    if (this.closed) throw new Error("Signing journal is closed");
    if (this.persistenceFaulted) throw new Error("Signing journal persistence fault requires validator restart");
    if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(round) || round < 0) {
      throw new Error("Invalid signing slot");
    }
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid signing hash");
    const key = `${height}:${round}`;
    const reservation = `${kind}:${value}`;
    const existing = this.reservations.get(key);
    if (existing === reservation) return;
    if (existing) throw new Error("Conflicting validator action prevented for consensus round");

    const line = `${JSON.stringify({ height, round, kind, value })}\n`;
    try {
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
        await faultHooks.afterWrite?.();
        await handle.sync();
        await faultHooks.afterSync?.();
      } finally {
        await handle.close();
      }
    } catch (error) {
      // The validator must never guess whether a reservation became durable.
      // A retry after an ambiguous append/fsync/close could release a signature
      // for a conflicting choice in the same consensus slot. Fail-stop this
      // journal instance; startup replay is the only safe recovery boundary.
      this.persistenceFaulted = true;
      throw new Error("Signing journal persistence failed; validator restart required", { cause: error });
    }
    this.reservations.set(key, reservation);
  }
}

function acquireSigningJournalLease(path: string): Database.Database {
  const database = new Database(path, { timeout: 0 });
  try {
    // Hold an OS-backed SQLite exclusive transaction for the complete journal
    // lifetime. A process crash releases the filesystem lock automatically, so
    // there is no stale PID/lockfile that an operator might incorrectly clear.
    database.pragma("journal_mode = DELETE");
    database.exec("BEGIN EXCLUSIVE");
    return database;
  } catch (error) {
    database.close();
    throw new Error("Signing journal data directory already has an active validator writer", { cause: error });
  }
}

interface LoadedRecoveryCheckpoint {
  checkpoint: RecoveryCheckpoint;
  chain: ZyronChain;
}

async function loadRecoveryCheckpoint(genesis: GenesisConfig, dataDir: string): Promise<LoadedRecoveryCheckpoint | undefined> {
  try {
    const value = JSON.parse(await readFile(join(dataDir, "recovery-checkpoint.json"), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recovery checkpoint");
    const record = value as Record<string, unknown>;
    const commonValid = typeof record.chainId === "string" && typeof record.genesisHash === "string" &&
      typeof record.tipHash === "string" && typeof record.snapshotSha256 === "string" &&
      Number.isSafeInteger(record.height) && Number(record.height) >= 0 &&
      Number.isSafeInteger(record.blockFileBytes) && Number(record.blockFileBytes) >= 0;
    if (!commonValid) {
      throw new Error("Invalid recovery checkpoint");
    }
    let checkpoint: RecoveryCheckpoint;
    if (record.version === 1) {
      const expectedKeys = [
        "version", "chainId", "genesisHash", "height", "tipHash", "blockFileBytes", "snapshotSha256", "snapshot"
      ].sort().join(",");
      if (Object.keys(record).sort().join(",") !== expectedKeys) throw new Error("Invalid recovery checkpoint");
      checkpoint = record as unknown as RecoveryCheckpointV1;
    } else if (record.version === 2) {
      const expectedKeys = [
        "version", "chainId", "genesisHash", "height", "tipHash", "stateV2Root", "retainedFromHeight",
        "blockFileBytes", "transition", "snapshotSha256", "snapshot"
      ].sort().join(",");
      const transition = record.transition;
      const transitionValid = transition === null || (
        typeof transition === "object" && !Array.isArray(transition) && transition !== null &&
        Object.keys(transition).sort().join(",") === "blockFileBytes,fromHeight" &&
        Number.isSafeInteger((transition as Record<string, unknown>).fromHeight) &&
        Number((transition as Record<string, unknown>).fromHeight) >= 1 &&
        Number.isSafeInteger((transition as Record<string, unknown>).blockFileBytes) &&
        Number((transition as Record<string, unknown>).blockFileBytes) >= 0
      );
      if (Object.keys(record).sort().join(",") !== expectedKeys || typeof record.stateV2Root !== "string" ||
          !/^[0-9a-f]{64}$/.test(record.stateV2Root) || !Number.isSafeInteger(record.retainedFromHeight) ||
          Number(record.retainedFromHeight) < 1 || Number(record.retainedFromHeight) > Number(record.height) + 1 ||
          !transitionValid) {
        throw new Error("Invalid recovery checkpoint");
      }
      checkpoint = record as unknown as RecoveryCheckpointV2;
      if (checkpoint.transition && (checkpoint.transition.fromHeight >= checkpoint.retainedFromHeight ||
          checkpoint.transition.fromHeight > checkpoint.height)) {
        throw new Error("Invalid recovery checkpoint transition");
      }
    } else {
      throw new Error("Invalid recovery checkpoint version");
    }
    if (checkpoint.chainId !== genesis.chainId || checkpoint.height !== (checkpoint.snapshot as { height?: unknown }).height ||
        checkpoint.tipHash !== (checkpoint.snapshot as { tip?: { hash?: unknown } }).tip?.hash) {
      throw new Error("Recovery checkpoint metadata mismatch");
    }
    const chain = ZyronChain.fromTrustedSnapshot(genesis, checkpoint.snapshot, {
      tipHash: checkpoint.tipHash,
      snapshotSha256: checkpoint.snapshotSha256
    });
    if (checkpoint.genesisHash !== chain.genesisHash) throw new Error("Recovery checkpoint genesis mismatch");
    if (checkpoint.height === 0 && checkpoint.blockFileBytes !== 0) throw new Error("Invalid genesis recovery boundary");
    if (checkpoint.version === 2) {
      const stateV2 = chain.stateV2ForPersistence();
      if (!stateV2 || checkpoint.stateV2Root !== stateV2.root() || checkpoint.stateV2Root !== chain.tip.header.stateRoot) {
        throw new Error("Recovery checkpoint State v2 root mismatch");
      }
      if (checkpoint.retainedFromHeight === checkpoint.height + 1 && checkpoint.blockFileBytes !== 0) {
        throw new Error("Invalid empty retained-history boundary");
      }
    }
    return { checkpoint, chain };
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    // Recovery metadata is an optimization, never the authority. Corrupt or
    // partially published metadata safely disables it and full replay takes over.
    return undefined;
  }
}

async function replayStoredBlocks(
  genesis: GenesisConfig,
  blocksPath: string,
  loaded?: LoadedRecoveryCheckpoint
): Promise<{
  chain: ZyronChain;
  count: number;
  offset: number;
  blockRanges: StoredBlockRange[];
  recoveredHeight: number;
}> {
  const chain = loaded?.chain ?? new ZyronChain(genesis);
  const checkpoint = loaded?.checkpoint;
  let checkpointVerified = checkpoint?.height === 0;
  let count = 0;
  let offset = 0;
  let layoutDetermined = checkpoint?.version !== 2;
  let checkpointBoundaryBytes = checkpoint?.blockFileBytes ?? 0;
  const blockRanges: StoredBlockRange[] = [];
  for await (const line of readLines(blocksPath)) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (!line.trim()) {
      offset += lineBytes + 1;
      continue;
    }
    if (lineBytes > MAX_STORED_BLOCK_LINE_BYTES) throw new Error("Stored block exceeds line limit");
    let parsed: unknown;
    if (checkpoint?.version === 2 && !layoutDetermined) {
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("Corrupt stored block at retained-history boundary");
      }
      const firstHeight = (parsed as { header?: { height?: unknown } }).header?.height;
      if (firstHeight === checkpoint.retainedFromHeight) {
        count = checkpoint.retainedFromHeight - 1;
        checkpointBoundaryBytes = checkpoint.blockFileBytes;
        checkpointVerified = checkpoint.retainedFromHeight === checkpoint.height + 1;
      } else if (checkpoint.transition && firstHeight === checkpoint.transition.fromHeight) {
        count = checkpoint.transition.fromHeight - 1;
        checkpointBoundaryBytes = checkpoint.transition.blockFileBytes;
      } else {
        throw new Error("Finalized history does not match checkpoint retention boundary");
      }
      layoutDetermined = true;
    }
    const height = count + 1;
    blockRanges.push({ height, offset, length: lineBytes });

    if (checkpoint && height < checkpoint.height) {
      count = height;
      offset += lineBytes + 1;
      continue;
    }

    if (parsed === undefined) {
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Corrupt stored block at line ${height}`);
      }
    }
    if (checkpoint && height === checkpoint.height) {
      if (offset + lineBytes + 1 !== checkpointBoundaryBytes || canonicalJson(parsed) !== canonicalJson(checkpoint.snapshot.tip)) {
        throw new Error("Recovery checkpoint does not match finalized block log");
      }
      checkpointVerified = true;
    } else {
      chain.acceptBlock(parsed as Block, Number.MAX_SAFE_INTEGER);
    }
    count = height;
    offset += lineBytes + 1;
    if ((!checkpoint || height > checkpoint.height) && chain.height !== count) {
      throw new Error("Stored block height discontinuity");
    }
  }
  if (checkpoint?.version === 2 && !layoutDetermined) {
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
  if (checkpoint?.version === 1 && checkpoint.blockFileBytes > offset) {
    throw new Error("Recovery checkpoint is ahead of finalized block log");
  }
  if (chain.height !== count) throw new Error("Stored block height discontinuity");
  return { chain, count, offset, blockRanges, recoveredHeight: checkpoint?.height ?? 0 };
}

async function ensureMetadata(path: string, expected: StoreMetadata): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as Partial<StoreMetadata>;
    if (existing.version !== expected.version || existing.chainId !== expected.chainId ||
        existing.genesisHash !== expected.genesisHash) {
      throw new Error("Data directory belongs to a different or unsupported chain");
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(expected)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
}

async function* readLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
    input.destroy();
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  throw new Error("Trusted snapshot target data directory already exists");
}