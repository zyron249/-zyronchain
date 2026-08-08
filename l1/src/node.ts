import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { canonicalJson, sha256Hex } from "./codec.js";

import {
  createBlockAttestation,
  createRoundSkipVote,
  expectedValidator,
  validateBlockAttestation,
  validateBlockShape,
  validateRoundSkipVote,
  validateRoundSkipQuorum
} from "./block.js";
import { publicKeyFromPrivate } from "./crypto.js";
import { Mempool } from "./mempool.js";
import { PeerReputationStore } from "./peer-reputation.js";
import {
  PeerRequestAuthenticator,
  signPeerRequest,
  validateSignedPeerRecord,
  type NodeIdentity,
  type SignedPeerRecord
} from "./peer-identity.js";
import { ChainStore, SigningJournal } from "./storage.js";
import { assertAddress, assertExactKeys, assertPlainRecord, validateTransactionShape } from "./transaction.js";
import type { Address, Block, BlockAttestation, RoundSkipVote, Transaction } from "./types.js";

const MAX_BODY_BYTES = 2_500_000;
const MAX_SYNC_BLOCKS = 100;
const MAX_SYNC_RESPONSE_BYTES = 25_000_000;
const MAX_SYNC_BATCH_PAYLOAD_BYTES = 20_000_000;
const MAX_CONFIGURED_PEERS = 64;
const PEER_FAILURE_BACKOFF_MS = 30_000;
const PEER_TIMEOUT_MS = 8_000;
const DEFAULT_RPC_WINDOW_MS = 60_000;
const DEFAULT_RPC_REQUESTS_PER_WINDOW = 600;
const DEFAULT_RPC_MAX_CONNECTIONS = 256;
export const BLOCK_INTERVAL_MS = 30_000;
export const ROUND_WINDOW_MS = 30_000;

export interface NodeStatus {
  chainId: string;
  genesisHash: string;
  height: number;
  tipHash: string;
}

export interface NodeMetrics extends NodeStatus {
  mempoolSize: number;
  validatorCount: number;
  uptimeSeconds: number;
}

export interface RpcServerOptions {
  maxConnections?: number;
  peerAuthToken?: string;
  peerRecord?: SignedPeerRecord;
  trustedPeerPublicKeys?: string[];
  requestsPerWindow?: number;
  windowMs?: number;
}

export interface PeerRequestCredentials {
  identity: NodeIdentity;
  chainId: string;
  genesisHash: string;
}

export class NodeService {
  readonly mempool = new Mempool();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly startedAtMs = Date.now();

  constructor(
    readonly store: ChainStore,
    private readonly signingJournal?: SigningJournal,
    private readonly validatorPrivateKey?: string
  ) {}

  status(): NodeStatus {
    return {
      chainId: this.store.chain.genesis.chainId,
      genesisHash: this.store.chain.genesisHash,
      height: this.store.chain.height,
      tipHash: this.store.chain.tip.hash
    };
  }

  metrics(nowMs = Date.now()): NodeMetrics {
    return {
      ...this.status(),
      mempoolSize: this.mempool.size,
      validatorCount: this.store.chain.validatorsAt(this.store.chain.height + 1).length,
      uptimeSeconds: Math.max(0, Math.floor((nowMs - this.startedAtMs) / 1_000))
    };
  }

  async blocks(from: number, limit: number, maxBytes = MAX_SYNC_BATCH_PAYLOAD_BYTES): Promise<Block[]> {
    if (!Number.isSafeInteger(from) || from < 1) throw new Error("Invalid block start height");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_BLOCKS) throw new Error("Invalid block limit");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SYNC_BATCH_PAYLOAD_BYTES) {
      throw new Error("Invalid block response byte limit");
    }
    return this.store.readFinalizedBlocks(from, limit, maxBytes);
  }

  balance(address: string): number {
    assertAddress(address);
    return this.store.chain.balance(address);
  }

  nonce(address: string): number {
    assertAddress(address);
    return this.store.chain.nonce(address);
  }

  submitTransaction(value: unknown): string {
    validateTransactionShape(value);
    const tx = value as Transaction;
    if (tx.chainId !== this.store.chain.genesis.chainId) throw new Error("Wrong transaction chain ID");
    const stateNonce = this.store.chain.nonce(tx.sender);
    if (tx.nonce <= stateNonce || tx.nonce > stateNonce + 64) throw new Error("Transaction nonce outside mempool window");
    this.store.chain.validateMempoolAdmission(tx);
    if (tx.kind === "transfer") {
      const conflicting = this.mempool.conflictingTransaction(tx.sender, tx.nonce);
      const replacedSpend = conflicting?.kind === "transfer"
        ? BigInt(conflicting.amountAtoms) + BigInt(conflicting.feeAtoms)
        : 0n;
      const pendingSpend = this.mempool.pendingTransferSpend(tx.sender) - replacedSpend;
      const required = pendingSpend + BigInt(tx.amountAtoms) + BigInt(tx.feeAtoms);
      if (required > BigInt(this.store.chain.balance(tx.sender))) {
        throw new Error("Pending transfers exceed confirmed balance");
      }
    }
    if (tx.nonce === stateNonce + 1) this.store.chain.validatePending([tx]);
    this.mempool.add(tx);
    return tx.txid;
  }

  async attestProposal(value: unknown): Promise<BlockAttestation> {
    return this.exclusive(async () => {
      if (!this.signingJournal || !this.validatorPrivateKey) throw new Error("Validator signing is disabled");
      validateBlockShape(value);
      const block = value as Block;
      this.store.chain.validateProposal(block);
      const publicKey = publicKeyFromPrivate(this.validatorPrivateKey);
      const validator = this.store.chain.validatorsAt(block.header.height).find((item) => item.publicKey === publicKey);
      if (!validator) throw new Error("Configured validator key is not in genesis");
      await this.signingJournal.reserveAttestation(block.header.height, block.header.round, block.hash);
      return createBlockAttestation(block, this.validatorPrivateKey, publicKey);
    });
  }

  async requestSkipVote(
    height: number,
    round: number,
    previousCertificate: RoundSkipVote[] = [],
    nowMs = Date.now()
  ): Promise<RoundSkipVote> {
    return this.exclusive(async () => {
      if (!this.signingJournal || !this.validatorPrivateKey) throw new Error("Validator signing is disabled");
      const chain = this.store.chain;
      if (!Number.isSafeInteger(height) || height !== chain.height + 1 || !Number.isSafeInteger(round) || round < 0) {
        throw new Error("Invalid round skip request");
      }
      const deadline = chain.tip.header.timestampMs + BLOCK_INTERVAL_MS + ((round + 1) * ROUND_WINDOW_MS);
      if (nowMs < deadline) throw new Error("Round skip deadline has not elapsed");
      if (round === 0 && previousCertificate.length !== 0) {
        throw new Error("Round 0 skip must not contain a predecessor certificate");
      }
      if (round > 0) {
        const validators = chain.validatorsAt(height);
        validateRoundSkipQuorum(
          previousCertificate,
          validators,
          chain.genesis.chainId,
          height,
          round - 1,
          chain.tip.hash
        );
      }
      const publicKey = publicKeyFromPrivate(this.validatorPrivateKey);
      if (!chain.validatorsAt(height).some((validator) => validator.publicKey === publicKey)) {
        throw new Error("Configured validator key is not in genesis");
      }
      await this.signingJournal.reserveSkip(height, round, chain.tip.hash);
      return createRoundSkipVote({
        chainId: chain.genesis.chainId,
        height,
        round,
        previousHash: chain.tip.hash,
        validatorPrivateKey: this.validatorPrivateKey,
        validatorPublicKey: publicKey
      });
    });
  }

  async acceptFinalizedBlock(value: unknown): Promise<void> {
    return this.exclusive(async () => {
      validateBlockShape(value);
      const block = value as Block;
      await this.store.commitFinalizedBlock(block);
      this.mempool.remove(block.transactions.map((tx) => tx.txid));
      this.mempool.prune((tx) => tx.nonce <= this.store.chain.nonce(tx.sender));
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function createRpcServer(service: NodeService, options: RpcServerOptions = {}): Server {
  const requestsPerWindow = boundedPositiveInteger(
    options.requestsPerWindow ?? DEFAULT_RPC_REQUESTS_PER_WINDOW,
    "RPC requests per window"
  );
  const windowMs = boundedPositiveInteger(options.windowMs ?? DEFAULT_RPC_WINDOW_MS, "RPC rate-limit window");
  const peerAuthToken = options.peerAuthToken === undefined ? undefined : validatePeerAuthToken(options.peerAuthToken);
  const peerRecord = options.peerRecord === undefined
    ? undefined
    : validateSignedPeerRecord(options.peerRecord, service.status());
  const peerRequestAuthenticator = options.trustedPeerPublicKeys?.length
    ? new PeerRequestAuthenticator(options.trustedPeerPublicKeys, service.status())
    : undefined;
  const limiter = new FixedWindowLimiter(requestsPerWindow, windowMs);
  const server = createServer(async (request, response) => {
    const rate = limiter.consume(request.socket.remoteAddress ?? "unknown", Date.now());
    response.setHeader("x-ratelimit-limit", String(requestsPerWindow));
    response.setHeader("x-ratelimit-remaining", String(rate.remaining));
    if (!rate.allowed) {
      response.setHeader("retry-after", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))));
      writeJson(response, 429, { error: "Rate limit exceeded" });
      return;
    }
    try {
      await route(service, request, response, peerRecord, peerAuthToken, peerRequestAuthenticator);
    } catch (error) {
      if (error instanceof PeerAuthenticationError) {
        response.setHeader("www-authenticate", peerRequestAuthenticator ? "ZyronSignature" : "Bearer");
        writeJson(response, 401, { error: error.message });
        return;
      }
      writeJson(response, 400, { error: safeError(error) });
    }
  });
  server.maxConnections = boundedPositiveInteger(options.maxConnections ?? DEFAULT_RPC_MAX_CONNECTIONS, "RPC max connections");
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function route(
  service: NodeService,
  request: IncomingMessage,
  response: ServerResponse,
  peerRecord?: SignedPeerRecord,
  peerAuthToken?: string,
  peerRequestAuthenticator?: PeerRequestAuthenticator
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://node.invalid");
  if (request.method === "GET" && url.pathname === "/status") {
    return writeJson(response, 200, service.status());
  }
  if (request.method === "GET" && url.pathname === "/peer-record" && peerRecord) {
    validateSignedPeerRecord(peerRecord, service.status());
    return writeJson(response, 200, peerRecord);
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    return writeJson(response, 200, { ok: true, height: service.status().height });
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    return writeJson(response, 200, service.metrics());
  }
  if (request.method === "GET" && url.pathname === "/blocks") {
    const from = parseInteger(url.searchParams.get("from"), "from");
    const limit = url.searchParams.has("limit") ? parseInteger(url.searchParams.get("limit"), "limit") : MAX_SYNC_BLOCKS;
    return writeJson(response, 200, { blocks: await service.blocks(from, limit) });
  }
  if (request.method === "GET" && (url.pathname.startsWith("/balance/") || url.pathname.startsWith("/nonce/"))) {
    const address = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    if (url.pathname.startsWith("/balance/")) return writeJson(response, 200, { address, balanceAtoms: service.balance(address) });
    return writeJson(response, 200, { address, nonce: service.nonce(address) });
  }
  if (request.method === "POST" && url.pathname === "/tx") {
    return writeJson(response, 202, { txid: service.submitTransaction(await readJsonBody(request)) });
  }
  if (request.method === "POST" && url.pathname === "/proposal/attest") {
    const body = await readJsonBody(request);
    authorizeConsensusRequest(request, url.pathname, body, peerAuthToken, peerRequestAuthenticator);
    return writeJson(response, 200, { attestation: await service.attestProposal(body) });
  }
  if (request.method === "POST" && url.pathname === "/round/skip") {
    const body = await readJsonBody(request);
    authorizeConsensusRequest(request, url.pathname, body, peerAuthToken, peerRequestAuthenticator);
    assertPlainRecord(body, "round skip request");
    assertExactKeys(body, ["height", "round", "previousCertificate"], "round skip request");
    if (!Number.isSafeInteger(body.height) || !Number.isSafeInteger(body.round) || !Array.isArray(body.previousCertificate)) {
      throw new Error("Invalid round skip request");
    }
    return writeJson(response, 200, {
      vote: await service.requestSkipVote(Number(body.height), Number(body.round), body.previousCertificate as RoundSkipVote[])
    });
  }
  if (request.method === "POST" && url.pathname === "/block") {
    const body = await readJsonBody(request);
    authorizeConsensusRequest(request, url.pathname, body, peerAuthToken, peerRequestAuthenticator);
    await service.acceptFinalizedBlock(body);
    return writeJson(response, 202, { accepted: true, height: service.status().height });
  }
  writeJson(response, 404, { error: "Not found" });
}

export class PeerClient {
  readonly peers: string[];
  private syncCursor = 0;
  private readonly failureUntil = new Map<string, number>();

  constructor(
    peers: string[],
    private readonly peerAuthToken?: string,
    private readonly peerRequestCredentials?: PeerRequestCredentials,
    private readonly peerReputation?: PeerReputationStore
  ) {
    if (peerAuthToken !== undefined) validatePeerAuthToken(peerAuthToken);
    this.peers = [...new Set(peers.map(normalizePeerUrl))];
    if (this.peers.length > MAX_CONFIGURED_PEERS) throw new Error("Too many configured peers");
    if (peerAuthToken !== undefined || peerRequestCredentials !== undefined) {
      for (const peer of this.peers) {
        if (!peerTransportProtectsCredentials(peer)) {
          throw new Error("Authenticated remote peers must use HTTPS");
        }
      }
    }
  }

  async syncFrom(peer: string, service: NodeService): Promise<number> {
    const base = normalizePeerUrl(peer);
    const remoteStatus = parseStatus(await getJson(`${base}/status`, 64_000));
    const local = service.status();
    if (remoteStatus.chainId !== local.chainId || remoteStatus.genesisHash !== local.genesisHash) {
      throw new Error("Peer chain identity mismatch");
    }
    let accepted = 0;
    while (service.status().height < remoteStatus.height) {
      const from = service.status().height + 1;
      const payload = await getJson(`${base}/blocks?from=${from}&limit=${MAX_SYNC_BLOCKS}`, MAX_SYNC_RESPONSE_BYTES);
      assertPlainRecord(payload, "peer block response");
      assertExactKeys(payload, ["blocks"], "peer block response");
      if (!Array.isArray(payload.blocks) || payload.blocks.length === 0 || payload.blocks.length > MAX_SYNC_BLOCKS) {
        throw new Error("Invalid peer block batch");
      }
      for (const block of payload.blocks) {
        await service.acceptFinalizedBlock(block);
        accepted += 1;
      }
    }
    return accepted;
  }

  async fetchPeerRecord(
    peer: string,
    expected: { chainId: string; genesisHash: string },
    nowMs = Date.now()
  ): Promise<SignedPeerRecord> {
    const base = normalizePeerUrl(peer);
    return validateSignedPeerRecord(await getJson(`${base}/peer-record`, 64_000), expected, nowMs);
  }

  async syncAny(service: NodeService): Promise<number> {
    let accepted = 0;
    while (this.peers.length > 0) {
      const startHeight = service.status().height;
      const nowMs = Date.now();
      const ordered = rotate(this.peers, this.syncCursor)
        .filter((peer) => (this.failureUntil.get(peer) ?? 0) <= nowMs && (this.peerReputation?.isAvailable(peer, nowMs) ?? true));
      if (ordered.length === 0) break;
      const attempts = await Promise.allSettled(ordered.map(async (peer) => {
          const status = parseStatus(await getJson(`${peer}/status`, 64_000));
          const local = service.status();
          if (status.chainId !== local.chainId || status.genesisHash !== local.genesisHash) {
            throw new Error("Peer chain identity mismatch");
          }
          if (status.height <= startHeight) return null;
          const payload = await getJson(
            `${peer}/blocks?from=${startHeight + 1}&limit=${MAX_SYNC_BLOCKS}`,
            MAX_SYNC_RESPONSE_BYTES
          );
          const blocks = parsePeerBlockBatch(payload);
          service.store.chain.validateFinalizedBlock(blocks[0] as Block);
          return { peer, height: status.height, blocks };
      }));
      let candidate: { peer: string; height: number; blocks: unknown[] } | undefined;
      for (let index = 0; index < attempts.length; index += 1) {
        const result = attempts[index]!;
        const peer = ordered[index]!;
        if (result.status === "rejected") {
          await this.recordFailure(peer, nowMs);
          continue;
        }
        if (!candidate && result.value) candidate = result.value;
      }
      if (!candidate) break;
      const selectedIndex = this.peers.indexOf(candidate.peer);
      this.syncCursor = selectedIndex < 0 ? 0 : (selectedIndex + 1) % this.peers.length;

      let progressed = false;
      let poisoned = false;
      for (const block of candidate.blocks) {
        try {
          await service.acceptFinalizedBlock(block);
          accepted += 1;
          progressed = true;
        } catch {
          // A peer with a valid first block but a poisoned tail cannot stop the next
          // independently selected peer. Back it off so latency cannot let it
          // immediately monopolize the next batch.
          poisoned = true;
          break;
        }
      }
      if (poisoned) {
        await this.recordFailure(candidate.peer, Date.now());
      } else if (progressed) {
        this.failureUntil.delete(candidate.peer);
        await this.peerReputation?.recordSuccess(candidate.peer, Date.now());
      }
      if (!progressed || service.status().height <= startHeight) break;
    }
    return accepted;
  }

  async requestAttestations(block: Block): Promise<BlockAttestation[]> {
    const results = await Promise.allSettled(this.peers.map(async (peer) => {
      const payload = await postJson(`${peer}/proposal/attest`, block, MAX_BODY_BYTES, this.peerAuthToken, this.peerRequestCredentials);
      assertPlainRecord(payload, "attestation response");
      assertExactKeys(payload, ["attestation"], "attestation response");
      return payload.attestation as BlockAttestation;
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  async requestRoundSkips(
    height: number,
    round: number,
    previousCertificate: RoundSkipVote[] = []
  ): Promise<RoundSkipVote[]> {
    const results = await Promise.allSettled(this.peers.map(async (peer) => {
      const payload = await postJson(`${peer}/round/skip`, { height, round, previousCertificate }, 128_000, this.peerAuthToken, this.peerRequestCredentials);
      assertPlainRecord(payload, "round skip response");
      assertExactKeys(payload, ["vote"], "round skip response");
      return payload.vote as RoundSkipVote;
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  async broadcastBlock(block: Block): Promise<void> {
    await Promise.allSettled(this.peers.map((peer) => postJson(
      `${peer}/block`, block, 64_000, this.peerAuthToken, this.peerRequestCredentials
    )));
  }

  private async recordFailure(peer: string, nowMs: number): Promise<void> {
    const backoffMs = this.peerReputation
      ? await this.peerReputation.recordFailure(peer, nowMs)
      : PEER_FAILURE_BACKOFF_MS;
    this.failureUntil.set(peer, nowMs + backoffMs);
  }
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  if (values.length === 0) return [];
  const start = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

export async function produceFinalizedBlock(
  service: NodeService,
  peers: PeerClient,
  validatorPrivateKey: string,
  nowMs = Date.now()
): Promise<Block | null> {
  const chain = service.store.chain;
  const elapsed = nowMs - chain.tip.header.timestampMs;
  if (elapsed < BLOCK_INTERVAL_MS) return null;
  const round = Math.max(0, Math.floor((elapsed - BLOCK_INTERVAL_MS) / ROUND_WINDOW_MS));
  const publicKey = publicKeyFromPrivate(validatorPrivateKey);
  const validators = chain.validatorsAt(chain.height + 1);
  const expected = expectedValidator(validators, chain.height + 1, round);
  if (expected.publicKey !== publicKey) return null;
  let roundCertificate: RoundSkipVote[] = [];
  if (round > 0) {
    let previousCertificate: RoundSkipVote[] = [];
    for (let skippedRound = 0; skippedRound < round; skippedRound += 1) {
      const votes: RoundSkipVote[] = [];
      try {
        votes.push(await service.requestSkipVote(chain.height + 1, skippedRound, previousCertificate, nowMs));
      } catch {
        // An honest validator that already attested this round must never also skip it.
      }
      votes.push(...await peers.requestRoundSkips(chain.height + 1, skippedRound, previousCertificate));
      const unique = new Map<Address, RoundSkipVote>();
      for (const vote of votes) {
        try {
          validateRoundSkipVote(
            vote,
            validators,
            chain.genesis.chainId,
            chain.height + 1,
            skippedRound,
            chain.tip.hash
          );
          unique.set(vote.validator, vote);
        } catch {
          // A malformed or invalid peer vote cannot poison an otherwise valid quorum.
        }
      }
      const certificate = [...unique.values()];
      try {
        validateRoundSkipQuorum(
          certificate,
          validators,
          chain.genesis.chainId,
          chain.height + 1,
          skippedRound,
          chain.tip.hash
        );
      } catch {
        return null;
      }
      roundCertificate = certificate;
      previousCertificate = certificate;
    }
  }
  const transactions = chain.selectValidPending(service.mempool.values(), 10_000);
  const proposal = chain.produceBlock(transactions, validatorPrivateKey, {
    round,
    timestampMs: nowMs,
    roundCertificate
  });
  const attestations: BlockAttestation[] = [];
  try {
    attestations.push(await service.attestProposal(proposal));
  } catch (error) {
    if (!/Validator signing is disabled/.test(safeError(error))) throw error;
  }
  attestations.push(...await peers.requestAttestations(proposal));
  const byValidator = new Map<Address, BlockAttestation>();
  for (const attestation of attestations) {
    try {
      validateBlockAttestation(proposal, attestation, validators);
      byValidator.set(attestation.validator, attestation);
    } catch {
      // Invalid peer attestations are ignored instead of poisoning block assembly.
    }
  }
  const withVotes = { ...proposal, attestations: [...byValidator.values()] };
  try {
    await service.acceptFinalizedBlock(withVotes);
  } catch (error) {
    if (/Finality quorum not reached/.test(safeError(error))) return null;
    throw error;
  }
  await peers.broadcastBlock(withVotes);
  return withVotes;
}

function parseStatus(value: unknown): NodeStatus {
  assertPlainRecord(value, "peer status");
  assertExactKeys(value, ["chainId", "genesisHash", "height", "tipHash"], "peer status");
  if (typeof value.chainId !== "string" || typeof value.genesisHash !== "string" || typeof value.tipHash !== "string" ||
      !Number.isSafeInteger(value.height) || Number(value.height) < 0 || !/^[0-9a-f]{64}$/.test(value.genesisHash) ||
      !/^[0-9a-f]{64}$/.test(value.tipHash)) throw new Error("Invalid peer status");
  return value as unknown as NodeStatus;
}

function parsePeerBlockBatch(value: unknown): unknown[] {
  assertPlainRecord(value, "peer block response");
  assertExactKeys(value, ["blocks"], "peer block response");
  if (!Array.isArray(value.blocks) || value.blocks.length === 0 || value.blocks.length > MAX_SYNC_BLOCKS) {
    throw new Error("Invalid peer block batch");
  }
  return value.blocks;
}

function normalizePeerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Peer URL must use HTTP(S)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Peer URL contains forbidden components");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function peerTransportProtectsCredentials(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "::1" || url.hostname === "[::1]";
}

async function getJson(url: string, maxBytes: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}`);
  return parseBoundedResponse(response, maxBytes);
}

async function postJson(
  url: string,
  value: unknown,
  maxResponseBytes: number,
  peerAuthToken?: string,
  peerRequestCredentials?: PeerRequestCredentials
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (peerAuthToken) headers.authorization = `Bearer ${peerAuthToken}`;
  const body = canonicalJson(value);
  if (peerRequestCredentials) {
    const target = new URL(url);
    Object.assign(headers, signPeerRequest(peerRequestCredentials.identity, {
      chainId: peerRequestCredentials.chainId,
      genesisHash: peerRequestCredentials.genesisHash,
      method: "POST",
      path: target.pathname,
      bodySha256: sha256Hex(Buffer.from(body, "utf8"))
    }));
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(PEER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}`);
  return parseBoundedResponse(response, maxResponseBytes);
}

async function parseBoundedResponse(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("Peer returned empty body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Peer response too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new Error("Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (total === 0) throw new Error("Request body is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function parseInteger(value: string | null, name: string): number {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${name}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid ${name}`);
  return result;
}

function boundedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) throw new Error(`Invalid ${name}`);
  return value;
}

function validatePeerAuthToken(value: string): string {
  if (value.length < 32 || value.length > 512 || /[\r\n]/.test(value)) {
    throw new Error("Peer authentication token must be 32-512 characters without newlines");
  }
  return value;
}

function validBearerToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

class PeerAuthenticationError extends Error {}

function authorizeConsensusRequest(
  request: IncomingMessage,
  path: string,
  body: unknown,
  peerAuthToken?: string,
  peerRequestAuthenticator?: PeerRequestAuthenticator
): void {
  if (peerRequestAuthenticator) {
    try {
      peerRequestAuthenticator.verify(request.headers, {
        method: request.method ?? "",
        path,
        bodySha256: sha256Hex(Buffer.from(canonicalJson(body), "utf8"))
      });
      return;
    } catch {
      throw new PeerAuthenticationError("Peer signature authentication required");
    }
  }
  if (peerAuthToken && !validBearerToken(request.headers.authorization, peerAuthToken)) {
    throw new PeerAuthenticationError("Peer authentication required");
  }
}

class FixedWindowLimiter {
  private readonly clients = new Map<string, { count: number; startedAtMs: number }>();
  private lastSweepMs = 0;

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  consume(client: string, nowMs: number): { allowed: boolean; remaining: number; retryAfterMs: number } {
    if (nowMs - this.lastSweepMs >= this.windowMs) {
      for (const [key, entry] of this.clients) {
        if (nowMs - entry.startedAtMs >= this.windowMs) this.clients.delete(key);
      }
      this.lastSweepMs = nowMs;
    }
    let entry = this.clients.get(client);
    if (!entry || nowMs - entry.startedAtMs >= this.windowMs) {
      entry = { count: 0, startedAtMs: nowMs };
      this.clients.set(client, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, this.limit - entry.count);
    return {
      allowed: entry.count <= this.limit,
      remaining,
      retryAfterMs: Math.max(0, entry.startedAtMs + this.windowMs - nowMs)
    };
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
