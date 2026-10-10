import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { z } from "zod";

export type JsonCache<T> = {
  get(keyParts: unknown[]): Promise<T | null>;
  set(keyParts: unknown[], value: T): Promise<void>;
};

/**
 * A small cache of JSON values in Redis. Every entry has an expiry (D-044).
 * What is read back is validated, so a value written by an older version of
 * the code is treated as a miss instead of being trusted.
 *
 * Redis is optional: if it is down, get returns null and set does nothing.
 */
export function createJsonCache<Schema extends z.ZodType>(
  redis: Pick<Redis, "get" | "set">,
  options: {
    /** What is cached, e.g. "parse". Part of every key. */
    name: string;
    schema: Schema;
    ttlSeconds: number;
    prefix?: string;
    logger: Logger;
  },
): JsonCache<z.infer<Schema>> {
  const key = (parts: unknown[]) =>
    `${options.prefix ?? "cinequery"}:${options.name}:` +
    createHash("sha256").update(JSON.stringify(parts)).digest("hex");

  return {
    async get(parts) {
      try {
        const text = await redis.get(key(parts));
        if (!text) return null;
        const parsed = options.schema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
      } catch (error) {
        options.logger.warn({ err: (error as Error).message }, `${options.name} cache read failed`);
        return null;
      }
    },
    async set(parts, value) {
      try {
        await redis.set(key(parts), JSON.stringify(value), "EX", options.ttlSeconds);
      } catch (error) {
        options.logger.warn({ err: (error as Error).message }, `${options.name} cache write failed`);
      }
    },
  };
}
