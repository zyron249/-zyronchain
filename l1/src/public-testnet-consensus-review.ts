import {
  hashCouldStillBeFinalized,
  uncommittedAttestationRevealThreshold,
  validatorQuorumSize
} from "./block.js";

export const CONSENSUS_REVIEW_SIZES = [3, 4, 7] as const;

export interface DualHashObservation {
  validatorCount: number;
  votesSeen: number;
  visibleA: number;
  visibleB: number;
  reachableA: boolean;
  reachableB: boolean;
  unseenCanHideQuorum: boolean;
}

export function byzantineFaultBound(validatorCount: number): number {
  if (!Number.isSafeInteger(validatorCount) || validatorCount < 1) throw new Error("Invalid validator count");
  return Math.floor((validatorCount - 1) / 3);
}

export function enumerateDualHashObservations(validatorCount: number): DualHashObservation[] {
  const observations: DualHashObservation[] = [];
  for (let votesSeen = 0; votesSeen <= validatorCount; votesSeen += 1) {
    for (let visibleA = 0; visibleA <= votesSeen; visibleA += 1) {
      for (let visibleB = 0; visibleB <= votesSeen - visibleA; visibleB += 1) {
        if (visibleA === 0 && visibleB === 0) continue;
        observations.push({
          validatorCount,
          votesSeen,
          visibleA,
          visibleB,
          reachableA: visibleA > 0 && hashCouldStillBeFinalized(visibleA, votesSeen, validatorCount),
          reachableB: visibleB > 0 && hashCouldStillBeFinalized(visibleB, votesSeen, validatorCount),
          unseenCanHideQuorum: hashCouldStillBeFinalized(0, votesSeen, validatorCount)
        });
      }
    }
  }
  return observations;
}

/** Mirrors round-0 completion: one hash, and not an unseen hidden quorum. */
export function boundedCompletionChoice(observation: DualHashObservation): "A" | "B" | null {
  if (observation.unseenCanHideQuorum) return null;
  const reachable = [
    observation.reachableA ? "A" as const : undefined,
    observation.reachableB ? "B" as const : undefined
  ].filter((hash): hash is "A" | "B" => hash !== undefined);
  if (reachable.length !== 1) return null;
  return reachable[0] ?? null;
}

export interface ConsensusSizeReview {
  validatorCount: number;
  quorum: number;
  byzantineFaultBound: number;
  uncommittedRevealThreshold: number;
  bothHashesStillReachable: number;
  completionWhileBothReachable: number;
  livenessClass: "impossible-under-bound" | "possible-halt";
}

export function reviewConsensusSize(validatorCount: number): ConsensusSizeReview {
  const observations = enumerateDualHashObservations(validatorCount);
  const both = observations.filter((observation) => observation.reachableA && observation.reachableB);
  const unsafeCompletion = both.filter((observation) => boundedCompletionChoice(observation) !== null);
  return {
    validatorCount,
    quorum: validatorQuorumSize(validatorCount),
    byzantineFaultBound: byzantineFaultBound(validatorCount),
    uncommittedRevealThreshold: uncommittedAttestationRevealThreshold(validatorCount),
    bothHashesStillReachable: both.length,
    completionWhileBothReachable: unsafeCompletion.length,
    livenessClass: both.length === 0 ? "impossible-under-bound" : "possible-halt"
  };
}

export const ROUND0_DOUBLE_HASH_CLASSIFICATION = {
  activation: "BLOCKS PUBLIC TESTNET" as const,
  privateRehearsal: "ACCEPTABLE FOR LIMITED PRIVATE REHEARSAL ONLY" as const,
  safety: "No double-finalization in the bounded N=3,4,7 search. Completion is refused while two hashes can both still reach quorum.",
  liveness: "N=4 and N=7 can halt a round-0 height when two attested hashes both remain possibly final under the f-equivocation bound. N=3 has no such observation. Ordinary single-hash packet loss is not that case. Two attested blocks in one round is possible and is not an activation approval.",
  separatePullRequest: "A view-change or prepare/commit design belongs in a separate consensus PR. This deployment does not lower quorum or the reveal threshold."
};
