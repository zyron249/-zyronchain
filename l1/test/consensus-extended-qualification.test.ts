import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { validatorQuorumSize } from "../src/block.js";
import { MIN_PROTOCOL_UPDATE_DELAY } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { writeLockCertificate } from "../src/lock-certificate-store.js";
import { MAX_MINING_MEMPOOL_CLAIMS, Mempool } from "../src/mempool.js";
import {
  INITIAL_MINING_REWARD_ATOMS,
  MINING_DIFFICULTY_BITS,
  MINING_ERA_TARGET_CLAIMS,
  MINING_PROTOCOL_VERSION,
  meetsMiningDifficulty,
  miningWorkHash
} from "../src/mining.js";
import {
  BLOCK_INTERVAL_MS,
  MAX_BODY_BYTES,
  MAX_CONSENSUS_ROUND_CATCHUP,
  NodeService,
  produceFinalizedBlock,
  ROUND_WINDOW_MS,
  type ConsensusPeerClient
} from "../src/node.js";
import { createMinerCohort, runMinerWorkload, WORKLOAD_SCENARIOS } from "../src/public-testnet-readiness.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import {
  createMiningClaim,
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer
} from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type Block, type GenesisConfig } from "../src/types.js";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);

function privateKey(byte: number): string {
  return byte.toString(16).padStart(64, "0");
}

function directPeers(services: NodeService[], nowMs: number): ConsensusPeerClient {
  return {
    async requestPrepares(block) {
      const votes = [];
      for (const service of services) {
        try { votes.push(await service.prepareProposal(block, nowMs)); } catch { /* refused */ }
      }
      return votes;
    },
    async requestAttestations(block, prepares = []) {
      const attestations = [];
      for (const service of services) {
        try { attestations.push(await service.attestProposal(block, nowMs, prepares)); } catch { /* refused */ }
      }
      return attestations;
    },
    async requestViewChanges(height, round, previousCertificate = [], knownPrepares = []) {
      const votes = [];
      for (const service of services) {
        try { votes.push(await service.requestViewChange(height, round, previousCertificate, knownPrepares, nowMs)); } catch { /* refused */ }
      }
      return votes;
    },
    async requestPrepareReports(height, round, previousHash) {
      const reports = [];
      for (const service of services) {
        try { reports.push(await service.reportPrepare(height, round, previousHash, nowMs)); } catch { /* refused */ }
      }
      return reports;
    },
    async requestRoundSkips(height, round, previousCertificate = []) {
      const votes = [];
      for (const service of services) {
        try { votes.push(await service.requestSkipVote(height, round, previousCertificate, nowMs)); } catch { /* refused */ }
      }
      return votes;
    },
    async requestLockedAttestations(height, round, previousHash) {
      const evidence = [];
      for (const service of services) {
        try { evidence.push(await service.lockedAttestEvidence(height, round, previousHash, nowMs)); } catch { /* none */ }
      }
      return evidence;
    },
    async requestRoundReports(height, round, previousHash) {
      const reports = [];
      for (const service of services) {
        try { reports.push(await service.reportRoundChoice(height, round, previousHash, nowMs)); } catch { /* refused */ }
      }
      return reports;
    },
    async requestCompletionAttestations(block, votes, prepares = []) {
      const attestations = [];
      for (const service of services) {
        try { attestations.push(await service.attestCompletion(block, votes, nowMs, prepares)); } catch { /* refused */ }
      }
      return attestations;
    },
    async broadcastBlock(block) {
      for (const service of services) {
        try { await service.acceptFinalizedBlock(block); } catch { /* already accepted */ }
      }
    }
  };
}

type Fault = "delay" | "loss" | "duplicate" | "reorder";

function chaosPeers(inner: ConsensusPeerClient, fault: Fault): ConsensusPeerClient {
  async function shape<T>(values: T[]): Promise<T[]> {
    if (fault === "delay") await new Promise((resolve) => setTimeout(resolve, 25));
    if (fault === "loss") return [];
    if (fault === "duplicate") return [...values, ...values];
    return [...values].reverse();
  }
  return {
    requestPrepares: async (block) => shape(await inner.requestPrepares!(block)),
    requestAttestations: async (block, prepares) => shape(await inner.requestAttestations(block, prepares)),
    requestViewChanges: async (height, round, previous, known) => shape(await inner.requestViewChanges!(height, round, previous, known)),
    requestPrepareReports: async (height, round, previousHash) => shape(await inner.requestPrepareReports!(height, round, previousHash)),
    requestRoundSkips: async (height, round, previous) => shape(await inner.requestRoundSkips(height, round, previous)),
    requestLockedAttestations: async (height, round, previousHash) => shape(await inner.requestLockedAttestations!(height, round, previousHash)),
    requestRoundReports: async (height, round, previousHash) => shape(await inner.requestRoundReports!(height, round, previousHash)),
    requestCompletionAttestations: async (block, votes, prepares) => shape(await inner.requestCompletionAttestations!(block, votes, prepares)),
    broadcastBlock: (block) => inner.broadcastBlock(block)
  };
}

async function openSet(count: number, label: string, extraAllocation?: GenesisConfig["allocations"][number]): Promise<{
  services: NodeService[];
  journals: SigningJournal[];
  directories: string[];
  keys: string[];
  publics: string[];
  config: GenesisConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), `zyron-ext-${label}-`));
  const keys = Array.from({ length: count }, (_, index) => privateKey(0xa0 + index));
  const publics = keys.map((key) => publicKeyFromPrivate(key));
  const addresses = publics.map((key) => addressFromPublicKey(key));
  const config: GenesisConfig = {
    chainId: `zyron-ext-${label}`,
    timestampMs: 1_700_000_000_000,
    validators: addresses.map((address, index) => ({ address, publicKey: publics[index]! })),
    activityOracles: [publicKeyFromPrivate(privateKey(0x71))],
    activityPool: addressFromPublicKey(publicKeyFromPrivate(privateKey(0x72))),
    allocations: [
      { address: addresses[0]!, amountAtoms: 1_000_000_000 },
      ...(extraAllocation ? [extraAllocation] : [])
    ]
  };
  const directories: string[] = [];
  const services: NodeService[] = [];
  const journals: SigningJournal[] = [];
  for (let index = 0; index < count; index += 1) {
    const directory = await mkdtemp(join(root, `v${index}-`));
    directories.push(directory);
    const journal = await SigningJournal.open(directory);
    journals.push(journal);
    services.push(new NodeService(await ChainStore.open(config, directory), journal, keys[index]!));
  }
  return { services, journals, directories, keys, publics, config };
}

async function closeSet(journals: SigningJournal[], directories: string[]): Promise<void> {
  for (const journal of journals) journal.close();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}

test("chaos delay, loss, duplication, and reorder keep a single hash", async () => {
  const opened = await openSet(4, "chaos");
  try {
    const now = opened.config.timestampMs + BLOCK_INTERVAL_MS;
    const peers = directPeers(opened.services.slice(1), now);
    const delayed = await produceFinalizedBlock(opened.services[0]!, chaosPeers(peers, "delay"), opened.keys[0]!, now);
    assert.ok(delayed);
    assert.equal(delayed.header.round, 0);
    assert.ok(delayed.attestations.length >= validatorQuorumSize(4));
    assert.ok(delayed.attestations.length <= 4);
    for (const service of opened.services) {
      assert.equal(service.status().height, 1);
      assert.equal(service.status().tipHash, delayed.hash);
    }
    const next = opened.config.timestampMs + (2 * BLOCK_INTERVAL_MS);
    const reordered = await produceFinalizedBlock(
      opened.services[1]!,
      chaosPeers(directPeers([opened.services[0]!, opened.services[2]!, opened.services[3]!], next), "reorder"),
      opened.keys[1]!,
      next
    );
    assert.ok(reordered);
    assert.equal(reordered.header.height, 2);
    assert.equal(new Set(opened.services.map((service) => service.status().tipHash)).size, 1);
  } finally {
    await closeSet(opened.journals, opened.directories);
  }
});

test("message loss does not finalize, and clearing the loss finalizes one hash", async () => {
  const opened = await openSet(4, "loss");
  try {
    const now = opened.config.timestampMs + BLOCK_INTERVAL_MS;
    const lost = await produceFinalizedBlock(
      opened.services[0]!,
      chaosPeers(directPeers(opened.services.slice(1), now), "loss"),
      opened.keys[0]!,
      now
    );
    assert.equal(lost, null);
    for (const service of opened.services) assert.equal(service.status().height, 0);
    const healed = await produceFinalizedBlock(
      opened.services[0]!,
      directPeers(opened.services.slice(1), now),
      opened.keys[0]!,
      now
    );
    assert.ok(healed);
    const hashes = new Set(opened.services.map((service) => service.status().tipHash));
    assert.equal(hashes.size, 1);
    assert.equal(opened.services[0]!.status().height, 1);
  } finally {
    await closeSet(opened.journals, opened.directories);
  }
});

test("duplicated peer votes cannot pad a short quorum into finality", async () => {
  const opened = await openSet(4, "dup");
  try {
    const now = opened.config.timestampMs + BLOCK_INTERVAL_MS;
    let short: Block | null = null;
    try {
      short = await produceFinalizedBlock(
        opened.services[0]!,
        chaosPeers(directPeers([opened.services[1]!], now), "duplicate"),
        opened.keys[0]!,
        now
      );
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /Duplicate/);
    }
    assert.equal(short, null);
    for (const service of opened.services) assert.equal(service.status().height, 0);
    const healed = await produceFinalizedBlock(
      opened.services[0]!,
      directPeers(opened.services.slice(1), now),
      opened.keys[0]!,
      now
    );
    assert.ok(healed);
    assert.equal(new Set(opened.services.map((service) => service.status().tipHash)).size, 1);
    assert.equal(opened.services[0]!.status().height, 1);
  } finally {
    await closeSet(opened.journals, opened.directories);
  }
});

test("a round above the catch-up bound does not finalize", async () => {
  const opened = await openSet(3, "future");
  try {
    const now = opened.config.timestampMs + BLOCK_INTERVAL_MS + ((MAX_CONSENSUS_ROUND_CATCHUP + 1) * ROUND_WINDOW_MS);
    const block = await produceFinalizedBlock(
      opened.services[0]!,
      directPeers(opened.services.slice(1), now),
      opened.keys[0]!,
      now
    );
    assert.equal(block, null);
    assert.equal(opened.services[0]!.status().height, 0);
  } finally {
    await closeSet(opened.journals, opened.directories);
  }
});

test("replaying a finalized block does not create a second tip", async () => {
  const opened = await openSet(3, "stale");
  try {
    const now = opened.config.timestampMs + BLOCK_INTERVAL_MS;
    const block = await produceFinalizedBlock(
      opened.services[0]!,
      directPeers(opened.services.slice(1), now),
      opened.keys[0]!,
      now
    );
    assert.ok(block);
    await assert.rejects(
      () => opened.services[1]!.acceptFinalizedBlock(block),
      /sequential|persistence|already|height|tip/i
    );
    assert.equal(opened.services[1]!.status().height, 1);
    assert.equal(opened.services[1]!.status().tipHash, block.hash);
  } finally {
    await closeSet(opened.journals, opened.directories);
  }
});

test("journal power loss before and after sync never releases two prepares", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-journal-power-"));
  try {
    const beforeSync = await SigningJournal.open(directory);
    await assert.rejects(
      () => beforeSync.reservePrepare(1, 0, HASH_A, { afterWrite: () => { throw new Error("power loss before sync"); } }),
      /persistence failed/
    );
    await assert.rejects(() => beforeSync.reservePrepare(1, 0, HASH_B), /persistence fault/);
    beforeSync.close();
    const reopened = await SigningJournal.open(directory);
    const seen = reopened.phase(1, 0, "prepare");
    if (seen) assert.equal(seen.value, HASH_A);
    else await reopened.reservePrepare(1, 0, HASH_A);
    await assert.rejects(() => reopened.reservePrepare(1, 0, HASH_B), /Conflicting/);
    reopened.close();

    const syncedDir = await mkdtemp(join(tmpdir(), "zyron-journal-synced-"));
    const synced = await SigningJournal.open(syncedDir);
    await assert.rejects(
      () => synced.reserveAttestation(1, 0, HASH_A, { afterSync: () => { throw new Error("power loss after sync"); } }),
      /persistence failed/
    );
    synced.close();
    const replay = await SigningJournal.open(syncedDir);
    assert.equal(replay.choice(1, 0)?.value, HASH_A);
    await assert.rejects(() => replay.reserveAttestation(1, 0, HASH_B), /Conflicting/);
    replay.close();
    await rm(syncedDir, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an orphan lock file without a journal commit does not finalize", async () => {
  const opened = await openSet(1, "orphan-lock");
  try {
    await writeLockCertificate(join(opened.directories[0]!, "lock-certificates"), 1, 0, []);
    const now = opened.config.timestampMs + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS;
    const vote = await opened.services[0]!.requestViewChange(1, 0, [], [], now);
    assert.equal(vote.lockHash, null);
    assert.equal(vote.lockRound, null);
    assert.equal(opened.services[0]!.status().height, 0);
  } finally {
    await closeSet(opened.journals, opened.directories);
  }
});

test("mempool and certificate bounds stay finite", () => {
  assert.equal(MAX_BODY_BYTES, 2_500_000);
  assert.equal(MAX_MINING_MEMPOOL_CLAIMS, 256);
  assert.equal(MAX_CONSENSUS_ROUND_CATCHUP, 64);
  const senderKey = privateKey(0x31);
  const sender = addressFromPublicKey(publicKeyFromPrivate(senderKey));
  const otherKey = privateKey(0x32);
  const other = addressFromPublicKey(publicKeyFromPrivate(otherKey));
  const pool = new Mempool(1, 0);
  const first = createTransfer({
    chainId: "zyron-ext-bounds",
    nonce: 1,
    sender,
    receiver: other,
    amountAtoms: 1,
    feeAtoms: 10,
    timestampMs: 1
  }, senderKey, publicKeyFromPrivate(senderKey));
  const second = createTransfer({
    chainId: "zyron-ext-bounds",
    nonce: 1,
    sender: other,
    receiver: sender,
    amountAtoms: 1,
    feeAtoms: 1,
    timestampMs: 1
  }, otherKey, publicKeyFromPrivate(otherKey));
  pool.add(first);
  assert.throws(() => pool.add(second), /Mempool full/);
  assert.equal(pool.size, 1);
});

test("NodeService reaches protocol v5 after delay 100, mines one 6.25 claim, and restarts", { timeout: 180_000 }, async () => {
  assert.equal(MIN_PROTOCOL_UPDATE_DELAY, 100);
  assert.equal(MINING_PROTOCOL_VERSION, 5);
  assert.equal(MINING_DIFFICULTY_BITS, 20);
  assert.equal(MINING_ERA_TARGET_CLAIMS, 4_000_000);
  assert.equal(INITIAL_MINING_REWARD_ATOMS, 6.25 * ATOMS_PER_ZYN);
  const minerKey = privateKey(0x91);
  const minerPublic = publicKeyFromPrivate(minerKey);
  const miner = addressFromPublicKey(minerPublic);
  const opened = await openSet(3, "v5-nodeservice", { address: miner, amountAtoms: 0 });
  try {
    const genesisSupply = opened.services[0]!.store.chain.totalSupplyAtoms();
    const upgradeInput = {
      chainId: opened.config.chainId,
      nonce: 1,
      sender: addressFromPublicKey(opened.publics[0]!),
      activationHeight: 101,
      protocolVersion: MINING_PROTOCOL_VERSION
    };
    const upgrade = createProtocolUpgrade({
      ...upgradeInput,
      approvals: opened.keys.map((key, index) => createProtocolUpgradeApproval(upgradeInput, key, opened.publics[index]!)),
      timestampMs: opened.config.timestampMs + 50
    }, opened.keys[0]!, opened.publics[0]!);
    opened.services[0]!.submitTransaction(upgrade);
    let tip: Block | undefined;
    for (let height = 1; height <= 100; height += 1) {
      const proposer = (height - 1) % 3;
      const now = opened.config.timestampMs + (height * BLOCK_INTERVAL_MS);
      const peers = directPeers(opened.services.filter((_, index) => index !== proposer), now);
      const block = await produceFinalizedBlock(opened.services[proposer]!, peers, opened.keys[proposer]!, now);
      assert.ok(block, `height ${height}`);
      assert.equal(block.header.height, height);
      assert.equal(block.header.version, 1);
      assert.equal(block.transactions.filter((tx) => tx.kind === "mining_claim").length, 0);
      tip = block;
    }
    assert.ok(tip);
    assert.equal(opened.services[0]!.store.chain.protocolVersionAt(100), 1);
    assert.equal(opened.services[0]!.store.chain.protocolVersionAt(101), 5);
    assert.equal(opened.services[0]!.store.chain.nextMiningRewardAtoms(), INITIAL_MINING_REWARD_ATOMS);
    const work = {
      chainId: opened.config.chainId,
      nonce: 1,
      sender: miner,
      height: 101,
      previousHash: tip.hash,
      rewardAtoms: INITIAL_MINING_REWARD_ATOMS,
      workNonce: "0000000000000000",
      publicKey: minerPublic
    };
    let solved: string | undefined;
    for (let counter = 0; counter < 20_000_000; counter += 1) {
      const workNonce = counter.toString(16).padStart(16, "0");
      if (meetsMiningDifficulty(miningWorkHash({ ...work, workNonce }))) {
        solved = workNonce;
        break;
      }
    }
    assert.ok(solved);
    const claim = createMiningClaim({
      chainId: work.chainId,
      nonce: 1,
      sender: miner,
      height: 101,
      previousHash: tip.hash,
      rewardAtoms: INITIAL_MINING_REWARD_ATOMS,
      workNonce: solved,
      timestampMs: opened.config.timestampMs + (101 * BLOCK_INTERVAL_MS)
    }, minerKey, minerPublic);
    opened.services[1]!.submitTransaction(claim);
    const now = opened.config.timestampMs + (101 * BLOCK_INTERVAL_MS);
    const mined = await produceFinalizedBlock(
      opened.services[1]!,
      directPeers([opened.services[0]!, opened.services[2]!], now),
      opened.keys[1]!,
      now
    );
    assert.ok(mined);
    assert.equal(mined.header.version, 5);
    assert.equal(mined.header.height, 101);
    const claims = mined.transactions.filter((tx) => tx.kind === "mining_claim");
    assert.equal(claims.length, 1);
    assert.equal(claims[0] && "rewardAtoms" in claims[0] ? claims[0].rewardAtoms : 0, INITIAL_MINING_REWARD_ATOMS);
    assert.equal(opened.services[1]!.store.chain.totalSupplyAtoms(), genesisSupply + INITIAL_MINING_REWARD_ATOMS);
    assert.equal(opened.services[1]!.store.chain.balance(miner), INITIAL_MINING_REWARD_ATOMS);
    const names = await readdir(join(opened.directories[1]!, "round-proposals")).catch(() => []);
    assert.equal(names.filter((name) => {
      const height = Number(name.split("-")[0]);
      return Number.isSafeInteger(height) && height <= 101;
    }).length, 0);
    for (const journal of opened.journals) journal.close();
    const restarted = new NodeService(
      await ChainStore.open(opened.config, opened.directories[1]!),
      await SigningJournal.open(opened.directories[1]!),
      opened.keys[1]!
    );
    assert.equal(restarted.status().height, 101);
    assert.equal(restarted.status().tipHash, mined.hash);
    assert.equal(restarted.store.chain.protocolVersionAt(101), 5);
    restarted.store.chain.totalSupplyAtoms();
    assert.equal(restarted.store.chain.totalSupplyAtoms(), genesisSupply + INITIAL_MINING_REWARD_ATOMS);
  } finally {
    for (const journal of opened.journals) {
      try { journal.close(); } catch { /* already closed */ }
    }
    await Promise.all(opened.directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
});

test("cohort sizes 3, 10, 25, and 50 reconcile supply and stop on a mismatch", () => {
  for (const cohortSize of [3, 10, 25, 50] as const) {
    assert.equal(createMinerCohort(cohortSize).length, cohortSize);
    const result = runMinerWorkload({
      cohortSize,
      scenario: "ramp",
      genesisSupplyAtoms: 0,
      profile: "low",
      chainId: "zyron-public-testnet-1",
      genesisHash: HASH_B
    });
    assert.equal(result.critical, false, String(cohortSize));
    assert.ok(result.supplyAtoms <= MAX_SUPPLY_ATOMS);
  }
  for (const scenario of WORKLOAD_SCENARIOS) {
    const result = runMinerWorkload({
      cohortSize: 25,
      scenario,
      genesisSupplyAtoms: 0,
      profile: "low",
      chainId: scenario === "wrong-chain" ? "zyron-devnet-1" : "zyron-public-testnet-1",
      genesisHash: HASH_B
    });
    assert.equal(result.critical, false, scenario);
  }
  const broken = runMinerWorkload({
    cohortSize: 50,
    scenario: "ramp",
    genesisSupplyAtoms: 0,
    profile: "low",
    chainId: "zyron-public-testnet-1",
    genesisHash: HASH_B,
    observedRewardsAtoms: [1]
  });
  assert.equal(broken.critical, true);
  assert.ok(broken.reasons.includes("CRITICAL FAIL"));
});

function childSource(nodeUrl: string, storageUrl: string): string {
  return [
    `const { createRpcServer, NodeService, PeerClient, produceFinalizedBlock } = await import(${JSON.stringify(nodeUrl)});`,
    `const { ChainStore, SigningJournal } = await import(${JSON.stringify(storageUrl)});`,
    `const { readFileSync } = await import("node:fs");`,
    `const genesis = JSON.parse(readFileSync(process.argv[1], "utf8"));`,
    `const directory = process.argv[2];`,
    `const privateKey = process.argv[3];`,
    `const service = new NodeService(await ChainStore.open(genesis, directory), await SigningJournal.open(directory), privateKey);`,
    `const server = createRpcServer(service);`,
    `await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(undefined)); });`,
    `const address = server.address();`,
    `process.stdout.write(JSON.stringify({ ready: true, port: address.port }) + "\\n");`,
    `let buffer = "";`,
    `const lines = [];`,
    `let pumping = false;`,
    `async function pump() {`,
    `  if (pumping) return;`,
    `  pumping = true;`,
    `  while (lines.length > 0) {`,
    `    const line = lines.shift();`,
    `    try {`,
    `      const message = JSON.parse(line);`,
    `      if (message.op === "produce") {`,
    `        const block = await produceFinalizedBlock(service, new PeerClient(message.peers), privateKey);`,
    `        const status = service.status();`,
    `        process.stdout.write(JSON.stringify({ ok: true, hash: block ? block.hash : null, round: block ? block.header.round : null, height: status.height, tipHash: status.tipHash, block }) + "\\n");`,
    `      } else if (message.op === "status") {`,
    `        const status = service.status();`,
    `        process.stdout.write(JSON.stringify({ ok: true, height: status.height, tipHash: status.tipHash }) + "\\n");`,
    `      } else if (message.op === "accept") {`,
    `        await service.acceptFinalizedBlock(message.block);`,
    `        const status = service.status();`,
    `        process.stdout.write(JSON.stringify({ ok: true, height: status.height, tipHash: status.tipHash }) + "\\n");`,
    `      } else process.stdout.write(JSON.stringify({ ok: false, error: "unknown op" }) + "\\n");`,
    `    } catch (error) {`,
    `      process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\\n");`,
    `    }`,
    `  }`,
    `  pumping = false;`,
    `  if (lines.length > 0) void pump();`,
    `}`,
    `process.stdin.on("data", (chunk) => {`,
    `  buffer += chunk.toString();`,
    `  let newline = buffer.indexOf("\\n");`,
    `  while (newline >= 0) { lines.push(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\\n"); }`,
    `  void pump();`,
    `});`
  ].join("\n");
}

async function startProxy(targetPort: number, delayMs: number): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      setTimeout(() => {
        const proxy = httpRequest({
          hostname: "127.0.0.1",
          port: targetPort,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: `127.0.0.1:${targetPort}` }
        }, (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        });
        proxy.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        proxy.end(Buffer.concat(chunks));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function lineReader(child: ChildProcess): { next(): Promise<string> } {
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queue.push(line);
  });
  return {
    next: () => queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve))
  };
}

async function runProcessMatrix(count: 4 | 7): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zyron-mp-${count}-`));
  const keys = Array.from({ length: count }, (_, index) => privateKey(0xb0 + index));
  const publics = keys.map((key) => publicKeyFromPrivate(key));
  const addresses = publics.map((key) => addressFromPublicKey(key));
  const genesisTimestamp = Date.now() - 35_000;
  const config: GenesisConfig = {
    chainId: `zyron-mp-chaos-${count}`,
    timestampMs: genesisTimestamp,
    validators: addresses.map((address, index) => ({ address, publicKey: publics[index]! })),
    activityOracles: [publicKeyFromPrivate(privateKey(0xc1))],
    activityPool: addressFromPublicKey(publicKeyFromPrivate(privateKey(0xc2))),
    allocations: [{ address: addresses[0]!, amountAtoms: 1_000 }]
  };
  const { writeFile } = await import("node:fs/promises");
  const genesisPath = join(root, "genesis.json");
  await writeFile(genesisPath, `${JSON.stringify(config)}\n`, "utf8");
  const directories = await Promise.all(Array.from({ length: count }, (_, index) => mkdtemp(join(root, `v${index}-`))));
  const nodeUrl = pathToFileURL(join(process.cwd(), "dist/src/node.js")).href;
  const storageUrl = pathToFileURL(join(process.cwd(), "dist/src/storage.js")).href;
  const script = childSource(nodeUrl, storageUrl);
  const children: ChildProcess[] = [];
  const readers: Array<{ next(): Promise<string> }> = [];
  const proxies: Array<{ close(): Promise<void> }> = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", script, genesisPath, directories[index]!, keys[index]!], {
        stdio: ["pipe", "pipe", "inherit"]
      });
      children.push(child);
      const queue: string[] = [];
      const waiters: Array<(line: string) => void> = [];
      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else queue.push(line);
      });
      readers.push({
        next: () => queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve))
      });
    }
    const ports: number[] = [];
    for (const reader of readers) {
      const ready = JSON.parse(await reader.next()) as { ready?: boolean; port?: number };
      assert.equal(ready.ready, true);
      ports.push(ready.port!);
    }
    const ask = async (index: number, message: unknown): Promise<Record<string, unknown>> => {
      children[index]!.stdin!.write(`${JSON.stringify(message)}\n`);
      return JSON.parse(await readers[index]!.next()) as Record<string, unknown>;
    };
    const quorum = validatorQuorumSize(count);
    const minority = ports.filter((_, index) => index !== 0).slice(0, quorum - 2).map((port) => `http://127.0.0.1:${port}`);
    const partitioned = await ask(0, { op: "produce", peers: minority });
    assert.equal(partitioned.ok, true, String(partitioned.error));
    assert.equal(partitioned.hash, null);
    assert.equal(partitioned.height, 0);
    const delayedPorts = await Promise.all(ports.slice(1).map(async (port, index) => {
      const proxy = await startProxy(port, 10 + (index * 5));
      proxies.push(proxy);
      return `http://127.0.0.1:${proxy.port}`;
    }));
    const healed = await ask(0, { op: "produce", peers: delayedPorts });
    assert.equal(healed.ok, true, String(healed.error));
    assert.equal(typeof healed.hash, "string");
    assert.equal(healed.height, 1);
    assert.equal(healed.round, 0);
    const stopped = children[1]!;
    await new Promise<void>((resolve) => {
      stopped.once("exit", () => resolve());
      stopped.kill("SIGKILL");
    });
    const restarted = spawn(process.execPath, ["--input-type=module", "--eval", script, genesisPath, directories[1]!, keys[1]!], {
      stdio: ["pipe", "pipe", "inherit"]
    });
    children.push(restarted);
    const restartReader = lineReader(restarted);
    const ready = JSON.parse(await restartReader.next()) as { ready?: boolean };
    assert.equal(ready.ready, true);
    restarted.stdin!.write(`${JSON.stringify({ op: "status" })}\n`);
    const status = JSON.parse(await restartReader.next()) as { ok?: boolean; height?: number; tipHash?: string; error?: string };
    assert.equal(status.ok, true, String(status.error));
    assert.equal(status.height, 1);
    assert.equal(status.tipHash, healed.hash);
    const freshDir = await mkdtemp(join(root, "fresh-"));
    const fresh = spawn(process.execPath, ["--input-type=module", "--eval", script, genesisPath, freshDir, keys[2]!], {
      stdio: ["pipe", "pipe", "inherit"]
    });
    children.push(fresh);
    const freshReader = lineReader(fresh);
    assert.equal(JSON.parse(await freshReader.next()).ready, true);
    fresh.stdin!.write(`${JSON.stringify({ op: "accept", block: healed.block })}\n`);
    const accepted = JSON.parse(await freshReader.next()) as { ok?: boolean; height?: number; tipHash?: string; error?: string };
    assert.equal(accepted.ok, true, String(accepted.error));
    assert.equal(accepted.height, 1);
    assert.equal(accepted.tipHash, healed.hash);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(proxies.map((proxy) => proxy.close()));
    await rm(root, { recursive: true, force: true });
  }
}

test("four OS processes survive partition, delayed heal, crash, and fresh sync", { timeout: 180_000 }, async () => {
  await runProcessMatrix(4);
});

test("seven OS processes survive partition, delayed heal, crash, and fresh sync", { timeout: 180_000 }, async () => {
  await runProcessMatrix(7);
});
