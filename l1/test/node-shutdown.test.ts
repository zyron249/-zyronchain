import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeDataDirectoryLease } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPublicKey = publicKeyFromPrivate("31".padStart(64, "0"));
const oraclePublicKey = publicKeyFromPrivate("32".padStart(64, "0"));
const fundedAddress = addressFromPublicKey(publicKeyFromPrivate("33".padStart(64, "0")));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("34".padStart(64, "0")));

test("node drains on SIGTERM and SIGINT and releases its writer lease for restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-graceful-shutdown-"));
  const genesisPath = join(directory, "genesis.json");
  const dataDirectory = join(directory, "node-data");
  await writeFile(genesisPath, JSON.stringify(genesis()), "utf8");

  try {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const port = await availablePort();
      const child = spawn(process.execPath, [
        join(process.cwd(), "dist/src/cli.js"),
        "node",
        "--genesis", genesisPath,
        "--data", dataDirectory,
        "--host", "127.0.0.1",
        "--port", String(port)
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

      await waitForOutput(child, () => stdout, "node listening");
      assert.equal(child.kill(signal), true);
      const result = await waitForExit(child);

      assert.equal(result.signal, null, `expected ${signal} to be handled inside the node`);
      assert.equal(result.code, 0, stderr);
      assert.match(stdout, new RegExp(`Received ${signal}; draining node services`));
      assert.match(stdout, /ZyronChain node shutdown complete/);

      const lease = await NodeDataDirectoryLease.acquire(dataDirectory);
      lease.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-graceful-shutdown-1",
    timestampMs: 1_700_000_000_000,
    validators: [{
      address: addressFromPublicKey(validatorPublicKey),
      publicKey: validatorPublicKey
    }],
    activityOracles: [oraclePublicKey],
    activityPool,
    allocations: [
      { address: fundedAddress, amountAtoms: 1_000 },
      { address: activityPool, amountAtoms: 1_000 }
    ]
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => error ? reject(error) : resolveClose())
  );
  return address.port;
}

async function waitForOutput(
  child: ReturnType<typeof spawn>,
  output: () => string,
  marker: string
): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${marker}": ${output()}`));
    }, 15_000);
    const onData = (): void => {
      if (!output().includes(marker)) return;
      cleanup();
      resolveReady();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Node exited before readiness: code=${code} signal=${signal}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForExit(
  child: ReturnType<typeof spawn>
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for graceful node shutdown"));
    }, 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
