/**
 * Runs at most `concurrency` tasks at once, in order. A task whose key is already queued or
 * running isn't added twice; the caller gets the existing promise.
 */
export interface Limiter {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  has(key: string): boolean;
  keys(): string[];
  readonly active: number;
  readonly queued: number;
  /** Called every time the limiter becomes idle. */
  onIdle(listener: () => void): void;
}

export function createLimiter(concurrency: number): Limiter {
  const inFlight = new Map<string, Promise<unknown>>();
  const queue: (() => void)[] = [];
  const idleListeners: (() => void)[] = [];
  let active = 0;

  const next = () => {
    while (active < concurrency && queue.length > 0) {
      active++;
      queue.shift()!();
    }
    if (active === 0 && queue.length === 0) for (const listener of idleListeners) listener();
  };

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing) return existing as Promise<T>;
      const promise = new Promise<T>((resolve, reject) => {
        // Settle bookkeeping before resolving, so a caller that awaits and immediately runs
        // the same key again gets a fresh task instead of the finished one.
        const settle = () => {
          active--;
          inFlight.delete(key);
          next();
        };
        queue.push(() => {
          Promise.resolve()
            .then(task)
            .then(
              (value) => {
                settle();
                resolve(value);
              },
              (error: unknown) => {
                settle();
                reject(error);
              },
            );
        });
      });
      inFlight.set(key, promise);
      next();
      return promise;
    },
    has: (key) => inFlight.has(key),
    keys: () => [...inFlight.keys()],
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    onIdle(listener) {
      idleListeners.push(listener);
    },
  };
}
