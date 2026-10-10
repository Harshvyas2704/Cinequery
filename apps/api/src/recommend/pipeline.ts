import { randomUUID } from "node:crypto";
import {
  type ParsedRequest,
  type Recommendation,
  type RecommendRequest,
  type RecommendResponse,
  RELAXABLE_FILTERS,
  type RelaxableFilter,
  type Stage,
  type StageStatus,
} from "@cinequery/shared";
import type pg from "pg";
import type { Logger } from "pino";
import type { JsonCache } from "../cache/jsonCache.js";
import type { QueryEmbeddingCache } from "../cache/queryEmbeddings.js";
import {
  PICK_PROMPT_VERSION,
  PICK_RESPONSE_SCHEMA,
  pickSystemPrompt,
  pickUserPrompt,
} from "../llm/prompts/pick-v1.js";
import {
  PARSE_PROMPT_VERSION,
  PARSE_RESPONSE_SCHEMA,
  parseSystemPrompt,
  parseUserPrompt,
} from "../llm/prompts/parse-v1.js";
import type { LlmProvider } from "../llm/types.js";
import type { MovieFilters } from "../search/filters.js";
import { type SearchSettings, searchMovies } from "../search/movies.js";
import { vectorSearch, type VectorSearchSettings } from "../search/vector.js";
import { candidateLines } from "./candidates.js";
import { normalizeQuery } from "./normalize.js";
import { sanitizeParse, unparsed } from "./parse.js";
import { applyPicks, type Pick, validatePicks } from "./pick.js";
import { blendVectors, findReferenceMovies } from "./references.js";

export type RecommendDeps = {
  pool: pg.Pool;
  /** Null when no LLM is configured. Search then works by keywords only. */
  llm: LlmProvider | null;
  embeddingCache: QueryEmbeddingCache;
  parseCache: JsonCache<ParsedRequest>;
  pickCache: JsonCache<Pick[]>;
  vector: VectorSearchSettings;
  /** Settings of the keyword search that fills in and falls back. */
  search: SearchSettings;
  parse: { model: string; thinkingLevel: string; timeoutMs: number; maxOutputTokens: number };
  pick: {
    model: string;
    thinkingLevel: string;
    timeoutMs: number;
    maxOutputTokens: number;
    /** How many search results the model chooses from. */
    candidates: number;
    tagsPerCandidate: number;
    overviewChars: number;
  };
  embedTimeoutMs: number;
  reference: {
    /** How far the query vector moves toward a film the request names, 0 to 1. */
    weight: number;
    /** How close a typed title must be to a real one, 0 to 1. */
    minTitleSimilarity: number;
  };
  /** The clock, so tests can fix the year. */
  now?: () => Date;
  logger: Logger;
};

/** What a caller that streams the answer is told along the way. */
export type RecommendOptions = {
  /** Aborted when the client has gone; the work then stops with an error. */
  signal?: AbortSignal;
  /** Called once, as soon as the search is done. */
  onResults?: (event: { requestId: string; results: Recommendation[]; picking: boolean }) => void;
  /** Called once if the pick step succeeds, with the final order and reasons. */
  onPicked?: (event: { results: Recommendation[] }) => void;
};

/** Runs one step and records how long it took and how it went. */
async function stage<T>(
  stages: Stage[],
  name: string,
  run: () => Promise<{ value: T; status: StageStatus }>,
): Promise<T> {
  const started = performance.now();
  const { value, status } = await run();
  stages.push({ name, ms: Math.round(performance.now() - started), status });
  return value;
}

function filtersOf(parsed: ParsedRequest, excludeIds: number[]): MovieFilters {
  return {
    genres: parsed.genres,
    excludeGenres: parsed.excludeGenres,
    yearFrom: parsed.yearFrom,
    yearTo: parsed.yearTo,
    maxRuntime: parsed.maxRuntime,
    language: parsed.language,
    minRating: parsed.minRating,
    excludeTags: parsed.excludeTags,
    excludeIds,
  };
}

// How each relaxable filter is loosened. Excluded genres and language never
// are: "no horror" and "in Hindi" are not negotiable. Genres are loosened last
// and only from "all of them" to "at least one of them".
const RELAX: Record<
  RelaxableFilter,
  { applies: (filters: MovieFilters) => boolean; without: (filters: MovieFilters) => MovieFilters }
> = {
  excludeTags: {
    applies: (filters) => filters.excludeTags.length > 0,
    without: (filters) => ({ ...filters, excludeTags: [] }),
  },
  minRating: {
    applies: (filters) => filters.minRating !== undefined,
    without: (filters) => ({ ...filters, minRating: undefined }),
  },
  maxRuntime: {
    applies: (filters) => filters.maxRuntime !== undefined,
    without: (filters) => ({ ...filters, maxRuntime: undefined }),
  },
  years: {
    applies: (filters) => filters.yearFrom !== undefined || filters.yearTo !== undefined,
    without: (filters) => ({ ...filters, yearFrom: undefined, yearTo: undefined }),
  },
  genres: {
    applies: (filters) => filters.genres.length > 1 && !filters.anyGenre,
    without: (filters) => ({ ...filters, anyGenre: true }),
  },
};

const hasConstraints = (filters: MovieFilters, tags: string[]) =>
  tags.length > 0 ||
  filters.genres.length > 0 ||
  filters.excludeGenres.length > 0 ||
  filters.excludeTags.length > 0 ||
  filters.yearFrom !== undefined ||
  filters.yearTo !== undefined ||
  filters.maxRuntime !== undefined ||
  filters.language !== undefined ||
  filters.minRating !== undefined;

/**
 * Answers a natural language request:
 *   1. parse   the LLM turns the request into filters, tags and a search text
 *   2. embed   the search text becomes a vector (moved toward any film it names)
 *   3. search  nearest vectors among the movies that pass the filters, with a
 *              boost for wanted tags; keyword search fills any gap
 *   4. pick    the LLM chooses the best of the search results and gives each
 *              a one-sentence reason
 * Each AI step has a fallback (D-011): a failed parse searches the words as
 * typed, a failed embedding searches by keywords, a failed pick keeps the
 * search order. The caller always gets results or an empty list, never an
 * error caused by the LLM.
 */
export async function recommend(
  deps: RecommendDeps,
  request: RecommendRequest,
  options: RecommendOptions = {},
): Promise<RecommendResponse> {
  const { signal } = options;
  // An LLM failure becomes a fallback, except when the client has gone: then
  // there is nobody to fall back for, and the whole request stops.
  const failedStep = (error: unknown, what: string) => {
    if (signal?.aborted) throw error;
    deps.logger.warn({ requestId, err: (error as Error).message }, what);
  };
  const requestId = randomUUID();
  const stages: Stage[] = [];
  const normalized = normalizeQuery(request.query);
  const currentYear = (deps.now?.() ?? new Date()).getFullYear();
  // "cached" means this request made no LLM call because stored results were used.
  let llmCalls = 0;
  let cacheHits = 0;

  // 1. Parse.
  const understood = await stage<ParsedRequest | null>(stages, "parse", async () => {
    if (!deps.llm) return { value: null, status: "skipped" };

    // The year is part of the key because "recent" depends on it; the model,
    // because another model may understand the request differently.
    const cacheKey = [PARSE_PROMPT_VERSION, deps.parse.model, currentYear, normalized];
    const stored = await deps.parseCache.get(cacheKey);
    if (stored) {
      cacheHits++;
      return { value: stored, status: "ok" };
    }
    llmCalls++;
    try {
      const { data } = await deps.llm.generateJson({
        stage: "parse",
        promptVersion: PARSE_PROMPT_VERSION,
        system: parseSystemPrompt(currentYear),
        prompt: parseUserPrompt(normalized),
        schema: PARSE_RESPONSE_SCHEMA,
        model: deps.parse.model,
        thinkingLevel: deps.parse.thinkingLevel,
        maxOutputTokens: deps.parse.maxOutputTokens,
        timeoutMs: deps.parse.timeoutMs,
        requestId,
        signal,
      });
      const parsed = sanitizeParse(data, { currentYear, fallbackText: normalized });
      if (!parsed) {
        deps.logger.warn({ requestId }, "parse reply was not an object");
        return { value: null, status: "fallback" };
      }
      await deps.parseCache.set(cacheKey, parsed);
      return { value: parsed, status: "ok" };
    } catch (error) {
      failedStep(error, "parse failed");
      return { value: null, status: "fallback" };
    }
  });
  const parsed = understood ?? unparsed(normalized);
  signal?.throwIfAborted();

  // 2. Embed the search text, and look up any films the request names.
  const [embedded, references] = await Promise.all([
    stage<number[] | null>(stages, "embed", async () => {
      if (!deps.llm) return { value: null, status: "skipped" };

      const text = normalizeQuery(parsed.searchText);
      const stored = await deps.embeddingCache.get(text);
      if (stored) {
        cacheHits++;
        return { value: stored, status: "ok" };
      }
      llmCalls++;
      try {
        const { vectors } = await deps.llm.embed({
          texts: [text],
          kind: "query",
          stage: "embed_query",
          timeoutMs: deps.embedTimeoutMs,
          requestId,
          signal,
        });
        const vector = vectors[0];
        if (!vector) return { value: null, status: "fallback" };
        await deps.embeddingCache.set(text, vector);
        return { value: vector, status: "ok" };
      } catch (error) {
        failedStep(error, "query embedding failed");
        return { value: null, status: "fallback" };
      }
    }),
    parsed.referenceTitles.length > 0
      ? findReferenceMovies(deps.pool, parsed.referenceTitles, {
          model: deps.vector.model,
          minSimilarity: deps.reference.minTitleSimilarity,
        })
      : [],
  ]);

  const queryVector =
    embedded &&
    blendVectors(
      embedded,
      references.map((movie) => movie.vector).filter((vector) => vector !== null),
      deps.reference.weight,
    );
  // Someone asking for films like Inception does not want Inception itself.
  const referenceIds = references.map((movie) => movie.id);

  signal?.throwIfAborted();

  // 3. Search, loosening filters if too few movies match. With an LLM, more
  // movies are fetched than will be shown, so the pick step has a choice.
  const wanted = deps.llm ? Math.max(deps.pick.candidates, request.limit) : request.limit;
  const relaxed: RelaxableFilter[] = [];
  const { results: found } = await stage(stages, "search", async () => {
    let filters = filtersOf(parsed, referenceIds);
    let found = await searchOnce(deps, { queryVector, parsed, filters, limit: wanted });

    for (const name of RELAXABLE_FILTERS) {
      if (found.results.length >= request.limit) break;
      if (!RELAX[name].applies(filters)) continue;
      filters = RELAX[name].without(filters);
      relaxed.push(name);
      found = await searchOnce(deps, { queryVector, parsed, filters, limit: wanted });
    }
    // A fallback only if meaning search was possible and found nothing.
    const status: StageStatus = queryVector && !found.usedVectors ? "fallback" : "ok";
    return { value: found, status };
  });

  signal?.throwIfAborted();

  // The search results are final enough to show: the pick step only reorders
  // them and adds reasons, and it is the slowest step.
  const candidates = found.slice(0, deps.pick.candidates);
  const inSearchOrder = found.slice(0, request.limit);
  const llm = candidates.length > 0 ? deps.llm : null;
  options.onResults?.({ requestId, results: inSearchOrder, picking: llm !== null });

  // 4. Pick.
  const picked = await stage<Recommendation[] | null>(stages, "pick", async () => {
    if (!llm) return { value: null, status: "skipped" };

    const candidateIds = candidates.map((candidate) => candidate.movie.id);
    // The candidates are part of the key: after new data or a change to the
    // search, the same request has other candidates and needs other picks.
    const cacheKey = [PICK_PROMPT_VERSION, deps.pick.model, normalized, request.limit, candidateIds];
    const stored = await deps.pickCache.get(cacheKey);
    if (stored) {
      cacheHits++;
      return { value: applyPicks(candidates, stored, request.limit), status: "ok" };
    }
    llmCalls++;
    try {
      const lines = await candidateLines(deps.pool, candidates, deps.pick);
      const { data } = await llm.generateJson({
        stage: "pick",
        promptVersion: PICK_PROMPT_VERSION,
        system: pickSystemPrompt(request.limit),
        prompt: pickUserPrompt(normalized, lines),
        schema: PICK_RESPONSE_SCHEMA,
        model: deps.pick.model,
        thinkingLevel: deps.pick.thinkingLevel,
        maxOutputTokens: deps.pick.maxOutputTokens,
        timeoutMs: deps.pick.timeoutMs,
        requestId,
        signal,
      });
      const checked = validatePicks(data, new Set(candidateIds));
      // Ids the model made up, or repeated. A rising number means the prompt
      // or the model is getting worse.
      if (checked?.dropped) {
        deps.logger.warn({ requestId, dropped: checked.dropped }, "pick ids dropped");
      }
      if (!checked || checked.picks.length === 0) {
        deps.logger.warn({ requestId }, "pick reply had no usable picks");
        return { value: null, status: "fallback" };
      }
      await deps.pickCache.set(cacheKey, checked.picks);
      return { value: applyPicks(candidates, checked.picks, request.limit), status: "ok" };
    } catch (error) {
      failedStep(error, "pick failed");
      return { value: null, status: "fallback" };
    }
  });
  signal?.throwIfAborted();
  if (picked) options.onPicked?.({ results: picked });

  return {
    requestId,
    results: picked ?? inSearchOrder,
    meta: {
      stages,
      cached: llmCalls === 0 && cacheHits > 0,
      ...(relaxed.length > 0 ? { relaxed } : {}),
      ...(understood ? { parsed: understood } : {}),
    },
  };
}

/**
 * One search with a fixed set of filters. Results come from up to three
 * sources, each only used if the ones before did not fill the list:
 *   1. movies nearest in meaning (needs a query vector and movie embeddings)
 *   2. movies matching the words of the search text
 *   3. the best movies that pass the filters and tags, if the request has any
 */
async function searchOnce(
  deps: RecommendDeps,
  input: {
    queryVector: number[] | null;
    parsed: ParsedRequest;
    filters: MovieFilters;
    limit: number;
  },
): Promise<{ results: Recommendation[]; usedVectors: boolean }> {
  const { queryVector, parsed, filters, limit } = input;
  const results: Recommendation[] = [];
  const add = (found: Recommendation[]) => results.push(...found.slice(0, limit - results.length));
  const withoutFound = (): MovieFilters => ({
    ...filters,
    excludeIds: [...filters.excludeIds, ...results.map((result) => result.movie.id)],
  });

  if (queryVector) {
    const matches = await vectorSearch(
      deps.pool,
      { queryVector, filters, boostTags: parsed.tags, limit },
      deps.vector,
    );
    add(matches.map(({ movie, score }) => ({ movie, score })));
  }
  const usedVectors = results.length > 0;

  const keywordSearch = async (q: string | undefined) => {
    const found = await searchMovies(
      deps.pool,
      {
        q,
        filters: withoutFound(),
        tags: parsed.tags,
        tagMode: "boost",
        limit: limit - results.length,
        offset: 0,
      },
      deps.search,
    );
    add(found.results);
  };

  if (results.length < limit) await keywordSearch(parsed.searchText);
  // Without any filter or tag, "the best movies" would be unrelated to the request.
  if (results.length < limit && hasConstraints(filters, parsed.tags)) await keywordSearch(undefined);

  return { results, usedVectors };
}
