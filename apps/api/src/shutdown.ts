import type { Logger } from "pino";

export type ShutdownSteps = {
  /**
   * Stop taking new work and resolve when the work in flight is done.
   * For the API: stop accepting connections and wait for open requests.
   */
  drain: () => Promise<unknown>;
  /** Called if draining takes longer than the timeout: cut off what is left. */
  force: () => void;
  /** Then close what the work depended on (database, Redis, queues), in order. */
  close: (() => Promise<unknown>)[];
  timeoutMs: number;
  logger: Logger;
};

/**
 * Returns the function to call on SIGTERM or SIGINT. It runs once, however
 * many signals arrive, and resolves to true if everything finished in time.
 */
export function createShutdown(steps: ShutdownSteps): (signal: string) => Promise<boolean> {
  let running: Promise<boolean> | undefined;

  async function shutdown(signal: string): Promise<boolean> {
    steps.logger.info({ signal }, "shutting down");
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), steps.timeoutMs);
    });
    const drained = steps.drain().catch((error: unknown) => {
      steps.logger.warn({ err: (error as Error).message }, "draining failed");
    });

    const clean = (await Promise.race([drained, timedOut])) !== "timeout";
    clearTimeout(timer);
    if (!clean) {
      steps.logger.warn({ timeoutMs: steps.timeoutMs }, "work in flight did not finish; cutting it off");
      steps.force();
      await drained;
    }

    for (const close of steps.close) {
      try {
        await close();
      } catch (error) {
        steps.logger.warn({ err: (error as Error).message }, "a resource did not close cleanly");
      }
    }
    steps.logger.info("shutdown complete");
    return clean;
  }

  return (signal) => (running ??= shutdown(signal));
}
