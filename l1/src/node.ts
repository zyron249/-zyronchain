import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  createBlockAttestation,
  createRoundSkipVote,
  expectedValidator,
  validateBlockShape,
  validateRoundSkipQuorum
} from "./block.js";
import { publicKeyFromPrivate } from "./crypto.js";
import { Mempool } from "./mempool.js";
import { ChainStore, SigningJournal } from "./storage.js";
import { assertAddress, assertExactKeys, assertPlainRecord, validateTransactionShape } from "./transaction.js";
import type { Address, Block, BlockAttestation, RoundSkipVote, Transaction } from "./types.js";

const MAX_BODY_BYTES = 2_500_000;
const MAX_SYNC_BLOCKS = 100;
const MAX_SYNC_RESPONSE_BYTES = 25_000_000;
const PEER_TIMEOUT_MS = 8_000;
export const BLOCK_INTERVAL_MS = 30_000;
export const ROUND_WINDOW_MS = 30_000;

export interface NodeStatus {
  chainId: string;
  genesisHash: string;
  height: number;
  tipHash: string;
}

export class NodeService {
  readonly mempool = new Mempool();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly store: ChainStore,
    private readonly signingJournal?: SigningJournal,
    private readonly validatorPrivateKey?: string
  ) {}

  status(): NodeStatus {
    const blocks = this.store.chain.getBlocks();
    return {
      chainId: this.store.chain.genesis.chainId,
      genesisHash: blocks[0]!.hash,
      height: this.store.chain.height,
      tipHash: this.store.chain.tip.hash
    };
  }

  blocks(from: number, limit: number): Block[] {
    if (!Number.isSafeInteger(from) || from < 1) throw new Error("Invalid block start height");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_BLOCKS) throw new Error("Invalid block limit");
    return this.store.chain.getBlocks().slice(from, from + limit).map((block) => structuredClone(block));
  }

  balance(address: string): number {
    assertAddress(address);
    return this.store.chain.getState().balance(address);
  }

  nonce(address: string): number {
    assertAddress(address);
    return this.store.chain.getState().nonce(address);
  }

  submitTransaction(value: unknown): string {
    validateTransactionShape(value);
    const tx = value as Transaction;
    if (tx.chainId !== this.store.chain.genesis.chainId) throw new Error("Wrong transaction chain ID");
    const stateNonce = this.store.chain.getState().nonce(tx.sender);
    if (tx.nonce <= stateNonce || tx.nonce > stateNonce + 64) throw new Error("Transaction nonce outside mempool window");
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
      const validator = this.store.chain.genesis.validators.find((item) => item.publicKey === publicKey);
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
        validateRoundSkipQuorum(
          previousCertificate,
          chain.genesis.validators,
          chain.genesis.chainId,
          height,
          round - 1,
          chain.tip.hash
        );
      }
      const publicKey = publicKeyFromPrivate(this.validatorPrivateKey);
      if (!chain.genesis.validators.some((validator) => validator.publicKey === publicKey)) {
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
      this.store.chain.acceptBlock(block);
      await this.store.appendFinalizedBlock(block);
      this.mempool.remove(block.transactions.map((tx) => tx.txid));
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

export function createRpcServer(service: NodeService): Server {
  return createServer(async (request, response) => {
    try {
      await route(service, request, response);
    } catch (error) {
      writeJson(response, 400, { error: safeError(error) });
    }
  });
}

async function route(service: NodeService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://node.invalid");
  if (request.method === "GET" && url.pathname === "/status") {
    return writeJson(response, 200, service.status());
  }
  if (request.method === "GET" && url.pathname === "/blocks") {
    const from = parseInteger(url.searchParams.get("from"), "from");
    const limit = url.searchParams.has("limit") ? parseInteger(url.searchParams.get("limit"), "limit") : MAX_SYNC_BLOCKS;
    return writeJson(response, 200, { blocks: service.blocks(from, limit) });
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
    return writeJson(response, 200, { attestation: await service.attestProposal(await readJsonBody(request)) });
  }
  if (request.method === "POST" && url.pathname === "/round/skip") {
    const body = await readJsonBody(request);
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
    await service.acceptFinalizedBlock(await readJsonBody(request));
    return writeJson(response, 202, { accepted: true, height: service.status().height });
  }
  writeJson(response, 404, { error: "Not found" });
}

export class PeerClient {
  readonly peers: string[];

  constructor(peers: string[]) {
    this.peers = [...new Set(peers.map(normalizePeerUrl))];
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

  async requestAttestations(block: Block): Promise<BlockAttestation[]> {
    const results = await Promise.allSettled(this.peers.map(async (peer) => {
      const payload = await postJson(`${peer}/proposal/attest`, block, MAX_BODY_BYTES);
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
      const payload = await postJson(`${peer}/round/skip`, { height, round, previousCertificate }, 128_000);
      assertPlainRecord(payload, "round skip response");
      assertExactKeys(payload, ["vote"], "round skip response");
      return payload.vote as RoundSkipVote;
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  async broadcastBlock(block: Block): Promise<void> {
    await Promise.allSettled(this.peers.map((peer) => postJson(`${peer}/block`, block, 64_000)));
  }
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
  const expected = expectedValidator(chain.genesis.validators, chain.height + 1, round);
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
      for (const vote of votes) unique.set(vote.validator, vote);
      const certificate = [...unique.values()];
      try {
        validateRoundSkipQuorum(
          certificate,
          chain.genesis.validators,
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
  for (const attestation of attestations) byValidator.set(attestation.validator, attestation);
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

function normalizePeerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Peer URL must use HTTP(S)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Peer URL contains forbidden components");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

async function getJson(url: string, maxBytes: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}`);
  return parseBoundedResponse(response, maxBytes);
}

async function postJson(url: string, value: unknown, maxResponseBytes: number): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
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

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
