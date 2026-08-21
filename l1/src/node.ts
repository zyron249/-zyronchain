export * from "./node-base.js";

import {
  BLOCK_INTERVAL_MS,
  ROUND_WINDOW_MS,
  NodeService,
  PeerClient as BasePeerClient,
  PeerResponseByteBudget,
  RPC_API_VERSION,
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
export const MAX_HTTP_ATTESTATION_RESPONSE_BYTES = 8_192;
export const MAX_HTTP_ROUND_SKIP_RESPONSE_BYTES = 16_384;
const MAX_HTTP_CONSENSUS_WIRE_BYTES_INFLIGHT = 16_000_000;
const MAX_HTTP_CONSENSUS_PARSE_BYTES_INFLIGHT = 64_000_000;
const MAX_HTTP_CONSENSUS_CHAIN_ID_LENGTH = 128;
const httpConsensusWireBudget = new PeerResponseByteBudget(MAX_HTTP_CONSENSUS_WIRE_BYTES_INFLIGHT);
const httpConsensusParseBudget = new PeerResponseByteBudget(MAX_HTTP_CONSENSUS_PARSE_BYTES_INFLIGHT);

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    await response.body?.cancel();
    throw new Error("Peer response must use application/json");
  }
  const advertised = response.headers.get("x-zyron-rpc-version");
  if (advertised === null) {
    await response.body?.cancel();
    throw new Error("Peer response is missing RPC API version");
  }
  if (advertised !== String(RPC_API_VERSION)) {
    await response.body?.cancel();
    throw new Error(`Peer uses unsupported RPC API version ${advertised}`);
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
        releases.push(httpConsensusWireBudget.reserve(value.byteLength));
      } catch (error) {
        await reader.cancel();
        throw error;
      }
      chunks.push(value);
    }
    if (total === 0) throw new Error("Peer returned empty body");
    const parsed = parsePeerResponseJsonChunks(chunks, total, httpConsensusParseBudget);
    releaseDecoded = parsed.release;
    // The route-specific inner shape gate runs before the decoded-memory lease
    // is released, so Promise.allSettled() cannot retain arbitrary nested peer
    // graphs after parse-budget capacity has been returned.
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
  validate: (value: unknown) => T
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
    signal: AbortSignal.timeout(HTTP_CONSENSUS_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}`);
  return parseHttpConsensusResponse(response, maxResponseBytes, validate);
}

/**
 * Canonical configured-HTTP peer client. The base implementation still owns
 * sync/discovery/gossip behavior; consensus result parsing is overridden here
 * so inner peer-controlled graphs are shape-gated before their decoded-memory
 * leases are released.
 */
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
    const results = await Promise.allSettled(this.peers.map(async (peer) => {
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
        }
      );
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  override async requestRoundSkips(
    height: number,
    round: number,
    previousCertificate: RoundSkipVote[] = []
  ): Promise<RoundSkipVote[]> {
    const results = await Promise.allSettled(this.peers.map(async (peer) => {
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
        }
      );
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
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
 * Tests that explicitly inject `nowMs` retain the historical deterministic
 * fixed-clock behavior.
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
