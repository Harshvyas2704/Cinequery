import { describe, expect, it } from "vitest";
import { readMovies } from "../src/ingest/parquet.js";
import { groupTags, movieRowSchema, splitList, toMovie } from "../src/ingest/transform.js";

const row = {
  tmdb_id: 27205,
  title: "Inception",
  overview: "A thief who steals secrets through dreams.",
  tagline: "Your mind is the scene of the crime.",
  genres: "Action, Science Fiction, Adventure",
  keywords: "dream, heist",
  release_year: 2010,
  runtime_minutes: 148,
  language: "en",
  vote_average: 8.364,
  vote_count: 34495,
  popularity: 83.952,
  poster_path: "/poster.jpg",
  imdb_id: "tt1375666",
};

describe("splitList", () => {
  it("splits on commas and trims each value", () => {
    expect(splitList("Action, Science Fiction,Adventure ")).toEqual([
      "Action",
      "Science Fiction",
      "Adventure",
    ]);
  });

  it("drops empty values", () => {
    expect(splitList("Action, , ,Drama,")).toEqual(["Action", "Drama"]);
    expect(splitList(" , ")).toEqual([]);
  });

  it("returns an empty array for null, undefined and empty text", () => {
    expect(splitList(null)).toEqual([]);
    expect(splitList(undefined)).toEqual([]);
    expect(splitList("")).toEqual([]);
  });

  it("keeps the first of repeated values", () => {
    expect(splitList("heist, dream, heist")).toEqual(["heist", "dream"]);
  });
});

describe("toMovie", () => {
  it("turns genres and keywords into arrays and keeps the rest", () => {
    expect(toMovie(row)).toEqual({
      ...row,
      genres: ["Action", "Science Fiction", "Adventure"],
      keywords: ["dream", "heist"],
    });
  });

  it("gives a movie without keywords an empty array", () => {
    expect(toMovie({ ...row, keywords: null, genres: "" })).toMatchObject({
      genres: [],
      keywords: [],
    });
  });
});

describe("movieRowSchema", () => {
  it("accepts nulls in the nullable columns", () => {
    const sparse = { ...row, tagline: null, release_year: null, runtime_minutes: null };
    expect(movieRowSchema.safeParse(sparse).success).toBe(true);
  });

  it("rejects a row without an overview", () => {
    expect(movieRowSchema.safeParse({ ...row, overview: "" }).success).toBe(false);
    expect(movieRowSchema.safeParse({ ...row, overview: undefined }).success).toBe(false);
  });
});

describe("groupTags", () => {
  it("groups tags by movie", () => {
    const grouped = groupTags([
      { tmdb_id: 1, tag: "heist", relevance: 0.8 },
      { tmdb_id: 2, tag: "dark", relevance: 0.6 },
      { tmdb_id: 1, tag: "twist ending", relevance: 0.9 },
    ]);
    expect(grouped.get(1)).toEqual([
      { tag: "heist", relevance: 0.8 },
      { tag: "twist ending", relevance: 0.9 },
    ]);
    expect(grouped.get(2)).toEqual([{ tag: "dark", relevance: 0.6 }]);
  });

  it("keeps the highest relevance when a tag is listed twice for a movie", () => {
    const grouped = groupTags([
      { tmdb_id: 1, tag: "heist", relevance: 0.6 },
      { tmdb_id: 1, tag: "heist", relevance: 0.9 },
    ]);
    expect(grouped.get(1)).toEqual([{ tag: "heist", relevance: 0.9 }]);
  });
});

describe("readMovies", () => {
  it("says how to create the file when it is missing", async () => {
    await expect(readMovies("/nonexistent/movies.parquet")).rejects.toThrow(
      "scripts/prepare-data.sql",
    );
  });
});
