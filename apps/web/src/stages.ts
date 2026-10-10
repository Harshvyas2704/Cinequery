import {
  LANGUAGES,
  type ParsedRequest,
  type RecommendResponse,
  type RelaxableFilter,
  type Stage,
} from "@cinequery/shared";

/** One row of the "How this was found" panel, in plain words. */
export type StageRow = { step: string; result: string; ms: number; problem: boolean };

const STEP_NAMES: Record<string, string> = {
  parse: "Understand the request",
  embed: "Turn it into a meaning vector",
  search: "Search the catalog",
  pick: "Choose the best and say why",
};

// A step is skipped either because no AI service is configured, or because
// the day's token budget is used up.
const skippedBecause = (budget: RecommendResponse["meta"]["budget"]) =>
  budget ? "Paused: today's AI budget is used up" : "Off: no AI service is configured";

function resultOf(stage: Stage, { cached, budget }: RecommendResponse["meta"]): string {
  if (stage.name === "parse") {
    if (stage.status === "ok") return cached ? "Reused from an earlier request" : "Read by the AI";
    if (stage.status === "skipped") return skippedBecause(budget);
    return "Failed, so the words were searched as typed";
  }
  if (stage.name === "embed") {
    if (stage.status === "ok") return cached ? "Reused from an earlier request" : "Done";
    if (stage.status === "skipped") return skippedBecause(budget);
    return "Failed, so keywords were used instead";
  }
  if (stage.name === "search") {
    if (stage.status === "fallback") return "Nothing found by meaning, so keywords were used";
    if (stage.status === "ok") return "Done";
  }
  if (stage.name === "pick") {
    if (stage.status === "ok") return cached ? "Reused from an earlier request" : "Chosen by the AI";
    if (stage.status === "skipped") return skippedBecause(budget);
    return "Not available, so the search order was kept";
  }
  return stage.status;
}

export function describeStages(meta: RecommendResponse["meta"]): StageRow[] {
  return meta.stages.map((stage) => ({
    step: STEP_NAMES[stage.name] ?? stage.name,
    result: resultOf(stage, meta),
    ms: stage.ms,
    // A failed pick is not flagged: the results are complete without it, only
    // their order is less considered and they have no reasons.
    problem: stage.name !== "pick" && (stage.status === "fallback" || stage.status === "error"),
  }));
}

/** True when the results came from matching meaning, not just words. */
export function searchedByMeaning(meta: RecommendResponse["meta"]): boolean {
  const status = (name: string) => meta.stages.find((stage) => stage.name === name)?.status;
  return status("embed") === "ok" && status("search") === "ok";
}

export function totalMs(meta: RecommendResponse["meta"]): number {
  return meta.stages.reduce((sum, stage) => sum + stage.ms, 0);
}

const languageName = (code: string) =>
  LANGUAGES.find((language) => language.code === code)?.name ?? code.toUpperCase();

/** What the request was understood to ask for, as short labels. */
export function describeParsed(parsed: ParsedRequest): string[] {
  const { yearFrom, yearTo } = parsed;
  const years =
    yearFrom !== undefined && yearTo !== undefined
      ? `${yearFrom} to ${yearTo}`
      : yearFrom !== undefined
        ? `from ${yearFrom}`
        : yearTo !== undefined
          ? `up to ${yearTo}`
          : null;
  return [
    ...parsed.genres,
    ...parsed.excludeGenres.map((genre) => `not ${genre}`),
    years,
    parsed.language ? languageName(parsed.language) : null,
    parsed.maxRuntime !== undefined ? `under ${parsed.maxRuntime} min` : null,
    parsed.minRating !== undefined ? `rated ${parsed.minRating}+` : null,
    ...parsed.tags,
    ...parsed.excludeTags.map((tag) => `not ${tag}`),
    ...parsed.referenceTitles.map((title) => `like ${title}`),
  ].filter((label) => label !== null);
}

const RELAXED_NAMES: Record<RelaxableFilter, string> = {
  excludeTags: "the tags to avoid",
  minRating: "the minimum rating",
  maxRuntime: "the maximum length",
  years: "the year range",
  genres: "the need to match every genre",
};

/** A sentence saying which filters were dropped to find enough movies, or null. */
export function describeRelaxed(relaxed: RelaxableFilter[] | undefined): string | null {
  if (!relaxed || relaxed.length === 0) return null;
  const names = relaxed.map((name) => RELAXED_NAMES[name]);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Too few movies matched everything, so ${list} ${names.length === 1 ? "was" : "were"} ignored.`;
}
