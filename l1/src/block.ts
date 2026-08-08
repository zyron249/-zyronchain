import { assertHex, canonicalJson, sha256Hex } from "./codec.js";
import { addressFromPublicKey, signCanonical, verifyCanonical } from "./crypto.js";
import { merkleRoot } from "./merkle.js";
import { assertAddress, assertExactKeys, assertPlainRecord, validateTransactionShape } from "./transaction.js";
import type {
  Block,
  BlockAttestation,
  BlockHeader,
  GenesisConfig,
  Transaction,
  Validator
} from "./types.js";

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
    attestations: []
  };
}

export function createSignedBlock(input: {
  chainId: string;
  height: number;
  round: number;
  previousHash: string;
  timestampMs: number;
  transactions: Transaction[];
  stateRoot: string;
  proposerPrivateKey: string;
  proposerPublicKey: string;
}): Block {
  const header: BlockHeader = {
    version: 1,
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
  const signature = signCanonical(header, input.proposerPrivateKey);
  return {
    header,
    transactions: input.transactions,
    hash,
    proposerPublicKey: input.proposerPublicKey,
    signature,
    attestations: []
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
    signature: signCanonical(payload, validatorPrivateKey)
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
  const index = (height - 1 + round) % validators.length;
  return validators[index]!;
}

export function validateBlockEnvelope(
  block: Block,
  previous: Block,
  validators: Validator[],
  nowMs: number,
  requireFinality = true
): void {
  validateBlockShape(block);
  if (block.header.version !== 1) throw new Error("Unsupported block version");
  if (block.header.chainId !== previous.header.chainId) throw new Error("Wrong chain ID");
  if (block.header.height !== previous.header.height + 1) throw new Error("Wrong block height");
  if (block.header.previousHash !== previous.hash) throw new Error("Wrong previous hash");
  if (block.header.round !== 0) {
    throw new Error("Only consensus round 0 is enabled until certified view-change is implemented");
  }
  if (!Number.isSafeInteger(block.header.timestampMs)) throw new Error("Invalid block timestamp");
  if (block.header.timestampMs <= previous.header.timestampMs) throw new Error("Block time must increase");
  if (block.header.timestampMs > nowMs + 120_000) throw new Error("Block time too far in future");
  if (block.transactions.length > 10_000) throw new Error("Too many transactions");
  if (block.header.transactionRoot !== merkleRoot(block.transactions)) {
    throw new Error("Transaction Merkle root mismatch");
  }
  if (block.hash !== blockHash(block.header)) throw new Error("Block hash mismatch");
  assertHex(block.hash, 32, "block hash");
  if (!block.proposerPublicKey || !block.signature) throw new Error("Missing proposer signature");
  assertHex(block.proposerPublicKey, 64, "proposerPublicKey");
  assertHex(block.signature, 64, "block signature");
  const expected = expectedValidator(validators, block.header.height, block.header.round);
  if (block.header.proposer !== expected.address) throw new Error("Unexpected proposer");
  if (block.proposerPublicKey !== expected.publicKey) throw new Error("Unexpected proposer public key");
  if (!verifyCanonical(block.header, block.signature, block.proposerPublicKey)) {
    throw new Error("Invalid proposer signature");
  }
  if (requireFinality) validateAttestationQuorum(block, validators);
}

export function validateBlockShape(value: unknown): asserts value is Block {
  assertPlainRecord(value, "block");
  assertExactKeys(value, [
    "header", "transactions", "hash", "proposerPublicKey", "signature", "attestations"
  ], "block");
  assertPlainRecord(value.header, "block header");
  assertExactKeys(value.header, [
    "version", "chainId", "height", "round", "previousHash", "timestampMs",
    "transactionRoot", "stateRoot", "proposer"
  ], "block header");
  const header = value.header;
  if (header.version !== 1 || typeof header.chainId !== "string") throw new Error("Invalid block header");
  for (const [name, item] of [["height", header.height], ["round", header.round], ["timestampMs", header.timestampMs]] as const) {
    if (!Number.isSafeInteger(item) || (name !== "timestampMs" && Number(item) < 0)) throw new Error(`Invalid block ${name}`);
  }
  for (const [name, item] of [["previousHash", header.previousHash], ["transactionRoot", header.transactionRoot], ["stateRoot", header.stateRoot], ["hash", value.hash]] as const) {
    if (typeof item !== "string") throw new Error(`Invalid ${name}`);
    assertHex(item, 32, name);
  }
  if (header.proposer !== "GENESIS") assertAddress(header.proposer as string);
  if (!Array.isArray(value.transactions)) throw new Error("Invalid block transactions");
  for (const tx of value.transactions) validateTransactionShape(tx);
  if (!Array.isArray(value.attestations)) throw new Error("Invalid block attestations");
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
}

export function validateAttestationQuorum(block: Block, validators: Validator[]): void {
  const allowed = new Map(validators.map((validator) => [validator.address, validator.publicKey]));
  const seen = new Set<string>();
  let valid = 0;
  for (const attestation of block.attestations) {
    if (seen.has(attestation.validator)) throw new Error("Duplicate validator attestation");
    seen.add(attestation.validator);
    const expectedPublicKey = allowed.get(attestation.validator);
    if (!expectedPublicKey || expectedPublicKey !== attestation.publicKey) {
      throw new Error("Unknown validator attestation");
    }
    if (!verifyCanonical(attestationPayload(block), attestation.signature, attestation.publicKey)) {
      throw new Error("Invalid validator attestation");
    }
    valid += 1;
  }
  const quorum = Math.floor((validators.length * 2) / 3) + 1;
  if (valid < quorum) throw new Error(`Finality quorum not reached: ${valid}/${quorum}`);
}
