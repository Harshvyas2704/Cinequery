import { randomUUID } from "node:crypto";
import {
  doneEventSchema,
  errorResponseSchema,
  parsedRequestSchema,
  pickedEventSchema,
  type RecommendResponse,
  recommendResponseSchema,
  resultsEventSchema,
} from "@cinequery/shared";
import type { Redis } from "ioredis";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createJsonCache } from "../src/cache/jsonCache.js";
import { createQueryEmbeddingCache } from "../src/cache/queryEmbeddings.js";
import { createRedis } from "../src/cache/redis.js";
import { runMigrations } from "../src/db/migrator.js";
import { createPool } from "../src/db/pool.js";
import { saveEmbeddings } from "../src/embeddings/store.js";
import { ingest } from "../src/ingest/load.js";
import type { Movie, MovieTag } from "../src/ingest/transform.js";
import { type TokenBudget, unlimitedBudget } from "../src/limits/budget.js";
import { llmCallRecorder } from "../src/llm/calls.js";
import { createFakeBackend, type FakeBackend, fakeEmbedding } from "../src/llm/fake.js";
import { createLlmProvider } from "../src/llm/provider.js";
import type { GenerateJsonInput, LlmProvider } from "../src/llm/types.js";
import { loadFacts, loadTokens } from "../src/eval/facts.js";
import { normalizeQuery } from "../src/recommend/normalize.js";
import { recommend as runPipeline, type RecommendDeps } from "../src/recommend/pipeline.js";
import { picksSchema } from "../src/recommend/pick.js";
import { loadTestConfig, silentLogger, startApp, testAppConfig, waitForRedis } from "./helpers.js";

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

const vectorOf = (text: string) => fakeEmbedding(text, DIMENSIONS);

/** A unit vector close to `near`, with a little of `other` mixed in. */
function mostly(near: number[], other: number[]): number[] {
  const mixed = near.map((value, index) => 0.9 * value + 0.1 * (other[index] ?? 0));
  const length = Math.hypot(...mixed);
  return mixed.map((value) => value / length);
}

// The fake embedding of a text carries no meaning, so each movie is given the
// vector of the search text it should answer. A search for that text finds the
// movie at similarity 1 and every other movie at about 0.
type Entry = { movie: Movie; vector: number[] | null; tags?: MovieTag[] };

const CATALOG: Entry[] = [
  { movie: movie(1, "Solaris"), vector: vectorOf("space movie about loneliness") },
  { movie: movie(2, "Cool Hand Luke"), vector: vectorOf("a prison escape") },
  {
    movie: movie(3, "Heist Night", { overview: "A crew plans a heist.", genres: ["Crime"] }),
    vector: vectorOf("unrelated a"),
  },
  // Same vector, different ratings: only the rating can order them.
  { movie: movie(4, "Twin Low", { vote_average: 6, vote_count: 5000 }), vector: vectorOf("twin request") },
  { movie: movie(5, "Twin High", { vote_average: 9, vote_count: 5000 }), vector: vectorOf("twin request") },

  // "fast action movie": three equally close films that differ in genre and year.
  {
    movie: movie(6, "Speed Chase", { genres: ["Action"], release_year: 1994, vote_average: 6.5 }),
    vector: vectorOf("fast action movie"),
  },
  {
    movie: movie(7, "Last Stand", { genres: ["Action"], release_year: 2015, vote_average: 8 }),
    vector: vectorOf("fast action movie"),
  },
  {
    movie: movie(8, "Quiet Nineties", { genres: ["Drama"], release_year: 1995, vote_average: 9 }),
    vector: vectorOf("fast action movie"),
  },
  {
    movie: movie(15, "Dilli Express", { genres: ["Action"], release_year: 2012, language: "hi", vote_average: 6 }),
    vector: vectorOf("fast action movie"),
  },

  // A film to be "like", and one that is close to it.
  { movie: movie(9, "Inception", { vote_count: 30000 }), vector: vectorOf("the inception vector") },
  {
    movie: movie(10, "Dream Thieves", { vote_average: 5, vote_count: 100 }),
    vector: mostly(vectorOf("the inception vector"), vectorOf("unrelated b")),
  },

  // "tense thriller": equally close, one has the twist tag.
  {
    movie: movie(11, "Plain Thriller", { genres: ["Thriller"], vote_average: 7.5 }),
    vector: vectorOf("tense thriller"),
  },
  {
    movie: movie(12, "Twisty Thriller", { genres: ["Thriller"], vote_average: 7 }),
    vector: vectorOf("tense thriller"),
    tags: [{ tag: "plot twist", relevance: 0.9 }],
  },

  // "scary house": one is a horror film.
  {
    movie: movie(13, "Haunted", { genres: ["Horror"], vote_average: 8 }),
    vector: vectorOf("scary house"),
  },
  {
    movie: movie(14, "Old Manor", { genres: ["Mystery"], vote_average: 6 }),
    vector: vectorOf("scary house"),
  },

  // No embedding: can only be found by its words.
  {
    movie: movie(16, "Unseen Job", {
      overview: "A crew of thieves plans a bank heist.",
      genres: ["Crime"],
      release_year: 2020,
    }),
    vector: null,
  },
];

let pool: pg.Pool;
let redis: Redis;
let backend: FakeBackend;
let llm: LlmProvider;
let app: Awaited<ReturnType<typeof startApp>> | undefined;

async function seed(options: { embeddings: boolean } = { embeddings: true }) {
  await pool.query(
    "TRUNCATE movies, movie_tags, movie_embeddings, rating_stats, llm_calls RESTART IDENTITY CASCADE",
  );
  await ingest(pool, {
    movies: CATALOG.map((entry) => entry.movie),
    tagsByTmdbId: new Map(
      CATALOG.filter((entry) => entry.tags).map((entry) => [entry.movie.tmdb_id, entry.tags!]),
    ),
    batchSize: 500,
    minVotesPercentile: 0.5,
  });
  if (!options.embeddings) return;
  const { rows } = await pool.query<{ id: number; tmdb_id: number }>("SELECT id, tmdb_id FROM movies");
  const idOf = new Map(rows.map((row) => [row.tmdb_id, row.id]));
  await saveEmbeddings(
    pool,
    MODEL,
    CATALOG.filter((entry) => entry.vector).map((entry) => ({
      movieId: idOf.get(entry.movie.tmdb_id)!,
      hash: "test",
      vector: entry.vector!,
    })),
  );
}

async function start(
  options: {
    llm?: LlmProvider | null;
    pickTimeoutMs?: number;
    pool?: pg.Pool;
    budget?: TokenBudget;
  } = {},
) {
  const prefix = `test-${randomUUID()}`; // clean caches for every test
  app = await startApp({
    pool: options.pool ?? pool,
    redis,
    budget: options.budget ?? unlimitedBudget,
    config: {
      ...testAppConfig,
      recommend: {
        ...testAppConfig.recommend,
        pick: {
          ...testAppConfig.recommend.pick,
          timeoutMs: options.pickTimeoutMs ?? testAppConfig.recommend.pick.timeoutMs,
        },
      },
    },
    llm: options.llm === undefined ? llm : options.llm,
    now: () => new Date("2026-06-15T12:00:00Z"),
    queryEmbeddingCache: createQueryEmbeddingCache(redis, {
      model: MODEL,
      dimensions: DIMENSIONS,
      ttlSeconds: 60,
      prefix,
      logger: silentLogger,
    }),
    parseCache: createJsonCache(redis, {
      name: "parse",
      schema: parsedRequestSchema,
      ttlSeconds: 60,
      prefix,
      logger: silentLogger,
    }),
    pickCache: createJsonCache(redis, {
      name: "pick",
      schema: picksSchema,
      ttlSeconds: 60,
      prefix,
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
    // The steps up to the search. The pick step has its own tests below; where
    // a test scripts no picks, it falls back and the search order is kept.
    stages: Object.fromEntries(
      body.meta.stages
        .filter((stage) => stage.name !== "pick")
        .map((stage) => [stage.name, stage.status]),
    ),
    pick: body.meta.stages.find((stage) => stage.name === "pick")?.status,
  };
}

/** Scripts what the model will answer to the next parse call. */
function modelSays(reply: Record<string, unknown>) {
  backend.respondWith({
    genres: [],
    excludeGenres: [],
    tags: [],
    excludeTags: [],
    referenceTitles: [],
    ...reply,
  });
}

const calls = (method: "embed" | "generateJson") =>
  backend.calls.filter((call) => call.method === method);

const callsOf = (stage: "parse" | "pick") =>
  calls("generateJson")
    .map((call) => call.input as GenerateJsonInput)
    .filter((input) => input.stage === stage);

/** The database id of a movie in the test catalog. */
async function idOf(title: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM movies WHERE title = $1", [title]);
  return rows[0]!.id;
}

/** Scripts what the model will answer to the next pick call. */
async function modelPicks(...picks: [title: string, why: string][]) {
  backend.respondWith({
    picks: await Promise.all(picks.map(async ([title, why]) => ({ id: await idOf(title), why }))),
  });
}

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

describe("POST /api/recommend: understanding the request", () => {
  it("applies the genre and the years of 'action movie from the 90s'", async () => {
    await start();
    modelSays({ genres: ["Action"], yearFrom: 1990, yearTo: 1999, searchText: "fast action movie" });

    const body = await recommend("action movie from the 90s", 1);
    // Without the year filter Last Stand (better rated) would be first; without
    // the genre filter Quiet Nineties (best rated) would be.
    expect(body.titles).toEqual(["Speed Chase"]);
    expect(body.stages).toEqual({ parse: "ok", embed: "ok", search: "ok" });
    expect(body.meta.parsed).toMatchObject({ genres: ["Action"], yearFrom: 1990, yearTo: 1999 });
    expect(body.meta.relaxed).toBeUndefined();
  });

  it("sends the request to the model between tags, with the prompt version", async () => {
    await start();
    modelSays({ searchText: "a prison escape" });
    await recommend("  A Prison   ESCAPE ");

    const input = calls("generateJson")[0]!.input as GenerateJsonInput;
    expect(input).toMatchObject({
      stage: "parse",
      promptVersion: "parse-v1",
      prompt: "<request>a prison escape</request>",
      model: "fake-parse",
      thinkingLevel: "minimal",
    });
    expect(input.system).toContain("Current year: 2026.");
  });

  it("embeds the English search text the model wrote, not the Hinglish request", async () => {
    await start();
    modelSays({ tags: ["tense"], searchText: "A good suspense movie" });
    const body = await recommend("koi achhi suspense movie batao");

    expect(calls("embed")[0]!.input).toMatchObject({ kind: "query", texts: ["a good suspense movie"] });
    expect(body.meta.parsed?.searchText).toBe("A good suspense movie");
  });

  it("drops what the model got wrong before searching", async () => {
    await start();
    modelSays({ genres: ["Heist", "action"], yearFrom: 1700, tags: ["explosions"], language: "Hindi", searchText: "fast action movie" });

    const body = await recommend("some request", 2);
    expect(body.meta.parsed).toMatchObject({ genres: ["Action"], tags: [] });
    expect(body.meta.parsed?.yearFrom).toBeUndefined();
    expect(body.meta.parsed?.language).toBeUndefined();
    expect(body.titles).toEqual(["Last Stand", "Speed Chase"]);
  });

  it("logs the parse and embedding calls with the response's request id", async () => {
    await start();
    modelSays({ searchText: "a prison escape" });
    const { requestId } = await recommend("a prison escape");

    const { rows } = await pool.query(
      "SELECT request_id, stage, model, prompt_version, status FROM llm_calls WHERE stage <> 'pick' ORDER BY id",
    );
    expect(rows).toEqual([
      { request_id: requestId, stage: "parse", model: "fake-parse", prompt_version: "parse-v1", status: "ok" },
      { request_id: requestId, stage: "embed_query", model: MODEL, prompt_version: null, status: "ok" },
    ]);
  });
});

describe("POST /api/recommend: tags", () => {
  it("lifts a movie that has a wanted tag above an equally close one", async () => {
    await start();
    modelSays({ searchText: "tense thriller" });
    expect((await recommend("a tense thriller", 2)).titles).toEqual(["Plain Thriller", "Twisty Thriller"]);

    modelSays({ tags: ["twist ending"], searchText: "tense thriller" });
    expect((await recommend("a tense thriller with a twist", 2)).titles).toEqual([
      "Twisty Thriller",
      "Plain Thriller",
    ]);
  });

  it("leaves out movies with an unwanted tag", async () => {
    await start();
    modelSays({ excludeTags: ["twist ending"], searchText: "tense thriller" });
    const body = await recommend("tense thriller, no twists", 1);
    expect(body.titles).toEqual(["Plain Thriller"]);
    expect(body.meta.relaxed).toBeUndefined();
  });

  it("leaves out an unwanted genre, and never brings it back", async () => {
    await start();
    modelSays({ excludeGenres: ["Horror"], searchText: "scary house" });
    const body = await recommend("spooky house but not horror");
    expect(body.titles[0]).toBe("Old Manor");
    expect(body.titles).not.toContain("Haunted");
    expect(body.meta.relaxed).toBeUndefined();
  });
});

describe("POST /api/recommend: films to be like", () => {
  it("moves the search toward the named film and leaves that film out", async () => {
    await start();
    modelSays({ referenceTitles: ["inception"], searchText: "mind-bending thriller" });

    const body = await recommend("something like Inception", 3);
    expect(body.titles[0]).toBe("Dream Thieves");
    expect(body.titles).not.toContain("Inception");
  });

  it("finds the film despite a typo in the title", async () => {
    await start();
    modelSays({ referenceTitles: ["Incepton"], searchText: "mind-bending thriller" });
    expect((await recommend("like incepton", 1)).titles).toEqual(["Dream Thieves"]);
  });

  it("ignores a title that is not in the catalog", async () => {
    await start();
    modelSays({ referenceTitles: ["Zzyzx Road Trip"], searchText: "a prison escape" });
    const body = await recommend("like Zzyzx Road Trip, a prison escape", 1);
    expect(body.titles).toEqual(["Cool Hand Luke"]);
  });
});

describe("POST /api/recommend: too few results", () => {
  it("loosens filters in a fixed order and reports which", async () => {
    await start();
    modelSays({
      genres: ["Action"],
      yearFrom: 1990,
      yearTo: 1999,
      minRating: 9,
      searchText: "fast action movie",
    });

    const body = await recommend("a top rated 90s action movie", 2);
    // Rating first (Speed Chase appears), then years (Last Stand appears).
    expect(body.meta.relaxed).toEqual(["minRating", "years"]);
    expect(body.titles).toEqual(["Last Stand", "Speed Chase"]);
    // The genre was never loosened.
    expect(body.titles).not.toContain("Quiet Nineties");
  });

  it("brings back movies with an unwanted tag only when it must", async () => {
    await start();
    modelSays({ genres: ["Thriller"], excludeTags: ["twist ending"], searchText: "tense thriller" });
    const body = await recommend("tense thriller, no twists", 2);
    expect(body.meta.relaxed).toEqual(["excludeTags"]);
    expect(body.titles).toEqual(["Plain Thriller", "Twisty Thriller"]);
  });

  it("as a last step accepts one of several genres, but never none of them", async () => {
    await start();
    modelSays({ genres: ["Action", "Thriller"], searchText: "fast action movie" });
    const body = await recommend("an action thriller", 4);
    // No movie is both. Action films and thrillers come back; the drama does not.
    expect(body.meta.relaxed).toEqual(["genres"]);
    expect(body.titles).toHaveLength(4);
    expect(body.titles.slice(0, 2)).toEqual(["Last Stand", "Speed Chase"]);
    expect(body.titles).not.toContain("Quiet Nineties");
  });

  it("never loosens the language, even if that leaves few results", async () => {
    await start();
    modelSays({ language: "hi", searchText: "fast action movie" });
    const body = await recommend("hindi action movie");
    expect(body.titles).toEqual(["Dilli Express"]);
    expect(body.meta.relaxed).toBeUndefined();
  });

  it("fills up with keyword matches for movies that have no embedding", async () => {
    await start();
    modelSays({ genres: ["Crime"], yearFrom: 2015, searchText: "thieves bank heist" });
    const body = await recommend("recent heist movie", 1);
    // No embedded movie passes the filters, so meaning search found nothing.
    expect(body.titles).toEqual(["Unseen Job"]);
    expect(body.stages).toEqual({ parse: "ok", embed: "ok", search: "fallback" });
  });
});

describe("POST /api/recommend: cache", () => {
  it("answers the same request the second time without calling the LLM", async () => {
    await start();
    modelSays({ searchText: "space movie about loneliness" });
    await modelPicks(["Solaris", "A lonely station above a strange planet."]);
    const first = await recommend("space movie about loneliness");
    const second = await recommend("Space movie about   LONELINESS");

    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(second.stages).toEqual({ parse: "ok", embed: "ok", search: "ok" });
    expect(second.pick).toBe("ok");
    expect(second.results).toEqual(first.results);
    expect(second.results[0]!.why).toBe("A lonely station above a strange planet.");
    expect(second.meta.parsed).toEqual(first.meta.parsed);
    expect(second.requestId).not.toBe(first.requestId);
    expect(calls("generateJson")).toHaveLength(2); // one parse, one pick
    expect(calls("embed")).toHaveLength(1);
  });

  it("shares an embedding between two requests with the same search text", async () => {
    await start();
    modelSays({ searchText: "a prison escape" });
    await recommend("prison break film");
    modelSays({ genres: ["Drama"], searchText: "a prison escape" });
    const second = await recommend("drama about escaping jail");

    expect(callsOf("parse")).toHaveLength(2);
    expect(calls("embed")).toHaveLength(1);
    // One step still called the LLM, so the request as a whole was not cached.
    expect(second.meta.cached).toBe(false);
    expect(second.titles[0]).toBe("Cool Hand Luke");
  });
});

describe("POST /api/recommend: fallbacks", () => {
  it("searches the words as typed when the model's reply is not valid JSON", async () => {
    await start();
    backend.failNext({ type: "invalid_json" });

    const body = await recommend("space movie about loneliness");
    expect(body.stages).toEqual({ parse: "fallback", embed: "ok", search: "ok" });
    expect(body.titles[0]).toBe("Solaris");
    expect(body.meta.parsed).toBeUndefined();
    expect(calls("embed")[0]!.input).toMatchObject({ texts: ["space movie about loneliness"] });
  });

  it("does the same when the parse call times out or the reply is not an object", async () => {
    await start();
    backend.failNext({ type: "timeout" });
    const timedOut = await recommend("a prison escape", 1);
    expect(timedOut.stages.parse).toBe("fallback");
    expect(timedOut.titles).toEqual(["Cool Hand Luke"]);

    backend.respondWith("Action movies from the 90s");
    const notAnObject = await recommend("space movie about loneliness", 1);
    expect(notAnObject.stages.parse).toBe("fallback");
    expect(notAnObject.titles).toEqual(["Solaris"]);
  });

  it("does not cache a failed parse: the next request asks the model again", async () => {
    await start();
    backend.failNext({ type: "status", status: 503 });
    await recommend("action movie from the 90s", 1);

    modelSays({ genres: ["Action"], yearFrom: 1990, yearTo: 1999, searchText: "fast action movie" });
    const retry = await recommend("action movie from the 90s", 1);
    expect(retry.stages.parse).toBe("ok");
    expect(retry.titles).toEqual(["Speed Chase"]);
  });

  it("keeps the parsed filters when only the embedding fails", async () => {
    await start();
    modelSays({ genres: ["Crime"], searchText: "heist crew" });
    backend.failNextEmbed({ type: "status", status: 500 });

    const body = await recommend("a heist film");
    expect(body.stages).toEqual({ parse: "ok", embed: "fallback", search: "ok" });
    expect(body.titles.sort()).toEqual(["Heist Night", "Unseen Job"]);
    expect(body.meta.cached).toBe(false);
  });

  it("searches by keywords when no LLM is configured", async () => {
    await start({ llm: null });
    const body = await recommend("heist");
    expect(body.stages).toEqual({ parse: "skipped", embed: "skipped", search: "ok" });
    expect(body.titles.sort()).toEqual(["Heist Night", "Unseen Job"]);
    expect(body.meta.parsed).toBeUndefined();
  });

  it("falls back to keyword search when no movie has an embedding", async () => {
    await seed({ embeddings: false });
    await start();
    modelSays({ searchText: "heist" });
    const body = await recommend("heist");
    expect(body.stages).toEqual({ parse: "ok", embed: "ok", search: "fallback" });
    expect(body.titles.sort()).toEqual(["Heist Night", "Unseen Job"]);
  });

  it("returns an empty list, not an error, when nothing matches at all", async () => {
    await seed({ embeddings: false });
    await start({ llm: null });
    expect((await recommend("xylophone")).results).toEqual([]);
  });
});

describe("POST /api/recommend: basics", () => {
  it("returns the nearest movie first, a request id, and at most `limit` movies", async () => {
    await start();
    modelSays({ searchText: "space movie about loneliness" });
    const body = await recommend("space movie about loneliness", 3);

    expect(body.titles[0]).toBe("Solaris");
    expect(body.results).toHaveLength(3);
    expect(body.results[0]!.score).toBeGreaterThan(body.results[1]!.score);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.meta.stages.map((stage) => stage.name)).toEqual([
      "parse",
      "embed",
      "search",
      "pick",
    ]);
    expect(body.results[0]!.why).toBeUndefined();
  });

  it("returns 8 movies by default", async () => {
    await start();
    modelSays({ searchText: "a prison escape" });
    expect((await recommend("a prison escape")).results).toHaveLength(8);
  });

  it("uses the weighted rating to order movies that are equally close", async () => {
    await start();
    modelSays({ searchText: "twin request" });
    expect((await recommend("twin request", 2)).titles).toEqual(["Twin High", "Twin Low"]);
  });
});

describe("POST /api/recommend: validation", () => {
  it("rejects a query that is too short, without calling the LLM", async () => {
    await start();
    const { status, json } = await post({ query: "hi" });
    expect(status).toBe(400);
    expect(errorResponseSchema.parse(json).error.details).toEqual([
      { field: "query", message: "query must be at least 3 characters" },
    ]);
    expect(backend.calls).toHaveLength(0);
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

describe("JSON cache", () => {
  const options = { name: "parse", schema: parsedRequestSchema, ttlSeconds: 60, logger: silentLogger };
  const value = {
    genres: ["Action"],
    excludeGenres: [],
    tags: [],
    excludeTags: [],
    referenceTitles: [],
    searchText: "fast action movie",
  };

  it("returns what was stored, with an expiry, and keeps keys apart", async () => {
    const prefix = `test-${randomUUID()}`;
    const cache = createJsonCache(redis, { ...options, prefix });
    await cache.set(["parse-v1", 2026, "action"], value);

    expect(await cache.get(["parse-v1", 2026, "action"])).toEqual(value);
    expect(await cache.get(["parse-v2", 2026, "action"])).toBeNull();
    expect(await cache.get(["parse-v1", 2027, "action"])).toBeNull();
    const [key] = await redis.keys(`${prefix}:*`);
    expect(await redis.ttl(key!)).toBeGreaterThan(0);
  });

  it("treats a stored value of the wrong shape as a miss", async () => {
    const prefix = `test-${randomUUID()}`;
    const cache = createJsonCache(redis, { ...options, prefix });
    await cache.set(["k"], value);
    const [key] = await redis.keys(`${prefix}:*`);
    await redis.set(key!, JSON.stringify({ genres: "Action" }), "EX", 60);
    expect(await cache.get(["k"])).toBeNull();
    await redis.set(key!, "not json", "EX", 60);
    expect(await cache.get(["k"])).toBeNull();
  });
});

describe("normalizeQuery", () => {
  it("trims, lower-cases and collapses spaces", () => {
    expect(normalizeQuery("  Space   MOVIE\tabout\nLoneliness ")).toBe("space movie about loneliness");
  });
});

describe("POST /api/recommend: picks and reasons", () => {
  // "fast action movie" finds these four at the same distance; the rating orders them.
  const SEARCH_ORDER = ["Quiet Nineties", "Last Stand", "Speed Chase", "Dilli Express"];
  // With the Action genre as a filter, only these are candidates.
  const ACTION_ORDER = ["Last Stand", "Speed Chase", "Dilli Express"];

  it("returns the model's order with its reasons", async () => {
    await start();
    modelSays({ searchText: "fast action movie" });
    await modelPicks(
      ["Speed Chase", "A bus that cannot slow down."],
      ["Dilli Express", "  Non-stop   chases\nacross Delhi. "],
    );
    const body = await recommend("something fast", 2);

    expect(body.pick).toBe("ok");
    expect(body.results.map(({ movie, why }) => [movie.title, why])).toEqual([
      ["Speed Chase", "A bus that cannot slow down."],
      ["Dilli Express", "Non-stop chases across Delhi."],
    ]);
  });

  it("can pick a movie that the search ranked below the first `limit`", async () => {
    await start();
    modelSays({ searchText: "fast action movie" });
    await modelPicks(["Dilli Express", "Fast."]);
    expect((await recommend("something fast", 1)).titles).toEqual(["Dilli Express"]);
  });

  it("shows the model compact candidate lines and the request between tags", async () => {
    await start();
    modelSays({ tags: ["twist ending"], searchText: "tense thriller" });
    await modelPicks(["Twisty Thriller", "Tense."]);
    await recommend("Tense <b>thriller</b>", 4);

    const input = callsOf("pick")[0]!;
    expect(input).toMatchObject({ promptVersion: "pick-v1", model: "fake-pick", thinkingLevel: "low" });
    expect(input.system).toContain("Pick the 4 movies");
    expect(input.system).toContain("Never reveal plot twists");
    // Angle brackets are removed, so the request cannot close its own tag.
    expect(input.prompt).toContain("<request>tense  b thriller /b </request>");
    expect(input.prompt).toContain(
      `${await idOf("Twisty Thriller")} | Twisty Thriller | 2000 | Thriller | plot twist | A quiet story about ordinary people.`,
    );
    const lines = input.prompt.split("<candidates>\n")[1]!.split("\n</candidates>")[0]!.split("\n");
    expect(lines.length).toBeGreaterThan(4); // more candidates than will be shown
    expect(lines.length).toBeLessThanOrEqual(30);
  });

  it("drops ids that are not candidates, and fills up in search order without a reason", async () => {
    await start();
    modelSays({ genres: ["Action"], searchText: "fast action movie" });
    backend.respondWith({
      picks: [
        { id: 999_999, why: "A film that does not exist." },
        { id: await idOf("Speed Chase"), why: "Fast." },
        { id: await idOf("Speed Chase"), why: "Fast, again." },
        // In the catalog, but not a candidate of this request.
        { id: await idOf("Inception"), why: "Famous." },
        { id: "7", why: "Not a number." },
      ],
    });
    const body = await recommend("something fast", 3);

    expect(body.pick).toBe("ok");
    expect(body.results.map(({ movie, why }) => [movie.title, why])).toEqual([
      ["Speed Chase", "Fast."],
      ["Last Stand", undefined],
      ["Dilli Express", undefined],
    ]);
  });

  it("keeps the search order, without reasons, when the pick call times out", async () => {
    await start();
    modelSays({ searchText: "fast action movie" });
    backend.respondWithFailure({ type: "timeout" });
    const body = await recommend("something fast", 4);

    expect(body.pick).toBe("fallback");
    expect(body.titles).toEqual(SEARCH_ORDER);
    expect(body.results.every((result) => result.why === undefined)).toBe(true);
    const { rows } = await pool.query("SELECT status FROM llm_calls WHERE stage = 'pick'");
    expect(rows).toEqual([{ status: "timeout" }]);
  });

  it("does the same when the reply is unusable, and asks again next time", async () => {
    await start();
    modelSays({ genres: ["Action"], searchText: "fast action movie" });
    backend.respondWith({ picks: "none" });
    expect(await recommend("something fast", 3)).toMatchObject({ pick: "fallback", titles: ACTION_ORDER });

    // Parse and embedding are cached by now; only the pick is asked for again.
    backend.respondWith({ picks: [{ id: 999_999, why: "Made up." }] });
    expect(await recommend("something fast", 3)).toMatchObject({ pick: "fallback", titles: ACTION_ORDER });

    await modelPicks(["Dilli Express", "Fast."]);
    const third = await recommend("something fast", 3);
    expect(third.pick).toBe("ok");
    expect(third.titles).toEqual(["Dilli Express", "Last Stand", "Speed Chase"]);
    expect(callsOf("pick")).toHaveLength(3);
  });

  it("skips the pick when there is no LLM or nothing to choose from", async () => {
    await start({ llm: null });
    expect((await recommend("fast action movie")).pick).toBe("skipped");
    await app!.close();

    await seed({ embeddings: false });
    await start();
    modelSays({ searchText: "xylophone" });
    const body = await recommend("xylophone");
    expect(body.results).toEqual([]);
    expect(body.pick).toBe("skipped");
    expect(callsOf("pick")).toHaveLength(0);
  });
});

describe("POST /api/recommend/stream", () => {
  type StreamEvent = { event: string; data: unknown };

  const parseEvents = (text: string): StreamEvent[] =>
    text
      .split("\n\n")
      .filter((block) => block !== "")
      .map((block) => ({
        event: /^event: (.*)$/m.exec(block)![1]!,
        data: JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as unknown,
      }));

  const open = (body: unknown, signal?: AbortSignal) =>
    fetch(`${app!.url}/api/recommend/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

  async function stream(body: unknown) {
    const response = await open(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseEvents(await response.text());
    return { events, names: events.map((event) => event.event) };
  }

  const titlesOf = (results: { movie: { title: string } }[]) => results.map((result) => result.movie.title);

  it("sends the search results, then the picks, then done", async () => {
    await start();
    modelSays({ genres: ["Action"], searchText: "fast action movie" });
    await modelPicks(["Dilli Express", "Fast."], ["Speed Chase", "Faster."]);
    const { events, names } = await stream({ query: "something fast", limit: 2 });

    expect(names).toEqual(["results", "picked", "done"]);
    const results = resultsEventSchema.parse(events[0]!.data);
    expect(titlesOf(results.results)).toEqual(["Last Stand", "Speed Chase"]);
    expect(results.picking).toBe(true);
    expect(results.results.every((result) => result.why === undefined)).toBe(true);

    const picked = pickedEventSchema.parse(events[1]!.data);
    expect(picked.results.map(({ movie, why }) => [movie.title, why])).toEqual([
      ["Dilli Express", "Fast."],
      ["Speed Chase", "Faster."],
    ]);

    const { meta } = doneEventSchema.parse(events[2]!.data);
    expect(meta.stages.map((stage) => [stage.name, stage.status])).toEqual([
      ["parse", "ok"],
      ["embed", "ok"],
      ["search", "ok"],
      ["pick", "ok"],
    ]);
    expect(meta.parsed?.genres).toEqual(["Action"]);
    const { rows } = await pool.query("SELECT DISTINCT request_id FROM llm_calls");
    expect(rows).toEqual([{ request_id: results.requestId }]);
  });

  it("sends the search results before the pick call has answered", async () => {
    await start({ pickTimeoutMs: 300 });
    modelSays({ searchText: "fast action movie" });
    backend.respondWithFailure({ type: "timeout" });
    const response = await open({ query: "something fast" });
    const reader = response.body!.getReader();

    const first = new TextDecoder().decode((await reader.read()).value);
    expect(parseEvents(first).map((event) => event.event)).toEqual(["results"]);
    // The pick call starts after the results were sent, and is still running.
    await expect.poll(() => backend.inFlight, { timeout: 2000 }).toBe(1);
    await reader.cancel();
  });

  it("sends no picks and no error when the pick step fails", async () => {
    await start();
    modelSays({ searchText: "fast action movie" });
    backend.respondWith({ nonsense: true });
    const { events, names } = await stream({ query: "something fast" });

    expect(names).toEqual(["results", "done"]);
    const { meta } = doneEventSchema.parse(events[1]!.data);
    expect(meta.stages.at(-1)).toMatchObject({ name: "pick", status: "fallback" });
  });

  it("says that no picks will follow when there is no LLM", async () => {
    await start({ llm: null });
    const { events, names } = await stream({ query: "heist" });

    expect(names).toEqual(["results", "done"]);
    expect(resultsEventSchema.parse(events[0]!.data).picking).toBe(false);
  });

  it("answers an invalid request with a normal 400, not a stream", async () => {
    await start();
    const response = await open({ query: "hi" });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe("validation_error");
  });

  it("sends an error event with a safe message when the database fails", async () => {
    const failing = () => Promise.reject(new Error("password authentication failed for user admin"));
    await start({ llm: null, pool: { query: failing, connect: failing } as unknown as pg.Pool });
    const response = await open({ query: "heist" });
    const text = await response.text();

    expect(parseEvents(text)).toEqual([
      { event: "error", data: { message: "Recommendations are not available right now." } },
    ]);
    expect(text).not.toContain("password");
  });

  it("stops the pick call and cleans up when the client disconnects", async () => {
    await start({ pickTimeoutMs: 30_000 });
    modelSays({ searchText: "fast action movie" });
    backend.respondWithFailure({ type: "timeout" }); // the pick call never answers
    const controller = new AbortController();
    const response = await open({ query: "something fast" }, controller.signal);
    const reader = response.body!.getReader();
    await reader.read(); // the results event
    await expect.poll(() => backend.inFlight, { timeout: 2000 }).toBe(1);

    controller.abort();

    // Long before the 30 second timeout, the call is stopped and logged.
    await expect.poll(() => backend.inFlight, { timeout: 2000 }).toBe(0);
    await expect
      .poll(async () => (await pool.query("SELECT status FROM llm_calls WHERE stage = 'pick'")).rows, {
        timeout: 2000,
      })
      .toEqual([{ status: "cancelled" }]);

    // The server is still healthy, and nothing half-done was cached.
    await modelPicks(["Dilli Express", "Fast."]);
    const { names } = await stream({ query: "something fast" });
    expect(names).toEqual(["results", "picked", "done"]);
    expect(callsOf("pick")).toHaveLength(2);
    // afterEach closes the server, which only finishes once every connection has closed.
  });

  it("stops the non-streaming request too", async () => {
    await start({ pickTimeoutMs: 30_000 });
    modelSays({ searchText: "fast action movie" });
    backend.respondWithFailure({ type: "timeout" });
    const controller = new AbortController();
    const pending = fetch(`${app!.url}/api/recommend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "something fast" }),
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await expect.poll(() => backend.inFlight, { timeout: 2000 }).toBe(1);

    controller.abort();
    await pending;
    await expect.poll(() => backend.inFlight, { timeout: 2000 }).toBe(0);
  });
});

describe("POST /api/recommend: token budget", () => {
  // A budget whose level the test sets directly.
  let level: "ok" | "soft" | "hard";
  const budget: TokenBudget = { ...unlimitedBudget, level: async () => level };

  beforeEach(() => {
    level = "ok";
  });

  it("skips the pick at the soft limit, but still understands the request", async () => {
    level = "soft";
    await start({ budget });
    modelSays({ genres: ["Action"], searchText: "fast action movie" });
    const body = await recommend("something fast", 3);

    expect(body.stages).toEqual({ parse: "ok", embed: "ok", search: "ok" });
    expect(body.pick).toBe("skipped");
    expect(body.meta.budget).toBe("soft");
    expect(body.titles).toEqual(["Last Stand", "Speed Chase", "Dilli Express"]);
    expect(callsOf("pick")).toHaveLength(0);
  });

  it("makes no LLM call at the hard limit, and searches by keywords", async () => {
    level = "hard";
    await start({ budget });
    const body = await recommend("heist");

    expect(body.stages).toEqual({ parse: "skipped", embed: "skipped", search: "ok" });
    expect(body.pick).toBe("skipped");
    expect(body.meta.budget).toBe("hard");
    expect(body.titles.sort()).toEqual(["Heist Night", "Unseen Job"]);
    expect(backend.calls).toHaveLength(0);
  });

  it("still uses what is cached when over budget", async () => {
    await start({ budget });
    modelSays({ searchText: "fast action movie" });
    await modelPicks(["Dilli Express", "Fast."]);
    const first = await recommend("something fast", 2);
    expect(first.meta.budget).toBeUndefined();

    level = "hard";
    const second = await recommend("something fast", 2);
    expect(second.stages).toEqual({ parse: "ok", embed: "ok", search: "ok" });
    expect(second.pick).toBe("ok");
    expect(second.results).toEqual(first.results);
    expect(second.meta).toMatchObject({ cached: true, budget: "hard" });
    expect(backend.calls).toHaveLength(3); // all from the first request
  });

  it("tells a streaming client about the budget in the last event", async () => {
    level = "soft";
    await start({ budget });
    modelSays({ searchText: "fast action movie" });
    const response = await fetch(`${app!.url}/api/recommend/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "something fast" }),
    });
    const text = await response.text();
    expect(text).not.toContain("event: picked");
    const done = JSON.parse(/event: done\ndata: (.*)/.exec(text)![1]!) as unknown;
    expect(doneEventSchema.parse(done).meta.budget).toBe("soft");
  });
});

describe("recommend with steps left out (the evaluation's modes)", () => {
  const deps = (): RecommendDeps => ({
    pool,
    llm,
    embeddingCache: noCache,
    parseCache: noCache,
    pickCache: noCache,
    budget: unlimitedBudget,
    vector: {
      model: MODEL,
      candidates: 30,
      weights: testAppConfig.recommend.weights,
      posterBaseUrl: testAppConfig.search.posterBaseUrl,
    },
    search: testAppConfig.search,
    parse: testAppConfig.recommend.parse,
    pick: testAppConfig.recommend.pick,
    embedTimeoutMs: 500,
    reference: testAppConfig.recommend.reference,
    logger: silentLogger,
  });
  const noCache = { get: async () => null, set: async () => {} };
  const statuses = (response: RecommendResponse) =>
    Object.fromEntries(response.meta.stages.map((stage) => [stage.name, stage.status]));

  it("fulltext: no LLM call at all, keyword search on the words as typed", async () => {
    const response = await runPipeline(deps(), { query: "heist", limit: 8 }, { skip: ["parse", "embed", "pick"] });
    expect(statuses(response)).toEqual({ parse: "skipped", embed: "skipped", search: "ok", pick: "skipped" });
    expect(response.results.map((result) => result.movie.title).sort()).toEqual(["Heist Night", "Unseen Job"]);
    expect(backend.calls).toHaveLength(0);
  });

  it("semantic: embeds the words as typed, without parse or pick", async () => {
    const response = await runPipeline(
      deps(),
      { query: "a prison escape", limit: 3 },
      { skip: ["parse", "pick"], requestId: "eval-semantic-1" },
    );
    expect(statuses(response)).toEqual({ parse: "skipped", embed: "ok", search: "ok", pick: "skipped" });
    expect(response.results[0]!.movie.title).toBe("Cool Hand Luke");
    expect(response.requestId).toBe("eval-semantic-1");
    expect(backend.calls.map((call) => call.method)).toEqual(["embed"]);
  });

  it("parsed: parse and embed, but no pick", async () => {
    modelSays({ genres: ["Action"], searchText: "fast action movie" });
    const response = await runPipeline(deps(), { query: "something fast", limit: 3 }, { skip: ["pick"] });
    expect(statuses(response)).toEqual({ parse: "ok", embed: "ok", search: "ok", pick: "skipped" });
    expect(callsOf("pick")).toHaveLength(0);
  });

  it("looks up the facts the checks need, with curated tag names", async () => {
    const ids = await Promise.all([idOf("Twisty Thriller"), idOf("Dilli Express")]);
    const found = await loadFacts(pool, ids);
    expect(found.get(ids[0]!)).toMatchObject({
      tmdbId: 12,
      title: "Twisty Thriller",
      year: 2000,
      genres: ["Thriller"],
      rating: 7,
      // The stored genome tag is "plot twist"; the curated tag is "twist ending".
      tags: ["twist ending"],
    });
    expect(found.get(ids[1]!)).toMatchObject({ tmdbId: 15, language: "hi", tags: [] });
    expect(await loadFacts(pool, [])).toEqual(new Map());
  });

  it("adds up the tokens of a request's LLM calls", async () => {
    modelSays({ searchText: "fast action movie" });
    await runPipeline(deps(), { query: "something fast", limit: 3 }, { skip: ["pick"], requestId: "eval-tokens-1" });
    // The fake reports 100 in and 20 out for the parse, and one token per embedded word.
    expect(await loadTokens(pool, "eval-tokens-1")).toEqual({ calls: 2, input: 103, output: 20 });
    expect(await loadTokens(pool, "no-such-request")).toEqual({ calls: 0, input: 0, output: 0 });
  });
});
