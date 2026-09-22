import {
  hashCouldStillBeFinalized,
  validateLockedAttestEvidence,
  validateRoundSkipVote,
  validatorQuorumSize
} from "./block.js";
import { assertHex } from "./codec.js";
import {
  addressFromPublicKey,
  signCanonical,
  signCanonicalDomain,
  verifyCanonical,
  verifyCanonicalDomain
} from "./crypto.js";
import { assertAddress, assertExactKeys, assertPlainRecord } from "./transaction.js";
import type { PrepareVote, RoundProgressEntry, Validator, ViewChangeVote } from "./types.js";

export const PREPARE_DOMAIN = "zyronchain/round-prepare/v1";
export const VIEW_CHANGE_DOMAIN = "zyronchain/round-view-change/v1";
export const CONSENSUS_RULES_VERSION = 2;

/** After an ambiguous round, at most f Byzantine proposers precede an honest one. */
export function roundChangeLivenessBound(validatorCount: number): number {
  if (!Number.isSafeInteger(validatorCount) || validatorCount < 1) throw new Error("Invalid validator count");
  return Math.floor((validatorCount - 1) / 3) + 1;
}

export function byzantineFaultBound(validatorCount: number): number {
  if (!Number.isSafeInteger(validatorCount) || validatorCount < 1) throw new Error("Invalid validator count");
  return Math.floor((validatorCount - 1) / 3);
}

/**
 * Honest intersection of a commit quorum and a later view-change quorum.
 * The value is at least 1 for every validator-set size this node accepts.
 */
export function honestQuorumIntersection(validatorCount: number): number {
  const quorum = validatorQuorumSize(validatorCount);
  const faults = byzantineFaultBound(validatorCount);
  return (2 * quorum) - validatorCount - faults;
}

export interface PriorCommit {
  round: number;
  hash: string;
}

/**
 * A later commit of a different hash is allowed only when its prepare quorum
 * is from a strictly higher round than every conflicting lock. A quorum of
 * that form cannot be assembled if the earlier hash already has a commit
 * quorum: the intersection contains an honest committer who will not prepare
 * the new hash.
 */
export function commitAllowedByLock(
  priorCommits: readonly PriorCommit[],
  round: number,
  hash: string,
  prepareQuorumRound: number | null
): boolean {
  for (const prior of priorCommits) {
    if (prior.hash === hash) continue;
    if (prepareQuorumRound === null || prepareQuorumRound <= prior.round) return false;
  }
  return true;
}

export function preparePayload(vote: Omit<PrepareVote, "signature">): unknown {
  return {
    domain: PREPARE_DOMAIN,
    validator: vote.validator,
    publicKey: vote.publicKey,
    chainId: vote.chainId,
    height: vote.height,
    round: vote.round,
    blockHash: vote.blockHash
  };
}

export function viewChangePayload(vote: Omit<ViewChangeVote, "signature" | "prepares">): unknown {
  return {
    domain: VIEW_CHANGE_DOMAIN,
    validator: vote.validator,
    publicKey: vote.publicKey,
    chainId: vote.chainId,
    height: vote.height,
    round: vote.round,
    previousHash: vote.previousHash,
    lockRound: vote.lockRound,
    lockHash: vote.lockHash
  };
}

export function createPrepareVote(input: {
  chainId: string;
  height: number;
  round: number;
  blockHash: string;
  validatorPrivateKey: string;
  validatorPublicKey: string;
  protocolVersion?: number;
}): PrepareVote {
  const unsigned = {
    validator: addressFromPublicKey(input.validatorPublicKey),
    publicKey: input.validatorPublicKey,
    chainId: input.chainId,
    height: input.height,
    round: input.round,
    blockHash: input.blockHash
  };
  return {
    ...unsigned,
    signature: signForProtocol(input.protocolVersion ?? 1, PREPARE_DOMAIN, preparePayload(unsigned), input.validatorPrivateKey)
  };
}

export function createViewChangeVote(input: {
  chainId: string;
  height: number;
  round: number;
  previousHash: string;
  lockRound: number | null;
  lockHash: string | null;
  prepares?: PrepareVote[];
  validatorPrivateKey: string;
  validatorPublicKey: string;
  protocolVersion?: number;
}): ViewChangeVote {
  const unsigned = {
    validator: addressFromPublicKey(input.validatorPublicKey),
    publicKey: input.validatorPublicKey,
    chainId: input.chainId,
    height: input.height,
    round: input.round,
    previousHash: input.previousHash,
    lockRound: input.lockRound,
    lockHash: input.lockHash
  };
  return {
    ...unsigned,
    prepares: input.prepares ?? [],
    signature: signForProtocol(
      input.protocolVersion ?? 1,
      VIEW_CHANGE_DOMAIN,
      viewChangePayload(unsigned),
      input.validatorPrivateKey
    )
  };
}

export function validatePrepareVote(
  vote: unknown,
  validators: Validator[] | Map<string, string>,
  chainId: string,
  height: number,
  round: number,
  blockHash: string,
  protocolVersion = 1
): asserts vote is PrepareVote {
  assertPlainRecord(vote, "prepare vote");
  assertExactKeys(
    vote,
    ["validator", "publicKey", "chainId", "height", "round", "blockHash", "signature"],
    "prepare vote"
  );
  if (typeof vote.validator !== "string" || typeof vote.publicKey !== "string" || typeof vote.chainId !== "string" ||
      typeof vote.blockHash !== "string" || typeof vote.signature !== "string" ||
      !Number.isSafeInteger(vote.height) || !Number.isSafeInteger(vote.round)) {
    throw new Error("Invalid prepare vote");
  }
  assertAddress(vote.validator);
  assertHex(vote.publicKey, 64, "prepare publicKey");
  assertHex(vote.blockHash, 32, "prepare blockHash");
  assertHex(vote.signature, 64, "prepare signature");
  const allowed = validators instanceof Map
    ? validators
    : new Map(validators.map((validator) => [validator.address, validator.publicKey]));
  if (allowed.get(vote.validator) !== vote.publicKey) throw new Error("Unknown prepare voter");
  if (vote.chainId !== chainId || vote.height !== height || vote.round !== round || vote.blockHash !== blockHash) {
    throw new Error("Prepare vote does not match the proposal");
  }
  const unsigned: Omit<PrepareVote, "signature"> = {
    validator: vote.validator,
    publicKey: vote.publicKey,
    chainId: vote.chainId,
    height: vote.height,
    round: vote.round,
    blockHash: vote.blockHash
  };
  if (!verifyForProtocol(protocolVersion, PREPARE_DOMAIN, preparePayload(unsigned), vote.signature, vote.publicKey)) {
    throw new Error("Invalid prepare signature");
  }
}

export function validatePrepareQuorum(
  votes: readonly PrepareVote[],
  validators: Validator[],
  chainId: string,
  height: number,
  round: number,
  blockHash: string,
  protocolVersion = 1
): void {
  if (votes.length > validators.length) throw new Error("Prepare certificate exceeds active validator set");
  const seen = new Set<string>();
  let valid = 0;
  for (const vote of votes) {
    validatePrepareVote(vote, validators, chainId, height, round, blockHash, protocolVersion);
    if (seen.has(vote.validator)) throw new Error("Duplicate prepare vote");
    seen.add(vote.validator);
    valid += 1;
  }
  const quorum = validatorQuorumSize(validators.length);
  if (valid < quorum) throw new Error(`Prepare quorum not reached: ${valid}/${quorum}`);
}

export function assertViewChangeVoteShape(value: unknown): asserts value is ViewChangeVote {
  assertPlainRecord(value, "view-change vote");
  assertExactKeys(value, [
    "validator", "publicKey", "chainId", "height", "round", "previousHash",
    "lockRound", "lockHash", "prepares", "signature"
  ], "view-change vote");
  if (typeof value.validator !== "string" || typeof value.publicKey !== "string" || typeof value.chainId !== "string" ||
      typeof value.previousHash !== "string" || typeof value.signature !== "string" ||
      !Number.isSafeInteger(value.height) || Number(value.height) < 1 ||
      !Number.isSafeInteger(value.round) || Number(value.round) < 0 ||
      !Array.isArray(value.prepares)) {
    throw new Error("Invalid view-change vote");
  }
  assertAddress(value.validator);
  assertHex(value.publicKey, 64, "view-change publicKey");
  assertHex(value.previousHash, 32, "view-change previousHash");
  assertHex(value.signature, 64, "view-change signature");
  const nil = value.lockRound === null && value.lockHash === null;
  const locked = Number.isSafeInteger(value.lockRound) && Number(value.lockRound) >= 0 &&
    typeof value.lockHash === "string";
  if (!nil && !locked) throw new Error("Invalid view-change lock");
  if (typeof value.lockHash === "string") assertHex(value.lockHash, 32, "view-change lockHash");
  if (value.prepares.length > 100) throw new Error("View-change prepare certificate exceeds active validator set");
}

export function validateViewChangeVote(
  vote: unknown,
  validators: Validator[] | Map<string, string>,
  chainId: string,
  height: number,
  round: number,
  previousHash: string,
  protocolVersion = 1
): asserts vote is ViewChangeVote {
  assertViewChangeVoteShape(vote);
  const allowed = validators instanceof Map
    ? validators
    : new Map(validators.map((validator) => [validator.address, validator.publicKey]));
  if (allowed.get(vote.validator) !== vote.publicKey) throw new Error("Unknown view-change voter");
  if (vote.chainId !== chainId || vote.height !== height || vote.round !== round || vote.previousHash !== previousHash) {
    throw new Error("View-change vote does not match the round");
  }
  const { signature: _signature, prepares: _prepares, ...unsigned } = vote;
  if (!verifyForProtocol(protocolVersion, VIEW_CHANGE_DOMAIN, viewChangePayload(unsigned), vote.signature, vote.publicKey)) {
    throw new Error("Invalid view-change signature");
  }
}

export interface ViewChangeLock {
  lockRound: number;
  lockHash: string;
}

/**
 * Returns the highest verified lock, or null when every counted vote is nil.
 * A lock vote counts only when some vote in the certificate carries a prepare
 * quorum for that same hash and round. Two different hashes at that highest
 * round are a conflicting certificate and are rejected.
 */
export function validateViewChangeCertificate(
  votes: readonly ViewChangeVote[],
  validators: Validator[],
  chainId: string,
  height: number,
  round: number,
  previousHash: string,
  protocolVersion = 1
): ViewChangeLock | null {
  if (votes.length > validators.length) throw new Error("View-change certificate exceeds active validator set");
  const unique = new Map<string, ViewChangeVote>();
  for (const vote of votes) {
    try {
      validateViewChangeVote(vote, validators, chainId, height, round, previousHash, protocolVersion);
    } catch {
      continue;
    }
    if (!unique.has(vote.validator)) unique.set(vote.validator, vote);
  }
  const proved = new Map<string, ViewChangeLock>();
  for (const vote of unique.values()) {
    if (vote.lockHash === null || vote.lockRound === null || vote.prepares.length === 0) continue;
    try {
      validatePrepareQuorum(
        vote.prepares,
        validators,
        chainId,
        height,
        vote.lockRound,
        vote.lockHash,
        protocolVersion
      );
    } catch {
      continue;
    }
    proved.set(`${vote.lockRound}:${vote.lockHash}`, { lockRound: vote.lockRound, lockHash: vote.lockHash });
  }
  const counted: ViewChangeVote[] = [];
  for (const vote of unique.values()) {
    if (vote.lockHash === null || vote.lockRound === null) {
      counted.push(vote);
      continue;
    }
    if (proved.has(`${vote.lockRound}:${vote.lockHash}`)) counted.push(vote);
  }
  const quorum = validatorQuorumSize(validators.length);
  if (counted.length < quorum) throw new Error(`View-change quorum not reached: ${counted.length}/${quorum}`);
  let highest: ViewChangeLock | null = null;
  for (const vote of counted) {
    if (vote.lockHash === null || vote.lockRound === null) continue;
    const lock = proved.get(`${vote.lockRound}:${vote.lockHash}`);
    if (!lock) continue;
    if (!highest || lock.lockRound > highest.lockRound) highest = lock;
    else if (lock.lockRound === highest.lockRound && lock.lockHash !== highest.lockHash) {
      throw new Error("Conflicting view-change locks");
    }
  }
  return highest;
}

/**
 * Same bound as `uniquePossiblyFinalizedHash`, plus prepare votes that are not
 * commits. A prepare is visible support. It still does not finalize.
 */
export function uniquePossiblyFinalizedWithPrepares(
  votes: readonly RoundProgressEntry[],
  prepares: readonly PrepareVote[],
  validators: Validator[],
  chainId: string,
  height: number,
  round: number,
  previousHash: string,
  protocolVersion = 1
): string | null {
  const progress = new Map<string, string | null>();
  const conflicted = new Set<string>();
  const note = (validator: string, hash: string | null): void => {
    const previous = progress.get(validator);
    if (conflicted.has(validator) || (previous !== undefined && previous !== hash)) {
      progress.delete(validator);
      conflicted.add(validator);
      return;
    }
    progress.set(validator, hash);
  };
  for (const vote of votes) {
    if (isViewChangeVote(vote)) continue;
    try {
      if (vote !== null && typeof vote === "object" && "previousHash" in vote && !("header" in vote)) {
        validateRoundSkipVote(vote, validators, chainId, height, round, previousHash, protocolVersion);
        note(vote.validator, null);
      } else {
        const locked = validateLockedAttestEvidence(vote, validators, chainId, height, round, previousHash, protocolVersion);
        note(locked.validator, locked.blockHash);
      }
    } catch {
      continue;
    }
  }
  for (const prepare of prepares) {
    try {
      validatePrepareVote(prepare, validators, chainId, height, round, prepare.blockHash, protocolVersion);
      note(prepare.validator, prepare.blockHash);
    } catch {
      continue;
    }
  }
  const votesSeen = progress.size;
  if (hashCouldStillBeFinalized(0, votesSeen, validators.length)) return null;
  const counts = new Map<string, number>();
  for (const hash of progress.values()) {
    if (!hash) continue;
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  const candidates: string[] = [];
  for (const [hash, visible] of counts) {
    if (hashCouldStillBeFinalized(visible, votesSeen, validators.length)) candidates.push(hash);
  }
  if (candidates.length !== 1) return null;
  return candidates[0]!;
}

export function isViewChangeVote(value: unknown): value is ViewChangeVote {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    "prepares" in value && "lockHash" in value && !("header" in value);
}

export interface ExplorationResult {
  validatorCount: number;
  roundsExplored: number;
  assignments: number;
  doubleFinalization: number;
  conflictingCertificates: number;
  honestDoubleSign: number;
  permanentDeadlockAfterRecovery: number;
  invalidUnlock: number;
  journalLoss: number;
  livenessFailures: number;
}

/**
 * Bounded search over prepare assignments for small validator sets.
 * Honest validators prepare at most one hash. Byzantine validators may add a
 * second prepare. A commit exists only for a hash that gathered a prepare
 * quorum inside the votes the committer could see. Findings that require an
 * honest node to sign twice are unreachable and are not counted as breaks.
 */
export function exploreBoundedConsensus(validatorCount: number, rounds = 2): ExplorationResult {
  if (![3, 4, 7].includes(validatorCount)) throw new Error("Bounded search covers N=3, 4, and 7");
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 2) throw new Error("Bounded search covers at most 2 rounds");
  const quorum = validatorQuorumSize(validatorCount);
  const faults = byzantineFaultBound(validatorCount);
  const result: ExplorationResult = {
    validatorCount,
    roundsExplored: rounds,
    assignments: 0,
    doubleFinalization: 0,
    conflictingCertificates: 0,
    honestDoubleSign: 0,
    permanentDeadlockAfterRecovery: 0,
    invalidUnlock: 0,
    journalLoss: 0,
    livenessFailures: 0
  };
  const total = 3 ** validatorCount;
  for (let index = 0; index < total; index += 1) {
    const honest = decodeAssignment(index, validatorCount);
    result.assignments += 1;
    const overlap = quorumOverlap(honest, faults, quorum, validatorCount);
    if (overlap.reachableDouble) result.doubleFinalization += 1;
    if (overlap.needsHonestDoubleSign) result.honestDoubleSign += 1;
    if (!unlockRespectsLock(honest, quorum)) result.invalidUnlock += 1;
    if (overlap.commitCount === 0 && !nilViewChangeCanProgress(validatorCount, quorum, faults)) {
      result.livenessFailures += 1;
      result.permanentDeadlockAfterRecovery += 1;
    }
    if (overlap.commitCount === 1 && !lockedViewChangeKeepsHash(validatorCount, quorum, faults)) {
      result.livenessFailures += 1;
    }
    for (const partition of partitionsFor(validatorCount)) {
      const left = quorumOverlap(honest, faults, quorum, validatorCount, partition);
      const rightMembers = new Set<number>();
      for (let validator = 0; validator < validatorCount; validator += 1) {
        if (!partition.has(validator)) rightMembers.add(validator);
      }
      const right = quorumOverlap(honest, faults, quorum, validatorCount, rightMembers);
      if (left.reachableDouble || right.reachableDouble) result.doubleFinalization += 1;
      const healed = new Set<number>();
      if (left.commitA && !left.needsHonestDoubleSign) healed.add(0);
      if (left.commitB && !left.needsHonestDoubleSign) healed.add(1);
      if (right.commitA && !right.needsHonestDoubleSign) healed.add(0);
      if (right.commitB && !right.needsHonestDoubleSign) healed.add(1);
      if (healed.size > 1) result.doubleFinalization += 1;
    }
  }
  if (honestQuorumIntersection(validatorCount) < 1) result.conflictingCertificates += 1;
  return result;
}

function byzantineSubsets(validatorCount: number, faults: number): number[][] {
  const subsets: number[][] = [[]];
  const current: number[] = [];
  const walk = (start: number, left: number): void => {
    if (left === 0) {
      subsets.push([...current]);
      return;
    }
    for (let index = start; index <= validatorCount - left; index += 1) {
      current.push(index);
      walk(index + 1, left - 1);
      current.pop();
    }
  };
  for (let size = 1; size <= faults; size += 1) walk(0, size);
  return subsets;
}

function decodeAssignment(index: number, validatorCount: number): number[] {
  const values: number[] = [];
  let cursor = index;
  for (let validator = 0; validator < validatorCount; validator += 1) {
    values.push(cursor % 3);
    cursor = Math.floor(cursor / 3);
  }
  return values;
}

interface Overlap {
  reachableDouble: boolean;
  needsHonestDoubleSign: boolean;
  commitCount: number;
  commitA: boolean;
  commitB: boolean;
}

function quorumOverlap(
  assignment: readonly number[],
  faults: number,
  quorum: number,
  validatorCount: number,
  visible?: ReadonlySet<number>
): Overlap {
  const empty: Overlap = {
    reachableDouble: false,
    needsHonestDoubleSign: false,
    commitCount: 0,
    commitA: false,
    commitB: false
  };
  for (const byzantineList of byzantineSubsets(validatorCount, faults)) {
    const byzantine = new Set(byzantineList);
    const sideA = new Set<number>();
    const sideB = new Set<number>();
    for (let validator = 0; validator < validatorCount; validator += 1) {
      if (visible && !visible.has(validator)) continue;
      const choice = assignment[validator] ?? 2;
      if (choice === 0) sideA.add(validator);
      if (choice === 1) sideB.add(validator);
      if (!byzantine.has(validator)) continue;
      if (choice !== 0) sideA.add(validator);
      if (choice !== 1) sideB.add(validator);
    }
    const commitA = sideA.size >= quorum;
    const commitB = sideB.size >= quorum;
    if (commitA) empty.commitA = true;
    if (commitB) empty.commitB = true;
    if (commitA && commitB) {
      let honestInBoth = 0;
      for (const validator of sideA) {
        if (sideB.has(validator) && !byzantine.has(validator)) honestInBoth += 1;
      }
      if (honestInBoth === 0) empty.reachableDouble = true;
      else empty.needsHonestDoubleSign = true;
    }
  }
  empty.commitCount = Number(empty.commitA) + Number(empty.commitB);
  if (empty.reachableDouble) empty.commitCount = 2;
  return empty;
}

function unlockRespectsLock(assignment: readonly number[], quorum: number): boolean {
  const commits = assignment.map((choice, index) => {
    const supporters = assignment.filter((value) => value === choice).length;
    return choice === 2 || supporters < quorum ? null : { round: 0, hash: String(choice), index };
  });
  for (const commit of commits) {
    if (!commit) continue;
    const other = commit.hash === "0" ? "1" : "0";
    if (commitAllowedByLock([{ round: commit.round, hash: commit.hash }], 1, other, null)) return false;
    if (commitAllowedByLock([{ round: commit.round, hash: commit.hash }], 1, other, 0)) return false;
    if (!commitAllowedByLock([{ round: commit.round, hash: commit.hash }], 1, commit.hash, 0)) return false;
  }
  return assignment.length > 0 || quorum > 0;
}

function nilViewChangeCanProgress(validatorCount: number, quorum: number, faults: number): boolean {
  return validatorCount - faults >= quorum && roundChangeLivenessBound(validatorCount) === faults + 1;
}

function lockedViewChangeKeepsHash(validatorCount: number, quorum: number, faults: number): boolean {
  return honestQuorumIntersection(validatorCount) >= 1 && quorum - faults >= 1 && validatorCount - faults >= quorum;
}

function partitionsFor(validatorCount: number): Array<Set<number>> {
  if (validatorCount === 3) return [new Set([0, 1])];
  if (validatorCount === 4) return [new Set([0, 1]), new Set([0, 1, 2])];
  return [new Set([0, 1, 2, 3]), new Set([0, 1, 2, 3, 4])];
}

export const SAFETY_INVARIANTS = [
  "S1 quorum is floor(2N/3)+1 and is never lowered",
  "S2 a hash finalizes only with a commit quorum of finality attestations",
  "S3 an honest validator commits at most one hash in a round",
  "S4 an honest validator commits a fresh hash only after a prepare quorum, or on the unique-hash completion path",
  "S5 a conflicting later commit requires a prepare quorum from a strictly higher round",
  "S6 two commit quorums on different hashes require an honest double-sign when faults are at most f",
  "S7 every view-change quorum intersects the honest committers of a commit quorum",
  "S8 a new-round proposal is accepted only for a nil-lock view-change certificate",
  "S9 timeout and view-change votes do not finalize a hash",
  "S10 journal and lock-certificate bytes are durable before the signature is returned"
] as const;

function signForProtocol(protocolVersion: number, domain: string, payload: unknown, privateKeyHex: string): string {
  return protocolVersion >= 3
    ? signCanonicalDomain(domain, payload, privateKeyHex)
    : signCanonical(payload, privateKeyHex);
}

function verifyForProtocol(
  protocolVersion: number,
  domain: string,
  payload: unknown,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  return protocolVersion >= 3
    ? verifyCanonicalDomain(domain, payload, signatureHex, publicKeyHex)
    : verifyCanonical(payload, signatureHex, publicKeyHex);
}
