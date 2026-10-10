import { z } from "zod";
import { CURATED_TAG_NAMES, GENRES } from "./catalog.js";

export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_OFFSET_MAX = 10_000;
export const SEARCH_QUERY_MAX_LENGTH = 200;

export const movieSummarySchema = z.object({
  id: z.number().int(),
  title: z.string(),
  overview: z.string(),
  releaseYear: z.number().int().nullable(),
  runtimeMinutes: z.number().int().nullable(),
  genres: z.array(z.string()),
  language: z.string().nullable(),
  /** TMDB's average rating, 0 to 10. */
  voteAverage: z.number().nullable(),
  voteCount: z.number().int(),
  posterUrl: z.string().nullable(),
});

export const movieDetailSchema = movieSummarySchema.extend({
  tmdbId: z.number().int(),
  imdbId: z.string().nullable(),
  tagline: z.string().nullable(),
  keywords: z.array(z.string()),
  /** Curated tags this movie has, most relevant first. */
  tags: z.array(z.object({ tag: z.string(), relevance: z.number() })),
});

export const searchResultSchema = z.object({
  movie: movieSummarySchema,
  score: z.number(),
});

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  /** How many movies match in total, across all pages. */
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export const genresResponseSchema = z.object({ genres: z.array(z.string()) });

export const tagsResponseSchema = z.object({
  tags: z.array(z.object({ tag: z.string(), group: z.enum(["plot", "mood"]) })),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  }),
});

// A list in a query string: "Action,Drama", or the parameter repeated.
function listOf(allowed: readonly string[], what: string) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : value.split(","))
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    )
    .superRefine((items, context) => {
      for (const item of items) {
        if (!allowed.includes(item)) {
          context.addIssue({ code: "custom", message: `Unknown ${what}: ${item}` });
        }
      }
    })
    .transform((items) => [...new Set(items)]);
}

const year = (name: string) =>
  z.coerce
    .number({ error: `${name} must be a year` })
    .int({ error: `${name} must be a year` })
    .min(1870, { error: `${name} must be 1870 or later` })
    .max(2100, { error: `${name} must be 2100 or earlier` });

/** Query parameters of GET /api/movies/search, as they arrive (all strings). */
export const searchQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(SEARCH_QUERY_MAX_LENGTH, {
        error: `q must be at most ${SEARCH_QUERY_MAX_LENGTH} characters`,
      })
      .optional(),
    /** A movie must have every genre listed. */
    genres: listOf(GENRES, "genre").default([]),
    /** A movie must have every curated tag listed. */
    tags: listOf(CURATED_TAG_NAMES, "tag").default([]),
    yearFrom: year("yearFrom").optional(),
    yearTo: year("yearTo").optional(),
    language: z
      .string()
      .regex(/^[a-z]{2}$/, { error: "language must be a two-letter code such as en or hi" })
      .optional(),
    minRating: z.coerce
      .number({ error: "minRating must be a number from 0 to 10" })
      .min(0, { error: "minRating must be a number from 0 to 10" })
      .max(10, { error: "minRating must be a number from 0 to 10" })
      .optional(),
    limit: z.coerce
      .number({ error: `limit must be a whole number from 1 to ${SEARCH_LIMIT_MAX}` })
      .int({ error: `limit must be a whole number from 1 to ${SEARCH_LIMIT_MAX}` })
      .min(1, { error: `limit must be a whole number from 1 to ${SEARCH_LIMIT_MAX}` })
      .max(SEARCH_LIMIT_MAX, {
        error: `limit must be a whole number from 1 to ${SEARCH_LIMIT_MAX}`,
      })
      .default(SEARCH_LIMIT_DEFAULT),
    offset: z.coerce
      .number({ error: `offset must be a whole number from 0 to ${SEARCH_OFFSET_MAX}` })
      .int({ error: `offset must be a whole number from 0 to ${SEARCH_OFFSET_MAX}` })
      .min(0, { error: `offset must be a whole number from 0 to ${SEARCH_OFFSET_MAX}` })
      .max(SEARCH_OFFSET_MAX, {
        error: `offset must be a whole number from 0 to ${SEARCH_OFFSET_MAX}`,
      })
      .default(0),
  })
  .refine(
    ({ yearFrom, yearTo }) => yearFrom === undefined || yearTo === undefined || yearFrom <= yearTo,
    { path: ["yearFrom"], error: "yearFrom must not be after yearTo" },
  );

export type MovieSummary = z.infer<typeof movieSummarySchema>;
export type MovieDetail = z.infer<typeof movieDetailSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
