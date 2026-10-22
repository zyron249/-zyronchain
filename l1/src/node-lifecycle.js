export const NODE_SHUTDOWN_GRACE_MS = 10_000;
export const MAX_BACKGROUND_TASKS = 32;
export async function drainHttpServer(server, graceMs = NODE_SHUTDOWN_GRACE_MS) {
    if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 60_000) {
        throw new Error("HTTP drain grace period must be an integer between 1 and 60000 ms");
    }
    if (!server.listening)
        return "drained";
    let forced = false;
    await new Promise((resolveDrain, rejectDrain) => {
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error && !forced)
                rejectDrain(error);
            else
                resolveDrain();
        };
        const timer = setTimeout(() => {
            forced = true;
            server.closeAllConnections();
            finish();
        }, graceMs);
        timer.unref();
        server.close((error) => finish(error));
    });
    return forced ? "forced" : "drained";
}
export class BackgroundTaskTracker {
    maxPending;
    accepting = true;
    pending = new Set();
    constructor(maxPending = MAX_BACKGROUND_TASKS) {
        this.maxPending = maxPending;
        if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1_024) {
            throw new Error("Background task limit must be an integer between 1 and 1024");
        }
    }
    run(operation) {
        if (!this.accepting || this.pending.size >= this.maxPending)
            return false;
        const task = operation();
        this.pending.add(task);
        void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
        return true;
    }
    stopAccepting() {
        this.accepting = false;
    }
    async drain() {
        this.stopAccepting();
        while (this.pending.size > 0) {
            await Promise.allSettled([...this.pending]);
        }
    }
    get pendingCount() {
        return this.pending.size;
    }
}
