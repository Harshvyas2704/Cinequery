import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMigrationFiles, MIGRATIONS_DIR, runMigrations } from "../src/db/migrator.js";
import { createPool } from "../src/db/pool.js";
import { loadTestConfig, silentLogger } from "./helpers.js";

let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(loadTestConfig().testDatabaseUrl, silentLogger);
});
afterAll(() => pool.end());

describe("runMigrations", () => {
  it("applies every migration, then does nothing on a second run", async () => {
    const files = await listMigrationFiles(MIGRATIONS_DIR);

    const first = await runMigrations(pool);
    expect([...first.applied, ...first.skipped].sort()).toEqual(files);

    const second = await runMigrations(pool);
    expect(second).toEqual({ applied: [], skipped: files });

    const { rows } = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    expect(rows.map((row) => row.name)).toEqual(files);
  });

  it("leaves the vector extension installed", async () => {
    await runMigrations(pool);
    const { rows } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    expect(rows).toHaveLength(1);
  });
});
