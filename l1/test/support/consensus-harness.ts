// Shared multi-validator harness for the F-01 tests (real NodeService, real
// fsynced SigningJournal and ChainStore files in temp directories, injected
// clocks, an in-memory transport with fault injection). It reuses the F-03
// approach: the target protocol version is reached through a real
// quorum-approved governance upgrade finalized at height 1 that activates at
// height 101, and the first 100 blocks are committed to every validator's store.
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectedValidator } from "../../src/block.js";
import { ZyronChain } from "../../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../../src/crypto.js";
import { NodeService, type ConsensusPeerClient } from "../../src/node.js";
import { ChainStore, SigningJournal } from "../../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../../src/transaction.js";
import type { Block, BlockAttestation, GenesisConfig, RoundSkipVote } from "../../src/types.js";

export const ACTIVATION_HEIGHT = 101;

export interface TestNetworkConfig {
  chainId: string;
  privateKeys: string[];
  publicKeys: string[];
  genesis: GenesisConfig;
}

export function testNetwork(n: number, firstKeyByte: number, chainId: string): TestNetworkConfig {
  const privateKeys = Array.from({ length: n }, (_, index) => (firstKeyByte + index).toString(16).padStart(64, "0"));
  const publicKeys = privateKeys.map(publicKeyFromPrivate);
  const oracle = publicKeyFromPrivate((firstKeyByte + 0x40).toString(16).padStart(64, "0"));
  const pool = addressFromPublicKey(publicKeyFromPrivate((firstKeyByte + 0x41).toString(16).padStart(64, "0")));
  return {
    chainId,
    privateKeys,
    publicKeys,
    genesis: {
      chainId,
      timestampMs: 1_700_000_000_000,
      validators: publicKeys.map((publicKey) => ({ address: addressFromPublicKey(publicKey), publicKey })),
      activityOracles: [oracle],
      activityPool: pool,
      allocations: [{ address: pool, amountAtoms: 1_000_000 }]
    }
  };
}

const prefixCache = new Map<string, Block[]>();

/** Heights 1..100 finalized under v1, with protocolVersion active from height 101. */
export function finalizedPrefix(network: TestNetworkConfig, protocolVersion: number): Block[] {
  const cacheKey = `${network.chainId}:${network.privateKeys.length}:${protocolVersion}`;
  const cached = prefixCache.get(cacheKey);
  if (cached) return cached;
  const config = network.genesis;
  const chain = new ZyronChain(config);
  const transactions = [];
  if (protocolVersion !== 1) {
    const proposal = {
      chainId: config.chainId,
      nonce: 1,
      sender: config.validators[0]!.address,
      activationHeight: ACTIVATION_HEIGHT,
      protocolVersion
    };
    transactions.push(createProtocolUpgrade({
      ...proposal,
      approvals: network.privateKeys.map((key, index) => createProtocolUpgradeApproval(proposal, key, network.publicKeys[index]!)),
      timestampMs: config.timestampMs + 10
    }, network.privateKeys[0]!, network.publicKeys[0]!));
  }
  const blocks: Block[] = [];
  for (let height = 1; height < ACTIVATION_HEIGHT; height += 1) {
    const timestampMs = config.timestampMs + (height * 1_000);
    const proposer = expectedValidator(config.validators, height, 0);
    const proposerKey = network.privateKeys[network.publicKeys.indexOf(proposer.publicKey)]!;
    let block = chain.produceBlock(height === 1 ? transactions : [], proposerKey, { timestampMs });
    for (const key of network.privateKeys) block = chain.attestBlock(block, key);
    chain.acceptBlock(block, timestampMs);
    blocks.push(block);
  }
  assert.equal(chain.protocolVersionAt(ACTIVATION_HEIGHT), protocolVersion);
  prefixCache.set(cacheKey, blocks);
  return blocks;
}

export interface TestValidator {
  index: number;
  directory: string;
  journal: SigningJournal;
  service: NodeService;
}

// Committing 100 fsynced blocks takes ~1.5 s per validator, so the committed
// store (without any signing journal) is built once per prefix and copied.
const templateCache = new Map<Block[], Promise<string>>();
const templateDirectories: string[] = [];
process.once("exit", () => {
  // Best effort; temp directories are small.
  for (const directory of templateDirectories) void rm(directory, { recursive: true, force: true });
});

async function storeTemplate(network: TestNetworkConfig, prefix: Block[]): Promise<string> {
  let template = templateCache.get(prefix);
  if (!template) {
    template = (async () => {
      const directory = await mkdtemp(join(tmpdir(), "zyron-f01-template-"));
      templateDirectories.push(directory);
      const store = await ChainStore.open(network.genesis, directory);
      for (const block of prefix) await store.commitFinalizedBlock(block);
      return directory;
    })();
    templateCache.set(prefix, template);
  }
  return template;
}

export async function openValidator(network: TestNetworkConfig, index: number, prefix: Block[], directory?: string): Promise<TestValidator> {
  let dir = directory;
  if (!dir) {
    dir = await mkdtemp(join(tmpdir(), `zyron-f01-v${index}-`));
    if (prefix.length > 0) {
      const template = await storeTemplate(network, prefix);
      for (const name of await readdir(template)) {
        if (name.startsWith("signing-journal")) continue;
        await cp(join(template, name), join(dir, name), { recursive: true });
      }
    }
  }
  const store = await ChainStore.open(network.genesis, dir);
  for (const block of prefix) if (block.header.height > store.chain.height) await store.commitFinalizedBlock(block);
  assert.ok(store.chain.height >= prefix.length, "validator store does not contain the finalized prefix");
  const journal = await SigningJournal.open(dir);
  const service = new NodeService(store, journal, network.privateKeys[index]!);
  return { index, directory: dir, journal, service };
}

export async function closeValidators(validators: Array<TestValidator | undefined>, remove = true): Promise<void> {
  for (const validator of validators) {
    if (!validator) continue;
    validator.journal.close();
    if (remove) await rm(validator.directory, { recursive: true, force: true });
  }
}

export function proposerIndex(network: TestNetworkConfig, height: number, round: number): number {
  return network.publicKeys.indexOf(expectedValidator(network.genesis.validators, height, round).publicKey);
}

/** Legacy journal rows as "height:round=kind" for assertions and reports. */
export async function journalRows(validator: TestValidator): Promise<string[]> {
  let text = "";
  try { text = await readFile(join(validator.directory, "signing-journal.ndjson"), "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map((line) => {
    const row = JSON.parse(line) as Record<string, unknown>;
    return row.kind !== undefined
      ? `${String(row.height)}:${String(row.round)}=${String(row.kind)}`
      : `${String(row.height)}:${String(row.round)}=${String(row.step)}`;
  });
}

export type MessageKind = "attest" | "skip" | "block" | string;

/**
 * In-memory consensus transport between validators of one process. Each
 * request calls the remote NodeService handler directly (as the HTTP and
 * native servers do) unless the destination is offline or the link drops it.
 */
export class MemoryNetwork {
  readonly online: boolean[];
  /** Return true to drop a request from -> to of the given kind. */
  drop: (from: number, to: number, kind: MessageKind) => boolean = () => false;
  /** Awaited before a request is delivered (used to interleave actions deterministically). */
  beforeDeliver: (from: number, to: number, kind: MessageKind) => Promise<void> | void = () => {};
  readonly errors: Array<{ from: number; to: number; kind: MessageKind; message: string }> = [];

  constructor(readonly validators: Array<TestValidator | undefined>, private readonly clock: () => number) {
    this.online = validators.map((validator) => validator !== undefined);
  }

  reachable(from: number, to: number, kind: MessageKind): TestValidator | undefined {
    const target = this.validators[to];
    if (from === to || !target || !this.online[to] || this.drop(from, to, kind)) return undefined;
    return target;
  }

  async deliver<T>(from: number, kind: MessageKind, call: (target: TestValidator) => Promise<T>): Promise<T[]> {
    const results: T[] = [];
    for (let to = 0; to < this.validators.length; to += 1) {
      if (!this.reachable(from, to, kind)) continue;
      await this.beforeDeliver(from, to, kind);
      const target = this.reachable(from, to, kind);
      if (!target) continue;
      try {
        results.push(await call(target));
      } catch (error) {
        this.errors.push({ from, to, kind, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  peersFor(from: number): ConsensusPeerClient {
    return {
      requestAttestations: (block: Block): Promise<BlockAttestation[]> =>
        this.deliver(from, "attest", (target) => target.service.attestProposal(block, this.clock())),
      requestRoundSkips: (height: number, round: number, previousCertificate?: RoundSkipVote[]): Promise<RoundSkipVote[]> =>
        this.deliver(from, "skip", (target) => target.service.requestSkipVote(height, round, previousCertificate ?? [], this.clock())),
      broadcastBlock: async (block: Block): Promise<void> => {
        await this.deliver(from, "block", (target) => target.service.acceptFinalizedBlock(block));
      }
    };
  }
}
