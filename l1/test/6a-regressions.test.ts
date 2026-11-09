import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import type { Address, Transaction, TransferTx } from "../src/types.js";

// Feature 6A (#1146) regression tests: the CLI process refuses protocol-1 chains
// with a clean, non-zero exit that no flag or environment variable can bypass,
// protocol v6 keeps working, the devnet package scripts map v6 by default, and
// the informational v1 devnet classifier labels the by-design refusal exactly.

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const classifierPath = join(l1Root, "scripts/classify-devnet-v1-result.mjs");
const ISSUE = "https://github.com/zyron249/-zyronchain/issues/1147";
const PASSWORD = "a-strong-local-wallet-password";
const receiver = addressFromPublicKey(publicKeyFromPrivate("62".padStart(64, "0")));
const BYPASS_ENV = {
  ZYRON_TX_VERSION: "1", ZYRON_TRANSFER_VERSION: "1", ZYRON_ALLOW_V1: "1", ZYRON_ALLOW_TX_V1: "true",
  ZYRON_PROTOCOL_VERSION: "3", ZYRON_PROTOCOL: "6", ZYRON_FORCE: "1", ZYRON_OFFLINE_CHAIN_PROTOCOLS: "{\"zyron-wallet-testnet-1\":6}",
  ZYRON_V1_EXCEPTION_END_MS: "9999999999999", NODE_OPTIONS: ""
};

type Run = { status: number | null; stdout: string; stderr: string };
function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zyron-6a-regress-"));
  const keyPath = join(root, "wallet.json");
  const passwordPath = join(root, "wallet.password");
  await writeFile(passwordPath, `${PASSWORD}\n`, { mode: 0o600 });
  const keygen = await run(["keygen", "--out", keyPath, "--password-file", passwordPath]);
  assert.equal(keygen.status, 0, keygen.stderr);
  const address = (JSON.parse(await readFile(keyPath, "utf8")) as { address: Address }).address;
  return { root, keyPath, address, env: { ZYRON_KEYSTORE_PASSWORD_FILE: passwordPath } };
}

async function fakeNode(address: Address, protocol: number | "404") {
  const posted: Transaction[] = [];
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "x-zyron-rpc-version": "1" });
      response.end(text);
    };
    if (request.method === "GET" && request.url === `/nonce/${address}`) return send(200, { nonce: 0 });
    if (request.method === "GET" && request.url === "/protocol") {
      return protocol === "404" ? send(404, { error: "not found" }) : send(200, { currentVersion: protocol, nextVersion: protocol });
    }
    if (request.method === "POST" && request.url === "/tx") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const tx = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Transaction;
        posted.push(tx);
        send(202, { txid: tx.txid });
      });
      return undefined;
    }
    return send(404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { rpc, posted, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A refusal is one clean "Fatal: Refusing to sign" line on stderr, no stack trace, nothing on stdout, non-zero exit. */
function assertCleanRefusal(result: Run, pattern: RegExp, label: string) {
  assert.notEqual(result.status, 0, `${label}: must exit non-zero`);
  assert.equal(result.stdout, "", `${label}: nothing on stdout`);
  const fatal = result.stderr.split("\n").filter((line) => line.startsWith("Fatal: "));
  assert.equal(fatal.length, 1, `${label}: exactly one Fatal line\n${result.stderr}`);
  assert.match(fatal[0]!, /^Fatal: Refusing to sign: /, label);
  assert.match(fatal[0]!, pattern, label);
  assert.doesNotMatch(result.stderr, /^\s+at /m, `${label}: no stack trace`);
}

test("6A regression: the CLI process refuses a protocol-1 chain offline with one clean error and a non-zero exit, under any flag or env", async () => {
  const { root, keyPath, env } = await setup();
  try {
    const out = join(root, "tx.json");
    const base = ["transfer-sign", "--key", keyPath, "--chain-id", "zyron-wallet-testnet-1", "--to", receiver, "--amount-atoms", "5",
      "--nonce", "1", "--timestamp-ms", "1761408000000", "--yes", "--out", out];
    const plain = await run(base, env);
    assertCleanRefusal(plain, /advertises protocol 1 \(offline-table\).*never signs version 1/, "plain");
    assert.ok(plain.stderr.includes(ISSUE), "points at #1147");
    // A matching --tx-version 2 does not turn the protocol-1 refusal into a v2 signature.
    assertCleanRefusal(await run([...base, "--tx-version", "2"], env), /advertises protocol 1 \(offline-table\)/, "--tx-version 2");
    assertCleanRefusal(await run([...base, "--tx-version", "1"], env), /advertises protocol 1|tx-version 1 is refused/, "--tx-version 1");
    assertCleanRefusal(await run(base, { ...env, ...BYPASS_ENV }), /advertises protocol 1 \(offline-table\)/, "bypass env");
    // Invented override flags are rejected outright, never silently honoured.
    for (const flag of [["--protocol", "6"], ["--force"], ["--allow-v1"], ["--v1-legacy"], ["--protocol-version", "3"]]) {
      const result = await run([...base, ...flag], { ...env, ...BYPASS_ENV });
      assert.notEqual(result.status, 0, flag.join(" "));
      assert.match(result.stderr, /Unknown option|Refusing to sign/, flag.join(" "));
    }
    assert.equal(await exists(out), false, "nothing was ever written");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6A regression: the CLI process refuses protocol-1 and protocol-2 nodes online with a clean non-zero exit and posts nothing", async () => {
  const { root, keyPath, address, env } = await setup();
  try {
    for (const protocol of [1, 2, "404"] as const) {
      const node = await fakeNode(address, protocol);
      try {
        const args = ["transfer", "--key", keyPath, "--rpc", node.rpc, "--chain-id", "zyron-devnet-1", "--to", receiver, "--amount-atoms", "5", "--yes"];
        assertCleanRefusal(await run(args, env), /advertises protocol [12] \(node\).*never signs version 1/, `protocol ${protocol}`);
        assertCleanRefusal(await run(args, { ...env, ...BYPASS_ENV }), /never signs version 1/, `protocol ${protocol} + env`);
        const flagged = await run([...args, "--tx-version", "2"], { ...env, ...BYPASS_ENV });
        assert.notEqual(flagged.status, 0);
        assert.match(flagged.stderr, /Unknown option: --tx-version/);
        assert.equal(node.posted.length, 0, `protocol ${protocol}: nothing posted`);
      } finally {
        await node.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6A regression: protocol v6 still signs and submits version 2 with exit 0, online and offline", async () => {
  const { root, keyPath, address, env } = await setup();
  const node = await fakeNode(address, 6);
  try {
    const online = await run(["transfer", "--key", keyPath, "--rpc", node.rpc, "--chain-id", "zyron-open-testnet-1", "--to", receiver, "--amount-atoms", "5", "--yes"], env);
    assert.equal(online.status, 0, online.stderr);
    assert.equal(node.posted.length, 1);
    assert.equal(node.posted[0]!.version, 2);
    assert.equal(node.posted[0]!.chainId, "zyron-open-testnet-1");
    assert.equal((node.posted[0] as unknown as TransferTx).receiver, receiver);
    const out = join(root, "tx.json");
    const offline = await run(["transfer-sign", "--key", keyPath, "--chain-id", "zyron-open-testnet-1", "--to", receiver, "--amount-atoms", "5",
      "--nonce", "1", "--timestamp-ms", "1761408000000", "--yes", "--out", out], env);
    assert.equal(offline.status, 0, offline.stderr);
    const tx = JSON.parse(await readFile(out, "utf8")) as Transaction;
    assert.equal(tx.version, 2);
    assert.equal(tx.nonce, 1);
  } finally {
    await node.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("6A regression: devnet:check runs v6, devnet:check:v6 aliases it, and v1 is only behind the *:v1-legacy scripts", async () => {
  const pkg = JSON.parse(await readFile(join(l1Root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["devnet:check"], "npm run build && node scripts/local-devnet.mjs --check --v6");
  assert.equal(pkg.scripts["devnet:check:v6"], "npm run devnet:check");
  assert.equal(pkg.scripts["devnet:check:v1-legacy"], "npm run build && node scripts/local-devnet.mjs --check --v1-legacy");
  assert.equal(pkg.scripts["devnet:v1-legacy"], "npm run build && node scripts/local-devnet.mjs --v1-legacy");
  const legacy = Object.keys(pkg.scripts).filter((name) => /--v1-legacy/.test(pkg.scripts[name]!));
  assert.deepEqual(legacy.sort(), ["devnet:check:v1-legacy", "devnet:v1-legacy"]);
  const workflow = await readFile(join(l1Root, "../.github/workflows/l1.yml"), "utf8");
  assert.match(workflow, /run: npm run devnet:check:v1-legacy 2>&1 \| tee "\$RUNNER_TEMP\/local-devnet-v1\.log"/);
  assert.match(workflow, /run: npm run devnet:check:v6\n/);
  assert.doesNotMatch(workflow, /run: npm run devnet:check(?: |\n)/, "no job runs the bare script expecting protocol 1");
});

// The exact failure the v1-legacy devnet harness prints when the CLI refuses its transfer step
// (captured from `node scripts/local-devnet.mjs --check --v1-legacy` on this branch).
const REFUSAL = "Fatal: Refusing to sign: zyron-devnet-1 advertises protocol 1 (node), which needs transaction version 1; the CLI never signs version 1. Use a protocol-3 chain; see https://github.com/zyron249/-zyronchain/issues/1147. Nothing was signed.";
function refusalLog(patch: { refusal?: string; command?: string; extra?: string } = {}) {
  const command = patch.command ?? "/usr/bin/node /work/l1/dist/src/secure-cli.js transfer --key /tmp/d/secrets/a.json --rpc http://127.0.0.1:38487 --chain-id zyron-devnet-1 --to ZYNc27a8819aa8902cbecdffcc6e7ba3c6ff1ad2531 --amount-atoms 100000000 --fee-atoms 1000 --yes";
  const refusal = patch.refusal ?? REFUSAL;
  return [
    "Local chain: zyron-devnet-1",
    "Waiting for both validators to finalize a block (30-second block interval)...",
    ...(patch.extra ? [patch.extra] : []),
    refusal,
    `Error: Command failed: ${command}`,
    refusal,
    "",
    "    at genericNodeError (node:internal/errors:983:15)",
    "Development data retained at /tmp/d; it contains development-only encrypted keys and password files.",
    ""
  ].join("\n");
}
type Classified = { kind: string; level: string; title: string; message: string };
const loadClassifier = async () => import(new URL("../../scripts/classify-devnet-v1-result.mjs", import.meta.url).href) as Promise<{
  classifyDevnetV1Result(text: string, outcome: string, logs?: Record<string, string>): Classified;
}>;

test("6A regression: the v1 classifier labels the by-design CLI refusal as expected, and the script exits 0 for it", async () => {
  const { classifyDevnetV1Result } = await loadClassifier();
  const result = classifyDevnetV1Result(refusalLog(), "failure", {});
  assert.equal(result.kind, "expected-v1-refusal");
  assert.equal(result.level, "warning");
  assert.match(result.title, /refused by design \(6A\), not a regression/);
  assert.match(result.message, /#1147/);
  const root = await mkdtemp(join(tmpdir(), "zyron-6a-classify-"));
  try {
    const path = join(root, "v1.log");
    await writeFile(path, refusalLog());
    const stdout = execFileSync(process.execPath, [classifierPath, path, "failure"], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
    assert.match(stdout, /^::warning title=Protocol-v1 devnet refused by design/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6A regression: anything short of the exact refusal signature is still a regression", async () => {
  const { classifyDevnetV1Result } = await loadClassifier();
  const cases: Record<string, string> = {
    "protocol 2 refusal": refusalLog({ refusal: REFUSAL.replace("protocol 1 (node)", "protocol 2 (node)") }),
    "offline-table source": refusalLog({ refusal: REFUSAL.replace("(node)", "(offline-table)") }),
    "no #1147 pointer": refusalLog({ refusal: REFUSAL.replace(` see ${ISSUE}.`, "") }),
    "different chain in refusal": refusalLog({ refusal: REFUSAL.replace("zyron-devnet-1 advertises", "zyron-other-1 advertises") }),
    "not the transfer command": refusalLog({ command: "/usr/bin/node /work/l1/dist/src/secure-cli.js transfer-sign --key k --chain-id zyron-devnet-1 --to x" }),
    "another CLI error": refusalLog({ refusal: "Fatal: RPC protocol status returned HTTP 500" }),
    "transfer was verified": refusalLog({ extra: "Transfer verified on both validators at height 3." })
  };
  for (const [label, log] of Object.entries(cases)) {
    assert.equal(classifyDevnetV1Result(log, "failure", {}).kind, "regression", label);
  }
  // A real refusal log still never turns into a pass, and success still needs its summary.
  assert.notEqual(classifyDevnetV1Result(refusalLog(), "success", {}).kind, "pass");
  assert.equal(classifyDevnetV1Result(refusalLog(), "cancelled", {}).kind, "not-run");
});
