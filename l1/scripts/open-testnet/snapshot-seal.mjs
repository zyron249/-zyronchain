// Sealing for open-testnet state snapshots (AES-256-GCM over gzipped JSON).
// Shared by the gateway (open-testnet.mjs) and the snapshot build worker
// (snapshot-worker.mjs) so both produce byte-format-identical bundles.
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

export const SNAPSHOT_MAGIC = "ZYRON-OPEN-TESTNET-STATE-V1";

export function snapshotKey(secret) {
  assert.ok(typeof secret === "string" && secret.length >= 32, "ZYRON_TESTNET_STATE_SECRET must be at least 32 characters");
  return createHash("sha256").update(`zyron-open-testnet-state\0${secret}`).digest();
}
export function sealSnapshot(bundle, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", snapshotKey(secret), iv);
  cipher.setAAD(Buffer.from(SNAPSHOT_MAGIC));
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(bundle)))), cipher.final()]);
  return Buffer.concat([Buffer.from(`${SNAPSHOT_MAGIC}\n`), iv, cipher.getAuthTag(), body]);
}
