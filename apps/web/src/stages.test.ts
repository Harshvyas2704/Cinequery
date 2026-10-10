import { describe, expect, it } from "vitest";
import {
  describeParsed,
  describeRelaxed,
  describeStages,
  searchedByMeaning,
  totalMs,
} from "./stages.ts";

const meta = (embed: string, search: string, cached = false) => ({
  cached,
  stages: [
    { name: "embed", ms: 120, status: embed as "ok" },
    { name: "search", ms: 15, status: search as "ok" },
  ],
});

const parsed = {
  genres: [],
  excludeGenres: [],
  tags: [],
  excludeTags: [],
  referenceTitles: [],
  searchText: "x",
};

describe("describeStages", () => {
  it("describes a normal request", () => {
    expect(describeStages(meta("ok", "ok"))).toEqual([
      { step: "Turn it into a meaning vector", result: "Done", ms: 120, problem: false },
      { step: "Search the catalog", result: "Done", ms: 15, problem: false },
    ]);
  });

  it("says when the vector came from the cache", () => {
    expect(describeStages(meta("ok", "ok", true))[0]!.result).toBe("Reused from an earlier request");
  });

  it("flags a fallback and explains it", () => {
    const [embed] = describeStages(meta("fallback", "ok"));
    expect(embed).toMatchObject({ result: "Failed, so keywords were used instead", problem: true });
    const [, search] = describeStages(meta("ok", "fallback"));
    expect(search).toMatchObject({ problem: true });
  });

  it("does not flag a skipped step as a problem", () => {
    expect(describeStages(meta("skipped", "ok"))[0]).toMatchObject({
      result: "Off: no AI service is configured",
      problem: false,
    });
  });

  it("describes the parse step", () => {
    const parse = (status: string, cached = false) =>
      describeStages({ cached, stages: [{ name: "parse", ms: 900, status: status as "ok" }] })[0]!;
    expect(parse("ok")).toMatchObject({ step: "Understand the request", result: "Read by the AI" });
    expect(parse("ok", true).result).toBe("Reused from an earlier request");
    expect(parse("fallback")).toMatchObject({
      result: "Failed, so the words were searched as typed",
      problem: true,
    });
    expect(parse("skipped").problem).toBe(false);
  });

  it("shows an unknown stage as it is", () => {
    const rows = describeStages({ cached: false, stages: [{ name: "pick", ms: 3, status: "ok" }] });
    expect(rows).toEqual([{ step: "pick", result: "ok", ms: 3, problem: false }]);
  });
});

describe("searchedByMeaning and totalMs", () => {
  it("is true only when both steps were ok", () => {
    expect(searchedByMeaning(meta("ok", "ok"))).toBe(true);
    expect(searchedByMeaning(meta("fallback", "ok"))).toBe(false);
    expect(searchedByMeaning(meta("skipped", "ok"))).toBe(false);
    expect(searchedByMeaning(meta("ok", "fallback"))).toBe(false);
  });

  it("adds up the stage times", () => {
    expect(totalMs(meta("ok", "ok"))).toBe(135);
  });
});

describe("describeParsed", () => {
  it("is empty when nothing was understood beyond the text", () => {
    expect(describeParsed(parsed)).toEqual([]);
  });

  it("lists what was understood, in plain words", () => {
    expect(
      describeParsed({
        ...parsed,
        genres: ["Action"],
        excludeGenres: ["Horror"],
        yearFrom: 2011,
        language: "hi",
        maxRuntime: 120,
        minRating: 7,
        tags: ["twist ending"],
        excludeTags: ["tearjerker"],
        referenceTitles: ["Inception"],
      }),
    ).toEqual([
      "Action",
      "not Horror",
      "from 2011",
      "Hindi",
      "under 120 min",
      "rated 7+",
      "twist ending",
      "not tearjerker",
      "like Inception",
    ]);
  });

  it("words year ranges", () => {
    expect(describeParsed({ ...parsed, yearFrom: 1990, yearTo: 1999 })).toEqual(["1990 to 1999"]);
    expect(describeParsed({ ...parsed, yearTo: 1980 })).toEqual(["up to 1980"]);
  });
});

describe("describeRelaxed", () => {
  it("is null when nothing was relaxed", () => {
    expect(describeRelaxed(undefined)).toBeNull();
    expect(describeRelaxed([])).toBeNull();
  });

  it("names one or several ignored filters", () => {
    expect(describeRelaxed(["years"])).toBe(
      "Too few movies matched everything, so the year range was ignored.",
    );
    expect(describeRelaxed(["minRating", "maxRuntime", "years"])).toBe(
      "Too few movies matched everything, so the minimum rating, the maximum length and the year range were ignored.",
    );
  });
});
