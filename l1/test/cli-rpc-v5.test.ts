import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";

const execFileAsync = promisify(execFile);
const cliPath = new URL("../src/cli.js", import.meta.url).pathname;

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("canonical CLI submits a transaction-v2 transfer when protocol v5 is next", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-cli-v5-"));
  const privateKey = "51".padStart(64, "0");
  const publicKey = publicKeyFromPrivate(privateKey);
  const sender = addressFromPublicKey(publicKey);
  const receiverPublicKey = publicKeyFromPrivate("52".padStart(64, "0"));
  const receiver = addressFromPublicKey(receiverPublicKey);
  const keyPath = join(root, "wallet.json");
  await writeFile(keyPath, `${JSON.stringify({ privateKey, publicKey, address: sender })}\n`, { mode: 0o600 });

  let submitted: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      const body = JSON.stringify(value);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-zyron-rpc-version": "1"
      });
      response.end(body);
    };
    if (request.method === "GET" && request.url === `/nonce/${sender}`) return send(200, { nonce: 0 });
    if (request.method === "GET" && request.url === "/protocol") return send(200, { currentVersion: 5, nextVersion: 5 });
    if (request.method === "POST" && request.url === "/tx") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        submitted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        send(202, { txid: submitted.txid });
      });
      return;
    }
    send(404, { error: "not found" });
  });

  try {
    const port = await listen(server);
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "transfer",
      "--key", keyPath,
      "--rpc", `http://127.0.0.1:${port}`,
      "--chain-id", "zyron-cli-v5",
      "--to", receiver,
      "--amount-atoms", "100",
      "--fee-atoms", "1"
    ], { maxBuffer: 1024 * 1024 });

    assert.match(stdout, /Submitted transaction [0-9a-f]{64}/);
    assert.ok(submitted);
    assert.equal(submitted.version, 2);
    assert.equal(submitted.kind, "transfer");
    assert.equal(submitted.sender, sender);
    assert.equal(submitted.receiver, receiver);
    assert.equal(submitted.chainId, "zyron-cli-v5");
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});
