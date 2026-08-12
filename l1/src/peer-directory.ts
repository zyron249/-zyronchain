import { validateSignedPeerRecord, type SignedPeerRecord } from "./peer-identity.js";

export const MAX_DISCOVERED_PEERS = 256;
export const MAX_DISCOVERY_RESPONSE_RECORDS = 32;

export interface PeerDirectoryLimits {
  maxRecords?: number;
  maxResponseRecords?: number;
}

export class PeerDirectory {
  private readonly records = new Map<string, SignedPeerRecord>();
  private readonly maxRecords: number;
  private readonly maxResponseRecords: number;

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
  }

  get size(): number {
    return this.records.size;
  }

  admit(value: unknown, nowMs = Date.now()): boolean {
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
    this.records.set(record.nodeId, record);
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
      if (record.expiresAtMs <= nowMs) this.records.delete(nodeId);
    }
  }
}

function boundedLimit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${label} limit`);
  }
  return value;
}
