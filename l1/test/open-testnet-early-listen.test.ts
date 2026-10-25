// Open TESTNET start-up on a platform with a port scan (Render free plan): the
// gateway must bind its port before the sealed snapshot is downloaded,
// decrypted and replayed, answer GET /health 200 {status:"starting", phase}
// meanwhile, keep every RPC endpoint (and /readyz) at 503 until the validators
// serve, and then continue the restored chain (same genesis, same height),
// not a fresh genesis.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { allocateValidatorBasePort } from "./helpers/open-testnet-ports.js";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(l1Root, "scripts", "open-testnet.mjs");
const CHAIN_ID = "zyron-early-listen-testnet-1";
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

async function runToExit(args: string[]): Promise<string> {
  const child = spawn(process.execPath, [script, ...args], { cwd: l1Root, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, out);
  return out;
}

async function json(url: string): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, headers: response.headers, body: await response.json() };
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

test("open testnet binds its port before snapshot restore and resumes the restored chain", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-early-listen-"));
  let child: ChildProcess | undefined;
  let snapshotServer: Server | undefined;
  try {
    // A real 100-block v6-prefix network to snapshot.
    const source = join(root, "source");
    await runToExit(["init", "--dir", source, "--chain-id", CHAIN_ID]);
    const genesis = JSON.parse(await readFile(join(source, "genesis.json"), "utf8"));
    const network = JSON.parse(await readFile(join(source, "network.json"), "utf8"));
    const keys: Record<string, string> = {};
    for (const file of await readdir(join(source, "keys"))) keys[file.replace(/\.json$/, "")] = JSON.parse(await readFile(join(source, "keys", file), "utf8")).privateKey;
    const blocks = (await readFile(join(source, "data-v1", "blocks.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(blocks.length, 100);
    const secret = randomBytes(32).toString("base64");
    const sealed = seal({ format: MAGIC, createdAtMs: Date.now(), genesis, network, keys, blocks }, secret);

    // Snapshot host: first request fails transiently (503, must be retried);
    // the second is held until the test has observed the "starting" phase.
    let requests = 0;
    let release!: () => void;
    const released = new Promise<void>((done) => { release = done; });
    snapshotServer = createServer((request, response) => {
      requests += 1;
      if (requests === 1) { response.writeHead(503); response.end(); return; }
      void released.then(() => { response.writeHead(200, { "content-type": "application/octet-stream", "content-length": sealed.length }); response.end(sealed); });
    });
    snapshotServer.listen(0, "127.0.0.1");
    await once(snapshotServer, "listening");
    const snapshotPort = (snapshotServer.address() as { port: number }).port;

    const target = join(root, "hosted");
    const basePort = await allocateValidatorBasePort("early-listen");
    child = spawn(process.execPath, [script, "run", "--dir", target, "--host", "127.0.0.1", "--port", "0", "--init-if-missing",
      "--chain-id", CHAIN_ID, "--validator-base-port", String(basePort), "--restore-url", `http://127.0.0.1:${snapshotPort}/state.enc`], {
      cwd: l1Root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZYRON_TESTNET_STATE_SECRET: secret, PORT: "" }
    });
    let log = "";
    child.stdout!.on("data", (c) => { log += c; });
    child.stderr!.on("data", (c) => { log += c; });
    const port = await until("gateway listening line", async () => Number(/gateway listening on 127\.0\.0\.1:(\d+)/.exec(log)?.[1] ?? 0) || false, 30_000);
    const base = `http://127.0.0.1:${port}`;

    // The port answers while the snapshot download is still pending.
    await until("snapshot download held", async () => requests >= 2, 30_000);
    const health = await json(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "starting");
    assert.equal(health.body.phase, "download");
    assert.equal(health.body.valueBearing, false);
    const ready = await json(`${base}/readyz`);
    assert.equal(ready.status, 503);
    for (const path of ["/status", "/api", "/blocks", "/state/snapshot"]) {
      const response = await json(`${base}${path}`);
      assert.equal(response.status, 503, `${path} must wait for the validators`);
      assert.equal(response.body.status, "starting");
      assert.equal(response.headers.get("retry-after"), "10");
    }
    const post = await fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(post.status, 503);
    await post.arrayBuffer();
    assert.doesNotMatch(log, /STATE RESTORE FAILED|fresh TEST genesis/);

    release();
    const status = await until("restored chain served", async () => {
      const response = await json(`${base}/status`);
      return response.status === 200 ? response.body : false;
    }, 180_000);
    assert.equal(status.genesisHash, network.genesisHash);
    assert.equal(status.persistence.mode, "snapshot-restore");
    assert.equal(status.persistence.restoredHeight, 100);
    assert.ok(status.height >= 100, `restored height ${status.height} must continue from the snapshot`);
    await until("quorum ready", async () => (await json(`${base}/readyz`)).status === 200, 120_000);
    const live = await json(`${base}/health`);
    assert.equal(live.status, 200);
    assert.equal(live.body.status, "ready");
    assert.equal(live.body.persistence.mode, "snapshot-restore");

    // One validated replay; the other validators open the verified checkpoint.
    for (const name of ["v1", "v2", "v3", "v4"]) await access(join(target, `data-${name}`, "recovery-checkpoint.json"));
    await until("startup timing log", async () => /startup complete in \d+ms; phase timings/.test(log), 60_000);
    for (const phase of ["download", "decrypt", "replay", "validators"]) assert.match(log, new RegExp(`startup phase ${phase} done in \\d+ms`));
    assert.match(log, /snapshot download returned 503; retrying/);
    assert.doesNotMatch(log, /STATE RESTORE FAILED|fresh TEST genesis/);
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), sleep(15_000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
    snapshotServer?.close();
    await rm(root, { recursive: true, force: true });
  }
});
