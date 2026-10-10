import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import type { Movie, MovieTag } from "./transform.js";

export type IngestInput = {
  movies: Movie[];
  /** Genome tags by tmdb_id. A movie that is not in this map ends up with no genome tags. */
  tagsByTmdbId: Map<number, MovieTag[]>;
  batchSize: number;
  /** Percentile of vote_count (0 to 1) used as m in the weighted rating. */
  minVotesPercentile: number;
};

export type IngestSummary = {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Genome tags that belong to the movies in the file. */
  tags: number;
  tagsWritten: number;
  tagsRemoved: number;
  /** Tags in the tags file whose movie is not in the movies file. */
  tagsSkipped: number;
  ratingStats: { meanVoteAverage: number; minVotes: number } | null;
};

// Insert new movies and update the ones whose data changed. A row whose values
// are all the same is left alone, so it is not rewritten and keeps updated_at.
// RETURNING only lists rows that were written; xmax = 0 marks a fresh insert.
const UPSERT_MOVIES = `
  INSERT INTO movies (
    tmdb_id, title, overview, tagline, genres, keywords, release_year,
    runtime_minutes, language, vote_average, vote_count, popularity, poster_path, imdb_id
  )
  SELECT
    tmdb_id, title, overview, tagline, genres, keywords, release_year,
    runtime_minutes, language, vote_average, vote_count, popularity, poster_path, imdb_id
  FROM jsonb_to_recordset($1::jsonb) AS incoming (
    tmdb_id integer, title text, overview text, tagline text, genres text[], keywords text[],
    release_year integer, runtime_minutes integer, language text, vote_average numeric,
    vote_count integer, popularity numeric, poster_path text, imdb_id text
  )
  ON CONFLICT (tmdb_id) DO UPDATE SET
    title = EXCLUDED.title,
    overview = EXCLUDED.overview,
    tagline = EXCLUDED.tagline,
    genres = EXCLUDED.genres,
    keywords = EXCLUDED.keywords,
    release_year = EXCLUDED.release_year,
    runtime_minutes = EXCLUDED.runtime_minutes,
    language = EXCLUDED.language,
    vote_average = EXCLUDED.vote_average,
    vote_count = EXCLUDED.vote_count,
    popularity = EXCLUDED.popularity,
    poster_path = EXCLUDED.poster_path,
    imdb_id = EXCLUDED.imdb_id,
    updated_at = now()
  WHERE (
    movies.title, movies.overview, movies.tagline, movies.genres, movies.keywords,
    movies.release_year, movies.runtime_minutes, movies.language, movies.vote_average,
    movies.vote_count, movies.popularity, movies.poster_path, movies.imdb_id
  ) IS DISTINCT FROM (
    EXCLUDED.title, EXCLUDED.overview, EXCLUDED.tagline, EXCLUDED.genres, EXCLUDED.keywords,
    EXCLUDED.release_year, EXCLUDED.runtime_minutes, EXCLUDED.language, EXCLUDED.vote_average,
    EXCLUDED.vote_count, EXCLUDED.popularity, EXCLUDED.poster_path, EXCLUDED.imdb_id
  )
  RETURNING (xmax = 0) AS inserted
`;

// Makes the genome tags of the batch's movies equal to the incoming ones: tags
// that are gone are deleted, new or changed ones are written, equal ones are
// left alone. Tags from another source ('llm', Phase 10) are not deleted.
//   $1 tmdb_ids of the batch, $2 to $4 parallel arrays: tmdb_id, tag, relevance
const REPLACE_TAGS = `
  WITH incoming AS (
    SELECT movies.id AS movie_id, t.tag, t.relevance
    FROM unnest($2::integer[], $3::text[], $4::real[]) AS t (tmdb_id, tag, relevance)
    JOIN movies ON movies.tmdb_id = t.tmdb_id
  ),
  removed AS (
    DELETE FROM movie_tags
    USING movies
    WHERE movies.id = movie_tags.movie_id
      AND movies.tmdb_id = ANY($1::integer[])
      AND movie_tags.source = 'genome'
      AND NOT EXISTS (
        SELECT 1 FROM incoming
        WHERE incoming.movie_id = movie_tags.movie_id AND incoming.tag = movie_tags.tag
      )
    RETURNING 1
  ),
  written AS (
    INSERT INTO movie_tags (movie_id, tag, relevance, source)
    SELECT movie_id, tag, relevance, 'genome' FROM incoming
    ON CONFLICT (movie_id, tag) DO UPDATE SET
      relevance = EXCLUDED.relevance,
      source = EXCLUDED.source
    WHERE (movie_tags.relevance, movie_tags.source) IS DISTINCT FROM (EXCLUDED.relevance, EXCLUDED.source)
    RETURNING 1
  )
  SELECT (SELECT count(*)::integer FROM removed) AS removed,
         (SELECT count(*)::integer FROM written) AS written
`;

// C is the mean rating of the catalog, m a percentile of its vote counts.
const COMPUTE_RATING_STATS = `
  INSERT INTO rating_stats (id, mean_vote_average, min_votes, computed_at)
  SELECT true,
         avg(vote_average),
         percentile_cont($1) WITHIN GROUP (ORDER BY vote_count)::integer,
         now()
  FROM movies
  HAVING count(vote_average) > 0
  ON CONFLICT (id) DO UPDATE SET
    mean_vote_average = EXCLUDED.mean_vote_average,
    min_votes = EXCLUDED.min_votes,
    computed_at = EXCLUDED.computed_at
  RETURNING mean_vote_average::float8 AS "meanVoteAverage", min_votes AS "minVotes"
`;

// Postgres text cannot hold the NUL character, and jsonb rejects it.
const stripNul = (_key: string, value: unknown) =>
  typeof value === "string" ? value.replaceAll("\u0000", "") : value;

/**
 * Loads movies and their genome tags. Each batch is one transaction, so a
 * failure leaves earlier batches in place and the run can simply be repeated.
 */
export async function ingest(pool: pg.Pool, input: IngestInput): Promise<IngestSummary> {
  const { movies, tagsByTmdbId, batchSize, minVotesPercentile } = input;
  const summary: IngestSummary = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    tags: 0,
    tagsWritten: 0,
    tagsRemoved: 0,
    tagsSkipped: 0,
    ratingStats: null,
  };

  const inFile = new Set(movies.map((movie) => movie.tmdb_id));
  for (const [tmdbId, tags] of tagsByTmdbId) {
    if (!inFile.has(tmdbId)) summary.tagsSkipped += tags.length;
  }

  for (let start = 0; start < movies.length; start += batchSize) {
    const batch = movies.slice(start, start + batchSize);
    const tmdbIds: number[] = [];
    const tagNames: string[] = [];
    const relevances: number[] = [];
    for (const movie of batch) {
      for (const { tag, relevance } of tagsByTmdbId.get(movie.tmdb_id) ?? []) {
        tmdbIds.push(movie.tmdb_id);
        tagNames.push(tag);
        relevances.push(relevance);
      }
    }

    await withTransaction(pool, async (client) => {
      const written = await client.query<{ inserted: boolean }>(UPSERT_MOVIES, [
        JSON.stringify(batch, stripNul),
      ]);
      const inserted = written.rows.filter((row) => row.inserted).length;
      summary.inserted += inserted;
      summary.updated += written.rows.length - inserted;
      summary.unchanged += batch.length - written.rows.length;

      const tags = await client.query<{ removed: number; written: number }>(REPLACE_TAGS, [
        batch.map((movie) => movie.tmdb_id),
        tmdbIds,
        tagNames,
        relevances,
      ]);
      summary.tags += tagNames.length;
      summary.tagsWritten += tags.rows[0]?.written ?? 0;
      summary.tagsRemoved += tags.rows[0]?.removed ?? 0;
    });
  }

  const stats = await pool.query<{ meanVoteAverage: number; minVotes: number }>(
    COMPUTE_RATING_STATS,
    [minVotesPercentile],
  );
  summary.ratingStats = stats.rows[0] ?? null;
  return summary;
}
