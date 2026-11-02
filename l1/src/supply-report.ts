// Read-only supply report for GET /supply (Red Team Session 1, INFO #5).
// Derived from current ledger state only; it changes no supply logic.
// Reconciles like tools/supply-verifier: balances + pending + burned = total,
// with locked a subset of balances. The protocol has no escrow state, so
// pending is 0.
//
// NO-MINT ASSUMPTION: the whole supply is allocated at genesis, mining is
// retired and no transaction kind mints, so totalSupplyAtoms is the genesis
// supply (50,000,000 ZYN on the fixed-supply genesis) and never changes. Fees
// are burned, so burned = total - balances - pending can only grow, and
// circulating = total - burned - pending - locked. If a minting path were ever
// added this report would have to change, and reconciles would no longer prove
// anything; supplyChanges is therefore a constant false, not a measurement.
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
  /** Always false: total supply is fixed at genesis (see the no-mint assumption above). */
  supplyChanges: false;
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
    // = balances - locked whenever the report reconciles.
    circulatingAtoms: (reconciles ? total - burned - pending - locked : balances - locked).toString(),
    pendingAtoms: pending.toString(),
    burnedAtoms: reconciles ? burned.toString() : null,
    supplyChanges: false,
    reconciles,
    note: "totalSupply is fixed at genesis and never changes (nothing mints; fees are burned); " +
      "balances + pending + burned = totalSupply; locked is part of balances; circulating = totalSupply - burned - pending - locked"
  };
}
