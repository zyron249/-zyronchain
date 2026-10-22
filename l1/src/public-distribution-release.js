import { isStrictNetworkClass, readNetworkClass } from "./network-class.js";
import { FIXED_SUPPLY_LAUNCH_PROFILE, PUBLIC_DISTRIBUTION_ATOMS } from "./tokenomics.js";
import { assertAddress, assertExactKeys, assertPlainRecord } from "./transaction.js";
import { MINING_TRACKER_ADDRESS } from "./mining.js";
const MS_PER_DAY = 86_400_000;
/**
 * Public-distribution release, version public-distribution-release-v1.
 *
 * The 20,000,000 ZYN public-distribution allocation cannot be spent in full on
 * day one when this field is present. The schedule reuses the cliff-then-linear
 * vesting arithmetic. The owner decided the default: no cliff, then a 365-day
 * linear release. Nodes do not fill those numbers in; the genesis file must
 * contain them. This module does not invent an address.
 */
export const PUBLIC_DISTRIBUTION_RELEASE_VERSION = "public-distribution-release-v1";
/** Owner decision: no cliff. Release starts at the first millisecond after genesis. */
export const PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_DAYS = 0;
/** Owner decision: 365-day linear release. 365 * 86_400_000 = 31_536_000_000. */
export const PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_DAYS = 365;
export const PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS = PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_DAYS * MS_PER_DAY;
export const PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS = PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_DAYS * MS_PER_DAY;
/**
 * Fail-closed floors. A cliff of 0 is allowed. A linear length shorter than
 * 365 days is rejected so the allocation cannot become spendable in full on
 * day one: at 24 hours the vested amount is at most one day of a 365-day line.
 */
export const PUBLIC_DISTRIBUTION_MIN_CLIFF_MS = 0;
export const PUBLIC_DISTRIBUTION_MIN_LINEAR_MS = 365 * MS_PER_DAY;
export const PUBLIC_DISTRIBUTION_MAX_CLIFF_MS = 100 * 365 * MS_PER_DAY;
export const PUBLIC_DISTRIBUTION_MAX_LINEAR_MS = 100 * 365 * MS_PER_DAY;
export const PUBLIC_DISTRIBUTION_LOCKED_MESSAGE = "Public distribution allocation is still vesting";
export function defaultPublicDistributionRelease(address) {
    assertAddress(address);
    return {
        address,
        cliffMs: PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS,
        linearMs: PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS
    };
}
/**
 * Fail-closed check. A value-bearing class and every `fixed-supply-v1` genesis
 * must name the schedule. A genesis that omits both may omit the field, and
 * then the allocation stays spendable. When the field is present it is
 * enforced, including on a test class.
 */
export function validatePublicDistributionRelease(genesis) {
    const present = Object.prototype.hasOwnProperty.call(genesis, "publicDistributionRelease");
    if (!present) {
        if (isStrictNetworkClass(readNetworkClass(genesis)) || genesis.launchProfile === FIXED_SUPPLY_LAUNCH_PROFILE) {
            throw new Error("fixed-supply-v1, public-launch, value-bearing, and mainnet genesis must declare publicDistributionRelease so the 20,000,000 ZYN allocation cannot be spent in full on day one");
        }
        return;
    }
    const release = genesis.publicDistributionRelease;
    assertPlainRecord(release, "public distribution release");
    assertExactKeys(release, ["address", "cliffMs", "linearMs"], "public distribution release");
    if (typeof release.address !== "string")
        throw new Error("Invalid public distribution release address");
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
    if (!allocation)
        throw new Error("Invalid public distribution release: the account needs a genesis allocation");
    assertScheduleBound(release.cliffMs, "cliffMs", PUBLIC_DISTRIBUTION_MIN_CLIFF_MS, PUBLIC_DISTRIBUTION_MAX_CLIFF_MS);
    assertScheduleBound(release.linearMs, "linearMs", PUBLIC_DISTRIBUTION_MIN_LINEAR_MS, PUBLIC_DISTRIBUTION_MAX_LINEAR_MS);
    if (genesis.launchProfile === FIXED_SUPPLY_LAUNCH_PROFILE && allocation.amountAtoms !== PUBLIC_DISTRIBUTION_ATOMS) {
        throw new Error("Public distribution release must cover the 20,000,000 ZYN public-distribution allocation");
    }
}
function assertScheduleBound(value, name, minimum, maximum) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`Invalid public distribution release ${name}`);
    }
}
