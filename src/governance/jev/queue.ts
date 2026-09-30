/**
 * Bounded, fire-and-forget work queue for Jev shadow runs. Shadow work must never slow down or fail
 * an authoritative decision: callers `enqueue()` without awaiting, excess work is dropped (and
 * counted) instead of buffering unboundedly, and task errors are swallowed after being counted.
 */
export interface ShadowQueueStats {
  enqueued: number;
  completed: number;
  failed: number;
  dropped: number;
  inFlight: number;
  queued: number;
}

export class ShadowQueue {
  private readonly pending: Array<() => Promise<unknown>> = [];
  private inFlight = 0;
  private counters = { enqueued: 0, completed: 0, failed: 0, dropped: 0 };
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly opts: { maxConcurrency: number; maxQueue: number; onError?: (err: unknown) => void }) {}

  /** Schedule `task`; returns false when it was dropped because the queue is full. */
  enqueue(task: () => Promise<unknown>): boolean {
    if (this.pending.length >= Math.max(0, this.opts.maxQueue)) {
      this.counters.dropped += 1;
      return false;
    }
    this.counters.enqueued += 1;
    this.pending.push(task);
    this.pump();
    return true;
  }

  stats(): ShadowQueueStats {
    return { ...this.counters, inFlight: this.inFlight, queued: this.pending.length };
  }

  /** Resolves once nothing is queued or running (used by tests and graceful shutdown). */
  idle(): Promise<void> {
    if (!this.inFlight && !this.pending.length) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.inFlight < Math.max(1, this.opts.maxConcurrency) && this.pending.length) {
      const task = this.pending.shift()!;
      this.inFlight += 1;
      // Defer to a microtask so a synchronous throw inside the task can't escape into the caller.
      Promise.resolve()
        .then(task)
        .then(
          () => { this.counters.completed += 1; },
          err => { this.counters.failed += 1; try { this.opts.onError?.(err); } catch { /* ignore */ } },
        )
        .finally(() => {
          this.inFlight -= 1;
          this.pump();
          if (!this.inFlight && !this.pending.length) {
            const waiters = this.idleWaiters.splice(0);
            for (const w of waiters) w();
          }
        });
    }
  }
}
