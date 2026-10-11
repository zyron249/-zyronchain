// Executable model of the protocol-v6 locked two-phase BFT (F-01 design spec,
// F01_CONSENSUS_DESIGN.md rules R1-R9) for one height.
//
// The model is deliberately independent of the production modules: it is a
// discrete-event simulator over abstract values, abstract signatures and a
// seeded adversarial network, used to validate the design (Phase 0) before
// production code exists and, later, as the T9/T12 checker.
//
// Fault model encoded here:
// - Signatures are unforgeable. An honest validator "signs" only after its
//   journal accepted the row (R1). Byzantine validators can sign anything.
// - The adversary is a global eavesdropper: every signature ever produced is
//   known to it, so it can assemble any certificate that the signatures allow.
// - Before GST the network drops/delays arbitrarily and may partition
//   (asymmetrically). After GST honest-to-honest messages arrive within DELTA.
// - Crashes lose volatile state only. Journal rows, the QC file and pending
//   proposal files are durable (optionally the QC file is lost on restart).
//
// Checked invariants:
// - S1: no honest validator signs two values for one (round, step).
// - S2: an honest lock only moves to a strictly higher round, on a valid QC.
// - S3: no two different values are finalizable. "Finalizable" is computed
//   over every signature in existence (honest commit signatures plus any
//   Byzantine signature), i.e. including certificates only the adversary could
//   assemble, not just the certificates honest nodes happened to observe.
// - Liveness: after GST, with at least q honest validators up and clock skew
//   within TIMEOUT_GUARD, every up honest validator decides within a bounded
//   number of rounds.

export type Mutation =
  | "none"
  | "no-lock-check"
  | "commit-without-qc"
  | "non-strict-unlock"
  | "two-prepare-values"
  | "cross-round-commit-count"
  | "timeout-exclusive-with-vote"
  | "non-strict-unlock+two-prepare-values";

export type ProtocolVariant =
  | "two-phase"          // the v6 design
  | "one-phase-unlock"   // §5.4: attestation = commit; unlock on a report at a round >= own lock
  | "one-phase-strict";  // §5.4: attestation = commit; never unlock a single-attestation lock

export interface ModelConfig {
  n: number;
  variant?: ProtocolVariant;
  byzantine: number[];
  seed: number;
  /** Validators that crash before GST and never return (counted as faulty). */
  permanentlyCrashed?: number[];
  /** Enable random crash/restart of honest validators before GST. */
  crashRestart?: boolean;
  /** Probability that a restart loses the QC file (lock row always survives). */
  qcLossOnRestart?: number;
  gstMs: number;
  preGstDropRate: number;
  preGstMaxDelayMs: number;
  /** Partition episodes before GST (random, possibly asymmetric). */
  partitions?: boolean;
  /** Per-validator clock offsets (local = global + offset). */
  skewMs?: number[];
  mutation?: Mutation;
  /**
   * Spec-literal TimeoutVote rule from §5.1 ("highQCRound < r"). The corrected
   * rule is "highQCRound <= r" (a validator locked at r must be able to report
   * its round-r QC when it times out round r, §6.3 / T2b).
   */
  strictTimeoutHighQC?: boolean;
  /**
   * Enforce the leader obligation at validators (justifyRound == max reported
   * highQCRound in the TC, §4.6). The spec classifies it as a liveness rule;
   * disabling it checks that safety rests on the lock rules alone (§7).
   */
  checkLeaderRule?: boolean;
  /** Pre-GST persistent link failures: probability that a directed link is down per epoch. */
  linkFailureRate?: number;
  horizonRounds?: number;
  /** Additional rounds to keep running after the first decision (safety stress). */
  extraRoundsAfterDecision?: number;
  roundBaseMs?: number;
  roundStepMs?: number;
  roundMaxMs?: number;
  timeoutGuardMs?: number;
  deltaMs?: number;
  collectionMs?: number;
  retryMs?: number;
  /** Byzantine aggressiveness 0..1 (probability of acting on each tick). */
  byzantineActivity?: number;
  /** Byzantine validators never answer (withhold all votes). */
  byzantineSilent?: boolean;
  /** Disable the liveness assertion (e.g. skew beyond the guard). */
  checkLiveness?: boolean;
  trace?: boolean;
}

export interface QC {
  round: number;
  value: string;
  signers: number[];
}

interface TimeoutClaim {
  from: number;
  round: number;
  hr: number;
  hv: string;
}

interface TC {
  round: number;
  votes: TimeoutClaim[];
  highQC: QC | null;
}

type Message =
  | { kind: "prepare"; from: number; round: number; value: string; justify: QC | null; tc: TC | null }
  | { kind: "prepare-vote"; from: number; round: number; value: string }
  | { kind: "commit"; from: number; round: number; qc: QC }
  | { kind: "commit-vote"; from: number; round: number; value: string }
  | { kind: "timeout-req"; from: number; round: number }
  | { kind: "timeout-vote"; from: number; claim: TimeoutClaim; qc: QC | null }
  | { kind: "final"; from: number; round: number; value: string; signers: number[] };

interface Journal {
  proposal: Map<number, string>;
  prepare: Map<number, string>;
  commit: Map<number, string>;
  timeout: Map<number, { hr: number; hv: string; qc: QC | null }>;
  lock: { round: number; value: string } | null;
  prepareExtra: Map<number, Set<string>>; // only used by the two-prepare-values mutation
}

interface PendingProposal {
  value: string;
  justify: QC | null;
  tc: TC | null;
}

interface LeaderState {
  round: number;
  phase: "pull" | "prepare" | "commit" | "done";
  firstPullAt: number;
  timeoutVotes: Map<number, { claim: TimeoutClaim; qc: QC | null }>;
  responders: Set<number>;
  proposal: PendingProposal | null;
  prepareVotes: Set<number>;
  qc: QC | null;
  commitVotes: Set<number>;
}

interface Node {
  id: number;
  byzantine: boolean;
  up: boolean;
  permanentlyDown: boolean;
  journal: Journal;
  highQC: QC | null; // durable QC file (may be lost on restart in a variant)
  pending: Map<number, PendingProposal>; // durable proposal files
  decided: { round: number; value: string; signers: number[] } | null;
  decidedAt: number | null;
  leader: LeaderState | null;
}

export interface ModelResult {
  seed: number;
  ok: boolean;
  violations: string[];
  decided: Array<{ node: number; round: number; value: string } | null>;
  decisionTimeMs: number | null;
  decisionRound: number | null;
  livenessChecked: boolean;
  livenessBoundRound: number | null;
  events: number;
  maxRound: number;
  finalizable: Array<{ round: number; value: string }>;
  trace: string[];
}

class Rng {
  private state: number;
  constructor(seed: number) { this.state = (seed >>> 0) || 0x9e3779b9; }
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number { return Math.floor(this.next() * maxExclusive); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(values: readonly T[]): T { return values[this.int(values.length)]!; }
  subset<T>(values: readonly T[], p = 0.5): T[] { return values.filter(() => this.chance(p)); }
}

export function quorum(n: number): number { return Math.floor((2 * n) / 3) + 1; }

export function leaderOf(n: number, height: number, round: number): number {
  return (((height - 1) % n) + (round % n)) % n;
}

export class V6Model {
  readonly cfg: Required<Omit<ModelConfig, "skewMs" | "permanentlyCrashed">> & { skewMs: number[]; permanentlyCrashed: number[] };
  private readonly rng: Rng;
  private readonly q: number;
  private readonly nodes: Node[];
  private readonly queue: Array<{ at: number; seq: number; run: () => void }> = [];
  private seq = 0;
  private now = 0;
  private events = 0;
  private readonly violations: string[] = [];
  private readonly trace: string[] = [];
  // Global signature registry (what exists in the world).
  private readonly honestPrepared = new Map<string, Set<number>>(); // round:value -> honest signers
  private readonly honestCommitted = new Map<string, Set<number>>();
  private readonly honestTimeouts = new Map<number, Map<number, { hr: number; hv: string; qc: QC | null }>>();
  private readonly signedPerStep = new Map<string, string>(); // node:round:step -> value (S1)
  private readonly knownValues = new Set<string>();
  private readonly partitionsBlocked = new Set<string>();
  private firstDecisionAt: number | null = null;
  private firstDecisionRound: number | null = null;
  private stopAt = Number.POSITIVE_INFINITY;
  private maxRoundSeen = 0;
  private readonly height = 1;

  constructor(config: ModelConfig) {
    this.cfg = {
      permanentlyCrashed: [],
      crashRestart: false,
      qcLossOnRestart: 0,
      partitions: false,
      mutation: "none",
      variant: "two-phase",
      strictTimeoutHighQC: false,
      checkLeaderRule: true,
      linkFailureRate: 0,
      horizonRounds: 24,
      extraRoundsAfterDecision: 2,
      roundBaseMs: 30_000,
      roundStepMs: 5_000,
      roundMaxMs: 120_000,
      timeoutGuardMs: 2_000,
      deltaMs: 1_000,
      collectionMs: 8_000,
      retryMs: 1_000,
      byzantineActivity: 0.5,
      byzantineSilent: false,
      checkLiveness: true,
      trace: false,
      ...config,
      skewMs: config.skewMs ?? new Array(config.n).fill(0)
    } as V6Model["cfg"];
    this.rng = new Rng(config.seed);
    this.q = quorum(config.n);
    this.nodes = Array.from({ length: config.n }, (_, id) => ({
      id,
      byzantine: this.cfg.byzantine.includes(id),
      up: true,
      permanentlyDown: false,
      journal: emptyJournal(),
      highQC: null,
      pending: new Map(),
      decided: null,
      decidedAt: null,
      leader: null
    }));
  }

  // ---- pacemaker math (§3.3) ----
  roundDuration(round: number): number {
    return Math.min(this.cfg.roundBaseMs + round * this.cfg.roundStepMs, this.cfg.roundMaxMs);
  }
  roundStart(round: number): number {
    let start = this.cfg.roundBaseMs; // tip timestamp 0 + BLOCK_INTERVAL
    for (let r = 0; r < round; r += 1) start += this.roundDuration(r);
    return start;
  }
  roundEnd(round: number): number { return this.roundStart(round) + this.roundDuration(round); }
  clockRound(localMs: number): number {
    if (localMs < this.roundStart(0)) return -1;
    let r = 0;
    while (this.roundEnd(r) <= localMs) r += 1;
    return r;
  }
  private local(node: number): number { return this.now + (this.cfg.skewMs[node] ?? 0); }
  private globalFor(node: number, localMs: number): number { return localMs - (this.cfg.skewMs[node] ?? 0); }

  // ---- event loop ----
  private schedule(at: number, run: () => void): void {
    const item = { at: Math.max(at, this.now), seq: this.seq++, run };
    // binary insertion keeps the queue ordered by (at, seq)
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const other = this.queue[mid]!;
      if (other.at < item.at || (other.at === item.at && other.seq < item.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, item);
  }

  private log(line: string): void {
    if (this.cfg.trace) this.trace.push(`t=${this.now} ${line}`);
  }

  private violation(message: string): void {
    if (this.violations.length < 20) this.violations.push(message);
    this.log(`VIOLATION ${message}`);
  }

  run(): ModelResult {
    const { n } = this.cfg;
    for (const id of this.cfg.permanentlyCrashed) {
      const node = this.nodes[id]!;
      const crashAt = this.rng.int(Math.max(1, this.cfg.gstMs));
      this.schedule(crashAt, () => { node.up = false; node.permanentlyDown = true; node.leader = null; this.log(`crash-permanent v${id}`); });
    }
    if (this.cfg.crashRestart) {
      for (const node of this.nodes) {
        if (node.byzantine || this.cfg.permanentlyCrashed.includes(node.id)) continue;
        const episodes = this.rng.int(3);
        for (let index = 0; index < episodes; index += 1) {
          const at = this.rng.int(Math.max(1, this.cfg.gstMs));
          const back = Math.min(this.cfg.gstMs, at + 1 + this.rng.int(60_000));
          this.schedule(at, () => this.crash(node));
          this.schedule(back, () => this.restart(node));
        }
      }
    }
    if (this.cfg.partitions) {
      const episodes = 1 + this.rng.int(3);
      for (let index = 0; index < episodes; index += 1) {
        const at = this.rng.int(Math.max(1, this.cfg.gstMs));
        const until = Math.min(this.cfg.gstMs, at + 5_000 + this.rng.int(90_000));
        const blocked: string[] = [];
        const side = new Set(this.rng.subset(this.nodes.map((node) => node.id)));
        for (let a = 0; a < n; a += 1) {
          for (let b = 0; b < n; b += 1) {
            if (a === b) continue;
            const crossing = side.has(a) !== side.has(b);
            // asymmetric: some crossing links stay open in one direction
            if (crossing && !(this.rng.chance(0.25) && side.has(a))) blocked.push(`${a}>${b}`);
          }
        }
        this.schedule(at, () => { for (const link of blocked) this.partitionsBlocked.add(link); this.log(`partition on (${blocked.length} links)`); });
        this.schedule(until, () => { for (const link of blocked) this.partitionsBlocked.delete(link); this.log("partition healed"); });
      }
    }
    if (this.cfg.linkFailureRate > 0) {
      const linkDown = new Set<string>();
      for (let at = 0; at < this.cfg.gstMs; at += 10_000 + this.rng.int(20_000)) {
        const down: string[] = [];
        for (let a = 0; a < n; a += 1) for (let b = 0; b < n; b += 1) {
          if (a !== b && this.rng.chance(this.cfg.linkFailureRate)) down.push(`${a}>${b}`);
        }
        this.schedule(at, () => {
          for (const link of linkDown) this.partitionsBlocked.delete(link);
          linkDown.clear();
          for (const link of down) { linkDown.add(link); this.partitionsBlocked.add(link); }
        });
      }
    }
    this.schedule(this.cfg.gstMs, () => {
      this.partitionsBlocked.clear();
      for (const node of this.nodes) if (!node.up && !node.permanentlyDown) this.restart(node);
    });
    for (const node of this.nodes) this.scheduleTick(node, 0);

    const horizon = this.roundEnd(this.cfg.horizonRounds);
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item.at > horizon || item.at > this.stopAt) break;
      this.now = item.at;
      this.events += 1;
      item.run();
      if (this.events > 2_000_000) { this.violation("event budget exceeded"); break; }
    }
    return this.finish();
  }

  private crash(node: Node): void {
    if (!node.up || node.permanentlyDown) return;
    node.up = false;
    node.leader = null;
    this.log(`crash v${node.id}`);
  }

  private restart(node: Node): void {
    if (node.up || node.permanentlyDown) return;
    node.up = true;
    if (this.cfg.qcLossOnRestart > 0 && this.rng.chance(this.cfg.qcLossOnRestart)) node.highQC = null;
    this.log(`restart v${node.id} lock=${JSON.stringify(node.journal.lock)} highQC=${node.highQC?.round ?? -1}`);
    this.scheduleTick(node, this.now);
  }

  private scheduleTick(node: Node, at: number): void {
    this.schedule(at, () => this.tick(node));
  }

  private send(from: number, to: number, message: Message): void {
    if (from === to) { this.schedule(this.now, () => this.deliver(to, message)); return; }
    let delay: number;
    if (this.now < this.cfg.gstMs) {
      if (this.partitionsBlocked.has(`${from}>${to}`)) return;
      if (this.rng.chance(this.cfg.preGstDropRate)) return;
      delay = 1 + this.rng.int(this.cfg.preGstMaxDelayMs);
      // a pre-GST message is delivered no later than GST + DELTA
      delay = Math.min(delay, Math.max(1, this.cfg.gstMs + this.cfg.deltaMs - this.now));
    } else {
      delay = 1 + this.rng.int(this.cfg.deltaMs);
    }
    this.schedule(this.now + delay, () => this.deliver(to, message));
  }

  private broadcast(from: number, message: Message, targets?: number[]): void {
    for (const to of targets ?? this.nodes.map((node) => node.id)) this.send(from, to, message);
  }

  // ---- signatures / certificate validity ----
  private signHonest(node: Node, round: number, step: string, value: string): void {
    const key = `${node.id}:${round}:${step}`;
    const previous = this.signedPerStep.get(key);
    if (previous !== undefined && previous !== value && !(step === "prepare" && this.has("two-prepare-values"))) {
      this.violation(`S1: v${node.id} signed ${step}@${round} for ${previous} and ${value}`);
    }
    if (previous === undefined) this.signedPerStep.set(key, value);
    const registry = step === "prepare" ? this.honestPrepared : step === "commit" ? this.honestCommitted : undefined;
    if (registry) {
      const id = `${round}:${value}`;
      if (!registry.has(id)) registry.set(id, new Set());
      registry.get(id)!.add(node.id);
    }
  }

  private isByz(id: number): boolean { return this.nodes[id]?.byzantine === true; }

  private has(mutation: Exclude<Mutation, "none">): boolean {
    return this.cfg.mutation === mutation || this.cfg.mutation.split("+").includes(mutation);
  }

  private get onePhase(): boolean { return this.cfg.variant !== "two-phase"; }

  qcValid(qc: QC | null | undefined): boolean {
    if (!qc) return false;
    const honest = this.honestPrepared.get(`${qc.round}:${qc.value}`) ?? new Set<number>();
    if (this.onePhase) {
      // One-phase "lock evidence" is a single attestation (report), not a quorum.
      return qc.signers.length >= 1 && qc.signers.every((signer) => this.isByz(signer) || honest.has(signer));
    }
    const seen = new Set<number>();
    for (const signer of qc.signers) {
      if (seen.has(signer) || signer < 0 || signer >= this.cfg.n) return false;
      if (!this.isByz(signer) && !honest.has(signer)) return false;
      seen.add(signer);
    }
    return seen.size >= this.q;
  }

  /** Can the adversary (global knowledge) assemble a PrepareQC for (round, value)? */
  private adversaryQC(round: number, value: string): QC | null {
    const honest = [...(this.honestPrepared.get(`${round}:${value}`) ?? [])];
    if (this.onePhase) return { round, value, signers: [...this.cfg.byzantine, ...honest].slice(0, 1) };
    const signers = [...honest, ...this.cfg.byzantine];
    if (new Set(signers).size < this.q) return null;
    return { round, value, signers: [...new Set(signers)].slice(0, this.q) };
  }

  private allValidQCs(): QC[] {
    const result: QC[] = [];
    // Byzantine validators are always fewer than q, so a certificate needs at
    // least one honest signature: only keys with honest signatures can qualify.
    for (const key of this.honestPrepared.keys()) {
      const separator = key.indexOf(":");
      const qc = this.adversaryQC(Number(key.slice(0, separator)), key.slice(separator + 1));
      if (qc) result.push(qc);
    }
    return result;
  }

  private timeoutClaimValid(claim: TimeoutClaim): boolean {
    if (this.isByz(claim.from)) return true; // Byzantine can sign any payload
    const signed = this.honestTimeouts.get(claim.round)?.get(claim.from);
    return signed !== undefined && signed.hr === claim.hr && signed.hv === claim.hv;
  }

  tcValid(tc: TC | null | undefined, round: number): boolean {
    if (!tc || tc.round !== round) return false;
    const seen = new Set<number>();
    let max = -1;
    for (const vote of tc.votes) {
      if (seen.has(vote.from) || vote.round !== round) return false;
      seen.add(vote.from);
      if (vote.hr < -1) return false;
      if (this.cfg.strictTimeoutHighQC ? vote.hr >= round : vote.hr > round) return false;
      if (!this.timeoutClaimValid(vote)) return false;
      max = Math.max(max, vote.hr);
    }
    if (seen.size < this.q) return false;
    if (max < 0) return tc.highQC === null;
    if (!tc.highQC || tc.highQC.round !== max || !this.qcValid(tc.highQC)) return false;
    if (this.onePhase) return tc.votes.some((vote) => vote.hr === max && vote.hv === tc.highQC!.value);
    return tc.votes.every((vote) => vote.hr !== max || vote.hv === tc.highQC!.value);
  }

  // ---- honest validator handlers ----
  private journalBlocksRound(node: Node, round: number): boolean {
    // §6.2-2: timeout at r' >= r, or prepare/commit at a round > r
    for (const r of node.journal.timeout.keys()) if (r >= round) return true;
    for (const r of node.journal.prepare.keys()) if (r > round) return true;
    for (const r of node.journal.commit.keys()) if (r > round) return true;
    return false;
  }

  private safeVote(node: Node, value: string, justifyRound: number): boolean {
    const lock = node.journal.lock;
    if (this.cfg.variant === "one-phase-strict") return !lock || lock.value === value;
    if (this.cfg.variant === "one-phase-unlock") return !lock || lock.value === value || justifyRound >= lock.round;
    if (this.has("no-lock-check")) return true;
    if (!lock) return true;
    if (lock.value === value) return true;
    return this.has("non-strict-unlock") ? justifyRound >= lock.round : justifyRound > lock.round;
  }

  private onPrepare(node: Node, message: Extract<Message, { kind: "prepare" }>): void {
    const { round, value, justify, tc } = message;
    if (message.from !== leaderOf(this.cfg.n, this.height, round)) return;
    let justifyRound = -1;
    if (round > 0) {
      if (!this.tcValid(tc, round - 1)) return;
      const max = tc!.highQC ? tc!.highQC.round : -1;
      justifyRound = justify ? justify.round : -1;
      if (this.cfg.checkLeaderRule) {
        if (justifyRound !== max) return;
        if (justify && (justify.value !== tc!.highQC!.value)) return;
      }
    } else if (justify) {
      return; // no QC can exist below round 0
    }
    if (justify && (!this.qcValid(justify) || justify.round >= round || justify.value !== value)) return;
    if (this.journalBlocksRound(node, round)) return;
    const existing = node.journal.prepare.get(round);
    if (existing !== undefined && existing !== value) {
      if (!this.has("two-prepare-values")) return;
    }
    if (!this.safeVote(node, value, justifyRound)) return;
    if (justify && (!node.highQC || justify.round > node.highQC.round)) node.highQC = justify;
    if (existing === undefined) node.journal.prepare.set(round, value);
    this.signHonest(node, round, "prepare", value);
    this.knownValues.add(value);
    if (this.onePhase) {
      // The attestation is also the commit vote; it locks on itself and is the
      // value reported in later timeouts.
      this.signHonest(node, round, "commit", value);
      if (!node.journal.lock || round >= node.journal.lock.round) node.journal.lock = { round, value };
      node.journal.commit.set(round, value);
      node.highQC = { round, value, signers: [node.id] };
    }
    this.send(node.id, message.from, { kind: "prepare-vote", from: node.id, round, value });
  }

  private onCommit(node: Node, message: Extract<Message, { kind: "commit" }>): void {
    const { round, qc } = message;
    if (this.onePhase) return; // one-phase variants have no separate commit step
    if (qc.round !== round) return;
    if (!this.has("commit-without-qc") && !this.qcValid(qc)) return;
    if (this.journalBlocksRound(node, round)) return;
    const prepared = node.journal.prepare.get(round);
    if (prepared !== undefined && prepared !== qc.value && !this.has("two-prepare-values")) return;
    const committed = node.journal.commit.get(round);
    if (committed !== undefined && committed !== qc.value) return;
    const lock = node.journal.lock;
    if (lock && (lock.round > round || (lock.round === round && lock.value !== qc.value))) return;
    // crash points (§9.1): QC file -> lock+commit append -> signature
    if (this.cfg.crashRestart && this.now < this.cfg.gstMs && this.rng.chance(0.05)) {
      if (!node.highQC || qc.round > node.highQC.round) node.highQC = qc;
      if (this.rng.chance(0.5)) {
        this.checkLockTransition(node, round, qc);
        node.journal.lock = { round, value: qc.value };
        node.journal.commit.set(round, qc.value);
      }
      this.crash(node);
      this.schedule(this.now + 1 + this.rng.int(20_000), () => this.restart(node));
      return;
    }
    if (!node.highQC || qc.round > node.highQC.round) node.highQC = qc;
    this.checkLockTransition(node, round, qc);
    node.journal.lock = { round, value: qc.value };
    node.journal.commit.set(round, qc.value);
    this.signHonest(node, round, "commit", qc.value);
    this.knownValues.add(qc.value);
    this.send(node.id, message.from, { kind: "commit-vote", from: node.id, round, value: qc.value });
  }

  private checkLockTransition(node: Node, round: number, qc: QC): void {
    const lock = node.journal.lock;
    if (this.has("commit-without-qc")) return;
    if (!this.qcValid(qc)) this.violation(`S2: v${node.id} locked on ${qc.value}@${round} without a valid QC`);
    if (lock && (round < lock.round || (round === lock.round && lock.value !== qc.value))) {
      this.violation(`S2: v${node.id} lock moved from ${lock.value}@${lock.round} to ${qc.value}@${round}`);
    }
  }

  private onTimeoutRequest(node: Node, message: Extract<Message, { kind: "timeout-req" }>): void {
    const { round } = message;
    if (this.local(node.id) < this.roundEnd(round) - this.cfg.timeoutGuardMs) return;
    let signed = node.journal.timeout.get(round);
    if (!signed && this.has("timeout-exclusive-with-vote") &&
        (node.journal.prepare.has(round) || node.journal.commit.has(round))) {
      return; // legacy rule: a timeout (skip) is exclusive with an earlier vote in the round
    }
    if (!signed) {
      const high = node.highQC;
      if (high && high.round > round) return; // cannot build a valid vote for an older round
      signed = high ? { hr: high.round, hv: high.value, qc: high } : { hr: -1, hv: "", qc: null };
      node.journal.timeout.set(round, signed);
      if (!this.honestTimeouts.has(round)) this.honestTimeouts.set(round, new Map());
      this.honestTimeouts.get(round)!.set(node.id, signed);
      this.signHonest(node, round, "timeout", `${signed.hr}:${signed.hv}`);
    }
    this.send(node.id, message.from, {
      kind: "timeout-vote",
      from: node.id,
      claim: { from: node.id, round, hr: signed.hr, hv: signed.hv },
      qc: signed.qc
    });
  }

  private onFinal(node: Node, message: Extract<Message, { kind: "final" }>): void {
    if (node.decided) return;
    if (!this.certificateValid(message.round, message.value, message.signers)) return;
    this.decide(node, message.round, message.value, message.signers);
  }

  private certificateValid(round: number, value: string, signers: number[]): boolean {
    const seen = new Set<number>();
    for (const signer of signers) {
      if (seen.has(signer)) return false;
      seen.add(signer);
      if (this.isByz(signer)) continue;
      if (this.has("cross-round-commit-count")) {
        let any = false;
        for (const [key, set] of this.honestCommitted) if (key.endsWith(`:${value}`) && set.has(signer)) any = true;
        if (!any) return false;
      } else if (!(this.honestCommitted.get(`${round}:${value}`)?.has(signer))) {
        return false;
      }
    }
    return seen.size >= this.q;
  }

  private decide(node: Node, round: number, value: string, signers: number[]): void {
    node.decided = { round, value, signers };
    node.decidedAt = this.now;
    node.leader = null;
    if (!node.byzantine) this.scheduleTick(node, this.now + 10_000);
    this.log(`decide v${node.id} ${value}@${round}`);
    if (this.firstDecisionAt === null) {
      this.firstDecisionAt = this.now;
      this.firstDecisionRound = round;
      const { boundRound } = this.livenessBound();
      this.stopAt = Math.max(this.roundEnd(round + this.cfg.extraRoundsAfterDecision),
        boundRound === null ? 0 : this.roundEnd(boundRound) + 1);
    }
    this.checkFinalizable();
  }

  private deliver(to: number, message: Message): void {
    const node = this.nodes[to]!;
    if (!node.up) return;
    if (node.byzantine) { this.byzantineReceive(node, message); return; }
    if (node.decided) {
      // A finalized node no longer votes at this height; it serves the final block.
      if (message.kind === "prepare" || message.kind === "commit" || message.kind === "timeout-req") {
        this.send(to, message.from, { kind: "final", from: to, round: node.decided.round, value: node.decided.value, signers: node.decided.signers });
      }
      return;
    }
    switch (message.kind) {
      case "prepare": this.onPrepare(node, message); break;
      case "commit": this.onCommit(node, message); break;
      case "timeout-req": this.onTimeoutRequest(node, message); break;
      case "final": this.onFinal(node, message); break;
      case "prepare-vote":
      case "commit-vote":
      case "timeout-vote":
        this.leaderReceive(node, message); break;
    }
  }

  // ---- honest leader (R6) ----
  private leaderWindow(node: Node): number | null {
    // The round this node may lead now: clockRound(local + guard) lets the
    // leader of r start collecting TC(r-1) at roundEnd(r-1) - guard.
    const local = this.local(node.id);
    const candidates = [this.clockRound(local + this.cfg.timeoutGuardMs), this.clockRound(local)];
    for (const round of candidates) {
      if (round < 0) continue;
      if (leaderOf(this.cfg.n, this.height, round) !== node.id) continue;
      if (local >= this.roundEnd(round)) continue;
      return round;
    }
    return null;
  }

  private nextLeaderStart(node: Node): number {
    const local = this.local(node.id);
    const current = Math.max(0, this.clockRound(local));
    for (let round = current; round < current + this.cfg.n + 2; round += 1) {
      if (leaderOf(this.cfg.n, this.height, round) !== node.id) continue;
      const startLocal = round === 0 ? this.roundStart(0) : this.roundEnd(round - 1) - this.cfg.timeoutGuardMs;
      if (startLocal > local) return this.globalFor(node.id, startLocal);
    }
    return this.now + this.cfg.retryMs;
  }

  private tick(node: Node): void {
    if (!node.up) return;
    if (node.byzantine) {
      this.byzantineTick(node);
      this.scheduleTick(node, this.now + this.cfg.retryMs);
      return;
    }
    if (node.decided) {
      // Periodic finalized-block sync (cli.ts peer sync tick): serve the final block.
      const decided = node.decided;
      this.broadcast(node.id, { kind: "final", from: node.id, round: decided.round, value: decided.value, signers: decided.signers });
      this.scheduleTick(node, this.now + 10_000);
      return;
    }
    const round = this.leaderWindow(node);
    if (round === null) {
      node.leader = null;
      this.scheduleTick(node, Math.max(this.now + 1, this.nextLeaderStart(node)));
      return;
    }
    this.maxRoundSeen = Math.max(this.maxRoundSeen, round);
    if (!node.leader || node.leader.round !== round) {
      node.leader = {
        round,
        phase: "pull",
        firstPullAt: this.now,
        timeoutVotes: new Map(),
        responders: new Set(),
        proposal: null,
        prepareVotes: new Set(),
        qc: null,
        commitVotes: new Set()
      };
      // §3.4 same-round retry: a stored proposal is re-sent unchanged.
      const stored = node.pending.get(round);
      if (stored) { node.leader.proposal = stored; node.leader.phase = "prepare"; }
      else if (node.journal.proposal.has(round)) { node.leader.phase = "done"; } // proposal file lost: never re-propose
      else if (round === 0) this.propose(node, null, null);
    }
    this.leaderStep(node);
    this.scheduleTick(node, this.now + this.cfg.retryMs);
  }

  private leaderStep(node: Node): void {
    const state = node.leader!;
    const round = state.round;
    if (state.phase === "pull") {
      const enoughTime = state.responders.size >= this.cfg.n || this.now - state.firstPullAt >= this.cfg.collectionMs;
      if (state.timeoutVotes.size >= this.q && enoughTime) {
        const votes = [...state.timeoutVotes.values()];
        let best: QC | null = null;
        for (const vote of votes) if (vote.qc && (!best || vote.qc.round > best.round)) best = vote.qc;
        if (this.onePhase && best) {
          // §5.4: "any deterministic choice rule" - here: most reports at the max round.
          const top = votes.filter((vote) => vote.qc && vote.qc.round === best!.round);
          const counts = new Map<string, number>();
          for (const vote of top) counts.set(vote.qc!.value, (counts.get(vote.qc!.value) ?? 0) + 1);
          const value = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
          best = top.find((vote) => vote.qc!.value === value)!.qc;
        }
        const tc: TC = { round: round - 1, votes: votes.map((vote) => vote.claim), highQC: best };
        this.propose(node, best, tc);
      } else {
        for (const other of this.nodes) {
          if (!state.responders.has(other.id)) this.send(node.id, other.id, { kind: "timeout-req", from: node.id, round: round - 1 });
        }
        return;
      }
    }
    if (state.phase === "prepare" && state.proposal) {
      const message: Message = { kind: "prepare", from: node.id, round, value: state.proposal.value, justify: state.proposal.justify, tc: state.proposal.tc };
      for (const other of this.nodes) if (!state.prepareVotes.has(other.id)) this.send(node.id, other.id, message);
    } else if (state.phase === "commit" && state.qc) {
      const message: Message = { kind: "commit", from: node.id, round, qc: state.qc };
      for (const other of this.nodes) if (!state.commitVotes.has(other.id)) this.send(node.id, other.id, message);
    }
  }

  private propose(node: Node, justify: QC | null, tc: TC | null): void {
    const state = node.leader!;
    const round = state.round;
    if (node.journal.proposal.has(round)) return;
    const value = justify ? justify.value : `B${node.id}r${round}`;
    if (!justify && round > 0 && tc && tc.highQC) return;
    const proposal: PendingProposal = { value, justify, tc };
    node.pending.set(round, proposal); // durable proposal file before the row (§9.1)
    node.journal.proposal.set(round, value);
    this.signHonest(node, round, "proposal", value);
    this.knownValues.add(value);
    state.proposal = proposal;
    state.phase = "prepare";
    this.log(`propose v${node.id} ${value}@${round} justify=${justify?.round ?? -1}`);
  }

  private leaderReceive(node: Node, message: Extract<Message, { kind: "prepare-vote" | "commit-vote" | "timeout-vote" }>): void {
    const state = node.leader;
    if (!state) return;
    if (message.kind === "timeout-vote") {
      if (state.phase !== "pull" || message.claim.round !== state.round - 1) return;
      state.responders.add(message.from);
      if (!this.timeoutClaimValid(message.claim)) return;
      const claim = message.claim;
      if (this.cfg.strictTimeoutHighQC ? claim.hr >= claim.round : claim.hr > claim.round) return;
      if (claim.hr >= 0) {
        if (!message.qc || message.qc.round !== claim.hr || message.qc.value !== claim.hv || !this.qcValid(message.qc)) return;
      }
      state.timeoutVotes.set(message.from, { claim, qc: claim.hr >= 0 ? message.qc : null });
      return;
    }
    if (message.round !== state.round) return;
    if (message.kind === "prepare-vote") {
      if (state.phase !== "prepare" || !state.proposal || message.value !== state.proposal.value) return;
      if (!this.isByz(message.from) && !this.honestPrepared.get(`${message.round}:${message.value}`)?.has(message.from)) return;
      state.prepareVotes.add(message.from);
      if (this.onePhase && state.prepareVotes.size >= this.q) {
        const signers = [...state.prepareVotes];
        state.phase = "done";
        this.decide(node, state.round, state.proposal.value, signers);
        this.broadcast(node.id, { kind: "final", from: node.id, round: state.round, value: state.proposal.value, signers });
        return;
      }
      if (state.prepareVotes.size >= this.q) {
        state.qc = { round: state.round, value: state.proposal.value, signers: [...state.prepareVotes] };
        state.phase = "commit";
        this.leaderStep(node);
      }
      return;
    }
    if (state.phase !== "commit" || !state.qc || message.value !== state.qc.value) return;
    if (!this.isByz(message.from) && !this.honestCommitted.get(`${message.round}:${message.value}`)?.has(message.from)) return;
    state.commitVotes.add(message.from);
    if (state.commitVotes.size >= this.q) {
      const signers = [...state.commitVotes];
      state.phase = "done";
      this.decide(node, state.round, state.qc.value, signers);
      this.broadcast(node.id, { kind: "final", from: node.id, round: state.round, value: state.qc.value, signers });
    }
  }

  // ---- Byzantine adversary ----
  private byzantineReceive(node: Node, message: Message): void {
    if (this.cfg.byzantineSilent || !this.rng.chance(0.8)) return; // sometimes silent
    switch (message.kind) {
      case "prepare":
        this.send(node.id, message.from, { kind: "prepare-vote", from: node.id, round: message.round, value: message.value });
        break;
      case "commit":
        this.send(node.id, message.from, { kind: "commit-vote", from: node.id, round: message.round, value: message.qc.value });
        break;
      case "timeout-req": {
        // Report a stale (lower) valid QC or nothing, to hide locks.
        const qcs = this.allValidQCs().filter((qc) => qc.round <= message.round);
        const choice = qcs.length && this.rng.chance(0.4) ? this.rng.pick(qcs) : null;
        this.send(node.id, message.from, {
          kind: "timeout-vote",
          from: node.id,
          claim: { from: node.id, round: message.round, hr: choice ? choice.round : -1, hv: choice ? choice.value : "" },
          qc: choice
        });
        break;
      }
      default:
        break;
    }
  }

  private honestIds(): number[] { return this.nodes.filter((node) => !node.byzantine).map((node) => node.id); }

  /** Build the TC for round r that hides the highest locks (lowest max claim). */
  private adversaryTC(round: number): TC | null {
    const honest = [...(this.honestTimeouts.get(round)?.entries() ?? [])]
      .map(([from, signed]) => ({ from, round, hr: signed.hr, hv: signed.hv, qc: signed.qc }))
      .sort((a, b) => a.hr - b.hr);
    const byz = this.cfg.byzantine.map((from) => ({ from, round, hr: -1, hv: "", qc: null as QC | null }));
    const votes = [...byz, ...honest].slice(0, Math.max(this.q, byz.length + this.rng.int(honest.length + 1)));
    if (votes.length < this.q) return null;
    let best: QC | null = null;
    for (const vote of votes) if (vote.hr >= 0 && (!best || vote.hr > best.round)) best = vote.qc;
    return { round, votes: votes.map(({ qc: _qc, ...claim }) => claim), highQC: best };
  }

  private byzantineTick(node: Node): void {
    if (this.cfg.byzantineSilent || this.rng.next() > this.cfg.byzantineActivity) return;
    const local = this.local(node.id);
    const round = Math.max(0, this.clockRound(local + this.cfg.timeoutGuardMs));
    this.maxRoundSeen = Math.max(this.maxRoundSeen, round);
    const honest = this.honestIds();
    const action = this.rng.int(5);
    if (leaderOf(this.cfg.n, this.height, round) === node.id && action <= 2) {
      // Equivocating leader: different proposals to different honest subsets.
      let tc: TC | null = null;
      if (round > 0) {
        // Ask honest validators for timeouts so signatures exist, then use whatever is known.
        for (const id of honest) this.send(node.id, id, { kind: "timeout-req", from: node.id, round: round - 1 });
        tc = this.adversaryTC(round - 1);
        if (!tc) return;
      }
      let justify = tc?.highQC ?? null;
      if (!this.cfg.checkLeaderRule && this.rng.chance(0.6)) {
        const lower = this.allValidQCs().filter((qc) => qc.round < round);
        justify = lower.length && this.rng.chance(0.5) ? this.rng.pick(lower) : null;
      }
      const values = justify ? [justify.value] : [`X${node.id}r${round}a`, `X${node.id}r${round}b`];
      for (const value of values) this.knownValues.add(value);
      for (const id of honest) {
        if (this.rng.chance(0.2)) continue;
        const value = this.rng.pick(values);
        this.send(node.id, id, { kind: "prepare", from: node.id, round, value, justify, tc });
      }
    } else if (action === 3) {
      // Partial commit: deliver any assemblable QC to a random honest subset.
      const qcs = this.allValidQCs();
      if (this.rng.chance(0.3) && this.knownValues.size) {
        // Fabricated QC (signatures that do not exist); honest nodes must reject it.
        const value = this.rng.pick([...this.knownValues]);
        const fake: QC = { round, value, signers: this.nodes.map((item) => item.id).slice(0, this.q) };
        for (const id of this.rng.subset(honest, 0.6)) this.send(node.id, id, { kind: "commit", from: node.id, round, qc: fake });
      } else if (qcs.length) {
        const qc = this.rng.pick(qcs);
        for (const id of this.rng.subset(honest, 0.4)) this.send(node.id, id, { kind: "commit", from: node.id, round: qc.round, qc });
      }
    } else if (action === 4 && round > 0) {
      // Solicit timeouts early to try to cut honest leaders' rounds short.
      for (const id of this.rng.subset(honest, 0.6)) this.send(node.id, id, { kind: "timeout-req", from: node.id, round: round - 1 });
    }
  }

  // ---- invariants ----
  finalizableSet(): Array<{ round: number; value: string }> {
    const result: Array<{ round: number; value: string }> = [];
    const byz = this.cfg.byzantine.length;
    if (this.has("cross-round-commit-count")) {
      const byValue = new Map<string, Set<number>>();
      for (const [key, set] of this.honestCommitted) {
        const value = key.slice(key.indexOf(":") + 1);
        if (!byValue.has(value)) byValue.set(value, new Set());
        for (const id of set) byValue.get(value)!.add(id);
      }
      for (const [value, set] of byValue) if (set.size + byz >= this.q) result.push({ round: -1, value });
      return result;
    }
    for (const [key, set] of this.honestCommitted) {
      if (set.size + byz >= this.q) {
        const separator = key.indexOf(":");
        result.push({ round: Number(key.slice(0, separator)), value: key.slice(separator + 1) });
      }
    }
    return result;
  }

  private checkFinalizable(): void {
    const values = new Set(this.finalizableSet().map((item) => item.value));
    for (const node of this.nodes) if (node.decided) values.add(node.decided.value);
    if (values.size > 1) this.violation(`S3: conflicting finalizable values ${[...values].join(",")}`);
  }

  /**
   * Liveness bound (§8.3): the first round that starts after GST + DELTA (with
   * skew and guard), then faulty+1 rounds to reach an honest leader, plus one
   * round of slack for the round in flight at GST.
   */
  livenessBound(): { applicable: boolean; boundRound: number | null } {
    const faulty = new Set([...this.cfg.byzantine, ...this.cfg.permanentlyCrashed]).size;
    const maxSkew = Math.max(...this.cfg.skewMs.map((skew) => Math.abs(skew)));
    const applicable = this.cfg.checkLiveness && this.cfg.n - faulty >= this.q &&
      maxSkew * 2 <= this.cfg.timeoutGuardMs && (this.cfg.qcLossOnRestart ?? 0) === 0 &&
      (this.cfg.mutation === "none" || this.cfg.mutation === "timeout-exclusive-with-vote") &&
      (this.cfg.variant === "two-phase" || this.cfg.variant === "one-phase-strict");
    if (!applicable) return { applicable, boundRound: null };
    let gstRound = 0;
    while (this.roundStart(gstRound) < this.cfg.gstMs + this.cfg.deltaMs + maxSkew + this.cfg.timeoutGuardMs) gstRound += 1;
    return { applicable, boundRound: gstRound + faulty + 1 };
  }

  private finish(): ModelResult {
    this.checkFinalizable();
    const { applicable: livenessApplicable, boundRound } = this.livenessBound();
    if (livenessApplicable && boundRound !== null) {
      const deadline = this.roundEnd(boundRound);
      for (const node of this.nodes) {
        if (node.byzantine || node.permanentlyDown) continue;
        if (!node.decided || node.decidedAt === null || node.decidedAt > deadline) {
          this.violation(`LIVENESS: v${node.id} undecided by end of round ${boundRound} (t=${deadline}, gst=${this.cfg.gstMs}, decidedAt=${node.decidedAt})`);
        }
      }
      if (this.firstDecisionAt !== null && this.firstDecisionAt > deadline) {
        this.violation(`LIVENESS: first decision at ${this.firstDecisionAt} after bound ${deadline}`);
      }
    }
    return {
      seed: this.cfg.seed,
      ok: this.violations.length === 0,
      violations: [...this.violations],
      decided: this.nodes.map((node) => node.decided ? { node: node.id, ...node.decided } : null),
      decisionTimeMs: this.firstDecisionAt,
      decisionRound: this.firstDecisionRound,
      livenessChecked: livenessApplicable,
      livenessBoundRound: boundRound,
      events: this.events,
      maxRound: this.maxRoundSeen,
      finalizable: this.finalizableSet(),
      trace: this.trace
    };
  }

  // ---- scripted access (deterministic scenarios) ----
  /** Expose internals for scripted scenarios in tests. */
  scripted(): ScriptedModelAccess {
    return {
      nodes: this.nodes,
      deliver: (to, message) => { this.deliver(to, message as Message); },
      runUntil: (t) => {
        while (this.queue.length > 0 && this.queue[0]!.at <= t) {
          const item = this.queue.shift()!;
          this.now = item.at;
          this.events += 1;
          item.run();
        }
        this.now = Math.max(this.now, t);
      },
      setNow: (t) => { this.now = t; },
      adversaryQC: (round, value) => this.adversaryQC(round, value),
      qcValid: (qc) => this.qcValid(qc),
      finalizable: () => this.finalizableSet(),
      finish: () => this.finish(),
      timeoutClaims: (round) => [...(this.honestTimeouts.get(round)?.entries() ?? [])]
        .map(([from, signed]) => ({ from, round, hr: signed.hr, hv: signed.hv, qc: signed.qc })),
      roundEnd: (round) => this.roundEnd(round),
      roundStart: (round) => this.roundStart(round)
    };
  }
}

export interface ScriptedModelAccess {
  nodes: unknown[];
  deliver(to: number, message: unknown): void;
  runUntil(t: number): void;
  setNow(t: number): void;
  adversaryQC(round: number, value: string): QC | null;
  qcValid(qc: QC): boolean;
  finalizable(): Array<{ round: number; value: string }>;
  finish(): ModelResult;
  timeoutClaims(round: number): Array<{ from: number; round: number; hr: number; hv: string; qc: QC | null }>;
  roundEnd(round: number): number;
  roundStart(round: number): number;
}

function emptyJournal(): Journal {
  return { proposal: new Map(), prepare: new Map(), commit: new Map(), timeout: new Map(), lock: null, prepareExtra: new Map() };
}

// ---- randomized schedule generation ----
export interface ScheduleProfile {
  n: number;
  byzantineCount: number;
  crashedCount: number;
}

export function randomConfig(seed: number, profile: ScheduleProfile, overrides: Partial<ModelConfig> = {}): ModelConfig {
  const rng = new Rng(seed ^ 0x5bd1e995);
  const ids = Array.from({ length: profile.n }, (_, index) => index);
  // shuffle
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swap = rng.int(index + 1);
    [ids[index], ids[swap]] = [ids[swap]!, ids[index]!];
  }
  const byzantine = ids.slice(0, profile.byzantineCount);
  const permanentlyCrashed = ids.slice(profile.byzantineCount, profile.byzantineCount + profile.crashedCount);
  const guard = 2_000;
  const skewMs = ids.map(() => rng.int(guard + 1) - Math.floor(guard / 2));
  return {
    n: profile.n,
    byzantine,
    permanentlyCrashed,
    seed,
    gstMs: rng.int(4) * 60_000 + rng.int(60_000),
    preGstDropRate: rng.next() * 0.6,
    preGstMaxDelayMs: 1 + rng.int(20_000),
    partitions: rng.chance(0.5),
    linkFailureRate: rng.chance(0.5) ? rng.next() * 0.5 : 0,
    crashRestart: rng.chance(0.5),
    skewMs,
    byzantineActivity: 0.2 + rng.next() * 0.8,
    ...overrides
  };
}

export const SCHEDULE_PROFILES: ScheduleProfile[] = (() => {
  const profiles: ScheduleProfile[] = [];
  for (const n of [1, 2, 3, 4, 7]) {
    const q = quorum(n);
    const tolerable = n - q; // faults compatible with liveness
    const safetyBound = 2 * q - n - 1; // Byzantine faults compatible with safety
    profiles.push({ n, byzantineCount: 0, crashedCount: 0 });
    if (tolerable > 0) {
      profiles.push({ n, byzantineCount: tolerable, crashedCount: 0 });
      profiles.push({ n, byzantineCount: 0, crashedCount: tolerable });
    }
    if (safetyBound > tolerable) profiles.push({ n, byzantineCount: safetyBound, crashedCount: 0 });
  }
  return profiles;
})();

export interface ScheduleRunSummary {
  schedules: number;
  firstSeed: number;
  lastSeed: number;
  failures: Array<{ seed: number; profile: ScheduleProfile; violations: string[] }>;
  livenessChecked: number;
  decided: number;
  maxDecisionRound: number;
  events: number;
  byProfile: Record<string, number>;
}

export function runRandomSchedules(count: number, firstSeed = 1, overrides: Partial<ModelConfig> = {}): ScheduleRunSummary {
  const summary: ScheduleRunSummary = {
    schedules: 0, firstSeed, lastSeed: firstSeed + count - 1, failures: [], livenessChecked: 0, decided: 0,
    maxDecisionRound: 0, events: 0, byProfile: {}
  };
  for (let seed = firstSeed; seed < firstSeed + count; seed += 1) {
    const profile = SCHEDULE_PROFILES[seed % SCHEDULE_PROFILES.length]!;
    const result = new V6Model(randomConfig(seed, profile, overrides)).run();
    summary.schedules += 1;
    summary.events += result.events;
    const key = `n${profile.n}-b${profile.byzantineCount}-c${profile.crashedCount}`;
    summary.byProfile[key] = (summary.byProfile[key] ?? 0) + 1;
    if (result.livenessChecked) summary.livenessChecked += 1;
    if (result.decisionRound !== null) {
      summary.decided += 1;
      summary.maxDecisionRound = Math.max(summary.maxDecisionRound, result.decisionRound);
    }
    if (!result.ok) summary.failures.push({ seed, profile, violations: result.violations.slice(0, 3) });
  }
  return summary;
}

export function searchCounterexample(
  maxSeeds: number,
  overrides: Partial<ModelConfig>,
  profiles: ScheduleProfile[] = [
    { n: 4, byzantineCount: 1, crashedCount: 0 },
    { n: 7, byzantineCount: 2, crashedCount: 0 },
    { n: 3, byzantineCount: 2, crashedCount: 0 },
    { n: 4, byzantineCount: 0, crashedCount: 1 }
  ]
): { seed: number; profile: ScheduleProfile; violation: string } | null {
  for (let seed = 1; seed <= maxSeeds; seed += 1) {
    const profile = profiles[seed % profiles.length]!;
    const result = new V6Model(randomConfig(seed, profile, overrides)).run();
    if (!result.ok) return { seed, profile, violation: result.violations[0]! };
  }
  return null;
}
