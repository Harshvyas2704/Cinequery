import {
  doneEventSchema,
  errorResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  pickedEventSchema,
  type Recommendation,
  type RecommendMeta,
  resultsEventSchema,
  type SearchResponse,
  searchResponseSchema,
  streamErrorEventSchema,
} from "@cinequery/shared";
import { type Filters, PAGE_SIZE, toQueryString } from "./filters.ts";
import { createSseParser } from "./sse.ts";

/** Fetches /api/health. A 503 still carries a valid body saying which service is down. */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok && response.status !== 503) {
    throw new Error(`The API answered with status ${response.status}`);
  }
  return healthResponseSchema.parse(await response.json());
}

/** An error whose message is safe and useful to show to the user. */
export class ApiError extends Error {}

export async function searchMovies(
  filters: Filters,
  offset: number,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const params = new URLSearchParams(toQueryString(filters));
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));

  const response = await fetch(`/api/movies/search?${params}`, { signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(body);
    // A 400 lists what was wrong with each filter; show that instead of a generic message.
    const details = error.success ? error.data.error.details : undefined;
    if (response.status === 400 && details?.length) {
      throw new ApiError(details.map((detail) => detail.message).join(". "));
    }
    throw new Error(`Search failed with status ${response.status}`);
  }
  return searchResponseSchema.parse(body);
}

/** What the page is told while a recommendation is being worked out. */
export type RecommendHandlers = {
  /** The movies in search order. Picks may follow if `picking` is true. */
  onResults(event: { results: Recommendation[]; picking: boolean }): void;
  /** The final order, with a reason for each pick. */
  onPicked(event: { results: Recommendation[] }): void;
  /** The request is complete. */
  onDone(event: { meta: RecommendMeta }): void;
};

/**
 * Asks for recommendations for a request written in plain language. The answer
 * arrives in steps (POST /api/recommend/stream), so the search results can be
 * shown while the AI is still choosing among them.
 */
export async function streamRecommendations(
  query: string,
  handlers: RecommendHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/recommend/stream", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!response.ok || !response.body) {
    const body: unknown = await response.json().catch(() => null);
    const error = errorResponseSchema.safeParse(body);
    const details = error.success ? error.data.error.details : undefined;
    if (response.status === 400 && details?.length) {
      throw new ApiError(details.map((detail) => detail.message).join(". "));
    }
    throw new Error(`Recommend failed with status ${response.status}`);
  }

  let failure: string | null = null;
  const parser = createSseParser(({ event, data }) => {
    const json: unknown = JSON.parse(data);
    if (event === "results") handlers.onResults(resultsEventSchema.parse(json));
    if (event === "picked") handlers.onPicked(pickedEventSchema.parse(json));
    if (event === "done") handlers.onDone(doneEventSchema.parse(json));
    if (event === "error") failure = streamErrorEventSchema.parse(json).message;
  });

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  if (failure !== null) throw new ApiError(failure);
}
