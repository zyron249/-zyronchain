import { genesisConfigCommitment } from "./block.js";
import { assertHex } from "./codec.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonicalDomain, verifyCanonicalDomain } from "./crypto.js";
import { isStrictNetworkClass, readNetworkClass } from "./network-class.js";
import type { GenesisConfig, ValidatorPossessionProof } from "./types.js";

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
