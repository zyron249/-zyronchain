import { linearCliffVestedAtoms } from "./founder-vesting.js";
import { MINING_TRACKER_ADDRESS } from "./mining.js";
import { assertAddress, assertExactKeys, assertPlainRecord } from "./transaction.js";
import { MAX_SUPPLY_ATOMS, type Address, type AllocationLocks, type GenesisConfig } from "./types.js";

/**
 * On-chain allocation locks (docs/ALLOCATION_LOCKS.md).
 *
 * A genesis may name two accounts in `allocationLocks`:
 * - `founderVesting`: the founder allocation vests from the genesis timestamp,
 *   measured at the including block's timestamp: nothing during the 365-day
 *   cliff (nothing at exactly the cliff either), then linearly over 1,095 days.
 *   A debit (amount + fee) may never leave the account below the still-locked
 *   part of its genesis allocation. Inflows are spendable at once.
 * - `permanentLiquidity`: every outflow (including fees) is refused forever.
 *   Unlocking needs a future audited mechanism, a protocol upgrade and owner
 *   approval.
 * The locks follow the address: inflows are allowed and become subject to the
 * same rule. Without `allocationLocks` behaviour is unchanged.
 *
 * Block timestamps (not heights) drive the schedule because honest validators
 * bound them to their clocks (+120 s), so a stalled or fast chain cannot move
 * the unlock date materially. All arithmetic is BigInt.
 */

export const MS_PER_DAY = 86_400_000;
export const FOUNDER_VESTING_CLIFF_MS = 365 * MS_PER_DAY;
export const FOUNDER_VESTING_LINEAR_MS = 1_095 * MS_PER_DAY;
export const FOUNDER_VESTING_LOCKED_MESSAGE = "Founder allocation is still vesting";
export const PERMANENT_LIQUIDITY_LOCKED_MESSAGE = "Permanent-liquidity reserve is locked";

export interface AllocationLockContext {
  readonly founderVesting: Address;
  readonly permanentLiquidity: Address;
  /** Genesis allocation of the founder account (the vesting total). */
  readonly founderAllocationAtoms: number;
  readonly genesisTimestampMs: number;
  /** Timestamp of the block that would include the debit. */
  readonly blockTimestampMs: number;
}

/** Fail-closed validation of the optional genesis `allocationLocks` field. */
export function validateAllocationLocks(genesis: GenesisConfig): void {
  if (!Object.prototype.hasOwnProperty.call(genesis, "allocationLocks")) return;
  const locks: unknown = (genesis as { allocationLocks?: unknown }).allocationLocks;
  assertPlainRecord(locks, "allocation locks");
  assertExactKeys(locks, ["founderVesting", "permanentLiquidity"], "allocation locks");
  const founder = locks.founderVesting;
  const liquidity = locks.permanentLiquidity;
  if (typeof founder !== "string" || typeof liquidity !== "string") throw new Error("Invalid allocation lock address");
  assertAddress(founder);
  assertAddress(liquidity);
  if (founder === liquidity) throw new Error("Invalid allocation locks: roles must use distinct addresses");
  for (const address of [founder, liquidity]) {
    if (address === MINING_TRACKER_ADDRESS) throw new Error("Invalid allocation lock: mining tracker is protocol-reserved");
    if (address === genesis.activityPool) throw new Error("Invalid allocation lock: the activity pool cannot be locked");
    if (!Array.isArray(genesis.allocations) || !genesis.allocations.some((allocation) => allocation.address === address)) {
      throw new Error("Invalid allocation lock: the locked account needs a genesis allocation");
    }
  }
}

/** Lock context for a block at `blockTimestampMs`, or undefined when the genesis declares no locks. */
export function allocationLockContext(genesis: GenesisConfig, blockTimestampMs: number): AllocationLockContext | undefined {
  const locks: AllocationLocks | undefined = genesis.allocationLocks;
  if (locks === undefined) return undefined;
  assertTimestamp(blockTimestampMs, "block timestamp");
  assertTimestamp(genesis.timestampMs, "genesis timestamp");
  const founderAllocation = genesis.allocations.find((allocation) => allocation.address === locks.founderVesting);
  if (!founderAllocation) throw new Error("Invalid allocation lock: the locked account needs a genesis allocation");
  assertAtoms(founderAllocation.amountAtoms);
  return Object.freeze({
    founderVesting: locks.founderVesting,
    permanentLiquidity: locks.permanentLiquidity,
    founderAllocationAtoms: founderAllocation.amountAtoms,
    genesisTimestampMs: genesis.timestampMs,
    blockTimestampMs
  });
}

export function founderVestedAtomsAtTimestamp(genesisTimestampMs: number, blockTimestampMs: number, totalAtoms: number): number {
  assertTimestamp(genesisTimestampMs, "genesis timestamp");
  assertTimestamp(blockTimestampMs, "block timestamp");
  assertAtoms(totalAtoms);
  const vested = linearCliffVestedAtoms(
    BigInt(blockTimestampMs) - BigInt(genesisTimestampMs),
    BigInt(FOUNDER_VESTING_CLIFF_MS),
    BigInt(FOUNDER_VESTING_LINEAR_MS),
    BigInt(totalAtoms)
  );
  const result = Number(vested);
  if (!Number.isSafeInteger(result) || result < 0 || result > totalAtoms) throw new Error("Founder vested amount overflow");
  return result;
}

export function founderLockedAtomsAtTimestamp(genesisTimestampMs: number, blockTimestampMs: number, totalAtoms: number): number {
  return totalAtoms - founderVestedAtomsAtTimestamp(genesisTimestampMs, blockTimestampMs, totalAtoms);
}

/** Atoms of `address` that must stay in place in a block governed by `context`. */
export function lockedAtoms(context: AllocationLockContext | undefined, address: Address, balanceAtoms: number): number {
  assertAtoms(balanceAtoms);
  if (!context) return 0;
  if (address === context.permanentLiquidity) return balanceAtoms;
  if (address === context.founderVesting) {
    return founderLockedAtomsAtTimestamp(context.genesisTimestampMs, context.blockTimestampMs, context.founderAllocationAtoms);
  }
  return 0;
}

/** Balance that `address` may move in a block governed by `context` (never negative). */
export function spendableAtoms(context: AllocationLockContext | undefined, address: Address, balanceAtoms: number): number {
  const locked = lockedAtoms(context, address, balanceAtoms);
  return balanceAtoms > locked ? balanceAtoms - locked : 0;
}

/**
 * Consensus check for every debit: `outflowAtoms` (amount + fee, or an
 * activity settlement total) leaving `sender` with `balanceAtoms` before the
 * debit. The permanent-liquidity account may never be debited, not even by 0.
 */
export function assertAllocationLockOutflow(
  context: AllocationLockContext | undefined,
  sender: Address,
  balanceAtoms: number,
  outflowAtoms: number
): void {
  if (!context) return;
  assertAtoms(balanceAtoms);
  assertAtoms(outflowAtoms);
  if (sender === context.permanentLiquidity) throw new Error(PERMANENT_LIQUIDITY_LOCKED_MESSAGE);
  if (sender !== context.founderVesting) return;
  const locked = lockedAtoms(context, sender, balanceAtoms);
  if (BigInt(balanceAtoms) - BigInt(outflowAtoms) < BigInt(locked)) throw new Error(FOUNDER_VESTING_LOCKED_MESSAGE);
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}

function assertAtoms(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SUPPLY_ATOMS) throw new Error("Invalid atom amount");
}
