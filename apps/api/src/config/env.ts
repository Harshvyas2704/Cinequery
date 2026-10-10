import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// The repo root .env, four levels up from src/config (and from dist/config).
const ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));
const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../../../data/clean", import.meta.url));

/** Loads the root .env if it exists. Variables already set in the environment win. */
export function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

const message = (expected: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? "is required" : `must be ${expected}`;

const url = (expected: string, protocol: RegExp) => z.url({ protocol, error: message(expected) });

const postgresUrl = () => url("a postgres:// or postgresql:// URL", /^postgres(ql)?$/);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"], {
      error: message("development, test or production"),
    })
    .default("development"),
  DATABASE_URL: postgresUrl(),
  TEST_DATABASE_URL: postgresUrl().optional(),
  REDIS_URL: url("a redis:// or rediss:// URL", /^rediss?$/),
  PORT: z.coerce
    .number({ error: message("a port number between 1 and 65535") })
    .int({ error: message("a port number between 1 and 65535") })
    .min(1, { error: message("a port number between 1 and 65535") })
    .max(65535, { error: message("a port number between 1 and 65535") })
    .default(3000),
  WEB_ORIGIN: url("an http:// or https:// origin such as http://localhost:5173", /^https?$/),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"], {
      error: message("a pino log level such as info or debug"),
    })
    .default("info"),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce
    .number({ error: message("a positive number of milliseconds") })
    .int({ error: message("a positive number of milliseconds") })
    .positive({ error: message("a positive number of milliseconds") })
    .default(2000),
  // Folder with movies.parquet and movie_tags.parquet, read by `pnpm ingest`.
  DATA_DIR: z.string().default(DEFAULT_DATA_DIR),
  INGEST_BATCH_SIZE: z.coerce
    .number({ error: message("a whole number between 1 and 5000") })
    .int({ error: message("a whole number between 1 and 5000") })
    .min(1, { error: message("a whole number between 1 and 5000") })
    .max(5000, { error: message("a whole number between 1 and 5000") })
    .default(500),
  // m in the weighted rating is this percentile of vote_count across the catalog (D-036).
  RATING_MIN_VOTES_PERCENTILE: z.coerce
    .number({ error: message("a number between 0 and 1") })
    .min(0, { error: message("a number between 0 and 1") })
    .max(1, { error: message("a number between 0 and 1") })
    .default(0.5),
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  webOrigin: string;
  databaseUrl: string;
  testDatabaseUrl: string | undefined;
  redisUrl: string;
  logLevel: string;
  healthCheckTimeoutMs: number;
  dataDir: string;
  ingestBatchSize: number;
  ratingMinVotesPercentile: number;
};

/** Thrown when the environment is missing or has invalid variables. Never contains values. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      [
        "Invalid environment configuration:",
        ...problems.map((problem) => `  - ${problem}`),
        "Set these in .env at the repo root (see .env.example).",
      ].join("\n"),
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value (`PORT=`) means "not set", so defaults and "is required" apply.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`),
    );
  }
  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    webOrigin: new URL(parsed.WEB_ORIGIN).origin,
    databaseUrl: parsed.DATABASE_URL,
    testDatabaseUrl: parsed.TEST_DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    logLevel: parsed.LOG_LEVEL,
    healthCheckTimeoutMs: parsed.HEALTH_CHECK_TIMEOUT_MS,
    dataDir: parsed.DATA_DIR,
    ingestBatchSize: parsed.INGEST_BATCH_SIZE,
    ratingMinVotesPercentile: parsed.RATING_MIN_VOTES_PERCENTILE,
  };
}

/** For entry points: load .env, then return the config or print what is wrong and exit. */
export function loadConfigOrExit(): Config {
  loadEnvFile();
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
