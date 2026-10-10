import { CURATED_TAG_NAMES, GENRES, SEARCH_LIMIT_DEFAULT } from "@cinequery/shared";

/** What the search form holds. Empty string and empty array mean "no filter". */
export type Filters = {
  q: string;
  genres: string[];
  tags: string[];
  yearFrom: string;
  yearTo: string;
  language: string;
};

export const EMPTY_FILTERS: Filters = {
  q: "",
  genres: [],
  tags: [],
  yearFrom: "",
  yearTo: "",
  language: "",
};

export const PAGE_SIZE = SEARCH_LIMIT_DEFAULT;

/** The query string for both the page URL and the API: only filters that are set. */
export function toQueryString(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.genres.length > 0) params.set("genres", filters.genres.join(","));
  if (filters.tags.length > 0) params.set("tags", filters.tags.join(","));
  if (filters.yearFrom) params.set("yearFrom", filters.yearFrom);
  if (filters.yearTo) params.set("yearTo", filters.yearTo);
  if (filters.language) params.set("language", filters.language);
  return params.toString();
}

const known = (value: string | null, allowed: readonly string[]) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => allowed.includes(item));

const yearOrEmpty = (value: string | null) => (value && /^\d{4}$/.test(value) ? value : "");

/** Reads filters from a page URL. Anything unknown is dropped, so an old link still loads. */
export function fromQueryString(search: string): Filters {
  const params = new URLSearchParams(search);
  const language = params.get("language") ?? "";
  return {
    q: (params.get("q") ?? "").trim(),
    genres: known(params.get("genres"), GENRES),
    tags: known(params.get("tags"), CURATED_TAG_NAMES),
    yearFrom: yearOrEmpty(params.get("yearFrom")),
    yearTo: yearOrEmpty(params.get("yearTo")),
    language: /^[a-z]{2}$/.test(language) ? language : "",
  };
}

export function countActive(filters: Filters): number {
  return (
    filters.genres.length +
    filters.tags.length +
    (filters.yearFrom ? 1 : 0) +
    (filters.yearTo ? 1 : 0) +
    (filters.language ? 1 : 0)
  );
}

export function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((other) => other !== item) : [...list, item];
}
