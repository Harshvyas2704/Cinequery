import {
  type EmbedInput,
  type GenerateJsonInput,
  type LlmBackend,
  LlmError,
  type LlmProvider,
  type Usage,
} from "./types.js";

export type RetrySettings = {
  /** Extra attempts after the first one. */
  maxRetries: number;
  /** Wait before the first retry; doubles each time. */
  baseDelayMs: number;
  maxDelayMs: number;
};

/** One row of llm_calls. One is written per attempt, including failed ones. */
export type LlmCallRecord = {
  requestId: string | null;
  stage: string;
  model: string;
  promptVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: "ok" | "timeout" | "rate_limited" | "invalid_output" | "error";
};

export type ProviderOptions = {
  retry: RetrySettings;
  /** Called after every attempt. Must not throw. */
  recordCall: (call: LlmCallRecord) => void | Promise<void>;
  /** Replaced in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter: a random wait between 0 and
 * base * 2^attempt, capped. If the provider said how long to wait, wait at
 * least that long.
 */
export function retryDelayMs(
  attempt: number,
  settings: RetrySettings,
  random: () => number,
  retryAfterMs?: number,
): number {
  const ceiling = Math.min(settings.maxDelayMs, settings.baseDelayMs * 2 ** attempt);
  return Math.max(Math.round(random() * ceiling), retryAfterMs ?? 0);
}

/**
 * Wraps a backend with what every call needs: a timeout, retries with backoff
 * on 429 and 5xx only, and a row in llm_calls.
 */
export function createLlmProvider(backend: LlmBackend, options: ProviderOptions): LlmProvider {
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  async function attemptOnce<T extends { usage: Usage }>(
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LlmError("timeout", `Timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      // The race means a backend that ignores the abort signal still times out.
      return await Promise.race([run(controller.signal), timedOut]);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (controller.signal.aborted) {
        throw new LlmError("timeout", `Timed out after ${timeoutMs} ms`, { cause: error });
      }
      throw new LlmError("error", error instanceof Error ? error.message : "Unknown error", {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T extends { usage: Usage }>(
    meta: { stage: string; model: string; promptVersion: string | null; requestId?: string },
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T & { latencyMs: number }> {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      const record = (status: LlmCallRecord["status"], usage?: Usage) =>
        options.recordCall({
          requestId: meta.requestId ?? null,
          stage: meta.stage,
          model: meta.model,
          promptVersion: meta.promptVersion,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          latencyMs: Math.round(performance.now() - started),
          status,
        });

      try {
        const result = await attemptOnce(timeoutMs, run);
        await record("ok", result.usage);
        return { ...result, latencyMs: Math.round(performance.now() - started) };
      } catch (error) {
        const llmError = error as LlmError;
        // llm_calls has no "server" status; a 5xx is stored as "error".
        await record(llmError.kind === "server" ? "error" : llmError.kind);
        if (!llmError.retryable || attempt >= options.retry.maxRetries) throw llmError;
        // A provider that asks for a longer wait than we are willing to sit
        // through is not retried here; the caller decides what to do.
        if ((llmError.retryAfterMs ?? 0) > options.retry.maxDelayMs) throw llmError;
        await sleep(retryDelayMs(attempt, options.retry, random, llmError.retryAfterMs));
      }
    }
  }

  return {
    generateJson: (input: GenerateJsonInput) =>
      call(
        {
          stage: input.stage,
          model: backend.textModel,
          promptVersion: input.promptVersion,
          requestId: input.requestId,
        },
        input.timeoutMs,
        (signal) => backend.generateJson(input, signal),
      ),

    embed: async (input: EmbedInput) => {
      if (input.texts.length === 0) {
        return { vectors: [], usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0 };
      }
      return call(
        {
          stage: input.stage,
          model: backend.embeddingModel,
          promptVersion: null,
          requestId: input.requestId,
        },
        input.timeoutMs,
        async (signal) => {
          const result = await backend.embed(input, signal);
          if (result.vectors.length !== input.texts.length) {
            throw new LlmError(
              "invalid_output",
              `Asked for ${input.texts.length} embeddings, got ${result.vectors.length}`,
            );
          }
          return result;
        },
      );
    },
  };
}
