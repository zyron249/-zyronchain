import { canonicalJson, sha256Hex } from "./codec.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type Address, type MiningClaimTx } from "./types.js";

/** Protocol v4 remains intentionally unsupported; mining activates in protocol v5. */
export const MINING_PROTOCOL_VERSION = 5;

/**
 * Consensus-owned zero-balance account used only as a persistent mining-claim
 * counter. No private key controls this address and ordinary transactions are
 * never allowed to spend from it.
 */
export const MINING_TRACKER_ADDRESS = `ZYN${"0".repeat(40)}` as Address;

/**
 * Issuance-only PoW difficulty. Mining does not select block proposers or replace
 * validator finality; it decides who earns the permissionless issuance reward.
 * A 20-bit target gives an expected 1,048,576 SHA-256 trials per solution.
 */
export const MINING_DIFFICULTY_BITS = 20;

/** 6.25 ZYN, halving every four million successful finalized claims. */
export const INITIAL_MINING_REWARD_ATOMS = 6.25 * ATOMS_PER_ZYN;
export const MINING_ERA_TARGET_CLAIMS = 4_000_000;
export const MINING_WORK_NONCE_HEX_LENGTH = 16;

export interface MiningWorkFields {
  chainId: string;
  nonce: number;
  sender: string;
  height: number;
  previousHash: string;
  rewardAtoms: number;
  workNonce: string;
  publicKey: string;
}

/**
 * The challenge is domain-separated and tip-bound, so work cannot be prepared
 * before the preceding finalized block is known or redirected to another miner.
 */
export function miningWorkPayload(input: MiningWorkFields): unknown {
  return {
    domain: "zyronchain/mining-work/v1",
    chainId: input.chainId,
    nonce: input.nonce,
    sender: input.sender,
    height: input.height,
    previousHash: input.previousHash,
    rewardAtoms: input.rewardAtoms,
    workNonce: input.workNonce,
    publicKey: input.publicKey
  };
}

export function miningWorkHash(input: MiningWorkFields): string {
  return sha256Hex(canonicalJson(miningWorkPayload(input)));
}

export function meetsMiningDifficulty(hashHex: string, bits = MINING_DIFFICULTY_BITS): boolean {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) return false;
  if (!Number.isSafeInteger(bits) || bits < 1 || bits > 255) return false;
  const targetExclusive = 1n << BigInt(256 - bits);
  return BigInt(`0x${hashHex}`) < targetExclusive;
}

export function validateMiningWork(tx: MiningClaimTx): void {
  const hash = miningWorkHash(tx);
  if (!meetsMiningDifficulty(hash)) {
    throw new Error(`Mining proof does not meet ${MINING_DIFFICULTY_BITS}-bit target`);
  }
}

export function miningEraForClaimCount(claimCount: number): number {
  assertClaimCount(claimCount);
  return Math.floor(claimCount / MINING_ERA_TARGET_CLAIMS);
}

/**
 * Historical mining issuance is derived only from the finalized claim counter,
 * never from current balances. Therefore transaction-fee burns stay permanently
 * burned and cannot reopen mining headroom.
 */
export function cumulativeMiningIssuanceAtoms(claimCount: number, genesisSupplyAtoms = 0): number {
  assertClaimCount(claimCount);
  assertGenesisSupply(genesisSupplyAtoms);
  const miningBudget = MAX_SUPPLY_ATOMS - genesisSupplyAtoms;
  let remainingClaims = claimCount;
  let reward = INITIAL_MINING_REWARD_ATOMS;
  let issued = 0;
  while (remainingClaims > 0 && issued < miningBudget) {
    const claimsInEra = Math.min(remainingClaims, MINING_ERA_TARGET_CLAIMS);
    const boundedReward = Math.max(1, reward);
    const eraPotential = claimsInEra * boundedReward;
    if (!Number.isSafeInteger(eraPotential)) throw new Error("Mining issuance overflow");
    const accepted = Math.min(eraPotential, miningBudget - issued);
    issued += accepted;
    remainingClaims -= claimsInEra;
    reward = Math.floor(reward / 2);
  }
  return issued;
}

/** Reward for the next successful claim under the immutable 50M historical cap. */
export function miningRewardAtoms(claimCount: number, genesisSupplyAtoms = 0): number {
  assertClaimCount(claimCount);
  assertGenesisSupply(genesisSupplyAtoms);
  const issued = cumulativeMiningIssuanceAtoms(claimCount, genesisSupplyAtoms);
  const remaining = MAX_SUPPLY_ATOMS - genesisSupplyAtoms - issued;
  if (remaining <= 0) return 0;
  const era = miningEraForClaimCount(claimCount);
  const scheduled = Math.max(1, Math.floor(INITIAL_MINING_REWARD_ATOMS / (2 ** era)));
  return Math.min(scheduled, remaining);
}

export function assertMiningClaimContext(
  tx: MiningClaimTx,
  input: { nextHeight: number; previousHash: string; claimCount: number; genesisSupplyAtoms: number }
): void {
  if (tx.height !== input.nextHeight) throw new Error("Mining claim targets wrong block height");
  if (tx.previousHash !== input.previousHash) throw new Error("Mining claim targets stale previous hash");
  const expectedReward = miningRewardAtoms(input.claimCount, input.genesisSupplyAtoms);
  if (expectedReward <= 0) throw new Error("ZYN maximum historical issuance has been reached");
  if (tx.rewardAtoms !== expectedReward) throw new Error("Mining claim reward does not match issuance schedule");
  validateMiningWork(tx);
}

function assertClaimCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid finalized mining claim count");
}

function assertGenesisSupply(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SUPPLY_ATOMS) {
    throw new Error("Invalid genesis ZYN supply");
  }
}
