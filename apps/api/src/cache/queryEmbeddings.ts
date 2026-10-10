import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

export type QueryEmbeddingCache = {
  get(normalizedQuery: string): Promise<number[] | null>;
  set(normalizedQuery: string, vector: number[]): Promise<void>;
};

export type QueryEmbeddingCacheOptions = {
  /** Part of the key, so a change of model or size never returns an old vector. */
  model: string;
  dimensions: number;
  ttlSeconds: number;
  /** Start of every key. Tests use their own to stay apart. */
  prefix?: string;
  logger: Logger;
};

/**
 * Stores the embedding of each search text in Redis, so the same request does
 * not call the embedding API twice. The vector is stored as raw 32-bit floats
 * (4 bytes a number, 3 KB at 768 dimensions), not as a JSON array.
 *
 * Redis is optional here: if it is down, get returns null and set does nothing.
 */
export function createQueryEmbeddingCache(
  redis: Pick<Redis, "getBuffer" | "set">,
  options: QueryEmbeddingCacheOptions,
): QueryEmbeddingCache {
  const key = (normalizedQuery: string) =>
    `${options.prefix ?? "cinequery"}:query-embedding:` +
    createHash("sha256")
      .update(JSON.stringify([options.model, options.dimensions, normalizedQuery]))
      .digest("hex");

  return {
    async get(normalizedQuery) {
      try {
        const bytes = await redis.getBuffer(key(normalizedQuery));
        if (!bytes || bytes.length !== options.dimensions * 4) return null;
        // Copy first: a Buffer may sit at an offset that is not a multiple of 4.
        const copy = new Uint8Array(bytes).buffer;
        return Array.from(new Float32Array(copy));
      } catch (error) {
        options.logger.warn({ err: (error as Error).message }, "query embedding cache read failed");
        return null;
      }
    },

    async set(normalizedQuery, vector) {
      try {
        const bytes = Buffer.from(new Float32Array(vector).buffer);
        await redis.set(key(normalizedQuery), bytes, "EX", options.ttlSeconds);
      } catch (error) {
        options.logger.warn({ err: (error as Error).message }, "query embedding cache write failed");
      }
    },
  };
}
