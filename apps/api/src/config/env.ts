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
  // While a user is waiting, fail fast and fall back instead of retrying for long.
  LLM_ONLINE_MAX_RETRIES: wholeNumber(0, 5).default(1),
  LLM_ONLINE_RETRY_BASE_MS: wholeNumber(1, 10_000).default(200),
  LLM_ONLINE_RETRY_MAX_MS: wholeNumber(1, 30_000).default(1000),

  // POST /api/recommend (docs/ARCHITECTURE.md).
  // How many nearest movies are taken from the vector index before re-scoring.
  RECOMMEND_CANDIDATES: wholeNumber(1, 200).default(30),
  RECOMMEND_WEIGHT_SIMILARITY: weight().default(1),
  RECOMMEND_WEIGHT_RATING: weight().default(0.2),
  // How much a wanted tag ("twist ending") lifts a movie that has it.
  RECOMMEND_WEIGHT_TAGS: weight().default(0.1),
  // "like Inception": how far the search moves toward the named film, 0 to 1.
  RECOMMEND_REFERENCE_WEIGHT: number({ min: 0, max: 1, expected: "a number between 0 and 1" }).default(
    0.5,
  ),
  // How close a typed title must be to a real one to count as that film, 0 to 1.
  REFERENCE_TITLE_MIN_SIMILARITY: number({
    min: 0,
    max: 1,
    expected: "a number between 0 and 1",
  }).default(0.55),
  // The parse step (prompt parse-v1). It runs while the user waits, so it uses
  // a small, fast model with the least thinking (D-045).
  GEMINI_PARSE_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  GEMINI_PARSE_THINKING_LEVEL: z
    .enum(["minimal", "low", "medium", "high"], {
      error: message("minimal, low, medium or high"),
    })
    .default("minimal"),
  PARSE_TIMEOUT_MS: wholeNumber(100, 60_000).default(4000),
  PARSE_MAX_OUTPUT_TOKENS: wholeNumber(50, 4000).default(500),
  // How long a parsed request is kept in Redis. Default: 7 days.
  PARSE_CACHE_TTL_SECONDS: wholeNumber(1, 31_536_000).default(604_800),
  // The pick step (prompt pick-v1): chooses the best candidates and says why.
  // The same small model as parse: measured about twice as fast as
  // GEMINI_TEXT_MODEL, with no timeouts (D-047).
  GEMINI_PICK_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  GEMINI_PICK_THINKING_LEVEL: z
    .enum(["minimal", "low", "medium", "high"], {
      error: message("minimal, low, medium or high"),
    })
    .default("minimal"),
  // Results are already on screen while this runs, so it may take longer than parse.
  PICK_TIMEOUT_MS: wholeNumber(100, 60_000).default(8000),
  PICK_MAX_OUTPUT_TOKENS: wholeNumber(50, 8000).default(2000),
  // How many search results the model chooses from (D-006).
  PICK_CANDIDATES: wholeNumber(1, 30).default(30),
  // What the model sees of each candidate (PLAN.md 7.1).
  PICK_TAGS_PER_CANDIDATE: wholeNumber(0, 25).default(5),
  PICK_OVERVIEW_CHARS: wholeNumber(0, 2000).default(300),
  // How long a set of picks is kept in Redis. Default: 1 day.
  PICK_CACHE_TTL_SECONDS: wholeNumber(1, 31_536_000).default(86_400),
  EMBED_QUERY_TIMEOUT_MS: wholeNumber(100, 60_000).default(4000),
  // How long a request's embedding is kept in Redis. It never goes stale for a
  // given model, so this only bounds memory. Default: 7 days.
  QUERY_EMBEDDING_TTL_SECONDS: wholeNumber(1, 31_536_000).default(604_800),

  // Production concerns (Phase 8, docs/ARCHITECTURE.md).
  // How many proxies sit in front of the API. The client's IP for rate limits
  // is read from X-Forwarded-For only when this is above 0.
  TRUST_PROXY_HOPS: wholeNumber(0, 10).default(0),
  // The largest request body the API reads.
  BODY_LIMIT_BYTES: wholeNumber(100, 1_000_000).default(10_000),
  // Requests per client IP in a sliding window. Recommend requests can cost
  // tokens, so they have their own, lower limit.
  RATE_LIMIT_WINDOW_SECONDS: wholeNumber(1, 3600).default(60),
  RATE_LIMIT_RECOMMEND_MAX: wholeNumber(1, 100_000).default(20),
  RATE_LIMIT_API_MAX: wholeNumber(1, 100_000).default(120),
  // Tokens (input plus output) the API may use per UTC day (D-049). From the
  // soft limit on, the pick step is skipped; from the hard limit on, no LLM
  // call is made at all.
  TOKEN_BUDGET_SOFT: wholeNumber(0, 1_000_000_000).default(800_000),
  TOKEN_BUDGET_HARD: wholeNumber(0, 1_000_000_000).default(1_000_000),
  // How many LLM calls may be running at the same time.
  LLM_MAX_CONCURRENT: wholeNumber(1, 1000).default(4),
  // On SIGTERM, how long requests in flight get to finish before they are cut off.
  SHUTDOWN_TIMEOUT_MS: wholeNumber(0, 600_000).default(10_000),
  // GET /api/stats needs this token. Without it the route does not exist.
  ADMIN_TOKEN: z.string().min(16, { error: message("at least 16 characters") }).optional(),
  // Rows of llm_calls and request_log older than this are deleted (D-024).
  LOG_RETENTION_DAYS: wholeNumber(1, 3650).default(30),
  // When the retention job runs (cron syntax, UTC). Default: 03:15 every day.
  RETENTION_CRON: z.string().min(9).default("15 3 * * *"),

  // The embeddings job (`pnpm embed`).
  EMBED_BATCH_SIZE: wholeNumber(1, 100).default(20),
  // Batches a minute. The free tier allows 100 embedded texts a minute, and a
  // batch is EMBED_BATCH_SIZE texts: 4 x 20 = 80, which leaves room for requests.
  EMBED_REQUESTS_PER_MINUTE: wholeNumber(1, 6000).default(4),
  EMBED_TIMEOUT_MS: wholeNumber(1000, 600_000).default(60_000),
  // How often a failed batch is tried again before it is listed as failed.
  EMBED_JOB_ATTEMPTS: wholeNumber(1, 20).default(3),
  // The provider's limit on embedded texts per day, and the time zone whose
  // midnight starts its day. `pnpm embed --remaining` uses what is left (D-051).
  EMBED_DAILY_QUOTA: wholeNumber(1, 100_000_000).default(1000),
  EMBED_QUOTA_TIMEZONE: z
    .string()
    .refine(
      (zone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      },
      { error: message("a time zone name such as America/Los_Angeles") },
    )
    .default("America/Los_Angeles"),
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
    /** Retries for calls made while a user waits. */
    onlineRetry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
    maxConcurrent: number;
  };
  recommend: {
    candidates: number;
    weights: { similarity: number; tags: number; rating: number };
    embedTimeoutMs: number;
    embeddingCacheTtlSeconds: number;
    reference: { weight: number; minTitleSimilarity: number };
    parse: {
      model: string;
      thinkingLevel: string;
      timeoutMs: number;
      maxOutputTokens: number;
      cacheTtlSeconds: number;
    };
    pick: {
      model: string;
      thinkingLevel: string;
      timeoutMs: number;
      maxOutputTokens: number;
      candidates: number;
      tagsPerCandidate: number;
      overviewChars: number;
      cacheTtlSeconds: number;
    };
  };
  embed: {
    batchSize: number;
    requestsPerMinute: number;
    timeoutMs: number;
    jobAttempts: number;
    exportDir: string;
    dailyQuota: number;
    quotaTimeZone: string;
  };
  http: { trustProxyHops: number; bodyLimitBytes: number; shutdownTimeoutMs: number };
  rateLimit: { windowSeconds: number; recommendMax: number; apiMax: number };
  budget: { softTokens: number; hardTokens: number };
  adminToken: string | undefined;
  retention: { days: number; cron: string };
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
  if (parsed.TOKEN_BUDGET_SOFT > parsed.TOKEN_BUDGET_HARD) {
    throw new ConfigError(["TOKEN_BUDGET_SOFT must not be above TOKEN_BUDGET_HARD"]);
  }
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
      onlineRetry: {
        maxRetries: parsed.LLM_ONLINE_MAX_RETRIES,
        baseDelayMs: parsed.LLM_ONLINE_RETRY_BASE_MS,
        maxDelayMs: parsed.LLM_ONLINE_RETRY_MAX_MS,
      },
      maxConcurrent: parsed.LLM_MAX_CONCURRENT,
    },
    recommend: {
      candidates: parsed.RECOMMEND_CANDIDATES,
      weights: {
        similarity: parsed.RECOMMEND_WEIGHT_SIMILARITY,
        tags: parsed.RECOMMEND_WEIGHT_TAGS,
        rating: parsed.RECOMMEND_WEIGHT_RATING,
      },
      embedTimeoutMs: parsed.EMBED_QUERY_TIMEOUT_MS,
      embeddingCacheTtlSeconds: parsed.QUERY_EMBEDDING_TTL_SECONDS,
      reference: {
        weight: parsed.RECOMMEND_REFERENCE_WEIGHT,
        minTitleSimilarity: parsed.REFERENCE_TITLE_MIN_SIMILARITY,
      },
      parse: {
        model: parsed.GEMINI_PARSE_MODEL,
        thinkingLevel: parsed.GEMINI_PARSE_THINKING_LEVEL,
        timeoutMs: parsed.PARSE_TIMEOUT_MS,
        maxOutputTokens: parsed.PARSE_MAX_OUTPUT_TOKENS,
        cacheTtlSeconds: parsed.PARSE_CACHE_TTL_SECONDS,
      },
      pick: {
        model: parsed.GEMINI_PICK_MODEL,
        thinkingLevel: parsed.GEMINI_PICK_THINKING_LEVEL,
        timeoutMs: parsed.PICK_TIMEOUT_MS,
        maxOutputTokens: parsed.PICK_MAX_OUTPUT_TOKENS,
        candidates: parsed.PICK_CANDIDATES,
        tagsPerCandidate: parsed.PICK_TAGS_PER_CANDIDATE,
        overviewChars: parsed.PICK_OVERVIEW_CHARS,
        cacheTtlSeconds: parsed.PICK_CACHE_TTL_SECONDS,
      },
    },
    embed: {
      batchSize: parsed.EMBED_BATCH_SIZE,
      requestsPerMinute: parsed.EMBED_REQUESTS_PER_MINUTE,
      timeoutMs: parsed.EMBED_TIMEOUT_MS,
      jobAttempts: parsed.EMBED_JOB_ATTEMPTS,
      exportDir: parsed.EXPORT_DIR,
      dailyQuota: parsed.EMBED_DAILY_QUOTA,
      quotaTimeZone: parsed.EMBED_QUOTA_TIMEZONE,
    },
    http: {
      trustProxyHops: parsed.TRUST_PROXY_HOPS,
      bodyLimitBytes: parsed.BODY_LIMIT_BYTES,
      shutdownTimeoutMs: parsed.SHUTDOWN_TIMEOUT_MS,
    },
    rateLimit: {
      windowSeconds: parsed.RATE_LIMIT_WINDOW_SECONDS,
      recommendMax: parsed.RATE_LIMIT_RECOMMEND_MAX,
      apiMax: parsed.RATE_LIMIT_API_MAX,
    },
    budget: { softTokens: parsed.TOKEN_BUDGET_SOFT, hardTokens: parsed.TOKEN_BUDGET_HARD },
    adminToken: parsed.ADMIN_TOKEN,
    retention: { days: parsed.LOG_RETENTION_DAYS, cron: parsed.RETENTION_CRON },
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
