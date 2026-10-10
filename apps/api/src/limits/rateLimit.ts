import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

export type RateLimitResult = {
  allowed: boolean;
  /** Requests left in the window after this one. */
  remaining: number;
  /** When refused: how long until a request will be allowed again. */
  retryAfterMs: number;
};

export type RateLimiter = {
  /** Counts one request for `key` and says whether it is within `max` per window. */
  hit(key: string, max: number): Promise<RateLimitResult>;
};

// A sliding window: the sorted set holds the time of every request of the last
// window. A fixed window ("20 per calendar minute") would let 40 requests
// through around the turn of a minute; this never allows more than `max` in
// any stretch of one window. The script runs as one step in Redis, so two
// requests arriving together cannot both take the last place.
//   KEYS[1] the key        ARGV: now (ms), window (ms), max, a unique member
const SLIDING_WINDOW = `
  local now, window, max = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
  local count = redis.call('ZCARD', KEYS[1])
  if count < max then
    redis.call('ZADD', KEYS[1], now, ARGV[4])
    redis.call('PEXPIRE', KEYS[1], window)
    return {1, max - count - 1, 0}
  end
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, 0, tonumber(oldest[2]) + window - now}
`;

export function createRateLimiter(
  redis: Pick<Redis, "eval">,
  options: { windowMs: number; prefix?: string; now?: () => number; logger: Logger },
): RateLimiter {
  const now = options.now ?? Date.now;
  return {
    async hit(key, max) {
      try {
        const [allowed, remaining, retryAfterMs] = (await redis.eval(
          SLIDING_WINDOW,
          1,
          `${options.prefix ?? "cinequery"}:rate:${key}`,
          now(),
          options.windowMs,
          max,
          randomUUID(),
        )) as [number, number, number];
        return { allowed: allowed === 1, remaining, retryAfterMs };
      } catch (error) {
        // Redis is optional (D-029). Without it requests are let through; the
        // token budget and the limit on concurrent LLM calls still hold.
        options.logger.warn({ err: (error as Error).message }, "rate limit check failed");
        return { allowed: true, remaining: max, retryAfterMs: 0 };
      }
    },
  };
}

/** Refuses a client's requests beyond `max` per window with 429 and Retry-After. */
export function rateLimit(limiter: RateLimiter, name: string, max: number): RequestHandler {
  return async (req, res, next) => {
    // req.ip honours X-Forwarded-For only as far as TRUST_PROXY_HOPS allows.
    const result = await limiter.hit(`${name}:${req.ip ?? "unknown"}`, max);
    if (result.allowed) {
      next();
      return;
    }
    const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res
      .status(429)
      .set("retry-after", String(seconds))
      .json({
        error: {
          code: "rate_limited",
          message: `Too many requests. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
          requestId: String(req.id),
        },
      });
  };
}
