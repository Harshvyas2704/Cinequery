import { describe, expect, it } from "vitest";
import { countActive, EMPTY_FILTERS, fromQueryString, toggle, toQueryString } from "./filters.ts";

describe("toQueryString", () => {
  it("is empty when no filter is set", () => {
    expect(toQueryString(EMPTY_FILTERS)).toBe("");
    expect(toQueryString({ ...EMPTY_FILTERS, q: "   " })).toBe("");
  });

  it("includes only the filters that are set", () => {
    const query = toQueryString({
      q: " heist ",
      genres: ["Action", "Science Fiction"],
      tags: ["twist ending"],
      yearFrom: "2005",
      yearTo: "",
      language: "hi",
    });
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      q: "heist",
      genres: "Action,Science Fiction",
      tags: "twist ending",
      yearFrom: "2005",
      language: "hi",
    });
  });
});

describe("fromQueryString", () => {
  it("round-trips what toQueryString wrote", () => {
    const filters = {
      q: "space",
      genres: ["Drama", "Science Fiction"],
      tags: ["lonely", "slow burn"],
      yearFrom: "1990",
      yearTo: "2020",
      language: "en",
    };
    expect(fromQueryString(`?${toQueryString(filters)}`)).toEqual(filters);
  });

  it("drops unknown genres, tags and malformed values", () => {
    expect(
      fromQueryString("?genres=Action,Nope&tags=explosions&yearFrom=soon&language=Hindi&x=1"),
    ).toEqual({ ...EMPTY_FILTERS, genres: ["Action"] });
  });

  it("returns empty filters for an empty URL", () => {
    expect(fromQueryString("")).toEqual(EMPTY_FILTERS);
  });
});

describe("helpers", () => {
  it("toggle adds and removes", () => {
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
  });

  it("countActive ignores the text", () => {
    expect(countActive({ ...EMPTY_FILTERS, q: "heist" })).toBe(0);
    expect(countActive({ ...EMPTY_FILTERS, genres: ["Drama"], tags: ["dark"], yearTo: "1999" })).toBe(3);
  });
});
