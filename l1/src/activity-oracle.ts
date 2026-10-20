import { ACTIVITY_EPOCH_MS, MAX_ACTIVITY_SETTLEMENT_ATOMS, PUBLIC_LAUNCH_ACTIVITY_CAP_ATOMS } from "./activity.js";
import { assertValidPublicKey } from "./crypto.js";
import { MAX_ACTIVITY_ORACLE_APPROVALS, verifyActivityOracleApprovalSignature } from "./transaction.js";
import type { ActivityOracleGovernanceAction, ActivitySettlementTx, GenesisConfig } from "./types.js";

/**
 * Activity-oracle authorization context: the registered oracle keys, the
 * optional legacy threshold, and the versioned policy. See
 * docs/ACTIVITY_ORACLE_GOVERNANCE.md.
 */
export type ActivityOracleSet = Pick<GenesisConfig,
  "activityOracles" | "activityOracleThreshold" | "activityOraclePolicy" | "activitySettlementCapAtoms" | "launchProfile"
> & {
  /** Genesis time, used to place threshold-v1 attestation expiry in the epoch window. */
  readonly timestampMs?: number;
  /** True when a validator-quorum pause is active at this height. */
  readonly paused?: boolean;
  /** Oracle keys removed by a validator-quorum revoke. */
  readonly revokedPublicKeys?: readonly string[];
};

export const ACTIVITY_ORACLE_POLICY_TEST_SINGLE = "test-single-v1";
export const ACTIVITY_ORACLE_POLICY_THRESHOLD = "threshold-v1";

export const UNAUTHORIZED_ACTIVITY_ORACLE_MESSAGE = "Unauthorized activity oracle";
export const ACTIVITY_APPROVALS_WITHOUT_THRESHOLD_MESSAGE =
  "Activity oracle approvals require a genesis activityOracleThreshold";
export const INVALID_ACTIVITY_APPROVAL_MESSAGE = "Invalid activity oracle approval signature";
export const DUPLICATE_ACTIVITY_ORACLE_SIGNER_MESSAGE = "Duplicate activity oracle signer";
export const UNKNOWN_ACTIVITY_ORACLE_MESSAGE = "Unknown activity oracle";
export const REVOKED_ACTIVITY_ORACLE_MESSAGE = "Revoked activity oracle";
export const ACTIVITY_ORACLE_APPROVAL_REPLAY_MESSAGE = "Activity oracle approval replay";
export const STALE_ACTIVITY_ORACLE_ATTESTATION_MESSAGE = "Stale activity oracle attestation";
export const EXPIRED_ACTIVITY_ORACLE_ATTESTATION_MESSAGE = "Expired activity oracle attestation";
export const WRONG_ACTIVITY_ORACLE_CHAIN_MESSAGE = "Wrong activity oracle chain ID";
export const ACTIVITY_ORACLE_PAUSED_MESSAGE = "Activity oracle settlements are paused";
export const ACTIVITY_ATTESTATION_EXPIRY_REQUIRED_MESSAGE = "Activity oracle attestation expiry is required";
export const ACTIVITY_ATTESTATION_EXPIRY_WITHOUT_POLICY_MESSAGE =
  "Activity oracle attestation expiry requires activity oracle policy threshold-v1";
export const ACTIVITY_ORACLE_POLICY_REQUIRED_MESSAGE =
  "Launch profile fixed-supply-v1 requires activity oracle policy threshold-v1";
export const ACTIVITY_ORACLE_THRESHOLD_TOO_WEAK_MESSAGE =
  "Activity oracle policy threshold-v1 requires 2-of-3 or stricter (at least two-thirds of at least three keys, with one spare)";

export interface ActivityOracleAuthContext {
  readonly chainId?: string;
  readonly blockTimestampMs?: number;
  readonly genesisTimestampMs?: number;
}

/** True when m-of-n is at least 2-of-3 and one registered key can be offline. */
export function isTwoOfThreeOrStricter(threshold: number, oracleCount: number): boolean {
  return Number.isSafeInteger(threshold) && Number.isSafeInteger(oracleCount) &&
    oracleCount >= 3 && threshold >= 2 && threshold <= oracleCount &&
    oracleCount - threshold >= 1 && threshold * 3 >= oracleCount * 2;
}

/** Validates the optional genesis threshold: an integer in 1..min(n, MAX_ACTIVITY_ORACLE_APPROVALS). */
export function validateActivityOracleThreshold(genesis: ActivityOracleSet): void {
  if (!Object.prototype.hasOwnProperty.call(genesis, "activityOracleThreshold")) return;
  const threshold = genesis.activityOracleThreshold;
  if (!Number.isSafeInteger(threshold) || (threshold as number) < 1 ||
      (threshold as number) > genesis.activityOracles.length ||
      (threshold as number) > MAX_ACTIVITY_ORACLE_APPROVALS) {
    throw new Error("Invalid activity oracle threshold");
  }
}

/**
 * Versioned policy rules. `fixed-supply-v1` cannot omit the policy and cannot
 * use the explicit single-key test profile. Legacy genesis files (no policy
 * field) are unchanged.
 */
export function validateActivityOraclePolicy(genesis: ActivityOracleSet): void {
  const hasPolicy = Object.prototype.hasOwnProperty.call(genesis, "activityOraclePolicy");
  const hasCap = Object.prototype.hasOwnProperty.call(genesis, "activitySettlementCapAtoms");
  const hasThreshold = Object.prototype.hasOwnProperty.call(genesis, "activityOracleThreshold");
  if (hasCap && !hasPolicy) throw new Error("activitySettlementCapAtoms requires an activity oracle policy");
  if (genesis.launchProfile === "fixed-supply-v1" && genesis.activityOraclePolicy !== ACTIVITY_ORACLE_POLICY_THRESHOLD) {
    throw new Error(ACTIVITY_ORACLE_POLICY_REQUIRED_MESSAGE);
  }
  if (!hasPolicy) return;
  const policy = genesis.activityOraclePolicy;
  if (policy !== ACTIVITY_ORACLE_POLICY_TEST_SINGLE && policy !== ACTIVITY_ORACLE_POLICY_THRESHOLD) {
    throw new Error("Unsupported activity oracle policy");
  }
  if (hasCap) {
    const cap = genesis.activitySettlementCapAtoms;
    const max = policy === ACTIVITY_ORACLE_POLICY_THRESHOLD
      ? PUBLIC_LAUNCH_ACTIVITY_CAP_ATOMS
      : MAX_ACTIVITY_SETTLEMENT_ATOMS;
    if (!Number.isSafeInteger(cap) || (cap as number) < 1 || (cap as number) > max) {
      throw new Error("Invalid activity settlement cap");
    }
  }
  if (policy === ACTIVITY_ORACLE_POLICY_TEST_SINGLE) {
    if (hasThreshold) throw new Error("Activity oracle policy test-single-v1 cannot declare activityOracleThreshold");
    if (genesis.launchProfile === "fixed-supply-v1") throw new Error(ACTIVITY_ORACLE_POLICY_REQUIRED_MESSAGE);
    return;
  }
  if (!hasThreshold || !isTwoOfThreeOrStricter(genesis.activityOracleThreshold as number, genesis.activityOracles.length)) {
    throw new Error(ACTIVITY_ORACLE_THRESHOLD_TOO_WEAK_MESSAGE);
  }
  for (const oracle of genesis.activityOracles) assertValidPublicKey(oracle, "Genesis activity oracle public key");
}

export function activityOracleGovernancePublicKeysValid(
  action: ActivityOracleGovernanceAction,
  publicKeys: readonly string[],
  registered: ReadonlySet<string>,
  alreadyRevoked: ReadonlySet<string>
): void {
  if (action === "pause" || action === "resume") {
    if (publicKeys.length !== 0) throw new Error("Activity oracle pause and resume name no keys");
    return;
  }
  if (publicKeys.length === 0 || publicKeys.length > MAX_ACTIVITY_ORACLE_APPROVALS) {
    throw new Error("Invalid activity oracle revoke set");
  }
  const seen = new Set<string>();
  for (const publicKey of publicKeys) {
    if (seen.has(publicKey)) throw new Error("Duplicate revoked activity oracle");
    seen.add(publicKey);
    if (!registered.has(publicKey)) throw new Error(UNKNOWN_ACTIVITY_ORACLE_MESSAGE);
    if (alreadyRevoked.has(publicKey)) throw new Error(REVOKED_ACTIVITY_ORACLE_MESSAGE);
    assertValidPublicKey(publicKey, "Revoked activity oracle public key");
  }
}

/**
 * Consensus authorization of an activity settlement (every path: mempool,
 * selection, block validation and both state appliers).
 *
 * - The submitting key must be a registered, non-revoked oracle.
 * - A pause rejects every settlement.
 * - Legacy genesis (no threshold): `oracleApprovals` must be absent; the
 *   submitter alone authorizes, exactly as before. Unknown extra approvals
 *   are not accepted.
 * - Legacy threshold genesis (m, no `threshold-v1` policy): at least m distinct
 *   registered keys. Unregistered approval entries are ignored. A key counts
 *   once. This encoding is unchanged.
 * - `threshold-v1`: fail closed. Duplicate signers, unknown keys, revoked keys,
 *   repeated signatures, a wrong chain id, a stale expiry and an expiry that
 *   the block time has passed are rejected. At least m distinct registered
 *   keys must have signed the v2 payload.
 */
export function assertActivitySettlementAuthorized(
  tx: ActivitySettlementTx,
  oracles: ActivityOracleSet,
  context: ActivityOracleAuthContext = {}
): void {
  const registered = new Set(oracles.activityOracles);
  const revoked = new Set(oracles.revokedPublicKeys ?? []);
  if (oracles.paused) throw new Error(ACTIVITY_ORACLE_PAUSED_MESSAGE);
  if (context.chainId !== undefined && tx.chainId !== context.chainId) {
    throw new Error(WRONG_ACTIVITY_ORACLE_CHAIN_MESSAGE);
  }
  if (revoked.has(tx.publicKey)) throw new Error(REVOKED_ACTIVITY_ORACLE_MESSAGE);
  if (!registered.has(tx.publicKey)) throw new Error(UNAUTHORIZED_ACTIVITY_ORACLE_MESSAGE);
  const hasApprovals = Object.prototype.hasOwnProperty.call(tx, "oracleApprovals");
  const hasExpiry = Object.prototype.hasOwnProperty.call(tx, "attestationExpiresAtMs");
  if (oracles.activityOraclePolicy !== ACTIVITY_ORACLE_POLICY_THRESHOLD) {
    if (hasExpiry) throw new Error(ACTIVITY_ATTESTATION_EXPIRY_WITHOUT_POLICY_MESSAGE);
    const threshold = oracles.activityOracleThreshold;
    if (threshold === undefined) {
      if (hasApprovals) throw new Error(ACTIVITY_APPROVALS_WITHOUT_THRESHOLD_MESSAGE);
      return;
    }
    const approvals = hasApprovals ? tx.oracleApprovals : [];
    if (!Array.isArray(approvals) || approvals.length > MAX_ACTIVITY_ORACLE_APPROVALS) {
      throw new Error("Invalid activity oracle approvals");
    }
    const approvers = new Set<string>([tx.publicKey]);
    for (const approval of approvals) {
      if (!registered.has(approval.publicKey) || revoked.has(approval.publicKey)) continue;
      if (!verifyActivityOracleApprovalSignature(tx, approval)) throw new Error(INVALID_ACTIVITY_APPROVAL_MESSAGE);
      approvers.add(approval.publicKey);
    }
    if (approvers.size < threshold) {
      throw new Error(`Activity settlement requires approvals from ${threshold} distinct registered activity oracles`);
    }
    return;
  }
  assertThresholdV1Authorized(tx, registered, revoked, context, oracles);
}

function assertThresholdV1Authorized(
  tx: ActivitySettlementTx,
  registered: ReadonlySet<string>,
  revoked: ReadonlySet<string>,
  context: ActivityOracleAuthContext,
  oracles: ActivityOracleSet
): void {
  const genesisTimestampMs = context.genesisTimestampMs ?? oracles.timestampMs;
  if (!Object.prototype.hasOwnProperty.call(tx, "attestationExpiresAtMs") ||
      !Number.isSafeInteger(tx.attestationExpiresAtMs)) {
    throw new Error(ACTIVITY_ATTESTATION_EXPIRY_REQUIRED_MESSAGE);
  }
  if (genesisTimestampMs === undefined || !Number.isSafeInteger(genesisTimestampMs)) {
    throw new Error(ACTIVITY_ATTESTATION_EXPIRY_REQUIRED_MESSAGE);
  }
  const expiresAtMs = tx.attestationExpiresAtMs as number;
  const windowOpen = genesisTimestampMs + (tx.epoch + 1) * ACTIVITY_EPOCH_MS;
  const windowClose = windowOpen + ACTIVITY_EPOCH_MS;
  if (!Number.isSafeInteger(windowOpen) || !Number.isSafeInteger(windowClose) ||
      expiresAtMs < windowOpen || expiresAtMs >= windowClose) {
    throw new Error(STALE_ACTIVITY_ORACLE_ATTESTATION_MESSAGE);
  }
  if (context.blockTimestampMs !== undefined && context.blockTimestampMs > expiresAtMs) {
    throw new Error(EXPIRED_ACTIVITY_ORACLE_ATTESTATION_MESSAGE);
  }
  const hasApprovals = Object.prototype.hasOwnProperty.call(tx, "oracleApprovals");
  const approvals = hasApprovals ? tx.oracleApprovals : [];
  if (!Array.isArray(approvals) || approvals.length > MAX_ACTIVITY_ORACLE_APPROVALS) {
    throw new Error("Invalid activity oracle approvals");
  }
  const approvers = new Set<string>();
  const signatures = new Set<string>();
  for (const approval of approvals) {
    if (approvers.has(approval.publicKey) || approval.publicKey === tx.publicKey) {
      throw new Error(DUPLICATE_ACTIVITY_ORACLE_SIGNER_MESSAGE);
    }
    if (signatures.has(approval.signature)) throw new Error(ACTIVITY_ORACLE_APPROVAL_REPLAY_MESSAGE);
    if (revoked.has(approval.publicKey)) throw new Error(REVOKED_ACTIVITY_ORACLE_MESSAGE);
    if (!registered.has(approval.publicKey)) throw new Error(UNKNOWN_ACTIVITY_ORACLE_MESSAGE);
    if (!verifyActivityOracleApprovalSignature(tx, approval, "v2")) throw new Error(INVALID_ACTIVITY_APPROVAL_MESSAGE);
    approvers.add(approval.publicKey);
    signatures.add(approval.signature);
  }
  approvers.add(tx.publicKey);
  const threshold = oracles.activityOracleThreshold as number;
  if (approvers.size < threshold) {
    throw new Error(`Activity settlement requires approvals from ${threshold} distinct registered activity oracles`);
  }
}
