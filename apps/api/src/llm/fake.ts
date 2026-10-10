import { createHash } from "node:crypto";
import {
  type EmbedInput,
  errorFromStatus,
  type GenerateJsonInput,
  type LlmBackend,
  LlmError,
} from "./types.js";

/** What the fake does on its next call instead of answering normally. */
export type FakeFailure =
  | { type: "timeout" } // never answers; the provider's timeout has to fire
  | { type: "status"; status: number; retryAfterMs?: number } // 429, 500, 400...
  | { type: "invalid_json" };

export type FakeBackend = LlmBackend & {
  /** Queue the reply of the next generateJson call. */
  respondWith(data: unknown): void;
  /** Queue a failure for the next call of either kind. */
  failNext(...failures: FakeFailure[]): void;
  /** Queue a failure for the next embed call only. */
  failNextEmbed(...failures: FakeFailure[]): void;
  /** Every call that reached the backend, including failed ones. */
  readonly calls: { method: "generateJson" | "embed"; input: GenerateJsonInput | EmbedInput }[];
};

/**
 * A deterministic unit vector for a text: the same text always gives the same
 * vector, different texts give different ones. It carries no meaning, so tests
 * can check plumbing but not search quality.
 */
export function fakeEmbedding(text: string, dimensions: number): number[] {
  const values: number[] = [];
  for (let block = 0; values.length < dimensions; block++) {
    const hash = createHash("sha256").update(`${block}:${text}`).digest();
    for (let i = 0; i + 4 <= hash.length && values.length < dimensions; i += 4) {
      values.push(hash.readInt32BE(i) / 2 ** 31);
    }
  }
  const length = Math.hypot(...values);
  return values.map((value) => value / length);
}

/** Stands in for Gemini in tests: no network, scripted replies and failures. */
export function createFakeBackend(options: { embeddingDimensions: number }): FakeBackend {
  const replies: unknown[] = [];
  const failures: FakeFailure[] = [];
  const embedFailures: FakeFailure[] = [];
  const calls: FakeBackend["calls"] = [];

  // Applies the next queued failure, if any.
  async function maybeFail(signal: AbortSignal, own: FakeFailure[] = []): Promise<void> {
    const failure = own.shift() ?? failures.shift();
    if (!failure) return;
    if (failure.type === "timeout") {
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (failure.type === "status") {
      throw errorFromStatus(failure.status, `Fake provider error ${failure.status}`, {
        retryAfterMs: failure.retryAfterMs,
      });
    }
    if (failure.type === "invalid_json") {
      throw new LlmError("invalid_output", "The model's reply was not valid JSON");
    }
  }

  return {
    textModel: "fake-text",
    embeddingModel: "fake-embedding",
    calls,
    respondWith: (data) => void replies.push(data),
    failNext: (...next) => void failures.push(...next),
    failNextEmbed: (...next) => void embedFailures.push(...next),

    async generateJson(input, signal) {
      calls.push({ method: "generateJson", input });
      await maybeFail(signal);
      if (replies.length === 0) {
        throw new LlmError("error", "The fake provider has no scripted reply for generateJson");
      }
      return { data: replies.shift(), usage: { inputTokens: 100, outputTokens: 20 } };
    },

    async embed(input, signal) {
      calls.push({ method: "embed", input });
      await maybeFail(signal, embedFailures);
      return {
        // Documents and queries with the same text get the same vector, so a
        // test can search for a movie by its own text.
        vectors: input.texts.map((text) => fakeEmbedding(text, options.embeddingDimensions)),
        usage: { inputTokens: input.texts.join(" ").split(/\s+/).length, outputTokens: 0 },
      };
    },
  };
}
