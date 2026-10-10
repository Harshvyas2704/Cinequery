import { z } from "zod";

// One row of data/clean/movies.parquet (PLAN.md 5.3). The files are our own
// output, but a schema here turns a changed column into a clear error.
export const movieRowSchema = z.object({
  tmdb_id: z.number().int().positive(),
  title: z.string().min(1),
  overview: z.string().min(1),
  tagline: z.string().nullable(),
  genres: z.string(),
  keywords: z.string().nullable(),
  release_year: z.number().int().nullable(),
  runtime_minutes: z.number().int().positive().nullable(),
  language: z.string().min(1),
  vote_average: z.number(),
  vote_count: z.number().int().nonnegative(),
  popularity: z.number(),
  poster_path: z.string().nullable(),
  imdb_id: z.string().nullable(),
});

// One row of data/clean/movie_tags.parquet.
export const tagRowSchema = z.object({
  tmdb_id: z.number().int().positive(),
  tag: z.string().min(1),
  relevance: z.number().min(0).max(1),
});

export type MovieRow = z.infer<typeof movieRowSchema>;
export type TagRow = z.infer<typeof tagRowSchema>;

/** A movie as it is written to the movies table. */
export type Movie = Omit<MovieRow, "genres" | "keywords"> & {
  genres: string[];
  keywords: string[];
};

export type MovieTag = { tag: string; relevance: number };

/** "Action,  Science Fiction, , Action" -> ["Action", "Science Fiction"] */
export function splitList(value: string | null | undefined): string[] {
  if (!value) return [];
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return [...new Set(items)];
}

export function toMovie(row: MovieRow): Movie {
  return { ...row, genres: splitList(row.genres), keywords: splitList(row.keywords) };
}

/** Groups tag rows by movie. A tag listed twice for a movie keeps its highest relevance. */
export function groupTags(rows: TagRow[]): Map<number, MovieTag[]> {
  const byMovie = new Map<number, Map<string, number>>();
  for (const { tmdb_id, tag, relevance } of rows) {
    let tags = byMovie.get(tmdb_id);
    if (!tags) byMovie.set(tmdb_id, (tags = new Map()));
    tags.set(tag, Math.max(relevance, tags.get(tag) ?? 0));
  }
  return new Map(
    [...byMovie].map(([tmdbId, tags]) => [
      tmdbId,
      [...tags].map(([tag, relevance]) => ({ tag, relevance })),
    ]),
  );
}
