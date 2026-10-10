// The one doorway to LLMs and embeddings. Everything outside this folder uses
// LlmProvider and never sees the Gemini SDK (D-005).

export type Usage = {
  inputTokens: number | null;
  /** Includes thinking tokens, which are billed as output. */
  outputTokens: number | null;
};

export type GenerateJsonInput = {
  /** What the call is for: parse, pick, tag. Stored in llm_calls. */
  stage: string;
  promptVersion: string;
  system: string;
  prompt: string;
  /** A JSON Schema for the reply, for the model's structured output mode. */
  schema: unknown;
  maxOutputTokens: number;
  timeoutMs: number;
  requestId?: string;
  /** Use this model instead of the provider's default text model. */
  model?: string;
  /** minimal, low, medium or high, instead of the provider's default. */
  thinkingLevel?: string;
  /** Aborted when the caller no longer wants the reply (the user left). */
  signal?: AbortSignal;
};

export type EmbedInput = {
  texts: string[];
  /**
   * What is being embedded. Documents and queries are embedded differently so
   * that a query lands near the documents that answer it.
   */
  kind: "document" | "query";
  /** For documents: a title per text, in the same order. */
  titles?: string[];
  timeoutMs: number;
  /** embed_query or embed_batch. Stored in llm_calls. */
  stage: string;
  requestId?: string;
  /** Aborted when the caller no longer wants the reply (the user left). */
  signal?: AbortSignal;
};

export interface LlmProvider {
  /** The reply is parsed JSON but otherwise untrusted: validate it with Zod. */
  generateJson(
    input: GenerateJsonInput,
  ): Promise<{ data: unknown; usage: Usage; latencyMs: number }>;
  /** One vector per text, in the same order. */
  embed(input: EmbedInput): Promise<{ vectors: number[][]; usage: Usage; latencyMs: number }>;
}

/**
 * What a backend (Gemini, or the fake) implements: one attempt, no retries, no
 * logging. `createLlmProvider` adds timeouts, retries and the llm_calls log.
 */
export interface LlmBackend {
  readonly textModel: string;
  readonly embeddingModel: string;
  generateJson(
    input: GenerateJsonInput,
    signal: AbortSignal,
  ): Promise<{ data: unknown; usage: Usage }>;
  embed(input: EmbedInput, signal: AbortSignal): Promise<{ vectors: number[][]; usage: Usage }>;
}

/** Matches the status column of llm_calls, apart from "ok". */
export type LlmErrorKind =
  | "timeout"
  | "rate_limited"
  | "invalid_output"
  | "server"
  | "error"
  // The caller gave up (its AbortSignal fired). Never retried.
  | "cancelled";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  /** HTTP status from the provider, when there was one. */
  readonly status: number | undefined;
  /** How long the provider asked us to wait, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: LlmErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LlmError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** Only rate limits (429) and server errors (5xx) are worth trying again. */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "server";
  }
}

/** Turns an HTTP status from a provider into the right kind of error. */
export function errorFromStatus(
  status: number,
  message: string,
  options: { retryAfterMs?: number; cause?: unknown } = {},
): LlmError {
  const kind: LlmErrorKind = status === 429 ? "rate_limited" : status >= 500 ? "server" : "error";
  return new LlmError(kind, message, { status, ...options });
}
