import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RecommendResponse } from "@cinequery/shared";
import { describe, expect, it } from "vitest";
import {
  brokenConstraints,
  hasConstraints,
  type MovieFacts,
  percentile,
  spoilerWordsIn,
} from "../src/eval/checks.js";
import { runEval, SKIPPED_STEPS, summarize } from "../src/eval/run.js";
import { type EvalFile, evalFileSchema, type EvalQuery } from "../src/eval/schema.js";

const facts = (overrides: Partial<MovieFacts> = {}): MovieFacts => ({
  tmdbId: 1,
  title: "A Movie",
  year: 2010,
  runtime: 100,
  language: "en",
  rating: 7.5,
  genres: ["Action", "Thriller"],
  tags: ["twist ending"],
  ...overrides,
});

describe("brokenConstraints", () => {
  it("passes a movie that meets every constraint", () => {
    const checks = {
      genresInclude: ["Action" as const],
      genresAny: ["Comedy" as const, "Thriller" as const],
      genresExclude: ["Horror" as const],
      minYear: 2005,
      maxYear: 2015,
      maxRuntime: 120,
      language: "en",
      minRating: 7,
      noneOfMovies: [{ tmdbId: 2, title: "Another" }],
    };
    expect(brokenConstraints(facts(), checks)).toEqual([]);
  });

  it("names each constraint a movie breaks", () => {
    const movie = facts({ year: 1999, genres: ["Horror"], runtime: 130, language: "hi", rating: 5 });
    expect(
      brokenConstraints(movie, {
        genresInclude: ["Action"],
        genresAny: ["Comedy", "Thriller"],
        genresExclude: ["Horror"],
        minYear: 2005,
        maxRuntime: 120,
        language: "en",
        minRating: 7,
        noneOfMovies: [{ tmdbId: 1, title: "A Movie" }],
      }),
    ).toEqual(["genresInclude", "genresAny", "genresExclude", "minYear", "maxRuntime", "language", "minRating", "noneOfMovies"]);
    expect(brokenConstraints(facts({ year: 2020 }), { maxYear: 2015 })).toEqual(["maxYear"]);
  });

  it("needs every genre of genresInclude but only one of genresAny", () => {
    expect(brokenConstraints(facts(), { genresInclude: ["Action", "Comedy"] })).toEqual(["genresInclude"]);
    expect(brokenConstraints(facts(), { genresAny: ["Action", "Comedy"] })).toEqual([]);
  });

  it("fails a constraint on a fact the database does not have", () => {
    const unknown = facts({ year: null, runtime: null, rating: null });
    expect(brokenConstraints(unknown, { minYear: 1990, maxRuntime: 90, minRating: 6 })).toEqual([
      "minYear",
      "maxRuntime",
      "minRating",
    ]);
  });

  it("knows whether a query has constraints at all", () => {
    expect(hasConstraints({ tagsAny: ["heist"], anyOfMovies: [] })).toBe(false);
    expect(hasConstraints({ minRating: 7 })).toBe(true);
  });
});

describe("spoilerWordsIn and percentile", () => {
  it("finds phrases whatever their case", () => {
    expect(spoilerWordsIn("It Turns Out he was dead all along.", ["turns out", "was dead", "the killer is"])).toEqual([
      "turns out",
      "was dead",
    ]);
    expect(spoilerWordsIn("A tense thriller with a surprise.", ["turns out"])).toEqual([]);
  });

  it("gives the value below which a share of the values lie", () => {
    const values = [50, 10, 40, 20, 30];
    expect(percentile(values, 0.5)).toBe(30);
    expect(percentile(values, 0.95)).toBe(50);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("runEval", () => {
  const movie = (id: number) => ({
    id,
    title: `Movie ${id}`,
    overview: "",
    releaseYear: 2000,
    runtimeMinutes: 100,
    genres: [],
    language: "en",
    voteAverage: 7,
    voteCount: 100,
    posterUrl: null,
  });
  const response = (
    results: { id: number; why?: string }[],
    stages: RecommendResponse["meta"]["stages"] = [],
  ): RecommendResponse => ({
    requestId: "r",
    results: results.map(({ id, why }) => ({ movie: movie(id), score: 1, ...(why ? { why } : {}) })),
    meta: { stages, cached: false },
  });

  // Internal ids 1 to 4 are TMDB ids 101 to 104.
  const CATALOG = new Map<number, MovieFacts>([
    [1, facts({ tmdbId: 101, title: "Old Action", year: 1990, genres: ["Action"], tags: [] })],
    [2, facts({ tmdbId: 102, title: "New Action", year: 2015, genres: ["Action"], tags: ["twist ending"] })],
    [3, facts({ tmdbId: 103, title: "New Drama", year: 2018, genres: ["Drama"], tags: [] })],
    [4, facts({ tmdbId: 104, title: "Newer Action", year: 2020, genres: ["Action"], tags: [] })],
  ]);

  const query = (id: string, checks: EvalQuery["checks"]): EvalQuery => ({ id, query: `query ${id}`, checks });
  const file: EvalFile = {
    limit: 4,
    noSpoilerWords: ["turns out"],
    queries: [
      query("constrained", {
        genresInclude: ["Action"],
        minYear: 2005,
        tagsAny: ["twist ending"],
        anyOfMovies: [{ tmdbId: 104, title: "Newer Action" }],
        noSpoilerWords: ["the butler"],
      }),
      query("missed", { anyOfMovies: [{ tmdbId: 999, title: "Not Returned" }] }),
      query("vague", {}),
      query("empty", { minYear: 2000, tagsAny: ["heist"] }),
    ],
  };

  const answers: Record<string, RecommendResponse> = {
    constrained: response(
      [
        { id: 1 },
        { id: 2, why: "It turns out the butler did it." },
        { id: 3, why: "A drama." },
        { id: 4 },
      ],
      [
        { name: "parse", ms: 5, status: "ok" },
        { name: "pick", ms: 9, status: "fallback" },
      ],
    ),
    missed: response([{ id: 1 }]),
    vague: response([{ id: 3 }]),
    empty: response([]),
  };

  async function run() {
    const asked: string[] = [];
    const sleeps: number[] = [];
    const outcome = await runEval(file, "run-1", {
      ask: async (asking, requestId) => {
        asked.push(requestId);
        return answers[asking.id]!;
      },
      facts: async (ids) => new Map(ids.map((id) => [id, CATALOG.get(id)!])),
      tokens: async (requestId) =>
        requestId.endsWith("constrained") ? { calls: 3, input: 900, output: 100 } : { calls: 0, input: 0, output: 0 },
      delayMs: 250,
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { ...outcome, asked, sleeps };
  }

  it("judges each answer against its query's checks", async () => {
    const { results } = await run();
    const [constrained, missed, vague, empty] = results;

    // Two of four are action films from 2005 on; one of four has the tag.
    expect(constrained).toMatchObject({ constraintPass: 0.5, tagMatch: 0.25, hit: true, reasons: 2, fallbacks: 1 });
    expect(constrained!.movies.map((item) => item.broken)).toEqual([["minYear"], [], ["genresInclude"], []]);
    expect(constrained!.spoilers).toEqual([{ title: "New Action", phrases: ["turns out", "the butler"] }]);
    expect(constrained!.tokens).toEqual({ calls: 3, input: 900, output: 100 });

    expect(missed).toMatchObject({ constraintPass: null, tagMatch: null, hit: false });
    expect(vague).toMatchObject({ constraintPass: null, tagMatch: null, hit: null });
    // An empty answer scores 0 on what the query asked for, not "not applicable".
    expect(empty).toMatchObject({ constraintPass: 0, tagMatch: 0, hit: null, movies: [] });
  });

  it("gives every request its own id, and pauses between requests only", async () => {
    const { asked, sleeps } = await run();
    expect(asked).toEqual(["run-1-constrained", "run-1-missed", "run-1-vague", "run-1-empty"]);
    expect(sleeps).toEqual([250, 250, 250]);
  });

  it("averages each measure over the queries it applies to", async () => {
    const { summary, results } = await run();
    expect(summary).toMatchObject({
      queries: 4,
      constraintPassRate: 0.25, // (0.5 + 0) / 2
      tagMatchRate: 0.125, // (0.25 + 0) / 2
      hitRate: 0.5, // 1 of the 2 queries with expected movies
      spoilerFailures: 1,
      reasonRate: 2 / 6,
      fallbacks: 1,
      emptyAnswers: 1,
      tokensPerQuery: 250,
      llmCalls: 3,
    });
    expect(summarize(results)).toEqual(summary);
    expect(summarize([]).hitRate).toBeNull();
  });
});

describe("modes", () => {
  it("each mode adds one step to the one before", () => {
    expect(SKIPPED_STEPS).toEqual({
      fulltext: ["parse", "embed", "pick"],
      semantic: ["parse", "pick"],
      parsed: ["pick"],
      full: [],
    });
  });
});

describe("eval/queries.json", () => {
  const file = evalFileSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL("../../../eval/queries.json", import.meta.url)), "utf8")),
  );

  it("is valid: known genres, tags and languages, unique ids", () => {
    expect(file.queries.length).toBeGreaterThanOrEqual(25);
  });

  it("has Hindi or Hinglish queries, vague ones, and no query without a check", () => {
    const ids = file.queries.map((item) => item.id);
    expect(ids.filter((id) => id.startsWith("hindi") || id.startsWith("hinglish")).length).toBeGreaterThanOrEqual(3);
    expect(ids.filter((id) => id.startsWith("vague")).length).toBeGreaterThanOrEqual(2);
    for (const item of file.queries) expect(Object.keys(item.checks).length, item.id).toBeGreaterThan(0);
  });
});
