import { assertHex, canonicalJson, sha256Hex } from "./codec.js";
import {
  addressFromPublicKey,
  signCanonical,
  signCanonicalDomain,
  verifyCanonical,
  verifyCanonicalDomain
} from "./crypto.js";
import { merkleRoot } from "./merkle.js";
import { assertAddress, assertExactKeys, assertPlainRecord, validateTransactionShape } from "./transaction.js";
import type {
  Block,
  BlockAttestation,
  BlockHeader,
  GenesisConfig,
  RoundSkipVote,
  Transaction,
  Validator
} from "./types.js";

export const MAX_VALIDATOR_COUNT = 100;
export const MAX_BLOCK_TRANSACTIONS = 10_000;
export const MAX_BLOCK_BYTES = 2_000_000;

export function blockHash(header: BlockHeader): string {
  return sha256Hex(canonicalJson(header));
}

export function createGenesisBlock(genesis: GenesisConfig, stateRoot: string): Block {
  const header: BlockHeader = {
    version: 1,
    chainId: genesis.chainId,
    height: 0,
    round: 0,
    previousHash: "0".repeat(64),
    timestampMs: genesis.timestampMs,
    transactionRoot: merkleRoot([]),
    stateRoot,
    proposer: "GENESIS"
  };
  return {
    header,
    transactions: [],
    hash: blockHash(header),
    proposerPublicKey: null,
    signature: null,
    roundCertificate: [],
    attestations: []
  };
}

export function createSignedBlock(input: {
  version: number;
  chainId: string;
  height: number;
  round: number;
  previousHash: string;
  timestampMs: number;
  transactions: Transaction[];
  stateRoot: string;
  proposerPrivateKey: string;
  proposerPublicKey: string;
  roundCertificate?: RoundSkipVote[];
}): Block {
  const unsigned = createUnsignedBlock(input);
  const signature = signForProtocol(
    input.version,
    "zyronchain/block-proposal/v1",
    unsigned.header,
    input.proposerPrivateKey
  );
  return attachBlockSignature(unsigned, signature);
}

export function createUnsignedBlock(input: {
  version: number;
  chainId: string;
  height: number;
  round: number;
  previousHash: string;
  timestampMs: number;
  transactions: Transaction[];
  stateRoot: string;
  proposerPublicKey: string;
  roundCertificate?: RoundSkipVote[];
}): Block {
  const header: BlockHeader = {
    version: input.version,
    chainId: input.chainId,
    height: input.height,
    round: input.round,
    previousHash: input.previousHash,
    timestampMs: input.timestampMs,
    transactionRoot: merkleRoot(input.transactions),
    stateRoot: input.stateRoot,
    proposer: addressFromPublicKey(input.proposerPublicKey)
  };
  const hash = blockHash(header);
  return {
    header,
    transactions: input.transactions,
    hash,
    proposerPublicKey: input.proposerPublicKey,
    signature: null,
    roundCertificate: structuredClone(input.roundCertificate ?? []),
    attestations: []
  };
}

export function attachBlockSignature(block: Block, signature: string): Block {
  if (block.header.height === 0 || !block.proposerPublicKey) throw new Error("Cannot sign genesis block as validator proposal");
  assertHex(signature, 64, "block signature");
  if (!verifyForProtocol(block.header.version, "zyronchain/block-proposal/v1", block.header, signature, block.proposerPublicKey)) {
    throw new Error("Invalid proposer signature");
  }
  return { ...block, signature };
}

export function roundSkipPayload(vote: Omit<RoundSkipVote, "signature">): unknown {
  return {
    validator: vote.validator,
    publicKey: vote.publicKey,
    chainId: vote.chainId,
    height: vote.height,
    round: vote.round,
    previousHash: vote.previousHash
  };
}

export function createRoundSkipVote(input: {
  chainId: string;
  height: number;
  round: number;
  previousHash: string;
  validatorPrivateKey: string;
  validatorPublicKey: string;
  protocolVersion?: number;
}): RoundSkipVote {
  const unsigned = {
    validator: addressFromPublicKey(input.validatorPublicKey),
    publicKey: input.validatorPublicKey,
    chainId: input.chainId,
    height: input.height,
    round: input.round,
    previousHash: input.previousHash
  };
  return {
    ...unsigned,
    signature: signForProtocol(
      input.protocolVersion ?? 1,
      "zyronchain/round-skip/v1",
      roundSkipPayload(unsigned),
      input.validatorPrivateKey
    )
  };
}

export function createBlockAttestation(
  block: Block,
  validatorPrivateKey: string,
  validatorPublicKey: string
): BlockAttestation {
  const validator = addressFromPublicKey(validatorPublicKey);
  const payload = attestationPayload(block);
  return {
    validator,
    publicKey: validatorPublicKey,
    signature: signForProtocol(
      block.header.version,
      "zyronchain/finality-attestation/v1",
      payload,
      validatorPrivateKey
    )
  };
}

export function attestationPayload(block: Block): unknown {
  return {
    chainId: block.header.chainId,
    height: block.header.height,
    blockHash: block.hash
  };
}

export function expectedValidator(validators: Validator[], height: number, round: number): Validator {
  if (validators.length === 0) throw new Error("Validator set is empty");
  if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(round) || round < 0) {
    throw new Error("Invalid proposer height or round");
  }
  const validatorCount = validators.length;
  const index = (((height - 1) % validatorCount) + (round % validatorCount)) % validatorCount;
  return validators[index]!;
}

export function validatorQuorumSize(validatorCount: number): number {
  if (!Number.isSafeInteger(validatorCount) || validatorCount < 1) throw new Error("Invalid validator count");
  return Math.floor((validatorCount * 2) / 3) + 1;
}

export function validateBlockEnvelope(
  block: Block,
  previous: Block,
  validators: Validator[],
  nowMs: number,
  requireFinality = true,
  expectedProtocolVersion = 1,
  requireProposerSignature = true
): void {
  validateBlockShape(block);
  if (Buffer.byteLength(canonicalJson(block), "utf8") > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
  if (block.header.version !== expectedProtocolVersion) throw new Error("Unexpected protocol version");
  if (block.header.chainId !== previous.header.chainId) throw new Error("Wrong chain ID");
  if (block.header.height !== previous.header.height + 1) throw new Error("Wrong block height");
  if (block.header.previousHash !== previous.hash) throw new Error("Wrong previous hash");
  if (!Number.isSafeInteger(block.header.round) || block.header.round < 0) throw new Error("Invalid round");
  if (!Number.isSafeInteger(block.header.timestampMs)) throw new Error("Invalid block timestamp");
  if (block.header.timestampMs <= previous.header.timestampMs) throw new Error("Block time must increase");
  if (block.header.timestampMs > nowMs + 120_000) throw new Error("Block time too far in future");
  if (block.transactions.length > MAX_BLOCK_TRANSACTIONS) throw new Error("Too many transactions");
  if (block.header.transactionRoot !== merkleRoot(block.transactions)) {
    throw new Error("Transaction Merkle root mismatch");
  }
  if (block.hash !== blockHash(block.header)) throw new Error("Block hash mismatch");
  assertHex(block.hash, 32, "block hash");
  if (!block.proposerPublicKey || (requireProposerSignature && !block.signature)) throw new Error("Missing proposer signature");
  assertHex(block.proposerPublicKey, 64, "proposerPublicKey");
  if (!requireProposerSignature && block.signature !== null) throw new Error("Prepared block must be unsigned");
  if (block.signature) assertHex(block.signature, 64, "block signature");
  const expected = expectedValidator(validators, block.header.height, block.header.round);
  if (block.header.proposer !== expected.address) throw new Error("Unexpected proposer");
  if (block.proposerPublicKey !== expected.publicKey) throw new Error("Unexpected proposer public key");
  if (requireProposerSignature && !verifyForProtocol(
    block.header.version,
    "zyronchain/block-proposal/v1",
    block.header,
    block.signature!,
    block.proposerPublicKey
  )) {
    throw new Error("Invalid proposer signature");
  }
  validateRoundCertificate(block, validators);
  if (requireFinality) validateAttestationQuorum(block, validators);
}

export function validateRoundCertificate(block: Block, validators: Validator[]): void {
  if (block.header.round === 0) {
    if (block.roundCertificate.length !== 0) throw new Error("Round 0 must not contain a skip certificate");
    return;
  }
  validateRoundSkipQuorum(
    block.roundCertificate,
    validators,
    block.header.chainId,
    block.header.height,
    block.header.round - 1,
    block.header.previousHash,
    block.header.version
  );
}

export function validateRoundSkipQuorum(
  votes: RoundSkipVote[],
  validators: Validator[],
  chainId: string,
  height: number,
  round: number,
  previousHash: string,
  protocolVersion = 1
): void {
  if (votes.length > validators.length) throw new Error("Round skip certificate exceeds active validator set");
  const allowed = new Map(validators.map((validator) => [validator.address, validator.publicKey]));
  const seen = new Set<string>();
  let valid = 0;
  for (const vote of votes) {
    if (seen.has(vote.validator)) throw new Error("Duplicate round skip vote");
    seen.add(vote.validator);
    validateRoundSkipVote(vote, allowed, chainId, height, round, previousHash, protocolVersion);
    valid += 1;
  }
  const quorum = validatorQuorumSize(validators.length);
  if (valid < quorum) throw new Error(`Round skip quorum not reached: ${valid}/${quorum}`);
}

export function validateRoundSkipVote(
  vote: unknown,
  validators: Validator[] | Map<string, string>,
  chainId: string,
  height: number,
  round: number,
  previousHash: string,
  protocolVersion = 1
): asserts vote is RoundSkipVote {
  assertPlainRecord(vote, "round skip vote");
  assertExactKeys(vote, ["validator", "publicKey", "chainId", "height", "round", "previousHash", "signature"], "round skip vote");
  if (typeof vote.validator !== "string" || typeof vote.publicKey !== "string" || typeof vote.chainId !== "string" ||
      typeof vote.previousHash !== "string" || typeof vote.signature !== "string" || !Number.isSafeInteger(vote.height) ||
      !Number.isSafeInteger(vote.round)) throw new Error("Invalid round skip vote");
  assertAddress(vote.validator);
  assertHex(vote.publicKey, 64, "round skip publicKey");
  assertHex(vote.previousHash, 32, "round skip previousHash");
  assertHex(vote.signature, 64, "round skip signature");
  const allowed = validators instanceof Map ? validators : new Map(validators.map((validator) => [validator.address, validator.publicKey]));
  if (allowed.get(vote.validator) !== vote.publicKey) throw new Error("Unknown round skip voter");
  if (vote.chainId !== chainId || vote.height !== height || vote.round !== round || vote.previousHash !== previousHash) {
    throw new Error("Round skip vote does not match proposal");
  }
  const { signature: _signature, ...unsigned } = vote;
  if (!verifyForProtocol(
    protocolVersion,
    "zyronchain/round-skip/v1",
    roundSkipPayload(unsigned as Omit<RoundSkipVote, "signature">),
    vote.signature,
    vote.publicKey
  )) {
    throw new Error("Invalid round skip signature");
  }
}

export function validateBlockShape(value: unknown): asserts value is Block {
  assertPlainRecord(value, "block");
  assertExactKeys(value, [
    "header", "transactions", "hash", "proposerPublicKey", "signature", "roundCertificate", "attestations"
  ], "block");
  assertPlainRecord(value.header, "block header");
  assertExactKeys(value.header, [
    "version", "chainId", "height", "round", "previousHash", "timestampMs",
    "transactionRoot", "stateRoot", "proposer"
  ], "block header");
  const header = value.header;
  if (!Number.isSafeInteger(header.version) || Number(header.version) < 1 || Number(header.version) > 65_535 ||
      typeof header.chainId !== "string") throw new Error("Invalid block header");
  for (const [name, item] of [["height", header.height], ["round", header.round], ["timestampMs", header.timestampMs]] as const) {
    if (!Number.isSafeInteger(item) || (name !== "timestampMs" && Number(item) < 0)) throw new Error(`Invalid block ${name}`);
  }
  for (const [name, item] of [["previousHash", header.previousHash], ["transactionRoot", header.transactionRoot], ["stateRoot", header.stateRoot], ["hash", value.hash]] as const) {
    if (typeof item !== "string") throw new Error(`Invalid ${name}`);
    assertHex(item, 32, name);
  }
  if (header.proposer !== "GENESIS") assertAddress(header.proposer as string);
  if (!Array.isArray(value.transactions)) throw new Error("Invalid block transactions");
  if (value.transactions.length > MAX_BLOCK_TRANSACTIONS) throw new Error("Too many transactions");
  for (const tx of value.transactions) validateTransactionShape(tx);
  if (!Array.isArray(value.attestations)) throw new Error("Invalid block attestations");
  if (!Array.isArray(value.roundCertificate)) throw new Error("Invalid round certificate");
  if (value.attestations.length > MAX_VALIDATOR_COUNT) throw new Error("Too many block attestations");
  if (value.roundCertificate.length > MAX_VALIDATOR_COUNT) throw new Error("Too many round certificate entries");
  if (value.proposerPublicKey !== null && typeof value.proposerPublicKey !== "string") throw new Error("Invalid proposer public key");
  if (value.signature !== null && typeof value.signature !== "string") throw new Error("Invalid block signature");
  for (const item of value.attestations) {
    assertPlainRecord(item, "block attestation");
    assertExactKeys(item, ["validator", "publicKey", "signature"], "block attestation");
    assertAddress(item.validator as string);
    if (typeof item.publicKey !== "string" || typeof item.signature !== "string") throw new Error("Invalid block attestation");
    assertHex(item.publicKey, 64, "attestation publicKey");
    assertHex(item.signature, 64, "attestation signature");
  }
  for (const item of value.roundCertificate) {
    assertPlainRecord(item, "round skip vote");
    assertExactKeys(item, ["validator", "publicKey", "chainId", "height", "round", "previousHash", "signature"], "round skip vote");
    assertAddress(item.validator as string);
    if (typeof item.publicKey !== "string" || typeof item.chainId !== "string" || typeof item.previousHash !== "string" ||
        typeof item.signature !== "string" || !Number.isSafeInteger(item.height) || !Number.isSafeInteger(item.round) ||
        Number(item.height) < 1 || Number(item.round) < 0) throw new Error("Invalid round skip vote");
    assertHex(item.publicKey, 64, "round skip publicKey");
    assertHex(item.previousHash, 32, "round skip previousHash");
    assertHex(item.signature, 64, "round skip signature");
  }
}

export function validateAttestationQuorum(block: Block, validators: Validator[]): void {
  if (block.attestations.length > validators.length) throw new Error("Finality certificate exceeds active validator set");
  const allowed = new Map(validators.map((validator) => [validator.address, validator.publicKey]));
  const seen = new Set<string>();
  let valid = 0;
  for (const attestation of block.attestations) {
    if (seen.has(attestation.validator)) throw new Error("Duplicate validator attestation");
    seen.add(attestation.validator);
    validateBlockAttestation(block, attestation, allowed);
    valid += 1;
  }
  const quorum = validatorQuorumSize(validators.length);
  if (valid < quorum) throw new Error(`Finality quorum not reached: ${valid}/${quorum}`);
}

export function validateBlockAttestation(
  block: Block,
  attestation: unknown,
  validators: Validator[] | Map<string, string>
): asserts attestation is BlockAttestation {
  assertPlainRecord(attestation, "block attestation");
  assertExactKeys(attestation, ["validator", "publicKey", "signature"], "block attestation");
  if (typeof attestation.validator !== "string" || typeof attestation.publicKey !== "string" || typeof attestation.signature !== "string") {
    throw new Error("Invalid block attestation");
  }
  assertAddress(attestation.validator);
  assertHex(attestation.publicKey, 64, "attestation publicKey");
  assertHex(attestation.signature, 64, "attestation signature");
  const allowed = validators instanceof Map ? validators : new Map(validators.map((validator) => [validator.address, validator.publicKey]));
  if (allowed.get(attestation.validator) !== attestation.publicKey) throw new Error("Unknown validator attestation");
  if (!verifyForProtocol(
    block.header.version,
    "zyronchain/finality-attestation/v1",
    attestationPayload(block),
    attestation.signature,
    attestation.publicKey
  )) {
    throw new Error("Invalid validator attestation");
  }
}

function signForProtocol(
  protocolVersion: number,
  domain: string,
  payload: unknown,
  privateKeyHex: string
): string {
  return protocolVersion >= 3
    ? signCanonicalDomain(domain, payload, privateKeyHex)
    : signCanonical(payload, privateKeyHex);
}

function verifyForProtocol(
  protocolVersion: number,
  domain: string,
  payload: unknown,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  return protocolVersion >= 3
    ? verifyCanonicalDomain(domain, payload, signatureHex, publicKeyHex)
    : verifyCanonical(payload, signatureHex, publicKeyHex);
}
