import { describe, expect, it } from "vitest";
import { CURATED_TAGS, curatedTagOf, findCuratedTag, GENRES } from "./catalog.js";
import { searchQuerySchema } from "./movies.js";

function messagesOf(input: Record<string, unknown>): Record<string, string> {
  const result = searchQuerySchema.safeParse(input);
  if (result.success) throw new Error("expected the query to be rejected");
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join("."), issue.message]),
  );
}

describe("curated tags", () => {
  it("has unique names and maps every genome tag once", () => {
    const names = CURATED_TAGS.map(({ tag }) => tag);
    const genome = CURATED_TAGS.flatMap(({ genomeTags }) => genomeTags);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(genome).size).toBe(genome.length);
    expect(CURATED_TAGS.every(({ genomeTags }) => genomeTags.length > 0)).toBe(true);
  });

  it("looks up in both directions", () => {
    expect(findCuratedTag("twist ending")?.genomeTags).toContain("plot twist");
    expect(curatedTagOf("plot twist")).toBe("twist ending");
    expect(curatedTagOf("imdb top 250")).toBeUndefined();
  });
});

describe("searchQuerySchema", () => {
  it("applies defaults to an empty query", () => {
    expect(searchQuerySchema.parse({})).toEqual({ genres: [], tags: [], limit: 20, offset: 0 });
  });

  it("parses lists, numbers and trims the text", () => {
    expect(
      searchQuerySchema.parse({
        q: "  heist ",
        genres: "Action, Science Fiction,Action",
        tags: ["twist ending", "dark"],
        yearFrom: "1990",
        yearTo: "1999",
        language: "hi",
        minRating: "7.5",
        limit: "5",
        offset: "10",
      }),
    ).toEqual({
      q: "heist",
      genres: ["Action", "Science Fiction"],
      tags: ["twist ending", "dark"],
      yearFrom: 1990,
      yearTo: 1999,
      language: "hi",
      minRating: 7.5,
      limit: 5,
      offset: 10,
    });
  });

  it("knows every genre in the catalog", () => {
    expect(searchQuerySchema.parse({ genres: GENRES.join(",") }).genres).toEqual([...GENRES]);
  });

  it("names unknown genres and tags", () => {
    expect(messagesOf({ genres: "Action,Heist" })).toEqual({ genres: "Unknown genre: Heist" });
    expect(messagesOf({ tags: "plot twist" })).toEqual({ tags: "Unknown tag: plot twist" });
  });

  it("rejects out-of-range numbers with a message per field", () => {
    expect(messagesOf({ limit: "51", offset: "-1", minRating: "11", yearFrom: "abc" })).toEqual({
      limit: "limit must be a whole number from 1 to 50",
      offset: "offset must be a whole number from 0 to 10000",
      minRating: "minRating must be a number from 0 to 10",
      yearFrom: "yearFrom must be a year",
    });
    expect(messagesOf({ limit: "0" }).limit).toBeDefined();
    expect(messagesOf({ limit: "2.5" }).limit).toBeDefined();
  });

  it("rejects a year range that is the wrong way round", () => {
    expect(messagesOf({ yearFrom: "2010", yearTo: "2000" })).toEqual({
      yearFrom: "yearFrom must not be after yearTo",
    });
  });

  it("rejects a bad language code and an over-long query", () => {
    expect(messagesOf({ language: "Hindi" }).language).toContain("two-letter code");
    expect(messagesOf({ q: "x".repeat(201) }).q).toBe("q must be at most 200 characters");
  });
});
