import { MAX_ACTIVITY_ORACLE_APPROVALS, verifyActivityOracleApprovalSignature } from "./transaction.js";
import type { ActivitySettlementTx, GenesisConfig } from "./types.js";

/**
 * Activity-oracle authorization context: the registered oracle keys and the
 * optional m-of-n threshold, both from genesis. See
 * docs/ACTIVITY_ORACLE_GOVERNANCE.md.
 */
export type ActivityOracleSet = Pick<GenesisConfig, "activityOracles" | "activityOracleThreshold">;

export const UNAUTHORIZED_ACTIVITY_ORACLE_MESSAGE = "Unauthorized activity oracle";
export const ACTIVITY_APPROVALS_WITHOUT_THRESHOLD_MESSAGE =
  "Activity oracle approvals require a genesis activityOracleThreshold";
export const INVALID_ACTIVITY_APPROVAL_MESSAGE = "Invalid activity oracle approval signature";

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
 * Consensus authorization of an activity settlement (every path: mempool,
 * selection, block validation and both state appliers).
 *
 * - The submitting key must be a registered oracle (unchanged rule).
 * - Legacy genesis (no threshold): `oracleApprovals` must be absent; the
 *   submitter alone authorizes, exactly as before.
 * - Threshold genesis (m): at least m DISTINCT registered keys must have signed
 *   the canonical settlement payload. The submitter counts once (its
 *   transaction signature covers every payload field). Each `oracleApprovals`
 *   entry from a registered key must verify under the approval domain or the
 *   settlement is rejected (repeats included); entries from unregistered keys
 *   are ignored; a key is counted at most once.
 *
 * The per-epoch cap, settlement window and ordering are enforced separately
 * and are unchanged.
 */
export function assertActivitySettlementAuthorized(tx: ActivitySettlementTx, oracles: ActivityOracleSet): void {
  const registered = new Set(oracles.activityOracles);
  if (!registered.has(tx.publicKey)) throw new Error(UNAUTHORIZED_ACTIVITY_ORACLE_MESSAGE);
  const hasApprovals = Object.prototype.hasOwnProperty.call(tx, "oracleApprovals");
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
    if (!registered.has(approval.publicKey)) continue;
    // Every entry from a registered key must verify, including repeats, so a
    // settlement never carries a registered key's signature over other data.
    if (!verifyActivityOracleApprovalSignature(tx, approval)) throw new Error(INVALID_ACTIVITY_APPROVAL_MESSAGE);
    approvers.add(approval.publicKey);
  }
  if (approvers.size < threshold) {
    throw new Error(`Activity settlement requires approvals from ${threshold} distinct registered activity oracles`);
  }
}
