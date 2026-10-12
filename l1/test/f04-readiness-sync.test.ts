// F-04 residual (independent retest, round 2): a node that knows it is behind
// and is actively synchronizing must not report ready, but ordinary one-block
// propagation lag must not flap readiness, and a finished or failed sync must
// never leave a stuck not-ready state.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { NodeService, PeerClient, createRpcServer } from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { finalizedPrefixSchedule, testNetwork, type TestNetworkConfig } from "./support/consensus-harness.js";

const T = 1_700_000_000_000;

interface Readyz { status: number; body: { ready: boolean; height: number; reasons: string[] } }

async function withLocalAndRemote(
  label: string,
  remoteHeight: number,
  body: (context: {
    net: TestNetworkConfig;
    local: NodeService;
    remote: NodeService;
    remoteBase: string;
    readyz: () => Promise<Readyz>;
  }) => Promise<void>
): Promise<void> {
  const net = testNetwork(1, 0x31, label, T);
  const localDir = await mkdtemp(join(tmpdir(), "zyron-f04-sync-local-"));
  const remoteDir = await mkdtemp(join(tmpdir(), "zyron-f04-sync-remote-"));
  const originalNow = Date.now;
  Date.now = () => T + 30_000;
  const journal = await SigningJournal.open(localDir);
  const servers: Server[] = [];
  const listen = async (service: NodeService): Promise<string> => {
    const server = createRpcServer(service);
    servers.push(server);
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  try {
    const local = new NodeService(await ChainStore.open(net.genesis, localDir), journal, net.privateKeys[0]);
    const remoteStore = await ChainStore.open(net.genesis, remoteDir);
    for (const block of finalizedPrefixSchedule(net, [], remoteHeight)) await remoteStore.commitFinalizedBlock(block);
    const remote = new NodeService(remoteStore);
    const localBase = await listen(local);
    const remoteBase = await listen(remote);
    await body({
      net,
      local,
      remote,
      remoteBase,
      readyz: async () => {
        const response = await fetch(`${localBase}/readyz`);
        return { status: response.status, body: await response.json() as Readyz["body"] };
      }
    });
  } finally {
    Date.now = originalNow;
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    journal.close();
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
}

/** Hold the local node's first finalized-block application until released. */
function gateFirstAccept(local: NodeService): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const enteredPromise = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  const accept = local.acceptFinalizedBlock.bind(local);
  let first = true;
  local.acceptFinalizedBlock = async (value: unknown) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return accept(value);
  };
  return { entered: enteredPromise, release };
}

test("F-04: syncFrom a peer known to be two blocks ahead reports 503 syncing until caught up", async () => {
  await withLocalAndRemote("f04-sync-from", 2, async ({ local, remoteBase, readyz }) => {
    assert.deepEqual(await readyz(), { status: 200, body: { ready: true, height: 0, reasons: [] } });
    const gate = gateFirstAccept(local);
    const syncing = new PeerClient([remoteBase]).syncFrom(remoteBase, local);
    try {
      await gate.entered;
      assert.deepEqual(await readyz(), { status: 503, body: { ready: false, height: 0, reasons: ["syncing"] } });
    } finally {
      gate.release();
      await syncing.catch(() => undefined);
    }
    assert.equal(await syncing, 2);
    assert.deepEqual(await readyz(), { status: 200, body: { ready: true, height: 2, reasons: [] } });
  });
});

test("F-04: periodic syncAny with a verified peer two blocks ahead reports 503 syncing until caught up", async () => {
  await withLocalAndRemote("f04-sync-any", 2, async ({ local, remoteBase, readyz }) => {
    const gate = gateFirstAccept(local);
    const syncing = new PeerClient([remoteBase]).syncAny(local);
    try {
      await gate.entered;
      assert.deepEqual(await readyz(), { status: 503, body: { ready: false, height: 0, reasons: ["syncing"] } });
    } finally {
      gate.release();
      await syncing.catch(() => undefined);
    }
    assert.equal(await syncing, 2);
    assert.deepEqual(await readyz(), { status: 200, body: { ready: true, height: 2, reasons: [] } });
  });
});

test("F-04: ordinary one-block propagation lag during sync does not flap readiness", async () => {
  await withLocalAndRemote("f04-sync-lag-one", 1, async ({ local, remoteBase, readyz }) => {
    const gate = gateFirstAccept(local);
    const syncing = new PeerClient([remoteBase]).syncAny(local);
    try {
      await gate.entered;
      assert.deepEqual(await readyz(), { status: 200, body: { ready: true, height: 0, reasons: [] } });
    } finally {
      gate.release();
      await syncing.catch(() => undefined);
    }
    assert.equal(await syncing, 1);
  });
});

test("F-04: a failed sync does not leave the node stuck not-ready", async () => {
  await withLocalAndRemote("f04-sync-failed", 3, async ({ local, remote, remoteBase, readyz }) => {
    const gate = gateFirstAccept(local);
    const accept = local.acceptFinalizedBlock;
    // The second block application fails (for example a poisoned batch).
    let calls = 0;
    local.acceptFinalizedBlock = async (value: unknown) => {
      calls += 1;
      if (calls === 2) throw new Error("fixture: block rejected");
      return accept(value);
    };
    const syncing = new PeerClient([remoteBase]).syncFrom(remoteBase, local);
    try {
      await gate.entered;
      assert.equal((await readyz()).status, 503);
    } finally {
      gate.release();
      await syncing.catch(() => undefined);
    }
    await assert.rejects(syncing, /fixture: block rejected/);
    assert.equal(local.status().height, 1);
    assert.equal(remote.status().height, 3);
    // The sync attempt ended; readiness reflects only current evidence again.
    assert.deepEqual(await readyz(), { status: 200, body: { ready: true, height: 1, reasons: [] } });
  });
});
