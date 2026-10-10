import type { Stage } from "@cinequery/shared";
import type pg from "pg";
import type { Logger } from "pino";

export type RequestRecord = {
  requestId: string;
  route: "recommend" | "recommend_stream";
  outcome: "ok" | "error" | "cancelled";
  cached: boolean;
  results: number;
  totalMs: number;
  stages: Stage[];
};

export type RequestRecorder = (record: RequestRecord) => Promise<void>;

/**
 * Returns the function that writes a row to request_log. Like the LLM call
 * log, it must never break the request it describes.
 */
export function requestRecorder(pool: Pick<pg.Pool, "query">, logger: Logger): RequestRecorder {
  return async (record) => {
    try {
      await pool.query(
        `INSERT INTO request_log (request_id, route, outcome, cached, results, total_ms, stages)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          record.requestId,
          record.route,
          record.outcome,
          record.cached,
          record.results,
          record.totalMs,
          JSON.stringify(record.stages),
        ],
      );
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "could not record request");
    }
  };
}
