import { randomUUID } from "node:crypto";
import {
  errorResponseSchema,
  parsedRequestSchema,
  recommendResponseSchema,
  statsResponseSchema,
} from "@cinequery/shared";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createJsonCache } from "../src/cache/jsonCache.js";
import { createQueryEmbeddingCache } from "../src/cache/queryEmbeddings.js";
import { createRedis } from "../src/cache/redis.js";
import { runMigrations } from "../src/db/migrator.js";
import { createPool } from "../src/db/pool.js";
import { quotaUsage } from "../src/embeddings/quota.js";
import { createQueueConnection } from "../src/jobs/embedQueue.js";
import {
  createMaintenanceQueue,
  deleteOldLogs,
  scheduleRetention,
  startMaintenanceWorker,
} from "../src/jobs/retention.js";
import { createTokenBudget, type TokenBudget } from "../src/limits/budget.js";
import { createRateLimiter } from "../src/limits/rateLimit.js";
import { llmCallRecorder } from "../src/llm/calls.js";
import { createFakeBackend, type FakeBackend } from "../src/llm/fake.js";
import { createLlmProvider } from "../src/llm/provider.js";
import { createLogger } from "../src/logger.js";
import { picksSchema } from "../src/recommend/pick.js";
import { requestRecorder } from "../src/stats/requestLog.js";
import { loadTestConfig, silentLogger, startApp, testAppConfig, waitForRedis } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const NOW = new Date("2026-06-15T12:00:00Z");

let pool: pg.Pool;
let redis: Redis;
let redisUrl: string;
let prefix: string;
let app: Awaited<ReturnType<typeof startApp>> | undefined;

beforeAll(async () => {
  const config = loadTestConfig();
  redisUrl = config.redisUrl;
  pool = createPool(config.testDatabaseUrl, silentLogger);
  await runMigrations(pool);
  redis = createRedis(config.redisUrl, silentLogger);
  await waitForRedis(redis);
});

beforeEach(async () => {
  // An empty catalog is enough here: these tests are about what surrounds a
  // request, not about what it finds.
  await pool.query(
    "TRUNCATE movies, movie_tags, movie_embeddings, rating_stats, llm_calls, request_log RESTART IDENTITY CASCADE",
  );
  prefix = `test-${randomUUID()}`; // keys of its own for every test
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  redis?.disconnect();
  await pool?.end();
});

const brokenRedis = new Proxy({}, { get: () => () => Promise.reject(new Error("redis is down")) });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app!.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("sliding window rate limiter", () => {
  let clock = 0;
  const limiter = () =>
    createRateLimiter(redis, { windowMs: 1000, prefix, now: () => clock, logger: silentLogger });

  it("allows `max` requests per window and says when the next one may come", async () => {
    const { hit } = limiter();
    clock = 10_000;
    expect(await hit("a", 2)).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    clock = 10_600;
    expect(await hit("a", 2)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    clock = 10_700;
    // The oldest request leaves the window 300 ms from now.
    expect(await hit("a", 2)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 300 });
  });

  it("slides: a place frees up as each old request leaves the window", async () => {
    const { hit } = limiter();
    clock = 20_000;
    await hit("a", 2);
    clock = 20_600;
    await hit("a", 2);

    // A fixed window would allow two new requests at the turn of the second.
    clock = 21_001;
    expect((await hit("a", 2)).allowed).toBe(true);
    expect(await hit("a", 2)).toMatchObject({ allowed: false, retryAfterMs: 599 });
    clock = 21_601;
    expect((await hit("a", 2)).allowed).toBe(true);
  });

  it("does not count a refused request against the client", async () => {
    const { hit } = limiter();
    clock = 30_000;
    await hit("a", 1);
    for (clock = 30_100; clock < 30_900; clock += 100) expect((await hit("a", 1)).allowed).toBe(false);
    clock = 31_001;
    expect((await hit("a", 1)).allowed).toBe(true);
  });

  it("counts every key on its own, and lets the keys expire", async () => {
    const { hit } = limiter();
    clock = 40_000;
    await hit("a", 1);
    expect((await hit("a", 1)).allowed).toBe(false);
    expect((await hit("b", 1)).allowed).toBe(true);

    const ttl = await redis.pttl(`${prefix}:rate:a`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1000);
  });

  it("lets requests through when Redis is down", async () => {
    const { hit } = createRateLimiter(brokenRedis as Redis, { windowMs: 1000, logger: silentLogger });
    expect(await hit("a", 1)).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect((await hit("a", 1)).allowed).toBe(true);
  });
});

describe("rate limits on the API", () => {
  async function start(options: { recommendMax?: number; apiMax?: number; trustProxyHops?: number }) {
    app = await startApp({
      pool,
      redis,
      rateLimiter: createRateLimiter(redis, { windowMs: 60_000, prefix, logger: silentLogger }),
      config: {
        ...testAppConfig,
        http: { ...testAppConfig.http, trustProxyHops: options.trustProxyHops ?? 0 },
        rateLimit: { recommendMax: options.recommendMax ?? 1000, apiMax: options.apiMax ?? 1000 },
      },
    });
  }

  it("answers 429 with Retry-After once a client is over the recommend limit", async () => {
    await start({ recommendMax: 2 });
    expect((await post("/api/recommend", { query: "heist" })).status).toBe(200);
    expect((await post("/api/recommend/stream", { query: "heist" })).status).toBe(200);

    const refused = await post("/api/recommend", { query: "heist" });
    expect(refused.status).toBe(429);
    const seconds = Number(refused.headers.get("retry-after"));
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(errorResponseSchema.parse(await refused.json()).error).toEqual({
      code: "rate_limited",
      message: `Too many requests. Try again in ${seconds} seconds.`,
      requestId: refused.headers.get("x-request-id"),
    });
    expect((await post("/api/recommend/stream", { query: "heist" })).status).toBe(429);

    // Other routes have their own, higher limit; health has none.
    expect((await fetch(`${app!.url}/api/genres`)).status).toBe(200);
    expect((await fetch(`${app!.url}/api/health`)).status).toBe(200);
  });

  it("limits the other API routes too, but never the health check", async () => {
    await start({ apiMax: 1 });
    expect((await fetch(`${app!.url}/api/genres`)).status).toBe(200);
    expect((await fetch(`${app!.url}/api/genres`)).status).toBe(429);
    expect((await fetch(`${app!.url}/api/health`)).status).toBe(200);
  });

  it("believes X-Forwarded-For only behind a trusted proxy", async () => {
    const from = (ip: string) => post("/api/recommend", { query: "heist" }, { "x-forwarded-for": ip });

    // No proxy: the header is ignored, so both requests count for one client.
    await start({ recommendMax: 1 });
    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.2")).status).toBe(429);
    await app!.close();

    // One proxy: each forwarded address is a client of its own.
    prefix = `test-${randomUUID()}`;
    await start({ recommendMax: 1, trustProxyHops: 1 });
    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.2")).status).toBe(200);
    expect((await from("203.0.113.1")).status).toBe(429);
  });
});

describe("token budget", () => {
  let now = NOW;
  const budget = (client: Redis = redis) =>
    createTokenBudget(client, {
      softTokens: 100,
      hardTokens: 200,
      prefix,
      now: () => now,
      logger: silentLogger,
    });

  beforeEach(() => {
    now = NOW;
  });

  it("moves from ok to soft to hard as tokens are used", async () => {
    const today = budget();
    expect(await today.level()).toBe("ok");
    await today.add(99);
    expect(await today.level()).toBe("ok");
    await today.add(1);
    expect(await today.level()).toBe("soft");
    await today.add(100);
    expect(await today.usage()).toEqual({
      usedTokens: 200,
      softTokens: 100,
      hardTokens: 200,
      level: "hard",
    });
  });

  it("is shared between processes, and survives a restart", async () => {
    await budget().add(150);
    expect(await budget().level()).toBe("soft");
  });

  it("starts again at midnight UTC", async () => {
    const today = budget();
    now = new Date("2026-06-15T23:59:59Z");
    await today.add(500);
    expect(await today.level()).toBe("hard");

    now = new Date("2026-06-16T00:00:01Z");
    expect(await today.usage()).toMatchObject({ usedTokens: 0, level: "ok" });
  });

  it("gives its key an expiry", async () => {
    await budget().add(1);
    expect(await redis.ttl(`${prefix}:budget:2026-06-15`)).toBeGreaterThan(86_400);
  });

  it("keeps counting in the process when Redis is down", async () => {
    const today = budget(brokenRedis as Redis);
    await today.add(150);
    expect(await today.level()).toBe("soft");
    await today.add(50);
    expect(await today.level()).toBe("hard");
  });
});

describe("request ids", () => {
  it("gives every response an id, also errors", async () => {
    app = await startApp({ pool, redis });
    const ok = await fetch(`${app.url}/api/genres`);
    expect(ok.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const missing = await fetch(`${app.url}/api/nope`);
    expect(errorResponseSchema.parse(await missing.json()).error.requestId).toBe(
      missing.headers.get("x-request-id"),
    );
  });

  it("keeps an id the caller sent, unless it is not safe to log", async () => {
    app = await startApp({ pool, redis });
    const idFor = async (sent: string) =>
      (await fetch(`${app!.url}/api/genres`, { headers: { "x-request-id": sent } })).headers.get(
        "x-request-id",
      );

    expect(await idFor("trace-1234.abc_DEF")).toBe("trace-1234.abc_DEF");
    for (const unsafe of ["short", "<script>alert(1)</script>", "a".repeat(65), "with spaces in it"]) {
      expect(await idFor(unsafe)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("uses one id for the response, the LLM calls and the request log", async () => {
    const backend = createFakeBackend({ embeddingDimensions: 768 });
    const llm = createLlmProvider(backend, {
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
      recordCall: llmCallRecorder(pool, silentLogger),
    });
    app = await startApp({ pool, redis, llm, recordRequest: requestRecorder(pool, silentLogger) });
    backend.respondWith({ genres: [], excludeGenres: [], tags: [], excludeTags: [], referenceTitles: [], searchText: "heist" });

    const response = await post("/api/recommend", { query: "heist" }, { "x-request-id": "trace-0001" });
    expect(response.headers.get("x-request-id")).toBe("trace-0001");
    expect(recommendResponseSchema.parse(await response.json()).requestId).toBe("trace-0001");

    const calls = await pool.query("SELECT stage, request_id FROM llm_calls ORDER BY id");
    expect(calls.rows).toEqual([
      { stage: "parse", request_id: "trace-0001" },
      { stage: "embed_query", request_id: "trace-0001" },
    ]);
    const logged = await pool.query("SELECT request_id, route, outcome, cached, results FROM request_log");
    expect(logged.rows).toEqual([
      { request_id: "trace-0001", route: "recommend", outcome: "ok", cached: false, results: 0 },
    ]);
  });
});

describe("input limits and headers", () => {
  beforeEach(async () => {
    app = await startApp({ pool, redis });
  });

  it("refuses a field it does not know", async () => {
    const response = await post("/api/recommend", { query: "heist", model: "something-else" });
    expect(response.status).toBe(400);
    const { error } = errorResponseSchema.parse(await response.json());
    expect(error.code).toBe("validation_error");
    expect(JSON.stringify(error.details)).toContain("model");
  });

  it("refuses a search parameter it does not know", async () => {
    expect((await fetch(`${app!.url}/api/movies/search?q=heist&sort=random`)).status).toBe(400);
    expect((await fetch(`${app!.url}/api/movies/search?q=heist`)).status).toBe(200);
  });

  it("refuses a body over the size limit with 413", async () => {
    const response = await post("/api/recommend", { query: "heist", padding: "x".repeat(20_000) });
    expect(response.status).toBe(413);
    expect(errorResponseSchema.parse(await response.json()).error).toMatchObject({
      code: "payload_too_large",
      message: "The request body is too large",
    });
  });

  it("allows only the web app's origin, and sends security headers", async () => {
    const response = await fetch(`${app!.url}/api/genres`, {
      headers: { origin: "https://evil.example" },
    });
    // The browser of another site sees an origin that is not its own, and blocks the read.
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("access-control-expose-headers")).toContain("x-request-id");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
  });
});

describe("GET /api/stats", () => {
  let backend: FakeBackend;
  let budget: TokenBudget;

  async function start(adminToken: string | undefined) {
    backend = createFakeBackend({ embeddingDimensions: 768 });
    budget = createTokenBudget(redis, {
      softTokens: 1000,
      hardTokens: 2000,
      prefix,
      now: () => NOW,
      logger: silentLogger,
    });
    const record = llmCallRecorder(pool, silentLogger);
    const llm = createLlmProvider(backend, {
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
      recordCall: async (call) => {
        await record(call);
        await budget.add((call.inputTokens ?? 0) + (call.outputTokens ?? 0));
      },
    });
    const cacheOptions = { ttlSeconds: 60, prefix, logger: silentLogger };
    app = await startApp({
      pool,
      redis,
      llm,
      budget,
      now: () => NOW,
      recordRequest: requestRecorder(pool, silentLogger),
      queryEmbeddingCache: createQueryEmbeddingCache(redis, {
        model: "fake-embedding",
        dimensions: 768,
        ttlSeconds: 60,
        prefix,
        logger: silentLogger,
      }),
      parseCache: createJsonCache(redis, { name: "parse", schema: parsedRequestSchema, ...cacheOptions }),
      pickCache: createJsonCache(redis, { name: "pick", schema: picksSchema, ...cacheOptions }),
      config: { ...testAppConfig, adminToken },
    });
  }

  const stats = (token?: string) =>
    fetch(`${app!.url}/api/stats`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("does not exist when no admin token is configured", async () => {
    await start(undefined);
    expect((await stats(ADMIN_TOKEN)).status).toBe(404);
  });

  it("refuses a missing or wrong token", async () => {
    await start(ADMIN_TOKEN);
    for (const response of [await stats(), await stats("wrong-token"), await stats(`${ADMIN_TOKEN}x`)]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(JSON.stringify(await response.json())).not.toContain(ADMIN_TOKEN);
    }
  });

  it("reports today's requests, cache hits, fallbacks, tokens and latency", async () => {
    await start(ADMIN_TOKEN);
    const parsed = { genres: [], excludeGenres: [], tags: [], excludeTags: [], referenceTitles: [] };
    // 1: parse and embedding are called. 2: the same request, from the caches.
    backend.respondWith({ ...parsed, searchText: "bank heist" });
    await post("/api/recommend", { query: "heist" });
    await post("/api/recommend/stream", { query: "heist" });
    // 3: the parse reply is not valid JSON, so the words are searched as typed.
    backend.failNext({ type: "invalid_json" });
    await post("/api/recommend", { query: "space" });
    // Rows from yesterday are not today's numbers.
    await pool.query(
      `INSERT INTO request_log (request_id, route, outcome, cached, results, total_ms, stages, created_at)
       VALUES ('old', 'recommend', 'ok', true, 0, 5, '[]', $1)`,
      [new Date(NOW.getTime() - 86_400_000)],
    );
    // The API's clock is fixed, but rows are stamped by the database's clock.
    await pool.query("UPDATE request_log SET created_at = $1 WHERE request_id <> 'old'", [NOW]);
    await pool.query("UPDATE llm_calls SET created_at = $1", [NOW]);

    const response = await stats(ADMIN_TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = statsResponseSchema.parse(await response.json());

    expect(body.since).toBe("2026-06-15T00:00:00.000Z");
    expect(body.requests).toMatchObject({ total: 3, cached: 1, errors: 0, cancelled: 0 });
    expect(body.requests.cacheHitRate).toBeCloseTo(1 / 3);
    expect(body.requests.latencyMs.p95).toBeGreaterThanOrEqual(body.requests.latencyMs.p50!);

    const stage = (name: string) => body.stages.find((row) => row.name === name)!;
    expect(body.stages.map((row) => row.name)).toEqual(["parse", "embed", "search", "pick"]);
    expect(stage("parse")).toMatchObject({ runs: 3, fallbacks: 1, skipped: 0 });
    expect(stage("pick")).toMatchObject({ runs: 3, fallbacks: 0, skipped: 3 }); // empty catalog
    expect(stage("search").latencyMs.p50).not.toBeNull();

    // Fake usage: 100 in and 20 out per generateJson; one token per word embedded.
    expect(body.llm.byStage).toEqual([
      { stage: "embed_query", calls: 2, failedCalls: 0, inputTokens: 3, outputTokens: 0 },
      { stage: "parse", calls: 2, failedCalls: 1, inputTokens: 100, outputTokens: 20 },
    ]);
    expect(body.llm).toMatchObject({ calls: 4, failedCalls: 1, inputTokens: 103, outputTokens: 20 });
    expect(body.llm.averageTokensPerRequest).toBe(41); // 123 tokens over 3 requests
    expect(body.budget).toEqual({ usedTokens: 123, softTokens: 1000, hardTokens: 2000, level: "ok" });
  });

  it("never writes the admin token to the log", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", { write: (line) => void lines.push(line) });
    app = await startApp({ pool, redis, logger, config: { ...testAppConfig, adminToken: ADMIN_TOKEN } });

    expect((await stats(ADMIN_TOKEN)).status).toBe(200);
    await expect.poll(() => lines.length).toBeGreaterThan(0);
    const log = lines.join("");
    expect(log).toContain("/api/stats");
    expect(log).toContain('"authorization":"[redacted]"');
    expect(log).not.toContain(ADMIN_TOKEN);
  });

  it("answers with zeros and nulls on a day without requests", async () => {
    await start(ADMIN_TOKEN);
    const body = statsResponseSchema.parse(await (await stats(ADMIN_TOKEN)).json());
    expect(body.requests).toEqual({
      total: 0,
      cached: 0,
      cacheHitRate: null,
      errors: 0,
      cancelled: 0,
      latencyMs: { p50: null, p95: null },
    });
    expect(body.stages).toEqual([]);
    expect(body.llm.averageTokensPerRequest).toBeNull();
  });
});

describe("retention", () => {
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

  async function seedLogs() {
    for (const [id, days] of [["old", 31], ["edge", 30.01], ["recent", 29.9], ["new", 0]] as const) {
      await pool.query(
        `INSERT INTO llm_calls (request_id, stage, model, latency_ms, status, created_at)
         VALUES ($1, 'parse', 'fake', 1, 'ok', $2)`,
        [id, daysAgo(days)],
      );
      await pool.query(
        `INSERT INTO request_log (request_id, route, outcome, cached, results, total_ms, stages, created_at)
         VALUES ($1, 'recommend', 'ok', false, 0, 1, '[]', $2)`,
        [id, daysAgo(days)],
      );
    }
  }
  const remaining = async (table: "llm_calls" | "request_log") =>
    (await pool.query<{ request_id: string }>(`SELECT request_id FROM ${table} ORDER BY id`)).rows.map(
      (row) => row.request_id,
    );

  it("deletes log rows older than the limit, and only those", async () => {
    await seedLogs();
    expect(await deleteOldLogs(pool, 30, NOW)).toEqual({ llmCalls: 2, requests: 2 });
    expect(await remaining("llm_calls")).toEqual(["recent", "new"]);
    expect(await remaining("request_log")).toEqual(["recent", "new"]);
    // Running it again changes nothing.
    expect(await deleteOldLogs(pool, 30, NOW)).toEqual({ llmCalls: 0, requests: 0 });
  });

  describe("as a queued job", () => {
    let connection: Redis;
    let queue: Queue;

    beforeEach(() => {
      connection = createQueueConnection(redisUrl);
      queue = createMaintenanceQueue(connection, `test-maintenance-${randomUUID()}`);
    });

    afterEach(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
    });

    it("is run by the worker", async () => {
      await seedLogs();
      const worker = startMaintenanceWorker({
        connection,
        queueName: queue.name,
        pool,
        retentionDays: 30,
        now: () => NOW,
        logger: silentLogger,
      });
      const finished = new Promise((resolve) => worker.worker.once("completed", (_job, result) => resolve(result)));
      await queue.add("retention", {});

      expect(await finished).toEqual({ llmCalls: 2, requests: 2 });
      expect(await remaining("llm_calls")).toEqual(["recent", "new"]);
      await worker.close();
    });

    it("is scheduled once, however often the worker starts", async () => {
      await scheduleRetention(queue, "15 3 * * *");
      await scheduleRetention(queue, "15 3 * * *");
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]).toMatchObject({ name: "retention", pattern: "15 3 * * *", tz: "UTC" });

      // A changed schedule replaces the old one.
      await scheduleRetention(queue, "0 4 * * *");
      expect((await queue.getJobSchedulers()).map((scheduler) => scheduler.pattern)).toEqual(["0 4 * * *"]);
    });
  });
});

describe("embedding quota usage", () => {
  it("counts embedded texts, not calls, since the last refill", async () => {
    const backend = createFakeBackend({ embeddingDimensions: 8 });
    const llm = createLlmProvider(backend, {
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
      recordCall: llmCallRecorder(pool, silentLogger),
    });
    const embed = (texts: string[], stage: string) =>
      llm.embed({ texts, kind: "document", stage, timeoutMs: 1000 });

    await embed(["a", "b", "c"], "embed_batch"); // one call, three texts
    await embed(["d", "e"], "embed_batch");
    await embed(["a request"], "embed_query");
    await embed(["another request"], "embed_query");
    // A refused call used no quota.
    backend.failNext({ type: "status", status: 429 });
    await embed(["f"], "embed_batch").catch(() => {});
    // Calls that are not embeddings, and calls of another model, do not count.
    backend.respondWith({});
    await llm.generateJson({
      stage: "parse",
      promptVersion: "v",
      system: "",
      prompt: "",
      schema: {},
      maxOutputTokens: 10,
      timeoutMs: 1000,
    });
    // Yesterday's use is not today's. Old rows have no item count.
    await pool.query(
      `INSERT INTO llm_calls (stage, model, latency_ms, status, items, created_at) VALUES
         ('embed_batch', 'fake-embedding', 1, 'ok', 20, now() - interval '2 days'),
         ('embed_query', 'another-model', 1, 'ok', 1, now()),
         ('embed_query', 'fake-embedding', 1, 'ok', NULL, now())`,
    );

    const since = new Date(Date.now() - 3_600_000);
    expect(await quotaUsage(pool, "fake-embedding", since)).toEqual({ movies: 5, requests: 3 });
    expect(await quotaUsage(pool, "fake-embedding", new Date(Date.now() + 1000))).toEqual({
      movies: 0,
      requests: 0,
    });
  });
});
