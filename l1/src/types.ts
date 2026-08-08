export const ATOMS_PER_ZYN = 100_000_000;
export const MAX_SUPPLY_ATOMS = 50_000_000 * ATOMS_PER_ZYN;

export type Address = `ZYN${string}`;

export interface Validator {
  address: Address;
  publicKey: string;
}

export interface Allocation {
  address: Address;
  amountAtoms: number;
}

export interface GenesisConfig {
  chainId: string;
  timestampMs: number;
  validators: Validator[];
  activityOracles: string[];
  activityPool: Address;
  allocations: Allocation[];
}

export interface TransferTx {
  kind: "transfer";
  version: 1;
  chainId: string;
  nonce: number;
  sender: Address;
  receiver: Address;
  amountAtoms: number;
  feeAtoms: number;
  timestampMs: number;
  publicKey: string;
  signature: string;
  txid: string;
}

export interface ActivityEntry {
  receiver: Address;
  amountAtoms: number;
}

export interface ActivitySettlementTx {
  kind: "activity_settlement";
  version: 1;
  chainId: string;
  nonce: number;
  sender: Address;
  epoch: number;
  entries: ActivityEntry[];
  receiptRoot: string;
  feeAtoms: 0;
  timestampMs: number;
  publicKey: string;
  signature: string;
  txid: string;
}

export interface ValidatorApproval {
  validator: Address;
  publicKey: string;
  signature: string;
}

export interface ValidatorSetUpdateTx {
  kind: "validator_update";
  version: 1;
  chainId: string;
  nonce: number;
  sender: Address;
  activationHeight: number;
  validators: Validator[];
  approvals: ValidatorApproval[];
  feeAtoms: 0;
  timestampMs: number;
  publicKey: string;
  signature: string;
  txid: string;
}

export interface ProtocolUpgradeTx {
  kind: "protocol_upgrade";
  version: 1;
  chainId: string;
  nonce: number;
  sender: Address;
  activationHeight: number;
  protocolVersion: number;
  approvals: ValidatorApproval[];
  feeAtoms: 0;
  timestampMs: number;
  publicKey: string;
  signature: string;
  txid: string;
}

export type Transaction = TransferTx | ActivitySettlementTx | ValidatorSetUpdateTx | ProtocolUpgradeTx;

export interface BlockHeader {
  version: number;
  chainId: string;
  height: number;
  round: number;
  previousHash: string;
  timestampMs: number;
  transactionRoot: string;
  stateRoot: string;
  proposer: Address | "GENESIS";
}

export interface Block {
  header: BlockHeader;
  transactions: Transaction[];
  hash: string;
  proposerPublicKey: string | null;
  signature: string | null;
  roundCertificate: RoundSkipVote[];
  attestations: BlockAttestation[];
}

export interface BlockAttestation {
  validator: Address;
  publicKey: string;
  signature: string;
}

export interface RoundSkipVote {
  validator: Address;
  publicKey: string;
  chainId: string;
  height: number;
  round: number;
  previousHash: string;
  signature: string;
}
