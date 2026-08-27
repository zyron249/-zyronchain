import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { peerIdFromString } from "@libp2p/peer-id";

import { readBoundedUtf8File } from "./bounded-file.js";
import { canonicalJson } from "./codec.js";
import { assertBoundedNativeReputationJsonStructure } from "./p2p-reputation-json-complexity.js";

const VERSION = 1;
const MAX_ENTRIES = 256;
const MAX_FAILURES = 32;
const BASE_TRANSIENT_BACKOFF_MS = 30_000;
const MAX_TRANSIENT_BACKOFF_MS = 30 * 60_000;
const PROTOCOL_BAN_MS = 30 * 60_000;
export const MAX_NATIVE_REPUTATION_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export type NativePeerFailureKind = "transient" | "protocol";

interface Entry {
  peerId: string;
  consecutiveFailures: number;
  backoffUntilMs: number;
  lastFailureMs: number;
  lastSuccessMs: number;
  lastFailureKind: NativePeerFailureKind | "none";
}

interface Snapshot { version: 1; peers: Entry[] }

export class NativePeerReputationStore {
  private readonly entries = new Map<string, Entry>();
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {}

  static async open(dataDir: string): Promise<NativePeerReputationStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const store = new NativePeerReputationStore(join(dataDir, "native-peer-reputation.json"));
    try {
      const text = await readBoundedUtf8File(
        store.path,
        MAX_NATIVE_REPUTATION_SNAPSHOT_BYTES,
        "Native peer reputation snapshot"
      );
      assertBoundedNativeReputationJsonStructure(text);
      const snapshot = validateSnapshot(JSON.parse(text) as unknown);
      for (const entry of snapshot.peers) store.entries.set(entry.peerId, entry);
    } catch (error) {
      if (!isMissingFile(error)) throw new Error("Corrupt native peer reputation store", { cause: error });
    }
    return store;
  }

  isAvailable(peerId: string, nowMs = Date.now()): boolean {
    validatePeerId(peerId);
    assertTimestamp(nowMs);
    const tracked = this.entries.get(peerId);
    if (tracked) return tracked.backoffUntilMs <= nowMs;
    if (this.entries.size < MAX_ENTRIES) return true;
    return this.reclaimableEntry(nowMs) !== undefined;
  }

  failureCount(peerId: string): number {
    validatePeerId(peerId);
    return this.entries.get(peerId)?.consecutiveFailures ?? 0;
  }

  async recordFailure(peerId: string, kind: NativePeerFailureKind, nowMs = Date.now()): Promise<number> {
    validatePeerId(peerId);
    assertTimestamp(nowMs);
    if (kind !== "transient" && kind !== "protocol") throw new Error("Invalid native peer failure kind");
    return this.exclusive(async () => {
      const previous = this.entries.get(peerId);
      const consecutiveFailures = Math.min(MAX_FAILURES, (previous?.consecutiveFailures ?? 0) + 1);
      const penalty = kind === "protocol"
        ? PROTOCOL_BAN_MS
        : Math.min(MAX_TRANSIENT_BACKOFF_MS, BASE_TRANSIENT_BACKOFF_MS * (2 ** Math.min(20, consecutiveFailures - 1)));
      if (!previous && !this.ensureSlot(nowMs)) return penalty;
      this.entries.set(peerId, {
        peerId,
        consecutiveFailures,
        backoffUntilMs: nowMs + penalty,
        lastFailureMs: nowMs,
        lastSuccessMs: previous?.lastSuccessMs ?? 0,
        lastFailureKind: kind
      });
      await this.persist();
      return penalty;
    });
  }

  async recordSuccess(peerId: string, nowMs = Date.now()): Promise<void> {
    validatePeerId(peerId);
    assertTimestamp(nowMs);
    await this.exclusive(async () => {
      const previous = this.entries.get(peerId);
      if (!previous && !this.ensureSlot(nowMs)) return;
      this.entries.set(peerId, {
        peerId,
        consecutiveFailures: 0,
        backoffUntilMs: 0,
        lastFailureMs: previous?.lastFailureMs ?? 0,
        lastSuccessMs: nowMs,
        lastFailureKind: "none"
      });
      await this.persist();
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private ensureSlot(nowMs: number): boolean {
    if (this.entries.size < MAX_ENTRIES) return true;
    const reclaimable = this.reclaimableEntry(nowMs);
    if (!reclaimable) return false;
    this.entries.delete(reclaimable.peerId);
    return true;
  }

  private reclaimableEntry(nowMs: number): Entry | undefined {
    let selected: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.backoffUntilMs > nowMs) continue;
      if (!selected || compareEntryAge(entry, selected) < 0) selected = entry;
    }
    return selected;
  }

  private async persist(): Promise<void> {
    const snapshot: Snapshot = { version: 1, peers: [...this.entries.values()].sort((a, b) => a.peerId.localeCompare(b.peerId)) };
    const serialized = `${canonicalJson(snapshot)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_NATIVE_REPUTATION_SNAPSHOT_BYTES) {
      throw new Error("Native peer reputation snapshot exceeds persistence byte limit");
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
      await rename(temporary, this.path);
      renamed = true;
      if (nativePeerReputationDirectorySyncSupported()) {
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }
}

export function nativePeerReputationDirectorySyncSupported(platform = process.platform): boolean {
  return platform !== "win32";
}

export function classifyNativePeerFailure(error: unknown): NativePeerFailureKind {
  const message = error instanceof Error ? `${error.name} ${error.message}` : "";
  return /timeout|abort|ECONN|connect|dial|stream|reset|closed/i.test(message) ? "transient" : "protocol";
}

function compareEntryAge(a: Entry, b: Entry): number {
  const byActivity = Math.max(a.lastFailureMs, a.lastSuccessMs) - Math.max(b.lastFailureMs, b.lastSuccessMs);
  return byActivity !== 0 ? byActivity : a.peerId.localeCompare(b.peerId);
}

function validateSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native reputation snapshot");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "peers,version" || record.version !== VERSION || !Array.isArray(record.peers) || record.peers.length > MAX_ENTRIES) {
    throw new Error("Invalid native reputation snapshot");
  }
  const seen = new Set<string>();
  const peers = record.peers.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid native reputation entry");
    const entry = candidate as Record<string, unknown>;
    const keys = "backoffUntilMs,consecutiveFailures,lastFailureKind,lastFailureMs,lastSuccessMs,peerId";
    if (Object.keys(entry).sort().join(",") !== keys || typeof entry.peerId !== "string") throw new Error("Invalid native reputation entry");
    validatePeerId(entry.peerId);
    if (seen.has(entry.peerId)) throw new Error("Duplicate native reputation peer");
    seen.add(entry.peerId);
    for (const key of ["consecutiveFailures", "backoffUntilMs", "lastFailureMs", "lastSuccessMs"] as const) {
      if (!Number.isSafeInteger(entry[key]) || Number(entry[key]) < 0) throw new Error("Invalid native reputation counter");
    }
    if (Number(entry.consecutiveFailures) > MAX_FAILURES || !["none", "transient", "protocol"].includes(String(entry.lastFailureKind))) {
      throw new Error("Invalid native reputation state");
    }
    return entry as unknown as Entry;
  });
  return { version: 1, peers };
}

function validatePeerId(value: string): void {
  if (value.length < 1 || value.length > 256) throw new Error("Invalid native reputation PeerId");
  try { peerIdFromString(value); } catch { throw new Error("Invalid native reputation PeerId"); }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid native reputation timestamp");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
