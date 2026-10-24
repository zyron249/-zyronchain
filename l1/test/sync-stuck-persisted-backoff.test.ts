// Regression (op2, 2026-10-22): a follower with existing data stayed at its tip
// (4291) while the single configured gateway advanced, even though the next
// block (4292) extended that tip and validated. Root cause: failures recorded
// while the gateway cold-started were persisted in peer-reputation.json with an
// exponential backoff, reloaded on restart, and syncAny filtered out every
// configured peer without probing or logging. A fresh data dir has no
// reputation file, which is why a resync "fixed" it.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { NodeService, PeerClient, createRpcServer } from "../src/node.js";
import { PEER_LOG_REASON_MAX, peerLogReason } from "../src/node-base.js";
import { ChainStore } from "../src/storage.js";
import { PeerReputationStore } from "../src/peer-reputation.js";
import { finalizedPrefixSchedule, testNetwork } from "./support/consensus-harness.js";

const T = 1_700_000_000_000;

async function withFollower(
  label: string,
  body: (ctx: { local: NodeService; localDir: string; remoteBase: string; now: number }) => Promise<void>
): Promise<void> {
  const net = testNetwork(1, 0x52, label, T);
  const localDir = await mkdtemp(join(tmpdir(), "zyron-sync-stuck-local-"));
  const remoteDir = await mkdtemp(join(tmpdir(), "zyron-sync-stuck-remote-"));
  const originalNow = Date.now;
  const now = T + 60_000;
  Date.now = () => now;
  let server: Server | undefined;
  try {
    const schedule = finalizedPrefixSchedule(net, [], 2);
    const localStore = await ChainStore.open(net.genesis, localDir);
    await localStore.commitFinalizedBlock(schedule[0]!);
    const local = new NodeService(localStore);
    const remoteStore = await ChainStore.open(net.genesis, remoteDir);
    for (const block of schedule) await remoteStore.commitFinalizedBlock(block);
    server = createRpcServer(new NodeService(remoteStore));
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolveListen);
    });
    const remoteBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await body({ local, localDir, remoteBase, now });
  } finally {
    Date.now = originalNow;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
}

test("sync-stuck: persisted peer backoff from a gateway cold start does not wedge a follower whose only peer can extend its tip", async () => {
  await withFollower("sync-stuck-backoff", async ({ local, localDir, remoteBase, now }) => {
    // Same shape as op2's data.stale-stuck-20261022-1835/peer-reputation.json:
    // 5 consecutive failures, backoff still running at restart.
    await writeFile(join(localDir, "peer-reputation.json"), `${JSON.stringify({
      peers: [{
        backoffUntilMs: now + 8 * 60_000,
        consecutiveFailures: 5,
        endpoint: remoteBase,
        lastFailureMs: now - 3 * 60_000,
        lastSuccessMs: now - 35 * 60_000
      }],
      version: 1
    })}\n`, { mode: 0o600 });
    const reputation = await PeerReputationStore.open(localDir);
    assert.equal(local.status().height, 1);
    const accepted = await new PeerClient([remoteBase], undefined, undefined, reputation).syncAny(local);
    assert.equal(accepted, 1, "follower must fetch and apply the next block from its only peer");
    assert.equal(local.status().height, 2);
    assert.equal(reputation.failureCount(remoteBase), 0, "a successful sync clears the persisted backoff");
  });
});

test("sync-stuck: per-peer sync failures are logged with peer, height and reason", async () => {
  await withFollower("sync-stuck-log", async ({ local }) => {
    const dead = "http://127.0.0.1:9";
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      assert.equal(await new PeerClient([dead]).syncAny(local), 0);
    } finally {
      console.warn = originalWarn;
    }
    const line = warnings.find((w) => w.includes(dead));
    assert.ok(line, `expected a per-peer sync failure warning, got ${JSON.stringify(warnings)}`);
    assert.match(line!, /height 1/);
    assert.match(line!, /reason: \S/);
  });
});

test("sync-stuck: peer-supplied failure reasons are sanitized and capped in log lines", () => {
  const hostile = `bad block\nPeer sync: forged line\r\u0007${"x".repeat(500)}\u2028tail`;
  const reason = peerLogReason(new Error(hostile));
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(reason), JSON.stringify(reason));
  assert.ok(reason.length <= PEER_LOG_REASON_MAX + 1, `length ${reason.length}`);
  assert.ok(reason.endsWith("\u2026"));
  assert.ok(reason.startsWith("bad block Peer sync: forged line"));
  assert.equal(peerLogReason(new Error("fetch failed")), "fetch failed");
});
