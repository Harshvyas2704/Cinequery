import {
  type CuratedTag,
  curatedTagOf,
  findCuratedTag,
  type MovieDetail,
  type MovieSummary,
  type SearchQuery,
  type SearchResponse,
} from "@cinequery/shared";
import type pg from "pg";

export type SearchWeights = { text: number; tags: number; rating: number };

export type SearchSettings = {
  weights: SearchWeights;
  /** Prefix for poster_path, for example https://image.tmdb.org/t/p/w342 */
  posterBaseUrl: string;
};

type Queryable = Pick<pg.Pool, "query">;

type SummaryRow = {
  id: number;
  title: string;
  overview: string;
  release_year: number | null;
  runtime_minutes: number | null;
  genres: string[];
  language: string | null;
  vote_average: number | null;
  vote_count: number;
  poster_path: string | null;
};

const SUMMARY_COLUMNS = `
  m.id, m.title, m.overview, m.release_year, m.runtime_minutes, m.genres, m.language,
  m.vote_average::float8 AS vote_average, m.vote_count, m.poster_path`;

function toSummary(row: SummaryRow, posterBaseUrl: string): MovieSummary {
  return {
    id: row.id,
    title: row.title,
    overview: row.overview,
    releaseYear: row.release_year,
    runtimeMinutes: row.runtime_minutes,
    genres: row.genres,
    language: row.language,
    voteAverage: row.vote_average,
    voteCount: row.vote_count,
    posterUrl: row.poster_path ? `${posterBaseUrl}${row.poster_path}` : null,
  };
}

// The words of the request joined with OR: a movie matching more of them, and
// closer together, ranks higher (D-038). plainto_tsquery drops punctuation and
// stop words, so the user's text can never change the query's structure.
const TSQUERY = `replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery`;
// True when there is no text to search for: no q, or only stop words ("the").
const NO_TEXT = `coalesce(numnode(${TSQUERY}), 0) = 0`;

// The ranking formula is explained in docs/ARCHITECTURE.md. Parameters:
//   $1 q (or null)            $2 genres (or null)        $3 yearFrom   $4 yearTo
//   $5 language               $6 minRating               $7 genome tags
//   $8 their curated tags     $9 number of curated tags requested
//   $10 to $12 weights: text, tags, rating               $13 limit     $14 offset
//
// Optional filters are written as "$n IS NULL OR ...". The parameters are known
// when Postgres plans the query, so unused filters disappear and the rest can
// use their indexes.
const SEARCH = `
  WITH stats AS (
    SELECT mean_vote_average AS c, min_votes AS m FROM rating_stats
  ),
  wanted AS (
    SELECT * FROM unnest($7::text[], $8::text[]) AS w (genome_tag, curated_tag)
  ),
  -- Movies that have every requested curated tag. A curated tag's relevance is
  -- the best of its genome tags; tag_score is the average over the requested tags.
  tagged AS (
    SELECT movie_id, avg(best)::float8 AS tag_score
    FROM (
      SELECT movie_tags.movie_id, wanted.curated_tag, max(movie_tags.relevance) AS best
      FROM movie_tags
      JOIN wanted ON wanted.genome_tag = movie_tags.tag
      GROUP BY movie_tags.movie_id, wanted.curated_tag
    ) AS per_tag
    GROUP BY movie_id
    HAVING count(*) = $9::integer
  ),
  matched AS (
    SELECT
      m.id,
      m.vote_count,
      -- 0 to 1: flag 32 makes ts_rank_cd return rank / (rank + 1).
      CASE WHEN ${NO_TEXT} THEN 0 ELSE ts_rank_cd(m.search_tsv, ${TSQUERY}, 32) END::float8
        AS text_score,
      coalesce(tagged.tag_score, 0) AS tag_score,
      -- 0 to 1: the weighted (Bayesian) rating divided by 10.
      CASE
        WHEN m.vote_count + coalesce(stats.m, 0) = 0 THEN 0
        ELSE (
          m.vote_count * coalesce(m.vote_average, stats.c, 0)
          + coalesce(stats.m, 0) * coalesce(stats.c, 0)
        ) / (m.vote_count + coalesce(stats.m, 0)) / 10
      END::float8 AS rating_score
    FROM movies m
    LEFT JOIN stats ON true
    LEFT JOIN tagged ON tagged.movie_id = m.id
    WHERE (CASE WHEN ${NO_TEXT} THEN true ELSE m.search_tsv @@ ${TSQUERY} END)
      AND ($2::text[] IS NULL OR m.genres @> $2::text[])
      AND ($3::integer IS NULL OR m.release_year >= $3::integer)
      AND ($4::integer IS NULL OR m.release_year <= $4::integer)
      AND ($5::text IS NULL OR m.language = $5::text)
      AND ($6::numeric IS NULL OR m.vote_average >= $6::numeric)
      AND ($9::integer = 0 OR tagged.movie_id IS NOT NULL)
  ),
  scored AS (
    SELECT
      id,
      vote_count,
      $10::float8 * text_score + $11::float8 * tag_score + $12::float8 * rating_score AS score
    FROM matched
  ),
  page AS (
    SELECT id, score, vote_count
    FROM scored
    ORDER BY score DESC, vote_count DESC, id
    LIMIT $13 OFFSET $14
  )
  -- Always at least one row, so the total is known even for an empty page.
  SELECT totals.total, page.score, ${SUMMARY_COLUMNS}
  FROM (SELECT count(*)::integer AS total FROM scored) AS totals
  LEFT JOIN page ON true
  LEFT JOIN movies m ON m.id = page.id
  ORDER BY page.score DESC, page.vote_count DESC, page.id
`;

function genomeTagsOf(curatedNames: string[]): { genome: string[]; curated: string[] } {
  const genome: string[] = [];
  const curated: string[] = [];
  for (const name of curatedNames) {
    const tag: CuratedTag | undefined = findCuratedTag(name);
    for (const genomeTag of tag?.genomeTags ?? []) {
      genome.push(genomeTag);
      curated.push(name);
    }
  }
  return { genome, curated };
}

export function searchParams(query: SearchQuery, weights: SearchWeights): unknown[] {
  const { genome, curated } = genomeTagsOf(query.tags);
  return [
    query.q || null,
    query.genres.length > 0 ? query.genres : null,
    query.yearFrom ?? null,
    query.yearTo ?? null,
    query.language ?? null,
    query.minRating ?? null,
    genome,
    curated,
    query.tags.length,
    weights.text,
    weights.tags,
    weights.rating,
    query.limit,
    query.offset,
  ];
}

export const SEARCH_SQL = SEARCH;

export async function searchMovies(
  db: Queryable,
  query: SearchQuery,
  settings: SearchSettings,
): Promise<SearchResponse> {
  const { rows } = await db.query<SummaryRow & { total: number; score: number | null }>(
    SEARCH,
    searchParams(query, settings.weights),
  );
  return {
    results: rows
      .filter((row) => row.id !== null)
      .map((row) => ({ movie: toSummary(row, settings.posterBaseUrl), score: row.score ?? 0 })),
    total: rows[0]?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

type DetailRow = SummaryRow & {
  tmdb_id: number;
  imdb_id: string | null;
  tagline: string | null;
  keywords: string[];
  tags: { tag: string; relevance: number }[];
};

const GET_MOVIE = `
  SELECT ${SUMMARY_COLUMNS}, m.tmdb_id, m.imdb_id, m.tagline, m.keywords,
    coalesce(
      (SELECT json_agg(json_build_object('tag', tag, 'relevance', relevance) ORDER BY relevance DESC, tag)
       FROM movie_tags WHERE movie_id = m.id),
      '[]'
    ) AS tags
  FROM movies m
  WHERE m.id = $1
`;

export async function getMovie(
  db: Queryable,
  id: number,
  settings: Pick<SearchSettings, "posterBaseUrl">,
): Promise<MovieDetail | null> {
  const { rows } = await db.query<DetailRow>(GET_MOVIE, [id]);
  const row = rows[0];
  if (!row) return null;

  // Genome tags become curated tags; a curated tag keeps its best relevance.
  const best = new Map<string, number>();
  for (const { tag, relevance } of row.tags) {
    const curated = curatedTagOf(tag);
    if (curated) best.set(curated, Math.max(relevance, best.get(curated) ?? 0));
  }

  return {
    ...toSummary(row, settings.posterBaseUrl),
    tmdbId: row.tmdb_id,
    imdbId: row.imdb_id,
    tagline: row.tagline,
    keywords: row.keywords,
    tags: [...best]
      .map(([tag, relevance]) => ({ tag, relevance: Math.round(relevance * 100) / 100 }))
      .sort((a, b) => b.relevance - a.relevance || a.tag.localeCompare(b.tag)),
  };
}
