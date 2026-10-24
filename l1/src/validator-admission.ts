import { genesisConfigCommitment } from "./block.js";
import { assertHex } from "./codec.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonicalDomain, verifyCanonicalDomain } from "./crypto.js";
import { isStrictNetworkClass, readNetworkClass } from "./network-class.js";
import type { GenesisConfig, Validator, ValidatorPossessionProof, ValidatorSetUpdateTx } from "./types.js";

/**
 * Validator admission, policy possession-proof-v1 (P1-07, F-05 residual;
 * docs/VALIDATOR_POSSESSION_PROOF.md).
 *
 * Under the opt-in genesis field `validatorAdmission`, every genesis validator
 * signs, with its own private key, a domain-separated statement that binds the
 * chain ID, the chain identity (`chainBinding`), the activation height and its
 * own slot. A value-bearing network class (`public-launch`, `value-bearing`,
 * `mainnet`) must carry the field. Genesis files without it keep their
 * validation and their genesis hash.
 *
 * For genesis proofs `chainBinding` is the genesis configuration commitment,
 * which is computed with `validatorAdmission.genesisProofs` replaced by an
 * empty array (see `genesisConfigCommitment`), so the chain identity never
 * depends on the proof bytes and nothing signs a hash that covers itself.
 */
export const POSSESSION_PROOF_DOMAIN = "zyronchain/validator-possession/v1";
export const POSSESSION_PROOF_POLICY_V1 = "possession-proof-v1";

export interface PossessionProofStatement {
  chainId: string;
  chainBinding: string;
  activationHeight: number;
  address: string;
  publicKey: string;
}

/** Canonical payload signed under `POSSESSION_PROOF_DOMAIN`. */
export function possessionProofPayload(statement: PossessionProofStatement): PossessionProofStatement {
  return {
    chainId: statement.chainId,
    chainBinding: statement.chainBinding,
    activationHeight: statement.activationHeight,
    address: statement.address,
    publicKey: statement.publicKey
  };
}

export function signPossessionProof(statement: PossessionProofStatement, privateKeyHex: string): string {
  if (publicKeyFromPrivate(privateKeyHex) !== statement.publicKey) {
    throw new Error("Possession proof private key does not match the validator public key");
  }
  return signCanonicalDomain(POSSESSION_PROOF_DOMAIN, possessionProofPayload(statement), privateKeyHex);
}

export function verifyPossessionProof(statement: PossessionProofStatement, signatureHex: string): boolean {
  return verifyCanonicalDomain(POSSESSION_PROOF_DOMAIN, possessionProofPayload(statement), signatureHex, statement.publicKey);
}

export function hasValidatorAdmission(genesis: object): boolean {
  return Object.prototype.hasOwnProperty.call(genesis, "validatorAdmission");
}

/**
 * Chain binding of a genesis possession proof: the proof-independent genesis
 * configuration commitment (`genesisConfigCommitment` empties
 * `validatorAdmission.genesisProofs` before hashing).
 */
export function genesisPossessionChainBinding(genesis: GenesisConfig): string {
  return genesisConfigCommitment(genesis);
}

function assertPlainRecordValue(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Unexpected ${name} field ${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`Missing ${name} field ${key}`);
  }
}

/**
 * Structure check of `validatorAdmission` (fail-closed record). Signatures are
 * checked by `assertGenesisPossessionProofs` once the rest of the genesis is
 * valid.
 */
export function validateValidatorAdmissionShape(genesis: GenesisConfig): void {
  if (!hasValidatorAdmission(genesis)) return;
  const admission = genesis.validatorAdmission as unknown;
  assertPlainRecordValue(admission, "validatorAdmission must be a plain record");
  if (typeof admission.policy !== "string" || admission.policy !== POSSESSION_PROOF_POLICY_V1) {
    throw new Error("Unsupported validatorAdmission policy");
  }
  assertOnlyKeys(admission, ["policy", "genesisProofs"], "validatorAdmission");
  if (!Array.isArray(admission.genesisProofs)) throw new Error("validatorAdmission genesisProofs must be an array");
  for (const proof of admission.genesisProofs as unknown[]) {
    assertPlainRecordValue(proof, "Genesis possession proof must be a plain record");
    assertOnlyKeys(proof, ["address", "signature"], "genesis possession proof");
    if (typeof proof.address !== "string") throw new Error("Invalid genesis possession proof address");
    if (typeof proof.signature !== "string") throw new Error("Invalid genesis possession proof signature");
    assertHex(proof.signature, 64, "genesis possession proof signature");
  }
}

/** A value-bearing network class must opt in. */
export function assertValueBearingClassRequiresValidatorAdmission(genesis: GenesisConfig): void {
  if (isStrictNetworkClass(readNetworkClass(genesis)) && !hasValidatorAdmission(genesis)) {
    throw new Error(
      "Value-bearing, public-launch, and mainnet genesis require validatorAdmission (policy \"possession-proof-v1\") with one possession proof per genesis validator"
    );
  }
}

/**
 * Verifies the genesis proofs of an opted-in genesis: exactly one per genesis
 * validator, in the order of `validators`, each a valid signature by that
 * validator's key over its own slot, activation height 0, the genesis chain ID
 * and the proof-independent configuration commitment.
 */
export function assertGenesisPossessionProofs(genesis: GenesisConfig): void {
  if (!hasValidatorAdmission(genesis)) return;
  const proofs = genesis.validatorAdmission!.genesisProofs;
  if (proofs.length !== genesis.validators.length) {
    throw new Error("validatorAdmission requires exactly one possession proof per genesis validator");
  }
  const chainBinding = genesisPossessionChainBinding(genesis);
  for (let index = 0; index < proofs.length; index += 1) {
    const proof = proofs[index]!;
    const validator = genesis.validators[index]!;
    if (proof.address !== validator.address) {
      throw new Error("Genesis possession proof does not match the genesis validator order");
    }
    const valid = verifyPossessionProof({
      chainId: genesis.chainId,
      chainBinding,
      activationHeight: 0,
      address: validator.address,
      publicKey: validator.publicKey
    }, proof.signature);
    if (!valid) throw new Error(`Invalid genesis validator possession proof for ${validator.address}`);
  }
}

/**
 * Tooling helper: returns a copy of `genesis` with `validatorAdmission`
 * (possession-proof-v1) and one proof per validator. `privateKeys[i]` must be
 * the key of `genesis.validators[i]`. In a real ceremony each operator signs
 * locally; this helper is for tests and single-host test networks.
 */
export function signGenesisPossessionProofs(genesis: GenesisConfig, privateKeys: readonly string[]): GenesisConfig {
  if (privateKeys.length !== genesis.validators.length) {
    throw new Error("Provide exactly one private key per genesis validator");
  }
  const unsigned: GenesisConfig = {
    ...structuredClone(genesis),
    validatorAdmission: { policy: POSSESSION_PROOF_POLICY_V1, genesisProofs: [] }
  };
  const chainBinding = genesisPossessionChainBinding(unsigned);
  const genesisProofs: ValidatorPossessionProof[] = genesis.validators.map((validator, index) => {
    if (addressFromPublicKey(validator.publicKey) !== validator.address) {
      throw new Error("Validator address/public key mismatch");
    }
    return {
      address: validator.address,
      signature: signPossessionProof({
        chainId: genesis.chainId,
        chainBinding,
        activationHeight: 0,
        address: validator.address,
        publicKey: validator.publicKey
      }, privateKeys[index]!)
    };
  });
  return { ...unsigned, validatorAdmission: { policy: POSSESSION_PROOF_POLICY_V1, genesisProofs } };
}

/**
 * Possession proof for a validator that a `validator_update` brings in. The
 * chain binding is the chain's genesis hash; the activation height is the
 * update's. Made by the incoming operator with its own key.
 */
export function signValidatorUpdatePossessionProof(
  input: { chainId: string; genesisHash: string; activationHeight: number; validator: Validator },
  privateKeyHex: string
): ValidatorPossessionProof {
  return {
    address: input.validator.address,
    signature: signPossessionProof({
      chainId: input.chainId,
      chainBinding: input.genesisHash,
      activationHeight: input.activationHeight,
      address: input.validator.address,
      publicKey: input.validator.publicKey
    }, privateKeyHex)
  };
}

export interface ValidatorUpdateAdmissionContext {
  /** Whether the genesis declares `validatorAdmission`. */
  optedIn: boolean;
  chainId: string;
  genesisHash: string;
  /**
   * The set this update replaces: the latest scheduled set (activation heights
   * strictly increase, so it is the entry with the highest activation height,
   * including an update accepted earlier in the same block).
   */
  replacedValidators: readonly Validator[];
}

/**
 * possession-proof-v1 rule for `validator_update` (P1-07). Without the
 * opt-in, the field is refused (upgraded and older binaries agree). With it,
 * the field is mandatory and holds exactly one valid proof per incoming
 * validator (not in the replaced set), in `validators` order.
 */
export function assertValidatorUpdatePossessionProofs(tx: ValidatorSetUpdateTx, context: ValidatorUpdateAdmissionContext): void {
  const present = Object.prototype.hasOwnProperty.call(tx, "possessionProofs");
  if (!context.optedIn) {
    if (present) throw new Error("Validator update possessionProofs require validatorAdmission in the genesis");
    return;
  }
  if (!present || !Array.isArray(tx.possessionProofs)) {
    throw new Error("Validator update requires possessionProofs (one possession proof per incoming validator) under validatorAdmission");
  }
  const continuing = new Set(context.replacedValidators.map((validator) => `${validator.address}:${validator.publicKey}`));
  const incoming = tx.validators.filter((validator) => !continuing.has(`${validator.address}:${validator.publicKey}`));
  const proofs = tx.possessionProofs;
  if (proofs.length !== incoming.length) {
    throw new Error("Validator update requires exactly one possession proof per incoming validator");
  }
  for (let index = 0; index < incoming.length; index += 1) {
    const validator = incoming[index]!;
    const proof = proofs[index]!;
    if (proof.address !== validator.address) {
      throw new Error("Validator possession proof does not match the incoming validator order");
    }
    const valid = verifyPossessionProof({
      chainId: context.chainId,
      chainBinding: context.genesisHash,
      activationHeight: tx.activationHeight,
      address: validator.address,
      publicKey: validator.publicKey
    }, proof.signature);
    if (!valid) throw new Error(`Invalid validator possession proof for ${validator.address}`);
  }
}

/**
 * P1-07-F2 (Codex P2 on #1104 at 104e108): the part of the possession-proof
 * rule that a pending predecessor cannot change. Which validators are
 * incoming depends on the replaced set, but every proof of a valid update
 * names a validator of the new set, in `validators` order, and its signature
 * verifies. Used only before a refused update may enter the node's bounded
 * deferred set (so variants with invalid proofs cannot evict a valid one);
 * never for block validity.
 */
export function assertValidatorUpdatePossessionProofSignatures(
  tx: ValidatorSetUpdateTx,
  context: { chainId: string; genesisHash: string }
): void {
  if (!Array.isArray(tx.possessionProofs)) {
    throw new Error("Validator update requires possessionProofs (one possession proof per incoming validator) under validatorAdmission");
  }
  let next = 0;
  for (const proof of tx.possessionProofs) {
    let index = next;
    while (index < tx.validators.length && tx.validators[index]!.address !== proof.address) index += 1;
    const validator = tx.validators[index];
    if (!validator) throw new Error("Validator possession proof does not match the incoming validator order");
    const valid = verifyPossessionProof({
      chainId: context.chainId,
      chainBinding: context.genesisHash,
      activationHeight: tx.activationHeight,
      address: validator.address,
      publicKey: validator.publicKey
    }, proof.signature);
    if (!valid) throw new Error(`Invalid validator possession proof for ${validator.address}`);
    next = index + 1;
  }
}
