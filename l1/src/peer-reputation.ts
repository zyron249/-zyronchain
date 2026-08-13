import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readBoundedUtf8File } from "./bounded-file.js";
import { canonicalJson } from "./codec.js";

const REPUTATION_VERSION = 1;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_FAILURE_COUNT = 32;
const MAX_STORED_PEERS = 256;
export const MAX_PEER_REPUTATION_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_PEER_REPUTATION_ENDPOINT_BYTES = 4 * 1024;

export interface PeerReputationPersistenceFaultHooks {
  afterTemporarySync?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
  afterDirectorySync?: () => void | Promise<void>;
}

interface PeerReputationEntry {
  endpoint: string;
  consecutiveFailures: number;
  backoffUntilMs: number;
  lastFailureMs: number;
  lastSuccessMs: number;
}

interface PeerReputationSnapshot {
  version: 1;
  peers: PeerReputationEntry[];
}

export class PeerReputationStore {
  private readonly entries = new Map<string, PeerReputationEntry>();
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {}

  static async open(dataDir: string): Promise<PeerReputationStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const store = new PeerReputationStore(join(dataDir, "peer-reputation.json"));
    try {
      const text = await readBoundedUtf8File(
        store.path,
        MAX_PEER_REPUTATION_SNAPSHOT_BYTES,
        "Peer reputation snapshot"
      );
      const value = JSON.parse(text) as unknown;
      const snapshot = validateSnapshot(value);
      for (const entry of snapshot.peers) store.entries.set(entry.endpoint, entry);
    } catch (error) {
      if (!isMissingFile(error)) throw new Error("Corrupt peer reputation store", { cause: error });
    }
    return store;
  }

  isAvailable(endpoint: string, nowMs = Date.now()): boolean {
    assertTimestamp(nowMs);
    const normalized = normalizeEndpoint(endpoint);
    const tracked = this.entries.get(normalized);
    if (tracked) return tracked.backoffUntilMs <= nowMs;
    if (this.entries.size < MAX_STORED_PEERS) return true;
    return this.reclaimableEntry(nowMs) !== undefined;
  }

  failureCount(endpoint: string): number {
    return this.entries.get(normalizeEndpoint(endpoint))?.consecutiveFailures ?? 0;
  }

  async recordFailure(
    endpoint: string,
    nowMs = Date.now(),
    faultHooks: PeerReputationPersistenceFaultHooks = {}
  ): Promise<number> {
    assertTimestamp(nowMs);
    const normalized = normalizeEndpoint(endpoint);
    return this.exclusive(async () => {
      const previous = this.entries.get(normalized);
      const consecutiveFailures = Math.min(MAX_FAILURE_COUNT, (previous?.consecutiveFailures ?? 0) + 1);
      const backoffMs = failureBackoffMs(consecutiveFailures);
      if (!previous && !this.ensureSlot(nowMs)) return backoffMs;
      this.entries.set(normalized, {
        endpoint: normalized,
        consecutiveFailures,
        backoffUntilMs: nowMs + backoffMs,
        lastFailureMs: nowMs,
        lastSuccessMs: previous?.lastSuccessMs ?? 0
      });
      await this.persist(faultHooks);
      return backoffMs;
    });
  }

  async recordSuccess(
    endpoint: string,
    nowMs = Date.now(),
    faultHooks: PeerReputationPersistenceFaultHooks = {}
  ): Promise<void> {
    assertTimestamp(nowMs);
    const normalized = normalizeEndpoint(endpoint);
    await this.exclusive(async () => {
      const previous = this.entries.get(normalized);
      if (!previous && !this.ensureSlot(nowMs)) return;
      this.entries.set(normalized, {
        endpoint: normalized,
        consecutiveFailures: 0,
        backoffUntilMs: 0,
        lastFailureMs: previous?.lastFailureMs ?? 0,
        lastSuccessMs: nowMs
      });
      await this.persist(faultHooks);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private ensureSlot(nowMs: number): boolean {
    if (this.entries.size < MAX_STORED_PEERS) return true;
    const reclaimable = this.reclaimableEntry(nowMs);
    if (!reclaimable) return false;
    this.entries.delete(reclaimable.endpoint);
    return true;
  }

  private reclaimableEntry(nowMs: number): PeerReputationEntry | undefined {
    let selected: PeerReputationEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.backoffUntilMs > nowMs) continue;
      if (!selected || compareEntryAge(entry, selected) < 0) selected = entry;
    }
    return selected;
  }

  private async persist(faultHooks: PeerReputationPersistenceFaultHooks): Promise<void> {
    const snapshot: PeerReputationSnapshot = {
      version: REPUTATION_VERSION,
      peers: [...this.entries.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint))
    };
    const serialized = `${canonicalJson(snapshot)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_PEER_REPUTATION_SNAPSHOT_BYTES) {
      throw new Error("Peer reputation snapshot exceeds persistence byte limit");
    }
    const temporary = `${this.path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    let renamed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await faultHooks.afterTemporarySync?.();
      await rename(temporary, this.path);
      renamed = true;
      await faultHooks.afterRename?.();
      if (httpPeerReputationDirectorySyncSupported()) {
        const directory = await open(dirname(this.path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        await faultHooks.afterDirectorySync?.();
      }
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }
}

export function httpPeerReputationDirectorySyncSupported(platform = process.platform): boolean {
  return platform !== "win32";
}

export function failureBackoffMs(consecutiveFailures: number): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 1) throw new Error("Invalid peer failure count");
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** Math.min(20, consecutiveFailures - 1)));
}

function compareEntryAge(a: PeerReputationEntry, b: PeerReputationEntry): number {
  const byActivity = Math.max(a.lastFailureMs, a.lastSuccessMs) - Math.max(b.lastFailureMs, b.lastSuccessMs);
  return byActivity !== 0 ? byActivity : a.endpoint.localeCompare(b.endpoint);
}

function validateSnapshot(value: unknown): PeerReputationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid peer reputation snapshot");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "peers,version" || record.version !== REPUTATION_VERSION || !Array.isArray(record.peers)) {
    throw new Error("Invalid peer reputation snapshot");
  }
  if (record.peers.length > MAX_STORED_PEERS) throw new Error("Peer reputation snapshot exceeds entry limit");
  const seen = new Set<string>();
  const peers = record.peers.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid peer reputation entry");
    const entry = candidate as Record<string, unknown>;
    const expectedKeys = "backoffUntilMs,consecutiveFailures,endpoint,lastFailureMs,lastSuccessMs";
    if (Object.keys(entry).sort().join(",") !== expectedKeys || typeof entry.endpoint !== "string") {
      throw new Error("Invalid peer reputation entry");
    }
    const endpoint = normalizeEndpoint(entry.endpoint);
    if (endpoint !== entry.endpoint || seen.has(endpoint)) throw new Error("Invalid peer reputation endpoint");
    seen.add(endpoint);
    for (const key of ["consecutiveFailures", "backoffUntilMs", "lastFailureMs", "lastSuccessMs"] as const) {
      if (!Number.isSafeInteger(entry[key]) || Number(entry[key]) < 0) throw new Error("Invalid peer reputation counter");
    }
    if (Number(entry.consecutiveFailures) > MAX_FAILURE_COUNT) throw new Error("Invalid peer failure count");
    return entry as unknown as PeerReputationEntry;
  });
  return { version: 1, peers };
}

function normalizeEndpoint(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_PEER_REPUTATION_ENDPOINT_BYTES) {
    throw new Error("Peer reputation endpoint exceeds byte limit");
  }
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid peer reputation endpoint");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  const normalized = url.toString().replace(/\/$/, "");
  if (Buffer.byteLength(normalized, "utf8") > MAX_PEER_REPUTATION_ENDPOINT_BYTES) {
    throw new Error("Peer reputation endpoint exceeds byte limit");
  }
  return normalized;
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid peer reputation timestamp");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
