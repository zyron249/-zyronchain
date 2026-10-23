// Pre-activation protocol readiness signal (V6_OPERATOR_GUIDE §12 item 8):
// `unsupported-next-protocol` on /readyz fires only one block before an
// activation. GET /protocol-schedule lets an operator see, long before the
// activation height, that a scheduled protocol version is not supported by
// the running binary. It is informational: /readyz and the strict
// /protocol shape (read by the CLI) stay unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { SUPPORTED_PROTOCOL_VERSIONS } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeService, createRpcServer } from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivate = "91".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const genesisTimestamp = 1_700_000_000_000;

function genesis(chainId: string): GenesisConfig {
  const pool = addressFromPublicKey(publicKeyFromPrivate("93".padStart(64, "0")));
  return {
    chainId,
    timestampMs: genesisTimestamp,
    validators: [{ address: addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
    activityOracles: [publicKeyFromPrivate("92".padStart(64, "0"))],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 1_000_000 }]
  };
}

type Json = Record<string, unknown>;

async function withNode(
  chainId: string,
  body: (context: { service: NodeService; get: (path: string) => Promise<{ status: number; body: Json }> }) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zyron-psched-"));
  const originalDateNow = Date.now;
  const journal = await SigningJournal.open(dir);
  const service = new NodeService(await ChainStore.open(genesis(chainId), dir), journal, validatorPrivate);
  const server = createRpcServer(service);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Date.now = () => genesisTimestamp + 60_000;
  try {
    await body({
      service,
      get: async (path) => {
        const response = await fetch(`${base}${path}`);
        return { status: response.status, body: await response.json() as Json };
      }
    });
  } finally {
    Date.now = originalDateNow;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    journal.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Simulates a network that scheduled a protocol version through governance
// (a recorded protocol_upgrade) that this binary does not know.
function injectSchedule(service: NodeService, activationHeight: number, protocolVersion: number): void {
  (service.store.chain as unknown as { protocolSchedule: Map<number, number> }).protocolSchedule.set(activationHeight, protocolVersion);
}

const supported = [...SUPPORTED_PROTOCOL_VERSIONS].sort((a, b) => a - b);

test("protocol schedule: GET /protocol-schedule reports no future entries on a fresh chain", async () => {
  await withNode("zyron-psched-empty", async ({ get }) => {
    assert.deepEqual(await get("/protocol-schedule"), {
      status: 200,
      body: { height: 0, currentVersion: 1, supportedVersions: supported, scheduled: [], firstUnsupported: null }
    });
  });
});

test("protocol schedule: a scheduled unsupported version is visible long before activation while /readyz stays ready", async () => {
  await withNode("zyron-psched-unsupported", async ({ get, service }) => {
    injectSchedule(service, 500, 6);
    injectSchedule(service, 9_000, 99);
    assert.deepEqual(await get("/protocol-schedule"), {
      status: 200,
      body: {
        height: 0,
        currentVersion: 1,
        supportedVersions: supported,
        scheduled: [
          { activationHeight: 500, protocolVersion: 6, supported: true },
          { activationHeight: 9_000, protocolVersion: 99, supported: false }
        ],
        firstUnsupported: { activationHeight: 9_000, protocolVersion: 99 }
      }
    });
    // Informational only: far from activation the node stays ready, and the
    // strict /protocol shape read by the CLI is unchanged.
    assert.deepEqual(await get("/readyz"), { status: 200, body: { ready: true, height: 0, reasons: [] } });
    assert.deepEqual(await get("/protocol"), { status: 200, body: { currentVersion: 1, nextVersion: 1 } });
  });
});

test("protocol schedule: a supported-only schedule reports firstUnsupported null and past entries are not listed", async () => {
  await withNode("zyron-psched-supported", async ({ get, service }) => {
    injectSchedule(service, 0, 1);
    injectSchedule(service, 40, 5);
    const response = await get("/protocol-schedule");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.scheduled, [{ activationHeight: 40, protocolVersion: 5, supported: true }]);
    assert.equal(response.body.firstUnsupported, null);
  });
});

test("protocol schedule: the listed future entries are bounded", async () => {
  await withNode("zyron-psched-bounded", async ({ get, service }) => {
    for (let index = 1; index <= 100; index += 1) injectSchedule(service, index * 10, 5);
    injectSchedule(service, 5_000, 77);
    const response = await get("/protocol-schedule");
    assert.equal(response.status, 200);
    assert.equal((response.body.scheduled as unknown[]).length, 64);
    // The unsupported entry beyond the listed window is still reported.
    assert.deepEqual(response.body.firstUnsupported, { activationHeight: 5_000, protocolVersion: 77 });
  });
});
