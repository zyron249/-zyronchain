// Disk design for open-testnet snapshots: verified history in an NDJSON file
// (RAM keeps only the tip and a running hash), snapshot builds streamed from
// it in a memory-capped child process.
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { createGunzip } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const mod = (path: string) => import(pathToFileURL(join(l1Root, path)).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await mod("scripts/open-testnet.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hf: any = await mod("scripts/open-testnet/history-file.mjs");
const { blockHash } = await mod("dist/src/block.js");
const { merkleRoot } = await mod("dist/src/merkle.js");
const H = (n: number) => n.toString(16).padStart(64, "0");
const SECRET = "s".repeat(32);
const CHAIN = "zyron-history-test-1";
const GENESIS = H(0xabc);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function syntheticChain(count: number, padBytes = 0): any[] {
  const blocks = [];
  let previous = GENESIS;
  const pad = "p".repeat(padBytes);
  for (let height = 1; height <= count; height += 1) {
    const header = { height, chainId: CHAIN, previousHash: previous, transactionRoot: merkleRoot([]), timestamp: height };
    const hash = blockHash(header);
    blocks.push(padBytes ? { header, hash, transactions: [], certificate: { pad } } : { header, hash, transactions: [] });
    previous = hash;
  }
  return blocks;
}
async function tempDir() { return mkdtemp(join(tmpdir(), "zyron-history-")); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeHistory(dir: string, blocks: any[]) {
  const file = await hf.createHistoryFile(join(dir, "h", "history.ndjson"), { chainId: CHAIN, genesisHash: GENESIS });
  await file.appendMany(blocks);
  return file;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAll(view: any) { const lines = []; for await (const line of hf.readHistoryLines(view)) lines.push(line); return lines; }
// Same key order as the gateway's bundle: format, createdAtMs, genesis, network, keys, blocks.
const head = { createdAtMs: 7, genesis: { chainId: CHAIN }, network: { genesisHash: GENESIS }, keys: { v1: H(0x11) } };

test("seal stays byte-identical: the child build equals sealSnapshot and sealSnapshotStream for the same IV", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  try {
    const blocks = syntheticChain(120);
    const file = await writeHistory(dir, blocks);
    const iv = Buffer.alloc(12, 7);
    const bundle = { format: "ZYRON-OPEN-TESTNET-STATE-V1", ...head, blocks };
    const reference = api.sealSnapshot(bundle, SECRET, { iv });
    const { sealSnapshotStream } = await mod("scripts/open-testnet/snapshot-seal.mjs");
    assert.ok((await sealSnapshotStream(bundle, SECRET, { iv, batchBytes: 100 })).equals(reference));
    const builder = api.createSnapshotChildBuilder({ secret: SECRET, outDir: join(dir, "out") });
    const built = await builder.build({ view: file.view(), ...head, iv });
    assert.equal(built.height, 120);
    assert.ok(built.sealed.equals(reference), "child output is byte-identical to sealSnapshot");
    assert.deepEqual(api.openSnapshot(built.sealed, SECRET), bundle);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("boot rebuild: createHistoryFile truncates whatever an earlier process left and re-appends the restored blocks", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "h", "history.ndjson");
    await writeHistory(dir, syntheticChain(3));
    await writeFile(path, "garbage from an earlier process\n");
    const blocks = syntheticChain(50);
    const file = await hf.createHistoryFile(path, { chainId: CHAIN, genesisHash: GENESIS });
    assert.equal(file.height(), 0);
    for (let index = 0; index < blocks.length; index += 20) await file.appendMany(blocks.slice(index, index + 20));
    assert.equal(file.height(), 50); assert.equal(file.tipHash(), blocks[49].hash);
    const lines = await readAll(file.view());
    assert.deepEqual(lines.map((line: string) => JSON.parse(line)), blocks);
    // Appends are linkage-checked: a block that does not link is refused and the tip does not move.
    await assert.rejects(file.append(syntheticChain(52)[51]));
    assert.equal(file.height(), 50);
    // A view taken earlier still validates (reads stop at its tip).
    const early = file.view(); await file.append(syntheticChain(51)[50]);
    assert.equal((await readAll(early)).length, 50);
    await file.reset(); assert.equal(file.height(), 0); assert.equal((await stat(path)).size, 0);
    await file.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("corrupt files are never trusted: truncation, bit flips, reordering, non-canonical lines and junk all fail as history_file_corrupt", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  try {
    const blocks = syntheticChain(10);
    const file = await writeHistory(dir, blocks);
    const view = file.view();
    const good = await readFile(view.path, "utf8");
    const lines = good.trimEnd().split("\n");
    const cases: Record<string, string> = {
      truncated: good.slice(0, good.length - 40),
      "missing last newline": good.slice(0, -1),
      "fewer lines": `${lines.slice(0, 9).join("\n")}\n`,
      "bit flip": good.replace(`"timestamp":5`, `"timestamp":6`),
      reordered: `${[lines[1], lines[0], ...lines.slice(2)].join("\n")}\n`,
      "not canonical": good.replace(lines[3] ?? "", ` ${lines[3]}`),
      "not JSON": good.replace(lines[2] ?? "", "{\"header\":"),
      empty: ""
    };
    for (const [name, content] of Object.entries(cases)) {
      await writeFile(view.path, content);
      await assert.rejects(readAll(view), (error: Error & { code?: string }) => { assert.equal(error.code, "history_file_corrupt", name); return true; }, name);
    }
    // Same lines, different running hash (e.g. a different history with the same tip): refused.
    await writeFile(view.path, good);
    await assert.rejects(readAll({ ...view, runningHash: H(1) }), /running hash mismatch/);
    // A child build of a corrupt file fails with the fixed code and leaves no output behind.
    await writeFile(view.path, cases["bit flip"] ?? "");
    const builder = api.createSnapshotChildBuilder({ secret: SECRET, outDir: join(dir, "out") });
    await assert.rejects(builder.build({ view, ...head }), (error: Error & { code?: string }) => error.code === "history_file_corrupt" && !error.message.includes(SECRET));
    assert.equal(api.snapshotErrorCode(Object.assign(new Error("x"), { code: "ENOENT" })), "build_failed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("collectSnapshotBlocks with a history file: a file that disagrees with the verified chain is a history_file_corrupt error", async () => {
  const dir = await tempDir();
  try {
    const file = await hf.createHistoryFile(join(dir, "h.ndjson"), { chainId: CHAIN, genesisHash: GENESIS });
    const history = { chain: { genesisHash: GENESIS, height: 3 }, file };
    await assert.rejects(api.collectSnapshotBlocks([], { tip: 5, tipHash: H(1), chainId: CHAIN, genesisHash: GENESIS, history }), (error: Error & { code?: string }) => error.code === "history_file_corrupt");
    await file.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("memory bound: a history several times the child's heap cap streams and seals; child peak RSS stays bounded", { timeout: 180_000 }, async () => {
  const dir = await tempDir();
  try {
    // ~2,000 blocks x ~48 KB = ~96 MB of NDJSON; the child gets a 32 MB heap.
    const blocks = syntheticChain(2_000, 48 * 1024);
    const file = await writeHistory(dir, blocks);
    blocks.length = 0;
    const fileBytes = (await stat(file.view().path)).size;
    assert.ok(fileBytes > 90 * 1024 * 1024);
    const builder = api.createSnapshotChildBuilder({ secret: SECRET, outDir: join(dir, "out"), maxOldSpaceMb: 32 });
    const built = await builder.build({ view: file.view(), ...head });
    assert.equal(built.height, 2_000);
    assert.ok(built.maxRssKb < 160 * 1024, `child peak RSS ${built.maxRssKb} KB`);
    console.log(`memory bound: history ${Math.round(fileBytes / 1048576)} MB, child heap cap 32 MB, child peak RSS ${Math.round(built.maxRssKb / 1024)} MB, sealed ${Math.round(built.sealed.length / 1024)} KB`);
    // Decrypt and gunzip as a stream: the plaintext is the full bundle.
    const magic = Buffer.from("ZYRON-OPEN-TESTNET-STATE-V1\n");
    const decipher = createDecipheriv("aes-256-gcm", (await mod("scripts/open-testnet/snapshot-seal.mjs")).snapshotKey(SECRET), built.sealed.subarray(magic.length, magic.length + 12));
    decipher.setAAD(Buffer.from("ZYRON-OPEN-TESTNET-STATE-V1")); decipher.setAuthTag(built.sealed.subarray(magic.length + 12, magic.length + 28));
    const gunzip = createGunzip(); let plainBytes = 0; let tail = "";
    gunzip.on("data", (chunk: Buffer) => { plainBytes += chunk.length; tail = (tail + chunk.toString("latin1")).slice(-64); });
    const done = new Promise((resolve, reject) => { gunzip.on("end", resolve); gunzip.on("error", reject); });
    gunzip.end(Buffer.concat([decipher.update(built.sealed.subarray(magic.length + 28)), decipher.final()]));
    await done;
    assert.ok(plainBytes > fileBytes); assert.ok(tail.endsWith("}]}"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function childScript(dir: string, code: string) { const path = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`); await writeFile(path, code); return pathToFileURL(path); }

test("child process: running out of heap fails the build with worker_out_of_memory; the gateway process is unaffected", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  try {
    const hog = await childScript(dir, `const hog = []; process.once("message", () => { for (;;) hog.push(new Array(1e5).fill({ x: Math.random() })); });`);
    const builder = api.createSnapshotChildBuilder({ secret: SECRET, outDir: join(dir, "out"), childUrl: hog, maxOldSpaceMb: 32 });
    const cache = api.createSnapshotCache({ build: ({ signal }: { signal: AbortSignal }) => builder.build({ view: { path: "x", tip: 0 }, ...head }, { signal }), currentHeight: async () => 1, log: () => {} });
    await cache.refresh();
    assert.equal(cache.status().lastError, "worker_out_of_memory");
    assert.equal(builder.running(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("child process: a hung build is killed at the cache's build timeout; busy builds do not back off", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  try {
    const hang = await childScript(dir, `process.once("message", () => { setInterval(() => {}, 1000); });`);
    const builder = api.createSnapshotChildBuilder({ secret: SECRET, outDir: join(dir, "out"), childUrl: hang });
    const cache = api.createSnapshotCache({ build: ({ signal }: { signal: AbortSignal }) => builder.build({ view: { path: "x", tip: 0 }, ...head }, { signal }), currentHeight: async () => 1, log: () => {}, buildTimeoutMs: 500 });
    const first = cache.refresh();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(builder.build({ view: { path: "x", tip: 0 }, ...head }), (error: Error & { code?: string }) => error.code === "busy");
    const started = performance.now();
    await first;
    assert.ok(performance.now() - started < 5_000);
    assert.equal(cache.status().lastError, "build_timeout");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(builder.running(), false, "the hung child was killed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Low-1: a worker holding more blocks than the new history is restarted and re-shipped", { timeout: 60_000 }, async () => {
  const blocks = syntheticChain(30);
  const builder = api.createSnapshotWorkerBuilder({ secret: SECRET, chunkSize: 7 });
  try {
    const common = { chainId: CHAIN, genesisHash: GENESIS, genesis: {}, network: {}, keys: {} };
    assert.equal((await builder.build({ ...common, blocks, tip: 30, tipHash: blocks[29].hash })).height, 30);
    const shorter = blocks.slice(0, 20);
    assert.equal((await builder.build({ ...common, blocks: shorter, tip: 20, tipHash: shorter[19].hash })).height, 20);
  } finally { builder.terminate(); }
});

test("Low-2: /health error codes come from a fixed allowlist", () => {
  assert.ok(api.SNAPSHOT_ERROR_CODES instanceof Set);
  for (const code of ["history_file_corrupt", "worker_out_of_memory", "build_timeout", "busy"]) assert.equal(api.snapshotErrorCode(Object.assign(new Error("x"), { code })), code);
  for (const code of ["ENOENT", "ERR_STREAM_DESTROYED", "made_up_code"]) assert.equal(api.snapshotErrorCode(Object.assign(new Error("x"), { code })), "build_failed");
});
void createReadStream;

test("history file refuses symlinks and keeps the directory 0700 and the file 0600", { skip: process.platform === "win32" }, async () => {
  const { symlink, mkdir, chmod } = await import("node:fs/promises");
  const dir = await tempDir();
  try {
    const hdir = join(dir, "h"); await mkdir(hdir, { mode: 0o755 }); await chmod(hdir, 0o755);
    const path = join(hdir, "history.ndjson");
    const file = await hf.createHistoryFile(path, { chainId: CHAIN, genesisHash: GENESIS });
    assert.equal((await stat(hdir)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await file.appendMany(syntheticChain(2));
    await file.close();
    // File path is a symlink: refused on create, and the target is untouched.
    const target = join(dir, "target.txt"); await writeFile(target, "keep");
    const linked = join(hdir, "linked.ndjson"); await symlink(target, linked);
    await assert.rejects(hf.createHistoryFile(linked, { chainId: CHAIN, genesisHash: GENESIS }), /symlink|regular file/);
    assert.equal(await readFile(target, "utf8"), "keep");
    // Reading through a symlink is refused (O_NOFOLLOW).
    const readLink = join(hdir, "read-link.ndjson"); await symlink(path, readLink);
    const view = { ...file.view(), path: readLink };
    await assert.rejects((async () => { for await (const _ of hf.readHistoryLines(view)) { /* drain */ } })(), (e: any) => e?.code === "history_file_corrupt");
    // Directory is a symlink: refused.
    const realDir = join(dir, "real"); await mkdir(realDir); const dirLink = join(dir, "dirlink"); await symlink(realDir, dirLink);
    await assert.rejects(hf.createHistoryFile(join(dirLink, "x.ndjson"), { chainId: CHAIN, genesisHash: GENESIS }), /plain directory/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("history file refuses a hard-linked path on create and on read (safe-rebuild error)", { skip: process.platform === "win32" }, async () => {
  const { link } = await import("node:fs/promises");
  const dir = await tempDir();
  try {
    const file = await writeHistory(dir, syntheticChain(3));
    await file.close();
    const view = file.view();
    assert.equal((await readAll(view)).length, 3);
    // Read: a second name for the history file is refused with history_file_corrupt.
    const other = join(dir, "other.ndjson"); await link(view.path, other);
    await assert.rejects(readAll(view), (e: any) => e?.code === "history_file_corrupt" && /hard link/.test(e.message));
    // Create: refused, and the other name keeps its contents (no truncation).
    const before = await readFile(other, "utf8");
    await assert.rejects(hf.createHistoryFile(view.path, { chainId: CHAIN, genesisHash: GENESIS }), (e: any) => e?.code === "history_file_corrupt" && /hard link/.test(e.message));
    assert.equal(await readFile(other, "utf8"), before);
    // After the extra link is gone the path is usable again.
    await rm(other);
    const again = await hf.createHistoryFile(view.path, { chainId: CHAIN, genesisHash: GENESIS });
    await again.appendMany(syntheticChain(1)); await again.close();
    assert.equal((await readAll(again.view())).length, 1);
    // Race (Security Low-1): a hard link created between the lstat check and
    // open() must be refused before any truncation reaches the other name.
    const victim = join(dir, "victim.ndjson");
    await writeFile(victim, "KEEP");
    await assert.rejects(
      hf.openForWrite(view.path, { beforeOpen: async () => { await rm(view.path); await link(victim, view.path); } }),
      (e: any) => e?.code === "history_file_corrupt" && /hard link/.test(e.message));
    assert.equal(await readFile(victim, "utf8"), "KEEP");
    // A plain existing file is still truncated on create.
    await rm(view.path); await writeFile(view.path, "old");
    const fresh = await hf.createHistoryFile(view.path, { chainId: CHAIN, genesisHash: GENESIS }); await fresh.close();
    assert.equal(await readFile(view.path, "utf8"), "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
