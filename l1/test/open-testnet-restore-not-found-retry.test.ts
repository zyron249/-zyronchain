// Open TESTNET cold start while a keeper replaces the published snapshot: the
// release asset is briefly missing (404) between deleting the old asset and
// uploading or renaming the new one. A transient 404 must be retried and the
// published chain restored; only a snapshot that stays missing may create a
// fresh TEST genesis.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(l1Root, "scripts", "open-testnet.mjs");
const CHAIN_ID = "zyron-restore-404-testnet-1";
const MAGIC = "ZYRON-OPEN-TESTNET-STATE-V1";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const api: any = await import(pathToFileURL(script).href);

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

// Serves 404 for the first `missing` requests, then the snapshot.
async function startHost(root: string, secret: string, missing: number, sealed: Buffer) {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    requests += 1;
    if (requests <= missing) { response.writeHead(404, { "content-type": "text/plain" }); response.end("Not Found"); return; }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": sealed.length });
    response.end(sealed);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const snapshotPort = (server.address() as { port: number }).port;
  // 29000-32599: disjoint from the other open-testnet tests (21000-28999), which
  // run concurrently in the same `node --test` invocation, and below the Linux
  // ephemeral port range.
  const basePort = 29_000 + Math.floor(Math.random() * 900) * 4;
  const child: ChildProcess = spawn(process.execPath, [script, "run", "--dir", join(root, "hosted"), "--host", "127.0.0.1", "--port", "0", "--init-if-missing",
    "--chain-id", CHAIN_ID, "--validator-base-port", String(basePort), "--restore-url", `http://127.0.0.1:${snapshotPort}/state.enc`], {
    cwd: l1Root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZYRON_TESTNET_STATE_SECRET: secret, PORT: "" }
  });
  const state = { log: "", requests: () => requests, child, server };
  child.stdout!.on("data", (c) => { state.log += c; });
  child.stderr!.on("data", (c) => { state.log += c; });
  return state;
}

async function stop(host: { child: ChildProcess; server: Server } | undefined): Promise<void> {
  if (!host) return;
  const { child, server } = host;
  if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), sleep(15_000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
  server.close();
}

async function servedStatus(host: { log: string }): Promise<any> {
  const port = await until("gateway listening line", async () => Number(/gateway listening on 127\.0\.0\.1:(\d+)/.exec(host.log)?.[1] ?? 0) || false, 30_000);
  return until("status served", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(10_000) });
    return response.status === 200 ? response.json() : false;
  }, 420_000);
}

// The retry schedule itself is checked in-process with an injected clock, so the
// suite does not wait the real 160 s (CI runners have a job time limit).
function fakeHost(statuses: Array<number | "error">) {
  const calls: string[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  let attempts = 0;
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (status === "error") throw new Error("connection reset");
    return new Response(status === 200 ? "sealed" : "Not Found", { status });
  };
  const options = { fetchImpl, sleepImpl: async (ms: number) => { waits.push(ms); }, onAttempt: () => { attempts += 1; }, log: (line: string) => { logs.push(line); } };
  return { calls, waits, logs, options, attempts: () => attempts };
}

test("the 404 retry schedule spans 160 s and is separate from the transient-failure schedule", () => {
  assert.deepEqual(api.SNAPSHOT_NOT_FOUND_RETRY_DELAYS_MS, [3_000, 7_000, 15_000, 30_000, 45_000, 60_000]);
  assert.equal(api.SNAPSHOT_NOT_FOUND_RETRY_DELAYS_MS.reduce((a: number, b: number) => a + b, 0), 160_000);
  assert.deepEqual(api.SNAPSHOT_DOWNLOAD_RETRY_DELAYS_MS, [2_000, 5_000]);
  // Every single wait stays far below the 5-minute start-up stall limit.
  for (const ms of api.SNAPSHOT_NOT_FOUND_RETRY_DELAYS_MS) assert.ok(ms < api.BOOT_STALL_MS / 2);
});

test("a transient 404 is retried until the published snapshot is back", async () => {
  const host = fakeHost([404, 404, 404, 404, 200]);
  const response = await api.downloadSnapshot("https://example.invalid/state.enc", host.options);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "sealed");
  assert.equal(host.calls.length, 5);
  assert.deepEqual(host.waits, [3_000, 7_000, 15_000, 30_000]);
  assert.equal(host.attempts(), 5, "start-up progress is reported before every attempt");
  assert.equal(host.logs.filter((line) => /returned 404; retrying/.test(line)).length, 4);
});

test("a snapshot that stays missing returns 404 only after the full 160 s schedule", async () => {
  const host = fakeHost([404]);
  const response = await api.downloadSnapshot("https://example.invalid/state.enc", host.options);
  assert.equal(response.status, 404);
  assert.equal(host.calls.length, 7, "one request plus six 404 retries");
  assert.deepEqual(host.waits, [3_000, 7_000, 15_000, 30_000, 45_000, 60_000]);
});

test("404 retries do not use up the transient-failure retries, and vice versa", async () => {
  const mixed = fakeHost([503, 404, 404, "error", 404, 200]);
  const response = await api.downloadSnapshot("https://example.invalid/state.enc", mixed.options);
  assert.equal(response.status, 200);
  assert.deepEqual(mixed.waits, [2_000, 3_000, 7_000, 5_000, 15_000]);
  // Transient failures still stop after two retries: the third 5xx is returned
  // (a failed restore), the third network error is thrown.
  const failing = fakeHost([500]);
  assert.equal((await api.downloadSnapshot("https://example.invalid/state.enc", failing.options)).status, 500);
  assert.deepEqual(failing.waits, [2_000, 5_000]);
  const unreachable = fakeHost(["error"]);
  await assert.rejects(api.downloadSnapshot("https://example.invalid/state.enc", unreachable.options), /connection reset/);
  assert.equal(unreachable.calls.length, 3);
});

test("a cold start retries a transient 404 and restores the published chain", { timeout: 360_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-restore-404-"));
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const secret = randomBytes(32).toString("base64");
    const { sealed, genesisHash } = await sealedNetwork(root, secret);
    // End to end through the CLI: one 404 (a 3 s wait), then the snapshot.
    host = await startHost(root, secret, 1, sealed);
    const status = await servedStatus(host);
    assert.equal(status.genesisHash, genesisHash);
    assert.equal(status.persistence.mode, "snapshot-restore");
    assert.equal(status.persistence.restoredHeight, 100);
    assert.equal(host.requests(), 2);
    assert.equal((host.log.match(/snapshot download returned 404; retrying/g) ?? []).length, 1);
    assert.doesNotMatch(host.log, /STATE RESTORE FAILED|fresh TEST genesis/);
  } finally {
    await stop(host);
    await rm(root, { recursive: true, force: true });
  }
});
