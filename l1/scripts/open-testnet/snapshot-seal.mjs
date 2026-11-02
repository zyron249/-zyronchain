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
// The `iv` option exists for tests only (byte-identical seal checks); production
// callers must omit it so every seal gets a fresh random 96-bit IV.
export function sealSnapshot(bundle, secret, { iv = randomBytes(12) } = {}) {
  const cipher = createCipheriv("aes-256-gcm", snapshotKey(secret), iv);
  cipher.setAAD(Buffer.from(SNAPSHOT_MAGIC));
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(bundle)))), cipher.final()]);
  return Buffer.concat([Buffer.from(`${SNAPSHOT_MAGIC}\n`), iv, cipher.getAuthTag(), body]);
}

// Streaming seal (Security L-C on #1161): the bundle JSON is produced one
// block at a time and fed straight through gzip and AES-256-GCM, so the full
// JSON string and the uncompressed buffer never exist in memory. The
// plaintext is identical to JSON.stringify(bundle) (same key order) and the
// output layout is the same as sealSnapshot.
//
// blockLines: an (async) iterable of JSON.stringify(block) strings.
// onChunk(buffer): receives the ciphertext in order (may return a promise).
// Returns { iv, tag } for the header (magic line, iv, tag, ciphertext).
export async function sealJsonStream({ format, createdAtMs, genesis, network, keys }, blockLines, secret, { batchBytes = 256 * 1024, iv = randomBytes(12), onChunk }) {
  const cipher = createCipheriv("aes-256-gcm", snapshotKey(secret), iv);
  cipher.setAAD(Buffer.from(SNAPSHOT_MAGIC));
  const gzip = createGzip();
  let sinkError; let sinkChain = Promise.resolve();
  gzip.on("data", (chunk) => {
    const encrypted = cipher.update(chunk);
    sinkChain = sinkChain.then(() => onChunk(encrypted)).catch((error) => { sinkError ??= error; });
  });
  // Info-1 (Security on #1162): every wait races against gzip finishing or
  // failing, so an error can never leave a drain wait pending forever.
  let failed;
  const finished = new Promise((done, fail) => {
    gzip.once("end", done);
    gzip.once("error", (error) => { failed = error; fail(error); });
  });
  finished.catch(() => {});
  const waitDrain = () => Promise.race([new Promise((done) => gzip.once("drain", done)), finished.then(() => { throw new Error("gzip ended before drain"); })]);
  let pending = []; let pendingBytes = 0;
  async function write(text) {
    pending.push(text); pendingBytes += text.length;
    if (pendingBytes < batchBytes) return;
    const chunk = pending.join(""); pending = []; pendingBytes = 0;
    if (failed) throw failed;
    if (!gzip.write(chunk)) await waitDrain();
    if (sinkError) throw sinkError;
  }
  try {
    const head = JSON.stringify({ format, createdAtMs, genesis, network, keys });
    await write(`${head.slice(0, -1)}${head.length > 2 ? "," : ""}"blocks":[`);
    let first = true;
    for await (const line of blockLines) { await write(`${first ? "" : ","}${line}`); first = false; }
    pending.push("]}");
    gzip.end(pending.join(""));
    await finished;
  } catch (error) {
    gzip.destroy();
    throw error;
  }
  await sinkChain;
  if (sinkError) throw sinkError;
  const tail = cipher.final();
  if (tail.length) await onChunk(tail);
  return { iv, tag: cipher.getAuthTag() };
}
export function snapshotHeader(iv, tag) { return Buffer.concat([Buffer.from(`${SNAPSHOT_MAGIC}\n`), iv, tag]); }
export async function sealSnapshotStream({ format, createdAtMs, genesis, network, keys, blocks }, secret, { batchBytes = 256 * 1024, iv = randomBytes(12) } = {}) {
  const encrypted = [];
  const lines = (function* () { for (const block of blocks) yield JSON.stringify(block) ?? "null"; })();
  const { tag } = await sealJsonStream({ format, createdAtMs, genesis, network, keys }, lines, secret, { batchBytes, iv, onChunk: (chunk) => { encrypted.push(chunk); } });
  return Buffer.concat([snapshotHeader(iv, tag), ...encrypted]);
}
