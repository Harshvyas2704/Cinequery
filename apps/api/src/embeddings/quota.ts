import type pg from "pg";

// The provider allows a fixed number of embedded texts per day, and its day
// runs from midnight to midnight in its own time zone (Pacific time for
// Gemini), not in ours. Everything here is about that day.

/** The hour (0 to 23) and the seconds since midnight of an instant, on the clock of a time zone. */
function clockIn(timeZone: string, instant: Date): { hour: number; sinceMidnightMs: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = value("hour");
  return {
    hour,
    sinceMidnightMs:
      (hour * 3600 + value("minute") * 60 + value("second")) * 1000 + instant.getMilliseconds(),
  };
}

const HOUR = 3_600_000;

// On the two days a year the clocks change, "24 hours" and "the time since
// midnight" are an hour off. This moves a near miss onto the real midnight.
function toMidnight(timeZone: string, nearMidnight: Date): Date {
  const { hour, sinceMidnightMs } = clockIn(timeZone, nearMidnight);
  if (hour === 0) return new Date(nearMidnight.getTime() - sinceMidnightMs);
  // 23:xx is before midnight, 01:xx after it.
  return new Date(nearMidnight.getTime() + (hour >= 12 ? 24 * HOUR - sinceMidnightMs : -sinceMidnightMs));
}

/** The most recent midnight in the time zone: when the current quota day began. */
export function lastQuotaReset(timeZone: string, now: Date): Date {
  return toMidnight(timeZone, new Date(now.getTime() - clockIn(timeZone, now).sinceMidnightMs));
}

/** The next midnight in the time zone: when the quota is refilled. */
export function nextQuotaReset(timeZone: string, now: Date): Date {
  return toMidnight(timeZone, new Date(lastQuotaReset(timeZone, now).getTime() + 24 * HOUR));
}

export type QuotaUsage = {
  /** Texts embedded for movies since the last refill. */
  movies: number;
  /** Texts embedded for search requests since the last refill. */
  requests: number;
};

/**
 * How much of the day's quota this database knows to be used. It is an
 * estimate: calls logged in another database (a laptop and a server sharing
 * one API key) are not seen, and a call that failed on our side may still
 * have counted on the provider's.
 */
export async function quotaUsage(
  pool: Pick<pg.Pool, "query">,
  model: string,
  since: Date,
): Promise<QuotaUsage> {
  const { rows } = await pool.query<QuotaUsage>(
    // A row from before the items column is one text if it was a request.
    `SELECT
       coalesce(sum(coalesce(items, 1)) FILTER (WHERE stage = 'embed_query'), 0)::integer AS requests,
       coalesce(sum(coalesce(items, 0)) FILTER (WHERE stage <> 'embed_query'), 0)::integer AS movies
     FROM llm_calls
     WHERE model = $1 AND status = 'ok' AND stage LIKE 'embed%' AND created_at >= $2`,
    [model, since],
  );
  return rows[0] ?? { movies: 0, requests: 0 };
}

export type Allowance = QuotaUsage & {
  used: number;
  /** How many more texts may be embedded now. */
  left: number;
  resetsAt: Date;
  minutesToReset: number;
};

/** What is left of the day's quota after what was used and what is held back for requests. */
export function allowanceOf(
  usage: QuotaUsage,
  settings: { dailyQuota: number; reserve: number; timeZone: string },
  now: Date,
): Allowance {
  const used = usage.movies + usage.requests;
  const resetsAt = nextQuotaReset(settings.timeZone, now);
  return {
    ...usage,
    used,
    left: Math.max(0, settings.dailyQuota - used - settings.reserve),
    resetsAt,
    minutesToReset: Math.round((resetsAt.getTime() - now.getTime()) / 60_000),
  };
}
