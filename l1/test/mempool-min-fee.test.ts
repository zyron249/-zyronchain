// Red Team MEDIUM 2, option A: a node-level transfer-fee floor.
// Mempool and relay admission policy only. Block validity is unchanged: a
// zero-fee transfer inside a block still validates. Protocol txs are exempt,
// fixed-fee-v1 ignores the floor (the exact fee wins), the code default is 0
// (off), and an invalid value fails closed.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { expectedValidator, validatorQuorumSize } from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { FIXED_FEE_MISMATCH_MESSAGE, FIXED_TRANSFER_FEE_ATOMS } from "../src/fee-policy.js";
import * as mempoolModule from "../src/mempool.js";
import { Mempool, type MempoolOptions } from "../src/mempool.js";
import { NodeService, type NodeServiceOptions } from "../src/node-base.js";
import { defaultPublicDistributionRelease } from "../src/public-distribution-release.js";
import { ChainStore } from "../src/storage.js";
import { createProtocolUpgrade, createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type GenesisConfig, type Transaction } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const DAY = 86_400_000;
const FLOOR = 1_000;
const BELOW = /Transfer fee \d+ atoms is below this node's minimum transfer fee of 1000 atoms/;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR_IDS = [71, 80, 81, 82];
const PUBLIC_DISTRIBUTION = 74;
const ALICE = 90;

// Typed loosely so the failing-first run compiles against the pre-change code.
type Exports = {
  parseMempoolMinFeeAtoms?: (value: string | undefined, name?: string) => number | undefined;
  nodeTransferFeeAtoms?: (fixed: number | undefined, floor: number | undefined) => number;
  MEMPOOL_MIN_FEE_ENV?: string;
};
const exported = mempoolModule as unknown as Exports;
const floorPool = (floor: unknown, extra: Record<string, unknown> = {}) =>
  new Mempool(undefined, undefined, undefined, undefined, { minTransferFeeAtoms: floor, ...extra } as MempoolOptions);

function genesisFor(chainId: string, fixedTransferFeeAtoms?: number): GenesisConfig {
  const genesis: GenesisConfig = {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: VALIDATOR_IDS.map((id) => ({ address: addr(id), publicKey: pub(id) })),
    activityOracles: [pub(72), pub(78), pub(79)],
    activityOracleThreshold: 2,
    activityOraclePolicy: "threshold-v1",
    activityPool: addr(76),
    allocations: [
      { address: addr(73), amountAtoms: 5_000_000 * ZYN },
      { address: addr(PUBLIC_DISTRIBUTION), amountAtoms: 20_000_000 * ZYN },
      { address: addr(75), amountAtoms: 20_000_000 * ZYN },
      { address: addr(76), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(73), permanentLiquidity: addr(75) },
    publicDistributionRelease: defaultPublicDistributionRelease(addr(PUBLIC_DISTRIBUTION)),
    launchProfile: "fixed-supply-v1"
  };
  if (fixedTransferFeeAtoms !== undefined) genesis.feePolicy = { version: "fixed-fee-v1", fixedTransferFeeAtoms };
  return genesis;
}

function idFor(address: string): number {
  const id = [...VALIDATOR_IDS, PUBLIC_DISTRIBUTION, ALICE].find((candidate) => addr(candidate) === address);
  if (id === undefined) throw new Error("unexpected address");
  return id;
}

function finalize(chain: ZyronChain, txs: Transaction[], timestampMs: number) {
  const height = chain.height + 1;
  const validators = chain.validatorsAt(height);
  const proposer = expectedValidator(validators, height, 0);
  let block = chain.produceBlock(txs, key(idFor(proposer.address)), { timestampMs });
  const quorum = validators.slice(0, validatorQuorumSize(validators.length));
  if (isConsensusV6(chain.protocolVersionAt(block.header.height))) {
    block.commitRound = 0;
    block.attestations = quorum.map((validator) => ({
      validator: validator.address,
      publicKey: validator.publicKey,
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(idFor(validator.address)))
    }));
  } else {
    for (const validator of quorum) block = chain.attestBlock(block, key(idFor(validator.address)));
  }
  chain.acceptBlock(block, timestampMs);
  return block;
}

function transfer(chainId: string, nonce: number, feeAtoms: number, timestampMs = 1_700_000_000_000 + DAY - 1): Transaction {
  return createTransfer({
    chainId, nonce, sender: addr(PUBLIC_DISTRIBUTION), receiver: addr(ALICE), amountAtoms: 1_000, feeAtoms, timestampMs
  }, key(PUBLIC_DISTRIBUTION), pub(PUBLIC_DISTRIBUTION));
}

async function withService<T>(genesis: GenesisConfig, options: NodeServiceOptions, run: (service: NodeService) => T | Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zyron-min-fee-"));
  try {
    const store = await ChainStore.open(genesis, directory);
    return await run(new NodeService(store, undefined, undefined, options));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("MIN-FEE: a transfer below the floor is rejected with a clear error; at and above the floor it is admitted", () => {
  const pool = floorPool(FLOOR);
  assert.throws(() => pool.add(transfer("zyron-min-fee-a", 1, 0)), BELOW);
  assert.throws(() => pool.add(transfer("zyron-min-fee-a", 1, FLOOR - 1)), BELOW);
  assert.throws(() => pool.add(transfer("zyron-min-fee-a", 1, 0)), /resend with a fee of at least 1000 atoms \(CLI: --fee-atoms 1000\)/);
  assert.doesNotThrow(() => pool.add(transfer("zyron-min-fee-a", 1, FLOOR)));
  assert.doesNotThrow(() => pool.add(transfer("zyron-min-fee-a", 2, FLOOR + 1)));
  assert.equal(pool.size, 2);
});

test("MIN-FEE: floor 0 and an unset floor keep today's behaviour (zero-fee transfers admitted)", async () => {
  assert.doesNotThrow(() => floorPool(0).add(transfer("zyron-min-fee-0", 1, 0)));
  assert.doesNotThrow(() => new Mempool().add(transfer("zyron-min-fee-0", 1, 0)));
  await withService(genesisFor("zyron-min-fee-default"), {}, (service) => {
    assert.doesNotThrow(() => service.mempool.add(transfer("zyron-min-fee-default", 1, 0)));
  });
});

test("MIN-FEE: the node wires the floor into its mempool (single admission point for RPC and relay)", async () => {
  await withService(genesisFor("zyron-min-fee-node"), { mempoolMinTransferFeeAtoms: FLOOR } as NodeServiceOptions, (service) => {
    assert.throws(() => service.mempool.add(transfer("zyron-min-fee-node", 1, 0)), BELOW);
    assert.doesNotThrow(() => service.mempool.add(transfer("zyron-min-fee-node", 1, FLOOR)));
  });
});

test("MIN-FEE: protocol transactions are exempt from the floor", () => {
  const pool = floorPool(FLOOR);
  const upgrade = createProtocolUpgrade({
    chainId: "zyron-min-fee-protocol", nonce: 1, sender: addr(VALIDATOR_IDS[0]!), activationHeight: 100,
    protocolVersion: 99, timestampMs: 1_700_000_000_000, approvals: []
  }, key(VALIDATOR_IDS[0]!), pub(VALIDATOR_IDS[0]!));
  assert.notEqual(upgrade.kind, "transfer");
  assert.doesNotThrow(() => pool.add(upgrade));
});

test("MIN-FEE: invalid floor configuration fails closed", async () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1000"]) {
    assert.throws(() => floorPool(bad), /Invalid minimum transfer fee/, `mempool must refuse ${String(bad)}`);
    await assert.rejects(withService(genesisFor("zyron-min-fee-bad"), { mempoolMinTransferFeeAtoms: bad } as NodeServiceOptions, () => undefined),
      /Invalid minimum transfer fee/, `node must refuse ${String(bad)}`);
  }
  // Fails closed under fixed-fee-v1 as well, although the floor is ignored there.
  await assert.rejects(withService(genesisFor("zyron-min-fee-bad-v1", FIXED_TRANSFER_FEE_ATOMS), { mempoolMinTransferFeeAtoms: -1 } as NodeServiceOptions, () => undefined),
    /Invalid minimum transfer fee/);
  const parse = exported.parseMempoolMinFeeAtoms;
  assert.equal(typeof parse, "function", "parseMempoolMinFeeAtoms must be exported for the CLI and the faucet");
  assert.equal(exported.MEMPOOL_MIN_FEE_ENV, "ZYRON_MEMPOOL_MIN_FEE_ATOMS");
  assert.equal(parse!(undefined), undefined);
  assert.equal(parse!(""), undefined);
  assert.equal(parse!("0"), 0);
  assert.equal(parse!("1000"), 1_000);
  for (const bad of ["-1", "1.5", "01", " 1", "1e3", "0x10", "abc", "9007199254740993"]) {
    assert.throws(() => parse!(bad), /Invalid mempool-min-fee-atoms/, `parser must refuse ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parse!("x", "ZYRON_MEMPOOL_MIN_FEE_ATOMS"), /Invalid ZYRON_MEMPOOL_MIN_FEE_ATOMS/);
});

test("MIN-FEE: under fixed-fee-v1 the floor is ignored and the exact fee still applies", async () => {
  const chainId = "zyron-min-fee-v1";
  const genesis = genesisFor(chainId, FIXED_TRANSFER_FEE_ATOMS);
  const floorAboveFee = FIXED_TRANSFER_FEE_ATOMS * 10;
  const pool = floorPool(floorAboveFee, { fixedTransferFeeAtoms: FIXED_TRANSFER_FEE_ATOMS, disableFeeReplacement: true });
  assert.doesNotThrow(() => pool.add(transfer(chainId, 1, FIXED_TRANSFER_FEE_ATOMS)));
  assert.throws(() => pool.add(transfer(chainId, 2, floorAboveFee)), (error: Error) => error.message === FIXED_FEE_MISMATCH_MESSAGE);
  await withService(genesis, { mempoolMinTransferFeeAtoms: floorAboveFee } as NodeServiceOptions, (service) => {
    assert.doesNotThrow(() => service.mempool.add(transfer(chainId, 1, FIXED_TRANSFER_FEE_ATOMS)));
    assert.throws(() => service.mempool.add(transfer(chainId, 2, floorAboveFee)), (error: Error) => error.message === FIXED_FEE_MISMATCH_MESSAGE);
  });
});

test("MIN-FEE: a zero-fee transfer inside a received block still validates (no consensus change)", async () => {
  const chainId = "zyron-min-fee-block";
  const genesis = genesisFor(chainId);
  const when = genesis.timestampMs + DAY;
  const zeroFee = transfer(chainId, 1, 0);
  assert.throws(() => floorPool(FLOOR).add(zeroFee), BELOW);
  const chain = new ZyronChain(genesis);
  assert.doesNotThrow(() => chain.validatePending([zeroFee], when));
  const block = finalize(chain, [zeroFee], when);
  assert.equal(chain.height, 1);
  assert.equal(chain.balance(addr(ALICE)), 1_000);
  // The same block is accepted by a node whose mempool enforces the floor.
  await withService(genesis, { mempoolMinTransferFeeAtoms: FLOOR } as NodeServiceOptions, async (service) => {
    await service.acceptFinalizedBlock(block);
    assert.equal(service.store.chain.height, 1);
    assert.equal(service.store.chain.balance(addr(ALICE)), 1_000);
  });
});

test("MIN-FEE: the faucet fee builder meets the configured floor and its drip is admitted and mined", async () => {
  const feeFor = exported.nodeTransferFeeAtoms;
  assert.equal(typeof feeFor, "function", "nodeTransferFeeAtoms must be exported for the faucet");
  assert.equal(feeFor!(undefined, undefined), 0);
  assert.equal(feeFor!(undefined, FLOOR), FLOOR);
  assert.equal(feeFor!(FIXED_TRANSFER_FEE_ATOMS, FLOOR), FIXED_TRANSFER_FEE_ATOMS);
  const chainId = "zyron-min-fee-faucet";
  const genesis = genesisFor(chainId);
  const when = genesis.timestampMs + DAY;
  const drip = createTransfer({
    chainId, nonce: 1, sender: addr(PUBLIC_DISTRIBUTION), receiver: addr(ALICE), amountAtoms: 100 * ZYN,
    feeAtoms: feeFor!(undefined, FLOOR), timestampMs: when - 1
  }, key(PUBLIC_DISTRIBUTION), pub(PUBLIC_DISTRIBUTION));
  const pool = floorPool(FLOOR);
  assert.doesNotThrow(() => pool.add(drip));
  const chain = new ZyronChain(genesis);
  finalize(chain, [drip], when);
  assert.equal(chain.balance(addr(ALICE)), 100 * ZYN);
});
