import { Redis } from "ioredis";
import type { Logger } from "pino";

export function createRedis(url: string, logger: Logger): Redis {
  // Fail fast: while Redis is down, commands reject at once instead of queueing
  // until it returns. Callers treat Redis as optional and fall back.
  const redis = new Redis(url, { enableOfflineQueue: false });
  // ioredis reconnects by itself; without a listener each failure is an unhandled error.
  redis.on("error", (err: Error) => logger.warn({ err: err.message }, "redis connection error"));
  return redis;
}
