import { validateSignedPeerRecord, type SignedPeerRecord } from "./peer-identity.js";

export const MAX_DISCOVERED_PEERS = 256;
export const MAX_DISCOVERY_RESPONSE_RECORDS = 32;
export const MAX_DISCOVERY_RECORDS_PER_SOURCE = MAX_DISCOVERY_RESPONSE_RECORDS;
const MAX_DISCOVERY_SOURCE_BYTES = 4 * 1024;

export interface PeerDirectoryLimits {
  maxRecords?: number;
  maxResponseRecords?: number;
  maxRecordsPerSource?: number;
}

export class PeerDirectory {
  private readonly records = new Map<string, SignedPeerRecord>();
  private readonly sourceByNodeId = new Map<string, string>();
  private readonly sourceCounts = new Map<string, number>();
  private readonly maxRecords: number;
  private readonly maxResponseRecords: number;
  private readonly maxRecordsPerSource: number;

  constructor(
    private readonly expected: { chainId: string; genesisHash: string },
    limits: PeerDirectoryLimits = {}
  ) {
    this.maxRecords = boundedLimit(limits.maxRecords ?? MAX_DISCOVERED_PEERS, MAX_DISCOVERED_PEERS, "peer directory");
    this.maxResponseRecords = boundedLimit(
      limits.maxResponseRecords ?? MAX_DISCOVERY_RESPONSE_RECORDS,
      MAX_DISCOVERY_RESPONSE_RECORDS,
      "peer discovery response"
    );
    const maxPerSource = Math.min(MAX_DISCOVERY_RECORDS_PER_SOURCE, this.maxResponseRecords, this.maxRecords);
    this.maxRecordsPerSource = boundedLimit(
      limits.maxRecordsPerSource ?? maxPerSource,
      maxPerSource,
      "peer discovery source"
    );
  }

  get size(): number {
    return this.records.size;
  }

  admit(value: unknown, nowMs = Date.now(), source?: string): boolean {
    this.pruneExpired(nowMs);
    const record = validateSignedPeerRecord(value, this.expected, nowMs);
    const existing = this.records.get(record.nodeId);
    if (existing) {
      if (record.publicKey !== existing.publicKey) throw new Error("Peer node identity changed public key");
      if (record.issuedAtMs <= existing.issuedAtMs) return false;
      this.records.set(record.nodeId, record);
      return true;
    }
    if (this.records.size >= this.maxRecords) throw new Error("Peer directory capacity reached");
    if (source !== undefined) {
      validateSource(source);
      if ((this.sourceCounts.get(source) ?? 0) >= this.maxRecordsPerSource) {
        throw new Error("Peer directory source capacity reached");
      }
    }
    this.records.set(record.nodeId, record);
    if (source !== undefined) {
      this.sourceByNodeId.set(record.nodeId, source);
      this.sourceCounts.set(source, (this.sourceCounts.get(source) ?? 0) + 1);
    }
    return true;
  }

  list(limit = this.maxResponseRecords, nowMs = Date.now()): SignedPeerRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxResponseRecords) {
      throw new Error("Invalid peer discovery response limit");
    }
    this.pruneExpired(nowMs);
    return [...this.records.values()]
      .sort((a, b) => b.issuedAtMs - a.issuedAtMs || a.nodeId.localeCompare(b.nodeId))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  private pruneExpired(nowMs: number): void {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid peer directory time");
    for (const [nodeId, record] of this.records) {
      if (record.expiresAtMs > nowMs) continue;
      this.records.delete(nodeId);
      const source = this.sourceByNodeId.get(nodeId);
      if (source === undefined) continue;
      this.sourceByNodeId.delete(nodeId);
      const remaining = (this.sourceCounts.get(source) ?? 1) - 1;
      if (remaining > 0) this.sourceCounts.set(source, remaining);
      else this.sourceCounts.delete(source);
    }
  }
}

function boundedLimit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${label} limit`);
  }
  return value;
}

function validateSource(value: string): void {
  if (value.length < 1 || Buffer.byteLength(value, "utf8") > MAX_DISCOVERY_SOURCE_BYTES) {
    throw new Error("Invalid peer discovery source");
  }
}
