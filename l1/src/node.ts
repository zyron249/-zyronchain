export * from "./node-base.js";

import {
  BLOCK_INTERVAL_MS,
  ROUND_WINDOW_MS,
  NodeService,
  PeerClient as BasePeerClient,
  PeerResponseByteBudget,
  RPC_API_VERSION,
  assertPeerHttpSuccess,
  cancelPeerResponseBody,
  parsePeerResponseJsonChunks,
  type ConsensusPeerClient,
  type PeerRequestCredentials
} from "./node-base.js";
import {
  expectedValidator,
  validateBlockAttestation,
  validateRoundSkipQuorum,
  validateRoundSkipVote
} from "./block.js";
import { assertHex, canonicalJson, sha256Hex } from "./codec.js";
import { addressFromPublicKey } from "./crypto.js";
import type { PeerReputationStore } from "./peer-reputation.js";
import { signPeerRequest } from "./peer-identity.js";
import { assertExactKeys, assertPlainRecord } from "./transaction.js";
import type { Address, Block, BlockAttestation, RoundSkipVote } from "./types.js";
import { LocalValidatorSigner, type ValidatorSigner } from "./validator-signer.js";

const HTTP_CONSENSUS_TIMEOUT_MS = 8_000;
export const MAX_HTTP_CONSENSUS_OUTBOUND_CONCURRENCY = 8;
export const MAX_HTTP_ATTESTATION_RESPONSE_BYTES = 8_192;
export const MAX_HTTP_ROUND_SKIP_RESPONSE_BYTES = 16_384;
export const MAX_CONSENSUS_ROUND_CATCHUP = 64;
const MAX_HTTP_CONSENSUS_WIRE_BYTES_INFLIGHT = 16_000_000;
const MAX_HTTP_CONSENSUS_PARSE_BYTES_INFLIGHT = 64_000_000;
const MAX_HTTP_CONSENSUS_CHAIN_ID_LENGTH = 128;
const httpConsensusWireBudget = new PeerResponseByteBudget(MAX_HTTP_CONSENSUS_WIRE_BYTES_INFLIGHT);
const httpConsensusParseBudget = new PeerResponseByteBudget(MAX_HTTP_CONSENSUS_PARSE_BYTES_INFLIGHT);

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelHttpConsensusReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    const cancellation = reader.cancel();
    void cancellation.catch(() => undefined);
  } catch {
  }
}

export function validateHttpPeerAttestationShape(value: unknown): BlockAttestation {
  assertPlainRecord(value, "HTTP peer attestation");
  assertExactKeys(value, ["validator", "publicKey", "signature"], "HTTP peer attestation");
  if (typeof value.validator !== "string" || typeof value.publicKey !== "string" || typeof value.signature !== "string") {
    throw new Error("Invalid HTTP peer attestation");
  }
  assertHex(value.publicKey, 64, "HTTP peer attestation public key");
  assertHex(value.signature, 64, "HTTP peer attestation signature");
  if (value.validator !== addressFromPublicKey(value.publicKey)) {
    throw new Error("Invalid HTTP peer attestation validator");
  }
  return value as unknown as BlockAttestation;
}

export function validateHttpPeerRoundSkipVoteShape(value: unknown): RoundSkipVote {
  assertPlainRecord(value, "HTTP peer round skip vote");
  assertExactKeys(
    value,
    ["validator", "publicKey", "chainId", "height", "round", "previousHash", "signature"],
    "HTTP peer round skip vote"
  );
  if (typeof value.validator !== "string" || typeof value.publicKey !== "string" || typeof value.signature !== "string" ||
      typeof value.chainId !== "string" || value.chainId.length < 1 || value.chainId.length > MAX_HTTP_CONSENSUS_CHAIN_ID_LENGTH ||
      !Number.isSafeInteger(value.height) || Number(value.height) < 1 ||
      !Number.isSafeInteger(value.round) || Number(value.round) < 0 || typeof value.previousHash !== "string") {
    throw new Error("Invalid HTTP peer round skip vote");
  }
  assertHex(value.publicKey, 64, "HTTP peer round skip public key");
  assertHex(value.signature, 64, "HTTP peer round skip signature");
  assertHex(value.previousHash, 32, "HTTP peer round skip previous hash");
  if (value.validator !== addressFromPublicKey(value.publicKey)) {
    throw new Error("Invalid HTTP peer round skip validator");
  }
  return value as unknown as RoundSkipVote;
}

async function parseHttpConsensusResponse<T>(
  response: Response,
  maxBytes: number,
  validate: (value: unknown) => T
): Promise<T> {
  const contentType = response.headers.get("content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await cancelPeerResponseBody(response);
    throw new Error("Peer response must use application/json");
  }
  const advertised = response.headers.get("x-zyron-rpc-version");
  if (advertised === null) {
    await cancelPeerResponseBody(response);
    throw new Error("Peer response is missing RPC API version");
  }
  if (advertised !== String(RPC_API_VERSION)) {
    await cancelPeerResponseBody(response);
    throw new Error(`Peer uses unsupported RPC API version ${advertised}`);
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      await cancelPeerResponseBody(response);
      throw new Error("Peer response has invalid Content-Length");
    }
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await cancelPeerResponseBody(response);
      throw new Error("Peer response too large");
    }
  }
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
        cancelHttpConsensusReader(reader);
        throw new Error("Peer response too large");
      }
      try {
        releases.push(httpConsensusWireBudget.reserve(value.byteLength));
      } catch (error) {
        cancelHttpConsensusReader(reader);
        throw error;
      }
      chunks.push(value);
    }
    if (total === 0) throw new Error("Peer returned empty body");
    const parsed = parsePeerResponseJsonChunks(chunks, total, httpConsensusParseBudget);
    releaseDecoded = parsed.release;
    return validate(parsed.value);
  } finally {
    releaseDecoded?.();
    for (const release of releases) release();
  }
}

async function postHttpConsensusJson<T>(
  url: string,
  value: unknown,
  maxResponseBytes: number,
  peerAuthToken: string | undefined,
  peerRequestCredentials: PeerRequestCredentials | undefined,
  validate: (value: unknown) => T,
  signal: AbortSignal
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-zyron-rpc-version": String(RPC_API_VERSION)
  };
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
    signal
  });
  await assertPeerHttpSuccess(response);
  return parseHttpConsensusResponse(response, maxResponseBytes, validate);
}

export async function collectHttpConsensusPeers<T>(
  peers: readonly string[],
  request: (peer: string, signal: AbortSignal) => Promise<T>,
  deadlineMs = HTTP_CONSENSUS_TIMEOUT_MS,
  concurrency = MAX_HTTP_CONSENSUS_OUTBOUND_CONCURRENCY
): Promise<T[]> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new Error("Invalid HTTP consensus deadline");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Invalid HTTP consensus concurrency");
  const controller = new AbortController();
  let resolveDeadline!: () => void;
  const deadlineReached = new Promise<void>((resolve) => { resolveDeadline = resolve; });
  const timer = setTimeout(() => {
    controller.abort(new Error("HTTP consensus collection deadline exceeded"));
    resolveDeadline();
  }, deadlineMs);
  timer.unref?.();
  let next = 0;
  const results: T[] = [];
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = next;
      if (index >= peers.length) return;
      next += 1;
      try {
        const value = await request(peers[index]!, controller.signal);
        if (!controller.signal.aborted) results.push(value);
      } catch {
      }
    }
  };
  try {
    const workerCount = Math.min(peers.length, concurrency);
    const workersDone = Promise.all(Array.from({ length: workerCount }, () => worker()));
    await Promise.race([workersDone, deadlineReached]);
    if (controller.signal.aborted) void workersDone.catch(() => undefined);
    return [...results];
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

export class PeerClient extends BasePeerClient {
  constructor(
    peers: string[],
    private readonly consensusPeerAuthToken?: string,
    private readonly consensusPeerRequestCredentials?: PeerRequestCredentials,
    peerReputation?: PeerReputationStore
  ) {
    super(peers, consensusPeerAuthToken, consensusPeerRequestCredentials, peerReputation);
  }

  override async requestAttestations(block: Block): Promise<BlockAttestation[]> {
    return collectHttpConsensusPeers(this.peers, async (peer, signal) => {
      return postHttpConsensusJson(
        `${peer}/proposal/attest`,
        block,
        MAX_HTTP_ATTESTATION_RESPONSE_BYTES,
        this.consensusPeerAuthToken,
        this.consensusPeerRequestCredentials,
        (payload) => {
          assertPlainRecord(payload, "attestation response");
          assertExactKeys(payload, ["attestation"], "attestation response");
          return validateHttpPeerAttestationShape(payload.attestation);
        },
        signal
      );
    });
  }

  override async requestRoundSkips(
    height: number,
    round: number,
    previousCertificate: RoundSkipVote[] = []
  ): Promise<RoundSkipVote[]> {
    return collectHttpConsensusPeers(this.peers, async (peer, signal) => {
      return postHttpConsensusJson(
        `${peer}/round/skip`,
        { height, round, previousCertificate },
        MAX_HTTP_ROUND_SKIP_RESPONSE_BYTES,
        this.consensusPeerAuthToken,
        this.consensusPeerRequestCredentials,
        (payload) => {
          assertPlainRecord(payload, "round skip response");
          assertExactKeys(payload, ["vote"], "round skip response");
          return validateHttpPeerRoundSkipVoteShape(payload.vote);
        },
        signal
      );
    });
  }
}

/**
 * Production-safe block production clock handling.
 *
 * The block/round decision is anchored to one consensus timestamp so the
 * proposal timestamp cannot drift while peer I/O is in flight. Local signing
 * operations, however, use a fresh wall-clock sample in production. This
 * prevents a concurrent inbound signing request from advancing the same
 * NodeService clock watermark and making an older captured proposal timestamp
 * look like a physical clock rollback.
 *
 * Round catch-up is explicitly bounded before any skip-vote signing or peer
 * request. A clock fault or stale tip that derives a larger round fails closed;
 * the validator never clamps to a different round/proposer.
 *
 * Tests that explicitly inject `nowMs` retain deterministic fixed-clock
 * behavior inside the supported catch-up window.
 */
export async function produceFinalizedBlock(
  service: NodeService,
  peers: ConsensusPeerClient,
  validator: string | ValidatorSigner,
  nowMs?: number
): Promise<Block | null> {
  const fixedClock = nowMs !== undefined;
  const consensusNowMs = nowMs ?? Date.now();
  const signingNowMs = (): number => fixedClock ? consensusNowMs : Date.now();
  const chain = service.store.chain;
  const elapsed = consensusNowMs - chain.tip.header.timestampMs;
  if (elapsed < BLOCK_INTERVAL_MS) return null;
  const round = Math.max(0, Math.floor((elapsed - BLOCK_INTERVAL_MS) / ROUND_WINDOW_MS));
  if (!Number.isSafeInteger(round) || round > MAX_CONSENSUS_ROUND_CATCHUP) return null;
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
        votes.push(await service.requestSkipVote(
          chain.height + 1,
          skippedRound,
          previousCertificate,
          signingNowMs()
        ));
      } catch {
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
  const unsignedProposal = chain.prepareBlock(transactions, publicKey, {
    round,
    timestampMs: consensusNowMs,
    roundCertificate
  });
  const proposal = await service.signPreparedProposal(unsignedProposal, signingNowMs());
  chain.validatePreparedBlock(proposal, consensusNowMs);

  const attestations: BlockAttestation[] = [];
  try {
    attestations.push(await service.attestProposal(proposal, signingNowMs()));
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
