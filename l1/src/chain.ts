import { canonicalJson, sha256Hex } from "./codec.js";
import {
  blockHash,
  createGenesisBlock,
  createBlockAttestation,
  createSignedBlock,
  expectedValidator,
  validateAttestationQuorum,
  validateBlockEnvelope,
  validateBlockShape,
  validateRoundCertificate
} from "./block.js";
import { addressFromPublicKey, publicKeyFromPrivate, verifyCanonical } from "./crypto.js";
import { LedgerState, type LedgerSnapshot } from "./state.js";
import {
  SparseMerkleState,
  applyStateV2Transaction,
  stateV2FromLedgerSnapshot,
} from "./state-v2.js";
import { validateStateV2PortableBundle, type StateV2PortableBundleV1 } from "./state-v2-portable.js";
import {
  assertAddress,
  assertExactKeys,
  assertPlainRecord,
  protocolUpgradeApprovalPayload,
  validateTransactionShape,
  validatorUpdateApprovalPayload
} from "./transaction.js";
import { assertHex } from "./codec.js";
import type { Address, Block, GenesisConfig, ProtocolUpgradeTx, RoundSkipVote, Transaction, Validator, ValidatorSetUpdateTx } from "./types.js";

const MAX_BLOCK_BYTES = 2_000_000;
export const MAX_BLOCK_TRANSACTION_BYTES = 1_500_000;
export const MIN_VALIDATOR_UPDATE_DELAY = 100;
export const MIN_PROTOCOL_UPDATE_DELAY = 100;
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([1, 2]);

interface AppliedTransition {
  ledger: LedgerState;
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
  private tipBlock: Block;
  private currentHeight = 0;
  private readonly validatorSchedule = new Map<number, Validator[]>();
  private readonly protocolSchedule = new Map<number, number>();
  private state: LedgerState;
  private stateV2: SparseMerkleState | undefined;

  constructor(genesis: GenesisConfig) {
    validateGenesis(genesis);
    this.genesis = structuredClone(genesis);
    this.state = LedgerState.fromGenesis(genesis);
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
    const sparse = protocolVersion === 2 ? stateV2FromLedgerSnapshot(state.snapshot(), governance) : undefined;
    const stateRoot = protocolVersion === 1 ? state.root() : sparse!.root();
    if (snapshot.tip.header.stateRoot !== stateRoot) throw new Error("Trusted checkpoint state root mismatch");

    if (snapshot.height === 0) {
      if (canonicalJson(snapshot.tip) !== canonicalJson(chain.genesisBlock)) throw new Error("Invalid genesis checkpoint tip");
    } else {
      const validators = chain.validatorsAt(snapshot.height);
      const expected = expectedValidator(validators, snapshot.height, snapshot.tip.header.round);
      if (snapshot.tip.header.proposer !== expected.address || snapshot.tip.proposerPublicKey !== expected.publicKey ||
          !snapshot.tip.signature || !verifyCanonical(snapshot.tip.header, snapshot.tip.signature, expected.publicKey)) {
        throw new Error("Invalid checkpoint proposer signature");
      }
      validateRoundCertificate(snapshot.tip, validators);
      validateAttestationQuorum(snapshot.tip, validators);
    }

    chain.state = state;
    chain.stateV2 = sparse;
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
    if (activeProtocol !== 2) throw new Error("Portable State v2 checkpoint requires active protocol v2");
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
    return this.state.clone();
  }

  stateV2ForPersistence(): SparseMerkleState | undefined {
    return this.stateV2;
  }

  validatedStateV2ForBlock(block: Block, nowMs = Date.now()): SparseMerkleState | undefined {
    return this.validateFinalizedTransition(block, nowMs).sparse;
  }

  balance(address: Address): number {
    return this.state.balance(address);
  }

  nonce(address: Address): number {
    return this.state.nonce(address);
  }

  snapshot(): ChainSnapshotV1 {
    return {
      version: 1,
      chainId: this.genesis.chainId,
      genesisHash: this.genesisHash,
      height: this.height,
      tip: structuredClone(this.tip),
      state: this.state.snapshot(),
      validatorSchedule: [...this.validatorSchedule.entries()]
        .sort(([a], [b]) => a - b)
        .map(([activationHeight, validators]) => ({ activationHeight, validators: structuredClone(validators) })),
      protocolSchedule: [...this.protocolSchedule.entries()]
        .sort(([a], [b]) => a - b)
        .map(([activationHeight, protocolVersion]) => ({ activationHeight, protocolVersion }))
    };
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
    const round = options.round ?? 0;
    const protocolVersion = this.protocolVersionAt(this.height + 1);
    assertSupportedProtocolVersion(protocolVersion);
    const publicKey = publicKeyFromPrivate(proposerPrivateKey);
    const validators = this.validatorsAt(this.height + 1);
    const expected = expectedValidator(validators, this.height + 1, round);
    if (publicKey !== expected.publicKey || addressFromPublicKey(publicKey) !== expected.address) {
      throw new Error("Private key is not the expected proposer");
    }
    const timestampMs = options.timestampMs ?? Math.max(Date.now(), this.tip.header.timestampMs + 1);
    const next = this.validateAndApply(transactions, this.state, this.height + 1);
    const block = createSignedBlock({
      version: protocolVersion,
      chainId: this.genesis.chainId,
      height: this.height + 1,
      round,
      previousHash: this.tip.hash,
      timestampMs,
      transactions,
      stateRoot: stateRootForProtocol(protocolVersion, next),
      proposerPrivateKey,
      proposerPublicKey: publicKey,
      roundCertificate: options.roundCertificate ?? []
    });
    validateBlockEnvelope(block, this.tip, validators, timestampMs, false, protocolVersion);
    if (Buffer.byteLength(canonicalJson(block), "utf8") > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
    return block;
  }

  acceptBlock(block: Block, nowMs = Date.now()): void {
    const next = this.validateFinalizedTransition(block, nowMs);
    this.tipBlock = structuredClone(block);
    this.currentHeight = block.header.height;
    if (block.header.version === 1) {
      this.state = next.ledger;
      this.stateV2 = undefined;
    } else {
      // Protocol v2 validation is performed against immutable sparse state. Keep
      // the legacy ledger only as a query/snapshot shadow after consensus checks
      // have succeeded; it is no longer cloned on the validation hot path.
      for (const tx of block.transactions) this.state.apply(tx, this.genesis.activityPool);
      this.stateV2 = next.sparse?.persistenceCheckpoint();
    }
    this.recordGovernanceUpdates(block.transactions);
  }

  validateFinalizedBlock(block: Block, nowMs = Date.now()): LedgerState {
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
    if (tx.kind === "transfer") {
      const total = tx.amountAtoms + tx.feeAtoms;
      if (!Number.isSafeInteger(total) || this.state.balance(tx.sender) < total) {
        throw new Error("Insufficient balance");
      }
      return;
    }
    if (tx.kind === "activity_settlement") {
      if (!this.genesis.activityOracles.includes(tx.publicKey)) throw new Error("Unauthorized activity oracle");
      if (tx.sender !== this.genesis.activityPool) throw new Error("Invalid activity pool sender");
      if (this.state.isActivityEpochSettled(tx.epoch)) throw new Error("Activity epoch already settled");
      const total = tx.entries.reduce((sum, entry) => sum + BigInt(entry.amountAtoms), 0n);
      if (total > BigInt(this.state.balance(this.genesis.activityPool))) throw new Error("Activity pool exhausted");
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
      .map((tx) => structuredClone(tx))
      .sort((left, right) =>
        left.sender.localeCompare(right.sender) ||
        left.nonce - right.nonce ||
        right.feeAtoms - left.feeAtoms ||
        left.timestampMs - right.timestampMs ||
        left.txid.localeCompare(right.txid)
      );
    const next = this.state.clone();
    const selected: Transaction[] = [];
    const seen = new Set<string>();
    let selectedBytes = 0;
    let lastActivation = this.lastValidatorActivationHeight();
    let lastProtocolActivation = this.lastProtocolActivationHeight();
    const currentValidators = this.validatorsAt(this.height + 1);
    for (const tx of ordered) {
      if (selected.length >= limit) break;
      try {
        if (tx.chainId !== this.genesis.chainId || seen.has(tx.txid)) continue;
        validateTransactionShape(tx);
        if (tx.kind === "activity_settlement" && !this.genesis.activityOracles.includes(tx.publicKey)) continue;
        if (tx.kind === "validator_update") {
          validateValidatorUpdateAuthorization(tx, currentValidators, this.height + 1, lastActivation);
          lastActivation = tx.activationHeight;
        } else if (tx.kind === "protocol_upgrade") {
          validateProtocolUpgradeAuthorization(tx, currentValidators, this.height + 1, lastProtocolActivation);
          lastProtocolActivation = tx.activationHeight;
        }
        const transactionBytes = Buffer.byteLength(canonicalJson(tx), "utf8") + (selected.length ? 1 : 0);
        if (selectedBytes + transactionBytes > maxTransactionBytes) continue;
        next.apply(tx, this.genesis.activityPool);
        selected.push(tx);
        selectedBytes += transactionBytes;
        seen.add(tx.txid);
      } catch {
        // Invalid or stale mempool entries are omitted; block validation stays authoritative.
      }
    }
    return selected;
  }

  private validateAndApply(transactions: Transaction[], startingState: LedgerState, blockHeight: number): AppliedTransition {
    const protocolVersion = this.protocolVersionAt(blockHeight);
    const next = protocolVersion === 1 ? startingState.clone() : startingState;
    let sparse = protocolVersion === 2
      ? (this.stateV2 ?? stateV2FromLedgerSnapshot(startingState.snapshot(), this.governanceSnapshot()))
      : undefined;
    const seen = new Set<string>();
    const currentValidators = this.validatorsAt(blockHeight);
    let lastActivation = this.lastValidatorActivationHeight();
    let lastProtocolActivation = this.lastProtocolActivationHeight();
    for (const tx of transactions) {
      if (tx.chainId !== this.genesis.chainId) throw new Error("Wrong transaction chain ID");
      if (seen.has(tx.txid)) throw new Error("Duplicate transaction in block");
      seen.add(tx.txid);
      validateTransactionShape(tx);
      if (tx.kind === "activity_settlement") {
        if (!this.genesis.activityOracles.includes(tx.publicKey)) {
          throw new Error("Unauthorized activity oracle");
        }
      }
      if (tx.kind === "validator_update") {
        validateValidatorUpdateAuthorization(tx, currentValidators, blockHeight, lastActivation);
        lastActivation = tx.activationHeight;
      } else if (tx.kind === "protocol_upgrade") {
        validateProtocolUpgradeAuthorization(tx, currentValidators, blockHeight, lastProtocolActivation);
        lastProtocolActivation = tx.activationHeight;
      }
      if (sparse) sparse = applyStateV2Transaction(sparse, tx, this.genesis.activityPool);
      else next.apply(tx, this.genesis.activityPool);
    }
    return { ledger: next, sparse };
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
    if (!Number.isSafeInteger(candidate.activationHeight) || Number(candidate.activationHeight) <= previousHeight ||
        !Number.isSafeInteger(candidate.protocolVersion) || !SUPPORTED_PROTOCOL_VERSIONS.has(Number(candidate.protocolVersion))) {
      throw new Error("Invalid checkpoint protocol schedule");
    }
    result.set(Number(candidate.activationHeight), Number(candidate.protocolVersion));
    previousHeight = Number(candidate.activationHeight);
  }
  if (result.get(0) !== 1) throw new Error("Checkpoint protocol schedule does not start at genesis");
  return result;
}

function stateRootForProtocol(protocolVersion: number, state: AppliedTransition): string {
  if (protocolVersion === 1) return state.ledger.root();
  if (protocolVersion === 2 && state.sparse) return state.sparse.root();
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
    if (!verifyCanonical(payload, approval.signature, approval.publicKey)) {
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
    if (!verifyCanonical(payload, approval.signature, approval.publicKey)) {
      throw new Error("Invalid protocol upgrade approval");
    }
    valid += 1;
  }
  const quorum = Math.floor((currentValidators.length * 2) / 3) + 1;
  if (valid < quorum) throw new Error(`Protocol upgrade quorum not reached: ${valid}/${quorum}`);
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
  if (!Array.isArray(genesis.allocations) || genesis.allocations.length === 0) {
    throw new Error("Invalid allocations");
  }
  const allocated = new Set<string>();
  for (const allocation of genesis.allocations) {
    assertPlainRecord(allocation, "allocation");
    assertExactKeys(allocation, ["address", "amountAtoms"], "allocation");
    assertAddress(allocation.address);
    if (!Number.isSafeInteger(allocation.amountAtoms) || allocation.amountAtoms < 0) {
      throw new Error("Invalid genesis allocation");
    }
    if (allocated.has(allocation.address)) throw new Error("Duplicate genesis allocation");
    allocated.add(allocation.address);
  }
}
