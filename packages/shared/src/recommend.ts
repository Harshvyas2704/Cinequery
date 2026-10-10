import { z } from "zod";
import { movieSummarySchema } from "./movies.js";

export const RECOMMEND_QUERY_MIN_LENGTH = 3;
export const RECOMMEND_QUERY_MAX_LENGTH = 300;
export const RECOMMEND_LIMIT_MAX = 20;
export const RECOMMEND_LIMIT_DEFAULT = 8;

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
  /** One sentence on why the movie fits. Arrives with the pick step (Phase 7). */
  why: z.string().optional(),
});

export const recommendResponseSchema = z.object({
  requestId: z.string(),
  results: z.array(recommendationSchema),
  meta: z.object({
    stages: z.array(stageSchema),
    /** True when a stored result was reused instead of calling the LLM. */
    cached: z.boolean(),
    /** Filters that were loosened to find enough results (Phase 6). */
    relaxed: z.array(z.string()).optional(),
  }),
});

export type RecommendRequest = z.infer<typeof recommendRequestSchema>;
export type RecommendResponse = z.infer<typeof recommendResponseSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type StageStatus = z.infer<typeof stageStatusSchema>;
