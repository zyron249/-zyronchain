import type { PeerId } from "@libp2p/interface";
import type { Libp2p } from "libp2p";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateBlockShape } from "./block.js";
import { ZyronChain } from "./chain.js";
import { readP2PFrameRetained, writeP2PFrame } from "./p2p-frame.js";
import {
  MAX_STATE_KEYS_PER_CHUNK,
  MAX_STATE_RECORDS_PER_CHUNK,
  MAX_STATE_SYNC_PEERS,
  P2P_STATE_PROTOCOL
} from "./p2p-state.js";
import { validateP2PChainIdentity, type P2PChainIdentity } from "./p2p.js";
import type { NodeIdentity } from "./peer-identity.js";
import { MAX_PORTABLE_STATE_KEYS, MAX_PORTABLE_STATE_NODES } from "./state-v2-portable.js";
import { PortableStateResumeStore } from "./state-v2-resume.js";
import { validatePortableResumeSnapshot } from "./state-v2-resume-trust.js";
import type { TrustedSnapshotAnchor } from "./storage.js";
import type { Block, GenesisConfig } from "./types.js";

const MAX_STATE_REQUEST_BYTES = 4_096;
const MAX_STATE_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_STATE_MANIFEST_BYTES = 2_500_000;
const P2P_STATE_TIMEOUT_MS = 8_000;
const P2P_STATE_RETRIES = 2;
const P2P_STATE_MIN_REQUEST_INTERVAL_MS = 50;

type StateRequestKind = "manifest" | "records" | "keys";

interface StateRequest {
  version: 1;
  identity: P2PChainIdentity;
  tipHash: string;
  snapshotSha256: string;
  kind: StateRequestKind;
  start: number;
  limit: number;
}

interface StateManifestResponse {
  version: 1;
  identity: P2PChainIdentity;
  tipHash: string;
  snapshotSha256: string;
  height: number;
  stateRoot: string;
  recordCount: number;
  keyCount: number;
  tip: Block;
}

interface StateChunkResponse {
  version: 1;
  identity: P2PChainIdentity;
  tipHash: string;
  snapshotSha256: string;
  kind: "records" | "keys";
  start: number;
  items: unknown[];
}

class PortableStateResumeAssemblyError extends Error {}

/**
 * Fetch a complete resumable State-v2 store without ever calling
 * PortableStateResumeStore.bundle(). Completed stores cross the existing
 * streamed trust bridge before return so poisoned assemblies still trigger the
 * same clean-retry/failover policy as the legacy bundle path.
 */
export async function fetchTrustedPortableResumeFromAnyPeer(
  node: Libp2p,
  targets: readonly Parameters<Libp2p["dial"]>[0][],
  identity: NodeIdentity,
  genesis: GenesisConfig,
  anchor: TrustedSnapshotAnchor,
  resumeDir: string
): Promise<PortableStateResumeStore> {
  if (targets.length < 1 || targets.length > MAX_STATE_SYNC_PEERS) throw new Error("Invalid portable state peer count");
  if (resumeDir.length < 1) throw new Error("Portable state resume directory is required");

  let lastError: unknown;
  for (const target of targets) {
    try {
      return await fetchTrustedPortableResume(node, target, identity, genesis, anchor, resumeDir);
    } catch (error) {
      lastError = error;
      if (!(error instanceof PortableStateResumeAssemblyError)) continue;
      try {
        return await fetchTrustedPortableResume(node, target, identity, genesis, anchor, resumeDir);
      } catch (retryError) {
        lastError = retryError;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All portable state peers failed");
}

async function fetchTrustedPortableResume(
  node: Libp2p,
  target: Parameters<Libp2p["dial"]>[0],
  identity: NodeIdentity,
  genesis: GenesisConfig,
  anchor: TrustedSnapshotAnchor,
  resumeDir: string
): Promise<PortableStateResumeStore> {
  assertAnchor(anchor);
  const expectedChain = new ZyronChain(genesis);
  const expected = { chainId: genesis.chainId, genesisHash: expectedChain.genesisHash };
  const local = localIdentity(identity, expected);
  validateP2PChainIdentity(local, expected, node.peerId);

  let lastRequestAt = 0;
  const request = async (kind: StateRequestKind, start: number, limit: number): Promise<{ value: unknown; remotePeer: PeerId; release: () => void }> => {
    const delay = P2P_STATE_MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    lastRequestAt = Date.now();
    let lastError: unknown;
    for (let attempt = 0; attempt <= P2P_STATE_RETRIES; attempt += 1) {
      let stream: Awaited<ReturnType<Awaited<ReturnType<typeof node.dial>>["newStream"]>> | undefined;
      let releaseFrame: (() => void) | undefined;
      try {
        const connection = await node.dial(target, { signal: AbortSignal.timeout(P2P_STATE_TIMEOUT_MS) });
        if (connection.encryption !== "/noise") {
          connection.abort(new Error("State transfer requires authenticated Noise"));
          throw new Error("State transfer requires authenticated Noise");
        }
        stream = await connection.newStream(P2P_STATE_PROTOCOL, { signal: AbortSignal.timeout(P2P_STATE_TIMEOUT_MS) });
        const body: StateRequest = {
          version: 1,
          identity: local,
          tipHash: anchor.tipHash,
          snapshotSha256: anchor.snapshotSha256,
          kind,
          start,
          limit
        };
        await writeP2PFrame(stream, body, MAX_STATE_REQUEST_BYTES, P2P_STATE_TIMEOUT_MS);
        const retained = await readP2PFrameRetained(
          stream,
          kind === "manifest" ? MAX_STATE_MANIFEST_BYTES : MAX_STATE_RESPONSE_BYTES,
          P2P_STATE_TIMEOUT_MS
        );
        releaseFrame = retained.release;
        await stream.close({ signal: AbortSignal.timeout(P2P_STATE_TIMEOUT_MS) });
        const reply = { value: retained.value, remotePeer: connection.remotePeer, release: retained.release };
        releaseFrame = undefined;
        return reply;
      } catch (error) {
        releaseFrame?.();
        lastError = error;
        stream?.abort(error instanceof Error ? error : new Error("State transfer failed"));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("State transfer failed after bounded retries");
  };

  const manifestReply = await request("manifest", 0, 1);
  const manifest = (() => {
    try {
      return parseManifest(manifestReply.value, expected, manifestReply.remotePeer, anchor);
    } finally {
      manifestReply.release();
    }
  })();

  const resume = await PortableStateResumeStore.open(resumeDir, {
    version: 1,
    chainId: expected.chainId,
    genesisHash: expected.genesisHash,
    tipHash: anchor.tipHash,
    snapshotSha256: anchor.snapshotSha256,
    height: manifest.height,
    stateRoot: manifest.stateRoot,
    recordCount: manifest.recordCount,
    keyCount: manifest.keyCount,
    tip: manifest.tip
  });

  for (let start = resume.nextRecordStart(); start < manifest.recordCount;) {
    const limit = Math.min(MAX_STATE_RECORDS_PER_CHUNK, manifest.recordCount - start);
    const reply = await request("records", start, limit);
    try {
      const chunk = parseChunk(reply.value, expected, reply.remotePeer, anchor, "records", start, limit);
      await resume.putRecords(start, chunk.items);
      start += chunk.items.length;
    } finally {
      reply.release();
    }
  }

  for (let start = resume.nextKeyStart(); start < manifest.keyCount;) {
    const limit = Math.min(MAX_STATE_KEYS_PER_CHUNK, manifest.keyCount - start);
    const reply = await request("keys", start, limit);
    try {
      const chunk = parseChunk(reply.value, expected, reply.remotePeer, anchor, "keys", start, limit);
      await resume.putKeys(start, chunk.items);
      start += chunk.items.length;
    } finally {
      reply.release();
    }
  }

  if (!resume.complete()) throw new Error("Portable state resume remained incomplete after transfer");

  const validationDir = await mkdtemp(join(tmpdir(), "zyron-state-resume-validate-"));
  try {
    await validatePortableResumeSnapshot(genesis, resume, anchor, validationDir);
  } catch (error) {
    await resume.discard();
    throw new PortableStateResumeAssemblyError("Portable state resume failed anchored validation", { cause: error });
  } finally {
    await rm(validationDir, { recursive: true, force: true });
  }
  return resume;
}

function parseManifest(
  value: unknown,
  expected: { chainId: string; genesisHash: string },
  remotePeer: Pick<PeerId, "toString">,
  anchor: TrustedSnapshotAnchor
): StateManifestResponse {
  assertExactRecord(value, ["version", "identity", "tipHash", "snapshotSha256", "height", "stateRoot", "recordCount", "keyCount", "tip"], "state manifest");
  if (value.version !== 1 || value.tipHash !== anchor.tipHash || value.snapshotSha256 !== anchor.snapshotSha256 ||
      !Number.isSafeInteger(value.height) || Number(value.height) < 1 || !isHash(value.stateRoot) ||
      !Number.isSafeInteger(value.recordCount) || Number(value.recordCount) < 1 || Number(value.recordCount) > MAX_PORTABLE_STATE_NODES ||
      !Number.isSafeInteger(value.keyCount) || Number(value.keyCount) < 1 || Number(value.keyCount) > MAX_PORTABLE_STATE_KEYS) {
    throw new Error("Invalid state manifest");
  }
  const identity = validateP2PChainIdentity(value.identity, expected, remotePeer);
  if (!value.tip || typeof value.tip !== "object" || Array.isArray(value.tip)) throw new Error("Invalid state manifest tip");
  validateBlockShape(value.tip);
  const tip = value.tip as unknown as Block;
  if (tip.hash !== anchor.tipHash || tip.header.height !== Number(value.height) || tip.header.stateRoot !== value.stateRoot) {
    throw new Error("State manifest tip does not match anchored metadata");
  }
  return {
    version: 1,
    identity,
    tipHash: value.tipHash,
    snapshotSha256: value.snapshotSha256,
    height: Number(value.height),
    stateRoot: value.stateRoot,
    recordCount: Number(value.recordCount),
    keyCount: Number(value.keyCount),
    tip: structuredClone(tip)
  };
}

function parseChunk(
  value: unknown,
  expected: { chainId: string; genesisHash: string },
  remotePeer: Pick<PeerId, "toString">,
  anchor: TrustedSnapshotAnchor,
  kind: "records" | "keys",
  start: number,
  limit: number
): StateChunkResponse {
  assertExactRecord(value, ["version", "identity", "tipHash", "snapshotSha256", "kind", "start", "items"], "state chunk");
  if (value.version !== 1 || value.tipHash !== anchor.tipHash || value.snapshotSha256 !== anchor.snapshotSha256 ||
      value.kind !== kind || value.start !== start || !Array.isArray(value.items) || value.items.length !== limit) {
    throw new Error("Invalid state chunk");
  }
  return {
    version: 1,
    identity: validateP2PChainIdentity(value.identity, expected, remotePeer),
    tipHash: value.tipHash,
    snapshotSha256: value.snapshotSha256,
    kind,
    start,
    items: structuredClone(value.items)
  };
}

function localIdentity(identity: NodeIdentity, chain: { chainId: string; genesisHash: string }): P2PChainIdentity {
  return { version: 1, nodeId: identity.nodeId, publicKey: identity.publicKey, chainId: chain.chainId, genesisHash: chain.genesisHash };
}

function assertAnchor(anchor: TrustedSnapshotAnchor): void {
  if (!isHash(anchor.tipHash) || !isHash(anchor.snapshotSha256)) throw new Error("Invalid trusted checkpoint anchor");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function assertExactRecord(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${name} fields`);
}
