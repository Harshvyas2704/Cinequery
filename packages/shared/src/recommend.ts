import { z } from "zod";
import { movieSummarySchema } from "./movies.js";

export const RECOMMEND_QUERY_MIN_LENGTH = 3;
export const RECOMMEND_QUERY_MAX_LENGTH = 300;
export const RECOMMEND_LIMIT_MAX = 20;
export const RECOMMEND_LIMIT_DEFAULT = 8;
/** A reason is one sentence of at most 25 words; anything longer is cut. */
export const RECOMMEND_WHY_MAX_LENGTH = 240;

/** Body of POST /api/recommend. */
export const recommendRequestSchema = z.object({
  query: z
    .string({ error: "query must be text" })
    .trim()
    .min(RECOMMEND_QUERY_MIN_LENGTH, {
      error: `query must be at least ${RECOMMEND_QUERY_MIN_LENGTH} characters`,
    })
    .max(RECOMMEND_QUERY_MAX_LENGTH, {
      error: `query must be at most ${RECOMMEND_QUERY_MAX_LENGTH} characters`,
    }),
  limit: z
    .number({ error: `limit must be a whole number from 1 to ${RECOMMEND_LIMIT_MAX}` })
    .int({ error: `limit must be a whole number from 1 to ${RECOMMEND_LIMIT_MAX}` })
    .min(1, { error: `limit must be a whole number from 1 to ${RECOMMEND_LIMIT_MAX}` })
    .max(RECOMMEND_LIMIT_MAX, {
      error: `limit must be a whole number from 1 to ${RECOMMEND_LIMIT_MAX}`,
    })
    .default(RECOMMEND_LIMIT_DEFAULT),
});

/**
 * How one step of answering a request went:
 *   ok        it ran and its result was used
 *   fallback  it failed (or had nothing to give) and a simpler method was used instead
 *   skipped   it was not attempted, for example because no API key is configured
 *   error     it failed and nothing replaced it
 */
export const stageStatusSchema = z.enum(["ok", "skipped", "fallback", "error"]);

export const stageSchema = z.object({
  name: z.string(),
  ms: z.number().nonnegative(),
  status: stageStatusSchema,
});

export const recommendationSchema = z.object({
  movie: movieSummarySchema,
  score: z.number(),
  /** One sentence on why the movie fits this request. Absent when the pick step gave none. */
  why: z.string().max(RECOMMEND_WHY_MAX_LENGTH).optional(),
});

/**
 * What the parse step understood from the request, after validation. Only
 * values that passed validation are here, so this is what search really used.
 */
export const parsedRequestSchema = z.object({
  genres: z.array(z.string()),
  excludeGenres: z.array(z.string()),
  yearFrom: z.number().int().optional(),
  yearTo: z.number().int().optional(),
  maxRuntime: z.number().int().optional(),
  language: z.string().optional(),
  minRating: z.number().optional(),
  tags: z.array(z.string()),
  excludeTags: z.array(z.string()),
  referenceTitles: z.array(z.string()),
  /** The meaning to search for, in English. */
  searchText: z.string(),
});

/** Filters that can be loosened when too few movies match, in the order they are tried. */
export const RELAXABLE_FILTERS = [
  "excludeTags",
  "minRating",
  "maxRuntime",
  "years",
  // Last, and only partly: a movie then needs one of the genres instead of all of them.
  "genres",
] as const;

export const recommendResponseSchema = z.object({
  requestId: z.string(),
  results: z.array(recommendationSchema),
  meta: z.object({
    stages: z.array(stageSchema),
    /** True when a stored result was reused instead of calling the LLM. */
    cached: z.boolean(),
    /** Filters that were loosened to find enough results, in the order they were dropped. */
    relaxed: z.array(z.enum(RELAXABLE_FILTERS)).optional(),
    /** What the request was understood to mean. Absent when the parse step did not run or failed. */
    parsed: parsedRequestSchema.optional(),
  }),
});

// POST /api/recommend/stream answers with Server-Sent Events, in this order:
//   results  the movies in search order, as soon as the search is done
//   picked   the final order with reasons; left out if the pick step did not succeed
//   done     the final meta; always the last event of a request that worked
//   error    instead of done, when the request could not be answered
export const RECOMMEND_STREAM_EVENTS = ["results", "picked", "done", "error"] as const;

export const resultsEventSchema = z.object({
  requestId: z.string(),
  results: z.array(recommendationSchema),
  /** True when the pick step is about to run, so a `picked` event may follow. */
  picking: z.boolean(),
});
export const pickedEventSchema = z.object({ results: z.array(recommendationSchema) });
export const doneEventSchema = z.object({ meta: recommendResponseSchema.shape.meta });
export const streamErrorEventSchema = z.object({ message: z.string() });

export type RecommendStreamEvent = (typeof RECOMMEND_STREAM_EVENTS)[number];
export type RecommendMeta = RecommendResponse["meta"];
export type RecommendRequest = z.infer<typeof recommendRequestSchema>;
export type ParsedRequest = z.infer<typeof parsedRequestSchema>;
export type RelaxableFilter = (typeof RELAXABLE_FILTERS)[number];
export type RecommendResponse = z.infer<typeof recommendResponseSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type StageStatus = z.infer<typeof stageStatusSchema>;
