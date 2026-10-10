import {
  CURATED_TAG_NAMES,
  GENRES,
  LANGUAGE_CODES,
  type ParsedRequest,
  RECOMMEND_QUERY_MAX_LENGTH,
} from "@cinequery/shared";
import { z } from "zod";

// The oldest film in the catalog is from 1874.
const EARLIEST_YEAR = 1870;
const MIN_RUNTIME = 30;
const MAX_RUNTIME = 600;
const MAX_REFERENCE_TITLES = 3;
const MAX_TITLE_LENGTH = 120;

const list = z.array(z.unknown()).catch([]);
const number = z.number().optional().catch(undefined);
const text = z.string().optional().catch(undefined);

/**
 * The shape of the model's reply, read as loosely as possible: a field of the
 * wrong type is ignored instead of throwing the whole reply away. A reply that
 * is not an object at all fails here.
 */
export const rawParseSchema = z.object({
  genres: list,
  excludeGenres: list,
  yearFrom: number,
  yearTo: number,
  maxRuntime: number,
  language: text,
  minRating: number,
  tags: list,
  excludeTags: list,
  referenceTitles: list,
  searchText: text,
});

/** Keeps the values that are in the allowed list, written the way the list writes them. */
function known(values: unknown[], allowed: readonly string[]): string[] {
  const canonical = new Map(allowed.map((value) => [value.toLowerCase(), value]));
  const kept = values
    .map((value) => (typeof value === "string" ? canonical.get(value.trim().toLowerCase()) : undefined))
    .filter((value) => value !== undefined);
  return [...new Set(kept)];
}

const wholeNumberIn = (value: number | undefined, min: number, max: number) =>
  value !== undefined && Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/**
 * Turns the model's reply into filters that are safe to use. The reply is
 * untrusted: anything unknown, out of range or contradictory is dropped, never
 * guessed at.
 *
 * @param fallbackText used as the search text when the reply has none
 */
export function sanitizeParse(
  reply: unknown,
  options: { currentYear: number; fallbackText: string },
): ParsedRequest | null {
  const result = rawParseSchema.safeParse(reply);
  if (!result.success) return null;
  const raw = result.data;

  const genres = known(raw.genres, GENRES);
  const tags = known(raw.tags, CURATED_TAG_NAMES);

  let yearFrom = wholeNumberIn(raw.yearFrom, EARLIEST_YEAR, options.currentYear);
  // A range that ends in the future is the same as no end.
  let yearTo = wholeNumberIn(raw.yearTo, EARLIEST_YEAR, options.currentYear - 1);
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    yearFrom = undefined;
    yearTo = undefined;
  }

  const language = raw.language?.trim().toLowerCase();
  const minRating =
    raw.minRating !== undefined && raw.minRating > 0 && raw.minRating <= 10
      ? raw.minRating
      : undefined;

  const referenceTitles = raw.referenceTitles
    .filter((title): title is string => typeof title === "string")
    .map((title) => title.trim())
    .filter((title) => title !== "" && title.length <= MAX_TITLE_LENGTH)
    .slice(0, MAX_REFERENCE_TITLES);

  const searchText = raw.searchText?.trim().slice(0, RECOMMEND_QUERY_MAX_LENGTH);

  return {
    genres,
    // Asking for a genre and excluding it makes no sense; wanting it wins.
    excludeGenres: known(raw.excludeGenres, GENRES).filter((genre) => !genres.includes(genre)),
    yearFrom,
    yearTo,
    maxRuntime: wholeNumberIn(raw.maxRuntime, MIN_RUNTIME, MAX_RUNTIME),
    language: language && LANGUAGE_CODES.includes(language) ? language : undefined,
    minRating,
    tags,
    excludeTags: known(raw.excludeTags, CURATED_TAG_NAMES).filter((tag) => !tags.includes(tag)),
    referenceTitles,
    searchText: searchText || options.fallbackText,
  };
}

/** What is searched when the parse step is skipped or fails: the words as typed, no filters. */
export function unparsed(normalizedQuery: string): ParsedRequest {
  return {
    genres: [],
    excludeGenres: [],
    tags: [],
    excludeTags: [],
    referenceTitles: [],
    searchText: normalizedQuery,
  };
}
