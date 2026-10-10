import type pg from "pg";
import type { LlmProvider } from "../llm/types.js";
import { type EmbeddingTarget, loadMoviesToEmbed, saveEmbeddings } from "./store.js";

export type EmbedBatchDeps = {
  pool: Pick<pg.Pool, "query">;
  llm: LlmProvider;
  target: EmbeddingTarget;
  timeoutMs: number;
};

export type EmbedBatchResult = { embedded: number; skipped: number; inputTokens: number };

/**
 * Embeds the movies of one batch that still need it and stores the vectors.
 * Safe to run twice: a movie whose stored hash is current is skipped, so a
 * batch that is retried or queued twice costs no extra API calls.
 */
export async function embedBatch(
  deps: EmbedBatchDeps,
  movieIds: number[],
): Promise<EmbedBatchResult> {
  const movies = await loadMoviesToEmbed(deps.pool, deps.target, movieIds);
  const pending = movies.filter((movie) => movie.needsEmbedding);
  if (pending.length === 0) return { embedded: 0, skipped: movies.length, inputTokens: 0 };

  const { vectors, usage } = await deps.llm.embed({
    texts: pending.map((movie) => movie.document.text),
    titles: pending.map((movie) => movie.document.title),
    kind: "document",
    stage: "embed_batch",
    timeoutMs: deps.timeoutMs,
  });

  await saveEmbeddings(
    deps.pool,
    deps.target.model,
    pending.map((movie, index) => ({
      movieId: movie.movieId,
      hash: movie.hash,
      vector: vectors[index] ?? [],
    })),
  );
  return {
    embedded: pending.length,
    skipped: movies.length - pending.length,
    inputTokens: usage.inputTokens ?? 0,
  };
}
