import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import { pino } from "pino";
import { type AppDeps, createApp } from "../src/app.js";
import { type Config, loadConfig, loadEnvFile } from "../src/config/env.js";
import type { HealthDeps } from "../src/routes/health.js";

export const silentLogger = pino({ level: "silent" });

export const testSearch = {
  weights: { text: 1, tags: 1, rating: 1 },
  posterBaseUrl: "https://img.test/w342",
};

/** Config for integration tests. Refuses to run without a separate test database. */
export function loadTestConfig(): Config & { testDatabaseUrl: string } {
  loadEnvFile();
  const config = loadConfig();
  const { testDatabaseUrl } = config;
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for integration tests (see .env.example)");
  }
  if (testDatabaseUrl === config.databaseUrl) {
    throw new Error("TEST_DATABASE_URL must not be the same database as DATABASE_URL");
  }
  return { ...config, testDatabaseUrl };
}

/** Waits for the Redis connection, with a clear error if Redis is not running. */
export async function waitForRedis(redis: Redis, timeoutMs = 2000): Promise<void> {
  if (redis.status === "ready") return;
  try {
    await once(redis, "ready", { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("Redis is not reachable at REDIS_URL. Start it to run integration tests.");
  }
}

/** Starts the app on a free port and returns its base URL. */
export const testAppConfig: AppDeps["config"] = {
  webOrigin: "http://localhost:5173",
  healthCheckTimeoutMs: 200,
  search: testSearch,
  recommend: {
    candidates: 30,
    weights: { similarity: 1, tags: 0.1, rating: 0.2 },
    embedTimeoutMs: 500,
    embeddingCacheTtlSeconds: 60,
    reference: { weight: 0.5, minTitleSimilarity: 0.55 },
    parse: {
      model: "fake-parse",
      thinkingLevel: "minimal",
      timeoutMs: 500,
      maxOutputTokens: 500,
      cacheTtlSeconds: 60,
    },
    pick: {
      model: "fake-pick",
      thinkingLevel: "low",
      timeoutMs: 500,
      maxOutputTokens: 1000,
      candidates: 30,
      tagsPerCandidate: 5,
      overviewChars: 300,
      cacheTtlSeconds: 60,
    },
  },
  llm: { embeddingModel: "fake-embedding" },
};

const noCache = { get: async () => null, set: async () => {} };

export async function startApp(deps: {
  // Health tests pass a fake with only the query they need; other tests pass a real pool.
  pool: HealthDeps["pool"] | AppDeps["pool"];
  redis: AppDeps["redis"];
  config?: AppDeps["config"];
  llm?: AppDeps["llm"];
  queryEmbeddingCache?: AppDeps["queryEmbeddingCache"];
  parseCache?: AppDeps["parseCache"];
  pickCache?: AppDeps["pickCache"];
  now?: AppDeps["now"];
}): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createApp({
    logger: silentLogger,
    llm: null,
    queryEmbeddingCache: noCache,
    parseCache: noCache,
    pickCache: noCache,
    ...deps,
    config: deps.config ?? testAppConfig,
    pool: deps.pool as AppDeps["pool"],
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
