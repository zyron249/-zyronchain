// Codex review of the boot-liveness watchdog: once a stalled start-up answers
// 503, the host may restart the process in place. A restore or fresh init that
// was interrupted leaves the network directory without network.json (both write
// it last). The next start must clean that partial directory and restore the
// published snapshot again, not fall back to a fresh TEST genesis. Nothing is
// deleted: the partial directory is moved aside, and a directory with top-level
// entries the open testnet does not create is refused and left untouched.
// A network.json torn by a crash while it was written, or one that does not
// describe the directory's genesis (Codex review), is not a completion marker:
// that directory is moved aside and restored again too.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(l1Root, "scripts", "open-testnet.mjs");
const CHAIN_ID = "zyron-interrupted-restore-testnet-1";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(script).href);

// Builds a source network, serves its sealed snapshot on loopback and returns
// what a restarted host needs to restore it.
async function publishSnapshot(root: string) {
  const source = join(root, "source");
  await runToExit(["init", "--dir", source, "--chain-id", CHAIN_ID]);
  const genesis = JSON.parse(await readFile(join(source, "genesis.json"), "utf8"));
  const network = JSON.parse(await readFile(join(source, "network.json"), "utf8"));
  const keys: Record<string, string> = {};
  for (const file of await readdir(join(source, "keys"))) keys[file.replace(/\.json$/, "")] = JSON.parse(await readFile(join(source, "keys", file), "utf8")).privateKey;
  const blocks = (await readFile(join(source, "data-v1", "blocks.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const secret = randomBytes(32).toString("base64");
  const sealed = seal({ format: MAGIC, createdAtMs: Date.now(), genesis, network, keys, blocks }, secret);
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/octet-stream", "content-length": sealed.length }); response.end(sealed); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { source, network, secret, server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/state.enc` };
}

function startHosted(target: string, published: { secret: string; url: string }) {
  const basePort = 23_000 + Math.floor(Math.random() * 1_000) * 4;
  const child = spawn(process.execPath, [script, "run", "--dir", target, "--host", "127.0.0.1", "--port", "0", "--init-if-missing",
    "--chain-id", CHAIN_ID, "--validator-base-port", String(basePort), "--restore-url", published.url], {
    cwd: l1Root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZYRON_TESTNET_STATE_SECRET: published.secret, PORT: "" }
  });
  const output = { log: "" };
  child.stdout!.on("data", (c) => { output.log += c; });
  child.stderr!.on("data", (c) => { output.log += c; });
  return { child, output };
}

async function stop(child: ChildProcess | undefined) {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), sleep(15_000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
}

test("an interrupted restore leaves a partial directory; the next start removes it and restores the snapshot", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-interrupted-restore-"));
  let child: ChildProcess | undefined;
  let snapshotServer: Server | undefined;
  try {
    const published = await publishSnapshot(root);
    snapshotServer = published.server;
    const { source, network } = published;

    // What a restore interrupted during replay leaves behind: keys, genesis and
    // the first validator's partially written data, but no network.json.
    const target = join(root, "hosted");
    await mkdir(target, { mode: 0o700 });
    await cp(join(source, "keys"), join(target, "keys"), { recursive: true });
    await cp(join(source, "genesis.json"), join(target, "genesis.json"));
    await cp(join(source, "data-v1"), join(target, "data-v1"), { recursive: true });

    const hosted = startHosted(target, published);
    child = hosted.child;
    const port = await until("gateway listening line", async () => Number(/gateway listening on 127\.0\.0\.1:(\d+)/.exec(hosted.output.log)?.[1] ?? 0) || false, 30_000);
    const status = await until("chain served", async () => {
      const response = await json(`http://127.0.0.1:${port}/status`);
      return response.status === 200 ? response.body : false;
    }, 180_000);
    const log = hosted.output.log;
    assert.equal(status.persistence.mode, "snapshot-restore", log);
    assert.equal(status.persistence.restoredHeight, 100);
    assert.equal(status.genesisHash, network.genesisHash);
    assert.doesNotMatch(log, /STATE RESTORE FAILED|fresh TEST genesis/);
    assert.match(log, /moved an incomplete network directory left by an interrupted start-up to .*hosted\.incomplete-/);
    assert.ok((await readdir(root)).some((name) => name.startsWith("hosted.incomplete-")), "partial directory kept aside");
    for (const name of ["v1", "v2", "v3", "v4"]) await access(join(target, `data-${name}`, "recovery-checkpoint.json"));
  } finally {
    await stop(child);
    snapshotServer?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a network.json torn by a crash is not a completion marker; the next start moves the directory aside and restores the snapshot", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-torn-marker-"));
  let child: ChildProcess | undefined;
  let snapshotServer: Server | undefined;
  try {
    const published = await publishSnapshot(root);
    snapshotServer = published.server;
    const { source, network } = published;

    // A full network directory whose network.json was cut short (process
    // killed or disk full while it was written).
    const target = join(root, "hosted");
    await cp(source, target, { recursive: true });
    const marker = await readFile(join(target, "network.json"));
    const tornLength = Math.floor(marker.length / 2);
    await truncate(join(target, "network.json"), tornLength);

    const hosted = startHosted(target, published);
    child = hosted.child;
    const port = await until("gateway listening line", async () => Number(/gateway listening on 127\.0\.0\.1:(\d+)/.exec(hosted.output.log)?.[1] ?? 0) || false, 30_000);
    const status = await until("chain served or start-up crashed", async () => {
      if (child!.exitCode !== null) return { exitedWith: child!.exitCode };
      const response = await json(`http://127.0.0.1:${port}/status`);
      return response.status === 200 ? response.body : false;
    }, 180_000);
    const log = hosted.output.log;
    assert.equal(status.exitedWith, undefined, `start-up crashed on the torn network.json:\n${log}`);
    assert.equal(status.persistence.mode, "snapshot-restore", log);
    assert.equal(status.persistence.restoredHeight, 100);
    assert.equal(status.genesisHash, network.genesisHash);
    assert.doesNotMatch(log, /STATE RESTORE FAILED|fresh TEST genesis/);
    assert.match(log, /moved an incomplete network directory left by an interrupted start-up to .*hosted\.incomplete-/);
    const aside = (await readdir(root)).find((name) => name.startsWith("hosted.incomplete-"));
    assert.ok(aside, "torn directory kept aside");
    assert.ok((await readFile(join(root, aside, "hosted", "network.json"))).equals(marker.subarray(0, tornLength)), "torn marker preserved, not deleted");
    assert.deepEqual(JSON.parse(await readFile(join(target, "network.json"), "utf8")), network);
    await assert.rejects(access(join(target, "network.json.partial")), { code: "ENOENT" });
  } finally {
    await stop(child);
    snapshotServer?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("move-aside treats an unparsable or partial marker as incomplete and never replaces an existing path", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-marker-dir-"));
  const realNow = Date.now;
  try {
    const torn = join(root, "torn");
    await mkdir(join(torn, "keys"), { recursive: true });
    await writeFile(join(torn, "network.json"), '{"network":"testnet","genesisHa');
    await writeFile(join(torn, "network.json.partial"), "{");
    const tornAside = await api.moveAsideIncompleteNetworkDir(torn);
    assert.match(String(tornAside), /torn\.incomplete-\d+-\d+\/torn$/);
    await access(join(tornAside, "network.json.partial"));

    // A marker that parses but is not a network description is not complete either.
    const wrongShape = join(root, "wrong-shape");
    await mkdir(wrongShape);
    await writeFile(join(wrongShape, "network.json"), "[]");
    assert.ok(await api.moveAsideIncompleteNetworkDir(wrongShape));

    // Same millisecond and process: an existing (even empty) directory at the
    // first candidate name is never replaced; the directory is moved into a
    // freshly reserved holder under its own name.
    const fixed = realNow();
    Date.now = () => fixed;
    const partial = join(root, "partial");
    await mkdir(join(partial, "keys"), { recursive: true });
    const taken = `${partial}.incomplete-${fixed}-${process.pid}`;
    await mkdir(taken);
    const takenInode = (await lstat(taken)).ino;
    const aside = await api.moveAsideIncompleteNetworkDir(partial);
    assert.equal(aside, join(`${taken}-1`, "partial"));
    assert.equal((await lstat(taken)).ino, takenInode, "existing destination replaced");
    assert.deepEqual(await readdir(taken), []);
    await access(join(aside, "keys"));
  } finally {
    Date.now = realNow;
    await rm(root, { recursive: true, force: true });
  }
});

test("a marker the gateway cannot run with, or one for another genesis, is not a completion marker (Codex review)", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-marker-consistency-"));
  try {
    // A real network is complete and stays where it is.
    const complete = join(root, "complete");
    await api.initNetwork(complete, CHAIN_ID);
    const network = JSON.parse(await readFile(join(complete, "network.json"), "utf8"));
    assert.equal(await api.moveAsideIncompleteNetworkDir(complete), false);
    await access(join(complete, "network.json"));

    // A marker the gateway cannot run with (no faucet address), or one that does
    // not describe this directory's genesis, is not a completion marker.
    const { faucetAddress: _dropped, ...withoutFaucet } = network;
    const noFaucet = join(root, "no-faucet");
    await cp(complete, noFaucet, { recursive: true });
    await rm(join(noFaucet, "network.json"));
    await writeFile(join(noFaucet, "network.json"), JSON.stringify(withoutFaucet));
    assert.ok(await api.moveAsideIncompleteNetworkDir(noFaucet), "marker without faucetAddress accepted as complete");
    const otherGenesis = join(root, "other-genesis");
    await cp(complete, otherGenesis, { recursive: true });
    await rm(join(otherGenesis, "network.json"));
    await writeFile(join(otherGenesis, "network.json"), JSON.stringify({ ...network, genesisHash: "ab".repeat(32) }));
    assert.ok(await api.moveAsideIncompleteNetworkDir(otherGenesis), "marker for another genesis accepted as complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incomplete directory is moved aside (never deleted), a foreign or complete directory is left untouched", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-incomplete-dir-"));
  try {
    assert.equal(await api.moveAsideIncompleteNetworkDir(join(root, "missing")), false);

    const partial = join(root, "partial");
    await mkdir(join(partial, "keys"), { recursive: true });
    await mkdir(join(partial, "data-v1"));
    await writeFile(join(partial, "genesis.json"), "{}");
    // Even an unexpected file nested inside a recognised directory survives.
    await writeFile(join(partial, "keys", "operator-note.txt"), "kept");
    const aside = await api.moveAsideIncompleteNetworkDir(partial);
    assert.match(String(aside), /partial\.incomplete-\d+-\d+\/partial$/);
    await assert.rejects(access(partial), { code: "ENOENT" });
    assert.equal(await readFile(join(aside, "keys", "operator-note.txt"), "utf8"), "kept");
    await access(join(aside, "genesis.json"));

    const foreign = join(root, "foreign");
    await mkdir(join(foreign, "keys"), { recursive: true });
    await writeFile(join(foreign, "notes.txt"), "not created by the open testnet");
    await assert.rejects(api.moveAsideIncompleteNetworkDir(foreign), /refusing to move .*notes\.txt/);
    await access(join(foreign, "notes.txt"));
    await access(join(foreign, "keys"));

    const complete = join(root, "complete");
    await api.initNetwork(complete, CHAIN_ID);
    assert.equal(await api.moveAsideIncompleteNetworkDir(complete), false);
    await access(join(complete, "network.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
