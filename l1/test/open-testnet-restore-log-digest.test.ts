// R21-1046-L1 (OpenClaw Round 21): below a recovery checkpoint, ChainStore.open
// only line-scans the finalized block log, so a same-length corruption of a
// historical record is accepted when a validator opens a copied log with its
// checkpoint. Since #1046 every restored open-testnet validator starts that
// way, and the gateway seals blocks served by a validator into the published
// state snapshot. A corrupted history would then be published, fail the next
// cold-start replay and reset the testnet to a fresh genesis.
//
// B: a restore must verify every validator's copied files byte-for-byte
//    against the log it has just replayed and validated.
// C: the snapshot builder must not seal history it cannot verify: header hash,
//    previous-hash linkage from genesis to the live tip, transaction root, and
//    every block served identically by two validators.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
const SECRET = "restore-log-digest-test-secret-0123456789abcdef";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function sourceBundle(root: string, chainId: string): Promise<Json> {
  const source = join(root, "source");
  await api.initNetwork(source, chainId);
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const keys: Record<string, string> = {};
  for (const file of await readdir(join(source, "keys"))) keys[file.replace(/\.json$/, "")] = (await json(join(source, "keys", file))).privateKey;
  const blocks = (await readFile(join(source, "data-v1", "blocks.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { format: "ZYRON-OPEN-TESTNET-STATE-V1", genesis: await json(join(source, "genesis.json")), network: await json(join(source, "network.json")), keys, blocks };
}

// The Round 21 fixture: flip the first character of block 50's hash in place,
// so the log keeps its exact byte length.
function corruptBlockHashSync(blocksPath: string, height = 50): { original: string; corrupted: string } {
  const text = readFileSync(blocksPath, "utf8");
  const lines = text.trimEnd().split("\n");
  const block = JSON.parse(lines[height - 1]!);
  const original: string = block.hash;
  const corrupted = (original[0] === "0" ? "1" : "0") + original.slice(1);
  lines[height - 1] = lines[height - 1]!.replace(original, corrupted);
  const changed = `${lines.join("\n")}\n`;
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(text));
  writeFileSync(blocksPath, changed);
  return { original, corrupted };
}

test("restore rejects a validator log that no longer matches the replayed log (same-length corruption below the checkpoint)", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-restore-digest-"));
  try {
    const bundle = await sourceBundle(root, "zyron-restore-digest-testnet-1");
    const target = join(root, "restored");
    let calls = 0;
    // restoreNetwork calls onProgress synchronously. The first tick after the
    // replay comes right after the recovery checkpoint is written and before
    // any validator copy is made: corrupt the replayed log in place there.
    const onProgress = () => {
      calls += 1;
      if (calls === bundle.blocks.length + 1) corruptBlockHashSync(join(target, "data-v1", "blocks.ndjson"));
    };
    await assert.rejects(
      api.restoreNetwork(target, bundle, bundle.genesis.chainId, { onProgress }),
      /restored v2 blocks\.ndjson does not match the replayed log/,
      "a validator log corrupted after the validated replay must not be accepted"
    );
    assert.ok(calls > bundle.blocks.length, "the corruption hook ran");
    // Nothing was marked complete, so the next start moves it aside and restores again.
    assert.ok(!(await api.readNetworkMarker(target)), "an unverified restore must not be marked complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore re-checks the replayed log itself after the validator copies", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-restore-digest-v1-"));
  try {
    const bundle = await sourceBundle(root, "zyron-restore-digest-v1-testnet-1");
    const target = join(root, "restored");
    let calls = 0;
    // The tick after the last validator copy (v4) is opened: only data-v1 changes.
    const onProgress = () => {
      calls += 1;
      if (calls === bundle.blocks.length + 4) corruptBlockHashSync(join(target, "data-v1", "blocks.ndjson"));
    };
    await assert.rejects(
      api.restoreNetwork(target, bundle, bundle.genesis.chainId, { onProgress }),
      /restored v1 blocks\.ndjson does not match the replayed log/
    );
    assert.ok(!(await api.readNetworkMarker(target)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an untouched restore still succeeds and every validator copy matches the replayed log", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-restore-digest-ok-"));
  try {
    const bundle = await sourceBundle(root, "zyron-restore-digest-ok-testnet-1");
    const target = join(root, "restored");
    const restored = await api.restoreNetwork(target, bundle, bundle.genesis.chainId);
    assert.equal(restored.height, bundle.blocks.length);
    const reference = await readFile(join(target, "data-v1", "blocks.ndjson"));
    for (const name of ["v2", "v3", "v4"]) assert.ok((await readFile(join(target, `data-${name}`, "blocks.ndjson"))).equals(reference), name);
    assert.ok(await api.readNetworkMarker(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function readerOf(name: string, blocks: Json[]): { name: string; read: (from: number, limit: number) => Promise<Json[]> } {
  return { name, read: async (from: number, limit: number) => structuredClone(blocks.slice(from - 1, from - 1 + limit)) };
}

test("snapshot block collection verifies hashes, linkage, transaction roots and agreement between validators", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-snapshot-verify-"));
  try {
    const bundle = await sourceBundle(root, "zyron-snapshot-verify-testnet-1");
    const blocks: Json[] = bundle.blocks;
    const tip = blocks.length;
    const expected = { tip, tipHash: blocks[tip - 1].hash, chainId: bundle.genesis.chainId, genesisHash: bundle.network.genesisHash };
    assert.equal(typeof api.collectSnapshotBlocks, "function", "collectSnapshotBlocks is not exported");
    assert.equal(typeof api.verifySnapshotBlocks, "function", "verifySnapshotBlocks is not exported");

    const honest = (name: string) => readerOf(name, blocks);
    const rejected: string[] = [];
    const onReject = (name: string) => { rejected.push(name); };

    // All honest: the first two agreeing validators are enough.
    const all = await api.collectSnapshotBlocks([honest("v1"), honest("v2"), honest("v3"), honest("v4")], { ...expected, onReject });
    assert.deepEqual(all, blocks);

    // Round 21 fixture: block 50 hash flipped (header no longer hashes to it,
    // block 51 no longer links to it).
    const flipped = structuredClone(blocks);
    flipped[49].hash = (flipped[49].hash[0] === "0" ? "1" : "0") + flipped[49].hash.slice(1);
    assert.throws(() => api.verifySnapshotBlocks(flipped, expected));
    rejected.length = 0;
    assert.deepEqual(await api.collectSnapshotBlocks([readerOf("v1", flipped), honest("v2"), honest("v3")], { ...expected, onReject }), blocks);
    assert.deepEqual(rejected, ["v1"]);

    // A consistent rewrite of one header (hash recomputed) breaks the linkage.
    const relinked = structuredClone(blocks);
    relinked[49].header.timestampMs += 1;
    assert.throws(() => api.verifySnapshotBlocks(relinked, expected));

    // A transaction body that no longer matches its header's transaction root.
    const body = structuredClone(blocks);
    assert.ok(body[0].transactions.length > 0, "block 1 carries the v6 upgrade transaction");
    body[0].transactions[0].nonce += 1;
    assert.throws(() => api.verifySnapshotBlocks(body, expected));

    // A wrong live tip hash, a wrong chain ID, a missing block.
    assert.throws(() => api.verifySnapshotBlocks(blocks, { ...expected, tipHash: blocks[tip - 2].hash }));
    assert.throws(() => api.verifySnapshotBlocks(blocks, { ...expected, chainId: "zyron-other-testnet-1" }));
    assert.throws(() => api.verifySnapshotBlocks(blocks.slice(0, -1), expected));
    assert.doesNotThrow(() => api.verifySnapshotBlocks(blocks, expected));

    // Corruption outside the hashed fields (an attestation signature) passes
    // the hash checks, so a second validator must serve identical history.
    const signature = structuredClone(blocks);
    const attestation = signature[49].attestations[0];
    attestation.signature = (attestation.signature[0] === "0" ? "1" : "0") + attestation.signature.slice(1);
    assert.doesNotThrow(() => api.verifySnapshotBlocks(signature, expected));
    assert.deepEqual(await api.collectSnapshotBlocks([readerOf("v1", signature), honest("v2"), honest("v3")], { ...expected, onReject }), blocks);

    // Validators can hold different (valid) finality certificates for the same
    // block. Without a whole-history pair, each height takes the block two
    // validators serve identically.
    const variant = (height: number) => {
      const copy = structuredClone(blocks);
      const vote = copy[height - 1].attestations[0];
      vote.signature = (vote.signature[0] === "0" ? "1" : "0") + vote.signature.slice(1);
      return copy;
    };
    rejected.length = 0;
    assert.deepEqual(await api.collectSnapshotBlocks([readerOf("v1", variant(60)), readerOf("v2", variant(70)), readerOf("v3", variant(80))], { ...expected, onReject }), blocks);
    assert.deepEqual(rejected, []);

    // No two validators agree at some height: nothing is sealed.
    await assert.rejects(api.collectSnapshotBlocks([readerOf("v1", signature), honest("v2"), readerOf("v3", flipped)], { ...expected, onReject }));
    await assert.rejects(api.collectSnapshotBlocks([honest("v1")], { ...expected, onReject }));
    // A reader that fails or serves nothing is skipped, not trusted.
    const failing = { name: "v1", read: async () => { throw new Error("connection refused"); } };
    const empty = { name: "v2", read: async () => [] };
    assert.deepEqual(await api.collectSnapshotBlocks([failing, empty, honest("v3"), honest("v4")], { ...expected, onReject }), blocks);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the gateway does not seal history corrupted on one validator's disk into the state snapshot", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-snapshot-seal-"));
  let network: Json;
  try {
    const bundle = await sourceBundle(root, "zyron-snapshot-seal-testnet-1");
    const target = join(root, "restored");
    await api.restoreNetwork(target, bundle, bundle.genesis.chainId);
    // Same-length corruption of block 50 in the first validator's log after
    // the restore; its checkpoint fast path accepts it on open.
    const { original, corrupted } = corruptBlockHashSync(join(target, "data-v1", "blocks.ndjson"));
    const basePort = 21_000 + Math.floor(Math.random() * 2_000) * 4;
    network = await api.runNetwork(target, { gatewayPort: 0, basePort, log: false, stateSecret: SECRET, persistence: { mode: "snapshot-restore" } });
    assert.ok(await network.waitForQuorum(120_000), "validators did not reach a quorum");
    const base = `http://127.0.0.1:${network.port}`;
    let sealed: Buffer | undefined;
    const deadline = Date.now() + 120_000;
    while (!sealed && Date.now() < deadline) {
      const response = await fetch(`${base}/state/snapshot`).catch(() => undefined);
      if (response?.status === 200) sealed = Buffer.from(await response.arrayBuffer());
      else await new Promise((done) => setTimeout(done, 1_000));
    }
    assert.ok(sealed, "no state snapshot was served");
    const snapshot = api.openSnapshot(sealed, SECRET);
    assert.notEqual(snapshot.blocks[49].hash, corrupted, "corrupted history from one validator was sealed into the snapshot");
    assert.equal(snapshot.blocks[49].hash, original);
    assert.doesNotThrow(() => api.verifySnapshotBlocks(snapshot.blocks, { tip: snapshot.blocks.length, tipHash: snapshot.blocks.at(-1).hash, chainId: bundle.genesis.chainId, genesisHash: bundle.network.genesisHash }));
  } finally {
    await network?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
