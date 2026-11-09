// S2-7: HTTP bearer for GET /state/snapshot keeper traffic.
// Derived from ZYRON_TESTNET_STATE_SECRET so the raw secret is never sent on the wire.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SNAPSHOT_KEEPER_BEARER_LABEL = "zyron-open-testnet-snapshot-keeper-v1";

/** HMAC-SHA256(secret, label) as lowercase hex. Never log or return the raw secret. */
export function deriveSnapshotKeeperBearer(stateSecret) {
  if (typeof stateSecret !== "string" || stateSecret.length === 0) return undefined;
  return createHmac("sha256", stateSecret).update(SNAPSHOT_KEEPER_BEARER_LABEL, "utf8").digest("hex");
}

/**
 * Constant-time equality that does not short-circuit on length: both sides are
 * SHA-256 hashed to fixed 32-byte digests, then timingSafeEqual'd.
 */
export function timingSafeTokenEqual(provided, expected) {
  const a = createHash("sha256").update(Buffer.from(String(provided ?? ""), "utf8")).digest();
  const b = createHash("sha256").update(Buffer.from(String(expected ?? ""), "utf8")).digest();
  try {
    return timingSafeEqual(a, b);
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

/** True when Authorization is Bearer <token> and token matches expected (constant-time). */
export function timingSafeBearerToken(header, expectedToken) {
  if (typeof header !== "string" || typeof expectedToken !== "string" || expectedToken.length === 0) return false;
  if (!header.startsWith("Bearer ")) return false;
  return timingSafeTokenEqual(header.slice("Bearer ".length), expectedToken);
}
