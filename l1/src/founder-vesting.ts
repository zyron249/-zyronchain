import { FOUNDER_ALLOCATION_ATOMS } from "./tokenomics.js";

export const TARGET_BLOCK_INTERVAL_SECONDS = 30;
export const BLOCKS_PER_DAY = (24 * 60 * 60) / TARGET_BLOCK_INTERVAL_SECONDS;
export const FOUNDER_CLIFF_BLOCKS = 365 * BLOCKS_PER_DAY;
export const FOUNDER_LINEAR_VESTING_BLOCKS = 3 * 365 * BLOCKS_PER_DAY;

/**
 * Deterministic founder vesting schedule expressed in block heights.
 *
 * The schedule deliberately does not depend on wall-clock time, locale, timezone,
 * or floating-point arithmetic. With the current 30-second target cadence the
 * cliff targets 365 days and the linear release targets the following 1,095 days.
 *
 * IMPORTANT: this module is consensus-safe arithmetic, but the current fixed-
 * supply PR does not yet wire the schedule into transaction authorization.
 */
export function founderVestedAtomsAtHeight(
  height: number,
  startHeight = 0,
  totalAtoms = FOUNDER_ALLOCATION_ATOMS
): number {
  assertHeight(height, "height");
  assertHeight(startHeight, "startHeight");
  assertAtoms(totalAtoms);

  const cliffHeight = startHeight + FOUNDER_CLIFF_BLOCKS;
  if (!Number.isSafeInteger(cliffHeight)) throw new Error("Founder cliff height overflow");
  if (height <= cliffHeight) return 0;

  const elapsed = Math.min(height - cliffHeight, FOUNDER_LINEAR_VESTING_BLOCKS);
  const vested = (BigInt(totalAtoms) * BigInt(elapsed)) / BigInt(FOUNDER_LINEAR_VESTING_BLOCKS);
  const result = Number(vested);
  if (!Number.isSafeInteger(result) || result < 0 || result > totalAtoms) {
    throw new Error("Founder vested amount overflow");
  }
  return result;
}

export function founderAvailableAtomsAtHeight(
  height: number,
  claimedAtoms: number,
  startHeight = 0,
  totalAtoms = FOUNDER_ALLOCATION_ATOMS
): number {
  assertAtoms(claimedAtoms);
  assertAtoms(totalAtoms);
  if (claimedAtoms > totalAtoms) throw new Error("Founder claimed amount exceeds allocation");
  const vested = founderVestedAtomsAtHeight(height, startHeight, totalAtoms);
  return Math.max(0, vested - claimedAtoms);
}

function assertHeight(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}

function assertAtoms(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid atom amount");
}
