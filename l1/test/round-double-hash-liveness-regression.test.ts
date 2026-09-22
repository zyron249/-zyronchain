import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createBlockAttestation,
  createSignedBlock,
  validatorQuorumSize
} from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { removeLockCertificate } from "../src/lock-certificate-store.js";
import { createRpcServer, NodeService, PeerClient, produceFinalizedBlock, type ConsensusPeerClient } from "../src/node.js";
import {
  byzantineFaultBound,
  honestQuorumIntersection,
  roundChangeLivenessBound,
  uniquePossiblyFinalizedWithPrepares
} from "../src/round-view-change.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import type { Block, GenesisConfig, PrepareVote } from "../src/types.js";

/**
 * Real state-machine regression for the round-0 double-hash halt.
 *
 * Before prepare/commit, N=4 with 2+2 and N=7 with 3+3+1 returned a null
 * completion and never opened another round. Quorum stays floor(2N/3)+1.
 * These tests must keep failing closed on two reachable hashes and then
 * finalize exactly one later hash.
 */

function privateKey(byte: number): string {
  return byte.toString(16).padStart(64, "0");
}

function signOutsideJournal(service: NodeService, privateKeyValue: string, publicKey: string, timestampMs: number): Block {
  const unsigned = service.store.chain.prepareBlock([], publicKey, { timestampMs });
  return createSignedBlock({
    version: unsigned.header.version,
    chainId: unsigned.header.chainId,
    height: unsigned.header.height,
    round: unsigned.header.round,
    previousHash: unsigned.header.previousHash,
    timestampMs: unsigned.header.timestampMs,
    transactions: unsigned.transactions,
    stateRoot: unsigned.header.stateRoot,
    proposerPrivateKey: privateKeyValue,
    proposerPublicKey: publicKey
  });
}

async function openValidatorSet(count: number, label: string): Promise<{
  services: NodeService[];
  journals: SigningJournal[];
  stores: ChainStore[];
  directories: string[];
  keys: string[];
  publics: string[];
  config: GenesisConfig;
}> {
  const keys = Array.from({ length: count }, (_, index) => privateKey(0x51 + index));
  const publics = keys.map((key) => publicKeyFromPrivate(key));
  const addresses = publics.map((key) => addressFromPublicKey(key));
  const config: GenesisConfig = {
    chainId: `zyron-round-change-n${count}-${label}`,
    timestampMs: 1_700_000_000_000,
    validators: addresses.map((address, index) => ({ address, publicKey: publics[index]! })),
    activityOracles: [publicKeyFromPrivate(privateKey(0x71))],
    activityPool: addressFromPublicKey(publicKeyFromPrivate(privateKey(0x72))),
    allocations: [
      { address: addresses[0]!, amountAtoms: 1_000_000_000 },
      { address: addressFromPublicKey(publicKeyFromPrivate(privateKey(0x72))), amountAtoms: 5_000_000_000 }
    ]
  };
  const directories: string[] = [];
  const services: NodeService[] = [];
  const journals: SigningJournal[] = [];
  const stores: ChainStore[] = [];
  for (let index = 0; index < count; index += 1) {
    const directory = await mkdtemp(join(tmpdir(), `zyron-rvc-${label}-${index}-`));
    directories.push(directory);
    const store = await ChainStore.open(config, directory);
    const journal = await SigningJournal.open(directory);
    stores.push(store);
    journals.push(journal);
    services.push(new NodeService(store, journal, keys[index]));
  }
  return { services, journals, stores, directories, keys, publics, config };
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
    async requestRoundSkips(height, round, previousCertificate = []) {
      const votes = [];
      for (const service of services) {
        try { votes.push(await service.requestSkipVote(height, round, previousCertificate, nowMs)); } catch { /* refused */ }
      }
      return votes;
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
        try { await service.acceptFinalizedBlock(block); } catch { /* producer already accepted */ }
      }
    }
  };
}

async function closeOpened(opened: { journals: SigningJournal[]; directories: string[] }): Promise<void> {
  for (const journal of opened.journals) journal.close();
  await Promise.all(opened.directories.map((directory) => rm(directory, { recursive: true, force: true })));
}

async function plantDoubleHash(count: number, left: number, label: string, right = count - left): Promise<{
  opened: Awaited<ReturnType<typeof openValidatorSet>>;
  first: Block;
  second: Block;
  roundZero: number;
  roundOne: number;
}> {
  const opened = await openValidatorSet(count, label);
  const roundZero = opened.config.timestampMs + 30_000;
  const roundOne = opened.config.timestampMs + 60_000;
  const unsigned = opened.services[0]!.store.chain.prepareBlock([], opened.publics[0]!, { timestampMs: roundZero });
  const first = await opened.services[0]!.signPreparedProposal(unsigned, roundZero);
  for (let index = 1; index < left; index += 1) {
    await opened.services[index]!.prepareProposal(first, roundZero);
  }
  const second = signOutsideJournal(opened.services[0]!, opened.keys[0]!, opened.publics[0]!, roundZero + 1_000);
  assert.notEqual(second.hash, first.hash);
  for (let index = left; index < left + right; index += 1) {
    await opened.services[index]!.prepareProposal(second, roundZero + 1_000);
  }
  return { opened, first, second, roundZero, roundOne };
}

async function collectPrepares(services: NodeService[], previousHash: string, nowMs: number): Promise<PrepareVote[]> {
  const prepares: PrepareVote[] = [];
  for (const service of services) {
    const report = await service.reportPrepare(1, 0, previousHash, nowMs);
    if (report.vote) prepares.push(report.vote);
  }
  return prepares;
}

test("N=4 2+2 prepare split stays unsafe to complete and then finalizes one round-1 hash", async () => {
  const planted = await plantDoubleHash(4, 2, "n4-split");
  try {
    assert.equal(validatorQuorumSize(4), 3);
    assert.equal(byzantineFaultBound(4), 1);
    assert.equal(honestQuorumIntersection(4), 1);
    assert.equal(roundChangeLivenessBound(4), 2);
    const prepares = await collectPrepares(planted.opened.services, planted.first.header.previousHash, planted.roundOne);
    assert.equal(prepares.length, 4);
    const byHash = new Map<string, number>();
    for (const vote of prepares) byHash.set(vote.blockHash, (byHash.get(vote.blockHash) ?? 0) + 1);
    assert.equal(byHash.get(planted.first.hash), 2);
    assert.equal(byHash.get(planted.second.hash), 2);
    assert.equal(uniquePossiblyFinalizedWithPrepares(
      [],
      prepares,
      planted.opened.config.validators,
      planted.opened.config.chainId,
      1,
      0,
      planted.first.header.previousHash,
      1
    ), null);
    const roundOneProposer = 1;
    const peers = directPeers(
      planted.opened.services.filter((_, index) => index !== roundOneProposer),
      planted.roundOne
    );
    const block = await produceFinalizedBlock(
      planted.opened.services[roundOneProposer]!,
      peers,
      planted.opened.keys[roundOneProposer]!,
      planted.roundOne
    );
    assert.ok(block);
    assert.equal(block.header.height, 1);
    assert.equal(block.header.round, 1);
    assert.ok(block.header.round <= roundChangeLivenessBound(4));
    assert.ok(block.attestations.length >= 3);
    assert.notEqual(block.hash, planted.first.hash);
    assert.notEqual(block.hash, planted.second.hash);
    for (const service of planted.opened.services) {
      assert.equal(service.status().height, 1);
      assert.equal(service.status().tipHash, block.hash);
    }
    await assert.rejects(
      () => planted.opened.services[0]!.acceptFinalizedBlock({
        ...planted.first,
        attestations: [0, 1, 2].map((index) => createBlockAttestation(
          planted.first,
          planted.opened.keys[index]!,
          planted.opened.publics[index]!
        ))
      }),
      /Refusing non-sequential block persistence|Wrong block height|Block time must increase/
    );
  } finally {
    await closeOpened(planted.opened);
  }
});

test("N=7 3+3+1 prepare split stays unsafe to complete and then finalizes one round-1 hash", async () => {
  const planted = await plantDoubleHash(7, 3, "n7-split", 3);
  try {
    await planted.opened.services[6]!.requestSkipVote(1, 0, [], planted.roundOne);
    assert.equal(validatorQuorumSize(7), 5);
    assert.equal(byzantineFaultBound(7), 2);
    assert.equal(roundChangeLivenessBound(7), 3);
    const prepares = await collectPrepares(planted.opened.services, planted.first.header.previousHash, planted.roundOne);
    assert.equal(prepares.filter((vote) => vote.blockHash === planted.first.hash).length, 3);
    assert.equal(prepares.filter((vote) => vote.blockHash === planted.second.hash).length, 3);
    assert.equal(uniquePossiblyFinalizedWithPrepares(
      [],
      prepares,
      planted.opened.config.validators,
      planted.opened.config.chainId,
      1,
      0,
      planted.first.header.previousHash,
      1
    ), null);
    const block = await produceFinalizedBlock(
      planted.opened.services[1]!,
      directPeers(planted.opened.services.filter((_, index) => index !== 1), planted.roundOne),
      planted.opened.keys[1]!,
      planted.roundOne
    );
    assert.ok(block);
    assert.equal(block.header.round, 1);
    assert.ok(block.header.round <= roundChangeLivenessBound(7));
    assert.ok(block.attestations.length >= 5);
    const tips = new Set(planted.opened.services.map((service) => service.status().tipHash));
    assert.deepEqual([...tips], [block.hash]);
    for (const service of planted.opened.services) assert.equal(service.status().height, 1);
  } finally {
    await closeOpened(planted.opened);
  }
});

test("partition heal converges for N=4 2+2 and 3+1 and N=7 4+3 and 5+2", async () => {
  const cases = [
    { count: 4, left: 2, during: null, after: "new" },
    { count: 4, left: 3, during: "first", after: "first" },
    { count: 7, left: 4, during: null, after: "new" },
    { count: 7, left: 5, during: "first", after: "first" }
  ] as const;
  for (const item of cases) {
    const planted = await plantDoubleHash(item.count, item.left, `part-${item.count}-${item.left}`);
    try {
      const leftServices = planted.opened.services.slice(0, item.left);
      const rightServices = planted.opened.services.slice(item.left);
      const leftProducer = 1;
      const leftAttempt = await produceFinalizedBlock(
        planted.opened.services[leftProducer]!,
        directPeers(leftServices.filter((_, index) => index !== leftProducer), planted.roundOne),
        planted.opened.keys[leftProducer]!,
        planted.roundOne
      );
      if (item.during === null) {
        assert.equal(leftAttempt, null);
        for (const service of planted.opened.services) assert.equal(service.status().height, 0);
      } else {
        assert.ok(leftAttempt);
        assert.equal(leftAttempt.hash, planted.first.hash);
        assert.equal(leftAttempt.header.round, 0);
      }
      const rightAttempt = await produceFinalizedBlock(
        rightServices[0]!,
        directPeers(rightServices.slice(1), planted.roundOne),
        planted.opened.keys[item.left]!,
        planted.roundOne
      );
      assert.equal(rightAttempt, null);

      const healed = item.during === "first"
        ? leftAttempt
        : await produceFinalizedBlock(
          planted.opened.services[leftProducer]!,
          directPeers(planted.opened.services.filter((_, index) => index !== leftProducer), planted.roundOne),
          planted.opened.keys[leftProducer]!,
          planted.roundOne
        );
      assert.ok(healed);
      assert.equal(healed.header.height, 1);
      if (item.after === "first") assert.equal(healed.hash, planted.first.hash);
      else {
        assert.notEqual(healed.hash, planted.first.hash);
        assert.notEqual(healed.hash, planted.second.hash);
      }
      for (const service of planted.opened.services) {
        if (service.status().height === 0) await service.acceptFinalizedBlock(healed);
      }
      for (const service of planted.opened.services) {
        assert.equal(service.status().height, 1);
        assert.equal(service.status().tipHash, healed.hash);
      }
    } finally {
      await closeOpened(planted.opened);
    }
  }
});

test("a commit quorum cannot be abandoned and a lost lock file refuses a nil view-change", async () => {
  const opened = await openValidatorSet(4, "crash-lock");
  try {
    const roundZero = opened.config.timestampMs + 30_000;
    const roundOne = opened.config.timestampMs + 60_000;
    const unsigned = opened.services[0]!.store.chain.prepareBlock([], opened.publics[0]!, { timestampMs: roundZero });
    const proposal = await opened.services[0]!.signPreparedProposal(unsigned, roundZero);
    const prepares: PrepareVote[] = [];
    for (const index of [0, 1, 2]) {
      prepares.push(await opened.services[index]!.prepareProposal(proposal, roundZero));
    }
    const other = signOutsideJournal(opened.services[0]!, opened.keys[0]!, opened.publics[0]!, roundZero + 1_000);
    await assert.rejects(
      () => opened.services[0]!.prepareProposal(other, roundZero + 1_000),
      /Conflicting/
    );
    for (const index of [0, 1, 2]) {
      await opened.services[index]!.attestProposal(proposal, roundZero, prepares);
    }
    await assert.rejects(
      () => opened.services[0]!.attestProposal(other, roundOne, prepares),
      /Prepare vote does not match the proposal|Conflicting validator action|Prepare quorum required/
    );
    opened.journals[0]!.close();
    const reopened = await SigningJournal.open(opened.directories[0]!);
    opened.journals[0] = reopened;
    const restarted = new NodeService(opened.stores[0]!, reopened, opened.keys[0]!);
    const persisted = await restarted.requestViewChange(1, 0, [], [], roundOne);
    assert.equal(persisted.lockHash, proposal.hash);
    assert.equal(persisted.lockRound, 0);
    await removeLockCertificate(join(opened.directories[0]!, "lock-certificates"), 1, 0);
    await assert.rejects(
      () => restarted.requestViewChange(1, 0, [], [], roundOne),
      /Locked commit is missing its prepare quorum/
    );
    const restored = await restarted.requestViewChange(1, 0, [], prepares, roundOne);
    assert.equal(restored.lockHash, proposal.hash);
    assert.equal(restored.lockRound, 0);
    const block = await produceFinalizedBlock(
      opened.services[1]!,
      directPeers([restarted, opened.services[2]!, opened.services[3]!], roundOne),
      opened.keys[1]!,
      roundOne
    );
    assert.ok(block);
    assert.equal(block.hash, proposal.hash);
    assert.equal(block.header.round, 0);
    for (const service of [restarted, opened.services[1]!, opened.services[2]!, opened.services[3]!]) {
      assert.equal(service.status().height, 1);
      assert.equal(service.status().tipHash, proposal.hash);
    }
  } finally {
    await closeOpened(opened);
  }
});

test("four OS processes with separate directories, keys, and ports finalize one hash after a 2+2 split", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-rvc-mp-"));
  const keys = [0x81, 0x82, 0x83, 0x84].map((byte) => privateKey(byte));
  const publics = keys.map((key) => publicKeyFromPrivate(key));
  const addresses = publics.map((key) => addressFromPublicKey(key));
  const genesisTimestamp = Date.now() - 61_000;
  const config: GenesisConfig = {
    chainId: "zyron-round-change-multiprocess",
    timestampMs: genesisTimestamp,
    validators: addresses.map((address, index) => ({ address, publicKey: publics[index]! })),
    activityOracles: [publicKeyFromPrivate(privateKey(0x91))],
    activityPool: addressFromPublicKey(publicKeyFromPrivate(privateKey(0x92))),
    allocations: [
      { address: addresses[0]!, amountAtoms: 1_000_000_000 },
      { address: addressFromPublicKey(publicKeyFromPrivate(privateKey(0x92))), amountAtoms: 5_000_000_000 }
    ]
  };
  const genesisPath = join(root, "genesis.json");
  await writeFile(genesisPath, `${JSON.stringify(config)}\n`, "utf8");
  const directories = await Promise.all([0, 1, 2, 3].map((index) => mkdtemp(join(root, `v${index}-`))));
  const nodeUrl = pathToFileURL(join(process.cwd(), "dist/src/node.js")).href;
  const storageUrl = pathToFileURL(join(process.cwd(), "dist/src/storage.js")).href;
  const script = [
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
    `      if (message.op === "prepare") {`,
    `        const vote = await service.prepareProposal(message.block, Date.now());`,
    `        process.stdout.write(JSON.stringify({ ok: true, vote }) + "\\n");`,
    `      } else if (message.op === "produce") {`,
    `        const block = await produceFinalizedBlock(service, new PeerClient(message.peers), privateKey);`,
    `        process.stdout.write(JSON.stringify({ ok: true, hash: block ? block.hash : null, round: block ? block.header.round : null, height: service.status().height, tipHash: service.status().tipHash }) + "\\n");`,
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
  const children: ChildProcess[] = [];
  const readers: Array<{ next(): Promise<string> }> = [];
  try {
    const builderDir = await mkdtemp(join(root, "builder-"));
    const builderStore = await ChainStore.open(config, builderDir);
    const builderJournal = await SigningJournal.open(builderDir);
    const builder = new NodeService(builderStore, builderJournal, keys[0]!);
    const first = await builder.signPreparedProposal(
      builder.store.chain.prepareBlock([], publics[0]!, { timestampMs: genesisTimestamp + 30_000 }),
      Date.now()
    );
    const unsignedSecond = builder.store.chain.prepareBlock([], publics[0]!, { timestampMs: genesisTimestamp + 31_000 });
    const second = createSignedBlock({
      version: unsignedSecond.header.version,
      chainId: unsignedSecond.header.chainId,
      height: unsignedSecond.header.height,
      round: unsignedSecond.header.round,
      previousHash: unsignedSecond.header.previousHash,
      timestampMs: unsignedSecond.header.timestampMs,
      transactions: unsignedSecond.transactions,
      stateRoot: unsignedSecond.header.stateRoot,
      proposerPrivateKey: keys[0]!,
      proposerPublicKey: publics[0]!
    });
    assert.notEqual(first.hash, second.hash);
    builderJournal.close();

    for (let index = 0; index < 4; index += 1) {
      const child = spawn(process.execPath, [
        "--input-type=module",
        "--eval",
        script,
        genesisPath,
        directories[index]!,
        keys[index]!
      ], { stdio: ["pipe", "pipe", "inherit"] });
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
        next: () => queue.length > 0
          ? Promise.resolve(queue.shift()!)
          : new Promise((resolve) => waiters.push(resolve))
      });
    }
    const ports: number[] = [];
    for (const reader of readers) {
      const ready = JSON.parse(await reader.next()) as { ready?: boolean; port?: number };
      assert.equal(ready.ready, true);
      assert.equal(typeof ready.port, "number");
      ports.push(ready.port!);
    }
    const ask = async (index: number, message: unknown): Promise<Record<string, unknown>> => {
      children[index]!.stdin!.write(`${JSON.stringify(message)}\n`);
      return JSON.parse(await readers[index]!.next()) as Record<string, unknown>;
    };
    for (const index of [0, 1]) {
      const prepared = await ask(index, { op: "prepare", block: first });
      assert.equal(prepared.ok, true, String(prepared.error));
    }
    for (const index of [2, 3]) {
      const prepared = await ask(index, { op: "prepare", block: second });
      assert.equal(prepared.ok, true, String(prepared.error));
    }
    const peers = ports.flatMap((port, index) => index === 1 ? [] : [`http://127.0.0.1:${port}`]);
    const produced = await ask(1, { op: "produce", peers });
    assert.equal(produced.ok, true, String(produced.error));
    assert.equal(typeof produced.hash, "string");
    assert.notEqual(produced.hash, first.hash);
    assert.notEqual(produced.hash, second.hash);
    assert.equal(produced.height, 1);
    assert.ok(Number(produced.round) >= 1);
    assert.ok(Number(produced.round) <= roundChangeLivenessBound(4) + 1);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});
