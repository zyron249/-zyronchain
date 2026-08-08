import type { Transaction } from "./types.js";

export class Mempool {
  private readonly byId = new Map<string, Transaction>();
  private readonly nonceKeys = new Set<string>();
  private readonly transferSpendBySender = new Map<string, bigint>();

  constructor(private readonly maxSize = 10_000) {}

  add(tx: Transaction): void {
    if (this.byId.has(tx.txid)) throw new Error("Transaction already in mempool");
    const nonceKey = `${tx.sender}:${tx.nonce}`;
    if (this.nonceKeys.has(nonceKey)) throw new Error("Conflicting sender nonce");
    if (this.byId.size >= this.maxSize) throw new Error("Mempool full");
    this.byId.set(tx.txid, structuredClone(tx));
    this.nonceKeys.add(nonceKey);
    this.adjustTransferSpend(tx, 1n);
  }

  remove(txids: Iterable<string>): void {
    for (const txid of txids) {
      const tx = this.byId.get(txid);
      if (!tx) continue;
      this.byId.delete(txid);
      this.nonceKeys.delete(`${tx.sender}:${tx.nonce}`);
      this.adjustTransferSpend(tx, -1n);
    }
  }

  prune(predicate: (tx: Transaction) => boolean): number {
    let removed = 0;
    for (const [txid, tx] of this.byId) {
      if (!predicate(tx)) continue;
      this.byId.delete(txid);
      this.nonceKeys.delete(`${tx.sender}:${tx.nonce}`);
      this.adjustTransferSpend(tx, -1n);
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
}
