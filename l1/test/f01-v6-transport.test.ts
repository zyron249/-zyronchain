// F-01 protocol v6 over the real transports ([H+N] in spec §11): HTTP
// (/v6/prepare, /v6/commit, /v6/timeout, /v6/block) and native libp2p
// /zyronchain/consensus/2.0.0, with the wall clock (no injected time), plus
// the TS light client for v6 finality proofs and the v6 activation-margin
// mempool policy.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import {
  V6_COMMIT_VOTE_DOMAIN,
  V6_MIN_ACTIVATION_MARGIN_BLOCKS,
  V6_PREPARE_VOTE_DOMAIN,
  V6_TIMEOUT_GUARD_MS,
  roundStart,
  signV6,
  votePayload
} from "../src/consensus-v6.js";
import { verifyNextFinalizedHeader, type LightClientAnchor } from "../src/light-client.js";
import { PeerClient, createRpcServer, produceFinalizedBlock, type ConsensusPeerClient } from "../src/node.js";
import {
  NativeConsensusPeerClient,
  P2P_CONSENSUS_PROTOCOL,
  P2P_CONSENSUS_V6_PROTOCOL,
  nativeConsensusV6RequestMaxBytes,
  nativeConsensusV6ResponseMaxBytes,
  registerP2PConsensusProtocol
} from "../src/p2p-consensus.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createP2PNode } from "../src/p2p.js";
import type { Block } from "../src/types.js";
import {
  ACTIVATION_HEIGHT,
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  openValidator,
  proposerIndex,
  testNetwork,
  type TestValidator
} from "./support/consensus-harness.js";

const H = ACTIVATION_HEIGHT;

interface Transport {
  /** Client of validator `from` that reaches only `to`. */
  client(from: number, to: number[]): ConsensusPeerClient;
  close(): Promise<void>;
}

async function httpTransport(validators: TestValidator[]): Promise<Transport> {
  const servers: Server[] = [];
  const urls: string[] = [];
  for (const validator of validators) {
    const server = createRpcServer(validator.service);
    servers.push(server);
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    urls.push(`http://127.0.0.1:${address.port}`);
  }
  return {
    client: (_from, to) => new PeerClient(to.map((index) => urls[index]!)),
    close: async () => {
      await Promise.allSettled(servers.map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
    }
  };
}

async function nativeTransport(validators: TestValidator[]): Promise<Transport> {
  const nodes: Array<Awaited<ReturnType<typeof createP2PNode>>> = [];
  const identities: Array<Awaited<ReturnType<typeof loadOrCreateNodeIdentity>>> = [];
  try {
    for (const validator of validators) {
      const identity = await loadOrCreateNodeIdentity(validator.directory);
      const node = await createP2PNode(identity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
      nodes.push(node);
      identities.push(identity);
      await registerP2PConsensusProtocol(node, identity, validator.service);
    }
  } catch (error) {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    throw error;
  }
  return {
    client: (from, to) => new NativeConsensusPeerClient(
      nodes[from]!,
      to.map((index) => nodes[index]!.getMultiaddrs()[0]!),
      identities[from]!,
      validators[from]!.service.status()
    ),
    close: async () => { await Promise.allSettled(nodes.map((node) => node.stop())); }
  };
}

async function waitUntil(ms: number): Promise<void> {
  const delay = ms - Date.now();
  if (delay > 0) await sleep(delay);
}

for (const [name, makeTransport] of [["HTTP", httpTransport], ["native libp2p 2.0.0", nativeTransport]] as const) {
  test(`F-01 v6 [${name}] T2b over the wire with the wall clock: partial commit, TC with highQC, block fetch, same block finalizes`, { timeout: 120_000 }, async () => {
    // Round 0 of height 101 starts ~now (setup may use most of the 30 s round).
    const start = Date.now();
    const genesisMs = start - 100_000 - 30_000;
    const network = testNetwork(4, 0xc1, `zyron-f01-v6-wire-${name.startsWith("HTTP") ? "http" : "native"}`, genesisMs);
    const prefix = finalizedPrefix(network, 6);
    const validators: TestValidator[] = [];
    let transport: Transport | undefined;
    try {
      for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
      transport = await makeTransport(validators);
      const tipMs = validators[0]!.service.store.chain.tip.header.timestampMs;
      const p0 = proposerIndex(network, H, 0);
      const p1 = proposerIndex(network, H, 1);
      const [a, b] = [0, 1, 2, 3].filter((index) => index !== p0 && index !== p1) as [number, number];
      const others = (index: number): number[] => [0, 1, 2, 3].filter((item) => item !== index);
      await waitUntil(roundStart(tipMs, 0) + 50);
      assert.ok(Date.now() < roundStart(tipMs, 1) - V6_TIMEOUT_GUARD_MS - 1_000, "test setup overran round 0");
      // Round 0: prepare reaches a and b (QC forms without p1); commit reaches a only.
      const all0 = transport.client(p0, others(p0));
      const leader0: ConsensusPeerClient = {
        ...bind(all0),
        requestV6Prepare: (request) => transport!.client(p0, [a, b]).requestV6Prepare!(request),
        requestV6Commit: (request) => transport!.client(p0, [a]).requestV6Commit!(request)
      };
      assert.equal(await produceFinalizedBlock(validators[p0]!.service, leader0, network.privateKeys[p0]!), null);
      const locked = validators[a]!.journal.v6Lock(H);
      assert.ok(locked);
      assert.equal(validators[p1]!.journal.v6Row(H, 0, "prepare"), undefined);
      assert.equal(await validators[p1]!.service.v6FetchBlock(H, locked.blockHash), null);
      // Round 1 (wall clock): p1 pulls timeouts, fetches B by hash over the wire, re-proposes it.
      await waitUntil(roundStart(tipMs, 1) - V6_TIMEOUT_GUARD_MS + 20);
      const block = await produceFinalizedBlock(validators[p1]!.service, transport.client(p1, others(p1)), network.privateKeys[p1]!);
      assert.ok(block);
      assert.equal(block.hash, locked.blockHash);
      assert.equal(block.commitRound, 1);
      for (let attempt = 0; attempt < 50 && validators.some((validator) => validator.service.status().height !== H); attempt += 1) await sleep(100);
      assert.deepEqual(validators.map((validator) => validator.service.status().height), [H, H, H, H]);
      assert.ok(Date.now() - start < 90_000);
    } finally {
      await transport?.close();
      await closeValidators(validators);
    }
  });
}

function bind(client: ConsensusPeerClient): ConsensusPeerClient {
  return {
    requestAttestations: client.requestAttestations.bind(client),
    requestRoundSkips: client.requestRoundSkips.bind(client),
    broadcastBlock: client.broadcastBlock.bind(client),
    ...(client.requestV6Prepare ? { requestV6Prepare: client.requestV6Prepare.bind(client) } : {}),
    ...(client.requestV6Commit ? { requestV6Commit: client.requestV6Commit.bind(client) } : {}),
    ...(client.requestV6Timeouts ? { requestV6Timeouts: client.requestV6Timeouts.bind(client) } : {}),
    ...(client.fetchV6Block ? { fetchV6Block: client.fetchV6Block.bind(client) } : {})
  };
}

test("F-01 v6 native protocol: 2.0.0 is separate from 1.0.0 and has per-kind limits", () => {
  assert.equal(P2P_CONSENSUS_PROTOCOL, "/zyronchain/consensus/1.0.0");
  assert.equal(P2P_CONSENSUS_V6_PROTOCOL, "/zyronchain/consensus/2.0.0");
  assert.ok(nativeConsensusV6ResponseMaxBytes("timeout") >= 64_000); // a timeout carries a QC (spec §16.4)
  assert.ok(nativeConsensusV6RequestMaxBytes("timeout") <= 1_024);
  assert.ok(nativeConsensusV6RequestMaxBytes("prepare") > 2_500_000);
  assert.ok(nativeConsensusV6ResponseMaxBytes("prepare") <= 8_192);
  assert.ok(nativeConsensusV6ResponseMaxBytes("block") > 2_500_000);
});

test("F-01 v6 light client: verifies a v6 commit certificate and rejects legacy-format or forged proofs", { timeout: 60_000 }, async () => {
  const network = testNetwork(4, 0xd1, "zyron-f01-v6-light");
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  try {
    for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
    let clock = 0;
    const memory = new MemoryNetwork(validators, () => clock);
    const tip = validators[0]!.service.store.chain.tip;
    clock = roundStart(tip.header.timestampMs, 0) + 100;
    const leader = proposerIndex(network, H, 0);
    const block = await produceFinalizedBlock(validators[leader]!.service, memory.peersFor(leader), network.privateKeys[leader]!, clock) as Block;
    assert.ok(block);
    const anchor: LightClientAnchor = {
      version: 1,
      chainId: network.chainId,
      genesisHash: validators[0]!.service.status().genesisHash,
      height: tip.header.height,
      blockHash: tip.hash,
      stateRoot: tip.header.stateRoot,
      timestampMs: tip.header.timestampMs,
      protocolVersion: 6,
      validators: network.genesis.validators
    };
    const proof = {
      version: 2,
      header: block.header,
      hash: block.hash,
      proposerPublicKey: block.proposerPublicKey,
      signature: block.signature,
      roundCertificate: block.roundCertificate,
      attestations: block.attestations,
      commitRound: block.commitRound
    };
    const next = verifyNextFinalizedHeader(anchor, structuredClone(proof));
    assert.equal(next.height, H);
    assert.equal(next.blockHash, block.hash);
    assert.equal(next.protocolVersion, 6);
    const rejects = (mutate: (copy: Record<string, unknown>) => void, anchorValue: LightClientAnchor = anchor): void => {
      const copy = structuredClone(proof) as Record<string, unknown>;
      mutate(copy);
      assert.throws(() => verifyNextFinalizedHeader(anchorValue, copy));
    };
    rejects((copy) => { delete copy.commitRound; copy.version = 1; }); // legacy format for a v6 anchor
    rejects((copy) => { copy.version = 1; });
    rejects((copy) => { copy.commitRound = 1; });
    rejects((copy) => { copy.attestations = (copy.attestations as unknown[]).slice(0, 2); });
    rejects((copy) => {
      copy.attestations = network.privateKeys.slice(0, 3).map((key, index) => ({
        validator: network.genesis.validators[index]!.address,
        publicKey: network.publicKeys[index]!,
        signature: signV6(V6_PREPARE_VOTE_DOMAIN, votePayload(network.chainId, H, 0, block.hash), key)
      }));
    });
    rejects((copy) => {
      copy.roundCertificate = [{ ...(copy.attestations as Array<Record<string, unknown>>)[0]!, chainId: network.chainId, height: H, round: 0, previousHash: tip.hash }];
    });
    // A v6 proof against a legacy anchor is refused (version continuity + exact keys).
    rejects(() => {}, { ...anchor, protocolVersion: 5 });
    // A genuine certificate from a different quorum verifies too.
    const alt = structuredClone(proof);
    alt.attestations = network.privateKeys.slice(1).map((key, offset) => ({
      validator: network.genesis.validators[offset + 1]!.address,
      publicKey: network.publicKeys[offset + 1]!,
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(network.chainId, H, 0, block.hash), key)
    }));
    assert.equal(verifyNextFinalizedHeader(anchor, alt).blockHash, block.hash);
  } finally {
    await closeValidators(validators);
  }
});

test("F-01 v6 activation margin is mempool policy only: short-margin v6 upgrades are refused by the node, not by consensus", { timeout: 60_000 }, async () => {
  const network = testNetwork(4, 0xe1, "zyron-f01-v6-policy");
  const validator = await openValidator(network, 0, []);
  try {
    const service = validator.service;
    const height = service.status().height;
    const upgrade = (protocolVersion: number, activationHeight: number) => {
      const proposal = { chainId: network.chainId, nonce: 1, sender: network.genesis.validators[0]!.address, activationHeight, protocolVersion };
      return createProtocolUpgrade({
        ...proposal,
        approvals: network.privateKeys.map((key, index) => createProtocolUpgradeApproval(proposal, key, network.publicKeys[index]!)),
        timestampMs: network.genesis.timestampMs + 10
      }, network.privateKeys[0]!, network.publicKeys[0]!);
    };
    assert.throws(() => service.submitTransaction(upgrade(6, height + 101)), /node policy/);
    assert.throws(() => service.submitTransaction(upgrade(6, height + V6_MIN_ACTIVATION_MARGIN_BLOCKS)), /node policy/);
    assert.ok(service.submitTransaction(upgrade(6, height + 1 + V6_MIN_ACTIVATION_MARGIN_BLOCKS)));
    // Other versions keep the consensus minimum (MIN_PROTOCOL_UPDATE_DELAY) only.
    const other = await openValidator(network, 1, []);
    try {
      assert.ok(other.service.submitTransaction(upgrade(5, height + 101)));
    } finally {
      await closeValidators([other]);
    }
    // Consensus still accepts a block with a short-margin v6 upgrade (the
    // F-01 harness prefix includes one activating at 101): old and new binaries agree.
    assert.equal(finalizedPrefix(network, 6).length, H - 1);
  } finally {
    await closeValidators([validator]);
  }
});
