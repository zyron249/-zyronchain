import { canonicalJson, compareCanonicalStrings, sha256Hex } from "./codec.js";
import {
  blockHash,
  createGenesisBlock,
  createBlockAttestation,
  createSignedBlock,
  createUnsignedBlock,
  expectedValidator,
  validateAttestationQuorum,
  validateBlockEnvelope,
  validateBlockShape,
  validateRoundCertificate
} from "./block.js";
import { CONSENSUS_V6_PROTOCOL_VERSION, isConsensusV6, validateCommitCertificate } from "./consensus-v6.js";
import { addressFromPublicKey, assertValidPublicKey, publicKeyFromPrivate, verifyCanonical, verifyCanonicalDomain } from "./crypto.js";
import {
  assertMiningClaimContext,
  assertMiningNotRetired,
  MINING_PROTOCOL_VERSION,
  MINING_TRACKER_ADDRESS,
  miningRewardAtoms as scheduledMiningRewardAtoms,
  rejectRetiredMiningClaim
} from "./mining.js";
import {
  ACTIVITY_ORACLE_PAUSED_MESSAGE,
  activityOracleGovernancePublicKeysValid,
  assertActivitySettlementAuthorized,
  validateActivityOraclePolicy,
  validateActivityOracleThreshold,
  type ActivityOracleSet
} from "./activity-oracle.js";
import { merkleRoot } from "./merkle.js";
import { assertNoActivityPoolInflow, LedgerState, type LedgerSnapshot } from "./state.js";
import {
  allocationLockContext,
  assertAllocationLockOutflow,
  spendableAtoms,
  validateAllocationLocks,
  type AllocationLockContext
} from "./allocation-locks.js";
import {
  ACTIVITY_ORDER_MESSAGE,
  ACTIVITY_WINDOW_AMOUNT_ADDRESS,
  ACTIVITY_WINDOW_RESERVED_MESSAGE,
  ACTIVITY_WINDOW_TIME_ADDRESS,
  activityRollingWindowEnforced,
  activitySettlementCapAtoms,
  assertActivityRollingWindow,
  assertNoActivityPoolDirectDebit,
  isActivityWindowAddress,
  activityEpochWindowExpired,
  assertActivityEpochWindow,
  assertActivitySettlementWithinCap
} from "./activity.js";
import {
  SparseMerkleState,
  accountKey,
  applyStateV2Transaction,
  stateV2ActivityEpochSettled,
  stateV2Balance,
  stateV2FromLedgerSnapshot,
  stateV2FromLedgerSnapshotSteps,
  stateV2Nonce,
  stateV2KeyPreimages,
  reconstructStateV2PortableView,
  stateV2TransactionKeyPreimages,
} from "./state-v2.js";
import { validateStateV2PortableBundle, type StateV2PortableBundleV1 } from "./state-v2-portable.js";
import {
  assertAddress,
  assertExactKeys,
  assertPlainRecord,
  validateTransactionShape,
  verifyActivityOracleGovernanceApprovalSignature,
  verifyProtocolUpgradeApprovalSignature,
  verifyValidatorUpdateApprovalSignature
} from "./transaction.js";
import { assertHex } from "./codec.js";
import type {
  Address,
  Block,
  GenesisConfig,
  MiningClaimTx,
  ActivityOracleGovernanceAction,
  ActivityOracleGovernanceTx,
  ProtocolUpgradeTx,
  RoundSkipVote,
  Transaction,
  Validator,
  ValidatorSetUpdateTx
} from "./types.js";
import { MAX_SUPPLY_ATOMS } from "./types.js";
import { assertValueBearingClassRequiresFixedSupplyProfile, minimumValidatorCount } from "./network-class.js";
import { validatePublicDistributionRelease } from "./public-distribution-release.js";
import { assertFixedSupplyLaunchProfile, FIXED_SUPPLY_LAUNCH_PROFILE } from "./tokenomics.js";
import {
  readFeePolicy,
  splitFixedFee,
  validateGenesisFeePolicy,
  type FixedFeeApplication
} from "./fee-policy.js";
import {
  assertGenesisPossessionProofs,
  assertValidatorUpdatePossessionProofs,
  assertValueBearingClassRequiresValidatorAdmission,
  hasValidatorAdmission,
  validateValidatorAdmissionShape,
  type ValidatorUpdateAdmissionContext
} from "./validator-admission.js";

const MAX_BLOCK_BYTES = 2_000_000;
export const MAX_BLOCK_TRANSACTION_BYTES = 1_500_000;
export const MIN_VALIDATOR_UPDATE_DELAY = 100;
export const MIN_PROTOCOL_UPDATE_DELAY = 100;
// Protocol 6 (F-01) = the v5 state and transaction model with the locked
// two-phase consensus of consensus-v6.ts. 4 remains unsupported.
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([1, 2, 3, 5, 6]);

export function protocolUsesStateV2(protocolVersion: number): boolean {
  return protocolVersion === 2 || protocolVersion === 3 || protocolVersion === 5 || protocolVersion === 6;
}

interface AppliedTransition {
  ledger: LedgerState | undefined;
  sparse: SparseMerkleState | undefined;
}

export interface ActivityOracleGovernanceEntry {
  activationHeight: number;
  action: ActivityOracleGovernanceAction;
  publicKeys: string[];
}

export interface ChainSnapshotV1 {
  version: 1;
  chainId: string;
  genesisHash: string;
  height: number;
  tip: Block;
  state: LedgerSnapshot;
  validatorSchedule: Array<{ activationHeight: number; validators: Validator[] }>;
  protocolSchedule: Array<{ activationHeight: number; protocolVersion: number }>;
}

/** Snapshot version 2 adds the activity-oracle pause/revoke schedule. Version 1 is unchanged. */
export interface ChainSnapshotV2 extends Omit<ChainSnapshotV1, "version"> {
  version: 2;
  activityOracleGovernance: ActivityOracleGovernanceEntry[];
}

export type ChainSnapshot = ChainSnapshotV1 | ChainSnapshotV2;

export class ZyronChain {
  readonly genesis: GenesisConfig;
  private readonly genesisBlock: Block;
  private readonly genesisSupplyAtomsValue: number;
  private tipBlock: Block;
  private currentHeight = 0;
  private readonly validatorSchedule = new Map<number, Validator[]>();
  private readonly protocolSchedule = new Map<number, number>();
  private readonly activityOracleGovernance = new Map<number, { action: ActivityOracleGovernanceAction; publicKeys: string[] }>();
  private state: LedgerState | undefined;
  private stateV2: SparseMerkleState | undefined;
  private stateV2SemanticKeys: Set<string> | undefined;

  constructor(genesis: GenesisConfig) {
    validateGenesis(genesis);
    this.genesis = structuredClone(genesis);
    this.state = LedgerState.fromGenesis(genesis);
    this.genesisSupplyAtomsValue = this.state.totalSupplyAtoms();
    this.genesisBlock = createGenesisBlock(genesis, this.state.root());
    this.tipBlock = this.genesisBlock;
    this.validatorSchedule.set(0, structuredClone(genesis.validators));
    this.protocolSchedule.set(0, 1);
  }

  static fromTrustedSnapshot(
    genesis: GenesisConfig,
    value: unknown,
    anchor: { tipHash: string; snapshotSha256: string }
  ): ZyronChain {
    const steps = ZyronChain.trustedSnapshotSteps(genesis, value, anchor);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /**
   * fromTrustedSnapshot (same checks, same result) in bounded steps: after each
   * step it calls onStep and yields to the event loop, so loading a large
   * checkpoint (the State-v2 rebuild hashes a key path per account) keeps the
   * process responsive and reports progress (Codex P2 on #1060). The caller
   * must own `value` and not change it while this runs.
   */
  static async fromTrustedSnapshotInSteps(
    genesis: GenesisConfig,
    value: unknown,
    anchor: { tipHash: string; snapshotSha256: string },
    onStep: () => void = () => {}
  ): Promise<ZyronChain> {
    const steps = ZyronChain.trustedSnapshotSteps(genesis, value, anchor);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      onStep();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private static *trustedSnapshotSteps(
    genesis: GenesisConfig,
    value: unknown,
    anchor: { tipHash: string; snapshotSha256: string }
  ): Generator<void, ZyronChain, undefined> {
    assertHex(anchor.tipHash, 32, "trusted checkpoint tip hash");
    assertHex(anchor.snapshotSha256, 32, "trusted checkpoint snapshot digest");
    if (sha256Hex(canonicalJson(value)) !== anchor.snapshotSha256) {
      throw new Error("Trusted checkpoint snapshot digest mismatch");
    }
    yield;
    assertPlainRecord(value, "chain snapshot");
    const snapshotVersion = (value as { version?: unknown }).version;
    if (snapshotVersion !== 1 && snapshotVersion !== 2) throw new Error("Invalid checkpoint version");
    assertExactKeys(value, [
      "version", "chainId", "genesisHash", "height", "tip", "state", "validatorSchedule", "protocolSchedule",
      ...(snapshotVersion === 2 ? ["activityOracleGovernance"] : [])
    ], "chain snapshot");
    const snapshot = value as unknown as ChainSnapshot;
    const chain = new ZyronChain(genesis);
    if (snapshot.chainId !== genesis.chainId || snapshot.genesisHash !== chain.genesisHash) {
      throw new Error("Trusted checkpoint chain identity mismatch");
    }
    if (!Number.isSafeInteger(snapshot.height) || snapshot.height < 0) throw new Error("Invalid checkpoint height");
    validateBlockShape(snapshot.tip);
    if (snapshot.tip.header.chainId !== snapshot.chainId || snapshot.tip.header.height !== snapshot.height ||
        snapshot.tip.hash !== anchor.tipHash || blockHash(snapshot.tip.header) !== snapshot.tip.hash) {
      throw new Error("Trusted checkpoint tip mismatch");
    }
    // The tip hash and its finality certificate authenticate only the header.
    // Bind the tip body to header.transactionRoot exactly as live block
    // validation does, so a pinned snapshot cannot pair a certified header
    // with a different transaction list that this node would then store and
    // serve as its tip.
    if (snapshot.tip.header.transactionRoot !== merkleRoot(snapshot.tip.transactions)) {
      throw new Error("Trusted checkpoint tip transaction root mismatch");
    }
    // merkleRoot duplicates the last leaf of an odd level, so a body with its
    // odd tail repeated keeps the same root. Live validation rejects that in
    // applyTransactions; this path does not re-execute the tip, so check here.
    const tipTxids = new Set<string>();
    for (const tx of snapshot.tip.transactions) {
      if (tipTxids.has(tx.txid)) throw new Error("Trusted checkpoint tip contains a duplicate transaction");
      tipTxids.add(tx.txid);
    }

    const validatorSchedule = validateValidatorSchedule(
      snapshot.validatorSchedule,
      genesis.validators,
      minimumValidatorCount(genesis)
    );
    const protocolSchedule = validateProtocolSchedule(snapshot.protocolSchedule);
    chain.validatorSchedule.clear();
    for (const [height, validators] of validatorSchedule) chain.validatorSchedule.set(height, validators);
    chain.protocolSchedule.clear();
    for (const [height, version] of protocolSchedule) chain.protocolSchedule.set(height, version);
    const activityOracleGovernance = snapshot.version === 2
      ? validateActivityOracleGovernanceSchedule(snapshot.activityOracleGovernance, genesis)
      : [];
    chain.activityOracleGovernance.clear();
    for (const entry of activityOracleGovernance) {
      chain.activityOracleGovernance.set(entry.activationHeight, { action: entry.action, publicKeys: [...entry.publicKeys] });
    }

    const state = LedgerState.fromSnapshot(snapshot.state);
    yield;
    const governance = {
      validatorSchedule: [...validatorSchedule].map(([activationHeight, validators]) => ({
        activationHeight, validators: structuredClone(validators)
      })),
      protocolSchedule: [...protocolSchedule].map(([activationHeight, protocolVersion]) => ({ activationHeight, protocolVersion })),
      ...(activityOracleGovernance.length ? { activityOracleGovernance } : {})
    };
    const protocolVersion = chain.protocolVersionAt(snapshot.height);
    assertSupportedProtocolVersion(protocolVersion);
    // The finality rule is selected by the governed protocol version at the tip
    // height, so a v6 header must never be checked under a legacy schedule (or
    // the reverse). Legacy (v1-v5) headers under a legacy schedule are untouched.
    if ((snapshot.tip.header.version === CONSENSUS_V6_PROTOCOL_VERSION) !== isConsensusV6(protocolVersion)) {
      throw new Error("Trusted checkpoint tip protocol version mismatch");
    }
    const sparse = protocolUsesStateV2(protocolVersion) ? yield* stateV2FromLedgerSnapshotSteps(state.snapshot(), governance) : undefined;
    yield;
    const stateRoot = protocolVersion === 1 ? state.root() : sparse!.root();
    if (snapshot.tip.header.stateRoot !== stateRoot) throw new Error("Trusted checkpoint state root mismatch");

    if (snapshot.height === 0) {
      if (canonicalJson(snapshot.tip) !== canonicalJson(chain.genesisBlock)) throw new Error("Invalid genesis checkpoint tip");
    } else {
      const validators = chain.validatorsAt(snapshot.height);
      const expected = expectedValidator(validators, snapshot.height, snapshot.tip.header.round);
      const proposerSignatureValid = snapshot.tip.signature && (protocolVersion >= 3
        ? verifyCanonicalDomain("zyronchain/block-proposal/v1", snapshot.tip.header, snapshot.tip.signature, expected.publicKey)
        : verifyCanonical(snapshot.tip.header, snapshot.tip.signature, expected.publicKey));
      if (snapshot.tip.header.proposer !== expected.address || snapshot.tip.proposerPublicKey !== expected.publicKey ||
          !proposerSignatureValid) {
        throw new Error("Invalid checkpoint proposer signature");
      }
      if (isConsensusV6(protocolVersion)) {
        // Protocol v6 (F-01) finality is the commit certificate, never legacy
        // attestations. Apply exactly the rule live block acceptance uses
        // (validateBlock with requireFinality): no round skip certificate in the
        // block, and >= q distinct CommitVotes over {chainId, height,
        // commitRound, blockHash} from validatorsAt(height).
        if (snapshot.tip.roundCertificate.length !== 0) {
          throw new Error("Protocol v6 blocks must not carry a round skip certificate");
        }
        validateCommitCertificate(snapshot.tip, validators);
      } else {
        validateRoundCertificate(snapshot.tip, validators);
        validateAttestationQuorum(snapshot.tip, validators);
      }
    }

    chain.state = protocolUsesStateV2(protocolVersion) ? undefined : state;
    chain.stateV2 = sparse;
    chain.stateV2SemanticKeys = sparse ? new Set(stateV2KeyPreimages(state.snapshot(), governance)) : undefined;
    chain.tipBlock = structuredClone(snapshot.tip);
    chain.currentHeight = snapshot.height;
    return chain;
  }

  /**
   * Reconstructs the canonical full checkpoint from root-authenticated portable
   * State-v2 records. The same external full-snapshot digest/tip anchor remains
   * authoritative; portable state does not introduce a weaker trust mode.
   */
  static fromTrustedPortableState(
    genesis: GenesisConfig,
    tip: Block,
    bundle: StateV2PortableBundleV1,
    anchor: { tipHash: string; snapshotSha256: string }
  ): ZyronChain {
    validateBlockShape(tip);
    const validated = validateStateV2PortableBundle(bundle, tip.header.stateRoot);
    const activeProtocol = [...validated.view.governance.protocolSchedule]
      .filter((entry) => entry.activationHeight <= tip.header.height)
      .at(-1)?.protocolVersion;
    if (activeProtocol === undefined || !protocolUsesStateV2(activeProtocol)) {
      throw new Error("Portable State v2 checkpoint requires an active State-v2 protocol");
    }
    const base = new ZyronChain(genesis);
    const oracleGovernance = validated.view.governance.activityOracleGovernance;
    const snapshot: ChainSnapshot = oracleGovernance && oracleGovernance.length > 0
      ? {
        version: 2,
        chainId: genesis.chainId,
        genesisHash: base.genesisHash,
        height: tip.header.height,
        tip: structuredClone(tip),
        state: validated.view.ledger,
        validatorSchedule: validated.view.governance.validatorSchedule,
        protocolSchedule: validated.view.governance.protocolSchedule,
        activityOracleGovernance: oracleGovernance.map((entry) => ({
          activationHeight: entry.activationHeight,
          action: entry.action,
          publicKeys: [...entry.publicKeys]
        }))
      }
      : {
        version: 1,
        chainId: genesis.chainId,
        genesisHash: base.genesisHash,
        height: tip.header.height,
        tip: structuredClone(tip),
        state: validated.view.ledger,
        validatorSchedule: validated.view.governance.validatorSchedule,
        protocolSchedule: validated.view.governance.protocolSchedule
      };
    return ZyronChain.fromTrustedSnapshot(genesis, snapshot, anchor);
  }

  get height(): number {
    return this.currentHeight;
  }

  get tip(): Block {
    return this.tipBlock;
  }

  get genesisHash(): string {
    return this.genesisBlock.hash;
  }

  getState(): LedgerState {
    if (this.state) return this.state.clone();
    return LedgerState.fromSnapshot(this.stateV2PortableView().ledger);
  }

  stateV2ForPersistence(): SparseMerkleState | undefined {
    return this.stateV2;
  }

  validatedStateV2ForBlock(block: Block, nowMs = Date.now()): SparseMerkleState | undefined {
    return this.validateFinalizedTransition(block, nowMs).sparse;
  }

  balance(address: Address): number {
    return this.stateV2 && protocolUsesStateV2(this.protocolVersionAt(this.height))
      ? stateV2Balance(this.stateV2, address)
      : this.requireLegacyState().balance(address);
  }

  /**
   * Confirmed balance that `address` may move in the next block (allocation
   * locks applied at the earliest next-block timestamp for `nowMs`). Equal to
   * balance() for every account that is not locked.
   */
  spendableBalance(address: Address, nowMs = Date.now()): number {
    return spendableAtoms(this.allocationLocksAt(this.nextBlockTimestampMs(nowMs)), address, this.balance(address));
  }

  /** Allocation-lock context for a block at `blockTimestampMs` (undefined without genesis locks). */
  allocationLocksAt(blockTimestampMs: number): AllocationLockContext | undefined {
    return allocationLockContext(this.genesis, blockTimestampMs);
  }

  nonce(address: Address): number {
    return this.stateV2 && protocolUsesStateV2(this.protocolVersionAt(this.height))
      ? stateV2Nonce(this.stateV2, address)
      : this.requireLegacyState().nonce(address);
  }

  totalSupplyAtoms(): number {
    if (this.state) return this.state.totalSupplyAtoms();
    return LedgerState.fromSnapshot(this.stateV2PortableView().ledger).totalSupplyAtoms();
  }

  genesisSupplyAtoms(): number {
    return this.genesisSupplyAtomsValue;
  }

  miningClaimCount(): number {
    return this.stateV2 && protocolUsesStateV2(this.protocolVersionAt(this.height))
      ? stateV2Nonce(this.stateV2, MINING_TRACKER_ADDRESS)
      : this.requireLegacyState().miningClaimCount();
  }

  nextMiningRewardAtoms(): number {
    return scheduledMiningRewardAtoms(this.miningClaimCount(), this.genesisSupplyAtomsValue);
  }

  snapshot(): ChainSnapshot {
    const ledger = this.state ? this.state.snapshot() : this.stateV2PortableView().ledger;
    const common = {
      chainId: this.genesis.chainId,
      genesisHash: this.genesisHash,
      height: this.height,
      tip: structuredClone(this.tip),
      state: ledger,
      validatorSchedule: [...this.validatorSchedule.entries()]
        .sort(([a], [b]) => a - b)
        .map(([activationHeight, validators]) => ({ activationHeight, validators: structuredClone(validators) })),
      protocolSchedule: [...this.protocolSchedule.entries()]
        .sort(([a], [b]) => a - b)
        .map(([activationHeight, protocolVersion]) => ({ activationHeight, protocolVersion }))
    };
    const activityOracleGovernance = [...this.activityOracleGovernance.entries()]
      .sort(([a], [b]) => a - b)
      .map(([activationHeight, entry]) => ({
        activationHeight,
        action: entry.action,
        publicKeys: [...entry.publicKeys]
      }));
    // Version 1 stays byte-identical until a pause or revoke is scheduled.
    if (activityOracleGovernance.length === 0) return { version: 1, ...common };
    return { version: 2, ...common, activityOracleGovernance };
  }

  stateV2SemanticKeyPreimages(): string[] | undefined {
    if (!protocolUsesStateV2(this.protocolVersionAt(this.height)) || !this.stateV2 || !this.stateV2SemanticKeys) return undefined;
    return [...this.stateV2SemanticKeys].sort();
  }

  stateV2SemanticKeyPreimagesForBlock(block: Block): string[] {
    const keys = new Set(this.stateV2SemanticKeys ?? stateV2KeyPreimages(this.requireLegacyState().snapshot(), this.governanceSnapshot()));
    for (const tx of block.transactions) {
      for (const key of stateV2KeysForTransaction(tx, this.genesis, block.header.proposer)) keys.add(key);
    }
    return [...keys].sort();
  }

  validatorsAt(height: number): Validator[] {
    if (!Number.isSafeInteger(height) || height < 0) throw new Error("Invalid validator height");
    let selected = this.genesis.validators;
    let selectedHeight = 0;
    for (const [activationHeight, validators] of this.validatorSchedule) {
      if (activationHeight <= height && activationHeight >= selectedHeight) {
        selected = validators;
        selectedHeight = activationHeight;
      }
    }
    return structuredClone(selected);
  }

  protocolVersionAt(height: number): number {
    if (!Number.isSafeInteger(height) || height < 0) throw new Error("Invalid protocol height");
    let selectedVersion = 1;
    let selectedHeight = 0;
    for (const [activationHeight, version] of this.protocolSchedule) {
      if (activationHeight <= height && activationHeight >= selectedHeight) {
        selectedVersion = version;
        selectedHeight = activationHeight;
      }
    }
    return selectedVersion;
  }

  attestBlock(block: Block, validatorPrivateKey: string): Block {
    const publicKey = publicKeyFromPrivate(validatorPrivateKey);
    const validator = this.validatorsAt(block.header.height).find((item) => item.publicKey === publicKey);
    if (!validator) throw new Error("Attestor is not in validator set");
    if (block.attestations.some((item) => item.validator === validator.address)) {
      throw new Error("Validator already attested block");
    }
    const copy = structuredClone(block);
    copy.attestations.push(createBlockAttestation(block, validatorPrivateKey, publicKey));
    return copy;
  }

  produceBlock(
    transactions: Transaction[],
    proposerPrivateKey: string,
    options: { round?: number; timestampMs?: number; roundCertificate?: RoundSkipVote[] } = {}
  ): Block {
    const publicKey = publicKeyFromPrivate(proposerPrivateKey);
    const unsigned = this.prepareBlock(transactions, publicKey, options);
    const block = createSignedBlock({
      version: unsigned.header.version,
      chainId: unsigned.header.chainId,
      height: unsigned.header.height,
      round: unsigned.header.round,
      previousHash: unsigned.header.previousHash,
      timestampMs: unsigned.header.timestampMs,
      transactions: unsigned.transactions,
      stateRoot: unsigned.header.stateRoot,
      proposerPrivateKey,
      proposerPublicKey: publicKey,
      roundCertificate: unsigned.roundCertificate
    });
    this.validatePreparedBlock(block, unsigned.header.timestampMs);
    return block;
  }

  prepareBlock(
    transactions: Transaction[],
    proposerPublicKey: string,
    options: { round?: number; timestampMs?: number; roundCertificate?: RoundSkipVote[] } = {}
  ): Block {
    const round = options.round ?? 0;
    const protocolVersion = this.protocolVersionAt(this.height + 1);
    assertSupportedProtocolVersion(protocolVersion);
    const validators = this.validatorsAt(this.height + 1);
    const expected = expectedValidator(validators, this.height + 1, round);
    if (proposerPublicKey !== expected.publicKey || addressFromPublicKey(proposerPublicKey) !== expected.address) {
      throw new Error("Public key is not the expected proposer");
    }
    const timestampMs = options.timestampMs ?? Math.max(Date.now(), this.tip.header.timestampMs + 1);
    const next = this.validateAndApply(
      transactions, this.state, this.height + 1, timestampMs, addressFromPublicKey(proposerPublicKey)
    );
    const block = createUnsignedBlock({
      version: protocolVersion,
      chainId: this.genesis.chainId,
      height: this.height + 1,
      round,
      previousHash: this.tip.hash,
      timestampMs,
      transactions,
      stateRoot: stateRootForProtocol(protocolVersion, next),
      proposerPublicKey,
      roundCertificate: options.roundCertificate ?? []
    });
    this.validatePreparedUnsignedBlock(block, timestampMs);
    return block;
  }

  validatePreparedUnsignedBlock(block: Block, nowMs = Date.now()): void {
    const protocolVersion = this.protocolVersionAt(block.header.height);
    assertSupportedProtocolVersion(protocolVersion);
    validateBlockEnvelope(block, this.tip, this.validatorsAt(block.header.height), nowMs, false, protocolVersion, false);
    if (Buffer.byteLength(canonicalJson(block), "utf8") > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
    const next = this.validateAndApply(
      block.transactions, this.state, block.header.height, block.header.timestampMs, feeProducerOf(block)
    );
    if (block.header.stateRoot !== stateRootForProtocol(protocolVersion, next)) throw new Error("State root mismatch");
  }

  validatePreparedBlock(block: Block, nowMs = Date.now()): void {
    const protocolVersion = this.protocolVersionAt(block.header.height);
    const validators = this.validatorsAt(block.header.height);
    validateBlockEnvelope(block, this.tip, validators, nowMs, false, protocolVersion);
    if (Buffer.byteLength(canonicalJson(block), "utf8") > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
  }

  acceptBlock(block: Block, nowMs = Date.now()): void {
    const next = this.validateFinalizedTransition(block, nowMs);
    this.tipBlock = structuredClone(block);
    this.currentHeight = block.header.height;
    if (block.header.version === 1) {
      this.state = next.ledger!;
      this.stateV2 = undefined;
      this.stateV2SemanticKeys = undefined;
    } else {
      const keys = new Set(this.stateV2SemanticKeys ?? stateV2KeyPreimages(this.requireLegacyState().snapshot(), this.governanceSnapshot()));
      for (const tx of block.transactions) {
        for (const key of stateV2KeysForTransaction(tx, this.genesis, block.header.proposer)) keys.add(key);
      }
      this.state = undefined;
      this.stateV2 = next.sparse?.persistenceCheckpoint();
      this.stateV2SemanticKeys = keys;
    }
    this.recordGovernanceUpdates(block.transactions);
  }

  validateFinalizedBlock(block: Block, nowMs = Date.now()): LedgerState | undefined {
    return this.validateFinalizedTransition(block, nowMs).ledger;
  }

  private validateFinalizedTransition(block: Block, nowMs = Date.now()): AppliedTransition {
    const protocolVersion = this.protocolVersionAt(block.header.height);
    assertSupportedProtocolVersion(protocolVersion);
    const validators = this.validatorsAt(block.header.height);
    validateBlockEnvelope(block, this.tip, validators, nowMs, true, protocolVersion);
    if (Buffer.byteLength(canonicalJson(block), "utf8") > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
    const next = this.validateAndApply(
      block.transactions, this.state, block.header.height, block.header.timestampMs, feeProducerOf(block)
    );
    if (block.header.stateRoot !== stateRootForProtocol(protocolVersion, next)) throw new Error("State root mismatch");
    return next;
  }

  validateProposal(block: Block, nowMs = Date.now()): void {
    const protocolVersion = this.protocolVersionAt(block.header.height);
    assertSupportedProtocolVersion(protocolVersion);
    validateBlockEnvelope(block, this.tip, this.validatorsAt(block.header.height), nowMs, false, protocolVersion);
    if (Buffer.byteLength(canonicalJson(block), "utf8") > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
    const next = this.validateAndApply(
      block.transactions, this.state, block.header.height, block.header.timestampMs, feeProducerOf(block)
    );
    if (block.header.stateRoot !== stateRootForProtocol(protocolVersion, next)) throw new Error("State root mismatch");
  }

  /** Earliest timestamp the next block can carry (block time must increase). */
  private nextBlockTimestampMs(nowMs = Date.now()): number {
    return Math.max(nowMs, this.tip.header.timestampMs + 1);
  }

  validatePending(transactions: Transaction[], blockTimestampMs = this.nextBlockTimestampMs()): void {
    this.validateAndApply(transactions, this.state, this.height + 1, blockTimestampMs);
  }

  /**
   * True when no future block can include this activity settlement any more
   * (its epoch's settlement window closed before the earliest possible next
   * block timestamp). Used for mempool pruning only; never for block validity.
   */
  isActivitySettlementExpired(tx: Transaction): boolean {
    return tx.kind === "activity_settlement" &&
      activityEpochWindowExpired(tx.epoch, this.genesis.timestampMs, this.tip.header.timestampMs + 1);
  }

  /**
   * Mempool admission (policy; block selection and validation stay
   * authoritative). `pending` is the node's current mempool: it is only used
   * for a `validator_update` (P1-07-F1, see validatorUpdateAdmissionPredecessors).
   * Returns the pending same-block predecessors an update can follow when it
   * needed one (empty otherwise).
   */
  validateMempoolAdmission(tx: Transaction, nowMs = Date.now(), pending: readonly Transaction[] = []): ValidatorSetUpdateTx[] {
    if (tx.chainId !== this.genesis.chainId) throw new Error("Wrong transaction chain ID");
    this.shape(tx);
    const protocolVersion = this.protocolVersionAt(this.height + 1);
    assertTransactionVersionForProtocol(tx, protocolVersion);
    const rollingWindow = activityRollingWindowEnforced(this.genesis);
    if (tx.kind === "transfer") {
      assertNoActivityPoolInflow(tx.receiver, this.genesis.activityPool);
      assertNoActivityPoolDirectDebit(tx.sender, this.genesis.activityPool, this.genesis);
      if (rollingWindow && isActivityWindowAddress(tx.receiver)) throw new Error(ACTIVITY_WINDOW_RESERVED_MESSAGE);
      const total = tx.amountAtoms + tx.feeAtoms;
      if (!Number.isSafeInteger(total) || this.balance(tx.sender) < total) {
        throw new Error("Insufficient balance");
      }
      assertAllocationLockOutflow(this.allocationLocksAt(this.nextBlockTimestampMs(nowMs)), tx.sender, this.balance(tx.sender), total);
      return [];
    }
    if (tx.kind === "activity_settlement") {
      const oracles = this.oracleSetAt(this.height + 1);
      const blockTimestampMs = this.nextBlockTimestampMs(nowMs);
      assertActivitySettlementAuthorized(tx, oracles, {
        chainId: this.genesis.chainId, blockTimestampMs, genesisTimestampMs: this.genesis.timestampMs
      });
      if (tx.sender !== this.genesis.activityPool) throw new Error("Invalid activity pool sender");
      for (const entry of tx.entries) assertNoActivityPoolInflow(entry.receiver, this.genesis.activityPool);
      const total = assertActivitySettlementWithinCap(tx.entries, activitySettlementCapAtoms(oracles));
      assertActivityEpochWindow(tx.epoch, this.genesis.timestampMs, blockTimestampMs);
      const settled = (epoch: number) => this.stateV2 && protocolUsesStateV2(this.protocolVersionAt(this.height))
        ? stateV2ActivityEpochSettled(this.stateV2, epoch)
        : this.requireLegacyState().isActivityEpochSettled(epoch);
      if (settled(tx.epoch)) throw new Error("Activity epoch already settled");
      if (settled(tx.epoch + 1)) throw new Error(ACTIVITY_ORDER_MESSAGE);
      if (rollingWindow) {
        // Rolling 24 h cap (activity.ts), judged at the earliest next block time.
        if (tx.entries.some((entry) => isActivityWindowAddress(entry.receiver))) {
          throw new Error(ACTIVITY_WINDOW_RESERVED_MESSAGE);
        }
        assertActivityRollingWindow({
          timestampMs: this.nonce(ACTIVITY_WINDOW_TIME_ADDRESS),
          amountAtoms: this.nonce(ACTIVITY_WINDOW_AMOUNT_ADDRESS)
        }, blockTimestampMs, total, activitySettlementCapAtoms(oracles));
      }
      if (total > this.balance(this.genesis.activityPool)) throw new Error("Activity pool exhausted");
      assertAllocationLockOutflow(
        this.allocationLocksAt(this.nextBlockTimestampMs(nowMs)), tx.sender, this.balance(this.genesis.activityPool), total
      );
      return [];
    }
    if (tx.kind === "mining_claim") {
      assertMiningNotRetired();
      if (tx.nonce !== this.nonce(tx.sender) + 1) throw new Error("Mining claim nonce must be next confirmed nonce");
      assertMiningClaimContext(tx, {
        nextHeight: this.height + 1,
        previousHash: this.tip.hash,
        claimCount: this.miningClaimCount(),
        genesisSupplyAtoms: this.genesisSupplyAtomsValue
      });
      return [];
    }
    const validators = this.validatorsAt(this.height + 1);
    if (tx.kind === "validator_update") {
      try {
        validateValidatorUpdateAuthorization(
          tx, validators, this.height + 1, this.lastValidatorActivationHeight(), minimumValidatorCount(this.genesis),
          this.validatorAdmissionContext(this.lastScheduledValidators())
        );
        return [];
      } catch (error) {
        const predecessors = this.validatorUpdateAdmissionPredecessors(tx, validators, pending);
        if (predecessors.length > 0) return predecessors;
        throw error;
      }
    }
    if (tx.kind === "activity_oracle_governance") {
      validateActivityOracleGovernanceAuthorization(
        tx, validators, this.height + 1, this.lastActivityOracleGovernanceHeight(), this.genesis,
        this.scheduledOracleRevocations(), this.oraclePauseScheduled()
      );
      return [];
    }
    validateProtocolUpgradeAuthorization(tx, validators, this.height + 1, this.lastProtocolActivationHeight(), this.lastScheduledProtocolVersion());
    return [];
  }

  /**
   * P1-07-F2: the part of `validator_update` admission that a pending
   * predecessor cannot change: set size, activation delay and order, an active
   * initiator and a quorum of valid approvals from the current validators. A
   * pending predecessor only changes the replaced set, i.e. which validators
   * are incoming and need possession proofs. Used before a refused update may
   * enter the node's bounded deferred set; never for block validity.
   */
  assertValidatorUpdateAuthorizedExceptProofs(tx: ValidatorSetUpdateTx): void {
    if (tx.chainId !== this.genesis.chainId) throw new Error("Wrong transaction chain ID");
    this.shape(tx);
    assertTransactionVersionForProtocol(tx, this.protocolVersionAt(this.height + 1));
    validateValidatorUpdateQuorum(
      tx, this.validatorsAt(this.height + 1), this.height + 1, this.lastValidatorActivationHeight(), minimumValidatorCount(this.genesis)
    );
  }

  /**
   * P1-07-F1: the set a `validator_update` replaces is the latest scheduled set
   * when it is selected, which can be another update selected earlier in the
   * same block (selectValidPending's per-block working schedule). Against the
   * persisted schedule alone, a same-block remove-then-re-add could therefore
   * never enter the mempool. An update that fails the persisted-schedule check
   * is admitted when it is fully valid (quorum, activation order, possession
   * proofs) as the direct successor of a pending update that is itself valid
   * against the persisted schedule, activates earlier and, from the same
   * sender, holds a lower nonce; every such predecessor is returned so the
   * node can check each with its pending nonce prefix. Block selection and
   * validation are unchanged, so nothing invalid is ever included.
   */
  private validatorUpdateAdmissionPredecessors(
    tx: ValidatorSetUpdateTx,
    validators: Validator[],
    pending: readonly Transaction[]
  ): ValidatorSetUpdateTx[] {
    if (!hasValidatorAdmission(this.genesis)) return [];
    const protocolVersion = this.protocolVersionAt(this.height + 1);
    const found: ValidatorSetUpdateTx[] = [];
    const lastActivation = this.lastValidatorActivationHeight();
    const minimum = minimumValidatorCount(this.genesis);
    for (const candidate of pending) {
      // Cheap filters first; signatures only for a plausible predecessor.
      if (candidate.kind !== "validator_update" || candidate.txid === tx.txid || candidate.chainId !== this.genesis.chainId) continue;
      if (candidate.activationHeight <= lastActivation || candidate.activationHeight >= tx.activationHeight) continue;
      // Same sender: selection walks nonces in order, so the predecessor must come first.
      if (candidate.sender === tx.sender && candidate.nonce >= tx.nonce) continue;
      try {
        this.shape(candidate);
        assertTransactionVersionForProtocol(candidate, protocolVersion);
        validateValidatorUpdateAuthorization(
          candidate, validators, this.height + 1, lastActivation, minimum,
          this.validatorAdmissionContext(this.lastScheduledValidators())
        );
        validateValidatorUpdateAuthorization(
          tx, validators, this.height + 1, candidate.activationHeight, minimum,
          this.validatorAdmissionContext(candidate.validators)
        );
        found.push(structuredClone(candidate));
      } catch {
        // Not a usable predecessor; try the next one.
      }
    }
    return found;
  }

  selectValidPending(
    transactions: Transaction[],
    limit: number,
    maxTransactionBytes = MAX_BLOCK_TRANSACTION_BYTES,
    blockTimestampMs = this.nextBlockTimestampMs(),
    producerAddress?: Address
  ): Transaction[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) {
      throw new Error("Invalid pending selection limit");
    }
    if (!Number.isSafeInteger(maxTransactionBytes) || maxTransactionBytes < 0 ||
        maxTransactionBytes > MAX_BLOCK_TRANSACTION_BYTES) {
      throw new Error("Invalid pending byte limit");
    }
    const protocolVersion = this.protocolVersionAt(this.height + 1);
    assertSupportedProtocolVersion(protocolVersion);
    const policy = readFeePolicy(this.genesis);
    const ordered = orderPendingByFeePriority(
      transactions.map((tx) => structuredClone(tx)),
      (tx) => this.isAuthorizedProtocolCandidate(tx, protocolVersion, blockTimestampMs),
      policy ? { feePriority: false } : undefined
    );
    const fee = this.fixedFeeApplication(this.height + 1, producerAddress);
    const next = protocolVersion === 1 ? this.legacyStateForTransition().clone() : undefined;
    let sparse = protocolUsesStateV2(protocolVersion)
      ? (this.stateV2 ?? stateV2FromLedgerSnapshot(this.requireLegacyState().snapshot(), this.governanceSnapshot()))
      : undefined;
    const selected: Transaction[] = [];
    const seen = new Set<string>();
    let selectedBytes = 0;
    let lastActivation = this.lastValidatorActivationHeight();
    // P1-07: per-block working schedule. The set an update replaces is the
    // latest scheduled set, including one selected earlier in this block.
    let lastScheduledValidators = this.lastScheduledValidators();
    let lastProtocolActivation = this.lastProtocolActivationHeight();
    let lastProtocolVersion = this.lastScheduledProtocolVersion();
    let lastOracleGovernance = this.lastActivityOracleGovernanceHeight();
    const scheduledRevoked = this.scheduledOracleRevocations();
    let pauseScheduled = this.oraclePauseScheduled();
    const currentValidators = this.validatorsAt(this.height + 1);
    const oracles = this.oracleSetAt(this.height + 1);
    let miningClaimSelected = false;
    let miningClaimCount = this.miningClaimCount();
    const locks = this.allocationLocksAt(blockTimestampMs);
    for (const tx of ordered) {
      if (selected.length >= limit) break;
      try {
        if (tx.chainId !== this.genesis.chainId || seen.has(tx.txid)) continue;
        this.shape(tx);
        assertTransactionVersionForProtocol(tx, protocolVersion);
        if (tx.kind === "activity_settlement") {
          assertActivitySettlementAuthorized(tx, oracles, {
            chainId: this.genesis.chainId, blockTimestampMs, genesisTimestampMs: this.genesis.timestampMs
          });
          assertActivityEpochWindow(tx.epoch, this.genesis.timestampMs, blockTimestampMs);
        }
        if (tx.kind === "mining_claim") {
          if (miningClaimSelected) continue;
          assertMiningClaimContext(tx, {
            nextHeight: this.height + 1,
            previousHash: this.tip.hash,
            claimCount: miningClaimCount,
            genesisSupplyAtoms: this.genesisSupplyAtomsValue
          });
        } else if (tx.kind === "validator_update") {
          validateValidatorUpdateAuthorization(
            tx, currentValidators, this.height + 1, lastActivation, minimumValidatorCount(this.genesis),
            this.validatorAdmissionContext(lastScheduledValidators)
          );
        } else if (tx.kind === "activity_oracle_governance") {
          validateActivityOracleGovernanceAuthorization(
            tx, currentValidators, this.height + 1, lastOracleGovernance, this.genesis,
            scheduledRevoked, pauseScheduled
          );
        } else if (tx.kind === "protocol_upgrade") {
          validateProtocolUpgradeAuthorization(tx, currentValidators, this.height + 1, lastProtocolActivation, lastProtocolVersion);
        }
        const transactionBytes = Buffer.byteLength(canonicalJson(tx), "utf8") + (selected.length ? 1 : 0);
        if (selectedBytes + transactionBytes > maxTransactionBytes) continue;
        if (sparse) {
          sparse = tx.kind === "mining_claim"
            ? applyMiningClaimStateV2(sparse, tx)
            : applyStateV2Transaction(sparse, tx, this.genesis.activityPool, locks, oracles, fee);
        } else {
          next!.apply(tx, this.genesis.activityPool, locks, oracles, fee);
        }
        if (tx.kind === "mining_claim") {
          miningClaimSelected = true;
          miningClaimCount += 1;
        }
        // F-06: advance the governance cursors only once the transaction has
        // passed the byte budget and its state transition, i.e. is selected.
        if (tx.kind === "validator_update") {
          lastActivation = tx.activationHeight;
          lastScheduledValidators = tx.validators;
        }
        if (tx.kind === "activity_oracle_governance") {
          lastOracleGovernance = tx.activationHeight;
          if (tx.action === "pause") pauseScheduled = true;
          else if (tx.action === "resume") pauseScheduled = false;
          else for (const publicKey of tx.publicKeys) scheduledRevoked.add(publicKey);
        }
        if (tx.kind === "protocol_upgrade") {
          lastProtocolActivation = tx.activationHeight;
          lastProtocolVersion = tx.protocolVersion;
        }
        selected.push(tx);
        selectedBytes += transactionBytes;
        seen.add(tx.txid);
      } catch {
        // Invalid or stale mempool entries are omitted; block validation stays authoritative.
      }
    }
    return selected;
  }

  /**
   * Selection-time priority hint only (R18-1041-L2): whether a pending protocol
   * transaction is currently authorized (signature, transaction version, oracle
   * or validator-quorum approval, epoch window and activation rules against the
   * block's starting cursors). Only such a transaction may lift its sender's
   * lower-nonce predecessors ahead of fee-paying transfers. Selection still
   * validates every transaction in order and block validation stays
   * authoritative.
   */
  private isAuthorizedProtocolCandidate(tx: Transaction, protocolVersion: number, blockTimestampMs: number): boolean {
    try {
      if (tx.chainId !== this.genesis.chainId) return false;
      if (tx.kind !== "activity_settlement" && tx.kind !== "validator_update" &&
          tx.kind !== "activity_oracle_governance" && tx.kind !== "protocol_upgrade") return false;
      this.shape(tx);
      assertTransactionVersionForProtocol(tx, protocolVersion);
      if (tx.kind === "activity_settlement") {
        assertActivitySettlementAuthorized(tx, this.oracleSetAt(this.height + 1), {
          chainId: this.genesis.chainId, blockTimestampMs, genesisTimestampMs: this.genesis.timestampMs
        });
        assertActivityEpochWindow(tx.epoch, this.genesis.timestampMs, blockTimestampMs);
        return true;
      }
      const validators = this.validatorsAt(this.height + 1);
      if (tx.kind === "validator_update") {
        validateValidatorUpdateAuthorization(
          tx, validators, this.height + 1, this.lastValidatorActivationHeight(), minimumValidatorCount(this.genesis),
          this.validatorAdmissionContext(this.lastScheduledValidators())
        );
      } else if (tx.kind === "activity_oracle_governance") {
        validateActivityOracleGovernanceAuthorization(
          tx, validators, this.height + 1, this.lastActivityOracleGovernanceHeight(), this.genesis,
          this.scheduledOracleRevocations(), this.oraclePauseScheduled()
        );
      } else {
        validateProtocolUpgradeAuthorization(
          tx, validators, this.height + 1, this.lastProtocolActivationHeight(), this.lastScheduledProtocolVersion()
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Shape check for this chain. fixed-fee-v1 passes the committed fee; other chains do not. */
  private shape(value: unknown): asserts value is Transaction {
    validateTransactionShape(value, readFeePolicy(this.genesis)?.fixedTransferFeeAtoms);
  }

  /**
   * Producer credit for fixed-fee-v1. Absent when the genesis has no fee
   * policy, so historical appliers still burn the whole fee. When the caller
   * knows the block proposer, that address is the producer. Mempool
   * pre-validation, which has no block yet, uses the round-0 proposer of the
   * height. Block validation always passes the block proposer.
   */
  private fixedFeeApplication(blockHeight: number, producer: Address | undefined): FixedFeeApplication | undefined {
    const policy = readFeePolicy(this.genesis);
    if (!policy) return undefined;
    const resolved = producer ?? expectedValidator(this.validatorsAt(blockHeight), blockHeight, 0).address;
    return { producer: resolved, fixedTransferFeeAtoms: policy.fixedTransferFeeAtoms };
  }

  private validateAndApply(
    transactions: Transaction[],
    startingState: LedgerState | undefined,
    blockHeight: number,
    blockTimestampMs: number,
    producer?: Address
  ): AppliedTransition {
    const protocolVersion = this.protocolVersionAt(blockHeight);
    const fee = this.fixedFeeApplication(blockHeight, producer);
    const next = protocolVersion === 1 ? this.legacyStateForTransition(startingState).clone() : startingState;
    let sparse = protocolUsesStateV2(protocolVersion)
      ? (this.stateV2 ?? stateV2FromLedgerSnapshot((startingState ?? this.requireLegacyState()).snapshot(), this.governanceSnapshot()))
      : undefined;
    const seen = new Set<string>();
    const currentValidators = this.validatorsAt(blockHeight);
    let lastActivation = this.lastValidatorActivationHeight();
    // P1-07: per-block working schedule (see selectValidPending).
    let lastScheduledValidators = this.lastScheduledValidators();
    let lastProtocolActivation = this.lastProtocolActivationHeight();
    let lastProtocolVersion = this.lastScheduledProtocolVersion();
    let lastOracleGovernance = this.lastActivityOracleGovernanceHeight();
    const scheduledRevoked = this.scheduledOracleRevocations();
    let pauseScheduled = this.oraclePauseScheduled();
    const oracles = this.oracleSetAt(blockHeight);
    let miningClaimSeen = false;
    let miningClaimCount = this.miningClaimCount();
    // On-chain allocation locks, evaluated at this block's own timestamp.
    const locks = this.allocationLocksAt(blockTimestampMs);
    for (const tx of transactions) {
      if (tx.chainId !== this.genesis.chainId) throw new Error("Wrong transaction chain ID");
      if (seen.has(tx.txid)) throw new Error("Duplicate transaction in block");
      seen.add(tx.txid);
      this.shape(tx);
      assertTransactionVersionForProtocol(tx, protocolVersion);
      if (tx.kind === "activity_settlement") {
        // Registered submitter plus, under a threshold policy, m-of-n approvals.
        assertActivitySettlementAuthorized(tx, oracles, {
          chainId: this.genesis.chainId, blockTimestampMs, genesisTimestampMs: this.genesis.timestampMs
        });
        // ZC-CRY-20260930-010: only the most recently closed epoch, judged by
        // this block's own timestamp. Since block time increases, this alone
        // makes settled epochs strictly increasing; the cap and the
        // once-only/adjacent-order checks are in the appliers.
        assertActivityEpochWindow(tx.epoch, this.genesis.timestampMs, blockTimestampMs);
      }
      if (tx.kind === "mining_claim") {
        if (miningClaimSeen) throw new Error("Block contains more than one mining claim");
        assertMiningClaimContext(tx, {
          nextHeight: blockHeight,
          previousHash: this.tip.hash,
          claimCount: miningClaimCount,
          genesisSupplyAtoms: this.genesisSupplyAtomsValue
        });
      } else if (tx.kind === "validator_update") {
        validateValidatorUpdateAuthorization(
          tx, currentValidators, blockHeight, lastActivation, minimumValidatorCount(this.genesis),
          this.validatorAdmissionContext(lastScheduledValidators)
        );
        lastActivation = tx.activationHeight;
        lastScheduledValidators = tx.validators;
      } else if (tx.kind === "activity_oracle_governance") {
        validateActivityOracleGovernanceAuthorization(
          tx, currentValidators, blockHeight, lastOracleGovernance, this.genesis, scheduledRevoked, pauseScheduled
        );
        lastOracleGovernance = tx.activationHeight;
        if (tx.action === "pause") pauseScheduled = true;
        else if (tx.action === "resume") pauseScheduled = false;
        else for (const publicKey of tx.publicKeys) scheduledRevoked.add(publicKey);
      } else if (tx.kind === "protocol_upgrade") {
        validateProtocolUpgradeAuthorization(tx, currentValidators, blockHeight, lastProtocolActivation, lastProtocolVersion);
        lastProtocolActivation = tx.activationHeight;
        lastProtocolVersion = tx.protocolVersion;
      }
      if (sparse) {
        sparse = tx.kind === "mining_claim"
          ? applyMiningClaimStateV2(sparse, tx)
          : applyStateV2Transaction(sparse, tx, this.genesis.activityPool, locks, oracles, fee);
      } else {
        next!.apply(tx, this.genesis.activityPool, locks, oracles, fee);
      }
      if (tx.kind === "mining_claim") {
        miningClaimSeen = true;
        miningClaimCount += 1;
      }
    }
    return { ledger: next, sparse };
  }

  private requireLegacyState(): LedgerState {
    if (!this.state) throw new Error("Legacy ledger is unavailable after State v2 activation");
    return this.state;
  }

  private legacyStateForTransition(preferred?: LedgerState): LedgerState {
    if (preferred) return preferred;
    if (this.state) return this.state;
    if (!this.stateV2) throw new Error("No authenticated state is available for legacy transition");
    return LedgerState.fromSnapshot(this.stateV2PortableView().ledger);
  }

  private stateV2PortableView(): import("./state-v2.js").StateV2PortableView {
    if (!this.stateV2 || !this.stateV2SemanticKeys) throw new Error("State v2 semantic view is unavailable");
    return reconstructStateV2PortableView(this.stateV2, [...this.stateV2SemanticKeys]);
  }

  private recordGovernanceUpdates(transactions: Transaction[]): void {
    for (const tx of transactions) {
      if (tx.kind === "validator_update") {
        this.validatorSchedule.set(tx.activationHeight, structuredClone(tx.validators));
      } else if (tx.kind === "activity_oracle_governance") {
        this.activityOracleGovernance.set(tx.activationHeight, { action: tx.action, publicKeys: [...tx.publicKeys] });
      } else if (tx.kind === "protocol_upgrade") {
        this.protocolSchedule.set(tx.activationHeight, tx.protocolVersion);
      }
    }
  }

  private lastValidatorActivationHeight(): number {
    return Math.max(...this.validatorSchedule.keys());
  }

  /** The latest scheduled validator set (P1-07: the set the next update replaces). */
  private lastScheduledValidators(): Validator[] {
    return this.validatorSchedule.get(this.lastValidatorActivationHeight())!;
  }

  private validatorAdmissionContext(replacedValidators: readonly Validator[]): ValidatorUpdateAdmissionContext {
    return {
      optedIn: hasValidatorAdmission(this.genesis),
      chainId: this.genesis.chainId,
      genesisHash: this.genesisHash,
      replacedValidators
    };
  }

  private lastProtocolActivationHeight(): number {
    return Math.max(...this.protocolSchedule.keys());
  }

  private lastActivityOracleGovernanceHeight(): number {
    return this.activityOracleGovernance.size === 0 ? 0 : Math.max(...this.activityOracleGovernance.keys());
  }

  /** Version of the latest scheduled protocol entry (active or pending). */
  private lastScheduledProtocolVersion(): number {
    return this.protocolSchedule.get(this.lastProtocolActivationHeight())!;
  }

  private governanceSnapshot(): import("./state-v2.js").StateV2GovernanceSnapshot {
    const activityOracleGovernance = [...this.activityOracleGovernance.entries()]
      .sort(([a], [b]) => a - b)
      .map(([activationHeight, entry]) => ({
        activationHeight,
        action: entry.action,
        publicKeys: [...entry.publicKeys]
      }));
    return {
      validatorSchedule: [...this.validatorSchedule.entries()]
        .sort(([a], [b]) => a - b)
        .map(([activationHeight, validators]) => ({ activationHeight, validators: structuredClone(validators) })),
      protocolSchedule: [...this.protocolSchedule.entries()]
        .sort(([a], [b]) => a - b)
        .map(([activationHeight, protocolVersion]) => ({ activationHeight, protocolVersion })),
      ...(activityOracleGovernance.length ? { activityOracleGovernance } : {})
    };
  }

  private activityOracleControlAt(height: number): { paused: boolean; revoked: Set<string> } {
    let paused = false;
    const revoked = new Set<string>();
    const entries = [...this.activityOracleGovernance.entries()].sort(([a], [b]) => a - b);
    for (const [activationHeight, entry] of entries) {
      if (activationHeight > height) break;
      if (entry.action === "pause") paused = true;
      else if (entry.action === "resume") paused = false;
      else for (const publicKey of entry.publicKeys) revoked.add(publicKey);
    }
    return { paused, revoked };
  }

  private oracleSetAt(height: number): ActivityOracleSet {
    const control = this.activityOracleControlAt(height);
    return {
      activityOracles: this.genesis.activityOracles,
      ...(this.genesis.activityOracleThreshold !== undefined
        ? { activityOracleThreshold: this.genesis.activityOracleThreshold }
        : {}),
      ...(this.genesis.activityOraclePolicy !== undefined
        ? { activityOraclePolicy: this.genesis.activityOraclePolicy }
        : {}),
      ...(this.genesis.activitySettlementCapAtoms !== undefined
        ? { activitySettlementCapAtoms: this.genesis.activitySettlementCapAtoms }
        : {}),
      ...(this.genesis.launchProfile !== undefined
        ? { launchProfile: this.genesis.launchProfile }
        : {}),
      timestampMs: this.genesis.timestampMs,
      paused: control.paused,
      revokedPublicKeys: [...control.revoked]
    };
  }

  private scheduledOracleRevocations(): Set<string> {
    const revoked = new Set<string>();
    for (const entry of this.activityOracleGovernance.values()) {
      if (entry.action === "revoke") for (const publicKey of entry.publicKeys) revoked.add(publicKey);
    }
    return revoked;
  }

  private oraclePauseScheduled(): boolean {
    let paused = false;
    for (const [, entry] of [...this.activityOracleGovernance.entries()].sort(([a], [b]) => a - b)) {
      if (entry.action === "pause") paused = true;
      else if (entry.action === "resume") paused = false;
    }
    return paused;
  }
}

function validateValidatorSchedule(
  value: unknown,
  genesisValidators: Validator[],
  minimumValidators: number
): Map<number, Validator[]> {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Invalid checkpoint validator schedule");
  const result = new Map<number, Validator[]>();
  let previousHeight = -1;
  for (const candidate of value) {
    assertPlainRecord(candidate, "checkpoint validator schedule entry");
    assertExactKeys(candidate, ["activationHeight", "validators"], "checkpoint validator schedule entry");
    if (!Number.isSafeInteger(candidate.activationHeight) || Number(candidate.activationHeight) <= previousHeight ||
        !Array.isArray(candidate.validators)) {
      throw new Error("Invalid checkpoint validator schedule");
    }
    if (candidate.validators.length < minimumValidators || candidate.validators.length > 100) {
      throw new Error(minimumValidators > 1
        ? "fixed-supply-v1, public-launch, value-bearing, and mainnet chains require at least 4 and at most 100 distinct validators"
        : "Invalid checkpoint validator schedule");
    }
    const validators: Validator[] = [];
    const seenAddresses = new Set<string>();
    const seenKeys = new Set<string>();
    for (const item of candidate.validators) {
      assertPlainRecord(item, "checkpoint validator");
      assertExactKeys(item, ["address", "publicKey"], "checkpoint validator");
      if (typeof item.address !== "string" || typeof item.publicKey !== "string") throw new Error("Invalid checkpoint validator");
      assertAddress(item.address);
      assertHex(item.publicKey, 64, "checkpoint validator public key");
      if (addressFromPublicKey(item.publicKey) !== item.address) throw new Error("Invalid checkpoint validator");
      if (seenKeys.has(item.publicKey)) throw new Error("Duplicate validator public key");
      if (seenAddresses.has(item.address)) throw new Error("Duplicate validator address");
      assertValidPublicKey(item.publicKey, "Checkpoint validator public key");
      seenAddresses.add(item.address);
      seenKeys.add(item.publicKey);
      validators.push({ address: item.address, publicKey: item.publicKey });
    }
    const activationHeight = Number(candidate.activationHeight);
    result.set(activationHeight, validators);
    previousHeight = activationHeight;
  }
  const first = result.get(0);
  if (!first || canonicalJson(first) !== canonicalJson(genesisValidators)) {
    throw new Error("Checkpoint validator schedule does not start at genesis");
  }
  return result;
}

function validateProtocolSchedule(value: unknown): Map<number, number> {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Invalid checkpoint protocol schedule");
  const result = new Map<number, number>();
  let previousHeight = -1;
  let previousVersion = 0;
  for (const candidate of value) {
    assertPlainRecord(candidate, "checkpoint protocol schedule entry");
    assertExactKeys(candidate, ["activationHeight", "protocolVersion"], "checkpoint protocol schedule entry");
    const protocolVersion = Number(candidate.protocolVersion);
    if (!Number.isSafeInteger(candidate.activationHeight) || Number(candidate.activationHeight) <= previousHeight ||
        !Number.isSafeInteger(candidate.protocolVersion) || protocolVersion < 1 || protocolVersion > 65_535) {
      throw new Error("Invalid checkpoint protocol schedule");
    }
    assertNoProtocolDowngradeFromV6(previousVersion, protocolVersion, "Invalid checkpoint protocol schedule: downgrade from protocol v6");
    result.set(Number(candidate.activationHeight), protocolVersion);
    previousHeight = Number(candidate.activationHeight);
    previousVersion = protocolVersion;
  }
  if (result.get(0) !== 1) throw new Error("Checkpoint protocol schedule does not start at genesis");
  return result;
}

function stateRootForProtocol(protocolVersion: number, state: AppliedTransition): string {
  if (protocolVersion === 1 && state.ledger) return state.ledger.root();
  if (protocolUsesStateV2(protocolVersion) && state.sparse) return state.sparse.root();
  throw new Error(`Missing state implementation for protocol version ${protocolVersion}`);
}

function assertSupportedProtocolVersion(version: number): void {
  if (!SUPPORTED_PROTOCOL_VERSIONS.has(version)) {
    throw new Error(`Protocol version ${version} is not supported by this binary`);
  }
}

function validateActivityOracleGovernanceSchedule(
  value: unknown,
  genesis: GenesisConfig
): ActivityOracleGovernanceEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Invalid activity oracle governance schedule");
  const registered = new Set(genesis.activityOracles);
  const revoked = new Set<string>();
  let paused = false;
  const result: ActivityOracleGovernanceEntry[] = [];
  let previousHeight = 0;
  for (const candidate of value) {
    assertPlainRecord(candidate, "activity oracle governance entry");
    assertExactKeys(candidate, ["activationHeight", "action", "publicKeys"], "activity oracle governance entry");
    const activationHeight = Number(candidate.activationHeight);
    const action = candidate.action;
    if (!Number.isSafeInteger(activationHeight) || activationHeight <= previousHeight || activationHeight < 1) {
      throw new Error("Invalid activity oracle governance schedule");
    }
    if (action !== "pause" && action !== "resume" && action !== "revoke") {
      throw new Error("Invalid activity oracle governance schedule");
    }
    if (!Array.isArray(candidate.publicKeys)) throw new Error("Invalid activity oracle governance schedule");
    const publicKeys = candidate.publicKeys.map((item) => {
      if (typeof item !== "string") throw new Error("Invalid activity oracle governance schedule");
      assertHex(item, 64, "activity oracle governance publicKey");
      return item;
    });
    if (action === "pause") {
      if (paused || publicKeys.length !== 0) throw new Error("Invalid activity oracle governance schedule");
      paused = true;
    } else if (action === "resume") {
      if (!paused || publicKeys.length !== 0) throw new Error("Invalid activity oracle governance schedule");
      paused = false;
    } else {
      activityOracleGovernancePublicKeysValid("revoke", publicKeys, registered, revoked);
      for (const publicKey of publicKeys) revoked.add(publicKey);
    }
    result.push({ activationHeight, action, publicKeys });
    previousHeight = activationHeight;
  }
  return result;
}

function validateActivityOracleGovernanceAuthorization(
  tx: ActivityOracleGovernanceTx,
  currentValidators: Validator[],
  blockHeight: number,
  lastActivationHeight: number,
  genesis: GenesisConfig,
  alreadyRevoked: ReadonlySet<string>,
  pauseScheduled: boolean
): void {
  if (tx.activationHeight < blockHeight + MIN_VALIDATOR_UPDATE_DELAY) {
    throw new Error("Activity oracle governance activation is too soon");
  }
  if (tx.activationHeight <= lastActivationHeight) throw new Error("Activity oracle governance activation height must increase");
  if (tx.action === "pause") {
    if (pauseScheduled) throw new Error(ACTIVITY_ORACLE_PAUSED_MESSAGE);
  } else if (tx.action === "resume") {
    if (!pauseScheduled) throw new Error("Activity oracle settlements are not paused");
  }
  activityOracleGovernancePublicKeysValid(tx.action, tx.publicKeys, new Set(genesis.activityOracles), alreadyRevoked);
  const allowed = new Map(currentValidators.map((validator) => [validator.address, validator.publicKey]));
  if (!allowed.has(tx.sender)) throw new Error("Activity oracle governance initiator is not active");
  const seen = new Set<string>();
  let valid = 0;
  for (const approval of tx.approvals) {
    if (seen.has(approval.validator)) throw new Error("Duplicate activity oracle governance approval");
    seen.add(approval.validator);
    if (allowed.get(approval.validator) !== approval.publicKey) throw new Error("Unknown activity oracle governance approver");
    if (!verifyActivityOracleGovernanceApprovalSignature(tx, approval)) {
      throw new Error("Invalid activity oracle governance approval");
    }
    valid += 1;
  }
  const quorum = Math.floor((currentValidators.length * 2) / 3) + 1;
  if (valid < quorum) throw new Error(`Activity oracle governance quorum not reached: ${valid}/${quorum}`);
}

function validateValidatorUpdateAuthorization(
  tx: ValidatorSetUpdateTx,
  currentValidators: Validator[],
  blockHeight: number,
  lastActivationHeight: number,
  minimumValidators: number,
  admission: ValidatorUpdateAdmissionContext
): void {
  validateValidatorUpdateQuorum(tx, currentValidators, blockHeight, lastActivationHeight, minimumValidators);
  // possession-proof-v1 (P1-07): incoming keys consent and prove possession.
  assertValidatorUpdatePossessionProofs(tx, admission);
}

/** Every check of validateValidatorUpdateAuthorization except the possession proofs (same order). */
function validateValidatorUpdateQuorum(
  tx: ValidatorSetUpdateTx,
  currentValidators: Validator[],
  blockHeight: number,
  lastActivationHeight: number,
  minimumValidators: number
): void {
  if (tx.validators.length < minimumValidators || tx.validators.length > 100) {
    throw new Error(minimumValidators > 1
      ? "fixed-supply-v1, public-launch, value-bearing, and mainnet chains require at least 4 and at most 100 distinct validators"
      : "Invalid validator set size");
  }
  if (tx.activationHeight < blockHeight + MIN_VALIDATOR_UPDATE_DELAY) {
    throw new Error("Validator update activation is too soon");
  }
  if (tx.activationHeight <= lastActivationHeight) throw new Error("Validator activation height must increase");
  const allowed = new Map(currentValidators.map((validator) => [validator.address, validator.publicKey]));
  if (!allowed.has(tx.sender)) throw new Error("Validator update initiator is not active");
  const seen = new Set<string>();
  let valid = 0;
  for (const approval of tx.approvals) {
    if (seen.has(approval.validator)) throw new Error("Duplicate validator update approval");
    seen.add(approval.validator);
    if (allowed.get(approval.validator) !== approval.publicKey) throw new Error("Unknown validator update approver");
    if (!verifyValidatorUpdateApprovalSignature(tx, approval)) {
      throw new Error("Invalid validator update approval");
    }
    valid += 1;
  }
  const quorum = Math.floor((currentValidators.length * 2) / 3) + 1;
  if (valid < quorum) throw new Error(`Validator update quorum not reached: ${valid}/${quorum}`);
}

/**
 * P0-03: once protocol v6 (locked two-phase consensus, F-01) is scheduled or
 * active, the schedule may never move back below the latest scheduled
 * version. Activation heights strictly increase, so any later entry takes
 * effect after v6 has activated; returning to the legacy single-phase
 * protocol would reinstate the F-01 split on a live v6 chain and abandon v6
 * locks (F01_CONSENSUS_DESIGN section 12.4: rollback only before activation).
 * Schedules that never reach v6 are unchanged, so historical validation of
 * legacy chains is byte-for-byte identical.
 */
function assertNoProtocolDowngradeFromV6(scheduledVersion: number, nextVersion: number, error: string): void {
  if (scheduledVersion >= CONSENSUS_V6_PROTOCOL_VERSION && nextVersion < scheduledVersion) throw new Error(error);
}

function validateProtocolUpgradeAuthorization(
  tx: ProtocolUpgradeTx,
  currentValidators: Validator[],
  blockHeight: number,
  lastActivationHeight: number,
  lastScheduledVersion: number
): void {
  if (tx.activationHeight < blockHeight + MIN_PROTOCOL_UPDATE_DELAY) {
    throw new Error("Protocol upgrade activation is too soon");
  }
  if (tx.activationHeight <= lastActivationHeight) throw new Error("Protocol activation height must increase");
  assertNoProtocolDowngradeFromV6(lastScheduledVersion, tx.protocolVersion,
    `Protocol downgrade refused: version ${tx.protocolVersion} after protocol v${lastScheduledVersion} is scheduled`);
  const allowed = new Map(currentValidators.map((validator) => [validator.address, validator.publicKey]));
  if (!allowed.has(tx.sender)) throw new Error("Protocol upgrade initiator is not active");
  const seen = new Set<string>();
  let valid = 0;
  for (const approval of tx.approvals) {
    if (seen.has(approval.validator)) throw new Error("Duplicate protocol upgrade approval");
    seen.add(approval.validator);
    if (allowed.get(approval.validator) !== approval.publicKey) throw new Error("Unknown protocol upgrade approver");
    if (!verifyProtocolUpgradeApprovalSignature(tx, approval)) {
      throw new Error("Invalid protocol upgrade approval");
    }
    valid += 1;
  }
  const quorum = Math.floor((currentValidators.length * 2) / 3) + 1;
  if (valid < quorum) throw new Error(`Protocol upgrade quorum not reached: ${valid}/${quorum}`);
}

function assertTransactionVersionForProtocol(tx: Transaction, protocolVersion: number): void {
  const expected = protocolVersion >= 3 ? 2 : 1;
  if (tx.version !== expected) {
    throw new Error(`Transaction version ${tx.version} is not valid under protocol version ${protocolVersion}`);
  }
  // Mining is retired for every genesis and every protocol version.
  if (tx.kind === "mining_claim") assertMiningNotRetired();
  if (tx.kind === "mining_claim" && protocolVersion < MINING_PROTOCOL_VERSION) {
    throw new Error(`Mining claims require protocol version ${MINING_PROTOCOL_VERSION}`);
  }
}

/**
 * Launch-ceremony precheck (P1-07): every genesis rule except the possession
 * proofs themselves. The genesis must declare `validatorAdmission` with an
 * empty `genesisProofs`; the validators then sign its (proof-independent)
 * configuration commitment, and the final check (`new ZyronChain`) verifies
 * the proofs. Never use this to start a node.
 */
export function validateGenesisBeforePossessionProofs(genesis: GenesisConfig): void {
  validateGenesis(genesis, { beforePossessionProofs: true });
}

function validateGenesis(genesis: GenesisConfig, options: { beforePossessionProofs?: boolean } = {}): void {
  assertPlainRecord(genesis, "genesis");
  assertExactKeys(genesis, [
    "chainId", "timestampMs", "validators", "activityOracles", "activityPool", "allocations",
    // Optional: on-chain allocation locks (docs/ALLOCATION_LOCKS.md).
    ...(Object.prototype.hasOwnProperty.call(genesis, "allocationLocks") ? ["allocationLocks"] : []),
    // Optional: m-of-n activity-oracle approval (docs/ACTIVITY_ORACLE_GOVERNANCE.md).
    ...(Object.prototype.hasOwnProperty.call(genesis, "activityOracleThreshold") ? ["activityOracleThreshold"] : []),
    // Optional: versioned activity-oracle policy (docs/ACTIVITY_ORACLE_GOVERNANCE.md).
    ...(Object.prototype.hasOwnProperty.call(genesis, "activityOraclePolicy") ? ["activityOraclePolicy"] : []),
    ...(Object.prototype.hasOwnProperty.call(genesis, "activitySettlementCapAtoms") ? ["activitySettlementCapAtoms"] : []),
    // Optional: launch profile (docs/GENESIS_CONFIG_BINDING.md).
    ...(Object.prototype.hasOwnProperty.call(genesis, "launchProfile") ? ["launchProfile"] : []),
    // Optional: network class, version network-class-v1 (docs/GENESIS_NETWORK_CLASS.md).
    ...(Object.prototype.hasOwnProperty.call(genesis, "networkClass") ? ["networkClass"] : []),
    // Optional: public-distribution release, version public-distribution-release-v1.
    ...(Object.prototype.hasOwnProperty.call(genesis, "publicDistributionRelease") ? ["publicDistributionRelease"] : []),
    // Optional: fixed-fee-v1 (docs/FEE_POLICY_V1.md). Absent: historical fee rules.
    ...(Object.prototype.hasOwnProperty.call(genesis, "feePolicy") ? ["feePolicy"] : []),
    // Optional: validator admission, policy possession-proof-v1 (docs/VALIDATOR_POSSESSION_PROOF.md).
    ...(Object.prototype.hasOwnProperty.call(genesis, "validatorAdmission") ? ["validatorAdmission"] : [])
  ], "genesis");
  const hasLaunchProfile = Object.prototype.hasOwnProperty.call(genesis, "launchProfile");
  if (hasLaunchProfile && genesis.launchProfile !== FIXED_SUPPLY_LAUNCH_PROFILE) {
    throw new Error("Unsupported genesis launch profile");
  }
  if (typeof genesis.chainId !== "string" || !/^[a-z0-9-]{3,64}$/.test(genesis.chainId)) {
    throw new Error("Invalid chain ID");
  }
  // network-class-v1: a non-test value-bearing class cannot omit the profile
  // that makes founder vesting and the permanent-liquidity lock consensus rules.
  assertValueBearingClassRequiresFixedSupplyProfile(genesis);
  if (!Number.isSafeInteger(genesis.timestampMs) || genesis.timestampMs < 0) {
    throw new Error("Invalid genesis timestamp");
  }
  const minimumValidators = minimumValidatorCount(genesis);
  if (!Array.isArray(genesis.validators) || genesis.validators.length < minimumValidators || genesis.validators.length > 100) {
    throw new Error(minimumValidators > 1
      ? "fixed-supply-v1, public-launch, value-bearing, and mainnet genesis require at least 4 and at most 100 distinct validators"
      : "Genesis validator count must be between 1 and 100");
  }
  const validatorAddresses = new Set<string>();
  const validatorKeys = new Set<string>();
  for (const validator of genesis.validators) {
    assertPlainRecord(validator, "validator");
    assertExactKeys(validator, ["address", "publicKey"], "validator");
    assertAddress(validator.address);
    if (typeof validator.publicKey !== "string") throw new Error("Invalid validator public key");
    assertHex(validator.publicKey, 64, "validator publicKey");
    if (addressFromPublicKey(validator.publicKey) !== validator.address) {
      throw new Error("Validator address/public key mismatch");
    }
    assertValidPublicKey(validator.publicKey, "Genesis validator public key");
    if (validatorKeys.has(validator.publicKey)) throw new Error("Duplicate validator public key");
    if (validatorAddresses.has(validator.address)) throw new Error("Duplicate validator address");
    validatorAddresses.add(validator.address);
    validatorKeys.add(validator.publicKey);
  }
  if (!Array.isArray(genesis.activityOracles) || !genesis.activityOracles.length) {
    throw new Error("At least one activity oracle is required");
  }
  const oracles = new Set<string>();
  for (const oracle of genesis.activityOracles) {
    if (typeof oracle !== "string") throw new Error("Invalid activity oracle");
    assertHex(oracle, 64, "activity oracle");
    if (oracles.has(oracle)) throw new Error("Duplicate activity oracle");
    oracles.add(oracle);
  }
  validateActivityOracleThreshold(genesis);
  validateActivityOraclePolicy(genesis);
  if (Object.prototype.hasOwnProperty.call(genesis, "activityOracleThreshold")) {
    // An unusable key must never count toward n (m could become unreachable).
    // Legacy genesis files keep the 64-hex check so existing chains still open.
    for (const oracle of genesis.activityOracles) assertValidPublicKey(oracle, "Genesis activity oracle public key");
  }
  assertAddress(genesis.activityPool);
  if (genesis.activityPool === MINING_TRACKER_ADDRESS) throw new Error("Mining tracker cannot be the activity pool");
  if (!Array.isArray(genesis.allocations) || genesis.allocations.length === 0) {
    throw new Error("Invalid allocations");
  }
  const allocated = new Set<string>();
  let genesisSupply = 0;
  for (const allocation of genesis.allocations) {
    assertPlainRecord(allocation, "allocation");
    assertExactKeys(allocation, ["address", "amountAtoms"], "allocation");
    assertAddress(allocation.address);
    if (allocation.address === MINING_TRACKER_ADDRESS) throw new Error("Mining tracker cannot receive a genesis allocation");
    if (hasLaunchProfile && isActivityWindowAddress(allocation.address)) {
      throw new Error("Activity window record address cannot receive a genesis allocation");
    }
    if (!Number.isSafeInteger(allocation.amountAtoms) || allocation.amountAtoms < 0) {
      throw new Error("Invalid genesis allocation");
    }
    genesisSupply += allocation.amountAtoms;
    if (!Number.isSafeInteger(genesisSupply) || genesisSupply > MAX_SUPPLY_ATOMS) {
      throw new Error("Genesis supply exceeds maximum supply");
    }
    if (allocated.has(allocation.address)) throw new Error("Duplicate genesis allocation");
    allocated.add(allocation.address);
  }
  validateAllocationLocks(genesis);
  // Under the fixed-supply launch profile the launch rules are consensus rules:
  // allocationLocks present, exactly 50M ZYN, 5M / 20M / 20M / 5M roles.
  if (hasLaunchProfile) assertFixedSupplyLaunchProfile(genesis);
  // public-distribution-release-v1. Required for fixed-supply-v1 and a value-bearing class.
  validatePublicDistributionRelease(genesis);
  // fixed-fee-v1. Optional. Absent feePolicy leaves historical fee rules in place.
  validateGenesisFeePolicy(genesis);
  // possession-proof-v1 (P1-07). Checked last, after every other genesis rule,
  // so the proofs are verified over an otherwise valid configuration.
  validateValidatorAdmissionShape(genesis);
  assertValueBearingClassRequiresValidatorAdmission(genesis);
  if (options.beforePossessionProofs) {
    if (!hasValidatorAdmission(genesis)) throw new Error("The possession-proof precheck requires validatorAdmission");
    if (genesis.validatorAdmission!.genesisProofs.length !== 0) {
      throw new Error("The possession-proof precheck requires an empty validatorAdmission.genesisProofs");
    }
    return;
  }
  assertGenesisPossessionProofs(genesis);
}

function stateV2KeysForTransaction(tx: Transaction, genesis: GenesisConfig, producer?: Address | "GENESIS"): string[] {
  const keys = stateV2KeysForTransactionBody(tx, genesis);
  if (tx.kind !== "transfer" || producer === undefined || producer === "GENESIS") return keys;
  const policy = readFeePolicy(genesis);
  if (!policy || splitFixedFee(tx.feeAtoms).producerAtoms <= 0) return keys;
  const producerKey = accountKey(producer);
  if (keys.includes(producerKey)) return keys;
  return [...keys, producerKey].sort();
}

function stateV2KeysForTransactionBody(tx: Transaction, genesis: GenesisConfig): string[] {
  if (tx.kind === "mining_claim") {
    return [accountKey(tx.sender), accountKey(MINING_TRACKER_ADDRESS)].sort();
  }
  if (tx.kind === "activity_settlement" && activityRollingWindowEnforced(genesis)) {
    // The rolling 24 h window record (activity.ts) is written by every settlement.
    return [
      ...stateV2TransactionKeyPreimages(tx),
      accountKey(ACTIVITY_WINDOW_TIME_ADDRESS),
      accountKey(ACTIVITY_WINDOW_AMOUNT_ADDRESS)
    ].sort();
  }
  return stateV2TransactionKeyPreimages(tx);
}

function feeProducerOf(block: Block): Address | undefined {
  return block.header.proposer === "GENESIS" ? undefined : block.header.proposer;
}

/**
 * Exported only so tests can pin its fail-closed retirement guard (EXT-04).
 * Mining is retired: explicit rejection only, no issuance logic.
 */
export function applyMiningClaimStateV2(_state: SparseMerkleState, _tx: MiningClaimTx): never {
  return rejectRetiredMiningClaim();
}

/**
 * Proposer-local mempool ordering (external reviewer note EXT-01).
 *
 * Block validity never depended on this order; it only decides which valid
 * pending transactions a proposer packs first. The previous order (sender
 * address, then nonce) let lexicographically small addresses always win,
 * independent of the fee they paid.
 *
 * Order now:
 *  1. Zero-fee protocol transactions (activity settlements, validator and
 *     protocol governance) before transfers, so fee bidding cannot starve them.
 *     Among themselves: activity settlements, then validator updates, then
 *     protocol upgrades, each kind by ascending activation height, so a later
 *     activation cannot advance a governance cursor past an earlier, otherwise
 *     compatible update (R18-1041-L1).
 *  2. A sender's lower-nonce transactions in front of a protocol transaction
 *     that `isAuthorizedProtocolTx` vouches for are ranked like the nearest
 *     such protocol transaction after them, because it cannot be included
 *     without them (R18-1041-L2). This holds for every vouched protocol
 *     transaction in the lane, not only the first.
 *     The default vouches for nothing, so callers decide (selection checks
 *     signatures and oracle/validator-quorum authorization first).
 *  3. Then, among per-sender queue heads, highest feeAtoms first.
 *     fixed-fee-v1 passes `feePriority: false` and uses input arrival order
 *     instead of fee (FIFO per sender nonce). Block validity does not depend
 *     on this order.
 *  4. Ties: earlier timestampMs, then txid, then sender (canonical order).
 * Each sender's transactions keep ascending nonce order (same-nonce
 * alternatives: higher fee first), so nonce sequencing is preserved. Heads are
 * compared lexicographically on these keys, a total order, so the result is a
 * pure function of the input set (and the predicate) and stays deterministic.
 */
export function orderPendingByFeePriority(
  transactions: Transaction[],
  isAuthorizedProtocolTx: (tx: Transaction) => boolean = () => false,
  options?: { feePriority: boolean }
): Transaction[] {
  const feePriority = options?.feePriority !== false;
  const arrival = new Map<string, number>();
  if (!feePriority) {
    transactions.forEach((tx, index) => {
      if (!arrival.has(tx.txid)) arrival.set(tx.txid, index);
    });
  }
  const arrivalOf = (tx: Transaction): number => arrival.get(tx.txid) ?? 0;
  const protocolRank = (tx: Transaction): number => {
    if (tx.kind === "activity_settlement") return 0;
    if (tx.kind === "validator_update") return 1;
    if (tx.kind === "protocol_upgrade") return 2;
    if (tx.kind === "activity_oracle_governance") return 3;
    return 4;
  };
  const activationOf = (tx: Transaction): number =>
    tx.kind === "validator_update" || tx.kind === "protocol_upgrade" || tx.kind === "activity_oracle_governance"
      ? tx.activationHeight : 0;
  // liftTarget[i]: index of the first authorized protocol transaction at or after i (-1 if none).
  interface Lane { queue: Transaction[]; index: number; liftTarget: number[] }
  // Priority key of a lane's current head: [class, rank, activation]; class 0 = protocol.
  const headKey = (lane: Lane): [number, number, number] => {
    const head = lane.queue[lane.index]!;
    if (head.kind !== "transfer") return [0, protocolRank(head), activationOf(head)];
    const target = lane.liftTarget[lane.index]!;
    if (target >= 0) {
      const lifter = lane.queue[target]!;
      return [0, protocolRank(lifter), activationOf(lifter)];
    }
    return [1, 0, 0];
  };
  const headBefore = (leftLane: Lane, rightLane: Lane): boolean => {
    const leftKey = headKey(leftLane);
    const rightKey = headKey(rightLane);
    for (let i = 0; i < leftKey.length; i += 1) {
      if (leftKey[i] !== rightKey[i]) return leftKey[i]! < rightKey[i]!;
    }
    const left = leftLane.queue[leftLane.index]!;
    const right = rightLane.queue[rightLane.index]!;
    if (feePriority) {
      if (left.feeAtoms !== right.feeAtoms) return left.feeAtoms > right.feeAtoms;
    } else if (arrivalOf(left) !== arrivalOf(right)) {
      return arrivalOf(left) < arrivalOf(right);
    }
    if (left.timestampMs !== right.timestampMs) return left.timestampMs < right.timestampMs;
    const byTxid = compareCanonicalStrings(left.txid, right.txid);
    if (byTxid) return byTxid < 0;
    return compareCanonicalStrings(left.sender, right.sender) < 0;
  };
  const queues = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const queue = queues.get(tx.sender);
    if (queue) queue.push(tx);
    else queues.set(tx.sender, [tx]);
  }
  const lanes: Lane[] = [];
  for (const queue of queues.values()) {
    queue.sort((left, right) =>
      left.nonce - right.nonce ||
      (feePriority ? right.feeAtoms - left.feeAtoms : arrivalOf(left) - arrivalOf(right)) ||
      left.timestampMs - right.timestampMs ||
      compareCanonicalStrings(left.txid, right.txid));
    const liftTarget = new Array<number>(queue.length);
    let next = -1;
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const tx = queue[i]!;
      if (tx.kind !== "transfer" && isAuthorizedProtocolTx(tx)) next = i;
      liftTarget[i] = next;
    }
    lanes.push({ queue, index: 0, liftTarget });
  }
  // Binary heap of lanes keyed by their current head.
  const before = (a: number, b: number): boolean => headBefore(lanes[a]!, lanes[b]!);
  const heap: number[] = [];
  const swap = (i: number, j: number): void => { const t = heap[i]!; heap[i] = heap[j]!; heap[j] = t; };
  const up = (i: number): void => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i]!, heap[parent]!)) return;
      swap(i, parent);
      i = parent;
    }
  };
  const down = (i: number): void => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let best = i;
      if (l < heap.length && before(heap[l]!, heap[best]!)) best = l;
      if (r < heap.length && before(heap[r]!, heap[best]!)) best = r;
      if (best === i) return;
      swap(i, best);
      i = best;
    }
  };
  for (let lane = 0; lane < lanes.length; lane += 1) { heap.push(lane); up(heap.length - 1); }
  const ordered: Transaction[] = [];
  while (heap.length) {
    const lane = lanes[heap[0]!]!;
    ordered.push(lane.queue[lane.index]!);
    lane.index += 1;
    if (lane.index < lane.queue.length) {
      down(0);
    } else {
      const last = heap.pop()!;
      if (heap.length) { heap[0] = last; down(0); }
    }
  }
  return ordered;
}
