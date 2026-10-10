import type { MovieSummary } from "@cinequery/shared";
import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import {
  FILTER_CONDITIONS,
  FILTER_PARAMS,
  filterParams,
  genomeTagsOf,
  type MovieFilters,
  RATING_SCORE,
  STATS_CTE,
  tagScoreCte,
} from "./filters.js";
import { SUMMARY_COLUMNS, type SummaryRow, toSummary } from "./movies.js";

export type VectorSearchSettings = {
  /** The embedding model whose vectors are searched. */
  model: string;
  /** How many nearest movies are taken from the index before they are re-scored. */
  candidates: number;
  weights: { similarity: number; tags: number; rating: number };
  posterBaseUrl: string;
};

export type VectorSearch = {
  queryVector: number[];
  filters: MovieFilters;
  /** Curated tags that raise the score of movies that have them. */
  boostTags: string[];
  limit: number;
};

export type VectorMatch = { movie: MovieSummary; score: number; similarity: number };

// Parameters after the filters ($1 to $10, see filters.ts):
const P = FILTER_PARAMS;
const GENOME = P + 1;
const CURATED = P + 2;
const TAG_COUNT = P + 3;
const VECTOR = P + 4;
const MODEL = P + 5;
const CANDIDATES = P + 6;
const LIMIT = P + 7;
const W_SIMILARITY = P + 8;
const W_TAGS = P + 9;
const W_RATING = P + 10;

// "nearest" is the part that uses the HNSW index: the closest vectors among
// the movies that pass the filters. The outer query re-scores only those.
const VECTOR_SEARCH = `
  WITH ${STATS_CTE},
  ${tagScoreCte(GENOME, CURATED, TAG_COUNT)},
  nearest AS (
    SELECT e.movie_id, e.embedding <=> $${VECTOR}::vector AS distance
    FROM movie_embeddings e
    JOIN movies m ON m.id = e.movie_id
    WHERE e.model = $${MODEL}
      AND ${FILTER_CONDITIONS}
    ORDER BY e.embedding <=> $${VECTOR}::vector
    LIMIT $${CANDIDATES}
  ),
  scored AS (
    SELECT
      m.id,
      m.vote_count,
      -- Cosine similarity: 1 means the same direction, 0 unrelated.
      (1 - nearest.distance)::float8 AS similarity,
      CASE WHEN $${TAG_COUNT}::integer = 0 THEN 0 ELSE coalesce(tagged.tag_score, 0) END AS tag_score,
      ${RATING_SCORE} AS rating_score
    FROM nearest
    JOIN movies m ON m.id = nearest.movie_id
    LEFT JOIN stats ON true
    LEFT JOIN tagged ON tagged.movie_id = m.id
  )
  SELECT
    scored.similarity,
    ($${W_SIMILARITY}::float8 * scored.similarity + $${W_TAGS}::float8 * scored.tag_score
       + $${W_RATING}::float8 * scored.rating_score) AS score,
    ${SUMMARY_COLUMNS}
  FROM scored
  JOIN movies m ON m.id = scored.id
  ORDER BY score DESC, scored.vote_count DESC, scored.id
  LIMIT $${LIMIT}
`;

/** The movies that pass the filters and are closest in meaning to the query vector. */
export async function vectorSearch(
  pool: pg.Pool,
  search: VectorSearch,
  settings: VectorSearchSettings,
): Promise<VectorMatch[]> {
  const { genome, curated } = genomeTagsOf(search.boostTags);
  const params = [
    ...filterParams(search.filters),
    genome,
    curated,
    search.boostTags.length,
    `[${search.queryVector.join(",")}]`,
    settings.model,
    Math.max(settings.candidates, search.limit),
    search.limit,
    settings.weights.similarity,
    settings.weights.tags,
    settings.weights.rating,
  ];

  const rows = await withTransaction(pool, async (client) => {
    // An HNSW index returns a fixed number of nearest vectors. With filters,
    // most of them may be thrown away. This setting (pgvector 0.8) makes the
    // index keep going until enough rows have passed the filters.
    await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
    const result = await client.query<SummaryRow & { similarity: number; score: number }>(
      VECTOR_SEARCH,
      params,
    );
    return result.rows;
  });

  return rows.map((row) => ({
    movie: toSummary(row, settings.posterBaseUrl),
    score: row.score,
    similarity: row.similarity,
  }));
}
