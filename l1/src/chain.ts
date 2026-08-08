import { canonicalJson } from "./codec.js";
import {
  createGenesisBlock,
  createBlockAttestation,
  createSignedBlock,
  expectedValidator,
  validateBlockEnvelope
} from "./block.js";
import { addressFromPublicKey, publicKeyFromPrivate, verifyCanonical } from "./crypto.js";
import { LedgerState } from "./state.js";
import {
  assertAddress,
  assertExactKeys,
  assertPlainRecord,
  protocolUpgradeApprovalPayload,
  validateTransactionShape,
  validatorUpdateApprovalPayload
} from "./transaction.js";
import { assertHex } from "./codec.js";
import type { Block, GenesisConfig, ProtocolUpgradeTx, RoundSkipVote, Transaction, Validator, ValidatorSetUpdateTx } from "./types.js";

const MAX_BLOCK_BYTES = 2_000_000;
export const MIN_VALIDATOR_UPDATE_DELAY = 100;
export const MIN_PROTOCOL_UPDATE_DELAY = 100;
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([1]);

export class ZyronChain {
  readonly genesis: GenesisConfig;
  private readonly genesisBlock: Block;
  private tipBlock: Block;
  private currentHeight = 0;
  private readonly validatorSchedule = new Map<number, Validator[]>();
  private readonly protocolSchedule = new Map<number, number>();
  private state: LedgerState;

  constructor(genesis: GenesisConfig) {
    validateGenesis(genesis);
    this.genesis = structuredClone(genesis);
    this.state = LedgerState.fromGenesis(genesis);
    this.genesisBlock = createGenesisBlock(genesis, this.state.root());
    this.tipBlock = this.genesisBlock;
    this.validatorSchedule.set(0, structuredClone(genesis.validators));
    this.protocolSchedule.set(0, 1);
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
    const nextState = this.validateAndApply(transactions, this.state, this.height + 1);
    const block = createSignedBlock({
      version: protocolVersion,
      chainId: this.genesis.chainId,
      height: this.height + 1,
      round,
      previousHash: this.tip.hash,
      timestampMs,
      transactions,
      stateRoot: nextState.root(),
      proposerPrivateKey,
      proposerPublicKey: publicKey,
      roundCertificate: options.roundCertificate ?? []
    });
    validateBlockEnvelope(block, this.tip, validators, timestampMs, false, protocolVersion);
    return block;
  }

  acceptBlock(block: Block, nowMs = Date.now()): void {
    const nextState = this.validateFinalizedBlock(block, nowMs);
    this.tipBlock = structuredClone(block);
    this.currentHeight = block.header.height;
    this.state = nextState;
    this.recordGovernanceUpdates(block.transactions);
  }

  validateFinalizedBlock(block: Block, nowMs = Date.now()): LedgerState {
    const protocolVersion = this.protocolVersionAt(block.header.height);
    assertSupportedProtocolVersion(protocolVersion);
    const validators = this.validatorsAt(block.header.height);
    validateBlockEnvelope(block, this.tip, validators, nowMs, true, protocolVersion);
    if (canonicalJson(block).length > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
    const nextState = this.validateAndApply(block.transactions, this.state, block.header.height);
    if (block.header.stateRoot !== nextState.root()) throw new Error("State root mismatch");
    return nextState;
  }

  validateProposal(block: Block, nowMs = Date.now()): void {
    const protocolVersion = this.protocolVersionAt(block.header.height);
    assertSupportedProtocolVersion(protocolVersion);
    validateBlockEnvelope(block, this.tip, this.validatorsAt(block.header.height), nowMs, false, protocolVersion);
    if (canonicalJson(block).length > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
    const nextState = this.validateAndApply(block.transactions, this.state, block.header.height);
    if (block.header.stateRoot !== nextState.root()) throw new Error("State root mismatch");
  }

  validatePending(transactions: Transaction[]): void {
    this.validateAndApply(transactions, this.state, this.height + 1);
  }

  selectValidPending(transactions: Transaction[], limit: number): Transaction[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) {
      throw new Error("Invalid pending selection limit");
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
        next.apply(tx, this.genesis.activityPool);
        selected.push(tx);
        seen.add(tx.txid);
      } catch {
        // Invalid or stale mempool entries are omitted; block validation stays authoritative.
      }
    }
    return selected;
  }

  private validateAndApply(transactions: Transaction[], startingState: LedgerState, blockHeight: number): LedgerState {
    const next = startingState.clone();
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
      next.apply(tx, this.genesis.activityPool);
    }
    return next;
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
  if (!Array.isArray(genesis.validators) || genesis.validators.length === 0) {
    throw new Error("At least one validator is required");
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
