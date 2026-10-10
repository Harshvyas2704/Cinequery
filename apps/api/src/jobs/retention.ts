import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { Logger } from "pino";

export const MAINTENANCE_QUEUE = "maintenance";
const RETENTION_JOB = "retention";

export type RetentionResult = { llmCalls: number; requests: number };

/** Deletes log rows older than `days` days (D-024). Safe to run at any time, and twice. */
export async function deleteOldLogs(
  pool: Pick<pg.Pool, "query">,
  days: number,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const before = new Date(now.getTime() - days * 86_400_000);
  const llmCalls = await pool.query("DELETE FROM llm_calls WHERE created_at < $1", [before]);
  const requests = await pool.query("DELETE FROM request_log WHERE created_at < $1", [before]);
  return { llmCalls: llmCalls.rowCount ?? 0, requests: requests.rowCount ?? 0 };
}

export function createMaintenanceQueue(connection: Redis, name = MAINTENANCE_QUEUE): Queue {
  return new Queue(name, { connection });
}

/**
 * Makes the retention job run on a schedule. The schedule lives in Redis under
 * a fixed id, so calling this at every start of the worker does not add a
 * second one; it only updates the times.
 */
export async function scheduleRetention(queue: Queue, cron: string): Promise<void> {
  await queue.upsertJobScheduler(
    "retention-schedule",
    { pattern: cron, tz: "UTC" },
    { name: RETENTION_JOB, opts: { removeOnComplete: 30, removeOnFail: 30, attempts: 3 } },
  );
}

/** Starts the worker that runs maintenance jobs, one at a time. */
export function startMaintenanceWorker(options: {
  connection: Redis;
  queueName?: string;
  pool: Pick<pg.Pool, "query">;
  retentionDays: number;
  now?: () => Date;
  logger: Logger;
}) {
  const worker = new Worker<unknown, RetentionResult>(
    options.queueName ?? MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name !== RETENTION_JOB) throw new Error(`Unknown maintenance job "${job.name}"`);
      const deleted = await deleteOldLogs(options.pool, options.retentionDays, options.now?.());
      options.logger.info({ ...deleted, days: options.retentionDays }, "old log rows deleted");
      return deleted;
    },
    { connection: options.connection, concurrency: 1 },
  );
  worker.on("failed", (job, error) =>
    options.logger.warn({ job: job?.name, err: error.message }, "maintenance job failed"),
  );
  worker.on("error", (error) =>
    options.logger.warn({ err: error.message }, "maintenance worker error"),
  );

  return {
    worker,
    ready: () => worker.waitUntilReady(),
    /** Stops taking jobs and waits for the one in progress. */
    close: () => worker.close(),
  };
}
