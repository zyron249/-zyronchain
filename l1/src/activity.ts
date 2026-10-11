import { ATOMS_PER_ZYN } from "./types.js";
import type { ActivityEntry } from "./types.js";

/**
 * Activity-oracle limits (ZC-CRY-20260930-010). Consensus constants: changing
 * either value is a consensus change. See docs/ACTIVITY_ORACLE_CAP.md.
 *
 * - Epoch e covers [genesis.timestampMs + e * ACTIVITY_EPOCH_MS,
 *   genesis.timestampMs + (e + 1) * ACTIVITY_EPOCH_MS).
 * - Epoch e may be settled only by a block whose timestamp lies in epoch e + 1
 *   (the most recently closed epoch). Missed epochs are forfeited, so idle time
 *   never accumulates into a larger burst.
 * - Each epoch settles at most once and epochs settle in strictly increasing
 *   order, so the per-settlement cap is also the per-epoch cap.
 */
export const ACTIVITY_EPOCH_MS = 86_400_000;
export const MAX_ACTIVITY_SETTLEMENT_ATOMS = 10_000 * ATOMS_PER_ZYN;

export const ACTIVITY_CAP_MESSAGE = "Activity settlement exceeds the per-epoch activity cap";
export const ACTIVITY_NOT_CLOSED_MESSAGE = "Activity epoch is not closed yet";
export const ACTIVITY_WINDOW_CLOSED_MESSAGE = "Activity epoch settlement window has closed";
export const ACTIVITY_ORDER_MESSAGE = "Activity epochs must settle in increasing order";

/** Total payout of a settlement; throws when it exceeds the per-epoch cap. */
export function assertActivitySettlementWithinCap(entries: readonly ActivityEntry[]): number {
  let total = 0n;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountAtoms) || entry.amountAtoms < 0) throw new Error("Invalid activity amount");
    total += BigInt(entry.amountAtoms);
    if (total > BigInt(MAX_ACTIVITY_SETTLEMENT_ATOMS)) throw new Error(ACTIVITY_CAP_MESSAGE);
  }
  return Number(total);
}

/** Index of the epoch that contains `timestampMs` (genesis-relative, floor). */
export function activityEpochAt(genesisTimestampMs: number, timestampMs: number): number {
  if (!Number.isSafeInteger(genesisTimestampMs) || !Number.isSafeInteger(timestampMs)) {
    throw new Error("Invalid activity epoch timestamp");
  }
  if (timestampMs < genesisTimestampMs) return -1;
  return Math.floor((timestampMs - genesisTimestampMs) / ACTIVITY_EPOCH_MS);
}

/** Epoch `epoch` is settleable only in a block timestamped inside epoch + 1. */
export function assertActivityEpochWindow(epoch: number, genesisTimestampMs: number, blockTimestampMs: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid activity epoch");
  const current = activityEpochAt(genesisTimestampMs, blockTimestampMs);
  if (epoch >= current) throw new Error(ACTIVITY_NOT_CLOSED_MESSAGE);
  if (epoch < current - 1) throw new Error(ACTIVITY_WINDOW_CLOSED_MESSAGE);
}

/** True once no block at or after `earliestBlockTimestampMs` can settle `epoch`. */
export function activityEpochWindowExpired(epoch: number, genesisTimestampMs: number, earliestBlockTimestampMs: number): boolean {
  return epoch < activityEpochAt(genesisTimestampMs, earliestBlockTimestampMs) - 1;
}
