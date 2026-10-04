// Phase 0 / T9 / T12: executable validation of the protocol-v6 design
// (F01_CONSENSUS_DESIGN.md R1-R9) with the independent model in
// test/support/consensus-v6-model.ts.
import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHEDULE_PROFILES,
  V6Model,
  runRandomSchedules,
  searchCounterexample,
  type ModelConfig,
  type QC
} from "./support/consensus-v6-model.js";

// Per-PR smoke size (§16.6); the nightly >= 10 000 run uses the same entry
// point through ZYRON_V6_MODEL_SCHEDULES.
const SMOKE_SCHEDULES = Number(process.env.ZYRON_V6_MODEL_SCHEDULES ?? 2_000);

interface ScriptNode {
  id: number;
  up: boolean;
  permanentlyDown: boolean;
  journal: { lock: { round: number; value: string } | null; prepare: Map<number, string>; commit: Map<number, string> };
  highQC: QC | null;
}

function scripted(config: Partial<ModelConfig> & { n: number; byzantine: number[] }) {
  const model = new V6Model({
    seed: 7,
    gstMs: 0,
    preGstDropRate: 0,
    preGstMaxDelayMs: 1,
    crashRestart: false,
    partitions: false,
    linkFailureRate: 0,
    byzantineSilent: true,
    ...config
  });
  const access = model.scripted();
  const nodes = access.nodes as ScriptNode[];
  const at = (t: number): void => access.setNow(t);
  const prepare = (to: number[], from: number, round: number, value: string, justify: QC | null = null, tc: unknown = null): void => {
    for (const id of to) access.deliver(id, { kind: "prepare", from, round, value, justify, tc });
  };
  const commit = (to: number[], qc: QC): void => {
    for (const id of to) access.deliver(id, { kind: "commit", from: 0, round: qc.round, qc });
  };
  const requestTimeouts = (to: number[], from: number, round: number): void => {
    at(access.roundEnd(round));
    for (const id of to) access.deliver(id, { kind: "timeout-req", from, round });
  };
  const tcFrom = (round: number, honest: number[], byzantineClaims: Array<{ from: number; hr: number; hv: string; qc: QC | null }> = []) => {
    const claims = access.timeoutClaims(round).filter((claim) => honest.includes(claim.from));
    assert.equal(claims.length, honest.length, "every requested honest validator signed a timeout");
    const votes = [...claims, ...byzantineClaims.map((claim) => ({ ...claim, round }))];
    let highQC: QC | null = null;
    for (const vote of votes) if (vote.qc && (!highQC || vote.qc.round > highQC.round)) highQC = vote.qc;
    return {
      tc: { round, votes: votes.map(({ qc: _qc, ...claim }) => claim), highQC },
      highQC
    };
  };
  return { model, access, nodes, at, prepare, commit, requestTimeouts, tcFrom };
}

test("T9 randomized adversarial schedules preserve S1/S2/S3 and bounded finality after GST", () => {
  const summary = runRandomSchedules(SMOKE_SCHEDULES, 1);
  assert.deepEqual(summary.failures, [], `failing seeds: ${JSON.stringify(summary.failures.slice(0, 5))}`);
  assert.equal(summary.schedules, SMOKE_SCHEDULES);
  // Every profile is exercised and liveness was asserted for the bulk of them.
  assert.equal(Object.keys(summary.byProfile).length, SCHEDULE_PROFILES.length);
  assert.ok(summary.livenessChecked > SMOKE_SCHEDULES / 2, `liveness checked in ${summary.livenessChecked} schedules`);
  assert.ok(summary.decided >= summary.livenessChecked);
});

test("T9 safety holds when validators do not enforce the leader obligation (§7 uses only the lock rules)", () => {
  const summary = runRandomSchedules(Math.max(500, Math.floor(SMOKE_SCHEDULES / 2)), 50_001, { checkLeaderRule: false });
  assert.deepEqual(summary.failures.filter((failure) => failure.violations.some((v) => /^S[123]/.test(v))), []);
});

test("T9 safety holds with clock skew far beyond the guard and lost QC files (liveness not asserted)", () => {
  const summary = runRandomSchedules(Math.max(500, Math.floor(SMOKE_SCHEDULES / 2)), 90_001, {
    skewMs: [-60_000, 45_000, 0, 30_000, -15_000, 90_000, -5_000],
    qcLossOnRestart: 0.5,
    crashRestart: true,
    checkLiveness: false
  });
  assert.deepEqual(summary.failures, []);
});

test("T12 model mutations are detected (lock check, commit without QC, cross-round counting, one-phase)", () => {
  const cases: Array<[string, Partial<ModelConfig>]> = [
    ["commit-without-qc", { mutation: "commit-without-qc" }],
    ["no-lock-check (leader rule not enforced)", { mutation: "no-lock-check", checkLeaderRule: false }],
    ["commit-without-qc (leader rule not enforced)", { mutation: "commit-without-qc", checkLeaderRule: false }],
    ["non-strict-unlock + two-prepare-values", { mutation: "non-strict-unlock+two-prepare-values", checkLeaderRule: false }],
    ["one-phase variant with unlock-on-report", { variant: "one-phase-unlock" }],
    ["one-phase variant with strict single-attestation lock", { variant: "one-phase-strict" }],
    ["legacy timeout/skip exclusive with an earlier vote (F-01 root cause)", { mutation: "timeout-exclusive-with-vote" }]
  ];
  for (const [name, overrides] of cases) {
    const found = searchCounterexample(20_000, overrides);
    assert.ok(found, `mutation "${name}" was not detected`);
  }
});

test("T12 single non-strict-unlock and single two-prepare-values are masked by the other rule (documented spec correction)", () => {
  // With L1 intact, justifyRound == lock.round implies the same value, so a
  // non-strict unlock changes nothing; with the strict unlock intact, a second
  // same-round QC cannot release a lock. Only the combination is unsafe.
  for (const mutation of ["non-strict-unlock", "two-prepare-values"] as const) {
    assert.equal(searchCounterexample(3_000, { mutation, checkLeaderRule: false }), null, mutation);
  }
});

test("T12 cross-round commit counting yields conflicting finality on a scripted schedule (and the real rule does not)", () => {
  for (const mutation of ["cross-round-commit-count", "none"] as const) {
    // n=4, q=3, v3 Byzantine. Leaders: r0 v0, r1 v1, r2 v2, r3 v3.
    const s = scripted({ n: 4, byzantine: [3], mutation, checkLiveness: false });
    const { access, nodes } = s;
    s.at(access.roundStart(0));
    s.prepare([0, 1, 2], 0, 0, "X");
    const qc0 = access.adversaryQC(0, "X")!;
    s.commit([0], qc0); // only the round-0 leader commits X@0
    s.requestTimeouts([1, 2], 1, 0);
    const r1 = s.tcFrom(0, [1, 2], [{ from: 3, hr: -1, hv: "", qc: null }]);
    assert.equal(r1.highQC, null);
    s.at(access.roundStart(1));
    s.prepare([0, 1, 2], 1, 1, "Y", null, r1.tc);
    assert.equal(nodes[0]!.journal.prepare.get(1), undefined, "v0 is locked on X and refuses Y");
    const qc1 = access.adversaryQC(1, "Y")!;
    s.commit([1], qc1); // v1 commits Y@1
    s.requestTimeouts([0, 2], 2, 1);
    const r2 = s.tcFrom(1, [0, 2], [{ from: 3, hr: -1, hv: "", qc: null }]);
    assert.equal(r2.highQC?.value, "X");
    s.at(access.roundStart(2));
    s.prepare([0, 1, 2], 2, 2, "X", r2.highQC, r2.tc);
    assert.equal(nodes[1]!.journal.prepare.get(2), undefined, "v1 is locked on Y@1 and refuses X with justify round 0");
    const qc2 = access.adversaryQC(2, "X")!;
    s.commit([2], qc2); // v2 commits X@2
    s.requestTimeouts([0, 1], 3, 2);
    const r3 = s.tcFrom(2, [0, 1], [{ from: 3, hr: -1, hv: "", qc: null }]);
    assert.equal(r3.highQC?.value, "Y");
    s.at(access.roundStart(3));
    s.prepare([0, 1, 2], 3, 3, "Y", r3.highQC, r3.tc);
    const qc3 = access.adversaryQC(3, "Y")!;
    s.commit([0, 1], qc3); // Y is final at round 3 (v0, v1, v3)
    const result = access.finish();
    if (mutation === "none") {
      assert.ok(result.ok, result.violations.join("; "));
      assert.deepEqual(result.finalizable.map((item) => item.value), ["Y"]);
    } else {
      assert.ok(result.violations.some((v) => v.startsWith("S3")), "cross-round counting must be caught");
    }
  }
});

test("§5.4 counterexample: one-phase designs either finalize conflicting blocks or halt; v6 two-phase is safe and live", () => {
  // n=4, q=3, v0 Byzantine and round-0 leader; v1 leads round 1.
  // Unlock-on-report variant: safety violation.
  {
    const s = scripted({ n: 4, byzantine: [0], variant: "one-phase-unlock" });
    s.at(s.access.roundStart(0));
    s.prepare([1, 2], 0, 0, "B");
    s.prepare([3], 0, 0, "B'");
    assert.deepEqual(s.access.finalizable().map((item) => item.value), ["B"], "B is final (v1, v2, v0); v0 keeps it private");
    s.requestTimeouts([1, 3], 1, 0);
    const report = { round: 0, value: "B'", signers: [0] };
    const { tc } = s.tcFrom(0, [1, 3], [{ from: 0, hr: 0, hv: "B'", qc: report }]);
    // Count rule at round 0: B' (v3, v0) beats B (v1), so the leader re-proposes B'.
    const steered = { ...tc, highQC: { round: 0, value: "B'", signers: [3] } };
    s.at(s.access.roundStart(1));
    s.prepare([1, 2, 3], 1, 1, "B'", steered.highQC, steered);
    const result = s.access.finish();
    assert.ok(result.violations.some((v) => v.startsWith("S3")), `expected S3 violation, got ${result.violations}`);
  }
  // Strict single-attestation lock: no conflicting finality, but a permanent halt.
  {
    const s = scripted({ n: 4, byzantine: [0], variant: "one-phase-strict", horizonRounds: 16 });
    s.at(s.access.roundStart(0));
    s.prepare([1, 2], 0, 0, "B");
    s.prepare([3], 0, 0, "B'");
    const result = s.model.run(); // continue with honest leaders, v0 withholds everything
    assert.ok(!result.violations.some((v) => v.startsWith("S3")));
    assert.ok(result.violations.some((v) => v.startsWith("LIVENESS")), "one-phase strict lock must halt");
    assert.ok(result.decided.every((item) => item === null), "nothing ever finalizes");
  }
  // Same Byzantine behaviour against the v6 two-phase design: safe and live.
  {
    const s = scripted({ n: 4, byzantine: [0] });
    s.at(s.access.roundStart(0));
    s.prepare([1, 2], 0, 0, "B");
    s.prepare([3], 0, 0, "B'");
    const qc = s.access.adversaryQC(0, "B")!;
    assert.equal(s.access.adversaryQC(0, "B'"), null, "at most one value per round has a QC (L1)");
    s.commit([1, 2], qc);
    assert.deepEqual(s.access.finalizable().map((item) => item.value), ["B"]);
    const result = s.model.run();
    assert.ok(result.ok, result.violations.join("; "));
    assert.ok(result.decided.filter((item) => item !== null).every((item) => item!.value === "B"));
    assert.ok(result.decided.filter((item) => item !== null).length >= 3);
  }
});

test("T2b in the model: a partial-commit lock is carried into round 1 only with highQCRound <= r (spec §5.1 correction)", () => {
  for (const strictTimeoutHighQC of [true, false]) {
    // n=4, no Byzantine. v0 leads round 0, forms QC(0,B), delivers commit to v1 only, then crashes.
    const s = scripted({ n: 4, byzantine: [], strictTimeoutHighQC, horizonRounds: 8 });
    const { access, nodes } = s;
    s.at(access.roundStart(0));
    s.prepare([0, 1, 2, 3], 0, 0, "B");
    const qc = { round: 0, value: "B", signers: [0, 1, 2] };
    s.commit([1], qc);
    assert.deepEqual(nodes[1]!.journal.lock, { round: 0, value: "B" });
    nodes[0]!.up = false;
    nodes[0]!.permanentlyDown = true;
    // Round-1 leader v1 pulls timeout(H,0) from v1, v2, v3.
    s.requestTimeouts([1, 2, 3], 1, 0);
    const { tc, highQC } = s.tcFrom(0, [1, 2, 3]);
    assert.equal(highQC?.round, 0, "v1 reports its round-0 QC when timing out round 0");
    s.at(access.roundStart(1));
    s.prepare([1, 2, 3], 1, 1, "B", highQC, tc);
    const prepared = [1, 2, 3].filter((id) => nodes[id]!.journal.prepare.get(1) === "B");
    if (strictTimeoutHighQC) {
      // Spec-literal rule rejects v1's vote (highQCRound == r), so no TC exists
      // for round 0 with q valid votes and the round-1 re-proposal fails.
      assert.deepEqual(prepared, [], "spec-literal rule: round-1 re-proposal of B is rejected");
    } else {
      assert.deepEqual(prepared, [1, 2, 3], "corrected rule: round-1 leader re-proposes B with justify QC(0,B)");
    }
    const result = s.model.run();
    assert.ok(!result.violations.some((v) => v.startsWith("S")), result.violations.join("; "));
    if (!strictTimeoutHighQC) {
      assert.ok(result.ok, result.violations.join("; "));
      assert.ok(result.decided.filter((item) => item !== null).every((item) => item!.value === "B" && item!.round === 1));
    }
  }
});

test("Phase 0 evidence: the spec-literal highQCRound < r rule violates the post-GST bound in randomized runs; the corrected rule does not", () => {
  const literal = runRandomSchedules(6_000, 1, { strictTimeoutHighQC: true });
  const corrected = runRandomSchedules(6_000, 1, { strictTimeoutHighQC: false });
  assert.ok(literal.failures.length > 0, "the spec-literal rule should produce bound violations");
  assert.ok(literal.failures.every((failure) => failure.violations.every((v) => v.startsWith("LIVENESS"))),
    "the spec-literal rule only harms liveness, never safety");
  assert.deepEqual(corrected.failures, []);
});
