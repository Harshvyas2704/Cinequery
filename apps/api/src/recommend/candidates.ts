import type { Recommendation } from "@cinequery/shared";
import type pg from "pg";

export type CandidateSettings = {
  /** How many of a movie's most relevant tags are shown to the model. */
  tagsPerCandidate: number;
  /** Overviews are cut to about this many characters. */
  overviewChars: number;
};

// The most relevant tags of each movie, best first.
const TOP_TAGS = `
  SELECT movie_id, tag
  FROM (
    SELECT movie_id, tag, relevance,
           row_number() OVER (PARTITION BY movie_id ORDER BY relevance DESC, tag) AS position
    FROM movie_tags
    WHERE movie_id = ANY($1::integer[])
  ) ranked
  WHERE position <= $2
  ORDER BY movie_id, position
`;

/** A field of a candidate line: one line, and no "|" that would look like a new field. */
const field = (text: string) => text.replace(/[|\s]+/g, " ").trim();

/** Cuts at a word boundary, so the model does not see half a word. */
export function cutText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * One compact line per candidate (PLAN.md 7.1):
 *   id | title | year | genres | top tags | overview
 * This is all the model sees of a movie; everything shown to the user comes
 * from the database.
 */
export async function candidateLines(
  pool: pg.Pool,
  candidates: Recommendation[],
  settings: CandidateSettings,
): Promise<string[]> {
  const tags = new Map<number, string[]>();
  if (candidates.length > 0 && settings.tagsPerCandidate > 0) {
    const { rows } = await pool.query<{ movie_id: number; tag: string }>(TOP_TAGS, [
      candidates.map(({ movie }) => movie.id),
      settings.tagsPerCandidate,
    ]);
    for (const row of rows) tags.set(row.movie_id, [...(tags.get(row.movie_id) ?? []), row.tag]);
  }

  return candidates.map(({ movie }) =>
    [
      String(movie.id),
      field(movie.title),
      movie.releaseYear === null ? "" : String(movie.releaseYear),
      movie.genres.map(field).join(", "),
      (tags.get(movie.id) ?? []).map(field).join(", "),
      cutText(field(movie.overview), settings.overviewChars),
    ].join(" | "),
  );
}
