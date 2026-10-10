import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

// Four digits, an underscore, a snake_case name: 0001_enable_vector.sql
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

// Any fixed number works; it only has to be the same for every migration run.
const ADVISORY_LOCK_KEY = 727_001;

export type MigrationResult = { applied: string[]; skipped: string[] };

/** Migration file names in the order they run. Rejects names that would sort unpredictably. */
export async function listMigrationFiles(dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const invalid = files.filter((file) => !MIGRATION_FILE.test(file));
  if (invalid.length > 0) {
    throw new Error(
      `Migration files must be named like 0001_enable_vector.sql. Invalid: ${invalid.join(", ")}`,
    );
  }
  const numbers = files.map((file) => file.slice(0, 4));
  const duplicate = numbers.find((number, index) => numbers.indexOf(number) !== index);
  if (duplicate) throw new Error(`Two migrations share the number ${duplicate}`);
  return files;
}

/**
 * Applies every migration not yet recorded in schema_migrations, in file name order.
 * Each file runs in its own transaction, so a failing migration leaves nothing behind.
 */
export async function runMigrations(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const files = await listMigrationFiles(dir);
  const client = await pool.connect();
  try {
    // Two runs at once (two test files, two deploys) wait for each other here.
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name       text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
      const done = new Set(rows.map((row) => row.name));

      const result: MigrationResult = { applied: [], skipped: [] };
      for (const file of files) {
        if (done.has(file)) {
          result.skipped.push(file);
          continue;
        }
        const sql = await readFile(join(dir, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw new Error(`Migration ${file} failed and was rolled back`, { cause: error });
        }
        result.applied.push(file);
      }
      return result;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
