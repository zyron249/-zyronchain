import { FIXED_SUPPLY_LAUNCH_PROFILE } from "./tokenomics.js";
import type { GenesisConfig } from "./types.js";

/**
 * Optional genesis network class, version network-class-v1
 * (docs/GENESIS_NETWORK_CLASS.md).
 *
 * Genesis files that omit both `networkClass` and `launchProfile` keep their
 * previous validation and their previous genesis hash. That is how the local
 * devnet, the wallet testnet and the private testnet keep starting. The open
 * testnet declares `fixed-supply-v1`, so it follows the launch rules without
 * a value-bearing class.
 *
 * A public-launch, value-bearing or mainnet class is refused unless it also
 * declares `launchProfile: "fixed-supply-v1"`. That profile refuses the
 * genesis unless founder vesting and the permanent-liquidity lock are present,
 * the 50,000,000 ZYN split is 5M / 20M / 20M / 5M, there are at least four
 * validators, `publicDistributionRelease` is set, and the activity-oracle
 * policy is `threshold-v1`. There is no other launch profile, so those
 * classes cannot be started with the allocations spendable.
 */
export const NETWORK_CLASS_VERSION = "network-class-v1";

export const TEST_NETWORK_CLASSES = [
  "devnet",
  "local-devnet",
  "testnet",
  "private-testnet",
  "open-testnet",
  "wallet-testnet"
] as const;

export const STRICT_NETWORK_CLASSES = [
  "public-launch",
  "value-bearing",
  "mainnet"
] as const;

export type TestNetworkClass = (typeof TEST_NETWORK_CLASSES)[number];
export type StrictNetworkClass = (typeof STRICT_NETWORK_CLASSES)[number];

const TEST_CLASS = new Set<string>(TEST_NETWORK_CLASSES);
const STRICT_CLASS = new Set<string>(STRICT_NETWORK_CLASSES);

export function isTestNetworkClass(value: string | undefined): value is TestNetworkClass {
  return value !== undefined && TEST_CLASS.has(value);
}

export function isStrictNetworkClass(value: string | undefined): value is StrictNetworkClass {
  return value !== undefined && STRICT_CLASS.has(value);
}

/** Value-bearing classes refuse a set that cannot tolerate one faulty validator. */
export const STRICT_MIN_VALIDATORS = 4;
export const MAX_VALIDATORS = 100;

/**
 * Test classes and genesis files that omit both `networkClass` and
 * `launchProfile` keep the historical minimum of one validator. A
 * public-launch, value-bearing or mainnet class, and every
 * `launchProfile: "fixed-supply-v1"` genesis, requires four distinct validators.
 */
export function minimumValidatorCount(genesis: object): number {
  const profile = (genesis as { launchProfile?: unknown }).launchProfile;
  return isStrictNetworkClass(readNetworkClass(genesis)) || profile === FIXED_SUPPLY_LAUNCH_PROFILE
    ? STRICT_MIN_VALIDATORS
    : 1;
}

/**
 * A chain ID that names a value-bearing class cannot omit that class.
 * The match is on hyphen-delimited segments, so `zyron-mainnet-1` matches and
 * `zyron-local-<hex>` does not.
 */
export function chainIdRequiresStrictNetworkClass(chainId: string): boolean {
  return /(?:^|-)(?:mainnet|public-launch|value-bearing)(?:-|$)/.test(chainId);
}

/** Closed-set check. Absent field returns undefined. Any other value throws. */
export function readNetworkClass(genesis: object): GenesisConfig["networkClass"] | undefined {
  if (!Object.prototype.hasOwnProperty.call(genesis, "networkClass")) return undefined;
  const value = (genesis as { networkClass?: unknown }).networkClass;
  if (typeof value !== "string" || (!TEST_CLASS.has(value) && !STRICT_CLASS.has(value))) {
    throw new Error("Unsupported genesis network class");
  }
  return value as GenesisConfig["networkClass"];
}

/**
 * Fail-closed gate used by genesis validation (and therefore by node start).
 * Call it only after the chain ID has passed its format check.
 */
export function assertValueBearingClassRequiresFixedSupplyProfile(genesis: GenesisConfig): void {
  const networkClass = readNetworkClass(genesis);
  const namedStrict = chainIdRequiresStrictNetworkClass(genesis.chainId);
  if (networkClass === undefined && !namedStrict) return;
  if (namedStrict && !isStrictNetworkClass(networkClass)) {
    throw new Error(
      "A chain ID that names mainnet, public-launch, or value-bearing requires networkClass \"public-launch\", \"value-bearing\", or \"mainnet\""
    );
  }
  if (isStrictNetworkClass(networkClass) && genesis.launchProfile !== FIXED_SUPPLY_LAUNCH_PROFILE) {
    throw new Error(
      "Value-bearing, public-launch, and mainnet genesis must declare launchProfile \"fixed-supply-v1\" so founder vesting and the permanent-liquidity lock are consensus rules"
    );
  }
}

/**
 * The offline launch ceremony (`npm run tokenomics:check`) refuses a file
 * that is not an explicit value-bearing class. Test classes and omitted
 * classes stay valid for devnets; they are not a launch ceremony.
 */
export function assertLaunchCeremonyNetworkClass(genesis: object): void {
  const networkClass = readNetworkClass(genesis);
  if (!isStrictNetworkClass(networkClass)) {
    throw new Error(
      "Launch ceremony genesis must declare networkClass \"public-launch\", \"value-bearing\", or \"mainnet\""
    );
  }
}
