import { canonicalJson } from "./codec.js";
import type { Transaction } from "./types.js";

const REPLACEMENT_BUMP_NUMERATOR = 11n;
const REPLACEMENT_BUMP_DENOMINATOR = 10n;

export class Mempool {
  private readonly byId = new Map<string, Transaction>();
  private readonly nonceIds = new Map<string, string>();
  private readonly transferSpendBySender = new Map<string, bigint>();

  constructor(private readonly maxSize = 10_000) {}

  add(tx: Transaction): void {
    if (this.byId.has(tx.txid)) throw new Error("Transaction already in mempool");
    const nonceKey = `${tx.sender}:${tx.nonce}`;
    const conflictingId = this.nonceIds.get(nonceKey);
    if (conflictingId) {
      const conflicting = this.byId.get(conflictingId)!;
      if (!isValidReplacement(conflicting, tx)) throw new Error("Conflicting sender nonce");
      this.deleteTransaction(conflictingId, conflicting);
    } else if (this.byId.size >= this.maxSize) {
      const eviction = this.lowestPriorityEvictableTransfer();
      if (!eviction || (tx.kind === "transfer" && !hasRequiredFeeRateBump(eviction.tx, tx))) {
        throw new Error("Mempool full");
      }
      this.deleteTransaction(eviction.txid, eviction.tx);
    }
    this.byId.set(tx.txid, structuredClone(tx));
    this.nonceIds.set(nonceKey, tx.txid);
    this.adjustTransferSpend(tx, 1n);
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
    this.adjustTransferSpend(tx, -1n);
  }

  private lowestPriorityEvictableTransfer(): { txid: string; tx: Transaction } | undefined {
    const highestNonce = new Map<string, number>();
    for (const tx of this.byId.values()) {
      highestNonce.set(tx.sender, Math.max(highestNonce.get(tx.sender) ?? 0, tx.nonce));
    }
    let selected: { txid: string; tx: Transaction } | undefined;
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

function isValidReplacement(existing: Transaction, incoming: Transaction): boolean {
  return existing.kind === "transfer" && incoming.kind === "transfer" &&
    hasRequiredFeeRateBump(existing, incoming);
}

function hasRequiredFeeRateBump(existing: Transaction, incoming: Transaction): boolean {
  if (existing.kind !== "transfer" || incoming.kind !== "transfer") return false;
  const existingBytes = BigInt(Buffer.byteLength(canonicalJson(existing), "utf8"));
  const incomingBytes = BigInt(Buffer.byteLength(canonicalJson(incoming), "utf8"));
  const incomingWeighted = BigInt(incoming.feeAtoms) * existingBytes * REPLACEMENT_BUMP_DENOMINATOR;
  const existingWeighted = BigInt(existing.feeAtoms) * incomingBytes * REPLACEMENT_BUMP_NUMERATOR;
  return incoming.feeAtoms > existing.feeAtoms && incomingWeighted >= existingWeighted;
}

function compareFeeRate(left: Transaction, right: Transaction): number {
  if (left.kind !== "transfer" || right.kind !== "transfer") return 0;
  const leftBytes = BigInt(Buffer.byteLength(canonicalJson(left), "utf8"));
  const rightBytes = BigInt(Buffer.byteLength(canonicalJson(right), "utf8"));
  const difference = (BigInt(left.feeAtoms) * rightBytes) - (BigInt(right.feeAtoms) * leftBytes);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
