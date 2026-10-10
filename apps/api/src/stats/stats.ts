import type { StatsResponse } from "@cinequery/shared";
import type pg from "pg";
import type { TokenBudget } from "../limits/budget.js";

// Everything below counts rows since midnight UTC, the same day the token
// budget uses.

const REQUESTS = `
  SELECT
    count(*)::integer                                    AS total,
    count(*) FILTER (WHERE cached)::integer              AS cached,
    count(*) FILTER (WHERE outcome = 'error')::integer   AS errors,
    count(*) FILTER (WHERE outcome = 'cancelled')::integer AS cancelled,
    percentile_cont(0.5)  WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE outcome = 'ok') AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE outcome = 'ok') AS p95
  FROM request_log
  WHERE created_at >= $1
`;

// One row per step of the pipeline, from the stages each request recorded.
const STAGES = `
  SELECT
    stage.item->>'name'                                               AS name,
    count(*)::integer                                                 AS runs,
    count(*) FILTER (WHERE stage.item->>'status' = 'fallback')::integer AS fallbacks,
    count(*) FILTER (WHERE stage.item->>'status' = 'skipped')::integer  AS skipped,
    percentile_cont(0.5)  WITHIN GROUP (ORDER BY (stage.item->>'ms')::integer) AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY (stage.item->>'ms')::integer) AS p95
  FROM request_log r
  CROSS JOIN LATERAL jsonb_array_elements(r.stages) WITH ORDINALITY AS stage(item, position)
  WHERE r.created_at >= $1
  GROUP BY stage.item->>'name'
  -- In the order the steps run.
  ORDER BY min(stage.position), name
`;

const LLM_CALLS = `
  SELECT
    stage,
    count(*)::integer                                AS calls,
    count(*) FILTER (WHERE status NOT IN ('ok', 'cancelled'))::integer AS failed,
    coalesce(sum(input_tokens), 0)::integer          AS input_tokens,
    coalesce(sum(output_tokens), 0)::integer         AS output_tokens
  FROM llm_calls
  WHERE created_at >= $1
  GROUP BY stage
  ORDER BY stage
`;

// The stages that run while a user waits, as opposed to batch jobs.
const REQUEST_STAGES = new Set(["parse", "embed_query", "pick"]);

const round = (value: number | null) => (value === null ? null : Math.round(value));

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Today's numbers for GET /api/stats. */
export async function loadStats(
  pool: Pick<pg.Pool, "query">,
  budget: TokenBudget,
  now: Date,
): Promise<StatsResponse> {
  const since = startOfUtcDay(now);
  const [requests, stages, calls, usage] = await Promise.all([
    pool.query<{
      total: number;
      cached: number;
      errors: number;
      cancelled: number;
      p50: number | null;
      p95: number | null;
    }>(REQUESTS, [since]),
    pool.query<{
      name: string;
      runs: number;
      fallbacks: number;
      skipped: number;
      p50: number | null;
      p95: number | null;
    }>(STAGES, [since]),
    pool.query<{
      stage: string;
      calls: number;
      failed: number;
      input_tokens: number;
      output_tokens: number;
    }>(LLM_CALLS, [since]),
    budget.usage(),
  ]);

  const totals = requests.rows[0]!;
  const sum = (pick: (row: (typeof calls.rows)[number]) => number) =>
    calls.rows.reduce((total, row) => total + pick(row), 0);
  const requestTokens = calls.rows
    .filter((row) => REQUEST_STAGES.has(row.stage))
    .reduce((total, row) => total + row.input_tokens + row.output_tokens, 0);

  return {
    since: since.toISOString(),
    requests: {
      total: totals.total,
      cached: totals.cached,
      cacheHitRate: totals.total === 0 ? null : totals.cached / totals.total,
      errors: totals.errors,
      cancelled: totals.cancelled,
      latencyMs: { p50: round(totals.p50), p95: round(totals.p95) },
    },
    stages: stages.rows.map((row) => ({
      name: row.name,
      runs: row.runs,
      fallbacks: row.fallbacks,
      skipped: row.skipped,
      latencyMs: { p50: round(row.p50), p95: round(row.p95) },
    })),
    llm: {
      calls: sum((row) => row.calls),
      failedCalls: sum((row) => row.failed),
      inputTokens: sum((row) => row.input_tokens),
      outputTokens: sum((row) => row.output_tokens),
      averageTokensPerRequest:
        totals.total === 0 ? null : Math.round(requestTokens / totals.total),
      byStage: calls.rows.map((row) => ({
        stage: row.stage,
        calls: row.calls,
        failedCalls: row.failed,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
    },
    budget: usage,
  };
}
