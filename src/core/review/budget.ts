/** One wall-clock budget, including preflight and final delivery. */
export class BudgetExceededError extends Error {
  constructor() { super('time budget exhausted'); this.name = 'BudgetExceededError'; }
}

export class BudgetTracker {
  readonly deadline: number;
  readonly startedAt: number;
  readonly finalizationReserveMs: number;

  constructor(startedAt: number, maxDurationMinutes: number) {
    this.startedAt = startedAt;
    this.deadline = startedAt + maxDurationMinutes * 60_000;
    this.finalizationReserveMs = Math.min(60_000, this.totalMs * 0.1);
  }

  /** Remaining milliseconds, floored at 0. */
  remaining(now: number = Date.now()): number {
    return Math.max(0, this.deadline - now);
  }

  exceeded(now: number = Date.now()): boolean {
    return now >= this.deadline;
  }

  workRemaining(now: number = Date.now()): number {
    return Math.max(0, this.remaining(now) - this.finalizationReserveMs);
  }

  workExceeded(now: number = Date.now()): boolean { return this.workRemaining(now) === 0; }

  signal(finalization = false, parent?: AbortSignal): AbortSignal {
    const remaining = finalization ? this.remaining() : this.workRemaining();
    if (remaining <= 0) throw new BudgetExceededError();
    const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    return parent ? AbortSignal.any([deadline, parent]) : deadline;
  }

  /** Bounds adapters that do not themselves honor AbortSignal, too. */
  async run<T>(fn: (signal: AbortSignal) => Promise<T>, finalization = false, parent?: AbortSignal): Promise<T> {
    const signal = this.signal(finalization, parent);
    signal.throwIfAborted();
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(parent?.aborted ? parent.reason : new BudgetExceededError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([fn(signal), aborted]);
      if (finalization ? this.exceeded() : this.workExceeded()) throw new BudgetExceededError();
      signal.throwIfAborted();
      return result;
    } finally { signal.removeEventListener('abort', onAbort); }
  }

  elapsed(now: number = Date.now()): number {
    return now - this.startedAt;
  }

  get totalMs(): number {
    return this.deadline - this.startedAt;
  }
}
