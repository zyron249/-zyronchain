// P1-01: m-of-n activity-oracle approval (docs/ACTIVITY_ORACLE_GOVERNANCE.md).
//
// Before this change any single registered oracle key could settle an epoch
// (up to the 10,000 ZYN per closed 24 h epoch cap, docs/ACTIVITY_ORACLE_CAP.md).
// A genesis may now declare `activityOracleThreshold` = m (1 <= m <= n, where
// n = activityOracles.length). Under such a genesis a settlement is valid only
// when at least m DISTINCT registered oracle keys signed the same canonical
// settlement payload {chainId, sender, epoch, entries, receiptRoot}:
//   - the submitting oracle's transaction signature counts as one approval
//     (it signs the whole transaction, which contains the payload);
//   - every `oracleApprovals` entry from a registered key must verify over the
//     payload under the approval domain, otherwise the settlement is rejected;
//   - entries from unregistered keys are ignored; a key is counted once.
// Genesis files without `activityOracleThreshold` keep the old behaviour, the
// old transaction encoding and identical genesis hashes; they reject
// `oracleApprovals`. The per-epoch cap, window and ordering are unchanged.
//
// This file builds approvals and settlements with local helpers (no new
// library API) so that it compiles and fails against the code before the fix.
import assert from "node:assert/strict";
import test from "node:test";

import { createBlockAttestation, createSignedBlock } from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonical, signCanonicalDomain } from "../src/crypto.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import {
  createActivitySettlement,
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  validateTransactionShape
} from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type ActivityEntry, type GenesisConfig, type Transaction } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const EPOCH_MS = 86_400_000;
const CAP = 10_000 * ZYN;
const POOL = 5_000_000 * ZYN;
const APPROVAL_DOMAIN = "zyronchain/activity-settlement-approval/v1";
const SETTLEMENT_DOMAIN = "zyronchain/transaction/activity-settlement/v2";
const NOT_ENOUGH = /requires approvals from \d+ distinct registered activity oracles/;
const BAD_APPROVAL = /Invalid activity oracle approval signature/;
const UNAUTHORIZED = /Unauthorized activity oracle/;
const NO_THRESHOLD = /Activity oracle approvals require a genesis activityOracleThreshold/;
const OVER_CAP = /exceeds the per-epoch activity cap/;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 0x71;
const O1 = 0x72;
const FOUNDER = 0x73;
const PUBLIC_DISTRIBUTION = 0x74;
const LIQUIDITY = 0x75;
const ECOSYSTEM = 0x76; // also the activity pool
const O2 = 0x77;
const O3 = 0x78;
const OUTSIDER = 0x79; // never registered as an oracle
const ALICE = 0x7a;

function legacyGenesis(chainId: string, oracles = [O1]): GenesisConfig {
  return {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: oracles.map(pub),
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: 5_000_000 * ZYN },
      { address: addr(PUBLIC_DISTRIBUTION), amountAtoms: 20_000_000 * ZYN },
      { address: addr(LIQUIDITY), amountAtoms: 20_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: POOL }
    ]
  };
}

/** Genesis declaring m-of-n oracle approval over oracles O1, O2, O3. */
function thresholdGenesis(chainId: string, threshold: unknown, oracles = [O1, O2, O3]): GenesisConfig {
  return { ...legacyGenesis(chainId, oracles), activityOracleThreshold: threshold } as unknown as GenesisConfig;
}

const windowOf = (genesis: GenesisConfig, epoch: number, offsetMs = 60_000) =>
  genesis.timestampMs + (epoch + 1) * EPOCH_MS + offsetMs;

function finalizeBlock(chain: ZyronChain, txs: Transaction[], timestampMs: number): void {
  let block = chain.produceBlock(txs, key(VALIDATOR), { timestampMs });
  if (isConsensusV6(chain.protocolVersionAt(block.header.height))) {
    block.commitRound = 0;
    block.attestations = [{
      validator: addr(VALIDATOR),
      publicKey: pub(VALIDATOR),
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(VALIDATOR))
    }];
  } else {
    block = chain.attestBlock(block, key(VALIDATOR));
  }
  chain.acceptBlock(block, timestampMs);
}

function chainAtVersion(genesis: GenesisConfig, version: number): ZyronChain {
  const chain = new ZyronChain(genesis);
  if (version === 1) return chain;
  const input = { chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101, protocolVersion: version };
  const upgrade = createProtocolUpgrade({
    ...input,
    approvals: [createProtocolUpgradeApproval(input, key(VALIDATOR), pub(VALIDATOR))],
    timestampMs: genesis.timestampMs + 10
  }, key(VALIDATOR), pub(VALIDATOR));
  for (let height = 1; height <= 100; height += 1) {
    finalizeBlock(chain, height === 1 ? [upgrade] : [], genesis.timestampMs + height * 1_000);
  }
  assert.equal(chain.protocolVersionAt(chain.height + 1), version);
  return chain;
}

interface Payload { chainId: string; sender: string; epoch: number; entries: ActivityEntry[]; receiptRoot: string }

function payloadOf(genesis: GenesisConfig, epoch: number, amountAtoms: number): Payload {
  return {
    chainId: genesis.chainId,
    sender: genesis.activityPool,
    epoch,
    entries: [{ receiver: addr(ALICE), amountAtoms }],
    receiptRoot: "00".repeat(32)
  };
}

function approval(signer: number, payload: Payload) {
  return { publicKey: pub(signer), signature: signCanonicalDomain(APPROVAL_DOMAIN, payload, key(signer)) };
}

/**
 * Settlement submitted by `submitter`. `approvals === undefined` produces the
 * legacy encoding (no `oracleApprovals` key).
 */
function settlement(
  genesis: GenesisConfig,
  options: {
    epoch?: number; nonce?: number; amountAtoms?: number; txVersion: 1 | 2; submitter?: number;
    approvals?: Array<{ publicKey: string; signature: string }>;
  }
): Transaction {
  const payload = payloadOf(genesis, options.epoch ?? 0, options.amountAtoms ?? CAP);
  const submitter = options.submitter ?? O1;
  const unsigned: Record<string, unknown> = {
    kind: "activity_settlement",
    version: options.txVersion,
    chainId: payload.chainId,
    nonce: options.nonce ?? 1,
    sender: payload.sender,
    epoch: payload.epoch,
    entries: payload.entries,
    receiptRoot: payload.receiptRoot,
    feeAtoms: 0,
    timestampMs: genesis.timestampMs + 1,
    publicKey: pub(submitter)
  };
  if (options.approvals !== undefined) unsigned.oracleApprovals = options.approvals;
  const signature = options.txVersion === 2
    ? signCanonicalDomain(SETTLEMENT_DOMAIN, unsigned, key(submitter))
    : signCanonical(unsigned, key(submitter));
  const withSignature = { ...unsigned, signature };
  return { ...withSignature, txid: sha256Hex(canonicalJson(withSignature)) } as unknown as Transaction;
}

// The appliers gained an optional trailing oracle-context argument; call them
// through an untyped view so this file also compiles against the old code.
const ledgerApply = (genesis: GenesisConfig, tx: Transaction) => {
  const state = LedgerState.fromGenesis(genesis);
  (state.apply as unknown as (...args: unknown[]) => void).call(state, tx, genesis.activityPool, undefined, genesis);
  return state;
};
const sparseApply = (genesis: GenesisConfig, tx: Transaction) =>
  (applyStateV2Transaction as unknown as (...args: unknown[]) => unknown)(
    stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot()), tx, genesis.activityPool, undefined, genesis
  );

function smuggledBlock(chain: ZyronChain, genesis: GenesisConfig, version: number, tx: Transaction, timestampMs: number) {
  const block = createSignedBlock({
    version,
    chainId: genesis.chainId,
    height: chain.height + 1,
    round: 0,
    previousHash: chain.tip.hash,
    timestampMs,
    transactions: [tx],
    stateRoot: "00".repeat(32),
    proposerPrivateKey: key(VALIDATOR),
    proposerPublicKey: pub(VALIDATOR)
  });
  if (isConsensusV6(version)) {
    block.commitRound = 0;
    block.attestations = [{
      validator: addr(VALIDATOR),
      publicKey: pub(VALIDATOR),
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(VALIDATOR))
    }];
  } else {
    block.attestations.push(createBlockAttestation(block, key(VALIDATOR), pub(VALIDATOR)));
  }
  return block;
}

/** The settlement is refused on every consensus path. */
function assertRejectedEverywhere(
  chain: ZyronChain, genesis: GenesisConfig, version: number, tx: Transaction, blockTime: number, expected: RegExp, label: string
): void {
  const height = chain.height;
  assert.throws(() => chain.validateMempoolAdmission(tx, blockTime), expected, `${label}: mempool`);
  assert.throws(() => chain.validatePending([tx], blockTime), expected, `${label}: validatePending`);
  assert.deepEqual(chain.selectValidPending([tx], 10, undefined, blockTime), [], `${label}: selection`);
  assert.throws(() => chain.produceBlock([tx], key(VALIDATOR), { timestampMs: blockTime }), expected, `${label}: produceBlock`);
  assert.throws(() => ledgerApply(genesis, tx), expected, `${label}: LedgerState.apply`);
  assert.throws(() => sparseApply(genesis, tx), expected, `${label}: applyStateV2Transaction`);
  const block = smuggledBlock(chain, genesis, version, tx, blockTime);
  assert.throws(() => chain.validateProposal(block, blockTime), expected, `${label}: validateProposal`);
  assert.throws(() => chain.acceptBlock(block, blockTime), expected, `${label}: acceptBlock`);
  assert.equal(chain.height, height);
}

/** The settlement is admitted, selected, applied by both appliers and finalized. */
function assertAcceptedEverywhere(
  chain: ZyronChain, genesis: GenesisConfig, tx: Transaction, blockTime: number
): void {
  chain.validateMempoolAdmission(tx, blockTime);
  chain.validatePending([tx], blockTime);
  assert.deepEqual(chain.selectValidPending([tx], 10, undefined, blockTime).map((t) => t.txid), [tx.txid]);
  ledgerApply(genesis, tx);
  sparseApply(genesis, tx);
  const before = chain.balance(addr(ALICE));
  finalizeBlock(chain, [tx], blockTime);
  assert.equal(chain.balance(addr(ALICE)) - before, CAP);
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
}

for (const version of [1, 2, 3, 5, 6]) {
  const txVersion = version >= 3 ? 2 : 1;

  test(`ORACLE-MOFN v${version}: with m=2 a settlement signed by one oracle is rejected on every path`, () => {
    const genesis = thresholdGenesis(`zyron-mofn-single-v${version}`, 2);
    const chain = chainAtVersion(genesis, version);
    const blockTime = windowOf(genesis, 0);
    const payload = payloadOf(genesis, 0, CAP);
    // Legacy encoding: only the submitter's transaction signature.
    assertRejectedEverywhere(chain, genesis, version, settlement(genesis, { txVersion }), blockTime, NOT_ENOUGH, "no approvals");
    // An explicit approval list that is empty or carries only the submitter.
    assertRejectedEverywhere(chain, genesis, version, settlement(genesis, { txVersion, approvals: [approval(O1, payload)] }), blockTime, NOT_ENOUGH, "submitter only");
    assert.equal(chain.balance(genesis.activityPool), POOL);

    // A second registered oracle over the same payload makes it valid.
    assertAcceptedEverywhere(chain, genesis, settlement(genesis, { txVersion, approvals: [approval(O2, payload)] }), blockTime);
    assert.equal(chain.balance(genesis.activityPool), POOL - CAP);
  });

  test(`ORACLE-MOFN v${version}: a duplicate signer is counted once`, () => {
    const genesis = thresholdGenesis(`zyron-mofn-dup-v${version}`, 3);
    const chain = chainAtVersion(genesis, version);
    const blockTime = windowOf(genesis, 0);
    const payload = payloadOf(genesis, 0, CAP);
    for (const approvals of [
      [approval(O1, payload), approval(O1, payload)],
      [approval(O2, payload), approval(O2, payload)],
      [approval(O1, payload), approval(O2, payload), approval(O2, payload)]
    ]) {
      assertRejectedEverywhere(chain, genesis, version, settlement(genesis, { txVersion, approvals }), blockTime, NOT_ENOUGH, "duplicates");
    }
    assertAcceptedEverywhere(chain, genesis, settlement(genesis, { txVersion, approvals: [approval(O2, payload), approval(O3, payload)] }), blockTime);
  });

  test(`ORACLE-MOFN v${version}: approvals from unregistered keys are ignored`, () => {
    const genesis = thresholdGenesis(`zyron-mofn-outsider-v${version}`, 2);
    const chain = chainAtVersion(genesis, version);
    const blockTime = windowOf(genesis, 0);
    const payload = payloadOf(genesis, 0, CAP);
    // A valid signature by an unregistered key does not count.
    assertRejectedEverywhere(chain, genesis, version, settlement(genesis, { txVersion, approvals: [approval(OUTSIDER, payload)] }), blockTime, NOT_ENOUGH, "outsider");
    // An unregistered submitter is refused even with m registered approvals.
    assertRejectedEverywhere(chain, genesis, version,
      settlement(genesis, { txVersion, submitter: OUTSIDER, approvals: [approval(O1, payload), approval(O2, payload)] }),
      blockTime, UNAUTHORIZED, "outsider submitter");
    // An unregistered entry (even with a garbage signature) is ignored, not fatal.
    const garbage = { publicKey: pub(OUTSIDER), signature: "11".repeat(64) };
    assertAcceptedEverywhere(chain, genesis, settlement(genesis, { txVersion, approvals: [garbage, approval(O2, payload)] }), blockTime);
  });

  test(`ORACLE-MOFN v${version}: an approval over a different payload is rejected`, () => {
    const genesis = thresholdGenesis(`zyron-mofn-mismatch-v${version}`, 2);
    const chain = chainAtVersion(genesis, version);
    const blockTime = windowOf(genesis, 0);
    const right = payloadOf(genesis, 0, CAP);
    const mismatches: Array<[string, Payload]> = [
      ["amount", payloadOf(genesis, 0, CAP - 1)],
      ["epoch", { ...right, epoch: 1 }],
      ["receiver", { ...right, entries: [{ receiver: addr(OUTSIDER), amountAtoms: CAP }] }],
      ["receiptRoot", { ...right, receiptRoot: "11".repeat(32) }],
      ["chainId", { ...right, chainId: "zyron-other-chain" }],
      ["sender", { ...right, sender: addr(LIQUIDITY) }]
    ];
    for (const [name, wrong] of mismatches) {
      assertRejectedEverywhere(chain, genesis, version, settlement(genesis, { txVersion, approvals: [approval(O2, wrong)] }), blockTime, BAD_APPROVAL, name);
    }
    // Same payload signed without the approval domain (raw canonical) is not an approval either.
    const undomained = { publicKey: pub(O2), signature: signCanonical(right, key(O2)) };
    assertRejectedEverywhere(chain, genesis, version, settlement(genesis, { txVersion, approvals: [undomained] }), blockTime, BAD_APPROVAL, "no domain");
    assertAcceptedEverywhere(chain, genesis, settlement(genesis, { txVersion, approvals: [approval(O2, right)] }), blockTime);
  });

  test(`ORACLE-MOFN v${version}: the per-epoch cap, window and once-only rules are unchanged under m-of-n`, () => {
    const genesis = thresholdGenesis(`zyron-mofn-cap-v${version}`, 2);
    const chain = chainAtVersion(genesis, version);
    const blockTime = windowOf(genesis, 0);
    const over = payloadOf(genesis, 0, CAP + 1);
    const allThree = [approval(O1, over), approval(O2, over), approval(O3, over)];
    const overCap = settlement(genesis, { txVersion, amountAtoms: CAP + 1, approvals: allThree });
    assert.throws(() => validateTransactionShape(overCap), OVER_CAP);
    assertRejectedEverywhere(chain, genesis, version, overCap, blockTime, OVER_CAP, "over cap");
    const payload = payloadOf(genesis, 0, CAP);
    assertAcceptedEverywhere(chain, genesis, settlement(genesis, { txVersion, approvals: [approval(O2, payload)] }), blockTime);
    const replay = settlement(genesis, { txVersion, nonce: 2, approvals: [approval(O2, payload), approval(O3, payload)] });
    assert.throws(() => chain.validateMempoolAdmission(replay, blockTime + 1_000), /Activity epoch already settled/);
    const future = payloadOf(genesis, 1, CAP);
    assert.throws(
      () => chain.validateMempoolAdmission(settlement(genesis, { txVersion, epoch: 1, nonce: 2, approvals: [approval(O2, future)] }), blockTime + 1_000),
      /Activity epoch is not closed yet/
    );
    assert.equal(chain.balance(genesis.activityPool), POOL - CAP);
  });

  test(`ORACLE-MOFN v${version}: m=1 keeps single-oracle behaviour; legacy genesis rejects oracleApprovals`, () => {
    const one = thresholdGenesis(`zyron-mofn-one-v${version}`, 1);
    const oneChain = chainAtVersion(one, version);
    assertAcceptedEverywhere(oneChain, one, settlement(one, { txVersion, submitter: O3 }), windowOf(one, 0));

    const legacy = legacyGenesis(`zyron-mofn-legacy-v${version}`, [O1, O2]);
    const legacyChain = chainAtVersion(legacy, version);
    const blockTime = windowOf(legacy, 0);
    const payload = payloadOf(legacy, 0, CAP);
    assertRejectedEverywhere(legacyChain, legacy, version, settlement(legacy, { txVersion, approvals: [approval(O2, payload)] }), blockTime, NO_THRESHOLD, "legacy + approvals");
    assertAcceptedEverywhere(legacyChain, legacy, settlement(legacy, { txVersion, submitter: O2 }), blockTime);
  });
}

test("ORACLE-MOFN: genesis threshold must be an integer in 1..n", () => {
  for (const bad of [0, -1, 4, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ZyronChain(thresholdGenesis("zyron-mofn-bad-threshold", bad)), /Invalid activity oracle threshold/, String(bad));
  }
  for (const good of [1, 2, 3]) new ZyronChain(thresholdGenesis("zyron-mofn-good-threshold", good));
});

test("ORACLE-MOFN: oracleApprovals entries are strictly shaped and bounded", () => {
  const genesis = thresholdGenesis("zyron-mofn-shape", 2);
  const payload = payloadOf(genesis, 0, CAP);
  const good = approval(O2, payload);
  validateTransactionShape(settlement(genesis, { txVersion: 2, approvals: [good] }));
  for (const [name, approvals] of [
    ["empty list", []],
    ["extra key", [{ ...good, extra: 1 }]],
    ["missing signature", [{ publicKey: good.publicKey }]],
    ["short key", [{ ...good, publicKey: "02" }]],
    ["over 100 entries", Array.from({ length: 101 }, () => good)]
  ] as const) {
    assert.throws(
      () => validateTransactionShape(settlement(genesis, { txVersion: 2, approvals: approvals as unknown as Array<{ publicKey: string; signature: string }> })),
      /activity oracle approval/i,
      name
    );
  }
});

test("ORACLE-MOFN: legacy genesis hash and legacy settlement encoding are unchanged", () => {
  // Values computed on main 5994096 before this change.
  const genesis = legacyGenesis("zyron-oracle-legacy-pin");
  assert.equal(new ZyronChain(genesis).genesisHash, "44729f08cd07228aab7442a1195c759610bbef53310029dfc3d94c6cbd5359a7");
  const input = {
    chainId: genesis.chainId, nonce: 1, sender: genesis.activityPool, epoch: 0,
    entries: [{ receiver: addr(ALICE), amountAtoms: 1_000 }], receiptRoot: "00".repeat(32), timestampMs: genesis.timestampMs + 1
  };
  assert.equal(createActivitySettlement(input, key(O1), pub(O1), 1).txid, "47653779356838c9881dd9e1435f1661845cbd68541a9009d63bd61f819caf11");
  assert.equal(createActivitySettlement(input, key(O1), pub(O1), 2).txid, "d9a6bb6066e8c5956798b9ca8bdf833335edfd5b7ed0f00798652c1bf3c1cee2");
  assert.equal(Object.hasOwn(createActivitySettlement(input, key(O1), pub(O1), 2), "oracleApprovals"), false);
});
