/**
 * Bounded diagnostics for round-skip votes rejected by the block producer.
 *
 * A rejected vote is counted by a fixed reason category and, at most
 * MAX_LOGGED_ROUND_SKIP_EVENTS_PER_ROUND times per (height, round), logged with
 * only the height, round, protocol version, validator address (when it is a
 * well-formed address) and a sanitized, truncated error message. Public keys,
 * signatures and raw vote payloads are never logged.
 */

export const MAX_LOGGED_ROUND_SKIP_EVENTS_PER_ROUND = 4;
const MAX_TRACKED_ROUND_SKIP_LOG_KEYS = 128;
const MAX_LOGGED_ERROR_CHARS = 160;
const ADDRESS_PATTERN = /^ZYN[0-9a-f]{40}$/;

export const ROUND_SKIP_VOTE_REJECTION_REASONS = [
  "invalid-signature",
  "unknown-voter",
  "mismatched-vote",
  "missing-protocol-version",
  "malformed-vote"
] as const;

export type RoundSkipVoteRejectionReason = typeof ROUND_SKIP_VOTE_REJECTION_REASONS[number];

export interface RoundSkipVoteDiagnosticsMetrics {
  rejectedVotes: number;
  rejectedVotesByReason: Record<RoundSkipVoteRejectionReason, number>;
  quorumFailures: number;
  suppressedLogLines: number;
}

export interface RoundSkipEventContext {
  height: number;
  round: number;
  protocolVersion: number;
  error: unknown;
}

export function classifyRoundSkipVoteRejection(error: unknown): RoundSkipVoteRejectionReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/Invalid round skip signature/.test(message)) return "invalid-signature";
  if (/Unknown round skip voter/.test(message)) return "unknown-voter";
  if (/does not match proposal/.test(message)) return "mismatched-vote";
  if (/explicit protocol version/.test(message)) return "missing-protocol-version";
  return "malformed-vote";
}

function sanitizedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const printable = message.replace(/[^\x20-\x7e]/g, "?");
  return printable.length > MAX_LOGGED_ERROR_CHARS ? `${printable.slice(0, MAX_LOGGED_ERROR_CHARS)}...` : printable;
}

function voteValidatorAddress(vote: unknown): string {
  if (typeof vote !== "object" || vote === null || Array.isArray(vote)) return "unknown";
  const validator = (vote as Record<string, unknown>).validator;
  return typeof validator === "string" && ADDRESS_PATTERN.test(validator) ? validator : "unknown";
}

export class RoundSkipVoteDiagnostics {
  private rejectedVotes = 0;
  private quorumFailures = 0;
  private suppressedLogLines = 0;
  private readonly byReason = Object.fromEntries(
    ROUND_SKIP_VOTE_REJECTION_REASONS.map((reason) => [reason, 0])
  ) as Record<RoundSkipVoteRejectionReason, number>;
  private readonly loggedPerRound = new Map<string, number>();

  constructor(private readonly log: (line: string) => void = (line) => console.warn(line)) {}

  recordRejectedVote(context: RoundSkipEventContext & { vote: unknown }): void {
    const reason = classifyRoundSkipVoteRejection(context.error);
    this.rejectedVotes += 1;
    this.byReason[reason] += 1;
    this.emit(context, () =>
      `Rejected round skip vote: height=${context.height} round=${context.round} ` +
      `protocolVersion=${context.protocolVersion} validator=${voteValidatorAddress(context.vote)} ` +
      `reason=${reason} error=${sanitizedErrorMessage(context.error)}`);
  }

  recordQuorumFailure(context: RoundSkipEventContext): void {
    this.quorumFailures += 1;
    this.emit(context, () =>
      `Round skip certificate incomplete: height=${context.height} round=${context.round} ` +
      `protocolVersion=${context.protocolVersion} error=${sanitizedErrorMessage(context.error)}`);
  }

  metrics(): RoundSkipVoteDiagnosticsMetrics {
    return {
      rejectedVotes: this.rejectedVotes,
      rejectedVotesByReason: { ...this.byReason },
      quorumFailures: this.quorumFailures,
      suppressedLogLines: this.suppressedLogLines
    };
  }

  private emit(context: RoundSkipEventContext, line: () => string): void {
    const key = `${context.height}:${context.round}`;
    const logged = this.loggedPerRound.get(key) ?? 0;
    if (logged >= MAX_LOGGED_ROUND_SKIP_EVENTS_PER_ROUND) {
      this.suppressedLogLines += 1;
      return;
    }
    if (!this.loggedPerRound.has(key) && this.loggedPerRound.size >= MAX_TRACKED_ROUND_SKIP_LOG_KEYS) {
      const oldest = this.loggedPerRound.keys().next().value;
      if (oldest !== undefined) this.loggedPerRound.delete(oldest);
    }
    this.loggedPerRound.set(key, logged + 1);
    try {
      this.log(line());
    } catch {
      // Diagnostics must never affect consensus progress.
    }
  }
}
