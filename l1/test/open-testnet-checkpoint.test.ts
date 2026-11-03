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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pw: any = await mod("scripts/open-testnet/checkpoint-prefix.mjs");
const { ZyronChain } = await mod("dist/src/chain.js");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// One real network, run with the checkpoint on; its files are the fixture.
// The host cgroup holds every agent's processes (GBs), so the worker's memory
// gate reads 0 here unless a test sets memoryCurrent (test 32).
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const start = async (extra: any = {}) => api.runNetwork(dir, { gatewayPort: 0, basePort: await allocateValidatorBasePort((starts++ % 2) ? "durable-watermark" : "restore-log-digest"), log: false, stateSecret: secret, snapshotRefreshMs: 1_000, checkpoint: { enabled: true, everyBlocks: 20, everyMs: 600_000, memoryCurrent: async () => 0, ...extra } });
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function restart(extra: any = {}) {
  logs.length = 0;
  network = await start(extra);
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
  assert.match(matched, new RegExp(`checkpoint at height ${older} matches the live chain; prefix checked by the worker; validated ${lines.length - older} tail blocks; continuing from ${lines.length}`));
  // Option (a): the worker ran once, and the first snapshot build started
  // only after it finished (never alongside it).
  const at = (re: RegExp) => logs.findIndex((l) => re.test(l));
  const started = at(/checkpoint prefix worker started/); const finished = at(/checkpoint prefix worker finished .*checked \d+ blocks/);
  assert.ok(started >= 0 && finished > started, logs.join("\n"));
  assert.equal(logs.filter((l) => /checkpoint prefix worker started/.test(l)).length, 1, "one worker");
  await until("first build", () => at(/first build started/) >= 0);
  assert.ok(at(/first build started/) > finished, "the first snapshot build did not overlap the worker");
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
  // Security Low on #1197: an attestation signature edited BELOW the
  // checkpoint, history running hash recomputed and the checkpoint resealed.
  // The boot scan accepts it; the prefix signature check must refuse it.
  ["22 attestation signature edited below the checkpoint, checkpoint resealed", async () => {
    const r = record(); const edited = [...lines]; const at = 50; const b = JSON.parse(edited[at - 1] as string);
    assert.ok(b.attestations?.length, "block 50 carries attestations");
    b.attestations[0].signature = "00".repeat(64); edited[at - 1] = JSON.stringify(b);
    const hf = await mod("scripts/open-testnet/history-file.mjs");
    let running = hf.historySeed(genesisHash); for (const line of edited.slice(0, r.height)) running = hf.nextRunningHash(running, line);
    await writeFile(historyPath, `${edited.join("\n")}\n`);
    await writeFile(checkpointPath, encode({ ...r, historyRunningHash: running }));
  }, /rebuilding the history file \(checkpoint rejected .*prefix block 50 rejected/],
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
    if (name.startsWith("22 ")) {
      // The worker refused the prefix, and it had finished before the
      // rebuild began; no worker runs during or after the rebuild.
      const at = (re: RegExp) => logs.findIndex((l) => re.test(l));
      const finished = at(/checkpoint prefix worker finished .*refused/); const rebuilt = at(/rebuilding the history file/);
      assert.ok(finished >= 0 && rebuilt > finished, logs.join("\n"));
      assert.ok(!logs.slice(rebuilt).some((l) => /checkpoint prefix worker started/.test(l)));
      assert.match(line, /worker refused the prefix/);
    }
    await stop();
  });
}

// Option (a) unit tests: the worker against the fixture files.
async function workerFixture(edit?: (lines: string[]) => string[]) {
  const d = await mkdtemp(join(tmpdir(), "zyron-ckpt-worker-"));
  const history = join(d, "history.ndjson"); const path = join(d, "checkpoint.json");
  const hf = await mod("scripts/open-testnet/history-file.mjs");
  const r = record(); const edited = edit ? edit([...lines]) : [...lines];
  let running = hf.historySeed(genesisHash); for (const line of edited.slice(0, r.height)) running = hf.nextRunningHash(running, line);
  await writeFile(history, `${edited.join("\n")}\n`, { mode: 0o600 });
  await writeFile(path, edit ? encode({ ...r, historyRunningHash: running }) : goodCheckpoint, { mode: 0o600 });
  const options = { historyPath: history, checkpointPath: path, chainId, genesisHash, genesis };
  return { d, options, record: cp.decodeCheckpoint(await readFile(path), ids()), mainView: { height: r.height, runningHash: running } };
}
test("24 prefix worker: passes the untampered prefix with env {}; its result is accepted only when it equals the record and the main thread's scan", { timeout: 120_000 }, async () => {
  const f = await workerFixture();
  try {
    const job = pw.startPrefixWorker(f.options); const result = await job.result;
    assert.equal(result.ok, true, result.reason); assert.equal(result.height, f.record.height); assert.equal(result.envKeyCount, 0, "worker env is empty");
    assert.equal(job.running(), false);
    assert.equal(pw.checkPrefixResult(result, f.record, f.mainView), undefined);
    // Results that do not match are refused.
    assert.match(pw.checkPrefixResult({ ...result, height: result.height - 1 }, f.record, f.mainView), /height/);
    assert.match(pw.checkPrefixResult({ ...result, runningHash: "ab".repeat(32) }, f.record, f.mainView), /running hash differs from the checkpoint/);
    assert.match(pw.checkPrefixResult(result, f.record, { ...f.mainView, runningHash: "cd".repeat(32) }), /main thread/);
    assert.match(pw.checkPrefixResult(result, f.record, undefined), /main thread/);
    assert.match(pw.checkPrefixResult({ ...result, stateHash: "ef".repeat(32) }, f.record, f.mainView), /different checkpoint/);
    assert.match(pw.checkPrefixResult({ ...result, tipHash: "12".repeat(32) }, f.record, f.mainView), /tip/);
    assert.match(pw.checkPrefixResult({ ok: false, reason: "x" }, f.record, f.mainView), /refused/);
    assert.match(pw.checkPrefixResult(undefined, f.record, f.mainView), /refused/);
  } finally { await rm(f.d, { recursive: true, force: true }); }
});
test("25 prefix worker: an edited attestation below the checkpoint is refused by the worker", { timeout: 120_000 }, async () => {
  const f = await workerFixture((l) => { const b = JSON.parse(l[49] as string); b.attestations[0].signature = "00".repeat(64); l[49] = JSON.stringify(b); return l; });
  try {
    const result = await pw.startPrefixWorker(f.options).result;
    assert.equal(result.ok, false); assert.match(result.reason, /prefix block 50 rejected/);
    assert.match(pw.checkPrefixResult(result, f.record, f.mainView), /worker refused the prefix/);
  } finally { await rm(f.d, { recursive: true, force: true }); }
});
test("26 prefix worker cancellation: cancel() terminates it and the result rejects as cancelled", { timeout: 120_000 }, async () => {
  const f = await workerFixture();
  try {
    const job = pw.startPrefixWorker(f.options); job.cancel();
    await assert.rejects(job.result, (e: { cancelled?: boolean }) => e.cancelled === true);
    assert.equal(job.running(), false); job.cancel();
  } finally { await rm(f.d, { recursive: true, force: true }); }
});
test("27 prefix worker options and gate: env {}, no SHARE_ENV, ~64 MB heap, no secret in workerData; never alongside a rebuild or a build", async () => {
  const o = pw.prefixWorkerOptions({ historyPath: "/h", checkpointPath: "/c", chainId, genesisHash, genesis });
  assert.deepEqual(o.env, {}); assert.equal(o.resourceLimits.maxOldGenerationSizeMb, 64);
  assert.deepEqual(Object.keys(o.workerData).sort(), ["chainId", "checkpointPath", "genesis", "genesisHash", "historyPath"]);
  assert.ok(!JSON.stringify(o.workerData).includes(secret), "no secret in workerData");
  const base = { started: false, haveCandidate: true, shuttingDown: false, historyRebuilding: false, building: false };
  assert.equal(api.prefixWorkerMayStart(base), true);
  assert.equal(api.prefixWorkerMayStart({ ...base, historyRebuilding: true }), false, "not during the history rebuild");
  assert.equal(api.prefixWorkerMayStart({ ...base, building: true }), false, "not during a snapshot build");
  assert.equal(api.prefixWorkerMayStart({ ...base, started: true }), false, "one worker");
  assert.equal(api.prefixWorkerMayStart({ ...base, haveCandidate: false }), false);
  assert.equal(api.prefixWorkerMayStart({ ...base, shuttingDown: true }), false);
  // While it runs, snapshot builds defer (not a failure).
  assert.equal(api.snapshotBuildReadiness({ quorumOk: true, tip: 10, historyHeight: 10, checkpointVerifying: true }), "checkpoint_verifying");
  assert.ok(api.SNAPSHOT_DEFERRED_CODES.has("checkpoint_verifying"));
});

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

// Prefix signature check (unit): every block at or below the checkpoint gets
// the full envelope check; one bad attestation, proposer or transaction
// signature anywhere in the prefix is refused.
test("22b prefix verifier: the untampered prefix passes; an edited attestation, proposer signature or reordered line below the checkpoint is refused", async () => {
  const r = record(); const chain = await cp.loadCheckpointChain(genesis, r);
  const run = (list: unknown[]) => { const v = cp.createPrefixVerifier(chain, genesis, r); for (const b of list) v.check(b); v.done(); };
  run(blocks().slice(0, r.height));
  const att = blocks().slice(0, r.height); att[49].attestations[0].signature = "00".repeat(64);
  assert.throws(() => run(att), /prefix block 50 rejected/);
  const late = blocks().slice(0, r.height); const i = r.height - 2; const sig = late[i].attestations[0].signature; late[i].attestations[0].signature = sig.slice(0, -2) + (sig.endsWith("00") ? "01" : "00");
  assert.throws(() => run(late), new RegExp(`prefix block ${i + 1} rejected`));
  const prop = blocks().slice(0, r.height); prop[9].signature = "11".repeat(64);
  assert.throws(() => run(prop), /prefix block 10 rejected/);
  const swapped = blocks().slice(0, r.height); [swapped[20], swapped[21]] = [swapped[21], swapped[20]];
  assert.throws(() => run(swapped), /prefix block 21 out of order/);
  assert.throws(() => run(blocks().slice(0, r.height - 1)), /prefix ends at/);
});

// A real validator_update in the replayed tail: a fifth validator is added
// after the checkpoint (signed by the testnet's own validator keys), the tail
// is replayed with acceptBlock across the activation, and a checkpoint taken
// after the activation still verifies the whole prefix (old set below the
// activation, new set above it) through the state-bound schedule.
test("23 validator_update in the replayed tail: replay across the activation, then a later checkpoint verifies the prefix with both sets", { timeout: 600_000 }, async () => {
  const { publicKeyFromPrivate, addressFromPublicKey } = await mod("dist/src/crypto.js");
  const { createValidatorApproval, createValidatorSetUpdate } = await mod("dist/src/transaction.js");
  const { expectedValidator } = await mod("dist/src/block.js");
  const { isConsensusV6, signV6, votePayload, V6_COMMIT_VOTE_DOMAIN } = await mod("dist/src/consensus-v6.js");
  const keyByPub = new Map<string, string>();
  for (const name of await readdir(join(dir, "keys"))) {
    const privateKey = JSON.parse(await readFile(join(dir, "keys", name), "utf8")).privateKey;
    if (typeof privateKey === "string") keyByPub.set(publicKeyFromPrivate(privateKey), privateKey);
  }
  const fifthKey = randomBytes(32).toString("hex"); const fifthPub = publicKeyFromPrivate(fifthKey); keyByPub.set(fifthPub, fifthKey);
  const r = record();
  const producer = await cp.loadCheckpointChain(genesis, r);
  const current = producer.validatorsAt(producer.height + 1);
  for (const v of current) assert.ok(keyByPub.has(v.publicKey), "fixture holds every validator key");
  const txVersion = producer.protocolVersionAt(producer.height + 1) >= 3 ? 2 : 1;
  const sender = current[0];
  const nonce = (producer.getState().snapshot().accounts.find((a: { address: string }) => a.address === sender.address)?.nonce ?? 0) + 1;
  const activationHeight = producer.height + 1 + 100;
  const input = { chainId, nonce, sender: sender.address, activationHeight, validators: [...current, { address: addressFromPublicKey(fifthPub), publicKey: fifthPub }] };
  const approvals = current.map((v: { publicKey: string }) => createValidatorApproval(input, keyByPub.get(v.publicKey)!, v.publicKey, txVersion));
  const tx = createValidatorSetUpdate({ ...input, approvals, timestampMs: producer.tip.header.timestampMs + 1 }, keyByPub.get(sender.publicKey)!, sender.publicKey, txVersion);
  const tail: unknown[] = [];
  const t0 = Math.max(producer.tip.header.timestampMs, Date.now() - 60_000);
  const produce = (txs: unknown[]) => {
    const height = producer.height + 1; const set = producer.validatorsAt(height);
    const at = t0 + (height - r.height) * 20;
    let block = producer.produceBlock(txs, keyByPub.get(expectedValidator(set, height, 0).publicKey)!, { timestampMs: at });
    if (isConsensusV6(block.header.version)) {
      // v6 finality: commit-domain votes for round 0, as the live validators sign them.
      block = { ...block, commitRound: 0, attestations: set.map((v: { address: string; publicKey: string }) => ({ validator: v.address, publicKey: v.publicKey, signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(chainId, height, 0, block.hash), keyByPub.get(v.publicKey)!) })) };
    } else for (const v of set) block = producer.attestBlock(block, keyByPub.get(v.publicKey)!);
    producer.acceptBlock(block, at); tail.push(block);
  };
  produce([tx]);
  while (producer.height < activationHeight + 3) produce([]);
  assert.equal(producer.validatorsAt(producer.height).length, current.length + 1, "the update activated");

  // Restart path: load the checkpoint, prefix check, acceptBlock replay of the tail.
  const chain = await cp.loadCheckpointChain(genesis, r);
  const v = cp.createPrefixVerifier(chain, genesis, r); for (const b of blocks().slice(0, r.height)) v.check(b); v.done();
  for (const b of tail) chain.acceptBlock(structuredClone(b), Date.now());
  assert.equal(chain.tip.hash, producer.tip.hash);
  assert.equal(chain.validatorsAt(chain.height).length, current.length + 1);
  cp.checkChainSupply(chain, genesis);

  // A checkpoint after the activation: its schedule verifies the old prefix and the new-set blocks.
  const all = [...blocks().slice(0, r.height), ...tail] as any[];
  let running = (await mod("scripts/open-testnet/history-file.mjs")).historySeed(genesisHash);
  const hf = await mod("scripts/open-testnet/history-file.mjs");
  for (const b of all) running = hf.nextRunningHash(running, JSON.stringify(b));
  const later = cp.decodeCheckpoint(encode({ chainId, genesisHash, height: chain.height, tipHash: chain.tip.hash, historyRunningHash: running, historyLine: JSON.stringify(all.at(-1)), state: chain.snapshot() }), ids());
  const loaded = await cp.loadCheckpointChain(genesis, later);
  const run = (list: unknown[]) => { const w = cp.createPrefixVerifier(loaded, genesis, later); for (const b of list) w.check(b); w.done(); };
  run(all);
  const forged = structuredClone(all); forged.at(-2).attestations[0].signature = "00".repeat(64);
  assert.throws(() => run(forged), new RegExp(`prefix block ${later.height - 1} rejected`));
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

// Security Low at 39b75f29: a FIFO swapped in after the boot scan, a worker
// that never answers, and the start gate on cgroup memory.
test("28 prefix worker: a FIFO at the history path does not hang open(); it is a file error and the caller falls back", { timeout: 60_000 }, async () => {
  const f = await workerFixture();
  try {
    await rm(f.options.historyPath); execFileSync("mkfifo", ["-m", "600", f.options.historyPath]);
    const t = Date.now(); const job = pw.startPrefixWorker(f.options);
    let why = ""; const result = await pw.awaitPrefixResult(job, { deadlineMs: performance.now() + 30_000, onFallback: (w: string) => { why = w; } });
    assert.equal(result, undefined); assert.match(why, /file error: history path is not a regular file/);
    assert.ok(Date.now() - t < 20_000, "no hang");
  } finally { await rm(f.d, { recursive: true, force: true }); }
});
test("29 prefix worker timeout: a result that never comes is cancelled at the deadline and the caller falls back", async () => {
  let cancelled = 0; const job = { result: new Promise(() => {}), cancel: () => { cancelled += 1; } };
  let why = ""; const t = performance.now();
  assert.equal(await pw.awaitPrefixResult(job, { deadlineMs: t + 50, onFallback: (w: string) => { why = w; } }), undefined);
  assert.equal(cancelled, 1); assert.match(why, /timed out/);
  assert.equal(pw.prefixWorkerTimeoutMs(13_420), 241_560, "about 3x the ~79 s measured");
  assert.equal(pw.prefixWorkerTimeoutMs(100), pw.PREFIX_WORKER_MIN_TIMEOUT_MS);
  assert.equal(pw.prefixWorkerTimeoutMs(100, 5), 5);
  // A cancellation (shutdown) is rethrown, not a fallback.
  await assert.rejects(pw.awaitPrefixResult({ result: Promise.reject(Object.assign(new Error("c"), { cancelled: true })), cancel() {} }, { deadlineMs: performance.now() + 1_000 }), /c/);
});
test("30 memory gate: memory.current below ~400 MB opens it; unreadable cgroup counts as open", async () => {
  assert.equal(pw.PREFIX_WORKER_MEMORY_LIMIT_BYTES, 400 * 1024 * 1024);
  assert.equal(pw.prefixMemoryGateOpen(399 * 1024 * 1024), true);
  assert.equal(pw.prefixMemoryGateOpen(400 * 1024 * 1024), false);
  assert.equal(pw.prefixMemoryGateOpen(undefined), true);
  const fake = (files: Record<string, string>) => async (path: string) => { if (path in files) return files[path]; throw new Error("ENOENT"); };
  assert.equal(await pw.readCgroupMemoryCurrent({ readFileImpl: fake({ "/proc/self/cgroup": "0::/zm1\n", "/sys/fs/cgroup/zm1/memory.current": "123456\n" }) }), 123456);
  assert.equal(await pw.readCgroupMemoryCurrent({ readFileImpl: fake({}) }), undefined);
});
test("31 FIFO swapped in after the boot scan (end to end): the worker does not hang, the prefix is checked serially, the checkpoint is used", { timeout: 600_000 }, async () => {
  await restoreGood();
  const real = `${historyPath}.real`; let swapped = false;
  await restart({ beforePrefixWorker: async (path: string) => { if (swapped) return; swapped = true; await import("node:fs/promises").then((fs) => fs.rename(path, real)); execFileSync("mkfifo", ["-m", "600", path]); } });
  try {
    await until("worker file error", () => logs.find((l) => /prefix worker failed \(file error: history path is not a regular file\); checking the prefix here/.test(l)) || logs.find((l) => /finished .*file error/.test(l)), 120_000);
  } finally { if (swapped) { await rm(historyPath, { force: true }); await import("node:fs/promises").then((fs) => fs.rename(real, historyPath)); } }
  const matched = await until("checkpoint matched", () => logs.find((l) => /matches the live chain/.test(l))) as string;
  assert.match(matched, /prefix checked here/);
  assert.ok(!fellBack(), logs.join("\n"));
  await stop();
});
test("32 worker timeout and memory gate (end to end): the worker waits while memory.current is high; a worker that times out is cancelled and the serial check accepts the checkpoint", { timeout: 900_000 }, async () => {
  const MB = 1024 * 1024; const at = (re: RegExp) => logs.findIndex((l) => re.test(l));
  // Memory gate: memory.current stays at 450 MB, so no worker ever starts;
  // the checkpoint is still accepted through the serial check.
  await restoreGood();
  let calls = 0;
  await restart({ memoryCurrent: async () => { calls += 1; return 450 * MB; } });
  let matched = await until("checkpoint matched", () => logs.find((l) => /matches the live chain/.test(l))) as string;
  assert.ok(at(/prefix worker waiting for memory \(cgroup memory.current 450 MB\)/) >= 0, logs.join("\n"));
  assert.ok(calls >= 1); assert.equal(at(/prefix worker started/), -1, "no worker above the limit");
  assert.match(matched, /prefix checked here/); assert.ok(!fellBack());
  await stop();
  // Timeout: the worker is cancelled at its deadline and the serial check runs.
  await restoreGood();
  // A worker that never answers (as one stuck in open() would).
  let cancels = 0;
  await restart({ prefixTimeoutMs: 2_000, prefixWorkerFactory: () => { let live = true; return { result: new Promise(() => {}), running: () => live, startedAt: performance.now(), elapsedMs: () => 0, cancel: () => { cancels += 1; live = false; } }; } });
  matched = await until("checkpoint matched", () => logs.find((l) => /matches the live chain/.test(l))) as string;
  assert.ok(at(/prefix worker started/) >= 0);
  assert.ok(at(/timed out and was cancelled; checking the prefix here/) >= 0, logs.join("\n"));
  assert.ok(cancels >= 1, "the stuck worker was cancelled");
  assert.match(matched, /prefix checked here/); assert.ok(!fellBack());
  await stop();
});
test("33 shutdown while the checkpoint is being checked keeps the good checkpoint and starts no rebuild", { timeout: 600_000 }, async () => {
  await restoreGood();
  await restart({ memoryCurrent: async () => 0 });
  await until("worker started", () => logs.find((l) => /prefix worker started/.test(l)), 120_000);
  await stop();
  assert.ok(!logs.some((l) => /rebuilding the history file|checkpoint not used/.test(l)), logs.join("\n"));
  assert.ok((await readFile(checkpointPath)).length > 0, "checkpoint kept");
  assert.ok(cp.decodeCheckpoint(await readFile(checkpointPath), ids()).height >= record().height);
});
