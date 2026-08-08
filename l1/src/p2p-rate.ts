export class P2PPeerRateLimiter {
  private readonly peers = new Map<string, { startedAtMs: number; count: number }>();

  constructor(
    private readonly requestsPerWindow: number,
    private readonly windowMs: number,
    private readonly maxTrackedPeers = 1_024
  ) {
    if (!Number.isSafeInteger(requestsPerWindow) || requestsPerWindow < 1 || requestsPerWindow > 100_000 ||
        !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 60 * 60 * 1_000 ||
        !Number.isSafeInteger(maxTrackedPeers) || maxTrackedPeers < 1 || maxTrackedPeers > 100_000) {
      throw new Error("Invalid P2P peer rate limits");
    }
  }

  consume(peerId: string, nowMs = Date.now()): boolean {
    if (peerId.length < 1 || peerId.length > 256 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("Invalid P2P peer rate-limit identity");
    }
    this.sweep(nowMs);
    let entry = this.peers.get(peerId);
    if (!entry) {
      if (this.peers.size >= this.maxTrackedPeers) return false;
      entry = { startedAtMs: nowMs, count: 0 };
      this.peers.set(peerId, entry);
    }
    entry.count += 1;
    return entry.count <= this.requestsPerWindow;
  }

  private sweep(nowMs: number): void {
    for (const [peerId, entry] of this.peers) {
      if (nowMs - entry.startedAtMs >= this.windowMs) this.peers.delete(peerId);
    }
  }
}
