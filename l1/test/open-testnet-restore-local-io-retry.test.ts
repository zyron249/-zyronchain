// Open TESTNET cold start (R37-1072-L1): a transient local filesystem I/O error
// while the downloaded snapshot is written to the instance's disk (EIO, EMFILE,
// ...) must not turn a valid published chain into a fresh TEST genesis. The
// restore is retried from the same verified bundle; if the local disk keeps
// failing, start-up stops without creating a new genesis.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(l1Root, "scripts", "open-testnet.mjs");
const CHAIN_ID = "zyron-restore-io-testnet-1";
const MAGIC = "ZYRON-OPEN-TESTNET-STATE-V1";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Independent re-implementation of the sealed snapshot format (pins it).
function seal(bundle: unknown, secret: string): Buffer {
  const key = createHash("sha256").update(`zyron-open-testnet-state\0${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(MAGIC));
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(bundle)))), cipher.final()]);
  return Buffer.concat([Buffer.from(`${MAGIC}\n`), iv, cipher.getAuthTag(), body]);
}

async function runToExit(args: string[]): Promise<void> {
  const child = spawn(process.execPath, [script, ...args], { cwd: l1Root, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, out);
}

async function until<T>(label: string, check: () => Promise<T | false | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function sealedNetwork(root: string, secret: string): Promise<{ sealed: Buffer; genesisHash: string }> {
  const source = join(root, "source");
  await runToExit(["init", "--dir", source, "--chain-id", CHAIN_ID]);
  const genesis = JSON.parse(await readFile(join(source, "genesis.json"), "utf8"));
  const network = JSON.parse(await readFile(join(source, "network.json"), "utf8"));
  const keys: Record<string, string> = {};
  for (const file of await readdir(join(source, "keys"))) keys[file.replace(/\.json$/, "")] = JSON.parse(await readFile(join(source, "keys", file), "utf8")).privateKey;
  const blocks = (await readFile(join(source, "data-v1", "blocks.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { sealed: seal({ format: MAGIC, createdAtMs: Date.now(), genesis, network, keys, blocks }, secret), genesisHash: network.genesisHash };
}

// Preloaded into the hosted process: the first `failures` exclusive creations
// of a validator copy (data-v2/blocks.ndjson, the restore's copy step) fail
// with EIO, as a flaky local disk would. Every other file operation is real.
const FAULT_PRELOAD = `
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
let left = Number(process.env.ZYRON_TEST_RESTORE_EIO_FAILURES || "0");
const realOpen = fsp.open;
fsp.open = async function open(path, flags, ...rest) {
  if (left > 0 && flags === "wx" && /data-v2[\\\\/]blocks\\.ndjson$/.test(String(path))) {
    left -= 1;
    console.error("[fault] injected EIO for " + String(path));
    throw Object.assign(new Error("EIO: i/o error, open '" + String(path) + "'"), { code: "EIO", errno: -5, syscall: "open", path: String(path) });
  }
  return realOpen.call(this, path, flags, ...rest);
};
syncBuiltinESMExports();
`;

async function startHost(root: string, secret: string, sealed: Buffer, failures: number) {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": sealed.length });
    response.end(sealed);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const snapshotPort = (server.address() as { port: number }).port;
  const preload = join(root, "fault-preload.mjs");
  await writeFile(preload, FAULT_PRELOAD);
  // 13000-16999: disjoint from the other open-testnet tests (19300-32599),
  // which run concurrently in the same \`node --test\` invocation.
  const basePort = 13_000 + Math.floor(Math.random() * 1_000) * 4;
  const child: ChildProcess = spawn(process.execPath, ["--import", pathToFileURL(preload).href, script, "run", "--dir", join(root, "hosted"), "--host", "127.0.0.1", "--port", "0", "--init-if-missing",
    "--chain-id", CHAIN_ID, "--validator-base-port", String(basePort), "--restore-url", `http://127.0.0.1:${snapshotPort}/state.enc`], {
    cwd: l1Root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZYRON_TESTNET_STATE_SECRET: secret, ZYRON_TEST_RESTORE_EIO_FAILURES: String(failures), PORT: "" }
  });
  const state = { log: "", requests: () => requests, child, server };
  child.stdout!.on("data", (c) => { state.log += c; });
  child.stderr!.on("data", (c) => { state.log += c; });
  return state;
}

async function stop(host: { child: ChildProcess; server: Server } | undefined): Promise<void> {
  if (!host) return;
  const { child, server } = host;
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), sleep(15_000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
  server.close();
}

async function servedStatus(host: { log: string }): Promise<any> {
  const port = await until("gateway listening line", async () => Number(/gateway listening on 127\.0\.0\.1:(\d+)/.exec(host.log)?.[1] ?? 0) || false, 30_000);
  return until("status served", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) return false;
    const status: any = await response.json();
    return status.phase === "ready" || status.genesisHash ? status : false;
  }, 420_000);
}

test("a cold start retries a transient local I/O error during the restore and restores the published chain (R37-1072-L1)", { timeout: 360_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-restore-eio-"));
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const secret = randomBytes(32).toString("base64");
    const { sealed, genesisHash } = await sealedNetwork(root, secret);
    host = await startHost(root, secret, sealed, 1);
    const status = await servedStatus(host);
    assert.match(host.log, /\[fault\] injected EIO/, "the fault must have been injected");
    assert.equal(status.genesisHash, genesisHash, host.log);
    assert.equal(status.persistence.mode, "snapshot-restore");
    assert.equal(status.persistence.restoredHeight, 100);
    assert.equal(host.requests(), 1, "the verified bundle is restored again without a second download");
    assert.doesNotMatch(host.log, /creating a fresh TEST genesis/);
  } finally {
    await stop(host);
    await rm(root, { recursive: true, force: true });
  }
});

test("a local disk that keeps failing during the restore stops start-up instead of creating a fresh TEST genesis (R37-1072-L1)", { timeout: 360_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-restore-eio-"));
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const secret = randomBytes(32).toString("base64");
    const { sealed } = await sealedNetwork(root, secret);
    host = await startHost(root, secret, sealed, 1_000);
    const running = host;
    const exited = once(running.child, "exit").then(([code]) => code);
    const outcome = await until("start-up to stop or to create a genesis", async () => {
      if (/creating a fresh TEST genesis/.test(running.log)) return "fresh-genesis";
      return running.child.exitCode !== null || running.child.signalCode !== null ? "exited" : false;
    }, 300_000);
    assert.doesNotMatch(running.log, /creating a fresh TEST genesis/);
    assert.equal(outcome, "exited");
    assert.notEqual(await exited, 0, running.log);
    assert.match(host.log, /STATE RESTORE FAILED/);
    // No completion marker: the next start (after the host restarts the
    // instance) downloads and restores the published snapshot again.
    await assert.rejects(readFile(join(root, "hosted", "network.json")), { code: "ENOENT" });
  } finally {
    await stop(host);
    await rm(root, { recursive: true, force: true });
  }
});

// The retry itself, in-process with an injected restore and clock.
const api: any = await import(pathToFileURL(script).href);
const eio = (path = "/x/data-v2/blocks.ndjson") => Object.assign(new Error(`EIO: i/o error, open '${path}'`), { code: "EIO", errno: -5, syscall: "open", path });

function fakeRestore(outcomes: Array<Error | "ok">) {
  const calls: string[] = [];
  const waits: number[] = [];
  const moved: string[] = [];
  const logs: string[] = [];
  const progress: string[] = [];
  const restore = async (dir: string) => {
    calls.push(dir);
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
    if (outcome !== "ok") throw outcome;
    return { chainId: "zyron-test", height: 100 };
  };
  const options = {
    restore,
    moveAside: async (dir: string) => { moved.push(dir); return `${dir}.incomplete-${moved.length}`; },
    sleepImpl: async (ms: number) => { waits.push(ms); },
    log: (line: string) => { logs.push(line); },
    onProgress: (event: { step: string }) => { progress.push(event.step); }
  };
  return { calls, waits, moved, logs, progress, options };
}

test("R37-1072-L1: the local restore retry schedule is short and far below the start-up stall limit", () => {
  assert.deepEqual(api.LOCAL_RESTORE_RETRY_DELAYS_MS, [2_000, 5_000]);
  for (const ms of api.LOCAL_RESTORE_RETRY_DELAYS_MS) assert.ok(ms < api.BOOT_STALL_MS / 2);
});

test("R37-1072-L1: a transient local I/O error is retried from the same bundle after moving the partial directory aside", async () => {
  const fake = fakeRestore([eio(), "ok"]);
  const bundle = { format: "bundle" };
  const result = await api.restoreNetworkWithLocalRetry("/net", bundle, "zyron-test", fake.options);
  assert.deepEqual(result, { chainId: "zyron-test", height: 100 });
  assert.deepEqual(fake.calls, ["/net", "/net"]);
  assert.deepEqual(fake.moved, ["/net"], "the partial directory is moved aside before the next attempt");
  assert.deepEqual(fake.waits, [2_000]);
  assert.ok(fake.progress.filter((step) => step === "local-io-retry").length >= 2, "start-up progress is reported around the wait");
  assert.equal(fake.logs.filter((line) => /local I\/O error \(EIO/.test(line)).length, 1);
});

test("R37-1072-L1: a disk that keeps failing ends as a localIo error after every attempt, never as a fresh-genesis error", async () => {
  const fake = fakeRestore([eio()]);
  await assert.rejects(api.restoreNetworkWithLocalRetry("/net", {}, "zyron-test", fake.options), (error: any) => {
    assert.equal(error.localIo, true);
    assert.match(error.message, /after 3 attempts: EIO/);
    assert.equal(error.cause.code, "EIO");
    return true;
  });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.waits, [2_000, 5_000]);
  assert.deepEqual(fake.moved, ["/net", "/net"]);
});

test("R37-1072-L1: errors about the snapshot itself are not retried and keep the existing fallback", async () => {
  const mismatch = new assert.AssertionError({ message: "snapshot genesis hash mismatch" });
  for (const error of [mismatch, new Error("restored v2 blocks.ndjson does not match the replayed log"), Object.assign(new Error("no syscall"), { code: "ERR_ASSERTION" })]) {
    const fake = fakeRestore([error, "ok"]);
    await assert.rejects(api.restoreNetworkWithLocalRetry("/net", {}, "zyron-test", fake.options), (thrown: any) => thrown === error && !thrown.localIo);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.waits, []);
    assert.deepEqual(fake.moved, []);
  }
});

test("R37-1072-L1: a system error wrapped as a cause counts as a local I/O error", async () => {
  assert.equal(api.isLocalIoError(eio()), true);
  assert.equal(api.isLocalIoError(new Error("wrapped", { cause: Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE", syscall: "open" }) })), true);
  assert.equal(api.isLocalIoError(new Error("plain")), false);
  assert.equal(api.isLocalIoError(undefined), false);
  assert.equal(api.isLocalIoError("EIO"), false);
  const fake = fakeRestore([new Error("store open failed", { cause: eio() }), "ok"]);
  assert.equal((await api.restoreNetworkWithLocalRetry("/net", {}, "zyron-test", fake.options)).height, 100);
  assert.equal(fake.calls.length, 2);
});
