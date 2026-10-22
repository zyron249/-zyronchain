export const DEFAULT_RPC_MAX_TRACKED_IDENTITIES = 4_096;
export class FixedWindowLimiter {
    limit;
    windowMs;
    maxTrackedIdentities;
    clients = new Map();
    overflow;
    lastSweepMs = 0;
    constructor(limit, windowMs, maxTrackedIdentities = DEFAULT_RPC_MAX_TRACKED_IDENTITIES) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.maxTrackedIdentities = maxTrackedIdentities;
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error("Invalid RPC rate-limit request cap");
        if (!Number.isSafeInteger(windowMs) || windowMs < 1)
            throw new Error("Invalid RPC rate-limit window");
        if (!Number.isSafeInteger(maxTrackedIdentities) || maxTrackedIdentities < 1) {
            throw new Error("Invalid RPC rate-limit identity cap");
        }
    }
    get trackedIdentityCount() {
        return this.clients.size;
    }
    consume(client, nowMs) {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0)
            throw new Error("Invalid RPC rate-limit clock");
        if (nowMs - this.lastSweepMs >= this.windowMs) {
            for (const [key, entry] of this.clients) {
                if (nowMs - entry.startedAtMs >= this.windowMs)
                    this.clients.delete(key);
            }
            if (this.overflow && nowMs - this.overflow.startedAtMs >= this.windowMs)
                this.overflow = undefined;
            this.lastSweepMs = nowMs;
        }
        let entry = this.clients.get(client);
        if (entry && nowMs - entry.startedAtMs >= this.windowMs) {
            this.clients.delete(client);
            entry = undefined;
        }
        if (!entry) {
            if (this.clients.size < this.maxTrackedIdentities) {
                entry = { count: 0, startedAtMs: nowMs };
                this.clients.set(client, entry);
            }
            else {
                if (!this.overflow || nowMs - this.overflow.startedAtMs >= this.windowMs) {
                    this.overflow = { count: 0, startedAtMs: nowMs };
                }
                entry = this.overflow;
            }
        }
        entry.count += 1;
        return {
            allowed: entry.count <= this.limit,
            remaining: Math.max(0, this.limit - entry.count),
            retryAfterMs: Math.max(0, entry.startedAtMs + this.windowMs - nowMs)
        };
    }
}
