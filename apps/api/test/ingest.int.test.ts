import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrator.js";
import { createPool } from "../src/db/pool.js";
import { ingest, type IngestInput } from "../src/ingest/load.js";
import type { Movie, MovieTag } from "../src/ingest/transform.js";
import { loadTestConfig, silentLogger } from "./helpers.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = createPool(loadTestConfig().testDatabaseUrl, silentLogger);
  await runMigrations(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE movies, movie_tags, rating_stats RESTART IDENTITY CASCADE");
});
afterAll(() => pool.end());

function movie(tmdbId: number, overrides: Partial<Movie> = {}): Movie {
  return {
    tmdb_id: tmdbId,
    title: `Movie ${tmdbId}`,
    overview: `Overview of movie ${tmdbId}.`,
    tagline: null,
    genres: ["Drama"],
    keywords: ["friendship"],
    release_year: 2000 + tmdbId,
    runtime_minutes: 100,
    language: "en",
    vote_average: 7.123,
    vote_count: tmdbId * 100,
    popularity: 12.3456,
    poster_path: `/poster-${tmdbId}.jpg`,
    imdb_id: `tt000000${tmdbId}`,
    ...overrides,
  };
}

function run(movies: Movie[], tags: Record<number, MovieTag[]> = {}, options = {}) {
  const input: IngestInput = {
    movies,
    tagsByTmdbId: new Map(Object.entries(tags).map(([id, list]) => [Number(id), list])),
    batchSize: 500,
    minVotesPercentile: 0.5,
    ...options,
  };
  return ingest(pool, input);
}

async function tagsOf(tmdbId: number) {
  const { rows } = await pool.query<{ tag: string; relevance: number; source: string }>(
    `SELECT tag, relevance, source FROM movie_tags
     JOIN movies ON movies.id = movie_tags.movie_id
     WHERE tmdb_id = $1 ORDER BY tag`,
    [tmdbId],
  );
  return rows;
}

describe("ingest: movies", () => {
  it("inserts movies with arrays, and fills the search column", async () => {
    const summary = await run([
      movie(1, { title: "The Heist", genres: ["Crime", "Thriller"], keywords: ["bank robbery"] }),
    ]);
    expect(summary).toMatchObject({ inserted: 1, updated: 0, unchanged: 0 });

    const { rows } = await pool.query(
      `SELECT title, genres, keywords, vote_average::float8 AS vote_average,
              search_tsv @@ to_tsquery('english', 'robbery') AS found_by_keyword
       FROM movies WHERE tmdb_id = 1`,
    );
    expect(rows).toEqual([
      {
        title: "The Heist",
        genres: ["Crime", "Thriller"],
        keywords: ["bank robbery"],
        vote_average: 7.12,
        found_by_keyword: true,
      },
    ]);
  });

  it("changes nothing on a second run with the same data", async () => {
    const movies = [movie(1), movie(2), movie(3)];
    const tags = { 1: [{ tag: "heist", relevance: 0.9735000133514404 }] };
    await run(movies, tags);
    const before = await pool.query("SELECT id, tmdb_id, updated_at FROM movies ORDER BY id");

    const second = await run(movies, tags);
    expect(second).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 3,
      tags: 1,
      tagsWritten: 0,
      tagsRemoved: 0,
    });
    const after = await pool.query("SELECT id, tmdb_id, updated_at FROM movies ORDER BY id");
    expect(after.rows).toEqual(before.rows);
  });

  it("updates a movie whose overview changed, and only that one", async () => {
    await run([movie(1), movie(2)]);
    const before = await pool.query("SELECT id, updated_at FROM movies WHERE tmdb_id = 1");

    const summary = await run([movie(1, { overview: "A new overview." }), movie(2)]);
    expect(summary).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });

    const after = await pool.query("SELECT id, overview, updated_at FROM movies WHERE tmdb_id = 1");
    expect(after.rows[0].overview).toBe("A new overview.");
    expect(after.rows[0].id).toBe(before.rows[0].id);
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());
  });

  it("stores nulls and empty arrays", async () => {
    await run([
      movie(1, { tagline: null, release_year: null, runtime_minutes: null, keywords: [], genres: [] }),
    ]);
    const { rows } = await pool.query(
      "SELECT tagline, release_year, runtime_minutes, keywords, genres FROM movies",
    );
    expect(rows).toEqual([
      { tagline: null, release_year: null, runtime_minutes: null, keywords: [], genres: [] },
    ]);
  });

  it("removes NUL characters, which Postgres text cannot store", async () => {
    await run([movie(1, { overview: "Before\u0000after" })]);
    const { rows } = await pool.query("SELECT overview FROM movies");
    expect(rows[0].overview).toBe("Beforeafter");
  });

  it("loads every movie when there are more movies than one batch", async () => {
    const movies = [1, 2, 3, 4, 5].map((id) => movie(id));
    const tags = { 1: [{ tag: "dark", relevance: 0.7 }], 5: [{ tag: "funny", relevance: 0.8 }] };
    const summary = await run(movies, tags, { batchSize: 2 });
    expect(summary).toMatchObject({ inserted: 5, tags: 2, tagsWritten: 2 });
    const { rows } = await pool.query("SELECT count(*)::int AS movies FROM movies");
    expect(rows[0].movies).toBe(5);
  });
});

describe("ingest: tags", () => {
  it("replaces a movie's tags instead of adding to them", async () => {
    await run([movie(1)], {
      1: [
        { tag: "heist", relevance: 0.9 },
        { tag: "dark", relevance: 0.6 },
      ],
    });

    const summary = await run([movie(1)], {
      1: [
        { tag: "heist", relevance: 0.75 },
        { tag: "twist ending", relevance: 0.8 },
      ],
    });
    expect(summary).toMatchObject({ tags: 2, tagsWritten: 2, tagsRemoved: 1 });
    expect(await tagsOf(1)).toEqual([
      { tag: "heist", relevance: 0.75, source: "genome" },
      { tag: "twist ending", relevance: 0.8, source: "genome" },
    ]);
  });

  it("does not duplicate tags when run twice", async () => {
    const tags = { 1: [{ tag: "heist", relevance: 0.9 }], 2: [{ tag: "heist", relevance: 0.5 }] };
    await run([movie(1), movie(2)], tags);
    await run([movie(1), movie(2)], tags);
    const { rows } = await pool.query("SELECT count(*)::int AS tags FROM movie_tags");
    expect(rows[0].tags).toBe(2);
  });

  it("removes the genome tags of a movie that no longer has any", async () => {
    await run([movie(1)], { 1: [{ tag: "heist", relevance: 0.9 }] });
    const summary = await run([movie(1)]);
    expect(summary).toMatchObject({ tags: 0, tagsRemoved: 1 });
    expect(await tagsOf(1)).toEqual([]);
  });

  it("keeps tags from another source", async () => {
    await run([movie(1)], { 1: [{ tag: "heist", relevance: 0.9 }] });
    await pool.query(
      `INSERT INTO movie_tags (movie_id, tag, relevance, source)
       SELECT id, 'feel-good', 0.7, 'llm' FROM movies WHERE tmdb_id = 1`,
    );
    await run([movie(1)], { 1: [{ tag: "dark", relevance: 0.6 }] });
    expect(await tagsOf(1)).toEqual([
      { tag: "dark", relevance: 0.6, source: "genome" },
      { tag: "feel-good", relevance: 0.7, source: "llm" },
    ]);
  });

  it("skips and counts tags whose movie is not in the movies file", async () => {
    const summary = await run([movie(1)], {
      1: [{ tag: "heist", relevance: 0.9 }],
      99: [
        { tag: "dark", relevance: 0.6 },
        { tag: "funny", relevance: 0.7 },
      ],
    });
    expect(summary).toMatchObject({ tags: 1, tagsWritten: 1, tagsSkipped: 2 });
    const { rows } = await pool.query("SELECT count(*)::int AS tags FROM movie_tags");
    expect(rows[0].tags).toBe(1);
  });
});

describe("ingest: rating stats", () => {
  it("stores the mean rating and the vote count percentile in a single row", async () => {
    const movies = [
      movie(1, { vote_average: 6, vote_count: 100 }),
      movie(2, { vote_average: 7, vote_count: 200 }),
      movie(3, { vote_average: 8, vote_count: 900 }),
    ];
    const first = await run(movies);
    expect(first.ratingStats).toEqual({ meanVoteAverage: 7, minVotes: 200 });

    const second = await run(movies, {}, { minVotesPercentile: 1 });
    expect(second.ratingStats).toEqual({ meanVoteAverage: 7, minVotes: 900 });

    const { rows } = await pool.query("SELECT count(*)::int AS stats FROM rating_stats");
    expect(rows[0].stats).toBe(1);
  });

  it("is not computed for an empty catalog", async () => {
    expect((await run([])).ratingStats).toBeNull();
  });
});
