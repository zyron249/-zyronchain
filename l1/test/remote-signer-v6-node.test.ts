// P0-09 integration: protocol v6 validators whose keys live only in reference
// remote signers (HTTP, bearer token, own journal v2) still finalize, carry a
// partial-commit lock forward across a signer restart, and the signer itself
// refuses double-sign and lock-violating requests from a compromised node.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { roundStart, signV6, V6_PREPARE_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { NodeService, produceFinalizedBlock } from "../src/node.js";
import {
  ReferenceRemoteSigner,
  startReferenceRemoteSignerServer,
  type ReferenceRemoteSignerServer
} from "../src/remote-signer-service.js";
import type { Block } from "../src/types.js";
import { RemoteValidatorSigner, type ValidatorSigner, type ValidatorSigningIntent, type V6SigningContext } from "../src/validator-signer.js";
import {
  ACTIVATION_HEIGHT,
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  openValidator,
  proposerIndex,
  testNetwork,
  type TestNetworkConfig,
  type TestValidator
} from "./support/consensus-harness.js";

const H = ACTIVATION_HEIGHT;
const TOKEN = "reference-remote-signer-node-test-token-0123456789";

/** Lets a test restart the remote signer behind a running node. */
class SwitchableSigner implements ValidatorSigner {
  constructor(public current: RemoteValidatorSigner) {}
  get publicKey(): string { return this.current.publicKey; }
  signCanonical(payload: unknown, intent: ValidatorSigningIntent, protocolVersion?: number, context?: V6SigningContext): Promise<string> {
    return this.current.signCanonical(payload, intent, protocolVersion, context);
  }
}

interface RemoteSlot {
  dataDir: string;
  signer: ReferenceRemoteSigner;
  server: ReferenceRemoteSignerServer;
  client: SwitchableSigner;
}

interface Cluster {
  network: TestNetworkConfig;
  validators: TestValidator[];
  remotes: RemoteSlot[];
  memory: MemoryNetwork;
  clock: number;
}

async function startRemote(network: TestNetworkConfig, index: number, dataDir: string): Promise<{ signer: ReferenceRemoteSigner; server: ReferenceRemoteSignerServer; client: RemoteValidatorSigner }> {
  const signer = await ReferenceRemoteSigner.open({
    privateKey: network.privateKeys[index]!,
    dataDir,
    chainId: network.chainId,
    allowConsensusV6Intents: true,
    validators: network.genesis.validators
  });
  const server = await startReferenceRemoteSignerServer({ signer, bearerToken: TOKEN });
  const client = new RemoteValidatorSigner(server.url, network.publicKeys[index]!, TOKEN, 5_000, { allowConsensusV6Intents: true });
  return { signer, server, client };
}

async function cluster(firstKeyByte: number, chainId: string): Promise<Cluster> {
  const network = testNetwork(4, firstKeyByte, chainId);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  const remotes: RemoteSlot[] = [];
  for (let index = 0; index < 4; index += 1) {
    const validator = await openValidator(network, index, prefix);
    const dataDir = await mkdtemp(join(tmpdir(), `zyron-remote-signer-node-${index}-`));
    const started = await startRemote(network, index, dataDir);
    const client = new SwitchableSigner(started.client);
    // The node keeps its own journal; the key is reachable only through the remote signer.
    validator.service = new NodeService(validator.service.store, validator.journal, client);
    validators.push(validator);
    remotes.push({ dataDir, signer: started.signer, server: started.server, client });
  }
  const state: Cluster = { network, validators, remotes, memory: undefined as unknown as MemoryNetwork, clock: 0 };
  state.memory = new MemoryNetwork(validators, () => state.clock);
  return state;
}

async function restartRemote(c: Cluster, index: number): Promise<void> {
  const slot = c.remotes[index]!;
  await slot.server.close();
  slot.signer.close();
  const started = await startRemote(c.network, index, slot.dataDir);
  slot.signer = started.signer;
  slot.server = started.server;
  slot.client.current = started.client;
}

async function teardown(c: Cluster): Promise<void> {
  for (const slot of c.remotes) {
    await slot.server.close();
    slot.signer.close();
    await rm(slot.dataDir, { recursive: true, force: true });
  }
  await closeValidators(c.validators);
}

async function lead(c: Cluster, round: number, offsetMs: number, tipMs: number): Promise<Block | null> {
  const height = c.validators[0]!.service.store.chain.height + 1;
  c.clock = roundStart(tipMs, round) + offsetMs;
  const leader = proposerIndex(c.network, height, round);
  if (!c.memory.online[leader]) return null;
  return produceFinalizedBlock(c.validators[leader]!.service, c.memory.peersFor(leader), c.remotes[leader]!.client, c.clock);
}

async function finalizedHash(validator: TestValidator, height: number): Promise<string | undefined> {
  const [block] = await validator.service.store.readFinalizedBlocks(height, 1, 8_000_000);
  return block?.header.height === height ? block.hash : undefined;
}

async function signerRows(slot: RemoteSlot): Promise<string[]> {
  const text = await readFile(join(slot.dataDir, "signing-journal.ndjson"), "utf8");
  return text.split("\n").filter(Boolean);
}

test("v6 validators signing through reference remote signers finalize consecutive heights", { timeout: 90_000 }, async () => {
  const c = await cluster(0xa1, "zyron-remote-signer-node-happy");
  try {
    for (let height = H; height < H + 3; height += 1) {
      const tipMs = c.validators[0]!.service.store.chain.tip.header.timestampMs;
      const block = await lead(c, 0, 100, tipMs);
      assert.ok(block);
      assert.equal(block.header.version, 6);
      assert.equal(block.header.height, height);
      assert.equal(block.attestations.length, 4);
      const hashes = new Set(await Promise.all(c.validators.map((validator) => finalizedHash(validator, height))));
      assert.deepEqual([...hashes], [block.hash]);
    }
    // Every remote signer journaled v2 rows (prepare + lock + commit at least) for the heights it signed.
    for (const slot of c.remotes) {
      const rows = (await signerRows(slot)).map((line) => JSON.parse(line) as { v: number; step: string });
      assert.ok(rows.length >= 9);
      assert.ok(rows.every((row) => row.v === 2));
      for (const step of ["prepare", "lock", "commit"]) assert.ok(rows.some((row) => row.step === step), step);
    }
  } finally {
    await teardown(c);
  }
});

test("partial commit, signer restart and leader crash: the signer keeps the lock, refuses a compromised node, and the locked block finalizes", { timeout: 90_000 }, async () => {
  const c = await cluster(0xb1, "zyron-remote-signer-node-chaos");
  try {
    const tipMs = c.validators[0]!.service.store.chain.tip.header.timestampMs;
    const p0 = proposerIndex(c.network, H, 0);
    const p1 = proposerIndex(c.network, H, 1);
    const locked = [0, 1, 2, 3].find((index) => index !== p0 && index !== p1)!;
    // Round 0: a QC forms but only `locked` receives the commit request.
    c.memory.drop = (from, to, kind) => from === p0 && kind === "v6-commit" && to !== locked;
    assert.equal(await lead(c, 0, 5_000, tipMs), null);
    const lock = c.validators[locked]!.journal.v6Lock(H);
    assert.ok(lock);
    assert.equal(lock.round, 0);

    // The locked validator's remote signer restarts (process crash).
    await restartRemote(c, locked);
    const client = c.remotes[locked]!.client.current;
    const other = "ee".repeat(32);
    // A compromised node asks the signer for conflicting signatures directly.
    await assert.rejects(() => client.signCanonical(votePayload(c.network.chainId, H, 0, other), "prepare-vote", 6, { justify: null }), /HTTP 409/, "double prepare");
    const qcFor = (round: number, hash: string, signers: number[]) => ({
      chainId: c.network.chainId, height: H, round, blockHash: hash,
      votes: signers.map((index) => ({
        validator: c.network.genesis.validators[index]!.address,
        publicKey: c.network.publicKeys[index]!,
        signature: signV6(V6_PREPARE_VOTE_DOMAIN, votePayload(c.network.chainId, H, round, hash), c.network.privateKeys[index]!)
      }))
    });
    const helpers = [0, 1, 2, 3].filter((index) => index !== locked);
    // Even a genuine QC for another block at round 0 cannot make it commit twice.
    await assert.rejects(() => client.signCanonical(votePayload(c.network.chainId, H, 0, other), "commit-vote", 6, { qc: qcFor(0, other, helpers) }), /HTTP 409/, "double commit");
    // Lock rule: a fresh block at round 1 without higher-round QC evidence is refused.
    await assert.rejects(() => client.signCanonical(votePayload(c.network.chainId, H, 1, other), "prepare-vote", 6, { justify: null }), /HTTP 409/, "lock violation");
    // A justify that is not a valid quorum (forged by the node) does not unlock.
    await assert.rejects(() => client.signCanonical(votePayload(c.network.chainId, H, 1, other), "prepare-vote", 6, { justify: qcFor(0, other, helpers.slice(0, 2)) }), /HTTP 409/, "forged justify");

    // Leader crash, heal: the lock is carried forward and the same block finalizes.
    c.memory.drop = () => false;
    c.memory.online[p0] = false;
    let block: Block | null = null;
    for (let round = 1; round < 6 && !block; round += 1) block = await lead(c, round, 1_000, tipMs);
    assert.ok(block);
    assert.equal(block.hash, lock.blockHash);
    for (const index of [0, 1, 2, 3].filter((item) => item !== p0)) assert.equal(await finalizedHash(c.validators[index]!, H), lock.blockHash);
    // The signer's own durable journal holds the lock row from before the restart.
    const rows = (await signerRows(c.remotes[locked]!)).map((line) => JSON.parse(line) as { step: string; round: number; value: string });
    assert.ok(rows.some((row) => row.step === "lock" && row.round === 0 && row.value === lock.blockHash));
  } finally {
    await teardown(c);
  }
});
