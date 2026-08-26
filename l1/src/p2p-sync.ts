import type { Libp2p } from "libp2p";

import {
  MAX_SYNC_BATCH_PAYLOAD_BYTES,
  MAX_SYNC_BLOCKS,
  PeerInflightLimiter,
  type NodeService,
  type NodeStatus
} from "./node.js";
import { validateP2PChainIdentity, type P2PChainIdentity } from "./p2p.js";
import { readP2PFrameRetained, writeP2PFrame } from "./p2p-frame.js";
import { P2PPeerRateLimiter } from "./p2p-rate.js";
import type { NodeIdentity } from "./peer-identity.js";
import type { Block } from "./types.js";

export const P2P_SYNC_PROTOCOL = "/zyronchain/sync/1.0.0";
const MAX_SYNC_REQUEST_BYTES = 2_048;
export const NATIVE_SYNC_RESPONSE_MAX_BYTES = 21_000_000;
const P2P_SYNC_TIMEOUT_MS = 8_000;
const MAX_SYNC_BATCHES_PER_CALL = 32;

interface SyncRequest {
  version: 1;
  identity: P2PChainIdentity;
  from: number;
  limit: number;
}

interface SyncResponse {
  version: 1;
  identity: P2PChainIdentity;
  status: NodeStatus;
  blocks: Block[];
}

/** Serves bounded finalized-history batches only to same-chain Noise identities. */
export async function registerP2PSyncProtocol(
  node: Libp2p,
  identity: NodeIdentity,
  service: NodeService
): Promise<void> {
  const local = localIdentity(identity, service.status());
  validateP2PChainIdentity(local, service.status(), node.peerId);
  const rate = new P2PPeerRateLimiter(120, 60_000);
  const inflight = new PeerInflightLimiter(2);
  await node.handle(P2P_SYNC_PROTOCOL, async (stream, connection) => {
    let release: (() => void) | undefined;
    let releaseFrame: (() => void) | undefined;
    try {
      if (connection.encryption !== "/noise") throw new Error("Native sync requires authenticated Noise");
      const peerId = connection.remotePeer.toString();
      if (!rate.consume(peerId)) throw new Error("Native sync rate limit exceeded");
      release = inflight.enter(peerId);
      const retained = await readP2PFrameRetained(stream, MAX_SYNC_REQUEST_BYTES, P2P_SYNC_TIMEOUT_MS);
      releaseFrame = retained.release;
      const request = parseSyncRequest(retained.value, service.status(), connection.remotePeer);
      const blocks = await service.blocks(request.from, request.limit, MAX_SYNC_BATCH_PAYLOAD_BYTES);
      const response: SyncResponse = {
        version: 1,
        identity: local,
        status: service.status(),
        blocks
      };
      await writeP2PFrame(stream, response, NATIVE_SYNC_RESPONSE_MAX_BYTES, P2P_SYNC_TIMEOUT_MS);
      await stream.close({ signal: AbortSignal.timeout(P2P_SYNC_TIMEOUT_MS) });
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Native sync protocol failure"));
    } finally {
      releaseFrame?.();
      release?.();
    }
  }, { maxInboundStreams: 2, maxOutboundStreams: 2 });
}

/**
 * Incrementally catches a node up over one authenticated Noise connection.
 * Work per invocation is capped so a remote height claim cannot monopolize the
 * event loop indefinitely; callers can invoke it again to continue catch-up.
 */
export async function syncP2PFrom(
  node: Libp2p,
  target: Parameters<Libp2p["dial"]>[0],
  identity: NodeIdentity,
  service: NodeService
): Promise<number> {
  const expected = service.status();
  const local = localIdentity(identity, expected);
  validateP2PChainIdentity(local, expected, node.peerId);
  const connection = await node.dial(target, { signal: AbortSignal.timeout(P2P_SYNC_TIMEOUT_MS) });
  if (connection.encryption !== "/noise") {
    connection.abort(new Error("Native sync requires authenticated Noise"));
    throw new Error("Native sync requires authenticated Noise");
  }

  let accepted = 0;
  for (let batch = 0; batch < MAX_SYNC_BATCHES_PER_CALL; batch += 1) {
    const from = service.status().height + 1;
    const stream = await connection.newStream(P2P_SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(P2P_SYNC_TIMEOUT_MS)
    });
    let releaseFrame: (() => void) | undefined;
    try {
      await writeP2PFrame(stream, { version: 1, identity: local, from, limit: MAX_SYNC_BLOCKS } satisfies SyncRequest, MAX_SYNC_REQUEST_BYTES, P2P_SYNC_TIMEOUT_MS);
      const retained = await readP2PFrameRetained(stream, NATIVE_SYNC_RESPONSE_MAX_BYTES, P2P_SYNC_TIMEOUT_MS);
      releaseFrame = retained.release;
      const response = parseSyncResponse(retained.value, expected, connection.remotePeer);
      await stream.close({ signal: AbortSignal.timeout(P2P_SYNC_TIMEOUT_MS) });

      const localHeight = service.status().height;
      if (response.status.height < localHeight) return accepted;
      if (response.status.height === localHeight) {
        if (response.status.tipHash !== service.status().tipHash) throw new Error("Native sync peer has conflicting tip");
        return accepted;
      }
      if (response.blocks.length === 0) throw new Error("Native sync peer omitted required finalized blocks");
      if (response.blocks.length > MAX_SYNC_BLOCKS) throw new Error("Native sync peer exceeded block batch limit");
      for (const block of response.blocks) {
        await service.acceptFinalizedBlock(block);
        accepted += 1;
      }
      if (service.status().height >= response.status.height) {
        if (service.status().tipHash !== response.status.tipHash) throw new Error("Native sync peer advertised a false tip");
        return accepted;
      }
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Native sync protocol failure"));
      throw error;
    } finally {
      releaseFrame?.();
    }
  }
  return accepted;
}

function localIdentity(identity: NodeIdentity, chain: Pick<NodeStatus, "chainId" | "genesisHash">): P2PChainIdentity {
  return {
    version: 1,
    nodeId: identity.nodeId,
    publicKey: identity.publicKey,
    chainId: chain.chainId,
    genesisHash: chain.genesisHash
  };
}

function parseSyncRequest(
  value: unknown,
  expected: NodeStatus,
  remotePeer: Parameters<typeof validateP2PChainIdentity>[2]
): SyncRequest {
  assertRecordWithKeys(value, ["version", "identity", "from", "limit"], "native sync request");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Number.isSafeInteger(record.from) || Number(record.from) < 1 ||
      !Number.isSafeInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > MAX_SYNC_BLOCKS) {
    throw new Error("Invalid native sync request");
  }
  const identity = validateP2PChainIdentity(record.identity, expected, remotePeer);
  return { version: 1, identity, from: Number(record.from), limit: Number(record.limit) };
}

function parseSyncResponse(
  value: unknown,
  expected: NodeStatus,
  remotePeer: Parameters<typeof validateP2PChainIdentity>[2]
): SyncResponse {
  assertRecordWithKeys(value, ["version", "identity", "status", "blocks"], "native sync response");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.blocks) || record.blocks.length > MAX_SYNC_BLOCKS) {
    throw new Error("Invalid native sync response");
  }
  const identity = validateP2PChainIdentity(record.identity, expected, remotePeer);
  assertRecordWithKeys(record.status, ["chainId", "genesisHash", "height", "tipHash"], "native sync status");
  const status = record.status as Record<string, unknown>;
  if (status.chainId !== expected.chainId || status.genesisHash !== expected.genesisHash ||
      !Number.isSafeInteger(status.height) || Number(status.height) < 0 ||
      typeof status.tipHash !== "string" || !/^[0-9a-f]{64}$/.test(status.tipHash)) {
    throw new Error("Invalid native sync status");
  }
  return {
    version: 1,
    identity,
    status: status as unknown as NodeStatus,
    blocks: record.blocks as Block[]
  };
}

function assertRecordWithKeys(value: unknown, expectedKeys: string[], name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const actual = Object.keys(value as object).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${name} fields`);
  }
}
