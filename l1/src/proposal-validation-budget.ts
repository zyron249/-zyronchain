/**
 * P1-06 (F-11 residual): bound the expensive validation an authenticated
 * proposer can trigger.
 *
 * F-11 puts every O(1) gate (right tip, expected proposer, proposer signature,
 * certificates) before the per-transaction signature checks and the state
 * replay. Only the expected proposer of a (height, round) slot gets past those
 * gates. It can still sign any number of distinct, heavy, invalid proposals for
 * its slot, and each one used to cost thousands of signature checks inside the
 * node-wide mutex, delaying honest consensus work queued behind it.
 *
 * An honest proposer signs one block per slot. A block that passes the gates
 * against this node's tip and then fails the expensive stage fails the same way
 * on every retry: the replay depends only on the tip state and the block. So
 * after `perSlot` such failures in a slot, other proposals for that slot are
 * refused before the expensive stage, and so is a repeat of a failed hash.
 * Only failures after the gates are recorded. A forged signature, the wrong
 * tip, or an unexpected proposer never uses up a slot, so another peer cannot
 * block an honest proposer.
 *
 * Memory: slots exist only for heights above the finalized tip, and the map
 * is capped at `maxSlots` entries, oldest evicted first. Eviction only allows
 * one more full validation.
 */
export const PROPOSAL_VALIDATION_BUDGET_MESSAGE = "Proposal validation budget exhausted for this proposer slot";
export const DEFAULT_PROPOSAL_FAILURES_PER_SLOT = 1;
export const DEFAULT_PROPOSAL_BUDGET_MAX_SLOTS = 1_024;

interface SlotFailures {
  height: number;
  hashes: Set<string>;
}

export class ProposalValidationBudget {
  private readonly slots = new Map<string, SlotFailures>();

  constructor(
    readonly perSlot = DEFAULT_PROPOSAL_FAILURES_PER_SLOT,
    readonly maxSlots = DEFAULT_PROPOSAL_BUDGET_MAX_SLOTS
  ) {
    if (!Number.isSafeInteger(perSlot) || perSlot < 1) throw new Error("Invalid proposal validation budget");
    if (!Number.isSafeInteger(maxSlots) || maxSlots < 1) throw new Error("Invalid proposal validation budget slot limit");
  }

  static slotKey(height: number, round: number, proposerPublicKey: string): string {
    return `${height}:${round}:${proposerPublicKey}`;
  }

  /** Drops every slot at or below the finalized height. */
  pruneThrough(finalizedHeight: number): void {
    for (const [key, slot] of this.slots) {
      if (slot.height <= finalizedHeight) this.slots.delete(key);
    }
  }

  /** Throws when the slot already spent its budget, or this hash already failed. */
  assertAllowed(slotKey: string, blockHash: string): void {
    const slot = this.slots.get(slotKey);
    if (slot && (slot.hashes.has(blockHash) || slot.hashes.size >= this.perSlot)) {
      throw new Error(PROPOSAL_VALIDATION_BUDGET_MESSAGE);
    }
  }

  /** Records a failure in the expensive stage of an authenticated proposal. */
  recordFailure(slotKey: string, height: number, blockHash: string): void {
    let slot = this.slots.get(slotKey);
    if (!slot) {
      while (this.slots.size >= this.maxSlots) {
        const oldest = this.slots.keys().next().value;
        if (oldest === undefined) break;
        this.slots.delete(oldest);
      }
      slot = { height, hashes: new Set() };
      this.slots.set(slotKey, slot);
    }
    slot.hashes.add(blockHash);
  }

  size(): number {
    return this.slots.size;
  }
}
