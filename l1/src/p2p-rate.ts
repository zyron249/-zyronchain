export class P2PPeerRateLimiter {
  private readonly peers = new Map<string, { startedAtMs: number; count: number }>();
  private overflow: { startedAtMs: number; count: number } | undefined;
  private nextSweepAtMs = Number.POSITIVE_INFINITY;

  constructor(
    private readonly requestsPerWindow: number,
    private readonly windowMs: number,
    private readonly maxTrackedPeers = 1_024,
    private readonly overflowRequestsPerWindow = requestsPerWindow
  ) {
    if (!Number.isSafeInteger(requestsPerWindow) || requestsPerWindow < 1 || requestsPerWindow > 100_000 ||
        !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 60 * 60 * 1_000 ||
        !Number.isSafeInteger(maxTrackedPeers) || maxTrackedPeers < 1 || maxTrackedPeers > 100_000 ||
        !Number.isSafeInteger(overflowRequestsPerWindow) || overflowRequestsPerWindow < 1 || overflowRequestsPerWindow > 100_000) {
      throw new Error("Invalid P2P peer rate limits");
    }
  }

  consume(peerId: string, nowMs = Date.now()): boolean {
    if (peerId.length < 1 || peerId.length > 256 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("Invalid P2P peer rate-limit identity");
    }

    let entry = this.peers.get(peerId);
    if (entry && nowMs - entry.startedAtMs >= this.windowMs) {
      this.peers.delete(peerId);
      entry = undefined;
    }

    if (!entry) {
      if (this.peers.size >= this.maxTrackedPeers && nowMs >= this.nextSweepAtMs) this.sweep(nowMs);
      if (this.peers.size >= this.maxTrackedPeers) return this.consumeOverflow(nowMs);
      entry = { startedAtMs: nowMs, count: 0 };
      this.peers.set(peerId, entry);
      this.nextSweepAtMs = Math.min(this.nextSweepAtMs, nowMs + this.windowMs);
    }

    entry.count += 1;
    return entry.count <= this.requestsPerWindow;
  }

  private consumeOverflow(nowMs: number): boolean {
    if (!this.overflow || nowMs - this.overflow.startedAtMs >= this.windowMs) {
      this.overflow = { startedAtMs: nowMs, count: 0 };
    }
    this.overflow.count += 1;
    return this.overflow.count <= this.overflowRequestsPerWindow;
  }

  private sweep(nowMs: number): void {
    let nextSweepAtMs = Number.POSITIVE_INFINITY;
    for (const [peerId, entry] of this.peers) {
      const expiresAtMs = entry.startedAtMs + this.windowMs;
      if (nowMs >= expiresAtMs) this.peers.delete(peerId);
      else nextSweepAtMs = Math.min(nextSweepAtMs, expiresAtMs);
    }
    this.nextSweepAtMs = nextSweepAtMs;
  }
}
