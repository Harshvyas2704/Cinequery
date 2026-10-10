import { createHash } from "node:crypto";

/** How many of a movie's most relevant tags go into its embedding text. */
export const TOP_TAGS = 10;

export type EmbeddingSource = {
  title: string;
  release_year: number | null;
  genres: string[];
  keywords: string[];
  tagline: string | null;
  overview: string;
  /** Most relevant first. Only the first TOP_TAGS are used. */
  tags: string[];
};

export type EmbeddingDocument = { title: string; text: string };

/**
 * The text a movie is embedded from. This is the one place that decides it:
 * any change here changes every content hash, so every movie is embedded again.
 */
export function buildEmbeddingDocument(movie: EmbeddingSource): EmbeddingDocument {
  const lines = [
    movie.genres.length > 0 ? `Genres: ${movie.genres.join(", ")}` : null,
    movie.tags.length > 0 ? `Tags: ${movie.tags.slice(0, TOP_TAGS).join(", ")}` : null,
    movie.keywords.length > 0 ? `Keywords: ${movie.keywords.join(", ")}` : null,
    movie.tagline ? `Tagline: ${movie.tagline}` : null,
    `Overview: ${movie.overview}`,
  ];
  return {
    title: movie.release_year ? `${movie.title} (${movie.release_year})` : movie.title,
    text: lines.filter((line) => line !== null).join("\n"),
  };
}

/**
 * Identifies an embedding's input: the text plus the model and vector size.
 * If the stored hash equals this, the stored vector is current.
 */
export function contentHash(document: EmbeddingDocument, model: string, dimensions: number): string {
  return createHash("sha256")
    .update(JSON.stringify([document.title, document.text, model, dimensions]))
    .digest("hex");
}
