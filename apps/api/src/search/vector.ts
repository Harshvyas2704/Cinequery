import type { MovieSummary } from "@cinequery/shared";
import type pg from "pg";
import { SUMMARY_COLUMNS, type SummaryRow, toSummary } from "./movies.js";

export type VectorSearchSettings = {
  /** The embedding model whose vectors are searched. */
  model: string;
  /** How many nearest movies are taken from the index before they are re-scored. */
  candidates: number;
  weights: { similarity: number; rating: number };
  posterBaseUrl: string;
};

export type VectorMatch = { movie: MovieSummary; score: number; similarity: number };

// $1 query vector   $2 model   $3 candidates   $4 limit
// $5 weight of similarity      $6 weight of the weighted rating
//
// The inner query is the only part that uses the HNSW index: "the $3 vectors
// nearest to the query". The outer query re-scores just those rows.
const VECTOR_SEARCH = `
  WITH stats AS (
    SELECT mean_vote_average AS c, min_votes AS m FROM rating_stats
  ),
  nearest AS (
    SELECT movie_id, embedding <=> $1::vector AS distance
    FROM movie_embeddings
    WHERE model = $2
    ORDER BY embedding <=> $1::vector
    LIMIT $3
  ),
  scored AS (
    SELECT
      m.id,
      m.vote_count,
      -- Cosine similarity: 1 means the same direction, 0 unrelated.
      (1 - nearest.distance)::float8 AS similarity,
      CASE
        WHEN m.vote_count + coalesce(stats.m, 0) = 0 THEN 0
        ELSE (
          m.vote_count * coalesce(m.vote_average, stats.c, 0)
          + coalesce(stats.m, 0) * coalesce(stats.c, 0)
        ) / (m.vote_count + coalesce(stats.m, 0)) / 10
      END::float8 AS rating_score
    FROM nearest
    JOIN movies m ON m.id = nearest.movie_id
    LEFT JOIN stats ON true
  )
  SELECT
    scored.similarity,
    ($5::float8 * scored.similarity + $6::float8 * scored.rating_score) AS score,
    ${SUMMARY_COLUMNS}
  FROM scored
  JOIN movies m ON m.id = scored.id
  ORDER BY score DESC, scored.vote_count DESC, scored.id
  LIMIT $4
`;

/** The movies whose embeddings are closest in meaning to the query vector. */
export async function vectorSearch(
  db: Pick<pg.Pool, "query">,
  queryVector: number[],
  limit: number,
  settings: VectorSearchSettings,
): Promise<VectorMatch[]> {
  const { rows } = await db.query<SummaryRow & { similarity: number; score: number }>(
    VECTOR_SEARCH,
    [
      `[${queryVector.join(",")}]`,
      settings.model,
      Math.max(settings.candidates, limit),
      limit,
      settings.weights.similarity,
      settings.weights.rating,
    ],
  );
  return rows.map((row) => ({
    movie: toSummary(row, settings.posterBaseUrl),
    score: row.score,
    similarity: row.similarity,
  }));
}
