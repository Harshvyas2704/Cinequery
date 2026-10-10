import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type pg from "pg";
import { z } from "zod";
import type { EmbeddingTarget } from "./store.js";

// The export is gzipped JSON lines. The first line is a header; every other
// line is one movie. Movies are identified by tmdb_id, because the database's
// own ids differ between machines. Vectors are stored exactly (32-bit floats,
// base64), so an import gives the same search results as the original.

const FORMAT = "cinequery-embeddings";
const PAGE_SIZE = 500;

const headerSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(1),
  model: z.string(),
  dimensions: z.number().int().positive(),
  count: z.number().int().nonnegative(),
});

const lineSchema = z.object({
  tmdb_id: z.number().int().positive(),
  content_hash: z.string().min(1),
  embedding: z.string().min(1),
});

type Queryable = Pick<pg.Pool, "query">;

export function exportFileName(target: EmbeddingTarget): string {
  return `embeddings-${target.model}-${target.dimensions}.jsonl.gz`;
}

const encodeVector = (vector: number[]) =>
  Buffer.from(new Float32Array(vector).buffer).toString("base64");

function decodeVector(encoded: string, dimensions: number): number[] {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== dimensions * 4) {
    throw new Error(`Expected a vector of ${dimensions} dimensions`);
  }
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, dimensions));
}

/** Writes every embedding of the model to a file. Returns how many were written. */
export async function exportEmbeddings(
  db: Queryable,
  target: EmbeddingTarget,
  path: string,
): Promise<number> {
  const total = await db.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM movie_embeddings WHERE model = $1",
    [target.model],
  );
  const count = total.rows[0]?.count ?? 0;

  async function* lines() {
    yield `${JSON.stringify({ format: FORMAT, version: 1, model: target.model, dimensions: target.dimensions, count })}\n`;
    // Read in pages by movie id, so memory use stays flat for any catalog size.
    for (let lastId = 0; ; ) {
      const { rows } = await db.query<{
        movie_id: number;
        tmdb_id: number;
        content_hash: string;
        embedding: number[];
      }>(
        `SELECT e.movie_id, m.tmdb_id, e.content_hash, e.embedding::real[] AS embedding
         FROM movie_embeddings e JOIN movies m ON m.id = e.movie_id
         WHERE e.model = $1 AND e.movie_id > $2
         ORDER BY e.movie_id LIMIT $3`,
        [target.model, lastId, PAGE_SIZE],
      );
      if (rows.length === 0) return;
      for (const row of rows) {
        yield `${JSON.stringify({ tmdb_id: row.tmdb_id, content_hash: row.content_hash, embedding: encodeVector(row.embedding) })}\n`;
      }
      lastId = rows[rows.length - 1]!.movie_id;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await pipeline(lines, createGzip(), createWriteStream(path));
  return count;
}

export type ImportSummary = {
  inFile: number;
  imported: number;
  /** Already stored with the same hash. */
  unchanged: number;
  /** In the file, but the movie is not in this database. */
  unknownMovies: number;
};

/** Loads an export into movie_embeddings. Running it twice changes nothing. */
export async function importEmbeddings(
  db: Queryable,
  target: EmbeddingTarget,
  path: string,
): Promise<ImportSummary> {
  const summary: ImportSummary = { inFile: 0, imported: 0, unchanged: 0, unknownMovies: 0 };
  let page: z.infer<typeof lineSchema>[] = [];

  async function flush() {
    if (page.length === 0) return;
    const { rows } = await db.query<{ known: number; written: number }>(
      `WITH incoming AS (
         SELECT m.id AS movie_id, t.content_hash, t.embedding
         FROM unnest($2::integer[], $3::text[], $4::text[]) AS t (tmdb_id, content_hash, embedding)
         JOIN movies m ON m.tmdb_id = t.tmdb_id
       ),
       written AS (
         INSERT INTO movie_embeddings (movie_id, model, content_hash, embedding)
         SELECT movie_id, $1, content_hash, embedding::vector FROM incoming
         ON CONFLICT (movie_id, model) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           embedding = EXCLUDED.embedding,
           created_at = now()
         WHERE movie_embeddings.content_hash IS DISTINCT FROM EXCLUDED.content_hash
         RETURNING 1
       )
       SELECT (SELECT count(*)::integer FROM incoming) AS known,
              (SELECT count(*)::integer FROM written) AS written`,
      [
        target.model,
        page.map((line) => line.tmdb_id),
        page.map((line) => line.content_hash),
        page.map((line) => `[${decodeVector(line.embedding, target.dimensions).join(",")}]`),
      ],
    );
    const { known = 0, written = 0 } = rows[0] ?? {};
    summary.imported += written;
    summary.unchanged += known - written;
    summary.unknownMovies += page.length - known;
    page = [];
  }

  const reader = createInterface({ input: createReadStream(path).pipe(createGunzip()) });
  let header: z.infer<typeof headerSchema> | undefined;
  for await (const line of reader) {
    if (!line) continue;
    if (!header) {
      header = headerSchema.parse(JSON.parse(line));
      if (header.model !== target.model || header.dimensions !== target.dimensions) {
        throw new Error(
          `${path} holds ${header.model} at ${header.dimensions} dimensions, but this app is ` +
            `configured for ${target.model} at ${target.dimensions}.`,
        );
      }
      continue;
    }
    page.push(lineSchema.parse(JSON.parse(line)));
    summary.inFile++;
    if (page.length >= PAGE_SIZE) await flush();
  }
  if (!header) throw new Error(`${path} is empty`);
  await flush();
  return summary;
}
