import type { RecommendResponse, Stage } from "@cinequery/shared";

/** One row of the "How this was found" panel, in plain words. */
export type StageRow = { step: string; result: string; ms: number; problem: boolean };

const STEP_NAMES: Record<string, string> = {
  embed: "Understand the request",
  search: "Search the catalog",
};

function resultOf(stage: Stage, cached: boolean): string {
  if (stage.name === "embed") {
    if (stage.status === "ok") return cached ? "Reused from an earlier request" : "Turned into a meaning vector";
    if (stage.status === "skipped") return "Off: no AI service is configured";
    return "Failed, so keywords were used instead";
  }
  if (stage.name === "search") {
    if (stage.status === "fallback") return "Nothing found by meaning, so keywords were used";
    if (stage.status === "ok") return "Done";
  }
  return stage.status;
}

export function describeStages(meta: RecommendResponse["meta"]): StageRow[] {
  return meta.stages.map((stage) => ({
    step: STEP_NAMES[stage.name] ?? stage.name,
    result: resultOf(stage, meta.cached),
    ms: stage.ms,
    problem: stage.status === "fallback" || stage.status === "error",
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
