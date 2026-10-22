import { canonicalJson } from "./codec.js";
import { FIXED_FEE_MISMATCH_MESSAGE } from "./fee-policy.js";
import { assertMiningNotRetired, miningWorkHash } from "./mining.js";
const REPLACEMENT_BUMP_NUMERATOR = 11n;
const REPLACEMENT_BUMP_DENOMINATOR = 10n;
export const MAX_MINING_MEMPOOL_CLAIMS = 256;
export const DEFAULT_MEMPOOL_NON_MINING_CAPACITY = 10_000;
export const DEFAULT_MEMPOOL_NON_MINING_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MINING_MEMPOOL_MAX_BYTES = 4 * 1024 * 1024;
export class Mempool {
    byId = new Map();
    nonceIds = new Map();
    transferSpendBySender = new Map();
    maxNonMiningSize;
    miningReserve;
    maxNonMiningBytes;
    maxMiningBytes;
    miningSize = 0;
    nonMiningSize = 0;
    miningBytes = 0;
    nonMiningBytes = 0;
    nonMiningEvictionCacheValid = false;
    nonMiningEvictionCache;
    pendingBySender = new Map();
    disableFeeReplacement;
    fixedTransferFeeAtoms;
    maxPendingPerSender;
    constructor(maxNonMiningSize, miningReserve, maxNonMiningBytes = DEFAULT_MEMPOOL_NON_MINING_MAX_BYTES, maxMiningBytes = DEFAULT_MINING_MEMPOOL_MAX_BYTES, options) {
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
        if (this.maxPendingPerSender !== undefined &&
            (!Number.isSafeInteger(this.maxPendingPerSender) || this.maxPendingPerSender < 1)) {
            throw new Error("Invalid per-sender mempool cap");
        }
    }
    add(tx) {
        // Mining is retired: the mining reserve can never be occupied.
        if (tx.kind === "mining_claim")
            assertMiningNotRetired();
        if (this.fixedTransferFeeAtoms !== undefined && tx.kind === "transfer" && tx.feeAtoms !== this.fixedTransferFeeAtoms) {
            throw new Error(FIXED_FEE_MISMATCH_MESSAGE);
        }
        if (this.byId.has(tx.txid))
            throw new Error("Transaction already in mempool");
        const txBytes = transactionBytes(tx);
        if (tx.kind === "mining_claim") {
            if (txBytes > this.maxMiningBytes)
                throw new Error("Mining mempool full");
        }
        else if (txBytes > this.maxNonMiningBytes) {
            throw new Error("Mempool full");
        }
        const nonceKey = `${tx.sender}:${tx.nonce}`;
        const conflictingId = this.nonceIds.get(nonceKey);
        if (conflictingId) {
            const conflicting = this.byId.get(conflictingId);
            if (!isValidReplacement(conflicting, tx, this.disableFeeReplacement))
                throw new Error("Conflicting sender nonce");
            const conflictingBytes = transactionBytes(conflicting);
            if (tx.kind === "mining_claim") {
                if (this.miningBytes - conflictingBytes + txBytes > this.maxMiningBytes) {
                    throw new Error("Mining mempool full");
                }
            }
            else if (this.nonMiningBytes - conflictingBytes + txBytes > this.maxNonMiningBytes) {
                throw new Error("Mempool full");
            }
            this.deleteTransaction(conflictingId, conflicting);
        }
        else if (this.maxPendingPerSender !== undefined &&
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
        }
        else if (this.nonMiningSize >= this.maxNonMiningSize ||
            this.nonMiningBytes + txBytes > this.maxNonMiningBytes) {
            if (this.disableFeeReplacement)
                throw new Error("Mempool full");
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
        this.adjustSenderCount(stored.sender, 1);
        this.invalidateNonMiningEvictionCache();
    }
    remove(txids) {
        for (const txid of txids) {
            const tx = this.byId.get(txid);
            if (!tx)
                continue;
            this.deleteTransaction(txid, tx);
        }
    }
    prune(predicate) {
        let removed = 0;
        for (const [txid, tx] of this.byId) {
            if (!predicate(tx))
                continue;
            this.deleteTransaction(txid, tx);
            removed += 1;
        }
        return removed;
    }
    values() {
        return [...this.byId.values()].map((tx) => structuredClone(tx));
    }
    pendingTransferSpend(sender) {
        return this.transferSpendBySender.get(sender) ?? 0n;
    }
    conflictingTransaction(sender, nonce) {
        const txid = this.nonceIds.get(`${sender}:${nonce}`);
        const tx = txid ? this.byId.get(txid) : undefined;
        return tx ? structuredClone(tx) : undefined;
    }
    get size() {
        return this.byId.size;
    }
    adjustOccupancy(tx, direction, bytes = transactionBytes(tx)) {
        if (tx.kind === "mining_claim") {
            this.miningSize += direction;
            this.miningBytes += direction * bytes;
        }
        else {
            this.nonMiningSize += direction;
            this.nonMiningBytes += direction * bytes;
        }
        if (this.miningSize < 0 || this.nonMiningSize < 0 || this.miningBytes < 0 || this.nonMiningBytes < 0 ||
            this.miningBytes > this.maxMiningBytes || this.nonMiningBytes > this.maxNonMiningBytes ||
            this.miningSize + this.nonMiningSize !== this.byId.size) {
            throw new Error("Mempool occupancy invariant violated");
        }
    }
    adjustTransferSpend(tx, direction) {
        if (tx.kind !== "transfer")
            return;
        const delta = BigInt(tx.amountAtoms) + BigInt(tx.feeAtoms);
        const next = (this.transferSpendBySender.get(tx.sender) ?? 0n) + (direction * delta);
        if (next === 0n)
            this.transferSpendBySender.delete(tx.sender);
        else
            this.transferSpendBySender.set(tx.sender, next);
    }
    deleteTransaction(txid, tx) {
        this.byId.delete(txid);
        this.nonceIds.delete(`${tx.sender}:${tx.nonce}`);
        this.adjustOccupancy(tx, -1);
        this.adjustTransferSpend(tx, -1n);
        this.adjustSenderCount(tx.sender, -1);
        this.invalidateNonMiningEvictionCache();
    }
    adjustSenderCount(sender, direction) {
        const next = (this.pendingBySender.get(sender) ?? 0) + direction;
        if (next < 0)
            throw new Error("Mempool occupancy invariant violated");
        if (next === 0)
            this.pendingBySender.delete(sender);
        else
            this.pendingBySender.set(sender, next);
    }
    invalidateNonMiningEvictionCache() {
        this.nonMiningEvictionCacheValid = false;
        this.nonMiningEvictionCache = undefined;
    }
    weakestMiningClaim() {
        let selected;
        for (const [txid, tx] of this.byId) {
            if (tx.kind !== "mining_claim")
                continue;
            if (!selected || compareMiningPriority(tx, selected.tx) < 0)
                selected = { txid, tx };
        }
        return selected;
    }
    lowestPriorityEvictableTransfer() {
        if (this.nonMiningEvictionCacheValid)
            return this.nonMiningEvictionCache;
        const selected = this.computeLowestPriorityEvictableTransfer();
        this.nonMiningEvictionCache = selected;
        this.nonMiningEvictionCacheValid = true;
        return selected;
    }
    computeLowestPriorityEvictableTransfer() {
        const highestNonce = new Map();
        for (const tx of this.byId.values()) {
            highestNonce.set(tx.sender, Math.max(highestNonce.get(tx.sender) ?? 0, tx.nonce));
        }
        let selected;
        for (const [txid, tx] of this.byId) {
            if (tx.kind !== "transfer" || tx.nonce !== highestNonce.get(tx.sender))
                continue;
            if (!selected || compareFeeRate(tx, selected.tx) < 0 ||
                (compareFeeRate(tx, selected.tx) === 0 && tx.timestampMs < selected.tx.timestampMs)) {
                selected = { txid, tx };
            }
        }
        return selected;
    }
}
function transactionBytes(tx) {
    const bytes = Buffer.byteLength(canonicalJson(tx), "utf8");
    if (!Number.isSafeInteger(bytes) || bytes < 1)
        throw new Error("Invalid mempool transaction byte size");
    return bytes;
}
function isValidReplacement(existing, incoming, disableFeeReplacement) {
    if (existing.kind === "transfer" && incoming.kind === "transfer") {
        if (disableFeeReplacement)
            return false;
        return hasRequiredFeeRateBump(existing, incoming);
    }
    if (existing.kind === "mining_claim" && incoming.kind === "mining_claim") {
        return isBetterMiningClaim(existing, incoming);
    }
    return false;
}
function isBetterMiningClaim(existing, incoming) {
    return compareMiningPriority(incoming, existing) > 0;
}
/**
 * Positive means left has higher mining-mempool priority.
 * A later finalized-tip height replaces stale work. At the same height only a
 * strictly lower work hash is better. Timestamp/txid are deliberately ignored
 * so the same PoW solution cannot be churned through replacement by re-signing.
 */
function compareMiningPriority(left, right) {
    if (left.height !== right.height)
        return left.height > right.height ? 1 : -1;
    const leftHash = miningWorkHash(left);
    const rightHash = miningWorkHash(right);
    if (leftHash !== rightHash)
        return leftHash < rightHash ? 1 : -1;
    return 0;
}
function hasRequiredFeeRateBump(existing, incoming) {
    if (existing.kind !== "transfer" || incoming.kind !== "transfer")
        return false;
    const existingBytes = BigInt(transactionBytes(existing));
    const incomingBytes = BigInt(transactionBytes(incoming));
    const incomingWeighted = BigInt(incoming.feeAtoms) * existingBytes * REPLACEMENT_BUMP_DENOMINATOR;
    const existingWeighted = BigInt(existing.feeAtoms) * incomingBytes * REPLACEMENT_BUMP_NUMERATOR;
    return incoming.feeAtoms > existing.feeAtoms && incomingWeighted >= existingWeighted;
}
function compareFeeRate(left, right) {
    if (left.kind !== "transfer" || right.kind !== "transfer")
        return 0;
    const leftBytes = BigInt(transactionBytes(left));
    const rightBytes = BigInt(transactionBytes(right));
    const difference = (BigInt(left.feeAtoms) * rightBytes) - (BigInt(right.feeAtoms) * leftBytes);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
