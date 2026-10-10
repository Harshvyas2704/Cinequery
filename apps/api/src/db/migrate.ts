// Entry point for `pnpm db:migrate`.
import { pino } from "pino";
import { loadConfigOrExit } from "../config/env.js";
import { runMigrations } from "./migrator.js";
import { createPool } from "./pool.js";

const config = loadConfigOrExit();
const pool = createPool(config.databaseUrl, pino({ level: config.logLevel }));

try {
  const { applied, skipped } = await runMigrations(pool);
  for (const file of applied) console.log(`applied  ${file}`);
  console.log(`${applied.length} applied, ${skipped.length} already up to date`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
