export class ConsensusOperationBudget {
  private active = 0;

  constructor(readonly limit: number, private readonly label: string) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid ${label} operation budget`);
  }

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.limit) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  current(): number {
    return this.active;
  }
}
