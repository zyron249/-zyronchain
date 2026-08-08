import type { Libp2p } from "libp2p";
import type { Stream } from "@libp2p/interface";

import {
  MAX_SYNC_BATCH_PAYLOAD_BYTES,
  MAX_SYNC_BLOCKS,
  MAX_SYNC_RESPONSE_BYTES,
  type NodeService,
  type NodeStatus
} from "./node.js";
import { validateP2PChainIdentity, type P2PChainIdentity } from "./p2p.js";
import type { NodeIdentity } from "./peer-identity.js";
import type { Block } from "./types.js";

export const P2P_SYNC_PROTOCOL = "/zyronchain/sync/1.0.0";
const MAX_SYNC_REQUEST_BYTES = 2_048;
const P2P_SYNC_TIMEOUT_MS = 8_000;
const MAX_SYNC_BATCHES_PER_CALL = 32;
const WRITE_CHUNK_BYTES = 64 * 1_024;

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
  await node.handle(P2P_SYNC_PROTOCOL, async (stream, connection) => {
    try {
      if (connection.encryption !== "/noise") throw new Error("Native sync requires authenticated Noise");
      const request = parseSyncRequest(await readFrame(stream, MAX_SYNC_REQUEST_BYTES), service.status(), connection.remotePeer);
      const blocks = await service.blocks(request.from, request.limit, MAX_SYNC_BATCH_PAYLOAD_BYTES);
      const response: SyncResponse = {
        version: 1,
        identity: local,
        status: service.status(),
        blocks
      };
      await writeFrame(stream, response, MAX_SYNC_RESPONSE_BYTES);
      await stream.close({ signal: AbortSignal.timeout(P2P_SYNC_TIMEOUT_MS) });
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Native sync protocol failure"));
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
    try {
      await writeFrame(stream, { version: 1, identity: local, from, limit: MAX_SYNC_BLOCKS } satisfies SyncRequest, MAX_SYNC_REQUEST_BYTES);
      const response = parseSyncResponse(await readFrame(stream, MAX_SYNC_RESPONSE_BYTES), expected, connection.remotePeer);
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

async function writeFrame(stream: Stream, value: unknown, maxBytes: number): Promise<void> {
  stream.inactivityTimeout = P2P_SYNC_TIMEOUT_MS;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > maxBytes) throw new Error("Native sync frame too large");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  await sendChunk(stream, header);
  for (let offset = 0; offset < body.length; offset += WRITE_CHUNK_BYTES) {
    await sendChunk(stream, body.subarray(offset, Math.min(body.length, offset + WRITE_CHUNK_BYTES)));
  }
}

async function sendChunk(stream: Stream, bytes: Uint8Array): Promise<void> {
  if (!stream.send(bytes)) await stream.onDrain({ signal: AbortSignal.timeout(P2P_SYNC_TIMEOUT_MS) });
}

async function readFrame(stream: Stream, maxBytes: number): Promise<unknown> {
  stream.inactivityTimeout = P2P_SYNC_TIMEOUT_MS;
  const header = Buffer.alloc(4);
  let headerBytes = 0;
  let expectedBytes: number | undefined;
  let body: Buffer | undefined;
  let bodyBytes = 0;

  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk.subarray());
    let offset = 0;
    if (expectedBytes === undefined) {
      const take = Math.min(4 - headerBytes, bytes.length);
      bytes.copy(header, headerBytes, 0, take);
      headerBytes += take;
      offset += take;
      if (headerBytes === 4) {
        expectedBytes = header.readUInt32BE(0);
        if (expectedBytes < 1 || expectedBytes > maxBytes) throw new Error("Invalid native sync frame length");
        body = Buffer.allocUnsafe(expectedBytes);
      }
    }
    if (expectedBytes !== undefined && body) {
      const remaining = expectedBytes - bodyBytes;
      const take = Math.min(remaining, bytes.length - offset);
      if (take > 0) bytes.copy(body, bodyBytes, offset, offset + take);
      bodyBytes += take;
      offset += take;
      if (bodyBytes === expectedBytes) {
        if (offset !== bytes.length) throw new Error("Trailing bytes in native sync frame");
        try {
          return JSON.parse(body.toString("utf8")) as unknown;
        } catch {
          throw new Error("Invalid native sync frame encoding");
        }
      }
    }
  }
  throw new Error("Truncated native sync frame");
}

function assertRecordWithKeys(value: unknown, expectedKeys: string[], name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const actual = Object.keys(value as object).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${name} fields`);
  }
}
