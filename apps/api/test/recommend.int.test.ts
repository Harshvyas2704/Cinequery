import { randomUUID } from "node:crypto";
import { errorResponseSchema, recommendResponseSchema } from "@cinequery/shared";
import type { Redis } from "ioredis";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createQueryEmbeddingCache } from "../src/cache/queryEmbeddings.js";
import { createRedis } from "../src/cache/redis.js";
import { runMigrations } from "../src/db/migrator.js";
import { createPool } from "../src/db/pool.js";
import { saveEmbeddings } from "../src/embeddings/store.js";
import { ingest } from "../src/ingest/load.js";
import type { Movie } from "../src/ingest/transform.js";
import { llmCallRecorder } from "../src/llm/calls.js";
import { createFakeBackend, type FakeBackend, fakeEmbedding } from "../src/llm/fake.js";
import { createLlmProvider } from "../src/llm/provider.js";
import type { LlmProvider } from "../src/llm/types.js";
import { normalizeQuery } from "../src/recommend/normalize.js";
import { loadTestConfig, silentLogger, startApp, waitForRedis } from "./helpers.js";

const DIMENSIONS = 768;
const MODEL = "fake-embedding";

function movie(tmdbId: number, title: string, overrides: Partial<Movie> = {}): Movie {
  return {
    tmdb_id: tmdbId,
    title,
    overview: "A quiet story about ordinary people.",
    tagline: null,
    genres: ["Drama"],
    keywords: [],
    release_year: 2000,
    runtime_minutes: 100,
    language: "en",
    vote_average: 7,
    vote_count: 1000,
    popularity: 1,
    poster_path: null,
    imdb_id: null,
    ...overrides,
  };
}

// The fake embedding of a text carries no meaning, so each movie is given the
// vector of the request it should answer. A request then finds "its" movie at
// similarity 1, and every other movie far away.
const CATALOG: { movie: Movie; answers: string }[] = [
  { movie: movie(1, "Solaris"), answers: "space movie about loneliness" },
  { movie: movie(2, "Cool Hand Luke"), answers: "a prison escape" },
  {
    movie: movie(3, "Heist Night", { overview: "A crew plans a heist." }),
    answers: "something else entirely",
  },
  // Two movies with the same vector: only the rating can order them.
  { movie: movie(4, "Twin Low", { vote_average: 6, vote_count: 5000 }), answers: "twin request" },
  { movie: movie(5, "Twin High", { vote_average: 9, vote_count: 5000 }), answers: "twin request" },
];

let pool: pg.Pool;
let redis: Redis;
let backend: FakeBackend;
let llm: LlmProvider;
let app: Awaited<ReturnType<typeof startApp>> | undefined;

async function seed(withEmbeddings = true) {
  await pool.query(
    "TRUNCATE movies, movie_tags, movie_embeddings, rating_stats, llm_calls RESTART IDENTITY CASCADE",
  );
  await ingest(pool, {
    movies: CATALOG.map((entry) => entry.movie),
    tagsByTmdbId: new Map(),
    batchSize: 500,
    minVotesPercentile: 0.5,
  });
  if (!withEmbeddings) return;
  const { rows } = await pool.query<{ id: number; tmdb_id: number }>("SELECT id, tmdb_id FROM movies");
  await saveEmbeddings(
    pool,
    MODEL,
    rows.map((row) => ({
      movieId: row.id,
      hash: "test",
      vector: fakeEmbedding(
        CATALOG.find((entry) => entry.movie.tmdb_id === row.tmdb_id)!.answers,
        DIMENSIONS,
      ),
    })),
  );
}

async function start(options: { llm?: LlmProvider | null } = {}) {
  app = await startApp({
    pool,
    redis,
    llm: options.llm === undefined ? llm : options.llm,
    queryEmbeddingCache: createQueryEmbeddingCache(redis, {
      model: MODEL,
      dimensions: DIMENSIONS,
      ttlSeconds: 60,
      prefix: `test-${randomUUID()}`, // a clean cache for every test
      logger: silentLogger,
    }),
  });
}

async function post(body: unknown) {
  const response = await fetch(`${app!.url}/api/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as unknown };
}

async function recommend(query: string, limit?: number) {
  const { status, json } = await post({ query, limit });
  expect(status).toBe(200);
  const body = recommendResponseSchema.parse(json);
  return {
    ...body,
    titles: body.results.map((result) => result.movie.title),
    stages: Object.fromEntries(body.meta.stages.map((stage) => [stage.name, stage.status])),
  };
}

const embedCalls = () => backend.calls.filter((call) => call.method === "embed");

beforeAll(async () => {
  const config = loadTestConfig();
  pool = createPool(config.testDatabaseUrl, silentLogger);
  await runMigrations(pool);
  redis = createRedis(config.redisUrl, silentLogger);
  await waitForRedis(redis);
});

beforeEach(async () => {
  await seed();
  backend = createFakeBackend({ embeddingDimensions: DIMENSIONS });
  llm = createLlmProvider(backend, {
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    recordCall: llmCallRecorder(pool, silentLogger),
    sleep: async () => {},
  });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  redis?.disconnect();
  await pool?.end();
});

describe("POST /api/recommend: search by meaning", () => {
  it("returns the movie nearest in meaning first, with stages and a request id", async () => {
    await start();
    const body = await recommend("space movie about loneliness");

    expect(body.titles[0]).toBe("Solaris");
    expect(body.results[0]!.score).toBeGreaterThan(body.results[1]!.score);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.meta.cached).toBe(false);
    expect(body.meta.stages.map((stage) => stage.name)).toEqual(["embed", "search"]);
    expect(body.stages).toEqual({ embed: "ok", search: "ok" });
    expect(body.results[0]!.why).toBeUndefined();
  });

  it("embeds the request as a query, normalised", async () => {
    await start();
    await recommend("  A Prison   ESCAPE ");
    expect(embedCalls()).toHaveLength(1);
    expect(embedCalls()[0]!.input).toMatchObject({
      kind: "query",
      texts: ["a prison escape"],
      stage: "embed_query",
    });
  });

  it("returns at most `limit` movies, 8 by default", async () => {
    await start();
    expect((await recommend("a prison escape", 2)).results).toHaveLength(2);
    expect((await recommend("a prison escape")).results).toHaveLength(5); // the whole test catalog
  });

  it("uses the weighted rating to order movies that are equally close", async () => {
    await start();
    const { titles } = await recommend("twin request");
    expect(titles.slice(0, 2)).toEqual(["Twin High", "Twin Low"]);
  });

  it("logs the embedding call with the response's request id", async () => {
    await start();
    const { requestId } = await recommend("a prison escape");
    const { rows } = await pool.query("SELECT request_id, stage, status FROM llm_calls");
    expect(rows).toEqual([{ request_id: requestId, stage: "embed_query", status: "ok" }]);
  });
});

describe("POST /api/recommend: cache", () => {
  it("answers the same request the second time without calling the embedding API", async () => {
    await start();
    const first = await recommend("space movie about loneliness");
    const second = await recommend("Space movie about   LONELINESS");

    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(second.stages).toEqual({ embed: "ok", search: "ok" });
    expect(second.titles).toEqual(first.titles);
    expect(second.requestId).not.toBe(first.requestId);
    expect(embedCalls()).toHaveLength(1);
  });

  it("does not reuse one request's vector for another", async () => {
    await start();
    await recommend("space movie about loneliness");
    const other = await recommend("a prison escape");
    expect(other.meta.cached).toBe(false);
    expect(other.titles[0]).toBe("Cool Hand Luke");
    expect(embedCalls()).toHaveLength(2);
  });
});

describe("POST /api/recommend: fallbacks", () => {
  it("falls back to keyword search when the embedding call fails", async () => {
    await start();
    backend.failNext({ type: "status", status: 500 });

    const body = await recommend("heist");
    expect(body.stages).toEqual({ embed: "fallback", search: "ok" });
    expect(body.titles).toEqual(["Heist Night"]);
    expect(body.meta.cached).toBe(false);
  });

  it("falls back when the embedding call times out", async () => {
    await start();
    backend.failNext({ type: "timeout" });

    const started = performance.now();
    const body = await recommend("heist");
    expect(body.stages.embed).toBe("fallback");
    expect(body.titles).toEqual(["Heist Night"]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("does not cache a failure: the next request tries the API again", async () => {
    await start();
    backend.failNext({ type: "status", status: 429 });
    await recommend("space movie about loneliness");

    const retry = await recommend("space movie about loneliness");
    expect(retry.stages.embed).toBe("ok");
    expect(retry.meta.cached).toBe(false);
    expect(retry.titles[0]).toBe("Solaris");
  });

  it("skips the embedding and searches by keywords when no LLM is configured", async () => {
    await start({ llm: null });
    const body = await recommend("heist");
    expect(body.stages).toEqual({ embed: "skipped", search: "ok" });
    expect(body.titles).toEqual(["Heist Night"]);
  });

  it("falls back to keyword search when no movie has an embedding", async () => {
    await seed(false);
    await start();
    const body = await recommend("heist");
    expect(body.stages).toEqual({ embed: "ok", search: "fallback" });
    expect(body.titles).toEqual(["Heist Night"]);
  });

  it("returns an empty list, not an error, when nothing matches at all", async () => {
    await seed(false);
    await start({ llm: null });
    const body = await recommend("xylophone");
    expect(body.results).toEqual([]);
  });
});

describe("POST /api/recommend: validation", () => {
  it("rejects a query that is too short", async () => {
    await start();
    const { status, json } = await post({ query: "hi" });
    expect(status).toBe(400);
    expect(errorResponseSchema.parse(json).error.details).toEqual([
      { field: "query", message: "query must be at least 3 characters" },
    ]);
    expect(embedCalls()).toHaveLength(0);
  });

  it("rejects a limit above 20 and a missing body", async () => {
    await start();
    expect((await post({ query: "heist", limit: 21 })).status).toBe(400);
    const response = await fetch(`${app!.url}/api/recommend`, { method: "POST" });
    expect(response.status).toBe(400);
  });

  it("answers malformed JSON with 400 in the error shape", async () => {
    await start();
    const response = await fetch(`${app!.url}/api/recommend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(errorResponseSchema.safeParse(await response.json()).success).toBe(true);
  });
});

describe("query embedding cache", () => {
  const options = { model: MODEL, dimensions: 4, ttlSeconds: 60, logger: silentLogger };

  it("stores a vector as 4 bytes a number and returns it with float precision", async () => {
    const prefix = `test-${randomUUID()}`;
    const cache = createQueryEmbeddingCache(redis, { ...options, prefix });
    await cache.set("heist", [0.25, -0.5, 1, 0.1]);

    const stored = await cache.get("heist");
    expect(stored).toHaveLength(4);
    expect(stored![0]).toBe(0.25);
    expect(stored![3]).toBeCloseTo(0.1, 6);

    const [key] = await redis.keys(`${prefix}:*`);
    expect(await redis.strlen(key!)).toBe(16);
    expect(await redis.ttl(key!)).toBeGreaterThan(0);
  });

  it("keeps vectors of different models and sizes apart", async () => {
    const prefix = `test-${randomUUID()}`;
    await createQueryEmbeddingCache(redis, { ...options, prefix }).set("heist", [1, 2, 3, 4]);
    const otherModel = createQueryEmbeddingCache(redis, { ...options, prefix, model: "other" });
    const otherSize = createQueryEmbeddingCache(redis, { ...options, prefix, dimensions: 8 });
    expect(await otherModel.get("heist")).toBeNull();
    expect(await otherSize.get("heist")).toBeNull();
  });

  it("acts as an empty cache when Redis is down", async () => {
    const down = {
      getBuffer: async () => Promise.reject(new Error("connection refused")),
      set: async () => Promise.reject(new Error("connection refused")),
    };
    const cache = createQueryEmbeddingCache(down as never, options);
    await expect(cache.set("heist", [1, 2, 3, 4])).resolves.toBeUndefined();
    await expect(cache.get("heist")).resolves.toBeNull();
  });
});

describe("normalizeQuery", () => {
  it("trims, lower-cases and collapses spaces", () => {
    expect(normalizeQuery("  Space   MOVIE\tabout\nLoneliness ")).toBe("space movie about loneliness");
  });
});
