import { createSemaphore } from "../limits/semaphore.js";
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
  /** For an embedding call: how many texts it embedded. The daily quota counts these. */
  items: number | null;
  status: "ok" | "timeout" | "rate_limited" | "invalid_output" | "error" | "cancelled";
};

export type ProviderOptions = {
  retry: RetrySettings;
  /** Called after every attempt. Must not throw. */
  recordCall: (call: LlmCallRecord) => void | Promise<void>;
  /** How many calls may run at once; the rest wait their turn. Unlimited if absent. */
  maxConcurrent?: number;
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
  // One queue for the whole process: a burst of requests cannot open more
  // connections to the provider, or use up its per-minute quota faster, than this.
  const slots = options.maxConcurrent ? createSemaphore(options.maxConcurrent) : null;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  async function attemptOnce<T extends { usage: Usage }>(
    timeoutMs: number,
    cancel: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let onCancel: (() => void) | undefined;
    // Either of these ends the attempt, and aborts the backend's request.
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LlmError("timeout", `Timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      onCancel = () => {
        controller.abort();
        reject(new LlmError("cancelled", "Cancelled by the caller"));
      };
      cancel?.addEventListener("abort", onCancel, { once: true });
    });
    let release: (() => void) | undefined;
    try {
      // Waiting for a free slot counts toward the timeout: a caller that
      // would wait too long gets its fallback instead.
      if (slots) release = await Promise.race([slots.acquire(controller.signal), stopped]);
      // The race means a backend that ignores the abort signal still stops here.
      return await Promise.race([run(controller.signal), stopped]);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (cancel?.aborted) {
        throw new LlmError("cancelled", "Cancelled by the caller", { cause: error });
      }
      if (controller.signal.aborted) {
        throw new LlmError("timeout", `Timed out after ${timeoutMs} ms`, { cause: error });
      }
      throw new LlmError("error", error instanceof Error ? error.message : "Unknown error", {
        cause: error,
      });
    } finally {
      release?.();
      clearTimeout(timer);
      if (onCancel) cancel?.removeEventListener("abort", onCancel);
    }
  }

  async function call<T extends { usage: Usage }>(
    meta: {
      stage: string;
      model: string;
      promptVersion: string | null;
      requestId?: string;
      items?: number;
    },
    timeoutMs: number,
    cancel: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T & { latencyMs: number }> {
    for (let attempt = 0; ; attempt++) {
      // Nothing is sent, so nothing is logged.
      if (cancel?.aborted) throw new LlmError("cancelled", "Cancelled by the caller");
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
          items: meta.items ?? null,
          status,
        });

      try {
        const result = await attemptOnce(timeoutMs, cancel, run);
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
          model: input.model ?? backend.textModel,
          promptVersion: input.promptVersion,
          requestId: input.requestId,
        },
        input.timeoutMs,
        input.signal,
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
          items: input.texts.length,
        },
        input.timeoutMs,
        input.signal,
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
