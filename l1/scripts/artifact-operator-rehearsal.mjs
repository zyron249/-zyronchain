#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const l1Root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "zyron-artifact-operator-"));
const packDir = join(root, "pack");
const operatorDir = join(root, "operator");
const packageDir = join(operatorDir, "node_modules", "@zyronchain", "l1");
const cliPath = join(packageDir, "dist", "src", "cli.js");
const chainId = `zyron-artifact-operator-${process.pid}`;
// The rehearsal runs consensus protocol v6 (F-01 fix). Protocol v1 keeps the
// legacy F-01 round-timer split and stalls about half the time; that path stays
// covered by the informational local-devnet job. MIN_PROTOCOL_UPDATE_DELAY is
// 100 blocks, so heights 1-100 are pre-built offline with the installed
// artifact's own modules (block 1 carries the quorum-approved upgrade) and v6
// is active from height 101 for every block the validators finalize.
const V6_ACTIVATION_HEIGHT = 101;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function runCli(args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: operatorDir,
    maxBuffer: 1024 * 1024
  });
}

function startNode(label, args, env = {}) {
  const child = spawn(process.execPath, [cliPath, "node", ...args], {
    cwd: operatorDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const append = (chunk) => { output += chunk.toString("utf8"); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { label, child, output: () => output };
}

async function stopNode(processInfo) {
  if (!processInfo || processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => processInfo.child.once("exit", resolveExit));
  processInfo.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 10_000))]);
  if (processInfo.child.exitCode === null && processInfo.child.signalCode === null) processInfo.child.kill("SIGKILL");
  assert.match(processInfo.output(), /ZyronChain node shutdown complete/, `${processInfo.label} did not complete graceful shutdown`);
}

async function fetchStatus(port) {
  const response = await fetch(`http://127.0.0.1:${port}/status`, {
    headers: { "x-zyron-rpc-version": "1" },
    signal: AbortSignal.timeout(3_000)
  });
  if (!response.ok) throw new Error(`status HTTP ${response.status}`);
  return response.json();
}

async function fetchJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "x-zyron-rpc-version": "1" },
    signal: AbortSignal.timeout(3_000)
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return response.json();
}

// Uses only modules from the installed release artifact, never the source tree.
async function prebuildV6Prefix(genesis, validators) {
  const dist = (name) => pathToFileURL(join(packageDir, "dist", "src", name)).href;
  const { ZyronChain } = await import(dist("chain.js"));
  const { ChainStore } = await import(dist("storage.js"));
  const { decryptPrivateKey } = await import(dist("keystore.js"));
  const { createProtocolUpgrade, createProtocolUpgradeApproval } = await import(dist("transaction.js"));
  const { expectedValidator } = await import(dist("block.js"));
  const privateKeys = new Map();
  for (const { keystore, passwordPath } of validators) {
    const password = (await readFile(passwordPath, "utf8")).trim();
    privateKeys.set(keystore.publicKey, decryptPrivateKey(keystore, password));
  }
  const initiator = validators[1].keystore;
  const proposal = { chainId: genesis.chainId, nonce: 1, sender: initiator.address, activationHeight: V6_ACTIVATION_HEIGHT, protocolVersion: 6 };
  const upgrade = createProtocolUpgrade({
    ...proposal,
    approvals: validators.map(({ keystore }) => createProtocolUpgradeApproval(proposal, privateKeys.get(keystore.publicKey), keystore.publicKey)),
    timestampMs: genesis.timestampMs + 1
  }, privateKeys.get(initiator.publicKey), initiator.publicKey);
  const chain = new ZyronChain(genesis);
  const blocks = [];
  for (let height = 1; height < V6_ACTIVATION_HEIGHT; height += 1) {
    const timestampMs = genesis.timestampMs + (height * 10);
    const proposer = expectedValidator(genesis.validators, height, 0);
    let block = chain.produceBlock(height === 1 ? [upgrade] : [], privateKeys.get(proposer.publicKey), { timestampMs });
    for (const key of privateKeys.values()) block = chain.attestBlock(block, key);
    chain.acceptBlock(block, timestampMs);
    blocks.push(block);
  }
  privateKeys.clear();
  assert.equal(chain.protocolVersionAt(V6_ACTIVATION_HEIGHT), 6);
  assert.equal(chain.protocolVersionAt(V6_ACTIVATION_HEIGHT - 1), 1);
  for (const { dataDirectory } of validators) {
    await mkdir(dataDirectory, { mode: 0o700 });
    const store = await ChainStore.open(genesis, dataDirectory);
    for (const block of blocks) await store.commitFinalizedBlock(block);
  }
}

async function verifyV6Blocks(ports, height) {
  let v6Heights = 0;
  for (const port of ports) {
    const { blocks } = await fetchJson(port, `/blocks?from=${V6_ACTIVATION_HEIGHT}&limit=${height - V6_ACTIVATION_HEIGHT + 1}`);
    assert.equal(blocks.length, height - V6_ACTIVATION_HEIGHT + 1);
    for (const block of blocks) {
      assert.equal(block.header.version, 6, `height ${block.header.height} is not a v6 block`);
      assert.ok(Number.isSafeInteger(block.commitRound) && block.commitRound >= block.header.round);
      assert.deepEqual(block.roundCertificate, []);
      assert.equal(block.attestations.length, 2);
    }
    v6Heights = blocks.length;
  }
  return v6Heights;
}

async function waitForConvergence(ports, minHeight, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await Promise.all(ports.map(fetchStatus));
      if (latest.every((status) => status.height >= minHeight) &&
          new Set(latest.map((status) => status.height)).size === 1 &&
          new Set(latest.map((status) => status.tipHash)).size === 1 &&
          new Set(latest.map((status) => status.genesisHash)).size === 1) return latest;
    } catch {
      // Processes may still be starting or synchronizing.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Artifact-installed validators did not converge at height ${minHeight}: ${JSON.stringify(latest)}`);
}

const processes = [];
try {
  await execFileAsync("mkdir", ["-p", packDir, operatorDir]);
  await execFileAsync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: l1Root,
    maxBuffer: 1024 * 1024
  });
  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `Expected one release tarball, got ${tarballs.join(",")}`);
  const tarballPath = join(packDir, tarballs[0]);
  const tarballSha256 = sha256(await readFile(tarballPath));

  await writeFile(join(operatorDir, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`, { mode: 0o644 });
  await execFileAsync("npm", ["install", "--no-audit", "--no-fund", tarballPath], {
    cwd: operatorDir,
    maxBuffer: 4 * 1024 * 1024
  });

  const installedPackage = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.equal(installedPackage.name, "@zyronchain/l1");
  assert.ok(installedPackage.version);
  assert.ok(cliPath.startsWith(operatorDir), "Installed CLI escaped clean operator directory");
  assert.equal(cliPath.includes(l1Root), false, "Rehearsal runtime points back into source tree");

  const validatorOnePath = join(operatorDir, "validator-one.json");
  const validatorTwoPath = join(operatorDir, "validator-two.json");
  const oraclePath = join(operatorDir, "oracle.json");
  const validatorOnePasswordPath = join(operatorDir, "validator-one.password");
  const validatorTwoPasswordPath = join(operatorDir, "validator-two.password");
  const oraclePasswordPath = join(operatorDir, "oracle.password");
  for (const passwordPath of [validatorOnePasswordPath, validatorTwoPasswordPath, oraclePasswordPath]) {
    await writeFile(passwordPath, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  }
  await runCli(["keygen", "--out", validatorOnePath, "--password-file", validatorOnePasswordPath]);
  await runCli(["keygen", "--out", validatorTwoPath, "--password-file", validatorTwoPasswordPath]);
  await runCli(["keygen", "--out", oraclePath, "--password-file", oraclePasswordPath]);
  const validatorOne = JSON.parse(await readFile(validatorOnePath, "utf8"));
  const validatorTwo = JSON.parse(await readFile(validatorTwoPath, "utf8"));
  const oracle = JSON.parse(await readFile(oraclePath, "utf8"));
  for (const value of [validatorOne, validatorTwo, oracle]) {
    assert.equal(value.version, 2, "New keystores use format v2");
    assert.deepEqual(value.kdfParams, { n: 131072, r: 8, p: 1, dkLen: 32 }, "v2 keystores use scrypt N=2^17, r=8, p=1");
    assert.equal(Object.hasOwn(value, "privateKey"), false, "Release rehearsal must not create plaintext private-key JSON");
    assert.equal(value.kdf, "scrypt", "Release rehearsal keystore must use scrypt");
    assert.equal(value.cipher, "aes-256-gcm", "Release rehearsal keystore must use AES-256-GCM");
    assert.match(value.salt, /^[0-9a-f]{64}$/);
    assert.match(value.iv, /^[0-9a-f]{24}$/);
    assert.match(value.tag, /^[0-9a-f]{32}$/);
    assert.match(value.ciphertext, /^[0-9a-f]{128}$/);
    assert.match(value.publicKey, /^[0-9a-f]{128}$/);
    assert.match(value.address, /^ZYN[0-9a-f]{40}$/);
  }

  const genesisPath = join(operatorDir, "genesis.json");
  await runCli([
    "genesis", "--out", genesisPath, "--chain-id", chainId,
    "--timestamp-ms", String(Date.now() - 30_000),
    "--validator-public-key", validatorOne.publicKey,
    "--validator-public-key", validatorTwo.publicKey,
    "--oracle-public-key", oracle.publicKey,
    "--activity-pool", validatorOne.address,
    "--allocation", `${validatorOne.address}:100000000`,
    "--allocation", `${validatorTwo.address}:100000000`
  ]);
  const genesis = JSON.parse(await readFile(genesisPath, "utf8"));
  assert.equal(genesis.chainId, chainId);
  assert.equal(genesis.validators.length, 2);

  const [portOne, portTwo] = await Promise.all([freePort(), freePort()]);
  const dataOne = join(operatorDir, "data-one");
  const dataTwo = join(operatorDir, "data-two");
  await prebuildV6Prefix(genesis, [
    { keystore: validatorOne, passwordPath: validatorOnePasswordPath, dataDirectory: dataOne },
    { keystore: validatorTwo, passwordPath: validatorTwoPasswordPath, dataDirectory: dataTwo }
  ]);
  const nodeOneArgs = ["--genesis", genesisPath, "--data", dataOne, "--host", "127.0.0.1", "--port", String(portOne), "--validator-key", validatorOnePath, "--peer", `http://127.0.0.1:${portTwo}`];
  const nodeTwoArgs = ["--genesis", genesisPath, "--data", dataTwo, "--host", "127.0.0.1", "--port", String(portTwo), "--validator-key", validatorTwoPath, "--peer", `http://127.0.0.1:${portOne}`];

  const nodeOne = startNode("artifact-validator-one", nodeOneArgs, { ZYRON_KEYSTORE_PASSWORD_FILE: validatorOnePasswordPath });
  let nodeTwo = startNode("artifact-validator-two", nodeTwoArgs, { ZYRON_KEYSTORE_PASSWORD_FILE: validatorTwoPasswordPath });
  processes.push(nodeOne, nodeTwo);
  const beforeRestart = await waitForConvergence([portOne, portTwo], V6_ACTIVATION_HEIGHT + 1);
  for (const port of [portOne, portTwo]) {
    assert.equal((await fetchJson(port, "/protocol")).currentVersion, 6, "Rehearsal validators must run consensus protocol v6");
  }
  const preRestartHeight = beforeRestart[0].height;
  const preRestartTip = beforeRestart[0].tipHash;
  const genesisHash = beforeRestart[0].genesisHash;

  await stopNode(nodeTwo);
  nodeTwo = startNode("artifact-validator-two-restarted", nodeTwoArgs, { ZYRON_KEYSTORE_PASSWORD_FILE: validatorTwoPasswordPath });
  processes.push(nodeTwo);
  const afterRestart = await waitForConvergence([portOne, portTwo], preRestartHeight);
  assert.equal(afterRestart[0].tipHash, afterRestart[1].tipHash);
  assert.equal(afterRestart[0].genesisHash, genesisHash);
  const v6Heights = await verifyV6Blocks([portOne, portTwo], afterRestart[0].height);

  console.log(JSON.stringify({
    status: "ok",
    scenario: "third-party-release-artifact-operator-rehearsal",
    packageName: installedPackage.name,
    packageVersion: installedPackage.version,
    tarballFile: tarballs[0],
    tarballSha256,
    cleanInstallDirectory: true,
    runtimeUsesInstalledArtifactOnly: true,
    encryptedKeystoresOnly: true,
    validatorProcesses: 2,
    genesisHash,
    preRestartHeight,
    preRestartTip,
    finalHeight: afterRestart[0].height,
    finalTip: afterRestart[0].tipHash,
    protocolVersion: 6,
    v6ActivationHeight: V6_ACTIVATION_HEIGHT,
    v6Heights,
    restartRecovered: true,
    converged: true,
    publicTestnetAuthorized: false,
    mainnetAuthorized: false,
    valueBearing: false
  }, null, 2));
} finally {
  for (const processInfo of processes) {
    if (processInfo.child.exitCode === null && processInfo.child.signalCode === null) {
      try { await stopNode(processInfo); } catch { processInfo.child.kill("SIGKILL"); }
    }
  }
  await rm(root, { recursive: true, force: true });
}
