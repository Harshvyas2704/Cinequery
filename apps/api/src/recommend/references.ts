import type pg from "pg";

export type ReferenceMovie = {
  id: number;
  title: string;
  /** Null when the movie has no embedding (yet). */
  vector: number[] | null;
};

// The movie whose title is closest to what was typed. An exact match (ignoring
// case) has similarity 1 and so comes first; among equals, the best-known wins.
// The % operator is what uses the trigram index.
//   $1 title   $2 embedding model   $3 minimum similarity, 0 to 1
const FIND_BY_TITLE = `
  SELECT m.id, m.title, e.embedding::real[] AS vector
  FROM movies m
  LEFT JOIN movie_embeddings e ON e.movie_id = m.id AND e.model = $2
  WHERE lower(m.title) % lower($1)
    AND similarity(lower(m.title), lower($1)) >= $3
  ORDER BY similarity(lower(m.title), lower($1)) DESC, m.vote_count DESC, m.id
  LIMIT 1
`;

/** Looks up the films a request names ("like Inception"). Titles that match nothing are dropped. */
export async function findReferenceMovies(
  db: Pick<pg.Pool, "query">,
  titles: string[],
  options: { model: string; minSimilarity: number },
): Promise<ReferenceMovie[]> {
  const found = await Promise.all(
    titles.map(async (title) => {
      const { rows } = await db.query<ReferenceMovie>(FIND_BY_TITLE, [
        title,
        options.model,
        options.minSimilarity,
      ]);
      return rows[0];
    }),
  );
  const unique = new Map(found.filter((movie) => movie !== undefined).map((movie) => [movie.id, movie]));
  return [...unique.values()];
}

/**
 * Moves the query vector toward the reference films:
 *   (1 - weight) * query + weight * average(references), scaled back to length 1.
 * With no reference vectors the query is returned unchanged.
 */
export function blendVectors(query: number[], references: number[][], weight: number): number[] {
  if (references.length === 0 || weight <= 0) return query;
  const blended = query.map((value, index) => {
    const average =
      references.reduce((sum, reference) => sum + (reference[index] ?? 0), 0) / references.length;
    return (1 - weight) * value + weight * average;
  });
  const length = Math.hypot(...blended);
  return length === 0 ? query : blended.map((value) => value / length);
}
