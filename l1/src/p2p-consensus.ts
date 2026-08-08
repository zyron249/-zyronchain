import type { Libp2p } from "libp2p";

import { PeerInflightLimiter, type ConsensusPeerClient, type NodeService, type NodeStatus } from "./node.js";
import { readP2PFrame, writeP2PFrame } from "./p2p-frame.js";
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
    try {
      if (connection.encryption !== "/noise") throw new Error("Native consensus requires authenticated Noise");
      // Gate before reading a potentially block-sized frame. Noise has already
      // authenticated this PeerId, so repeated connections cannot evade the
      // per-identity memory/CPU concurrency bound.
      const peerId = connection.remotePeer.toString();
      if (!rate.consume(peerId)) throw new Error("Native consensus rate limit exceeded");
      release = inflight.enter(peerId);
      const request = parseConsensusRequest(
        await readP2PFrame(stream, MAX_CONSENSUS_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS),
        service.status(),
        connection.remotePeer
      );
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
      } satisfies ConsensusResponse, MAX_CONSENSUS_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS);
      await stream.close({ signal: AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS) });
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Native consensus protocol failure"));
    } finally {
      release?.();
    }
  }, { maxInboundStreams: 4, maxOutboundStreams: 4 });
}

export class NativeConsensusPeerClient implements ConsensusPeerClient {
  private gossipCursor = 0;
  private readonly blockSeen = new Set<string>();
  private readonly transactionSeen = new Set<string>();

  constructor(
    private readonly node: Libp2p,
    private readonly targets: Array<Parameters<Libp2p["dial"]>[0]>,
    private readonly identity: NodeIdentity,
    private readonly chain: { chainId: string; genesisHash: string }
  ) {
    if (targets.length > MAX_CONFIGURED_NATIVE_PEERS) throw new Error("Too many configured native peers");
    validateP2PChainIdentity(localIdentity(identity, chain), chain, node.peerId);
  }

  async requestAttestations(block: Block): Promise<BlockAttestation[]> {
    const results = await Promise.allSettled(this.targets.map((target) => this.request(target, {
      version: 1,
      identity: localIdentity(this.identity, this.chain),
      kind: "attest",
      block
    })));
    return results.flatMap((result) => result.status === "fulfilled" && result.value.kind === "attest"
      ? [result.value.result as BlockAttestation]
      : []);
  }

  async requestRoundSkips(height: number, round: number, previousCertificate: RoundSkipVote[] = []): Promise<RoundSkipVote[]> {
    const results = await Promise.allSettled(this.targets.map((target) => this.request(target, {
      version: 1,
      identity: localIdentity(this.identity, this.chain),
      kind: "skip",
      height,
      round,
      previousCertificate
    })));
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

  private async request(target: Parameters<Libp2p["dial"]>[0], request: ConsensusRequest): Promise<ConsensusResponse> {
    const connection = await this.node.dial(target, { signal: AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS) });
    if (connection.encryption !== "/noise") {
      connection.abort(new Error("Native consensus requires authenticated Noise"));
      throw new Error("Native consensus requires authenticated Noise");
    }
    const stream = await connection.newStream(P2P_CONSENSUS_PROTOCOL, { signal: AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS) });
    try {
      await writeP2PFrame(stream, request, MAX_CONSENSUS_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS);
      const response = parseConsensusResponse(
        await readP2PFrame(stream, MAX_CONSENSUS_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS),
        this.chain,
        connection.remotePeer,
        request.kind
      );
      await stream.close({ signal: AbortSignal.timeout(P2P_CONSENSUS_TIMEOUT_MS) });
      return response;
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Native consensus protocol failure"));
      throw error;
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
  return {
    version: 1,
    identity: validateP2PChainIdentity(record.identity, expected, remotePeer),
    kind: expectedKind,
    result: record.result
  };
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
