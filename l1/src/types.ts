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
  /**
   * Optional on-chain allocation locks (docs/ALLOCATION_LOCKS.md). Absent on
   * genesis files that predate them; behaviour is then unchanged.
   */
  allocationLocks?: AllocationLocks;
  /**
   * Optional m-of-n activity-oracle approval (docs/ACTIVITY_ORACLE_GOVERNANCE.md):
   * a settlement needs approvals from at least this many distinct keys of
   * `activityOracles`. Absent on genesis files that predate it; behaviour,
   * transaction encoding and genesis hash are then unchanged (single oracle).
   */
  activityOracleThreshold?: number;
}

export interface AllocationLocks {
  /** Founder allocation: 365-day cliff, then 1,095-day linear release from the genesis timestamp. */
  founderVesting: Address;
  /** Permanent-liquidity reserve: no outflow, ever (inflows allowed). */
  permanentLiquidity: Address;
}

export interface TransferTx {
  kind: "transfer";
  version: 1 | 2;
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

/** Signature by one registered activity oracle over the canonical settlement payload. */
export interface ActivityOracleApproval {
  publicKey: string;
  signature: string;
}

export interface ActivitySettlementTx {
  kind: "activity_settlement";
  version: 1 | 2;
  chainId: string;
  nonce: number;
  sender: Address;
  epoch: number;
  entries: ActivityEntry[];
  receiptRoot: string;
  /**
   * Present only under a genesis with `activityOracleThreshold`; the key is
   * omitted entirely otherwise, so legacy settlements keep their exact encoding.
   */
  oracleApprovals?: ActivityOracleApproval[];
  feeAtoms: 0;
  timestampMs: number;
  publicKey: string;
  signature: string;
  txid: string;
}

/**
 * Permissionless protocol-v4 proof-of-work issuance claim.
 *
 * Validators do not choose the reward amount: rewardAtoms is derived from the
 * canonical supply schedule and rechecked against chain state. previousHash and
 * height bind the work to one specific next-block challenge, while sender/publicKey
 * bind a valid solution to the miner that performed the work.
 */
export interface MiningClaimTx {
  kind: "mining_claim";
  version: 2;
  chainId: string;
  nonce: number;
  sender: Address;
  height: number;
  previousHash: string;
  rewardAtoms: number;
  workNonce: string;
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
  version: 1 | 2;
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
  version: 1 | 2;
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

export type Transaction = TransferTx | ActivitySettlementTx | MiningClaimTx | ValidatorSetUpdateTx | ProtocolUpgradeTx;

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
  /**
   * Protocol v6 only (F-01): the round whose CommitVotes form `attestations`.
   * Absent on every v1/v2/v3/v5 block (their encoding is unchanged); `null` on
   * a v6 proposal that is not yet finalized.
   */
  commitRound?: number | null;
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
