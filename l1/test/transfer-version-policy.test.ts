import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { IntentRenderRefusal, RENDERABLE_CHAIN_IDS, TRANSFER_INTENT_DOMAIN, renderIntent } from "../src/intent-render.js";
import { signTransfer } from "../src/transaction.js";
import {
  FIRST_V2_PROTOCOL,
  OFFLINE_CHAIN_PROTOCOLS,
  V1_RETIREMENT_ISSUE,
  offlineProtocolForChain,
  resolveTransferVersion
} from "../src/transfer-version-policy.js";
import type { Address, Transaction } from "../src/types.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PASSWORD = "a-strong-local-wallet-password";
const signerKey = "6a".padStart(64, "0");
const publicKey = publicKeyFromPrivate(signerKey);
const sender = addressFromPublicKey(publicKey);
const receiver = addressFromPublicKey(publicKeyFromPrivate("62".padStart(64, "0")));
const ALL_CHAIN_IDS = [...RENDERABLE_CHAIN_IDS, "zyron-mainnet-1", "zyron-public-testnet-1", "zyron-unknown-devnet-9"];
const V1_ENV = {
  ZYRON_TX_VERSION: "1", ZYRON_TRANSFER_VERSION: "1", ZYRON_ALLOW_V1: "1", ZYRON_ALLOW_TX_V1: "true",
  ZYRON_PROTOCOL_VERSION: "1", ZYRON_RENDERABLE_CHAIN_IDS: "zyron-mainnet-1", ZYRON_V1_EXCEPTION_END_MS: "9999999999999", ZYRON_YES: "1"
};

function payload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "transfer", version: 2, chainId: "zyron-open-testnet-1", nonce: 1, sender, receiver,
    amountAtoms: 5, feeAtoms: 0, timestampMs: 1_761_408_000_000, publicKey, ...patch
  };
}

async function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 });
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zyron-6a-version-"));
  const keyPath = join(root, "wallet.json");
  const passwordPath = join(root, "wallet.password");
  await writeFile(passwordPath, `${PASSWORD}\n`, { mode: 0o600 });
  await cli(["keygen", "--out", keyPath, "--password-file", passwordPath]);
  const address = (JSON.parse(await readFile(keyPath, "utf8")) as { address: Address }).address;
  const env = { ZYRON_KEYSTORE_PASSWORD_FILE: passwordPath };
  const offline = (chainId: string, out: string, extra: string[] = []) => [
    "transfer-sign", "--key", keyPath, "--chain-id", chainId, "--to", receiver, "--amount-atoms", "5", "--nonce", "1",
    "--timestamp-ms", "1761408000000", ...extra, "--yes", "--out", out
  ];
  return { root, keyPath, address, env, offline };
}

/** A fake node that advertises `protocol` on /protocol (or 404) and counts POSTs. */
async function fakeNode(address: Address, protocol: number | "404", nextProtocol: number | undefined = undefined) {
  const posted: Transaction[] = [];
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "x-zyron-rpc-version": "1" });
      response.end(text);
    };
    if (request.method === "GET" && request.url === `/nonce/${address}`) return send(200, { nonce: 0 });
    if (request.method === "GET" && request.url === "/protocol") {
      return protocol === "404" ? send(404, { error: "not found" }) : send(200, { currentVersion: protocol, nextVersion: nextProtocol ?? protocol });
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

test("option 3: the offline chainId-to-protocol table is fixed, frozen and pinned; unknown chains are v2-capable", () => {
  assert.deepEqual({ ...OFFLINE_CHAIN_PROTOCOLS }, { "zyron-wallet-testnet-1": 1, "zyron-open-testnet-1": 6 });
  assert.ok(Object.isFrozen(OFFLINE_CHAIN_PROTOCOLS));
  assert.throws(() => { (OFFLINE_CHAIN_PROTOCOLS as Record<string, number>)["zyron-open-testnet-1"] = 1; }, TypeError);
  assert.equal(offlineProtocolForChain("zyron-open-testnet-1"), 6);
  assert.equal(offlineProtocolForChain("zyron-devnet-1"), FIRST_V2_PROTOCOL);
  assert.equal(offlineProtocolForChain("zyron-never-seen-devnet"), FIRST_V2_PROTOCOL);
  assert.equal(offlineProtocolForChain("__proto__"), FIRST_V2_PROTOCOL, "inherited keys are not table entries");
});

test("option 3: the version follows the advertised protocol; protocol < 3 and invalid protocols are refused with the #1147 pointer", () => {
  for (const protocol of [3, 5, 6, 7]) assert.equal(resolveTransferVersion("zyron-devnet-1", protocol, "node"), 2);
  for (const protocol of [1, 2]) {
    assert.throws(() => resolveTransferVersion("zyron-devnet-1", protocol, "node"), (error: unknown) =>
      error instanceof IntentRenderRefusal && error.message.includes(V1_RETIREMENT_ISSUE) && /never signs version 1/.test(error.message));
  }
  for (const protocol of [0, -1, 2.5, Number.NaN, "3", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveTransferVersion("zyron-devnet-1", protocol, "node"), IntentRenderRefusal, String(protocol));
  }
});

test("downgrade-proof: a v2-capable chain cannot be pushed to v1 by a flag, user input, a spoofed payload version or a tampered offline table entry", () => {
  // Flag / user input: a requested version may only confirm 2.
  for (const requested of [1, 0, 3]) {
    assert.throws(() => resolveTransferVersion("zyron-open-testnet-1", 6, "offline-table", requested), /cannot be overridden/);
    assert.throws(() => resolveTransferVersion("zyron-devnet-1", 3, "node", requested), /cannot be overridden/);
  }
  assert.equal(resolveTransferVersion("zyron-open-testnet-1", 6, "offline-table", 2), 2);
  // Spoofed payload version: the renderer and the signer refuse version 1 whatever the chain says.
  assert.throws(() => renderIntent({ domain: TRANSFER_INTENT_DOMAIN, payload: payload({ version: 1 }) }), /transaction version 1/);
  assert.throws(() => renderIntent({ domain: "zyronchain/transaction/transfer/v1", payload: payload({ version: 1 }) }), IntentRenderRefusal);
  const genuine = renderIntent({ domain: TRANSFER_INTENT_DOMAIN, payload: payload() });
  assert.throws(() => signTransfer({ ...genuine, payload: { ...genuine.payload, version: 1 } } as never, signerKey), IntentRenderRefusal);
  // Tampered offline table entry for a known v2 chain: refused, never downgraded.
  for (const tampered of [1, 2, 0, "6", null]) {
    const table = { ...OFFLINE_CHAIN_PROTOCOLS, "zyron-open-testnet-1": tampered };
    assert.throws(() => resolveTransferVersion("zyron-open-testnet-1", offlineProtocolForChain("zyron-open-testnet-1", table), "offline-table"),
      IntentRenderRefusal, String(tampered));
  }
  // A node that advertises protocol 1 for a v2 chain is refused too (no silent v1).
  assert.throws(() => resolveTransferVersion("zyron-open-testnet-1", 1, "node"), /never signs version 1/);
});

test("confinement (a): l1 signTransfer refuses version 1 on every chain ID, including zyron-wallet-testnet-1", () => {
  for (const chainId of ALL_CHAIN_IDS) {
    assert.throws(() => renderIntent({ domain: TRANSFER_INTENT_DOMAIN, payload: payload({ chainId, version: 1 }) }), IntentRenderRefusal, chainId);
    const forged = { rendererVersion: 1, kind: "transfer", domain: TRANSFER_INTENT_DOMAIN, payload: payload({ chainId, version: 1 }), lines: [], text: "", signingBytesHex: "" };
    assert.throws(() => signTransfer(forged as never, signerKey), IntentRenderRefusal, chainId);
  }
  // zyron-wallet-testnet-1 renders only as version 2; the CLI then refuses it by protocol (next test).
  assert.equal(renderIntent({ domain: TRANSFER_INTENT_DOMAIN, payload: payload({ chainId: "zyron-wallet-testnet-1" }) }).payload.version, 2);
});

test("confinement (a): the CLI refuses version 1 and protocol-1 chains on every chain ID, offline and online", async () => {
  const { root, address, env, offline } = await setup();
  try {
    const out = join(root, "tx.json");
    for (const chainId of ALL_CHAIN_IDS) {
      await assert.rejects(cli(offline(chainId, out, ["--tx-version", "1"]), env), /Refusing to sign/, chainId);
    }
    await assert.rejects(cli(offline("zyron-wallet-testnet-1", out), env), (error: { stderr: string }) =>
      /advertises protocol 1 \(offline-table\)/.test(error.stderr) && error.stderr.includes(V1_RETIREMENT_ISSUE));
    assert.equal(await exists(out), false, "nothing was signed offline");
    for (const chainId of ["zyron-wallet-testnet-1", "zyron-devnet-1", "zyron-open-testnet-1"]) {
      for (const protocol of [1, 2, "404"] as const) {
        const node = await fakeNode(address, protocol);
        try {
          await assert.rejects(cli([
            "transfer", "--key", join(root, "wallet.json"), "--rpc", node.rpc, "--chain-id", chainId, "--to", receiver, "--amount-atoms", "5", "--yes"
          ], env), (error: { stderr: string }) => /never signs version 1/.test(error.stderr) && error.stderr.includes(V1_RETIREMENT_ISSUE), `${chainId} ${protocol}`);
          assert.equal(node.posted.length, 0, "nothing was posted");
        } finally {
          await node.close();
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downgrade-proof CLI: a protocol-3 node always gets version 2; transfer has no version flag and transfer-sign cannot override the table", async () => {
  const { root, address, env, offline } = await setup();
  const node = await fakeNode(address, 3);
  try {
    const base = ["transfer", "--key", join(root, "wallet.json"), "--rpc", node.rpc, "--chain-id", "zyron-devnet-1", "--to", receiver, "--amount-atoms", "5", "--yes"];
    await assert.rejects(cli([...base, "--tx-version", "1"], env), /Unknown option: --tx-version/);
    await cli(base, env);
    assert.equal(node.posted.length, 1);
    assert.equal(node.posted[0]!.version, 2);
    const out = join(root, "tx.json");
    await assert.rejects(cli(offline("zyron-open-testnet-1", out, ["--tx-version", "1"]), env), /cannot be overridden/);
    await cli(offline("zyron-open-testnet-1", out, ["--tx-version", "2"]), env);
    assert.equal((JSON.parse(await readFile(out, "utf8")) as Transaction).version, 2);
  } finally {
    await node.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("active protocol: the CLI uses /protocol currentVersion, not nextVersion (an upcoming v3 activation does not unlock signing early)", async () => {
  const { root, address, env } = await setup();
  try {
    const base = ["transfer", "--key", join(root, "wallet.json"), "--chain-id", "zyron-devnet-1", "--to", receiver, "--amount-atoms", "5", "--yes"];
    const pending = await fakeNode(address, 1, 3);
    try {
      await assert.rejects(cli([...base, "--rpc", pending.rpc], env), /advertises protocol 1 \(node\).*#?1147|advertises protocol 1 \(node\)/s);
      assert.equal(pending.posted.length, 0);
    } finally { await pending.close(); }
    const active = await fakeNode(address, 3, 6);
    try {
      await cli([...base, "--rpc", active.rpc], env);
      assert.equal(active.posted.length, 1);
      assert.equal(active.posted[0]!.version, 2);
    } finally { await active.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confinement (d): environment variables or config cannot change the version, the chain list or the v1 refusal", async () => {
  // No environment, file or config input in the policy, the renderer or the signer.
  for (const file of ["intent-render.ts", "transfer-version-policy.ts"]) {
    const source = await readFile(new URL(`../../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /process\.|import\.meta|from "node:|readFile|localStorage|getenv/i, file);
  }
  const { root, address, env, offline } = await setup();
  const node = await fakeNode(address, 1);
  const v6 = await fakeNode(address, 6);
  try {
    const out = join(root, "tx.json");
    // Offline: the wallet testnet stays refused and a v1 request stays refused under every override attempt.
    await assert.rejects(cli(offline("zyron-wallet-testnet-1", out), { ...env, ...V1_ENV }), /advertises protocol 1/);
    await assert.rejects(cli(offline("zyron-mainnet-1", out), { ...env, ...V1_ENV }), /not in the fixed list/);
    await assert.rejects(cli(offline("zyron-devnet-1", out, ["--tx-version", "1"]), { ...env, ...V1_ENV }), /tx-version 1 is refused/);
    // Online: a protocol-1 node stays refused; a protocol-6 node still gets version 2.
    const online = (rpc: string) => ["transfer", "--key", join(root, "wallet.json"), "--rpc", rpc, "--chain-id", "zyron-devnet-1", "--to", receiver, "--amount-atoms", "5", "--yes"];
    await assert.rejects(cli(online(node.rpc), { ...env, ...V1_ENV }), /never signs version 1/);
    assert.equal(node.posted.length, 0);
    await cli(online(v6.rpc), { ...env, ...V1_ENV });
    assert.equal(v6.posted[0]!.version, 2);
    // --yes is never read from the environment either.
    await assert.rejects(cli(offline("zyron-devnet-1", out).filter((arg) => arg !== "--yes"), { ...env, ...V1_ENV }), /no interactive terminal/);
  } finally {
    await node.close();
    await v6.close();
    await rm(root, { recursive: true, force: true });
  }
});
