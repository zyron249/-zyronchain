import { canonicalJson, sha256Hex } from "./codec.js";
import { MAX_SUPPLY_ATOMS } from "./types.js";
import type { ActivitySettlementTx, Address, GenesisConfig, ProtocolUpgradeTx, Transaction, TransferTx, ValidatorSetUpdateTx } from "./types.js";

interface AccountState {
  balanceAtoms: number;
  nonce: number;
}

export interface LedgerSnapshot {
  accounts: Array<{ address: Address; balanceAtoms: number; nonce: number }>;
  settledActivityEpochs: number[];
}

export class LedgerState {
  private readonly accounts: Map<Address, AccountState>;
  private readonly settledActivityEpochs: Set<number>;

  constructor(
    accounts: Map<Address, AccountState> = new Map(),
    epochs: Set<number> = new Set()
  ) {
    this.accounts = accounts;
    this.settledActivityEpochs = epochs;
  }

  static fromGenesis(genesis: GenesisConfig): LedgerState {
    const state = new LedgerState();
    let supply = 0;
    for (const allocation of genesis.allocations) {
      if (!Number.isSafeInteger(allocation.amountAtoms) || allocation.amountAtoms < 0) {
        throw new Error("Invalid genesis allocation");
      }
      supply += allocation.amountAtoms;
      if (!Number.isSafeInteger(supply) || supply > MAX_SUPPLY_ATOMS) {
        throw new Error("Genesis supply exceeds maximum supply");
      }
      state.credit(allocation.address, allocation.amountAtoms);
    }
    return state;
  }

  clone(): LedgerState {
    return new LedgerState(
      new Map([...this.accounts].map(([address, account]) => [address, { ...account }])),
      new Set(this.settledActivityEpochs)
    );
  }

  balance(address: Address): number {
    return this.accounts.get(address)?.balanceAtoms ?? 0;
  }

  nonce(address: Address): number {
    return this.accounts.get(address)?.nonce ?? 0;
  }

  isActivityEpochSettled(epoch: number): boolean {
    return this.settledActivityEpochs.has(epoch);
  }

  apply(tx: Transaction, activityPool: Address): void {
    if (tx.kind === "transfer") this.applyTransfer(tx);
    else if (tx.kind === "activity_settlement") this.applyActivity(tx, activityPool);
    else if (tx.kind === "validator_update") this.applyValidatorUpdate(tx);
    else this.applyProtocolUpgrade(tx);
  }

  root(): string {
    return sha256Hex(canonicalJson(this.snapshot()));
  }

  snapshot(): LedgerSnapshot {
    return {
      accounts: [...this.accounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([address, state]) => ({ address, ...state })),
      settledActivityEpochs: [...this.settledActivityEpochs].sort((a, b) => a - b)
    };
  }

  private applyTransfer(tx: TransferTx): void {
    this.requireNonce(tx.sender, tx.nonce);
    const total = tx.amountAtoms + tx.feeAtoms;
    if (!Number.isSafeInteger(total) || this.balance(tx.sender) < total) {
      throw new Error("Insufficient balance");
    }
    this.debit(tx.sender, total);
    this.credit(tx.receiver, tx.amountAtoms);
    this.setNonce(tx.sender, tx.nonce);
  }

  private applyActivity(tx: ActivitySettlementTx, activityPool: Address): void {
    if (tx.sender !== activityPool) throw new Error("Invalid activity pool sender");
    if (this.settledActivityEpochs.has(tx.epoch)) throw new Error("Activity epoch already settled");
    this.requireNonce(activityPool, tx.nonce);
    const total = tx.entries.reduce((sum, entry) => {
      const next = sum + entry.amountAtoms;
      if (!Number.isSafeInteger(next)) throw new Error("Activity total overflow");
      return next;
    }, 0);
    if (this.balance(activityPool) < total) throw new Error("Activity pool exhausted");
    this.debit(activityPool, total);
    for (const entry of tx.entries) this.credit(entry.receiver, entry.amountAtoms);
    this.setNonce(activityPool, tx.nonce);
    this.settledActivityEpochs.add(tx.epoch);
  }

  private applyValidatorUpdate(tx: ValidatorSetUpdateTx): void {
    this.requireNonce(tx.sender, tx.nonce);
    this.setNonce(tx.sender, tx.nonce);
  }

  private applyProtocolUpgrade(tx: ProtocolUpgradeTx): void {
    this.requireNonce(tx.sender, tx.nonce);
    this.setNonce(tx.sender, tx.nonce);
  }

  private requireNonce(address: Address, nonce: number): void {
    if (nonce !== this.nonce(address) + 1) throw new Error("Invalid nonce");
  }

  private credit(address: Address, amount: number): void {
    const current = this.balance(address);
    const next = current + amount;
    if (!Number.isSafeInteger(next) || next > MAX_SUPPLY_ATOMS) throw new Error("Balance overflow");
    const account = this.accounts.get(address) ?? { balanceAtoms: 0, nonce: 0 };
    account.balanceAtoms = next;
    this.accounts.set(address, account);
  }

  private debit(address: Address, amount: number): void {
    const account = this.accounts.get(address) ?? { balanceAtoms: 0, nonce: 0 };
    if (account.balanceAtoms < amount) throw new Error("Insufficient balance");
    account.balanceAtoms -= amount;
    this.accounts.set(address, account);
  }

  private setNonce(address: Address, nonce: number): void {
    const account = this.accounts.get(address) ?? { balanceAtoms: 0, nonce: 0 };
    account.nonce = nonce;
    this.accounts.set(address, account);
  }
}
