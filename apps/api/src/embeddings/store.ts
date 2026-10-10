import type pg from "pg";
import {
  buildEmbeddingDocument,
  contentHash,
  type EmbeddingDocument,
  type EmbeddingSource,
  TOP_TAGS,
} from "./text.js";

type Queryable = Pick<pg.Pool, "query">;

export type EmbeddingTarget = { model: string; dimensions: number };

export type MovieToEmbed = {
  movieId: number;
  document: EmbeddingDocument;
  hash: string;
  /** False when the stored vector was made from this exact text, model and size. */
  needsEmbedding: boolean;
  voteCount: number;
};

// $1 model, $2 movie ids (null for every movie), $3 how many tags
const LOAD_SOURCES = `
  SELECT
    m.id, m.title, m.release_year, m.genres, m.keywords, m.tagline, m.overview, m.vote_count,
    coalesce(
      (SELECT array_agg(top.tag ORDER BY top.relevance DESC, top.tag)
       FROM (
         SELECT tag, relevance FROM movie_tags
         WHERE movie_id = m.id
         ORDER BY relevance DESC, tag
         LIMIT $3
       ) AS top),
      '{}'
    ) AS tags,
    e.content_hash AS stored_hash
  FROM movies m
  LEFT JOIN movie_embeddings e ON e.movie_id = m.id AND e.model = $1
  WHERE $2::integer[] IS NULL OR m.id = ANY($2::integer[])
  ORDER BY m.id
`;

/** Movies with the text they should be embedded from and whether that is already done. */
export async function loadMoviesToEmbed(
  db: Queryable,
  target: EmbeddingTarget,
  movieIds: number[] | null = null,
): Promise<MovieToEmbed[]> {
  const { rows } = await db.query<
    EmbeddingSource & { id: number; vote_count: number; stored_hash: string | null }
  >(
    LOAD_SOURCES,
    [target.model, movieIds, TOP_TAGS],
  );
  return rows.map((row) => {
    const document = buildEmbeddingDocument(row);
    const hash = contentHash(document, target.model, target.dimensions);
    return {
      movieId: row.id,
      document,
      hash,
      needsEmbedding: row.stored_hash !== hash,
      voteCount: row.vote_count,
    };
  });
}

/** Writes a batch of vectors in one statement, so a batch is stored whole or not at all. */
export async function saveEmbeddings(
  db: Queryable,
  model: string,
  rows: { movieId: number; hash: string; vector: number[] }[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO movie_embeddings (movie_id, model, content_hash, embedding)
     SELECT t.movie_id, $1, t.content_hash, t.embedding::vector
     FROM unnest($2::integer[], $3::text[], $4::text[]) AS t (movie_id, content_hash, embedding)
     ON CONFLICT (movie_id, model) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       embedding = EXCLUDED.embedding,
       created_at = now()`,
    [
      model,
      rows.map((row) => row.movieId),
      rows.map((row) => row.hash),
      rows.map((row) => `[${row.vector.join(",")}]`),
    ],
  );
}

/** The size of the embedding column, e.g. 768 for vector(768). */
export async function embeddingColumnDimensions(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ dimensions: number }>(
    `SELECT atttypmod AS dimensions FROM pg_attribute
     WHERE attrelid = 'movie_embeddings'::regclass AND attname = 'embedding'`,
  );
  return rows[0]?.dimensions ?? 0;
}

export async function assertDimensionsMatch(db: Queryable, configured: number): Promise<void> {
  const column = await embeddingColumnDimensions(db);
  if (column !== configured) {
    throw new Error(
      `EMBEDDING_DIMENSIONS is ${configured} but movie_embeddings.embedding is vector(${column}). ` +
        "They must match; changing the size needs a migration and a full re-embed (D-021).",
    );
  }
}

export async function embeddingCoverage(
  db: Queryable,
  model: string,
): Promise<{ movies: number; embedded: number }> {
  const { rows } = await db.query<{ movies: number; embedded: number }>(
    `SELECT (SELECT count(*)::integer FROM movies) AS movies,
            (SELECT count(*)::integer FROM movie_embeddings WHERE model = $1) AS embedded`,
    [model],
  );
  return rows[0] ?? { movies: 0, embedded: 0 };
}
