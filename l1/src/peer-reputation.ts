import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "./codec.js";

const REPUTATION_VERSION = 1;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_FAILURE_COUNT = 32;
const MAX_STORED_PEERS = 256;

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
      const value = JSON.parse(await readFile(store.path, "utf8")) as unknown;
      const snapshot = validateSnapshot(value);
      for (const entry of snapshot.peers) store.entries.set(entry.endpoint, entry);
    } catch (error) {
      if (!isMissingFile(error)) throw new Error("Corrupt peer reputation store", { cause: error });
    }
    return store;
  }

  isAvailable(endpoint: string, nowMs = Date.now()): boolean {
    return (this.entries.get(normalizeEndpoint(endpoint))?.backoffUntilMs ?? 0) <= nowMs;
  }

  failureCount(endpoint: string): number {
    return this.entries.get(normalizeEndpoint(endpoint))?.consecutiveFailures ?? 0;
  }

  async recordFailure(endpoint: string, nowMs = Date.now()): Promise<number> {
    const normalized = normalizeEndpoint(endpoint);
    return this.exclusive(async () => {
      const previous = this.entries.get(normalized);
      const consecutiveFailures = Math.min(MAX_FAILURE_COUNT, (previous?.consecutiveFailures ?? 0) + 1);
      const backoffMs = failureBackoffMs(consecutiveFailures);
      this.entries.set(normalized, {
        endpoint: normalized,
        consecutiveFailures,
        backoffUntilMs: nowMs + backoffMs,
        lastFailureMs: nowMs,
        lastSuccessMs: previous?.lastSuccessMs ?? 0
      });
      this.prune();
      await this.persist();
      return backoffMs;
    });
  }

  async recordSuccess(endpoint: string, nowMs = Date.now()): Promise<void> {
    const normalized = normalizeEndpoint(endpoint);
    await this.exclusive(async () => {
      const previous = this.entries.get(normalized);
      this.entries.set(normalized, {
        endpoint: normalized,
        consecutiveFailures: 0,
        backoffUntilMs: 0,
        lastFailureMs: previous?.lastFailureMs ?? 0,
        lastSuccessMs: nowMs
      });
      this.prune();
      await this.persist();
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

  private prune(): void {
    if (this.entries.size <= MAX_STORED_PEERS) return;
    const oldest = [...this.entries.values()]
      .sort((a, b) => Math.max(a.lastFailureMs, a.lastSuccessMs) - Math.max(b.lastFailureMs, b.lastSuccessMs));
    for (const entry of oldest.slice(0, this.entries.size - MAX_STORED_PEERS)) this.entries.delete(entry.endpoint);
  }

  private async persist(): Promise<void> {
    const snapshot: PeerReputationSnapshot = {
      version: REPUTATION_VERSION,
      peers: [...this.entries.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint))
    };
    const temporary = `${this.path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(snapshot)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }
}

export function failureBackoffMs(consecutiveFailures: number): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 1) throw new Error("Invalid peer failure count");
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** Math.min(20, consecutiveFailures - 1)));
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
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid peer reputation endpoint");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
