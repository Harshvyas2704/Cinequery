import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import { pino } from "pino";
import { type AppDeps, createApp } from "../src/app.js";
import { type Config, loadConfig, loadEnvFile } from "../src/config/env.js";

export const silentLogger = pino({ level: "silent" });

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
export async function startApp(
  deps: Omit<AppDeps, "logger" | "config"> & { config?: AppDeps["config"] },
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createApp({
    logger: silentLogger,
    config: { webOrigin: "http://localhost:5173", healthCheckTimeoutMs: 200 },
    ...deps,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
