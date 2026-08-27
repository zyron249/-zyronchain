import { canonicalJson } from "./codec.js";
import { miningWorkHash } from "./mining.js";
import type { MiningClaimTx, Transaction } from "./types.js";

const REPLACEMENT_BUMP_NUMERATOR = 11n;
const REPLACEMENT_BUMP_DENOMINATOR = 10n;
export const MAX_MINING_MEMPOOL_CLAIMS = 256;
export const DEFAULT_MEMPOOL_NON_MINING_CAPACITY = 10_000;
export const DEFAULT_MEMPOOL_NON_MINING_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MINING_MEMPOOL_MAX_BYTES = 4 * 1024 * 1024;

type EvictionCandidate = { txid: string; tx: Transaction };

export class Mempool {
  private readonly byId = new Map<string, Transaction>();
  private readonly nonceIds = new Map<string, string>();
  private readonly transferSpendBySender = new Map<string, bigint>();
  private readonly maxNonMiningSize: number;
  private readonly miningReserve: number;
  private readonly maxNonMiningBytes: number;
  private readonly maxMiningBytes: number;
  private miningSize = 0;
  private nonMiningSize = 0;
  private miningBytes = 0;
  private nonMiningBytes = 0;
  private nonMiningEvictionCacheValid = false;
  private nonMiningEvictionCache: EvictionCandidate | undefined;

  constructor(
    maxNonMiningSize?: number,
    miningReserve?: number,
    maxNonMiningBytes = DEFAULT_MEMPOOL_NON_MINING_MAX_BYTES,
    maxMiningBytes = DEFAULT_MINING_MEMPOOL_MAX_BYTES
  ) {
    this.maxNonMiningSize = maxNonMiningSize ?? DEFAULT_MEMPOOL_NON_MINING_CAPACITY;
    this.miningReserve = miningReserve ?? (maxNonMiningSize === undefined ? MAX_MINING_MEMPOOL_CLAIMS : 0);
    this.maxNonMiningBytes = maxNonMiningBytes;
    this.maxMiningBytes = maxMiningBytes;
    if (!Number.isSafeInteger(this.maxNonMiningSize) || this.maxNonMiningSize < 1) {
      throw new Error("Invalid mempool capacity");
    }
    if (!Number.isSafeInteger(this.miningReserve) || this.miningReserve < 0 ||
        this.miningReserve > MAX_MINING_MEMPOOL_CLAIMS) {
      throw new Error("Invalid mining mempool reserve");
    }
    if (!Number.isSafeInteger(this.maxNonMiningBytes) || this.maxNonMiningBytes < 1) {
      throw new Error("Invalid non-mining mempool byte capacity");
    }
    if (!Number.isSafeInteger(this.maxMiningBytes) || this.maxMiningBytes < 1) {
      throw new Error("Invalid mining mempool byte capacity");
    }
  }

  add(tx: Transaction): void {
    if (this.byId.has(tx.txid)) throw new Error("Transaction already in mempool");
    const txBytes = transactionBytes(tx);
    if (tx.kind === "mining_claim") {
      if (txBytes > this.maxMiningBytes) throw new Error("Mining mempool full");
    } else if (txBytes > this.maxNonMiningBytes) {
      throw new Error("Mempool full");
    }

    const nonceKey = `${tx.sender}:${tx.nonce}`;
    const conflictingId = this.nonceIds.get(nonceKey);
    if (conflictingId) {
      const conflicting = this.byId.get(conflictingId)!;
      if (!isValidReplacement(conflicting, tx)) throw new Error("Conflicting sender nonce");
      const conflictingBytes = transactionBytes(conflicting);
      if (tx.kind === "mining_claim") {
        if (this.miningBytes - conflictingBytes + txBytes > this.maxMiningBytes) {
          throw new Error("Mining mempool full");
        }
      } else if (this.nonMiningBytes - conflictingBytes + txBytes > this.maxNonMiningBytes) {
        throw new Error("Mempool full");
      }
      this.deleteTransaction(conflictingId, conflicting);
    }

    if (tx.kind === "mining_claim") {
      const totalCapacity = this.maxNonMiningSize + this.miningReserve;
      const configuredMiningCapacity = this.miningReserve > 0
        ? this.miningReserve
        : MAX_MINING_MEMPOOL_CLAIMS;
      if (this.miningSize >= configuredMiningCapacity || this.byId.size >= totalCapacity ||
          this.miningBytes + txBytes > this.maxMiningBytes) {
        const weakest = this.weakestMiningClaim();
        if (!weakest || !isBetterMiningClaim(weakest.tx, tx) ||
            this.miningBytes - transactionBytes(weakest.tx) + txBytes > this.maxMiningBytes) {
          throw new Error("Mining mempool full");
        }
        this.deleteTransaction(weakest.txid, weakest.tx);
      }
    } else if (this.nonMiningSize >= this.maxNonMiningSize ||
        this.nonMiningBytes + txBytes > this.maxNonMiningBytes) {
      const eviction = this.lowestPriorityEvictableTransfer();
      if (!eviction || (tx.kind === "transfer" && !hasRequiredFeeRateBump(eviction.tx, tx)) ||
          this.nonMiningBytes - transactionBytes(eviction.tx) + txBytes > this.maxNonMiningBytes) {
        throw new Error("Mempool full");
      }
      this.deleteTransaction(eviction.txid, eviction.tx);
    }

    const stored = structuredClone(tx);
    this.byId.set(tx.txid, stored);
    this.nonceIds.set(nonceKey, tx.txid);
    this.adjustOccupancy(stored, 1, txBytes);
    this.adjustTransferSpend(stored, 1n);
    this.invalidateNonMiningEvictionCache();
  }

  remove(txids: Iterable<string>): void {
    for (const txid of txids) {
      const tx = this.byId.get(txid);
      if (!tx) continue;
      this.deleteTransaction(txid, tx);
    }
  }

  prune(predicate: (tx: Transaction) => boolean): number {
    let removed = 0;
    for (const [txid, tx] of this.byId) {
      if (!predicate(tx)) continue;
      this.deleteTransaction(txid, tx);
      removed += 1;
    }
    return removed;
  }

  values(): Transaction[] {
    return [...this.byId.values()].map((tx) => structuredClone(tx));
  }

  pendingTransferSpend(sender: string): bigint {
    return this.transferSpendBySender.get(sender) ?? 0n;
  }

  conflictingTransaction(sender: string, nonce: number): Transaction | undefined {
    const txid = this.nonceIds.get(`${sender}:${nonce}`);
    const tx = txid ? this.byId.get(txid) : undefined;
    return tx ? structuredClone(tx) : undefined;
  }

  get size(): number {
    return this.byId.size;
  }

  private adjustOccupancy(tx: Transaction, direction: 1 | -1, bytes = transactionBytes(tx)): void {
    if (tx.kind === "mining_claim") {
      this.miningSize += direction;
      this.miningBytes += direction * bytes;
    } else {
      this.nonMiningSize += direction;
      this.nonMiningBytes += direction * bytes;
    }
    if (this.miningSize < 0 || this.nonMiningSize < 0 || this.miningBytes < 0 || this.nonMiningBytes < 0 ||
        this.miningBytes > this.maxMiningBytes || this.nonMiningBytes > this.maxNonMiningBytes ||
        this.miningSize + this.nonMiningSize !== this.byId.size) {
      throw new Error("Mempool occupancy invariant violated");
    }
  }

  private adjustTransferSpend(tx: Transaction, direction: 1n | -1n): void {
    if (tx.kind !== "transfer") return;
    const delta = BigInt(tx.amountAtoms) + BigInt(tx.feeAtoms);
    const next = (this.transferSpendBySender.get(tx.sender) ?? 0n) + (direction * delta);
    if (next === 0n) this.transferSpendBySender.delete(tx.sender);
    else this.transferSpendBySender.set(tx.sender, next);
  }

  private deleteTransaction(txid: string, tx: Transaction): void {
    this.byId.delete(txid);
    this.nonceIds.delete(`${tx.sender}:${tx.nonce}`);
    this.adjustOccupancy(tx, -1);
    this.adjustTransferSpend(tx, -1n);
    this.invalidateNonMiningEvictionCache();
  }

  private invalidateNonMiningEvictionCache(): void {
    this.nonMiningEvictionCacheValid = false;
    this.nonMiningEvictionCache = undefined;
  }

  private weakestMiningClaim(): { txid: string; tx: MiningClaimTx } | undefined {
    let selected: { txid: string; tx: MiningClaimTx } | undefined;
    for (const [txid, tx] of this.byId) {
      if (tx.kind !== "mining_claim") continue;
      if (!selected || compareMiningPriority(tx, selected.tx) < 0) selected = { txid, tx };
    }
    return selected;
  }

  private lowestPriorityEvictableTransfer(): EvictionCandidate | undefined {
    if (this.nonMiningEvictionCacheValid) return this.nonMiningEvictionCache;
    const selected = this.computeLowestPriorityEvictableTransfer();
    this.nonMiningEvictionCache = selected;
    this.nonMiningEvictionCacheValid = true;
    return selected;
  }

  private computeLowestPriorityEvictableTransfer(): EvictionCandidate | undefined {
    const highestNonce = new Map<string, number>();
    for (const tx of this.byId.values()) {
      highestNonce.set(tx.sender, Math.max(highestNonce.get(tx.sender) ?? 0, tx.nonce));
    }
    let selected: EvictionCandidate | undefined;
    for (const [txid, tx] of this.byId) {
      if (tx.kind !== "transfer" || tx.nonce !== highestNonce.get(tx.sender)) continue;
      if (!selected || compareFeeRate(tx, selected.tx) < 0 ||
          (compareFeeRate(tx, selected.tx) === 0 && tx.timestampMs < selected.tx.timestampMs)) {
        selected = { txid, tx };
      }
    }
    return selected;
  }
}

function transactionBytes(tx: Transaction): number {
  const bytes = Buffer.byteLength(canonicalJson(tx), "utf8");
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Invalid mempool transaction byte size");
  return bytes;
}

function isValidReplacement(existing: Transaction, incoming: Transaction): boolean {
  if (existing.kind === "transfer" && incoming.kind === "transfer") {
    return hasRequiredFeeRateBump(existing, incoming);
  }
  if (existing.kind === "mining_claim" && incoming.kind === "mining_claim") {
    return isBetterMiningClaim(existing, incoming);
  }
  return false;
}

function isBetterMiningClaim(existing: MiningClaimTx, incoming: MiningClaimTx): boolean {
  return compareMiningPriority(incoming, existing) > 0;
}

/**
 * Positive means left has higher mining-mempool priority.
 * A later finalized-tip height replaces stale work. At the same height only a
 * strictly lower work hash is better. Timestamp/txid are deliberately ignored
 * so the same PoW solution cannot be churned through replacement by re-signing.
 */
function compareMiningPriority(left: MiningClaimTx, right: MiningClaimTx): number {
  if (left.height !== right.height) return left.height > right.height ? 1 : -1;
  const leftHash = miningWorkHash(left);
  const rightHash = miningWorkHash(right);
  if (leftHash !== rightHash) return leftHash < rightHash ? 1 : -1;
  return 0;
}

function hasRequiredFeeRateBump(existing: Transaction, incoming: Transaction): boolean {
  if (existing.kind !== "transfer" || incoming.kind !== "transfer") return false;
  const existingBytes = BigInt(transactionBytes(existing));
  const incomingBytes = BigInt(transactionBytes(incoming));
  const incomingWeighted = BigInt(incoming.feeAtoms) * existingBytes * REPLACEMENT_BUMP_DENOMINATOR;
  const existingWeighted = BigInt(existing.feeAtoms) * incomingBytes * REPLACEMENT_BUMP_NUMERATOR;
  return incoming.feeAtoms > existing.feeAtoms && incomingWeighted >= existingWeighted;
}

function compareFeeRate(left: Transaction, right: Transaction): number {
  if (left.kind !== "transfer" || right.kind !== "transfer") return 0;
  const leftBytes = BigInt(transactionBytes(left));
  const rightBytes = BigInt(transactionBytes(right));
  const difference = (BigInt(left.feeAtoms) * rightBytes) - (BigInt(right.feeAtoms) * leftBytes);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
