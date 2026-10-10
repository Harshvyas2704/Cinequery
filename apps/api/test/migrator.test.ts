import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMigrationFiles, MIGRATIONS_DIR } from "../src/db/migrator.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "migrations-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const touch = (name: string) => writeFile(join(dir, name), "SELECT 1;");

describe("listMigrationFiles", () => {
  it("returns SQL files in numeric order and ignores other files", async () => {
    await Promise.all([touch("0002_movies.sql"), touch("0001_enable_vector.sql"), touch("notes.md")]);
    expect(await listMigrationFiles(dir)).toEqual(["0001_enable_vector.sql", "0002_movies.sql"]);
  });

  it("rejects badly named files", async () => {
    await Promise.all([touch("0001_ok.sql"), touch("2_movies.sql")]);
    await expect(listMigrationFiles(dir)).rejects.toThrow("2_movies.sql");
  });

  it("rejects two migrations with the same number", async () => {
    await Promise.all([touch("0001_a.sql"), touch("0001_b.sql")]);
    await expect(listMigrationFiles(dir)).rejects.toThrow("share the number 0001");
  });

  it("accepts the real migrations folder", async () => {
    expect((await listMigrationFiles(MIGRATIONS_DIR))[0]).toBe("0001_enable_vector.sql");
  });
});
