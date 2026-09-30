import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type Address, type Allocation, type GenesisConfig } from "./types.js";

export const FIXED_SUPPLY_TOTAL_ZYN = 50_000_000;
export const FOUNDER_ALLOCATION_ZYN = 5_000_000;
export const PUBLIC_DISTRIBUTION_ZYN = 20_000_000;
export const LIQUIDITY_RESERVE_ZYN = 20_000_000;
export const ECOSYSTEM_RESERVE_ZYN = 5_000_000;

export const FOUNDER_ALLOCATION_ATOMS = FOUNDER_ALLOCATION_ZYN * ATOMS_PER_ZYN;
export const PUBLIC_DISTRIBUTION_ATOMS = PUBLIC_DISTRIBUTION_ZYN * ATOMS_PER_ZYN;
export const LIQUIDITY_RESERVE_ATOMS = LIQUIDITY_RESERVE_ZYN * ATOMS_PER_ZYN;
export const ECOSYSTEM_RESERVE_ATOMS = ECOSYSTEM_RESERVE_ZYN * ATOMS_PER_ZYN;

export const FOUNDER_CLIFF_MONTHS = 12;
export const FOUNDER_LINEAR_VESTING_MONTHS = 36;

export interface FixedSupplyAddresses {
  founder: Address;
  publicDistribution: Address;
  liquidityReserve: Address;
  ecosystemReserve: Address;
}

const RESERVED_MINING_TRACKER = `ZYN${"0".repeat(40)}`;

export function buildFixedSupplyAllocations(addresses: FixedSupplyAddresses): Allocation[] {
  assertFixedSupplyAddresses(addresses);
  const allocations: Allocation[] = [
    { address: addresses.founder, amountAtoms: FOUNDER_ALLOCATION_ATOMS },
    { address: addresses.publicDistribution, amountAtoms: PUBLIC_DISTRIBUTION_ATOMS },
    { address: addresses.liquidityReserve, amountAtoms: LIQUIDITY_RESERVE_ATOMS },
    { address: addresses.ecosystemReserve, amountAtoms: ECOSYSTEM_RESERVE_ATOMS }
  ];
  assertFixedSupplyAllocations(allocations, addresses);
  return allocations;
}

export function assertFixedSupplyAllocations(
  allocations: readonly Allocation[],
  addresses: FixedSupplyAddresses
): void {
  assertFixedSupplyAddresses(addresses);
  if (!Array.isArray(allocations) || allocations.length !== 4) {
    throw new Error("Fixed-supply genesis requires exactly four disclosed allocation accounts");
  }

  const expected = new Map<Address, number>([
    [addresses.founder, FOUNDER_ALLOCATION_ATOMS],
    [addresses.publicDistribution, PUBLIC_DISTRIBUTION_ATOMS],
    [addresses.liquidityReserve, LIQUIDITY_RESERVE_ATOMS],
    [addresses.ecosystemReserve, ECOSYSTEM_RESERVE_ATOMS]
  ]);

  const seen = new Set<Address>();
  let total = 0;
  for (const allocation of allocations) {
    assertZynAddress(allocation.address);
    if (!Number.isSafeInteger(allocation.amountAtoms) || allocation.amountAtoms < 0) {
      throw new Error("Invalid fixed-supply allocation amount");
    }
    if (seen.has(allocation.address)) throw new Error("Duplicate fixed-supply allocation address");
    seen.add(allocation.address);

    const required = expected.get(allocation.address);
    if (required === undefined || allocation.amountAtoms !== required) {
      throw new Error("Genesis allocation does not match the frozen fixed-supply plan");
    }
    total += allocation.amountAtoms;
    if (!Number.isSafeInteger(total)) throw new Error("Fixed-supply allocation total overflow");
  }

  if (seen.size !== expected.size) throw new Error("Fixed-supply allocation role is missing");
  if (total !== MAX_SUPPLY_ATOMS || total !== FIXED_SUPPLY_TOTAL_ZYN * ATOMS_PER_ZYN) {
    throw new Error("Fixed-supply genesis must allocate exactly 50,000,000 ZYN");
  }
}

export function assertFixedSupplyGenesis(genesis: GenesisConfig, addresses: FixedSupplyAddresses): void {
  assertFixedSupplyAllocations(genesis.allocations, addresses);
  // ZC-CRY-20260930-006 (owner decision 2026-09-30): the activity airdrop is paid
  // only from the 5M ecosystem/community allocation. Any genesis activity oracle
  // can move the whole activityPool balance with one settlement, so the pool must
  // never be the founder, public-distribution, or permanent-liquidity account.
  // Consensus also refuses inflows to the activity pool, so cumulative airdrops can
  // never exceed this genesis allocation (ECOSYSTEM_RESERVE_ATOMS).
  if (genesis.activityPool === addresses.founder ||
      genesis.activityPool === addresses.publicDistribution ||
      genesis.activityPool === addresses.liquidityReserve) {
    throw new Error("Fixed-supply activity pool must not be the founder, public-distribution, or permanent-liquidity allocation");
  }
  if (genesis.activityPool !== addresses.ecosystemReserve) {
    throw new Error("Fixed-supply activity pool must be the ecosystem/community allocation");
  }
}

export function fixedSupplyPlanAtoms(): Readonly<{
  founder: number;
  publicDistribution: number;
  liquidityReserve: number;
  ecosystemReserve: number;
  total: number;
}> {
  return Object.freeze({
    founder: FOUNDER_ALLOCATION_ATOMS,
    publicDistribution: PUBLIC_DISTRIBUTION_ATOMS,
    liquidityReserve: LIQUIDITY_RESERVE_ATOMS,
    ecosystemReserve: ECOSYSTEM_RESERVE_ATOMS,
    total: MAX_SUPPLY_ATOMS
  });
}

function assertFixedSupplyAddresses(addresses: FixedSupplyAddresses): void {
  const entries = Object.entries(addresses) as Array<[keyof FixedSupplyAddresses, Address]>;
  const seen = new Set<string>();
  for (const [role, address] of entries) {
    assertZynAddress(address);
    if (address === RESERVED_MINING_TRACKER) {
      throw new Error(`Fixed-supply ${role} address cannot be the reserved mining tracker`);
    }
    if (seen.has(address)) throw new Error("Fixed-supply allocation roles must use distinct addresses");
    seen.add(address);
  }
}

function assertZynAddress(address: string): asserts address is Address {
  if (typeof address !== "string" || !/^ZYN[0-9a-f]{40}$/.test(address)) {
    throw new Error("Invalid fixed-supply ZYN address");
  }
}
