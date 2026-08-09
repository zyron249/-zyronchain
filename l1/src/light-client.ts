import { blockHash, expectedValidator, validateAttestationQuorum, validateBlockShape, validateRoundCertificate } from "./block.js";
import { assertHex } from "./codec.js";
import { addressFromPublicKey, verifyCanonical, verifyCanonicalDomain } from "./crypto.js";
import { validatorScheduleKey, verifySparseMerkleProof, type SparseMerkleProof } from "./state-v2.js";
import { assertExactKeys, assertPlainRecord } from "./transaction.js";
import type { Block, BlockAttestation, BlockHeader, RoundSkipVote, Validator } from "./types.js";

export interface LightClientAnchor {
  version: 1;
  chainId: string;
  genesisHash: string;
  height: number;
  blockHash: string;
  stateRoot: string;
  timestampMs: number;
  protocolVersion: number;
  validators: Validator[];
}

export interface LightFinalityProof {
  version: 1;
  header: BlockHeader;
  hash: string;
  proposerPublicKey: string;
  signature: string;
  roundCertificate: RoundSkipVote[];
  attestations: BlockAttestation[];
}

/** Validate an independently obtained trust anchor before using it. */
export function validateLightClientAnchor(value: unknown): LightClientAnchor {
  assertPlainRecord(value, "light-client anchor");
  assertExactKeys(value, [
    "version", "chainId", "genesisHash", "height", "blockHash", "stateRoot",
    "timestampMs", "protocolVersion", "validators"
  ], "light-client anchor");
  if (value.version !== 1 || typeof value.chainId !== "string" || !/^[a-z0-9-]{3,64}$/.test(value.chainId) ||
      !Number.isSafeInteger(value.height) || Number(value.height) < 0 ||
      !Number.isSafeInteger(value.timestampMs) || Number(value.timestampMs) < 0 ||
      !Number.isSafeInteger(value.protocolVersion) || Number(value.protocolVersion) < 1 ||
      !Array.isArray(value.validators) || value.validators.length < 1 || value.validators.length > 100) {
    throw new Error("Invalid light-client anchor");
  }
  assertHexField(value.genesisHash, "light-client genesis hash");
  assertHexField(value.blockHash, "light-client block hash");
  assertHexField(value.stateRoot, "light-client state root");
  const seen = new Set<string>();
  const validators = value.validators.map((candidate) => {
    assertPlainRecord(candidate, "light-client validator");
    assertExactKeys(candidate, ["address", "publicKey"], "light-client validator");
    if (typeof candidate.address !== "string" || typeof candidate.publicKey !== "string") {
      throw new Error("Invalid light-client validator");
    }
    assertHex(candidate.publicKey, 64, "light-client validator public key");
    if (addressFromPublicKey(candidate.publicKey) !== candidate.address || seen.has(candidate.address)) {
      throw new Error("Invalid or duplicate light-client validator");
    }
    seen.add(candidate.address);
    return { address: candidate.address, publicKey: candidate.publicKey } as Validator;
  });
  return {
    version: 1,
    chainId: value.chainId,
    genesisHash: value.genesisHash as string,
    height: Number(value.height),
    blockHash: value.blockHash as string,
    stateRoot: value.stateRoot as string,
    timestampMs: Number(value.timestampMs),
    protocolVersion: Number(value.protocolVersion),
    validators
  };
}

/**
 * Verify one finalized header extending an independently trusted anchor.
 * Validator-set transitions are deliberately not inferred from peer input; the
 * returned anchor keeps the exact trusted set until a separately verified
 * transition proof is introduced.
 */
export function verifyNextFinalizedHeader(anchorValue: unknown, proofValue: unknown): LightClientAnchor {
  const anchor = validateLightClientAnchor(anchorValue);
  assertPlainRecord(proofValue, "light finality proof");
  assertExactKeys(proofValue, [
    "version", "header", "hash", "proposerPublicKey", "signature", "roundCertificate", "attestations"
  ], "light finality proof");
  if (proofValue.version !== 1 || typeof proofValue.hash !== "string" ||
      typeof proofValue.proposerPublicKey !== "string" || typeof proofValue.signature !== "string" ||
      !Array.isArray(proofValue.roundCertificate) || !Array.isArray(proofValue.attestations) ||
      proofValue.roundCertificate.length > anchor.validators.length || proofValue.attestations.length > anchor.validators.length) {
    throw new Error("Invalid light finality proof");
  }
  const block: Block = {
    header: proofValue.header as BlockHeader,
    transactions: [],
    hash: proofValue.hash,
    proposerPublicKey: proofValue.proposerPublicKey,
    signature: proofValue.signature,
    roundCertificate: proofValue.roundCertificate as RoundSkipVote[],
    attestations: proofValue.attestations as BlockAttestation[]
  };
  // Reuse the consensus wire validator for every nested header/signature/vote
  // field. Transaction bytes are intentionally absent: their Merkle root is a
  // signed commitment in the finalized header.
  validateBlockShape(block);
  if (block.header.chainId !== anchor.chainId) throw new Error("Light-client chain ID mismatch");
  if (block.header.height !== anchor.height + 1) throw new Error("Light-client height discontinuity");
  if (block.header.previousHash !== anchor.blockHash) throw new Error("Light-client previous hash mismatch");
  if (block.header.timestampMs <= anchor.timestampMs) throw new Error("Light-client timestamp did not advance");
  if (block.header.version !== anchor.protocolVersion) throw new Error("Light-client protocol version mismatch");
  if (block.hash !== blockHash(block.header)) throw new Error("Light-client block hash mismatch");

  const proposer = expectedValidator(anchor.validators, block.header.height, block.header.round);
  if (block.header.proposer !== proposer.address || block.proposerPublicKey !== proposer.publicKey) {
    throw new Error("Unexpected light-client proposer");
  }
  const proposerSignatureValid = block.header.version >= 3
    ? verifyCanonicalDomain("zyronchain/block-proposal/v1", block.header, block.signature!, block.proposerPublicKey!)
    : verifyCanonical(block.header, block.signature!, block.proposerPublicKey!);
  if (!proposerSignatureValid) {
    throw new Error("Invalid light-client proposer signature");
  }
  validateRoundCertificate(block, anchor.validators);
  validateAttestationQuorum(block, anchor.validators);

  return {
    ...anchor,
    height: block.header.height,
    blockHash: block.hash,
    stateRoot: block.header.stateRoot,
    timestampMs: block.header.timestampMs
  };
}

/** Verify a State-v2 membership/non-membership proof against a finalized anchor. */
export function verifyLightClientStateProof(
  anchorValue: unknown,
  key: string,
  value: unknown | null,
  proof: SparseMerkleProof
): boolean {
  try {
    const anchor = validateLightClientAnchor(anchorValue);
    if (anchor.protocolVersion !== 2 && anchor.protocolVersion !== 3) return false;
    return verifySparseMerkleProof(anchor.stateRoot, key, value, proof);
  } catch {
    return false;
  }
}

/**
 * Authenticate the validator set that activates at the very next height.
 * The schedule value is read through a Merkle proof from the current finalized
 * State-v2 root, so the new set is never accepted merely because a peer supplied it.
 */
export function activateNextValidatorSet(
  anchorValue: unknown,
  validatorsValue: unknown,
  proof: SparseMerkleProof
): LightClientAnchor {
  const anchor = validateLightClientAnchor(anchorValue);
  if (anchor.protocolVersion !== 2 && anchor.protocolVersion !== 3) {
    throw new Error("Validator transition proof requires authenticated State v2");
  }
  if (!Array.isArray(validatorsValue)) throw new Error("Invalid light-client validator transition");
  // Reuse anchor validation for the exact validator identity/cardinality rules.
  const candidate = validateLightClientAnchor({ ...anchor, validators: validatorsValue });
  const activationHeight = anchor.height + 1;
  if (!Number.isSafeInteger(activationHeight)) throw new Error("Invalid light-client validator activation height");
  const key = validatorScheduleKey(activationHeight);
  if (!verifySparseMerkleProof(anchor.stateRoot, key, { validators: candidate.validators }, proof)) {
    throw new Error("Invalid light-client validator transition proof");
  }
  return candidate;
}

function assertHexField(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  assertHex(value, 32, label);
}
