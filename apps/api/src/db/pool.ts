import pg from "pg";
import type { Logger } from "pino";

export function createPool(connectionString: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  // Without a listener, an error on an idle client crashes the process.
  pool.on("error", (err) => logger.warn({ err: err.message }, "postgres idle client error"));
  return pool;
}

/** Runs fn inside a transaction: commit if it returns, roll back if it throws. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
