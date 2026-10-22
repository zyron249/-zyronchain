export class P2PPeerRateLimiter {
    requestsPerWindow;
    windowMs;
    maxTrackedPeers;
    overflowRequestsPerWindow;
    peers = new Map();
    nextSweepAtMs = Number.POSITIVE_INFINITY;
    overflowStartedAtMs = null;
    overflowCount = 0;
    constructor(requestsPerWindow, windowMs, maxTrackedPeers = 1_024, overflowRequestsPerWindow = requestsPerWindow) {
        this.requestsPerWindow = requestsPerWindow;
        this.windowMs = windowMs;
        this.maxTrackedPeers = maxTrackedPeers;
        this.overflowRequestsPerWindow = overflowRequestsPerWindow;
        if (!Number.isSafeInteger(requestsPerWindow) || requestsPerWindow < 1 || requestsPerWindow > 100_000 ||
            !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 60 * 60 * 1_000 ||
            !Number.isSafeInteger(maxTrackedPeers) || maxTrackedPeers < 1 || maxTrackedPeers > 100_000 ||
            !Number.isSafeInteger(overflowRequestsPerWindow) || overflowRequestsPerWindow < 1 || overflowRequestsPerWindow > 100_000) {
            throw new Error("Invalid P2P peer rate limits");
        }
    }
    consume(peerId, nowMs = Date.now()) {
        if (peerId.length < 1 || peerId.length > 256 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
            throw new Error("Invalid P2P peer rate-limit identity");
        }
        let entry = this.peers.get(peerId);
        if (entry && nowMs - entry.startedAtMs >= this.windowMs) {
            this.peers.delete(peerId);
            entry = undefined;
        }
        if (!entry) {
            if (this.peers.size >= this.maxTrackedPeers && nowMs >= this.nextSweepAtMs)
                this.sweep(nowMs);
            if (this.peers.size >= this.maxTrackedPeers)
                return this.consumeOverflow(nowMs);
            entry = { startedAtMs: nowMs, count: 0 };
            this.peers.set(peerId, entry);
            this.nextSweepAtMs = Math.min(this.nextSweepAtMs, nowMs + this.windowMs);
        }
        entry.count += 1;
        return entry.count <= this.requestsPerWindow;
    }
    consumeOverflow(nowMs) {
        if (this.overflowStartedAtMs === null || nowMs - this.overflowStartedAtMs >= this.windowMs) {
            this.overflowStartedAtMs = nowMs;
            this.overflowCount = 0;
        }
        this.overflowCount += 1;
        return this.overflowCount <= this.overflowRequestsPerWindow;
    }
    sweep(nowMs) {
        let nextSweepAtMs = Number.POSITIVE_INFINITY;
        for (const [peerId, entry] of this.peers) {
            const expiresAtMs = entry.startedAtMs + this.windowMs;
            if (nowMs >= expiresAtMs)
                this.peers.delete(peerId);
            else
                nextSweepAtMs = Math.min(nextSweepAtMs, expiresAtMs);
        }
        this.nextSweepAtMs = nextSweepAtMs;
    }
}
