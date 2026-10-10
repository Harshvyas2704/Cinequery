import { type HealthResponse, healthResponseSchema } from "@cinequery/shared";

/** Fetches /api/health. A 503 still carries a valid body saying which service is down. */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok && response.status !== 503) {
    throw new Error(`The API answered with status ${response.status}`);
  }
  return healthResponseSchema.parse(await response.json());
}
