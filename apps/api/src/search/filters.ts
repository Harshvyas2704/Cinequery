import { findCuratedTag } from "@cinequery/shared";

/** Facts a movie must satisfy. Empty arrays and undefined mean "no restriction". */
export type MovieFilters = {
  /** The movie must have every one of these genres (or, with anyGenre, at least one). */
  genres: string[];
  /** True: one of `genres` is enough. */
  anyGenre?: boolean;
  /** The movie must have none of these genres. */
  excludeGenres: string[];
  yearFrom?: number;
  yearTo?: number;
  maxRuntime?: number;
  language?: string;
  minRating?: number;
  /** Curated tags the movie must not have. */
  excludeTags: string[];
  /** Movies to leave out, by id (for example the film a request says "like"). */
  excludeIds: number[];
};

export const NO_FILTERS: MovieFilters = {
  genres: [],
  excludeGenres: [],
  excludeTags: [],
  excludeIds: [],
};

/** The genome tags behind curated tags, as two parallel arrays for unnest(). */
export function genomeTagsOf(curatedNames: string[]): { genome: string[]; curated: string[] } {
  const genome: string[] = [];
  const curated: string[] = [];
  for (const name of curatedNames) {
    for (const genomeTag of findCuratedTag(name)?.genomeTags ?? []) {
      genome.push(genomeTag);
      curated.push(name);
    }
  }
  return { genome, curated };
}

// The filter conditions on `movies m`, shared by keyword and vector search.
// They always use parameters $1 to $10; each query's own parameters come after.
//
// Optional filters are written as "$n IS NULL OR ...". The values are known
// when Postgres plans the query, so unused filters disappear and the rest can
// use their indexes.
export const FILTER_PARAMS = 10;
export const FILTER_CONDITIONS = `
        ($1::text[] IS NULL
         OR CASE WHEN $10::boolean THEN m.genres && $1::text[] ELSE m.genres @> $1::text[] END)
    AND ($2::text[] IS NULL OR NOT m.genres && $2::text[])
    AND ($3::integer IS NULL OR m.release_year >= $3::integer)
    AND ($4::integer IS NULL OR m.release_year <= $4::integer)
    AND ($5::integer IS NULL OR m.runtime_minutes <= $5::integer)
    AND ($6::text IS NULL OR m.language = $6::text)
    AND ($7::numeric IS NULL OR m.vote_average >= $7::numeric)
    AND ($8::text[] IS NULL OR NOT EXISTS (
          SELECT 1 FROM movie_tags excluded
          WHERE excluded.movie_id = m.id AND excluded.tag = ANY($8::text[])
        ))
    AND ($9::integer[] IS NULL OR m.id <> ALL($9::integer[]))`;

const orNull = <T>(list: T[]) => (list.length > 0 ? list : null);

export function filterParams(filters: MovieFilters): unknown[] {
  return [
    orNull(filters.genres),
    orNull(filters.excludeGenres),
    filters.yearFrom ?? null,
    filters.yearTo ?? null,
    filters.maxRuntime ?? null,
    filters.language ?? null,
    filters.minRating ?? null,
    orNull(genomeTagsOf(filters.excludeTags).genome),
    orNull(filters.excludeIds),
    filters.anyGenre ?? false,
  ];
}

// How well each movie matches the wanted curated tags. Uses three parameters,
// numbered by the caller: genome tags, their curated tags, number of curated tags.
//   matched    how many of the wanted curated tags the movie has
//   tag_score  0 to 1: the best relevance per wanted tag, averaged over ALL
//              wanted tags, so a missing tag counts as 0
export function tagScoreCte(genomeParam: number, curatedParam: number, countParam: number): string {
  return `
  wanted AS (
    SELECT * FROM unnest($${genomeParam}::text[], $${curatedParam}::text[]) AS w (genome_tag, curated_tag)
  ),
  tagged AS (
    SELECT movie_id, count(*) AS matched, (sum(best) / $${countParam}::integer)::float8 AS tag_score
    FROM (
      SELECT movie_tags.movie_id, wanted.curated_tag, max(movie_tags.relevance) AS best
      FROM movie_tags
      JOIN wanted ON wanted.genome_tag = movie_tags.tag
      GROUP BY movie_tags.movie_id, wanted.curated_tag
    ) AS per_tag
    GROUP BY movie_id
  )`;
}

/** The weighted (Bayesian) rating divided by 10, from `movies m` and `stats`. */
export const RATING_SCORE = `
      CASE
        WHEN m.vote_count + coalesce(stats.m, 0) = 0 THEN 0
        ELSE (
          m.vote_count * coalesce(m.vote_average, stats.c, 0)
          + coalesce(stats.m, 0) * coalesce(stats.c, 0)
        ) / (m.vote_count + coalesce(stats.m, 0)) / 10
      END::float8`;

export const STATS_CTE = `
  stats AS (
    SELECT mean_vote_average AS c, min_votes AS m FROM rating_stats
  )`;
