import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrator.js";
import { createPool } from "../src/db/pool.js";
import { embedBatch } from "../src/embeddings/batch.js";
import { assertDimensionsMatch, loadMoviesToEmbed } from "../src/embeddings/store.js";
import { exportEmbeddings, importEmbeddings } from "../src/embeddings/transfer.js";
import { ingest } from "../src/ingest/load.js";
import type { Movie } from "../src/ingest/transform.js";
import {
  createEmbedQueue,
  createQueueConnection,
  type EmbedJobData,
  enqueueEmbedBatches,
  remainingJobs,
  runUntilDone,
  startEmbedWorker,
} from "../src/jobs/embedQueue.js";
import { llmCallRecorder } from "../src/llm/calls.js";
import { createFakeBackend, type FakeBackend, fakeEmbedding } from "../src/llm/fake.js";
import { createLlmProvider } from "../src/llm/provider.js";
import type { LlmProvider } from "../src/llm/types.js";
import { loadTestConfig, silentLogger, waitForRedis } from "./helpers.js";

const DIMENSIONS = 768; // the size of the embedding column
const target = { model: "fake-embedding", dimensions: DIMENSIONS };

function movie(tmdbId: number, overrides: Partial<Movie> = {}): Movie {
  return {
    tmdb_id: tmdbId,
    title: `Movie ${tmdbId}`,
    overview: `Overview of movie ${tmdbId}.`,
    tagline: null,
    genres: ["Drama"],
    keywords: [],
    release_year: 2000,
    runtime_minutes: 100,
    language: "en",
    vote_average: 7,
    vote_count: 100,
    popularity: 1,
    poster_path: null,
    imdb_id: null,
    ...overrides,
  };
}

let pool: pg.Pool;
let connection: Redis;
let queue: Queue<EmbedJobData>;
let backend: FakeBackend;
let llm: LlmProvider;

const load = (movies: Movie[]) =>
  ingest(pool, { movies, tagsByTmdbId: new Map(), batchSize: 500, minVotesPercentile: 0.5 });

const idsOf = async () =>
  (await pool.query<{ id: number }>("SELECT id FROM movies ORDER BY id")).rows.map((row) => row.id);

const embeddedCount = async () =>
  (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM movie_embeddings")).rows[0]!
    .count;

const embedCalls = () => backend.calls.filter((call) => call.method === "embed").length;

function worker(options: { batchDelayMs?: number } = {}) {
  return startEmbedWorker({
    connection,
    queueName: queue.name,
    processBatch: async (movieIds) => {
      const result = await embedBatch({ pool, llm, target, timeoutMs: 1000 }, movieIds);
      if (options.batchDelayMs) await new Promise((r) => setTimeout(r, options.batchDelayMs));
      return result;
    },
    requestsPerMinute: 6000,
    rateLimitPatience: 2,
    rateLimitPauseMs: 20,
    rateLimitMaxWaitMs: 1000,
    logger: silentLogger,
  });
}

const run = () => runUntilDone(queue, worker(), { pollMs: 20 });

beforeAll(async () => {
  const config = loadTestConfig();
  pool = createPool(config.testDatabaseUrl, silentLogger);
  await runMigrations(pool);
  connection = createQueueConnection(config.redisUrl);
  await waitForRedis(connection);
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE movies, movie_tags, movie_embeddings, rating_stats, llm_calls RESTART IDENTITY CASCADE",
  );
  // A queue of its own for every test, so tests cannot see each other's jobs.
  queue = createEmbedQueue(connection, `test-embeddings-${randomUUID()}`);
  backend = createFakeBackend({ embeddingDimensions: DIMENSIONS });
  llm = createLlmProvider(backend, {
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    recordCall: llmCallRecorder(pool, silentLogger),
    sleep: async () => {},
  });
});

afterEach(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
});

afterAll(async () => {
  connection?.disconnect();
  await pool?.end();
});

describe("embedBatch", () => {
  it("embeds movies, stores one vector each and logs the call", async () => {
    await load([movie(1), movie(2), movie(3)]);
    const result = await embedBatch({ pool, llm, target, timeoutMs: 1000 }, await idsOf());
    expect(result).toMatchObject({ embedded: 3, skipped: 0 });

    const { rows } = await pool.query(
      `SELECT model, vector_dims(embedding) AS dims, length(content_hash) AS hash_length
       FROM movie_embeddings`,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ model: "fake-embedding", dims: 768, hash_length: 64 });

    const calls = await pool.query(
      "SELECT stage, model, status, input_tokens > 0 AS has_tokens, latency_ms >= 0 AS has_latency FROM llm_calls",
    );
    expect(calls.rows).toEqual([
      { stage: "embed_batch", model: "fake-embedding", status: "ok", has_tokens: true, has_latency: true },
    ]);
  });

  it("sends the title separately from the text, as a document", async () => {
    await load([movie(1, { title: "Inception", release_year: 2010 })]);
    await embedBatch({ pool, llm, target, timeoutMs: 1000 }, await idsOf());
    expect(backend.calls[0]!.input).toMatchObject({
      kind: "document",
      titles: ["Inception (2010)"],
      texts: ["Genres: Drama\nOverview: Overview of movie 1."],
    });
  });

  it("does nothing on a second run: no API call, no new rows", async () => {
    await load([movie(1), movie(2)]);
    const ids = await idsOf();
    await embedBatch({ pool, llm, target, timeoutMs: 1000 }, ids);

    const second = await embedBatch({ pool, llm, target, timeoutMs: 1000 }, ids);
    expect(second).toEqual({ embedded: 0, skipped: 2, inputTokens: 0 });
    expect(embedCalls()).toBe(1);
    expect(await embeddedCount()).toBe(2);
  });

  it("embeds again only the movie whose text changed", async () => {
    await load([movie(1), movie(2)]);
    const ids = await idsOf();
    await embedBatch({ pool, llm, target, timeoutMs: 1000 }, ids);

    await load([movie(1, { overview: "A completely new overview." }), movie(2)]);
    const pending = (await loadMoviesToEmbed(pool, target)).filter((m) => m.needsEmbedding);
    expect(pending.map((m) => m.movieId)).toEqual([ids[0]]);

    const result = await embedBatch({ pool, llm, target, timeoutMs: 1000 }, ids);
    expect(result).toMatchObject({ embedded: 1, skipped: 1 });
    expect(await embeddedCount()).toBe(2);
  });

  it("stores nothing when the API call fails", async () => {
    await load([movie(1)]);
    backend.failNext({ type: "status", status: 500 });
    await expect(embedBatch({ pool, llm, target, timeoutMs: 1000 }, await idsOf())).rejects.toThrow();
    expect(await embeddedCount()).toBe(0);
    expect((await pool.query("SELECT status FROM llm_calls")).rows).toEqual([{ status: "error" }]);
  });

  it("finds a movie by its own vector through the HNSW index", async () => {
    await load([movie(1), movie(2), movie(3), movie(4)]);
    const ids = await idsOf();
    await embedBatch({ pool, llm, target, timeoutMs: 1000 }, ids);

    const query = fakeEmbedding("Genres: Drama\nOverview: Overview of movie 3.", DIMENSIONS);
    const { rows } = await pool.query(
      `SELECT movie_id, embedding <=> $1::vector AS distance
       FROM movie_embeddings ORDER BY embedding <=> $1::vector LIMIT 1`,
      [`[${query.join(",")}]`],
    );
    expect(rows[0].movie_id).toBe(ids[2]);
    expect(rows[0].distance).toBeCloseTo(0, 5);
  });

  it("refuses a configured size that differs from the column", async () => {
    await expect(assertDimensionsMatch(pool, 768)).resolves.toBeUndefined();
    await expect(assertDimensionsMatch(pool, 1536)).rejects.toThrow("vector(768)");
  });
});

describe("embeddings queue", () => {
  it("embeds every queued batch, and a second pass finds nothing to do", async () => {
    await load([1, 2, 3, 4, 5].map((id) => movie(id)));
    const jobs = await enqueueEmbedBatches(queue, await idsOf(), { batchSize: 2, attempts: 1 });
    expect(jobs).toBe(3);

    const totals = await run();
    expect(totals).toMatchObject({ batches: 3, embedded: 5, skipped: 0, failedBatches: 0 });
    expect(await embeddedCount()).toBe(5);
    expect(await remainingJobs(queue)).toBe(0);

    const pending = (await loadMoviesToEmbed(pool, target)).filter((m) => m.needsEmbedding);
    expect(pending).toEqual([]);
  });

  it("continues after a crash without embedding finished work again", async () => {
    await load([1, 2, 3, 4, 5, 6].map((id) => movie(id)));
    const ids = await idsOf();
    await enqueueEmbedBatches(queue, ids, { batchSize: 2, attempts: 1 });

    // The first batch was stored, then the process died before the job was
    // marked done. All three jobs are still in the queue.
    await embedBatch({ pool, llm, target, timeoutMs: 1000 }, ids.slice(0, 2));
    expect(await remainingJobs(queue)).toBe(3);

    const totals = await run();
    expect(totals).toMatchObject({ batches: 3, embedded: 4, skipped: 2 });
    expect(await embeddedCount()).toBe(6);
    // One call before the crash, two after: the stored batch cost no second call.
    expect(embedCalls()).toBe(3);
  });

  it("can be stopped and restarted", async () => {
    await load([1, 2, 3, 4, 5, 6].map((id) => movie(id)));
    await enqueueEmbedBatches(queue, await idsOf(), { batchSize: 2, attempts: 1 });

    // Stop as soon as the first batch is done. Slow batches make sure the
    // stop is noticed while others are still waiting.
    const first = worker({ batchDelayMs: 200 });
    const partial = await runUntilDone(queue, first, {
      shouldStop: () => first.totals.batches >= 1,
      pollMs: 5,
    });
    expect(partial.batches).toBeGreaterThanOrEqual(1);
    expect(await remainingJobs(queue)).toBeGreaterThan(0);

    await run();
    expect(await embeddedCount()).toBe(6);
    expect(await remainingJobs(queue)).toBe(0);
  });

  it("keeps a batch that fails for good and still finishes the others", async () => {
    await load([1, 2, 3, 4].map((id) => movie(id)));
    await enqueueEmbedBatches(queue, await idsOf(), { batchSize: 2, attempts: 1 });
    backend.failNext({ type: "status", status: 400 });

    const totals = await run();
    expect(totals).toMatchObject({ batches: 1, embedded: 2, failedBatches: 1 });
    const failed = await queue.getFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data.movieIds).toHaveLength(2);

    // The next run retries what failed.
    await queue.retryJobs({ state: "failed" });
    await run();
    expect(await embeddedCount()).toBe(4);
    expect(await queue.getFailed()).toHaveLength(0);
  });

  it("stops when the API keeps answering 429 and leaves the batches queued", async () => {
    await load([1, 2, 3, 4].map((id) => movie(id)));
    await enqueueEmbedBatches(queue, await idsOf(), { batchSize: 2, attempts: 1 });
    backend.failNext(...Array.from({ length: 10 }, () => ({ type: "status" as const, status: 429 })));

    const totals = await run();
    expect(totals).toMatchObject({ stoppedByRateLimit: true, embedded: 0, failedBatches: 0 });
    expect(await remainingJobs(queue)).toBe(2);
    expect(await queue.getFailed()).toHaveLength(0);
  });
});

describe("rate limits that ask for a long wait", () => {
  it("stops at once instead of waiting, and keeps the batches queued", async () => {
    await load([1, 2, 3, 4].map((id) => movie(id)));
    await enqueueEmbedBatches(queue, await idsOf(), { batchSize: 2, attempts: 1 });
    backend.failNext({ type: "status", status: 429, retryAfterMs: 3_600_000 });

    const started = performance.now();
    const totals = await run();
    expect(totals).toMatchObject({ stoppedByRateLimit: true, embedded: 0 });
    expect(totals.lastRateLimitMessage).toContain("429");
    expect(performance.now() - started).toBeLessThan(3000);
    expect(await remainingJobs(queue)).toBe(2);
  });
});

describe("export and import", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "embeddings-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const vectors = async () =>
    (
      await pool.query(
        `SELECT m.tmdb_id, e.content_hash, e.embedding::real[] AS embedding
         FROM movie_embeddings e JOIN movies m ON m.id = e.movie_id ORDER BY m.tmdb_id`,
      )
    ).rows;

  it("brings back exactly the same vectors", async () => {
    await load([movie(1), movie(2), movie(3)]);
    await embedBatch({ pool, llm, target, timeoutMs: 1000 }, await idsOf());
    const before = await vectors();
    const path = join(dir, "export.jsonl.gz");

    expect(await exportEmbeddings(pool, target, path)).toBe(3);
    await pool.query("TRUNCATE movie_embeddings");

    expect(await importEmbeddings(pool, target, path)).toEqual({
      inFile: 3,
      imported: 3,
      unchanged: 0,
      unknownMovies: 0,
    });
    expect(await vectors()).toEqual(before);

    // Imported movies count as embedded, so `pnpm embed` has nothing to do.
    const pending = (await loadMoviesToEmbed(pool, target)).filter((m) => m.needsEmbedding);
    expect(pending).toEqual([]);
  });

  it("changes nothing when imported twice, and skips movies it does not know", async () => {
    await load([movie(1), movie(2), movie(3)]);
    await embedBatch({ pool, llm, target, timeoutMs: 1000 }, await idsOf());
    const path = join(dir, "export.jsonl.gz");
    await exportEmbeddings(pool, target, path);

    await pool.query("DELETE FROM movies WHERE tmdb_id = 3");
    expect(await importEmbeddings(pool, target, path)).toEqual({
      inFile: 3,
      imported: 0,
      unchanged: 2,
      unknownMovies: 1,
    });
  });

  it("refuses a file made with another model or size", async () => {
    await load([movie(1)]);
    await embedBatch({ pool, llm, target, timeoutMs: 1000 }, await idsOf());
    const path = join(dir, "export.jsonl.gz");
    await exportEmbeddings(pool, target, path);

    await expect(importEmbeddings(pool, { ...target, model: "other-model" }, path)).rejects.toThrow(
      "configured for other-model",
    );
  });
});
