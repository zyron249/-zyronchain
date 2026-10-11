// Deterministic discrete-event simulation of protocol v6 validators driven by
// the production V6LeaderScheduler (F-01 phase 5: T6, T13, chaos runs).
//
// Every validator is a real NodeService with a real fsynced journal and
// consensus-state directory (consensus-harness.ts). Time is virtual: all
// scheduler timers live in one queue and each callback (a scheduler tick,
// including a whole leader attempt) is awaited before time advances, so a run
// is reproducible from its seed. Message delivery goes through MemoryNetwork
// with a pluggable link filter (partitions, drops, crashes). A
// SignatureLedger records every v6 signature that crosses the network (after
// verifying it) so that runs can assert "no honest double-sign" and "no two
// commit certificates for different blocks at one height" independently of
// the journal that is supposed to guarantee them.
import { expectedValidator } from "../../src/block.js";
import {
  V6_COMMIT_VOTE_DOMAIN,
  V6_PREPARE_VOTE_DOMAIN,
  isConsensusV6,
  timeoutDigest,
  validateTimeoutVote,
  validateV6Vote,
  verifyProposalSignature,
  type PrepareQC,
  type V6CommitRequest,
  type V6PrepareRequest,
  type V6TimeoutResponse,
  type V6Vote
} from "../../src/consensus-v6.js";
import { validatorQuorumSize } from "../../src/block.js";
import { produceFinalizedBlock, type ConsensusPeerClient } from "../../src/node.js";
import type { Block, Validator } from "../../src/types.js";
import { V6LeaderScheduler, type V6SchedulerClock } from "../../src/v6-scheduler.js";
import { MemoryNetwork, openValidator, type MessageKind, type TestNetworkConfig, type TestValidator } from "./consensus-harness.js";

/** mulberry32: small seeded PRNG for reproducible schedules. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Timer { at: number; seq: number; callback: () => unknown }

export class VirtualTime {
  private seq = 0;
  private readonly timers = new Map<number, Timer>();
  constructor(public nowMs: number) {}

  setTimeout(callback: () => unknown, delayMs: number): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.nowMs + Math.max(0, Math.floor(delayMs)), seq: id, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Run timers in time order until `untilMs`, or until `stop()` returns true after a callback. */
  async run(untilMs: number, stop: () => boolean = () => false): Promise<boolean> {
    for (;;) {
      let nextId: number | undefined;
      let next: Timer | undefined;
      for (const [id, timer] of this.timers) {
        if (!next || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq)) { next = timer; nextId = id; }
      }
      if (!next || next.at > untilMs) {
        this.nowMs = Math.max(this.nowMs, untilMs);
        return false;
      }
      this.timers.delete(nextId!);
      this.nowMs = Math.max(this.nowMs, next.at);
      await next.callback();
      if (stop()) return true;
    }
  }
}

export interface LedgerConflict { publicKey: string; key: string; values: string[] }

/**
 * Records verified v6 signatures by (signer, step, height, round). Two
 * different values under one key are a double-sign. Commit votes are also
 * grouped into certificates to detect conflicting finality.
 */
export class SignatureLedger {
  private readonly entries = new Map<string, Set<string>>();
  private readonly commitVotes = new Map<string, Set<string>>(); // `${H}|${hash}|${r}` -> signers
  count = 0;

  constructor(private readonly chainId: string, private readonly validatorsAt: (height: number) => Validator[]) {}

  private record(publicKey: string, step: string, height: number, round: number, value: string): void {
    const key = `${publicKey}|${step}|${height}|${round}`;
    let set = this.entries.get(key);
    if (!set) { set = new Set(); this.entries.set(key, set); }
    if (!set.has(value)) this.count += 1;
    set.add(value);
  }

  private vote(step: "prepare" | "commit", vote: unknown, height: number, round: number, hash: string): void {
    const domain = step === "prepare" ? V6_PREPARE_VOTE_DOMAIN : V6_COMMIT_VOTE_DOMAIN;
    try {
      validateV6Vote(vote, this.validatorsAt(height), domain, this.chainId, height, round, hash);
    } catch {
      return; // unverifiable: not evidence of anything
    }
    const valid = vote as V6Vote;
    this.record(valid.publicKey, step, height, round, hash);
    if (step === "commit") {
      const key = `${height}|${hash}|${round}`;
      let signers = this.commitVotes.get(key);
      if (!signers) { signers = new Set(); this.commitVotes.set(key, signers); }
      signers.add(valid.publicKey);
    }
  }

  qc(qc: PrepareQC | null | undefined): void {
    if (!qc) return;
    for (const vote of qc.votes) this.vote("prepare", vote, qc.height, qc.round, qc.blockHash);
  }

  timeout(response: V6TimeoutResponse | unknown, height: number, round: number): void {
    const item = response as V6TimeoutResponse;
    try {
      validateTimeoutVote(item?.vote, this.validatorsAt(height), this.chainId, height, round);
    } catch {
      return;
    }
    this.record(item.vote.publicKey, "timeout", height, round, timeoutDigest(item.vote));
    this.qc(item.highQC);
  }

  prepareRequest(request: V6PrepareRequest): void {
    const { proposal, block, tc } = request;
    const validators = this.validatorsAt(proposal.height);
    try {
      verifyProposalSignature(proposal, validators);
      const leader = expectedValidator(validators, proposal.height, proposal.round);
      this.record(leader.publicKey, "proposal", proposal.height, proposal.round, `${proposal.blockHash}/${proposal.justifyRound}`);
    } catch {
    }
    // The block header signature binds (H, origin round) to one block.
    if (block.proposerPublicKey) this.record(block.proposerPublicKey, "block-proposal", block.header.height, block.header.round, block.hash);
    if (tc) {
      for (const vote of tc.votes) this.timeout({ vote, highQC: null }, tc.height, tc.round);
      this.qc(tc.highQC);
    }
  }

  prepareResponses(request: V6PrepareRequest, votes: unknown[]): void {
    for (const vote of votes) this.vote("prepare", vote, request.proposal.height, request.proposal.round, request.block.hash);
  }

  commitRequest(request: V6CommitRequest, votes: unknown[] = []): void {
    this.qc(request.qc);
    for (const vote of votes) this.vote("commit", vote, request.qc.height, request.qc.round, request.qc.blockHash);
  }

  finalized(block: Block): void {
    if (block.commitRound === undefined || block.commitRound === null) return;
    for (const vote of block.attestations) this.vote("commit", vote, block.header.height, block.commitRound, block.hash);
  }

  /** Keys with more than one signed value (double-signs), optionally restricted to some signers. */
  conflicts(signers?: Set<string>): LedgerConflict[] {
    const result: LedgerConflict[] = [];
    for (const [key, values] of this.entries) {
      if (values.size < 2) continue;
      const publicKey = key.split("|")[0]!;
      if (signers && !signers.has(publicKey)) continue;
      result.push({ publicKey, key, values: [...values] });
    }
    return result;
  }

  /** Heights with commit certificates (>= q distinct commit votes) for more than one block. */
  conflictingCertificates(): Array<{ height: number; hashes: string[] }> {
    const byHeight = new Map<number, Set<string>>();
    for (const [key, signers] of this.commitVotes) {
      const [heightText, hash] = key.split("|") as [string, string];
      const height = Number(heightText);
      if (signers.size < validatorQuorumSize(this.validatorsAt(height).length)) continue;
      let hashes = byHeight.get(height);
      if (!hashes) { hashes = new Set(); byHeight.set(height, hashes); }
      hashes.add(hash);
    }
    return [...byHeight].filter(([, hashes]) => hashes.size > 1).map(([height, hashes]) => ({ height, hashes: [...hashes] }));
  }

  /** Wrap a peer client so that everything it sends and receives is recorded. */
  wrap(peers: ConsensusPeerClient): ConsensusPeerClient {
    return {
      requestAttestations: (block) => peers.requestAttestations(block),
      requestRoundSkips: (height, round, previous) => peers.requestRoundSkips(height, round, previous),
      broadcastBlock: async (block) => { this.finalized(block); await peers.broadcastBlock(block); },
      requestV6Prepare: async (request) => {
        this.prepareRequest(request);
        const votes = await (peers.requestV6Prepare?.(request) ?? Promise.resolve([]));
        this.prepareResponses(request, votes);
        return votes;
      },
      requestV6Commit: async (request) => {
        const votes = await (peers.requestV6Commit?.(request) ?? Promise.resolve([]));
        this.commitRequest(request, votes);
        return votes;
      },
      requestV6Timeouts: async (height, round) => {
        const responses = await (peers.requestV6Timeouts?.(height, round) ?? Promise.resolve([]));
        for (const response of responses) this.timeout(response, height, round);
        return responses;
      },
      fetchV6Block: (height, hash) => peers.fetchV6Block?.(height, hash) ?? Promise.resolve(null)
    };
  }
}

export interface SimFinality { height: number; hash: string; commitRound: number; headerRound: number; atMs: number; leader: number }

export interface V6SimOptions {
  network: TestNetworkConfig;
  prefix: Block[];
  validators: TestValidator[];
  seed: number;
  /** Per-validator constant clock offsets. */
  skewMs?: number[];
  /** Virtual time of the first event (default: the shared tip timestamp). */
  startMs?: number;
  /** Periodic block sync between reachable validators (the CLI's peer sync), default 10 s. */
  syncIntervalMs?: number;
  /** Byzantine equivocating leader: `twin` shares the key of `index` with a separate journal. */
  byzantine?: { index: number; twin: TestValidator; sideA: Set<number> };
}

/**
 * Validators driven by V6LeaderScheduler instances on a virtual clock. The
 * link filter `linkDown(from, to, kind, nowMs)` decides delivery; validators
 * marked offline neither lead nor answer.
 */
export class V6Sim {
  readonly time: VirtualTime;
  readonly memory: MemoryNetwork;
  readonly ledger: SignatureLedger;
  readonly random: () => number;
  readonly schedulers: Array<V6LeaderScheduler<Block> | undefined>;
  readonly finality: SimFinality[] = [];
  readonly errors: string[] = [];
  readonly restarts: Array<{ index: number; atMs: number; lock: string | null }> = [];
  linkDown: (from: number, to: number, kind: MessageKind, nowMs: number) => boolean = () => false;
  private twinMemory: MemoryNetwork | undefined;

  constructor(readonly options: V6SimOptions) {
    const { validators, network } = options;
    const tip = validators[0]!.service.store.chain.tip.header.timestampMs;
    this.time = new VirtualTime(options.startMs ?? tip);
    this.random = seededRandom(options.seed);
    this.memory = new MemoryNetwork(validators, () => this.time.nowMs);
    this.memory.drop = (from, to, kind) => this.linkDown(from, to, kind, this.time.nowMs);
    (options.skewMs ?? []).forEach((skew, index) => this.memory.skewMs.set(index, skew));
    this.ledger = new SignatureLedger(network.chainId, (height) => validators[0]!.service.store.chain.validatorsAt(height));
    this.schedulers = validators.map(() => undefined);
    if (options.byzantine) {
      const { index, twin, sideA } = options.byzantine;
      this.twinMemory = new MemoryNetwork(validators.map((validator, item) => item === index ? twin : validator), () => this.time.nowMs);
      this.twinMemory.drop = (from, to, kind) => (from === index && sideA.has(to)) || this.linkDown(from, to, kind, this.time.nowMs);
      (options.skewMs ?? []).forEach((skew, item) => this.twinMemory!.skewMs.set(item, skew));
      this.memory.drop = (from, to, kind) => (from === index && kind.startsWith("v6-") && kind !== "v6-timeout" && kind !== "v6-block" && !sideA.has(to)) ||
        this.linkDown(from, to, kind, this.time.nowMs);
    }
    const syncInterval = options.syncIntervalMs ?? 10_000;
    const syncLoop = async (): Promise<void> => {
      await this.syncAll();
      this.time.setTimeout(syncLoop, syncInterval);
    };
    this.time.setTimeout(syncLoop, syncInterval);
  }

  get validators(): TestValidator[] { return this.options.validators; }

  localNow(index: number): number {
    return this.time.nowMs + (this.memory.skewMs.get(index) ?? 0);
  }

  height(index: number): number {
    return this.validators[index]!.service.status().height;
  }

  maxHeight(): number {
    return Math.max(...this.validators.map((_, index) => this.height(index)));
  }

  private schedulerClock(index: number): V6SchedulerClock {
    return {
      now: () => this.localNow(index),
      setTimeout: (callback, delayMs) => this.time.setTimeout(callback, delayMs),
      clearTimeout: (handle) => this.time.clearTimeout(handle),
      random: this.random
    };
  }

  private async attempt(index: number, nowMs: number): Promise<Block | null> {
    const validator = this.validators[index]!;
    const key = this.options.network.privateKeys[index]!;
    const byzantine = this.options.byzantine;
    let block: Block | null = null;
    try {
      block = await produceFinalizedBlock(validator.service, this.ledger.wrap(this.memory.peersFor(index)), key, nowMs);
    } catch (error) {
      this.errors.push(`v${index} attempt: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (byzantine && byzantine.index === index && this.twinMemory) {
      // The twin proposes its own value for the same slot to the other side.
      try {
        const twinBlock = await produceFinalizedBlock(byzantine.twin.service, this.ledger.wrap(this.twinMemory.peersFor(index)), key, nowMs + 1);
        block ??= twinBlock;
      } catch (error) {
        this.errors.push(`twin attempt: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return block;
  }

  private scheduler(index: number): V6LeaderScheduler<Block> {
    return new V6LeaderScheduler<Block>({
      context: () => {
        if (!this.memory.online[index]) return null;
        const chain = this.validators[index]!.service.store.chain;
        const height = chain.height + 1;
        if (!isConsensusV6(chain.protocolVersionAt(height))) return null;
        return {
          tipTimestampMs: chain.tip.header.timestampMs,
          height,
          validators: chain.validatorsAt(height),
          publicKey: this.options.network.publicKeys[index]!
        };
      },
      attempt: (nowMs) => this.attempt(index, nowMs),
      onResult: (block) => {
        if (this.finality.some((item) => item.height === block.header.height)) return;
        this.finality.push({
          height: block.header.height,
          hash: block.hash,
          commitRound: block.commitRound ?? -1,
          headerRound: block.header.round,
          atMs: this.time.nowMs,
          leader: index
        });
      },
      onError: (error) => this.errors.push(`v${index} scheduler: ${error instanceof Error ? error.message : String(error)}`),
      clock: this.schedulerClock(index)
    });
  }

  /** Start validator `index`'s scheduler at virtual time `atMs` (process start offset). */
  startAt(index: number, atMs: number): void {
    this.time.setTimeout(() => {
      if (this.schedulers[index] || !this.memory.online[index]) return;
      const scheduler = this.scheduler(index);
      this.schedulers[index] = scheduler;
      scheduler.start();
    }, atMs - this.time.nowMs);
  }

  crash(index: number): void {
    this.retired += this.schedulers[index]?.attempts.length ?? 0;
    this.schedulers[index]?.stop();
    this.schedulers[index] = undefined;
    this.memory.online[index] = false;
  }

  /** Reopen validator `index` from its directory (journal, consensus state, chain) and restart its scheduler. */
  async restart(index: number): Promise<void> {
    this.crash(index);
    const old = this.validators[index]!;
    const height = old.service.store.chain.height + 1;
    const lock = old.journal.v6Lock(height);
    old.journal.close();
    const reopened = await openValidator(this.options.network, index, this.options.prefix, old.directory);
    this.validators[index] = reopened;
    this.memory.online[index] = true;
    this.restarts.push({ index, atMs: this.time.nowMs, lock: lock ? `${lock.round}:${lock.blockHash.slice(0, 12)}` : null });
    await this.syncAll();
    const scheduler = this.scheduler(index);
    this.schedulers[index] = scheduler;
    scheduler.start();
  }

  /** The CLI's periodic sync: pull finalized blocks from any reachable peer that is ahead. */
  async syncAll(): Promise<void> {
    const targets: Array<[number, TestValidator]> = this.validators.map((validator, index) => [index, validator]);
    if (this.options.byzantine) targets.push([this.options.byzantine.index, this.options.byzantine.twin]);
    for (const [index, validator] of targets) {
      if (!this.memory.online[index]) continue;
      for (let from = 0; from < this.validators.length; from += 1) {
        if (from === index || !this.memory.online[from] || this.linkDown(from, index, "sync", this.time.nowMs)) continue;
        const source = this.validators[from]!;
        while (validator.service.status().height < source.service.status().height) {
          const blocks = await source.service.store.readFinalizedBlocks(validator.service.status().height + 1, 16, 8_000_000);
          if (!blocks.length) break;
          try {
            for (const block of blocks) await validator.service.acceptFinalizedBlock(block);
          } catch (error) {
            this.errors.push(`sync v${from}->v${index}: ${error instanceof Error ? error.message : String(error)}`);
            break;
          }
        }
      }
    }
  }

  async run(untilMs: number, stop: () => boolean = () => false): Promise<boolean> {
    return this.time.run(untilMs, stop);
  }

  /** Leader attempts made by all schedulers that are still registered or were replaced. */
  attemptsTotal(): number {
    return this.retired + this.schedulers.reduce((sum, scheduler) => sum + (scheduler?.attempts.length ?? 0), 0);
  }

  private retired = 0;

  stopAll(): void {
    for (const scheduler of this.schedulers) scheduler?.stop();
  }

  /** Finalized hash of `height` per validator (undefined if not reached). */
  async finalizedHashes(height: number): Promise<Array<string | undefined>> {
    return Promise.all(this.validators.map(async (validator) => {
      const [block] = await validator.service.store.readFinalizedBlocks(height, 1, 8_000_000);
      return block?.header.height === height ? block.hash : undefined;
    }));
  }

  /** Every height reached by two validators has the same hash on both. */
  async assertNoConflictingFinality(fromHeight: number): Promise<{ heights: number; conflicts: number[] }> {
    const conflicts: number[] = [];
    const top = this.maxHeight();
    for (let height = fromHeight; height <= top; height += 1) {
      const hashes = new Set((await this.finalizedHashes(height)).filter((hash) => hash !== undefined));
      if (hashes.size > 1) conflicts.push(height);
    }
    return { heights: top - fromHeight + 1, conflicts };
  }
}
