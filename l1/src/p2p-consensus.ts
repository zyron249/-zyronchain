import type { Libp2p } from "libp2p";

import { assertHex } from "./codec.js";
import { ConsensusOperationBudget } from "./consensus-operation-budget.js";
import { addressFromPublicKey } from "./crypto.js";
import { PeerInflightLimiter, type ConsensusPeerClient, type NodeService, type NodeStatus } from "./node.js";
import { readP2PFrameRetained, writeP2PFrame } from "./p2p-frame.js";
import { validateP2PChainIdentity, type P2PChainIdentity } from "./p2p.js";
import { P2PPeerRateLimiter } from "./p2p-rate.js";
import type { NodeIdentity } from "./peer-identity.js";
import { validateTransactionShape } from "./transaction.js";
import type { Block, BlockAttestation, RoundSkipVote, Transaction } from "./types.js";

export const P2P_CONSENSUS_PROTOCOL = "/zyronchain/consensus/1.0.0";
const MAX_CONSENSUS_FRAME_BYTES = 2_500_000;
const P2P_CONSENSUS_TIMEOUT_MS = 8_000;
const MAX_CONFIGURED_NATIVE_PEERS = 64;
const MAX_NATIVE_GOSSIP_FANOUT = 8;
const MAX_NATIVE_GOSSIP_DEDUP = 4_096;
const MAX_NATIVE_CONSENSUS_INFLIGHT_PER_PEER = 2;
export const MAX_NATIVE_CONSENSUS_OUTBOUND_CONCURRENCY = 8;
export const MAX_NATIVE_CONSENSUS_OUTSTANDING = 32;
export const NATIVE_CONSENSUS_COLLECTION_TIMEOUT_MS = 8_000;
const MAX_CONSENSUS_CHAIN_ID_LENGTH = 128;
const nativeConsensusOperationBudget = new ConsensusOperationBudget(MAX_NATIVE_CONSENSUS_OUTSTANDING, "native consensus");

const NATIVE_CONSENSUS_REQUEST_MAX_BYTES = {
  attest: MAX_CONSENSUS_FRAME_BYTES,
  skip: 128_000,
  block: MAX_CONSENSUS_FRAME_BYTES,
  transaction: 64_000
} as const;

const NATIVE_CONSENSUS_RESPONSE_MAX_BYTES = {
  attest: 8 * 1024,
  skip: 16 * 1024,
  block: 4 * 1024,
  transaction: 4 * 1024
} as const;

type ConsensusRequest =
  | { version: 1; identity: P2PChainIdentity; kind: "attest"; block: Block }
  | { version: 1; identity: P2PChainIdentity; kind: "skip"; height: number; round: number; previousCertificate: RoundSkipVote[] }
  | { version: 1; identity: P2PChainIdentity; kind: "block"; block: Block }
  | { version: 1; identity: P2PChainIdentity; kind: "transaction"; transaction: Transaction };

interface ConsensusResponse {
  version: 1;
  identity: P2PChainIdentity;
  kind: "attest" | "skip" | "block" | "transaction";
  result: unknown;
}

export function nativeConsensusRequestMaxBytes(kind: "attest" | "skip" | "block" | "transaction"): number {
  return NATIVE_CONSENSUS_REQUEST_MAX_BYTES[kind];
}

export function nativeConsensusResponseMaxBytes(kind: ConsensusResponse["kind"]): number {
  return NATIVE_CONSENSUS_RESPONSE_MAX_BYTES[kind];
}

/**
 * Schedules every eligible target through a bounded worker pool while sharing
 * one wall-clock deadline. Process-wide outstanding work is additionally
 * bounded; saturation skips new transport work instead of queueing waiters.
 */
export async function collectNativeConsensusBounded<T, U>(
  targets: readonly T[],
  request: (target: T, signal: AbortSignal, deadlineMs: number) => Promise<U>,
  options: { maxConcurrency?: number; timeoutMs?: number } = {}
): Promise<Array<PromiseSettledResult<U>>> {
  const maxConcurrency = options.maxConcurrency ?? MAX_NATIVE_CONSENSUS_OUTBOUND_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? NATIVE_CONSENSUS_COLLECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error("Invalid native consensus concurrency");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid native consensus collection timeout");
  if (targets.length === 0) return [];

  const controller = new AbortController();
  const deadlineMs = Date.now() + timeoutMs;
  const results: Array<PromiseSettledResult<U> | undefined> = new Array(targets.length);
  let cursor = 0;
  let resolveDeadline!: () => void;
  const deadlineReached = new Promise<void>((resolve) => { resolveDeadline = resolve; });
  const timer = setTimeout(() => {
    controller.abort(new Error("Native consensus collection deadline exceeded"));
    resolveDeadline();
  }, timeoutMs);

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = cursor++;
      if (index >= targets.length) return;
      const releaseOperation = nativeConsensusOperationBudget.tryAcquire();
      if (!releaseOperation) {
        results[index] = { status: "rejected", reason: new Error("Native consensus outstanding work limit reached") };
        continue;
      }
      try {
        const value = await request(targets[index]!, controller.signal, deadlineMs);
        if (!controller.signal.aborted) results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      } finally {
        releaseOperation();
      }
    }
  };

  try {
    const workersDone = Promise.all(
      Array.from({ length: Math.min(maxConcurrency, targets.length) }, () => worker())
    );
    await Promise.race([workersDone, deadlineReached]);
    if (controller.signal.aborted) {
      const reason = controller.signal.reason ?? new Error("Native consensus collection deadline exceeded");
      const started = Math.min(cursor, targets.length);
      for (let index = 0; index < started; index += 1) {
        if (results[index] === undefined) results[index] = { status: "rejected", reason };
      }
      void workersDone.catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
  return results.filter((result): result is PromiseSettledResult<U> => result !== undefined);
}

export async function registerP2PConsensusProtocol(
  node: Libp2p,
  identity: NodeIdentity,
  service: NodeService
): Promise<void> {
  const local = localIdentity(identity, service.status());
  validateP2PChainIdentity(local, service.status(), node.peerId);
  const inflight = new PeerInflightLimiter(MAX_NATIVE_CONSENSUS_INFLIGHT_PER_PEER);
  const rate = new P2PPeerRateLimiter(240, 60_000);
  await node.handle(P2P_CONSENSUS_PROTOCOL, async (stream, connection) => {
    let release: (() => void) | undefined;
    let releaseFrame: (() => void) | undefined;
    try {
      if (connection.encryption !== "/noise") throw new Error("Native consensus requires authenticated Noise");
      const peerId = connection.remotePeer.toString();
      if (!rate.consume(peerId)) throw new Error("Native consensus rate limit exceeded");
      release = inflight.enter(peerId);
      const retained = await readP2PFrameRetained(stream, MAX_CONSENSUS_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS);
      releaseFrame = retained.release;
      const request = parseConsensusRequest(retained.value, service.status(), connection.remotePeer);
      let result: unknown;
      if (request.kind === "attest") result = await service.attestProposal(request.block);
      else if (request.kind === "skip") result = await service.requestSkipVote(request.height, request.round, request.previousCertificate);
      else if (request.kind === "block") {
        await service.acceptFinalizedBlock(request.block);
        result = { accepted: true };
      } else {
        result = { txid: service.submitTransaction(request.transaction) };
      }
      await writeP2PFrame(stream, {
        version: 1,
        identity: local,
        kind: request.kind,
        result
      } satisfies ConsensusResponse, nativeConsensusResponseMaxBytes(request.kind), P2P_CONSENSUS_TIMEOUT_MS);
      await stream.close({ signal: AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS) });
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Native consensus protocol failure"));
    } finally {
      releaseFrame?.();
      release?.();
    }
  }, { maxInboundStreams: 4, maxOutboundStreams: 4 });
}

export class NativeConsensusPeerClient implements ConsensusPeerClient {
  private gossipCursor = 0;
  private readonly blockSeen = new Set<string>();
  private readonly transactionSeen = new Set<string>();
  private targets: Array<Parameters<Libp2p["dial"]>[0]>;

  constructor(
    private readonly node: Libp2p,
    targets: Array<Parameters<Libp2p["dial"]>[0]>,
    private readonly identity: NodeIdentity,
    private readonly chain: { chainId: string; genesisHash: string }
  ) {
    this.targets = [];
    this.replaceTargets(targets);
    validateP2PChainIdentity(localIdentity(identity, chain), chain, node.peerId);
  }

  replaceTargets(targets: Array<Parameters<Libp2p["dial"]>[0]>): void {
    if (targets.length > MAX_CONFIGURED_NATIVE_PEERS) throw new Error("Too many configured native peers");
    this.targets = [...targets];
    if (this.targets.length === 0) this.gossipCursor = 0;
    else this.gossipCursor %= this.targets.length;
  }

  async requestAttestations(block: Block): Promise<BlockAttestation[]> {
    const request: ConsensusRequest = {
      version: 1,
      identity: localIdentity(this.identity, this.chain),
      kind: "attest",
      block
    };
    const results = await collectNativeConsensusBounded(this.targets, (target, signal, deadlineMs) =>
      this.request(target, request, signal, deadlineMs));
    return results.flatMap((result) => result.status === "fulfilled" && result.value.kind === "attest"
      ? [result.value.result as BlockAttestation]
      : []);
  }

  async requestRoundSkips(height: number, round: number, previousCertificate: RoundSkipVote[] = []): Promise<RoundSkipVote[]> {
    const request: ConsensusRequest = {
      version: 1,
      identity: localIdentity(this.identity, this.chain),
      kind: "skip",
      height,
      round,
      previousCertificate
    };
    const results = await collectNativeConsensusBounded(this.targets, (target, signal, deadlineMs) =>
      this.request(target, request, signal, deadlineMs));
    return results.flatMap((result) => result.status === "fulfilled" && result.value.kind === "skip"
      ? [result.value.result as RoundSkipVote]
      : []);
  }

  async broadcastBlock(block: Block): Promise<void> {
    if (!remember(this.blockSeen, block.hash)) return;
    if (this.targets.length === 0) return;
    const count = Math.min(MAX_NATIVE_GOSSIP_FANOUT, this.targets.length);
    const selected = Array.from({ length: count }, (_, offset) => this.targets[(this.gossipCursor + offset) % this.targets.length]!);
    this.gossipCursor = (this.gossipCursor + count) % this.targets.length;
    await Promise.allSettled(selected.map((target) => this.request(target, {
      version: 1,
      identity: localIdentity(this.identity, this.chain),
      kind: "block",
      block
    })));
  }

  async broadcastTransaction(transaction: Transaction): Promise<void> {
    validateTransactionShape(transaction);
    if (!remember(this.transactionSeen, transaction.txid)) return;
    await this.broadcastGossip({
      version: 1,
      identity: localIdentity(this.identity, this.chain),
      kind: "transaction",
      transaction
    });
  }

  private async broadcastGossip(request: ConsensusRequest): Promise<void> {
    if (this.targets.length === 0) return;
    const count = Math.min(MAX_NATIVE_GOSSIP_FANOUT, this.targets.length);
    const selected = Array.from({ length: count }, (_, offset) => this.targets[(this.gossipCursor + offset) % this.targets.length]!);
    this.gossipCursor = (this.gossipCursor + count) % this.targets.length;
    await Promise.allSettled(selected.map((target) => this.request(target, request)));
  }

  private async request(
    target: Parameters<Libp2p["dial"]>[0],
    request: ConsensusRequest,
    signal?: AbortSignal,
    deadlineMs?: number
  ): Promise<ConsensusResponse> {
    const operationSignal = signal ?? AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS);
    const timeout = (): number => {
      if (deadlineMs === undefined) return P2P_CONSENSUS_TIMEOUT_MS;
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) throw new Error("Native consensus collection deadline exceeded");
      return Math.max(1, remaining);
    };

    timeout();
    const connection = await this.node.dial(target, { signal: operationSignal });
    if (connection.encryption !== "/noise") {
      connection.abort(new Error("Native consensus requires authenticated Noise"));
      throw new Error("Native consensus requires authenticated Noise");
    }
    timeout();
    const stream = await connection.newStream(P2P_CONSENSUS_PROTOCOL, { signal: operationSignal });
    let releaseFrame: (() => void) | undefined;
    try {
      await writeP2PFrame(stream, request, nativeConsensusRequestMaxBytes(request.kind), timeout());
      const retained = await readP2PFrameRetained(stream, nativeConsensusResponseMaxBytes(request.kind), timeout());
      releaseFrame = retained.release;
      const response = parseConsensusResponse(retained.value, this.chain, connection.remotePeer, request.kind);
      await stream.close({ signal: signal ?? AbortSignal.timeout(timeout()) });
      return response;
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Native consensus protocol failure"));
      throw error;
    } finally {
      releaseFrame?.();
    }
  }
}

function parseConsensusRequest(
  value: unknown,
  expected: NodeStatus,
  remotePeer: Parameters<typeof validateP2PChainIdentity>[2]
): ConsensusRequest {
  assertRecord(value, "native consensus request");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.kind !== "string") throw new Error("Invalid native consensus request");
  const identity = validateP2PChainIdentity(record.identity, expected, remotePeer);
  if (record.kind === "attest" || record.kind === "block") {
    assertExactKeys(record, ["version", "identity", "kind", "block"], "native consensus request");
    return { version: 1, identity, kind: record.kind, block: record.block as Block };
  }
  if (record.kind === "transaction") {
    assertExactKeys(record, ["version", "identity", "kind", "transaction"], "native consensus request");
    validateTransactionShape(record.transaction);
    return { version: 1, identity, kind: "transaction", transaction: record.transaction as Transaction };
  }
  if (record.kind === "skip") {
    assertExactKeys(record, ["version", "identity", "kind", "height", "round", "previousCertificate"], "native consensus request");
    if (!Number.isSafeInteger(record.height) || Number(record.height) < 1 || !Number.isSafeInteger(record.round) || Number(record.round) < 0 ||
        !Array.isArray(record.previousCertificate) || record.previousCertificate.length > 256) throw new Error("Invalid native skip request");
    return {
      version: 1,
      identity,
      kind: "skip",
      height: Number(record.height),
      round: Number(record.round),
      previousCertificate: record.previousCertificate as RoundSkipVote[]
    };
  }
  throw new Error("Unsupported native consensus request");
}

function parseConsensusResponse(
  value: unknown,
  expected: { chainId: string; genesisHash: string },
  remotePeer: Parameters<typeof validateP2PChainIdentity>[2],
  expectedKind: ConsensusResponse["kind"]
): ConsensusResponse {
  assertRecord(value, "native consensus response");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ["version", "identity", "kind", "result"], "native consensus response");
  if (record.version !== 1 || record.kind !== expectedKind) throw new Error("Invalid native consensus response");
  const identity = validateP2PChainIdentity(record.identity, expected, remotePeer);
  validateConsensusResponseResultShape(expectedKind, record.result);
  return { version: 1, identity, kind: expectedKind, result: record.result };
}

export function validateConsensusResponseResultShape(kind: ConsensusResponse["kind"], value: unknown): void {
  assertRecord(value, `native consensus ${kind} result`);
  if (kind === "attest") {
    assertExactKeys(value, ["validator", "publicKey", "signature"], "native consensus attest result");
    if (typeof value.publicKey !== "string" || typeof value.signature !== "string" || typeof value.validator !== "string") {
      throw new Error("Invalid native consensus attest result");
    }
    assertHex(value.publicKey, 64, "native consensus attestation public key");
    assertHex(value.signature, 64, "native consensus attestation signature");
    if (value.validator !== addressFromPublicKey(value.publicKey)) throw new Error("Invalid native consensus attestation validator");
    return;
  }
  if (kind === "skip") {
    assertExactKeys(value, ["validator", "publicKey", "chainId", "height", "round", "previousHash", "signature"], "native consensus skip result");
    if (typeof value.publicKey !== "string" || typeof value.signature !== "string" || typeof value.validator !== "string" ||
        typeof value.chainId !== "string" || value.chainId.length < 1 || value.chainId.length > MAX_CONSENSUS_CHAIN_ID_LENGTH ||
        !Number.isSafeInteger(value.height) || Number(value.height) < 1 ||
        !Number.isSafeInteger(value.round) || Number(value.round) < 0 || typeof value.previousHash !== "string") {
      throw new Error("Invalid native consensus skip result");
    }
    assertHex(value.publicKey, 64, "native consensus skip public key");
    assertHex(value.signature, 64, "native consensus skip signature");
    assertHex(value.previousHash, 32, "native consensus skip previous hash");
    if (value.validator !== addressFromPublicKey(value.publicKey)) throw new Error("Invalid native consensus skip validator");
    return;
  }
  if (kind === "block") {
    assertExactKeys(value, ["accepted"], "native consensus block result");
    if (value.accepted !== true) throw new Error("Invalid native consensus block result");
    return;
  }
  assertExactKeys(value, ["txid"], "native consensus transaction result");
  if (typeof value.txid !== "string") throw new Error("Invalid native consensus transaction result");
  assertHex(value.txid, 32, "native consensus transaction txid");
}

function localIdentity(identity: NodeIdentity, chain: Pick<NodeStatus, "chainId" | "genesisHash">): P2PChainIdentity {
  return { version: 1, nodeId: identity.nodeId, publicKey: identity.publicKey, chainId: chain.chainId, genesisHash: chain.genesisHash };
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${name} fields`);
}

function remember(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > MAX_NATIVE_GOSSIP_DEDUP) {
    const oldest = seen.values().next().value as string | undefined;
    if (oldest) seen.delete(oldest);
  }
  return true;
}
