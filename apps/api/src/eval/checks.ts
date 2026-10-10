import type { Checks } from "./schema.js";

/** What the checks need to know about a returned movie. All of it from the database. */
export type MovieFacts = {
  tmdbId: number;
  title: string;
  year: number | null;
  runtime: number | null;
  language: string | null;
  rating: number | null;
  genres: string[];
  /** The curated tags the movie has. */
  tags: string[];
};

const CONSTRAINT_KEYS = [
  "genresInclude",
  "genresAny",
  "genresExclude",
  "minYear",
  "maxYear",
  "maxRuntime",
  "language",
  "minRating",
  "noneOfMovies",
] as const satisfies readonly (keyof Checks)[];

export const hasConstraints = (checks: Checks) =>
  CONSTRAINT_KEYS.some((key) => checks[key] !== undefined);

/**
 * The names of the constraints a movie breaks; empty if it passes. A fact the
 * database does not have (no year, no runtime) breaks a constraint on it: the
 * request asked for something we cannot show to be true.
 */
export function brokenConstraints(movie: MovieFacts, checks: Checks): string[] {
  const broken: string[] = [];
  const fail = (name: (typeof CONSTRAINT_KEYS)[number], ok: boolean) => {
    if (!ok) broken.push(name);
  };
  const { genres } = movie;

  if (checks.genresInclude) fail("genresInclude", checks.genresInclude.every((g) => genres.includes(g)));
  if (checks.genresAny) fail("genresAny", checks.genresAny.some((g) => genres.includes(g)));
  if (checks.genresExclude) fail("genresExclude", !checks.genresExclude.some((g) => genres.includes(g)));
  if (checks.minYear !== undefined) fail("minYear", movie.year !== null && movie.year >= checks.minYear);
  if (checks.maxYear !== undefined) fail("maxYear", movie.year !== null && movie.year <= checks.maxYear);
  if (checks.maxRuntime !== undefined) {
    fail("maxRuntime", movie.runtime !== null && movie.runtime <= checks.maxRuntime);
  }
  if (checks.language !== undefined) fail("language", movie.language === checks.language);
  if (checks.minRating !== undefined) {
    fail("minRating", movie.rating !== null && movie.rating >= checks.minRating);
  }
  if (checks.noneOfMovies) {
    fail("noneOfMovies", !checks.noneOfMovies.some((unwanted) => unwanted.tmdbId === movie.tmdbId));
  }
  return broken;
}

export const hasAnyTag = (movie: MovieFacts, tags: string[]) =>
  tags.some((tag) => movie.tags.includes(tag));

/** The spoiler phrases that occur in a reason, compared without regard to case. */
export function spoilerWordsIn(reason: string, phrases: string[]): string[] {
  const text = reason.toLowerCase();
  return phrases.filter((phrase) => text.includes(phrase.toLowerCase()));
}

/** The value below which `p` (0 to 1) of the values lie; null for no values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
