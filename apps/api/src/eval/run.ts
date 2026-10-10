import type { RecommendResponse, Stage } from "@cinequery/shared";
import type { LlmStep } from "../recommend/pipeline.js";
import {
  brokenConstraints,
  hasAnyTag,
  hasConstraints,
  mean,
  type MovieFacts,
  percentile,
  spoilerWordsIn,
} from "./checks.js";
import type { EvalFile, EvalMode, EvalQuery } from "./schema.js";

// What each mode leaves out. Comparing them shows what each step adds:
//   fulltext  keyword search on the words as typed (no AI at all)
//   semantic  + the request is embedded and searched by meaning
//   parsed    + the request is first parsed into filters, tags and a search text
//   full      + the model picks the best of the results and gives reasons
export const SKIPPED_STEPS: Record<EvalMode, LlmStep[]> = {
  fulltext: ["parse", "embed", "pick"],
  semantic: ["parse", "pick"],
  parsed: ["pick"],
  full: [],
};

export type Tokens = { calls: number; input: number; output: number };

export type EvalDeps = {
  /** Answers one request with the steps of the mode. */
  ask(query: EvalQuery, requestId: string): Promise<RecommendResponse>;
  /** Facts about movies, by the internal id the response uses. */
  facts(movieIds: number[]): Promise<Map<number, MovieFacts>>;
  /** What the LLM calls of one request used. */
  tokens(requestId: string): Promise<Tokens>;
  /** Pause between requests, to stay under the provider's rate limit. */
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onQuery?: (result: QueryResult, index: number, total: number) => void;
};

export type QueryResult = {
  id: string;
  query: string;
  movies: {
    tmdbId: number;
    title: string;
    year: number | null;
    why?: string;
    /** Constraints this movie breaks; empty if none. */
    broken: string[];
    expected: boolean;
  }[];
  /** Share of the returned movies that pass every constraint; null if the query has none. */
  constraintPass: number | null;
  /** Share of the returned movies with one of the wanted tags; null if the query names none. */
  tagMatch: number | null;
  /** Whether an expected movie was returned; null if the query lists none. */
  hit: boolean | null;
  /** Reasons that contain a spoiler phrase. */
  spoilers: { title: string; phrases: string[] }[];
  reasons: number;
  stages: Stage[];
  fallbacks: number;
  relaxed: string[];
  ms: number;
  tokens: Tokens;
};

export type EvalSummary = {
  queries: number;
  /** Mean over the queries that have constraints. */
  constraintPassRate: number | null;
  /** Share of the queries with expected movies that returned at least one. */
  hitRate: number | null;
  /** Mean over the queries that name tags. */
  tagMatchRate: number | null;
  spoilerFailures: number;
  /** Share of all returned movies that came with a reason. */
  reasonRate: number | null;
  fallbacks: number;
  emptyAnswers: number;
  latencyMs: { p50: number | null; p95: number | null };
  tokensPerQuery: number | null;
  llmCalls: number;
};

function judge(
  query: EvalQuery,
  response: RecommendResponse,
  facts: Map<number, MovieFacts>,
  defaults: Pick<EvalFile, "noSpoilerWords">,
): Omit<QueryResult, "ms" | "tokens"> {
  const { checks } = query;
  const expectedIds = new Set((checks.anyOfMovies ?? []).map((movie) => movie.tmdbId));
  const spoilerWords = [...defaults.noSpoilerWords, ...(checks.noSpoilerWords ?? [])];

  const returned = response.results.flatMap(({ movie, why }) => {
    const known = facts.get(movie.id);
    return known ? [{ facts: known, why }] : [];
  });
  const movies = returned.map(({ facts: movie, why }) => ({
    tmdbId: movie.tmdbId,
    title: movie.title,
    year: movie.year,
    ...(why ? { why } : {}),
    broken: brokenConstraints(movie, checks),
    expected: expectedIds.has(movie.tmdbId),
  }));
  // An empty answer passes nothing: 0, not "not applicable".
  const share = (count: number) => (movies.length === 0 ? 0 : count / movies.length);

  return {
    id: query.id,
    query: query.query,
    movies,
    constraintPass: hasConstraints(checks)
      ? share(movies.filter((movie) => movie.broken.length === 0).length)
      : null,
    tagMatch: checks.tagsAny?.length
      ? share(returned.filter(({ facts: movie }) => hasAnyTag(movie, checks.tagsAny!)).length)
      : null,
    hit: expectedIds.size > 0 ? movies.some((movie) => movie.expected) : null,
    spoilers: movies.flatMap((movie) => {
      const phrases = movie.why ? spoilerWordsIn(movie.why, spoilerWords) : [];
      return phrases.length > 0 ? [{ title: movie.title, phrases }] : [];
    }),
    reasons: movies.filter((movie) => movie.why).length,
    stages: response.meta.stages,
    fallbacks: response.meta.stages.filter((stage) => stage.status === "fallback").length,
    relaxed: response.meta.relaxed ?? [],
  };
}

export function summarize(results: QueryResult[]): EvalSummary {
  const present = <T>(values: (T | null)[]) => values.filter((value) => value !== null);
  const hits = present(results.map((result) => result.hit));
  const movies = results.reduce((sum, result) => sum + result.movies.length, 0);
  const times = results.map((result) => result.ms);
  const tokens = mean(results.map((result) => result.tokens.input + result.tokens.output));
  return {
    queries: results.length,
    constraintPassRate: mean(present(results.map((result) => result.constraintPass))),
    hitRate: hits.length === 0 ? null : hits.filter(Boolean).length / hits.length,
    tagMatchRate: mean(present(results.map((result) => result.tagMatch))),
    spoilerFailures: results.reduce((sum, result) => sum + result.spoilers.length, 0),
    reasonRate:
      movies === 0 ? null : results.reduce((sum, result) => sum + result.reasons, 0) / movies,
    fallbacks: results.reduce((sum, result) => sum + result.fallbacks, 0),
    emptyAnswers: results.filter((result) => result.movies.length === 0).length,
    latencyMs: { p50: percentile(times, 0.5), p95: percentile(times, 0.95) },
    tokensPerQuery: tokens === null ? null : Math.round(tokens),
    llmCalls: results.reduce((sum, result) => sum + result.tokens.calls, 0),
  };
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs every query once, one after the other, and judges each answer. */
export async function runEval(
  file: EvalFile,
  runId: string,
  deps: EvalDeps,
): Promise<{ results: QueryResult[]; summary: EvalSummary }> {
  const sleep = deps.sleep ?? realSleep;
  const results: QueryResult[] = [];

  for (const [index, query] of file.queries.entries()) {
    if (index > 0 && deps.delayMs > 0) await sleep(deps.delayMs);
    const requestId = `${runId}-${query.id}`;
    const started = performance.now();
    const response = await deps.ask(query, requestId);
    const ms = Math.round(performance.now() - started);

    const facts = await deps.facts(response.results.map((result) => result.movie.id));
    const result: QueryResult = {
      ...judge(query, response, facts, file),
      ms,
      tokens: await deps.tokens(requestId),
    };
    results.push(result);
    deps.onQuery?.(result, index, file.queries.length);
  }
  return { results, summary: summarize(results) };
}
