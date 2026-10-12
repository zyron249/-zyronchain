import { ATOMS_PER_ZYN } from "./types.js";
import type { ActivityEntry, Address } from "./types.js";

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

/**
 * Rolling 24 h activity cap (owner rule: at most 10,000 ZYN of activity
 * settlements per 24 hours). Enforced only under `launchProfile:
 * "fixed-supply-v1"`; a genesis without a launch profile keeps the per-epoch
 * rule above, so existing chains do not fork. See docs/ACTIVITY_ORACLE_CAP.md.
 *
 * Rule: the settlements whose block timestamps lie inside any window
 * (t, t + 24 h) sum to at most MAX_ACTIVITY_SETTLEMENT_ATOMS.
 *
 * Why one record is enough: epoch e settles only in a block timestamped inside
 * epoch e + 1, at most once and in increasing order, so each 24 h epoch of
 * block time holds at most one settlement. A window shorter than or equal to
 * 24 h therefore holds at most two settlements, and they are consecutive. It
 * suffices to check each settlement against the previous one: if the previous
 * one lies less than 24 h earlier, their sum must stay within the cap.
 *
 * The previous settlement (block timestamp, amount) is consensus state, kept
 * as the nonces of two protocol-reserved zero-balance accounts. They hold no
 * balance, so total supply is unchanged, and they are committed by the same
 * account records as every other account in both the legacy and the State-v2
 * representations (snapshots, checkpoints and state sync carry them).
 */
export const ACTIVITY_ROLLING_WINDOW_MS = 86_400_000;
export const ACTIVITY_WINDOW_TIME_ADDRESS = `ZYN${"0".repeat(39)}1` as Address;
export const ACTIVITY_WINDOW_AMOUNT_ADDRESS = `ZYN${"0".repeat(39)}2` as Address;
export const ACTIVITY_ROLLING_CAP_MESSAGE = "Activity settlements exceed 10,000 ZYN in a rolling 24-hour window";
export const ACTIVITY_WINDOW_RESERVED_MESSAGE = "Activity window record address is protocol-reserved";

/** Launch profile under which the rolling window is a consensus rule. */
export const ACTIVITY_ROLLING_WINDOW_PROFILE = "fixed-supply-v1";

export function activityRollingWindowEnforced(genesis: { readonly launchProfile?: string } | undefined): boolean {
  return genesis?.launchProfile === ACTIVITY_ROLLING_WINDOW_PROFILE;
}

export function isActivityWindowAddress(address: string): boolean {
  return address === ACTIVITY_WINDOW_TIME_ADDRESS || address === ACTIVITY_WINDOW_AMOUNT_ADDRESS;
}

export interface ActivityWindowRecord {
  /** Block timestamp of the previous settlement (0 before the first one). */
  readonly timestampMs: number;
  /** Payout of the previous settlement in atoms. */
  readonly amountAtoms: number;
}

/** Throws when a settlement of `totalAtoms` at `blockTimestampMs` would break the rolling cap. */
export function assertActivityRollingWindow(
  previous: ActivityWindowRecord,
  blockTimestampMs: number | undefined,
  totalAtoms: number
): void {
  if (blockTimestampMs === undefined || !Number.isSafeInteger(blockTimestampMs) || blockTimestampMs < 0) {
    throw new Error("Activity rolling window requires the block timestamp");
  }
  if (!Number.isSafeInteger(previous.timestampMs) || previous.timestampMs < 0 ||
      !Number.isSafeInteger(previous.amountAtoms) || previous.amountAtoms < 0 ||
      previous.amountAtoms > MAX_ACTIVITY_SETTLEMENT_ATOMS || previous.timestampMs > blockTimestampMs) {
    throw new Error("Corrupt activity window state");
  }
  if (!Number.isSafeInteger(totalAtoms) || totalAtoms < 0) throw new Error("Invalid activity amount");
  if (blockTimestampMs - previous.timestampMs < ACTIVITY_ROLLING_WINDOW_MS &&
      previous.amountAtoms + totalAtoms > MAX_ACTIVITY_SETTLEMENT_ATOMS) {
    throw new Error(ACTIVITY_ROLLING_CAP_MESSAGE);
  }
}
