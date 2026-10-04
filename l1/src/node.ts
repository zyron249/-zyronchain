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
  blockHash,
  expectedValidator,
  validateBlockAttestation,
  validateBlockShape,
  validateRoundSkipQuorum,
  validateRoundSkipVote,
  validatorQuorumSize
} from "./block.js";
import {
  CONSENSUS_V6_PROTOCOL_VERSION,
  assertV6ProposalBlockIntegrity,
  V6_COMMIT_VOTE_DOMAIN,
  V6_PREPARE_VOTE_DOMAIN,
  V6_TIMEOUT_GUARD_MS,
  clockRound,
  isConsensusV6,
  maxQC,
  validateTimeoutCertificate,
  validateTimeoutResponse,
  validateTimeoutResponseShape,
  validateV6Vote,
  validateV6VoteShape,
  type PrepareQC,
  type TimeoutCertificate,
  type V6CommitRequest,
  type V6PrepareRequest,
  type V6TimeoutResponse,
  type V6Vote
} from "./consensus-v6.js";
import { assertHex, canonicalJson, sha256Hex } from "./codec.js";
import { ConsensusOperationBudget } from "./consensus-operation-budget.js";
import { addressFromPublicKey } from "./crypto.js";
import type { PeerReputationStore } from "./peer-reputation.js";
import { signPeerRequest } from "./peer-identity.js";
import { assertExactKeys, assertPlainRecord } from "./transaction.js";
import type { Address, Block, BlockAttestation, RoundSkipVote, Validator } from "./types.js";
import { LocalValidatorSigner, type ValidatorSigner } from "./validator-signer.js";

const HTTP_CONSENSUS_TIMEOUT_MS = 8_000;
export const MAX_HTTP_CONSENSUS_OUTBOUND_CONCURRENCY = 8;
export const MAX_HTTP_CONSENSUS_OUTSTANDING = 32;
export const MAX_HTTP_ATTESTATION_RESPONSE_BYTES = 8_192;
export const MAX_HTTP_ROUND_SKIP_RESPONSE_BYTES = 16_384;
export const MAX_CONSENSUS_ROUND_CATCHUP = 64;
export const MAX_HTTP_V6_VOTE_RESPONSE_BYTES = 8_192;
export const MAX_HTTP_V6_TIMEOUT_RESPONSE_BYTES = 128_000;
export const MAX_HTTP_V6_BLOCK_RESPONSE_BYTES = 2_600_000;
const MAX_HTTP_CONSENSUS_WIRE_BYTES_INFLIGHT = 16_000_000;
const MAX_HTTP_CONSENSUS_PARSE_BYTES_INFLIGHT = 64_000_000;
const MAX_HTTP_CONSENSUS_CHAIN_ID_LENGTH = 128;
const httpConsensusWireBudget = new PeerResponseByteBudget(MAX_HTTP_CONSENSUS_WIRE_BYTES_INFLIGHT);
const httpConsensusParseBudget = new PeerResponseByteBudget(MAX_HTTP_CONSENSUS_PARSE_BYTES_INFLIGHT);
const httpConsensusOperationBudget = new ConsensusOperationBudget(MAX_HTTP_CONSENSUS_OUTSTANDING, "HTTP consensus");

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
      const releaseOperation = httpConsensusOperationBudget.tryAcquire();
      if (!releaseOperation) continue;
      try {
        const value = await request(peers[index]!, controller.signal);
        if (!controller.signal.aborted) results.push(value);
      } catch {
      } finally {
        releaseOperation();
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

  // Protocol v6 (F-01) consensus requests. Responses are shape-checked here
  // and fully verified (membership, signatures, QCs) by the leader.
  async requestV6Prepare(request: V6PrepareRequest): Promise<V6Vote[]> {
    return this.postV6Votes("/v6/prepare", request);
  }

  async requestV6Commit(request: V6CommitRequest): Promise<V6Vote[]> {
    return this.postV6Votes("/v6/commit", request);
  }

  async requestV6Timeouts(height: number, round: number): Promise<V6TimeoutResponse[]> {
    return collectHttpConsensusPeers(this.peers, async (peer, signal) => postHttpConsensusJson(
      `${peer}/v6/timeout`,
      { height, round },
      MAX_HTTP_V6_TIMEOUT_RESPONSE_BYTES,
      this.consensusPeerAuthToken,
      this.consensusPeerRequestCredentials,
      (payload) => {
        validateTimeoutResponseShape(payload);
        return payload;
      },
      signal
    ));
  }

  async fetchV6Block(height: number, hash: string): Promise<Block | null> {
    for (const peer of this.peers) {
      try {
        const block = await postHttpConsensusJson(
          `${peer}/v6/block`,
          { height, blockHash: hash },
          MAX_HTTP_V6_BLOCK_RESPONSE_BYTES,
          this.consensusPeerAuthToken,
          this.consensusPeerRequestCredentials,
          (payload) => {
            assertPlainRecord(payload, "v6 block response");
            assertExactKeys(payload, ["block"], "v6 block response");
            return payload.block === null ? null : validateFetchedV6Block(payload.block, height, hash);
          },
          AbortSignal.timeout(HTTP_CONSENSUS_TIMEOUT_MS)
        );
        if (block) return block;
      } catch {
      }
    }
    return null;
  }

  private async postV6Votes(path: string, request: unknown): Promise<V6Vote[]> {
    return collectHttpConsensusPeers(this.peers, async (peer, signal) => postHttpConsensusJson(
      `${peer}${path}`,
      request,
      MAX_HTTP_V6_VOTE_RESPONSE_BYTES,
      this.consensusPeerAuthToken,
      this.consensusPeerRequestCredentials,
      (payload) => {
        assertPlainRecord(payload, "v6 vote response");
        assertExactKeys(payload, ["vote"], "v6 vote response");
        validateV6VoteShape(payload.vote);
        return payload.vote;
      },
      signal
    ));
  }
}

/** Shape, hash, target and body/signature integrity of a block fetched by hash for a v6 re-proposal. */
export function validateFetchedV6Block(value: unknown, height: number, hash: string): Block {
  validateBlockShape(value);
  if (value.hash !== hash || blockHash(value.header) !== hash || value.header.height !== height ||
      value.header.version !== CONSENSUS_V6_PROTOCOL_VERSION) {
    throw new Error("Fetched v6 block does not match the requested hash");
  }
  assertV6ProposalBlockIntegrity(value, height, hash);
  return value;
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
  // Protocol v6 heights use the locked two-phase protocol (F-01); every
  // other version continues below exactly as before.
  if (isConsensusV6(chain.protocolVersionAt(chain.height + 1))) {
    const v6Signer = typeof validator === "string" ? new LocalValidatorSigner(validator) : validator;
    return produceFinalizedBlockV6(service, peers, v6Signer, consensusNowMs, signingNowMs);
  }
  const elapsed = consensusNowMs - chain.tip.header.timestampMs;
  if (elapsed < BLOCK_INTERVAL_MS) return null;
  const round = Math.max(0, Math.floor((elapsed - BLOCK_INTERVAL_MS) / ROUND_WINDOW_MS));
  if (!Number.isSafeInteger(round) || round > MAX_CONSENSUS_ROUND_CATCHUP) return null;
  const signer = typeof validator === "string" ? new LocalValidatorSigner(validator) : validator;
  const publicKey = signer.publicKey;
  const validators = chain.validatorsAt(chain.height + 1);
  // Skip votes for height H+1 are signed under protocolVersionAt(H+1)
  // (NodeService.requestSkipVote) and the finalized block is validated under
  // the same version, so verification must use exactly that version (F-03).
  const protocolVersion = chain.protocolVersionAt(chain.height + 1);
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
            chain.tip.hash,
            protocolVersion
          );
          unique.set(vote.validator, vote);
        } catch (error) {
          service.roundSkipVoteDiagnostics.recordRejectedVote({
            height: chain.height + 1,
            round: skippedRound,
            protocolVersion,
            vote,
            error
          });
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
          chain.tip.hash,
          protocolVersion
        );
      } catch (error) {
        service.roundSkipVoteDiagnostics.recordQuorumFailure({
          height: chain.height + 1,
          round: skippedRound,
          protocolVersion,
          error
        });
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

function uniqueValidVotes(
  votes: unknown[],
  validators: Validator[],
  domain: typeof V6_PREPARE_VOTE_DOMAIN | typeof V6_COMMIT_VOTE_DOMAIN,
  chainId: string,
  height: number,
  round: number,
  hash: string
): V6Vote[] {
  const unique = new Map<Address, V6Vote>();
  for (const vote of votes) {
    try {
      validateV6Vote(vote, validators, domain, chainId, height, round, hash);
      unique.set(vote.validator, vote);
    } catch {
    }
  }
  return [...unique.values()];
}

/**
 * Leader: build TC(H, r) from timeout responses (§5.1, §5.2). Each vote is
 * counted only if its carried QC verifies; M is the highest verified QC among
 * all responses. Returns null without a quorum.
 */
export function assembleTimeoutCertificate(
  responses: unknown[],
  validators: Validator[],
  chainId: string,
  height: number,
  round: number
): TimeoutCertificate | null {
  const valid = new Map<Address, V6TimeoutResponse>();
  for (const response of responses) {
    try {
      validateTimeoutResponse(response, validators, chainId, height, round);
      valid.set(response.vote.validator, response);
    } catch {
    }
  }
  const highest: PrepareQC | null = maxQC([...valid.values()].map((response) => response.highQC));
  const votes = [...valid.values()]
    .filter((response) => !(highest && response.vote.highQCRound === highest.round && response.vote.highQCHash !== highest.blockHash))
    .map((response) => response.vote);
  if (votes.length < validatorQuorumSize(validators.length)) return null;
  const certificate: TimeoutCertificate = { chainId, height, round, votes, highQC: highest };
  validateTimeoutCertificate(certificate, validators, chainId, height, round);
  return certificate;
}

/**
 * Protocol v6 leader path (spec §3.4 PROPOSE/COMMIT/FINALIZE). One call
 * performs one attempt for the round given by the pacemaker; the caller
 * retries within the round (a retry re-sends the stored proposal and
 * validators re-sign idempotently).
 */
async function produceFinalizedBlockV6(
  service: NodeService,
  peers: ConsensusPeerClient,
  signer: ValidatorSigner,
  consensusNowMs: number,
  signingNowMs: () => number
): Promise<Block | null> {
  const chain = service.store.chain;
  const height = chain.height + 1;
  const chainId = chain.genesis.chainId;
  const tipTimestampMs = chain.tip.header.timestampMs;
  // The leader of r starts at roundStart(r) - guard, when validators may sign timeout(r-1).
  const round = clockRound(tipTimestampMs, consensusNowMs + V6_TIMEOUT_GUARD_MS);
  if (round === null) return null;
  const validators = chain.validatorsAt(height);
  if (expectedValidator(validators, height, round).publicKey !== signer.publicKey) return null;
  const quorum = validatorQuorumSize(validators.length);

  let request: V6PrepareRequest;
  const stored = await service.v6StoredProposal(round, signingNowMs());
  if (stored.status === "unavailable") return null; // never propose a second value in this round (§6.4)
  if (stored.status === "ok") {
    request = stored.request;
  } else {
    let tc: TimeoutCertificate | null = null;
    if (round > 0) {
      const responses: unknown[] = [];
      try {
        responses.push(await service.v6Timeout(height, round - 1, signingNowMs()));
      } catch {
      }
      responses.push(...await (peers.requestV6Timeouts?.(height, round - 1) ?? Promise.resolve([])));
      tc = assembleTimeoutCertificate(responses, validators, chainId, height, round - 1);
      if (!tc) return null;
    }
    let block: Block | null;
    if (tc?.highQC) {
      const hash = tc.highQC.blockHash;
      block = await service.v6FetchBlock(height, hash);
      if (!block && peers.fetchV6Block) {
        const fetched = await peers.fetchV6Block(height, hash);
        try {
          block = fetched ? validateFetchedV6Block(fetched, height, hash) : null;
        } catch {
          block = null;
        }
      }
      if (!block) return null;
    } else {
      const ownHash = service.v6OwnBlockProposal(round);
      if (ownHash !== undefined) {
        block = await service.v6FetchBlock(height, ownHash);
        if (!block) return null;
      } else {
        const transactions = chain.selectValidPending(service.mempool.values(), 10_000);
        const unsigned = chain.prepareBlock(transactions, signer.publicKey, {
          round,
          timestampMs: Math.max(consensusNowMs, tipTimestampMs + 1)
        });
        block = await service.v6SignFreshBlock(unsigned, signingNowMs());
      }
    }
    request = await service.v6SignProposal({ round, block, tc }, signingNowMs());
  }
  const hash = request.block.hash;

  const prepareResponses: unknown[] = [];
  try {
    prepareResponses.push(await service.v6Prepare(request, signingNowMs()));
  } catch {
  }
  prepareResponses.push(...await (peers.requestV6Prepare?.(request) ?? Promise.resolve([])));
  const prepareVotes = uniqueValidVotes(prepareResponses, validators, V6_PREPARE_VOTE_DOMAIN, chainId, height, round, hash);
  if (prepareVotes.length < quorum) return null;
  const qc: PrepareQC = { chainId, height, round, blockHash: hash, votes: prepareVotes };

  const commitRequest: V6CommitRequest = { qc, block: request.block };
  const commitResponses: unknown[] = [];
  try {
    commitResponses.push(await service.v6Commit(commitRequest, signingNowMs()));
  } catch {
  }
  commitResponses.push(...await (peers.requestV6Commit?.(commitRequest) ?? Promise.resolve([])));
  const commitVotes = uniqueValidVotes(commitResponses, validators, V6_COMMIT_VOTE_DOMAIN, chainId, height, round, hash);
  if (commitVotes.length < quorum) return null;

  const finalized: Block = { ...request.block, attestations: commitVotes, commitRound: round };
  if (service.status().height < height) await service.acceptFinalizedBlock(finalized);
  await peers.broadcastBlock(finalized);
  return finalized;
}
