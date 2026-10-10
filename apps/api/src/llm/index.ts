import type pg from "pg";
import type { Logger } from "pino";
import type { Config } from "../config/env.js";
import { llmCallRecorder } from "./calls.js";
import { createGeminiBackend } from "./gemini.js";
import { createLlmProvider } from "./provider.js";
import type { LlmProvider } from "./types.js";

export { createFakeBackend, fakeEmbedding } from "./fake.js";
export { createLlmProvider } from "./provider.js";
export { LlmError, type LlmProvider } from "./types.js";

/** The real provider: Gemini with timeouts, retries and the llm_calls log. */
export function createGeminiProvider(
  config: Pick<Config, "llm">,
  pool: Pick<pg.Pool, "query">,
  logger: Logger,
): LlmProvider {
  const { apiKey } = config.llm;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Add it to .env (see .env.example).");
  }
  return createLlmProvider(
    createGeminiBackend({
      apiKey,
      textModel: config.llm.textModel,
      thinkingLevel: config.llm.thinkingLevel,
      embeddingModel: config.llm.embeddingModel,
      embeddingDimensions: config.llm.embeddingDimensions,
    }),
    { retry: config.llm.retry, recordCall: llmCallRecorder(pool, logger) },
  );
}
