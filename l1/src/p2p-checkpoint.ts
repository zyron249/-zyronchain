import type { PeerId } from "@libp2p/interface";
import type { Libp2p } from "libp2p";

import { canonicalJson, sha256Hex } from "./codec.js";
import { ZyronChain } from "./chain.js";
import { assertBoundedCheckpointJsonStructure } from "./checkpoint-json-complexity.js";
import type { NodeService } from "./node.js";
import { readP2PFrameRetained, writeP2PFrame } from "./p2p-frame.js";
import { P2PPeerRateLimiter } from "./p2p-rate.js";
import { validateP2PChainIdentity, type P2PChainIdentity } from "./p2p.js";
import type { NodeIdentity } from "./peer-identity.js";
import type { TrustedSnapshotAnchor } from "./storage.js";
import type { GenesisConfig } from "./types.js";

export const P2P_CHECKPOINT_PROTOCOL = "/zyronchain/checkpoint/1.0.0";
export const MAX_CHECKPOINT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_CHECKPOINT_CHUNK_BYTES = 256 * 1024;
const MAX_CHECKPOINT_REQUEST_BYTES = 4_096;
const MAX_CHECKPOINT_RESPONSE_BYTES = 400_000;
const MAX_CHECKPOINT_CHUNKS = MAX_CHECKPOINT_SNAPSHOT_BYTES / MAX_CHECKPOINT_CHUNK_BYTES;
const P2P_CHECKPOINT_TIMEOUT_MS = 8_000;

interface CheckpointRequest {
  version: 1;
  identity: P2PChainIdentity;
  tipHash: string;
  snapshotSha256: string;
  offset: number;
  maxBytes: number;
}

interface CheckpointResponse {
  version: 1;
  identity: P2PChainIdentity;
  tipHash: string;
  snapshotSha256: string;
  height: number;
  totalBytes: number;
  offset: number;
  data: string;
}

interface CachedSnapshot {
  tipHash: string;
  snapshotSha256: string;
  height: number;
  bytes: Buffer;
}

/**
 * Serves bounded chunks only when the requester already knows the exact
 * finalized tip and snapshot digest. This protocol is transport, not a trust
 * oracle: it never advertises an anchor for a client to adopt.
 */
export async function registerP2PCheckpointProtocol(
  node: Libp2p,
  identity: NodeIdentity,
  service: NodeService
): Promise<void> {
  const local = localIdentity(identity, service.status());
  validateP2PChainIdentity(local, service.status(), node.peerId);
  const rate = new P2PPeerRateLimiter(300, 60_000);
  // Keep two finalized snapshots so a transfer that spans a block boundary is
  // not invalidated merely because the live tip advances. Memory stays bounded.
  const cache = new Map<string, CachedSnapshot>();

  await node.handle(P2P_CHECKPOINT_PROTOCOL, async (stream, connection) => {
    let releaseFrame: (() => void) | undefined;
    try {
      if (connection.encryption !== "/noise") throw new Error("Checkpoint transfer requires authenticated Noise");
      if (!rate.consume(connection.remotePeer.toString())) throw new Error("Checkpoint transfer rate limit exceeded");
      const retained = await readP2PFrameRetained(stream, MAX_CHECKPOINT_REQUEST_BYTES, P2P_CHECKPOINT_TIMEOUT_MS);
      releaseFrame = retained.release;
      const request = parseRequest(retained.value, service.status(), connection.remotePeer);
      if (!service.store.chain.stateV2ForPersistence()) throw new Error("Checkpoint transfer requires active State v2");

      let selected = cache.get(request.tipHash);
      if (!selected) {
        // Reject unknown tips before the potentially expensive serialization.
        const status = service.status();
        if (request.tipHash !== status.tipHash) throw new Error("Requested checkpoint tip is not locally finalized");
        const candidate = snapshotForServing(service);
        // The candidate is canonical local state for this exact finalized tip,
        // not requester-controlled data. Cache it before comparing the supplied
        // digest so repeated mismatches cannot force full re-serialization.
        if (cache.size >= 2) cache.delete(cache.keys().next().value!);
        cache.set(candidate.tipHash, candidate);
        selected = candidate;
      }
      if (request.snapshotSha256 !== selected.snapshotSha256) throw new Error("Requested checkpoint digest is unavailable");
      if (request.offset > selected.bytes.length) throw new Error("Checkpoint offset exceeds snapshot length");
      const end = Math.min(selected.bytes.length, request.offset + request.maxBytes);
      const response: CheckpointResponse = {
        version: 1,
        identity: local,
        tipHash: selected.tipHash,
        snapshotSha256: selected.snapshotSha256,
        height: selected.height,
        totalBytes: selected.bytes.length,
        offset: request.offset,
        data: selected.bytes.subarray(request.offset, end).toString("base64")
      };
      await writeP2PFrame(stream, response, MAX_CHECKPOINT_RESPONSE_BYTES, P2P_CHECKPOINT_TIMEOUT_MS);
      await stream.close({ signal: AbortSignal.timeout(P2P_CHECKPOINT_TIMEOUT_MS) });
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Checkpoint transfer failed"));
    } finally {
      releaseFrame?.();
    }
  }, { maxInboundStreams: 1, maxOutboundStreams: 1 });
}

/** Fetches one externally anchored snapshot; the peer can supply bytes, never trust. */
export async function fetchTrustedSnapshotFromPeer(
  node: Libp2p,
  target: Parameters<Libp2p["dial"]>[0],
  identity: NodeIdentity,
  genesis: GenesisConfig,
  anchor: TrustedSnapshotAnchor
): Promise<ReturnType<ZyronChain["snapshot"]>> {
  assertAnchor(anchor);
  const expectedChain = new ZyronChain(genesis);
  const expected = { chainId: genesis.chainId, genesisHash: expectedChain.genesisHash };
  const local = localIdentity(identity, expected);
  validateP2PChainIdentity(local, expected, node.peerId);
  const connection = await node.dial(target, { signal: AbortSignal.timeout(P2P_CHECKPOINT_TIMEOUT_MS) });
  if (connection.encryption !== "/noise") {
    connection.abort(new Error("Checkpoint transfer requires authenticated Noise"));
    throw new Error("Checkpoint transfer requires authenticated Noise");
  }

  let offset = 0;
  let totalBytes: number | undefined;
  let height: number | undefined;
  let snapshotBytes: Buffer | undefined;
  for (let chunkIndex = 0; chunkIndex < MAX_CHECKPOINT_CHUNKS; chunkIndex += 1) {
    const stream = await connection.newStream(P2P_CHECKPOINT_PROTOCOL, {
      signal: AbortSignal.timeout(P2P_CHECKPOINT_TIMEOUT_MS)
    });
    let releaseFrame: (() => void) | undefined;
    try {
      const request: CheckpointRequest = {
        version: 1,
        identity: local,
        tipHash: anchor.tipHash,
        snapshotSha256: anchor.snapshotSha256,
        offset,
        maxBytes: MAX_CHECKPOINT_CHUNK_BYTES
      };
      await writeP2PFrame(stream, request, MAX_CHECKPOINT_REQUEST_BYTES, P2P_CHECKPOINT_TIMEOUT_MS);
      const retained = await readP2PFrameRetained(stream, MAX_CHECKPOINT_RESPONSE_BYTES, P2P_CHECKPOINT_TIMEOUT_MS);
      releaseFrame = retained.release;
      const response = parseResponse(retained.value, expected, connection.remotePeer, anchor, offset);
      await stream.close({ signal: AbortSignal.timeout(P2P_CHECKPOINT_TIMEOUT_MS) });
      if (totalBytes === undefined) {
        totalBytes = response.totalBytes;
        height = response.height;
        // The response parser already bounds totalBytes to <=64 MiB. Allocate
        // one destination buffer and fill it only at the exact validated offset;
        // the completion check below prevents any uninitialized bytes from
        // reaching UTF-8/JSON parsing.
        snapshotBytes = Buffer.allocUnsafe(totalBytes);
      } else if (response.totalBytes !== totalBytes || response.height !== height) {
        throw new Error("Checkpoint metadata changed during transfer");
      }
      const bytes = decodeCanonicalBase64(response.data);
      if (bytes.length < 1 || bytes.length > MAX_CHECKPOINT_CHUNK_BYTES || offset + bytes.length > totalBytes) {
        throw new Error("Invalid checkpoint chunk length");
      }
      if (!snapshotBytes) throw new Error("Checkpoint transfer buffer is unavailable");
      bytes.copy(snapshotBytes, offset);
      offset += bytes.length;
      if (offset === totalBytes) break;
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Checkpoint transfer failed"));
      throw error;
    } finally {
      releaseFrame?.();
    }
  }
  if (totalBytes === undefined || !snapshotBytes || offset !== totalBytes) {
    throw new Error("Checkpoint transfer exceeded bounded chunk budget");
  }

  // Authenticate the received bytes before allocating a full UTF-8 string.
  if (sha256Hex(snapshotBytes) !== anchor.snapshotSha256) throw new Error("Checkpoint transfer digest mismatch");
  // Bound parser object-graph amplification before JSON.parse allocates it.
  assertBoundedCheckpointJsonStructure(snapshotBytes);

  let text = snapshotBytes.toString("utf8");
  snapshotBytes = undefined;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Checkpoint transfer is not valid JSON");
  }
  // The byte buffer no longer overlaps JSON parsing, and the original full
  // text no longer overlaps canonical re-serialization. Canonical equivalence
  // remains bound to the same externally authenticated SHA-256 anchor.
  text = "";
  const canonical = canonicalJson(value);
  if (Buffer.byteLength(canonical, "utf8") !== totalBytes || sha256Hex(canonical) !== anchor.snapshotSha256) {
    throw new Error("Checkpoint transfer is not canonical JSON");
  }
  // Revalidate finality, governance schedule and state root before returning bytes
  // to any installer. The external anchor remains the authority.
  return ZyronChain.fromTrustedSnapshot(genesis, value, anchor).snapshot();
}

function snapshotForServing(service: NodeService): CachedSnapshot {
  const snapshot = service.store.chain.snapshot();
  const text = canonicalJson(snapshot);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_CHECKPOINT_SNAPSHOT_BYTES) {
    throw new Error("Checkpoint snapshot exceeds transfer byte budget");
  }
  return {
    tipHash: snapshot.tip.hash,
    snapshotSha256: sha256Hex(text),
    height: snapshot.height,
    bytes
  };
}

function parseRequest(value: unknown, expected: { chainId: string; genesisHash: string }, remotePeer: Pick<PeerId, "toString">): CheckpointRequest {
  assertExactRecord(value, ["version", "identity", "tipHash", "snapshotSha256", "offset", "maxBytes"], "checkpoint request");
  if (value.version !== 1 || typeof value.tipHash !== "string" || typeof value.snapshotSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.tipHash) || !/^[0-9a-f]{64}$/.test(value.snapshotSha256) ||
      !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 || Number(value.offset) >= MAX_CHECKPOINT_SNAPSHOT_BYTES ||
      !Number.isSafeInteger(value.maxBytes) || Number(value.maxBytes) < 1 || Number(value.maxBytes) > MAX_CHECKPOINT_CHUNK_BYTES) {
    throw new Error("Invalid checkpoint request");
  }
  return {
    version: 1,
    identity: validateP2PChainIdentity(value.identity, expected, remotePeer),
    tipHash: value.tipHash,
    snapshotSha256: value.snapshotSha256,
    offset: Number(value.offset),
    maxBytes: Number(value.maxBytes)
  };
}

function parseResponse(
  value: unknown,
  expected: { chainId: string; genesisHash: string },
  remotePeer: Pick<PeerId, "toString">,
  anchor: TrustedSnapshotAnchor,
  offset: number
): CheckpointResponse {
  assertExactRecord(value, ["version", "identity", "tipHash", "snapshotSha256", "height", "totalBytes", "offset", "data"], "checkpoint response");
  if (value.version !== 1 || value.tipHash !== anchor.tipHash || value.snapshotSha256 !== anchor.snapshotSha256 ||
      !Number.isSafeInteger(value.height) || Number(value.height) < 1 ||
      !Number.isSafeInteger(value.totalBytes) || Number(value.totalBytes) < 1 || Number(value.totalBytes) > MAX_CHECKPOINT_SNAPSHOT_BYTES ||
      value.offset !== offset || typeof value.data !== "string" || value.data.length < 1 || value.data.length > 360_000) {
    throw new Error("Invalid checkpoint response");
  }
  return {
    version: 1,
    identity: validateP2PChainIdentity(value.identity, expected, remotePeer),
    tipHash: value.tipHash,
    snapshotSha256: value.snapshotSha256,
    height: Number(value.height),
    totalBytes: Number(value.totalBytes),
    offset,
    data: value.data
  };
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("Invalid checkpoint chunk encoding");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Invalid checkpoint chunk encoding");
  return bytes;
}

function localIdentity(identity: NodeIdentity, chain: { chainId: string; genesisHash: string }): P2PChainIdentity {
  return { version: 1, nodeId: identity.nodeId, publicKey: identity.publicKey, chainId: chain.chainId, genesisHash: chain.genesisHash };
}

function assertAnchor(anchor: TrustedSnapshotAnchor): void {
  if (!/^[0-9a-f]{64}$/.test(anchor.tipHash) || !/^[0-9a-f]{64}$/.test(anchor.snapshotSha256)) {
    throw new Error("Invalid trusted checkpoint anchor");
  }
}

function assertExactRecord(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${name} fields`);
}
