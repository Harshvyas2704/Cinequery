import {
  errorResponseSchema,
  genresResponseSchema,
  movieDetailSchema,
  searchResponseSchema,
  tagsResponseSchema,
} from "@cinequery/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrator.js";
import { createPool } from "../src/db/pool.js";
import { ingest } from "../src/ingest/load.js";
import type { Movie, MovieTag } from "../src/ingest/transform.js";
import { loadTestConfig, silentLogger, startApp } from "./helpers.js";

// A small catalog where the right answer to each query is obvious.
function movie(tmdbId: number, title: string, overrides: Partial<Movie>): Movie {
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
    popularity: 10,
    poster_path: `/p${tmdbId}.jpg`,
    imdb_id: null,
    ...overrides,
  };
}

const MOVIES: Movie[] = [
  movie(1, "The Heist", {
    overview: "A crew plans one last job.",
    genres: ["Crime", "Thriller"],
    release_year: 2001,
    vote_average: 7.5,
    vote_count: 5000,
  }),
  movie(2, "Vault", {
    overview: "Thieves plan a daring heist on a casino vault.",
    keywords: ["heist", "casino"],
    genres: ["Crime", "Action"],
    release_year: 2015,
    vote_average: 6.5,
    vote_count: 800,
  }),
  movie(3, "Night Shift", {
    overview: "A security guard stumbles on a heist during a long night.",
    genres: ["Thriller"],
    release_year: 1995,
    vote_average: 6.0,
    vote_count: 300,
  }),
  movie(4, "Paper Moonlight", {
    overview: "Two strangers fall in love over one summer.",
    genres: ["Romance", "Drama"],
    release_year: 1999,
    vote_average: 8.4,
    vote_count: 20000,
  }),
  movie(5, "Tiny Gem", {
    overview: "A festival favourite almost nobody has seen.",
    genres: ["Drama"],
    release_year: 2019,
    vote_average: 9.5,
    vote_count: 60,
  }),
  movie(6, "Dil Ki Baat", {
    overview: "A family comedy about a wedding that goes wrong.",
    genres: ["Comedy", "Family"],
    release_year: 2010,
    language: "hi",
    vote_average: 7.2,
    vote_count: 400,
    poster_path: null,
  }),
  movie(7, "The Last Reveal", {
    overview: "A detective reopens a case everyone thought was closed.",
    genres: ["Mystery", "Thriller"],
    release_year: 2012,
    vote_average: 7.8,
    vote_count: 9000,
  }),
  movie(8, "Mirror Room", {
    overview: "Nothing in the house is what it seems.",
    genres: ["Mystery", "Horror"],
    release_year: 2006,
    vote_average: 6.9,
    vote_count: 1200,
  }),
];

const TAGS: Record<number, MovieTag[]> = {
  1: [
    { tag: "heist", relevance: 0.95 },
    { tag: "imdb top 250", relevance: 0.9 },
  ],
  2: [{ tag: "caper", relevance: 0.7 }],
  7: [
    { tag: "plot twist", relevance: 0.97 },
    { tag: "twist ending", relevance: 0.8 },
    { tag: "dark", relevance: 0.6 },
  ],
  8: [
    { tag: "twist ending", relevance: 0.6 },
    { tag: "dark", relevance: 0.9 },
  ],
};

let pool: pg.Pool;
let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  pool = createPool(loadTestConfig().testDatabaseUrl, silentLogger);
  await runMigrations(pool);
  await pool.query("TRUNCATE movies, movie_tags, rating_stats RESTART IDENTITY CASCADE");
  await ingest(pool, {
    movies: MOVIES,
    tagsByTmdbId: new Map(Object.entries(TAGS).map(([id, tags]) => [Number(id), tags])),
    batchSize: 500,
    minVotesPercentile: 0.5,
  });
  app = await startApp({ pool, redis: { ping: async () => "PONG" } });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

async function search(params: Record<string, string> = {}) {
  const response = await fetch(`${app.url}/api/movies/search?${new URLSearchParams(params)}`);
  expect(response.status).toBe(200);
  const body = searchResponseSchema.parse(await response.json());
  return { ...body, titles: body.results.map((result) => result.movie.title) };
}

async function searchError(params: Record<string, string>) {
  const response = await fetch(`${app.url}/api/movies/search?${new URLSearchParams(params)}`);
  const body = errorResponseSchema.parse(await response.json());
  return { status: response.status, ...body.error };
}

describe("GET /api/movies/search: ranking", () => {
  it("ranks a title match above a keyword match above an overview match", async () => {
    const { titles, total, results } = await search({ q: "heist" });
    expect(titles).toEqual(["The Heist", "Vault", "Night Shift"]);
    expect(total).toBe(3);
    const scores = results.map((result) => result.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("matches any of the words and ranks movies with more of them higher", async () => {
    const { titles } = await search({ q: "casino heist wedding" });
    expect(titles[0]).toBe("Vault");
    expect(titles).toContain("Dil Ki Baat");
    expect(titles).not.toContain("Paper Moonlight");
  });

  it("uses word stems, so 'thieves planning' finds 'Thieves plan'", async () => {
    expect((await search({ q: "thief planning" })).titles).toContain("Vault");
  });

  it("without text, orders by weighted rating: many good votes beat a few perfect ones", async () => {
    const { titles, total } = await search();
    expect(total).toBe(8);
    expect(titles[0]).toBe("Paper Moonlight");
    expect(titles.indexOf("Tiny Gem")).toBeGreaterThan(titles.indexOf("The Last Reveal"));
  });

  it("treats a query of only stop words as no text", async () => {
    expect((await search({ q: "the of and" })).total).toBe(8);
  });

  it("is not confused by query syntax characters", async () => {
    expect((await search({ q: "heist & | ! ( ' :*" })).titles).toEqual([
      "The Heist",
      "Vault",
      "Night Shift",
    ]);
    expect((await search({ q: "'; DROP TABLE movies; --" })).total).toBe(0);
    expect((await search()).total).toBe(8);
  });

  it("returns nothing for a word no movie has", async () => {
    expect(await search({ q: "xylophone" })).toMatchObject({ results: [], total: 0 });
  });
});

describe("GET /api/movies/search: filters", () => {
  it("genres: a movie must have every genre listed", async () => {
    expect((await search({ genres: "Thriller" })).titles.sort()).toEqual([
      "Night Shift",
      "The Heist",
      "The Last Reveal",
    ]);
    expect((await search({ genres: "Crime,Thriller" })).titles).toEqual(["The Heist"]);
  });

  it("yearFrom and yearTo are inclusive", async () => {
    expect((await search({ yearFrom: "2012" })).titles.sort()).toEqual([
      "The Last Reveal",
      "Tiny Gem",
      "Vault",
    ]);
    expect((await search({ yearTo: "1999" })).titles.sort()).toEqual([
      "Night Shift",
      "Paper Moonlight",
    ]);
    expect((await search({ yearFrom: "1999", yearTo: "2001" })).total).toBe(2);
  });

  it("language", async () => {
    expect((await search({ language: "hi" })).titles).toEqual(["Dil Ki Baat"]);
  });

  it("minRating uses the plain average rating", async () => {
    expect((await search({ minRating: "7.8" })).titles.sort()).toEqual([
      "Paper Moonlight",
      "The Last Reveal",
      "Tiny Gem",
    ]);
  });

  it("tags: keeps movies with the tag and ranks the more relevant one first", async () => {
    const { titles, results } = await search({ tags: "twist ending" });
    expect(titles).toEqual(["The Last Reveal", "Mirror Room"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("tags: any genome tag behind a curated tag counts", async () => {
    expect((await search({ tags: "heist" })).titles).toEqual(["The Heist", "Vault"]);
  });

  it("tags: a movie must have every tag listed", async () => {
    expect((await search({ tags: "twist ending,dark" })).titles.sort()).toEqual([
      "Mirror Room",
      "The Last Reveal",
    ]);
    expect((await search({ tags: "twist ending,heist" })).total).toBe(0);
  });

  it("combines text with filters", async () => {
    expect((await search({ q: "heist", genres: "Thriller", yearFrom: "2000" })).titles).toEqual([
      "The Heist",
    ]);
  });
});

describe("GET /api/movies/search: pagination", () => {
  it("pages through results without gaps or repeats", async () => {
    const all = await search({ limit: "50" });
    const first = await search({ limit: "3" });
    const second = await search({ limit: "3", offset: "3" });
    const third = await search({ limit: "3", offset: "6" });
    expect(first).toMatchObject({ total: 8, limit: 3, offset: 0 });
    expect([...first.titles, ...second.titles, ...third.titles]).toEqual(all.titles);
    expect(third.titles).toHaveLength(2);
  });

  it("still reports the total for a page past the end", async () => {
    expect(await search({ q: "heist", offset: "10" })).toMatchObject({ results: [], total: 3 });
  });
});

describe("GET /api/movies/search: response and validation", () => {
  it("returns movie summaries with a poster URL", async () => {
    const { results } = await search({ q: "casino" });
    expect(results[0]!.movie).toEqual({
      id: expect.any(Number),
      title: "Vault",
      overview: "Thieves plan a daring heist on a casino vault.",
      releaseYear: 2015,
      runtimeMinutes: 100,
      genres: ["Crime", "Action"],
      language: "en",
      voteAverage: 6.5,
      voteCount: 800,
      posterUrl: "https://img.test/w342/p2.jpg",
    });
    expect((await search({ language: "hi" })).results[0]!.movie.posterUrl).toBeNull();
  });

  it("answers bad input with 400 and a message for each field", async () => {
    const error = await searchError({ limit: "500", genres: "Heist", yearFrom: "soon" });
    expect(error.status).toBe(400);
    expect(error.code).toBe("validation_error");
    expect(error.details).toEqual(
      expect.arrayContaining([
        { field: "limit", message: "limit must be a whole number from 1 to 50" },
        { field: "genres", message: "Unknown genre: Heist" },
        { field: "yearFrom", message: "yearFrom must be a year" },
      ]),
    );
    expect(error.details).toHaveLength(3);
  });

  it("rejects an unknown tag", async () => {
    const error = await searchError({ tags: "explosions" });
    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ field: "tags", message: "Unknown tag: explosions" }]);
  });
});

describe("GET /api/movies/:id", () => {
  it("returns the movie with its curated tags, best first", async () => {
    const { results } = await search({ q: "reveal" });
    const response = await fetch(`${app.url}/api/movies/${results[0]!.movie.id}`);
    expect(response.status).toBe(200);
    const movie = movieDetailSchema.parse(await response.json());
    expect(movie).toMatchObject({ title: "The Last Reveal", tmdbId: 7, keywords: [] });
    // "plot twist" 0.97 and "twist ending" 0.8 are one curated tag; genome-only tags are left out.
    expect(movie.tags).toEqual([
      { tag: "twist ending", relevance: 0.97 },
      { tag: "dark", relevance: 0.6 },
    ]);
  });

  it("returns 404 in the error shape for an unknown id", async () => {
    const response = await fetch(`${app.url}/api/movies/999999`);
    expect(response.status).toBe(404);
    expect(errorResponseSchema.parse(await response.json()).error).toEqual({
      code: "not_found",
      message: "No movie with id 999999",
      requestId: response.headers.get("x-request-id"),
    });
  });

  it("returns 400 for an id that is not a number", async () => {
    for (const id of ["abc", "0", "-3", "1.5", "99999999999"]) {
      const response = await fetch(`${app.url}/api/movies/${id}`);
      expect(response.status).toBe(400);
      expect(errorResponseSchema.parse(await response.json()).error.details).toEqual([
        { field: "id", message: "id must be a positive whole number" },
      ]);
    }
  });
});

describe("GET /api/genres and /api/tags", () => {
  it("lists the genres", async () => {
    const body = genresResponseSchema.parse(await (await fetch(`${app.url}/api/genres`)).json());
    expect(body.genres).toHaveLength(19);
    expect(body.genres).toContain("Science Fiction");
  });

  it("lists the curated tags with their group, without the genome mapping", async () => {
    const raw = (await (await fetch(`${app.url}/api/tags`)).json()) as { tags: object[] };
    const body = tagsResponseSchema.parse(raw);
    expect(body.tags).toContainEqual({ tag: "twist ending", group: "plot" });
    expect(body.tags).toContainEqual({ tag: "feel-good", group: "mood" });
    expect(Object.keys(raw.tags[0]!)).toEqual(["tag", "group"]);
  });
});
