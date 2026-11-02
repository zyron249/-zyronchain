// Verified gateway checkpoint (#1193): opt-in speed-up for the restart
// replay. Every tamper, corruption or mismatch must fall back to full
// validation from genesis; nothing from a checkpoint is used before the
// live validators serve its tip.
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { allocateValidatorBasePort } from "./helpers/open-testnet-ports.js";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const mod = (path: string) => import(pathToFileURL(join(l1Root, path)).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await mod("scripts/open-testnet.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cp: any = await mod("scripts/open-testnet/checkpoint-file.mjs");
const { ZyronChain } = await mod("dist/src/chain.js");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// One real network, run with the checkpoint on; its files are the fixture.
const root = await mkdtemp(join(tmpdir(), "zyron-ckpt-")); await chmod(root, 0o700);
const dir = join(root, "net");
const histDir = join(dir, "snapshot-history");
const historyPath = join(histDir, "history.ndjson");
const checkpointPath = join(histDir, "checkpoint.json");
const secret = randomBytes(32).toString("base64");
const chainId = "zyron-checkpoint-testnet-1";
const logs: string[] = [];
const original = console.error;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let network: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let genesis: any; let genesisHash: string; let lines: string[] = []; let goodCheckpoint: Buffer; let goodHistory: Buffer;
let starts = 0;
const start = async () => api.runNetwork(dir, { gatewayPort: 0, basePort: await allocateValidatorBasePort((starts++ % 2) ? "durable-watermark" : "restore-log-digest"), log: false, stateSecret: secret, snapshotRefreshMs: 1_000, checkpoint: { enabled: true, everyBlocks: 20, everyMs: 600_000 } });
const until = async (label: string, check: () => Promise<unknown> | unknown, ms = 600_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await Promise.resolve().then(check).catch(() => undefined); if (v) return v; await sleep(250); } throw new Error(`timed out: ${label}\n${logs.slice(-25).join("\n")}`); };
const json = async (p: string) => { const r = await fetch(`http://127.0.0.1:${network.port}${p}`); return { status: r.status, body: await r.json() }; };
const lineCount = async () => (await readFile(historyPath, "utf8")).split("\n").filter(Boolean).length;
const ids = () => ({ chainId, genesisHash });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const record = () => cp.decodeCheckpoint(goodCheckpoint, ids()) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const encode = (r: any) => cp.encodeCheckpoint(r) as Buffer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readers = (blocks: any[], count = 4) => Array.from({ length: count }, (_, i) => ({ name: `v${i + 1}`, read: async (from: number, limit: number) => blocks.slice(from - 1, from - 1 + limit) }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const blocks = () => lines.map((line) => JSON.parse(line)) as any[];
async function restart() {
  logs.length = 0;
  network = await start();
}
async function stop() { await network?.shutdown(); network = undefined; }
async function restoreGood() { await rm(checkpointPath, { force: true }); await writeFile(historyPath, goodHistory); await writeFile(checkpointPath, goodCheckpoint, { mode: 0o600 }); await chmod(checkpointPath, 0o600); }
const fellBack = () => logs.find((l) => /checkpoint not used|rebuilding the history file \(checkpoint/.test(l));

before(async () => {
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  await api.initNetwork(dir, chainId);
  genesis = JSON.parse(await readFile(join(dir, "genesis.json"), "utf8"));
  genesisHash = JSON.parse(await readFile(join(dir, "network.json"), "utf8")).genesisHash;
  network = await start();
  await until("history past v6", async () => (await json("/status")).body.height >= 104 && (await lineCount()) >= 104);
  await until("a checkpoint was written", () => logs.find((l) => /checkpoint written at height/.test(l)));
  await stop(); // clean shutdown writes one at the file tip
  goodCheckpoint = await readFile(checkpointPath);
  goodHistory = await readFile(historyPath);
  lines = goodHistory.toString("utf8").split("\n").filter(Boolean);
}, { timeout: 900_000 });
after(async () => { await stop().catch(() => {}); console.error = original; await rm(root, { recursive: true, force: true }); });

test("1 written atomically at the history tip on a clean shutdown: 0600, digest and stateHash verify, byte-equal history line", async () => {
  const info = await stat(checkpointPath);
  assert.equal(info.mode & 0o777, 0o600);
  const r = record();
  assert.equal(r.height, lines.length, "the shutdown checkpoint is at the file tip");
  assert.equal(r.historyLine, lines[r.height - 1]);
  assert.ok(goodCheckpoint.length < cp.CHECKPOINT_MAX_BYTES);
  assert.deepEqual((await readdir(histDir)).filter((n) => cp.isCheckpointTmpName(n)), [], "no tmp file left");
  assert.ok(logs.some((l) => /checkpoint written at height/.test(l)));
});

test("2 clean resume: only the tail after the checkpoint is validated, no rebuild, snapshot builds", { timeout: 900_000 }, async () => {
  // An older (stale but valid) checkpoint 20 blocks back: accepted as a base, its tail validated in full.
  const r = record();
  const older = r.height - 2;
  assert.ok(older >= 101, "state v2 from height 101");
  const chain = new ZyronChain(genesis);
  for (const block of blocks().slice(0, older)) chain.acceptBlock(structuredClone(block), Date.now());
  let running = (await mod("scripts/open-testnet/history-file.mjs")).historySeed(genesisHash);
  const hf = await mod("scripts/open-testnet/history-file.mjs");
  for (const line of lines.slice(0, older)) running = hf.nextRunningHash(running, line);
  await writeFile(checkpointPath, encode({ chainId, genesisHash, height: older, tipHash: chain.tip.hash, historyRunningHash: running, historyLine: lines[older - 1] as string, state: chain.snapshot() }));
  await restart();
  const matched = await until("checkpoint matched", () => logs.find((l) => /checkpoint at height \d+ matches the live chain/.test(l))) as string;
  assert.match(matched, new RegExp(`checkpoint at height ${older} matches the live chain; validated ${lines.length - older} tail blocks; continuing from ${lines.length}`));
  assert.ok(!logs.some((l) => /history file resumed at height \d+; matching/.test(l)), "the full-replay resume did not run");
  assert.ok(!fellBack(), logs.join("\n"));
  await until("snapshot built after the checkpoint resume", async () => (await json("/health")).body.snapshotCache?.lastBuiltHeight >= lines.length);
  await stop();
  goodCheckpoint = await readFile(checkpointPath); goodHistory = await readFile(historyPath);
  lines = goodHistory.toString("utf8").split("\n").filter(Boolean);
});

// Boot-time checks (no network needed): the gateway runs readCheckpoint and
// resumeHistoryAtCheckpoint; any throw means "checkpoint not used" and the
// full #1192 replay from genesis (asserted end to end in test 4).
async function bootCheck(tamper: (d: string, path: string, history: string) => Promise<void>) {
  const d = await mkdtemp(join(tmpdir(), "zyron-ckpt-boot-"));
  try {
    const path = join(d, "h", "checkpoint.json"); const history = join(d, "h", "history.ndjson");
    await mkdir(join(d, "h"), { mode: 0o700 });
    await writeFile(path, goodCheckpoint, { mode: 0o600 }); await writeFile(history, goodHistory, { mode: 0o600 });
    await tamper(d, path, history);
    const r = await cp.readCheckpoint(path, ids());
    const resumed = await cp.resumeHistoryAtCheckpoint(history, r, ids());
    await resumed.file.close();
    return resumed;
  } finally { await rm(d, { recursive: true, force: true }); }
}
const bootCases: Array<[string, (d: string, path: string, history: string) => Promise<void>, RegExp]> = [
  ["3 torn (truncated) file", async (_d, path) => { await writeFile(path, goodCheckpoint.subarray(0, goodCheckpoint.length - 100)); }, /truncated|digest/],
  ["5 flipped byte in the state", async (_d, path) => { const b = Buffer.from(goodCheckpoint); const i = b.indexOf("\"accounts\"") + 40; b[i] = b[i] === 0x31 ? 0x32 : 0x31; await writeFile(path, b); }, /digest mismatch/],
  ["6 history line not byte-equal to the file", async (_d, path) => { const r = record(); const parsed = JSON.parse(r.historyLine); r.historyLine = JSON.stringify(parsed, Object.keys(parsed).reverse()); await writeFile(path, encode(r)); }, /history line/],
  ["7 history running hash mismatch", async (_d, path) => { const r = record(); r.historyRunningHash = "ab".repeat(32); await writeFile(path, encode(r)); }, /running hash/],
  ["8 checkpoint height above the history tip", async (_d, _p, history) => { await writeFile(history, `${lines.slice(0, record().height - 3).join("\n")}\n`); }, /above the history tip/],
  ["9 chain ID / genesis mismatch", async (_d, path) => { const r = record(); r.genesisHash = "cd".repeat(32); r.state.genesisHash = r.genesisHash; await writeFile(path, encode(r)); }, /chain ID or genesis mismatch/],
  ["10 key outside ChainSnapshot", async (_d, path) => { const r = record(); r.state.mempool = []; await writeFile(path, encode(r)); }, /unexpected keys/],
  ["11 extra top-level key", async (_d, path) => { const r = record(); const body = JSON.parse(encode(r).toString().split("\n")[0] as string); body.hmac = "00"; const text = JSON.stringify(Object.fromEntries(Object.entries(body).sort(([x], [y]) => (x < y ? -1 : 1)))); const { createHash } = await import("node:crypto"); await writeFile(path, `${text}\n${createHash("sha256").update(text).digest("hex")}\n`); }, /unexpected keys|not canonical/],
  ["12 symlink in place of the file", async (d, path) => { await writeFile(join(d, "elsewhere"), goodCheckpoint); await rm(path); await symlink(join(d, "elsewhere"), path); }, /symlink|regular file/],
  ["13 hard link", async (d, path) => { await link(path, join(d, "second")); }, /hard link/]
];
test("boot checks accept the untampered checkpoint", async () => { const resumed = await bootCheck(async () => {}); assert.equal(resumed.height, lines.length); });
for (const [name, tamper, expected] of bootCases) {
  test(`${name}: refused at boot (full validation from genesis)`, async () => { await assert.rejects(bootCheck(tamper), expected); });
}

// End to end: the gateway falls back to full validation from genesis and
// never uses the checkpoint. Test 4 is a boot-time refusal; 14-16 pass the
// file checks and the live match and are refused by the loader.
const e2eCases: Array<[string, () => Promise<void>, RegExp]> = [
  ["4 torn file at boot", async () => { await writeFile(checkpointPath, goodCheckpoint.subarray(0, goodCheckpoint.length - 100)); }, /checkpoint not used \(.*(truncated|digest)/],
  ["14 valid digest and stateHash but a wrong state root (balance changed)", async () => {
    const r = record(); const account = r.state.state.accounts.find((a: { balanceAtoms: number }) => a.balanceAtoms > 10); account.balanceAtoms -= 1;
    await writeFile(checkpointPath, encode(r));
  }, /rebuilding the history file \(checkpoint rejected .*state root/],
  ["15 bad finality certificate on the tip", async () => {
    const r = record(); r.state.tip.attestations.splice(1);
    await writeFile(checkpointPath, encode(r));
  }, /rebuilding the history file \(checkpoint rejected/],
  ["16 validator schedule changed (schedules are bound by the state-v2 root)", async () => {
    const r = record(); const entry = r.state.validatorSchedule[0]; entry.validators = [...entry.validators].reverse(); await writeFile(checkpointPath, encode(r));
  }, /rebuilding the history file \(checkpoint rejected/]
];
for (const [name, tamper, expected] of e2eCases) {
  test(`${name}: the gateway falls back to full validation from genesis`, { timeout: 600_000 }, async () => {
    await restoreGood();
    await tamper();
    await restart();
    const line = await until("fallback", fellBack) as string;
    assert.match(line, expected, logs.join("\n"));
    assert.ok(!logs.some((l) => /checkpoint at height \d+ matches the live chain/.test(l)), "checkpoint never used");
    await until("history validated from genesis", () => logs.find((l) => /history file resumed at height \d+; matching|resumed history matches|rebuilding the history file/.test(l)));
    await stop();
  });
}

test("17 leftover tmp files are removed at boot without following symlinks; a crash between write and rename keeps the old file", async () => {
  const d = await mkdtemp(join(tmpdir(), "zyron-ckpt-tmp-"));
  try {
    const path = join(d, "checkpoint.json");
    await cp.writeCheckpoint(path, goodCheckpoint);
    const target = join(d, "precious"); await writeFile(target, "keep");
    await symlink(target, join(d, "checkpoint.json.tmp.99999"));
    await writeFile(join(d, "checkpoint.json.tmp.88888"), "torn");
    await mkdir(join(d, "checkpoint.json.tmp.dir"));
    assert.equal(await cp.cleanStaleCheckpointTmp(d), 2);
    assert.equal(await readFile(target, "utf8"), "keep", "symlink target untouched");
    assert.ok((await lstat(join(d, "checkpoint.json.tmp.dir"))).isDirectory());
    // Crash between write and rename: the previous checkpoint stays intact.
    await assert.rejects(cp.writeCheckpoint(path, Buffer.from("new"), { beforeRename: async () => { throw new Error("crash"); } }), /crash/);
    assert.deepEqual(await readFile(path), goodCheckpoint);
    assert.deepEqual((await readdir(d)).filter((n) => cp.isCheckpointTmpName(n) && n !== "checkpoint.json.tmp.dir"), []);
    // O_EXCL: an existing tmp name (a planted symlink) is never written through.
    await symlink(target, join(d, `checkpoint.json.tmp.${process.pid}`));
    await assert.rejects(cp.writeCheckpoint(path, goodCheckpoint), /EEXIST|ELOOP/);
    assert.equal(await readFile(target, "utf8"), "keep");
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("18 FIFO, oversize, over the JSON complexity limits, non-canonical: refused by the reader", async () => {
  const d = await mkdtemp(join(tmpdir(), "zyron-ckpt-io-"));
  try {
    const path = join(d, "checkpoint.json");
    execFileSync("mkfifo", [path]);
    await assert.rejects(cp.readCheckpoint(path, ids()), /regular file/);
    await rm(path);
    await writeFile(path, goodCheckpoint);
    await assert.rejects(cp.readCheckpoint(path, { ...ids(), maxBytes: goodCheckpoint.length - 1 }), /size cap/);
    await assert.rejects(cp.writeCheckpoint(path, Buffer.alloc(cp.CHECKPOINT_MAX_BYTES + 1)), /over the .*cap/);
    const deep = "[".repeat(100) + "]".repeat(100);
    const { createHash } = await import("node:crypto");
    await writeFile(path, `${deep}\n${createHash("sha256").update(deep).digest("hex")}\n`);
    await assert.rejects(cp.readCheckpoint(path, ids()), /complexity/);
    const body = goodCheckpoint.subarray(0, goodCheckpoint.length - 66).toString("utf8");
    const spaced = ` ${body}`;
    await writeFile(path, `${spaced}\n${createHash("sha256").update(spaced).digest("hex")}\n`);
    await assert.rejects(cp.readCheckpoint(path, ids()), /not canonical/);
    assert.equal(await cp.readCheckpoint(join(d, "missing"), ids()), undefined);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("19 live tip match (checkResumedTail rule): forked checkpoint or height above the live tip means rebuild; fewer than 3 of 4 answering means retry", async () => {
  const live = blocks();
  const r = record();
  const at = { height: r.height, tipHash: r.tipHash };
  const tip = live.length; const tipHash = live[tip - 1].hash;
  assert.equal(await api.checkResumedTail(readers(live), at, { tip, tipHash }), undefined);
  assert.match(await api.checkResumedTail(readers(live), { height: r.height, tipHash: "ef".repeat(32) }, { tip, tipHash }), /does not match/);
  assert.match(await api.checkResumedTail(readers(live), at, { tip: r.height - 1, tipHash: live[r.height - 2].hash }), /above the live tip/);
  const forked = live.map((b, i) => (i === r.height - 1 ? { ...b, hash: "12".repeat(32) } : b));
  assert.match(await api.checkResumedTail([...readers(live, 3), ...readers(forked, 1).map((x) => ({ ...x, name: "v4" }))], at, { tip, tipHash }), /validator v4/);
  const down = { name: "down", read: async () => { throw new Error("validator not running"); } };
  await assert.rejects(api.checkResumedTail([...readers(live, 2), down, down], at, { tip, tipHash }), /2 of 4 validators served/);
});

test("20 load checks: a tip before state v2 is refused; supply must reconcile with genesis and burns; the loader never seeds the active set", async () => {
  const chain = new ZyronChain(genesis);
  const pre = 50; // before the protocol-v6 / state-v2 activation of the open testnet genesis
  for (const block of blocks().slice(0, pre)) chain.acceptBlock(structuredClone(block), Date.now());
  const state = chain.snapshot();
  const stateHash = (await import("node:crypto")).createHash("sha256").update((await mod("dist/src/codec.js")).canonicalJson(state)).digest("hex");
  await assert.rejects(cp.loadCheckpointChain(genesis, { height: pre, tipHash: chain.tip.hash, stateHash, state }), /not on state v2/);
  const good = await cp.loadCheckpointChain(genesis, record());
  const report = cp.checkChainSupply(good, genesis);
  assert.equal(report.reconciles, true);
  const fake = Object.create(good); fake.genesisSupplyAtoms = () => good.genesisSupplyAtoms() + 1;
  assert.throws(() => cp.checkChainSupply(fake, genesis), /genesis supply mismatch/);
  const minted = Object.create(good); minted.getState = () => { const s = good.getState(); const snap = s.snapshot(); snap.accounts[0].balanceAtoms += Number(BigInt(report.burnedAtoms)) + 1; return { snapshot: () => snap }; };
  assert.throws(() => cp.checkChainSupply(minted, genesis), /supply/);
  const src = await readFile(join(l1Root, "scripts/open-testnet.mjs"), "utf8");
  assert.ok(!/activeSetSeedFromHistory\([^)]*checkpoint/.test(src), "the active set is never seeded from a checkpoint");
});

test("21 off by default: without ZYRON_CHECKPOINT=1 nothing is read or written", () => {
  assert.equal(cp.parseCheckpointOptions({}).enabled, false);
  assert.equal(cp.parseCheckpointOptions({ ZYRON_CHECKPOINT: "true" }).enabled, false);
  assert.deepEqual(cp.parseCheckpointOptions({ ZYRON_CHECKPOINT: "1" }), { enabled: true, everyBlocks: 500, everyMs: 600_000 });
});
