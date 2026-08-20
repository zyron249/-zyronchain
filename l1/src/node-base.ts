import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { canonicalJson, sha256Hex } from "./codec.js";

import {
  attachBlockSignature,
  attestationPayload,
  expectedValidator,
  roundSkipPayload,
  validateBlockAttestation,
  validateBlockShape,
  validateRoundSkipVote,
  validateRoundSkipQuorum
} from "./block.js";
import { addressFromPublicKey } from "./crypto.js";
import { Mempool } from "./mempool.js";
import { PeerReputationStore } from "./peer-reputation.js";
import { ipv6Prefix64 } from "./p2p-address.js";
import { nativeP2PFrameBudgetMetrics } from "./p2p-frame.js";
import { MAX_DISCOVERY_RESPONSE_RECORDS, PeerDirectory } from "./peer-directory.js";
import {
  PeerRequestAuthenticator,
  signPeerRequest,
  validateSignedPeerRecord,
  type NodeIdentity,
  type SignedPeerRecord
} from "./peer-identity.js";
import { FixedWindowLimiter } from "./rpc-rate-limit.js";
import { ChainStore, SigningJournal } from "./storage.js";
import { assertAddress, assertExactKeys, assertPlainRecord, validateTransactionShape } from "./transaction.js";
import type { Address, Block, BlockAttestation, RoundSkipVote, Transaction } from "./types.js";
import { LocalValidatorSigner, signWithValidator, type ValidatorSigner } from "./validator-signer.js";

const MAX_BODY_BYTES = 2_500_000;
export const MAX_RPC_JSON_NESTING_DEPTH = 64;
export const MAX_RPC_JSON_STRUCTURAL_TOKENS = 250_000;
export const MAX_PEER_RESPONSE_JSON_NESTING_DEPTH = 64;
export const MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS = 250_000;
export const MAX_PEER_RESPONSE_PARSE_BYTES_INFLIGHT = 160_000_000;
const PEER_RESPONSE_JSON_NODE_ESTIMATE_BYTES = 64;
export const RPC_API_VERSION = 1;
export const MAX_SYNC_BLOCKS = 100;
export const MAX_SYNC_RESPONSE_BYTES = 25_000_000;
export const MAX_PEER_RESPONSE_BYTES_INFLIGHT = 50_000_000;
export const MAX_SYNC_BATCH_PAYLOAD_BYTES = 20_000_000;
const MAX_CONFIGURED_PEERS = 64;
export const MAX_SYNC_PROBE_CONCURRENCY = 8;
export const MAX_GOSSIP_FANOUT = 8;
const MAX_GOSSIP_DEDUP_IDS = 4_096;
const PEER_FAILURE_BACKOFF_MS = 30_000;
const PEER_TIMEOUT_MS = 8_000;
const DEFAULT_RPC_WINDOW_MS = 60_000;
const DEFAULT_RPC_REQUESTS_PER_WINDOW = 600;
const DEFAULT_RPC_MAX_CONNECTIONS = 256;
const DEFAULT_RPC_MAX_INFLIGHT_REQUESTS = 128;
export const DEFAULT_RPC_MAX_INFLIGHT_BODY_BYTES = 25_000_000;
export const DEFAULT_RPC_MAX_INFLIGHT_RESPONSE_BYTES = 25_000_000;
export const MAX_SMALL_RPC_RESPONSE_SERIALIZATION_BYTES = 4_000_000;
export const RPC_MAX_HEADERS = 64;
export const RPC_MAX_REQUESTS_PER_SOCKET = 100;
export const MAX_RPC_TRUSTED_PROXIES = 16;
export const MAX_RPC_FORWARDED_HOPS = 16;
const DEFAULT_CONSENSUS_INFLIGHT_PER_PEER = 4;
export const BLOCK_INTERVAL_MS = 30_000;
export const ROUND_WINDOW_MS = 30_000;
export const MAX_VALIDATOR_CLOCK_ROLLBACK_MS = 1_000;

export interface NodeStatus {
  chainId: string;
  genesisHash: string;
  height: number;
  tipHash: string;
}

export interface NodeProtocolStatus {
  currentVersion: number;
  nextVersion: number;
}

export interface NodeReadiness {
  ready: boolean;
  height: number;
  reasons: string[];
}

export interface NodeMetrics extends NodeStatus {
  mempoolSize: number;
  validatorCount: number;
  uptimeSeconds: number;
  finalizedBlockAgeSeconds: number;
  firstStoredHeight: number;
  persistenceHealthy: boolean;
  recoveredFromCheckpointHeight: number;
  recoveredStateV2FromCorruption: boolean;
  validatorClockHealthy: boolean;
}

export interface RpcAdmissionMetrics {
  inflightRequests: number;
  maxInflightRequests: number;
  rejectedRequests: number;
}

export interface RpcByteBudgetMetrics {
  requestBodyBytesInUse: number;
  maxRequestBodyBytes: number;
  rejectedRequestBodies: number;
  responseBytesInUse: number;
  maxResponseBytes: number;
  rejectedResponses: number;
}

export interface RpcServerOptions {
  maxConnections?: number;
  maxInflightRequests?: number;
  maxInflightRequestBodyBytes?: number;
  maxInflightResponseBytes?: number;
  maxConsensusInflightPerPeer?: number;
  peerAuthToken?: string;
  peerRecord?: SignedPeerRecord;
  peerDirectory?: PeerDirectory;
  trustedPeerPublicKeys?: string[];
  trustedProxyAddresses?: string[];
  onTransactionAccepted?: (transaction: Transaction) => void | Promise<void>;
  requestsPerWindow?: number;
  windowMs?: number;
}

export interface PeerRequestCredentials {
  identity: NodeIdentity;
  chainId: string;
  genesisHash: string;
}

export interface ConsensusPeerClient {
  requestAttestations(block: Block): Promise<BlockAttestation[]>;
  requestRoundSkips(height: number, round: number, previousCertificate?: RoundSkipVote[]): Promise<RoundSkipVote[]>;
  broadcastBlock(block: Block): Promise<void>;
}

export function assertSafeRpcBinding(
  host: string,
  consensusAuthenticationConfigured: boolean,
  trustedHttpsProxyConfigured = false
): void {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = normalized === "localhost" || normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."));
  if (!loopback && !consensusAuthenticationConfigured) {
    throw new Error("Non-loopback RPC binding requires consensus peer authentication");
  }
  if (!loopback && !trustedHttpsProxyConfigured) {
    throw new Error("Non-loopback RPC binding requires an HTTPS-enforcing trusted proxy");
  }
}

function normalizeProxyAddress(address: string): string {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4Mapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const candidate = isIP(ipv4Mapped) === 4 ? ipv4Mapped : normalized;
  if (isIP(candidate) === 0) throw new Error("Trusted RPC proxy must be an IP address");
  return candidate;
}

function normalizeTrustedProxyAddresses(addresses: readonly string[]): ReadonlySet<string> {
  if (addresses.length > MAX_RPC_TRUSTED_PROXIES) {
    throw new Error("Too many configured trusted RPC proxies");
  }
  return new Set(addresses.map(normalizeProxyAddress));
}

export function assertRpcTrustedProxyConfiguration(addresses: readonly string[]): void {
  normalizeTrustedProxyAddresses(addresses);
}

function isTrustedHttpsProxyRequestFromSet(
  remoteAddress: string | undefined,
  forwardedProto: string | string[] | undefined,
  trusted: ReadonlySet<string>
): boolean {
  if (trusted.size === 0) return true;
  if (forwardedProto !== "https" || remoteAddress === undefined) return false;
  try {
    return trusted.has(normalizeProxyAddress(remoteAddress));
  } catch {
    return false;
  }
}

export function isTrustedHttpsProxyRequest(
  remoteAddress: string | undefined,
  forwardedProto: string | string[] | undefined,
  trustedProxyAddresses: readonly string[]
): boolean {
  try {
    return isTrustedHttpsProxyRequestFromSet(
      remoteAddress,
      forwardedProto,
      normalizeTrustedProxyAddresses(trustedProxyAddresses)
    );
  } catch {
    return false;
  }
}

function forwardedHopCountWithinBound(value: string): boolean {
  let hops = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 44) continue;
    hops += 1;
    if (hops > MAX_RPC_FORWARDED_HOPS) return false;
  }
  return true;
}

function rpcRateLimitIdentityFromSet(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trusted: ReadonlySet<string>
): string {
  if (remoteAddress === undefined) return "unknown";
  let remote: string;
  try {
    remote = normalizeProxyAddress(remoteAddress);
  } catch {
    return "unknown";
  }
  if (trusted.size === 0) return remote;
  if (!trusted.has(remote)) return remote;
  if (typeof forwardedFor !== "string" || forwardedFor.length === 0) return `proxy:${remote}`;
  if (!forwardedHopCountWithinBound(forwardedFor)) return `proxy:${remote}`;
  const chain = forwardedFor.split(",").map((item) => item.trim());
  if (chain.length === 0 || chain.some((item) => item.length === 0)) return `proxy:${remote}`;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    let hop: string;
    try {
      hop = normalizeProxyAddress(chain[index]!);
    } catch {
      return `proxy:${remote}`;
    }
    if (!trusted.has(hop)) return hop;
  }
  return `proxy:${remote}`;
}

export function rpcRateLimitIdentity(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxyAddresses: readonly string[]
): string {
  return rpcRateLimitIdentityFromSet(
    remoteAddress,
    forwardedFor,
    normalizeTrustedProxyAddresses(trustedProxyAddresses)
  );
}

export class NodeService {
  readonly mempool = new Mempool();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly startedAtMs = Date.now();
  private readonly validatorSigner: ValidatorSigner | undefined;
  private lastValidatorClockMs: number | undefined;
  private validatorClockFaulted = false;

  constructor(
    readonly store: ChainStore,
    private readonly signingJournal?: SigningJournal,
    validator?: string | ValidatorSigner
  ) {
    this.validatorSigner = typeof validator === "string" ? new LocalValidatorSigner(validator) : validator;
  }

  status(): NodeStatus {
    return {
      chainId: this.store.chain.genesis.chainId,
      genesisHash: this.store.chain.genesisHash,
      height: this.store.chain.height,
      tipHash: this.store.chain.tip.hash
    };
  }

  protocolStatus(): NodeProtocolStatus {
    const height = this.store.chain.height;
    return {
      currentVersion: this.store.chain.protocolVersionAt(height),
      nextVersion: this.store.chain.protocolVersionAt(height + 1)
    };
  }

  readiness(): NodeReadiness {
    const reasons: string[] = [];
    if (!this.store.persistenceHealthy) reasons.push("persistence-unhealthy");
    if (this.signingJournal && !this.signingJournal.persistenceHealthy) reasons.push("signing-journal-unhealthy");
    if (this.validatorClockFaulted) reasons.push("validator-clock-unhealthy");
    return {
      ready: reasons.length === 0,
      height: this.store.chain.height,
      reasons
    };
  }

  metrics(nowMs = Date.now()): NodeMetrics {
    return {
      ...this.status(),
      mempoolSize: this.mempool.size,
      validatorCount: this.store.chain.validatorsAt(this.store.chain.height + 1).length,
      uptimeSeconds: Math.max(0, Math.floor((nowMs - this.startedAtMs) / 1_000)),
      finalizedBlockAgeSeconds: Math.max(0, Math.floor((nowMs - this.store.chain.tip.header.timestampMs) / 1_000)),
      firstStoredHeight: this.store.firstStoredHeight,
      persistenceHealthy: this.store.persistenceHealthy,
      recoveredFromCheckpointHeight: this.store.recoveredFromCheckpointHeight,
      recoveredStateV2FromCorruption: this.store.recoveredStateV2FromCorruption,
      validatorClockHealthy: !this.validatorClockFaulted
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

  async attestProposal(value: unknown, nowMs = Date.now()): Promise<BlockAttestation> {
    return this.exclusive(async () => {
      if (!this.signingJournal || !this.validatorSigner) throw new Error("Validator signing is disabled");
      this.assertValidatorClock(nowMs);
      validateBlockShape(value);
      const block = value as Block;
      this.store.chain.validateProposal(block, nowMs);
      const publicKey = this.validatorSigner.publicKey;
      const validator = this.store.chain.validatorsAt(block.header.height).find((item) => item.publicKey === publicKey);
      if (!validator) throw new Error("Configured validator key is not in genesis");
      await this.signingJournal.reserveAttestation(block.header.height, block.header.round, block.hash);
      return {
        validator: validator.address,
        publicKey,
        signature: await signWithValidator(
          this.validatorSigner,
          attestationPayload(block),
          "block-attestation",
          block.header.version
        )
      };
    });
  }

  async signPreparedProposal(block: Block, nowMs = Date.now()): Promise<Block> {
    return this.exclusive(async () => {
      if (!this.signingJournal || !this.validatorSigner) throw new Error("Validator signing is disabled");
      this.assertValidatorClock(nowMs);
      this.store.chain.validatePreparedUnsignedBlock(block, nowMs);
      if (block.proposerPublicKey !== this.validatorSigner.publicKey) throw new Error("Configured validator is not the block proposer");
      await this.signingJournal.reserveAttestation(block.header.height, block.header.round, block.hash);
      return attachBlockSignature(
        block,
        await signWithValidator(this.validatorSigner, block.header, "block-proposal", block.header.version)
      );
    });
  }

  async requestSkipVote(
    height: number,
    round: number,
    previousCertificate: RoundSkipVote[] = [],
    nowMs = Date.now()
  ): Promise<RoundSkipVote> {
    return this.exclusive(async () => {
      if (!this.signingJournal || !this.validatorSigner) throw new Error("Validator signing is disabled");
      this.assertValidatorClock(nowMs);
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
          chain.tip.hash,
          chain.protocolVersionAt(height)
        );
      }
      const publicKey = this.validatorSigner.publicKey;
      if (!chain.validatorsAt(height).some((validator) => validator.publicKey === publicKey)) {
        throw new Error("Configured validator key is not in genesis");
      }
      await this.signingJournal.reserveSkip(height, round, chain.tip.hash);
      const unsigned = {
        validator: addressFromPublicKey(publicKey),
        publicKey,
        chainId: chain.genesis.chainId,
        height,
        round,
        previousHash: chain.tip.hash,
      };
      return {
        ...unsigned,
        signature: await signWithValidator(
          this.validatorSigner,
          roundSkipPayload(unsigned),
          "round-skip",
          chain.protocolVersionAt(height)
        )
      };
    });
  }

  async acceptFinalizedBlock(value: unknown): Promise<void> {
    return this.exclusive(async () => {
      validateBlockShape(value);
      const block = value as Block;
      await this.store.commitFinalizedBlock(block);
      await this.signingJournal?.compactThrough(this.store.chain.height);
      this.mempool.remove(block.transactions.map((tx) => tx.txid));
      const nextMiningHeight = this.store.chain.height + 1;
      const nextMiningPreviousHash = this.store.chain.tip.hash;
      this.mempool.prune((tx) =>
        tx.nonce <= this.store.chain.nonce(tx.sender) ||
        (tx.kind === "mining_claim" &&
          (tx.height !== nextMiningHeight || tx.previousHash !== nextMiningPreviousHash))
      );
    });
  }

  private assertValidatorClock(nowMs: number): void {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid validator clock");
    if (this.validatorClockFaulted) throw new Error("Validator clock fault requires process restart");
    if (this.lastValidatorClockMs !== undefined &&
        nowMs + MAX_VALIDATOR_CLOCK_ROLLBACK_MS < this.lastValidatorClockMs) {
      this.validatorClockFaulted = true;
      throw new Error("Validator clock moved backwards beyond the safety tolerance");
    }
    this.lastValidatorClockMs = Math.max(this.lastValidatorClockMs ?? nowMs, nowMs);
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
  const consensusInflight = new PeerInflightLimiter(
    boundedPositiveInteger(
      options.maxConsensusInflightPerPeer ?? DEFAULT_CONSENSUS_INFLIGHT_PER_PEER,
      "consensus inflight per peer"
    )
  );
  const rpcAdmission = new RpcAdmissionController(
    options.maxInflightRequests ?? DEFAULT_RPC_MAX_INFLIGHT_REQUESTS
  );
  const rpcBodyBudget = new RpcRequestBodyByteBudget(
    options.maxInflightRequestBodyBytes ?? DEFAULT_RPC_MAX_INFLIGHT_BODY_BYTES
  );
  const rpcResponseBudget = new RpcResponseByteBudget(
    options.maxInflightResponseBytes ?? DEFAULT_RPC_MAX_INFLIGHT_RESPONSE_BYTES
  );
  const limiter = new FixedWindowLimiter(requestsPerWindow, windowMs);
  const trustedProxyAddresses = normalizeTrustedProxyAddresses(options.trustedProxyAddresses ?? []);
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const bodyReservation = new RpcRequestBodyReservation(rpcBodyBudget);
    response.setHeader("x-zyron-rpc-version", String(RPC_API_VERSION));
    if (!isTrustedHttpsProxyRequestFromSet(
      request.socket.remoteAddress,
      request.headers["x-forwarded-proto"],
      trustedProxyAddresses
    )) {
      response.setHeader("connection", "close");
      writeJson(response, 403, { error: "RPC request did not arrive through the configured HTTPS proxy" });
      return;
    }
    const rate = limiter.consume(rpcRateLimitIdentityFromSet(
      request.socket.remoteAddress,
      request.headers["x-forwarded-for"],
      trustedProxyAddresses
    ), Date.now());
    response.setHeader("x-ratelimit-limit", String(requestsPerWindow));
    response.setHeader("x-ratelimit-remaining", String(rate.remaining));
    if (!rate.allowed) {
      response.setHeader("retry-after", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))));
      writeJson(response, 429, { error: "Rate limit exceeded" });
      return;
    }
    const requestedRpcVersion = request.headers["x-zyron-rpc-version"];
    if (requestedRpcVersion !== undefined && requestedRpcVersion !== String(RPC_API_VERSION)) {
      writeJson(response, 426, {
        error: "Unsupported RPC API version",
        rpcVersion: RPC_API_VERSION,
        supportedRpcVersions: [RPC_API_VERSION]
      });
      return;
    }
    try {
      await route(
        service,
        request,
        response,
        peerRecord,
        options.peerDirectory,
        peerAuthToken,
        peerRequestAuthenticator,
        consensusInflight,
        bodyReservation,
        rpcAdmission,
        rpcResponseBudget,
        options.onTransactionAccepted
      );
    } catch (error) {
      if (error instanceof PeerAuthenticationError) {
        response.setHeader("www-authenticate", peerRequestAuthenticator ? "ZyronSignature" : "Bearer");
        writeJson(response, 401, { error: error.message });
        return;
      }
      if (error instanceof PeerInflightLimitError) {
        response.setHeader("retry-after", "1");
        writeJson(response, 429, { error: error.message });
        return;
      }
      if (error instanceof RpcBodyBudgetError) {
        response.setHeader("retry-after", "1");
        response.setHeader("connection", "close");
        writeJson(response, 503, { error: error.message });
        return;
      }
      writeJson(response, 400, { error: safeError(error) });
    } finally {
      bodyReservation.release();
    }
  };
  const server = createServer((request, response) => {
    rpcResponseBudgets.set(response, rpcResponseBudget);
    let release: () => void;
    try {
      release = rpcAdmission.enter();
    } catch {
      response.setHeader("retry-after", "1");
      response.setHeader("connection", "close");
      writeJson(response, 503, { error: "RPC concurrency limit exceeded" });
      return;
    }
    void handleRequest(request, response)
      .catch((error) => writeJson(response, 500, { error: safeError(error) }))
      .finally(release);
  });
  server.maxConnections = boundedPositiveInteger(options.maxConnections ?? DEFAULT_RPC_MAX_CONNECTIONS, "RPC max connections");
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = RPC_MAX_HEADERS;
  server.maxRequestsPerSocket = RPC_MAX_REQUESTS_PER_SOCKET;
  return server;
}

async function route(
  service: NodeService,
  request: IncomingMessage,
  response: ServerResponse,
  peerRecord?: SignedPeerRecord,
  peerDirectory?: PeerDirectory,
  peerAuthToken?: string,
  peerRequestAuthenticator?: PeerRequestAuthenticator,
  consensusInflight?: PeerInflightLimiter,
  bodyReservation?: RpcRequestBodyReservation,
  rpcAdmission?: RpcAdmissionController,
  rpcResponseBudget?: RpcResponseByteBudget,
  onTransactionAccepted?: (transaction: Transaction) => void | Promise<void>
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://node.invalid");
  if (request.method === "GET" && url.pathname === "/rpc-info") {
    return writeJson(response, 200, {
      rpcVersion: RPC_API_VERSION,
      supportedRpcVersions: [RPC_API_VERSION]
    });
  }
  if (request.method === "GET" && url.pathname === "/status") {
    return writeJson(response, 200, service.status());
  }
  if (request.method === "GET" && url.pathname === "/protocol") {
    return writeJson(response, 200, service.protocolStatus());
  }
  if (request.method === "GET" && url.pathname === "/peer-record" && peerRecord) {
    validateSignedPeerRecord(peerRecord, service.status());
    return writeJson(response, 200, peerRecord);
  }
  if (request.method === "GET" && url.pathname === "/peers" && peerDirectory) {
    const limit = url.searchParams.has("limit")
      ? parseInteger(url.searchParams.get("limit"), "limit")
      : MAX_DISCOVERY_RESPONSE_RECORDS;
    return writeJson(response, 200, { records: peerDirectory.list(limit) });
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    return writeJson(response, 200, { ok: true, height: service.status().height });
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    const readiness = service.readiness();
    return writeJson(response, readiness.ready ? 200 : 503, readiness);
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    return writeJson(response, 200, {
      ...service.metrics(),
      rpc: {
        ...rpcAdmission?.metrics(),
        ...bodyReservation?.metrics(),
        ...rpcResponseBudget?.metrics()
      },
      p2pFrames: nativeP2PFrameBudgetMetrics()
    });
  }
  if (request.method === "GET" && url.pathname === "/blocks") {
    const from = parseInteger(url.searchParams.get("from"), "from");
    const limit = url.searchParams.has("limit") ? parseInteger(url.searchParams.get("limit"), "limit") : MAX_SYNC_BLOCKS;
    return writeJson(response, 200, { blocks: await service.blocks(from, limit) }, MAX_SYNC_RESPONSE_BYTES);
  }
  if (request.method === "GET" && (url.pathname.startsWith("/balance/") || url.pathname.startsWith("/nonce/"))) {
    const address = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    if (url.pathname.startsWith("/balance/")) return writeJson(response, 200, { address, balanceAtoms: service.balance(address) });
    return writeJson(response, 200, { address, nonce: service.nonce(address) });
  }
  if (request.method === "POST" && url.pathname === "/tx") {
    const body = await readJsonBody(request, bodyReservation);
    const txid = service.submitTransaction(body);
    if (onTransactionAccepted) {
      const transaction = structuredClone(body as Transaction);
      void Promise.resolve().then(() => onTransactionAccepted(transaction)).catch(() => undefined);
    }
    return writeJson(response, 202, { txid });
  }
  if (request.method === "POST" && url.pathname === "/proposal/attest") {
    preauthorizeConsensusRequest(request, url.pathname, peerAuthToken, peerRequestAuthenticator);
    const body = await readJsonBody(request, bodyReservation);
    const release = enterConsensusRequest(
      request, url.pathname, body, peerAuthToken, peerRequestAuthenticator, consensusInflight
    );
    try {
      return writeJson(response, 200, { attestation: await service.attestProposal(body) });
    } finally {
      release();
    }
  }
  if (request.method === "POST" && url.pathname === "/round/skip") {
    preauthorizeConsensusRequest(request, url.pathname, peerAuthToken, peerRequestAuthenticator);
    const body = await readJsonBody(request, bodyReservation);
    const release = enterConsensusRequest(
      request, url.pathname, body, peerAuthToken, peerRequestAuthenticator, consensusInflight
    );
    try {
      assertPlainRecord(body, "round skip request");
      assertExactKeys(body, ["height", "round", "previousCertificate"], "round skip request");
      if (!Number.isSafeInteger(body.height) || !Number.isSafeInteger(body.round) || !Array.isArray(body.previousCertificate)) {
        throw new Error("Invalid round skip request");
      }
      return writeJson(response, 200, {
        vote: await service.requestSkipVote(Number(body.height), Number(body.round), body.previousCertificate as RoundSkipVote[])
      });
    } finally {
      release();
    }
  }
  if (request.method === "POST" && url.pathname === "/block") {
    preauthorizeConsensusRequest(request, url.pathname, peerAuthToken, peerRequestAuthenticator);
    const body = await readJsonBody(request, bodyReservation);
    const release = enterConsensusRequest(
      request, url.pathname, body, peerAuthToken, peerRequestAuthenticator, consensusInflight
    );
    try {
      await service.acceptFinalizedBlock(body);
      return writeJson(response, 202, { accepted: true, height: service.status().height });
    } finally {
      release();
    }
  }
  writeJson(response, 404, { error: "Not found" });
}

export class PeerClient {
  readonly peers: string[];
  private syncCursor = 0;
  private discoveryCursor = 0;
  private gossipCursor = 0;
  private readonly failureUntil = new Map<string, number>();
  private readonly blockGossipSeen = new Set<string>();
  private readonly transactionGossipSeen = new Set<string>();

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
    const remoteStatus = await getJson(`${base}/status`, 64_000, parseStatus);
    const local = service.status();
    if (remoteStatus.chainId !== local.chainId || remoteStatus.genesisHash !== local.genesisHash) {
      throw new Error("Peer chain identity mismatch");
    }
    let accepted = 0;
    while (service.status().height < remoteStatus.height) {
      const from = service.status().height + 1;
      const leasedBlocks = await getJsonRetained(`${base}/blocks?from=${from}&limit=${MAX_SYNC_BLOCKS}`, MAX_SYNC_RESPONSE_BYTES, parsePeerBlockBatch);
      try {
        for (const block of leasedBlocks.value) {
          await service.acceptFinalizedBlock(block);
          accepted += 1;
        }
      } finally {
        leasedBlocks.release();
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
    return getJson(`${base}/peer-record`, 64_000, (value) => validateSignedPeerRecord(value, expected, nowMs));
  }

  async fetchPeerRecords(
    peer: string,
    expected: { chainId: string; genesisHash: string },
    limit = MAX_DISCOVERY_RESPONSE_RECORDS,
    nowMs = Date.now()
  ): Promise<SignedPeerRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_RESPONSE_RECORDS) {
      throw new Error("Invalid peer discovery request limit");
    }
    const base = normalizePeerUrl(peer);
    return getJson(`${base}/peers?limit=${limit}`, 256_000, (payload) => {
      assertPlainRecord(payload, "peer discovery response");
      assertExactKeys(payload, ["records"], "peer discovery response");
      if (!Array.isArray(payload.records) || payload.records.length > limit) {
        throw new Error("Invalid peer discovery response");
      }
      return payload.records.map((record) => validateSignedPeerRecord(record, expected, nowMs));
    });
  }

  async refreshPeerDirectory(
    directory: PeerDirectory,
    expected: { chainId: string; genesisHash: string },
    nowMs = Date.now()
  ): Promise<number> {
    const ordered = diversityOrderedPeers(this.peers, this.discoveryCursor);
    if (ordered.length === 0) return 0;
    const seenGroups = new Set<string>();
    const sources = ordered.filter((peer) => {
      const group = peerDiversityBucket(peer);
      if (seenGroups.has(group)) return false;
      seenGroups.add(group);
      return true;
    }).slice(0, MAX_SYNC_PROBE_CONCURRENCY);
    const groupCount = Math.max(1, new Set(this.peers.map(peerDiversityBucket)).size);
    this.discoveryCursor = (this.discoveryCursor + sources.length) % groupCount;
    const results = await Promise.allSettled(
      sources.map((peer) => this.fetchPeerRecords(peer, expected, MAX_DISCOVERY_RESPONSE_RECORDS, nowMs))
    );
    let admitted = 0;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      const source = sources[index]!;
      if (result.status === "rejected") continue;
      for (const record of result.value) {
        try {
          if (directory.admit(record, nowMs, source)) admitted += 1;
        } catch (error) {
          if (/Peer directory (?:source )?capacity reached/.test(safeError(error))) break;
          throw error;
        }
      }
    }
    return admitted;
  }

  async syncAny(service: NodeService): Promise<number> {
    let accepted = 0;
    while (this.peers.length > 0) {
      const startHeight = service.status().height;
      const nowMs = Date.now();
      const available = this.peers
        .filter((peer) => (this.failureUntil.get(peer) ?? 0) <= nowMs && (this.peerReputation?.isAvailable(peer, nowMs) ?? true));
      let candidate: { peer: string; height: number; blocks: unknown[]; release: () => void } | undefined;
      for (const batch of peerSyncProbeBatches(available, this.syncCursor)) {
        const attempts = await Promise.allSettled(batch.map(async (peer) => {
            const status = await getJson(`${peer}/status`, 64_000, parseStatus);
            const local = service.status();
            if (status.chainId !== local.chainId || status.genesisHash !== local.genesisHash) {
              throw new Error("Peer chain identity mismatch");
            }
            if (status.height <= startHeight) return null;
            const leasedBlocks = await getJsonRetained(
              `${peer}/blocks?from=${startHeight + 1}&limit=${MAX_SYNC_BLOCKS}`,
              MAX_SYNC_RESPONSE_BYTES,
              parsePeerBlockBatch
            );
            try {
              service.store.chain.validateFinalizedBlock(leasedBlocks.value[0] as Block);
              return { peer, height: status.height, blocks: leasedBlocks.value, release: leasedBlocks.release };
            } catch (error) {
              leasedBlocks.release();
              throw error;
            }
        }));
        for (let index = 0; index < attempts.length; index += 1) {
          const result = attempts[index]!;
          const peer = batch[index]!;
          if (result.status === "rejected") {
            await this.recordFailure(peer, nowMs);
            continue;
          }
          if (!result.value) continue;
          if (!candidate) candidate = result.value;
          else result.value.release();
        }
        if (candidate) break;
      }
      if (!candidate) break;
      const groups = [...new Set(available.map(peerDiversityBucket))];
      const selectedGroupIndex = groups.indexOf(peerDiversityBucket(candidate.peer));
      this.syncCursor = selectedGroupIndex < 0 || groups.length === 0 ? 0 : (selectedGroupIndex + 1) % groups.length;

      let progressed = false;
      try {
        let poisoned = false;
        for (const block of candidate.blocks) {
          try {
            await service.acceptFinalizedBlock(block);
            accepted += 1;
            progressed = true;
          } catch {
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
      } finally {
        candidate.release();
      }
      if (!progressed || service.status().height <= startHeight) break;
    }
    return accepted;
  }

  async requestAttestations(block: Block): Promise<BlockAttestation[]> {
    const results = await Promise.allSettled(this.peers.map(async (peer) => {
      return postJson(
        `${peer}/proposal/attest`,
        block,
        MAX_BODY_BYTES,
        this.peerAuthToken,
        this.peerRequestCredentials,
        (payload) => {
          assertPlainRecord(payload, "attestation response");
          assertExactKeys(payload, ["attestation"], "attestation response");
          return payload.attestation as BlockAttestation;
        }
      );
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  async requestRoundSkips(
    height: number,
    round: number,
    previousCertificate: RoundSkipVote[] = []
  ): Promise<RoundSkipVote[]> {
    const results = await Promise.allSettled(this.peers.map(async (peer) => {
      return postJson(
        `${peer}/round/skip`,
        { height, round, previousCertificate },
        128_000,
        this.peerAuthToken,
        this.peerRequestCredentials,
        (payload) => {
          assertPlainRecord(payload, "round skip response");
          assertExactKeys(payload, ["vote"], "round skip response");
          return payload.vote as RoundSkipVote;
        }
      );
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  async broadcastBlock(block: Block): Promise<void> {
    if (!rememberGossipId(this.blockGossipSeen, block.hash)) return;
    const fanout = this.nextGossipFanout();
    await Promise.allSettled(fanout.map((peer) => postJson(
      `${peer}/block`, block, 64_000, this.peerAuthToken, this.peerRequestCredentials
    )));
  }

  async broadcastTransaction(transaction: Transaction): Promise<void> {
    validateTransactionShape(transaction);
    if (!rememberGossipId(this.transactionGossipSeen, transaction.txid)) return;
    const fanout = this.nextGossipFanout();
    await Promise.allSettled(fanout.map((peer) => postJson(
      `${peer}/tx`, transaction, 64_000
    )));
  }

  private nextGossipFanout(): string[] {
    const fanout = diversityOrderedPeers(this.peers, this.gossipCursor).slice(0, MAX_GOSSIP_FANOUT);
    const groupCount = Math.max(1, new Set(this.peers.map(peerDiversityBucket)).size);
    this.gossipCursor = (this.gossipCursor + 1) % groupCount;
    return fanout;
  }

  private async recordFailure(peer: string, nowMs: number): Promise<void> {
    const backoffMs = this.peerReputation
      ? await this.peerReputation.recordFailure(peer, nowMs)
      : PEER_FAILURE_BACKOFF_MS;
    this.failureUntil.set(peer, nowMs + backoffMs);
  }
}

function rememberGossipId(cache: Set<string>, id: string): boolean {
  if (cache.has(id)) return false;
  cache.add(id);
  if (cache.size > MAX_GOSSIP_DEDUP_IDS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) cache.delete(oldest);
  }
  return true;
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  if (values.length === 0) return [];
  const start = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

export function peerDiversityBucket(peer: string): string {
  const url = new URL(normalizePeerUrl(peer));
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(hostname) === 4) {
    const octets = hostname.split(".");
    return `ipv4:${octets.slice(0, 3).join(".")}.0/24`;
  }
  if (isIP(hostname) === 6) return `ipv6:${ipv6Prefix64(hostname)}/64`;
  return `host:${hostname}`;
}

export function diversityOrderedPeers(peers: readonly string[], groupOffset = 0): string[] {
  const groups = new Map<string, string[]>();
  for (const peer of peers) {
    const normalized = normalizePeerUrl(peer);
    const key = peerDiversityBucket(normalized);
    const bucket = groups.get(key) ?? [];
    bucket.push(normalized);
    groups.set(key, bucket);
  }
  const rotatedGroups = rotate([...groups.values()], groupOffset);
  const result: string[] = [];
  const rounds = Math.max(0, ...rotatedGroups.map((group) => group.length));
  for (let index = 0; index < rounds; index += 1) {
    for (const group of rotatedGroups) {
      if (group[index]) result.push(group[index]!);
    }
  }
  return result;
}

export function peerSyncProbeBatches(peers: readonly string[], groupOffset = 0): string[][] {
  const ordered = diversityOrderedPeers(peers, groupOffset);
  const batches: string[][] = [];
  for (let index = 0; index < ordered.length; index += MAX_SYNC_PROBE_CONCURRENCY) {
    batches.push(ordered.slice(index, index + MAX_SYNC_PROBE_CONCURRENCY));
  }
  return batches;
}

export async function produceFinalizedBlock(
  service: NodeService,
  peers: ConsensusPeerClient,
  validator: string | ValidatorSigner,
  nowMs = Date.now()
): Promise<Block | null> {
  const chain = service.store.chain;
  const elapsed = nowMs - chain.tip.header.timestampMs;
  if (elapsed < BLOCK_INTERVAL_MS) return null;
  const round = Math.max(0, Math.floor((elapsed - BLOCK_INTERVAL_MS) / ROUND_WINDOW_MS));
  const signer = typeof validator === "string" ? new LocalValidatorSigner(validator) : validator;
  const publicKey = signer.publicKey;
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
      } catch {}
      votes.push(...await peers.requestRoundSkips(chain.height + 1, skippedRound, previousCertificate));
      const unique = new Map<Address, RoundSkipVote>();
      for (const vote of votes) {
        try {
          validateRoundSkipVote(vote, validators, chain.genesis.chainId, chain.height + 1, skippedRound, chain.tip.hash);
          unique.set(vote.validator, vote);
        } catch {}
      }
      const certificate = [...unique.values()];
      try {
        validateRoundSkipQuorum(certificate, validators, chain.genesis.chainId, chain.height + 1, skippedRound, chain.tip.hash);
      } catch {
        return null;
      }
      roundCertificate = certificate;
      previousCertificate = certificate;
    }
  }
  const transactions = chain.selectValidPending(service.mempool.values(), 10_000);
  const unsignedProposal = chain.prepareBlock(transactions, publicKey, { round, timestampMs: nowMs, roundCertificate });
  const proposal = await service.signPreparedProposal(unsignedProposal, nowMs);
  chain.validatePreparedBlock(proposal, nowMs);
  const attestations: BlockAttestation[] = [];
  try {
    attestations.push(await service.attestProposal(proposal, nowMs));
  } catch (error) {
    if (!/Validator signing is disabled/.test(safeError(error))) throw error;
  }
  attestations.push(...await peers.requestAttestations(proposal));
  const byValidator = new Map<Address, BlockAttestation>();
  for (const attestation of attestations) {
    try {
      validateBlockAttestation(proposal, attestation, validators);
      byValidator.set(attestation.validator, attestation);
    } catch {}
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
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
}

async function getJson<T = unknown>(
  url: string,
  maxBytes: number,
  validate: (value: unknown) => T = (value) => value as T
): Promise<T> {
  const response = await fetch(url, {
    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },
    signal: AbortSignal.timeout(PEER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}`);
  return parseBoundedResponse(response, maxBytes, validate);
}

type RetainedPeerResponse<T> = { value: T; release: () => void };

async function getJsonRetained<T>(
  url: string,
  maxBytes: number,
  validate: (value: unknown) => T
): Promise<RetainedPeerResponse<T>> {
  const response = await fetch(url, {
    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },
    signal: AbortSignal.timeout(PEER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}`);
  return parseBoundedResponseRetained(response, maxBytes, validate);
}

async function postJson<T = unknown>(
  url: string,
  value: unknown,
  maxResponseBytes: number,
  peerAuthToken?: string,
  peerRequestCredentials?: PeerRequestCredentials,
  validate: (value: unknown) => T = (responseValue) => responseValue as T
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-zyron-rpc-version": String(RPC_API_VERSION) };
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
  return parseBoundedResponse(response, maxResponseBytes, validate);
}

function assertCompatibleRpcResponse(response: Response): void {
  const advertised = response.headers.get("x-zyron-rpc-version");
  if (advertised === null) {
    throw new Error("Peer response is missing RPC API version");
  }
  if (advertised !== String(RPC_API_VERSION)) {
    throw new Error(`Peer uses unsupported RPC API version ${advertised}`);
  }
}

export function assertBoundedPeerResponseJsonStructure(body: Uint8Array): number {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let tokens = 0;

  for (const byte of body) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (byte === 0x5c) {
        escaped = true;
        continue;
      }
      if (byte === 0x22) inString = false;
      continue;
    }
    if (byte === 0x22) {
      inString = true;
      continue;
    }
    if (byte === 0x7b || byte === 0x5b) {
      depth += 1;
      tokens += 1;
      if (depth > MAX_PEER_RESPONSE_JSON_NESTING_DEPTH) throw new Error("Peer response JSON complexity exceeded");
    } else if (byte === 0x7d || byte === 0x5d) {
      depth = Math.max(0, depth - 1);
      tokens += 1;
    } else if (byte === 0x2c || byte === 0x3a) {
      tokens += 1;
    }
    if (tokens > MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS) {
      throw new Error("Peer response JSON complexity exceeded");
    }
  }
  return tokens;
}

export function parsePeerResponseJsonChunks(
  chunks: readonly Uint8Array[],
  totalBytes: number,
  parseBudget: PeerResponseByteBudget
): { value: unknown; release: () => void } {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) throw new Error("Invalid peer response JSON parse size");
  const releaseTransient = parseBudget.reserve(totalBytes * 3);
  let releaseDecoded: (() => void) | undefined;
  try {
    const body = Buffer.concat(chunks, totalBytes);
    const structuralTokens = assertBoundedPeerResponseJsonStructure(body);
    const decodedBytes = (totalBytes * 2) + (structuralTokens * PEER_RESPONSE_JSON_NODE_ESTIMATE_BYTES);
    releaseDecoded = parseBudget.reserve(decodedBytes);
    const value = JSON.parse(body.toString("utf8")) as unknown;
    const retainedRelease = releaseDecoded;
    releaseDecoded = undefined;
    return { value, release: retainedRelease };
  } finally {
    releaseDecoded?.();
    releaseTransient();
  }
}

async function parseBoundedResponseRetained<T>(
  response: Response,
  maxBytes: number,
  validate: (value: unknown) => T
): Promise<RetainedPeerResponse<T>> {
  const contentType = response.headers.get("content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await response.body?.cancel();
    throw new Error("Peer response must use application/json");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      await response.body?.cancel();
      throw new Error("Peer response has invalid Content-Length");
    }
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await response.body?.cancel();
      throw new Error("Peer response too large");
    }
  }
  assertCompatibleRpcResponse(response);
  if (!response.body) throw new Error("Peer returned empty body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const releases: Array<() => void> = [];
  let releaseDecoded: (() => void) | undefined;
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Peer response too large");
      }
      try {
        releases.push(peerResponseByteBudget.reserve(value.byteLength));
      } catch (error) {
        await reader.cancel();
        throw error;
      }
      chunks.push(value);
    }
    if (total === 0) throw new Error("Peer returned empty body");
    const parsed = parsePeerResponseJsonChunks(chunks, total, peerResponseParseByteBudget);
    releaseDecoded = parsed.release;
    const value = validate(parsed.value);
    const retainedRelease = releaseDecoded;
    releaseDecoded = undefined;
    let released = false;
    return {
      value,
      release: () => {
        if (released) return;
        released = true;
        retainedRelease();
      }
    };
  } finally {
    releaseDecoded?.();
    for (const release of releases) release();
  }
}

async function parseBoundedResponse<T>(
  response: Response,
  maxBytes: number,
  validate: (value: unknown) => T
): Promise<T> {
  const retained = await parseBoundedResponseRetained(response, maxBytes, validate);
  try {
    return retained.value;
  } finally {
    retained.release();
  }
}

export function assertBoundedRpcJsonStructure(body: Uint8Array): void {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let tokens = 0;

  for (const byte of body) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (byte === 0x5c) {
        escaped = true;
        continue;
      }
      if (byte === 0x22) inString = false;
      continue;
    }

    if (byte === 0x22) {
      inString = true;
      continue;
    }

    if (byte === 0x7b || byte === 0x5b) {
      depth += 1;
      tokens += 1;
      if (depth > MAX_RPC_JSON_NESTING_DEPTH) throw new Error("RPC request JSON complexity exceeded");
    } else if (byte === 0x7d || byte === 0x5d) {
      depth = Math.max(0, depth - 1);
      tokens += 1;
    } else if (byte === 0x2c || byte === 0x3a) {
      tokens += 1;
    }

    if (tokens > MAX_RPC_JSON_STRUCTURAL_TOKENS) throw new Error("RPC request JSON complexity exceeded");
  }
}

export function parseRpcJsonChunks(
  chunks: readonly Buffer[],
  totalBytes: number,
  reservation?: RpcRequestBodyReservation
): unknown {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_BODY_BYTES) {
    throw new Error("Invalid RPC JSON parse size");
  }
  // The received chunk bytes are already retained by the request lifecycle.
  // Before allocating another contiguous Buffer plus the transient JavaScript
  // UTF-8 string, conservatively reserve 1x + 2x the wire bytes from the same
  // aggregate budget. The decoded graph is separately bounded by the lexical
  // depth/cardinality scan below.
  const transientBytes = totalBytes * 3;
  const releaseTransient = reservation?.reserveTransient(transientBytes);
  try {
    const body = Buffer.concat(chunks, totalBytes);
    assertBoundedRpcJsonStructure(body);
    return JSON.parse(body.toString("utf8")) as unknown;
  } finally {
    releaseTransient?.();
  }
}

async function readJsonBody(request: IncomingMessage, bodyReservation?: RpcRequestBodyReservation): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new Error("Content-Type must be application/json");
  }
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) throw new Error("Invalid Content-Length");
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_BODY_BYTES) throw new Error("Request body too large");
    if (declaredBytes > 0) bodyReservation?.reserve(declaredBytes);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length === 0) continue;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    if (declaredLength === undefined) bodyReservation?.reserve(buffer.length);
    chunks.push(buffer);
  }
  if (total === 0) throw new Error("Request body is empty");
  return parseRpcJsonChunks(chunks, total, bodyReservation);
}

const RPC_RESPONSE_OVERLOAD_BODY = '{"error":"Aggregate RPC response byte budget exceeded"}';

function writeRpcResponseOverload(response: ServerResponse): void {
  if (response.headersSent) return;
  response.setHeader("retry-after", "1");
  response.setHeader("connection", "close");
  response.writeHead(503, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(RPC_RESPONSE_OVERLOAD_BODY),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-zyron-rpc-version": String(RPC_API_VERSION)
  });
  response.end(RPC_RESPONSE_OVERLOAD_BODY);
}

export function serializeRpcJsonWithBudget(
  value: unknown,
  budget: RpcResponseByteBudget,
  serializationUpperBoundBytes = MAX_SMALL_RPC_RESPONSE_SERIALIZATION_BYTES
): { body: string; bodyBytes: number; release: () => void } {
  const allowance = Math.min(serializationUpperBoundBytes, budget.maxBytes);
  const reservation = budget.reserveForSerialization(allowance);
  try {
    const body = JSON.stringify(value);
    if (body === undefined) throw new Error("RPC response is not JSON serializable");
    const bodyBytes = Buffer.byteLength(body);
    if (bodyBytes > allowance) {
      throw new RpcResponseBudgetError("RPC response exceeded pre-serialization byte allowance");
    }
    const release = reservation.commit(bodyBytes);
    return { body, bodyBytes, release };
  } catch (error) {
    reservation.release();
    throw error;
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  serializationUpperBoundBytes = MAX_SMALL_RPC_RESPONSE_SERIALIZATION_BYTES
): void {
  if (response.headersSent) return;
  const budget = rpcResponseBudgets.get(response);
  let body: string;
  let bodyBytes: number;
  let release: (() => void) | undefined;
  try {
    if (budget) {
      ({ body, bodyBytes, release } = serializeRpcJsonWithBudget(value, budget, serializationUpperBoundBytes));
    } else {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("RPC response is not JSON serializable");
      body = serialized;
      bodyBytes = Buffer.byteLength(body);
    }
  } catch (error) {
    if (error instanceof RpcResponseBudgetError) {
      writeRpcResponseOverload(response);
      return;
    }
    throw error;
  }
  if (release) {
    response.once("finish", release);
    response.once("close", release);
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bodyBytes,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-zyron-rpc-version": String(RPC_API_VERSION)
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
class PeerInflightLimitError extends Error {}
class RpcBodyBudgetError extends Error {}

function preauthorizeConsensusRequest(
  request: IncomingMessage,
  path: string,
  peerAuthToken?: string,
  peerRequestAuthenticator?: PeerRequestAuthenticator
): void {
  if (peerRequestAuthenticator) {
    try {
      peerRequestAuthenticator.preflight(request.headers, { method: request.method ?? "", path });
      return;
    } catch {
      throw new PeerAuthenticationError("Peer signature authentication required");
    }
  }
  if (peerAuthToken && !validBearerToken(request.headers.authorization, peerAuthToken)) {
    throw new PeerAuthenticationError("Peer authentication required");
  }
}

function authorizeConsensusRequest(
  request: IncomingMessage,
  path: string,
  body: unknown,
  peerAuthToken?: string,
  peerRequestAuthenticator?: PeerRequestAuthenticator
): string {
  if (peerRequestAuthenticator) {
    try {
      return peerRequestAuthenticator.verify(request.headers, {
        method: request.method ?? "",
        path,
        bodySha256: sha256Hex(Buffer.from(canonicalJson(body), "utf8"))
      });
    } catch {
      throw new PeerAuthenticationError("Peer signature authentication required");
    }
  }
  if (peerAuthToken && !validBearerToken(request.headers.authorization, peerAuthToken)) {
    throw new PeerAuthenticationError("Peer authentication required");
  }
  return `transport:${request.socket.remoteAddress ?? "unknown"}`;
}

function enterConsensusRequest(
  request: IncomingMessage,
  path: string,
  body: unknown,
  peerAuthToken: string | undefined,
  peerRequestAuthenticator: PeerRequestAuthenticator | undefined,
  limiter: PeerInflightLimiter | undefined
): () => void {
  const identity = authorizeConsensusRequest(request, path, body, peerAuthToken, peerRequestAuthenticator);
  return limiter?.enter(identity) ?? (() => {});
}

export class PeerInflightLimiter {
  private readonly inflight = new Map<string, number>();

  constructor(private readonly limit: number) {
    boundedPositiveInteger(limit, "consensus inflight per peer");
  }

  enter(identity: string): () => void {
    const count = this.inflight.get(identity) ?? 0;
    if (count >= this.limit) throw new PeerInflightLimitError("Consensus peer concurrency limit exceeded");
    this.inflight.set(identity, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.inflight.get(identity) ?? 0;
      if (current <= 1) this.inflight.delete(identity);
      else this.inflight.set(identity, current - 1);
    };
  }
}

class RpcAdmissionController {
  private inflightRequests = 0;
  private rejectedRequests = 0;

  constructor(private readonly maxInflightRequests: number) {
    boundedPositiveInteger(maxInflightRequests, "global RPC inflight requests");
  }

  enter(): () => void {
    if (this.inflightRequests >= this.maxInflightRequests) {
      this.rejectedRequests += 1;
      throw new PeerInflightLimitError("RPC concurrency limit exceeded");
    }
    this.inflightRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflightRequests -= 1;
    };
  }

  metrics(): RpcAdmissionMetrics {
    return { inflightRequests: this.inflightRequests, maxInflightRequests: this.maxInflightRequests, rejectedRequests: this.rejectedRequests };
  }
}

export class RpcRequestBodyByteBudget {
  private reservedBytes = 0;
  private rejectedReservations = 0;

  constructor(readonly maxBytes: number) {
    boundedPositiveInteger(maxBytes, "RPC in-flight request body bytes");
  }

  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Invalid RPC request body reservation");
    if (bytes > this.maxBytes - this.reservedBytes) {
      this.rejectedReservations += 1;
      throw new RpcBodyBudgetError("Aggregate RPC request body byte budget exceeded");
    }
    this.reservedBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedBytes -= bytes;
    };
  }

  metrics(): Pick<RpcByteBudgetMetrics, "requestBodyBytesInUse" | "maxRequestBodyBytes" | "rejectedRequestBodies"> {
    return { requestBodyBytesInUse: this.reservedBytes, maxRequestBodyBytes: this.maxBytes, rejectedRequestBodies: this.rejectedReservations };
  }
}

export class RpcResponseBudgetError extends Error {}

interface RpcResponseSerializationReservation {
  commit(actualBytes: number): () => void;
  release(): void;
}

export class RpcResponseByteBudget {
  private reservedBytes = 0;
  private rejectedReservations = 0;

  constructor(readonly maxBytes: number) {
    boundedPositiveInteger(maxBytes, "RPC in-flight response bytes");
  }

  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.maxBytes - this.reservedBytes) {
      this.rejectedReservations += 1;
      throw new RpcResponseBudgetError("Aggregate RPC response byte budget exceeded");
    }
    this.reservedBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedBytes -= bytes;
    };
  }

  reserveForSerialization(maxBytes: number): RpcResponseSerializationReservation {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxBytes - this.reservedBytes) {
      this.rejectedReservations += 1;
      throw new RpcResponseBudgetError("Aggregate RPC response byte budget exceeded");
    }
    this.reservedBytes += maxBytes;
    let heldBytes = maxBytes;
    let committed = false;
    return {
      commit: (actualBytes: number): (() => void) => {
        if (committed || heldBytes === 0) throw new Error("RPC response serialization reservation already committed");
        if (!Number.isSafeInteger(actualBytes) || actualBytes < 1 || actualBytes > heldBytes) {
          this.rejectedReservations += 1;
          throw new RpcResponseBudgetError("RPC response exceeded pre-serialization byte allowance");
        }
        committed = true;
        this.reservedBytes -= heldBytes - actualBytes;
        heldBytes = actualBytes;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.reservedBytes -= heldBytes;
          heldBytes = 0;
        };
      },
      release: (): void => {
        if (heldBytes === 0) return;
        this.reservedBytes -= heldBytes;
        heldBytes = 0;
      }
    };
  }

  metrics(): Pick<RpcByteBudgetMetrics, "responseBytesInUse" | "maxResponseBytes" | "rejectedResponses"> {
    return { responseBytesInUse: this.reservedBytes, maxResponseBytes: this.maxBytes, rejectedResponses: this.rejectedReservations };
  }
}

const rpcResponseBudgets = new WeakMap<ServerResponse, RpcResponseByteBudget>();

export class RpcRequestBodyReservation {
  private readonly releases: Array<() => void> = [];
  private released = false;

  constructor(private readonly budget: RpcRequestBodyByteBudget) {}

  reserve(bytes: number): void {
    if (this.released) throw new Error("RPC request body reservation already released");
    this.releases.push(this.budget.reserve(bytes));
  }

  reserveTransient(bytes: number): () => void {
    if (this.released) throw new Error("RPC request body reservation already released");
    return this.budget.reserve(bytes);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const release of this.releases) release();
  }

  metrics(): Pick<RpcByteBudgetMetrics, "requestBodyBytesInUse" | "maxRequestBodyBytes" | "rejectedRequestBodies"> {
    return this.budget.metrics();
  }
}

export class PeerResponseByteBudget {
  private reservedBytes = 0;

  constructor(readonly maxBytes: number) {
    boundedPositiveInteger(maxBytes, "peer response in-flight bytes");
  }

  get inUseBytes(): number {
    return this.reservedBytes;
  }

  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Invalid peer response byte reservation");
    if (bytes > this.maxBytes - this.reservedBytes) throw new Error("Aggregate peer response byte budget exceeded");
    this.reservedBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedBytes -= bytes;
    };
  }
}

const peerResponseByteBudget = new PeerResponseByteBudget(MAX_PEER_RESPONSE_BYTES_INFLIGHT);
const peerResponseParseByteBudget = new PeerResponseByteBudget(MAX_PEER_RESPONSE_PARSE_BYTES_INFLIGHT);

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
