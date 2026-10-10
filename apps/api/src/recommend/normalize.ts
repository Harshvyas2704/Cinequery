/**
 * The form of a request used for cache keys: trimmed, lower case, single
 * spaces. "  Space   MOVIE " and "space movie" are the same request.
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}
