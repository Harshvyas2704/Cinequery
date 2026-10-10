import { describe, expect, it } from "vitest";
import { recommendRequestSchema, recommendResponseSchema } from "./recommend.js";

const messageOf = (input: unknown) => {
  const result = recommendRequestSchema.safeParse(input);
  if (result.success) throw new Error("expected the request to be rejected");
  return result.error.issues[0]?.message;
};

describe("recommendRequestSchema", () => {
  it("trims the query and defaults the limit to 8", () => {
    expect(recommendRequestSchema.parse({ query: "  space movie  " })).toEqual({
      query: "space movie",
      limit: 8,
    });
  });

  it("rejects a query that is too short, too long or not text", () => {
    expect(messageOf({ query: "  a " })).toBe("query must be at least 3 characters");
    expect(messageOf({ query: "x".repeat(301) })).toBe("query must be at most 300 characters");
    expect(messageOf({})).toBe("query must be text");
    expect(messageOf({ query: 42 })).toBe("query must be text");
  });

  it("rejects a limit outside 1 to 20, or not a whole number", () => {
    for (const limit of [0, 21, 2.5, "5"]) {
      expect(messageOf({ query: "heist", limit })).toBe("limit must be a whole number from 1 to 20");
    }
  });
});

describe("recommendResponseSchema", () => {
  it("accepts a response with and without reasons", () => {
    const movie = {
      id: 1,
      title: "Solaris",
      overview: "A psychologist is sent to a space station.",
      releaseYear: 1972,
      runtimeMinutes: 167,
      genres: ["Drama", "Science Fiction"],
      language: "ru",
      voteAverage: 7.9,
      voteCount: 1500,
      posterUrl: null,
    };
    const result = recommendResponseSchema.safeParse({
      requestId: "abc",
      results: [{ movie, score: 0.7 }, { movie, score: 0.6, why: "It is quiet and lonely." }],
      meta: { stages: [{ name: "embed", ms: 12, status: "ok" }], cached: false },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown stage status", () => {
    const result = recommendResponseSchema.safeParse({
      requestId: "abc",
      results: [],
      meta: { stages: [{ name: "embed", ms: 1, status: "maybe" }], cached: false },
    });
    expect(result.success).toBe(false);
  });
});
