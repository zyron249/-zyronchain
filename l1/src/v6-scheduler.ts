// Protocol v6 event-driven validator scheduling (F-01 spec §3.3, §8.6).
//
// The legacy fixed 30 s setInterval tick is phase-locked to process start and
// must not drive v6 consensus. Instead, each validator:
//   - acts as the round-r leader from roundStart(H, r) - TIMEOUT_GUARD_MS (r > 0:
//     early entry once TC(H, r-1) can exist) or roundStart(H, 0) (r = 0), plus
//     a random jitter of 0..V6_LEADER_JITTER_MAX_MS;
//   - retries a failed attempt every V6_LEADER_RETRY_MS (<= 1 s) while it is
//     still the leader of that round (a retry re-sends the stored proposal);
//   - otherwise sleeps until its next leader slot, bounded by the fallback poll
//     V6_FALLBACK_POLL_MS (= ROUND_BASE_MS / 10) so new tips are noticed.
// Attempts never overlap. Validators answer prepare/commit/timeout requests
// immediately through the RPC/native handlers, independent of this loop.
import { expectedValidator } from "./block.js";
import {
  V6_FALLBACK_POLL_MS,
  V6_LEADER_JITTER_MAX_MS,
  V6_LEADER_RETRY_MS,
  V6_MAX_ROUND,
  V6_TIMEOUT_GUARD_MS,
  clockRound,
  roundStart
} from "./consensus-v6.js";
import type { Validator } from "./types.js";

export interface V6LeaderSlot {
  height: number;
  round: number;
}

export interface V6WakePlanInput {
  tipTimestampMs: number;
  height: number;
  validators: Validator[];
  publicKey: string;
  nowMs: number;
  jitterMs: number;
}

/** Earliest local time at which the leader of `round` may act (§3.3). */
export function v6LeaderStart(tipTimestampMs: number, round: number): number {
  return round === 0 ? roundStart(tipTimestampMs, 0) : roundStart(tipTimestampMs, round) - V6_TIMEOUT_GUARD_MS;
}

/**
 * The leader round this validator may act in now (null if none), or the delay
 * until its next leader slot, capped by the fallback poll.
 */
export function planV6Wake(input: V6WakePlanInput): { act: V6LeaderSlot | null; delayMs: number } {
  const { tipTimestampMs, height, validators, publicKey, nowMs } = input;
  const jitterMs = Math.max(0, Math.min(V6_LEADER_JITTER_MAX_MS, Math.floor(input.jitterMs)));
  if (!Number.isSafeInteger(nowMs) || !validators.some((validator) => validator.publicKey === publicKey)) {
    return { act: null, delayMs: V6_FALLBACK_POLL_MS };
  }
  const isLeader = (round: number): boolean => expectedValidator(validators, height, round).publicKey === publicKey;
  // The round whose leader may act now (leader of r > 0 enters `guard` early);
  // null before roundStart(H, 0) - guard, when round 0 is the next slot.
  const current = clockRound(tipTimestampMs, nowMs + V6_TIMEOUT_GUARD_MS);
  if (current === null && nowMs + V6_TIMEOUT_GUARD_MS >= roundStart(tipTimestampMs, 0)) {
    return { act: null, delayMs: V6_FALLBACK_POLL_MS }; // beyond V6_MAX_ROUND
  }
  const first = current ?? 0;
  for (let round = first; round <= Math.min(V6_MAX_ROUND, first + validators.length); round += 1) {
    if (!isLeader(round)) continue;
    const start = v6LeaderStart(tipTimestampMs, round) + jitterMs;
    // Only round === current can already have started (later slots start after now).
    if (round === current && nowMs >= start) return { act: { height, round }, delayMs: 0 };
    return { act: null, delayMs: Math.max(1, Math.min(start - nowMs, V6_FALLBACK_POLL_MS)) };
  }
  return { act: null, delayMs: V6_FALLBACK_POLL_MS };
}

export interface V6SchedulerClock {
  now(): number;
  setTimeout(callback: () => unknown, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
}

export const SYSTEM_V6_SCHEDULER_CLOCK: V6SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  random: () => Math.random()
};

export interface V6SchedulerOptions<T> {
  /** Current context, or null while the next height is not governed by v6. */
  context(): Omit<V6WakePlanInput, "nowMs" | "jitterMs"> | null;
  /** One leader attempt; resolves to a truthy value on finality. */
  attempt(nowMs: number): Promise<T | null>;
  onResult?(result: T): void;
  onError?(error: unknown): void;
  clock?: V6SchedulerClock;
}

export class V6LeaderScheduler<T> {
  private timer: unknown;
  private running = false;
  private stopped = true;
  private readonly clock: V6SchedulerClock;
  /** Leader jitter, drawn once per height so that a wake-up lands inside its own slot. */
  private jitter: { height: number; ms: number } | undefined;
  /** Attempts per leader slot, for diagnostics and tests. */
  readonly attempts: Array<V6LeaderSlot & { atMs: number; finalized: boolean }> = [];

  constructor(private readonly options: V6SchedulerOptions<T>) {
    this.clock = options.clock ?? SYSTEM_V6_SCHEDULER_CLOCK;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.arm(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    this.timer = this.clock.setTimeout(() => this.tick(), Math.max(0, delayMs));
  }

  /** One scheduler step (exposed for deterministic simulations). */
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    let delayMs = V6_FALLBACK_POLL_MS;
    try {
      const context = this.options.context();
      if (context) {
        const nowMs = this.clock.now();
        if (this.jitter?.height !== context.height) {
          this.jitter = { height: context.height, ms: Math.floor(this.clock.random() * (V6_LEADER_JITTER_MAX_MS + 1)) };
        }
        const plan = planV6Wake({ ...context, nowMs, jitterMs: this.jitter.ms });
        delayMs = plan.delayMs;
        if (plan.act) {
          let finalized = false;
          try {
            const result = await this.options.attempt(nowMs);
            if (result) {
              finalized = true;
              this.options.onResult?.(result);
            }
          } catch (error) {
            this.options.onError?.(error);
          }
          this.attempts.push({ ...plan.act, atMs: nowMs, finalized });
          // Retry within the same leader slot after <= 1 s; otherwise re-plan now.
          const after = this.options.context();
          const stillLeader = !finalized && after !== null && after.height === plan.act.height &&
            planV6Wake({ ...after, nowMs: this.clock.now(), jitterMs: 0 }).act?.round === plan.act.round;
          delayMs = stillLeader ? V6_LEADER_RETRY_MS : 0;
        }
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
      this.arm(delayMs);
    }
  }
}
