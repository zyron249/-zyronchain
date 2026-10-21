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
   * transaction encoding and genesis hash are then unchanged (single oracle),
   * unless `activityOraclePolicy` says otherwise.
   */
  activityOracleThreshold?: number;
  /**
   * Versioned activity-oracle policy (docs/ACTIVITY_ORACLE_GOVERNANCE.md).
   * Absent: historical rules (single oracle, or the lenient threshold above).
   * "test-single-v1": explicit dev/test profile. One registered key authorizes.
   *   Refused together with `launchProfile: "fixed-supply-v1"`.
   * "threshold-v1": fail-closed m-of-n (2-of-3 or stricter) and the reduced
   *   configurable cap. Required by `launchProfile: "fixed-supply-v1"`.
   */
  activityOraclePolicy?: "test-single-v1" | "threshold-v1";
  /**
   * Optional per-epoch activity cap in atoms. Allowed only with
   * `activityOraclePolicy`. Omitted: the policy default (historical 10,000 ZYN
   * for test-single-v1, the reduced public-launch cap for threshold-v1).
   * Cannot raise the cap above that policy's maximum.
   */
  activitySettlementCapAtoms?: number;
  /**
   * Optional launch profile (docs/GENESIS_CONFIG_BINDING.md). Absent on every
   * genesis that predates it; its genesis hash and rules are then unchanged.
   * "fixed-supply-v1": the genesis hash commits to the entire genesis
   * configuration, and the genesis is refused unless `allocationLocks` is
   * present, exactly 50,000,000 ZYN is allocated and the four roles hold
   * 5M / 20M / 20M / 5M, at least four distinct validators,
   * `publicDistributionRelease`, and `activityOraclePolicy: "threshold-v1"`.
   */
  launchProfile?: "fixed-supply-v1";
  /**
   * Optional network class, version network-class-v1
   * (docs/GENESIS_NETWORK_CLASS.md). Absent on genesis files that predate it;
   * validation and the genesis hash are then unchanged. A public-launch,
   * value-bearing or mainnet class must also set launchProfile to
   * "fixed-supply-v1", so founder vesting and the permanent-liquidity lock
   * cannot be skipped by choosing another profile.
   */
  networkClass?:
    | "devnet"
    | "local-devnet"
    | "testnet"
    | "private-testnet"
    | "open-testnet"
    | "wallet-testnet"
    | "public-launch"
    | "value-bearing"
    | "mainnet";
  /**
   * Optional public-distribution release, version public-distribution-release-v1
   * (docs/PUBLIC_DISTRIBUTION_RELEASE.md). Absent on genesis files that predate
   * it; that allocation stays spendable and the genesis hash is unchanged.
   * A public-launch, value-bearing or mainnet network class must set it.
   * The address is an input, not a value stored in this repository.
   */
  publicDistributionRelease?: PublicDistributionRelease;
  /**
   * Optional fee policy, protocol rule version fixed-fee-v1
   * (docs/FEE_POLICY_V1.md). Absent on every shipped genesis, including the
   * open testnet: transfer fees stay caller-chosen, the whole fee is burned,
   * and the genesis hash is unchanged. Present only together with
   * `launchProfile: "fixed-supply-v1"`. The single tunable parameter is
   * `fixedTransferFeeAtoms` (proposed default 100,000 atoms = 0.001 ZYN).
   */
  feePolicy?: FeePolicyV1;
}

/** Opt-in fixed transfer fee. See docs/FEE_POLICY_V1.md. Not activated on shipped genesis. */
export interface FeePolicyV1 {
  version: "fixed-fee-v1";
  /** Exact transfer fee in atoms. Proposed launch default: 100,000 (0.001 ZYN). */
  fixedTransferFeeAtoms: number;
}

export interface PublicDistributionRelease {
  /** Public-distribution allocation. Supplied at genesis; not invented here. */
  address: Address;
  /** Milliseconds after the genesis timestamp before any of the allocation vests. */
  cliffMs: number;
  /** Linear release length after the cliff, in milliseconds. */
  linearMs: number;
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

/** Validator-quorum action that pauses settlements or revokes an oracle key. */
export type ActivityOracleGovernanceAction = "pause" | "resume" | "revoke";

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
  /**
   * Inclusive expiry of the threshold-v1 attestation, signed by every oracle.
   * Omitted unless `activityOraclePolicy` is `threshold-v1`.
   */
  attestationExpiresAtMs?: number;
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

export interface ActivityOracleGovernanceTx {
  kind: "activity_oracle_governance";
  version: 1 | 2;
  chainId: string;
  nonce: number;
  sender: Address;
  activationHeight: number;
  action: ActivityOracleGovernanceAction;
  publicKeys: string[];
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

export type Transaction = TransferTx | ActivitySettlementTx | MiningClaimTx | ValidatorSetUpdateTx | ActivityOracleGovernanceTx | ProtocolUpgradeTx;

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
