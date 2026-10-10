import { randomUUID } from "node:crypto";
import type { RecommendRequest, RecommendResponse, Stage, StageStatus } from "@cinequery/shared";
import type pg from "pg";
import type { Logger } from "pino";
import type { QueryEmbeddingCache } from "../cache/queryEmbeddings.js";
import type { LlmProvider } from "../llm/types.js";
import { type SearchSettings, searchMovies } from "../search/movies.js";
import { vectorSearch, type VectorSearchSettings } from "../search/vector.js";
import { normalizeQuery } from "./normalize.js";

export type RecommendDeps = {
  pool: Pick<pg.Pool, "query">;
  /** Null when no LLM is configured. Search then works by keywords only. */
  llm: LlmProvider | null;
  cache: QueryEmbeddingCache;
  vector: VectorSearchSettings;
  /** Settings of the keyword search used as the fallback. */
  search: SearchSettings;
  embedTimeoutMs: number;
  logger: Logger;
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

/**
 * Answers a natural language request by meaning:
 *   1. embed the request (from the cache if it was asked before)
 *   2. find the movies whose embeddings are nearest, and re-score them
 * If the embedding cannot be made, or finds nothing, keyword search answers
 * instead (D-011). The caller always gets results or an empty list, never an
 * error caused by the LLM.
 */
export async function recommend(
  deps: RecommendDeps,
  request: RecommendRequest,
): Promise<RecommendResponse> {
  const requestId = randomUUID();
  const stages: Stage[] = [];
  const normalized = normalizeQuery(request.query);
  let cached = false;

  const queryVector = await stage<number[] | null>(stages, "embed", async () => {
    if (!deps.llm) return { value: null, status: "skipped" };

    const stored = await deps.cache.get(normalized);
    if (stored) {
      cached = true;
      return { value: stored, status: "ok" };
    }
    try {
      const { vectors } = await deps.llm.embed({
        texts: [normalized],
        kind: "query",
        stage: "embed_query",
        timeoutMs: deps.embedTimeoutMs,
        requestId,
      });
      const vector = vectors[0];
      if (!vector) return { value: null, status: "fallback" };
      await deps.cache.set(normalized, vector);
      return { value: vector, status: "ok" };
    } catch (error) {
      deps.logger.warn({ requestId, err: (error as Error).message }, "query embedding failed");
      return { value: null, status: "fallback" };
    }
  });

  const results = await stage(stages, "search", async () => {
    if (queryVector) {
      const matches = await vectorSearch(deps.pool, queryVector, request.limit, deps.vector);
      if (matches.length > 0) {
        return {
          value: matches.map(({ movie, score }) => ({ movie, score })),
          status: "ok" as const,
        };
      }
    }
    // No vector, or no movie has an embedding yet: search by keywords.
    const keyword = await searchMovies(
      deps.pool,
      { q: normalized, genres: [], tags: [], limit: request.limit, offset: 0 },
      deps.search,
    );
    // It is a fallback only if meaning search was attempted and gave nothing.
    return { value: keyword.results, status: queryVector ? ("fallback" as const) : ("ok" as const) };
  });

  return { requestId, results, meta: { stages, cached } };
}
