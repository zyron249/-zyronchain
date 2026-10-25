import { canonicalJson } from "./codec.js";
import { FIXED_FEE_MISMATCH_MESSAGE } from "./fee-policy.js";
import { assertMiningNotRetired, miningWorkHash } from "./mining.js";
import type { MiningClaimTx, Transaction } from "./types.js";

export interface MempoolOptions {
  /** fixed-fee-v1: same-nonce replacement by a higher fee is rejected. */
  disableFeeReplacement?: boolean;
  /** fixed-fee-v1: transfers whose fee is not this value are rejected. */
  fixedTransferFeeAtoms?: number;
  /**
   * Node policy floor for `transfer` fees (Red Team M2 option A). Mempool and
   * relay admission only, never block validity. 0 or unset: no floor. Ignored
   * when `fixedTransferFeeAtoms` is set (fixed-fee-v1: the exact fee wins).
   */
  minTransferFeeAtoms?: number;
  /** Per-sender pending cap. Unset: no count cap beyond the caller's other checks. */
  maxPendingPerSender?: number;
}

/** Environment variable for the node's mempool transfer-fee floor. */
export const MEMPOOL_MIN_FEE_ENV = "ZYRON_MEMPOOL_MIN_FEE_ATOMS";

/**
 * Parses a configured transfer-fee floor. Unset or empty means no floor.
 * Anything other than a non-negative safe decimal integer fails closed.
 */
export function parseMempoolMinFeeAtoms(value: string | undefined, name = "mempool-min-fee-atoms"): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${name}: expected a non-negative integer number of atoms`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}: expected a non-negative integer number of atoms`);
  return parsed;
}

/**
 * The transfer fee a node-side builder (faucet, smoke tests) must use so the
 * node admits its transfers: the exact fixed-fee-v1 fee when active, else the
 * node's floor (0 when none).
 */
export function nodeTransferFeeAtoms(fixedTransferFeeAtoms: number | undefined, minTransferFeeAtoms: number | undefined): number {
  return fixedTransferFeeAtoms ?? minTransferFeeAtoms ?? 0;
}

export function belowMinTransferFeeMessage(feeAtoms: number, minTransferFeeAtoms: number): string {
  return `Transfer fee ${feeAtoms} atoms is below this node's minimum transfer fee of ${minTransferFeeAtoms} atoms; ` +
    `resend with a fee of at least ${minTransferFeeAtoms} atoms (CLI: --fee-atoms ${minTransferFeeAtoms})`;
}

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
  private readonly pendingBySender = new Map<string, number>();
  /** Pending `validator_update` count per sender (P1-07-F2: O(1) sender query). */
  private readonly validatorUpdatesBySender = new Map<string, number>();
  /** Pending `validator_update` txids (P1-07-F2: admission copies only these, not the pool). */
  private readonly validatorUpdateIds = new Set<string>();
  private readonly disableFeeReplacement: boolean;
  private readonly fixedTransferFeeAtoms: number | undefined;
  private readonly maxPendingPerSender: number | undefined;
  private readonly minTransferFeeAtoms: number;
  /** Effective transfer-fee floor (0 when off and under fixed-fee-v1). Reported on GET /status. */
  get effectiveMinTransferFeeAtoms(): number { return this.minTransferFeeAtoms; }
  /** The exact fixed-fee-v1 transfer fee, or undefined when no fixed fee applies. */
  get fixedTransferFee(): number | undefined { return this.fixedTransferFeeAtoms; }
  /** Node policy only: admission time per txid, in insertion (admission) order. */
  private readonly admittedAtMs = new Map<string, number>();

  constructor(
    maxNonMiningSize?: number,
    miningReserve?: number,
    maxNonMiningBytes = DEFAULT_MEMPOOL_NON_MINING_MAX_BYTES,
    maxMiningBytes = DEFAULT_MINING_MEMPOOL_MAX_BYTES,
    options?: MempoolOptions
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
    this.disableFeeReplacement = options?.disableFeeReplacement === true;
    this.fixedTransferFeeAtoms = options?.fixedTransferFeeAtoms;
    this.maxPendingPerSender = options?.maxPendingPerSender;
    if (this.fixedTransferFeeAtoms !== undefined &&
        (!Number.isSafeInteger(this.fixedTransferFeeAtoms) || this.fixedTransferFeeAtoms < 1)) {
      throw new Error("Invalid fixed transfer fee");
    }
    const minFee = options?.minTransferFeeAtoms;
    if (minFee !== undefined && (!Number.isSafeInteger(minFee) || minFee < 0)) {
      throw new Error("Invalid minimum transfer fee");
    }
    // fixed-fee-v1: the exact fee is the only rule; the floor does not apply.
    this.minTransferFeeAtoms = this.fixedTransferFeeAtoms === undefined ? minFee ?? 0 : 0;
    if (this.maxPendingPerSender !== undefined &&
        (!Number.isSafeInteger(this.maxPendingPerSender) || this.maxPendingPerSender < 1)) {
      throw new Error("Invalid per-sender mempool cap");
    }
  }

  add(tx: Transaction, admittedAtMs = Date.now()): void {
    // Mining is retired: the mining reserve can never be occupied.
    if (tx.kind === "mining_claim") assertMiningNotRetired();
    if (this.fixedTransferFeeAtoms !== undefined && tx.kind === "transfer" && tx.feeAtoms !== this.fixedTransferFeeAtoms) {
      throw new Error(FIXED_FEE_MISMATCH_MESSAGE);
    }
    if (tx.kind === "transfer" && tx.feeAtoms < this.minTransferFeeAtoms) {
      throw new Error(belowMinTransferFeeMessage(tx.feeAtoms, this.minTransferFeeAtoms));
    }
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
      if (!isValidReplacement(conflicting, tx, this.disableFeeReplacement)) throw new Error("Conflicting sender nonce");
      const conflictingBytes = transactionBytes(conflicting);
      if (tx.kind === "mining_claim") {
        if (this.miningBytes - conflictingBytes + txBytes > this.maxMiningBytes) {
          throw new Error("Mining mempool full");
        }
      } else if (this.nonMiningBytes - conflictingBytes + txBytes > this.maxNonMiningBytes) {
        throw new Error("Mempool full");
      }
      this.deleteTransaction(conflictingId, conflicting);
    } else if (this.maxPendingPerSender !== undefined &&
        (this.pendingBySender.get(tx.sender) ?? 0) >= this.maxPendingPerSender) {
      throw new Error("Per-sender mempool cap exceeded");
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
      if (this.disableFeeReplacement) throw new Error("Mempool full");
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
    this.admittedAtMs.set(tx.txid, admittedAtMs);
    this.adjustOccupancy(stored, 1, txBytes);
    this.adjustTransferSpend(stored, 1n);
    this.adjustSenderCount(stored.sender, 1);
    if (stored.kind === "validator_update") {
      this.adjustValidatorUpdateSender(stored.sender, 1);
      this.validatorUpdateIds.add(stored.txid);
    }
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

  has(txid: string): boolean {
    return this.byId.has(txid);
  }

  /** A copy of one pending transaction (no copy of the whole pool). */
  get(txid: string): Transaction | undefined {
    const tx = this.byId.get(txid);
    return tx ? structuredClone(tx) : undefined;
  }

  /** Copies of the pending `validator_update` transactions only (no copy of the whole pool). */
  validatorUpdates(): Transaction[] {
    return [...this.validatorUpdateIds].map((txid) => structuredClone(this.byId.get(txid)!));
  }

  /**
   * Copies of `sender`'s pending transactions with nonces in
   * (`afterNonce`, `beforeNonce`), in nonce order, looked up by nonce (at most
   * `beforeNonce - afterNonce - 1` lookups; callers bound the range by the
   * mempool nonce window).
   */
  senderNonceRange(sender: string, afterNonce: number, beforeNonce: number): Transaction[] {
    const range: Transaction[] = [];
    for (let nonce = afterNonce + 1; nonce < beforeNonce; nonce += 1) {
      const txid = this.nonceIds.get(`${sender}:${nonce}`);
      const tx = txid ? this.byId.get(txid) : undefined;
      if (tx) range.push(structuredClone(tx));
    }
    return range;
  }

  /** Whether `sender` has a pending `validator_update` (O(1)). */
  hasValidatorUpdateFrom(sender: string): boolean {
    return this.validatorUpdatesBySender.has(sender);
  }

  pendingTransferSpend(sender: string): bigint {
    return this.transferSpendBySender.get(sender) ?? 0n;
  }

  conflictingTransaction(sender: string, nonce: number): Transaction | undefined {
    const txid = this.nonceIds.get(`${sender}:${nonce}`);
    const tx = txid ? this.byId.get(txid) : undefined;
    return tx ? structuredClone(tx) : undefined;
  }

  /** Whether `sender` has a pending transaction with exactly `nonce` (O(1), no copy). */
  hasSenderNonce(sender: string, nonce: number): boolean {
    return this.nonceIds.has(`${sender}:${nonce}`);
  }

  /** Number of `sender`'s pending transactions (O(1)). */
  senderPendingCount(sender: string): number {
    return this.pendingBySender.get(sender) ?? 0;
  }

  /**
   * Sender and nonce of the pending transactions admitted at or before
   * `cutoffMs`, oldest first (no transaction copies). Admission times are in
   * insertion order, so the scan stops at the first younger entry when the
   * clock is monotonic.
   */
  admittedAtOrBefore(cutoffMs: number): Array<{ txid: string; sender: Transaction["sender"]; nonce: number }> {
    const result: Array<{ txid: string; sender: Transaction["sender"]; nonce: number }> = [];
    for (const [txid, admittedAtMs] of this.admittedAtMs) {
      if (admittedAtMs > cutoffMs) break;
      const tx = this.byId.get(txid);
      if (tx) result.push({ txid, sender: tx.sender, nonce: tx.nonce });
    }
    return result;
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
    this.admittedAtMs.delete(txid);
    this.adjustOccupancy(tx, -1);
    this.adjustTransferSpend(tx, -1n);
    this.adjustSenderCount(tx.sender, -1);
    if (tx.kind === "validator_update") {
      this.adjustValidatorUpdateSender(tx.sender, -1);
      this.validatorUpdateIds.delete(tx.txid);
    }
    this.invalidateNonMiningEvictionCache();
  }

  private adjustValidatorUpdateSender(sender: string, direction: 1 | -1): void {
    const next = (this.validatorUpdatesBySender.get(sender) ?? 0) + direction;
    if (next < 0) throw new Error("Mempool occupancy invariant violated");
    if (next === 0) this.validatorUpdatesBySender.delete(sender);
    else this.validatorUpdatesBySender.set(sender, next);
  }

  private adjustSenderCount(sender: string, direction: 1 | -1): void {
    const next = (this.pendingBySender.get(sender) ?? 0) + direction;
    if (next < 0) throw new Error("Mempool occupancy invariant violated");
    if (next === 0) this.pendingBySender.delete(sender);
    else this.pendingBySender.set(sender, next);
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

function isValidReplacement(existing: Transaction, incoming: Transaction, disableFeeReplacement: boolean): boolean {
  if (existing.kind === "transfer" && incoming.kind === "transfer") {
    if (disableFeeReplacement) return false;
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
