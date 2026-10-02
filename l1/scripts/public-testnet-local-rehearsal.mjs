#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const plan = {
  label: "LOCAL MULTIPROCESS REHEARSAL",
  realRegions: false,
  chainId: "zyron-local-multiprocess-rehearsal",
  validators: 3,
  bootstraps: 3,
  publicRpcRole: "covered by in-process public-role tests; this boot uses loopback validator RPC only",
  protocolGenesis: 1,
  protocolV5DelayBlocks: 100,
  publicMiningActivated: false
};

if (args.includes("--plan") || args.length === 0) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}
if (!args.includes("--boot-check")) {
  console.error("Usage: public-testnet-local-rehearsal --plan | --boot-check");
  process.exit(1);
}
if (process.platform === "win32") {
  console.error("Boot check needs POSIX directory fsync.");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/src/secure-cli.js");
const directory = await mkdtemp(join(tmpdir(), "zyron-local-multiprocess-"));
await chmod(directory, 0o700);
const secretDirectory = join(directory, "secrets");
await mkdir(secretDirectory, { mode: 0o700 });
const children = [];

function command(name, argv) {
  return execFileSync(process.execPath, [cli, ...argv], {
    cwd: directory,
    env: { ...process.env, ZYRON_KEYSTORE_PASSWORD_FILE: join(secretDirectory, `${name}.password`) },
    encoding: "utf8",
    timeout: 30_000
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

try {
  const names = ["a", "b", "c", "oracle"];
  const keys = {};
  for (const name of names) {
    const passwordFile = join(secretDirectory, `${name}.password`);
    await writeFile(passwordFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    command(name, ["keygen", "--out", join(secretDirectory, `${name}.json`), "--password-file", passwordFile]);
    keys[name] = JSON.parse(await readFile(join(secretDirectory, `${name}.json`), "utf8"));
    if (Object.hasOwn(keys[name], "privateKey")) throw new Error("Keygen printed a private key field");
  }
  command("a", [
    "genesis", "--out", join(directory, "genesis.json"),
    "--chain-id", plan.chainId,
    "--timestamp-ms", "1700000000000",
    "--validator-public-key", keys.a.publicKey,
    "--validator-public-key", keys.b.publicKey,
    "--validator-public-key", keys.c.publicKey,
    "--oracle-public-key", keys.oracle.publicKey,
    "--activity-pool", keys.oracle.address,
    "--allocation", `${keys.oracle.address}:0`
  ]);
  const ports = [await freePort(), await freePort(), await freePort()];
  for (const [index, name] of ["a", "b", "c"].entries()) {
    const peers = ports.filter((_, peerIndex) => peerIndex !== index).map((port) => `http://127.0.0.1:${port}`);
    const child = spawn(process.execPath, [
      cli, "node",
      "--genesis", join(directory, "genesis.json"),
      "--data", join(directory, `data-${name}`),
      "--validator-key", join(secretDirectory, `${name}.json`),
      "--host", "127.0.0.1",
      "--port", String(ports[index]),
      ...peers.flatMap((peer) => ["--peer", peer])
    ], {
      cwd: directory,
      env: { ...process.env, ZYRON_KEYSTORE_PASSWORD_FILE: join(secretDirectory, `${name}.password`) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
  }
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const statuses = await Promise.all(ports.map(async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (response.status !== 200) throw new Error(`health ${response.status}`);
        const status = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) });
        return status.json();
      }));
      if (statuses.every((status) => status.chainId === plan.chainId && status.genesisHash === statuses[0].genesisHash)) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
    }
  }
  if (!ready) throw new Error("LOCAL MULTIPROCESS REHEARSAL boot check did not see three matching loopback validators");
  process.stdout.write(`${JSON.stringify({ ...plan, bootCheck: "pass", host: "127.0.0.1", ports }, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => new Promise((resolveClose) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolveClose(); }, 5000);
    child.once("close", () => { clearTimeout(timer); resolveClose(); });
  })));
  await rm(directory, { recursive: true, force: true });
}
