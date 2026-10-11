import { FOUNDER_ALLOCATION_ATOMS } from "./tokenomics.js";

export const TARGET_BLOCK_INTERVAL_SECONDS = 30;
export const BLOCKS_PER_DAY = (24 * 60 * 60) / TARGET_BLOCK_INTERVAL_SECONDS;
export const FOUNDER_CLIFF_BLOCKS = 365 * BLOCKS_PER_DAY;
export const FOUNDER_LINEAR_VESTING_BLOCKS = 3 * 365 * BLOCKS_PER_DAY;

/**
 * Shared cliff + linear vesting arithmetic (BigInt only, no floating point).
 *
 * `elapsed` is measured from the schedule start in any unit (blocks or
 * milliseconds); `cliff` and `linear` use the same unit. Nothing is vested at
 * or before the cliff (including a negative elapsed value); afterwards the
 * release is floor(total * min(elapsed - cliff, linear) / linear), so it
 * saturates at exactly `total`. Both the block-height schedule below and the
 * consensus-enforced timestamp schedule in allocation-locks.ts use this helper,
 * so they agree exactly at the 30-second target cadence.
 */
export function linearCliffVestedAtoms(elapsed: bigint, cliff: bigint, linear: bigint, total: bigint): bigint {
  if (typeof elapsed !== "bigint" || typeof cliff !== "bigint" || typeof linear !== "bigint" ||
      typeof total !== "bigint" || cliff < 0n || linear <= 0n || total < 0n) {
    throw new Error("Invalid vesting schedule");
  }
  if (elapsed <= cliff) return 0n;
  const released = elapsed - cliff < linear ? elapsed - cliff : linear;
  return (total * released) / linear;
}

/**
 * Deterministic founder vesting schedule expressed in block heights.
 *
 * The schedule deliberately does not depend on wall-clock time, locale, timezone,
 * or floating-point arithmetic. With the current 30-second target cadence the
 * cliff targets 365 days and the linear release targets the following 1,095 days.
 *
 * Consensus enforces the equivalent timestamp schedule (allocation-locks.ts),
 * which shares linearCliffVestedAtoms with this function; this height form is
 * kept as the reference schedule and for planning tools.
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

  const vested = linearCliffVestedAtoms(
    BigInt(height) - BigInt(startHeight),
    BigInt(FOUNDER_CLIFF_BLOCKS),
    BigInt(FOUNDER_LINEAR_VESTING_BLOCKS),
    BigInt(totalAtoms)
  );
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
