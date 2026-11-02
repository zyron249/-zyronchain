// Sealing for open-testnet state snapshots (AES-256-GCM over gzipped JSON).
// Shared by the gateway (open-testnet.mjs) and the snapshot build worker
// (snapshot-worker.mjs) so both produce byte-format-identical bundles.
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createGzip, gzipSync } from "node:zlib";

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

// Streaming variant used by the snapshot worker (Security L-C on #1161): the
// bundle JSON is produced one block at a time and fed straight through gzip
// and AES-256-GCM, so the full JSON string and the uncompressed buffer never
// exist in memory. Output bytes have the same layout as sealSnapshot and the
// plaintext JSON is identical to JSON.stringify(bundle) (same key order).
export async function sealSnapshotStream({ format, createdAtMs, genesis, network, keys, blocks }, secret, { batchBytes = 256 * 1024 } = {}) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", snapshotKey(secret), iv);
  cipher.setAAD(Buffer.from(SNAPSHOT_MAGIC));
  const encrypted = [];
  const gzip = createGzip();
  gzip.on("data", (chunk) => { encrypted.push(cipher.update(chunk)); });
  const finished = new Promise((done, fail) => { gzip.once("end", done); gzip.once("error", fail); });
  let pending = [];
  let pendingBytes = 0;
  async function write(text) {
    pending.push(text); pendingBytes += text.length;
    if (pendingBytes < batchBytes) return;
    const chunk = pending.join(""); pending = []; pendingBytes = 0;
    if (!gzip.write(chunk)) await new Promise((done) => gzip.once("drain", done));
  }
  const head = JSON.stringify({ format, createdAtMs, genesis, network, keys });
  await write(`${head.slice(0, -1)}${head.length > 2 ? "," : ""}"blocks":[`);
  for (let index = 0; index < blocks.length; index += 1) {
    await write(`${index ? "," : ""}${JSON.stringify(blocks[index]) ?? "null"}`);
  }
  pending.push("]}");
  gzip.end(pending.join(""));
  await finished;
  encrypted.push(cipher.final());
  return Buffer.concat([Buffer.from(`${SNAPSHOT_MAGIC}\n`), iv, cipher.getAuthTag(), ...encrypted]);
}
