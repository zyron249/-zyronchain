import type { Transaction } from "./types.js";

export class Mempool {
  private readonly byId = new Map<string, Transaction>();
  private readonly nonceKeys = new Set<string>();

  constructor(private readonly maxSize = 10_000) {}

  add(tx: Transaction): void {
    if (this.byId.has(tx.txid)) throw new Error("Transaction already in mempool");
    const nonceKey = `${tx.sender}:${tx.nonce}`;
    if (this.nonceKeys.has(nonceKey)) throw new Error("Conflicting sender nonce");
    if (this.byId.size >= this.maxSize) throw new Error("Mempool full");
    this.byId.set(tx.txid, structuredClone(tx));
    this.nonceKeys.add(nonceKey);
  }

  remove(txids: Iterable<string>): void {
    for (const txid of txids) {
      const tx = this.byId.get(txid);
      if (!tx) continue;
      this.byId.delete(txid);
      this.nonceKeys.delete(`${tx.sender}:${tx.nonce}`);
    }
  }

  select(limit: number): Transaction[] {
    return [...this.byId.values()]
      .sort((a, b) => {
        const feeA = a.kind === "transfer" ? a.feeAtoms : 0;
        const feeB = b.kind === "transfer" ? b.feeAtoms : 0;
        return feeB - feeA || a.timestampMs - b.timestampMs || a.txid.localeCompare(b.txid);
      })
      .slice(0, limit)
      .map((tx) => structuredClone(tx));
  }

  get size(): number {
    return this.byId.size;
  }
}
