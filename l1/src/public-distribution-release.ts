import { isStrictNetworkClass, readNetworkClass } from "./network-class.js";
import { FIXED_SUPPLY_LAUNCH_PROFILE, PUBLIC_DISTRIBUTION_ATOMS } from "./tokenomics.js";
import { assertAddress, assertExactKeys, assertPlainRecord } from "./transaction.js";
import { MINING_TRACKER_ADDRESS } from "./mining.js";

const MS_PER_DAY = 86_400_000;
import type { Address, GenesisConfig, PublicDistributionRelease } from "./types.js";

/**
 * Public-distribution release, version public-distribution-release-v1.
 *
 * The 20,000,000 ZYN public-distribution allocation is not spendable on day
 * one when this field is present. The schedule reuses the cliff-then-linear
 * vesting arithmetic. Parameters below are the fail-closed floors and the
 * documented conservative default. The exact cliff and linear length are
 * PENDING REVIEW: they are a product decision and must be explicit in the
 * genesis file. This module does not invent an address.
 */
export const PUBLIC_DISTRIBUTION_RELEASE_VERSION = "public-distribution-release-v1";

/** PENDING REVIEW. Documented conservative default: 90 days with nothing vested at the cliff. */
export const PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_DAYS = 90;
/** PENDING REVIEW. Documented conservative default: 1,095 days of linear release after the cliff. */
export const PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_DAYS = 1_095;

export const PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS = PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_DAYS * MS_PER_DAY;
export const PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS = PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_DAYS * MS_PER_DAY;

/**
 * Fail-closed floors, also PENDING REVIEW as bounds rather than as the chosen
 * schedule. A cliff shorter than one day would make some of the allocation
 * spendable on day one. A linear length shorter than 365 days would let the
 * remainder finish too quickly after the cliff.
 */
export const PUBLIC_DISTRIBUTION_MIN_CLIFF_MS = MS_PER_DAY;
export const PUBLIC_DISTRIBUTION_MIN_LINEAR_MS = 365 * MS_PER_DAY;
export const PUBLIC_DISTRIBUTION_MAX_CLIFF_MS = 100 * 365 * MS_PER_DAY;
export const PUBLIC_DISTRIBUTION_MAX_LINEAR_MS = 100 * 365 * MS_PER_DAY;

export const PUBLIC_DISTRIBUTION_LOCKED_MESSAGE = "Public distribution allocation is still vesting";

export function defaultPublicDistributionRelease(address: Address): PublicDistributionRelease {
  assertAddress(address);
  return {
    address,
    cliffMs: PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS,
    linearMs: PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS
  };
}

/**
 * Fail-closed check. A value-bearing class must name the schedule. Any other
 * genesis may omit it, and then the allocation stays spendable (existing
 * testnets). When the field is present it is enforced, including on a test class.
 */
export function validatePublicDistributionRelease(genesis: GenesisConfig): void {
  const present = Object.prototype.hasOwnProperty.call(genesis, "publicDistributionRelease");
  if (!present) {
    if (isStrictNetworkClass(readNetworkClass(genesis))) {
      throw new Error(
        "Value-bearing, public-launch, and mainnet genesis must declare publicDistributionRelease so the 20,000,000 ZYN allocation is not spendable on day one"
      );
    }
    return;
  }
  const release: unknown = genesis.publicDistributionRelease;
  assertPlainRecord(release, "public distribution release");
  assertExactKeys(release, ["address", "cliffMs", "linearMs"], "public distribution release");
  if (typeof release.address !== "string") throw new Error("Invalid public distribution release address");
  assertAddress(release.address);
  if (release.address === MINING_TRACKER_ADDRESS) {
    throw new Error("Invalid public distribution release: mining tracker is protocol-reserved");
  }
  if (release.address === genesis.activityPool) {
    throw new Error("Invalid public distribution release: the activity pool cannot be the public-distribution account");
  }
  const locks = genesis.allocationLocks;
  if (locks && (release.address === locks.founderVesting || release.address === locks.permanentLiquidity)) {
    throw new Error("Invalid public distribution release: the address must not be the founder or permanent-liquidity allocation");
  }
  const allocation = genesis.allocations.find((item) => item.address === release.address);
  if (!allocation) throw new Error("Invalid public distribution release: the account needs a genesis allocation");
  assertScheduleBound(release.cliffMs, "cliffMs", PUBLIC_DISTRIBUTION_MIN_CLIFF_MS, PUBLIC_DISTRIBUTION_MAX_CLIFF_MS);
  assertScheduleBound(release.linearMs, "linearMs", PUBLIC_DISTRIBUTION_MIN_LINEAR_MS, PUBLIC_DISTRIBUTION_MAX_LINEAR_MS);
  if (genesis.launchProfile === FIXED_SUPPLY_LAUNCH_PROFILE && allocation.amountAtoms !== PUBLIC_DISTRIBUTION_ATOMS) {
    throw new Error("Public distribution release must cover the 20,000,000 ZYN public-distribution allocation");
  }
}

function assertScheduleBound(value: unknown, name: string, minimum: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid public distribution release ${name}`);
  }
}
