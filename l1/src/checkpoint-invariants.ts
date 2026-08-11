import { merkleRoot } from "./merkle.js";
import {
  cumulativeMiningIssuanceAtoms,
  MINING_TRACKER_ADDRESS,
  miningRewardAtoms
} from "./mining.js";
import type { LedgerState } from "./state.js";
import type { Block } from "./types.js";

export function validateTrustedCheckpointSemantics(input: {
  tip: Block;
  activeProtocolVersion: number;
  state: LedgerState;
  genesisSupplyAtoms: number;
}): void {
  const { tip, activeProtocolVersion, state, genesisSupplyAtoms } = input;

  if (tip.header.version !== activeProtocolVersion) {
    throw new Error("Trusted checkpoint tip protocol version mismatch");
  }
  if (tip.header.transactionRoot !== merkleRoot(tip.transactions)) {
    throw new Error("Trusted checkpoint transaction Merkle root mismatch");
  }

  if (state.balance(MINING_TRACKER_ADDRESS) !== 0) {
    throw new Error("Trusted checkpoint mining tracker balance must remain zero");
  }

  const claimCount = state.miningClaimCount();
  if (claimCount > 0 && miningRewardAtoms(claimCount - 1, genesisSupplyAtoms) === 0) {
    throw new Error("Trusted checkpoint mining claim counter exceeds reachable issuance history");
  }

  const historicalIssuedAtoms = genesisSupplyAtoms + cumulativeMiningIssuanceAtoms(claimCount, genesisSupplyAtoms);
  if (!Number.isSafeInteger(historicalIssuedAtoms) || state.totalSupplyAtoms() > historicalIssuedAtoms) {
    throw new Error("Trusted checkpoint current supply exceeds historical issuance");
  }
}
