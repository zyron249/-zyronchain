import { canonicalJson, sha256Hex } from "./codec.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type MiningClaimTx } from "./types.js";

/** Mining is consensus-valid only once protocol v4 is active. */
export const MINING_PROTOCOL_VERSION = 4;

/**
 * Issuance-only PoW difficulty. Mining does not select block proposers or replace
 * validator finality; it decides who earns the permissionless issuance reward.
 * A 20-bit target gives an expected 1,048,576 SHA-256 trials per solution.
 */
export const MINING_DIFFICULTY_BITS = 20;

/** 6.25 ZYN. At zero premine, each economic era contains ~4,000,000 claims. */
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

/**
 * Supply-driven halving schedule.
 *
 * Era 0 issues the first half of the 50M cap at 6.25 ZYN/claim. Every later
 * era issues half of the remaining cap at half the previous reward. Because
 * the era is derived from finalized total supply rather than block height,
 * an empty mining slot never destroys future issuance. The final reward is
 * clipped to the era/cap boundary, making MAX_SUPPLY_ATOMS an exact hard stop.
 */
export function miningEraForSupply(totalSupplyAtoms: number): number {
  assertSupply(totalSupplyAtoms);
  if (totalSupplyAtoms >= MAX_SUPPLY_ATOMS) return Number.MAX_SAFE_INTEGER;
  let era = 0;
  let eraSpan = Math.floor(MAX_SUPPLY_ATOMS / 2);
  let boundary = MAX_SUPPLY_ATOMS - eraSpan;
  while (eraSpan > 0 && totalSupplyAtoms >= boundary) {
    era += 1;
    eraSpan = Math.floor(eraSpan / 2);
    boundary = MAX_SUPPLY_ATOMS - eraSpan;
  }
  return era;
}

export function miningRewardAtoms(totalSupplyAtoms: number): number {
  assertSupply(totalSupplyAtoms);
  const capRemaining = MAX_SUPPLY_ATOMS - totalSupplyAtoms;
  if (capRemaining <= 0) return 0;

  let era = 0;
  let eraSpan = Math.floor(MAX_SUPPLY_ATOMS / 2);
  let boundary = MAX_SUPPLY_ATOMS - eraSpan;
  while (eraSpan > 0 && totalSupplyAtoms >= boundary) {
    era += 1;
    eraSpan = Math.floor(eraSpan / 2);
    boundary = MAX_SUPPLY_ATOMS - eraSpan;
  }

  const unclipped = Math.max(1, Math.floor(INITIAL_MINING_REWARD_ATOMS / (2 ** era)));
  const eraRemaining = Math.max(1, boundary - totalSupplyAtoms);
  return Math.min(unclipped, eraRemaining, capRemaining);
}

export function assertMiningClaimContext(
  tx: MiningClaimTx,
  input: { nextHeight: number; previousHash: string; totalSupplyAtoms: number }
): void {
  if (tx.height !== input.nextHeight) throw new Error("Mining claim targets wrong block height");
  if (tx.previousHash !== input.previousHash) throw new Error("Mining claim targets stale previous hash");
  const expectedReward = miningRewardAtoms(input.totalSupplyAtoms);
  if (expectedReward <= 0) throw new Error("ZYN maximum supply has been reached");
  if (tx.rewardAtoms !== expectedReward) throw new Error("Mining claim reward does not match issuance schedule");
  validateMiningWork(tx);
}

function assertSupply(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SUPPLY_ATOMS) {
    throw new Error("Invalid finalized ZYN supply");
  }
}
