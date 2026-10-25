// Follow-up to Red Team M2 option A (#1134): GET /status exposes the node's
// effective minTransferFeeAtoms (0 when the floor is off, 0 under
// fixed-fee-v1 where the exact fee applies), and the open-testnet faucet reads
// that floor from the node instead of only its own env, failing loudly when a
// drip cannot meet it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { FIXED_TRANSFER_FEE_ATOMS } from "../src/fee-policy.js";
import { NodeService, createRpcServer, type NodeServiceOptions } from "../src/node.js";
import { defaultPublicDistributionRelease } from "../src/public-distribution-release.js";
import { ChainStore } from "../src/storage.js";
import { ATOMS_PER_ZYN, type GenesisConfig } from "../src/types.js";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);

const ZYN = ATOMS_PER_ZYN;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));

function genesisFor(chainId: string, fixedTransferFeeAtoms?: number): GenesisConfig {
  const genesis: GenesisConfig = {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: [71, 80, 81, 82].map((id) => ({ address: addr(id), publicKey: pub(id) })),
    activityOracles: [pub(72), pub(78), pub(79)],
    activityOracleThreshold: 2,
    activityOraclePolicy: "threshold-v1",
    activityPool: addr(76),
    allocations: [
      { address: addr(73), amountAtoms: 5_000_000 * ZYN },
      { address: addr(74), amountAtoms: 20_000_000 * ZYN },
      { address: addr(75), amountAtoms: 20_000_000 * ZYN },
      { address: addr(76), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(73), permanentLiquidity: addr(75) },
    publicDistributionRelease: defaultPublicDistributionRelease(addr(74)),
    launchProfile: "fixed-supply-v1"
  };
  if (fixedTransferFeeAtoms !== undefined) genesis.feePolicy = { version: "fixed-fee-v1", fixedTransferFeeAtoms };
  return genesis;
}

async function statusOf(genesis: GenesisConfig, options: NodeServiceOptions): Promise<{ status: number; body: any }> {
  const dir = await mkdtemp(join(tmpdir(), "zyron-status-min-fee-"));
  const server = createRpcServer(new NodeService(await ChainStore.open(genesis, dir), undefined, undefined, options));
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}

test("STATUS-MIN-FEE: /status reports minTransferFeeAtoms 0 when the floor is off", async () => {
  const { status, body } = await statusOf(genesisFor("zyron-status-fee-off"), {});
  assert.equal(status, 200);
  assert.equal(body.minTransferFeeAtoms, 0);
  assert.equal(body.chainId, "zyron-status-fee-off");
});

test("STATUS-MIN-FEE: /status reports the configured floor when it is on", async () => {
  const { body } = await statusOf(genesisFor("zyron-status-fee-on"), { mempoolMinTransferFeeAtoms: 1_000 } as NodeServiceOptions);
  assert.equal(body.minTransferFeeAtoms, 1_000);
});

test("STATUS-MIN-FEE: under fixed-fee-v1 the effective floor is 0 and the exact fee is reported separately", async () => {
  const { body } = await statusOf(genesisFor("zyron-status-fee-v1", FIXED_TRANSFER_FEE_ATOMS), { mempoolMinTransferFeeAtoms: 1_000 } as NodeServiceOptions);
  assert.equal(body.minTransferFeeAtoms, 0);
  assert.equal(body.fixedTransferFeeAtoms, FIXED_TRANSFER_FEE_ATOMS);
  const off = await statusOf(genesisFor("zyron-status-fee-v1-off"), {});
  assert.equal(off.body.fixedTransferFeeAtoms, null, "no fixed fee is reported as null");
});

test("STATUS-MIN-FEE: the faucet pays max(own env floor, node /status floor)", () => {
  assert.equal(typeof api.faucetTransferFeeAtoms, "function", "faucetTransferFeeAtoms must be exported");
  const ok = (minTransferFeeAtoms: unknown) => ({ status: 200, body: { height: 3, minTransferFeeAtoms } });
  assert.equal(api.faucetTransferFeeAtoms(0, ok(1_000)), 1_000, "a node floor above the env is used");
  assert.equal(api.faucetTransferFeeAtoms(2_000, ok(1_000)), 2_000, "the env floor is kept when higher");
  assert.equal(api.faucetTransferFeeAtoms(0, ok(0)), 0);
});

test("STATUS-MIN-FEE: the faucet fails loudly when it cannot learn or meet the floor", () => {
  assert.equal(typeof api.FaucetFeeFloorError, "function", "FaucetFeeFloorError must be exported");
  const cases: unknown[] = [
    { status: 502, body: { error: "node unavailable" } },
    { status: 200, body: { height: 3 } },
    { status: 200, body: { minTransferFeeAtoms: -1 } },
    { status: 200, body: { minTransferFeeAtoms: "1000" } },
    { status: 200, body: { minTransferFeeAtoms: Number.MAX_SAFE_INTEGER + 1 } },
    undefined
  ];
  for (const response of cases) {
    assert.throws(() => api.faucetTransferFeeAtoms(0, response), (error: unknown) => error instanceof api.FaucetFeeFloorError, JSON.stringify(response));
  }
});

async function postFaucet(route: (req: IncomingMessage, res: any, ip: string) => Promise<void>) {
  const server: Server = createServer((req, res) => { void route(req, res, "127.0.0.1"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    return await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/faucet", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      });
      req.on("error", reject); req.end(JSON.stringify({ address: `ZYN${"a".repeat(40)}` }));
    });
  } finally { await new Promise<void>((done) => server.close(() => done())); }
}

test("STATUS-MIN-FEE: a fee-floor failure reaches the faucet caller with a clear error and is logged at error level", async () => {
  const open = () => ({ take: () => ({ allowed: true, retryAfterMs: 0 }) });
  const logged: string[] = [];
  const route = api.createFaucetRoute({
    origins: new Set<string>(), limits: { faucetIp: open(), faucetAddress: open(), faucetGlobal: open() },
    faucetAddress: `ZYN${"b".repeat(40)}`,
    readJsonBody: async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const c of request) chunks.push(c as Buffer); return JSON.parse(Buffer.concat(chunks).toString("utf8")); },
    send: async () => api.faucetTransferFeeAtoms(0, { status: 502, body: {} }),
    log: (line: string) => logged.push(line)
  });
  const reply = await postFaucet(route);
  assert.equal(reply.status, 503);
  assert.equal(reply.body.code, "fee-floor");
  assert.match(reply.body.error, /minimum transfer fee/);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /^faucet error \(fee floor\): /);
});
