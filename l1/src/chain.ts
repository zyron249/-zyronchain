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
import { addressFromPublicKey, publicKeyFromPrivate, verifyCanonical, verifyCanonicalDomain } from "./crypto.js";
import {
  assertMiningClaimContext,
  MINING_PROTOCOL_VERSION,
  MINING_TRACKER_ADDRESS,
  miningRewardAtoms as scheduledMiningRewardAtoms,
  miningWorkHash
} from "./mining.js";
import { LedgerState, type LedgerSnapshot } from "./state.js";
import {
  SparseMerkleState,
  accountKey,
  applyStateV2Transaction,
  stateV2ActivityEpochSettled,
  stateV2Balance,
  stateV2FromLedgerSnapshot,
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
  protocolUpgradeApprovalPayload,
  validateTransactionShape,
  validatorUpdateApprovalPayload,
  verifyProtocolUpgradeApprovalSignature,
  verifyValidatorUpdateApprovalSignature
} from "./transaction.js";
import { assertHex } from "./codec.js";
import type {
  Address,
  Block,
  GenesisConfig,
  MiningClaimTx,
  ProtocolUpgradeTx,
  RoundSkipVote,
  Transaction,
  Validator,
  ValidatorSetUpdateTx
} from "./types.js";
import { MAX_SUPPLY_ATOMS } from "./types.js";

const MAX_BLOCK_BYTES = 2_000_000;
export const MAX_BLOCK_TRANSACTION_BYTES = 1_500_000;
export const MIN_VALIDATOR_UPDATE_DELAY = 100;
export const MIN_PROTOCOL_UPDATE_DELAY = 100;
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([1, 2, 3, 5]);

export function protocolUsesStateV2(protocolVersion: number): boolean {
  return protocolVersion === 2 || protocolVersion === 3 || protocolVersion === 5;
}

interface AppliedTransition {
  ledger: LedgerState | undefined;
  sparse: SparseMerkleState | undefined;
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

export class ZyronChain {
  readonly genesis: GenesisConfig;
  private readonly genesisBlock: Block;
  private readonly genesisSupplyAtomsValue: number;
  private tipBlock: Block;
  private currentHeight = 0;
  private readonly validatorSchedule = new Map<number, Validator[]>();
  private readonly protocolSchedule = new Map<number, number>();
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
    assertHex(anchor.tipHash, 32, "trusted checkpoint tip hash");
    assertHex(anchor.snapshotSha256, 32, "trusted checkpoint snapshot digest");
    if (sha256Hex(canonicalJson(value)) !== anchor.snapshotSha256) {
      throw new Error("Trusted checkpoint snapshot digest mismatch");
    }
    assertPlainRecord(value, "chain snapshot");
    assertExactKeys(value, [
      "version", "chainId", "genesisHash", "height", "tip", "state", "validatorSchedule", "protocolSchedule"
    ], "chain snapshot");
    const snapshot = value as unknown as ChainSnapshotV1;
    const chain = new ZyronChain(genesis);
    if (snapshot.version !== 1 || snapshot.chainId !== genesis.chainId || snapshot.genesisHash !== chain.genesisHash) {
      throw new Error("Trusted checkpoint chain identity mismatch");
    }
    if (!Number.isSafeInteger(snapshot.height) || snapshot.height < 0) throw new Error("Invalid checkpoint height");
    validateBlockShape(snapshot.tip);
    if (snapshot.tip.header.chainId !== snapshot.chainId || snapshot.tip.header.height !== snapshot.height ||
        snapshot.tip.hash !== anchor.tipHash || blockHash(snapshot.tip.header) !== snapshot.tip.hash) {
      throw new Error("Trusted checkpoint tip mismatch");
    }

    const validatorSchedule = validateValidatorSchedule(snapshot.validatorSchedule, genesis.validators);
    const protocolSchedule = validateProtocolSchedule(snapshot.protocolSchedule);
    chain.validatorSchedule.clear();
    for (const [height, validators] of validatorSchedule) chain.validatorSchedule.set(height, validators);
    chain.protocolSchedule.clear();
    for (const [height, version] of protocolSchedule) chain.protocolSchedule.set(height, version);

    const state = LedgerState.fromSnapshot(snapshot.state);
    const governance = {
      validatorSchedule: [...validatorSchedule].map(([activationHeight, validators]) => ({
        activationHeight, validators: structuredClone(validators)
      })),
      protocolSchedule: [...protocolSchedule].map(([activationHeight, protocolVersion]) => ({ activationHeight, protocolVersion }))
    };
    const protocolVersion = chain.protocolVersionAt(snapshot.height);
    assertSupportedProtocolVersion(protocolVersion);
    const sparse = protocolUsesStateV2(protocolVersion) ? stateV2FromLedgerSnapshot(state.snapshot(), governance) : undefined;
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
      validateRoundCertificate(snapshot.tip, validators);
      validateAttestationQuorum(snapshot.tip, validators);
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
    const snapshot: ChainSnapshotV1 = {
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

  snapshot(): ChainSnapshotV1 {
    const ledger = this.state ? this.state.snapshot() : this.stateV2PortableView().ledger;
    return {
      version: 1,
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
  }

  stateV2SemanticKeyPreimages(): string[] | undefined {
    if (!protocolUsesStateV2(this.protocolVersionAt(this.height)) || !this.stateV2 || !this.stateV2SemanticKeys) return undefined;
    return [...this.stateV2SemanticKeys].sort();
  }

  stateV2SemanticKeyPreimagesForBlock(block: Block): string[] {
    const keys = new Set(this.stateV2SemanticKeys ?? stateV2KeyPreimages(this.requireLegacyState().snapshot(), this.governanceSnapshot()));
    for (const tx of block.transactions) {
      for (const key of stateV2KeysForTransaction(tx)) keys.add(key);
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
    const next = this.validateAndApply(transactions, this.state, this.height + 1);
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
    const next = this.validateAndApply(block.transactions, this.state, block.header.height);
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
        for (const key of stateV2KeysForTransaction(tx)) keys.add(key);
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
    const next = this.validateAndApply(block.transactions, this.state, block.header.height);
    if (block.header.stateRoot !== stateRootForProtocol(protocolVersion, next)) throw new Error("State root mismatch");
    return next;
  }

  validateProposal(block: Block, nowMs = Date.now()): void {
    const protocolVersion = this.protocolVersionAt(block.header.height);
    assertSupportedProtocolVersion(protocolVersion);
    validateBlockEnvelope(block, this.tip, this.validatorsAt(block.header.height), nowMs, false, protocolVersion);
    if (Buffer.byteLength(canonicalJson(block), "utf8") > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
    const next = this.validateAndApply(block.transactions, this.state, block.header.height);
    if (block.header.stateRoot !== stateRootForProtocol(protocolVersion, next)) throw new Error("State root mismatch");
  }

  validatePending(transactions: Transaction[]): void {
    this.validateAndApply(transactions, this.state, this.height + 1);
  }

  validateMempoolAdmission(tx: Transaction): void {
    if (tx.chainId !== this.genesis.chainId) throw new Error("Wrong transaction chain ID");
    validateTransactionShape(tx);
    const protocolVersion = this.protocolVersionAt(this.height + 1);
    assertTransactionVersionForProtocol(tx, protocolVersion);
    if (tx.kind === "transfer") {
      const total = tx.amountAtoms + tx.feeAtoms;
      if (!Number.isSafeInteger(total) || this.balance(tx.sender) < total) {
        throw new Error("Insufficient balance");
      }
      return;
    }
    if (tx.kind === "activity_settlement") {
      if (!this.genesis.activityOracles.includes(tx.publicKey)) throw new Error("Unauthorized activity oracle");
      if (tx.sender !== this.genesis.activityPool) throw new Error("Invalid activity pool sender");
      const settled = this.stateV2 && protocolUsesStateV2(this.protocolVersionAt(this.height))
        ? stateV2ActivityEpochSettled(this.stateV2, tx.epoch)
        : this.requireLegacyState().isActivityEpochSettled(tx.epoch);
      if (settled) throw new Error("Activity epoch already settled");
      const total = tx.entries.reduce((sum, entry) => sum + BigInt(entry.amountAtoms), 0n);
      if (total > BigInt(this.balance(this.genesis.activityPool))) throw new Error("Activity pool exhausted");
      return;
    }
    if (tx.kind === "mining_claim") {
      assertMiningClaimContext(tx, {
        nextHeight: this.height + 1,
        previousHash: this.tip.hash,
        claimCount: this.miningClaimCount(),
        genesisSupplyAtoms: this.genesisSupplyAtomsValue
      });
      return;
    }
    const validators = this.validatorsAt(this.height + 1);
    if (tx.kind === "validator_update") {
      validateValidatorUpdateAuthorization(tx, validators, this.height + 1, this.lastValidatorActivationHeight());
      return;
    }
    validateProtocolUpgradeAuthorization(tx, validators, this.height + 1, this.lastProtocolActivationHeight());
  }

  selectValidPending(
    transactions: Transaction[],
    limit: number,
    maxTransactionBytes = MAX_BLOCK_TRANSACTION_BYTES
  ): Transaction[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) {
      throw new Error("Invalid pending selection limit");
    }
    if (!Number.isSafeInteger(maxTransactionBytes) || maxTransactionBytes < 0 ||
        maxTransactionBytes > MAX_BLOCK_TRANSACTION_BYTES) {
      throw new Error("Invalid pending byte limit");
    }
    const ordered = transactions
      .map((tx) => ({
        tx: structuredClone(tx),
        miningHash: tx.kind === "mining_claim" ? miningWorkHash(tx) : null
      }))
      .sort((left, right) => {
        if (left.miningHash !== null || right.miningHash !== null) {
          if (left.miningHash === null) return 1;
          if (right.miningHash === null) return -1;
          const workOrder = compareCanonicalStrings(left.miningHash, right.miningHash);
          if (workOrder) return workOrder;
        }
        return compareCanonicalStrings(left.tx.sender, right.tx.sender) ||
          left.tx.nonce - right.tx.nonce ||
          right.tx.feeAtoms - left.tx.feeAtoms ||
          left.tx.timestampMs - right.tx.timestampMs ||
          compareCanonicalStrings(left.tx.txid, right.tx.txid);
      })
      .map((entry) => entry.tx);
    const protocolVersion = this.protocolVersionAt(this.height + 1);
    assertSupportedProtocolVersion(protocolVersion);
    const next = protocolVersion === 1 ? this.legacyStateForTransition().clone() : undefined;
    let sparse = protocolUsesStateV2(protocolVersion)
      ? (this.stateV2 ?? stateV2FromLedgerSnapshot(this.requireLegacyState().snapshot(), this.governanceSnapshot()))
      : undefined;
    const selected: Transaction[] = [];
    const seen = new Set<string>();
    let selectedBytes = 0;
    let lastActivation = this.lastValidatorActivationHeight();
    let lastProtocolActivation = this.lastProtocolActivationHeight();
    const currentValidators = this.validatorsAt(this.height + 1);
    let miningClaimSelected = false;
    let miningClaimCount = this.miningClaimCount();
    for (const tx of ordered) {
      if (selected.length >= limit) break;
      try {
        if (tx.chainId !== this.genesis.chainId || seen.has(tx.txid)) continue;
        validateTransactionShape(tx);
        assertTransactionVersionForProtocol(tx, protocolVersion);
        if (tx.kind === "activity_settlement" && !this.genesis.activityOracles.includes(tx.publicKey)) continue;
        if (tx.kind === "mining_claim") {
          if (miningClaimSelected) continue;
          assertMiningClaimContext(tx, {
            nextHeight: this.height + 1,
            previousHash: this.tip.hash,
            claimCount: miningClaimCount,
            genesisSupplyAtoms: this.genesisSupplyAtomsValue
          });
        } else if (tx.kind === "validator_update") {
          validateValidatorUpdateAuthorization(tx, currentValidators, this.height + 1, lastActivation);
          lastActivation = tx.activationHeight;
        } else if (tx.kind === "protocol_upgrade") {
          validateProtocolUpgradeAuthorization(tx, currentValidators, this.height + 1, lastProtocolActivation);
          lastProtocolActivation = tx.activationHeight;
        }
        const transactionBytes = Buffer.byteLength(canonicalJson(tx), "utf8") + (selected.length ? 1 : 0);
        if (selectedBytes + transactionBytes > maxTransactionBytes) continue;
        if (sparse) {
          sparse = tx.kind === "mining_claim"
            ? applyMiningClaimStateV2(sparse, tx)
            : applyStateV2Transaction(sparse, tx, this.genesis.activityPool);
        } else {
          next!.apply(tx, this.genesis.activityPool);
        }
        if (tx.kind === "mining_claim") {
          miningClaimSelected = true;
          miningClaimCount += 1;
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

  private validateAndApply(transactions: Transaction[], startingState: LedgerState | undefined, blockHeight: number): AppliedTransition {
    const protocolVersion = this.protocolVersionAt(blockHeight);
    const next = protocolVersion === 1 ? this.legacyStateForTransition(startingState).clone() : startingState;
    let sparse = protocolUsesStateV2(protocolVersion)
      ? (this.stateV2 ?? stateV2FromLedgerSnapshot((startingState ?? this.requireLegacyState()).snapshot(), this.governanceSnapshot()))
      : undefined;
    const seen = new Set<string>();
    const currentValidators = this.validatorsAt(blockHeight);
    let lastActivation = this.lastValidatorActivationHeight();
    let lastProtocolActivation = this.lastProtocolActivationHeight();
    let miningClaimSeen = false;
    let miningClaimCount = this.miningClaimCount();
    for (const tx of transactions) {
      if (tx.chainId !== this.genesis.chainId) throw new Error("Wrong transaction chain ID");
      if (seen.has(tx.txid)) throw new Error("Duplicate transaction in block");
      seen.add(tx.txid);
      validateTransactionShape(tx);
      assertTransactionVersionForProtocol(tx, protocolVersion);
      if (tx.kind === "activity_settlement") {
        if (!this.genesis.activityOracles.includes(tx.publicKey)) {
          throw new Error("Unauthorized activity oracle");
        }
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
        validateValidatorUpdateAuthorization(tx, currentValidators, blockHeight, lastActivation);
        lastActivation = tx.activationHeight;
      } else if (tx.kind === "protocol_upgrade") {
        validateProtocolUpgradeAuthorization(tx, currentValidators, blockHeight, lastProtocolActivation);
        lastProtocolActivation = tx.activationHeight;
      }
      if (sparse) {
        sparse = tx.kind === "mining_claim"
          ? applyMiningClaimStateV2(sparse, tx)
          : applyStateV2Transaction(sparse, tx, this.genesis.activityPool);
      } else {
        next!.apply(tx, this.genesis.activityPool);
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
      } else if (tx.kind === "protocol_upgrade") {
        this.protocolSchedule.set(tx.activationHeight, tx.protocolVersion);
      }
    }
  }

  private lastValidatorActivationHeight(): number {
    return Math.max(...this.validatorSchedule.keys());
  }

  private lastProtocolActivationHeight(): number {
    return Math.max(...this.protocolSchedule.keys());
  }

  private governanceSnapshot(): import("./state-v2.js").StateV2GovernanceSnapshot {
    return {
      validatorSchedule: [...this.validatorSchedule.entries()]
        .sort(([a], [b]) => a - b)
        .map(([activationHeight, validators]) => ({ activationHeight, validators: structuredClone(validators) })),
      protocolSchedule: [...this.protocolSchedule.entries()]
        .sort(([a], [b]) => a - b)
        .map(([activationHeight, protocolVersion]) => ({ activationHeight, protocolVersion }))
    };
  }
}

function validateValidatorSchedule(value: unknown, genesisValidators: Validator[]): Map<number, Validator[]> {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Invalid checkpoint validator schedule");
  const result = new Map<number, Validator[]>();
  let previousHeight = -1;
  for (const candidate of value) {
    assertPlainRecord(candidate, "checkpoint validator schedule entry");
    assertExactKeys(candidate, ["activationHeight", "validators"], "checkpoint validator schedule entry");
    if (!Number.isSafeInteger(candidate.activationHeight) || Number(candidate.activationHeight) <= previousHeight ||
        !Array.isArray(candidate.validators) || candidate.validators.length < 1 || candidate.validators.length > 100) {
      throw new Error("Invalid checkpoint validator schedule");
    }
    const validators: Validator[] = [];
    const seen = new Set<string>();
    for (const item of candidate.validators) {
      assertPlainRecord(item, "checkpoint validator");
      assertExactKeys(item, ["address", "publicKey"], "checkpoint validator");
      if (typeof item.address !== "string" || typeof item.publicKey !== "string") throw new Error("Invalid checkpoint validator");
      assertAddress(item.address);
      assertHex(item.publicKey, 64, "checkpoint validator public key");
      if (addressFromPublicKey(item.publicKey) !== item.address || seen.has(item.address)) throw new Error("Invalid checkpoint validator");
      seen.add(item.address);
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
  for (const candidate of value) {
    assertPlainRecord(candidate, "checkpoint protocol schedule entry");
    assertExactKeys(candidate, ["activationHeight", "protocolVersion"], "checkpoint protocol schedule entry");
    const protocolVersion = Number(candidate.protocolVersion);
    if (!Number.isSafeInteger(candidate.activationHeight) || Number(candidate.activationHeight) <= previousHeight ||
        !Number.isSafeInteger(candidate.protocolVersion) || protocolVersion < 1 || protocolVersion > 65_535) {
      throw new Error("Invalid checkpoint protocol schedule");
    }
    result.set(Number(candidate.activationHeight), protocolVersion);
    previousHeight = Number(candidate.activationHeight);
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

function validateValidatorUpdateAuthorization(
  tx: ValidatorSetUpdateTx,
  currentValidators: Validator[],
  blockHeight: number,
  lastActivationHeight: number
): void {
  if (tx.activationHeight < blockHeight + MIN_VALIDATOR_UPDATE_DELAY) {
    throw new Error("Validator update activation is too soon");
  }
  if (tx.activationHeight <= lastActivationHeight) throw new Error("Validator activation height must increase");
  const allowed = new Map(currentValidators.map((validator) => [validator.address, validator.publicKey]));
  if (!allowed.has(tx.sender)) throw new Error("Validator update initiator is not active");
  const payload = validatorUpdateApprovalPayload(tx);
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

function validateProtocolUpgradeAuthorization(
  tx: ProtocolUpgradeTx,
  currentValidators: Validator[],
  blockHeight: number,
  lastActivationHeight: number
): void {
  if (tx.activationHeight < blockHeight + MIN_PROTOCOL_UPDATE_DELAY) {
    throw new Error("Protocol upgrade activation is too soon");
  }
  if (tx.activationHeight <= lastActivationHeight) throw new Error("Protocol activation height must increase");
  const allowed = new Map(currentValidators.map((validator) => [validator.address, validator.publicKey]));
  if (!allowed.has(tx.sender)) throw new Error("Protocol upgrade initiator is not active");
  const payload = protocolUpgradeApprovalPayload(tx);
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
  if (tx.kind === "mining_claim" && protocolVersion < MINING_PROTOCOL_VERSION) {
    throw new Error(`Mining claims require protocol version ${MINING_PROTOCOL_VERSION}`);
  }
}

function validateGenesis(genesis: GenesisConfig): void {
  assertPlainRecord(genesis, "genesis");
  assertExactKeys(genesis, [
    "chainId", "timestampMs", "validators", "activityOracles", "activityPool", "allocations"
  ], "genesis");
  if (typeof genesis.chainId !== "string" || !/^[a-z0-9-]{3,64}$/.test(genesis.chainId)) {
    throw new Error("Invalid chain ID");
  }
  if (!Number.isSafeInteger(genesis.timestampMs) || genesis.timestampMs < 0) {
    throw new Error("Invalid genesis timestamp");
  }
  if (!Array.isArray(genesis.validators) || genesis.validators.length === 0 || genesis.validators.length > 100) {
    throw new Error("Genesis validator count must be between 1 and 100");
  }
  const validators = new Set<string>();
  for (const validator of genesis.validators) {
    assertPlainRecord(validator, "validator");
    assertExactKeys(validator, ["address", "publicKey"], "validator");
    assertAddress(validator.address);
    if (typeof validator.publicKey !== "string") throw new Error("Invalid validator public key");
    assertHex(validator.publicKey, 64, "validator publicKey");
    if (addressFromPublicKey(validator.publicKey) !== validator.address) {
      throw new Error("Validator address/public key mismatch");
    }
    if (validators.has(validator.address)) throw new Error("Duplicate validator");
    validators.add(validator.address);
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
}

function stateV2KeysForTransaction(tx: Transaction): string[] {
  if (tx.kind === "mining_claim") {
    return [accountKey(tx.sender), accountKey(MINING_TRACKER_ADDRESS)].sort();
  }
  return stateV2TransactionKeyPreimages(tx);
}

function applyMiningClaimStateV2(state: SparseMerkleState, tx: MiningClaimTx): SparseMerkleState {
  if (tx.sender === MINING_TRACKER_ADDRESS) throw new Error("Mining tracker address is protocol-reserved");
  const minerNonce = stateV2Nonce(state, tx.sender);
  if (tx.nonce !== minerNonce + 1) throw new Error("Invalid nonce");
  const trackerNonce = stateV2Nonce(state, MINING_TRACKER_ADDRESS);
  if (trackerNonce >= Number.MAX_SAFE_INTEGER) throw new Error("Mining claim counter exhausted");
  const balance = stateV2Balance(state, tx.sender);
  const nextBalance = balance + tx.rewardAtoms;
  if (!Number.isSafeInteger(nextBalance) || nextBalance > MAX_SUPPLY_ATOMS) throw new Error("Mining balance overflow");
  let next = state.set(accountKey(tx.sender), { balanceAtoms: nextBalance, nonce: tx.nonce });
  next = next.set(accountKey(MINING_TRACKER_ADDRESS), {
    balanceAtoms: stateV2Balance(state, MINING_TRACKER_ADDRESS),
    nonce: trackerNonce + 1
  });
  return next;
}