// F-01 phase 5 chaos scenarios for protocol v6, run on V6Sim (real
// NodeService/journal instances, production V6LeaderScheduler, virtual time).
//
// Each run: validators start at random offsets inside the first window; a
// scenario-specific fault process runs until GST; at GST all links heal,
// crashed (non-permanent) validators restart from disk and sync. Assertions:
//   safety  - no two validators finalize different blocks at a height, no
//             two commit certificates for different blocks at a height (from
//             every signature seen on the wire), no honest double-sign;
//   liveness (after GST, skew within the guard) - every height finalizes in a
//             round <= R_h + f_faulty, where R_h is the first round (on the
//             grid of its own tip) whose leader start is at/after the moment
//             the height became pending after GST: f + 1 rounds (§8.3). For the
//             height pending at GST, R_h = R*. A height that follows a
//             re-proposed block starts at a high round number because the grid
//             is anchored at the re-proposed block's origin timestamp (§8.4);
//             that is why the bound is relative to R_h and not to round 0.
import { validatorQuorumSize } from "../../src/block.js";
import { V6_ROUND_BASE_MS, V6_TIMEOUT_GUARD_MS } from "../../src/consensus-v6.js";
import { v6LeaderStart } from "../../src/v6-scheduler.js";
import { finalizedPrefix, openValidator, closeValidators, testNetwork, type MessageKind, type TestValidator } from "./consensus-harness.js";
import { V6Sim } from "./v6-sim.js";

export const CHAOS_SCENARIOS = [
  "partition-heal",
  "asymmetric-partition",
  "proposer-crash-partial",
  "restart-while-locked",
  "repeated-round-changes",
  "byzantine-equivocation",
  "clock-skew",
  "clock-skew-beyond-guard",
  "mixed"
] as const;
export type ChaosScenario = typeof CHAOS_SCENARIOS[number];

export interface ChaosOptions {
  scenario: ChaosScenario;
  n: number;
  seed: number;
  /** Fault period before GST (virtual ms after the first round start), default 300 s. */
  chaosMs?: number;
  /** Heights that must finalize after GST, default 4. */
  postGstHeights?: number;
  /** Per-message drop probability before GST for "repeated-round-changes" (default 0.8). */
  dropRate?: number;
}

export interface ChaosResult {
  scenario: ChaosScenario;
  n: number;
  seed: number;
  faulty: string;
  skewMs: number[];
  heightsFinalized: number;
  heightsBeforeGst: number;
  heightsAfterGst: number;
  maxCommitRoundBeforeGst: number;
  roundsUsedBeforeGst: number;
  /** Rounds elapsed over all heights: finalized heights (commitRound + 1) (includes the height pending at GST). */
  totalRounds: number;
  pendingAtGst: number;
  rStar: number;
  pendingCommitRound: number | null;
  /**
   * Heights finalized after GST: commitRound and its bound R_h + f_faulty, where
   * R_h is the first round whose leader start is at or after the moment the
   * height became pending after GST (max(GST, finality of H-1)) on the grid of
   * its own tip, and the latency from that moment to finality.
   */
  postGst: Array<{ height: number; commitRound: number; bound: number; latencyMs: number }>;
  maxPostGstLatencyMs: number;
  livenessAsserted: boolean;
  livenessOk: boolean;
  restarts: number;
  restartsWhileLocked: number;
  signaturesSeen: number;
  honestDoubleSigns: number;
  byzantineDoubleSigns: number;
  conflictingCertificates: number;
  conflictingFinality: number;
  attempts: number;
  ok: boolean;
  failure?: string;
}

function canByzantine(n: number): boolean {
  return n - validatorQuorumSize(n) >= 1;
}

export async function runChaos(options: ChaosOptions): Promise<ChaosResult> {
  const { scenario, n, seed } = options;
  const chaosMs = options.chaosMs ?? 300_000;
  const postGstHeights = options.postGstHeights ?? 4;
  const network = testNetwork(n, 0x10 + n, `zyron-f01-chaos-n${n}`);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  for (let index = 0; index < n; index += 1) validators.push(await openValidator(network, index, prefix));
  const tip = validators[0]!.service.store.chain.tip.header.timestampMs;
  const firstHeight = validators[0]!.service.status().height + 1;
  const pre = { random: (() => { let s = seed * 2654435761 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })() };
  const pick = <T>(items: T[]): T => items[Math.floor(pre.random() * items.length)]!;
  const f = n - validatorQuorumSize(n);

  // Clock skew: pairwise <= guard within the guard, far beyond it otherwise.
  let skewMs = validators.map(() => 0);
  if (scenario === "clock-skew" || scenario === "mixed") skewMs = validators.map(() => Math.round((pre.random() - 0.5) * V6_TIMEOUT_GUARD_MS));
  if (scenario === "clock-skew-beyond-guard") skewMs = validators.map(() => Math.round((pre.random() - 0.5) * 12_000));

  let byzantine: { index: number; twin: TestValidator; sideA: Set<number> } | undefined;
  if (scenario === "byzantine-equivocation" && canByzantine(n)) {
    const index = Math.floor(pre.random() * n);
    const others = validators.map((_, item) => item).filter((item) => item !== index);
    const sideA = new Set(others.filter(() => pre.random() < 0.5));
    byzantine = { index, twin: await openValidator(network, index, prefix), sideA };
  }
  const permanentCrash = scenario === "repeated-round-changes" && f >= 1 ? Math.floor(pre.random() * n) : undefined;
  const sim = new V6Sim({ network, prefix, validators, seed, skewMs, startMs: tip, ...(byzantine ? { byzantine } : {}) });
  const gst = tip + V6_ROUND_BASE_MS + chaosMs;
  const result: ChaosResult = {
    scenario, n, seed,
    faulty: byzantine ? `byzantine v${byzantine.index} sideA=[${[...byzantine.sideA].join(",")}]` : permanentCrash !== undefined ? `crashed v${permanentCrash}` : "none",
    skewMs,
    heightsFinalized: 0, heightsBeforeGst: 0, heightsAfterGst: 0, maxCommitRoundBeforeGst: -1, roundsUsedBeforeGst: 0, totalRounds: 0,
    pendingAtGst: 0, rStar: 0, pendingCommitRound: null, postGst: [], maxPostGstLatencyMs: 0, livenessAsserted: false, livenessOk: false,
    restarts: 0, restartsWhileLocked: 0, signaturesSeen: 0, honestDoubleSigns: 0, byzantineDoubleSigns: 0,
    conflictingCertificates: 0, conflictingFinality: 0, attempts: 0, ok: false
  };
  const crashed = new Set<number>();
  try {
    for (let index = 0; index < n; index += 1) {
      if (index === permanentCrash) { sim.crash(index); crashed.add(index); continue; }
      sim.startAt(index, tip + Math.floor(pre.random() * V6_ROUND_BASE_MS));
    }

    // ---- fault process before GST -------------------------------------
    let linkFilter: (from: number, to: number, kind: MessageKind) => boolean = () => false;
    const dropRate = (rate: number, commitRate = rate) => (_from: number, _to: number, kind: MessageKind) =>
      sim.random() < (kind === "v6-commit" ? commitRate : rate);
    const every = (minMs: number, maxMs: number, action: () => Promise<void> | void): void => {
      const loop = async (): Promise<void> => {
        if (sim.time.nowMs >= gst) return;
        await action();
        sim.time.setTimeout(loop, minMs + Math.floor(pre.random() * (maxMs - minMs)));
      };
      sim.time.setTimeout(loop, minMs + Math.floor(pre.random() * (maxMs - minMs)));
    };
    const partition = (): void => {
      const groupA = new Set(validators.map((_, i) => i).filter(() => pre.random() < 0.5));
      linkFilter = pre.random() < 0.25 ? () => false : (from, to) => groupA.has(from) !== groupA.has(to);
    };
    const asymmetric = (): void => {
      const down = new Set<string>();
      for (let a = 0; a < n; a += 1) for (let b = 0; b < n; b += 1) if (a !== b && pre.random() < 0.5) down.add(`${a}>${b}`);
      linkFilter = (from, to) => down.has(`${from}>${to}`);
    };
    // Crash a leader in the middle of its prepare/commit broadcast.
    let armed = false;
    let victim: { index: number; reach: Set<number> } | undefined;
    const partialCrashFilter = (from: number, to: number, kind: MessageKind): boolean => {
      if (victim && from === victim.index) return !victim.reach.has(to);
      if (!armed || crashed.has(from) || (kind !== "v6-prepare" && kind !== "v6-commit")) return false;
      armed = false;
      victim = { index: from, reach: new Set(validators.map((_, i) => i).filter((i) => i !== from && pre.random() < 0.5)) };
      const index = from;
      sim.time.setTimeout(() => {
        sim.crash(index);
        crashed.add(index);
        victim = undefined;
        sim.time.setTimeout(async () => {
          if (!crashed.has(index) || sim.time.nowMs >= gst) return;
          crashed.delete(index);
          await sim.restart(index);
        }, 10_000 + Math.floor(pre.random() * 50_000));
      }, 0);
      return !victim.reach.has(to);
    };
    const restartSomeone = async (preferLocked: boolean): Promise<void> => {
      const candidates = validators.map((_, i) => i).filter((i) => !crashed.has(i));
      const locked = candidates.filter((i) => sim.validators[i]!.journal.v6Lock(sim.height(i) + 1) !== undefined);
      const target = preferLocked && locked.length ? pick(locked) : pick(candidates);
      if (locked.includes(target)) result.restartsWhileLocked += 1;
      await sim.restart(target);
    };

    switch (scenario) {
      case "partition-heal":
        every(20_000, 60_000, partition);
        break;
      case "asymmetric-partition":
        every(20_000, 60_000, asymmetric);
        break;
      case "proposer-crash-partial":
        every(30_000, 70_000, () => { armed = true; });
        break;
      case "restart-while-locked":
        linkFilter = dropRate(0.15, 0.6);
        every(15_000, 45_000, () => restartSomeone(true));
        break;
      case "repeated-round-changes":
        linkFilter = dropRate(options.dropRate ?? 0.8);
        break;
      case "byzantine-equivocation":
        linkFilter = dropRate(0.1);
        break;
      case "clock-skew":
      case "clock-skew-beyond-guard":
        linkFilter = dropRate(0.2);
        break;
      case "mixed": {
        every(25_000, 70_000, () => (pre.random() < 0.5 ? partition() : asymmetric()));
        every(30_000, 80_000, () => { armed = true; });
        every(40_000, 90_000, () => restartSomeone(true));
        break;
      }
    }
    sim.linkDown = (from, to, kind, nowMs) => {
      if (crashed.has(from) || crashed.has(to)) return true;
      if (nowMs >= gst) return false;
      if (partialCrashFilter(from, to, kind)) return true;
      return linkFilter(from, to, kind) || (scenario === "mixed" && sim.random() < 0.1);
    };

    await sim.run(gst);

    // ---- GST: heal, restart crashed (non-permanent) validators, sync ----
    linkFilter = () => false;
    armed = false;
    victim = undefined;
    for (const index of [...crashed]) {
      if (index === permanentCrash) continue;
      crashed.delete(index);
      await sim.restart(index);
    }
    await sim.syncAll();
    const online = validators.map((_, i) => i).filter((i) => !crashed.has(i));
    const heightAtGst = Math.max(...online.map((i) => sim.height(i)));
    result.heightsBeforeGst = heightAtGst - firstHeight + 1;
    const before = sim.finality.filter((item) => item.height <= heightAtGst);
    result.maxCommitRoundBeforeGst = Math.max(-1, ...before.map((item) => item.commitRound));
    result.roundsUsedBeforeGst = before.reduce((sum, item) => sum + item.commitRound + 1, 0);
    result.pendingAtGst = heightAtGst + 1;
    const gstTip = sim.validators[online[0]!]!.service.store.chain.tip.header.timestampMs;
    const maxSkew = Math.max(0, ...skewMs);
    let rStar = 0;
    while (v6LeaderStart(gstTip, rStar) < gst + maxSkew) rStar += 1;
    result.rStar = rStar;
    const fFaulty = (byzantine ? 1 : 0) + (permanentCrash !== undefined ? 1 : 0);
    const target = heightAtGst + postGstHeights;
    await sim.run(gst + 3_600_000, () => sim.maxHeight() >= target && online.every((i) => sim.height(i) >= target));
    sim.stopAll();
    await sim.syncAll();

    // ---- assertions ----------------------------------------------------
    const finalityByHeight = new Map(sim.finality.map((item) => [item.height, item]));
    result.heightsFinalized = sim.maxHeight() - firstHeight + 1;
    result.heightsAfterGst = sim.maxHeight() - heightAtGst;
    result.pendingCommitRound = finalityByHeight.get(heightAtGst + 1)?.commitRound ?? null;
    const reference = sim.validators[online[0]!]!;
    let pendingSince = gst;
    for (let height = heightAtGst + 1; height <= target; height += 1) {
      const item = finalityByHeight.get(height);
      const [previous] = await reference.service.store.readFinalizedBlocks(height - 1, 1, 8_000_000);
      if (!item || !previous) { result.postGst.push({ height, commitRound: -1, bound: -1, latencyMs: -1 }); break; }
      let first = 0;
      while (v6LeaderStart(previous.header.timestampMs, first) < pendingSince + maxSkew) first += 1;
      result.postGst.push({ height, commitRound: item.commitRound, bound: first + fFaulty, latencyMs: item.atMs - pendingSince });
      pendingSince = Math.max(gst, item.atMs);
    }
    result.maxPostGstLatencyMs = Math.max(0, ...result.postGst.map((item) => item.latencyMs));
    result.livenessAsserted = scenario !== "clock-skew-beyond-guard";
    result.livenessOk = result.heightsAfterGst >= postGstHeights && result.postGst.length === postGstHeights &&
      result.postGst.every((item) => item.commitRound >= 0 && item.commitRound <= item.bound);
    const honest = new Set(network.publicKeys.filter((_, i) => i !== byzantine?.index));
    result.signaturesSeen = sim.ledger.count;
    result.honestDoubleSigns = sim.ledger.conflicts(honest).length;
    result.byzantineDoubleSigns = byzantine ? sim.ledger.conflicts(new Set([network.publicKeys[byzantine.index]!])).length : 0;
    result.conflictingCertificates = sim.ledger.conflictingCertificates().length;
    result.conflictingFinality = (await sim.assertNoConflictingFinality(firstHeight)).conflicts.length;
    result.totalRounds = sim.finality.reduce((sum, item) => sum + item.commitRound + 1, 0);
    result.restarts = sim.restarts.length;
    result.attempts = sim.attemptsTotal();
    const failures: string[] = [];
    if (result.honestDoubleSigns) failures.push(`honest double-sign: ${JSON.stringify(sim.ledger.conflicts(honest).slice(0, 3))}`);
    if (result.conflictingCertificates) failures.push("conflicting commit certificates");
    if (result.conflictingFinality) failures.push("conflicting finality");
    if (result.livenessAsserted && !result.livenessOk) {
      failures.push(`liveness after GST (R*=${rStar}, f=${fFaulty}): ${JSON.stringify(result.postGst)}, heights after GST ${result.heightsAfterGst}`);
    }
    result.ok = failures.length === 0;
    if (failures.length) result.failure = `${failures.join("; ")} | errors: ${sim.errors.slice(-5).join(" / ")}`;
    return result;
  } finally {
    sim.stopAll();
    await closeValidators([...sim.validators, byzantine?.twin]);
  }
}
