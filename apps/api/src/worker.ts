// The background worker (`pnpm worker`): runs scheduled maintenance, which for
// now is the daily deletion of old log rows. The embeddings job is not here:
// `pnpm embed` runs until the queue is empty and then exits.
import { loadConfigOrExit } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createQueueConnection } from "./jobs/embedQueue.js";
import {
  createMaintenanceQueue,
  scheduleRetention,
  startMaintenanceWorker,
} from "./jobs/retention.js";
import { createLogger } from "./logger.js";
import { createShutdown } from "./shutdown.js";

const config = loadConfigOrExit();
const logger = createLogger(config.logLevel);

const pool = createPool(config.databaseUrl, logger);
const connection = createQueueConnection(config.redisUrl);
connection.on("error", (err: Error) => logger.warn({ err: err.message }, "redis connection error"));
const queue = createMaintenanceQueue(connection);

await scheduleRetention(queue, config.retention.cron);
const worker = startMaintenanceWorker({
  connection,
  pool,
  retentionDays: config.retention.days,
  logger,
});
await worker.ready();
logger.info(
  { cron: config.retention.cron, days: config.retention.days },
  "worker started: retention job scheduled",
);

const shutdown = createShutdown({
  // Closing the worker lets the job in progress finish.
  drain: () => worker.close(),
  force: () => void worker.worker.close(true),
  close: [() => queue.close(), () => connection.quit(), () => pool.end()],
  timeoutMs: config.http.shutdownTimeoutMs,
  logger,
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then((clean) => process.exit(clean ? 0 : 1));
  });
}
