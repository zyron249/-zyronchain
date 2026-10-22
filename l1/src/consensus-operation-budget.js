export class ConsensusOperationBudget {
    limit;
    active = 0;
    constructor(limit, label) {
        this.limit = limit;
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error(`Invalid ${label} operation budget`);
    }
    tryAcquire() {
        if (this.active >= this.limit)
            return undefined;
        this.active += 1;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.active -= 1;
        };
    }
    current() {
        return this.active;
    }
}
