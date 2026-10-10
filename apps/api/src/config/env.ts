import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// The repo root .env, four levels up from src/config (and from dist/config).
const ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));
const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../../../data/clean", import.meta.url));
const DEFAULT_EXPORT_DIR = fileURLToPath(new URL("../../../../exports", import.meta.url));

/** Loads the root .env if it exists. Variables already set in the environment win. */
export function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

const message = (expected: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? "is required" : `must be ${expected}`;

const url = (expected: string, protocol: RegExp) => z.url({ protocol, error: message(expected) });

const postgresUrl = () => url("a postgres:// or postgresql:// URL", /^postgres(ql)?$/);

/** A number from the environment, with one message for every way it can be wrong. */
function number(options: { min: number; max: number; expected: string; whole?: boolean }) {
  const error = message(options.expected);
  const base = z.coerce.number({ error }).min(options.min, { error }).max(options.max, { error });
  return options.whole ? base.int({ error }) : base;
}

const wholeNumber = (min: number, max: number) =>
  number({ min, max, whole: true, expected: `a whole number between ${min} and ${max}` });

const weight = () => number({ min: 0, max: 100, expected: "a number from 0 to 100" });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"], {
      error: message("development, test or production"),
    })
    .default("development"),
  DATABASE_URL: postgresUrl(),
  TEST_DATABASE_URL: postgresUrl().optional(),
  REDIS_URL: url("a redis:// or rediss:// URL", /^rediss?$/),
  PORT: number({
    min: 1,
    max: 65535,
    whole: true,
    expected: "a port number between 1 and 65535",
  }).default(3000),
  WEB_ORIGIN: url("an http:// or https:// origin such as http://localhost:5173", /^https?$/),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"], {
      error: message("a pino log level such as info or debug"),
    })
    .default("info"),
  HEALTH_CHECK_TIMEOUT_MS: number({
    min: 1,
    max: 600_000,
    whole: true,
    expected: "a positive number of milliseconds",
  }).default(2000),

  // Folder with movies.parquet and movie_tags.parquet, read by `pnpm ingest`.
  DATA_DIR: z.string().default(DEFAULT_DATA_DIR),
  INGEST_BATCH_SIZE: wholeNumber(1, 5000).default(500),
  // m in the weighted rating is this percentile of vote_count across the catalog (D-036).
  RATING_MIN_VOTES_PERCENTILE: number({
    min: 0,
    max: 1,
    expected: "a number between 0 and 1",
  }).default(0.5),

  // Ranking weights for search (docs/ARCHITECTURE.md). Each score is 0 to 1 before weighting.
  SEARCH_WEIGHT_TEXT: weight().default(1),
  SEARCH_WEIGHT_TAGS: weight().default(1),
  SEARCH_WEIGHT_RATING: weight().default(1),
  // Poster URLs are this prefix plus the movie's poster_path.
  TMDB_IMAGE_BASE_URL: url("an https:// URL", /^https$/).default("https://image.tmdb.org/t/p/w342"),

  // Gemini (D-040). The key is only needed by code that calls the real API.
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_TEXT_MODEL: z.string().min(1).default("gemini-3.8-flash"),
  GEMINI_THINKING_LEVEL: z
    .enum(["minimal", "low", "medium", "high"], {
      error: message("minimal, low, medium or high"),
    })
    .default("low"),
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default("gemini-embedding-2"),
  // Must match the vector(...) size of movie_embeddings.embedding (D-021).
  EMBEDDING_DIMENSIONS: wholeNumber(1, 2000).default(768),
  // Retries after a 429 or 5xx from the LLM, with exponential backoff and jitter.
  LLM_MAX_RETRIES: wholeNumber(0, 10).default(3),
  LLM_RETRY_BASE_MS: wholeNumber(1, 60_000).default(1000),
  LLM_RETRY_MAX_MS: wholeNumber(1, 600_000).default(30_000),

  // The embeddings job (`pnpm embed`).
  EMBED_BATCH_SIZE: wholeNumber(1, 100).default(20),
  EMBED_REQUESTS_PER_MINUTE: wholeNumber(1, 6000).default(7),
  EMBED_TIMEOUT_MS: wholeNumber(1000, 600_000).default(60_000),
  // How often a failed batch is tried again before it is listed as failed.
  EMBED_JOB_ATTEMPTS: wholeNumber(1, 20).default(3),
  // Where `pnpm embed:export` writes and `pnpm embed:import` reads.
  EXPORT_DIR: z.string().default(DEFAULT_EXPORT_DIR),
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
  search: {
    weights: { text: number; tags: number; rating: number };
    posterBaseUrl: string;
  };
  llm: {
    apiKey: string | undefined;
    textModel: string;
    thinkingLevel: string;
    embeddingModel: string;
    embeddingDimensions: number;
    retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  };
  embed: {
    batchSize: number;
    requestsPerMinute: number;
    timeoutMs: number;
    jobAttempts: number;
    exportDir: string;
  };
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
    search: {
      weights: {
        text: parsed.SEARCH_WEIGHT_TEXT,
        tags: parsed.SEARCH_WEIGHT_TAGS,
        rating: parsed.SEARCH_WEIGHT_RATING,
      },
      posterBaseUrl: parsed.TMDB_IMAGE_BASE_URL.replace(/\/+$/, ""),
    },
    llm: {
      apiKey: parsed.GEMINI_API_KEY,
      textModel: parsed.GEMINI_TEXT_MODEL,
      thinkingLevel: parsed.GEMINI_THINKING_LEVEL,
      embeddingModel: parsed.GEMINI_EMBEDDING_MODEL,
      embeddingDimensions: parsed.EMBEDDING_DIMENSIONS,
      retry: {
        maxRetries: parsed.LLM_MAX_RETRIES,
        baseDelayMs: parsed.LLM_RETRY_BASE_MS,
        maxDelayMs: parsed.LLM_RETRY_MAX_MS,
      },
    },
    embed: {
      batchSize: parsed.EMBED_BATCH_SIZE,
      requestsPerMinute: parsed.EMBED_REQUESTS_PER_MINUTE,
      timeoutMs: parsed.EMBED_TIMEOUT_MS,
      jobAttempts: parsed.EMBED_JOB_ATTEMPTS,
      exportDir: parsed.EXPORT_DIR,
    },
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
