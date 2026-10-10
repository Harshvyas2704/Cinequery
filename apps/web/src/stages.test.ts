import { describe, expect, it } from "vitest";
import { describeStages, searchedByMeaning, totalMs } from "./stages.ts";

const meta = (embed: string, search: string, cached = false) => ({
  cached,
  stages: [
    { name: "embed", ms: 120, status: embed as "ok" },
    { name: "search", ms: 15, status: search as "ok" },
  ],
});

describe("describeStages", () => {
  it("describes a normal request", () => {
    expect(describeStages(meta("ok", "ok"))).toEqual([
      { step: "Understand the request", result: "Turned into a meaning vector", ms: 120, problem: false },
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
