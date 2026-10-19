// H3: a public-launch genesis cannot be moved by one oracle key.
//
// `launchProfile: "fixed-supply-v1"` requires `activityOraclePolicy: "threshold-v1"`
// (2-of-3 or stricter) and the reduced cap. Fail-closed checks reject duplicate
// signers, unknown keys, replayed signatures, stale or expired attestations and
// a wrong chain id. `activityOraclePolicy: "test-single-v1"` is the explicit
// dev/test profile and cannot be combined with the launch profile. Genesis
// files that omit the policy keep the historical single-oracle encoding.
// Validator-quorum pause and revoke follow the same delayed-activation model
// as validator_update. No real oracle key is used; every key is a test scalar.
import assert from "node:assert/strict";
import test from "node:test";

import { PUBLIC_LAUNCH_ACTIVITY_CAP_ATOMS } from "../src/activity.js";
import { expectedValidator, validatorQuorumSize } from "../src/block.js";
import {
  ACTIVITY_ORACLE_APPROVAL_REPLAY_MESSAGE,
  ACTIVITY_ORACLE_PAUSED_MESSAGE,
  ACTIVITY_ORACLE_POLICY_REQUIRED_MESSAGE,
  ACTIVITY_ORACLE_THRESHOLD_TOO_WEAK_MESSAGE,
  DUPLICATE_ACTIVITY_ORACLE_SIGNER_MESSAGE,
  EXPIRED_ACTIVITY_ORACLE_ATTESTATION_MESSAGE,
  REVOKED_ACTIVITY_ORACLE_MESSAGE,
  STALE_ACTIVITY_ORACLE_ATTESTATION_MESSAGE,
  UNKNOWN_ACTIVITY_ORACLE_MESSAGE,
  WRONG_ACTIVITY_ORACLE_CHAIN_MESSAGE
} from "../src/activity-oracle.js";
import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonicalDomain } from "../src/crypto.js";
import { assertMiningNotRetired } from "../src/mining.js";
import { defaultPublicDistributionRelease } from "../src/public-distribution-release.js";
import { LedgerState } from "../src/state.js";
import {
  applyStateV2Transaction,
  reconstructStateV2PortableView,
  stateV2FromLedgerSnapshot,
  stateV2KeyPreimages
} from "../src/state-v2.js";
import {
  createActivityOracleApprovalV2,
  createActivityOracleGovernance,
  createActivityOracleGovernanceApproval,
  createActivitySettlement,
  createMiningClaim,
  validateTransactionShape
} from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type ActivityEntry, type GenesisConfig } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const EPOCH_MS = 86_400_000;
const POOL = 5_000_000 * ZYN;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));

const VALIDATOR = 0x81;
const VALIDATOR_2 = 0x82;
const VALIDATOR_IDS = [VALIDATOR, 0x91, 0x92, 0x93];
const O1 = 0x83;
const O2 = 0x84;
const O3 = 0x85;
const O4 = 0x86;
const OUTSIDER = 0x87;
const FOUNDER = 0x88;
const PUBLIC_DISTRIBUTION = 0x89;
const LIQUIDITY = 0x8a;
const ECOSYSTEM = 0x8b;
const ALICE = 0x8c;

function base(chainId: string, oracles: number[]): GenesisConfig {
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
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) }
  };
}

function withLaunchValidators(genesis: GenesisConfig): GenesisConfig {
  return {
    ...genesis,
    validators: VALIDATOR_IDS.map((id) => ({ address: addr(id), publicKey: pub(id) }))
  };
}

function launch(chainId: string, threshold = 2, oracles = [O1, O2, O3], cap?: number): GenesisConfig {
  return {
    ...withLaunchValidators(base(chainId, oracles)),
    activityOracleThreshold: threshold,
    activityOraclePolicy: "threshold-v1",
    ...(cap === undefined ? {} : { activitySettlementCapAtoms: cap }),
    publicDistributionRelease: defaultPublicDistributionRelease(addr(PUBLIC_DISTRIBUTION)),
    launchProfile: "fixed-supply-v1"
  };
}

function signerId(address: string): number {
  const id = VALIDATOR_IDS.find((candidate) => addr(candidate) === address);
  if (id === undefined) throw new Error("unexpected validator");
  return id;
}

function finalize(chain: ZyronChain, txs: Parameters<ZyronChain["produceBlock"]>[0], timestampMs: number): void {
  const height = chain.height + 1;
  const validators = chain.validatorsAt(height);
  const proposer = expectedValidator(validators, height, 0);
  let block = chain.produceBlock(txs, key(signerId(proposer.address)), { timestampMs });
  for (const validator of validators.slice(0, validatorQuorumSize(validators.length))) {
    block = chain.attestBlock(block, key(signerId(validator.address)));
  }
  chain.acceptBlock(block, timestampMs);
}

function governanceTx(
  proposal: {
    chainId: string; nonce: number; sender: ReturnType<typeof addr>; activationHeight: number;
    action: "pause" | "resume" | "revoke"; publicKeys: string[];
  },
  timestampMs: number
) {
  const signers = VALIDATOR_IDS.slice(0, validatorQuorumSize(VALIDATOR_IDS.length));
  return createActivityOracleGovernance({
    ...proposal,
    approvals: signers.map((id) => createActivityOracleGovernanceApproval(proposal, key(id), pub(id))),
    timestampMs
  }, key(VALIDATOR), pub(VALIDATOR));
}

function expiresFor(genesis: GenesisConfig, epoch: number): number {
  return genesis.timestampMs + (epoch + 2) * EPOCH_MS - 1;
}

function settlement(
  genesis: GenesisConfig,
  options: {
    epoch?: number; nonce?: number; amountAtoms?: number; submitter?: number; approvers?: number[];
    chainId?: string; expiresAtMs?: number; omitExpiry?: boolean; noApprovals?: boolean;
    approvals?: Array<{ publicKey: string; signature: string }>;
  } = {}
) {
  const epoch = options.epoch ?? 0;
  const entries: ActivityEntry[] = [{ receiver: addr(ALICE), amountAtoms: options.amountAtoms ?? ZYN }];
  const chainId = options.chainId ?? genesis.chainId;
  const expiresAtMs = options.expiresAtMs ?? expiresFor(genesis, epoch);
  const payload = { chainId, sender: genesis.activityPool, epoch, entries, receiptRoot: "ab".repeat(32), expiresAtMs };
  const submitter = options.submitter ?? O1;
  const oracleApprovals = options.approvals ?? (options.noApprovals ? undefined : (options.approvers ?? [O2]).map((signer) =>
    createActivityOracleApprovalV2(payload, key(signer), pub(signer))));
  return createActivitySettlement({
    chainId, nonce: options.nonce ?? 1, sender: genesis.activityPool, epoch, entries,
    receiptRoot: payload.receiptRoot, timestampMs: genesis.timestampMs + 1,
    ...(options.omitExpiry ? {} : { attestationExpiresAtMs: expiresAtMs }),
    ...(oracleApprovals === undefined ? {} : { oracleApprovals })
  }, key(submitter), pub(submitter));
}

test("fixed-supply-v1 refuses a single oracle and the explicit test profile", () => {
  assert.throws(() => new ZyronChain({ ...withLaunchValidators(base("zyron-h3-single", [O1])), launchProfile: "fixed-supply-v1" }), { message: ACTIVITY_ORACLE_POLICY_REQUIRED_MESSAGE });
  assert.throws(() => new ZyronChain({
    ...withLaunchValidators(base("zyron-h3-test-profile", [O1])),
    activityOraclePolicy: "test-single-v1",
    launchProfile: "fixed-supply-v1"
  }), { message: ACTIVITY_ORACLE_POLICY_REQUIRED_MESSAGE });
  const missingRelease = launch("zyron-h3-no-release");
  delete missingRelease.publicDistributionRelease;
  assert.throws(() => new ZyronChain(missingRelease), /publicDistributionRelease/);
  const fewValidators = launch("zyron-h3-few-validators");
  fewValidators.validators = fewValidators.validators.slice(0, 3);
  assert.throws(() => new ZyronChain(fewValidators), /at least 4 and at most 100 distinct validators/);
  assert.throws(() => new ZyronChain(launch("zyron-h3-2of2", 2, [O1, O2])), { message: ACTIVITY_ORACLE_THRESHOLD_TOO_WEAK_MESSAGE });
  assert.throws(() => new ZyronChain(launch("zyron-h3-2of4", 2, [O1, O2, O3, O4])), { message: ACTIVITY_ORACLE_THRESHOLD_TOO_WEAK_MESSAGE });
  assert.throws(() => new ZyronChain(launch("zyron-h3-3of5", 3, [O1, O2, O3, O4, OUTSIDER])), { message: ACTIVITY_ORACLE_THRESHOLD_TOO_WEAK_MESSAGE });
  assert.throws(() => new ZyronChain(launch("zyron-h3-cap", 2, [O1, O2, O3], PUBLIC_LAUNCH_ACTIVITY_CAP_ATOMS + 1)), /Invalid activity settlement cap/);
  assert.doesNotThrow(() => new ZyronChain(launch("zyron-h3-2of3")));
  assert.doesNotThrow(() => new ZyronChain(launch("zyron-h3-3of4", 3, [O1, O2, O3, O4])));
  const explicit = new ZyronChain({
    ...base("zyron-h3-explicit-test", [O1]),
    activityOraclePolicy: "test-single-v1",
    activitySettlementCapAtoms: 50 * ZYN
  });
  const over = createActivitySettlement({
    chainId: explicit.genesis.chainId, nonce: 1, sender: explicit.genesis.activityPool, epoch: 0,
    entries: [{ receiver: addr(ALICE), amountAtoms: 51 * ZYN }],
    receiptRoot: "ab".repeat(32), timestampMs: explicit.genesis.timestampMs + 1
  }, key(O1), pub(O1));
  assert.throws(() => explicit.validatePending([over], explicit.genesis.timestampMs + EPOCH_MS + 1), /per-epoch activity cap/);
});

test("legacy genesis without a policy still accepts one oracle and rejects the new expiry field", () => {
  const genesis = base("zyron-h3-legacy", [O1]);
  const chain = new ZyronChain(genesis);
  const legacy = createActivitySettlement({
    chainId: genesis.chainId, nonce: 1, sender: genesis.activityPool, epoch: 0,
    entries: [{ receiver: addr(ALICE), amountAtoms: 10_000 * ZYN }],
    receiptRoot: "ab".repeat(32), timestampMs: genesis.timestampMs + 1
  }, key(O1), pub(O1));
  chain.validatePending([legacy], genesis.timestampMs + EPOCH_MS + 1);
  assert.throws(() => chain.validatePending([settlement(genesis)], genesis.timestampMs + EPOCH_MS + 1), /threshold-v1/);
});

test("threshold-v1 fail-closed: one key, duplicates, unknown keys, replay, stale, expired, wrong chain", () => {
  const genesis = launch("zyron-h3-fail-closed");
  const chain = new ZyronChain(genesis);
  const when = genesis.timestampMs + EPOCH_MS + 60_000;
  assert.throws(() => chain.validatePending([settlement(genesis, { noApprovals: true })], when), /requires approvals from 2/);
  assert.throws(() => chain.validatePending([settlement(genesis, { approvers: [O2, O2] })], when), { message: DUPLICATE_ACTIVITY_ORACLE_SIGNER_MESSAGE });
  assert.throws(() => chain.validatePending([settlement(genesis, { approvers: [O1] })], when), { message: DUPLICATE_ACTIVITY_ORACLE_SIGNER_MESSAGE });
  assert.throws(() => chain.validatePending([settlement(genesis, { approvers: [OUTSIDER] })], when), { message: UNKNOWN_ACTIVITY_ORACLE_MESSAGE });
  assert.throws(() => chain.validatePending([settlement(genesis, { expiresAtMs: genesis.timestampMs + EPOCH_MS - 1 })], when), { message: STALE_ACTIVITY_ORACLE_ATTESTATION_MESSAGE });
  assert.throws(() => chain.validatePending([
    settlement(genesis, { expiresAtMs: genesis.timestampMs + EPOCH_MS + 1_000 })
  ], genesis.timestampMs + EPOCH_MS + 2_000), { message: EXPIRED_ACTIVITY_ORACLE_ATTESTATION_MESSAGE });
  assert.throws(() => chain.validatePending([settlement(genesis, { chainId: "zyron-other-chain" })], when), new RegExp(`${WRONG_ACTIVITY_ORACLE_CHAIN_MESSAGE}|Wrong transaction chain ID`));
  const good = settlement(genesis);
  const repeated = settlement(genesis, {
    approvals: [good.oracleApprovals![0]!, { publicKey: pub(O3), signature: good.oracleApprovals![0]!.signature }]
  });
  assert.throws(() => chain.validatePending([repeated], when), { message: ACTIVITY_ORACLE_APPROVAL_REPLAY_MESSAGE });
  const wrongDomain = settlement(genesis, {
    approvals: [{
      publicKey: pub(O2),
      signature: signCanonicalDomain("zyronchain/activity-settlement-approval/v1", {
        chainId: genesis.chainId, sender: genesis.activityPool, epoch: 0, entries: good.entries, receiptRoot: good.receiptRoot
      }, key(O2))
    }]
  });
  assert.throws(() => chain.validatePending([wrongDomain], when), /Invalid activity oracle approval signature/);
  finalize(chain, [good], when);
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
  assert.equal(chain.balance(addr(ALICE)), ZYN);
  assert.throws(() => chain.validatePending([settlement(genesis, { nonce: 2 })], when + 1), /already settled/);
  assert.throws(() => validateTransactionShape(createMiningClaim({
    chainId: genesis.chainId, nonce: 1, sender: addr(ALICE), height: 1, previousHash: "11".repeat(32),
    rewardAtoms: ZYN, workNonce: "00".repeat(8), timestampMs: genesis.timestampMs
  }, key(ALICE), pub(ALICE))), /Mining is retired/);
  assert.throws(() => assertMiningNotRetired(), /Mining is retired/);
});

test("a configurable cap below the public-launch maximum is enforced", () => {
  const cap = 25 * ZYN;
  const genesis = launch("zyron-h3-lower-cap", 2, [O1, O2, O3], cap);
  const chain = new ZyronChain(genesis);
  const when = genesis.timestampMs + EPOCH_MS + 1;
  assert.throws(() => chain.validatePending([settlement(genesis, { amountAtoms: cap + 1 })], when), /per-epoch activity cap/);
  finalize(chain, [settlement(genesis, { amountAtoms: cap })], when);
  assert.equal(POOL - chain.balance(genesis.activityPool), cap);
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
});

test("validator quorum can pause, revoke and resume oracle keys", () => {
  const genesis = launch("zyron-h3-governance");
  const chain = new ZyronChain(genesis);
  const proposal = {
    chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101,
    action: "pause" as const, publicKeys: [] as string[]
  };
  const pause = governanceTx(proposal, genesis.timestampMs + 1);
  const tooSoon = { ...proposal, activationHeight: 50 };
  assert.throws(() => chain.validatePending([governanceTx(tooSoon, genesis.timestampMs + 1)]), /too soon/);
  assert.throws(() => chain.validateMempoolAdmission(createActivityOracleGovernance({
    chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR_2), activationHeight: 101,
    action: "pause", publicKeys: [],
    approvals: [createActivityOracleGovernanceApproval({
      chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR_2), activationHeight: 101, action: "pause", publicKeys: []
    }, key(VALIDATOR_2), pub(VALIDATOR_2))],
    timestampMs: genesis.timestampMs + 1
  }, key(VALIDATOR_2), pub(VALIDATOR_2))), /not active/);
  finalize(chain, [pause], genesis.timestampMs + 1_000);
  const snapshot = chain.snapshot();
  assert.equal(snapshot.version, 2);
  const restored = ZyronChain.fromTrustedSnapshot(genesis, snapshot, {
    tipHash: chain.tip.hash,
    snapshotSha256: sha256Hex(canonicalJson(snapshot))
  });
  assert.equal(restored.height, 1);
  assert.throws(() => restored.validateMempoolAdmission(pause), /too soon|activation height must increase|Invalid nonce/);
  for (let height = 2; height <= 100; height += 1) finalize(chain, [], genesis.timestampMs + height * 1_000);
  const when = genesis.timestampMs + EPOCH_MS + 60_000;
  assert.throws(() => chain.validatePending([settlement(genesis)], when), { message: ACTIVITY_ORACLE_PAUSED_MESSAGE });
  const revokeProposal = {
    chainId: genesis.chainId, nonce: 2, sender: addr(VALIDATOR), activationHeight: 201,
    action: "revoke" as const, publicKeys: [pub(O2)]
  };
  finalize(chain, [governanceTx(revokeProposal, genesis.timestampMs + 101_000)], genesis.timestampMs + 101_000);
  for (let height = 102; height <= 200; height += 1) finalize(chain, [], genesis.timestampMs + height * 1_000);
  const resumeProposal = {
    chainId: genesis.chainId, nonce: 3, sender: addr(VALIDATOR), activationHeight: 301,
    action: "resume" as const, publicKeys: [] as string[]
  };
  finalize(chain, [governanceTx(resumeProposal, genesis.timestampMs + 201_000)], genesis.timestampMs + 201_000);
  for (let height = 202; height <= 300; height += 1) finalize(chain, [], genesis.timestampMs + height * 1_000);
  assert.throws(() => chain.validatePending([settlement(genesis)], when), { message: REVOKED_ACTIVITY_ORACLE_MESSAGE });
  finalize(chain, [settlement(genesis, { approvers: [O3] })], when);
  assert.equal(chain.balance(addr(ALICE)), ZYN);
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
});

test("state v2 commits a pause under its own semantic key", () => {
  const genesis = launch("zyron-h3-state-v2");
  const proposal = {
    chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101,
    action: "pause" as const, publicKeys: [] as string[]
  };
  const pause = createActivityOracleGovernance({
    ...proposal,
    approvals: [createActivityOracleGovernanceApproval(proposal, key(VALIDATOR), pub(VALIDATOR))],
    timestampMs: genesis.timestampMs + 1
  }, key(VALIDATOR), pub(VALIDATOR));
  const governance = {
    validatorSchedule: [{ activationHeight: 0, validators: genesis.validators }],
    protocolSchedule: [{ activationHeight: 0, protocolVersion: 1 }],
    activityOracleGovernance: [{ activationHeight: 101, action: "pause" as const, publicKeys: [] as string[] }]
  };
  const ledger = LedgerState.fromGenesis(genesis);
  ledger.apply(pause, genesis.activityPool, undefined, genesis);
  const sparse = applyStateV2Transaction(
    stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot(), {
      validatorSchedule: governance.validatorSchedule,
      protocolSchedule: governance.protocolSchedule
    }),
    pause, genesis.activityPool, undefined, genesis
  );
  const view = reconstructStateV2PortableView(sparse, stateV2KeyPreimages(ledger.snapshot(), governance));
  assert.deepEqual(view.governance.activityOracleGovernance, governance.activityOracleGovernance);
  assert.equal(sparse.root(), stateV2FromLedgerSnapshot(ledger.snapshot(), governance).root());
});
