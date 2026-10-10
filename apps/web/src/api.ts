import {
  errorResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  type RecommendResponse,
  recommendResponseSchema,
  type SearchResponse,
  searchResponseSchema,
} from "@cinequery/shared";
import { type Filters, PAGE_SIZE, toQueryString } from "./filters.ts";

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

/** Asks for recommendations for a request written in plain language. */
export async function recommendMovies(
  query: string,
  signal?: AbortSignal,
): Promise<RecommendResponse> {
  const response = await fetch("/api/recommend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(body);
    const details = error.success ? error.data.error.details : undefined;
    if (response.status === 400 && details?.length) {
      throw new ApiError(details.map((detail) => detail.message).join(". "));
    }
    throw new Error(`Recommend failed with status ${response.status}`);
  }
  return recommendResponseSchema.parse(body);
}
