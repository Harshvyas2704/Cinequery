import type { BudgetLevel } from "@cinequery/shared";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

export type BudgetUsage = {
  usedTokens: number;
  softTokens: number;
  hardTokens: number;
  level: BudgetLevel;
};

export type TokenBudget = {
  /** Counts tokens that were just used. */
  add(tokens: number): Promise<void>;
  /**
   *   ok    below the soft limit: everything runs
   *   soft  the pick step is skipped (it is most of a request's cost)
   *   hard  no LLM call is made; search uses keywords and cached data
   */
  level(): Promise<BudgetLevel>;
  usage(): Promise<BudgetUsage>;
};

/** A budget that is never used up, for when no LLM is configured and for tests. */
export const unlimitedBudget: TokenBudget = {
  add: async () => {},
  level: async () => "ok",
  usage: async () => ({ usedTokens: 0, softTokens: 0, hardTokens: 0, level: "ok" }),
};

/**
 * Counts the tokens used per UTC day in Redis, so that several API processes
 * share one budget and a restart does not reset it.
 *
 * The count is also kept in this process. If Redis cannot be reached, the
 * local count is used, so a Redis outage does not switch the budget off.
 */
export function createTokenBudget(
  redis: Pick<Redis, "incrby" | "expire" | "get">,
  options: {
    softTokens: number;
    hardTokens: number;
    prefix?: string;
    now?: () => Date;
    logger: Logger;
  },
): TokenBudget {
  const now = options.now ?? (() => new Date());
  const local = { day: "", used: 0 };

  // The key changes at midnight UTC, which is what resets the budget.
  function today(): { day: string; key: string } {
    const day = now().toISOString().slice(0, 10);
    if (local.day !== day) {
      local.day = day;
      local.used = 0;
    }
    return { day, key: `${options.prefix ?? "cinequery"}:budget:${day}` };
  }

  const levelOf = (used: number): BudgetLevel =>
    used >= options.hardTokens ? "hard" : used >= options.softTokens ? "soft" : "ok";

  async function used(): Promise<number> {
    const { key } = today();
    try {
      local.used = Math.max(local.used, Number((await redis.get(key)) ?? 0));
    } catch (error) {
      options.logger.warn({ err: (error as Error).message }, "token budget read failed");
    }
    return local.used;
  }

  return {
    async add(tokens) {
      if (tokens <= 0) return;
      const { key } = today();
      local.used += tokens;
      try {
        const total = await redis.incrby(key, tokens);
        // Two days: long enough to outlive its day, and an expiry makes the
        // key one Redis may evict last among cache entries (D-044).
        await redis.expire(key, 172_800);
        local.used = Math.max(local.used, total);
      } catch (error) {
        options.logger.warn({ err: (error as Error).message }, "token budget write failed");
      }
    },
    level: async () => levelOf(await used()),
    async usage() {
      const usedTokens = await used();
      return {
        usedTokens,
        softTokens: options.softTokens,
        hardTokens: options.hardTokens,
        level: levelOf(usedTokens),
      };
    },
  };
}
