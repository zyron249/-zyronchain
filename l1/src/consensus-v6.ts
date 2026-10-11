// Protocol v6 consensus primitives (F-01 remediation): a locked two-phase BFT
// protocol with timeout certificates. See F01_CONSENSUS_DESIGN.md §3-§9.
//
// This module is pure: pacemaker arithmetic, signed payloads, certificate
// validation and the SAFE-VOTE predicate. Persistence (journal v2 rows and
// consensus-state files) lives in storage.ts; the request handlers live in
// node-base.ts; the leader path lives in node.ts.
//
// Signed messages (all domain-separated, all bound to chainId/height/round):
//   Proposal     {chainId, height, round, blockHash, justifyRound}   zyronchain/consensus-proposal/v1
//   PrepareVote  {chainId, height, round, blockHash}                 zyronchain/prepare-vote/v1
//   CommitVote   {chainId, height, round, blockHash}                 zyronchain/commit-vote/v1
//   TimeoutVote  {chainId, height, round, highQCRound, highQCHash}   zyronchain/round-timeout/v1
// The block header keeps its v1 proposal domain (zyronchain/block-proposal/v1).
import { assertHex, canonicalJson, sha256Hex } from "./codec.js";
import { addressFromPublicKey, signCanonicalDomain, verifyCanonicalDomain } from "./crypto.js";
import { blockHash, expectedValidator, validatorQuorumSize } from "./block.js";
import { merkleRoot } from "./merkle.js";
import { assertAddress, assertExactKeys, assertPlainRecord } from "./transaction.js";
import type { Address, Block, Validator } from "./types.js";

export const CONSENSUS_V6_PROTOCOL_VERSION = 6;

// Pacemaker (spec §3.3, decided defaults §16.9-1).
export const V6_BLOCK_INTERVAL_MS = 30_000; // == node-base BLOCK_INTERVAL_MS (pinned by test)
export const V6_ROUND_BASE_MS = 30_000;
export const V6_ROUND_STEP_MS = 5_000;
export const V6_ROUND_MAX_MS = 120_000;
export const V6_TIMEOUT_GUARD_MS = 2_000;
export const V6_LEADER_JITTER_MAX_MS = 250;
export const V6_LEADER_RETRY_MS = 1_000;
export const V6_FALLBACK_POLL_MS = V6_ROUND_BASE_MS / 10;
/** Upper bound for v6 rounds (with 120 s rounds this is ~3.8 years of failed rounds). */
export const V6_MAX_ROUND = 1_000_000;
/** Minimum distance between a v6 upgrade's inclusion height and its activation height (policy, §16.9-9). */
export const V6_MIN_ACTIVATION_MARGIN_BLOCKS = 2_000;

export const V6_PROPOSAL_DOMAIN = "zyronchain/consensus-proposal/v1";
export const V6_PREPARE_VOTE_DOMAIN = "zyronchain/prepare-vote/v1";
export const V6_COMMIT_VOTE_DOMAIN = "zyronchain/commit-vote/v1";
export const V6_TIMEOUT_DOMAIN = "zyronchain/round-timeout/v1";

export const ZERO_HASH = "0".repeat(64);

export function isConsensusV6(protocolVersion: number): boolean {
  return protocolVersion === CONSENSUS_V6_PROTOCOL_VERSION;
}

// ---------------------------------------------------------------------------
// Pacemaker
// ---------------------------------------------------------------------------

function assertRound(round: number): void {
  if (!Number.isSafeInteger(round) || round < 0 || round > V6_MAX_ROUND) throw new Error("Invalid v6 round");
}

export function roundDuration(round: number): number {
  assertRound(round);
  return Math.min(V6_ROUND_BASE_MS + (round * V6_ROUND_STEP_MS), V6_ROUND_MAX_MS);
}

/** First round whose duration is capped at V6_ROUND_MAX_MS. */
const CAP_ROUND = Math.ceil((V6_ROUND_MAX_MS - V6_ROUND_BASE_MS) / V6_ROUND_STEP_MS);

/** Offset of roundStart(r) from roundStart(0). */
export function roundOffset(round: number): number {
  assertRound(round);
  const linear = Math.min(round, CAP_ROUND);
  const linearPart = (linear * V6_ROUND_BASE_MS) + ((V6_ROUND_STEP_MS * linear * (linear - 1)) / 2);
  return linearPart + (Math.max(0, round - CAP_ROUND) * V6_ROUND_MAX_MS);
}

export function roundStart(tipTimestampMs: number, round: number): number {
  return tipTimestampMs + V6_BLOCK_INTERVAL_MS + roundOffset(round);
}

export function roundEnd(tipTimestampMs: number, round: number): number {
  return roundStart(tipTimestampMs, round) + roundDuration(round);
}

/** Earliest local time at which a validator signs timeout(H, round) (§3.4, R5). */
export function timeoutAllowedAt(tipTimestampMs: number, round: number): number {
  return roundEnd(tipTimestampMs, round) - V6_TIMEOUT_GUARD_MS;
}

/**
 * The largest round r with roundStart(r) <= now, or null before round 0 starts
 * or beyond V6_MAX_ROUND. Closed form (no per-round loop).
 */
export function clockRound(tipTimestampMs: number, nowMs: number): number | null {
  const elapsed = nowMs - (tipTimestampMs + V6_BLOCK_INTERVAL_MS);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const capOffset = roundOffset(CAP_ROUND);
  let round: number;
  if (elapsed >= capOffset) {
    round = CAP_ROUND + Math.floor((elapsed - capOffset) / V6_ROUND_MAX_MS);
  } else {
    // offset(r) = B r + S r (r-1) / 2  ->  S/2 r^2 + (B - S/2) r - elapsed = 0
    const a = V6_ROUND_STEP_MS / 2;
    const b = V6_ROUND_BASE_MS - (V6_ROUND_STEP_MS / 2);
    round = Math.floor((-b + Math.sqrt((b * b) + (4 * a * elapsed))) / (2 * a));
    // Correct floating-point drift at exact boundaries.
    while (round > 0 && roundOffset(round) > elapsed) round -= 1;
    while (round + 1 <= CAP_ROUND && roundOffset(round + 1) <= elapsed) round += 1;
  }
  if (!Number.isSafeInteger(round) || round > V6_MAX_ROUND) return null;
  return round;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface V6ProposalPayload {
  chainId: string;
  height: number;
  round: number;
  blockHash: string;
  justifyRound: number;
}

export interface V6Proposal extends V6ProposalPayload {
  signature: string;
}

/** A PrepareVote or CommitVote as carried in QCs, responses and finality certificates. */
export interface V6Vote {
  validator: Address;
  publicKey: string;
  signature: string;
}

export interface PrepareQC {
  chainId: string;
  height: number;
  round: number;
  blockHash: string;
  votes: V6Vote[];
}

export interface V6TimeoutPayload {
  chainId: string;
  height: number;
  round: number;
  highQCRound: number;
  highQCHash: string;
}

export interface V6TimeoutVote extends V6TimeoutPayload {
  validator: Address;
  publicKey: string;
  signature: string;
}

export interface TimeoutCertificate {
  chainId: string;
  height: number;
  round: number;
  votes: V6TimeoutVote[];
  highQC: PrepareQC | null;
}

/** `prepare` request (§3.4 PREPARE). The justify QC is `tc.highQC` (leader obligation, §4.6). */
export interface V6PrepareRequest {
  proposal: V6Proposal;
  block: Block;
  tc: TimeoutCertificate | null;
}

/** `commit` request (§3.4 COMMIT). */
export interface V6CommitRequest {
  qc: PrepareQC;
  block: Block;
}

/** `timeout` response: the signed vote plus the QC it reports (unsigned carrier). */
export interface V6TimeoutResponse {
  vote: V6TimeoutVote;
  highQC: PrepareQC | null;
}

export interface V6Lock {
  round: number;
  blockHash: string;
}

export function proposalPayload(proposal: V6ProposalPayload): V6ProposalPayload {
  return {
    chainId: proposal.chainId,
    height: proposal.height,
    round: proposal.round,
    blockHash: proposal.blockHash,
    justifyRound: proposal.justifyRound
  };
}

export function votePayload(chainId: string, height: number, round: number, blockHash: string): unknown {
  return { chainId, height, round, blockHash };
}

export function timeoutPayload(input: V6TimeoutPayload): V6TimeoutPayload {
  return {
    chainId: input.chainId,
    height: input.height,
    round: input.round,
    highQCRound: input.highQCRound,
    highQCHash: input.highQCHash
  };
}

/** Journal value of a proposal row: sha256 of the canonical Proposal payload (§6.1). */
export function proposalDigest(proposal: V6ProposalPayload): string {
  return sha256Hex(canonicalJson(proposalPayload(proposal)));
}

/** Journal value of a timeout row: sha256 of the canonical TimeoutVote payload (§6.1). */
export function timeoutDigest(payload: V6TimeoutPayload): string {
  return sha256Hex(canonicalJson(timeoutPayload(payload)));
}

export function signV6(domain: string, payload: unknown, privateKeyHex: string): string {
  return signCanonicalDomain(domain, payload, privateKeyHex);
}

// ---------------------------------------------------------------------------
// Shape validation (untrusted input)
// ---------------------------------------------------------------------------

function assertHeight(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid v6 ${name} height`);
}

function assertRoundValue(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > V6_MAX_ROUND) {
    throw new Error(`Invalid v6 ${name} round`);
  }
}

function assertChainId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new Error(`Invalid v6 ${name} chain ID`);
}

function assertHash(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`Invalid v6 ${name}`);
  assertHex(value, 32, name);
}

export function validateV6VoteShape(value: unknown): asserts value is V6Vote {
  assertPlainRecord(value, "v6 vote");
  assertExactKeys(value, ["validator", "publicKey", "signature"], "v6 vote");
  if (typeof value.validator !== "string" || typeof value.publicKey !== "string" || typeof value.signature !== "string") {
    throw new Error("Invalid v6 vote");
  }
  assertAddress(value.validator);
  assertHex(value.publicKey, 64, "v6 vote publicKey");
  assertHex(value.signature, 64, "v6 vote signature");
}

export function validateProposalShape(value: unknown): asserts value is V6Proposal {
  assertPlainRecord(value, "v6 proposal");
  assertExactKeys(value, ["chainId", "height", "round", "blockHash", "justifyRound", "signature"], "v6 proposal");
  assertChainId(value.chainId, "proposal");
  assertHeight(value.height, "proposal");
  assertRoundValue(value.round, "proposal");
  assertHash(value.blockHash, "proposal blockHash");
  if (!Number.isSafeInteger(value.justifyRound) || (value.justifyRound as number) < -1 ||
      (value.justifyRound as number) >= (value.round as number)) {
    throw new Error("Invalid v6 proposal justifyRound");
  }
  if (typeof value.signature !== "string") throw new Error("Invalid v6 proposal signature");
  assertHex(value.signature, 64, "v6 proposal signature");
}

export function validatePrepareQCShape(value: unknown): asserts value is PrepareQC {
  assertPlainRecord(value, "prepare QC");
  assertExactKeys(value, ["chainId", "height", "round", "blockHash", "votes"], "prepare QC");
  assertChainId(value.chainId, "prepare QC");
  assertHeight(value.height, "prepare QC");
  assertRoundValue(value.round, "prepare QC");
  assertHash(value.blockHash, "prepare QC blockHash");
  if (!Array.isArray(value.votes) || value.votes.length > 100) throw new Error("Invalid prepare QC votes");
  for (const vote of value.votes) validateV6VoteShape(vote);
}

export function validateTimeoutVoteShape(value: unknown): asserts value is V6TimeoutVote {
  assertPlainRecord(value, "timeout vote");
  assertExactKeys(value, [
    "validator", "publicKey", "chainId", "height", "round", "highQCRound", "highQCHash", "signature"
  ], "timeout vote");
  if (typeof value.validator !== "string" || typeof value.publicKey !== "string" || typeof value.signature !== "string") {
    throw new Error("Invalid timeout vote");
  }
  assertAddress(value.validator);
  assertHex(value.publicKey, 64, "timeout vote publicKey");
  assertHex(value.signature, 64, "timeout vote signature");
  assertChainId(value.chainId, "timeout vote");
  assertHeight(value.height, "timeout vote");
  assertRoundValue(value.round, "timeout vote");
  // Phase 0 correction of §5.1: -1 <= highQCRound <= round.
  if (!Number.isSafeInteger(value.highQCRound) || (value.highQCRound as number) < -1 ||
      (value.highQCRound as number) > (value.round as number)) {
    throw new Error("Invalid timeout vote highQCRound");
  }
  assertHash(value.highQCHash, "timeout vote highQCHash");
  if ((value.highQCRound === -1) !== (value.highQCHash === ZERO_HASH)) throw new Error("Invalid timeout vote highQC report");
}

export function validateTimeoutCertificateShape(value: unknown): asserts value is TimeoutCertificate {
  assertPlainRecord(value, "timeout certificate");
  assertExactKeys(value, ["chainId", "height", "round", "votes", "highQC"], "timeout certificate");
  assertChainId(value.chainId, "timeout certificate");
  assertHeight(value.height, "timeout certificate");
  assertRoundValue(value.round, "timeout certificate");
  if (!Array.isArray(value.votes) || value.votes.length > 100) throw new Error("Invalid timeout certificate votes");
  for (const vote of value.votes) validateTimeoutVoteShape(vote);
  if (value.highQC !== null) validatePrepareQCShape(value.highQC);
}

export function validateTimeoutResponseShape(value: unknown): asserts value is V6TimeoutResponse {
  assertPlainRecord(value, "timeout response");
  assertExactKeys(value, ["vote", "highQC"], "timeout response");
  validateTimeoutVoteShape(value.vote);
  if (value.highQC !== null) validatePrepareQCShape(value.highQC);
}

// ---------------------------------------------------------------------------
// Signature and certificate validation
// ---------------------------------------------------------------------------

function memberMap(validators: Validator[] | Map<string, string>): Map<string, string> {
  return validators instanceof Map ? validators : new Map(validators.map((validator) => [validator.address, validator.publicKey]));
}

export function verifyProposalSignature(proposal: V6Proposal, validators: Validator[]): void {
  const leader = expectedValidator(validators, proposal.height, proposal.round);
  if (!verifyCanonicalDomain(V6_PROPOSAL_DOMAIN, proposalPayload(proposal), proposal.signature, leader.publicKey)) {
    throw new Error("Invalid v6 proposal signature");
  }
}

function validateVoteSet(
  votes: V6Vote[],
  validators: Validator[],
  domain: string,
  payload: unknown,
  label: string
): void {
  if (votes.length > validators.length) throw new Error(`${label} exceeds active validator set`);
  const allowed = memberMap(validators);
  const seen = new Set<string>();
  for (const vote of votes) {
    validateV6VoteShape(vote);
    if (seen.has(vote.validator)) throw new Error(`Duplicate ${label} vote`);
    seen.add(vote.validator);
    if (allowed.get(vote.validator) !== vote.publicKey) throw new Error(`Unknown ${label} validator`);
    if (!verifyCanonicalDomain(domain, payload, vote.signature, vote.publicKey)) throw new Error(`Invalid ${label} signature`);
  }
  const quorum = validatorQuorumSize(validators.length);
  if (votes.length < quorum) throw new Error(`${label} quorum not reached: ${votes.length}/${quorum}`);
}

/** Validate a single PrepareVote/CommitVote response against a member set. */
export function validateV6Vote(
  vote: unknown,
  validators: Validator[] | Map<string, string>,
  domain: typeof V6_PREPARE_VOTE_DOMAIN | typeof V6_COMMIT_VOTE_DOMAIN,
  chainId: string,
  height: number,
  round: number,
  blockHash: string
): asserts vote is V6Vote {
  validateV6VoteShape(vote);
  if (memberMap(validators).get(vote.validator) !== vote.publicKey) throw new Error("Unknown v6 vote validator");
  if (!verifyCanonicalDomain(domain, votePayload(chainId, height, round, blockHash), vote.signature, vote.publicKey)) {
    throw new Error("Invalid v6 vote signature");
  }
}

/** A PrepareQC: >= q distinct prepare-vote signatures over identical (chainId, H, r, blockHash) (§4.4). */
export function validatePrepareQC(qc: unknown, validators: Validator[], chainId: string, height: number): asserts qc is PrepareQC {
  validatePrepareQCShape(qc);
  if (qc.chainId !== chainId) throw new Error("Prepare QC chain ID mismatch");
  if (qc.height !== height) throw new Error("Prepare QC height mismatch");
  validateVoteSet(qc.votes, validators, V6_PREPARE_VOTE_DOMAIN, votePayload(chainId, height, qc.round, qc.blockHash), "Prepare QC");
}

export function validateTimeoutVote(
  vote: unknown,
  validators: Validator[] | Map<string, string>,
  chainId: string,
  height: number,
  round: number
): asserts vote is V6TimeoutVote {
  validateTimeoutVoteShape(vote);
  if (vote.chainId !== chainId || vote.height !== height || vote.round !== round) throw new Error("Timeout vote target mismatch");
  if (memberMap(validators).get(vote.validator) !== vote.publicKey) throw new Error("Unknown timeout vote validator");
  if (!verifyCanonicalDomain(V6_TIMEOUT_DOMAIN, timeoutPayload(vote), vote.signature, vote.publicKey)) {
    throw new Error("Invalid timeout vote signature");
  }
}

/**
 * Validate a timeout response for (H, r): the vote and, if it reports a QC,
 * the carried QC (which must match the report exactly). Used by the leader
 * before counting a vote (§5.2).
 */
export function validateTimeoutResponse(
  response: unknown,
  validators: Validator[],
  chainId: string,
  height: number,
  round: number
): asserts response is V6TimeoutResponse {
  validateTimeoutResponseShape(response);
  validateTimeoutVote(response.vote, validators, chainId, height, round);
  if (response.vote.highQCRound === -1) {
    if (response.highQC !== null) throw new Error("Timeout response carries an unreported QC");
    return;
  }
  if (response.highQC === null) throw new Error("Timeout response is missing its reported QC");
  validatePrepareQC(response.highQC, validators, chainId, height);
  if (response.highQC.round !== response.vote.highQCRound || response.highQC.blockHash !== response.vote.highQCHash) {
    throw new Error("Timeout response QC does not match the signed report");
  }
}

/**
 * TC(H, r) (§5.1): >= q distinct valid timeout votes for (H, r) and, iff the
 * maximum reported highQCRound is >= 0, the PrepareQC of exactly that round
 * whose hash equals every vote reporting that round. Returns the maximum
 * reported highQCRound (-1 if none).
 */
export function validateTimeoutCertificate(
  tc: unknown,
  validators: Validator[],
  chainId: string,
  height: number,
  round: number
): number {
  validateTimeoutCertificateShape(tc);
  if (tc.chainId !== chainId || tc.height !== height || tc.round !== round) throw new Error("Timeout certificate target mismatch");
  if (tc.votes.length > validators.length) throw new Error("Timeout certificate exceeds active validator set");
  const allowed = memberMap(validators);
  const seen = new Set<string>();
  let maxReported = -1;
  for (const vote of tc.votes) {
    if (seen.has(vote.validator)) throw new Error("Duplicate timeout vote");
    seen.add(vote.validator);
    validateTimeoutVote(vote, allowed, chainId, height, round);
    maxReported = Math.max(maxReported, vote.highQCRound);
  }
  const quorum = validatorQuorumSize(validators.length);
  if (tc.votes.length < quorum) throw new Error(`Timeout certificate quorum not reached: ${tc.votes.length}/${quorum}`);
  if (maxReported < 0) {
    if (tc.highQC !== null) throw new Error("Timeout certificate carries an unreported QC");
    return -1;
  }
  if (tc.highQC === null) throw new Error("Timeout certificate is missing the highest reported QC");
  validatePrepareQC(tc.highQC, validators, chainId, height);
  if (tc.highQC.round !== maxReported) throw new Error("Timeout certificate QC is not the highest reported QC");
  for (const vote of tc.votes) {
    if (vote.highQCRound === maxReported && vote.highQCHash !== tc.highQC.blockHash) {
      throw new Error("Timeout certificate QC does not match a highest-round report");
    }
  }
  return maxReported;
}

/**
 * Proposal-level checks of a `prepare` request that do not depend on chain
 * state or the validator's lock (§3.4 PREPARE, first block): leader
 * signature, TC for r-1, the leader obligation, and the justify QC. Block
 * validity (header, transactions, origin proposer signature) is checked by
 * the chain. Returns the justify QC (tc.highQC) or null.
 */
export function validatePrepareRequestCertificates(
  request: V6PrepareRequest,
  validators: Validator[],
  chainId: string,
  height: number,
  options: { verifyProposalSignature?: boolean } = {}
): PrepareQC | null {
  const { proposal, block, tc } = request;
  validateProposalShape(proposal);
  if (proposal.chainId !== chainId) throw new Error("v6 proposal chain ID mismatch");
  if (proposal.height !== height) throw new Error("v6 proposal height mismatch");
  // The leader checks its own request before signing (no signature yet).
  if (options.verifyProposalSignature !== false) verifyProposalSignature(proposal, validators);
  if (block.hash !== proposal.blockHash) throw new Error("v6 proposal block hash mismatch");
  if (block.header.height !== height || block.header.chainId !== chainId) throw new Error("v6 proposal block target mismatch");
  if (block.header.round > proposal.round) throw new Error("v6 proposal block is from a later round");
  if (proposal.round === 0) {
    if (tc !== null) throw new Error("Round 0 v6 proposal must not carry a timeout certificate");
    if (proposal.justifyRound !== -1) throw new Error("Round 0 v6 proposal must not carry a justification");
    if (block.header.round !== 0) throw new Error("Round 0 v6 proposal must carry a fresh block");
    return null;
  }
  if (tc === null) throw new Error("v6 proposal is missing the timeout certificate for the previous round");
  const maxReported = validateTimeoutCertificate(tc, validators, chainId, height, proposal.round - 1);
  // Leader obligation (§4.6): re-propose exactly the block of the highest reported QC.
  if (proposal.justifyRound !== maxReported) throw new Error("v6 proposal does not extend the highest reported QC");
  if (maxReported === -1) {
    if (block.header.round !== proposal.round) throw new Error("Unjustified v6 proposal must carry a fresh block");
    return null;
  }
  const justify = tc.highQC!;
  if (justify.blockHash !== block.hash) throw new Error("v6 proposal block does not match its justification");
  if (block.header.round > justify.round) throw new Error("v6 justified block is newer than its QC");
  return justify;
}

/** SAFE-VOTE (§3.4, R2): lock = ⊥ ∨ lock.hash = B ∨ justifyRound > lock.round. */
export function safeVote(lock: V6Lock | null, blockHash: string, justifyRound: number): boolean {
  return lock === null || lock.blockHash === blockHash || justifyRound > lock.round;
}

/**
 * v6 finality certificate (§3.4 FINALIZE, R7): >= q CommitVotes from distinct
 * members of validatorsAt(H), all over {chainId, height, round: commitRound,
 * blockHash}. commitRound >= header.round (a block is committed in or after
 * its origin round).
 */
export function validateCommitCertificate(block: Block, validators: Validator[]): void {
  const commitRound = block.commitRound;
  if (typeof commitRound !== "number" || !Number.isSafeInteger(commitRound) || commitRound < 0 || commitRound > V6_MAX_ROUND) {
    throw new Error("v6 block requires a commit round");
  }
  if (commitRound < block.header.round) throw new Error("v6 commit round precedes the block's origin round");
  validateVoteSet(
    block.attestations,
    validators,
    V6_COMMIT_VOTE_DOMAIN,
    votePayload(block.header.chainId, block.header.height, commitRound, block.hash),
    "Finality"
  );
}

/**
 * Integrity of a v6 proposal block obtained outside a validated `prepare`
 * request (commit request, consensus-state file, fetch by hash). The block
 * hash covers only the header, so the body (transactions vs transactionRoot),
 * the proposal-form envelope and the proposer signature are checked here;
 * otherwise a stored or fetched copy with the right header and a different
 * body would make every later re-proposal of it fail (liveness, §8.2).
 * Chain-state validity is implied by the PrepareQC and re-checked by every
 * validator when the block is re-proposed.
 */
export function assertV6ProposalBlockIntegrity(block: Block, height: number, hash: string, validators?: Validator[]): void {
  if (block.hash !== hash || blockHash(block.header) !== hash || block.header.height !== height ||
      block.header.version !== CONSENSUS_V6_PROTOCOL_VERSION) {
    throw new Error("v6 block does not match the requested hash");
  }
  if (block.header.transactionRoot !== merkleRoot(block.transactions)) throw new Error("v6 block body does not match its header");
  if (block.roundCertificate.length !== 0 || block.attestations.length !== 0 || block.commitRound !== null) {
    throw new Error("v6 block is not in proposal form");
  }
  if (typeof block.signature !== "string" || typeof block.proposerPublicKey !== "string") throw new Error("v6 block is unsigned");
  assertHex(block.signature, 64, "v6 block signature");
  assertHex(block.proposerPublicKey, 64, "v6 block proposerPublicKey");
  if (addressFromPublicKey(block.proposerPublicKey) !== block.header.proposer) throw new Error("v6 block proposer key mismatch");
  if (validators && expectedValidator(validators, height, block.header.round).publicKey !== block.proposerPublicKey) {
    throw new Error("v6 block proposer is not the origin-round leader");
  }
  if (!verifyCanonicalDomain("zyronchain/block-proposal/v1", block.header, block.signature, block.proposerPublicKey)) {
    throw new Error("Invalid v6 block proposer signature");
  }
}

/** Highest-round QC among verified candidates (ties: identical by L1, first wins). */
export function maxQC(candidates: Array<PrepareQC | null | undefined>): PrepareQC | null {
  let best: PrepareQC | null = null;
  for (const candidate of candidates) {
    if (candidate && (!best || candidate.round > best.round)) best = candidate;
  }
  return best;
}
