// Regression (op3, 2026-11-01): a follower with one configured peer (the
// Render gateway) stalled after the gateway answered 429/500 for a while.
// Each failure doubled the persisted peer backoff (30 s up to 30 min) and the
// periodic sync silently filtered the peer out, so catch-up did not resume
// for many minutes after the gateway was healthy again, and node.log showed
// nothing but the last "Caught up N finalized block(s)" line.
//
// Expected behaviour: every periodic sync tick still contacts the soonest
// backed-off peer when all peers are gated, logs each failure, and resumes
// catch-up on the first tick after the peer recovers, reaching its tip.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { NodeService, PeerClient, createRpcServer } from "../src/node.js";
import { ChainStore } from "../src/storage.js";
import { PeerReputationStore } from "../src/peer-reputation.js";
import { finalizedPrefixSchedule, testNetwork } from "./support/consensus-harness.js";

const T = 1_700_000_000_000;
// Same cadence as the node's periodic sync: max(5 s, BLOCK_INTERVAL_MS / 3).
const SYNC_TICK_MS = 10_000;
const GATEWAY_FAILURES = 8;

test("follower catch-up: after 429/500 from the only peer and the backoff growing, the next tick after recovery resumes catch-up to the tip", async () => {
  const net = testNetwork(1, 0x53, "follower-catchup-retry", T);
  const localDir = await mkdtemp(join(tmpdir(), "zyron-follower-retry-local-"));
  const remoteDir = await mkdtemp(join(tmpdir(), "zyron-follower-retry-remote-"));
  const schedule = finalizedPrefixSchedule(net, [], 5);
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let now = T + 60_000;
  let gatewayFailures = 0;
  let gatewayRequests = 0;
  const warnings: string[] = [];
  let server: Server | undefined;
  try {
    Date.now = () => now;
    const localStore = await ChainStore.open(net.genesis, localDir);
    await localStore.commitFinalizedBlock(schedule[0]!);
    const local = new NodeService(localStore);
    const remoteStore = await ChainStore.open(net.genesis, remoteDir);
    for (const block of schedule.slice(0, 2)) await remoteStore.commitFinalizedBlock(block);
    server = createRpcServer(new NodeService(remoteStore));
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolveListen);
    });
    const gateway = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The Render gateway in front of the peer: rate limited (429) or failing
    // (500) while gatewayFailures > 0, a transparent proxy otherwise.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      gatewayRequests += 1;
      if (gatewayFailures > 0) {
        gatewayFailures -= 1;
        return new Response("{}", { status: gatewayFailures % 2 === 0 ? 500 : 429, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    const reputation = await PeerReputationStore.open(localDir);
    const client = new PeerClient([gateway], undefined, undefined, reputation);
    const tick = async (): Promise<number> => {
      now += SYNC_TICK_MS;
      return client.syncAny(local);
    };

    assert.equal(await tick(), 1, "initial catch-up from the gateway");
    assert.equal(local.status().height, 2);

    // The chain keeps finalizing while the gateway answers 429/500.
    gatewayFailures = GATEWAY_FAILURES;
    for (const block of schedule.slice(2)) await remoteStore.commitFinalizedBlock(block);
    for (let index = 0; index < GATEWAY_FAILURES; index += 1) {
      const requestsBefore = gatewayRequests;
      const warningsBefore = warnings.length;
      assert.equal(await tick(), 0);
      assert.ok(gatewayRequests > requestsBefore, `tick ${index + 1} during the outage must still contact the gateway`);
      assert.ok(warnings.length > warningsBefore, `tick ${index + 1} during the outage must log why sync made no progress`);
    }
    assert.equal(gatewayFailures, 0);
    assert.equal(reputation.failureCount(gateway), GATEWAY_FAILURES);
    assert.ok(reputation.backoffUntil(gateway) > now + 5 * 60_000, "the persisted backoff has grown well past one tick");
    assert.equal(local.status().height, 2, "no progress while the gateway fails");

    // Gateway healthy again: the very next tick resumes catch-up to the tip.
    assert.equal(await tick(), 3);
    assert.equal(local.status().height, 5, "follower reached the gateway tip");
    assert.equal(reputation.failureCount(gateway), 0, "a successful catch-up clears the backoff");
    assert.ok(warnings.some((line) => line.includes(gateway) && /HTTP 429/.test(line)), JSON.stringify(warnings));
    assert.ok(warnings.some((line) => line.includes(gateway) && /HTTP 500/.test(line)), JSON.stringify(warnings));
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});

test("peer reputation: a long backoff persisted before a restart is capped at 2 minutes on load; the failure count is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-follower-retry-load-"));
  try {
    const endpoint = "https://gateway.example/peer";
    const now = T + 3_600_000;
    // Same shape as op3's data/peer-reputation.json on Nov 1.
    await writeFile(join(dir, "peer-reputation.json"), `${JSON.stringify({
      peers: [{ backoffUntilMs: now + 25 * 60_000, consecutiveFailures: 7, endpoint, lastFailureMs: now - 60_000, lastSuccessMs: now - 3_600_000 }],
      version: 1
    })}\n`, { mode: 0o600 });
    const store = await PeerReputationStore.open(dir, now);
    assert.ok(store.backoffUntil(endpoint) <= now + 120_000, `backoff on load is bounded, got +${store.backoffUntil(endpoint) - now} ms`);
    assert.equal(store.isAvailable(endpoint, now + 120_000), true, "the peer is eligible again 2 minutes after the restart");
    assert.equal(store.failureCount(endpoint), 7, "the failure count survives the restart");
    // A still-failing peer goes straight back to its long backoff.
    assert.equal(await store.recordFailure(endpoint, now + 120_000), 30 * 60_000);

    // A short persisted backoff is kept as is.
    await writeFile(join(dir, "peer-reputation.json"), `${JSON.stringify({
      peers: [{ backoffUntilMs: now + 10_000, consecutiveFailures: 1, endpoint, lastFailureMs: now - 20_000, lastSuccessMs: 0 }],
      version: 1
    })}\n`, { mode: 0o600 });
    assert.equal((await PeerReputationStore.open(dir, now)).backoffUntil(endpoint), now + 10_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
