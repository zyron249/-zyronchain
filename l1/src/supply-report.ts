// Read-only supply report for GET /supply (Red Team Session 1, INFO #5).
// Derived from current ledger state only; it changes no supply logic.
// Reconciles like tools/supply-verifier: balances + pending + burned = total,
// with locked a subset of balances. Mining is retired and nothing mints, so
// burned is the genesis supply minus current balances. The protocol has no
// escrow state, so pending is 0.
import { MAX_SUPPLY_ATOMS, type Address } from "./types.js";

export interface SupplySource {
  height: number;
  tipHash: string;
  genesisSupplyAtoms(): number;
  accounts(): Array<{ address: Address; balanceAtoms: number }>;
  /** Atoms of `balanceAtoms` that allocation locks keep unspendable. */
  lockedAtoms(address: Address, balanceAtoms: number): number;
}

export interface SupplyReport {
  height: number;
  tipHash: string;
  maxSupplyAtoms: string;
  totalSupplyAtoms: string;
  balancesAtoms: string;
  lockedAtoms: string;
  circulatingAtoms: string;
  pendingAtoms: string;
  burnedAtoms: string | null;
  reconciles: boolean;
  note: string;
}

export function supplyReport(source: SupplySource): SupplyReport {
  const total = BigInt(source.genesisSupplyAtoms());
  let balances = 0n;
  let locked = 0n;
  for (const account of source.accounts()) {
    const balance = BigInt(account.balanceAtoms);
    const lockedPart = BigInt(source.lockedAtoms(account.address, account.balanceAtoms));
    if (lockedPart < 0n || lockedPart > balance) throw new Error("locked atoms out of range");
    balances += balance;
    locked += lockedPart;
  }
  const pending = 0n;
  const burned = total - balances - pending;
  const reconciles = burned >= 0n;
  return {
    height: source.height,
    tipHash: source.tipHash,
    maxSupplyAtoms: String(MAX_SUPPLY_ATOMS),
    totalSupplyAtoms: total.toString(),
    balancesAtoms: balances.toString(),
    lockedAtoms: locked.toString(),
    circulatingAtoms: (balances - locked).toString(),
    pendingAtoms: pending.toString(),
    burnedAtoms: reconciles ? burned.toString() : null,
    reconciles,
    note: "balances + pending + burned = totalSupply; locked is part of balances; circulating = balances - locked"
  };
}
