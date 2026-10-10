import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { z } from "zod";
import { type Movie, movieRowSchema, type TagRow, tagRowSchema, toMovie } from "./transform.js";

async function readRows<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await parquetReadObjects({ file: await asyncBufferFromFile(path) });
  } catch (error) {
    throw new Error(`Could not read ${path}. Run "duckdb < scripts/prepare-data.sql" first.`, {
      cause: error,
    });
  }
  return rows.map((row, index) => {
    const result = schema.safeParse(row);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new Error(`${path}, row ${index}: ${issue?.path.join(".")} ${issue?.message}`);
    }
    return result.data;
  });
}

export async function readMovies(path: string): Promise<Movie[]> {
  return (await readRows(path, movieRowSchema)).map(toMovie);
}

export function readTags(path: string): Promise<TagRow[]> {
  return readRows(path, tagRowSchema);
}
