import {
  curatedTagOf,
  type MovieDetail,
  type MovieSummary,
  type SearchResponse,
  type SearchResult,
} from "@cinequery/shared";
import type pg from "pg";
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

export type SearchWeights = { text: number; tags: number; rating: number };

export type SearchSettings = {
  weights: SearchWeights;
  /** Prefix for poster_path, for example https://image.tmdb.org/t/p/w342 */
  posterBaseUrl: string;
};

/** A keyword search: free text, filters, and curated tags. */
export type KeywordSearch = {
  q?: string;
  filters: MovieFilters;
  tags: string[];
  /**
   * "require": a movie must have every tag (the filter page).
   * "boost": tags only raise the score, so untagged movies can still appear.
   */
  tagMode: "require" | "boost";
  limit: number;
  offset: number;
};

type Queryable = Pick<pg.Pool, "query">;

export type SummaryRow = {
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

export const SUMMARY_COLUMNS = `
  m.id, m.title, m.overview, m.release_year, m.runtime_minutes, m.genres, m.language,
  m.vote_average::float8 AS vote_average, m.vote_count, m.poster_path`;

export function toSummary(row: SummaryRow, posterBaseUrl: string): MovieSummary {
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

// Parameters after the filters ($1 to $10, see filters.ts):
const P = FILTER_PARAMS;
const GENOME = P + 1; // genome tags of the wanted curated tags
const CURATED = P + 2; // the curated tag of each
const TAG_COUNT = P + 3; // number of wanted curated tags
const REQUIRE_TAGS = P + 4; // true: a movie must have all of them
const Q = P + 5; // the text, or null
const W_TEXT = P + 6;
const W_TAGS = P + 7;
const W_RATING = P + 8;
const LIMIT = P + 9;
const OFFSET = P + 10;

// The words of the request joined with OR: a movie matching more of them, and
// closer together, ranks higher (D-038). plainto_tsquery drops punctuation and
// stop words, so the user's text can never change the query's structure.
const TSQUERY = `replace(plainto_tsquery('english', $${Q})::text, '&', '|')::tsquery`;
// True when there is no text to search for: no q, or only stop words ("the").
const NO_TEXT = `coalesce(numnode(${TSQUERY}), 0) = 0`;

// The ranking formula is explained in docs/ARCHITECTURE.md.
const SEARCH = `
  WITH ${STATS_CTE},
  ${tagScoreCte(GENOME, CURATED, TAG_COUNT)},
  matched AS (
    SELECT
      m.id,
      m.vote_count,
      -- 0 to 1: flag 32 makes ts_rank_cd return rank / (rank + 1).
      CASE WHEN ${NO_TEXT} THEN 0 ELSE ts_rank_cd(m.search_tsv, ${TSQUERY}, 32) END::float8
        AS text_score,
      coalesce(tagged.tag_score, 0) AS tag_score,
      ${RATING_SCORE} AS rating_score
    FROM movies m
    LEFT JOIN stats ON true
    LEFT JOIN tagged ON tagged.movie_id = m.id
    WHERE (CASE WHEN ${NO_TEXT} THEN true ELSE m.search_tsv @@ ${TSQUERY} END)
      AND ${FILTER_CONDITIONS}
      AND (NOT $${REQUIRE_TAGS}::boolean OR $${TAG_COUNT}::integer = 0
           OR tagged.matched = $${TAG_COUNT}::integer)
  ),
  scored AS (
    SELECT
      id,
      vote_count,
      $${W_TEXT}::float8 * text_score + $${W_TAGS}::float8 * tag_score
        + $${W_RATING}::float8 * rating_score AS score
    FROM matched
  ),
  page AS (
    SELECT id, score, vote_count
    FROM scored
    ORDER BY score DESC, vote_count DESC, id
    LIMIT $${LIMIT} OFFSET $${OFFSET}
  )
  -- Always at least one row, so the total is known even for an empty page.
  SELECT totals.total, page.score, ${SUMMARY_COLUMNS}
  FROM (SELECT count(*)::integer AS total FROM scored) AS totals
  LEFT JOIN page ON true
  LEFT JOIN movies m ON m.id = page.id
  ORDER BY page.score DESC, page.vote_count DESC, page.id
`;

export function searchParams(search: KeywordSearch, weights: SearchWeights): unknown[] {
  const { genome, curated } = genomeTagsOf(search.tags);
  return [
    ...filterParams(search.filters),
    genome,
    curated,
    search.tags.length,
    search.tagMode === "require",
    search.q || null,
    weights.text,
    weights.tags,
    weights.rating,
    search.limit,
    search.offset,
  ];
}

export const SEARCH_SQL = SEARCH;

export async function searchMovies(
  db: Queryable,
  search: KeywordSearch,
  settings: SearchSettings,
): Promise<SearchResponse> {
  const { rows } = await db.query<SummaryRow & { total: number; score: number | null }>(
    SEARCH,
    searchParams(search, settings.weights),
  );
  const results: SearchResult[] = rows
    .filter((row) => row.id !== null)
    .map((row) => ({ movie: toSummary(row, settings.posterBaseUrl), score: row.score ?? 0 }));
  return { results, total: rows[0]?.total ?? 0, limit: search.limit, offset: search.offset };
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
