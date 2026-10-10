export type Semaphore = {
  /**
   * Waits for a free place and returns the function that gives it back.
   * Rejects if `signal` fires while waiting.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** Places in use, and callers waiting for one. */
  readonly active: number;
  readonly waiting: number;
};

/** Lets at most `max` holders in at a time; the rest wait in order of arrival. */
export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const queue: (() => void)[] = [];

  // A place is given back at most once, however often release is called.
  const releaser = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      // The place goes straight to the next in line, so `active` stays the same.
      if (next) next();
      else active--;
    };
  };

  return {
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(new Error("aborted while waiting"));
      if (active < max) {
        active++;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve, reject) => {
        const enter = () => {
          signal?.removeEventListener("abort", leave);
          resolve(releaser());
        };
        const leave = () => {
          queue.splice(queue.indexOf(enter), 1);
          reject(new Error("aborted while waiting"));
        };
        queue.push(enter);
        signal?.addEventListener("abort", leave, { once: true });
      });
    },
  };
}
