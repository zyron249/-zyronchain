// Fix A: a gateway restart on the same network directory resumes the verified
// history file instead of rebuilding it from genesis, but only after every
// line is checked again and its tail matches the live chain; any defect means
// the full rebuild from genesis.
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { allocateValidatorBasePort } from "./helpers/open-testnet-ports.js";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const mod = (path: string) => import(pathToFileURL(join(l1Root, path)).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await mod("scripts/open-testnet.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hf: any = await mod("scripts/open-testnet/history-file.mjs");
const { blockHash } = await mod("dist/src/block.js");
const { merkleRoot } = await mod("dist/src/merkle.js");
const H = (n: number) => n.toString(16).padStart(64, "0");
const CHAIN = "zyron-resume-test-1";
const GENESIS = H(0xabc);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function syntheticChain(count: number, { salt = 0, from = 1, previous = GENESIS }: { salt?: number; from?: number; previous?: string } = {}): any[] {
  const blocks = [];
  for (let height = from; height < from + count; height += 1) {
    const header = { height, chainId: CHAIN, previousHash: previous, transactionRoot: merkleRoot([]), timestamp: height * 10 + salt };
    const hash = blockHash(header);
    blocks.push({ header, hash, transactions: [] });
    previous = hash;
  }
  return blocks;
}
async function tempDir() { const dir = await mkdtemp(join(tmpdir(), "zyron-resume-")); await chmod(dir, 0o700); return dir; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeHistory(path: string, blocks: any[]) {
  const file = await hf.createHistoryFile(path, { chainId: CHAIN, genesisHash: GENESIS });
  await file.appendMany(blocks);
  await file.close();
}
const resume = (path: string, onBlock?: (block: unknown) => unknown) => hf.resumeHistoryFile(path, { chainId: CHAIN, genesisHash: GENESIS, ...(onBlock ? { onBlock } : {}) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAll(view: any) { const lines = []; for await (const line of hf.readHistoryLines(view)) lines.push(line); return lines; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readersFor = (chains: any[][]) => chains.map((blocks, index) => ({ name: `v${index + 1}`, read: async (from: number, limit: number) => blocks.slice(from - 1, from - 1 + limit) }));

test("clean resume: every line is re-checked and replayed in order, appends continue at the stored tip, readers validate the whole file", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "h", "history.ndjson");
    const blocks = syntheticChain(40);
    await writeHistory(path, blocks.slice(0, 30));
    const seen: number[] = [];
    const resumed = await resume(path, (block) => { seen.push((block as { header: { height: number } }).header.height); });
    assert.equal(resumed.height, 30); assert.equal(resumed.tipHash, blocks[29].hash); assert.equal(resumed.droppedBytes, 0);
    assert.deepEqual(seen, Array.from({ length: 30 }, (_, i) => i + 1));
    await resumed.file.appendMany(blocks.slice(30));
    assert.equal(resumed.file.height(), 40);
    const lines = await readAll(resumed.file.view());
    assert.deepEqual(lines, blocks.map((b) => JSON.stringify(b)), "the resumed file plus the appended blocks is the whole chain");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await resumed.file.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("torn last line: it is dropped, the resume works and the file is repaired", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "h", "history.ndjson");
    const blocks = syntheticChain(12);
    await writeHistory(path, blocks.slice(0, 10));
    const torn = JSON.stringify(blocks[10]).slice(0, 37);
    await appendFile(path, torn);
    const resumed = await resume(path);
    assert.equal(resumed.height, 10); assert.equal(resumed.droppedBytes, Buffer.byteLength(torn));
    const raw = await readFile(path, "utf8");
    assert.ok(raw.endsWith("\n") && !raw.includes(torn), "the torn bytes are gone");
    await resumed.file.appendMany(blocks.slice(10));
    assert.deepEqual(await readAll(resumed.file.view()), blocks.map((b) => JSON.stringify(b)));
    await resumed.file.close();
    // A complete JSON object without its newline is a torn write as well.
    await appendFile(path, JSON.stringify(syntheticChain(1, { from: 13, previous: blocks[11].hash })[0]));
    const again = await resume(path);
    assert.equal(again.height, 12); assert.ok(again.droppedBytes > 0);
    await again.file.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a broken hash link, a height gap, a corrupt or non-canonical line mid-file, or a refused replay: no resume (full rebuild)", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "h", "history.ndjson");
    const blocks = syntheticChain(10);
    const lines = blocks.map((b) => JSON.stringify(b));
    const write = async (body: string[]) => { await mkdir(join(dir, "h"), { recursive: true, mode: 0o700 }); await rm(path, { force: true }); await writeFile(path, `${body.join("\n")}\n`, { mode: 0o600 }); };
    // Broken link: line 5 from another chain (valid block hash, wrong previous hash).
    const fork = syntheticChain(10, { salt: 1 });
    await write([...lines.slice(0, 4), JSON.stringify(fork[4]), ...lines.slice(5)]);
    await assert.rejects(resume(path), (error: Error & { code?: string }) => error.code === "history_file_corrupt" && /line 5/.test(error.message));
    // Height gap: line 5 missing.
    await write([...lines.slice(0, 4), ...lines.slice(5)]);
    await assert.rejects(resume(path), /line 5/);
    // A tampered block hash.
    await write([...lines.slice(0, 3), JSON.stringify({ ...blocks[3], hash: H(7) }), ...lines.slice(4)]);
    await assert.rejects(resume(path), /line 4/);
    // Garbage and a non-canonical line mid-file (not the torn tail).
    await write([...lines.slice(0, 3), "{not json", ...lines.slice(4)]);
    await assert.rejects(resume(path), /line 4 is not JSON/);
    await write([...lines.slice(0, 3), JSON.stringify(blocks[3], null, 1).replace(/\n/g, ""), ...lines.slice(4)]);
    await assert.rejects(resume(path), /line 4 is not canonical/);
    // The gateway's replay (full finalized-block validation) refuses a block.
    await write(lines);
    await assert.rejects(resume(path, (block) => { if ((block as { header: { height: number } }).header.height === 6) throw new Error("bad certificate"); }), /line 6 refused \(bad certificate\)/);
    // A symlink or a hard link at the path is never resumed.
    const { symlink, link } = await import("node:fs/promises");
    await rm(path); await writeFile(join(dir, "elsewhere"), `${lines.join("\n")}\n`); await symlink(join(dir, "elsewhere"), path);
    await assert.rejects(resume(path), /not a regular file|symlink/);
    await rm(path); await link(join(dir, "elsewhere"), path);
    await assert.rejects(resume(path), /hard link/);
    // No file: reported as missing (a normal first start).
    await rm(path);
    await assert.rejects(resume(path), (error: Error & { missing?: boolean }) => error.missing === true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("checkResumedTail: a clean tail matches, a forked tail or a stored height above the tip means rebuild, too few answers means retry", async () => {
  const live = syntheticChain(50);
  const stored = { height: 30, tipHash: live[29].hash };
  const readers = readersFor([live, live, live, live]);
  assert.equal(await api.checkResumedTail(readers, stored, { tip: 50, tipHash: live[49].hash }), undefined);
  assert.equal(await api.checkResumedTail(readers, { height: 50, tipHash: live[49].hash }, { tip: 50, tipHash: live[49].hash }), undefined, "stored tip equals the live tip");
  // Forked tail: the file followed another branch from height 21.
  const forked = [...live.slice(0, 20), ...syntheticChain(10, { salt: 5, from: 21, previous: live[19].hash })];
  assert.match(await api.checkResumedTail(readers, { height: 30, tipHash: forked[29].hash }, { tip: 50, tipHash: live[49].hash }), /hash at height 30 does not match validator v1/);
  // Above the tip.
  const longer = syntheticChain(60);
  assert.match(await api.checkResumedTail(readers, { height: 60, tipHash: longer[59].hash }, { tip: 50, tipHash: live[49].hash }), /above the live tip \(60 > 50\)/);
  // At the tip with another hash.
  assert.match(await api.checkResumedTail(readers, { height: 50, tipHash: H(9) }, { tip: 50, tipHash: live[49].hash }), /live tip 50 does not match/);
  // One validator disagrees: rebuild (never trust the file over a validator).
  assert.match(await api.checkResumedTail(readersFor([live, live, forked, live]), { height: 30, tipHash: live[29].hash }, { tip: 50, tipHash: live[49].hash }), /validator v3/);
  // Two validators down: 2 of 4 is below a quorum of 3, so not decided yet.
  const down = { name: "v9", read: async () => { throw new Error("validator not running"); } };
  await assert.rejects(api.checkResumedTail([...readersFor([live, live]), down, down], stored, { tip: 50, tipHash: live[49].hash }), /2 of 4 validators served block 30, need 3/);
  await assert.rejects(api.checkResumedTail(readers, stored, { tip: undefined }), /live tip unknown/);
});

test("restart on the same network directory resumes the history at its stored tip (no rebuild from genesis); a forked file falls back to the rebuild", { timeout: 900_000 }, async () => {
  const root = await tempDir();
  const secret = randomBytes(32).toString("base64");
  const chainId = "zyron-resume-testnet-1";
  const dir = join(root, "net");
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let network: any;
  const until = async (label: string, check: () => Promise<unknown> | unknown, ms = 600_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await Promise.resolve().then(check).catch(() => undefined); if (v) return v; await sleep(250); } throw new Error(`timed out: ${label}\n${logs.slice(-20).join("\n")}`); };
  const json = async (p: string) => { const r = await fetch(`http://127.0.0.1:${network.port}${p}`); return { status: r.status, body: await r.json() }; };
  const historyPath = join(dir, "snapshot-history", "history.ndjson");
  const lineCount = async () => (await readFile(historyPath, "utf8")).split("\n").filter(Boolean).length;
  // Alternate port windows so a restart never races the ports the previous
  // run just released.
  let starts = 0;
  const start = async () => api.runNetwork(dir, { gatewayPort: 0, basePort: await allocateValidatorBasePort((starts++ % 2) ? "durable-watermark" : "restore-log-digest"), log: false, stateSecret: secret, snapshotRefreshMs: 1_000 });
  try {
    await api.initNetwork(dir, chainId);
    network = await start();
    await until("history file at the tip past v6", async () => (await json("/status")).body.height >= 102 && (await lineCount()) >= 102);
    await until("first snapshot built", async () => (await json("/health")).body.snapshotCache?.lastBuiltHeight >= 102);
    await network.shutdown(); network = undefined;
    const storedLines = await lineCount();
    // Simulate a write torn by the restart.
    await appendFile(historyPath, '{"header":{"height":');
    logs.length = 0;
    network = await start();
    const resumed = await until("resume matched", () => logs.find((l) => /resumed history matches the live chain at height (\d+)/.test(l))) as string;
    assert.equal(Number(/at height (\d+)/.exec(resumed)![1]), storedLines);
    assert.ok(logs.some((l) => /dropped a torn last line/.test(l)), "the torn line was dropped");
    assert.ok(!logs.some((l) => /rebuilding the history file|not resumed/.test(l)), `no rebuild from genesis:\n${logs.join("\n")}`);
    await until("snapshot built after the restart", async () => (await json("/health")).body.snapshotCache?.lastBuiltHeight >= storedLines);
    await network.shutdown(); network = undefined;
    // Forked file: rewrite the last stored block on another branch (valid
    // linkage inside the file, but not the live chain and not replayable).
    const raw = (await readFile(historyPath, "utf8")).split("\n").filter(Boolean);
    const last = JSON.parse(raw[raw.length - 1] as string);
    const header = { ...last.header, stateRoot: "f".repeat(64) };
    raw[raw.length - 1] = JSON.stringify({ ...last, header, hash: blockHash(header) });
    await writeFile(historyPath, `${raw.join("\n")}\n`);
    logs.length = 0;
    network = await start();
    await until("fallback logged", () => logs.find((l) => /history file not resumed|rebuilding the history file/.test(l)));
    assert.ok(!logs.some((l) => /resumed history matches/.test(l)));
    await until("rebuilt snapshot", async () => (await json("/health")).body.snapshotCache?.lastBuiltHeight >= raw.length);
  } finally {
    await network?.shutdown();
    console.error = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing history file (ephemeral disk after a container restart) logs one explicit warning; other defects keep the not-resumed line", async () => {
  const dir = await tempDir();
  try {
    let missing: unknown;
    try { await hf.resumeHistoryFile(join(dir, "snapshot-history", "history.ndjson"), { chainId: CHAIN, genesisHash: GENESIS, onBlock: async () => {} }); } catch (error) { missing = error; }
    assert.equal((missing as { missing?: boolean })?.missing, true);
    assert.equal(api.historyResumeSkipMessage(missing), "snapshot: history file absent (ephemeral disk); rebuilding from genesis");
    const other = api.historyResumeSkipMessage(new hf.HistoryFileError("broken hash link at line 3"));
    assert.match(other, /^snapshot: history file not resumed \(.*broken hash link.*\); rebuilding from genesis$/);
    assert.doesNotMatch(other, /absent/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rate-limiter key bound: 10k default, tunable via ZYRON_RPC_LIMITER_MAX_KEYS within 1000..1000000, junk falls back", () => {
  assert.equal(api.RATE_LIMITER_MAX_KEYS_DEFAULT, 10_000);
  assert.equal(api.rateLimiterMaxKeys({}), 10_000);
  assert.equal(api.rateLimiterMaxKeys({ ZYRON_RPC_LIMITER_MAX_KEYS: "50000" }), 50_000);
  assert.equal(api.rateLimiterMaxKeys({ ZYRON_RPC_LIMITER_MAX_KEYS: "1000" }), 1_000);
  assert.equal(api.rateLimiterMaxKeys({ ZYRON_RPC_LIMITER_MAX_KEYS: "1000000" }), 1_000_000);
  for (const bad of ["", "999", "1000001", "1e4.5", "abc", "-5", "12.5", " 5000", "5000 ", "\t5000", "1e3", "0x3e8", "+5000", "5000.0"]) assert.equal(api.rateLimiterMaxKeys({ ZYRON_RPC_LIMITER_MAX_KEYS: bad }), 10_000, bad);
});

test("WindowLimiter saturation (deny-on-full / faucet path): live key stays counted, new key denied when full, expired entries recovered; day-window faucet limiters keep 50k", () => {
  // Default (evictOnFull=false) keeps the faucet day-window policy: never push
  // out a live key to reset its quota. The 60s tables opt into eviction separately.
  const l = new api.WindowLimiter(2, 1_000, 3);
  for (const k of ["a", "b", "c"]) assert.equal(l.take(k, 0).allowed, true);
  assert.equal(l.take("d", 10).allowed, false);
  assert.equal(l.hits.has("d"), false);
  assert.equal(l.stats().deniedFull, 1);
  assert.equal(l.stats().evicted, 0);
  assert.equal(l.take("a", 20).allowed, true);
  assert.equal(l.take("a", 30).allowed, false);
  assert.equal(l.hits.get("a").count, 2);
  assert.equal(l.take("d", 1_000).allowed, true);
  assert.equal(l.hits.size, 1);
  assert.equal(api.DAY_WINDOW_LIMITER_MAX_KEYS, 50_000);
  assert.equal(api.RATE_LIMITER_PREFIX_CAP_DEFAULT, 256);
  assert.equal(new api.WindowLimiter(1, 1).maxKeys, 10_000);
  assert.equal(new api.WindowLimiter(1, 1).evictOnFull, false);
});

// ---- Red Team PR #1200 follow-up (fail-first against 7e2c363) ----------------
// (1) 60s tables evict the oldest entry instead of denying when full.
// (2) At most ~256 live keys per IPv6 /48.
// (3) /health (via rateLimitersHealth) exposes size, deniedFull, evicted.

test("WindowLimiter 60s tables: when full, admit a new key by evicting the oldest (not deny); count the eviction", () => {
  // Fail-first against deny-on-full at 7e2c363.
  const l = new api.WindowLimiter(10, 60_000, 3, { evictOnFull: true });
  assert.equal(l.take("oldest", 0).allowed, true);
  assert.equal(l.take("mid", 1).allowed, true);
  assert.equal(l.take("newest", 2).allowed, true);
  assert.equal(l.hits.size, 3);
  const admitted = l.take("fresh", 3);
  assert.equal(admitted.allowed, true, "new key must be admitted by evicting the oldest");
  assert.equal(l.hits.has("oldest"), false, "oldest live key is the eviction victim");
  assert.equal(l.hits.has("fresh"), true);
  assert.equal(l.hits.size, 3);
  assert.equal(l.stats().evicted, 1);
  assert.equal(l.stats().deniedFull, 0);
  // Eviction is only to admit a new key: an existing live key still hits its own limit.
  for (let i = 0; i < 9; i += 1) assert.equal(l.take("fresh", 4 + i).allowed, true);
  assert.equal(l.take("fresh", 20).allowed, false);
});

test("WindowLimiter: at most 256 live keys per IPv6 /48; further /64s from that /48 are denied and counted", () => {
  // Fail-first against uncapped /48 sprays at 7e2c363.
  const l = new api.WindowLimiter(10, 60_000, 10_000, { evictOnFull: true, prefixCap: 256 });
  const key = (n: number) => `ipv6:2001:0db8:0001:${n.toString(16).padStart(4, "0")}/64`;
  for (let i = 0; i < 256; i += 1) assert.equal(l.take(key(i), i).allowed, true, `admit /64 ${i}`);
  assert.equal(l.hits.size, 256);
  assert.equal(l.take(key(256), 300).allowed, false, "257th /64 from the same /48 is denied");
  assert.equal(l.hits.has(key(256)), false);
  assert.equal(l.stats().deniedFull, 1);
  // A different /48 still gets in.
  assert.equal(l.take("ipv6:2001:0db8:0002:0000/64", 301).allowed, true);
  assert.equal(l.hits.size, 257);
  // IPv4 and non-ipv6 keys are not subject to the /48 cap.
  assert.equal(l.take("198.51.100.7", 302).allowed, true);
});

test("rateLimitersHealth exposes size, maxKeys, deniedFull and evicted per table", () => {
  // Fail-first against missing /health rate-limiter counters at 7e2c363.
  assert.equal(typeof api.rateLimitersHealth, "function");
  const read = new api.WindowLimiter(10, 60_000, 2, { evictOnFull: true, prefixCap: 256 });
  read.take("a", 0);
  read.take("b", 1);
  read.take("c", 2); // evicts "a"
  const write = new api.WindowLimiter(10, 60_000, 1, { evictOnFull: false });
  write.take("x", 0);
  assert.equal(write.take("y", 1).allowed, false); // deny-on-full
  const body = api.rateLimitersHealth({ read, write, relayIp: new api.WindowLimiter(1, 60_000, 10, { evictOnFull: true }) });
  assert.equal(body.read.size, 2);
  assert.equal(body.read.maxKeys, 2);
  assert.equal(body.read.evicted, 1);
  assert.equal(body.read.deniedFull, 0);
  assert.equal(body.write.size, 1);
  assert.equal(body.write.deniedFull, 1);
  assert.equal(body.write.evicted, 0);
  assert.equal(body.relayIp.size, 0);
  assert.equal(body.relayIp.evicted, 0);
  assert.equal(body.relayIp.deniedFull, 0);
});
