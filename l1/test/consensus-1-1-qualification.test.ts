import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createSignedBlock,
  validateAttestationQuorum,
  validateBlockAttestation,
  validateRoundCertificate,
  validatorQuorumSize
} from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { BLOCK_INTERVAL_MS, createRpcServer, NodeService, produceFinalizedBlock } from "../src/node.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { NativeConsensusPeerClient, P2P_CONSENSUS_PROTOCOL, registerP2PConsensusProtocol } from "../src/p2p-consensus.js";
import { createP2PNode } from "../src/p2p.js";
import {
  assertViewChangeVoteShape,
  createPrepareVote,
  createViewChangeVote,
  roundChangeLivenessBound,
  SAFETY_INVARIANTS,
  validatePrepareVote,
  validateViewChangeCertificate
} from "../src/round-view-change.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import type { Block, GenesisConfig, Validator } from "../src/types.js";

const OLD_CONSENSUS_PROTOCOL = "/zyronchain/consensus/1.0.0";
const HASH = "ab".repeat(32);
const PREVIOUS = "cd".repeat(32);

function privateKey(byte: number): string {
  return byte.toString(16).padStart(64, "0");
}

function validatorFrom(byte: number): { privateKey: string; publicKey: string; validator: Validator } {
  const key = privateKey(byte);
  const publicKey = publicKeyFromPrivate(key);
  return { privateKey: key, publicKey, validator: { address: addressFromPublicKey(publicKey), publicKey } };
}

function minimalBlock(proposer: Block["header"]["proposer"], roundCertificate: Block["roundCertificate"] = []): Block {
  return {
    header: {
      version: 1,
      chainId: "zyron-consensus-1-1-qualification",
      height: 1,
      round: 1,
      previousHash: PREVIOUS,
      timestampMs: 1,
      transactionRoot: HASH,
      stateRoot: HASH,
      proposer
    },
    transactions: [],
    hash: HASH,
    proposerPublicKey: null,
    signature: null,
    roundCertificate,
    attestations: []
  };
}

test("S9 a view-change quorum does not satisfy finality", () => {
  assert.equal(SAFETY_INVARIANTS[8], "S9 timeout and view-change votes do not finalize a hash");
  const signers = [0x11, 0x12, 0x13, 0x14].map((byte) => validatorFrom(byte));
  const validators = signers.map((signer) => signer.validator);
  assert.equal(validatorQuorumSize(validators.length), 3);
  const votes = signers.slice(0, 3).map((signer) => createViewChangeVote({
    chainId: "zyron-consensus-1-1-qualification",
    height: 1,
    round: 0,
    previousHash: PREVIOUS,
    lockRound: null,
    lockHash: null,
    validatorPrivateKey: signer.privateKey,
    validatorPublicKey: signer.publicKey
  }));
  assert.equal(validateViewChangeCertificate(
    votes,
    validators,
    "zyron-consensus-1-1-qualification",
    1,
    0,
    PREVIOUS
  ), null);
  const block = minimalBlock(signers[0]!.validator.address, votes);
  assert.doesNotThrow(() => validateRoundCertificate(block, validators));
  assert.throws(() => validateAttestationQuorum(block, validators), /Finality quorum not reached: 0\/3/);
  assert.throws(() => validateBlockAttestation(block, votes[0], validators), /view-change vote|block attestation|Exact keys/);
  assert.throws(
    () => assertViewChangeVoteShape({ ...votes[0]!, prepares: Array.from({ length: 101 }, () => ({})) }),
    /prepare certificate exceeds/
  );
});

test("protocol v5 prepare signatures verify only under domain separation", () => {
  const signer = validatorFrom(0x21);
  const chainId = "zyron-consensus-1-1-qualification";
  const version5 = createPrepareVote({
    chainId,
    height: 1,
    round: 0,
    blockHash: HASH,
    validatorPrivateKey: signer.privateKey,
    validatorPublicKey: signer.publicKey,
    protocolVersion: 5
  });
  assert.doesNotThrow(() => validatePrepareVote(version5, [signer.validator], chainId, 1, 0, HASH, 5));
  assert.throws(
    () => validatePrepareVote(version5, [signer.validator], chainId, 1, 0, HASH, 1),
    /Invalid prepare signature/
  );
  const version1 = createPrepareVote({
    chainId,
    height: 1,
    round: 0,
    blockHash: HASH,
    validatorPrivateKey: signer.privateKey,
    validatorPublicKey: signer.publicKey,
    protocolVersion: 1
  });
  assert.throws(
    () => validatePrepareVote(version1, [signer.validator], chainId, 1, 0, HASH, 5),
    /Invalid prepare signature/
  );
});

test("malformed view-change HTTP fails closed before a vote is returned", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-view-malformed-"));
  const signer = validatorFrom(0x31);
  const genesis: GenesisConfig = {
    chainId: "zyron-consensus-1-1-qualification",
    timestampMs: Date.now(),
    validators: [signer.validator],
    activityOracles: [publicKeyFromPrivate(privateKey(0x32))],
    activityPool: addressFromPublicKey(publicKeyFromPrivate(privateKey(0x33))),
    allocations: [{ address: signer.validator.address, amountAtoms: 1_000 }]
  };
  const store = await ChainStore.open(genesis, root);
  const journal = await SigningJournal.open(root);
  const service = new NodeService(store, journal, signer.privateKey);
  const server = createRpcServer(service);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/round/view`;
  try {
    const bodies = [
      { body: "{", label: "broken json" },
      { body: JSON.stringify({ bad: true }), label: "wrong keys" },
      { body: JSON.stringify({ height: "1", round: 0, previousCertificate: [], knownPrepares: [] }), label: "string height" },
      { body: JSON.stringify({ height: 1, round: 0, previousCertificate: [], knownPrepares: "no" }), label: "prepares not array" },
      {
        body: JSON.stringify({
          height: 1,
          round: 0,
          previousCertificate: [],
          knownPrepares: [],
          extra: "x"
        }),
        label: "extra key"
      }
    ];
    for (const item of bodies) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: item.body
      });
      const payload = await response.json() as { error?: string; vote?: unknown };
      assert.equal(response.status, 400, item.label);
      assert.equal(payload.vote, undefined, item.label);
      assert.equal(typeof payload.error, "string", item.label);
      assert.equal(service.status().height, 0, item.label);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("consensus 1.0 streams are rejected and 1.1 still finalizes chain version 1", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "zyron-mix-source-"));
  const remoteDir = await mkdtemp(join(tmpdir(), "zyron-mix-remote-"));
  let sourceNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  let remoteNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const first = validatorFrom(0x41);
    const second = validatorFrom(0x42);
    const genesis: GenesisConfig = {
      chainId: "zyron-consensus-1-1-qualification",
      timestampMs: 1_700_000_000_000,
      validators: [first.validator, second.validator],
      activityOracles: [publicKeyFromPrivate(privateKey(0x43))],
      activityPool: addressFromPublicKey(publicKeyFromPrivate(privateKey(0x44))),
      allocations: [{ address: first.validator.address, amountAtoms: 1_000 }]
    };
    const source = new NodeService(
      await ChainStore.open(genesis, sourceDir),
      await SigningJournal.open(sourceDir),
      first.privateKey
    );
    const remote = new NodeService(
      await ChainStore.open(genesis, remoteDir),
      await SigningJournal.open(remoteDir),
      second.privateKey
    );
    const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
    const remoteIdentity = await loadOrCreateNodeIdentity(remoteDir);
    sourceNode = await createP2PNode(sourceIdentity);
    remoteNode = await createP2PNode(remoteIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    await registerP2PConsensusProtocol(remoteNode, remoteIdentity, remote);
    const remoteAddress = remoteNode.getMultiaddrs()[0];
    assert.ok(remoteAddress);
    const connection = await sourceNode.dial(remoteAddress);
    const rejections: string[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await assert.rejects(
        () => connection.newStream(OLD_CONSENSUS_PROTOCOL),
        (error: unknown) => {
          const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
          rejections.push(text);
          return error instanceof Error &&
            error.name === "UnsupportedProtocolError" &&
            /Protocol selection failed/.test(error.message);
        }
      );
    }
    assert.equal(rejections.length, 8);
    assert.equal(connection.status, "open");
    assert.equal(remoteNode.getConnections().length, 1);
    assert.equal(remote.status().height, 0);
    assert.equal(source.status().height, 0);
    const stream = await connection.newStream(P2P_CONSENSUS_PROTOCOL);
    assert.equal(stream.protocol, P2P_CONSENSUS_PROTOCOL);
    stream.abort(new Error("qualification probe"));
    await connection.close();
    for (let wait = 0; wait < 20 && remoteNode.getConnections().length > 0; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(remoteNode.getConnections().length, 0);
    const peers = new NativeConsensusPeerClient(sourceNode, [remoteAddress], sourceIdentity, source.status());
    const block = await produceFinalizedBlock(source, peers, first.privateKey, genesis.timestampMs + BLOCK_INTERVAL_MS);
    assert.ok(block);
    assert.equal(block.header.version, 1);
    assert.equal(block.attestations.length, validatorQuorumSize(2));
    assert.equal(source.status().height, 1);
    assert.equal(remote.status().height, 1);
    assert.equal(source.status().tipHash, remote.status().tipHash);
  } finally {
    await Promise.allSettled([sourceNode?.stop(), remoteNode?.stop()]);
    await rm(sourceDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});

test("seven OS processes with separate directories, keys, and ports finalize one hash after 3+3+1", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-rvc-mp7-"));
  const keys = [0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7].map((byte) => privateKey(byte));
  const publics = keys.map((key) => publicKeyFromPrivate(key));
  const addresses = publics.map((key) => addressFromPublicKey(key));
  const genesisTimestamp = Date.now() - 61_000;
  const config: GenesisConfig = {
    chainId: "zyron-round-change-multiprocess-n7",
    timestampMs: genesisTimestamp,
    validators: addresses.map((address, index) => ({ address, publicKey: publics[index]! })),
    activityOracles: [publicKeyFromPrivate(privateKey(0xc1))],
    activityPool: addressFromPublicKey(publicKeyFromPrivate(privateKey(0xc2))),
    allocations: [{ address: addresses[0]!, amountAtoms: 1_000_000_000 }]
  };
  const genesisPath = join(root, "genesis.json");
  await writeFile(genesisPath, `${JSON.stringify(config)}\n`, "utf8");
  const directories = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((index) => mkdtemp(join(root, `v${index}-`))));
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
    for (let index = 0; index < 7; index += 1) {
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
    for (const index of [0, 1, 2]) {
      const prepared = await ask(index, { op: "prepare", block: first });
      assert.equal(prepared.ok, true, String(prepared.error));
    }
    for (const index of [3, 4, 5]) {
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
    assert.equal(produced.tipHash, produced.hash);
    assert.ok(Number(produced.round) >= 1);
    assert.ok(Number(produced.round) <= roundChangeLivenessBound(7) + 1);
    const portsSeen = new Set(ports);
    assert.equal(portsSeen.size, 7);
    assert.equal(new Set(directories).size, 7);
    assert.equal(new Set(keys).size, 7);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});
