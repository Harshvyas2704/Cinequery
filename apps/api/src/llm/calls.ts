import type pg from "pg";
import type { Logger } from "pino";
import type { LlmCallRecord } from "./provider.js";

/**
 * Returns the function that writes a row to llm_calls. Logging a call must
 * never break the call itself, so a failed insert is only warned about.
 */
export function llmCallRecorder(pool: Pick<pg.Pool, "query">, logger: Logger) {
  return async (call: LlmCallRecord): Promise<void> => {
    try {
      await pool.query(
        `INSERT INTO llm_calls
           (request_id, stage, model, prompt_version, input_tokens, output_tokens, latency_ms, status, items)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          call.requestId,
          call.stage,
          call.model,
          call.promptVersion,
          call.inputTokens,
          call.outputTokens,
          call.latencyMs,
          call.status,
          call.items,
        ],
      );
    } catch (error) {
      logger.warn({ err: error }, "could not record llm call");
    }
  };
}
