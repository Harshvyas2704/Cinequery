import pg from "pg";
import type { Logger } from "pino";

export function createPool(connectionString: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  // Without a listener, an error on an idle client crashes the process.
  pool.on("error", (err) => logger.warn({ err: err.message }, "postgres idle client error"));
  return pool;
}
