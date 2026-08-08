import type { PeerId } from "@libp2p/interface";
import type { Libp2p } from "libp2p";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { validateBlockShape } from "./block.js";
import { canonicalJson, sha256Hex } from "./codec.js";
import { ZyronChain } from "./chain.js";
import type { NodeService } from "./node.js";
import { readP2PFrame, writeP2PFrame } from "./p2p-frame.js";
import { P2PPeerRateLimiter } from "./p2p-rate.js";
import { validateP2PChainIdentity, type P2PChainIdentity } from "./p2p.js";
import type { NodeIdentity } from "./peer-identity.js";
import {
  createStateV2PortableBundle,
  MAX_PORTABLE_STATE_KEYS,
  MAX_PORTABLE_STATE_NODES,
  type StateV2PortableBundleV1
} from "./state-v2-portable.js";
import { PortableStateResumeStore, type PortableStateResumeManifestV1 } from "./state-v2-resume.js";
import type { TrustedSnapshotAnchor } from "./storage.js";
import type { Block, GenesisConfig } from "./types.js";

export const P2P_STATE_PROTOCOL = "/zyronchain/state/1.0.0";
export const MAX_STATE_RECORDS_PER_CHUNK = 128;
export const MAX_STATE_KEYS_PER_CHUNK = 1_024;
const MAX_STATE_REQUEST_BYTES = 4_096;
const MAX_STATE_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_STATE_MANIFEST_BYTES = 2_500_000;
const P2P_STATE_TIMEOUT_MS = 8_000;
const P2P_STATE_RETRIES = 2;
const P2P_STATE_MIN_REQUEST_INTERVAL_MS = 50;
export const MAX_STATE_SYNC_PEERS = 8;

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

interface CachedPortableState {
  tipHash: string;
  snapshotSha256: string;
  height: number;
  tip: Block;
  stateRoot: string;
  recordCount: number;
  keyCount: number;
  store: PortableStateResumeStore;
}

export interface TrustedPortableStateTransfer {
  tip: Block;
  bundle: StateV2PortableBundleV1;
}

/**
 * Serves independently addressable State-v2 chunks. The caller must already
 * know the exact finalized tip and canonical full-snapshot digest. Neither the
 * manifest nor a peer response is a source of checkpoint trust.
 */
export async function registerP2PStateProtocol(
  node: Libp2p,
  identity: NodeIdentity,
  service: NodeService
): Promise<void> {
  const local = localIdentity(identity, service.status());
  validateP2PChainIdentity(local, service.status(), node.peerId);
  const rate = new P2PPeerRateLimiter(1_200, 60_000);
  const cache = new Map<string, CachedPortableState>();
  const durableCacheRoot = join(service.store.dataDir, "p2p-state-checkpoints");
  await mkdir(durableCacheRoot, { recursive: true, mode: 0o700 });
  await pruneDurableCache(durableCacheRoot, 2);
  const activeCounts = new Map<string, number>();
  let selectionTail: Promise<void> = Promise.resolve();

  const acquirePortableState = async (request: StateRequest): Promise<CachedPortableState> => {
    const previous = selectionTail;
    let release!: () => void;
    selectionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const selected = await selectPortableState(cache, durableCacheRoot, new Set(activeCounts.keys()), service, request);
      activeCounts.set(selected.store.dataDir, (activeCounts.get(selected.store.dataDir) ?? 0) + 1);
      return selected;
    } finally {
      release();
    }
  };

  await node.handle(P2P_STATE_PROTOCOL, async (stream, connection) => {
    let selected: CachedPortableState | undefined;
    try {
      if (connection.encryption !== "/noise") throw new Error("State transfer requires authenticated Noise");
      if (!rate.consume(connection.remotePeer.toString())) throw new Error("State transfer rate limit exceeded");
      const request = parseRequest(
        await readP2PFrame(stream, MAX_STATE_REQUEST_BYTES, P2P_STATE_TIMEOUT_MS),
        service.status(),
        connection.remotePeer
      );
      selected = await acquirePortableState(request);
      const response = await responseForRequest(local, selected, request);
      await writeP2PFrame(
        stream,
        response,
        request.kind === "manifest" ? MAX_STATE_MANIFEST_BYTES : MAX_STATE_RESPONSE_BYTES,
        P2P_STATE_TIMEOUT_MS
      );
      await stream.close({ signal: AbortSignal.timeout(P2P_STATE_TIMEOUT_MS) });
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("State transfer failed"));
    } finally {
      if (selected) {
        const remaining = (activeCounts.get(selected.store.dataDir) ?? 1) - 1;
        if (remaining > 0) activeCounts.set(selected.store.dataDir, remaining);
        else activeCounts.delete(selected.store.dataDir);
      }
    }
  }, { maxInboundStreams: 1, maxOutboundStreams: 1 });
}

/**
 * Fetches an indexed portable state under one immutable external anchor.
 * Completed chunks remain in memory while an interrupted chunk is retried;
 * every response is bound to the same authenticated Noise peer and anchor.
 */
export async function fetchTrustedPortableStateFromPeer(
  node: Libp2p,
  target: Parameters<Libp2p["dial"]>[0],
  identity: NodeIdentity,
  genesis: GenesisConfig,
  anchor: TrustedSnapshotAnchor
): Promise<TrustedPortableStateTransfer> {
  return fetchTrustedPortableState(node, target, identity, genesis, anchor);
}

/** Same trust model as the in-memory fetch, with crash-safe untrusted chunk staging. */
export async function fetchTrustedPortableStateResumableFromPeer(
  node: Libp2p,
  target: Parameters<Libp2p["dial"]>[0],
  identity: NodeIdentity,
  genesis: GenesisConfig,
  anchor: TrustedSnapshotAnchor,
  resumeDir: string
): Promise<TrustedPortableStateTransfer> {
  if (resumeDir.length < 1) throw new Error("Portable state resume directory is required");
  return fetchTrustedPortableState(node, target, identity, genesis, anchor, resumeDir);
}

/**
 * Tries a bounded operator-selected peer set under one immutable anchor and
 * one durable progress directory. A completed poisoned assembly is discarded;
 * the same peer gets one clean retry before failover so poison inherited from
 * an earlier partial peer cannot make an honest source fail permanently.
 */
export async function fetchTrustedPortableStateFromAnyPeer(
  node: Libp2p,
  targets: readonly Parameters<Libp2p["dial"]>[0][],
  identity: NodeIdentity,
  genesis: GenesisConfig,
  anchor: TrustedSnapshotAnchor,
  resumeDir: string
): Promise<TrustedPortableStateTransfer> {
  if (targets.length < 1 || targets.length > MAX_STATE_SYNC_PEERS) throw new Error("Invalid portable state peer count");
  let lastError: unknown;
  for (const target of targets) {
    try {
      return await fetchTrustedPortableState(node, target, identity, genesis, anchor, resumeDir);
    } catch (error) {
      lastError = error;
      if (!(error instanceof PortableStateAssemblyError)) continue;
      try {
        return await fetchTrustedPortableState(node, target, identity, genesis, anchor, resumeDir);
      } catch (retryError) {
        lastError = retryError;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All portable state peers failed");
}

async function fetchTrustedPortableState(
  node: Libp2p,
  target: Parameters<Libp2p["dial"]>[0],
  identity: NodeIdentity,
  genesis: GenesisConfig,
  anchor: TrustedSnapshotAnchor,
  resumeDir?: string
): Promise<TrustedPortableStateTransfer> {
  assertAnchor(anchor);
  const expectedChain = new ZyronChain(genesis);
  const expected = { chainId: genesis.chainId, genesisHash: expectedChain.genesisHash };
  const local = localIdentity(identity, expected);
  validateP2PChainIdentity(local, expected, node.peerId);

  let lastRequestAt = 0;
  const request = async (kind: StateRequestKind, start: number, limit: number): Promise<{ value: unknown; remotePeer: PeerId }> => {
    const delay = P2P_STATE_MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    lastRequestAt = Date.now();
    let lastError: unknown;
    for (let attempt = 0; attempt <= P2P_STATE_RETRIES; attempt += 1) {
      let stream: Awaited<ReturnType<Awaited<ReturnType<typeof node.dial>>["newStream"]>> | undefined;
      try {
        const connection = await node.dial(target, { signal: AbortSignal.timeout(P2P_STATE_TIMEOUT_MS) });
        if (connection.encryption !== "/noise") {
          connection.abort(new Error("State transfer requires authenticated Noise"));
          throw new Error("State transfer requires authenticated Noise");
        }
        stream = await connection.newStream(P2P_STATE_PROTOCOL, { signal: AbortSignal.timeout(P2P_STATE_TIMEOUT_MS) });
        const body: StateRequest = {
          version: 1, identity: local, tipHash: anchor.tipHash, snapshotSha256: anchor.snapshotSha256,
          kind, start, limit
        };
        await writeP2PFrame(stream, body, MAX_STATE_REQUEST_BYTES, P2P_STATE_TIMEOUT_MS);
        const value = await readP2PFrame(
          stream,
          kind === "manifest" ? MAX_STATE_MANIFEST_BYTES : MAX_STATE_RESPONSE_BYTES,
          P2P_STATE_TIMEOUT_MS
        );
        await stream.close({ signal: AbortSignal.timeout(P2P_STATE_TIMEOUT_MS) });
        return { value, remotePeer: connection.remotePeer };
      } catch (error) {
        lastError = error;
        stream?.abort(error instanceof Error ? error : new Error("State transfer failed"));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("State transfer failed after bounded retries");
  };

  const manifestReply = await request("manifest", 0, 1);
  const manifest = parseManifest(manifestReply.value, expected, manifestReply.remotePeer, anchor);
  const resume = resumeDir ? await PortableStateResumeStore.open(resumeDir, {
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
  }) : undefined;
  const records: unknown[] = [];
  for (let start = resume?.nextRecordStart() ?? 0; start < manifest.recordCount;) {
    const limit = Math.min(MAX_STATE_RECORDS_PER_CHUNK, manifest.recordCount - start);
    const reply = await request("records", start, limit);
    const chunk = parseChunk(reply.value, expected, reply.remotePeer, anchor, "records", start, limit);
    if (resume) await resume.putRecords(start, chunk.items);
    else records.push(...chunk.items);
    start += chunk.items.length;
  }
  const keys: unknown[] = [];
  for (let start = resume?.nextKeyStart() ?? 0; start < manifest.keyCount;) {
    const limit = Math.min(MAX_STATE_KEYS_PER_CHUNK, manifest.keyCount - start);
    const reply = await request("keys", start, limit);
    const chunk = parseChunk(reply.value, expected, reply.remotePeer, anchor, "keys", start, limit);
    if (resume) await resume.putKeys(start, chunk.items);
    else keys.push(...chunk.items);
    start += chunk.items.length;
  }
  if (!resume && (records.length !== manifest.recordCount || keys.length !== manifest.keyCount)) {
    throw new Error("State transfer chunk counts changed during transfer");
  }
  const bundle = resume ? await resume.bundle() : {
    version: 1 as const,
    root: manifest.stateRoot,
    records,
    keyPreimages: keys
  } as unknown as StateV2PortableBundleV1;
  // This is the security boundary: root graph, semantic key preimages,
  // governance/finality and the original full-snapshot digest all revalidate.
  try {
    ZyronChain.fromTrustedPortableState(genesis, manifest.tip, bundle, anchor);
  } catch (error) {
    // Persisted chunks are untrusted cache only. If the complete assembled
    // bundle cannot satisfy the anchor, discard poison rather than pinning a
    // future retry to attacker-supplied bytes.
    await resume?.discard();
    throw new PortableStateAssemblyError("Portable state assembly failed anchored validation", { cause: error });
  }
  return { tip: structuredClone(manifest.tip), bundle: structuredClone(bundle) };
}

class PortableStateAssemblyError extends Error {}

async function selectPortableState(
  cache: Map<string, CachedPortableState>,
  durableCacheRoot: string,
  activePaths: ReadonlySet<string>,
  service: NodeService,
  request: StateRequest
): Promise<CachedPortableState> {
  const cached = cache.get(request.tipHash);
  if (cached) {
    if (cached.snapshotSha256 !== request.snapshotSha256) throw new Error("Requested State-v2 digest is unavailable");
    return cached;
  }
  const expected = service.status();
  const durablePath = portableCachePath(durableCacheRoot, request.tipHash, request.snapshotSha256);
  let reusableCurrentStore: PortableStateResumeStore | undefined;
  try {
    const store = await PortableStateResumeStore.openExisting(durablePath, {
      chainId: expected.chainId,
      genesisHash: expected.genesisHash,
      tipHash: request.tipHash,
      snapshotSha256: request.snapshotSha256
    });
    if (store.complete()) {
      const selected = cachedStateFromStore(store);
      rememberPortableState(cache, selected);
      return selected;
    }
    if (request.tipHash !== expected.tipHash) throw new Error("Historical durable State-v2 serving checkpoint is incomplete");
    reusableCurrentStore = store;
  } catch (error) {
    if (!isMissingFile(error) && request.tipHash !== expected.tipHash) throw error;
    // A corrupt/incomplete derived cache for the current tip is disposable: the
    // authoritative live chain can rebuild it. Historical cache corruption
    // fails closed because the live node cannot recreate old state safely.
    if (request.tipHash === expected.tipHash && !isMissingFile(error)) {
      await rm(durablePath, { recursive: true, force: true });
    }
  }
  const status = service.status();
  if (request.tipHash !== status.tipHash) throw new Error("Requested State-v2 tip is not locally finalized or durably cached");
  const snapshot = service.store.chain.snapshot();
  const snapshotSha256 = sha256Hex(canonicalJson(snapshot));
  if (snapshotSha256 !== request.snapshotSha256) throw new Error("Requested State-v2 digest is unavailable");
  const state = service.store.chain.stateV2ForPersistence();
  if (!state) throw new Error("State transfer requires active State v2");
  const bundle = createStateV2PortableBundle(state, snapshot.state, {
    validatorSchedule: snapshot.validatorSchedule,
    protocolSchedule: snapshot.protocolSchedule
  });
  const manifest: PortableStateResumeManifestV1 = {
    version: 1, chainId: status.chainId, genesisHash: status.genesisHash,
    tipHash: snapshot.tip.hash, snapshotSha256, height: snapshot.height,
    stateRoot: bundle.root, recordCount: bundle.records.length,
    keyCount: bundle.keyPreimages.length, tip: structuredClone(snapshot.tip)
  };
  const store = reusableCurrentStore ?? await PortableStateResumeStore.open(durablePath, manifest);
  for (let start = store.nextRecordStart(); start < bundle.records.length;) {
    const items = bundle.records.slice(start, start + MAX_STATE_RECORDS_PER_CHUNK);
    await store.putRecords(start, items);
    start += items.length;
  }
  for (let start = store.nextKeyStart(); start < bundle.keyPreimages.length;) {
    const items = bundle.keyPreimages.slice(start, start + MAX_STATE_KEYS_PER_CHUNK);
    await store.putKeys(start, items);
    start += items.length;
  }
  const selected = cachedStateFromStore(store);
  rememberPortableState(cache, selected);
  await pruneDurableCache(durableCacheRoot, 2, new Set([
    ...activePaths,
    ...[...cache.values()].map((entry) => entry.store.dataDir)
  ]));
  return selected;
}

async function responseForRequest(
  identity: P2PChainIdentity,
  state: CachedPortableState,
  request: StateRequest
): Promise<StateManifestResponse | StateChunkResponse> {
  if (request.kind === "manifest") {
    return {
      version: 1, identity, tipHash: state.tipHash, snapshotSha256: state.snapshotSha256,
      height: state.height, stateRoot: state.stateRoot, recordCount: state.recordCount,
      keyCount: state.keyCount, tip: structuredClone(state.tip)
    };
  }
  const total = request.kind === "records" ? state.recordCount : state.keyCount;
  if (request.start >= total || request.start + request.limit > total) throw new Error("State chunk range exceeds manifest bounds");
  const items = request.kind === "records"
    ? await state.store.records(request.start, request.limit)
    : await state.store.keys(request.start, request.limit);
  return {
    version: 1, identity, tipHash: state.tipHash, snapshotSha256: state.snapshotSha256,
    kind: request.kind, start: request.start, items
  };
}

function cachedStateFromStore(store: PortableStateResumeStore): CachedPortableState {
  const manifest = store.manifest;
  validateBlockShape(manifest.tip);
  if (manifest.tip.hash !== manifest.tipHash || manifest.tip.header.height !== manifest.height ||
      manifest.tip.header.stateRoot !== manifest.stateRoot) throw new Error("Durable State-v2 serving manifest is inconsistent");
  return {
    tipHash: manifest.tipHash,
    snapshotSha256: manifest.snapshotSha256,
    height: manifest.height,
    tip: structuredClone(manifest.tip),
    stateRoot: manifest.stateRoot,
    recordCount: manifest.recordCount,
    keyCount: manifest.keyCount,
    store
  };
}

function rememberPortableState(cache: Map<string, CachedPortableState>, selected: CachedPortableState): void {
  if (!cache.has(selected.tipHash) && cache.size >= 2) cache.delete(cache.keys().next().value!);
  cache.set(selected.tipHash, selected);
}

function portableCachePath(root: string, tipHash: string, snapshotSha256: string): string {
  return join(root, `${tipHash}-${snapshotSha256}`);
}

async function pruneDurableCache(root: string, keep: number, protectedPaths: ReadonlySet<string> = new Set()): Promise<void> {
  const names = await readdir(root);
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}-[0-9a-f]{64}$/.test(name)) continue;
    const path = join(root, name);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    candidates.push({ path, mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  let unprotectedBudget = Math.max(0, keep - protectedPaths.size);
  for (const candidate of candidates) {
    if (protectedPaths.has(candidate.path)) continue;
    if (unprotectedBudget > 0) { unprotectedBudget -= 1; continue; }
    await rm(candidate.path, { recursive: true, force: true });
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function parseRequest(value: unknown, expected: { chainId: string; genesisHash: string }, remotePeer: Pick<PeerId, "toString">): StateRequest {
  assertExactRecord(value, ["version", "identity", "tipHash", "snapshotSha256", "kind", "start", "limit"], "state request");
  if (value.version !== 1 || !isHash(value.tipHash) || !isHash(value.snapshotSha256) ||
      (value.kind !== "manifest" && value.kind !== "records" && value.kind !== "keys") ||
      !Number.isSafeInteger(value.start) || Number(value.start) < 0 ||
      !Number.isSafeInteger(value.limit) || Number(value.limit) < 1) throw new Error("Invalid state request");
  const kind = value.kind;
  const start = Number(value.start);
  const limit = Number(value.limit);
  if (kind === "manifest" ? (start !== 0 || limit !== 1) :
      kind === "records" ? (start >= MAX_PORTABLE_STATE_NODES || limit > MAX_STATE_RECORDS_PER_CHUNK) :
      (start >= MAX_PORTABLE_STATE_KEYS || limit > MAX_STATE_KEYS_PER_CHUNK)) throw new Error("Invalid state request bounds");
  return {
    version: 1,
    identity: validateP2PChainIdentity(value.identity, expected, remotePeer),
    tipHash: value.tipHash,
    snapshotSha256: value.snapshotSha256,
    kind, start, limit
  };
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
    version: 1, identity, tipHash: value.tipHash, snapshotSha256: value.snapshotSha256,
    height: Number(value.height), stateRoot: value.stateRoot, recordCount: Number(value.recordCount),
    keyCount: Number(value.keyCount), tip: structuredClone(tip)
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
    version: 1, identity: validateP2PChainIdentity(value.identity, expected, remotePeer), tipHash: value.tipHash,
    snapshotSha256: value.snapshotSha256, kind, start, items: structuredClone(value.items)
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
