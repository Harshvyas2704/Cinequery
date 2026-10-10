import { curatedTagOf } from "@cinequery/shared";
import type pg from "pg";
import type { MovieFacts } from "./checks.js";
import type { Tokens } from "./run.js";

const FACTS = `
  SELECT m.id, m.tmdb_id, m.title, m.release_year, m.runtime_minutes, m.language,
         m.vote_average::float8 AS vote_average, m.genres,
         coalesce(array_agg(t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}') AS genome_tags
  FROM movies m
  LEFT JOIN movie_tags t ON t.movie_id = m.id
  WHERE m.id = ANY($1::integer[])
  GROUP BY m.id
`;

/** Looks up what the checks need about the returned movies, straight from the database. */
export async function loadFacts(
  pool: Pick<pg.Pool, "query">,
  movieIds: number[],
): Promise<Map<number, MovieFacts>> {
  if (movieIds.length === 0) return new Map();
  const { rows } = await pool.query<{
    id: number;
    tmdb_id: number;
    title: string;
    release_year: number | null;
    runtime_minutes: number | null;
    language: string | null;
    vote_average: number | null;
    genres: string[];
    genome_tags: string[];
  }>(FACTS, [movieIds]);

  return new Map(
    rows.map((row) => [
      row.id,
      {
        tmdbId: row.tmdb_id,
        title: row.title,
        year: row.release_year,
        runtime: row.runtime_minutes,
        language: row.language,
        rating: row.vote_average,
        genres: row.genres,
        // movie_tags holds genome tags; the checks speak in curated tags (D-034).
        tags: [...new Set(row.genome_tags.flatMap((tag) => curatedTagOf(tag) ?? []))],
      },
    ]),
  );
}

/** The tokens of the LLM calls made for one request, including failed attempts. */
export async function loadTokens(pool: Pick<pg.Pool, "query">, requestId: string): Promise<Tokens> {
  const { rows } = await pool.query<Tokens>(
    `SELECT count(*)::integer AS calls,
            coalesce(sum(input_tokens), 0)::integer AS input,
            coalesce(sum(output_tokens), 0)::integer AS output
     FROM llm_calls WHERE request_id = $1`,
    [requestId],
  );
  return rows[0]!;
}
