import { CURATED_TAG_NAMES, GENRES, LANGUAGE_CODES, RECOMMEND_LIMIT_MAX } from "@cinequery/shared";
import { z } from "zod";

// The shape of eval/queries.json. Every check is something a program can
// decide from the database row of a returned movie, so a run needs no human
// judgement and two runs can be compared.

const genres = z.array(z.enum(GENRES));
const movieRef = z.strictObject({
  tmdbId: z.number().int().positive(),
  /** Only for the reader; the id is what is compared. */
  title: z.string(),
});

export const checksSchema = z.strictObject({
  // Constraints: each returned movie either passes all of them or fails.
  /** The movie has every one of these genres. */
  genresInclude: genres.optional(),
  /** The movie has at least one of these genres. */
  genresAny: genres.optional(),
  /** The movie has none of these genres. */
  genresExclude: genres.optional(),
  minYear: z.number().int().optional(),
  maxYear: z.number().int().optional(),
  maxRuntime: z.number().int().positive().optional(),
  /** ISO 639-1 code of the original language. */
  language: z.enum(LANGUAGE_CODES as [string, ...string[]]).optional(),
  /** TMDB average rating, 0 to 10. */
  minRating: z.number().min(0).max(10).optional(),
  /** None of these movies may be returned ("like Inception" must not return Inception). */
  noneOfMovies: z.array(movieRef).optional(),

  // Relevance.
  /** Curated tags; a returned movie matches if it has at least one. */
  tagsAny: z.array(z.enum(CURATED_TAG_NAMES as [string, ...string[]])).optional(),
  /** Movies a good answer would contain; the query is a "hit" if at least one is returned. */
  anyOfMovies: z.array(movieRef).optional(),

  /** Phrases that would give an ending away, in addition to the file's defaults. */
  noSpoilerWords: z.array(z.string().min(3)).optional(),
});

export const evalQuerySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  query: z.string().min(3),
  /** Why the query is in the set. */
  note: z.string().optional(),
  checks: checksSchema,
});

export const evalFileSchema = z
  .strictObject({
    /** How many movies each query asks for. */
    limit: z.number().int().min(1).max(RECOMMEND_LIMIT_MAX),
    /** Phrases checked in every reason. */
    noSpoilerWords: z.array(z.string().min(3)),
    queries: z.array(evalQuerySchema).min(1),
  })
  .refine((file) => new Set(file.queries.map((query) => query.id)).size === file.queries.length, {
    error: "query ids must be unique",
  });

export type Checks = z.infer<typeof checksSchema>;
export type EvalQuery = z.infer<typeof evalQuerySchema>;
export type EvalFile = z.infer<typeof evalFileSchema>;

export const EVAL_MODES = ["fulltext", "semantic", "parsed", "full"] as const;
export type EvalMode = (typeof EVAL_MODES)[number];
