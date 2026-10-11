// F-01 protocol v6 (locked two-phase BFT with timeout certificates): the
// spec §11 schedules run against real NodeService instances with fsynced
// journals and consensus-state files, injected clocks and the in-memory
// transport with fault injection. The legacy versions of T1/T1b/T2 halt
// permanently (f01-legacy-split-characterization.test.ts, which passes on the
// base commit 8a07c0c); here the same schedules finalize under v6.
import assert from "node:assert/strict";
import test from "node:test";

import {
  V6_PREPARE_VOTE_DOMAIN,
  V6_TIMEOUT_GUARD_MS,
  roundStart,
  signV6,
  timeoutAllowedAt,
  votePayload,
  type V6PrepareRequest
} from "../src/consensus-v6.js";
import { validateBlockEnvelope } from "../src/block.js";
import { produceFinalizedBlock } from "../src/node.js";
import type { Block } from "../src/types.js";
import {
  ACTIVATION_HEIGHT,
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  journalRows,
  openValidator,
  proposerIndex,
  testNetwork,
  type TestNetworkConfig,
  type TestValidator
} from "./support/consensus-harness.js";

const H = ACTIVATION_HEIGHT;

interface Cluster {
  network: TestNetworkConfig;
  prefix: Block[];
  validators: TestValidator[];
  memory: MemoryNetwork;
  clock: number;
  tipMs: () => number;
}

async function cluster(n: number, firstKeyByte: number, chainId: string): Promise<Cluster> {
  const network = testNetwork(n, firstKeyByte, chainId);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  for (let index = 0; index < n; index += 1) validators.push(await openValidator(network, index, prefix));
  const state: Cluster = {
    network,
    prefix,
    validators,
    memory: undefined as unknown as MemoryNetwork,
    clock: 0,
    tipMs: () => validators[0]!.service.store.chain.tip.header.timestampMs
  };
  state.memory = new MemoryNetwork(validators, () => state.clock);
  return state;
}

/** The round-r leader acts `offsetMs` after roundStart(r) of the current height. */
async function lead(c: Cluster, round: number, offsetMs = 100, tipMs = c.tipMs()): Promise<Block | null> {
  const height = c.validators[0]!.service.store.chain.height + 1;
  c.clock = roundStart(tipMs, round) + offsetMs;
  const leader = proposerIndex(c.network, height, round);
  if (!c.memory.online[leader]) return null;
  return produceFinalizedBlock(c.validators[leader]!.service, c.memory.peersFor(leader), c.network.privateKeys[leader]!, c.clock);
}

function heights(c: Cluster): number[] {
  return c.validators.map((validator) => validator.service.status().height);
}

async function finalizedBlock(validator: TestValidator, height: number): Promise<Block | undefined> {
  const [block] = await validator.service.store.readFinalizedBlocks(height, 1, 8_000_000);
  return block?.header.height === height ? block : undefined;
}

async function finalizedHash(validator: TestValidator, height: number): Promise<string | undefined> {
  return (await finalizedBlock(validator, height))?.hash;
}

async function assertAgreement(c: Cluster, height: number): Promise<string> {
  const all = await Promise.all(c.validators.map((validator) => finalizedHash(validator, height)));
  const hashes = new Set(all.filter((hash) => hash !== undefined));
  assert.equal(hashes.size, 1, "validators disagree on the finalized block");
  return [...hashes][0]!;
}

function heal(c: Cluster): void {
  c.memory.drop = () => false;
  c.memory.beforeDeliver = () => {};
  for (let index = 0; index < c.memory.online.length; index += 1) c.memory.online[index] = true;
}

test("F-01 v6 happy path: n=4 finalizes consecutive heights in round 0 with a commit certificate", { timeout: 60_000 }, async () => {
  const c = await cluster(4, 0x71, "zyron-f01-v6-happy");
  try {
    for (let height = H; height < H + 3; height += 1) {
      const block = await lead(c, 0);
      assert.ok(block);
      assert.equal(block.header.version, 6);
      assert.equal(block.header.height, height);
      assert.equal(block.commitRound, 0);
      assert.deepEqual(block.roundCertificate, []);
      assert.equal(block.attestations.length, 4);
      const previous = await finalizedBlock(c.validators[0]!, height - 1);
      assert.ok(previous);
      validateBlockEnvelope(block, previous, c.validators[0]!.service.store.chain.validatorsAt(height), c.clock, true, 6);
      assert.deepEqual(heights(c), [height, height, height, height]);
      await assertAgreement(c, height);
    }
    // v2 journal rows only at v6 heights (no legacy attest/skip rows).
    for (const validator of c.validators) {
      for (const row of await journalRows(validator)) assert.match(row, /=(block-proposal|proposal|prepare|lock|commit|timeout)$/);
    }
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-01 v6 T1: n=2 crossing timeout/prepare at the round-0 boundary finalizes in round 1", { timeout: 60_000 }, async () => {
  const c = await cluster(2, 0x61, "zyron-f01-v6-t1");
  try {
    const tipMs = c.tipMs();
    const p0 = proposerIndex(c.network, H, 0);
    const p1 = proposerIndex(c.network, H, 1);
    assert.notEqual(p0, p1);
    let crossed = false;
    // Before the round-0 prepare request reaches p1, p1's clock passes the
    // timeout deadline of round 0 and it signs timeout(H, 0).
    c.memory.beforeDeliver = async (from, to, kind) => {
      if (from !== p0 || to !== p1 || kind !== "v6-prepare" || crossed) return;
      crossed = true;
      c.clock = timeoutAllowedAt(tipMs, 0) + 5;
      await c.validators[p1]!.service.v6Timeout(H, 0, c.clock);
    };
    const late = roundStart(tipMs, 1) - V6_TIMEOUT_GUARD_MS - 10 - roundStart(tipMs, 0);
    assert.equal(await lead(c, 0, late, tipMs), null);
    assert.ok(crossed);
    assert.ok(c.memory.errors.some((item) => /round already timed out/.test(item.message)));
    assert.deepEqual(await journalRows(c.validators[p1]!), [`${H}:0=timeout`]);
    // Legacy halts permanently here; v6 recovers with TC(H, 0) in round 1.
    heal(c);
    const block = await lead(c, 1, 100, tipMs);
    assert.ok(block);
    assert.equal(block.commitRound, 1);
    assert.equal(block.header.round, 1);
    assert.deepEqual(heights(c), [H, H]);
    await assertAgreement(c, H);
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-01 v6 T1b: n=2 peer offline for the round-0 attempt finalizes in round 1", { timeout: 60_000 }, async () => {
  const c = await cluster(2, 0x61, "zyron-f01-v6-t1");
  try {
    const tipMs = c.tipMs();
    const p1 = proposerIndex(c.network, H, 1);
    c.memory.online[p1] = false;
    assert.equal(await lead(c, 0, 7_000, tipMs), null);
    c.memory.online[p1] = true;
    const block = await lead(c, 1, 3_000, tipMs);
    assert.ok(block);
    assert.equal(block.commitRound, 1);
    await assertAgreement(c, H);
    assert.deepEqual(heights(c), [H, H]);
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-01 v6 T2: n=4 round-0 proposal reaching one peer, then a TC round, finalizes", { timeout: 60_000 }, async () => {
  const c = await cluster(4, 0x69, "zyron-f01-v6-t2");
  try {
    const tipMs = c.tipMs();
    const p0 = proposerIndex(c.network, H, 0);
    const p1 = proposerIndex(c.network, H, 1);
    const lucky = [0, 1, 2, 3].find((index) => index !== p0 && index !== p1)!;
    c.memory.drop = (from, to, kind) => from === p0 && kind === "v6-prepare" && to !== lucky;
    assert.equal(await lead(c, 0, 5_000, tipMs), null);
    const prepared = c.validators.filter((validator) => validator.journal.v6Row(H, 0, "prepare") !== undefined);
    assert.equal(prepared.length, 2);
    heal(c);
    const block = await lead(c, 1, 1_000, tipMs);
    assert.ok(block);
    assert.equal(block.commitRound, 1);
    assert.deepEqual(heights(c), [H, H, H, H]);
    await assertAgreement(c, H);
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-01 v6 T2b: a partial commit (one honest lock) is carried forward and the same block finalizes", { timeout: 60_000 }, async () => {
  const c = await cluster(4, 0x69, "zyron-f01-v6-t2");
  try {
    const tipMs = c.tipMs();
    const p0 = proposerIndex(c.network, H, 0);
    const p1 = proposerIndex(c.network, H, 1);
    const locked = [0, 1, 2, 3].find((index) => index !== p0 && index !== p1)!;
    // Round 0: everyone prepares (QC forms) but the commit request reaches only `locked`.
    c.memory.drop = (from, to, kind) => from === p0 && kind === "v6-commit" && to !== locked;
    assert.equal(await lead(c, 0, 5_000, tipMs), null);
    const round0Hash = c.validators[p0]!.journal.v6Row(H, 0, "proposal") === undefined ? undefined : c.validators[p0]!.journal.v6Lock(H)?.blockHash;
    assert.ok(round0Hash);
    assert.deepEqual(c.validators[locked]!.journal.v6Lock(H), { round: 0, blockHash: round0Hash });
    assert.deepEqual(c.validators[locked]!.service.v6Metrics(), { height: H, lockRound: 0, maxVoteRound: 0, maxTimeoutRound: -1 });
    // The round-0 leader crashes; the round-1 leader's TC must include a locked
    // validator (q-intersection), so it re-proposes the locked block.
    heal(c);
    c.memory.online[p0] = false;
    const block = await lead(c, 1, 1_000, tipMs);
    assert.ok(block);
    assert.equal(block.hash, round0Hash);
    assert.equal(block.header.round, 0);
    assert.equal(block.commitRound, 1);
    for (const index of [0, 1, 2, 3].filter((item) => item !== p0)) assert.equal(await finalizedHash(c.validators[index]!, H), round0Hash);
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-01 v6 T3: asymmetric partition across several rounds, then heal, finalizes a single block", { timeout: 60_000 }, async () => {
  const c = await cluster(4, 0x75, "zyron-f01-v6-t3");
  try {
    const tipMs = c.tipMs();
    // Asymmetric directed links: every validator can reach exactly one peer
    // (a leader gathers 2 < q = 3 votes) and the reachability graph changes
    // between rounds 0-1 and 2-3 (2 -> 0 works while 0 -> 2 does not, ...).
    const phase1 = new Set(["0>1", "1>0", "2>0", "3>1"]);
    const phase2 = new Set(["1>3", "3>2", "2>1", "0>3"]);
    for (let round = 0; round < 4; round += 1) {
      const allowed = round < 2 ? phase1 : phase2;
      c.memory.drop = (from, to) => !allowed.has(`${from}>${to}`);
      assert.equal(await lead(c, round, 1_000, tipMs), null);
    }
    const before = heights(c);
    heal(c);
    let finalizedRound: number | null = null;
    for (let round = 4; round < 8 && finalizedRound === null; round += 1) {
      const block = await lead(c, round, 1_000, tipMs);
      if (block) finalizedRound = block.commitRound ?? null;
    }
    assert.notEqual(finalizedRound, null);
    assert.ok(finalizedRound! >= 4);
    assert.deepEqual(before, [H - 1, H - 1, H - 1, H - 1]);
    assert.deepEqual(heights(c), [H, H, H, H]);
    await assertAgreement(c, H);
  } finally {
    await closeValidators(c.validators);
  }
});

for (const n of [4, 7]) {
  test(`F-01 v6 T4: n=${n} proposer crashes after a partial commit broadcast; the locked block is finalized`, { timeout: 90_000 }, async () => {
    const c = await cluster(n, 0x80 + n, `zyron-f01-v6-t4-n${n}`);
    try {
      const tipMs = c.tipMs();
      const p0 = proposerIndex(c.network, H, 0);
      const all = c.validators.map((_, index) => index);
      const f = Math.floor((n - 1) / 3);
      const receivers = all.filter((index) => index !== p0).slice(0, f);
      let sent = 0;
      // The commit request reaches f peers, then the leader crashes.
      c.memory.drop = (from, to, kind) => from === p0 && kind === "v6-commit" && !receivers.includes(to);
      c.memory.beforeDeliver = (from, _to, kind) => {
        if (from === p0 && kind === "v6-commit") sent += 1;
      };
      assert.equal(await lead(c, 0, 2_000, tipMs), null);
      assert.equal(sent, f);
      const lockedHash = c.validators[p0]!.journal.v6Lock(H)?.blockHash;
      assert.ok(lockedHash);
      for (const index of receivers) assert.equal(c.validators[index]!.journal.v6Lock(H)?.blockHash, lockedHash);
      heal(c);
      c.memory.online[p0] = false;
      let block: Block | null = null;
      for (let round = 1; round < 6 && !block; round += 1) block = await lead(c, round, 1_000, tipMs);
      assert.ok(block);
      assert.equal(block.hash, lockedHash);
      // The crashed proposer restarts from disk and accepts the finalized block.
      const crashed = c.validators[p0]!;
      crashed.journal.close();
      const restarted = await openValidator(c.network, p0, c.prefix, crashed.directory);
      c.validators[p0] = restarted;
      assert.deepEqual(restarted.journal.v6Lock(H), { round: 0, blockHash: lockedHash });
      await restarted.service.acceptFinalizedBlock(block);
      assert.equal(restarted.service.status().height, H);
      await assertAgreement(c, H);
    } finally {
      await closeValidators(c.validators);
    }
  });
}

test("F-01 v6 T5: a validator restarted while locked keeps its lock and refuses a conflicting unjustified block", { timeout: 60_000 }, async () => {
  const c = await cluster(4, 0x91, "zyron-f01-v6-t5");
  try {
    const tipMs = c.tipMs();
    const p0 = proposerIndex(c.network, H, 0);
    const p1 = proposerIndex(c.network, H, 1);
    const locked = [0, 1, 2, 3].find((index) => index !== p0 && index !== p1)!;
    const others = [0, 1, 2, 3].filter((index) => index !== p0 && index !== locked);
    c.memory.drop = (from, to, kind) => from === p0 && kind === "v6-commit" && to !== locked;
    assert.equal(await lead(c, 0, 2_000, tipMs), null);
    const lock = c.validators[locked]!.journal.v6Lock(H);
    assert.ok(lock);
    // Restart the locked validator (journal + consensus-state reloaded from disk).
    c.validators[locked]!.journal.close();
    c.validators[locked] = await openValidator(c.network, locked, c.prefix, c.validators[locked]!.directory);
    c.memory.validators[locked] = c.validators[locked];
    assert.deepEqual(c.validators[locked]!.journal.v6Lock(H), lock);
    // Round 1: the byzantine p0 (f = 1) signs timeout(H, 0) from a fresh
    // journal hiding its QC; with p1 and the third honest validator that is a
    // valid TC with highQC = null that omits the locked validator. p1 proposes
    // a fresh block, which the restarted locked validator refuses (SAFE-VOTE).
    const twin = await openValidator(c.network, p0, c.prefix);
    const original = c.validators[p0]!;
    try {
      c.memory.validators[p0] = twin;
      c.memory.drop = (_from, to, kind) => (to === locked && kind === "v6-timeout") || (to === p0 && kind !== "v6-timeout");
      const fresh = await lead(c, 1, 1_000, tipMs);
      assert.equal(fresh, null);
    } finally {
      c.memory.validators[p0] = original;
      await closeValidators([twin]);
    }
    const freshHash = c.validators[p1]!.journal.v6Row(H, 1, "block-proposal");
    assert.ok(freshHash);
    assert.notEqual(freshHash, lock.blockHash);
    assert.equal(c.validators[locked]!.journal.v6Row(H, 1, "prepare"), undefined);
    assert.ok(c.memory.errors.some((item) => item.to === locked && /conflicts with the validator's lock/.test(item.message)));
    for (const index of others) assert.equal(c.validators[index]!.journal.v6Row(H, 1, "prepare"), freshHash);
    // Round 2: the locked validator's timeout reports its QC; the lock is carried forward.
    heal(c);
    c.memory.online[p0] = false;
    let block: Block | null = null;
    for (let round = 2; round < 6 && !block; round += 1) block = await lead(c, round, 1_000, tipMs);
    assert.ok(block);
    assert.equal(block.hash, lock.blockHash);
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-01 v6 T5 (leader): a leader restarted after signing its proposal re-sends the identical proposal", { timeout: 60_000 }, async () => {
  const c = await cluster(4, 0x95, "zyron-f01-v6-t5l");
  try {
    const tipMs = c.tipMs();
    const p0 = proposerIndex(c.network, H, 0);
    c.memory.drop = (from, _to, kind) => from === p0 && kind === "v6-prepare";
    assert.equal(await lead(c, 0, 1_000, tipMs), null);
    const blockHash = c.validators[p0]!.journal.v6Row(H, 0, "block-proposal");
    const proposalDigest = c.validators[p0]!.journal.v6Row(H, 0, "proposal");
    assert.ok(blockHash && proposalDigest);
    c.validators[p0]!.journal.close();
    c.validators[p0] = await openValidator(c.network, p0, c.prefix, c.validators[p0]!.directory);
    c.memory.validators[p0] = c.validators[p0];
    // A new mempool / new timestamp would produce a different block; the
    // restarted leader must re-send the stored proposal instead.
    const stored = await c.validators[p0]!.service.v6StoredProposal(0, roundStart(tipMs, 0) + 9_000);
    assert.equal(stored.status, "ok");
    assert.equal(stored.status === "ok" ? stored.request.block.hash : undefined, blockHash);
    heal(c);
    const block = await lead(c, 0, 9_000, tipMs);
    assert.ok(block);
    assert.equal(block.hash, blockHash);
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-01 v6 T7: an equivocating proposer cannot finalize two blocks; forged justifications are refused", { timeout: 60_000 }, async () => {
  const c = await cluster(4, 0xa1, "zyron-f01-v6-t7");
  // The byzantine leader runs two NodeService instances with the same key and
  // separate journals, so it signs two different round-0 proposals.
  const p0 = proposerIndex(c.network, H, 0);
  const twin = await openValidator(c.network, p0, c.prefix);
  try {
    const tipMs = c.tipMs();
    const honest = [0, 1, 2, 3].filter((index) => index !== p0);
    const [a1, a2, b1] = honest as [number, number, number];
    const twinMemory = new MemoryNetwork(c.validators.map((validator, index) => index === p0 ? twin : validator), () => c.clock);
    c.memory.drop = (_from, to, kind) => kind === "v6-prepare" && to === b1;
    twinMemory.drop = (_from, to, kind) => kind === "v6-prepare" && to !== b1;
    c.clock = roundStart(tipMs, 0) + 500;
    const blockA = await produceFinalizedBlock(c.validators[p0]!.service, c.memory.peersFor(p0), c.network.privateKeys[p0]!, c.clock);
    // Different timestamp => different block B for the same (H, 0).
    c.clock += 1;
    const blockB = await produceFinalizedBlock(twin.service, twinMemory.peersFor(p0), c.network.privateKeys[p0]!, c.clock);
    assert.ok(blockA);
    assert.equal(blockB, null);
    // Now deliver B's request directly to A's voters: they refuse to vote twice in round 0.
    const requestB = await twin.service.v6StoredProposal(0, c.clock);
    assert.equal(requestB.status, "ok");
    if (requestB.status !== "ok") return;
    assert.notEqual(requestB.request.block.hash, blockA.hash);
    for (const index of [a1, a2]) {
      // They already finalized A (height moved on), so B targets a past height.
      await assert.rejects(c.validators[index]!.service.v6Prepare(structuredClone(requestB.request), c.clock));
    }
    for (const validator of c.validators) assert.equal(validator.service.status().height, H);
    await assertAgreement(c, H);
  } finally {
    await closeValidators([...c.validators, twin]);
  }
});

test("F-01 v6 T7: forged TC / highQC and conflicting same-round prepare are refused at the same height", { timeout: 60_000 }, async () => {
  const c = await cluster(4, 0xa9, "zyron-f01-v6-t7b");
  const p0 = proposerIndex(c.network, H, 0);
  const twin = await openValidator(c.network, p0, c.prefix);
  try {
    const tipMs = c.tipMs();
    const p1 = proposerIndex(c.network, H, 1);
    const voter = [0, 1, 2, 3].find((index) => index !== p0 && index !== p1)!;
    // Equivocation at one height: the voter prepares A, then refuses B.
    c.memory.drop = (_from, to, kind) => kind === "v6-prepare" && to !== voter;
    c.clock = roundStart(tipMs, 0) + 500;
    assert.equal(await produceFinalizedBlock(c.validators[p0]!.service, c.memory.peersFor(p0), c.network.privateKeys[p0]!, c.clock), null);
    c.clock += 7;
    const twinMemory = new MemoryNetwork(c.validators.map((validator, index) => index === p0 ? twin : validator), () => c.clock);
    twinMemory.drop = (_from, to, kind) => kind === "v6-prepare" && to !== voter;
    assert.equal(await produceFinalizedBlock(twin.service, twinMemory.peersFor(p0), c.network.privateKeys[p0]!, c.clock), null);
    assert.ok(twinMemory.errors.some((item) => item.to === voter && /Conflicting validator action prevented/.test(item.message)));
    const hashA = c.validators[voter]!.journal.v6Row(H, 0, "prepare");
    assert.equal(hashA, c.validators[p0]!.journal.v6Row(H, 0, "block-proposal"));

    // Round 1 (honest leader p1): build a genuine request, then tamper with it.
    heal(c);
    c.memory.drop = (from, _to, kind) => from === p1 && kind === "v6-prepare";
    assert.equal(await lead(c, 1, 1_000, tipMs), null);
    const stored = await c.validators[p1]!.service.v6StoredProposal(1, c.clock);
    assert.equal(stored.status, "ok");
    if (stored.status !== "ok") return;
    const genuine = stored.request;
    const target = c.validators[[0, 1, 2, 3].find((index) => index !== p1 && index !== voter && index !== p0)!]!;
    // (a) TC with a duplicated timeout vote (below quorum).
    const dupTc = structuredClone(genuine);
    assert.ok(dupTc.tc);
    dupTc.tc.votes = [dupTc.tc.votes[0]!, dupTc.tc.votes[0]!, dupTc.tc.votes[0]!];
    await assert.rejects(target.service.v6Prepare(dupTc, c.clock));
    // (b) Forged highQC: prepare votes signed over another hash.
    const forged: V6PrepareRequest = structuredClone(genuine);
    assert.ok(forged.tc);
    forged.tc.highQC = {
      chainId: c.network.chainId,
      height: H,
      round: 0,
      blockHash: "ab".repeat(32),
      votes: c.network.privateKeys.slice(0, 3).map((key, index) => ({
        validator: c.network.genesis.validators[index]!.address,
        publicKey: c.network.publicKeys[index]!,
        signature: signV6(V6_PREPARE_VOTE_DOMAIN, votePayload(c.network.chainId, H, 0, "cd".repeat(32)), key)
      }))
    };
    await assert.rejects(target.service.v6Prepare(forged, c.clock));
    // (c) Proposal for round 1 without any TC.
    const noTc = structuredClone(genuine);
    noTc.tc = null;
    await assert.rejects(target.service.v6Prepare(noTc, c.clock), /missing the timeout certificate/);
    // (d) Proposal signed by a non-leader key.
    const wrongSigner = structuredClone(genuine);
    wrongSigner.proposal.signature = signV6("zyronchain/consensus-proposal/v1", { ...genuine.proposal, signature: undefined }, c.network.privateKeys[voter]!);
    await assert.rejects(target.service.v6Prepare(wrongSigner, c.clock));
    // The genuine request is still accepted by the same validator.
    const vote = await target.service.v6Prepare(structuredClone(genuine), c.clock);
    assert.equal(vote.publicKey, c.network.publicKeys[target.index]);
  } finally {
    await closeValidators([...c.validators, twin]);
  }
});

test("F-01 v6 T8: clock skew within the guard still finalizes; a validator refuses to time out early", { timeout: 90_000 }, async () => {
  const c = await cluster(4, 0xb1, "zyron-f01-v6-t8");
  try {
    c.memory.skewMs.set(0, 1_500);
    c.memory.skewMs.set(1, -1_500);
    c.memory.skewMs.set(2, 900);
    for (let height = H; height < H + 4; height += 1) {
      const tipMs = c.tipMs();
      const leader = proposerIndex(c.network, height, 0);
      // Leader acts at its own (skewed) roundStart(0).
      const block = await lead(c, 0, 100 - (c.memory.skewMs.get(leader) ?? 0), tipMs);
      assert.ok(block, `height ${height}`);
      await assertAgreement(c, height);
    }
    // A timeout request that arrives before the validator's local deadline is refused.
    const tipMs = c.tipMs();
    const height = H + 4;
    const early = timeoutAllowedAt(tipMs, 0) - 1;
    await assert.rejects(c.validators[3]!.service.v6Timeout(height, 0, early), /deadline has not elapsed/);
    const vote = await c.validators[3]!.service.v6Timeout(height, 0, early + 1);
    assert.equal(vote.vote.round, 0);
    // A slow-clock leader of round 1 still assembles a TC once q validators reached the deadline.
    c.memory.skewMs.clear();
    const block = await lead(c, 1, 0, tipMs);
    assert.ok(block);
    assert.equal(block.commitRound, 1);
  } finally {
    await closeValidators(c.validators);
  }
});
