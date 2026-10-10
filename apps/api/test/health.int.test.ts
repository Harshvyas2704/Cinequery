import { healthResponseSchema } from "@cinequery/shared";
import type { Redis } from "ioredis";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedis } from "../src/cache/redis.js";
import { runMigrations } from "../src/db/migrator.js";
import { createPool } from "../src/db/pool.js";
import { loadTestConfig, silentLogger, startApp, waitForRedis } from "./helpers.js";

let pool: pg.Pool;
let redis: Redis;
let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  const config = loadTestConfig();
  pool = createPool(config.testDatabaseUrl, silentLogger);
  redis = createRedis(config.redisUrl, silentLogger);
  await runMigrations(pool);
  await waitForRedis(redis);
  app = await startApp({ pool, redis, config });
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  await pool?.end();
});

describe("GET /api/health against local Postgres and Redis", () => {
  it("reports all three services as ok", async () => {
    const response = await fetch(`${app.url}/api/health`);
    const body = healthResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      status: "ok",
      services: {
        postgres: { status: "ok" },
        pgvector: { status: "ok", version: expect.stringMatching(/^\d+\.\d+/) },
        redis: { status: "ok" },
      },
    });
    expect(response.status).toBe(200);
  });
});
